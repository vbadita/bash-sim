// Word expansion: brace, tilde, parameter, command substitution, arithmetic,
// field splitting, pathname expansion, quote removal. Mixed into Shell.

import { skipSingle, skipDouble, skipDollar, skipBacktick, skipAnsi, skipParens } from './parser.js';
import { hasGlob, globFiles, removeMatch, replaceMatch, matchPattern } from './pattern.js';
import { evalArith, ArithError } from './arith.js';

export class ShellError extends Error {
  constructor(msg, status = 1, fatal = true) {
    super(msg);
    this.status = status;
    this.fatal = fatal;
  }
}

const globEsc = (s) => s.replace(/[\\*?[\]@!+()|]/g, '\\$&');
const regexEsc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

class FieldBuilder {
  constructor(ifs, split, esc = globEsc) {
    this.ifs = ifs;
    this.split = split;
    this.esc = esc;
    this.fields = [];
    this.cur = null;
    this.atEmpty = false;
  }
  ensure() {
    if (!this.cur) this.cur = { val: '', pat: '', keep: false };
    return this.cur;
  }
  addQuoted(s) {
    this.adds = (this.adds || 0) + 1;
    const c = this.ensure();
    c.val += s;
    c.pat += this.esc(s);
    c.keep = true;
  }
  addLiteral(s) {
    const c = this.ensure();
    c.val += s;
    c.pat += s;
  }
  brk() {
    if (!this.split) {
      this.addQuoted(' ');
      return;
    }
    if (this.cur) this.fields.push(this.cur);
    this.cur = null;
  }
  addExpansion(s, quoted) {
    if (quoted) return this.addQuoted(s);
    if (!this.split) return this.addLiteral(s);
    const ifs = this.ifs;
    if (ifs === '') {
      if (s !== '') this.addLiteral(s);
      return;
    }
    const ws = new Set([...ifs].filter((c) => c === ' ' || c === '\t' || c === '\n'));
    const isIfs = (c) => ifs.includes(c);
    const n = s.length;
    let i = 0;
    while (i < n && ws.has(s[i])) i++;
    if (i > 0 && this.cur) {
      this.fields.push(this.cur);
      this.cur = null;
    }
    while (i < n) {
      const start = i;
      while (i < n && !isIfs(s[i])) i++;
      const word = s.slice(start, i);
      if (word) this.addLiteral(word);
      if (i >= n) break;
      let sawNws = false;
      while (i < n && ws.has(s[i])) i++;
      if (i < n && isIfs(s[i]) && !ws.has(s[i])) {
        sawNws = true;
        i++;
        while (i < n && ws.has(s[i])) i++;
      }
      if (word || sawNws || this.cur) {
        this.ensure().keep = true;
        this.fields.push(this.cur);
        this.cur = null;
      }
    }
  }
  done() {
    if (this.cur) this.fields.push(this.cur);
    this.cur = null;
    return this.fields.filter((f) => f.keep || f.val !== '');
  }
}

export function ansiDecode(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const d = s[++i];
    switch (d) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e':
      case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '?': out += '?'; break;
      case 'c': {
        const x = s[++i] || '';
        out += String.fromCharCode(x.toUpperCase().charCodeAt(0) ^ 64);
        break;
      }
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const m = (d === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\' + d;
        break;
      }
      default:
        if (d >= '0' && d <= '7') {
          const m = /^[0-7]{1,3}/.exec(s.slice(i));
          out += String.fromCharCode(parseInt(m[0], 8) & 255);
          i += m[0].length - 1;
        } else if (d === undefined) out += '\\';
        else out += '\\' + d;
    }
  }
  return out;
}

