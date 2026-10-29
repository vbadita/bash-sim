// Terminal glue between xterm.js (or a headless test double) and the shell:
// readline-style line editing, completion, history search, cooked input for
// programs, raw key mode for full-screen programs, and the interactive REPL.

import { Reader, Writer, EmptyReader } from './streams.js';
import { strWidth } from './util.js';
import { ParseError } from './parser.js';
import { ExitEx, InterruptEx, RESERVED_WORDS } from './shell.js';
import { ShellError } from './expand.js';

const visible = (s) => s.replace(/\x01[^\x02]*\x02/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x01\x02]/g, '');

class TermWriter extends Writer {
  constructor(term) {
    super();
    this.term = term;
    this.isTerminalWriter = true;
  }
  async write(s) {
    const p = this.term.write(s);
    if (p) await p;
  }
}

class TermReader extends Reader {
  constructor(term) {
    super();
    this.term = term;
    this.isTerminal = true;
  }
  async _pull() {
    const r = await this.term.readInput({ echo: !this.term.noEcho });
    if (r === null) return null;
    return r.text + (r.delim ? '\n' : '');
  }
}

export class Terminal {
  // host: { write(s), cols, rows, onResize? } ; input is fed with feed(data)
  constructor(host) {
    this.host = host;
    this.queue = '';
    this.waiter = null;
    this.mode = 'idle'; // idle | line | input | raw
    this.shell = null;
    this.killRing = '';
    this.noEcho = false;
  }

  get cols() {
    return this.host.cols || 80;
  }
  get rows() {
    return this.host.rows || 24;
  }

  // returns a promise when the host asks the writer to slow down
  write(s) {
    return this.host.write(s.replace(/\r?\n/g, '\r\n'));
  }

  writer() {
    return new TermWriter(this);
  }
  reader() {
    return new TermReader(this);
  }

