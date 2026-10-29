// Shared helpers for commands: option parsing, file input, bytes, hashing.

import { FsError } from './vfs.js';

export class UsageError extends Error {
  constructor(msg, status = 1, tryHelp = true) {
    super(msg);
    this.status = status;
    this.tryHelp = tryHelp;
  }
}

// GNU-style option parser.
// spec: { flags: 'abc', params: 'nk', long: { lines: 'n', all: 'a', color: '=' }, numeric: 'n', stopAtOperand }
// long values: a short letter alias, or '=' (takes a value, stored under the long name),
// or '?' (optional value), or '' (flag stored under the long name)
export function getopt(args, spec, name) {
  const o = {};
  const rest = [];
  const flags = spec.flags || '';
  const params = spec.params || '';
  const long = spec.long || {};
  const multi = spec.multi || '';
  const setv = (k, v) => {
    if (multi.includes(k) || (spec.multiLong || []).includes(k)) (o[k] = o[k] || []).push(v);
    else o[k] = v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') {
      rest.push(a);
      continue;
    }
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      let key = k;
      if (!(key in long)) {
        const cands = Object.keys(long).filter((x) => x.startsWith(k));
        if (cands.length === 1) key = cands[0];
        else if (cands.length > 1) throw new UsageError(`option '--${k}' is ambiguous; possibilities: ${cands.map((c) => "'--" + c + "'").join(' ')}`);
        else throw new UsageError(`unrecognized option '--${k}'`);
      }
      const t = long[key];
      if (t === '=' || (t && params.includes(t))) {
        if (v === undefined) {
          if (i + 1 >= args.length) throw new UsageError(`option '--${key}' requires an argument`);
          v = args[++i];
        }
        setv(t === '=' ? key : t, v);
      } else if (t === '?') {
        setv(key, v === undefined ? true : v);
      } else {
        if (v !== undefined) throw new UsageError(`option '--${key}' doesn't allow an argument`);
        if (t === '') o[key] = true;
        else o[t] = (o[t] === true || typeof o[t] === 'number' ? (typeof o[t] === 'number' ? o[t] : 1) + 1 : true);
        if (t !== '' && (spec.count || '').includes(t)) o[t] = (typeof o[t] === 'number' ? o[t] : 0) + 0;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !(spec.negNumbers && /^-\d/.test(a))) {
      if (spec.numeric && /^-\d+$/.test(a)) {
        setv(spec.numeric, a.slice(1));
        continue;
      }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (params.includes(c)) {
          let v = a.slice(j + 1);
          if (v === '') {
            if (i + 1 >= args.length) throw new UsageError(`option requires an argument -- '${c}'`);
            v = args[++i];
          }
          setv(c, v);
          break;
        }
        if (flags.includes(c)) {
          if ((spec.count || '').includes(c)) o[c] = (o[c] || 0) + 1;
          else o[c] = true;
          continue;
        }
        if (spec.numeric && /\d/.test(c)) {
          setv(spec.numeric, a.slice(j).match(/^\d+/)[0]);
          j += a.slice(j).match(/^\d+/)[0].length - 1;
          continue;
        }
        throw new UsageError(`invalid option -- '${c}'`);
      }
      continue;
    }
    rest.push(a);
    if (spec.stopAtOperand) {
      rest.push(...args.slice(i + 1));
      break;
    }
  }
  return { o, rest };
}

// wrap a command implementation with usage-error and fs-error handling
export function cmd(fn, { help = '', usageStatus = 1 } = {}) {
  return async (ctx) => {
    try {
      if (help && ctx.args.includes('--help') && ctx.args[0] === '--help') {
        await ctx.out(help.endsWith('\n') ? help : help + '\n');
        return 0;
      }
      const r = await fn(ctx);
      return r === undefined ? 0 : r;
    } catch (e) {
      if (e instanceof UsageError) {
        await ctx.err(`${ctx.name}: ${e.message}\n`);
        if (e.tryHelp) await ctx.err(`Try '${ctx.name} --help' for more information.\n`);
        return e.status === 1 ? usageStatus : e.status;
      }
      if (e instanceof FsError) {
        await ctx.err(`${ctx.name}: ${e.path ? e.path + ': ' : ''}${e.message}\n`);
        return 1;
      }
      throw e;
    }
  };
}

// read each named file (or stdin for '-' / none). Yields {name, text} and reports errors.
export async function* inputs(ctx, files, { allowDir = false } = {}) {
  if (!files.length) files = ['-'];
  for (const f of files) {
    if (f === '-') {
      yield { name: '-', text: await ctx.stdin.readAll(), stdin: true };
      continue;
    }
    try {
      const n = ctx.vfs.stat(f, ctx.cwd);
      if (n.type === 'dir' && !allowDir) {
        await ctx.err(`${ctx.name}: ${f}: Is a directory\n`);
        ctx.failed = true;
        continue;
      }
      yield { name: f, text: ctx.vfs.readFile(f, ctx.cwd) };
    } catch (e) {
      if (e instanceof FsError) {
        await ctx.err(`${ctx.name}: ${f}: ${e.message}\n`);
        ctx.failed = true;
        continue;
      }
      throw e;
    }
  }
}

