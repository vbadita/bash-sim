// Shell arithmetic: 64-bit signed integers (BigInt), C operator precedence,
// assignment operators, short-circuit evaluation, variables evaluated recursively.

export class ArithError extends Error {}

const wrap = (x) => BigInt.asIntN(64, x);
const lt = (s) => s.replace(/^\s+/, '');

function tokenize(src) {
  const toks = [];
  let i = 0;
  const ops = ['<<=', '>>=', '**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '^', '|', '?', ':', ',', '(', ')'];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9A-Za-z_#@]/.test(src[j])) j++;
      toks.push({ t: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const name = src.slice(i, j);
      let sub = null;
      if (src[j] === '[') {
        let depth = 0;
        let k = j;
        for (; k < src.length; k++) {
          if (src[k] === '[') depth++;
          else if (src[k] === ']') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (k >= src.length) throw new ArithError(`${src.slice(i)}: syntax error: invalid arithmetic operator (error token is "${src.slice(i)}")`);
        sub = src.slice(j + 1, k);
        j = k + 1;
      }
      toks.push({ t: 'var', v: name, sub, pos: i });
      i = j;
      continue;
    }
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new ArithError(`${src.slice(i)}: syntax error: invalid arithmetic operator (error token is "${src.slice(i)}")`);
    toks.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  return toks;
}

function parseNumber(s, src) {
  let m;
  const bad = () => new ArithError(`${s}: value too great for base (error token is "${s}")`);
  if ((m = /^(\d+)#([0-9A-Za-z@_]+)$/.exec(s))) {
    const base = Number(m[1]);
    if (base < 2 || base > 64) throw new ArithError(`${s}: invalid arithmetic base (error token is "${s}")`);
    let v = 0n;
    for (const ch of m[2]) {
      let d;
      if (/[0-9]/.test(ch)) d = ch.charCodeAt(0) - 48;
      else if (/[a-z]/.test(ch)) d = ch.charCodeAt(0) - 97 + 10;
      else if (/[A-Z]/.test(ch)) d = base <= 36 ? ch.charCodeAt(0) - 65 + 10 : ch.charCodeAt(0) - 65 + 36;
      else if (ch === '@') d = 62;
      else d = 63;
      if (d >= base) throw bad();
      v = v * BigInt(base) + BigInt(d);
    }
    return wrap(v);
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(s)) return wrap(BigInt(s));
  if (/^0[0-7]+$/.test(s)) return wrap(BigInt('0o' + s.slice(1)));
  if (/^0[0-9]+$/.test(s)) throw bad();
  if (/^[0-9]+$/.test(s)) return wrap(BigInt(s));
  throw new ArithError(`${lt(src)}: syntax error: invalid arithmetic operator (error token is "${s}")`);
}

const BIN = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11,
};
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '^=', '|=']);

function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const errTok = () => {
    const t = toks[i];
    const rest = t ? src.slice(t.pos) : '';
    return rest;
  };
  const expect = (v) => {
    const t = toks[i];
    if (!t || t.v !== v) {
      throw new ArithError(`${lt(src)}: syntax error: ${v === ')' ? "missing `)'" : 'operand expected'} (error token is "${errTok()}")`);
    }
    i++;
  };
  function comma() {
    let l = assign();
    while (peek() && peek().v === ',') {
      i++;
      l = { k: ',', a: l, b: assign() };
    }
    return l;
  }
  function assign() {
    const t = peek();
    if (t && t.t === 'var' && toks[i + 1] && ASSIGN.has(toks[i + 1].v)) {
      i += 2;
      return { k: 'set', name: t.v, sub: t.sub, op: toks[i - 1].v, b: assign() };
    }
    return ternary();
  }
  function ternary() {
    const c = binary(1);
    if (peek() && peek().v === '?') {
      i++;
      const a = assign();
      expect(':');
      const b = assign();
      return { k: '?', c, a, b };
    }
    return c;
  }
  function binary(minPrec) {
    let l = unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op' || !(t.v in BIN) || BIN[t.v] < minPrec) break;
      const prec = BIN[t.v];
      i++;
      const r = t.v === '**' ? binary(prec) : binary(prec + 1);
      l = { k: 'bin', op: t.v, a: l, b: r };
    }
    return l;
  }
  function unary() {
    const t = peek();
    if (!t) throw new ArithError(`${lt(src)}: syntax error: operand expected (error token is "${errTok()}")`);
    if (t.t === 'op') {
      if (t.v === '++' || t.v === '--') {
        i++;
        const v = peek();
        if (!v || v.t !== 'var') throw new ArithError(`${lt(src)}: syntax error: operand expected (error token is "${errTok()}")`);
        i++;
        return { k: 'pre', op: t.v, name: v.v, sub: v.sub };
      }
      if (['!', '~', '-', '+'].includes(t.v)) {
        i++;
        return { k: 'un', op: t.v, a: unary() };
      }
      if (t.v === '(') {
        i++;
        const e = comma();
        expect(')');
        return e;
      }
      throw new ArithError(`${lt(src)}: syntax error: operand expected (error token is "${errTok()}")`);
    }
    i++;
    if (t.t === 'num') return { k: 'num', v: parseNumber(t.v, src) };
    const n = peek();
    if (n && (n.v === '++' || n.v === '--')) {
      i++;
      return { k: 'post', op: n.v, name: t.v, sub: t.sub };
    }
    return { k: 'var', name: t.v, sub: t.sub };
  }
  if (!toks.length) return { k: 'num', v: 0n };
  const e = comma();
  if (i < toks.length) throw new ArithError(`${lt(src)}: syntax error in expression (error token is "${errTok()}")`);
  return e;
}