// brace expansion on a raw word
export function braceExpand(s) {
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(s, i);
      if (k < 0) return [s];
      i = k - 1;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(s, i);
      if (k < 0) return [s];
      i = k - 1;
      continue;
    }
    if (c === '`') {
      const k = skipBacktick(s, i);
      if (k < 0) return [s];
      i = k - 1;
      continue;
    }
    if (c === '$' && (s[i + 1] === '(' || s[i + 1] === '{')) {
      const k = skipDollar(s, i);
      if (k < 0) return [s];
      i = k - 1;
      continue;
    }
    if (c !== '{') continue;
    // find matching close and top-level commas
    let depth = 0;
    const commas = [];
    let j = i;
    let ok = false;
    for (; j < n; j++) {
      const d = s[j];
      if (d === '\\') {
        j++;
        continue;
      }
      if (d === "'" || d === '"' || d === '`') {
        const k = d === "'" ? skipSingle(s, j) : d === '"' ? skipDouble(s, j) : skipBacktick(s, j);
        if (k < 0) break;
        j = k - 1;
        continue;
      }
      if (d === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        const k = skipDollar(s, j);
        if (k < 0) break;
        j = k - 1;
        continue;
      }
      if (d === '{') depth++;
      else if (d === '}') {
        depth--;
        if (depth === 0) {
          ok = true;
          break;
        }
      } else if (d === ',' && depth === 1) commas.push(j);
    }
    if (!ok) continue;
    const inner = s.slice(i + 1, j);
    const pre = s.slice(0, i);
    const post = s.slice(j + 1);
    let alts = null;
    if (commas.length) {
      alts = [];
      let last = i + 1;
      for (const k of commas) {
        alts.push(s.slice(last, k));
        last = k + 1;
      }
      alts.push(s.slice(last, j));
    } else {
      alts = sequence(inner);
    }
    if (!alts) continue;
    const out = [];
    const posts = braceExpand(post);
    for (const a of alts) for (const ax of braceExpand(a)) for (const p of posts) out.push(pre + ax + p);
    return out;
  }
  return [s];
}

function sequence(inner) {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    let step = Math.abs(parseInt(m[3] || '1', 10)) || 1;
    const width = /^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2]) ? Math.max(m[1].length, m[2].length) : 0;
    const out = [];
    const pad = (x) => {
      if (!width) return String(x);
      const neg = x < 0;
      let s = String(Math.abs(x)).padStart(width - (neg ? 1 : 0), '0');
      return neg ? '-' + s : s;
    };
    if (a <= b) for (let x = a; x <= b && out.length < 100000; x += step) out.push(pad(x));
    else for (let x = a; x >= b && out.length < 100000; x -= step) out.push(pad(x));
    return out;
  }
  m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (m) {
    const a = m[1].charCodeAt(0);
    const b = m[2].charCodeAt(0);
    const step = Math.abs(parseInt(m[3] || '1', 10)) || 1;
    const out = [];
    if (a <= b) for (let x = a; x <= b; x += step) out.push(String.fromCharCode(x));
    else for (let x = a; x >= b; x -= step) out.push(String.fromCharCode(x));
    return out;
  }
  return null;
}

