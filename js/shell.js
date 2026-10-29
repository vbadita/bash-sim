// The interpreter: variables, functions, execution of the AST, redirections,
// pipelines, jobs, traps, subshells.

import { parse, ParseError, parseAssign, isAssignWord } from './parser.js';
import { ExpandMixin, ShellError, ansiDecode } from './expand.js';
import { matchPattern } from './pattern.js';
import { StringReader, EmptyReader, Reader, Writer, NullWriter, CollectWriter, Pipe, EPIPE, FnReader } from './streams.js';
import { FsError, Node as FsNode } from './vfs.js';
import { ArithError } from './arith.js';

export class ExitEx {
  constructor(code) {
    this.code = code;
  }
}
export class ReturnEx {
  constructor(code) {
    this.code = code;
  }
}
export class BreakEx {
  constructor(n) {
    this.n = n;
  }
}
export class ContinueEx {
  constructor(n) {
    this.n = n;
  }
}
export class InterruptEx {
  constructor(sig = 'INT') {
    this.sig = sig;
  }
}

const SIGNALS = ['', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM', 'STKFLT', 'CHLD', 'CONT', 'STOP', 'TSTP', 'TTIN', 'TTOU', 'URG', 'XCPU', 'XFSZ', 'VTALRM', 'PROF', 'WINCH', 'IO', 'PWR', 'SYS'];
export { SIGNALS };

const DECL_BUILTINS = new Set(['declare', 'typeset', 'local', 'export', 'readonly']);

class FileWriter extends Writer {
  constructor(vfs, node, path) {
    super();
    this.vfs = vfs;
    this.node = node;
    this.path = path;
    this.written = 0;
  }
  async write(s) {
    if (this.node.type === 'chr') {
      const d = this.vfs.devices[this.node.dev];
      if (d && d.write) await d.write(s);
      return;
    }
    this.written += s.length;
    if (this.written > this.vfs.limitBytes) throw new FsError('ENOSPC', this.path);
    this.node.data += s;
    this.node.mtime = this.node.ctime = Date.now();
    this.vfs.changed();
  }
}

class ClosedFd extends Writer {
  async write() {
    throw new ShellError('Bad file descriptor', 1, false);
  }
}

let pidCounter = 1000;
export function nextPid() {
  pidCounter += 1 + Math.floor(Math.random() * 3);
  return pidCounter;
}

const yieldNow = typeof MessageChannel !== 'undefined'
  ? () => new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    })
  : () => new Promise((r) => setTimeout(r, 0));

export class Shell {
  constructor({ vfs, commands, term = null, system }) {
    this.vfs = vfs;
    this.commands = commands;
    this.term = term;
    this.system = system; // shared: processes, users, boot time, hostname
    this.globals = new Map();
    this.scopes = [];
    this.functions = new Map();
    this.aliases = new Map();
    this.opts = {
      errexit: false, nounset: false, xtrace: false, pipefail: false, noglob: false, noclobber: false,
      verbose: false, allexport: false, notify: false, monitor: true, hashall: true, braceexpand: true,
      histexpand: true, emacs: true, vi: false, ignoreeof: false, interactive_comments: true, posix: false,
      noexec: false, onecmd: false, keyword: false, physical: false, privileged: false, errtrace: false, functrace: false, history: true, nolog: false,
    };
    this.shopt = {
      autocd: false, cdable_vars: false, cdspell: false, checkhash: false, checkjobs: false, checkwinsize: true,
      cmdhist: true, dotglob: false, execfail: false, expand_aliases: true, extdebug: false, extglob: true,
      extquote: true, failglob: false, force_fignore: true, globasciiranges: true, globstar: false,
      histappend: true, histreedit: false, histverify: false, hostcomplete: true, huponexit: false,
      inherit_errexit: false, interactive_comments: true, lastpipe: false, lithist: false, login_shell: false,
      mailwarn: false, no_empty_cmd_completion: false, nocaseglob: false, nocasematch: false, nullglob: false,
      progcomp: true, promptvars: true, shift_verbose: false, sourcepath: true, xpg_echo: false,
      patsub_replacement: true, globskipdots: true, assoc_expand_once: false, localvar_inherit: false,
    };
    this.positional = [];
    this.argv0 = 'bash';
    this.status = 0;
    this.cwd = '/';
    this.dirstack = [];
    this.history = [];
    this.histBase = 1;
    this.jobs = [];
    this.traps = {};
    this.pid = nextPid();
    this.rootPid = this.pid;
    this.ppid = 1;
    this.funcStack = [];
    this.sourceStack = [];
    this.lineno = 0;
    this.startTime = Date.now();
    this.hash = new Map();
    this.umask = 0o022;
    this.user = { uid: 1000, gid: 1000, name: 'user', groups: [1000, 27] };
    this.interactive = false;
    this.subshellLevel = 0;
    this.ctl = { interrupted: false, waiters: new Set() };
    this.noErrexit = 0;
    this.lastBgPid = undefined;
    this.lastArg = '';
    this.io = null;
    this.ticks = 0;
    this.lastYield = 0;
    this.randomSeed = (Math.random() * 0x7fff) | 0;
    this.scriptName = null;
    this.loopDepth = 0;
    this.jobCounter = 0;
    this.lastSubStatus = 0;
    this.inTrap = false;
  }

  // ---------- variables ----------

  lookupVar(name, depth = 0) {
    let v;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      v = this.scopes[i].get(name);
      if (v) break;
    }
    if (!v) v = this.globals.get(name);
    if (v && v.n && depth < 10 && v.v) {
      const target = v.v.replace(/\[.*$/, '');
      if (target !== name) return this.lookupVar(target, depth + 1) || null;
    }
    return v;
  }