export async function readInput(ctx, files) {
  let s = '';
  for await (const f of inputs(ctx, files)) s += f.text;
  return s;
}

export function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function abspath(cwd, p) {
  if (!p.startsWith('/')) p = (cwd === '/' ? '' : cwd) + '/' + p;
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export function basename(p) {
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

export function dirname(p) {
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';
  const i = p.lastIndexOf('/');
  if (i < 0) return '.';
  const d = p.slice(0, i).replace(/\/+$/, '');
  return d === '' ? '/' : d;
}

// ---------- bytes (UTF-8 with surrogateescape for invalid bytes) ----------

export function toBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xdc80 && c <= 0xdcff) {
      out.push(c - 0xdc00);
      continue;
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
        continue;
      }
      out.push(0xef, 0xbf, 0xbd);
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function fromBytes(b) {
  let s = '';
  const n = b.length;
  let chunk = [];
  const flush = () => {
    if (chunk.length) {
      s += String.fromCharCode.apply(null, chunk);
      chunk = [];
    }
  };
  for (let i = 0; i < n; ) {
    const c = b[i];
    let cp = -1;
    let len = 1;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i + 1 < n && (b[i + 1] & 0xc0) === 0x80) {
      cp = ((c & 31) << 6) | (b[i + 1] & 63);
      len = 2;
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < n && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80) {
      cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63);
      len = 3;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) cp = -1;
    } else if (c >= 0xf0 && c < 0xf5 && i + 3 < n && (b[i + 1] & 0xc0) === 0x80 && (b[i + 2] & 0xc0) === 0x80 && (b[i + 3] & 0xc0) === 0x80) {
      cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63);
      len = 4;
      if (cp < 0x10000 || cp > 0x10ffff) cp = -1;
    }
    if (cp < 0) {
      chunk.push(0xdc00 + c);
      i++;
    } else {
      if (cp > 0xffff) {
        cp -= 0x10000;
        chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else chunk.push(cp);
      i += len;
    }
    if (chunk.length > 8192) flush();
  }
  flush();
  return s;
}

export function byteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80 || (c >= 0xdc80 && c <= 0xdcff)) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// display width of a string (wide CJK/emoji count 2, combining 0)
export function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 32) continue;
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200b) continue;
    if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) w += 2;
    else w += 1;
  }
  return w;
}

// ---------- hashing ----------

export function md5(bytes) {
  const K = new Uint32Array(64);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const len = bytes.length;
  const total = ((len + 8) >> 6) * 64 + 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < total; off += 64) {
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((x, i) => ov.setUint32(i * 4, x, true));
  return hex(out);
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function shaHex(algo, bytes) {
  const d = await globalThis.crypto.subtle.digest(algo, bytes);
  return hex(new Uint8Array(d));
}

let crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// POSIX cksum CRC
export function posixCksum(bytes) {
  let crc = 0;
  const T = [];
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    T[i] = c >>> 0;
  }
  for (const b of bytes) crc = ((crc << 8) ^ T[((crc >>> 24) ^ b) & 255]) >>> 0;
  let len = bytes.length;
  while (len > 0) {
    crc = ((crc << 8) ^ T[((crc >>> 24) ^ (len & 255)) & 255]) >>> 0;
    len = Math.floor(len / 256);
  }
  return (~crc) >>> 0;
}

export async function compress(format, bytes) {
  const cs = new CompressionStream(format);
  const out = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

export async function decompress(format, bytes) {
  const ds = new DecompressionStream(format);
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export function humanSize(n, si = false) {
  const base = si ? 1000 : 1024;
  const units = ['', 'K', 'M', 'G', 'T', 'P'];
  let i = 0;
  let v = n;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  if (i === 0) return String(n);
  const s = v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v));
  return s + units[i];
}