// parse a parameter reference at the start of s: name, name[sub], digits, or special char
function parseParamRef(s) {
  let m = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(s);
  if (m) {
    let len = m[0].length;
    let sub = null;
    if (s[len] === '[') {
      let depth = 0;
      let k = len;
      for (; k < s.length; k++) {
        if (s[k] === '[') depth++;
        else if (s[k] === ']') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (k >= s.length) return null;
      sub = s.slice(len + 1, k);
      len = k + 1;
    }
    return { name: m[1], sub, len };
  }
  m = /^[0-9]+/.exec(s);
  if (m) return { name: m[0], sub: null, len: m[0].length };
  if (s && '@*#?$!-_'.includes(s[0])) return { name: s[0], sub: null, len: 1 };
  return null;
}

export const ExpandMixin = {
  ifsValue() {
    const v = this.getVar('IFS');
    return v === undefined ? ' \t\n' : v;
  },

  async expandWords(raws, { glob = true } = {}) {
    const out = [];
    for (const raw of raws) {
      const bs = this.opts.braceexpand ? braceExpand(raw) : [raw];
      for (const b of bs) for (const f of await this.expandWord(b, { glob })) out.push(f);
    }
    return out;
  },

  async expandWord(raw, { glob = true } = {}) {
    const fb = new FieldBuilder(this.ifsValue(), true);
    await this.expandInto(raw, fb, { tilde: true });
    const fields = fb.done();
    const out = [];
    for (const f of fields) {
      if (glob && !this.opts.noglob && hasGlob(f.pat, this.shopt.extglob)) {
        const m = globFiles(this.vfs, this.cwd, f.pat, {
          dotglob: this.shopt.dotglob,
          globstar: this.shopt.globstar,
          nocase: this.shopt.nocaseglob,
          extglob: this.shopt.extglob,
        });
        if (m.length) {
          out.push(...m);
          continue;
        }
        if (this.shopt.failglob) throw new ShellError(`no match: ${f.val}`, 1, false);
        if (this.shopt.nullglob) continue;
      }
      out.push(f.val);
    }
    return out;
  },

  // no field splitting, no globbing (assignments, redirection targets, case word, [[ ]])
  async expandString(raw, { tilde = true } = {}) {
    const fb = new FieldBuilder(this.ifsValue(), false);
    await this.expandInto(raw, fb, { tilde });
    return fb.done().map((f) => f.val).join(' ');
  },

  async expandAssignValue(raw) {
    const fb = new FieldBuilder(this.ifsValue(), false);
    // tilde after = and after each unquoted ':'
    const parts = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '\\') {
        cur += c + (raw[i + 1] || '');
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`' || (c === '$' && (raw[i + 1] === '(' || raw[i + 1] === '{'))) {
        const k = c === "'" ? skipSingle(raw, i) : c === '"' ? skipDouble(raw, i) : c === '`' ? skipBacktick(raw, i) : skipDollar(raw, i);
        if (k < 0) {
          cur += raw.slice(i);
          break;
        }
        cur += raw.slice(i, k);
        i = k - 1;
        continue;
      }
      if (c === ':' && depth === 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur += c;
    }
    parts.push(cur);
    for (let i = 0; i < parts.length; i++) {
      if (i) fb.addQuoted(':');
      await this.expandInto(parts[i], fb, { tilde: true });
    }
    return fb.done().map((f) => f.val).join(' ');
  },

  // pattern context: quoted characters escaped so they match literally
  async expandPattern(raw, regex = false) {
    const fb = new FieldBuilder(this.ifsValue(), false, regex ? regexEsc : globEsc);
    await this.expandInto(raw, fb, { tilde: true });
    return fb.done().map((f) => f.pat).join(' ');
  },

  async expandHeredoc(body) {
    const fb = new FieldBuilder('', false);
    await this.expandInto(body, fb, { dq: true, heredoc: true });
    return fb.done().map((f) => f.val).join('');
  },

  // prompt strings and similar: parameter/command/arith expansion only
  async expandText(s) {
    return this.expandHeredoc(s);
  },

  tildeExpand(prefix) {
    if (prefix === '') return this.getVar('HOME') ?? this.homeOf(this.user.name) ?? '~';
    if (prefix === '+') return this.getVar('PWD') ?? '~+';
    if (prefix === '-') return this.getVar('OLDPWD') ?? '~-';
    if (/^[+-]?\d+$/.test(prefix)) {
      const n = parseInt(prefix.replace(/^[+-]/, ''), 10);
      const stack = [this.cwd, ...this.dirstack];
      const v = prefix.startsWith('-') ? stack[stack.length - 1 - n] : stack[n];
      return v ?? '~' + prefix;
    }
    return this.homeOf(prefix) ?? '~' + prefix;
  },

  async expandInto(raw, fb, { dq = false, tilde = false, heredoc = false } = {}) {
    let i = 0;
    const n = raw.length;
    if (tilde && !dq && raw[0] === '~') {
      let j = 1;
      while (j < n && raw[j] !== '/' && raw[j] !== ':') j++;
      const prefix = raw.slice(1, j);
      if (!/['"\\$`]/.test(prefix)) {
        const v = this.tildeExpand(prefix);
        if (v.startsWith('~')) fb.addLiteral(v);
        else fb.addQuoted(v);
        i = j;
      }
    }
    if (!dq && (raw[0] === '<' || raw[0] === '>') && raw[1] === '(') {
      const k = skipParens(raw, 1);
      if (k > 0) {
        fb.addQuoted(await this.processSubst(raw[0], raw.slice(2, k - 1)));
        i = k;
      }
    }
    while (i < n) {
      const c = raw[i];
      if (c === '\\') {
        const d = raw[i + 1];
        if (dq) {
          const escapable = heredoc ? '$`\\\n' : '$`"\\\n';
          if (d !== undefined && escapable.includes(d)) {
            if (d !== '\n') fb.addQuoted(d);
            i += 2;
          } else {
            fb.addQuoted('\\');
            i++;
          }
        } else if (d === undefined) {
          fb.addLiteral('\\');
          i++;
        } else {
          if (d !== '\n') fb.addQuoted(d);
          i += 2;
        }
        continue;
      }
      if (c === "'" && !dq) {
        const k = skipSingle(raw, i);
        if (k < 0) {
          fb.addLiteral(raw.slice(i));
          break;
        }
        fb.addQuoted(raw.slice(i + 1, k - 1));
        i = k;
        continue;
      }
      if (c === '"' && !dq) {
        const k = skipDouble(raw, i);
        if (k < 0) {
          fb.addLiteral(raw.slice(i));
          break;
        }
        await this.expandDQ(raw.slice(i + 1, k - 1), fb);
        i = k;
        continue;
      }
      if (c === '`') {
        const k = skipBacktick(raw, i);
        if (k < 0) {
          fb.addLiteral(raw.slice(i));
          break;
        }
        let cmd = raw.slice(i + 1, k - 1).replace(/\\([$`\\])/g, '$1');
        if (dq) cmd = cmd.replace(/\\"/g, '"');
        fb.addExpansion(await this.commandSubst(cmd), dq);
        i = k;
        continue;
      }
      if (c === '$') {
        const d = raw[i + 1];
        if (d === "'" && !dq) {
          const k = skipAnsi(raw, i);
          if (k < 0) {
            fb.addLiteral(raw.slice(i));
            break;
          }
          fb.addQuoted(ansiDecode(raw.slice(i + 2, k - 1)));
          i = k;
          continue;
        }
        if (d === '"' && !dq) {
          const k = skipDouble(raw, i + 1);
          if (k < 0) {
            fb.addLiteral(raw.slice(i));
            break;
          }
          await this.expandDQ(raw.slice(i + 2, k - 1), fb);
          i = k;
          continue;
        }
        if (d === '(') {
          const k = skipDollar(raw, i);
          if (k < 0) {
            fb.addLiteral(raw.slice(i));
            break;
          }
          if (raw[i + 2] === '(' && skipParens(raw, i + 2) === k - 1 && raw[k - 2] === ')') {
            const expr = raw.slice(i + 3, k - 2);
            fb.addExpansion(await this.arithExpand(expr), dq);
          } else {
            fb.addExpansion(await this.commandSubst(raw.slice(i + 2, k - 1)), dq);
          }
          i = k;
          continue;
        }
        if (d === '[') {
          // obsolete $[expr]
          const k = raw.indexOf(']', i);
          if (k > 0) {
            fb.addExpansion(await this.arithExpand(raw.slice(i + 2, k)), dq);
            i = k + 1;
            continue;
          }
        }
        if (d === '{') {
          const k = skipDollar(raw, i);
          if (k < 0) {
            fb.addLiteral(raw.slice(i));
            break;
          }
          await this.paramExpand(raw.slice(i + 2, k - 1), fb, dq);
          i = k;
          continue;
        }
        let m;
        if (d !== undefined && (m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1)))) {
          await this.simpleParam(m[0], fb, dq);
          i += 1 + m[0].length;
          continue;
        }
        if (d !== undefined && /[0-9@*#?$!\-_]/.test(d)) {
          await this.simpleParam(d, fb, dq);
          i += 2;
          continue;
        }
        if (dq) fb.addQuoted('$');
        else fb.addLiteral('$');
        i++;
        continue;
      }
      // literal run
      let j = i + 1;
      while (j < n && !'\\\'"`$'.includes(raw[j])) j++;
      const lit = raw.slice(i, j);
      if (dq) fb.addQuoted(lit);
      else fb.addLiteral(lit);
      i = j;
    }
  },

  async expandDQ(inner, fb) {
    const before = fb.atEmpty;
    fb.atEmpty = false;
    const adds = fb.adds || 0;
    const fieldsBefore = fb.fields.length;
    await this.expandInto(inner, fb, { dq: true });
    // "${empty[@]}" alone produces no word at all
    const onlyEmptyList = fb.atEmpty && (fb.adds || 0) === adds && fb.fields.length === fieldsBefore;
    if (!onlyEmptyList) fb.ensure().keep = true;
    fb.atEmpty = before || fb.atEmpty;
  },

  async simpleParam(name, fb, dq) {
    if (name === '@' || name === '*') {
      this.addList(this.positional.slice(), fb, dq, name === '*');
      return;
    }
    const v = this.getParam(name, null);
    if (v === undefined && this.opts.nounset && name !== '!' ) {
      throw new ShellError(`${name}: unbound variable`, 127);
    }
    fb.addExpansion(v ?? '', dq);
  },

  addList(values, fb, dq, star) {
    if (star) {
      const ifs = this.ifsValue();
      const sep = this.getVar('IFS') === undefined ? ' ' : ifs.slice(0, 1);
      if (dq) {
        fb.addQuoted(values.join(sep));
        return;
      }
    }
    if (!values.length) {
      fb.atEmpty = true;
      return;
    }
    values.forEach((v, k) => {
      if (k > 0) fb.brk();
      fb.addExpansion(v, dq);
    });
  },

  // value of a parameter for ${...} handling
  // returns {list: [...] | null, star, value, set}
  paramValue(name, sub) {
    if (name === '@' || name === '*') return { list: this.positional.slice(), star: name === '*', set: true, isPos: true };
    if (sub === '@' || sub === '*') {
      const dyn = this.arrayVar(name);
      if (dyn) return { list: dyn, star: sub === '*', set: dyn.length > 0 };
      const v = this.lookupVar(name);
      let list = [];
      if (v) {
        if (v.a) list = [...v.a.keys()].sort((a, b) => a - b).map((k) => v.a.get(k));
        else if (v.A) list = [...v.A.values()];
        else if (v.v !== undefined) list = [v.v];
      }
      return { list, star: sub === '*', set: list.length > 0 };
    }
    if (sub !== null) {
      const val = this.getElement(name, sub);
      return { value: val, set: val !== undefined };
    }
    const val = this.getParam(name, null);
    return { value: val, set: val !== undefined };
  },

  async evalSub(name, sub) {
    // expand $ inside a subscript
    return sub.includes('$') || sub.includes('`') ? await this.expandString(sub) : sub;
  },

  async paramExpand(content, fb, dq) {
    const bad = () => new ShellError(`\${${content}}: bad substitution`, 1);
    if (content === '') throw bad();
    // ${#...} length
    if (content[0] === '#' && content.length > 1) {
      const ref = parseParamRef(content.slice(1));
      if (ref && ref.len === content.length - 1) {
        const sub = ref.sub !== null ? await this.evalSub(ref.name, ref.sub) : null;
        const pv = this.paramValue(ref.name, sub);
        if (pv.list) fb.addExpansion(String(pv.list.length), dq);
        else {
          if (pv.value === undefined && this.opts.nounset) throw new ShellError(`${ref.name}: unbound variable`, 127);
          fb.addExpansion(String([...(pv.value ?? '')].length), dq);
        }
        return;
      }
    }
    let rest = content;
    let indirect = false;
    if (content[0] === '!' && content.length > 1) {
      let m;
      if ((m = /^!([A-Za-z_][A-Za-z0-9_]*)([*@])$/.exec(content))) {
        const names = this.allVarNames().filter((k) => k.startsWith(m[1]));
        this.addList(names, fb, dq, m[2] === '*');
        return;
      }
      if ((m = /^!([A-Za-z_][A-Za-z0-9_]*)\[([*@])\]$/.exec(content))) {
        const v = this.lookupVar(m[1]);
        let keys = [];
        if (v && v.a) keys = [...v.a.keys()].sort((a, b) => a - b).map(String);
        else if (v && v.A) keys = [...v.A.keys()];
        else if (v && v.v !== undefined) keys = ['0'];
        this.addList(keys, fb, dq, m[2] === '*');
        return;
      }
      indirect = true;
      rest = content.slice(1);
    }
    const ref = parseParamRef(rest);
    if (!ref) throw bad();
    let name = ref.name;
    let sub = ref.sub !== null ? await this.evalSub(name, ref.sub) : null;
    let op = rest.slice(ref.len);
    if (indirect) {
      const target = this.paramValue(name, sub);
      const t = target.list ? target.list.join(' ') : target.value;
      if (t === undefined || t === '') {
        if (this.opts.nounset) throw new ShellError(`${name}: unbound variable`, 127);
        if (!op) return;
      }
      const r2 = parseParamRef(t || '');
      if (t && (!r2 || r2.len !== t.length)) throw new ShellError(`${t}: invalid variable name`);
      if (r2) {
        name = r2.name;
        sub = r2.sub !== null ? await this.evalSub(r2.name, r2.sub) : null;
      }
    }
    let pv = this.paramValue(name, sub);
    const varDesc = sub !== null ? `${name}[${sub}]` : name;

    if (op === '') {
      if (pv.list) {
        this.addList(pv.list, fb, dq, pv.star);
        return;
      }
      if (pv.value === undefined && this.opts.nounset) throw new ShellError(`${varDesc}: unbound variable`, 127);
      fb.addExpansion(pv.value ?? '', dq);
      return;
    }
    let m;
    // default / assign / error / alternate
    if ((m = /^(:?)([-=?+])/.exec(op))) {
      const colon = m[1] === ':';
      const word = op.slice(m[0].length);
      const isNull = pv.list ? pv.list.length === 0 || (colon && pv.list.join('') === '' && false) : pv.value === undefined || (colon && pv.value === '');
      const isSet = pv.list ? pv.list.length > 0 && !(colon && pv.list.length === 1 && pv.list[0] === '') : pv.value !== undefined && !(colon && pv.value === '');
      const t = m[2];
      if (t === '-') {
        if (!isSet) await this.expandInto(word, fb, { dq, tilde: !dq });
        else if (pv.list) this.addList(pv.list, fb, dq, pv.star);
        else fb.addExpansion(pv.value, dq);
        return;
      }
      if (t === '+') {
        if (isSet) await this.expandInto(word, fb, { dq, tilde: !dq });
        else if (!isNull && false) fb.addExpansion('', dq);
        return;
      }
      if (t === '=') {
        if (!isSet) {
          if (/^[0-9@*#?$!\-]/.test(name) || pv.isPos) throw new ShellError(`$${name}: cannot assign in this way`);
          const val = await this.expandString(word);
          if (sub !== null) this.setElement(name, sub, val);
          else this.setVar(name, val);
          fb.addExpansion(this.getParam(name, sub) ?? val, dq);
        } else if (pv.list) this.addList(pv.list, fb, dq, pv.star);
        else fb.addExpansion(pv.value, dq);
        return;
      }
      if (t === '?') {
        if (!isSet) {
          const msg = word ? await this.expandString(word) : colon ? 'parameter null or not set' : 'parameter not set';
          throw new ShellError(`${varDesc}: ${msg}`, 127, true);
        }
        if (pv.list) this.addList(pv.list, fb, dq, pv.star);
        else fb.addExpansion(pv.value, dq);
        return;
      }
    }
    if (pv.value === undefined && !pv.list && this.opts.nounset) throw new ShellError(`${varDesc}: unbound variable`, 127);
    // substring
    if (op[0] === ':') {
      const spec = op.slice(1);
      let offRaw = spec;
      let lenRaw = null;
      // split on top-level ':' (not inside ?: ternary is ambiguous; follow bash: first ':')
      let depth = 0;
      for (let k = 0; k < spec.length; k++) {
        if (spec[k] === '(') depth++;
        else if (spec[k] === ')') depth--;
        else if (spec[k] === '?' && depth === 0) depth += 100;
        else if (spec[k] === ':' && depth >= 100) depth -= 100;
        else if (spec[k] === ':' && depth === 0) {
          offRaw = spec.slice(0, k);
          lenRaw = spec.slice(k + 1);
          break;
        }
      }
      let off = Number(await this.arithExpand(offRaw.trim() || '0'));
      let len = lenRaw !== null ? Number(await this.arithExpand(lenRaw.trim() || '0')) : null;
      if (pv.list) {
        let list = pv.list;
        if (pv.isPos) list = [this.argv0, ...list];
        else if (false) list = list;
        if (pv.isPos && off === 0) off = 0;
        else if (pv.isPos) off = off;
        let start = off < 0 ? list.length + off : off;
        if (!pv.isPos) start = off < 0 ? list.length + off : off;
        if (start < 0) {
          this.addList([], fb, dq, pv.star);
          return;
        }
        if (len !== null && len < 0) throw new ShellError(`${lenRaw}: substring expression < 0`);
        const sl = len === null ? list.slice(start) : list.slice(start, start + len);
        this.addList(sl, fb, dq, pv.star);
        return;
      }
      const chars = [...(pv.value ?? '')];
      let start = off < 0 ? chars.length + off : off;
      if (start < 0 || start > chars.length) {
        fb.addExpansion('', dq);
        return;
      }
      let end = chars.length;
      if (len !== null) {
        end = len < 0 ? chars.length + len : start + len;
        if (end < start) throw new ShellError(`${lenRaw}: substring expression < 0`);
      }
      fb.addExpansion(chars.slice(start, end).join(''), dq);
      return;
    }
    const apply = async (fn) => {
      if (pv.list) this.addList(pv.list.map(fn), fb, dq, pv.star);
      else fb.addExpansion(fn(pv.value ?? ''), dq);
    };
    const popts = { extglob: this.shopt.extglob, nocase: this.shopt.nocasematch };
    if ((m = /^(##|#|%%|%)/.exec(op))) {
      const pat = await this.expandPattern(op.slice(m[0].length));
      await apply((v) => removeMatch(v, pat, m[0], popts));
      return;
    }
    if (op[0] === '/') {
      let mode = '/';
      let r = op.slice(1);
      if (r[0] === '/' || r[0] === '#' || r[0] === '%') {
        mode += r[0];
        r = r.slice(1);
      }
      // split pattern / replacement at first unescaped, unquoted '/'
      let k = 0;
      for (; k < r.length; k++) {
        if (r[k] === '\\') k++;
        else if (r[k] === "'") k = skipSingle(r, k) - 1;
        else if (r[k] === '"') k = skipDouble(r, k) - 1;
        else if (r[k] === '/') break;
        if (k < 0) break;
      }
      const patRaw = k >= 0 ? r.slice(0, k) : r;
      const repRaw = k >= 0 && k < r.length ? r.slice(k + 1) : '';
      const pat = await this.expandPattern(patRaw);
      const rep = await this.expandString(repRaw);
      await apply((v) => replaceMatch(v, pat, rep, mode, popts));
      return;
    }
    if ((m = /^(\^\^|\^|,,|,|~~|~)/.exec(op))) {
      const patRaw = op.slice(m[0].length);
      const pat = patRaw ? await this.expandPattern(patRaw) : null;
      const okc = (ch) => !pat || matchPattern(pat, ch, popts);
      const conv = (ch, kind) => {
        if (!okc(ch)) return ch;
        if (kind === 'u') return ch.toUpperCase();
        if (kind === 'l') return ch.toLowerCase();
        return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
      };
      const kind = m[0][0] === '^' ? 'u' : m[0][0] === ',' ? 'l' : 't';
      const all = m[0].length === 2;
      await apply((v) => {
        const cs = [...v];
        if (all) return cs.map((ch) => conv(ch, kind)).join('');
        if (!cs.length) return v;
        return conv(cs[0], kind) + cs.slice(1).join('');
      });
      return;
    }
    if (op[0] === '@' && op.length === 2) {
      const t = op[1];
      const v = this.lookupVar(name);
      switch (t) {
        case 'Q': await apply((x) => this.quoteValue(x)); return;
        case 'E': await apply((x) => ansiDecode(x)); return;
        case 'P': {
          if (pv.list) this.addList(await Promise.all(pv.list.map((x) => this.expandPrompt(x))), fb, dq, pv.star);
          else fb.addExpansion(await this.expandPrompt(pv.value ?? ''), dq);
          return;
        }
        case 'U': await apply((x) => x.toUpperCase()); return;
        case 'u': await apply((x) => (x ? x[0].toUpperCase() + x.slice(1) : x)); return;
        case 'L': await apply((x) => x.toLowerCase()); return;
        case 'a': fb.addExpansion(v ? this.attrString(v) : '', dq); return;
        case 'A': {
          if (!v) return;
          fb.addExpansion(this.declareLine(name, v, true), dq);
          return;
        }
        case 'K':
        case 'k': {
          if (v && (v.a || v.A)) {
            const parts = [];
            if (v.a) for (const k2 of [...v.a.keys()].sort((a, b) => a - b)) parts.push(String(k2), this.quoteValue(v.a.get(k2)));
            else for (const [k2, x] of v.A) parts.push(this.quoteValue(k2), this.quoteValue(x));
            fb.addExpansion(parts.join(' '), dq);
          } else await apply((x) => this.quoteValue(x));
          return;
        }
      }
    }
    throw bad();
  },

  async arithExpand(expr) {
    const s = await this.expandArithText(expr);
    try {
      return String(this.evalArith(s));
    } catch (e) {
      if (e instanceof ArithError) throw new ShellError(e.message, 1);
      throw e;
    }
  },

  async expandArithText(expr) {
    if (!/[$`"'\\]/.test(expr)) return expr;
    return this.expandHeredoc(expr.replace(/"/g, ''));
  },

  evalArith(s) {
    const shell = this;
    return evalArith(s, {
      nounset: this.opts.nounset,
      get(name, sub) {
        if (sub === null) return shell.getParam(name, null);
        const v = shell.lookupVar(name);
        if (v && v.A) return v.A.get(sub);
        return shell.getElement(name, String(shell.evalArith(sub)));
      },
      set(name, sub, val) {
        if (sub === null) shell.setVar(name, val);
        else {
          const v = shell.lookupVar(name);
          shell.setElement(name, v && v.A ? sub : String(shell.evalArith(sub)), val);
        }
      },
    });
  },
};