  // ---- input plumbing ----
  feed(data) {
    // Ctrl-C while a command runs (not reading input): interrupt
    if (this.mode === 'idle' || (this.mode === 'raw' && this.rawInterruptible)) {
      if (data.includes('\x03')) {
        this.write('^C');
        if (this.shell) this.shell.interrupt('INT');
        this.queue = '';
        return;
      }
      if (data.includes('\x1c')) {
        this.write('^\\');
        if (this.shell) this.shell.interrupt('QUIT');
        return;
      }
      if (data === '\x1a') {
        // Ctrl-Z: job control is limited; interrupt like bash would stop the job
        this.write('^Z');
        return;
      }
    }
    this.queue += data;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async nextKey() {
    while (!this.queue) await new Promise((r) => (this.waiter = r));
    // split one key off the queue
    const q = this.queue;
    let len = 1;
    if (q[0] === '\x1b') {
      let m;
      if ((m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(q))) len = m[0].length;
      else if ((m = /^\x1bO./.exec(q))) len = m[0].length;
      else if (q.length > 1) len = 2;
    } else {
      const cp = q.codePointAt(0);
      len = cp > 0xffff ? 2 : 1;
    }
    const k = q.slice(0, len);
    this.queue = q.slice(len);
    return k;
  }

  cancelInput() {
    this.cancelled = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  // ---- cooked input for programs (cat, read, ...) ----
  // returns {text, delim} or null on EOF (^D on empty line)
  async readInput({ echo = true, n = null, delim = '\n', initial = null } = {}) {
    const prev = this.mode;
    this.mode = 'input';
    let buf = initial || '';
    if (echo && buf) this.write(buf);
    this.cancelled = false;
    try {
      for (;;) {
        if (this.shell && this.shell.ctl.interrupted) throw new InterruptEx('INT');
        const k = await this.nextKey();
        if (this.cancelled) return null;
        if (k === '\x03') {
          this.write('^C\r\n');
          if (this.shell) this.shell.interrupt('INT');
          throw new InterruptEx('INT');
        }
        if (k === '\x04') {
          if (buf === '') return null;
          return { text: buf, delim: false };
        }
        if (k === '\r' || k === '\n') {
          if (delim === '\n' || n === null) {
            this.write('\r\n');
            if (delim !== '\n') {
              buf += '\n';
              continue;
            }
            return { text: buf, delim: true };
          }
          if (echo) this.write('\r\n');
          buf += '\n';
          if (n !== null && [...buf].length >= n) return { text: buf, delim: false };
          continue;
        }
        if (k === '\x7f' || k === '\b') {
          if (buf) {
            const chars = [...buf];
            const last = chars.pop();
            buf = chars.join('');
            if (echo) this.write('\b \b'.repeat(strWidth(last) || 1));
          }
          continue;
        }
        if (k === '\x15') {
          if (echo) this.write('\b \b'.repeat(strWidth(buf)));
          buf = '';
          continue;
        }
        if (k === '\x17') {
          const m = /\S*\s*$/.exec(buf);
          if (echo) this.write('\b \b'.repeat(strWidth(m[0])));
          buf = buf.slice(0, buf.length - m[0].length);
          continue;
        }
        if (k.startsWith('\x1b')) continue;
        if (k === delim && delim !== '\n') {
          if (echo) this.write(k);
          return { text: buf, delim: true };
        }
        buf += k;
        if (echo) this.write(k);
        if (n !== null && [...buf].length >= n) {
          return { text: buf, delim: false };
        }
      }
    } finally {
      this.mode = prev === 'input' ? 'idle' : prev;
    }
  }

  // ---- raw mode for full-screen programs ----
  async raw(fn, { interruptible = false } = {}) {
    const prev = this.mode;
    this.mode = 'raw';
    this.rawInterruptible = interruptible;
    try {
      return await fn({
        key: () => this.nextKey(),
        hasKey: () => this.queue.length > 0,
        write: (s) => this.host.write(s),
        cols: () => this.cols,
        rows: () => this.rows,
      });
    } finally {
      this.mode = prev === 'raw' ? 'idle' : prev;
      this.rawInterruptible = false;
    }
  }

  // ---- the line editor ----
  async readLine(prompt, shell, { history = true } = {}) {
    this.mode = 'line';
    const lines = prompt.split('\n');
    const lastPrompt = lines.pop();
    if (lines.length) this.write(lines.join('\n') + '\n');
    const ed = {
      prompt: lastPrompt.replace(/[\x01\x02]/g, ''),
      pw: strWidth(visible(lastPrompt)),
      buf: '',
      pos: 0,
      row: 0,
    };
    const hist = history ? shell.history : [];
    let hi = hist.length;
    const edits = new Map();
    let lastTab = false;
    const render = () => {
      const cols = this.cols;
      let s = '\r';
      if (ed.row > 0) s += `\x1b[${ed.row}A`;
      s += '\x1b[J' + ed.prompt + ed.buf;
      const total = ed.pw + strWidth(ed.buf);
      if (total > 0 && total % cols === 0) s += '\r\n';
      const endRow = Math.floor(total / cols);
      const cur = ed.pw + strWidth(ed.buf.slice(0, ed.pos));
      const row = Math.floor(cur / cols);
      const col = cur % cols;
      if (endRow - row > 0) s += `\x1b[${endRow - row}A`;
      s += '\r';
      if (col > 0) s += `\x1b[${col}C`;
      ed.row = row;
      this.host.write(s);
    };
    const setBuf = (b, p = b.length) => {
      ed.buf = b;
      ed.pos = p;
      render();
    };
    const finish = () => {
      ed.pos = ed.buf.length;
      render();
      this.host.write('\r\n');
      ed.row = 0;
    };
    this.host.write(ed.prompt);
    if (this.pendingInitial) {
      setBuf(this.pendingInitial);
      this.pendingInitial = null;
    }
    try {
      for (;;) {
        const k = await this.nextKey();
        const wasTab = lastTab;
        lastTab = false;
        switch (k) {
          case '\r':
          case '\n':
            finish();
            return ed.buf;
          case '\x03':
            ed.pos = ed.buf.length;
            render();
            this.host.write('^C\r\n');
            ed.row = 0;
            return { interrupted: true };
          case '\x04':
            if (ed.buf === '') {
              this.host.write('\r\n');
              return null;
            }
            if (ed.pos < ed.buf.length) setBuf(ed.buf.slice(0, ed.pos) + ed.buf.slice(ed.pos + 1), ed.pos);
            continue;
          case '\x7f':
          case '\b':
            if (ed.pos > 0) {
              const before = [...ed.buf.slice(0, ed.pos)];
              before.pop();
              const b = before.join('');
              setBuf(b + ed.buf.slice(ed.pos), b.length);
            }
            continue;
          case '\x1b[3~':
            if (ed.pos < ed.buf.length) {
              const after = [...ed.buf.slice(ed.pos)];
              after.shift();
              setBuf(ed.buf.slice(0, ed.pos) + after.join(''), ed.pos);
            }
            continue;
          case '\x1b[D':
          case '\x02':
            if (ed.pos > 0) {
              const before = [...ed.buf.slice(0, ed.pos)];
              before.pop();
              ed.pos = before.join('').length;
              render();
            }
            continue;
          case '\x1b[C':
          case '\x06':
            if (ed.pos < ed.buf.length) {
              const c = [...ed.buf.slice(ed.pos)][0];
              ed.pos += c.length;
              render();
            }
            continue;
          case '\x1b[H':
          case '\x1bOH':
          case '\x1b[1~':
          case '\x01':
            ed.pos = 0;
            render();
            continue;
          case '\x1b[F':
          case '\x1bOF':
          case '\x1b[4~':
          case '\x05':
            ed.pos = ed.buf.length;
            render();
            continue;
          case '\x1b[A':
          case '\x10':
            if (hi > 0) {
              edits.set(hi, ed.buf);
              hi--;
              setBuf(edits.get(hi) ?? hist[hi]);
            }
            continue;
          case '\x1b[B':
          case '\x0e':
            if (hi < hist.length) {
              edits.set(hi, ed.buf);
              hi++;
              setBuf(edits.get(hi) ?? (hi === hist.length ? '' : hist[hi]));
            }
            continue;
          case '\x0b':
            this.killRing = ed.buf.slice(ed.pos);
            setBuf(ed.buf.slice(0, ed.pos), ed.pos);
            continue;
          case '\x15':
            this.killRing = ed.buf.slice(0, ed.pos);
            setBuf(ed.buf.slice(ed.pos), 0);
            continue;
          case '\x17': {
            const m = /\S*\s*$/.exec(ed.buf.slice(0, ed.pos));
            this.killRing = m[0];
            const b = ed.buf.slice(0, ed.pos - m[0].length);
            setBuf(b + ed.buf.slice(ed.pos), b.length);
            continue;
          }
          case '\x19': {
            const b = ed.buf.slice(0, ed.pos) + this.killRing;
            setBuf(b + ed.buf.slice(ed.pos), b.length);
            continue;
          }
          case '\x14': {
            if (ed.pos > 0 && ed.buf.length > 1) {
              let p = ed.pos === ed.buf.length ? ed.pos - 1 : ed.pos;
              const b = ed.buf.slice(0, p - 1) + ed.buf[p] + ed.buf[p - 1] + ed.buf.slice(p + 1);
              setBuf(b, p + 1);
            }
            continue;
          }
          case '\x0c':
            this.host.write('\x1b[H\x1b[2J');
            ed.row = 0;
            this.host.write(ed.prompt);
            render();
            continue;
          case '\x1bb':
          case '\x1b[1;5D':
          case '\x1b[1;3D': {
            const m = /\w*\W*$/.exec(ed.buf.slice(0, ed.pos));
            ed.pos -= m[0].length;
            render();
            continue;
          }
          case '\x1bf':
          case '\x1b[1;5C':
          case '\x1b[1;3C': {
            const m = /^\W*\w*/.exec(ed.buf.slice(ed.pos));
            ed.pos += m[0].length;
            render();
            continue;
          }
          case '\x1bd': {
            const m = /^\W*\w*/.exec(ed.buf.slice(ed.pos));
            this.killRing = m[0];
            setBuf(ed.buf.slice(0, ed.pos) + ed.buf.slice(ed.pos + m[0].length), ed.pos);
            continue;
          }
          case '\x1b\x7f': {
            const m = /\w*\W*$/.exec(ed.buf.slice(0, ed.pos));
            const b = ed.buf.slice(0, ed.pos - m[0].length);
            setBuf(b + ed.buf.slice(ed.pos), b.length);
            continue;
          }
          case '\x1bu':
          case '\x1bl':
          case '\x1bc': {
            const m = /^(\W*)(\w*)/.exec(ed.buf.slice(ed.pos));
            let w = m[2];
            w = k === '\x1bu' ? w.toUpperCase() : k === '\x1bl' ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            const b = ed.buf.slice(0, ed.pos) + m[1] + w;
            setBuf(b + ed.buf.slice(ed.pos + m[0].length), b.length);
            continue;
          }
          case '\x1b.':
          case '\x1b_': {
            const prev = hist[hist.length - 1] || '';
            const words = prev.trim().split(/\s+/);
            const w = words[words.length - 1] || '';
            const b = ed.buf.slice(0, ed.pos) + w;
            setBuf(b + ed.buf.slice(ed.pos), b.length);
            continue;
          }
          case '\x12': {
            const r = await this.reverseSearch(ed, hist, render);
            if (r === 'accept') {
              finish();
              return ed.buf;
            }
            if (r === 'interrupt') {
              this.host.write('^C\r\n');
              ed.row = 0;
              return { interrupted: true };
            }
            continue;
          }
          case '\t': {
            await this.complete(ed, shell, render, wasTab);
            lastTab = true;
            continue;
          }
          case '\x1b':
          case '\x1b[2~':
          case '\x1b[5~':
          case '\x1b[6~':
          case '\x1b[Z':
            continue;
          default:
            if (k.startsWith('\x1b')) continue;
            if (k.length === 1 && k.charCodeAt(0) < 32) continue;
            setBuf(ed.buf.slice(0, ed.pos) + k + ed.buf.slice(ed.pos), ed.pos + k.length);
        }
      }
    } finally {
      this.mode = 'idle';
    }
  }

  async reverseSearch(ed, hist, render) {
    let q = '';
    let idx = hist.length;
    let found = '';
    const saved = { prompt: ed.prompt, pw: ed.pw };
    const show = (failed = false) => {
      ed.prompt = `(${failed ? 'failed ' : ''}reverse-i-search)\`${q}': `;
      ed.pw = strWidth(ed.prompt);
      ed.buf = found;
      ed.pos = Math.max(0, found.indexOf(q));
      render();
    };
    const search = (from) => {
      for (let i = from; i >= 0; i--) {
        if (hist[i] && hist[i].includes(q)) {
          idx = i;
          found = hist[i];
          return true;
        }
      }
      return false;
    };
    show();
    const restore = () => {
      ed.prompt = saved.prompt;
      ed.pw = saved.pw;
    };
    for (;;) {
      const k = await this.nextKey();
      if (k === '\x12') {
        if (!search(idx - 1)) show(true);
        else show();
        continue;
      }
      if (k === '\x7f' || k === '\b') {
        q = q.slice(0, -1);
        idx = hist.length;
        if (q) search(idx - 1);
        else found = '';
        show();
        continue;
      }
      if (k === '\x03') {
        restore();
        ed.buf = '';
        ed.pos = 0;
        render();
        return 'interrupt';
      }
      if (k === '\x07') {
        restore();
        ed.buf = '';
        ed.pos = 0;
        render();
        return 'cancel';
      }
      if (k === '\r' || k === '\n') {
        restore();
        ed.buf = found;
        ed.pos = found.length;
        render();
        return 'accept';
      }
      if (k.length === 1 && k >= ' ') {
        q += k;
        if (!search(idx < hist.length && hist[idx]?.includes(q) ? idx : Math.min(idx, hist.length - 1))) {
          show(true);
          continue;
        }
        show();
        continue;
      }
      restore();
      ed.buf = found;
      ed.pos = found.length;
      render();
      if (k !== '\x1b') this.queue = k + this.queue;
      return 'done';
    }
  }

  completionCandidates(shell, word, isCmd) {
    const vfs = shell.vfs;
    const out = new Set();
    if (word.startsWith('$')) {
      const brace = word.startsWith('${');
      const pre = word.slice(brace ? 2 : 1);
      for (const n of shell.allVarNames()) if (n.startsWith(pre)) out.add((brace ? '${' : '$') + n + (brace ? '}' : ''));
      return { list: [...out].sort(), kind: 'var' };
    }
    if (word.startsWith('~') && !word.includes('/')) {
      for (const u of shell.system.users()) if (('~' + u.name).startsWith(word)) out.add('~' + u.name + '/');
      return { list: [...out].sort(), kind: 'user' };
    }
    if (isCmd && !word.includes('/')) {
      for (const k of shell.aliases.keys()) if (k.startsWith(word)) out.add(k);
      for (const k of shell.functions.keys()) if (k.startsWith(word)) out.add(k);
      for (const [k, v] of shell.commands) if (v.builtin && k.startsWith(word)) out.add(k);
      for (const k of RESERVED_WORDS) if (k.startsWith(word) && /^[a-z]/.test(k)) out.add(k);
      for (const d of (shell.getVar('PATH') || '').split(':')) {
        try {
          for (const n of vfs.readdir(d || '.', shell.cwd)) {
            if (!n.startsWith(word)) continue;
            try {
              const node = vfs.stat((d || '.') + '/' + n, shell.cwd);
              if (node.type === 'file' && node.mode & 0o111) out.add(n);
            } catch {}
          }
        } catch {}
      }
      if (shell.shopt.autocd || word === '' ) {}
      return { list: [...out].sort(), kind: 'cmd' };
    }
    // files
    let expanded = word;
    if (word.startsWith('~')) {
      const i = word.indexOf('/');
      expanded = shell.tildeExpand(word.slice(1, i)) + word.slice(i);
    }
    const i = expanded.lastIndexOf('/');
    const dir = i >= 0 ? expanded.slice(0, i + 1) : '';
    const base = expanded.slice(i + 1);
    const shownDir = i >= 0 ? word.slice(0, word.lastIndexOf('/') + 1) : '';
    let names = [];
    try {
      names = vfs.readdir(dir || '.', shell.cwd);
    } catch {}
    for (const n of names) {
      if (!n.startsWith(base)) continue;
      if (n.startsWith('.') && !base.startsWith('.')) continue;
      let isDir = false;
      try {
        isDir = vfs.stat(dir + n, shell.cwd).type === 'dir';
      } catch {}
      if (isCmd && !isDir) {
        try {
          if (!(vfs.stat(dir + n, shell.cwd).mode & 0o111)) continue;
        } catch {
          continue;
        }
      }
      out.add(shownDir + n + (isDir ? '/' : ''));
    }
    return { list: [...out].sort(), kind: 'file' };
  }

  async complete(ed, shell, render, second) {
    const before = ed.buf.slice(0, ed.pos);
    // find the start of the current word (unquoted whitespace or operator)
    let start = 0;
    let quote = null;
    for (let i = 0; i < before.length; i++) {
      const c = before[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (/[\s;|&<>()]/.test(c)) start = i + 1;
      if (c === '=' && /^[A-Za-z_]/.test(before.slice(start))) start = i + 1;
    }
    const rawWord = before.slice(start);
    const word = rawWord.replace(/\\(.)/g, '$1').replace(/^['"]/, '');
    const prefix = before.slice(0, start);
    const isCmd = /(^|[;|&(]|&&|\|\||\b(then|do|else|elif|sudo|time|exec|xargs|command|nohup|env|watch|which|type|man)\s)\s*$/.test(prefix) && !/=$/.test(prefix);
    let { list, kind } = this.completionCandidates(shell, word, isCmd);
    if (!list.length && isCmd && !word.includes('/') && !word.startsWith('$')) ({ list, kind } = this.completionCandidates(shell, word, false));
    if (!list.length) {
      this.host.write('\x07');
      return;
    }
    const esc = (s) => (kind === 'file' || kind === 'cmd' ? s.replace(/([ \t'"\\$`!&;|<>(){}[\]*?#~])/g, (m, c, off) => (c === '~' && off === 0 ? c : '\\' + c)) : s);
    if (list.length === 1) {
      let c = esc(list[0]);
      if (!c.endsWith('/') && kind !== 'var') c += ' ';
      if (kind === 'var') c += '';
      const b = prefix + c;
      ed.buf = b + ed.buf.slice(ed.pos);
      ed.pos = b.length;
      render();
      return;
    }
    // common prefix
    let common = list[0];
    for (const x of list) {
      let k = 0;
      while (k < common.length && k < x.length && common[k] === x[k]) k++;
      common = common.slice(0, k);
    }
    if (common.length > word.length) {
      const b = prefix + esc(common);
      ed.buf = b + ed.buf.slice(ed.pos);
      ed.pos = b.length;
      render();
      return;
    }
    if (!second) {
      this.host.write('\x07');
      return;
    }
    // list candidates in columns
    const shown = list.map((x) => (kind === 'file' ? x.replace(/\/$/, '').split('/').pop() + (x.endsWith('/') ? '/' : '') : x));
    const cols = this.cols;
    if (shown.length > 100) {
      this.host.write(`\r\nDisplay all ${shown.length} possibilities? (y or n)`);
      const k = await this.nextKey();
      if (k !== 'y' && k !== 'Y') {
        this.host.write('\r\n');
        ed.row = 0;
        this.host.write(ed.prompt);
        render();
        return;
      }
    }
    const w = Math.max(...shown.map((s) => strWidth(s))) + 2;
    const per = Math.max(1, Math.floor(cols / w));
    const rows = Math.ceil(shown.length / per);
    let out = '\r\n';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < per; c++) {
        const i = c * rows + r;
        if (i < shown.length) line += shown[i] + (c < per - 1 ? ' '.repeat(w - strWidth(shown[i])) : '');
      }
      out += line.trimEnd() + '\r\n';
    }
    this.host.write(out);
    ed.row = 0;
    this.host.write(ed.prompt);
    render();
  }

  // ---- interactive shell loop ----
  async repl(shell, { rcFiles = [], nested = false } = {}) {
    const prevShell = this.shell;
    this.shell = shell;
    shell.term = this;
    shell.interactive = true;
    const io = { 0: this.reader(), 1: this.writer(), 2: this.writer() };
    shell.baseIo = io;
    const runQuiet = async (src) => {
      try {
        await shell.runTop(src, { ...io });
      } catch (e) {
        if (e instanceof ExitEx) throw e;
        if (e instanceof InterruptEx) shell.ctl.interrupted = false;
        else throw e;
      }
    };
    let exitCode = 0;
    try {
      for (const f of rcFiles) {
        try {
          const text = shell.vfs.readFile(f, shell.cwd);
          shell.sourceStack.push(f);
          await runQuiet(text);
          shell.sourceStack.pop();
        } catch (e) {
          if (e instanceof ExitEx) throw e;
        }
      }
      for (;;) {
        shell.ctl.interrupted = false;
        for (const l of shell.takeJobNotifications()) this.write(l + '\n');
        const pc = shell.getVar('PROMPT_COMMAND');
        if (pc) await runQuiet(pc);
        if (this.onPrompt) this.onPrompt(shell);
        let ps1 = '$ ';
        try {
          ps1 = await shell.expandPrompt(shell.getVar('PS1') ?? '\\s-\\v\\$ ');
        } catch {}
        let line = await this.readLine(ps1, shell);
        if (line && line.interrupted) {
          shell.status = 130;
          continue;
        }
        if (line === null) {
          if (shell.opts.ignoreeof) {
            this.write(`Use "${nested ? 'exit' : 'logout'}" to leave the shell.\n`);
            continue;
          }
          this.write(nested ? 'exit\n' : 'logout\n');
          break;
        }
        // continuation lines
        let src = line;
        let aborted = false;
        for (;;) {
          try {
            shell.parse(src, true);
            break;
          } catch (e) {
            if (!(e instanceof ParseError) || !e.incomplete) break;
          }
          let ps2 = '> ';
          try {
            ps2 = await shell.expandPrompt(shell.getVar('PS2') ?? '> ');
          } catch {}
          const more = await this.readLine(ps2, shell, { history: false });
          if (more === null) {
            this.write(`bash: syntax error: unexpected end of file\n`);
            aborted = true;
            shell.status = 2;
            break;
          }
          if (more.interrupted) {
            aborted = true;
            shell.status = 130;
            break;
          }
          src += '\n' + more;
        }
        if (aborted) continue;
        if (!src.trim()) continue;
        try {
          const h = shell.historyExpand(src);
          if (h.changed) {
            src = h.line;
            this.write(src + '\n');
          }
        } catch (e) {
          if (e instanceof ShellError) {
            this.write(`bash: ${e.message}\n`);
            shell.status = 1;
            continue;
          }
          throw e;
        }
        this.addHistory(shell, src);
        shell.cmdCount = (shell.cmdCount || 0) + 1;
        try {
          const ioCopy = { ...io, ...(shell.baseIo !== io ? shell.baseIo : {}) };
          await shell.runTop(src, ioCopy);
        } catch (e) {
          if (e instanceof ExitEx) throw e;
          if (e instanceof InterruptEx) {
            this.write('\n');
            shell.status = 130;
            shell.ctl.interrupted = false;
            if (shell.traps.INT) await runQuiet(shell.traps.INT);
            continue;
          }
          this.write(`\nbash: internal error: ${e && e.message ? e.message : e}\n`);
          console.error(e);
          shell.status = 1;
        }
      }
      exitCode = shell.status;
    } catch (e) {
      if (!(e instanceof ExitEx)) throw e;
      exitCode = e.code;
    } finally {
      if (shell.traps.EXIT) {
        try {
          await shell.runTrap('EXIT', io);
        } catch {}
      }
      if (!nested || true) this.saveHistory(shell);
      this.shell = prevShell;
      if (prevShell) prevShell.ctl.interrupted = false;
    }
    if (typeof exitCode === 'object' && exitCode !== null) {
      if (nested && !exitCode.restart) return exitCode.code;
      throw new ExitEx(exitCode);
    }
    return exitCode;
  }

  addHistory(shell, src) {
    const ctl = shell.getVar('HISTCONTROL') || '';
    if (/ignorespace|ignoreboth/.test(ctl) && /^\s/.test(src)) return;
    const entry = src.replace(/\n+$/, '');
    if (/ignoredups|ignoreboth/.test(ctl) && shell.history[shell.history.length - 1] === entry) return;
    if (/erasedups/.test(ctl)) {
      const i = shell.history.indexOf(entry);
      if (i >= 0) shell.history.splice(i, 1);
    }
    shell.history.push(entry);
    shell.trimHistory();
    this.saveHistory(shell);
  }

  saveHistory(shell) {
    const file = shell.getVar('HISTFILE');
    if (!file) return;
    try {
      const n = parseInt(shell.getVar('HISTFILESIZE') ?? '2000', 10);
      const lines = shell.history.slice(-n);
      shell.vfs.writeFile(file, '/', lines.join('\n') + (lines.length ? '\n' : ''), { umask: 0o077 });
    } catch {}
  }
}

export { visible };
