// Bash lexer and recursive-descent parser. Words are kept raw (quotes and all);
// expansion happens at run time in expand.js.

export class ParseError extends Error {
  constructor(msg, incomplete = false) {
    super(msg);
    this.incomplete = incomplete;
  }
}

const incomplete = (what) => new ParseError(`unexpected EOF while looking for matching \`${what}'`, true);

// ---------- scanning helpers shared with the expander ----------

export function skipSingle(s, i) {
  const j = s.indexOf("'", i + 1);
  return j < 0 ? -1 : j + 1;
}

export function skipAnsi(s, i) {
  // s[i] = '$', s[i+1] = "'"
  for (let j = i + 2; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === "'") return j + 1;
  }
  return -1;
}

export function skipBacktick(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '`') return j + 1;
  }
  return -1;
}

export function skipDouble(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '"') return j + 1;
    else if (c === '`') {
      j = skipBacktick(s, j);
      if (j < 0) return -1;
      j--;
    } else if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
      j = skipDollar(s, j);
      if (j < 0) return -1;
      j--;
    }
  }
  return -1;
}

// s[i] = '$' followed by ( or {; returns index after the matching close
export function skipDollar(s, i) {
  const open = s[i + 1];
  const close = open === '(' ? ')' : '}';
  let depth = 1;
  let caseDepth = 0;
  for (let j = i + 2; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === "'" && (open === '(' || true)) {
      if (open === '{' && false) continue;
      const k = skipSingle(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '`') {
      const k = skipBacktick(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
      const k = skipDollar(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (open === '(') {
      // crude support for `case ... in x) ...` inside $( )
      if (/[\s;(]/.test(s[j - 1] || ' ') && s.startsWith('case', j) && /\s/.test(s[j + 4] || '')) caseDepth++;
      if (/[\s;]/.test(s[j - 1] || ' ') && s.startsWith('esac', j) && /[\s;)]/.test(s[j + 4] || ')')) caseDepth--;
      if (c === '#' && /\s/.test(s[j - 1] || '')) {
        const k = s.indexOf('\n', j);
        if (k < 0) return -1;
        j = k;
        continue;
      }
    }
    if (c === open) depth++;
    else if (c === close) {
      if (open === '(' && caseDepth > 0 && depth === 1) continue;
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// balanced (...) starting at s[i] = '('
export function skipParens(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === "'") {
      const k = skipSingle(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '"') {
      const k = skipDouble(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
      const k = skipDollar(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '`') {
      const k = skipBacktick(s, j);
      if (k < 0) return -1;
      j = k - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

// ---------- lexer ----------

const OPS = ['<<<', '<<-', '&>>', ';;&', '((', '<<', '>>', '<&', '>&', '<>', '>|', '&&', '||', ';;', ';&', '|&', '&>', '<', '>', '|', '&', ';', '(', ')'];
const META = ' \t\n;&|()<>';
export const REDIR_OPS = new Set(['<', '>', '>>', '>|', '<>', '<&', '>&', '&>', '&>>', '<<', '<<-', '<<<']);
export const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', 'select', '{', '}', '!', '[[', ']]', 'time', 'coproc']);
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/;

export class Lexer {
  constructor(src, { interactive = false } = {}) {
    this.s = src;
    this.i = 0;
    this.line = 1;
    this.heredocs = [];
    this.interactive = interactive;
    this.warnings = [];
  }

  skipBlanks() {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
        this.line++;
      } else break;
    }
  }

  readHeredocs() {
    const s = this.s;
    for (const hd of this.heredocs) {
      const lines = [];
      for (;;) {
        if (this.i >= s.length) {
          if (this.interactive) throw new ParseError('here-document', true);
          this.warnings.push(`warning: here-document at line ${hd.line} delimited by end-of-file (wanted \`${hd.delim}')`);
          break;
        }
        let j = s.indexOf('\n', this.i);
        if (j < 0) j = s.length;
        let line = s.slice(this.i, j);
        this.i = Math.min(j + 1, s.length);
        this.line++;
        if (hd.strip) line = line.replace(/^\t+/, '');
        if (line === hd.delim) break;
        lines.push(line);
      }
      hd.body = lines.length ? lines.join('\n') + '\n' : '';
    }
    this.heredocs = [];
  }

  next() {
    this.skipBlanks();
    const s = this.s;
    const start = this.i;
    if (this.i >= s.length) {
      if (this.heredocs.length) {
        if (this.interactive) throw new ParseError('here-document', true);
        for (const hd of this.heredocs) hd.body = '';
        this.heredocs = [];
      }
      return { t: 'eof', start, end: start, line: this.line };
    }
    let c = s[this.i];
    if (c === '#') {
      while (this.i < s.length && s[this.i] !== '\n') this.i++;
      return this.next();
    }
    if (c === '\n') {
      this.i++;
      const line = this.line++;
      if (this.heredocs.length) this.readHeredocs();
      return { t: 'nl', start, end: start + 1, line };
    }
    if ((c === '<' || c === '>') && s[this.i + 1] === '(') return this.readWord();
    for (const op of OPS) {
      if (s.startsWith(op, this.i)) {
        this.i += op.length;
        return { t: 'op', v: op, start, end: this.i, line: this.line };
      }
    }
    return this.readWord();
  }

  readWord() {
    const s = this.s;
    const start = this.i;
    let w = '';
    const line = this.line;
    if ((s[this.i] === '<' || s[this.i] === '>') && s[this.i + 1] === '(') {
      const k = skipParens(s, this.i + 1);
      if (k < 0) throw incomplete(')');
      w = s.slice(this.i, k);
      this.i = k;
    }
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '(' && w && (ASSIGN_RE.test(w) && /=$/.test(w) || /[@!*+?]$/.test(w))) {
        const k = skipParens(s, this.i);
        if (k < 0) throw incomplete(')');
        w += s.slice(this.i, k);
        for (let x = this.i; x < k; x++) if (s[x] === '\n') this.line++;
        this.i = k;
        continue;
      }
      if (META.includes(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') {
          this.i += 2;
          this.line++;
          continue;
        }
        if (this.i + 1 >= s.length) {
          if (this.interactive) throw new ParseError('\\', true);
          w += c;
          this.i++;
          continue;
        }
        w += s.slice(this.i, this.i + 2);
        this.i += 2;
        continue;
      }
      let k = -1;
      let what = c;
      if (c === "'") k = skipSingle(s, this.i);
      else if (c === '"') k = skipDouble(s, this.i);
      else if (c === '`') k = skipBacktick(s, this.i);
      else if (c === '$' && s[this.i + 1] === "'") k = skipAnsi(s, this.i);
      else if (c === '$' && s[this.i + 1] === '"') {
        k = skipDouble(s, this.i + 1);
        what = '"';
      } else if (c === '$' && (s[this.i + 1] === '(' || s[this.i + 1] === '{')) {
        k = skipDollar(s, this.i);
        what = s[this.i + 1] === '(' ? ')' : '}';
      } else {
        w += c;
        this.i++;
        continue;
      }
      if (k < 0) throw incomplete(what);
      const piece = s.slice(this.i, k);
      for (const ch of piece) if (ch === '\n') this.line++;
      w += piece;
      this.i = k;
    }
    const tok = { t: 'w', v: w, start, end: this.i, line };
    if (/^\d+$/.test(w) && (s[this.i] === '<' || s[this.i] === '>')) tok.t = 'io';
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(w) && (s[this.i] === '<' || s[this.i] === '>')) tok.t = 'io';
    return tok;
  }

  // raw text up to the matching '))' (after '((' was consumed)
  readArith() {
    const s = this.s;
    let depth = 0;
    const start = this.i;
    for (let j = this.i; j < s.length; j++) {
      const c = s[j];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) {
          if (s[j + 1] === ')') {
            this.i = j + 2;
            return s.slice(start, j);
          }
          throw new ParseError("syntax error near unexpected token `)'");
        }
        depth--;
      } else if (c === '\n') this.line++;
      else if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        const k = skipDollar(s, j);
        if (k < 0) throw incomplete(')');
        j = k - 1;
      } else if (c === '"' || c === "'") {
        const k = c === '"' ? skipDouble(s, j) : skipSingle(s, j);
        if (k < 0) throw incomplete(c);
        j = k - 1;
      }
    }
    throw incomplete('))');
  }

  // [[ x =~ regex ]]: the regex may contain unquoted ( ) | < >
  readRegex() {
    this.skipBlanks();
    const s = this.s;
    const start = this.i;
    let depth = 0;
    let j = this.i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        const k = c === '"' ? skipDouble(s, j) : skipSingle(s, j);
        if (k < 0) throw incomplete(c);
        j = k - 1;
        continue;
      }
      if (c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
        const k = skipDollar(s, j);
        if (k < 0) throw incomplete('}');
        j = k - 1;
        continue;
      }
      if (c === '(' || c === '[') depth++;
      else if ((c === ')' || c === ']') && depth > 0) depth--;
      else if (depth === 0 && (c === ' ' || c === '\t' || c === '\n')) break;
      else if (depth === 0 && (s.startsWith('&&', j) || s.startsWith('||', j))) break;
    }
    this.i = j;
    return s.slice(start, j);
  }
}

