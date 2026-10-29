// An awk interpreter (POSIX awk plus common gawk extensions).

import { posixRegex, splitLines, cToFixed } from '../util.js';
import { StringReader, CollectWriter } from '../streams.js';

class AwkError extends Error {}
class NextEx {}
class NextFileEx {}
class ExitEx {
  constructor(code) {
    this.code = code;
  }
}
class ReturnEx {
  constructor(v) {
    this.v = v;
  }
}
class BreakEx {}
class ContinueEx {}

// strnum: a string from input that may compare numerically
class StrNum {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

const NUMRE = /^\s*[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|0[xX][0-9a-fA-F]+|inf|infinity|nan)\s*$/i;

function looksNumeric(s) {
  return NUMRE.test(s) && !/^\s*[+-]?0[xX]/.test(s) && !/^\s*[+-]?(inf|nan)/i.test(s);
}

function strToNum(s) {
  const m = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s);
  if (m) return parseFloat(m[0]);
  const m2 = /^\s*([+-])?(inf|nan)/i.exec(s);
  if (m2) return m2[2].toLowerCase() === 'nan' ? NaN : m2[1] === '-' ? -Infinity : Infinity;
  return 0;
}

// ---------- lexer ----------

const KEYWORDS = new Set(['BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else', 'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete', 'in', 'getline', 'print', 'printf']);
const BUILTINS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush', 'gensub', 'strftime', 'systime', 'mktime', 'asort', 'asorti', 'and', 'or', 'xor', 'lshift', 'rshift', 'compl', 'typeof', 'isarray', 'patsplit', 'strtonum']);

function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t, v, extra = {}) => toks.push({ t, v, line, ...extra });
  const regexAllowed = () => {
    const p = toks[toks.length - 1];
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'name' || p.t === 'builtin' || p.t === 'funcname' || p.t === 'ere') return false;
    if (p.t === 'op' && (p.v === ')' || p.v === ']' || p.v === '$' || p.v === '++' || p.v === '--')) return false;
    if (p.t === 'kw' && p.v === 'getline') return false;
    return true;
  };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') {
      i += 3;
      line++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      push('nl', '\n');
      line++;
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      push('num', m[0].startsWith('0x') || m[0].startsWith('0X') ? parseInt(m[0], 16) : parseFloat(m[0]));
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const w = m[0];
      i += w.length;
      if (KEYWORDS.has(w)) push('kw', w === 'func' ? 'function' : w);
      else if (BUILTINS.has(w)) push('builtin', w);
      else if (src[i] === '(') push('funcname', w);
      else push('name', w);
      continue;
    }
    if (c === '"') {
      let s = '';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          const d = src[i + 1];
          i += 2;
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' };
          if (d in map) s += map[d];
          else if (d === '\n') {
            line++;
          } else if (/[0-7]/.test(d)) {
            const m = /^[0-7]{1,3}/.exec(src.slice(i - 1));
            s += String.fromCharCode(parseInt(m[0], 8));
            i += m[0].length - 1;
          } else if (d === 'x') {
            const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i));
            if (m) {
              s += String.fromCharCode(parseInt(m[0], 16));
              i += m[0].length;
            } else s += '\\x';
          } else s += '\\' + d;
          continue;
        }
        if (src[i] === '\n') throw new AwkError(`newline in string`);
        s += src[i++];
      }
      if (i >= n) throw new AwkError('unterminated string');
      i++;
      push('str', s);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let s = '';
      i++;
      let inBracket = false;
      while (i < n && (src[i] !== '/' || inBracket)) {
        if (src[i] === '\\' && i + 1 < n) {
          if (src[i + 1] === '/') s += '/';
          else s += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (src[i] === '[' && !inBracket) {
          inBracket = true;
          s += src[i++];
          if (src[i] === '^') s += src[i++];
          if (src[i] === ']') s += src[i++];
          continue;
        }
        if (src[i] === ']' && inBracket) inBracket = false;
        if (src[i] === '\n') throw new AwkError('newline in regex');
        s += src[i++];
      }
      if (i >= n) throw new AwkError('unterminated regexp');
      i++;
      push('ere', s);
      continue;
    }
    const ops = ['**=', '^=', '+=', '-=', '*=', '/=', '%=', '==', '<=', '>=', '!=', '++', '--', '&&', '||', '>>', '!~', '**', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '='];
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new AwkError(`syntax error at source line ${line}: unexpected character '${c}'`);
    i += op.length;
    push('op', op === '**' ? '^' : op === '**=' ? '^=' : op);
  }
  push('eof', null);
  return toks;
}

// ---------- parser ----------