// POSIX basic/extended regex to JS
export function posixRegex(src, { extended = false, icase = false, global = false, multiline = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  const CL = {
    alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: ' \\t\\n\\r\\f\\v',
    blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e',
  };
  let atStart = true;
  while (i < n) {
    const c = src[i];
    if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (src[j] === '^') {
        cls += '^';
        j++;
      }
      if (src[j] === ']') {
        cls += '\\]';
        j++;
      }
      while (j < n && src[j] !== ']') {
        if (src[j] === '[' && src[j + 1] === ':') {
          const k = src.indexOf(':]', j + 2);
          if (k > 0) {
            cls += CL[src.slice(j + 2, k)] || '';
            j = k + 2;
            continue;
          }
        }
        if (src[j] === '[' && (src[j + 1] === '.' || src[j + 1] === '=')) {
          const close = src[j + 1] + ']';
          const k = src.indexOf(close, j + 2);
          if (k > 0) {
            cls += src.slice(j + 2, k).replace(/[\]\\^-]/g, '\\$&');
            j = k + 2;
            continue;
          }
        }
        if (src[j] === '\\') cls += '\\\\';
        else if (src[j] === '[') cls += '\\[';
        else cls += src[j];
        j++;
      }
      out += cls + ']';
      i = j + 1;
      atStart = false;
      continue;
    }
    if (c === '\\') {
      const d = src[i + 1];
      i += 2;
      if (d === undefined) {
        out += '\\\\';
        continue;
      }
      if (!extended && '(){}|+?'.includes(d)) {
        out += d;
        atStart = d === '(' || d === '|';
        continue;
      }
      if (d === '<') out += '\\b(?=\\w)';
      else if (d === '>') out += '\\b(?<=\\w)';
      else if (d === '`') out += '^';
      else if (d === "'") out += '$';
      else if ('wWsSbB'.includes(d)) out += '\\' + d;
      else if (/[1-9]/.test(d)) out += '\\' + d;
      else if (d === 'n') out += '\\n';
      else if (d === 't') out += '\\t';
      else out += '\\' + (/[a-zA-Z0-9]/.test(d) ? d : d);
      atStart = false;
      continue;
    }
    if (!extended) {
      if ('(){}|+?'.includes(c)) {
        out += '\\' + c;
        i++;
        atStart = false;
        continue;
      }
      if (c === '*' && atStart) {
        out += '\\*';
        i++;
        atStart = false;
        continue;
      }
      if (c === '^' && !atStart) {
        out += '\\^';
        i++;
        continue;
      }
      if (c === '$' && i !== n - 1 && !(src.slice(i + 1, i + 3) === '\\)' || src.slice(i + 1, i + 3) === '\\|')) {
        out += '\\$';
        i++;
        atStart = false;
        continue;
      }
    } else if (c === '{' && !/^\{\d*(,\d*)?\}/.test(src.slice(i))) {
      out += '\\{';
      i++;
      continue;
    }
    if (c === '/') out += '\\/';
    else out += c;
    atStart = c === '^' || (extended && (c === '(' || c === '|'));
    i++;
  }
  let flags = '';
  if (icase) flags += 'i';
  if (global) flags += 'g';
  if (multiline) flags += 'm';
  return new RegExp(out, flags);
}

export function fsMessage(e) {
  return e instanceof FsError ? e.message : String(e && e.message ? e.message : e);
}

export function fmtDate(t, long = false) {
  const d = new Date(t);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const six = 182 * 86400 * 1000;
  if (!long && Math.abs(Date.now() - t) < six) return `${M} ${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${M} ${day}  ${d.getFullYear()}`;
}

// toFixed with C printf rounding: exact ties round half to even
export function cToFixed(x, p) {
  const s = x.toFixed(p);
  if (!isFinite(x) || p > 20 || x === 0) return s;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  if (e >= 0) return s;
  const scaled = mant * 10n ** BigInt(p);
  const denom = 1n << BigInt(-e);
  const rem = scaled % denom;
  if (rem * 2n !== denom) return s;
  let n = scaled / denom;
  if (n % 2n === 1n) n += 1n;
  let digits = n.toString().padStart(p + 1, '0');
  const out = p ? digits.slice(0, digits.length - p) + '.' + digits.slice(digits.length - p) : digits;
  return (x < 0 ? '-' : '') + out;
}

// bash's printf converts with long double (64-bit mantissa); emulate %.Nf of a
// decimal string exactly: round the decimal to the nearest long double, then
// round that value to N places (ties to even)
export function longDoubleFixed(str, p) {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(str);
  if (!m || (!m[2] && !m[3])) return null;
  const neg = m[1] === '-';
  const digits = (m[2] || '') + (m[3] || '');
  let exp10 = -(m[3] || '').length + (m[4] ? parseInt(m[4], 10) : 0);
  let N = BigInt(digits || '0');
  let D = 1n;
  if (exp10 >= 0) N *= 10n ** BigInt(exp10);
  else D = 10n ** BigInt(-exp10);
  if (N === 0n) return (neg ? '-' : '') + (p ? '0.' + '0'.repeat(p) : '0');
  const bitlen = (x) => x.toString(2).length;
  let s = 63 - (bitlen(N) - bitlen(D));
  const scaledQ = (s_) => (s_ >= 0 ? (N << BigInt(s_)) / D : N / (D << BigInt(-s_)));
  while (scaledQ(s) < 1n << 63n) s++;
  while (scaledQ(s) >= 1n << 64n) s--;
  // M = round_half_even(N * 2^s / D)
  const num = s >= 0 ? N << BigInt(s) : N;
  const den = s >= 0 ? D : D << BigInt(-s);
  let M = num / den;
  const r = num % den;
  if (r * 2n > den || (r * 2n === den && M % 2n === 1n)) M += 1n;
  // value = M / 2^s ; round to p decimals
  const scaled = M * 10n ** BigInt(p);
  let q;
  if (s <= 0) q = scaled << BigInt(-s);
  else {
    const d2 = 1n << BigInt(s);
    q = scaled / d2;
    const rem = scaled % d2;
    if (rem * 2n > d2 || (rem * 2n === d2 && q % 2n === 1n)) q += 1n;
  }
  const ds = q.toString().padStart(p + 1, '0');
  const out = p ? ds.slice(0, ds.length - p) + '.' + ds.slice(ds.length - p) : ds;
  return (neg ? '-' : '') + out;
}