// ---------- parser ----------

export class Parser {
  constructor(src, { aliases = null, interactive = false } = {}) {
    this.src = src;
    this.lx = new Lexer(src, { interactive });
    this.buf = [];
    this.aliases = aliases;
    this.aliasDepth = 0;
  }

  peek() {
    if (!this.buf.length) this.buf.push(this.lx.next());
    return this.buf[0];
  }
  next() {
    const t = this.peek();
    this.buf.shift();
    return t;
  }
  isWord(t, v) {
    return t.t === 'w' && t.v === v;
  }
  isOp(t, v) {
    return t.t === 'op' && t.v === v;
  }

  unexpected(t) {
    if (t.t === 'eof') return new ParseError('syntax error: unexpected end of file', true);
    const v = t.t === 'nl' ? 'newline' : t.v;
    return new ParseError(`syntax error near unexpected token \`${v}'`);
  }

  expectWord(v) {
    const t = this.next();
    if (!this.isWord(t, v)) {
      if (t.t === 'eof') throw new ParseError(`syntax error: unexpected end of file`, true);
      throw this.unexpected(t);
    }
    this.lastEnd = t.end;
    return t;
  }

  skipNl() {
    while (this.peek().t === 'nl') this.next();
  }

  parseProgram() {
    const list = this.parseList(new Set(), new Set());
    const t = this.peek();
    if (t.t !== 'eof') throw this.unexpected(t);
    return list;
  }