function parse(src) {
  const toks = lex(src);
  let p = 0;
  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const is = (t, v) => {
    const x = toks[p];
    return x.t === t && (v === undefined || x.v === v);
  };
  const isOp = (v) => is('op', v);
  const err = (msg) => {
    const t = toks[p];
    throw new AwkError(`syntax error at source line ${t.line}: ${msg || `unexpected ${t.t === 'eof' ? 'end of program' : `'${t.v}'`}`}`);
  };
  const expect = (t, v) => {
    if (!is(t, v)) err(`expected '${v ?? t}'`);
    return next();
  };
  const optNl = () => {
    while (is('nl')) next();
  };
  const sep = () => {
    let any = false;
    while (is('nl') || isOp(';')) {
      next();
      any = true;
    }
    return any;
  };

  const program = { begin: [], end: [], beginfile: [], endfile: [], rules: [], funcs: new Map() };

  function parseBlock() {
    expect('op', '{');
    const stmts = [];
    sep();
    while (!isOp('}')) {
      if (is('eof')) err('unexpected end of program, missing }');
      stmts.push(statement());
      sep();
    }
    next();
    return { k: 'block', stmts };
  }

  function simpleEnd() {
    if (isOp(';') || is('nl')) {
      next();
      return;
    }
    if (isOp('}') || is('eof')) return;
    err();
  }

  function statement() {
    const t = peek();
    if (t.t === 'op' && t.v === '{') return parseBlock();
    if (t.t === 'op' && t.v === ';') {
      next();
      return { k: 'nop' };
    }
    if (t.t === 'kw') {
      switch (t.v) {
        case 'if': {
          next();
          expect('op', '(');
          const cond = expr();
          expect('op', ')');
          optNl();
          const then = statement();
          // look past newlines/semicolons for else
          const save = p;
          sep();
          if (is('kw', 'else')) {
            next();
            optNl();
            return { k: 'if', cond, then, els: statement() };
          }
          p = save;
          return { k: 'if', cond, then, els: null };
        }
        case 'while': {
          next();
          expect('op', '(');
          const cond = expr();
          expect('op', ')');
          if (isOp(';')) {
            next();
            return { k: 'while', cond, body: { k: 'nop' } };
          }
          optNl();
          return { k: 'while', cond, body: statement() };
        }
        case 'do': {
          next();
          optNl();
          const body = statement();
          sep();
          expect('kw', 'while');
          expect('op', '(');
          const cond = expr();
          expect('op', ')');
          simpleEnd();
          return { k: 'do', cond, body };
        }
        case 'for': {
          next();
          expect('op', '(');
          // for (k in arr)
          if ((is('name') && peek(1).t === 'kw' && peek(1).v === 'in' && peek(2).t === 'name' && peek(3).t === 'op' && peek(3).v === ')') || (isOp('(') && peek(1).t === 'name' && peek(2).t === 'kw' && peek(2).v === 'in')) {
            const paren = isOp('(');
            if (paren) next();
            const v = next().v;
            next();
            const arr = next().v;
            if (paren) expect('op', ')');
            expect('op', ')');
            optNl();
            return { k: 'forin', v, arr, body: statement() };
          }
          const init = isOp(';') ? null : simpleStatementExpr();
          expect('op', ';');
          optNl();
          const cond = isOp(';') ? null : expr();
          expect('op', ';');
          optNl();
          const step = isOp(')') ? null : simpleStatementExpr();
          expect('op', ')');
          if (isOp(';')) {
            next();
            return { k: 'for', init, cond, step, body: { k: 'nop' } };
          }
          optNl();
          return { k: 'for', init, cond, step, body: statement() };
        }
        case 'break':
          next();
          simpleEnd();
          return { k: 'break' };
        case 'continue':
          next();
          simpleEnd();
          return { k: 'continue' };
        case 'next':
          next();
          simpleEnd();
          return { k: 'next' };
        case 'nextfile':
          next();
          simpleEnd();
          return { k: 'nextfile' };
        case 'exit': {
          next();
          let e = null;
          if (!isOp(';') && !is('nl') && !isOp('}') && !is('eof')) e = expr();
          simpleEnd();
          return { k: 'exit', e };
        }
        case 'return': {
          next();
          let e = null;
          if (!isOp(';') && !is('nl') && !isOp('}') && !is('eof')) e = expr();
          simpleEnd();
          return { k: 'return', e };
        }
        case 'delete': {
          next();
          const name = expect('name').v;
          let idx = null;
          if (isOp('[')) {
            next();
            idx = exprList();
            expect('op', ']');
          }
          simpleEnd();
          return { k: 'delete', name, idx };
        }
        case 'print':
        case 'printf': {
          const s = printStmt();
          simpleEnd();
          return s;
        }
      }
    }
    const e = simpleStatementExpr();
    simpleEnd();
    return { k: 'expr', e };
  }

  function simpleStatementExpr() {
    if (is('kw', 'print') || is('kw', 'printf')) return { k: 'stmtexpr', s: printStmt() };
    return expr();
  }

  function printStmt() {
    const kind = next().v;
    let args = [];
    if (!isOp(';') && !is('nl') && !isOp('}') && !isOp('>') && !isOp('>>') && !isOp('|') && !is('eof')) {
      if (isOp('(')) {
        // print (a,b) > "x"  or print (a)(b)
        const save = p;
        next();
        const list = exprList(true);
        if (isOp(')') && (peek(1).t === 'nl' || (peek(1).t === 'op' && [';', '}', '>', '>>', '|'].includes(peek(1).v)) || peek(1).t === 'eof')) {
          next();
          args = list;
        } else {
          p = save;
          args = exprList(false, true);
        }
      } else args = exprList(false, true);
    }
    let dest = null;
    if (isOp('>') || isOp('>>') || isOp('|')) {
      const mode = next().v;
      dest = { mode, e: concatExpr(true) };
    }
    return { k: kind, args, dest };
  }

  function exprList(inParens = false, noGt = false) {
    const list = [expr(noGt && !inParens)];
    while (isOp(',')) {
      next();
      optNl();
      list.push(expr(noGt && !inParens));
    }
    return list;
  }

  // precedence climbing
  function expr(noGt = false) {
    return ternary(noGt);
  }

  function ternary(noGt) {
    const c = orExpr(noGt);
    if (isOp('?')) {
      next();
      optNl();
      const a = ternary(noGt);
      optNl();
      expect('op', ':');
      optNl();
      const b = ternary(noGt);
      return { k: '?:', c, a, b };
    }
    if (is('op') && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(peek().v) && isLvalue(c)) {
      const op = next().v;
      optNl();
      const r = ternary(noGt);
      return { k: 'assign', op, l: c, r };
    }
    return c;
  }

  function isLvalue(e) {
    return e.k === 'var' || e.k === 'index' || e.k === 'field';
  }

  function orExpr(noGt) {
    let l = andExpr(noGt);
    while (isOp('||')) {
      next();
      optNl();
      l = { k: '||', a: l, b: andExpr(noGt) };
    }
    return l;
  }

  function andExpr(noGt) {
    let l = inExpr(noGt);
    while (isOp('&&')) {
      next();
      optNl();
      l = { k: '&&', a: l, b: inExpr(noGt) };
    }
    return l;
  }

  function inExpr(noGt) {
    let l = matchExpr(noGt);
    while (is('kw', 'in')) {
      next();
      const arr = expect('name').v;
      l = { k: 'in', idx: l.k === 'group' ? l.list : [l], arr };
    }
    return l;
  }

  function matchExpr(noGt) {
    let l = relExpr(noGt);
    while (isOp('~') || isOp('!~')) {
      const op = next().v;
      const r = relExpr(noGt);
      l = { k: 'match', neg: op === '!~', a: l, re: r };
    }
    return l;
  }

  function relExpr(noGt) {
    let l = concatExpr(noGt);
    const ops = ['<', '<=', '!=', '==', '>=', '>'];
    if (is('op') && ops.includes(peek().v) && !(noGt && peek().v === '>')) {
      const op = next().v;
      const r = concatExpr(noGt);
      l = { k: 'cmp', op, a: l, b: r };
    }
    return l;
  }

  function startsOperand() {
    const t = peek();
    if (t.t === 'num' || t.t === 'str' || t.t === 'ere' || t.t === 'name' || t.t === 'funcname' || t.t === 'builtin') return true;
    if (t.t === 'op' && ['$', '!', '(', '++', '--', '-', '+'].includes(t.v)) return t.v !== '-' && t.v !== '+';
    if (t.t === 'kw' && t.v === 'getline') return false;
    return false;
  }

  function concatExpr(noGt) {
    let l = additive(noGt);
    while (startsOperand() && !is('kw', 'in')) {
      const r = additive(noGt);
      l = { k: 'concat', a: l, b: r };
    }
    // cmd | getline [var]
    while (isOp('|') && peek(1).t === 'kw' && peek(1).v === 'getline') {
      next();
      next();
      let v = null;
      if (is('name') || isOp('$')) v = primaryLvalue();
      l = { k: 'getline', from: 'cmd', src: l, v };
    }
    return l;
  }

  function additive(noGt) {
    let l = multiplicative(noGt);
    while (isOp('+') || isOp('-')) {
      const op = next().v;
      l = { k: 'bin', op, a: l, b: multiplicative(noGt) };
    }
    return l;
  }

  function multiplicative(noGt) {
    let l = unary(noGt);
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = next().v;
      l = { k: 'bin', op, a: l, b: unary(noGt) };
    }
    return l;
  }

  function unary(noGt) {
    if (isOp('!')) {
      next();
      return { k: 'not', a: unary(noGt) };
    }
    if (isOp('-')) {
      next();
      return { k: 'neg', a: unary(noGt) };
    }
    if (isOp('+')) {
      next();
      return { k: 'pos', a: unary(noGt) };
    }
    return power(noGt);
  }

  function power(noGt) {
    const base = postfix(noGt);
    if (isOp('^')) {
      next();
      // right associative; exponent may have unary minus
      let e;
      if (isOp('-')) {
        next();
        e = { k: 'neg', a: powerOperand(noGt) };
      } else e = powerOperand(noGt);
      return { k: 'bin', op: '^', a: base, b: e };
    }
    return base;
  }

  function powerOperand(noGt) {
    return power(noGt);
  }

  function postfix(noGt) {
    if (isOp('++') || isOp('--')) {
      const op = next().v;
      const lv = primaryLvalue();
      return { k: 'preinc', op, l: lv };
    }
    const e = primary(noGt);
    if ((isOp('++') || isOp('--')) && isLvalue(e)) {
      const op = next().v;
      return { k: 'postinc', op, l: e };
    }
    return e;
  }

  function primaryLvalue() {
    if (isOp('$')) {
      next();
      return { k: 'field', e: fieldOperand() };
    }
    const name = expect('name').v;
    if (isOp('[')) {
      next();
      const idx = exprList();
      expect('op', ']');
      return { k: 'index', name, idx };
    }
    return { k: 'var', name };
  }

  function fieldOperand() {
    if (isOp('++') || isOp('--')) {
      const op = next().v;
      return { k: 'preinc', op, l: primaryLvalue() };
    }
    if (isOp('-')) {
      next();
      return { k: 'neg', a: fieldOperand() };
    }
    return primary(false);
  }

  function primary(noGt) {
    const t = next();
    switch (t.t) {
      case 'num':
        return { k: 'num', v: t.v };
      case 'str':
        return { k: 'str', v: t.v };
      case 'ere':
        return { k: 'regex', v: t.v };
      case 'name':
        if (isOp('[')) {
          next();
          const idx = exprList();
          expect('op', ']');
          return { k: 'index', name: t.v, idx };
        }
        return { k: 'var', name: t.v };
      case 'funcname': {
        expect('op', '(');
        const args = [];
        optNl();
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) {
            next();
            optNl();
            args.push(expr());
          }
        }
        optNl();
        expect('op', ')');
        return { k: 'call', name: t.v, args };
      }
      case 'builtin': {
        const args = [];
        if (isOp('(')) {
          next();
          optNl();
          if (!isOp(')')) {
            args.push(expr());
            while (isOp(',')) {
              next();
              optNl();
              args.push(expr());
            }
          }
          optNl();
          expect('op', ')');
        } else if (t.v !== 'length') err(`builtin ${t.v} requires arguments`);
        return { k: 'builtin', name: t.v, args };
      }
      case 'kw':
        if (t.v === 'getline') {
          let v = null;
          if (is('name') || isOp('$')) v = primaryLvalue();
          if (isOp('<')) {
            next();
            const f = primaryNoConcat();
            return { k: 'getline', from: 'file', src: f, v };
          }
          return { k: 'getline', from: 'main', v };
        }
        break;
      case 'op':
        if (t.v === '$') return { k: 'field', e: fieldOperand() };
        if (t.v === '(') {
          optNl();
          const list = exprList();
          optNl();
          expect('op', ')');
          if (list.length > 1) {
            if (!is('kw', 'in')) err('grouping with commas must be followed by in');
            return { k: 'group', list };
          }
          return { k: 'paren', e: list[0] };
        }
        if (t.v === '-') return { k: 'neg', a: unary(noGt) };
        if (t.v === '+') return { k: 'pos', a: unary(noGt) };
        if (t.v === '!') return { k: 'not', a: unary(noGt) };
        break;
    }
    p--;
    err();
  }

  function primaryNoConcat() {
    // operand of getline < file: a non-concatenated primary
    if (isOp('(')) {
      next();
      const e = expr();
      expect('op', ')');
      return e;
    }
    if (isOp('$')) {
      next();
      return { k: 'field', e: fieldOperand() };
    }
    const t = next();
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'name') {
      if (isOp('[')) {
        next();
        const idx = exprList();
        expect('op', ']');
        return { k: 'index', name: t.v, idx };
      }
      return { k: 'var', name: t.v };
    }
    if (t.t === 'num') return { k: 'num', v: t.v };
    p--;
    err();
  }

  // program items
  sep();
  while (!is('eof')) {
    if (is('kw', 'function')) {
      next();
      const nameTok = next();
      if (nameTok.t !== 'funcname' && nameTok.t !== 'name') err('expected function name');
      expect('op', '(');
      const params = [];
      while (!isOp(')')) {
        params.push(expect('name').v);
        if (isOp(',')) {
          next();
          optNl();
        }
      }
      next();
      optNl();
      const body = parseBlock();
      program.funcs.set(nameTok.v, { params, body });
    } else if (is('kw', 'BEGIN') || is('kw', 'END') || is('kw', 'BEGINFILE') || is('kw', 'ENDFILE')) {
      const k = next().v.toLowerCase();
      optNl();
      program[k].push(parseBlock());
    } else {
      let pattern = null;
      let pattern2 = null;
      if (!isOp('{')) {
        pattern = expr();
        if (isOp(',')) {
          next();
          optNl();
          pattern2 = expr();
        }
      }
      let action = null;
      if (isOp('{')) action = parseBlock();
      program.rules.push({ pattern, pattern2, action, inRange: false });
    }
    sep();
  }
  return program;
}