  // the Map the variable lives in (or where it would be created)
  varHome(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i];
    return this.globals;
  }

  resolveNameref(name) {
    for (let d = 0; d < 10; d++) {
      let v;
      for (let i = this.scopes.length - 1; i >= 0 && !v; i--) v = this.scopes[i].get(name);
      if (!v) v = this.globals.get(name);
      if (v && v.n && v.v) name = v.v;
      else return name;
    }
    return name;
  }

  dynamicVar(name) {
    switch (name) {
      case 'RANDOM':
        this.randomSeed = (this.randomSeed * 1103515245 + 12345) & 0x7fffffff;
        return String((this.randomSeed >> 16) & 0x7fff);
      case 'SRANDOM':
        return String((Math.random() * 0xffffffff) >>> 0);
      case 'SECONDS':
        return String(Math.floor((Date.now() - this.startTime) / 1000) + (this.secondsBase || 0));
      case 'LINENO':
        return String(this.lineno);
      case 'EPOCHSECONDS':
        return String(Math.floor(Date.now() / 1000));
      case 'EPOCHREALTIME': {
        const t = Date.now();
        return Math.floor(t / 1000) + '.' + String((t % 1000) * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0');
      }
      case 'BASHPID':
        return String(this.pid);
      case 'BASH_SUBSHELL':
        return String(this.subshellLevel);
      case 'HISTCMD':
        return String(this.histBase + this.history.length);
      case 'PPID':
        return String(this.ppid);
      case 'UID':
        return String(this.user.uid);
      case 'EUID':
        return String(this.vfs.cred.uid);
      case 'COLUMNS':
        if (this.term && !this.globals.get('COLUMNS')?.set) return String(this.term.cols);
        return undefined;
      case 'LINES':
        if (this.term && !this.globals.get('LINES')?.set) return String(this.term.rows);
        return undefined;
      case 'BASH_COMMAND':
        return this.currentCommand || '';
      case 'SHELLOPTS':
        return Object.keys(this.opts).filter((k) => this.opts[k]).sort().join(':');
      case 'BASHOPTS':
        return Object.keys(this.shopt).filter((k) => this.shopt[k]).sort().join(':');
    }
    return undefined;
  }

  arrayVar(name) {
    switch (name) {
      case 'FUNCNAME':
        return this.funcStack.length ? [...this.funcStack].reverse().concat(this.scriptName ? ['main'] : []) : null;
      case 'BASH_SOURCE':
        return this.funcStack.length || this.sourceStack.length ? [...this.sourceStack].reverse() : null;
      case 'DIRSTACK':
        return [this.tildeShort(this.cwd), ...this.dirstack.map((d) => this.tildeShort(d))];
      case 'GROUPS':
        return this.user.groups.map(String);
      case 'BASH_ARGV':
        return [...this.positional].reverse();
      case 'BASH_ARGC':
        return [String(this.positional.length)];
    }
    return null;
  }

  getVar(name) {
    const d = this.dynamicVar(name);
    if (d !== undefined) return d;
    const arr = this.arrayVar(name);
    if (arr) return arr[0];
    const v = this.lookupVar(name);
    if (!v) return undefined;
    if (v.a) return v.a.get(0);
    if (v.A) return v.A.get('0');
    return v.v;
  }

  getParam(name, sub) {
    if (sub !== null && sub !== undefined) return this.getElement(name, sub);
    if (/^[0-9]+$/.test(name)) {
      const n = parseInt(name, 10);
      if (n === 0) return this.argv0;
      return this.positional[n - 1];
    }
    switch (name) {
      case '?':
        return String(this.status);
      case '$':
        return String(this.rootPid);
      case '!':
        return this.lastBgPid === undefined ? undefined : String(this.lastBgPid);
      case '#':
        return String(this.positional.length);
      case '-': {
        let s = '';
        const map = { allexport: 'a', braceexpand: 'B', errexit: 'e', hashall: 'h', histexpand: 'H', monitor: 'm', noclobber: 'C', noglob: 'f', nounset: 'u', verbose: 'v', xtrace: 'x', noexec: 'n', notify: 'b', privileged: 'p', errtrace: 'E', functrace: 'T', keyword: 'k', onecmd: 't', physical: 'P' };
        for (const [k, c] of Object.entries(map)) if (this.opts[k]) s += c;
        if (this.interactive) s += 'i';
        return [...s].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).join('');
      }
      case '_':
        return this.lastArg;
      case '@':
      case '*':
        return this.positional.join(name === '*' ? (this.ifsValue()[0] ?? '') : ' ');
    }
    return this.getVar(name);
  }

  getElement(name, sub) {
    const arr = this.arrayVar(name);
    if (arr) {
      const i = Number(this.evalArith(sub));
      return arr[i < 0 ? arr.length + i : i];
    }
    const v = this.lookupVar(name);
    if (v && v.A) return v.A.get(sub);
    const i = Number(this.evalArith(sub || '0'));
    if (!v) return undefined;
    if (v.a) {
      if (i < 0) {
        const keys = [...v.a.keys()];
        const max = keys.length ? Math.max(...keys) : -1;
        return v.a.get(max + 1 + i);
      }
      return v.a.get(i);
    }
    if (i === 0 || i === -1) return v.v;
    return undefined;
  }

  newVar(home, name) {
    const v = { v: undefined };
    if (this.opts.allexport) v.x = true;
    home.set(name, v);
    return v;
  }

  checkWritable(name, v) {
    if (v && v.r) throw new ShellError(`${name}: readonly variable`, 1, false);
  }

  transformValue(v, val, name) {
    if (v.i) {
      try {
        val = String(this.evalArith(val || '0'));
      } catch (e) {
        if (e instanceof ArithError) throw new ShellError(e.message, 1, false);
        throw e;
      }
    }
    if (v.u) val = val.toUpperCase();
    if (v.l) val = val.toLowerCase();
    return val;
  }

  setVar(name, val, { append = false } = {}) {
    name = this.resolveNameref(name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ShellError(`\`${name}': not a valid identifier`, 1, false);
    switch (name) {
      case 'RANDOM':
        this.randomSeed = parseInt(val, 10) || 0;
        return;
      case 'SECONDS':
        this.startTime = Date.now();
        this.secondsBase = parseInt(val, 10) || 0;
        return;
      case 'LINENO':
      case 'BASHPID':
      case 'EPOCHSECONDS':
      case 'EPOCHREALTIME':
        return;
    }
    const home = this.varHome(name);
    let v = home.get(name) || this.newVar(home, name);
    this.checkWritable(name, v);
    if (append) {
      if (v.i) val = String(this.evalArith(`(${this.getVar(name) || 0})+(${val || 0})`));
      else val = (v.a ? v.a.get(0) ?? '' : v.A ? v.A.get('0') ?? '' : v.v ?? '') + val;
      if (v.i) {
        v.i = false;
        val = this.transformValue(v, val, name);
        v.i = true;
      } else val = this.transformValue(v, val, name);
    } else val = this.transformValue(v, val, name);
    if (v.a) v.a.set(0, val);
    else if (v.A) v.A.set('0', val);
    else v.v = val;
    if (this.opts.allexport) v.x = true;
    if (name === 'PWD' && false) this.cwd = val;
    if (name === 'HISTSIZE') this.trimHistory();
  }

  setElement(name, sub, val, { append = false } = {}) {
    name = this.resolveNameref(name);
    const home = this.varHome(name);
    let v = home.get(name) || this.newVar(home, name);
    this.checkWritable(name, v);
    if (v.A) {
      if (append) val = (v.A.get(sub) ?? '') + val;
      v.A.set(sub, this.transformValue(v, val, name));
      return;
    }
    if (!v.a) {
      v.a = new Map();
      if (v.v !== undefined) v.a.set(0, v.v);
      delete v.v;
    }
    let i = Number(this.evalArith(sub || '0'));
    if (i < 0) {
      const keys = [...v.a.keys()];
      const max = keys.length ? Math.max(...keys) : -1;
      i = max + 1 + i;
      if (i < 0) throw new ShellError(`${name}[${sub}]: bad array subscript`, 1, false);
    }
    if (append) val = (v.a.get(i) ?? '') + val;
    v.a.set(i, this.transformValue(v, val, name));
  }

  setArray(name, values, { append = false, assoc = null } = {}) {
    name = this.resolveNameref(name);
    const home = this.varHome(name);
    let v = home.get(name) || this.newVar(home, name);
    this.checkWritable(name, v);
    if (v.A || assoc) {
      if (!v.A || !append) v.A = new Map();
      delete v.v;
      delete v.a;
      for (const [k, x] of values) {
        if (k === null) throw new ShellError(`${name}: ${x}: must use subscript when assigning associative array`, 1, false);
        v.A.set(k, this.transformValue(v, x, name));
      }
      return;
    }
    let base = 0;
    if (append) {
      if (!v.a) {
        v.a = new Map();
        if (v.v !== undefined) v.a.set(0, v.v);
      }
      const keys = [...v.a.keys()];
      base = keys.length ? Math.max(...keys) + 1 : 0;
    } else v.a = new Map();
    delete v.v;
    let idx = base;
    for (const [k, x] of values) {
      if (k !== null) idx = Number(this.evalArith(k));
      v.a.set(idx, this.transformValue(v, x, name));
      idx++;
    }
  }

  unsetVar(name) {
    if (this.functions.has(name) && !this.lookupVar(name)) return;
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(name);
      if (v) {
        if (v.r) throw new ShellError(`${name}: cannot unset: readonly variable`, 1, false);
        // unsetting a local makes the variable appear unset in this scope
        this.scopes[i].set(name, { v: undefined, unsetLocal: true });
        return;
      }
    }
    const v = this.globals.get(name);
    if (v) {
      if (v.r) throw new ShellError(`${name}: cannot unset: readonly variable`, 1, false);
      this.globals.delete(name);
    }
  }

  unsetElement(name, sub) {
    const v = this.lookupVar(name);
    if (!v) return;
    this.checkWritable(name, v);
    if (v.A) v.A.delete(sub);
    else if (v.a) {
      let i = Number(this.evalArith(sub));
      if (i < 0) {
        const keys = [...v.a.keys()];
        i = Math.max(...keys) + 1 + i;
      }
      v.a.delete(i);
    } else if (Number(this.evalArith(sub)) === 0) this.unsetVar(name);
  }

  allVarNames() {
    const names = new Set(this.globals.keys());
    for (const s of this.scopes) for (const [k, v] of s) if (!v.unsetLocal) names.add(k);
    for (const k of ['RANDOM', 'SECONDS', 'LINENO', 'EPOCHSECONDS', 'EPOCHREALTIME', 'BASHPID', 'BASH_SUBSHELL', 'HISTCMD', 'PPID', 'UID', 'EUID', 'SRANDOM', 'COLUMNS', 'LINES', 'GROUPS', 'DIRSTACK', 'SHELLOPTS', 'BASHOPTS', 'BASH_COMMAND']) names.add(k);
    return [...names].filter((k) => this.getVar(k) !== undefined || this.lookupVar(k)).sort();
  }

  isSet(name) {
    const v = this.lookupVar(name);
    return !!v && (v.v !== undefined || !!v.a || !!v.A);
  }

  exportedEnv() {
    const env = {};
    const seen = new Set();
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      for (const [k, v] of this.scopes[i]) {
        if (seen.has(k)) continue;
        seen.add(k);
        if (v.x && v.v !== undefined) env[k] = v.v;
      }
    }
    for (const [k, v] of this.globals) {
      if (seen.has(k)) continue;
      if (v.x && v.v !== undefined) env[k] = v.v;
    }
    return env;
  }

  homeOf(user) {
    const u = this.system.userByName(user);
    return u ? u.home : undefined;
  }

  tildeShort(p) {
    const home = this.getVar('HOME');
    if (home && home !== '/' && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
    return p;
  }

  quoteValue(s) {
    if (s === '') return "''";
    if (/[\x00-\x1f\x7f]/.test(s)) {
      return "$'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\x00-\x1f\x7f]/g, (c) => {
        const m = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x1b': '\\E', '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\v': '\\v' };
        return m[c] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0');
      }) + "'";
    }
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  // quoting used by `set`, `declare -p` for scalars (bash uses double quotes there)
  dquote(s) {
    if (/[\x00-\x1f\x7f]/.test(s)) return this.quoteValue(s);
    return '"' + s.replace(/[\\"$`]/g, '\\$&') + '"';
  }

  attrString(v) {
    let s = '';
    if (v.a) s += 'a';
    if (v.A) s += 'A';
    if (v.i) s += 'i';
    if (v.l) s += 'l';
    if (v.n) s += 'n';
    if (v.r) s += 'r';
    if (v.t) s += 't';
    if (v.u) s += 'u';
    if (v.x) s += 'x';
    return s;
  }

  declareLine(name, v, assignOnly = false) {
    const attrs = this.attrString(v);
    let val = '';
    if (v.a) {
      const keys = [...v.a.keys()].sort((a, b) => a - b);
      val = '=(' + keys.map((k) => `[${k}]=${this.dquote(v.a.get(k))}`).join(' ') + ')';
    } else if (v.A) {
      val = '=(' + [...v.A.entries()].map(([k, x]) => `[${/^[A-Za-z0-9_]+$/.test(k) ? k : this.dquote(k)}]=${this.dquote(x)} `).join('') + ')';
    } else if (v.v !== undefined) val = '=' + this.dquote(v.v);
    if (assignOnly && !attrs) return `${name}${val.replace(/^=\(/, '=(')}`;
    return `declare -${attrs || '-'} ${name}${val}`;
  }

  trimHistory() {
    const n = parseInt(this.getVar('HISTSIZE') ?? '1000', 10);
    if (n >= 0 && this.history.length > n) {
      const drop = this.history.length - n;
      this.history.splice(0, drop);
      this.histBase += drop;
    }
  }

  // ---------- subshells ----------

  cloneVars(m) {
    const out = new Map();
    for (const [k, v] of m) {
      const c = { ...v };
      if (v.a) c.a = new Map(v.a);
      if (v.A) c.A = new Map(v.A);
      out.set(k, c);
    }
    return out;
  }

  subshell({ fresh = false } = {}) {
    const s = new Shell({ vfs: this.vfs, commands: this.commands, term: this.term, system: this.system });
    s.parentShell = this;
    if (fresh) {
      // a new process running a script: only exported variables survive
      for (const [k, v] of Object.entries(this.exportedEnv())) s.globals.set(k, { v, x: true });
      for (const [k, f] of this.functions) if (f.exported) s.functions.set(k, f);
      s.subshellLevel = 0;
      s.ppid = this.pid;
      s.pid = nextPid();
      s.rootPid = s.pid;
      s.shopt.expand_aliases = false;
    } else {
      s.globals = this.cloneVars(this.globals);
      s.scopes = this.scopes.map((m) => this.cloneVars(m));
      s.functions = new Map(this.functions);
      s.aliases = new Map(this.aliases);
      s.positional = this.positional.slice();
      s.argv0 = this.argv0;
      s.funcStack = this.funcStack.slice();
      s.sourceStack = this.sourceStack.slice();
      s.subshellLevel = this.subshellLevel + 1;
      s.rootPid = this.rootPid;
      s.pid = nextPid();
      s.ppid = this.pid;
      s.traps = {};
      for (const [k, v] of Object.entries(this.traps)) if (k !== 'EXIT' && v === '') s.traps[k] = v;
      s.lastBgPid = this.lastBgPid;
      s.scriptName = this.scriptName;
      s.dirstack = this.dirstack.slice();
      s.history = this.history;
      s.histBase = this.histBase;
      s.jobs = [];
      s.startTime = this.startTime;
      s.secondsBase = this.secondsBase;
      s.lineno = this.lineno;
      s.status = this.status;
      s.lastArg = this.lastArg;
      s.interactiveParent = this.interactive || this.interactiveParent;
      s.loopDepth = 0;
    }
    s.opts = { ...this.opts };
    s.shopt = { ...this.shopt };
    if (fresh) s.opts.monitor = false;
    s.cwd = this.cwd;
    s.umask = this.umask;
    s.user = this.user;
    s.hash = new Map(this.hash);
    s.ctl = this.ctl;
    s.randomSeed = (this.randomSeed * 31 + s.pid) & 0x7fffffff;
    s.interactive = false;
    return s;
  }

  // ---------- running ----------

  async tick() {
    if (this.ctl.interrupted) throw new InterruptEx(this.ctl.sig || 'INT');
    if ((++this.ticks & 63) === 0) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - this.lastYield > 25) {
        this.lastYield = now;
        await yieldNow();
        if (this.ctl.interrupted) throw new InterruptEx(this.ctl.sig || 'INT');
      }
    }
  }

  async sleep(ms) {
    if (this.ctl.interrupted) throw new InterruptEx(this.ctl.sig || 'INT');
    await new Promise((resolve) => {
      const t = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(t);
        self.ctl.waiters.delete(done);
        resolve();
      }
      this.ctl.waiters.add(done);
    });
    if (this.ctl.interrupted) throw new InterruptEx(this.ctl.sig || 'INT');
  }

  interrupt(sig = 'INT') {
    this.ctl.interrupted = true;
    this.ctl.sig = sig;
    for (const w of [...this.ctl.waiters]) w();
    if (this.ctl.onInterrupt) for (const f of [...this.ctl.onInterrupt]) f();
  }

  errPrefix() {
    if (this.interactive || (!this.scriptName && this.interactiveParent)) return 'bash: ';
    if (this.scriptName) return `${this.scriptName}: line ${this.lineno}: `;
    return `bash: line ${this.lineno}: `;
  }

  async report(msg, io = this.io) {
    const w = io && io[2];
    if (w) {
      try {
        await w.write(this.errPrefix() + msg + '\n');
      } catch {}
    }
  }

  parse(src, interactive = false) {
    return parse(src, { aliases: this.shopt.expand_aliases ? this.aliases : null, interactive });
  }

  // run source text in this shell; returns status. Catches syntax errors.
  async runSource(src, io, { catchExit = false } = {}) {
    let ast;
    try {
      ast = this.parse(src, false);
    } catch (e) {
      if (e instanceof ParseError) {
        await this.report(e.message, io);
        this.status = 2;
        return 2;
      }
      throw e;
    }
    for (const w of ast.warnings || []) await this.report(w, io);
    try {
      return await this.execNode(ast, io);
    } catch (e) {
      if (catchExit && e instanceof ExitEx) return e.code;
      throw e;
    }
  }

  // run a whole script/command line at top level, handling exit and fatal errors
  async runTop(src, io) {
    try {
      return await this.runSource(src, io);
    } catch (e) {
      return this.handleTopError(e, io);
    }
  }

  async handleTopError(e, io) {
    if (e instanceof ExitEx) throw e;
    if (e instanceof ShellError) {
      await this.report(e.message, io);
      this.status = e.status;
      if (!this.interactive && e.fatal) throw new ExitEx(e.status);
      return e.status;
    }
    if (e instanceof InterruptEx) throw e;
    if (e instanceof ReturnEx || e instanceof BreakEx || e instanceof ContinueEx) return this.status;
    throw e;
  }

  async execNode(node, io) {
    const saved = this.io;
    this.io = io;
    try {
      if (node.redirs && node.redirs.length && node.type !== 'simple') {
        const r = await this.applyRedirs(node.redirs, io);
        if (!r) return (this.status = 1);
        try {
          this.io = r.io;
          return (this.status = await this.execInner(node, r.io));
        } finally {
          await r.cleanup();
        }
      }
      return (this.status = await this.execInner(node, io));
    } finally {
      this.io = saved;
    }
  }

  async execInner(node, io) {
    switch (node.type) {
      case 'list':
        return this.execList(node, io);
      case 'andor':
        return this.execAndOr(node, io);
      case 'pipeline':
        return this.execPipeline(node, io);
      case 'simple':
        return this.execSimple(node, io);
      case 'group':
        return this.execNode(node.body, io);
      case 'subshell':
        return this.execSubshell(node.body, io);
      case 'if':
        return this.execIf(node, io);
      case 'while':
        return this.execWhile(node, io);
      case 'for':
        return this.execFor(node, io);
      case 'arfor':
        return this.execArFor(node, io);
      case 'select':
        return this.execSelect(node, io);
      case 'case':
        return this.execCase(node, io);
      case 'func':
        this.functions.set(node.name, { body: node.body, text: node.text, name: node.name });
        return 0;
      case 'arith':
        return this.execArith(node, io);
      case 'cond':
        return this.execCond(node, io);
    }
    throw new Error('unknown node ' + node.type);
  }

  async execList(node, io) {
    let status = 0;
    for (const item of node.items) {
      await this.tick();
      if (item.bg) {
        status = await this.startJob(item.node, io);
        continue;
      }
      this.shortCircuit = false;
      status = await this.execNode(item.node, io);
      this.status = status;
      if (status !== 0 && !this.noErrexit && !this.shortCircuit && !(item.node.type === 'pipeline' && item.node.bang)) {
        if (this.traps.ERR && !this.inTrap) await this.runTrap('ERR', io);
        if (this.opts.errexit) throw new ExitEx(status);
      }
    }
    return status;
  }

  async execAndOr(node, io) {
    let status;
    this.noErrexit++;
    try {
      status = await this.execNode(node.parts[0], io);
    } finally {
      this.noErrexit--;
    }
    for (let i = 0; i < node.ops.length; i++) {
      const op = node.ops[i];
      if ((op === '&&' && status !== 0) || (op === '||' && status === 0)) {
        this.shortCircuit = true;
        continue;
      }
      const last = i === node.ops.length - 1;
      if (!last) this.noErrexit++;
      try {
        status = await this.execNode(node.parts[i + 1], io);
      } finally {
        if (!last) this.noErrexit--;
      }
      this.shortCircuit = false;
    }
    if (node.ops.length && this.shortCircuitLast(node, status)) this.shortCircuit = true;
    return status;
  }

  shortCircuitLast(node, status) {
    return this.shortCircuit;
  }

  async execPipeline(node, io) {
    const n = node.cmds.length;
    const t0 = Date.now();
    let statuses;
    if (node.bang) this.noErrexit++;
    try {
      if (n === 1) {
        statuses = [await this.execNode(node.cmds[0], io)];
      } else {
        const pipes = [];
        for (let i = 0; i < n - 1; i++) pipes.push(new Pipe());
        const runs = node.cmds.map(async (cmd, i) => {
          const fds = { ...io };
          if (i > 0) fds[0] = pipes[i - 1].reader;
          if (i < n - 1) {
            fds[1] = pipes[i].writer;
            if (node.errs[i]) fds[2] = pipes[i].writer;
          }
          const sh = i === n - 1 && this.shopt.lastpipe && !this.opts.monitor ? this : this.subshell();
          try {
            return await sh.execNode(cmd, fds);
          } catch (e) {
            if (e instanceof EPIPE || e?.code === 'EPIPE') return 141;
            if (e instanceof ExitEx) return e.code;
            if (e instanceof ShellError) {
              await sh.report(e.message, fds);
              return e.status;
            }
            if (e instanceof ReturnEx || e instanceof BreakEx || e instanceof ContinueEx) return sh.status;
            throw e;
          } finally {
            if (i < n - 1) pipes[i].writer.close();
            if (i > 0) pipes[i - 1].reader.close();
            if (sh !== this && sh.traps.EXIT) await sh.runTrap('EXIT', fds);
          }
        });
        statuses = await Promise.all(runs);
      }
    } finally {
      if (node.bang) this.noErrexit--;
    }
    if (n > 1 || node.time || node.bang) this.setArray('PIPESTATUS', statuses.map((s) => [null, String(s)]));
    let status = statuses[statuses.length - 1];
    if (this.opts.pipefail) {
      for (let i = statuses.length - 1; i >= 0; i--) if (statuses[i] !== 0) {
        status = statuses[i];
        break;
      }
    }
    if (node.bang) status = status === 0 ? 1 : 0;
    if (node.time) {
      const dt = (Date.now() - t0) / 1000;
      const fmt = (s) => `${Math.floor(s / 60)}m${(s % 60).toFixed(3)}s`;
      const tf = this.getVar('TIMEFORMAT');
      let msg;
      if (tf !== undefined) {
        msg = tf.replace(/%(\d)?(l)?([RUSP%])/g, (m, p, l, c) => {
          if (c === '%') return '%';
          const v = c === 'R' ? dt : c === 'P' ? 0 : dt * 0.01;
          if (c === 'P') return (dt ? 1 : 0).toFixed(p ?? 2);
          return l ? fmt(v) : v.toFixed(p === undefined ? 3 : Number(p));
        }) + '\n';
      } else msg = `\nreal\t${fmt(dt)}\nuser\t${fmt(dt * 0.01)}\nsys\t${fmt(dt * 0.005)}\n`;
      await io[2].write(msg);
    }
    return status;
  }

  async execSubshell(body, io) {
    const sh = this.subshell();
    try {
      return await sh.execNode(body, io);
    } catch (e) {
      if (e instanceof ExitEx) return e.code;
      if (e instanceof ShellError) {
        await sh.report(e.message, io);
        return e.status;
      }
      if (e instanceof ReturnEx || e instanceof BreakEx || e instanceof ContinueEx) return sh.status;
      throw e;
    } finally {
      if (sh.traps.EXIT) await sh.runTrap('EXIT', io);
    }
  }

  async execIf(node, io) {
    for (const c of node.clauses) {
      let st;
      this.noErrexit++;
      try {
        st = await this.execNode(c.cond, io);
      } finally {
        this.noErrexit--;
      }
      if (st === 0) return this.execNode(c.body, io);
    }
    if (node.else) return this.execNode(node.else, io);
    return 0;
  }

  async loopBody(body, io) {
    try {
      return { status: await this.execNode(body, io) };
    } catch (e) {
      if (e instanceof BreakEx) {
        if (e.n > 1) throw new BreakEx(e.n - 1);
        return { status: 0, brk: true };
      }
      if (e instanceof ContinueEx) {
        if (e.n > 1) throw new ContinueEx(e.n - 1);
        return { status: 0 };
      }
      throw e;
    }
  }

  async execWhile(node, io) {
    let status = 0;
    this.loopDepth++;
    try {
      for (;;) {
        await this.tick();
        let st;
        this.noErrexit++;
        try {
          st = await this.execNode(node.cond, io);
        } finally {
          this.noErrexit--;
        }
        if (node.until ? st === 0 : st !== 0) break;
        const r = await this.loopBody(node.body, io);
        status = r.status;
        if (r.brk) break;
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  async execFor(node, io) {
    const words = node.words === null ? this.positional.slice() : await this.expandWords(node.words);
    let status = 0;
    this.loopDepth++;
    try {
      for (const w of words) {
        await this.tick();
        this.setVar(node.name, w);
        const r = await this.loopBody(node.body, io);
        status = r.status;
        if (r.brk) break;
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  async arithStatus(expr) {
    const s = await this.expandArithText(expr);
    if (s.trim() === '') return 1n;
    try {
      return this.evalArith(s);
    } catch (e) {
      if (e instanceof ArithError) throw new ShellError(`((: ${e.message}`, 1, false);
      throw e;
    }
  }

  async execArFor(node, io) {
    let status = 0;
    this.loopDepth++;
    try {
      if (node.init.trim()) await this.arithStatus(node.init);
      for (;;) {
        await this.tick();
        if (node.cond.trim() && (await this.arithStatus(node.cond)) === 0n) break;
        const r = await this.loopBody(node.body, io);
        status = r.status;
        if (r.brk) break;
        if (node.step.trim()) await this.arithStatus(node.step);
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  async execSelect(node, io) {
    const words = node.words === null ? this.positional.slice() : await this.expandWords(node.words);
    let status = 0;
    const menu = async () => {
      const w = String(words.length).length;
      let s = '';
      words.forEach((x, i) => (s += `${String(i + 1).padStart(w)}) ${x}\n`));
      await io[2].write(s);
    };
    await menu();
    this.loopDepth++;
    try {
      for (;;) {
        await this.tick();
        const ps3 = this.getVar('PS3') ?? '#? ';
        await io[2].write(ps3);
        const line = await io[0].readLine();
        if (line === null) {
          await io[2].write('\n');
          status = 1;
          break;
        }
        this.setVar('REPLY', line);
        if (line.trim() === '') {
          await menu();
          continue;
        }
        const n = parseInt(line, 10);
        this.setVar(node.name, n >= 1 && n <= words.length && String(n) === line.trim() ? words[n - 1] : '');
        const r = await this.loopBody(node.body, io);
        status = r.status;
        if (r.brk) break;
      }
    } finally {
      this.loopDepth--;
    }
    return status;
  }

  async execCase(node, io) {
    const word = await this.expandString(node.word);
    let status = 0;
    let fall = false;
    for (let i = 0; i < node.items.length; i++) {
      const it = node.items[i];
      let matched = fall;
      if (!matched) {
        for (const p of it.patterns) {
          const pat = await this.expandPattern(p);
          if (matchPattern(pat, word, { extglob: this.shopt.extglob, nocase: this.shopt.nocasematch })) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) continue;
      status = await this.execNode(it.body, io);
      fall = false;
      if (it.term === ';&') {
        fall = true;
        continue;
      }
      if (it.term === ';;&') continue;
      break;
    }
    return status;
  }

  async execArith(node, io) {
    this.lineno = node.line || this.lineno;
    try {
      const v = await this.arithStatus(node.expr);
      if (this.opts.xtrace) await this.xtrace(['((', node.expr.trim(), '))'], io);
      return v !== 0n ? 0 : 1;
    } catch (e) {
      if (e instanceof ShellError) {
        await this.report(e.message, io);
        return 1;
      }
      throw e;
    }
  }

  async execCond(node, io) {
    try {
      const r = await this.evalCond(node.expr);
      if (this.opts.xtrace) await this.xtrace(['[[', '...', ']]'], io);
      return r ? 0 : 1;
    } catch (e) {
      if (e instanceof ShellError) {
        await this.report(e.message, io);
        return 2;
      }
      throw e;
    }
  }

  async evalCond(e) {
    switch (e.op) {
      case '!':
        return !(await this.evalCond(e.a));
      case '&&':
        return (await this.evalCond(e.a)) && (await this.evalCond(e.b));
      case '||':
        return (await this.evalCond(e.a)) || (await this.evalCond(e.b));
    }
    if (e.unary) {
      const a = await this.expandString(e.a);
      return this.commands.get('test').unary(this, e.op, a);
    }
    const a = await this.expandString(e.a);
    if (e.op === '==' || e.op === '=' || e.op === '!=') {
      const pat = await this.expandPattern(e.b);
      const m = matchPattern(pat, a, { extglob: true, nocase: this.shopt.nocasematch });
      return e.op === '!=' ? !m : m;
    }
    if (e.op === '=~') {
      const src = await this.expandPattern(e.b, true);
      let re;
      try {
        re = new RegExp(posixToJsRegex(src), this.shopt.nocasematch ? 'i' : '');
      } catch {
        throw new ShellError(`invalid regular expression`, 2, false);
      }
      const m = re.exec(a);
      if (!m) {
        this.setArray('BASH_REMATCH', []);
        return false;
      }
      this.setArray('BASH_REMATCH', [...m].map((x) => [null, x ?? '']));
      return true;
    }
    const b = await this.expandString(e.b);
    if (e.op === '<') return a < b;
    if (e.op === '>') return a > b;
    if (['-eq', '-ne', '-lt', '-le', '-gt', '-ge'].includes(e.op)) {
      const x = this.evalArith(a || '0');
      const y = this.evalArith(b || '0');
      return { '-eq': x === y, '-ne': x !== y, '-lt': x < y, '-le': x <= y, '-gt': x > y, '-ge': x >= y }[e.op];
    }
    return this.commands.get('test').binary(this, e.op, a, b);
  }

  // ---------- simple commands ----------

  async doAssign(a, { local = false, exportIt = false } = {}) {
    if (a.array) {
      const v = this.lookupVar(a.name);
      const assoc = v && v.A;
      const values = [];
      for (const w of a.array) {
        const m = /^\[([^\]]*)\](\+?)=(.*)$/s.exec(w);
        if (m) values.push([await this.expandString(m[1]), await this.expandAssignValue(m[3])]);
        else if (assoc) {
          // bash 5.1+: key value pairs
          for (const x of await this.expandWords([w])) values.push(x);
        } else for (const x of await this.expandWords([w])) values.push([null, x]);
      }
      if (assoc && values.some((x) => typeof x === 'string')) {
        const flat = values.map((x) => (typeof x === 'string' ? x : null));
        const pairs = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1] ?? '']);
        this.setArray(a.name, pairs, { append: a.append });
      } else this.setArray(a.name, values, { append: a.append });
      return;
    }
    const val = await this.expandAssignValue(a.value);
    if (a.index !== null) {
      const v = this.lookupVar(a.name);
      const sub = await this.expandString(a.index);
      if (v && v.A) this.setElement(a.name, sub, val, { append: a.append });
      else this.setElement(a.name, sub, val, { append: a.append });
    } else this.setVar(a.name, val, { append: a.append });
    if (exportIt) this.lookupVar(a.name).x = true;
  }

  async xtrace(words, io) {
    const ps4 = this.getVar('PS4') ?? '+ ';
    let p = ps4;
    try {
      p = await this.expandText(ps4);
    } catch {}
    const lvl = p[0] ? p[0].repeat(this.subshellLevel) : '';
    const q = words.map((w) => (/^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(w) ? w : this.quoteValue(w)));
    await io[2].write(lvl + p + q.join(' ') + '\n');
  }

  async expandArgs(node) {
    const words = node.words;
    if (words.length && DECL_BUILTINS.has(words[0]) && (!this.functions.has(words[0]))) {
      const out = [words[0]];
      for (const w of words.slice(1)) {
        if (isAssignWord(w)) {
          const a = parseAssign(w);
          if (a.array) {
            const values = [];
            for (const x of a.array) {
              const m = /^\[([^\]]*)\]=(.*)$/s.exec(x);
              if (m) values.push([await this.expandString(m[1]), await this.expandAssignValue(m[2])]);
              else for (const y of await this.expandWords([x])) values.push([null, y]);
            }
            out.push({ assign: a.name, append: a.append, array: values });
          } else {
            const val = await this.expandAssignValue(a.value);
            out.push({ assign: a.name, index: a.index !== null ? await this.expandString(a.index) : null, append: a.append, value: val });
          }
        } else out.push(...(await this.expandWords([w])));
      }
      return out;
    }
    return this.expandWords(words);
  }

  async execSimple(node, io) {
    this.lineno = node.line || this.lineno;
    this.lastSubStatus = 0;
    let argv;
    try {
      argv = await this.expandArgs(node);
    } catch (e) {
      if (e instanceof ShellError) {
        await this.report(e.message, io);
        if (!this.interactive && e.fatal) throw new ExitEx(this.subshellLevel > 0 ? 1 : e.status);
        return e.status === 127 ? 1 : e.status;
      }
      throw e;
    }
    if (argv.length === 0) {
      try {
        for (const a of node.assigns) await this.doAssign(a);
      } catch (e) {
        if (e instanceof ShellError) {
          await this.report(e.message, io);
          if (!this.interactive && e.message.includes('readonly')) throw new ExitEx(1);
          if (!this.interactive && e.fatal) throw new ExitEx(this.subshellLevel > 0 ? 1 : e.status);
          return 1;
        }
        throw e;
      }
      if (this.opts.xtrace && node.assigns.length) {
        await this.xtrace(node.assigns.map((a) => `${a.name}${a.index !== null ? `[${a.index}]` : ''}${a.append ? '+' : ''}=${a.array ? '(...)' : this.getVar(a.name) ?? ''}`), io);
      }
      if (node.redirs.length) {
        const r = await this.applyRedirs(node.redirs, io);
        if (!r) return 1;
        await r.cleanup();
      }
      return this.lastSubStatus;
    }
    const name = typeof argv[0] === 'string' ? argv[0] : '';
    // temporary environment for prefix assignments
    let tempScope = null;
    if (node.assigns.length) {
      tempScope = new Map();
      tempScope.tempEnv = true;
      const vals = [];
      for (const a of node.assigns) {
        if (a.array) continue;
        vals.push([a.name, await this.expandAssignValue(a.value), a.append]);
      }
      for (const [k, v, ap] of vals) {
        const old = this.getVar(k);
        tempScope.set(k, { v: ap ? (old ?? '') + v : v, x: true });
      }
    }
    const r = await this.applyRedirs(node.redirs, io);
    if (!r) return 1;
    const cio = r.io;
    if (this.opts.xtrace) {
      const parts = [];
      for (const a of node.assigns) parts.push(`${a.name}=${tempScope?.get(a.name)?.v ?? ''}`);
      for (const x of argv) parts.push(typeof x === 'string' ? x : `${x.assign}=${x.value ?? '(...)'}`);
      await this.xtrace(parts, cio);
    }
    this.currentCommand = node.text || argv.join(' ');
    let status;
    if (tempScope) this.scopes.push(tempScope);
    const savedIo = this.io;
    this.io = cio;
    this.parentIo = io;
    try {
      status = await this.runCommand(argv, cio, { tempScope });
    } catch (e) {
      if (e instanceof EPIPE || e?.code === 'EPIPE') status = 141;
      else if (e instanceof ShellError) {
        await this.report(e.message, cio);
        status = e.status;
        if (!this.interactive && e.fatal && e.fatalAlways) throw new ExitEx(status);
      } else throw e;
    } finally {
      this.io = savedIo;
      if (tempScope) {
        const i = this.scopes.lastIndexOf(tempScope);
        if (i >= 0) this.scopes.splice(i, 1);
      }
      await r.cleanup();
      if (this.psubFiles && this.psubFiles.length) await this.flushPsubs(argv[0] === 'exec' && argv.length === 1);
    }
    const last = argv[argv.length - 1];
    this.lastArg = typeof last === 'string' ? last : last.assign;
    return status;
  }

  findInPath(name) {
    if (name.includes('/')) return name;
    const path = this.getVar('PATH') ?? '';
    for (const dir of path.split(':')) {
      const p = (dir || '.') + '/' + name;
      try {
        const n = this.vfs.stat(p, this.cwd);
        if (n.type === 'file' && n.mode & 0o111) return p;
      } catch {}
    }
    return null;
  }

  commandType(name) {
    if (this.aliases.has(name)) return 'alias';
    if (RESERVED_WORDS.has(name)) return 'keyword';
    if (this.functions.has(name)) return 'function';
    const c = this.commands.get(name);
    if (c && c.builtin) return 'builtin';
    if (this.findInPath(name)) return 'file';
    return null;
  }

  makeCtx(argv, io, extra = {}) {
    const shell = this;
    const name = argv[0];
    const ctx = {
      shell,
      argv,
      name: typeof name === 'string' ? name.split('/').pop() : name,
      args: argv.slice(1),
      io,
      stdin: io[0],
      stdout: io[1],
      stderr: io[2],
      vfs: this.vfs,
      get cwd() {
        return shell.cwd;
      },
      get env() {
        return shell.exportedEnv();
      },
      out: (s) => io[1].write(s),
      err: (s) => io[2].write(s),
      error: (msg) => io[2].write(`${ctx.name}: ${msg}\n`),
      tick: () => shell.tick(),
      ...extra,
    };
    return ctx;
  }

  async runCommand(argv, io, { tempScope = null, skipFunctions = false, onlyBuiltin = false } = {}) {
    const name = argv[0];
    if (typeof name !== 'string') throw new ShellError('internal: bad command');
    if (!skipFunctions && this.functions.has(name)) return this.callFunction(name, argv, io);
    const c = this.commands.get(name);
    if (c && c.builtin) {
      const ctx = this.makeCtx(argv, io);
      const st = await c.fn(ctx);
      return st === undefined ? 0 : st;
    }
    if (onlyBuiltin) {
      await this.report(`${name}: not a shell builtin`, io);
      return 1;
    }
    return this.execExternal(argv, io, tempScope);
  }

  async execExternal(argv, io, tempScope) {
    const name = argv[0];
    let path;
    if (name.includes('/')) path = name;
    else {
      path = this.hash.get(name);
      if (path && !this.vfs.exists(path, '/')) path = null;
      if (!path) {
        path = this.findInPath(name);
        if (path && this.opts.hashall) this.hash.set(name, path.startsWith('/') ? path : this.cwd + '/' + path);
      }
    }
    if (!path) {
      if (this.functions.has('command_not_found_handle')) {
        return this.callFunction('command_not_found_handle', ['command_not_found_handle', ...argv.slice(0)], io);
      }
      const hint = this.system.notFoundHint(name);
      if (hint && (this.interactive || this.interactiveParent)) await io[2].write(hint);
      await this.report(`${name}: command not found`, io);
      return 127;
    }
    let node;
    try {
      node = this.vfs.stat(path, this.cwd);
    } catch (e) {
      await this.report(`${name}: ${e instanceof FsError ? e.message : 'error'}`, io);
      return 127;
    }
    if (node.type === 'dir') {
      if (this.shopt.autocd && !name.includes('/') === false) return this.runCommand(['cd', name], io);
      await this.report(`${name}: Is a directory`, io);
      return 126;
    }
    if (!this.vfs.can(node, 1) || node.type !== 'file') {
      await this.report(`${name}: Permission denied`, io);
      return 126;
    }
    const data = node.gen ? node.gen() : node.data;
    const proc = this.system.spawn(argv, this);
    try {
      if (data.startsWith('\x7fELF')) {
        const m = /BASHSIM:([^\0]+)\0/.exec(data);
        const cmd = m && this.commands.get(m[1]);
        if (!cmd) {
          await this.report(`${name}: cannot execute binary file: Exec format error`, io);
          return 126;
        }
        const ctx = this.makeCtx(argv, io, { proc, exe: m[1] });
        const savedCred = { ...this.vfs.cred };
        try {
          const st = await cmd.fn(ctx);
          return st === undefined ? 0 : st;
        } finally {
          this.vfs.cred = savedCred;
        }
      }
      if (!this.vfs.can(node, 4)) {
        await this.report(`${name}: Permission denied`, io);
        return 126;
      }
      return await this.runScriptText(data, path, argv, io);
    } finally {
      this.system.exit(proc);
    }
  }

  async runScriptText(data, path, argv, io) {
    // shebang
    if (data.startsWith('#!')) {
      const line = data.slice(2).split('\n')[0].trim();
      const parts = line.split(/\s+/);
      let interp = parts[0];
      let iargs = parts.slice(1);
      if (/(^|\/)env$/.test(interp) && iargs.length) {
        if (iargs[0] === '-S') iargs.shift();
        interp = iargs.shift();
      }
      const base = interp.split('/').pop();
      if (!['bash', 'sh', 'dash', 'zsh', 'ksh'].includes(base)) {
        const target = interp.includes('/') ? interp : this.findInPath(interp);
        if (!target || !this.vfs.exists(target, this.cwd)) {
          await this.report(`${argv[0]}: ${interp}: bad interpreter: No such file or directory`, io);
          return 126;
        }
        return this.execExternal([target, ...iargs, path, ...argv.slice(1)], io);
      }
    }
    const sh = this.subshell({ fresh: true });
    sh.argv0 = argv[0];
    sh.positional = argv.slice(1);
    sh.scriptName = argv[0];
    sh.sourceStack = [argv[0]];
    sh.setVar('SHLVL', String((parseInt(this.getVar('SHLVL') || '1', 10) || 1) + 1));
    sh.lookupVar('SHLVL').x = true;
    let status;
    try {
      status = await sh.runSource(data, io);
      await sh.finishPsubs();
    } catch (e) {
      await sh.finishPsubs();
      if (e instanceof ExitEx) status = e.code;
      else if (e instanceof ShellError) {
        await sh.report(e.message, io);
        status = e.status;
      } else if (e instanceof ReturnEx) status = e.code;
      else if (e instanceof BreakEx || e instanceof ContinueEx) status = sh.status;
      else throw e;
    }
    if (sh.traps.EXIT) {
      sh.status = status;
      await sh.runTrap('EXIT', io);
    }
    return status;
  }

  async callFunction(name, argv, io) {
    const f = this.functions.get(name);
    if (this.funcStack.length > 1000) throw new ShellError(`${name}: maximum function nesting level exceeded (1000)`, 1);
    const savedPos = this.positional;
    this.positional = argv.slice(1);
    this.scopes.push(new Map());
    this.funcStack.push(name);
    this.sourceStack.push(this.sourceStack[this.sourceStack.length - 1] || (this.interactive ? 'main' : this.scriptName || 'main'));
    const savedLoop = this.loopDepth;
    this.loopDepth = 0;
    try {
      return await this.execNode(f.body, io);
    } catch (e) {
      if (e instanceof ReturnEx) return e.code;
      throw e;
    } finally {
      this.loopDepth = savedLoop;
      this.positional = savedPos;
      this.scopes.pop();
      this.funcStack.pop();
      this.sourceStack.pop();
      if (this.traps.RETURN && !this.inTrap) await this.runTrap('RETURN', io);
    }
  }

  async runTrap(sig, io) {
    const action = this.traps[sig];
    if (!action) return;
    const saved = this.status;
    this.inTrap = true;
    try {
      await this.runSource(action, io || this.io);
    } catch (e) {
      if (e instanceof ExitEx) {
        this.inTrap = false;
        throw e;
      }
      if (!(e instanceof ShellError)) throw e;
    } finally {
      this.inTrap = false;
    }
    this.status = saved;
  }

  // ---------- redirections ----------

  async openRead(path, io) {
    switch (path) {
      case '/dev/stdin':
      case '/proc/self/fd/0':
      case '/dev/fd/0':
        return io[0];
      case '/dev/tty':
        return this.term ? this.term.reader() : new EmptyReader();
    }
    const m = /^\/dev\/fd\/(\d+)$/.exec(path);
    if (m && io[m[1]] instanceof Reader) return io[m[1]];
    const { node } = this.vfs.lookup(path, this.cwd);
    if (node.type === 'dir') throw new FsError('EISDIR', path);
    this.vfs.check(node, 4, path);
    if (node.type === 'chr' && this.vfs.devices[node.dev]?.stream) {
      return new FnReader(() => this.vfs.devices[node.dev].read());
    }
    return new StringReader(this.vfs.readNode(node, path));
  }

  openWrite(path, io, append, clobber) {
    switch (path) {
      case '/dev/stdout':
      case '/dev/fd/1':
      case '/proc/self/fd/1':
        return io[1];
      case '/dev/stderr':
      case '/dev/fd/2':
      case '/proc/self/fd/2':
        return io[2];
      case '/dev/null':
        return new NullWriter();
      case '/dev/tty':
        return this.term ? this.term.writer() : new NullWriter();
    }
    const m = /^\/dev\/fd\/(\d+)$/.exec(path);
    if (m && io[m[1]] instanceof Writer) return io[m[1]];
    if (m && this.system.psubPipes && this.system.psubPipes.has(m[1])) {
      const pipe = this.system.psubPipes.get(m[1]);
      return new (class extends Writer {
        async write(s) {
          return pipe.writer.write(s);
        }
      })();
    }
    const noclobber = this.opts.noclobber && !clobber && !append;
    const node = this.vfs.writeFile(path, this.cwd, '', { append: true, umask: this.umask, noclobber });
    if (!append && node.type === 'file') node.data = '';
    return new FileWriter(this.vfs, node, path);
  }

  async redirTarget(raw) {
    if (/^[<>]\(/.test(raw)) return (await this.expandWords([raw]))[0];
    const fields = await this.expandWords([raw]);
    if (fields.length !== 1) throw new ShellError(`${raw}: ambiguous redirect`, 1, false);
    return fields[0];
  }

  // returns {io, cleanup} or null on failure (error already reported)
  async applyRedirs(redirs, io) {
    const fds = { ...io };
    const cleanups = [];
    const cleanup = async () => {
      for (const c of cleanups.reverse()) await c();
    };
    try {
      for (const r of redirs) {
        let fd = r.fd;
        let fdVar = null;
        if (fd && fd.startsWith('{')) {
          fdVar = fd.slice(1, -1);
          let n = 10;
          while (fds[n]) n++;
          fd = n;
          this.setVar(fdVar, String(n));
        } else if (fd !== null) fd = parseInt(fd, 10);
        switch (r.op) {
          case '<': {
            const t = await this.redirTarget(r.target);
            fds[fd ?? 0] = await this.openRead(t, fds);
            break;
          }
          case '>':
          case '>|':
          case '>>': {
            const t = await this.redirTarget(r.target);
            fds[fd ?? 1] = this.openWrite(t, fds, r.op === '>>', r.op === '>|');
            break;
          }
          case '&>':
          case '&>>': {
            const t = await this.redirTarget(r.target);
            const w = this.openWrite(t, fds, r.op === '&>>', false);
            fds[1] = w;
            fds[2] = w;
            break;
          }
          case '<>': {
            const t = await this.redirTarget(r.target);
            if (!this.vfs.exists(t, this.cwd)) this.vfs.writeFile(t, this.cwd, '', { umask: this.umask });
            fds[fd ?? 0] = await this.openRead(t, fds);
            break;
          }
          case '>&':
          case '<&': {
            const t = await this.expandString(r.target);
            const def = r.op === '>&' ? 1 : 0;
            if (t === '-') {
              fds[fd ?? def] = r.op === '>&' ? new ClosedFd() : new EmptyReader();
              break;
            }
            const m = /^(\d+)(-?)$/.exec(t);
            if (m) {
              const src = parseInt(m[1], 10);
              if (!fds[src]) throw new ShellError(`${src}: Bad file descriptor`, 1, false);
              fds[fd ?? def] = fds[src];
              if (m[2]) delete fds[src];
              break;
            }
            if (r.op === '>&' && fd === null) {
              const w = this.openWrite(t, fds, false, false);
              fds[1] = w;
              fds[2] = w;
              break;
            }
            throw new ShellError(`${t}: ambiguous redirect`, 1, false);
          }
          case '<<':
          case '<<-': {
            const body = r.heredoc.body ?? '';
            const text = r.heredoc.quoted ? body : await this.expandHeredoc(body);
            fds[fd ?? 0] = new StringReader(text);
            break;
          }
          case '<<<': {
            const t = await this.expandString(r.target);
            fds[fd ?? 0] = new StringReader(t + '\n');
            break;
          }
        }
      }
    } catch (e) {
      await cleanup();
      if (e instanceof FsError) {
        await this.report(`${e.path ?? ''}: ${e.code === 'EEXIST' ? 'cannot overwrite existing file' : e.message}`, io);
        return null;
      }
      if (e instanceof ShellError) {
        await this.report(e.message, io);
        return null;
      }
      throw e;
    }
    return { io: fds, cleanup };
  }

  // process substitution: <(cmd) and >(cmd)
  // process substitution: <(cmd) and >(cmd) appear as /dev/fd/63, /dev/fd/62, ...
  async processSubst(kind, cmd) {
    const fdDir = this.vfs.lookup('/proc/self/fd', '/').node;
    let fd = 63;
    while (fdDir.children.has(String(fd)) && fd > 10) fd--;
    const node = new FsNode('file', 0o600, this.vfs.cred.uid, this.vfs.cred.gid);
    fdDir.children.set(String(fd), node);
    const path = `/dev/fd/${fd}`;
    if (kind === '<') {
      const w = new CollectWriter();
      const sh = this.subshell();
      try {
        await sh.runSource(cmd, { ...this.io, 1: w });
      } catch (e) {
        if (!(e instanceof ExitEx)) throw e;
      }
      node.data = w.text;
    } else {
      // >(cmd): the command runs concurrently, reading what is written to /dev/fd/N
      const pipe = new Pipe();
      const sh = this.subshell();
      const promise = (async () => {
        try {
          await sh.runSource(cmd, { ...this.io, 0: pipe.reader });
        } catch (e) {
          if (!(e instanceof ExitEx)) throw e;
        } finally {
          pipe.reader.close();
        }
      })();
      this.system.psubPipes = this.system.psubPipes || new Map();
      this.system.psubPipes.set(String(fd), pipe);
      this.pendingPsubOut = this.pendingPsubOut || [];
      this.pendingPsubOut.push({ node, pipe, promise, fd: String(fd) });
    }
    this.psubFiles = this.psubFiles || [];
    this.psubFiles.push(String(fd));
    return path;
  }

  async closePsubOut(p) {
    try {
      if (p.node.data) await p.pipe.writer.write(p.node.data);
    } catch {}
    p.pipe.writer.close();
    await p.promise;
    if (this.system.psubPipes) this.system.psubPipes.delete(p.fd);
    try {
      this.vfs.lookup('/proc/self/fd', '/').node.children.delete(p.fd);
    } catch {}
  }

  async flushPsubs(persist = false) {
    const outs = this.pendingPsubOut || [];
    this.pendingPsubOut = [];
    const fdDir = this.vfs.lookup('/proc/self/fd', '/').node;
    const keep = new Set();
    for (const p of outs) {
      if (persist) {
        this.persistentPsubs = this.persistentPsubs || [];
        this.persistentPsubs.push(p);
        keep.add(p.fd);
        continue;
      }
      await this.closePsubOut(p);
    }
    for (const f of this.psubFiles || []) if (!keep.has(f)) fdDir.children.delete(f);
    this.psubFiles = [];
  }

  // called when a shell process ends: close >(cmd) kept open by exec
  async finishPsubs() {
    const ps = this.persistentPsubs || [];
    this.persistentPsubs = [];
    for (const p of ps) await this.closePsubOut(p);
  }

  async commandSubst(cmd) {
    const t = cmd.trim();
    const m = /^<\s*(\S+)$/.exec(t);
    if (m) {
      const path = await this.expandString(m[1]);
      try {
        const s = this.vfs.readFile(path, this.cwd);
        this.lastSubStatus = 0;
        return s.replace(/\n+$/, '');
      } catch (e) {
        await this.report(`${path}: ${e.message}`);
        this.lastSubStatus = 1;
        return '';
      }
    }
    const w = new CollectWriter();
    const sh = this.subshell();
    const io = { ...(this.io || {}), 1: w };
    if (!io[0]) io[0] = new EmptyReader();
    if (!io[2]) io[2] = new NullWriter();
    let status;
    try {
      status = await sh.runSource(cmd, io);
    } catch (e) {
      if (e instanceof ExitEx) status = e.code;
      else if (e instanceof ShellError) {
        await sh.report(e.message, io);
        status = e.status;
      } else if (e instanceof ReturnEx || e instanceof BreakEx || e instanceof ContinueEx) status = sh.status;
      else throw e;
    }
    if (sh.traps.EXIT) await sh.runTrap('EXIT', io);
    this.lastSubStatus = status;
    this.status = status;
    return w.text.replace(/\n+$/, '');
  }

  // ---------- jobs ----------

  async startJob(node, io) {
    const sh = this.subshell();
    sh.ctl = { interrupted: false, waiters: new Set() };
    const id = this.jobs.length ? Math.max(...this.jobs.map((j) => j.id)) + 1 : 1;
    const text = (node.text || '').trim();
    const job = { id, pid: sh.pid, text, state: 'Running', status: null, shell: sh, notified: false };
    const jio = { ...io };
    if (this.interactive && jio[0] === this.termReaderMarker) jio[0] = new EmptyReader();
    if (this.interactive) jio[0] = io[0] && io[0].isTerminal ? new EmptyReader() : io[0];
    const proc = this.system.spawn(['bash'], sh, text);
    job.proc = proc;
    job.promise = (async () => {
      try {
        return await sh.execNode(node, jio);
      } catch (e) {
        if (e instanceof ExitEx) return e.code;
        if (e instanceof InterruptEx) return 128 + SIGNALS.indexOf(e.sig);
        if (e instanceof ShellError) {
          await sh.report(e.message, jio);
          return e.status;
        }
        if (e?.code === 'EPIPE') return 141;
        if (e instanceof ReturnEx || e instanceof BreakEx || e instanceof ContinueEx) return sh.status;
        try {
          await jio[2].write(`bash: internal error: ${e?.message || e}\n`);
        } catch {}
        return 1;
      }
    })().then((st) => {
      job.status = st;
      job.state = st >= 128 && st !== 141 ? 'Killed' : 'Done';
      if (st >= 128 && SIGNALS[st - 128]) job.signal = SIGNALS[st - 128];
      this.system.exit(proc);
      if (this.onJobDone) this.onJobDone(job);
      return st;
    });
    this.jobs.push(job);
    this.lastBgPid = sh.pid;
    if (this.interactive) await io[2].write(`[${id}] ${sh.pid}\n`);
    return 0;
  }

  findJob(spec) {
    if (!this.jobs.length) return null;
    if (spec === undefined || spec === '%%' || spec === '%+' || spec === '%') return this.jobs[this.jobs.length - 1];
    if (spec === '%-') return this.jobs[this.jobs.length - 2] || null;
    let m;
    if ((m = /^%(\d+)$/.exec(spec))) return this.jobs.find((j) => j.id === Number(m[1])) || null;
    if ((m = /^%\?(.*)$/.exec(spec))) return this.jobs.find((j) => j.text.includes(m[1])) || null;
    if ((m = /^%(.*)$/.exec(spec))) return this.jobs.find((j) => j.text.startsWith(m[1])) || null;
    if (/^\d+$/.test(spec)) return this.jobs.find((j) => j.pid === Number(spec)) || null;
    return null;
  }

  jobLine(j, mark = ' ', pid = false) {
    let state = j.state;
    if (j.state === 'Done' && j.status) state = `Exit ${j.status}`;
    if (j.state === 'Killed') state = { INT: 'Interrupt', TERM: 'Terminated', KILL: 'Killed', HUP: 'Hangup' }[j.signal] || 'Killed';
    if (j.state === 'Stopped') state = 'Stopped';
    return `[${j.id}]${mark} ${pid ? j.pid + ' ' : ''}${state.padEnd(pid ? 22 : 24)}${j.text}${j.state === 'Running' ? ' &' : ''}`;
  }

  // called before each prompt: report finished jobs
  takeJobNotifications() {
    const lines = [];
    const n = this.jobs.length;
    for (let i = 0; i < this.jobs.length; i++) {
      const j = this.jobs[i];
      if (j.state !== 'Running' && j.state !== 'Stopped') {
        const mark = i === n - 1 ? '+' : i === n - 2 ? '-' : ' ';
        lines.push(this.jobLine(j, mark));
        j.notified = true;
      }
    }
    this.jobs = this.jobs.filter((j) => !j.notified);
    return lines;
  }

  // ---------- prompt ----------

  async expandPrompt(ps) {
    const now = new Date();
    const pad = (x) => String(x).padStart(2, '0');
    let out = '';
    for (let i = 0; i < ps.length; i++) {
      const c = ps[i];
      if (c !== '\\') {
        out += c;
        continue;
      }
      const d = ps[++i];
      switch (d) {
        case 'u': out += this.user.name; break;
        case 'h': out += this.system.hostname.split('.')[0]; break;
        case 'H': out += this.system.hostname; break;
        case 'w': {
          const p = this.getVar('PWD') || this.cwd;
          out += this.tildeShort(p);
          break;
        }
        case 'W': {
          const p = this.getVar('PWD') || this.cwd;
          out += p === this.getVar('HOME') ? '~' : p === '/' ? '/' : p.split('/').pop();
          break;
        }
        case '$': out += this.vfs.cred.uid === 0 || this.user.uid === 0 ? '#' : '$'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 'a': out += '\x07'; break;
        case 'e': out += '\x1b'; break;
        case 's': out += 'bash'; break;
        case 'v': out += '5.2'; break;
        case 'V': out += '5.2.21'; break;
        case 't': out += `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`; break;
        case 'T': out += `${pad(now.getHours() % 12 || 12)}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`; break;
        case '@': out += `${pad(now.getHours() % 12 || 12)}:${pad(now.getMinutes())} ${now.getHours() < 12 ? 'AM' : 'PM'}`; break;
        case 'A': out += `${pad(now.getHours())}:${pad(now.getMinutes())}`; break;
        case 'd': out += now.toDateString().slice(0, 10); break;
        case 'D': {
          const k = ps.indexOf('}', i);
          if (ps[i + 1] === '{' && k > 0) {
            const fmt = ps.slice(i + 2, k) || '%X';
            out += this.commands.get('date').format(now, fmt);
            i = k;
          }
          break;
        }
        case 'j': out += String(this.jobs.length); break;
        case 'l': out += 'pts/0'; break;
        case '!': out += String(this.histBase + this.history.length); break;
        case '#': out += String((this.cmdCount || 0) + 1); break;
        case '[': out += '\x01'; break;
        case ']': out += '\x02'; break;
        case '\\': out += '\\'; break;
        default:
          if (d >= '0' && d <= '7') {
            const m = /^[0-7]{1,3}/.exec(ps.slice(i));
            out += String.fromCharCode(parseInt(m[0], 8));
            i += m[0].length - 1;
          } else out += '\\' + (d ?? '');
      }
    }
    if (this.shopt.promptvars) {
      try {
        const sh = this;
        out = await sh.expandHeredoc(out.replace(/\\/g, '\\\\'));
      } catch {}
    }
    return out;
  }

  // ---------- history expansion ----------

  historyExpand(line) {
    if (!this.opts.histexpand || !line.includes('!') && !line.startsWith('^')) return { line, changed: false };
    const hist = this.history;
    const get = (n) => hist[n];
    let changed = false;
    if (line.startsWith('^')) {
      const m = /^\^([^^]*)\^([^^]*)\^?(.*)$/.exec(line);
      if (m) {
        const prev = hist[hist.length - 1];
        if (!prev || !prev.includes(m[1])) throw new ShellError(`:s${m[1]}${m[2]}: substitution failed`, 1, false);
        return { line: prev.replace(m[1], m[2]) + m[3], changed: true };
      }
    }
    let out = '';
    let inSingle = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "'" ) inSingle = !inSingle;
      if (c === '\\' && line[i + 1] === '!') {
        out += '!';
        i++;
        continue;
      }
      if (c !== '!' || inSingle) {
        out += c;
        continue;
      }
      const rest = line.slice(i + 1);
      if (rest === '' || /^[\s=(]/.test(rest) || (rest[0] === '"' )) {
        out += c;
        continue;
      }
      let ev = null;
      let len = 0;
      let m;
      if (rest[0] === '!') {
        ev = get(hist.length - 1);
        len = 1;
      } else if ((m = /^-?\d+/.exec(rest))) {
        const n = parseInt(m[0], 10);
        ev = n < 0 ? get(hist.length + n) : get(n - this.histBase);
        len = m[0].length;
      } else if (rest[0] === '$' || rest[0] === '^' || rest[0] === '*' || rest[0] === ':') {
        ev = get(hist.length - 1);
        len = 0;
      } else if ((m = /^\?([^?\n]*)\??/.exec(rest))) {
        for (let k = hist.length - 1; k >= 0; k--) if (hist[k].includes(m[1])) {
          ev = hist[k];
          break;
        }
        len = m[0].length;
      } else if ((m = /^[^\s:;&|<>()]+/.exec(rest))) {
        for (let k = hist.length - 1; k >= 0; k--) if (hist[k].startsWith(m[0])) {
          ev = hist[k];
          break;
        }
        len = m[0].length;
      }
      if (ev === null || ev === undefined) throw new ShellError(`!${rest.slice(0, Math.max(len, 1))}: event not found`, 1, false);
      let r = rest.slice(len);
      // word designators
      const words = ev.match(/(?:[^\s'"]+|'[^']*'|"(?:\\.|[^"])*")+/g) || [];
      let sel = ev;
      if (r[0] === ':' || r[0] === '$' || r[0] === '^' || r[0] === '*') {
        if (r[0] === ':') r = r.slice(1);
        if ((m = /^(\$|\^|\*|\d+-\d+|\d+\*|\d+-|\d+)/.exec(r))) {
          const d = m[0];
          if (d === '$') sel = words[words.length - 1] ?? '';
          else if (d === '^') sel = words[1] ?? '';
          else if (d === '*') sel = words.slice(1).join(' ');
          else if (/^\d+-\d+$/.test(d)) {
            const [a, b] = d.split('-').map(Number);
            sel = words.slice(a, b + 1).join(' ');
          } else if (/^\d+\*$/.test(d)) sel = words.slice(parseInt(d, 10)).join(' ');
          else if (/^\d+-$/.test(d)) sel = words.slice(parseInt(d, 10), -1).join(' ');
          else sel = words[parseInt(d, 10)] ?? '';
          r = r.slice(d.length);
        }
        // modifiers :h :t :r :e :p :s/a/b/ :gs
        while ((m = /^:(h|t|r|e|p|q|u|l|s\/([^/]*)\/([^/]*)\/?|gs\/([^/]*)\/([^/]*)\/?)/.exec(r))) {
          const mod = m[1];
          if (mod === 'h') sel = sel.replace(/\/[^/]*$/, '');
          else if (mod === 't') sel = sel.replace(/^.*\//, '');
          else if (mod === 'r') sel = sel.replace(/\.[^./]*$/, '');
          else if (mod === 'e') sel = (/\.[^./]*$/.exec(sel) || [''])[0];
          else if (mod === 'q') sel = this.quoteValue(sel);
          else if (mod === 'u') sel = sel.toUpperCase();
          else if (mod === 'l') sel = sel.toLowerCase();
          else if (mod.startsWith('s')) sel = sel.replace(m[2], m[3]);
          else if (mod.startsWith('gs')) sel = sel.split(m[4]).join(m[5]);
          r = r.slice(m[0].length);
        }
      }
      out += sel;
      i += len + (rest.length - len - r.length);
      changed = true;
    }
    return { line: out, changed };
  }
}

export const RESERVED_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'select', '{', '}', '!', '[[', ']]', 'time', 'coproc']);

// POSIX ERE -> JS regex (bracket classes)
export function posixToJsRegex(src) {
  return src.replace(/\[\[:(\w+):\]\]/g, (m, n) => `[${POSIX_CLASS[n] || ''}]`).replace(/\[:(\w+):\]/g, (m, n) => POSIX_CLASS[n] || m);
}
export const POSIX_CLASS = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e', word: 'A-Za-z0-9_',
};

Object.assign(Shell.prototype, ExpandMixin);