  // a list of and-or commands; stops at a reserved word in stopWords or an op in stopOps
  parseList(stopWords, stopOps) {
    const items = [];
    this.skipNl();
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof') break;
      if (t.t === 'w' && stopWords.has(t.v)) break;
      if (t.t === 'op' && (stopOps.has(t.v) || t.v === ')' || t.v === ';;' || t.v === ';&' || t.v === ';;&')) break;
      const node = this.parseAndOr();
      const s = this.peek();
      let bg = false;
      if (this.isOp(s, ';')) this.next();
      else if (this.isOp(s, '&')) {
        this.next();
        bg = true;
      } else if (s.t === 'nl') this.next();
      else if (!(s.t === 'eof' || (s.t === 'w' && stopWords.has(s.v)) || (s.t === 'op' && (stopOps.has(s.v) || [')', ';;', ';&', ';;&'].includes(s.v)))))
        throw this.unexpected(s);
      items.push({ node, bg });
      this.skipNl();
    }
    return { type: 'list', items };
  }

  parseAndOr() {
    const parts = [this.parsePipeline()];
    const ops = [];
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '&&') || this.isOp(t, '||')) {
        this.next();
        this.skipNl();
        ops.push(t.v);
        parts.push(this.parsePipeline());
      } else break;
    }
    return parts.length === 1 ? parts[0] : { type: 'andor', parts, ops };
  }

  parsePipeline() {
    let bang = false;
    let time = false;
    const start = this.peek().start;
    for (;;) {
      const t = this.peek();
      if (this.isWord(t, '!')) {
        this.next();
        bang = !bang;
      } else if (this.isWord(t, 'time')) {
        this.next();
        time = true;
        if (this.isWord(this.peek(), '-p')) this.next();
      } else break;
    }
    const cmds = [this.parseCommand()];
    const errs = [];
    for (;;) {
      const t = this.peek();
      if (this.isOp(t, '|') || this.isOp(t, '|&')) {
        this.next();
        this.skipNl();
        errs.push(t.v === '|&');
        cmds.push(this.parseCommand());
      } else break;
    }
    const end = this.lastEnd;
    const text = this.src.slice(start, end);
    if (cmds.length === 1 && !bang && !time) {
      cmds[0].text = cmds[0].text || text;
      return cmds[0];
    }
    return { type: 'pipeline', cmds, errs, bang, time, text };
  }

  parseCommand() {
    let t = this.peek();
    let node;
    const start = t.start;
    if (t.t === 'w' && RESERVED.has(t.v)) {
      switch (t.v) {
        case 'if':
          node = this.parseIf();
          break;
        case 'while':
        case 'until':
          node = this.parseWhile();
          break;
        case 'for':
          node = this.parseFor();
          break;
        case 'select':
          node = this.parseFor(true);
          break;
        case 'case':
          node = this.parseCase();
          break;
        case '{':
          this.next();
          node = { type: 'group', body: this.parseList(new Set(['}']), new Set()) };
          this.expectWord('}');
          break;
        case '[[':
          node = this.parseCond();
          break;
        case 'function':
          return this.parseFunction(true);
        case 'coproc':
          this.next();
          return this.parseCommand();
        default:
          throw this.unexpected(t);
      }
    } else if (this.isOp(t, '(')) {
      this.next();
      const body = this.parseList(new Set(), new Set([')']));
      const c = this.next();
      if (!this.isOp(c, ')')) throw c.t === 'eof' ? incomplete(')') : this.unexpected(c);
      this.lastEnd = c.end;
      node = { type: 'subshell', body };
    } else if (this.isOp(t, '((')) {
      this.next();
      if (this.buf.length) throw new ParseError('internal: lookahead before arithmetic');
      const expr = this.lx.readArith();
      this.lastEnd = this.lx.i;
      node = { type: 'arith', expr, line: t.line };
    } else if (t.t === 'w' || t.t === 'io' || (t.t === 'op' && REDIR_OPS.has(t.v))) {
      // function definition: name ( )
      if (t.t === 'w' && /^[^'"$`\\]+$/.test(t.v) && !t.v.includes('=')) {
        this.next();
        const t2 = this.peek();
        if (this.isOp(t2, '(')) {
          this.next();
          const t3 = this.next();
          if (!this.isOp(t3, ')')) throw this.unexpected(t3);
          return this.parseFunctionBody(t.v, start);
        }
        this.buf.unshift(t);
      }
      return this.parseSimple();
    } else throw this.unexpected(t);
    node.redirs = this.parseRedirs();
    node.text = this.src.slice(start, this.lastEnd);
    return node;
  }

  parseFunction() {
    const kw = this.next();
    const name = this.next();
    if (name.t !== 'w') throw this.unexpected(name);
    if (this.isOp(this.peek(), '(')) {
      this.next();
      const c = this.next();
      if (!this.isOp(c, ')')) throw this.unexpected(c);
    } else if (this.isOp(this.peek(), '((')) {
      throw this.unexpected(this.peek());
    }
    return this.parseFunctionBody(name.v, kw.start);
  }

  parseFunctionBody(name, start) {
    this.skipNl();
    const body = this.parseCommand();
    const text = this.src.slice(start, this.lastEnd);
    return { type: 'func', name, body, text, redirs: [] };
  }

  parseRedirs() {
    const redirs = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'io') {
        this.next();
        const op = this.next();
        if (op.t !== 'op' || !REDIR_OPS.has(op.v)) throw this.unexpected(op);
        redirs.push(this.parseRedirTail(t.v, op.v));
      } else if (t.t === 'op' && REDIR_OPS.has(t.v)) {
        this.next();
        redirs.push(this.parseRedirTail(null, t.v));
      } else break;
    }
    return redirs;
  }

  parseRedirTail(fd, op) {
    const w = this.next();
    if (w.t !== 'w' && w.t !== 'io') throw this.unexpected(w);
    this.lastEnd = w.end;
    if (op === '<<' || op === '<<-') {
      const quoted = /['"\\]/.test(w.v);
      const delim = w.v.replace(/\\(.)/g, '$1').replace(/'([^']*)'/g, '$1').replace(/"([^"]*)"/g, '$1').replace(/^\$(['"])/, '$1');
      const hd = { delim, strip: op === '<<-', quoted, body: null, line: w.line };
      this.lx.heredocs.push(hd);
      return { fd, op, heredoc: hd };
    }
    return { fd, op, target: w.v };
  }

  parseSimple() {
    const node = { type: 'simple', assigns: [], words: [], redirs: [], line: this.peek().line };
    const start = this.peek().start;
    this.usedAliases = null;
    for (;;) {
      const t = this.peek();
      if (t.t === 'io') {
        this.next();
        const op = this.next();
        if (op.t !== 'op' || !REDIR_OPS.has(op.v)) throw this.unexpected(op);
        node.redirs.push(this.parseRedirTail(t.v, op.v));
      } else if (t.t === 'op' && REDIR_OPS.has(t.v)) {
        this.next();
        node.redirs.push(this.parseRedirTail(null, t.v));
      } else if (t.t === 'w') {
        if (!node.words.length && ASSIGN_RE.test(t.v)) {
          this.next();
          node.assigns.push(parseAssign(t.v));
          this.lastEnd = t.end;
          continue;
        }
        if (!node.words.length && this.aliases && this.tryAlias(t)) continue;
        this.next();
        node.words.push(t.v);
        this.lastEnd = t.end;
      } else break;
    }
    if (!node.words.length && !node.assigns.length && !node.redirs.length) throw this.unexpected(this.peek());
    node.text = this.src.slice(start, this.lastEnd);
    return node;
  }

  tryAlias(t) {
    if (!/^[^'"\\$`]+$/.test(t.v)) return false;
    const val = this.aliases.get(t.v);
    if (val === undefined) return false;
    this.usedAliases = this.usedAliases || new Set();
    if (this.usedAliases.has(t.v) || this.aliasDepth > 20) return false;
    this.usedAliases.add(t.v);
    this.aliasDepth++;
    this.next();
    const sub = new Lexer(val);
    const toks = [];
    for (;;) {
      const x = sub.next();
      if (x.t === 'eof') break;
      x.start = t.start;
      x.end = t.end;
      toks.push(x);
    }
    this.buf.unshift(...toks);
    if (!toks.length) this.usedAliases.delete(t.v);
    return true;
  }

  parseIf() {
    this.next();
    const clauses = [];
    let els = null;
    const cond = this.parseList(new Set(['then']), new Set());
    this.expectWord('then');
    const body = this.parseList(new Set(['elif', 'else', 'fi']), new Set());
    clauses.push({ cond, body });
    for (;;) {
      const t = this.next();
      if (this.isWord(t, 'fi')) {
        this.lastEnd = t.end;
        break;
      }
      if (this.isWord(t, 'elif')) {
        const c = this.parseList(new Set(['then']), new Set());
        this.expectWord('then');
        const b = this.parseList(new Set(['elif', 'else', 'fi']), new Set());
        clauses.push({ cond: c, body: b });
      } else if (this.isWord(t, 'else')) {
        els = this.parseList(new Set(['fi']), new Set());
      } else throw t.t === 'eof' ? new ParseError('syntax error: unexpected end of file', true) : this.unexpected(t);
    }
    return { type: 'if', clauses, else: els };
  }

  parseDoBody() {
    this.skipNl();
    const t = this.peek();
    if (this.isWord(t, '{')) {
      this.next();
      const body = this.parseList(new Set(['}']), new Set());
      this.expectWord('}');
      return body;
    }
    this.expectWord('do');
    const body = this.parseList(new Set(['done']), new Set());
    this.expectWord('done');
    return body;
  }

  parseWhile() {
    const kw = this.next();
    const cond = this.parseList(new Set(['do']), new Set());
    const body = this.parseDoBody();
    return { type: 'while', until: kw.v === 'until', cond, body };
  }

  parseFor(select = false) {
    this.next();
    const t = this.peek();
    if (!select && this.isOp(t, '((')) {
      this.next();
      if (this.buf.length) throw new ParseError('internal lookahead');
      const raw = this.lx.readArith();
      const parts = splitTopSemis(raw);
      if (parts.length !== 3) throw new ParseError('syntax error: arithmetic expression required');
      if (this.isOp(this.peek(), ';')) this.next();
      const body = this.parseDoBody();
      return { type: 'arfor', init: parts[0], cond: parts[1], step: parts[2], body };
    }
    const name = this.next();
    if (name.t !== 'w') throw this.unexpected(name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name.v)) throw new ParseError(`\`${name.v}': not a valid identifier`);
    let words = null;
    this.skipNl();
    let n = this.peek();
    if (this.isWord(n, 'in')) {
      this.next();
      words = [];
      for (;;) {
        n = this.peek();
        if (n.t === 'w') {
          this.next();
          words.push(n.v);
        } else break;
      }
      if (this.isOp(n, ';') || n.t === 'nl') this.next();
      else if (!(n.t === 'w')) throw this.unexpected(n);
    } else if (this.isOp(n, ';')) this.next();
    const body = this.parseDoBody();
    return { type: select ? 'select' : 'for', name: name.v, words, body };
  }

  parseCase() {
    this.next();
    const w = this.next();
    if (w.t !== 'w') throw this.unexpected(w);
    this.skipNl();
    this.expectWord('in');
    const items = [];
    for (;;) {
      this.skipNl();
      let t = this.next();
      if (this.isWord(t, 'esac')) {
        this.lastEnd = t.end;
        break;
      }
      if (t.t === 'eof') throw new ParseError('syntax error: unexpected end of file', true);
      if (this.isOp(t, '(')) t = this.next();
      const patterns = [];
      for (;;) {
        if (t.t !== 'w') throw this.unexpected(t);
        patterns.push(t.v);
        const s = this.next();
        if (this.isOp(s, '|')) {
          t = this.next();
          continue;
        }
        if (this.isOp(s, ')')) break;
        throw this.unexpected(s);
      }
      const body = this.parseList(new Set(['esac']), new Set([';;', ';&', ';;&']));
      const term = this.peek();
      let tv = ';;';
      if (term.t === 'op' && (term.v === ';;' || term.v === ';&' || term.v === ';;&')) {
        this.next();
        tv = term.v;
      }
      items.push({ patterns, body, term: tv });
    }
    return { type: 'case', word: w.v, items };
  }

  parseCond() {
    this.next(); // [[
    const toks = [];
    for (;;) {
      const t = this.next();
      if (t.t === 'eof') throw incomplete(']]');
      if (this.isWord(t, ']]')) {
        this.lastEnd = t.end;
        break;
      }
      if (t.t === 'nl') continue;
      toks.push(t);
      if (this.isWord(t, '=~')) {
        if (this.buf.length) throw new ParseError('internal lookahead');
        const r = this.lx.readRegex();
        toks.push({ t: 'w', v: r, regex: true });
      }
    }
    let i = 0;
    const peek = () => toks[i];
    const isOp = (t, v) => t && (t.t === 'op' || t.t === 'w') && t.v === v;
    const UN = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-o', '-v', '-R']);
    const BIN = new Set(['==', '=', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);
    const word = () => {
      const t = toks[i++];
      if (!t) throw new ParseError("syntax error in conditional expression: unexpected token `]]'");
      if (t.t === 'op' && t.v !== '<' && t.v !== '>') throw new ParseError(`syntax error in conditional expression: unexpected token \`${t.v}'`);
      return t.v;
    };
    const primary = () => {
      const t = peek();
      if (!t) throw new ParseError("syntax error in conditional expression");
      if (isOp(t, '!')) {
        i++;
        return { op: '!', a: primary() };
      }
      if (t.t === 'op' && t.v === '(') {
        i++;
        const e = or();
        if (!isOp(peek(), ')')) throw new ParseError("syntax error in conditional expression: expected `)'");
        i++;
        return e;
      }
      if (t.t === 'w' && UN.has(t.v) && toks[i + 1] && !BIN.has((toks[i + 1] || {}).v)) {
        i++;
        return { op: t.v, a: word(), unary: true };
      }
      const a = word();
      const n = peek();
      if (n && BIN.has(n.v) && (n.t === 'w' || n.v === '<' || n.v === '>')) {
        i++;
        const b = toks[i++];
        if (!b) throw new ParseError('syntax error in conditional expression');
        return { op: n.v, a, b: b.v, regex: !!b.regex };
      }
      return { op: '-n', a, unary: true, implicit: true };
    };
    const and = () => {
      let l = primary();
      while (isOp(peek(), '&&')) {
        i++;
        l = { op: '&&', a: l, b: primary() };
      }
      return l;
    };
    const or = () => {
      let l = and();
      while (isOp(peek(), '||')) {
        i++;
        l = { op: '||', a: l, b: and() };
      }
      return l;
    };
    const expr = or();
    if (i < toks.length) throw new ParseError(`syntax error in conditional expression: unexpected token \`${toks[i].v}'`);
    return { type: 'cond', expr };
  }
}

function splitTopSemis(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ';' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseAssign(raw) {
  const m = ASSIGN_RE.exec(raw);
  const name = m[1];
  const index = m[2] ? m[2].slice(1, -1) : null;
  const append = m[3] === '+';
  const rest = raw.slice(m[0].length);
  if (rest.startsWith('(') && rest.endsWith(')') && index === null) {
    return { name, index, append, array: splitArrayWords(rest.slice(1, -1)) };
  }
  return { name, index, append, value: rest };
}

export function splitArrayWords(inner) {
  const lx = new Lexer(inner);
  const words = [];
  for (;;) {
    const t = lx.next();
    if (t.t === 'eof') break;
    if (t.t === 'nl') continue;
    if (t.t === 'op') throw new ParseError(`syntax error near unexpected token \`${t.v}'`);
    words.push(t.v);
  }
  return words;
}

export function isAssignWord(w) {
  return ASSIGN_RE.test(w);
}

export function parse(src, opts) {
  const p = new Parser(src, opts);
  const ast = p.parseProgram();
  ast.warnings = p.lx.warnings;
  return ast;
}