// ---------- formatting ----------

function fmtNum(n, fmt) {
  if (Number.isInteger(n)) return BigInt(n).toString();
  if (isNaN(n)) return n < 0 || Object.is(n, -NaN) ? '-nan' : 'nan';
  if (!isFinite(n)) return n < 0 ? '-inf' : 'inf';
  return sprintf(fmt, [n]);
}

function sprintf(fmt, args) {
  let ai = 0;
  let out = '';
  const nextArg = () => args[ai++];
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (fmt[i + 1] === '%') {
      out += '%';
      i++;
      continue;
    }
    const m = /^%([-+ 0#']*)(\*|\d+)?(?:\.(\*|\d*))?([hlLqjzt]*)([diouxXeEfFgGcsaA])/.exec(fmt.slice(i));
    if (!m) {
      out += c;
      continue;
    }
    i += m[0].length - 1;
    const flags = m[1];
    let width = m[2] === '*' ? Math.trunc(toNumber(nextArg())) : m[2] ? Number(m[2]) : 0;
    let prec = m[3] === undefined ? undefined : m[3] === '*' ? Math.trunc(toNumber(nextArg())) : Number(m[3] || 0);
    let left = flags.includes('-');
    if (width < 0) {
      left = true;
      width = -width;
    }
    const conv = m[5];
    const arg = nextArg();
    let s;
    const signed = (neg, body) => (neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + body;
    switch (conv) {
      case 'c': {
        if (typeof arg === 'number') s = String.fromCodePoint(Math.trunc(arg) & 0x1fffff || 0);
        else s = toStr(arg ?? '').slice(0, 1) || (arg === undefined ? '' : '');
        if (arg instanceof StrNum && looksNumeric(arg.s)) s = toStr(arg).slice(0, 1);
        break;
      }
      case 's':
        s = arg === undefined ? '' : toOutStr(arg, '%.6g');
        if (prec !== undefined) s = s.slice(0, prec);
        break;
      case 'd':
      case 'i': {
        let v = toNumber(arg ?? 0);
        if (!isFinite(v)) {
          s = signed(v < 0, isNaN(v) ? 'nan' : 'inf');
          break;
        }
        v = Math.trunc(v);
        let body = BigInt(Math.abs(v) < 2 ** 53 ? v : Math.trunc(v)).toString().replace('-', '');
        if (prec !== undefined) body = body.padStart(prec, '0');
        s = signed(v < 0, body);
        if (flags.includes('0') && !left && prec === undefined) {
          const sign = /^[-+ ]/.test(s) ? s[0] : '';
          s = sign + s.slice(sign.length).padStart(width - sign.length, '0');
        }
        break;
      }
      case 'o':
      case 'x':
      case 'X':
      case 'u': {
        let v = Math.trunc(toNumber(arg ?? 0));
        let bv = BigInt(v);
        if (bv < 0n) bv = BigInt.asUintN(64, bv);
        let body = bv.toString(conv === 'o' ? 8 : conv === 'u' ? 10 : 16);
        if (conv === 'X') body = body.toUpperCase();
        if (prec !== undefined) body = body.padStart(prec, '0');
        if (flags.includes('#') && v) body = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + body;
        s = body;
        if (flags.includes('0') && !left && prec === undefined) s = s.padStart(width, '0');
        break;
      }
      default: {
        const v = toNumber(arg ?? 0);
        const p = prec === undefined ? 6 : prec;
        let body;
        const av = Math.abs(v);
        if (isNaN(v)) body = 'nan';
        else if (!isFinite(v)) body = 'inf';
        else if (conv === 'f' || conv === 'F') body = cToFixed(av, p);
        else if (conv === 'e' || conv === 'E') body = av.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2');
        else if (conv === 'a' || conv === 'A') body = av.toString(16);
        else {
          const P = p === 0 ? 1 : p;
          if (av === 0) body = flags.includes('#') ? (0).toFixed(P - 1) : '0';
          else {
            const e = Number(av.toExponential(P - 1).split('e')[1]);
            if (e < -4 || e >= P) {
              body = av.toExponential(P - 1);
              if (!flags.includes('#')) body = body.replace(/\.?0+e/, 'e');
              body = body.replace(/e([+-])(\d)$/, 'e$10$2');
            } else {
              body = av.toFixed(Math.max(0, P - 1 - e));
              if (!flags.includes('#') && body.includes('.')) body = body.replace(/\.?0+$/, '');
            }
          }
        }
        if (conv === 'E' || conv === 'G' || conv === 'F' || conv === 'A') body = body.toUpperCase();
        s = signed(v < 0 || Object.is(v, -0), body);
        if (flags.includes('0') && !left && isFinite(v) && s.length < width) {
          const sign = /^[-+ ]/.test(s) ? s[0] : '';
          s = sign + s.slice(sign.length).padStart(width - sign.length, '0');
        }
      }
    }
    if (s.length < width) s = left ? s.padEnd(width) : s.padStart(width);
    out += s;
  }
  return out;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v instanceof StrNum) return strToNum(v.s);
  if (v === undefined || v === null) return 0;
  return strToNum(String(v));
}

let CONVFMT = '%.6g';
function toStr(v) {
  if (typeof v === 'number') return fmtNum(v, CONVFMT);
  if (v instanceof StrNum) return v.s;
  if (v === undefined || v === null) return '';
  return String(v);
}

function toOutStr(v, ofmt) {
  if (typeof v === 'number') return fmtNum(v, ofmt);
  return toStr(v);
}

function toBool(v) {
  if (typeof v === 'number') return v !== 0;
  if (v instanceof StrNum) return looksNumeric(v.s) ? strToNum(v.s) !== 0 : v.s !== '';
  return v !== '' && v !== undefined && v !== null;
}

function compare(a, b) {
  const an = typeof a === 'number' || (a instanceof StrNum && looksNumeric(a.s)) || a === undefined;
  const bn = typeof b === 'number' || (b instanceof StrNum && looksNumeric(b.s)) || b === undefined;
  if (an && bn) {
    const x = toNumber(a);
    const y = toNumber(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toStr(a);
  const y = toStr(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------- interpreter ----------

class Interp {
  constructor(prog, ctx) {
    this.prog = prog;
    this.ctx = ctx;
    this.globals = new Map();
    this.arrays = new Map();
    this.fields = [''];
    this.nf = 0;
    this.record = '';
    this.regexCache = new Map();
    this.outputs = new Map();
    this.fileReaders = new Map();
    this.cmdReaders = new Map();
    this.frames = [];
    this.prevSeed = 0;
    this.rng = mulberry(0);
    this.steps = 0;
    this.out = [];
    const env = new Map();
    for (const [k, v] of Object.entries(ctx.env)) env.set(k, new StrNum(v));
    this.arrays.set('ENVIRON', env);
    this.setVar('FS', ' ');
    this.setVar('OFS', ' ');
    this.setVar('ORS', '\n');
    this.setVar('RS', '\n');
    this.setVar('NR', 0);
    this.setVar('FNR', 0);
    this.setVar('SUBSEP', '\x1c');
    this.setVar('CONVFMT', '%.6g');
    this.setVar('OFMT', '%.6g');
    this.setVar('RSTART', 0);
    this.setVar('RLENGTH', -1);
    this.setVar('FILENAME', '');
    this.setVar('RT', '');
  }

  frame() {
    return this.frames[this.frames.length - 1];
  }

  getVar(name) {
    if (name === 'NF') return this.nf;
    const f = this.frame();
    if (f && f.has(name)) return f.get(name).v;
    return this.globals.get(name);
  }

  setVar(name, v) {
    const f = this.frame();
    if (f && f.has(name)) {
      const slot = f.get(name);
      if (slot.arr) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
      slot.v = v;
      return;
    }
    if (this.arrays.has(name)) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
    if (name === 'NF') {
      this.setNF(Math.trunc(toNumber(v)));
      return;
    }
    if (name === 'CONVFMT') CONVFMT = toStr(v);
    this.globals.set(name, v);
  }

  isArrayName(name) {
    const f = this.frame();
    if (f && f.has(name)) return !!f.get(name).arr;
    return this.arrays.has(name);
  }

  getArray(name) {
    const f = this.frame();
    if (f && f.has(name)) {
      const slot = f.get(name);
      if (!slot.arr) {
        if (slot.v !== undefined) throw new AwkError(`attempt to use scalar parameter \`${name}' as an array`);
        slot.arr = new Map();
        if (slot.ref) slot.ref(slot.arr);
      }
      return slot.arr;
    }
    let a = this.arrays.get(name);
    if (!a) {
      if (this.globals.get(name) !== undefined) throw new AwkError(`attempt to use scalar \`${name}' as an array`);
      a = new Map();
      this.arrays.set(name, a);
      this.globals.delete(name);
    }
    return a;
  }

  regex(src) {
    let r = this.regexCache.get(src);
    if (!r) {
      try {
        r = posixRegex(src, { extended: true });
      } catch {
        throw new AwkError(`invalid regular expression: /${src}/`);
      }
      if (this.regexCache.size > 500) this.regexCache.clear();
      this.regexCache.set(src, r);
    }
    r.lastIndex = 0;
    return r;
  }

  async toRegex(e) {
    if (e.k === 'regex') return this.regex(e.v);
    return this.regex(toStr(await this.eval(e)));
  }

  // ----- fields -----
  setRecord(s) {
    this.record = s;
    this.splitRecord();
  }

  splitRecord() {
    const fs = toStr(this.getVar('FS'));
    const parts = this.splitWith(this.record, fs, toStr(this.getVar('RS')) === '');
    this.fields = ['', ...parts.map((x) => new StrNum(x))];
    this.nf = parts.length;
  }

  splitWith(s, fs, paragraph = false) {
    if (s === '') return [];
    if (fs === ' ') return s.trim() === '' ? [] : s.replace(/^[ \t\n]+|[ \t\n]+$/g, '').split(/[ \t\n]+/);
    if (fs === '') return [...s];
    let re;
    if (fs.length === 1 && fs !== '\\') {
      if (!paragraph) return s.split(fs);
      re = new RegExp(`[${fs.replace(/[\]\\^-]/g, '\\$&')}\\n]`);
    } else {
      const r = this.regex(fs);
      re = new RegExp(r.source + (paragraph ? '|\\n' : ''), r.flags.replace('g', ''));
    }
    const out = [];
    let last = 0;
    const g = new RegExp(re.source, re.flags + 'g');
    let m;
    while ((m = g.exec(s))) {
      if (m[0] === '') {
        g.lastIndex++;
        if (g.lastIndex > s.length) break;
        continue;
      }
      out.push(s.slice(last, m.index));
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  }

  getField(i) {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) return new StrNum(this.record);
    return this.fields[i] ?? new StrNum('');
  }

  rebuild() {
    const ofs = toStr(this.getVar('OFS'));
    const parts = [];
    for (let i = 1; i <= this.nf; i++) parts.push(toStr(this.fields[i] ?? ''));
    this.record = parts.join(ofs);
  }

  setField(i, v) {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) {
      this.setRecord(toStr(v));
      return;
    }
    while (this.fields.length <= i) this.fields.push(new StrNum(''));
    this.fields[i] = v;
    if (i > this.nf) this.nf = i;
    this.rebuild();
  }

  setNF(n) {
    if (n < 0) n = 0;
    while (this.fields.length <= n) this.fields.push(new StrNum(''));
    this.fields.length = n + 1;
    this.nf = n;
    this.rebuild();
  }

  // ----- evaluation -----
  async lvalue(e) {
    if (e.k === 'var') return { get: () => this.getVar(e.name), set: (v) => this.setVar(e.name, v) };
    if (e.k === 'field') {
      const i = Math.trunc(toNumber(await this.eval(e.e)));
      return { get: () => this.getField(i), set: (v) => this.setField(i, v) };
    }
    if (e.k === 'index') {
      const arr = this.getArray(e.name);
      const key = await this.key(e.idx);
      return { get: () => arr.get(key), set: (v) => arr.set(key, v) };
    }
    if (e.k === 'paren') return this.lvalue(e.e);
    throw new AwkError('invalid assignment target');
  }

  async key(idx) {
    if (idx.length === 1) return toStr(await this.eval(idx[0]));
    const parts = [];
    for (const x of idx) parts.push(toStr(await this.eval(x)));
    return parts.join(toStr(this.getVar('SUBSEP')));
  }

  async eval(e) {
    switch (e.k) {
      case 'num':
      case 'str':
        return e.v;
      case 'regex':
        return this.regex(e.v).test(this.record) ? 1 : 0;
      case 'var': {
        if (this.isArrayName(e.name)) throw new AwkError(`attempt to use array \`${e.name}' in a scalar context`);
        return this.getVar(e.name);
      }
      case 'field':
        return this.getField(Math.trunc(toNumber(await this.eval(e.e))));
      case 'index': {
        const arr = this.getArray(e.name);
        const k = await this.key(e.idx);
        if (!arr.has(k)) arr.set(k, undefined);
        return arr.get(k);
      }
      case 'paren':
        return this.eval(e.e);
      case 'group':
        return this.key(e.list);
      case 'assign': {
        const lv = await this.lvalue(e.l);
        let v = await this.eval(e.r);
        if (e.op !== '=') v = this.arith(e.op[0], toNumber(lv.get()), toNumber(v));
        lv.set(v);
        return v;
      }
      case '?:':
        return toBool(await this.eval(e.c)) ? this.eval(e.a) : this.eval(e.b);
      case '||':
        return toBool(await this.eval(e.a)) || toBool(await this.eval(e.b)) ? 1 : 0;
      case '&&':
        return toBool(await this.eval(e.a)) && toBool(await this.eval(e.b)) ? 1 : 0;
      case 'in':
        return this.getArray(e.arr).has(await this.key(e.idx)) ? 1 : 0;
      case 'match': {
        const s = toStr(await this.eval(e.a));
        const m = (await this.toRegex(e.re)).test(s);
        return (e.neg ? !m : m) ? 1 : 0;
      }
      case 'cmp': {
        const c = compare(await this.eval(e.a), await this.eval(e.b));
        return { '<': c < 0, '<=': c <= 0, '!=': c !== 0, '==': c === 0, '>=': c >= 0, '>': c > 0 }[e.op] ? 1 : 0;
      }
      case 'concat':
        return toStr(await this.eval(e.a)) + toStr(await this.eval(e.b));
      case 'bin':
        return this.arith(e.op, toNumber(await this.eval(e.a)), toNumber(await this.eval(e.b)));
      case 'not':
        return toBool(await this.eval(e.a)) ? 0 : 1;
      case 'neg':
        return -toNumber(await this.eval(e.a));
      case 'pos':
        return toNumber(await this.eval(e.a));
      case 'preinc': {
        const lv = await this.lvalue(e.l);
        const v = toNumber(lv.get()) + (e.op === '++' ? 1 : -1);
        lv.set(v);
        return v;
      }
      case 'postinc': {
        const lv = await this.lvalue(e.l);
        const old = toNumber(lv.get());
        lv.set(old + (e.op === '++' ? 1 : -1));
        return old;
      }
      case 'call':
        return this.callUser(e);
      case 'builtin':
        return this.builtin(e);
      case 'getline':
        return this.getline(e);
      case 'stmtexpr':
        await this.doPrint(e.s);
        return 1;
    }
    throw new AwkError('bad expression ' + e.k);
  }

  arith(op, a, b) {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        if (b === 0) throw new AwkError('division by zero attempted');
        return a / b;
      case '%':
        if (b === 0) throw new AwkError('division by zero attempted in `%\'');
        return a % b;
      case '^':
        return a ** b;
    }
    return 0;
  }

  async callUser(e) {
    const f = this.prog.funcs.get(e.name);
    if (!f) throw new AwkError(`function \`${e.name}' not defined`);
    if (e.args.length > f.params.length) throw new AwkError(`function \`${e.name}' called with more arguments than declared`);
    const frame = new Map();
    for (let i = 0; i < f.params.length; i++) {
      const p = f.params[i];
      const a = e.args[i];
      if (a === undefined) {
        frame.set(p, { v: undefined });
        continue;
      }
      if (a.k === 'var') {
        const cf = this.frame();
        if (cf && cf.has(a.name)) {
          const slot = cf.get(a.name);
          if (slot.arr) {
            frame.set(p, { arr: slot.arr });
            continue;
          }
          if (slot.v === undefined) {
            frame.set(p, {
              v: undefined,
              ref: (arr) => {
                slot.arr = arr;
              },
            });
            continue;
          }
        } else if (this.arrays.has(a.name)) {
          frame.set(p, { arr: this.arrays.get(a.name) });
          continue;
        } else if (this.globals.get(a.name) === undefined) {
          frame.set(p, {
            v: undefined,
            ref: (arr) => {
              this.arrays.set(a.name, arr);
              this.globals.delete(a.name);
            },
          });
          continue;
        }
      }
      frame.set(p, { v: await this.eval(a) });
    }
    if (this.frames.length > 1000) throw new AwkError('function call nesting too deep');
    this.frames.push(frame);
    try {
      await this.exec(f.body);
      return '';
    } catch (ex) {
      if (ex instanceof ReturnEx) return ex.v;
      throw ex;
    } finally {
      this.frames.pop();
    }
  }

  async builtin(e) {
    const a = e.args;
    const S = async (i) => toStr(await this.eval(a[i]));
    const N = async (i) => toNumber(await this.eval(a[i]));
    switch (e.name) {
      case 'length': {
        if (!a.length) return [...this.record].length;
        if (a[0].k === 'var' && this.isArrayName(a[0].name)) return this.getArray(a[0].name).size;
        return [...(await S(0))].length;
      }
      case 'substr': {
        const s = [...(await S(0))];
        let m = await N(1);
        m = isNaN(m) ? 1 : Math.round(m);
        let n = a.length > 2 ? await N(2) : Infinity;
        if (isNaN(n)) n = 0;
        else if (n !== Infinity) n = Math.round(n);
        // gawk: a start below 1 is treated as 1, keeping the length
        let start = m < 1 ? 1 : m;
        let end = n === Infinity ? s.length + 1 : start + n;
        if (end > s.length + 1) end = s.length + 1;
        if (end <= start) return '';
        return s.slice(start - 1, end - 1).join('');
      }
      case 'index': {
        const s = await S(0);
        const t = await S(1);
        const i = s.indexOf(t);
        return i < 0 ? 0 : [...s.slice(0, i)].length + 1;
      }
      case 'split': {
        const s = await S(0);
        let parts;
        if (a.length < 3) parts = this.splitWith(s, toStr(this.getVar('FS')));
        else if (a[2].k === 'regex') parts = this.splitWith(s, a[2].v.length === 1 ? '[' + a[2].v + ']' : a[2].v);
        else parts = this.splitWith(s, await S(2));
        const arr = this.getArray(a[1].name);
        arr.clear();
        parts.forEach((p, i) => arr.set(String(i + 1), new StrNum(p)));
        return parts.length;
      }
      case 'sub':
      case 'gsub': {
        const re = await this.toRegex(a[0]);
        const rep = await S(1);
        const target = a[2] || { k: 'field', e: { k: 'num', v: 0 } };
        const lv = await this.lvalue(target);
        const s = toStr(lv.get());
        const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
        let count = 0;
        let out = '';
        let last = 0;
        let m;
        while ((m = g.exec(s))) {
          count++;
          out += s.slice(last, m.index) + this.subRepl(rep, m[0]);
          last = m.index + m[0].length;
          if (m[0] === '') {
            if (m.index < s.length) out += s[m.index];
            last = m.index + 1;
            g.lastIndex = m.index + 1;
            if (m.index >= s.length) break;
          }
          if (e.name === 'sub') break;
        }
        if (count) lv.set(out + s.slice(last));
        return count;
      }
      case 'gensub': {
        const re = await this.toRegex(a[0]);
        const rep = await S(1);
        const how = await S(2);
        const s = a[3] ? await S(3) : this.record;
        const g = new RegExp(re.source, re.flags.replace('g', '') + 'g');
        const nth = /^[gG]/.test(how) ? 0 : Math.max(1, Math.trunc(toNumber(how)));
        let count = 0;
        let out = '';
        let last = 0;
        let m;
        while ((m = g.exec(s))) {
          count++;
          if (nth === 0 || count === nth) {
            out += s.slice(last, m.index) + rep.replace(/\\(\d)|\\&|&/g, (x, d) => (x === '&' ? m[0] : x === '\\&' ? '&' : m[Number(d)] ?? ''));
            last = m.index + m[0].length;
          }
          if (m[0] === '') g.lastIndex++;
          if (nth && count >= nth) break;
          if (g.lastIndex > s.length) break;
        }
        return out + s.slice(last);
      }
      case 'match': {
        const s = await S(0);
        const re = await this.toRegex(a[1]);
        const m = new RegExp(re.source, re.flags.replace('g', '')).exec(s);
        if (a[2]) {
          const arr = this.getArray(a[2].name);
          arr.clear();
          if (m) m.forEach((x, i) => x !== undefined && arr.set(String(i), new StrNum(x)));
        }
        if (!m) {
          this.setVar('RSTART', 0);
          this.setVar('RLENGTH', -1);
          return 0;
        }
        const start = [...s.slice(0, m.index)].length + 1;
        this.setVar('RSTART', start);
        this.setVar('RLENGTH', [...m[0]].length);
        return start;
      }
      case 'sprintf': {
        if (!a.length) return '';
        const vals = [];
        for (const x of a.slice(1)) vals.push(await this.eval(x));
        return sprintf(await S(0), vals);
      }
      case 'sin':
        return Math.sin(await N(0));
      case 'cos':
        return Math.cos(await N(0));
      case 'atan2':
        return Math.atan2(await N(0), await N(1));
      case 'exp':
        return Math.exp(await N(0));
      case 'log':
        return Math.log(await N(0));
      case 'sqrt':
        return Math.sqrt(await N(0));
      case 'int':
        return Math.trunc(await N(0));
      case 'rand':
        return this.rng();
      case 'srand': {
        const prev = this.prevSeed;
        const seed = a.length ? await N(0) : Math.floor(Date.now() / 1000);
        this.prevSeed = seed;
        this.rng = mulberry(seed);
        return prev;
      }
      case 'tolower':
        return (await S(0)).toLowerCase();
      case 'toupper':
        return (await S(0)).toUpperCase();
      case 'system': {
        const cmdline = await S(0);
        await this.flush();
        const st = await this.ctx.shell.runCommand(['sh', '-c', cmdline], { ...this.ctx.io }, {});
        return st;
      }
      case 'close': {
        const name = await S(0);
        const o = this.outputs.get(name);
        if (o) {
          this.outputs.delete(name);
          if (o.kind === 'pipe') {
            await this.flush();
            return this.runPipe(o);
          }
          return 0;
        }
        if (this.fileReaders.delete(name) || this.cmdReaders.delete(name)) return 0;
        return -1;
      }
      case 'fflush':
        await this.flush();
        return 0;
      case 'systime':
        return Math.floor(Date.now() / 1000);
      case 'mktime': {
        const p = (await S(0)).trim().split(/\s+/).map(Number);
        if (p.length < 6) return -1;
        return Math.floor(new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5]).getTime() / 1000);
      }
      case 'strftime': {
        const fmt = a.length ? await S(0) : '%a %b %e %H:%M:%S %Z %Y';
        const t = a.length > 1 ? (await N(1)) * 1000 : Date.now();
        const utc = a.length > 2 ? toBool(await this.eval(a[2])) : false;
        return this.ctx.shell.commands.get('date').format(new Date(t), fmt, utc);
      }
      case 'asort':
      case 'asorti': {
        const src = this.getArray(a[0].name);
        const vals = e.name === 'asort' ? [...src.values()] : [...src.keys()];
        vals.sort((x, y) => compare(x, y));
        const dest = a[1] ? this.getArray(a[1].name) : src;
        dest.clear();
        vals.forEach((v, i) => dest.set(String(i + 1), v));
        return vals.length;
      }
      case 'and':
        return Number(BigInt(Math.trunc(await N(0))) & BigInt(Math.trunc(await N(1))));
      case 'or':
        return Number(BigInt(Math.trunc(await N(0))) | BigInt(Math.trunc(await N(1))));
      case 'xor':
        return Number(BigInt(Math.trunc(await N(0))) ^ BigInt(Math.trunc(await N(1))));
      case 'lshift':
        return Number(BigInt(Math.trunc(await N(0))) << BigInt(Math.trunc(await N(1))));
      case 'rshift':
        return Number(BigInt(Math.trunc(await N(0))) >> BigInt(Math.trunc(await N(1))));
      case 'compl':
        return Number(BigInt.asUintN(53, ~BigInt(Math.trunc(await N(0)))));
      case 'strtonum': {
        const s = (await S(0)).trim();
        if (/^0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
        if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
        return strToNum(s);
      }
      case 'typeof': {
        if (a[0].k === 'var' && this.isArrayName(a[0].name)) return 'array';
        const v = await this.eval(a[0]);
        if (v === undefined) return 'unassigned';
        if (typeof v === 'number') return 'number';
        if (v instanceof StrNum) return looksNumeric(v.s) ? 'strnum' : 'string';
        return 'string';
      }
      case 'isarray':
        return a[0].k === 'var' && this.isArrayName(a[0].name) ? 1 : 0;
      case 'patsplit': {
        const s = await S(0);
        const arr = this.getArray(a[1].name);
        arr.clear();
        const re = a[2] ? await this.toRegex(a[2]) : this.regex('[^ \t\n]+');
        let i = 0;
        for (const m of s.matchAll(new RegExp(re.source, 'g'))) arr.set(String(++i), new StrNum(m[0]));
        return i;
      }
    }
    throw new AwkError(`unknown function ${e.name}`);
  }

  subRepl(rep, matched) {
    let out = '';
    for (let i = 0; i < rep.length; i++) {
      const c = rep[i];
      if (c === '\\' && rep[i + 1] === '&') {
        out += '&';
        i++;
      } else if (c === '\\' && rep[i + 1] === '\\') {
        out += '\\';
        i++;
      } else if (c === '&') out += matched;
      else out += c;
    }
    return out;
  }

  async getline(e) {
    let rec;
    let fromMain = false;
    if (e.from === 'main') {
      rec = await this.mainGetline();
      fromMain = true;
    } else {
      const name = toStr(await this.eval(e.src));
      if (e.from === 'file') {
        let r = this.fileReaders.get(name);
        if (!r) {
          try {
            r = name === '-' || name === '/dev/stdin' ? this.ctx.stdin : new StringReader(this.ctx.vfs.readFile(name, this.ctx.cwd));
          } catch {
            return -1;
          }
          this.fileReaders.set(name, r);
        }
        rec = await this.readRecord(r);
      } else {
        let r = this.cmdReaders.get(name);
        if (!r) {
          await this.flush();
          const w = new CollectWriter();
          await this.ctx.shell.runCommand(['sh', '-c', name], { ...this.ctx.io, 1: w }, {});
          r = new StringReader(w.text);
          this.cmdReaders.set(name, r);
        }
        rec = await this.readRecord(r);
        if (rec !== null) this.setVar('NR', toNumber(this.getVar('NR')) + 1);
      }
    }
    if (rec === null) return 0;
    if (e.v) (await this.lvalue(e.v)).set(new StrNum(rec));
    else {
      this.setRecord(rec);
    }
    void fromMain;
    return 1;
  }

  async exec(s) {
    switch (s.k) {
      case 'block':
        for (const x of s.stmts) await this.exec(x);
        return;
      case 'nop':
        return;
      case 'expr':
        await this.eval(s.e);
        return;
      case 'print':
      case 'printf':
        await this.doPrint(s);
        return;
      case 'if':
        if (toBool(await this.eval(s.cond))) await this.exec(s.then);
        else if (s.els) await this.exec(s.els);
        return;
      case 'while':
        while (toBool(await this.eval(s.cond))) {
          await this.step();
          try {
            await this.exec(s.body);
          } catch (ex) {
            if (ex instanceof BreakEx) break;
            if (ex instanceof ContinueEx) continue;
            throw ex;
          }
        }
        return;
      case 'do':
        do {
          await this.step();
          try {
            await this.exec(s.body);
          } catch (ex) {
            if (ex instanceof BreakEx) break;
            if (ex instanceof ContinueEx) continue;
            throw ex;
          }
        } while (toBool(await this.eval(s.cond)));
        return;
      case 'for':
        if (s.init) await this.eval(s.init);
        while (!s.cond || toBool(await this.eval(s.cond))) {
          await this.step();
          try {
            await this.exec(s.body);
          } catch (ex) {
            if (ex instanceof BreakEx) break;
            if (!(ex instanceof ContinueEx)) throw ex;
          }
          if (s.step) await this.eval(s.step);
        }
        return;
      case 'forin': {
        const arr = this.getArray(s.arr);
        for (const k of [...arr.keys()]) {
          if (!arr.has(k)) continue;
          await this.step();
          (await this.lvalue({ k: 'var', name: s.v })).set(new StrNum(k));
          try {
            await this.exec(s.body);
          } catch (ex) {
            if (ex instanceof BreakEx) break;
            if (ex instanceof ContinueEx) continue;
            throw ex;
          }
        }
        return;
      }
      case 'break':
        throw new BreakEx();
      case 'continue':
        throw new ContinueEx();
      case 'next':
        throw new NextEx();
      case 'nextfile':
        throw new NextFileEx();
      case 'exit':
        throw new ExitEx(s.e ? Math.trunc(toNumber(await this.eval(s.e))) : null);
      case 'return':
        throw new ReturnEx(s.e ? await this.eval(s.e) : '');
      case 'delete': {
        const arr = this.getArray(s.name);
        if (s.idx) arr.delete(await this.key(s.idx));
        else arr.clear();
        return;
      }
    }
    throw new AwkError('bad statement ' + s.k);
  }

  async step() {
    this.steps++;
    if ((this.steps & 0x3ff) === 0) await this.ctx.tick();
  }

  async doPrint(s) {
    let text;
    if (s.k === 'print') {
      const ofmt = toStr(this.getVar('OFMT'));
      if (!s.args.length) text = this.record;
      else {
        const parts = [];
        for (const x of s.args) parts.push(toOutStr(await this.eval(x), ofmt));
        text = parts.join(toStr(this.getVar('OFS')));
      }
      text += toStr(this.getVar('ORS'));
    } else {
      if (!s.args.length) throw new AwkError('printf: no format');
      const vals = [];
      for (const x of s.args.slice(1)) vals.push(await this.eval(x));
      text = sprintf(toStr(await this.eval(s.args[0])), vals);
    }
    if (!s.dest) {
      this.out.push(text);
      if (this.out.length > 256) await this.flush();
      return;
    }
    const name = toStr(await this.eval(s.dest.e));
    let o = this.outputs.get(name);
    if (!o) {
      if (s.dest.mode === '|') o = { kind: 'pipe', cmd: name, buf: [] };
      else if (name === '/dev/stdout' || name === '-') o = { kind: 'stdout' };
      else if (name === '/dev/stderr') o = { kind: 'stderr' };
      else {
        o = { kind: 'file', name };
        try {
          this.ctx.vfs.writeFile(name, this.ctx.cwd, '', { append: s.dest.mode === '>>', umask: this.ctx.shell.umask });
          if (s.dest.mode === '>') this.ctx.vfs.writeFile(name, this.ctx.cwd, '', { umask: this.ctx.shell.umask });
        } catch (e) {
          throw new AwkError(`can't redirect to \`${name}' (${e.message})`);
        }
      }
      this.outputs.set(name, o);
    }
    if (o.kind === 'pipe') o.buf.push(text);
    else if (o.kind === 'stdout') this.out.push(text);
    else if (o.kind === 'stderr') {
      await this.flush();
      await this.ctx.err(text);
    } else this.ctx.vfs.writeFile(name, this.ctx.cwd, text, { append: true });
  }

  async flush() {
    if (this.out.length) {
      const s = this.out.join('');
      this.out = [];
      await this.ctx.out(s);
    }
  }

  runPipe(o) {
    const input = o.buf.join('');
    o.buf = [];
    return this.ctx.shell.runCommand(['sh', '-c', o.cmd], { ...this.ctx.io, 0: new StringReader(input) }, {});
  }

  // ----- input -----
  async readRecord(reader) {
    const rs = toStr(this.getVar('RS'));
    if (rs === '\n') {
      const r = await reader.readLineRaw();
      if (!r) return null;
      this.setVar('RT', r.nl ? '\n' : '');
      return r.line;
    }
    if (rs === '') {
      const lines = [];
      for (;;) {
        const r = await reader.readLineRaw();
        if (!r) break;
        if (r.line === '') {
          if (lines.length) break;
          continue;
        }
        lines.push(r.line);
      }
      if (!lines.length) return null;
      return lines.join('\n');
    }
    if (rs.length === 1) {
      const r = await reader.readUntil(rs);
      if (!r) return null;
      this.setVar('RT', r.nl ? rs : '');
      return r.line;
    }
    if (!reader.__rsParts) {
      const all = await reader.readAll();
      const re = new RegExp(this.regex(rs).source, 'g');
      const parts = [];
      let last = 0;
      let m;
      while ((m = re.exec(all))) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        parts.push([all.slice(last, m.index), m[0]]);
        last = m.index + m[0].length;
      }
      if (last < all.length) parts.push([all.slice(last), '']);
      reader.__rsParts = parts;
    }
    const p = reader.__rsParts.shift();
    if (!p) return null;
    this.setVar('RT', p[1]);
    return p[0];
  }
}

function mulberry(seed) {
  let a = Math.floor(seed * 1000003) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function runAwk(ctx, programText, operands, assigns, fs) {
  let prog;
  try {
    prog = parse(programText);
  } catch (e) {
    if (e instanceof AwkError) {
      await ctx.err(`awk: cmd. line:1: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  CONVFMT = '%.6g';
  const it = new Interp(prog, ctx);
  if (fs !== null) it.setVar('FS', fs);
  for (const [k, v] of assigns) it.setVar(k, new StrNum(v));
  const argv = it.getArray('ARGV');
  argv.set('0', 'awk');
  operands.forEach((o, i) => argv.set(String(i + 1), new StrNum(o)));
  it.setVar('ARGC', operands.length + 1);

  let operandIdx = 1;
  let curReader = null;
  let usedInput = false;
  let hadError = false;
  const nextReader = async () => {
    const argc = Math.trunc(toNumber(it.getVar('ARGC')));
    while (operandIdx < argc) {
      const v = argv.get(String(operandIdx++));
      const a = v === undefined ? '' : toStr(v);
      if (a === '') continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a);
      if (m) {
        it.setVar(m[1], new StrNum(processEscapes(m[2])));
        continue;
      }
      usedInput = true;
      it.setVar('FILENAME', a);
      it.setVar('FNR', 0);
      if (a === '-' || a === '/dev/stdin') return ctx.stdin;
      try {
        const node = ctx.vfs.stat(a, ctx.cwd);
        if (node.type === 'dir') {
          await ctx.err(`awk: warning: command line argument \`${a}' is a directory: skipped\n`);
          continue;
        }
        return new StringReader(ctx.vfs.readFile(a, ctx.cwd));
      } catch (e) {
        await ctx.err(`awk: fatal: cannot open file \`${a}' for reading: ${e.message}\n`);
        hadError = true;
        return null;
      }
    }
    if (!usedInput) {
      usedInput = true;
      return ctx.stdin;
    }
    return null;
  };
  it.mainGetline = async () => {
    for (;;) {
      if (!curReader) {
        curReader = await nextReader();
        if (!curReader) return null;
      }
      const rec = await it.readRecord(curReader);
      if (rec !== null) {
        it.setVar('NR', toNumber(it.getVar('NR')) + 1);
        it.setVar('FNR', toNumber(it.getVar('FNR')) + 1);
        return rec;
      }
      curReader = null;
    }
  };

  let exitCode = 0;
  let exiting = false;
  try {
    try {
      for (const b of prog.begin) await it.exec(b);
    } catch (ex) {
      if (ex instanceof ExitEx) {
        exiting = true;
        if (ex.code !== null) exitCode = ex.code;
      } else throw ex;
    }
    if (!exiting && (prog.rules.length || prog.end.length)) {
      for (;;) {
        const rec = await it.mainGetline();
        if (rec === null) break;
        it.setRecord(rec);
        try {
          for (const r of prog.rules) {
            let matched;
            if (r.pattern2) {
              if (r.inRange) {
                matched = true;
                if (toBool(await it.eval(r.pattern2))) r.inRange = false;
              } else if (toBool(await it.eval(r.pattern))) {
                matched = true;
                r.inRange = !toBool(await it.eval(r.pattern2));
              } else matched = false;
            } else matched = !r.pattern || toBool(await it.eval(r.pattern));
            if (!matched) continue;
            if (r.action) await it.exec(r.action);
            else it.out.push(it.record + toStr(it.getVar('ORS')));
          }
        } catch (ex) {
          if (ex instanceof NextEx) continue;
          if (ex instanceof NextFileEx) {
            curReader = null;
            continue;
          }
          if (ex instanceof ExitEx) {
            if (ex.code !== null) exitCode = ex.code;
            break;
          }
          throw ex;
        }
        if (it.out.length > 64) await it.flush();
        await ctx.tick();
      }
    }
    try {
      for (const b of prog.end) await it.exec(b);
    } catch (ex) {
      if (ex instanceof ExitEx) {
        if (ex.code !== null) exitCode = ex.code;
      } else throw ex;
    }
    await it.flush();
    for (const [, o] of it.outputs) if (o.kind === 'pipe') await it.runPipe(o);
  } catch (ex) {
    await it.flush().catch(() => {});
    if (ex instanceof AwkError) {
      await ctx.err(`awk: cmd. line:1: (FILENAME=${toStr(it.getVar('FILENAME')) || '-'} FNR=${toStr(it.getVar('FNR'))}) fatal: ${ex.message}\n`);
      return 2;
    }
    if (ex instanceof NextEx) {
      await ctx.err('awk: fatal: `next\' used in BEGIN or END action\n');
      return 2;
    }
    if (ex instanceof BreakEx || ex instanceof ContinueEx) {
      await ctx.err('awk: fatal: `break\' or `continue\' outside a loop is not allowed\n');
      return 2;
    }
    throw ex;
  }
  return hadError && exitCode === 0 ? 2 : exitCode;
}