// env: { get(name, sub) -> string|undefined, set(name, sub, string), depth }
export function evalArith(src, env, depth = 0) {
  if (depth > 1024) throw new ArithError(`${lt(src)}: expression recursion level exceeded`);
  src = String(src);
  const ast = parse(src);
  const valueOf = (name, sub) => {
    const s = env.get(name, sub);
    if (s === undefined || s === '') {
      if (env.nounset) throw new ArithError(`${name}: unbound variable`);
      return 0n;
    }
    const t = s.trim();
    if (/^-?[0-9]+$/.test(t)) return wrap(BigInt(t));
    return evalArith(t, env, depth + 1);
  };
  const apply = (op, a, b) => {
    switch (op) {
      case '+': return wrap(a + b);
      case '-': return wrap(a - b);
      case '*': return wrap(a * b);
      case '/':
        if (b === 0n) throw new ArithError(`${lt(src)}: division by 0 (error token is "${lt(src.slice(src.lastIndexOf('/') + 1))}")`);
        return wrap(a / b);
      case '%':
        if (b === 0n) throw new ArithError(`${lt(src)}: division by 0 (error token is "${lt(src.slice(src.lastIndexOf('%') + 1))}")`);
        return wrap(a % b);
      case '**':
        if (b < 0n) throw new ArithError(`${lt(src)}: exponent less than 0 (error token is "${src.split('**').pop().trim()}")`);
        return wrap(a ** b);
      case '<<': return wrap(a << (b & 63n));
      case '>>': return wrap(a >> (b & 63n));
      case '<': return a < b ? 1n : 0n;
      case '>': return a > b ? 1n : 0n;
      case '<=': return a <= b ? 1n : 0n;
      case '>=': return a >= b ? 1n : 0n;
      case '==': return a === b ? 1n : 0n;
      case '!=': return a !== b ? 1n : 0n;
      case '&': return wrap(a & b);
      case '^': return wrap(a ^ b);
      case '|': return wrap(a | b);
    }
    throw new ArithError(`bad operator ${op}`);
  };
  const ev = (n) => {
    switch (n.k) {
      case 'num': return n.v;
      case 'var': return valueOf(n.name, n.sub);
      case ',': ev(n.a); return ev(n.b);
      case '?': return ev(n.c) !== 0n ? ev(n.a) : ev(n.b);
      case 'un': {
        const a = ev(n.a);
        if (n.op === '!') return a === 0n ? 1n : 0n;
        if (n.op === '~') return wrap(~a);
        if (n.op === '-') return wrap(-a);
        return a;
      }
      case 'bin': {
        if (n.op === '&&') return ev(n.a) !== 0n && ev(n.b) !== 0n ? 1n : 0n;
        if (n.op === '||') return ev(n.a) !== 0n || ev(n.b) !== 0n ? 1n : 0n;
        return apply(n.op, ev(n.a), ev(n.b));
      }
      case 'pre':
      case 'post': {
        const old = valueOf(n.name, n.sub);
        const nv = wrap(n.op === '++' ? old + 1n : old - 1n);
        env.set(n.name, n.sub, String(nv));
        return n.k === 'pre' ? nv : old;
      }
      case 'set': {
        let v = ev(n.b);
        if (n.op !== '=') v = apply(n.op.slice(0, -1), valueOf(n.name, n.sub), v);
        env.set(n.name, n.sub, String(v));
        return v;
      }
    }
    throw new ArithError('bad expression');
  };
  return ev(ast);
}