function processEscapes(s) {
  return s.replace(/\\(n|t|r|\\|"|\/|a|b|f|v|[0-7]{1,3})/g, (m, c) => {
    const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' };
    if (c in map) return map[c];
    return String.fromCharCode(parseInt(c, 8));
  });
}

export async function awkCmd(ctx) {
  const args = ctx.args;
  let fs = null;
  const assigns = [];
  const progFiles = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-F') {
      fs = args[++i];
      continue;
    }
    if (a.startsWith('-F')) {
      fs = a.slice(2);
      continue;
    }
    if (a === '-v') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(args[++i] || '');
      if (!m) {
        await ctx.err(`awk: invalid -v argument\n`);
        return 2;
      }
      assigns.push([m[1], processEscapes(m[2])]);
      continue;
    }
    if (a.startsWith('-v') && a.length > 2) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a.slice(2));
      if (m) assigns.push([m[1], processEscapes(m[2])]);
      continue;
    }
    if (a === '-f') {
      progFiles.push(args[++i]);
      continue;
    }
    if (a === '--version' || a === '-V') {
      await ctx.out('GNU Awk 5.2.1, API 3.2 (browser simulation)\n');
      return 0;
    }
    if (a === '--help' || a === '-h') {
      await ctx.out("Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] 'program' file ...\nPOSIX options:\t\tGNU long options: (standard)\n\t-f progfile\t\t--file=progfile\n\t-F fs\t\t\t--field-separator=fs\n\t-v var=val\t\t--assign=var=val\n");
      return 0;
    }
    if (a.startsWith('--field-separator=')) {
      fs = a.slice(18);
      continue;
    }
    if (a.startsWith('--assign=')) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(a.slice(9));
      if (m) assigns.push([m[1], processEscapes(m[2])]);
      continue;
    }
    if (a.startsWith('--file=')) {
      progFiles.push(a.slice(7));
      continue;
    }
    if (a.startsWith('-') && a !== '-' && /^-[a-zA-Z]/.test(a)) {
      if (['-e', '-E', '-b', '-c', '-P', '-O', '-M', '-S', '-r', '-s', '-n', '-t', '-l', '-L', '-g', '-D', '-o', '-p', '-i', '-W'].some((x) => a.startsWith(x))) {
        if (a === '-e' || a === '--source') progFiles.push({ src: args[++i] });
        continue;
      }
      await ctx.err(`awk: not an option: ${a}\n`);
      return 2;
    }
    break;
  }
  let program;
  if (progFiles.length) {
    const parts = [];
    for (const f of progFiles) {
      if (typeof f === 'object') {
        parts.push(f.src);
        continue;
      }
      try {
        parts.push(f === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(f, ctx.cwd));
      } catch (e) {
        await ctx.err(`awk: fatal: can't open source file \`${f}' for reading: ${e.message}\n`);
        return 2;
      }
    }
    program = parts.join('\n');
  } else {
    if (i >= args.length) {
      await ctx.err("Usage: awk [POSIX or GNU style options] -f progfile [--] file ...\nUsage: awk [POSIX or GNU style options] [--] 'program' file ...\n");
      return 2;
    }
    program = args[i++];
  }
  if (fs !== null) {
    if (fs === 't') fs = '\t';
    else fs = processEscapes(fs);
  }
  return runAwk(ctx, program, args.slice(i), assigns, fs);
}

export function install(reg) {
  reg.set('awk', { fn: awkCmd });
  reg.set('gawk', { fn: awkCmd });
  reg.set('mawk', { fn: awkCmd });
  reg.set('nawk', { fn: awkCmd });
}
