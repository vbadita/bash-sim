// Shell builtins (the commands bash implements itself).

import { ShellError, ansiDecode } from '../expand.js';
import { ExitEx, ReturnEx, BreakEx, ContinueEx, InterruptEx, SIGNALS, RESERVED_WORDS } from '../shell.js';
import { FsError } from '../vfs.js';
import { abspath, strWidth, cToFixed, longDoubleFixed } from '../util.js';
import { parseAssign } from '../parser.js';
import { StringReader } from '../streams.js';

const B = (fn, extra = {}) => ({ fn, builtin: true, ...extra });

const isName = (s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

function ctxErr(ctx, msg) {
  return ctx.shell.report(`${ctx.name}: ${msg}`, ctx.io);
}

// ---------- printf ----------

function escapeOct(s, i) {
  const m = /^[0-7]{1,3}/.exec(s.slice(i));
  return m;
}

// process backslash escapes in printf format / %b argument
function printfEscapes(s, bmode = false) {
  let out = '';
  let stop = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const d = s[++i];
    if (d === undefined) {
      out += '\\';
      break;
    }
    const map = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
    if (d in map && !(bmode && (d === '"' || d === "'"))) {
      out += map[d];
      continue;
    }
    if (d === 'c' && bmode) {
      stop = true;
      break;
    }
    if (d === '0' && bmode) {
      const m = /^[0-7]{0,3}/.exec(s.slice(i + 1));
      out += String.fromCharCode(parseInt(m[0] || '0', 8) & 255);
      i += m[0].length;
      continue;
    }
    if (d >= '0' && d <= '7' && !bmode) {
      const m = escapeOct(s, i);
      out += String.fromCharCode(parseInt(m[0], 8) & 255);
      i += m[0].length - 1;
      continue;
    }
    if (d === 'x') {
      const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
      if (m) {
        const v = parseInt(m[0], 16);
        out += v >= 0x80 ? String.fromCharCode(0xdc00 + v) : String.fromCharCode(v);
        i += m[0].length;
      } else out += '\\x';
      continue;
    }
    if (d === 'u' || d === 'U') {
      const m = (d === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(s.slice(i + 1));
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += m[0].length;
      } else out += '\\' + d;
      continue;
    }
    out += '\\' + d;
  }
  return { out, stop };
}

function numArg(a, ctx, errs) {
  if (a === undefined || a === '') return 0n;
  if (/^['"]/.test(a)) return BigInt(a.length > 1 ? a.codePointAt(1) : 0);
  const t = a.trim();
  let m;
  try {
    if ((m = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(t))) return (m[1] === '-' ? -1n : 1n) * BigInt('0x' + m[2]);
    if ((m = /^([+-]?)0([0-7]+)$/.exec(t))) return (m[1] === '-' ? -1n : 1n) * BigInt('0o' + m[2]);
    if (/^[+-]?\d+$/.test(t)) return BigInt(t);
  } catch {}
  m = /^([+-]?\d+)/.exec(t);
  errs.push(`${a}: invalid number`);
  return m ? BigInt(m[1]) : 0n;
}

function floatArg(a, errs) {
  if (a === undefined || a === '') return 0;
  if (/^['"]/.test(a)) return a.length > 1 ? a.codePointAt(1) : 0;
  const t = a.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) || /^[+-]?(inf|infinity|nan)$/i.test(t)) return parseFloat(t.replace(/^([+-]?)inf(inity)?$/i, '$1Infinity'));
  if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  errs.push(`${a}: invalid number`);
  return parseFloat(t) || 0;
}

function fmtExp(v, prec, upper) {
  let s = v.toExponential(prec);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

function fmtG(v, prec, alt, upper) {
  if (prec === 0) prec = 1;
  if (v === 0) return alt ? (0).toFixed(prec - 1) : '0';
  if (!isFinite(v)) return upper ? String(v).toUpperCase() : String(v).replace('Infinity', 'inf').replace('NaN', 'nan');
  const exp = Math.floor(Math.log10(Math.abs(v)));
  let s;
  const e2 = Number(v.toExponential(prec - 1).split('e')[1]);
  if (e2 < -4 || e2 >= prec) {
    s = v.toExponential(prec - 1);
    if (!alt) s = s.replace(/\.?0+e/, 'e');
    s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  } else {
    s = v.toFixed(Math.max(0, prec - 1 - e2));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
  }
  void exp;
  return upper ? s.toUpperCase() : s;
}

export function formatPrintf(fmt, args, ctx) {
  const errs = [];
  let out = '';
  let ai = 0;
  const next = () => args[ai++];
  let consumed = false;
  let stop = false;
  const shell = ctx && ctx.shell;
  do {
    consumed = false;
    for (let i = 0; i < fmt.length && !stop; i++) {
      const c = fmt[i];
      if (c === '\\') {
        const r = printfEscapes(fmt.slice(i, i + 12).replace(/^(\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)).*$/s, '$1'));
        const m = /^\\(?:[0-7]{1,3}|x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)/s.exec(fmt.slice(i));
        out += r.out;
        i += (m ? m[0].length : 1) - 1;
        continue;
      }
      if (c !== '%') {
        out += c;
        continue;
      }
      if (fmt[i + 1] === '%') {
        out += '%';
        i++;
        continue;
      }
      const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d*))?(\(([^)]*)\)T|[hlLqjzt]*[diouxXfFeEgGaAcsbq])/.exec(fmt.slice(i));
      if (!m) {
        errs.push(`\`${fmt.slice(i + 1, i + 2) || '%'}': invalid format character`);
        stop = true;
        break;
      }
      i += m[0].length - 1;
      const flags = m[1];
      let width = m[2] === '*' ? Number(numArg(next(), ctx, errs)) : m[2] ? parseInt(m[2], 10) : 0;
      let prec = m[3] === undefined ? undefined : m[3] === '*' ? Number(numArg(next(), ctx, errs)) : m[3] === '' ? 0 : parseInt(m[3], 10);
      let left = flags.includes('-');
      if (width < 0) {
        left = true;
        width = -width;
      }
      const conv = m[4].startsWith('(') ? 'T' : m[4].slice(-1);
      const arg = next();
      if (arg !== undefined) consumed = true;
      let s;
      const zero = flags.includes('0') && !left;
      const signed = (neg, body) => (neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') + body;
      switch (conv) {
        case 's':
          s = arg ?? '';
          if (prec !== undefined) s = [...s].slice(0, prec).join('');
          break;
        case 'b': {
          const r = printfEscapes(arg ?? '', true);
          s = r.out;
          if (prec !== undefined) s = s.slice(0, prec);
          if (r.stop) stop = true;
          break;
        }
        case 'q':
          s = arg === undefined ? "''" : shell ? shellQuoteQ(arg) : arg;
          break;
        case 'c':
          s = arg ? [...arg][0] : '';
          break;
        case 'd':
        case 'i': {
          const v = numArg(arg, ctx, errs);
          let body = (v < 0n ? -v : v).toString();
          if (prec !== undefined) body = body.padStart(prec, '0');
          s = signed(v < 0n, body);
          if (zero && prec === undefined && s.length < width) {
            const sign = /^[-+ ]/.test(s) ? s[0] : '';
            s = sign + s.slice(sign.length).padStart(width - sign.length, '0');
          }
          break;
        }
        case 'u':
        case 'o':
        case 'x':
        case 'X': {
          let v = numArg(arg, ctx, errs);
          if (v < 0n) v = BigInt.asUintN(64, v);
          let body = v.toString(conv === 'o' ? 8 : conv === 'u' ? 10 : 16);
          if (conv === 'X') body = body.toUpperCase();
          if (prec !== undefined) body = body.padStart(prec, '0');
          if (flags.includes('#') && v !== 0n) body = (conv === 'o' ? '0' : conv === 'x' ? '0x' : conv === 'X' ? '0X' : '') + body;
          s = body;
          if (zero && prec === undefined) s = s.padStart(width, '0');
          break;
        }
        case 'f':
        case 'F':
        case 'e':
        case 'E':
        case 'g':
        case 'G':
        case 'a':
        case 'A': {
          const v = floatArg(arg, errs);
          const p = prec === undefined ? 6 : prec;
          let body;
          const av = Math.abs(v);
          if (!isFinite(v)) body = isNaN(v) ? 'nan' : 'inf';
          else if (conv === 'f' || conv === 'F') body = (/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(arg ?? '') && longDoubleFixed(String(arg).replace(/^\s*-/, ''), p)) || cToFixed(av, p);
          else if (conv === 'e' || conv === 'E') body = fmtExp(av, p, conv === 'E');
          else if (conv === 'a' || conv === 'A') body = av.toString(16);
          else body = fmtG(av, p, flags.includes('#'), conv === 'G');
          if (conv === 'F' || conv === 'E' || conv === 'G') body = body.toUpperCase();
          if (flags.includes('#') && !body.includes('.') && /^\d+$/.test(body)) body += '.';
          s = signed(v < 0 || Object.is(v, -0), body);
          if (zero && isFinite(v) && s.length < width) {
            const sign = /^[-+ ]/.test(s) ? s[0] : '';
            s = sign + s.slice(sign.length).padStart(width - sign.length, '0');
          }
          break;
        }
        case 'T': {
          const f = m[5] || '%X';
          let t;
          if (arg === undefined || arg === '' || arg === '-1') t = Date.now();
          else if (arg === '-2') t = ctx.shell.startTime;
          else t = Number(numArg(arg, ctx, errs)) * 1000;
          s = ctx.shell.commands.get('date').format(new Date(t), f);
          if (prec !== undefined) s = s.slice(0, prec);
          break;
        }
      }
      const w = strWidth(s);
      if (w < width) s = left ? s + ' '.repeat(width - w) : ' '.repeat(width - w) + s;
      out += s;
    }
  } while (!stop && consumed && ai < args.length);
  return { out, errs };
}

function shellQuoteQ(s) {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  if (/[\x00-\x1f\x7f]/.test(s)) {
    return "$'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\x00-\x1f\x7f]/g, (c) => ({ '\n': '\\n', '\t': '\\t', '\r': '\\r', '\x1b': '\\E' }[c] || '\\' + c.charCodeAt(0).toString(8).padStart(3, '0'))) + "'";
  }
  return s.replace(/[^A-Za-z0-9_@%+=:,./-]/g, '\\$&');
}

// ---------- test ----------

function fileTest(shell, op, a) {
  const vfs = shell.vfs;
  if (op === '-t') {
    const fd = parseInt(a, 10);
    const s = shell.io && shell.io[fd];
    return !!(s && (s.isTerminal || s.isTerminalWriter));
  }
  if (a === '') return false;
  let node;
  try {
    node = vfs.stat(a, shell.cwd, op !== '-h' && op !== '-L');
  } catch {
    return false;
  }
  switch (op) {
    case '-e':
    case '-a':
      return true;
    case '-f':
      return node.type === 'file';
    case '-d':
      return node.type === 'dir';
    case '-h':
    case '-L':
      return node.type === 'link';
    case '-s':
      return node.type === 'file' ? (node.gen ? node.gen() : node.data).length > 0 : node.type === 'dir';
    case '-r':
      return vfs.can(node, 4);
    case '-w':
      return vfs.can(node, 2) && !node.gen;
    case '-x':
      return vfs.can(node, 1);
    case '-c':
      return node.type === 'chr';
    case '-b':
      return false;
    case '-p':
      return node.type === 'fifo';
    case '-S':
      return false;
    case '-u':
      return !!(node.mode & 0o4000);
    case '-g':
      return !!(node.mode & 0o2000);
    case '-k':
      return !!(node.mode & 0o1000);
    case '-O':
      return node.uid === vfs.cred.uid;
    case '-G':
      return node.gid === vfs.cred.gid;
    case '-N':
      return node.mtime > node.atime;
  }
  return false;
}

const UNARY = new Set(['-a', '-b', '-c', '-d', '-e', '-f', '-g', '-h', '-k', '-p', '-r', '-s', '-t', '-u', '-w', '-x', '-G', '-L', '-N', '-O', '-S', '-z', '-n', '-o', '-v', '-R']);
const BINARY = new Set(['=', '==', '!=', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot', '-ef']);

function testUnary(shell, op, a) {
  switch (op) {
    case '-z':
      return a === '';
    case '-n':
      return a !== '';
    case '-o':
      return !!shell.opts[a];
    case '-v': {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?$/.exec(a);
      if (!m) return false;
      if (m[2] !== undefined) return shell.getElement(m[1], m[2]) !== undefined;
      return shell.getVar(m[1]) !== undefined || shell.isSet(m[1]);
    }
    case '-R': {
      const v = shell.lookupVar(a);
      return !!(v && v.n);
    }
  }
  return fileTest(shell, op, a);
}

function intArg(shell, s) {
  const t = s.trim();
  if (!/^[+-]?\d+$/.test(t)) throw new ShellError(`${s}: integer expression expected`, 2, false);
  return BigInt(t);
}

function testBinary(shell, op, a, b) {
  switch (op) {
    case '=':
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '-eq':
      return intArg(shell, a) === intArg(shell, b);
    case '-ne':
      return intArg(shell, a) !== intArg(shell, b);
    case '-lt':
      return intArg(shell, a) < intArg(shell, b);
    case '-le':
      return intArg(shell, a) <= intArg(shell, b);
    case '-gt':
      return intArg(shell, a) > intArg(shell, b);
    case '-ge':
      return intArg(shell, a) >= intArg(shell, b);
    case '-nt':
    case '-ot':
    case '-ef': {
      let x = null;
      let y = null;
      try {
        x = shell.vfs.stat(a, shell.cwd);
      } catch {}
      try {
        y = shell.vfs.stat(b, shell.cwd);
      } catch {}
      if (op === '-ef') return !!x && x === y;
      if (op === '-nt') return !!x && (!y || x.mtime > y.mtime);
      return !!y && (!x || x.mtime < y.mtime);
    }
  }
  throw new ShellError(`${op}: binary operator expected`, 2, false);
}

function testEval(shell, args) {
  let i = 0;
  const n = args.length;
  const primary = () => {
    const a = args[i];
    if (a === '!') {
      i++;
      return !primary();
    }
    if (a === '(') {
      i++;
      const r = orExpr();
      if (args[i] !== ')') throw new ShellError(`\`)' expected`, 2, false);
      i++;
      return r;
    }
    if (UNARY.has(a) && i + 1 < n && !(i + 2 < n && BINARY.has(args[i + 1]))) {
      i += 2;
      return testUnary(shell, a, args[i - 1]);
    }
    if (i + 2 < n + 0 && BINARY.has(args[i + 1])) {
      i += 3;
      return testBinary(shell, args[i - 2], args[i - 3], args[i - 1]);
    }
    if (a === undefined) throw new ShellError('argument expected', 2, false);
    i++;
    return a !== '';
  };
  const andExpr = () => {
    let r = primary();
    while (args[i] === '-a') {
      i++;
      const r2 = primary();
      r = r && r2;
    }
    return r;
  };
  const orExpr = () => {
    let r = andExpr();
    while (args[i] === '-o') {
      i++;
      const r2 = andExpr();
      r = r || r2;
    }
    return r;
  };
  // POSIX rules by argument count
  if (n === 0) return false;
  if (n === 1) return args[0] !== '';
  if (n === 2) {
    if (args[0] === '!') return args[1] === '';
    if (UNARY.has(args[0])) return testUnary(shell, args[0], args[1]);
    throw new ShellError(`${args[0]}: unary operator expected`, 2, false);
  }
  if (n === 3) {
    if (BINARY.has(args[1])) return testBinary(shell, args[1], args[0], args[2]);
    if (args[1] === '-a') return args[0] !== '' && args[2] !== '';
    if (args[1] === '-o') return args[0] !== '' || args[2] !== '';
    if (args[0] === '!') return !testEval(shell, args.slice(1));
    if (args[0] === '(' && args[2] === ')') return args[1] !== '';
    throw new ShellError(`${args[1]}: binary operator expected`, 2, false);
  }
  if (n === 4 && args[0] === '!') return !testEval(shell, args.slice(1));
  if (n === 4 && args[0] === '(' && args[3] === ')') return testEval(shell, args.slice(1, 3));
  const r = orExpr();
  if (i < n) throw new ShellError(`${args[i]}: unexpected argument`, 2, false);
  return r;
}

async function testCmd(ctx) {
  let args = ctx.args.slice();
  if (ctx.name === '[') {
    if (args[args.length - 1] !== ']') {
      await ctxErr(ctx, "missing `]'");
      return 2;
    }
    args.pop();
  }
  try {
    return testEval(ctx.shell, args) ? 0 : 1;
  } catch (e) {
    if (e instanceof ShellError) {
      await ctxErr(ctx, e.message);
      return 2;
    }
    throw e;
  }
}

// ---------- read ----------

async function readCmd(ctx) {
  const sh = ctx.shell;
  let raw = false;
  let prompt = null;
  let silent = false;
  let nchars = null;
  let exact = false;
  let delim = '\n';
  let arrayName = null;
  let timeout = null;
  let fd = 0;
  let initial = null;
  const names = [];
  const a = ctx.args;
  let i = 0;
  for (; i < a.length; i++) {
    const s = a[i];
    if (s === '--') {
      i++;
      break;
    }
    if (!s.startsWith('-') || s === '-') break;
    for (let j = 1; j < s.length; j++) {
      const c = s[j];
      const val = () => {
        const v = s.slice(j + 1) || a[++i];
        j = s.length;
        if (v === undefined) throw new ShellError(`read: -${c}: option requires an argument`, 2, false);
        return v;
      };
      if (c === 'r') raw = true;
      else if (c === 's') silent = true;
      else if (c === 'e') {} else if (c === 'p') prompt = val();
      else if (c === 'n') nchars = parseInt(val(), 10);
      else if (c === 'N') {
        nchars = parseInt(val(), 10);
        exact = true;
      } else if (c === 'd') {
        const v = val();
        delim = v === '' ? '\0' : v[0];
      } else if (c === 'a') arrayName = val();
      else if (c === 't') timeout = parseFloat(val());
      else if (c === 'u') fd = parseInt(val(), 10);
      else if (c === 'i') initial = val();
      else {
        await sh.report(`read: -${c}: invalid option`, ctx.io);
        await ctx.err('read: usage: read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n');
        return 2;
      }
    }
  }
  names.push(...a.slice(i));
  for (const n of names) if (!isName(n)) {
    await sh.report(`read: \`${n}': not a valid identifier`, ctx.io);
    return 1;
  }
  const input = ctx.io[fd];
  if (!input || !input.readLine) {
    await sh.report(`read: ${fd}: invalid file descriptor: Bad file descriptor`, ctx.io);
    return 1;
  }
  const isTerm = !!input.isTerminal;
  if (prompt !== null && isTerm) await ctx.err(prompt);
  let line = null;
  let gotDelim = false;
  const doRead = async () => {
    if (isTerm) {
      const r = await input.term.readInput({ echo: !silent, n: nchars, delim, initial });
      if (r === null) return;
      line = r.text;
      gotDelim = r.delim;
      return;
    }
    if (nchars !== null) {
      let s = '';
      while (s.length < nchars) {
        const ch = await input.readChars(1);
        if (ch === '') break;
        if (!exact && ch === delim) {
          gotDelim = true;
          break;
        }
        if (!raw && ch === '\\' && !exact) {
          const nx = await input.readChars(1);
          if (nx === '\n') continue;
          s += nx;
          continue;
        }
        s += ch;
      }
      line = s === '' && !gotDelim && input.eof && !input.buf ? null : s;
      if (line !== null && s.length === nchars) gotDelim = true;
      return;
    }
    let acc = '';
    for (;;) {
      const r = delim === '\n' ? await input.readLineRaw() : await input.readUntil(delim);
      if (!r) {
        line = acc === '' ? null : acc;
        return;
      }
      if (!raw && r.line.endsWith('\\') && r.nl && delim === '\n') {
        // count trailing backslashes
        const m = /\\+$/.exec(r.line);
        if (m[0].length % 2 === 1) {
          acc += r.line.slice(0, -1);
          continue;
        }
      }
      acc += r.line;
      gotDelim = r.nl;
      line = acc;
      return;
    }
  };
  if (timeout !== null) {
    let timedOut = false;
    await Promise.race([
      doRead(),
      new Promise((res) => setTimeout(() => {
        timedOut = true;
        res();
      }, timeout * 1000)),
    ]);
    if (timedOut && line === null) {
      if (isTerm && input.term.cancelInput) input.term.cancelInput();
      return 142;
    }
  } else await doRead();
  if (line === null) {
    if (arrayName) sh.setArray(arrayName, []);
    else if (names.length) for (const n of names) sh.setVar(n, '');
    else sh.setVar('REPLY', '');
    return 1;
  }
  // backslash processing
  let text = line;
  const literalMask = [];
  if (!raw) {
    let t = '';
    for (let k = 0; k < text.length; k++) {
      if (text[k] === '\\' && k + 1 < text.length) {
        t += text[k + 1];
        literalMask[t.length - 1] = true;
        k++;
      } else t += text[k];
    }
    text = t;
  }
  if (!names.length && !arrayName) {
    sh.setVar('REPLY', text);
    return gotDelim || nchars !== null ? 0 : 1;
  }
  const ifs = sh.ifsValue();
  const ws = [...ifs].filter((c) => ' \t\n'.includes(c)).join('');
  const isWs = (k) => ws.includes(text[k]) && !literalMask[k];
  const isIfs = (k) => ifs.includes(text[k]) && !literalMask[k];
  // split into fields
  const fields = [];
  let k = 0;
  const n = text.length;
  while (k < n && isWs(k)) k++;
  const wantFields = arrayName ? Infinity : names.length;
  while (k < n) {
    if (fields.length === wantFields - 1) {
      // rest of line, minus trailing IFS whitespace
      let rest = text.slice(k);
      let e = n;
      while (e > k && isWs(e - 1)) e--;
      rest = text.slice(k, e);
      // a single trailing non-whitespace IFS char is also stripped
      if (rest.length && ifs.includes(rest[rest.length - 1]) && !ws.includes(rest[rest.length - 1]) && !literalMask[e - 1]) {
        const before = rest.slice(0, -1);
        let cnt = 0;
        for (const ch of before) if (ifs.includes(ch) && !ws.includes(ch)) cnt++;
        if (cnt === 0) rest = before;
      }
      fields.push(rest);
      k = n;
      break;
    }
    let start = k;
    while (k < n && !isIfs(k)) k++;
    fields.push(text.slice(start, k));
    if (k >= n) break;
    while (k < n && isWs(k)) k++;
    if (k < n && isIfs(k) && !isWs(k)) {
      k++;
      while (k < n && isWs(k)) k++;
    }
  }
  if (arrayName) sh.setArray(arrayName, fields.map((f) => [null, f]));
  else names.forEach((nm, idx) => sh.setVar(nm, fields[idx] ?? ''));
  return gotDelim || nchars !== null ? 0 : 1;
}

async function mapfileCmd(ctx) {
  const sh = ctx.shell;
  let strip = false;
  let count = 0;
  let origin = 0;
  let skip = 0;
  let delim = '\n';
  let fd = 0;
  let cb = null;
  let quantum = 5000;
  let name = 'MAPFILE';
  const a = ctx.args;
  let i = 0;
  for (; i < a.length; i++) {
    const s = a[i];
    if (!s.startsWith('-') || s === '-') break;
    const c = s[1];
    const v = () => s.slice(2) || a[++i];
    if (c === 't') strip = true;
    else if (c === 'n') count = parseInt(v(), 10);
    else if (c === 'O') origin = parseInt(v(), 10);
    else if (c === 's') skip = parseInt(v(), 10);
    else if (c === 'd') {
      const x = v();
      delim = x === '' ? '\0' : x[0];
    } else if (c === 'u') fd = parseInt(v(), 10);
    else if (c === 'C') cb = v();
    else if (c === 'c') quantum = parseInt(v(), 10);
    else {
      await sh.report(`${ctx.name}: ${s}: invalid option`, ctx.io);
      return 2;
    }
  }
  if (a[i]) name = a[i];
  const input = ctx.io[fd];
  const values = [];
  let n = 0;
  let idx = origin;
  for (;;) {
    if (count && values.length >= count) break;
    const r = delim === '\n' ? await input.readLineRaw() : await input.readUntil(delim);
    if (!r) break;
    n++;
    if (n <= skip) continue;
    const val = strip || !r.nl ? r.line : r.line + delim;
    values.push([String(idx), val]);
    if (cb && values.length % quantum === 0) await sh.runSource(`${cb} ${idx} ${sh.quoteValue(val)}`, ctx.io);
    idx++;
  }
  if (origin === 0) sh.setArray(name, values);
  else {
    for (const [k, v] of values) sh.setElement(name, k, v);
  }
  return 0;
}

// ---------- declare & friends ----------

async function declareCmd(ctx) {
  const sh = ctx.shell;
  const isLocal = ctx.name === 'local';
  if (isLocal && !sh.funcStack.length) {
    await sh.report('local: can only be used in a function', ctx.io);
    return 1;
  }
  const on = new Set();
  const off = new Set();
  const items = [];
  let i = 0;
  const a = ctx.args;
  for (; i < a.length; i++) {
    const s = a[i];
    if (typeof s !== 'string') break;
    if (s === '--') {
      i++;
      break;
    }
    if ((s[0] === '-' || s[0] === '+') && s.length > 1) {
      for (const c of s.slice(1)) {
        if (!'aAfFgilnprtuxI'.includes(c)) {
          await sh.report(`${ctx.name}: ${s[0]}${c}: invalid option`, ctx.io);
          await ctx.err(`${ctx.name}: usage: ${ctx.name} [-aAfFgiIlnrtux] [name[=value] ...] or ${ctx.name} -p [-aAfFilnrtux] [name ...]\n`);
          return 2;
        }
        (s[0] === '-' ? on : off).add(c);
      }
      continue;
    }
    break;
  }
  items.push(...a.slice(i));
  if (ctx.name === 'export') {
    on.add('x');
    if (on.has('n')) {
      on.delete('n');
      on.delete('x');
      off.add('x');
    }
  }
  if (ctx.name === 'readonly') on.add('r');
  const print = on.has('p') || (!items.length && !on.has('f') && !on.has('F'));
  // functions
  if (on.has('f') || on.has('F')) {
    const names = items.length ? items.map((x) => (typeof x === 'string' ? x : x.assign)) : [...sh.functions.keys()].sort();
    let st = 0;
    for (const n of names) {
      const f = sh.functions.get(n);
      if (!f) {
        st = 1;
        continue;
      }
      if (on.has('x')) f.exported = true;
      if (on.has('r')) f.readonly = true;
      if (items.length && (on.has('x') || on.has('r')) && !on.has('p')) continue;
      if (on.has('F')) await ctx.out(`declare -f${f.exported ? 'x' : ''} ${n}\n`);
      else await ctx.out(formatFunction(n, f) + '\n');
    }
    return st;
  }
  if (print && !items.length) {
    const filterAttrs = [...on].filter((c) => 'aAilnrtux'.includes(c));
    for (const name of sh.allVarNames()) {
      let v = sh.lookupVar(name);
      if (!v) v = { v: sh.getVar(name) };
      if (filterAttrs.length && !filterAttrs.every((c) => (c === 'a' ? v.a : c === 'A' ? v.A : v[c]))) continue;
      if (ctx.name === 'export' || (ctx.name === 'declare' && on.has('x') && !on.has('p') && false)) {
        if (!v.x) continue;
        const val = v.v === undefined ? '' : `=${sh.dquote(v.v)}`;
        await ctx.out(`declare -x ${name}${val}\n`);
        continue;
      }
      if (ctx.name === 'readonly') {
        if (!v.r) continue;
      }
      if (on.has('p') || ctx.name === 'readonly' || filterAttrs.length) await ctx.out(sh.declareLine(name, v) + '\n');
      else {
        if (v.a || v.A) await ctx.out(sh.declareLine(name, v).replace(/^declare -\S+ /, '') + '\n');
        else if (v.v !== undefined) await ctx.out(`${name}=${sh.quoteValue(v.v).replace(/^''$/, '')}\n`);
      }
    }
    if (!on.has('p') && ctx.name === 'declare' && !filterAttrs.length) {
      for (const [n, f] of [...sh.functions].sort()) await ctx.out(formatFunction(n, f) + '\n');
    }
    return 0;
  }
  if (print) {
    let st = 0;
    for (const it of items) {
      const n = typeof it === 'string' ? it : it.assign;
      const v = sh.lookupVar(n);
      if (!v && sh.getVar(n) === undefined) {
        await sh.report(`${ctx.name}: ${n}: not found`, ctx.io);
        st = 1;
        continue;
      }
      await ctx.out(sh.declareLine(n, v || { v: sh.getVar(n) }) + '\n');
    }
    return st;
  }
  const makeLocal = isLocal || (sh.funcStack.length && !on.has('g') && (ctx.name === 'declare' || ctx.name === 'typeset'));
  let st = 0;
  for (const it of items) {
    let name;
    let value;
    let index = null;
    let arrayVals = null;
    let append = false;
    if (typeof it === 'string') {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?(\+?)=(.*)$/s.exec(it);
      if (m) {
        name = m[1];
        index = m[2] ?? null;
        append = !!m[3];
        value = m[4];
        if (value.startsWith('(') && value.endsWith(')') && (on.has('a') || on.has('A'))) {
          const pa = parseAssign(`${name}=${value}`);
          arrayVals = [];
          for (const w of pa.array) {
            const mm = /^\[([^\]]*)\]=(.*)$/s.exec(w);
            if (mm) arrayVals.push([mm[1], mm[2]]);
            else arrayVals.push([null, w]);
          }
          value = undefined;
        }
      } else name = it;
    } else {
      name = it.assign;
      append = it.append;
      if (it.array) arrayVals = it.array;
      else {
        value = it.value;
        index = it.index ?? null;
      }
    }
    if (!isName(name)) {
      await sh.report(`${ctx.name}: \`${typeof it === 'string' ? it : name}': not a valid identifier`, ctx.io);
      st = 1;
      continue;
    }
    let home;
    if (makeLocal) {
      home = sh.scopes[sh.scopes.length - 1];
      // the innermost function scope (skip temp env scopes)
      for (let k = sh.scopes.length - 1; k >= 0; k--) {
        if (!sh.scopes[k].tempEnv) {
          home = sh.scopes[k];
          break;
        }
      }
    } else if (on.has('g')) home = sh.globals;
    else home = sh.varHome(name);
    let v = home.get(name);
    if (v && v.unsetLocal) {
      home.delete(name);
      v = undefined;
    }
    if (!v) {
      v = { v: undefined };
      if (makeLocal && sh.shopt.localvar_inherit) {
        const outer = sh.lookupVar(name);
        if (outer) Object.assign(v, { v: outer.v, a: outer.a && new Map(outer.a), A: outer.A && new Map(outer.A) });
      }
      home.set(name, v);
    }
    if (v.r && (value !== undefined || arrayVals || off.size || [...on].some((c) => c !== 'r' && c !== 'x' && c !== 'g'))) {
      await sh.report(`${ctx.name}: ${name}: readonly variable`, ctx.io);
      st = 1;
      continue;
    }
    if (on.has('A') && v.a) {
      await sh.report(`${ctx.name}: ${name}: cannot convert indexed to associative array`, ctx.io);
      st = 1;
      continue;
    }
    if (on.has('a') && !v.a && !v.A) {
      v.a = new Map();
      if (v.v !== undefined) v.a.set(0, v.v);
      delete v.v;
    }
    if (on.has('A') && !v.A) {
      v.A = new Map();
      if (v.v !== undefined) v.A.set('0', v.v);
      delete v.v;
    }
    for (const c of 'ilnrtux') {
      if (on.has(c)) v[c] = true;
      if (off.has(c)) v[c] = false;
    }
    if (v.l && on.has('l')) v.u = false;
    if (v.u && on.has('u')) v.l = false;
    try {
      if (arrayVals) {
        const vals = [];
        for (const [k, x] of arrayVals) vals.push([k, x]);
        if (v.A) sh.setArray(name, vals, { append });
        else sh.setArray(name, vals, { append });
      } else if (value !== undefined) {
        const rflag = v.r;
        v.r = false;
        if (index !== null) sh.setElement(name, index, value, { append });
        else sh.setVar(name, value, { append });
        v.r = rflag;
      } else if (v.v !== undefined && (on.has('u') || on.has('l') || on.has('i'))) {
        v.v = sh.transformValue(v, v.v, name);
      }
    } catch (e) {
      if (e instanceof ShellError) {
        await sh.report(`${ctx.name}: ${e.message}`, ctx.io);
        st = 1;
        continue;
      }
      throw e;
    }
  }
  return st;
}

export function formatFunction(name, f) {
  let text = f.text || '';
  // normalize to bash's display: name () \n{ ... }
  const m = /^(?:function\s+)?([^\s(]+)\s*(?:\(\s*\))?\s*/.exec(text);
  let body = m ? text.slice(m[0].length) : text;
  if (body.startsWith('{')) {
    const inner = body.slice(1, body.lastIndexOf('}')).trim();
    const lines = inner.split('\n').map((l) => l.trim()).filter(Boolean);
    const stmts = [];
    for (const l of lines) for (const p of l.split(/;\s*(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/)) if (p.trim()) stmts.push(p.trim().replace(/;$/, ''));
    return `${name} () \n{ \n${stmts.map((s) => '    ' + s).join(';\n')}${stmts.length ? '\n' : ''}}`;
  }
  return `${name} () \n${body}`;
}

async function unsetCmd(ctx) {
  const sh = ctx.shell;
  let mode = null;
  let i = 0;
  const a = ctx.args;
  for (; i < a.length && a[i].startsWith('-') && a[i] !== '-'; i++) {
    if (a[i] === '--') {
      i++;
      break;
    }
    for (const c of a[i].slice(1)) {
      if (c === 'f') mode = 'f';
      else if (c === 'v') mode = 'v';
      else if (c === 'n') mode = 'n';
      else {
        await sh.report(`unset: -${c}: invalid option`, ctx.io);
        await ctx.err('unset: usage: unset [-f] [-v] [-n] [name ...]\n');
        return 2;
      }
    }
  }
  let st = 0;
  for (const n of a.slice(i)) {
    try {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(n);
      if (mode === 'f') {
        sh.functions.delete(n);
        continue;
      }
      if (m) {
        if (m[2] === '@' || m[2] === '*') sh.unsetVar(m[1]);
        else sh.unsetElement(m[1], m[2]);
        continue;
      }
      if (!isName(n)) {
        await sh.report(`unset: \`${n}': not a valid identifier`, ctx.io);
        st = 1;
        continue;
      }
      if (!mode && !sh.lookupVar(n) && sh.functions.has(n)) {
        sh.functions.delete(n);
        continue;
      }
      if (mode === 'n') {
        const home = sh.varHome(n);
        home.delete(n);
        continue;
      }
      sh.unsetVar(n);
    } catch (e) {
      if (e instanceof ShellError) {
        await sh.report(`unset: ${e.message}`, ctx.io);
        st = 1;
      } else throw e;
    }
  }
  return st;
}

const SET_FLAGS = { a: 'allexport', b: 'notify', e: 'errexit', f: 'noglob', h: 'hashall', k: 'keyword', m: 'monitor', n: 'noexec', p: 'privileged', t: 'onecmd', u: 'nounset', v: 'verbose', x: 'xtrace', B: 'braceexpand', C: 'noclobber', E: 'errtrace', H: 'histexpand', P: 'physical', T: 'functrace' };

async function setCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args;
  if (!a.length) {
    for (const name of sh.allVarNames()) {
      const v = sh.lookupVar(name);
      if (v && (v.a || v.A)) await ctx.out(`${name}=${sh.declareLine(name, v).replace(/^declare -\S+ [^=]+=/, '')}\n`);
      else {
        const val = sh.getVar(name);
        if (val !== undefined) await ctx.out(`${name}=${val === '' ? "''" : /^[A-Za-z0-9_\/.:,@%+=-]+$/.test(val) ? val : sh.quoteValue(val)}\n`);
      }
    }
    for (const [n, f] of [...sh.functions].sort()) await ctx.out(formatFunction(n, f) + '\n');
    return 0;
  }
  let i = 0;
  for (; i < a.length; i++) {
    const s = a[i];
    if (s === '--') {
      sh.positional = a.slice(i + 1);
      return 0;
    }
    if (s === '-' ) {
      sh.opts.xtrace = false;
      sh.opts.verbose = false;
      if (i + 1 < a.length) sh.positional = a.slice(i + 1);
      return 0;
    }
    if ((s[0] === '-' || s[0] === '+') && s.length > 1) {
      const on = s[0] === '-';
      for (let j = 1; j < s.length; j++) {
        const c = s[j];
        if (c === 'o') {
          const name = a[i + 1];
          if (name === undefined || name.startsWith('-') || name.startsWith('+')) {
            const names = Object.keys(sh.opts).sort();
            for (const k of names) {
              if (on) await ctx.out(`${k.padEnd(15)}\t${sh.opts[k] ? 'on' : 'off'}\n`);
              else await ctx.out(`set ${sh.opts[k] ? '-' : '+'}o ${k}\n`);
            }
            continue;
          }
          i++;
          if (!(name in sh.opts)) {
            await sh.report(`set: ${name}: invalid option name`, ctx.io);
            return 1;
          }
          sh.opts[name] = on;
          if (name === 'vi') sh.opts.emacs = !on;
          if (name === 'emacs') sh.opts.vi = !on;
          continue;
        }
        if (c === 'i') continue;
        const name = SET_FLAGS[c];
        if (!name) {
          await sh.report(`set: ${s[0]}${c}: invalid option`, ctx.io);
          await ctx.err('set: usage: set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]\n');
          return 2;
        }
        sh.opts[name] = on;
      }
      continue;
    }
    sh.positional = a.slice(i);
    return 0;
  }
  return 0;
}

async function shoptCmd(ctx) {
  const sh = ctx.shell;
  let set = null;
  let print = false;
  let quiet = false;
  let useO = false;
  const names = [];
  for (const s of ctx.args) {
    if (/^-[supqo]+$/.test(s)) {
      for (const c of s.slice(1)) {
        if (c === 's') set = true;
        if (c === 'u') set = false;
        if (c === 'p') print = true;
        if (c === 'q') quiet = true;
        if (c === 'o') useO = true;
      }
    } else if (s.startsWith('-')) {
      await sh.report(`shopt: ${s}: invalid option`, ctx.io);
      await ctx.err('shopt: usage: shopt [-pqsu] [-o] [optname ...]\n');
      return 2;
    } else names.push(s);
  }
  const table = useO ? sh.opts : sh.shopt;
  let st = 0;
  const show = async (k) => {
    if (quiet) return;
    if (print || set !== null) await ctx.out(useO ? `set ${table[k] ? '-' : '+'}o ${k}\n` : `shopt ${table[k] ? '-s' : '-u'} ${k}\n`);
    else await ctx.out(`${k.padEnd(useO ? 15 : 23)}\t${table[k] ? 'on' : 'off'}\n`);
  };
  if (!names.length) {
    for (const k of Object.keys(table).sort()) {
      if (set === null || table[k] === set) await show(k);
    }
    return 0;
  }
  for (const k of names) {
    if (!(k in table)) {
      await sh.report(`shopt: ${k}: invalid shell option name`, ctx.io);
      st = 1;
      continue;
    }
    if (set !== null) table[k] = set;
    else {
      if (!table[k]) st = 1;
      await show(k);
    }
  }
  return st;
}

// ---------- cd / pwd / dirs ----------

function logicalJoin(base, p) {
  return abspath(base, p);
}

async function changeDir(sh, target, io, { physical = false, print = false } = {}) {
  const vfs = sh.vfs;
  const pwd = sh.getVar('PWD') || sh.cwd;
  let dest = physical ? null : logicalJoin(pwd, target);
  let node;
  try {
    const r = vfs.lookup(physical ? target : dest, physical ? sh.cwd : '/');
    node = r.node;
    if (node.type !== 'dir') throw new FsError('ENOTDIR', target);
    if (!vfs.can(node, 1)) throw new FsError('EACCES', target);
    if (physical) dest = '/' + r.canon.join('/');
  } catch (e) {
    if (e instanceof FsError) return e;
    throw e;
  }
  sh.setVar('OLDPWD', pwd);
  sh.cwd = dest;
  sh.setVar('PWD', dest);
  if (print) await io[1].write(sh.tildeShort(dest) === dest ? dest + '\n' : dest + '\n');
  return null;
}

async function cdCmd(ctx) {
  const sh = ctx.shell;
  let physical = sh.opts.physical;
  const args = [];
  for (const a of ctx.args) {
    if (a === '-P') physical = true;
    else if (a === '-L') physical = false;
    else if (a === '-e' || a === '-@') {} else if (a.startsWith('-') && a !== '-' && args.length === 0 && a !== '--') {
      await sh.report(`cd: ${a}: invalid option`, ctx.io);
      await ctx.err('cd: usage: cd [-L|[-P [-e]] [-@]] [dir]\n');
      return 2;
    } else if (a !== '--') args.push(a);
  }
  if (args.length > 1) {
    await sh.report('cd: too many arguments', ctx.io);
    return 1;
  }
  let target = args[0];
  let print = false;
  if (target === undefined) {
    target = sh.getVar('HOME');
    if (target === undefined) {
      await sh.report('cd: HOME not set', ctx.io);
      return 1;
    }
    if (target === '') return 0;
  } else if (target === '-') {
    target = sh.getVar('OLDPWD');
    if (target === undefined) {
      await sh.report('cd: OLDPWD not set', ctx.io);
      return 1;
    }
    print = true;
  }
  // CDPATH
  const cdpath = sh.getVar('CDPATH');
  if (cdpath && !target.startsWith('/') && !/^\.\.?(\/|$)/.test(target)) {
    for (const d of cdpath.split(':')) {
      const cand = (d || '.') + '/' + target;
      const e = await changeDir(sh, cand, ctx.io, { physical, print: !!d });
      if (!e) return 0;
    }
  }
  const e = await changeDir(sh, target, ctx.io, { physical, print });
  if (e) {
    if (sh.shopt.cdable_vars && isName(target) && sh.getVar(target)) {
      const e2 = await changeDir(sh, sh.getVar(target), ctx.io, { physical, print: true });
      if (!e2) return 0;
    }
    await sh.report(`cd: ${target}: ${e.message}`, ctx.io);
    return 1;
  }
  return 0;
}

async function pwdCmd(ctx) {
  const sh = ctx.shell;
  let physical = sh.opts.physical;
  for (const a of ctx.args) {
    if (a === '-P') physical = true;
    else if (a === '-L') physical = false;
    else if (a.startsWith('-')) {
      await sh.report(`pwd: ${a}: invalid option`, ctx.io);
      await ctx.err('pwd: usage: pwd [-LP]\n');
      return 2;
    }
  }
  let p = sh.getVar('PWD');
  if (physical || !p) {
    try {
      p = sh.vfs.realpath(sh.cwd, '/');
    } catch {
      p = sh.cwd;
    }
  }
  await ctx.out(p + '\n');
  return 0;
}

async function dirsPrint(ctx, flags = {}) {
  const sh = ctx.shell;
  const stack = [sh.getVar('PWD') || sh.cwd, ...sh.dirstack];
  const fmt = (d) => (flags.l ? d : sh.tildeShort(d));
  if (flags.v) {
    let s = '';
    stack.forEach((d, i) => (s += ` ${String(i).padStart(1)}  ${fmt(d)}\n`));
    await ctx.out(s);
  } else if (flags.p) await ctx.out(stack.map(fmt).join('\n') + '\n');
  else await ctx.out(stack.map(fmt).join(' ') + '\n');
}

async function dirsCmd(ctx) {
  const flags = {};
  for (const a of ctx.args) {
    if (a === '-c') {
      ctx.shell.dirstack = [];
      return 0;
    }
    if (/^-[lpv]+$/.test(a)) for (const c of a.slice(1)) flags[c] = true;
    else if (/^[+-]\d+$/.test(a)) {
      const stack = [ctx.shell.cwd, ...ctx.shell.dirstack];
      const n = parseInt(a.slice(1), 10);
      const d = a[0] === '+' ? stack[n] : stack[stack.length - 1 - n];
      if (d === undefined) {
        await ctx.shell.report(`dirs: ${a}: directory stack index out of range`, ctx.io);
        return 1;
      }
      await ctx.out(ctx.shell.tildeShort(d) + '\n');
      return 0;
    }
  }
  await dirsPrint(ctx, flags);
  return 0;
}

async function pushdCmd(ctx) {
  const sh = ctx.shell;
  const args = ctx.args.filter((a) => a !== '-n');
  const cur = sh.getVar('PWD') || sh.cwd;
  if (!args.length) {
    if (!sh.dirstack.length) {
      await sh.report('pushd: no other directory', ctx.io);
      return 1;
    }
    const top = sh.dirstack[0];
    const e = await changeDir(sh, top, ctx.io);
    if (e) {
      await sh.report(`pushd: ${top}: ${e.message}`, ctx.io);
      return 1;
    }
    sh.dirstack[0] = cur;
    await dirsPrint(ctx);
    return 0;
  }
  const a = args[0];
  if (/^[+-]\d+$/.test(a)) {
    const stack = [cur, ...sh.dirstack];
    const n = parseInt(a.slice(1), 10);
    const k = a[0] === '+' ? n : stack.length - 1 - n;
    if (k < 0 || k >= stack.length) {
      await sh.report(`pushd: ${a}: directory stack index out of range`, ctx.io);
      return 1;
    }
    const rot = stack.slice(k).concat(stack.slice(0, k));
    const e = await changeDir(sh, rot[0], ctx.io);
    if (e) return 1;
    sh.dirstack = rot.slice(1);
    await dirsPrint(ctx);
    return 0;
  }
  const e = await changeDir(sh, a, ctx.io);
  if (e) {
    await sh.report(`pushd: ${a}: ${e.message}`, ctx.io);
    return 1;
  }
  sh.dirstack.unshift(cur);
  await dirsPrint(ctx);
  return 0;
}

async function popdCmd(ctx) {
  const sh = ctx.shell;
  const args = ctx.args.filter((a) => a !== '-n');
  if (!sh.dirstack.length) {
    await sh.report('popd: directory stack empty', ctx.io);
    return 1;
  }
  if (args.length && /^[+-]\d+$/.test(args[0])) {
    const stack = [sh.cwd, ...sh.dirstack];
    const n = parseInt(args[0].slice(1), 10);
    const k = args[0][0] === '+' ? n : stack.length - 1 - n;
    if (k <= 0 || k >= stack.length) {
      if (k === 0) {
        const top = sh.dirstack.shift();
        await changeDir(sh, top, ctx.io);
        await dirsPrint(ctx);
        return 0;
      }
      await sh.report(`popd: ${args[0]}: directory stack index out of range`, ctx.io);
      return 1;
    }
    sh.dirstack.splice(k - 1, 1);
    await dirsPrint(ctx);
    return 0;
  }
  const top = sh.dirstack.shift();
  const e = await changeDir(sh, top, ctx.io);
  if (e) {
    await sh.report(`popd: ${top}: ${e.message}`, ctx.io);
    return 1;
  }
  await dirsPrint(ctx);
  return 0;
}

// ---------- misc builtins ----------

async function echoCmd(ctx) {
  let args = ctx.args.slice();
  let nl = true;
  let esc = ctx.shell.shopt.xpg_echo;
  while (args.length && /^-[neE]+$/.test(args[0])) {
    for (const c of args[0].slice(1)) {
      if (c === 'n') nl = false;
      if (c === 'e') esc = true;
      if (c === 'E') esc = false;
    }
    args.shift();
  }
  let s = args.join(' ');
  if (esc) {
    const r = printfEscapes(s, true);
    s = r.out;
    if (r.stop) {
      await ctx.out(s);
      return 0;
    }
  }
  await ctx.out(nl ? s + '\n' : s);
  return 0;
}

async function printfCmd(ctx) {
  const sh = ctx.shell;
  let args = ctx.args.slice();
  let varName = null;
  if (args[0] === '-v') {
    varName = args[1];
    args = args.slice(2);
    if (!varName || !/^[A-Za-z_][A-Za-z0-9_]*(\[.*\])?$/.test(varName)) {
      await sh.report(`printf: \`${varName}': not a valid identifier`, ctx.io);
      return 2;
    }
  }
  if (args[0] === '--') args.shift();
  if (!args.length) {
    await ctx.err('printf: usage: printf [-v var] format [arguments]\n');
    return 2;
  }
  const { out, errs } = formatPrintf(args[0], args.slice(1), ctx);
  for (const e of errs) await sh.report(`printf: ${e}`, ctx.io);
  if (varName) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(varName);
    if (m) sh.setElement(m[1], m[2], out);
    else sh.setVar(varName, out);
  } else await ctx.out(out);
  return errs.length ? 1 : 0;
}

async function sourceCmd(ctx) {
  const sh = ctx.shell;
  const file = ctx.args[0];
  if (file === undefined) {
    await sh.report(`${ctx.name}: filename argument required`, ctx.io);
    await ctx.err(`${ctx.name}: usage: ${ctx.name} filename [arguments]\n`);
    return 2;
  }
  let path = file;
  if (!file.includes('/') && sh.shopt.sourcepath) {
    for (const d of (sh.getVar('PATH') || '').split(':')) {
      const p = (d || '.') + '/' + file;
      try {
        if (sh.vfs.stat(p, sh.cwd).type === 'file') {
          path = p;
          break;
        }
      } catch {}
    }
  }
  let text;
  try {
    const n = sh.vfs.stat(path, sh.cwd);
    if (n.type === 'dir') throw new FsError('EISDIR', file);
    text = sh.vfs.readFile(path, sh.cwd);
  } catch (e) {
    if (e instanceof FsError) {
      await sh.report(`${file}: ${e.message}`, ctx.io);
      return 1;
    }
    throw e;
  }
  const savedPos = sh.positional;
  if (ctx.args.length > 1) sh.positional = ctx.args.slice(1);
  sh.sourceStack.push(file);
  const savedScript = sh.scriptName;
  if (!sh.interactive) sh.scriptName = file;
  try {
    return await sh.runSource(text, ctx.io);
  } catch (e) {
    if (e instanceof ReturnEx) return e.code;
    throw e;
  } finally {
    sh.scriptName = savedScript;
    sh.sourceStack.pop();
    if (ctx.args.length > 1) sh.positional = savedPos;
  }
}

async function evalCmd(ctx) {
  const src = ctx.args.join(' ');
  if (!src.trim()) return 0;
  return ctx.shell.runSource(src, ctx.io);
}

async function execCmd(ctx) {
  const sh = ctx.shell;
  let args = ctx.args.slice();
  while (args.length && /^-[cla]$/.test(args[0])) args.shift();
  if (!args.length) {
    // make redirections permanent
    if (sh.parentIo) Object.assign(sh.parentIo, ctx.io);
    if (sh.baseIo) Object.assign(sh.baseIo, ctx.io);
    return 0;
  }
  if (sh.interactive && /^(bash|sh|-bash)$/.test(args[0].split('/').pop())) {
    throw new ExitEx({ restart: true, code: 0 });
  }
  const st = await sh.runCommand(args, ctx.io, { skipFunctions: true });
  throw new ExitEx(st);
}

async function exitCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args[0];
  let code = sh.status;
  if (a !== undefined) {
    if (!/^[+-]?\d+$/.test(a.trim())) {
      if (sh.interactive) await ctx.err('exit\n');
      await sh.report(`${ctx.name}: ${a}: numeric argument required`, ctx.io);
      throw new ExitEx(2);
    }
    if (ctx.args.length > 1) {
      if (sh.interactive) await ctx.err('exit\n');
      await sh.report(`${ctx.name}: too many arguments`, ctx.io);
      return 1;
    }
    code = ((parseInt(a, 10) % 256) + 256) % 256;
  }
  if (sh.interactive) {
    const running = sh.jobs.filter((j) => j.state === 'Running');
    if (running.length && !sh.exitWarned) {
      sh.exitWarned = true;
      await ctx.err('There are running jobs.\n');
      return 1;
    }
    await ctx.err(ctx.name === 'logout' ? 'logout\n' : 'exit\n');
  }
  throw new ExitEx(code);
}

async function returnCmd(ctx) {
  const sh = ctx.shell;
  if (!sh.funcStack.length && sh.sourceStack.length <= (sh.scriptName ? 1 : 0) && !sh.inTrap) {
    await sh.report('return: can only `return\' from a function or sourced script', ctx.io);
    return 1;
  }
  const a = ctx.args[0];
  let code = sh.status;
  if (a !== undefined) {
    if (!/^[+-]?\d+$/.test(a.trim())) {
      await sh.report(`return: ${a}: numeric argument required`, ctx.io);
      code = 2;
    } else code = ((parseInt(a, 10) % 256) + 256) % 256;
  }
  throw new ReturnEx(code);
}

function loopCtl(kind) {
  return async (ctx) => {
    const sh = ctx.shell;
    let n = 1;
    if (ctx.args[0] !== undefined) {
      if (!/^\d+$/.test(ctx.args[0])) {
        await sh.report(`${kind}: ${ctx.args[0]}: numeric argument required`, ctx.io);
        n = 1;
        if (!sh.loopDepth) return 128;
      } else n = parseInt(ctx.args[0], 10);
      if (n < 1) {
        await sh.report(`${kind}: ${ctx.args[0]}: loop count out of range`, ctx.io);
        return 1;
      }
    }
    if (!sh.loopDepth) {
      await sh.report(`${kind}: only meaningful in a \`for', \`while', or \`until' loop`, ctx.io);
      return 0;
    }
    n = Math.min(n, sh.loopDepth);
    throw kind === 'break' ? new BreakEx(n) : new ContinueEx(n);
  };
}

async function shiftCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args[0];
  let n = 1;
  if (a !== undefined) {
    if (!/^\d+$/.test(a)) {
      await sh.report(`shift: ${a}: numeric argument required`, ctx.io);
      return 1;
    }
    n = parseInt(a, 10);
  }
  if (n > sh.positional.length) {
    if (sh.shopt.shift_verbose) await sh.report(`shift: ${n}: shift count out of range`, ctx.io);
    return 1;
  }
  sh.positional = sh.positional.slice(n);
  return 0;
}

async function aliasCmd(ctx) {
  const sh = ctx.shell;
  let args = ctx.args.slice();
  if (args[0] === '-p') args.shift();
  const show = (k) => ctx.out(`alias ${k}=${sh.quoteValue(sh.aliases.get(k))}\n`);
  if (!args.length) {
    for (const k of [...sh.aliases.keys()].sort()) await show(k);
    return 0;
  }
  let st = 0;
  for (const a of args) {
    const i = a.indexOf('=');
    if (i > 0) {
      const name = a.slice(0, i);
      if (/[\s'"\\$`=/|&;<>()]/.test(name)) {
        await sh.report(`alias: \`${name}': invalid alias name`, ctx.io);
        st = 1;
        continue;
      }
      sh.aliases.set(name, a.slice(i + 1));
    } else if (sh.aliases.has(a)) await show(a);
    else {
      await sh.report(`alias: ${a}: not found`, ctx.io);
      st = 1;
    }
  }
  return st;
}

async function unaliasCmd(ctx) {
  const sh = ctx.shell;
  if (ctx.args[0] === '-a') {
    sh.aliases.clear();
    return 0;
  }
  if (!ctx.args.length) {
    await ctx.err('unalias: usage: unalias [-a] name [name ...]\n');
    return 2;
  }
  let st = 0;
  for (const a of ctx.args) {
    if (!sh.aliases.delete(a)) {
      await sh.report(`unalias: ${a}: not found`, ctx.io);
      st = 1;
    }
  }
  return st;
}

async function typeCmd(ctx) {
  const sh = ctx.shell;
  let flags = { t: false, a: false, p: false, P: false, f: false };
  const names = [];
  for (const a of ctx.args) {
    if (/^-[tapPf]+$/.test(a)) for (const c of a.slice(1)) flags[c] = true;
    else if (a === '--') continue;
    else names.push(a);
  }
  let st = 0;
  for (const n of names) {
    const found = [];
    if (!flags.P) {
      if (sh.aliases.has(n) && !flags.p) found.push(['alias', `${n} is aliased to \`${sh.aliases.get(n)}'`]);
      if (RESERVED_WORDS.has(n) && !flags.p) found.push(['keyword', `${n} is a shell keyword`]);
      if (sh.functions.has(n) && !flags.f && !flags.p) found.push(['function', `${n} is a function\n${formatFunction(n, sh.functions.get(n))}`]);
      const c = sh.commands.get(n);
      if (c && c.builtin && !flags.p) found.push(['builtin', `${n} is a shell builtin`]);
    }
    if (found.length && !flags.a && !flags.P) {
      // first one only
    }
    const paths = [];
    if (n.includes('/')) {
      if (sh.vfs.exists(n, sh.cwd)) paths.push(n);
    } else {
      if (sh.hash.has(n) && !flags.a) paths.push(sh.hash.get(n));
      for (const d of (sh.getVar('PATH') || '').split(':')) {
        const p = (d || '.') + '/' + n;
        try {
          const node = sh.vfs.stat(p, sh.cwd);
          if (node.type === 'file' && node.mode & 0o111 && !paths.includes(p)) paths.push(p);
        } catch {}
      }
    }
    for (const p of paths) found.push(['file', sh.hash.get(n) === p && !flags.a ? `${n} is hashed (${p})` : `${n} is ${p}`, p]);
    if (!found.length) {
      if (!flags.t && !flags.p && !flags.P) await sh.report(`type: ${n}: not found`, ctx.io);
      st = 1;
      continue;
    }
    const list = flags.a ? found : [found[0]];
    for (const [kind, msg, p] of list) {
      if (flags.t) await ctx.out(kind + '\n');
      else if (flags.p || flags.P) {
        if (kind === 'file') await ctx.out(p + '\n');
      } else await ctx.out(msg + '\n');
    }
  }
  return st;
}

async function commandCmd(ctx) {
  const sh = ctx.shell;
  let args = ctx.args.slice();
  let v = false;
  let V = false;
  while (args.length && /^-[pvV]+$/.test(args[0])) {
    if (args[0].includes('v')) v = true;
    if (args[0].includes('V')) V = true;
    args.shift();
  }
  if (args[0] === '--') args.shift();
  if (!args.length) return 0;
  if (v || V) {
    let st = 0;
    for (const n of args) {
      if (V) {
        const r = await typeCmd({ ...ctx, args: [n], name: 'type' });
        if (r) st = 1;
        continue;
      }
      if (sh.aliases.has(n)) await ctx.out(`alias ${n}=${sh.quoteValue(sh.aliases.get(n))}\n`);
      else if (RESERVED_WORDS.has(n) || sh.functions.has(n) || sh.commands.get(n)?.builtin) await ctx.out(n + '\n');
      else {
        const p = sh.findInPath(n);
        if (p) await ctx.out((p.startsWith('/') ? p : p) + '\n');
        else st = 1;
      }
    }
    return st;
  }
  return sh.runCommand(args, ctx.io, { skipFunctions: true });
}

async function builtinCmd(ctx) {
  if (!ctx.args.length) return 0;
  const sh = ctx.shell;
  const c = sh.commands.get(ctx.args[0]);
  if (!c || !c.builtin) {
    await sh.report(`builtin: ${ctx.args[0]}: not a shell builtin`, ctx.io);
    return 1;
  }
  return sh.runCommand(ctx.args, ctx.io, { skipFunctions: true, onlyBuiltin: true });
}

async function hashCmd(ctx) {
  const sh = ctx.shell;
  const args = ctx.args;
  if (args[0] === '-r') {
    sh.hash.clear();
    return 0;
  }
  if (!args.length || args[0] === '-l') {
    if (!sh.hash.size) {
      await ctx.out('hash: hash table empty\n');
      return 0;
    }
    await ctx.out('hits\tcommand\n');
    for (const [k, p] of sh.hash) await ctx.out(`   1\t${p}\n`);
    return 0;
  }
  let st = 0;
  for (const n of args.filter((a) => !a.startsWith('-'))) {
    const p = sh.findInPath(n);
    if (p) sh.hash.set(n, p);
    else {
      await sh.report(`hash: ${n}: not found`, ctx.io);
      st = 1;
    }
  }
  return st;
}

async function historyCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args;
  if (a[0] === '-c') {
    sh.history.length = 0;
    sh.histBase = 1;
    return 0;
  }
  if (a[0] === '-d') {
    const n = parseInt(a[1], 10);
    const idx = n < 0 ? sh.history.length + n : n - sh.histBase;
    if (isNaN(n) || idx < 0 || idx >= sh.history.length) {
      await sh.report(`history: ${a[1]}: history position out of range`, ctx.io);
      return 1;
    }
    sh.history.splice(idx, 1);
    return 0;
  }
  if (a[0] === '-w' || a[0] === '-a') {
    const f = a[1] || sh.getVar('HISTFILE') || `${sh.getVar('HOME')}/.bash_history`;
    try {
      sh.vfs.writeFile(f, sh.cwd, sh.history.join('\n') + '\n', { umask: sh.umask });
    } catch (e) {
      await sh.report(`history: ${f}: ${e.message}`, ctx.io);
      return 1;
    }
    return 0;
  }
  if (a[0] === '-r') {
    const f = a[1] || sh.getVar('HISTFILE') || `${sh.getVar('HOME')}/.bash_history`;
    try {
      sh.history.push(...sh.vfs.readFile(f, sh.cwd).split('\n').filter(Boolean));
    } catch (e) {
      await sh.report(`history: ${f}: ${e.message}`, ctx.io);
      return 1;
    }
    return 0;
  }
  if (a[0] === '-s') {
    sh.history.push(a.slice(1).join(' '));
    return 0;
  }
  if (a[0] === '-p') {
    for (const x of a.slice(1)) await ctx.out(sh.historyExpand(x).line + '\n');
    return 0;
  }
  let n = sh.history.length;
  if (a[0] !== undefined) {
    if (!/^\d+$/.test(a[0])) {
      await sh.report(`history: ${a[0]}: numeric argument required`, ctx.io);
      return 1;
    }
    n = Math.min(n, parseInt(a[0], 10));
  }
  const start = sh.history.length - n;
  const tf = sh.getVar('HISTTIMEFORMAT');
  let out = '';
  for (let i = start; i < sh.history.length; i++) {
    const ts = tf ? sh.commands.get('date').format(new Date(), tf) : '';
    out += `${String(i + sh.histBase).padStart(5)}  ${ts}${sh.history[i]}\n`;
  }
  await ctx.out(out);
  return 0;
}

async function fcCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args;
  if (a[0] === '-l' || a[0] === '-ln' || a[0] === '-nl') {
    const n = sh.history.length;
    const start = Math.max(0, n - 17);
    for (let i = start; i < n - 1; i++) await ctx.out(a[0] === '-l' ? `${i + sh.histBase}\t ${sh.history[i]}\n` : `\t ${sh.history[i]}\n`);
    return 0;
  }
  if (a[0] === '-s') {
    let rest = a.slice(1);
    let sub = null;
    if (rest[0] && rest[0].includes('=')) sub = rest.shift().split('=');
    let cmd = null;
    const hist = sh.history.slice(0, -1);
    if (rest[0] === undefined) cmd = hist[hist.length - 1];
    else if (/^-?\d+$/.test(rest[0])) {
      const n = parseInt(rest[0], 10);
      cmd = n < 0 ? hist[hist.length + n] : hist[n - sh.histBase];
    } else for (let i = hist.length - 1; i >= 0; i--) if (hist[i].startsWith(rest[0])) {
      cmd = hist[i];
      break;
    }
    if (!cmd) {
      await sh.report('fc: no command found', ctx.io);
      return 1;
    }
    if (sub) cmd = cmd.split(sub[0]).join(sub[1]);
    await ctx.err(cmd + '\n');
    sh.history[sh.history.length - 1] = cmd;
    return sh.runSource(cmd, ctx.io);
  }
  await sh.report('fc: editing history in an editor is not supported here; use fc -l or fc -s', ctx.io);
  return 1;
}

async function jobsCmd(ctx) {
  const sh = ctx.shell;
  let l = false;
  let p = false;
  let r = false;
  let s = false;
  const specs = [];
  for (const a of ctx.args) {
    if (/^-[lprsn]+$/.test(a)) {
      l ||= a.includes('l');
      p ||= a.includes('p');
      r ||= a.includes('r');
      s ||= a.includes('s');
    } else specs.push(a);
  }
  const n = sh.jobs.length;
  let jobs = sh.jobs.map((j, i) => [j, i === n - 1 ? '+' : i === n - 2 ? '-' : ' ']);
  if (specs.length) {
    const sel = [];
    for (const sp of specs) {
      const j = sh.findJob(sp);
      if (!j) {
        await sh.report(`jobs: ${sp}: no such job`, ctx.io);
        return 1;
      }
      sel.push(jobs.find((x) => x[0] === j));
    }
    jobs = sel;
  }
  for (const [j, mark] of jobs) {
    if (r && j.state !== 'Running') continue;
    if (s && j.state !== 'Stopped') continue;
    if (p) await ctx.out(j.pid + '\n');
    else await ctx.out(sh.jobLine(j, mark, l) + '\n');
    if (j.state !== 'Running') j.notified = true;
  }
  sh.jobs = sh.jobs.filter((j) => !j.notified);
  return 0;
}

async function fgCmd(ctx) {
  const sh = ctx.shell;
  const j = sh.findJob(ctx.args[0]);
  if (!j) {
    await sh.report(`${ctx.name}: ${ctx.args[0] || 'current'}: no such job`, ctx.io);
    return 1;
  }
  if (ctx.name === 'bg') {
    await sh.report(`bg: job ${j.id} already in background`, ctx.io);
    return 0;
  }
  await ctx.out(j.text + '\n');
  const onInt = () => j.shell.interrupt(sh.ctl.sig || 'INT');
  sh.ctl.onInterrupt = sh.ctl.onInterrupt || new Set();
  sh.ctl.onInterrupt.add(onInt);
  try {
    const st = await j.promise;
    sh.jobs = sh.jobs.filter((x) => x !== j);
    return st;
  } finally {
    sh.ctl.onInterrupt.delete(onInt);
  }
}

async function waitCmd(ctx) {
  const sh = ctx.shell;
  const args = ctx.args.filter((a) => !a.startsWith('-'));
  const anyOne = ctx.args.includes('-n');
  if (!args.length) {
    if (anyOne) {
      const running = sh.jobs.filter((j) => j.state === 'Running');
      if (!running.length) return 127;
      const st = await Promise.race(running.map((j) => j.promise));
      return st;
    }
    let st = 0;
    for (const j of sh.jobs.slice()) st = await j.promise;
    sh.jobs = sh.jobs.filter((j) => j.state === 'Running');
    return 0;
  }
  let st = 0;
  for (const a of args) {
    const j = sh.findJob(a.startsWith('%') ? a : a);
    if (!j) {
      await sh.report(`wait: pid ${a} is not a child of this shell`, ctx.io);
      st = 127;
      continue;
    }
    st = await j.promise;
    sh.jobs = sh.jobs.filter((x) => x !== j);
  }
  return st;
}

function sigNum(s) {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const n = s.toUpperCase().replace(/^SIG/, '');
  const i = SIGNALS.indexOf(n);
  return i > 0 ? i : -1;
}

async function killCmd(ctx) {
  const sh = ctx.shell;
  let args = ctx.args.slice();
  let sig = 15;
  if (!args.length) {
    await ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n');
    return 2;
  }
  if (args[0] === '-l' || args[0] === '-L') {
    if (args[1]) {
      for (const a of args.slice(1)) {
        if (/^\d+$/.test(a)) {
          const n = parseInt(a, 10);
          await ctx.out((SIGNALS[n > 128 ? n - 128 : n] || '?') + '\n');
        } else await ctx.out(sigNum(a) + '\n');
      }
      return 0;
    }
    const names = [];
    for (let i = 1; i < SIGNALS.length; i++) names.push(`${String(i).padStart(2)}) SIG${SIGNALS[i]}`);
    const rt = ['RTMIN', 'RTMIN+1', 'RTMIN+2', 'RTMIN+3', 'RTMIN+4', 'RTMIN+5', 'RTMIN+6', 'RTMIN+7', 'RTMIN+8', 'RTMIN+9', 'RTMIN+10', 'RTMIN+11', 'RTMIN+12', 'RTMIN+13', 'RTMIN+14', 'RTMIN+15', 'RTMAX-14', 'RTMAX-13', 'RTMAX-12', 'RTMAX-11', 'RTMAX-10', 'RTMAX-9', 'RTMAX-8', 'RTMAX-7', 'RTMAX-6', 'RTMAX-5', 'RTMAX-4', 'RTMAX-3', 'RTMAX-2', 'RTMAX-1', 'RTMAX'];
    rt.forEach((n, k) => names.push(`${34 + k}) SIG${n}`));
    let out = '';
    names.forEach((n, k) => (out += n + ((k + 1) % 5 === 0 || k === names.length - 1 ? '\n' : '\t')));
    await ctx.out(out);
    return 0;
  }
  if (args[0] === '-s' || args[0] === '-n') {
    sig = sigNum(args[1] || '');
    args = args.slice(2);
  } else if (/^-/.test(args[0]) && args[0] !== '--') {
    sig = sigNum(args[0].slice(1));
    args = args.slice(1);
  }
  if (args[0] === '--') args.shift();
  if (sig < 0) {
    await sh.report(`kill: ${ctx.args[0].replace(/^-[sn]?/, '')}: invalid signal specification`, ctx.io);
    return 1;
  }
  let st = 0;
  for (const a of args) {
    const job = a.startsWith('%') ? sh.findJob(a) : sh.jobs.find((j) => j.pid === Number(a));
    if (a.startsWith('%') && !job) {
      await sh.report(`kill: ${a}: no such job`, ctx.io);
      st = 1;
      continue;
    }
    if (job) {
      if (sig !== 0 && job.state === 'Running') job.shell.interrupt(SIGNALS[sig] || 'TERM');
      continue;
    }
    if (!/^-?\d+$/.test(a)) {
      await sh.report(`kill: ${a}: arguments must be process or job IDs`, ctx.io);
      st = 1;
      continue;
    }
    const pid = Number(a);
    if (pid === sh.rootPid || pid === sh.pid) {
      if (sig === 9 || (sig === 1 && sh.interactive)) throw new ExitEx({ restart: true, code: 128 + sig, killed: true });
      if (!sh.interactive && sig !== 0 && sig !== 28 && sig !== 17) throw new ExitEx(128 + sig);
      continue;
    }
    const p = sh.system.procs.get(pid);
    if (!p) {
      await sh.report(`kill: (${pid}) - No such process`, ctx.io);
      st = 1;
      continue;
    }
    if (p.user !== sh.system.userName(sh.vfs.cred.uid) && sh.vfs.cred.uid !== 0) {
      await sh.report(`kill: (${pid}) - Operation not permitted`, ctx.io);
      st = 1;
      continue;
    }
    if (sig !== 0) {
      if (p.pid === 1) continue;
      sh.system.procs.delete(pid);
    }
  }
  return st;
}

async function trapCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args.slice();
  if (a[0] === '-l') {
    return killCmd({ ...ctx, args: ['-l'] });
  }
  const norm = (s) => {
    if (/^\d+$/.test(s)) return s === '0' ? 'EXIT' : SIGNALS[parseInt(s, 10)];
    const u = s.toUpperCase().replace(/^SIG/, '');
    if (['EXIT', 'ERR', 'DEBUG', 'RETURN'].includes(u)) return u;
    return SIGNALS.includes(u) ? u : null;
  };
  if (!a.length || a[0] === '-p') {
    const sigs = a[0] === '-p' && a.length > 1 ? a.slice(1).map(norm) : Object.keys(sh.traps);
    for (const k of sigs) {
      if (sh.traps[k] === undefined) continue;
      await ctx.out(`trap -- ${sh.quoteValue(sh.traps[k])} ${k === 'EXIT' || k === 'ERR' || k === 'DEBUG' || k === 'RETURN' ? k : 'SIG' + k}\n`);
    }
    return 0;
  }
  if (a[0] === '--') a.shift();
  let action = a[0];
  let sigs = a.slice(1);
  if (sigs.length === 0 || /^\d+$/.test(action)) {
    if (/^\d+$/.test(action) || action === '-') {
      sigs = action === '-' ? sigs : a;
      action = '-';
    } else {
      sigs = [action];
      action = '-';
    }
  }
  let st = 0;
  for (const s of sigs) {
    const k = norm(s);
    if (!k) {
      await sh.report(`trap: ${s}: invalid signal specification`, ctx.io);
      st = 1;
      continue;
    }
    if (action === '-') delete sh.traps[k];
    else sh.traps[k] = action;
  }
  return st;
}

async function umaskCmd(ctx) {
  const sh = ctx.shell;
  let sym = false;
  let pmode = false;
  const args = [];
  for (const a of ctx.args) {
    if (a === '-S') sym = true;
    else if (a === '-p') pmode = true;
    else args.push(a);
  }
  const symStr = (m) => {
    const f = (bits) => (bits & 4 ? 'r' : '') + (bits & 2 ? 'w' : '') + (bits & 1 ? 'x' : '');
    const p = ~m & 0o777;
    return `u=${f((p >> 6) & 7)},g=${f((p >> 3) & 7)},o=${f(p & 7)}`;
  };
  if (!args.length) {
    if (sym) await ctx.out(symStr(sh.umask) + '\n');
    else await ctx.out((pmode ? 'umask ' : '') + sh.umask.toString(8).padStart(4, '0') + '\n');
    return 0;
  }
  const v = args[0];
  if (/^[0-7]+$/.test(v)) {
    sh.umask = parseInt(v, 8) & 0o777;
    return 0;
  }
  // symbolic
  let perm = ~sh.umask & 0o777;
  for (const clause of v.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwx]*)$/.exec(clause);
    if (!m) {
      await sh.report(`umask: \`${clause.slice(-1)}': invalid symbolic mode operator`, ctx.io);
      return 1;
    }
    const who = m[1] || 'a';
    let bits = 0;
    for (const c of m[3]) bits |= c === 'r' ? 4 : c === 'w' ? 2 : 1;
    for (const w of who === 'a' ? 'ugo' : who) {
      const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
      if (m[2] === '+') perm |= bits << shift;
      else if (m[2] === '-') perm &= ~(bits << shift);
      else perm = (perm & ~(7 << shift)) | (bits << shift);
    }
  }
  sh.umask = ~perm & 0o777;
  return 0;
}

async function ulimitCmd(ctx) {
  const table = [
    ['c', 'core file size', 'blocks', '0'],
    ['d', 'data seg size', 'kbytes', 'unlimited'],
    ['e', 'scheduling priority', '', '0'],
    ['f', 'file size', 'blocks', 'unlimited'],
    ['i', 'pending signals', '', '31581'],
    ['l', 'max locked memory', 'kbytes', '1021732'],
    ['m', 'max memory size', 'kbytes', 'unlimited'],
    ['n', 'open files', '', '1024'],
    ['p', 'pipe size', '512 bytes', '8'],
    ['q', 'POSIX message queues', 'bytes', '819200'],
    ['r', 'real-time priority', '', '0'],
    ['s', 'stack size', 'kbytes', '8192'],
    ['t', 'cpu time', 'seconds', 'unlimited'],
    ['u', 'max user processes', '', '31581'],
    ['v', 'virtual memory', 'kbytes', 'unlimited'],
    ['x', 'file locks', '', 'unlimited'],
  ];
  const sh = ctx.shell;
  sh.ulimits = sh.ulimits || {};
  if (ctx.args.includes('-a')) {
    for (const [c, d, u, v] of table) {
      const label = `${d}${u ? ` (${u}, -${c})` : ` (-${c})`}`;
      await ctx.out(`${label.padEnd(32)}${sh.ulimits[c] ?? v}\n`);
    }
    return 0;
  }
  let flag = 'f';
  let val = null;
  for (const a of ctx.args) {
    if (/^-[SH]*[a-z]$/.test(a)) flag = a.slice(-1);
    else if (/^-[SH]+$/.test(a)) continue;
    else val = a;
  }
  const row = table.find((r) => r[0] === flag);
  if (val === null) await ctx.out((sh.ulimits[flag] ?? (row ? row[3] : 'unlimited')) + '\n');
  else sh.ulimits[flag] = val;
  return 0;
}

async function getoptsCmd(ctx) {
  const sh = ctx.shell;
  const [optstring, name, ...rest] = ctx.args;
  if (optstring === undefined || name === undefined) {
    await ctx.err('getopts: usage: getopts optstring name [arg ...]\n');
    return 2;
  }
  const args = rest.length ? rest : sh.positional;
  let optind = parseInt(sh.getVar('OPTIND') || '1', 10);
  if (optind < 1) optind = 1;
  if (sh._getoptsInd !== optind) {
    sh._getoptsPos = 1;
  }
  const silent = optstring.startsWith(':');
  const spec = silent ? optstring.slice(1) : optstring;
  const arg = args[optind - 1];
  const finish = () => {
    sh.setVar(name, '?');
    sh._getoptsInd = optind;
    sh.setVar('OPTIND', String(optind));
    return 1;
  };
  if (arg === undefined || !arg.startsWith('-') || arg === '-') return finish();
  if (arg === '--') {
    optind++;
    return finish();
  }
  let pos = sh._getoptsPos || 1;
  const c = arg[pos];
  pos++;
  const advance = () => {
    if (pos >= arg.length) {
      optind++;
      pos = 1;
    }
  };
  const idx = spec.indexOf(c);
  if (idx < 0 || c === ':') {
    advance();
    if (silent) {
      sh.setVar(name, '?');
      sh.setVar('OPTARG', c);
    } else {
      await sh.report(`illegal option -- ${c}`, ctx.io).catch(() => {});
      sh.setVar(name, '?');
      sh.unsetVar('OPTARG');
    }
  } else if (spec[idx + 1] === ':') {
    if (pos < arg.length) {
      sh.setVar('OPTARG', arg.slice(pos));
      optind++;
      pos = 1;
      sh.setVar(name, c);
    } else if (args[optind] !== undefined) {
      sh.setVar('OPTARG', args[optind]);
      optind += 2;
      pos = 1;
      sh.setVar(name, c);
    } else {
      optind++;
      pos = 1;
      if (silent) {
        sh.setVar(name, ':');
        sh.setVar('OPTARG', c);
      } else {
        await sh.report(`option requires an argument -- ${c}`, ctx.io);
        sh.setVar(name, '?');
        sh.unsetVar('OPTARG');
      }
    }
  } else {
    sh.setVar(name, c);
    sh.unsetVar('OPTARG');
    advance();
  }
  sh._getoptsPos = pos;
  sh._getoptsInd = optind;
  sh.setVar('OPTIND', String(optind));
  return 0;
}

async function letCmd(ctx) {
  const sh = ctx.shell;
  if (!ctx.args.length) {
    await sh.report('let: expression expected', ctx.io);
    return 1;
  }
  let v = 0n;
  for (const a of ctx.args) {
    try {
      v = sh.evalArith(a);
    } catch (e) {
      await sh.report(`let: ${e.message}`, ctx.io);
      return 1;
    }
  }
  return v !== 0n ? 0 : 1;
}

async function timesCmd(ctx) {
  const s = (Date.now() - ctx.shell.startTime) / 1000;
  const f = (x) => `${Math.floor(x / 60)}m${(x % 60).toFixed(3)}s`;
  await ctx.out(`${f(s * 0.004)} ${f(s * 0.002)}\n${f(s * 0.01)} ${f(s * 0.003)}\n`);
  return 0;
}

async function callerCmd(ctx) {
  const sh = ctx.shell;
  if (!sh.funcStack.length) return 1;
  const n = parseInt(ctx.args[0] || '0', 10);
  const fs = [...sh.funcStack].reverse();
  const caller = fs[n + 1] || 'main';
  if (ctx.args.length) await ctx.out(`${sh.lineno} ${caller} ${sh.scriptName || 'main'}\n`);
  else await ctx.out(`${sh.lineno} ${sh.scriptName || 'NULL'}\n`);
  return 0;
}

async function compgenCmd(ctx) {
  const sh = ctx.shell;
  const a = ctx.args;
  const actions = new Set();
  let words = null;
  let prefix = '';
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    if (s === '-W') words = a[++i];
    else if (s === '-A') actions.add(a[++i]);
    else if (/^-[a-z]+$/i.test(s)) for (const c of s.slice(1)) actions.add({ a: 'alias', b: 'builtin', c: 'command', d: 'directory', e: 'export', f: 'file', g: 'group', j: 'job', k: 'keyword', u: 'user', v: 'variable' }[c] || c);
    else prefix = s;
  }
  const out = new Set();
  const add = (x) => {
    if (x.startsWith(prefix)) out.add(x);
  };
  for (const act of actions) {
    if (act === 'alias') sh.aliases.forEach((v, k) => add(k));
    if (act === 'builtin' || act === 'command') sh.commands.forEach((v, k) => v.builtin && add(k));
    if (act === 'keyword' || act === 'command') RESERVED_WORDS.forEach(add);
    if (act === 'function' || act === 'command') sh.functions.forEach((v, k) => add(k));
    if (act === 'command') {
      sh.aliases.forEach((v, k) => add(k));
      for (const d of (sh.getVar('PATH') || '').split(':')) {
        try {
          for (const n of sh.vfs.readdir(d || '.', sh.cwd)) add(n);
        } catch {}
      }
    }
    if (act === 'variable') sh.allVarNames().forEach(add);
    if (act === 'export') Object.keys(sh.exportedEnv()).forEach(add);
    if (act === 'user') sh.system.users().forEach((u) => add(u.name));
    if (act === 'group') sh.system.groups().forEach((g) => add(g.name));
    if (act === 'job') sh.jobs.forEach((j) => add(j.text.split(' ')[0]));
    if (act === 'file' || act === 'directory') {
      const i = prefix.lastIndexOf('/');
      const dir = i >= 0 ? prefix.slice(0, i + 1) : '';
      try {
        for (const n of sh.vfs.readdir(dir || '.', sh.cwd)) {
          if (n.startsWith('.') && !prefix.slice(i + 1).startsWith('.')) continue;
          const full = dir + n;
          if (act === 'directory') {
            try {
              if (sh.vfs.stat(full, sh.cwd).type !== 'dir') continue;
            } catch {
              continue;
            }
          }
          add(full);
        }
      } catch {}
    }
  }
  if (words !== null) for (const w of await sh.expandWords([words])) for (const x of w.split(/\s+/)) if (x) add(x);
  if (!out.size) return 1;
  await ctx.out([...out].sort().join('\n') + '\n');
  return 0;
}

const HELP = {
  ':': ': [arguments]\n    Null command. No effect; the command does nothing. Exit Status: Always succeeds.',
  '.': '. filename [arguments]\n    Execute commands from a file in the current shell.',
  '[': '[ arg... ]\n    Evaluate conditional expression. This is a synonym for the "test" builtin, but the last argument must be a literal `]\'.',
  '[[': '[[ expression ]]\n    Execute conditional command. Returns 0 or 1 depending on the evaluation of EXPRESSION.',
  alias: 'alias [-p] [name[=value] ... ]\n    Define or display aliases.',
  bg: 'bg [job_spec ...]\n    Move jobs to the background.',
  bind: 'bind [-lpsvPSVX] ...\n    Set Readline key bindings and variables.',
  break: 'break [n]\n    Exit for, while, or until loops.',
  builtin: 'builtin [shell-builtin [arg ...]]\n    Execute shell builtins.',
  caller: 'caller [expr]\n    Return the context of the current subroutine call.',
  case: 'case WORD in [PATTERN [| PATTERN]...) COMMANDS ;;]... esac\n    Execute commands based on pattern matching.',
  cd: 'cd [-L|[-P [-e]] [-@]] [dir]\n    Change the shell working directory.',
  command: 'command [-pVv] command [arg ...]\n    Execute a simple command or display information about commands.',
  compgen: 'compgen [-abcdefgjksuv] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [word]\n    Display possible completions depending on the options.',
  complete: 'complete [-abcdefgjksuv] [-pr] [-DEI] [-o option] [-A action] [-G globpat] [-W wordlist] [-F function] [-C command] [-X filterpat] [-P prefix] [-S suffix] [name ...]\n    Specify how arguments are to be completed by Readline.',
  continue: 'continue [n]\n    Resume for, while, or until loops.',
  declare: 'declare [-aAfFgiIlnrtux] [name[=value] ...] or declare -p [-aAfFilnrtux] [name ...]\n    Set variable values and attributes.',
  dirs: 'dirs [-clpv] [+N] [-N]\n    Display directory stack.',
  disown: 'disown [-h] [-ar] [jobspec ... | pid ...]\n    Remove jobs from current shell.',
  echo: 'echo [-neE] [arg ...]\n    Write arguments to the standard output.',
  enable: 'enable [-a] [-dnps] [-f filename] [name ...]\n    Enable and disable shell builtins.',
  eval: 'eval [arg ...]\n    Execute arguments as a shell command.',
  exec: 'exec [-cl] [-a name] [command [argument ...]] [redirection ...]\n    Replace the shell with the given command.',
  exit: 'exit [n]\n    Exit the shell.',
  export: 'export [-fn] [name[=value] ...] or export -p\n    Set export attribute for shell variables.',
  false: 'false\n    Return an unsuccessful result.',
  fc: 'fc [-e ename] [-lnr] [first] [last] or fc -s [pat=rep] [command]\n    Display or execute commands from the history list.',
  fg: 'fg [job_spec]\n    Move job to the foreground.',
  for: 'for NAME [in WORDS ... ] ; do COMMANDS; done\n    Execute commands for each member in a list.\n\nfor (( exp1; exp2; exp3 )); do COMMANDS; done\n    Arithmetic for loop.',
  function: 'function name { COMMANDS ; } or name () { COMMANDS ; }\n    Define shell function.',
  getopts: 'getopts optstring name [arg ...]\n    Parse option arguments.',
  hash: 'hash [-lr] [-p pathname] [-dt] [name ...]\n    Remember or display program locations.',
  help: 'help [-dms] [pattern ...]\n    Display information about builtin commands.',
  history: 'history [-c] [-d offset] [n] or history -anrw [filename] or history -ps arg [arg...]\n    Display or manipulate the history list.',
  if: 'if COMMANDS; then COMMANDS; [ elif COMMANDS; then COMMANDS; ]... [ else COMMANDS; ] fi\n    Execute commands based on conditional.',
  jobs: 'jobs [-lnprs] [jobspec ...] or jobs -x command [args]\n    Display status of jobs.',
  kill: 'kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n    Send a signal to a job.',
  let: 'let arg [arg ...]\n    Evaluate arithmetic expressions.',
  local: 'local [option] name[=value] ...\n    Define local variables.',
  logout: 'logout [n]\n    Exit a login shell.',
  mapfile: 'mapfile [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]\n    Read lines from the standard input into an indexed array variable.',
  popd: 'popd [-n] [+N | -N]\n    Remove directories from stack.',
  printf: 'printf [-v var] format [arguments]\n    Formats and prints ARGUMENTS under control of the FORMAT.',
  pushd: 'pushd [-n] [+N | -N | dir]\n    Add directories to stack.',
  pwd: 'pwd [-LP]\n    Print the name of the current working directory.',
  read: 'read [-ers] [-a array] [-d delim] [-i text] [-n nchars] [-N nchars] [-p prompt] [-t timeout] [-u fd] [name ...]\n    Read a line from the standard input and split it into fields.',
  readarray: 'readarray [-d delim] [-n count] [-O origin] [-s count] [-t] [-u fd] [-C callback] [-c quantum] [array]\n    Read lines from a file into an array variable.',
  readonly: 'readonly [-aAf] [name[=value] ...] or readonly -p\n    Mark shell variables as unchangeable.',
  return: 'return [n]\n    Return from a shell function.',
  select: 'select NAME [in WORDS ... ;] do COMMANDS; done\n    Select words from a list and execute commands.',
  set: 'set [-abefhkmnptuvxBCEHPT] [-o option-name] [--] [-] [arg ...]\n    Set or unset values of shell options and positional parameters.',
  shift: 'shift [n]\n    Shift positional parameters.',
  shopt: 'shopt [-pqsu] [-o] [optname ...]\n    Set and unset shell options.',
  source: 'source filename [arguments]\n    Execute commands from a file in the current shell.',
  suspend: 'suspend [-f]\n    Suspend shell execution.',
  test: 'test [expr]\n    Evaluate conditional expression.',
  time: 'time [-p] pipeline\n    Report time consumed by pipeline\'s execution.',
  times: 'times\n    Display process times.',
  trap: 'trap [-lp] [[arg] signal_spec ...]\n    Trap signals and other events.',
  true: 'true\n    Return a successful result.',
  type: 'type [-afptP] name [name ...]\n    Display information about command type.',
  typeset: 'typeset [-aAfFgiIlnrtux] name[=value] ... or typeset -p [-aAfFilnrtux] [name ...]\n    Set variable values and attributes.',
  ulimit: 'ulimit [-SHabcdefiklmnpqrstuvxPRT] [limit]\n    Modify shell resource limits.',
  umask: 'umask [-p] [-S] [mode]\n    Display or set file mode mask.',
  unalias: 'unalias [-a] name [name ...]\n    Remove each NAME from the list of defined aliases.',
  unset: 'unset [-f] [-v] [-n] [name ...]\n    Unset values and attributes of shell variables and functions.',
  until: 'until COMMANDS; do COMMANDS-2; done\n    Execute commands as long as a test does not succeed.',
  wait: 'wait [-fn] [-p var] [id ...]\n    Wait for job completion and return exit status.',
  while: 'while COMMANDS; do COMMANDS-2; done\n    Execute commands as long as a test succeeds.',
  '((': '(( expression ))\n    Evaluate arithmetic expression.',
  '{': '{ COMMANDS ; }\n    Group commands as a unit.',
};

async function helpCmd(ctx) {
  const args = ctx.args.filter((a) => !a.startsWith('-'));
  const short = ctx.args.includes('-s');
  if (!args.length) {
    let out = 'GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu) - browser simulation at apps.badita.com/bash\n';
    out += 'These shell commands are defined internally.  Type `help\' to see this list.\nType `help name\' to find out more about the function `name\'.\nUse `man -k\' or `info\' to find out more about commands not in this list.\n\n';
    out += 'Other commands (ls, grep, sed, awk, ...) live in /usr/bin: try `ls /usr/bin` or `man <command>`.\n\n';
    const keys = Object.keys(HELP).sort();
    const usages = keys.map((k) => HELP[k].split('\n')[0]);
    const half = Math.ceil(usages.length / 2);
    for (let i = 0; i < half; i++) {
      const l = usages[i].slice(0, 36).padEnd(37);
      const r = (usages[i + half] || '').slice(0, 36);
      out += ` ${l}${r}\n`;
    }
    await ctx.out(out);
    return 0;
  }
  let st = 0;
  for (const a of args) {
    const keys = Object.keys(HELP).filter((k) => k === a || (a.includes('*') ? new RegExp('^' + a.replace(/\*/g, '.*') + '$').test(k) : false));
    if (!keys.length) {
      await ctx.shell.report(`help: no help topics match \`${a}'.  Try \`help help' or \`man -k ${a}' or \`info ${a}'.`, ctx.io);
      st = 1;
      continue;
    }
    for (const k of keys) {
      const [usage, ...rest] = HELP[k].split('\n');
      if (short) await ctx.out(`${k}: ${usage}\n`);
      else await ctx.out(`${k}: ${usage}\n${rest.join('\n')}\n`);
    }
  }
  return st;
}

async function enableCmd(ctx) {
  const sh = ctx.shell;
  if (ctx.args.length && !ctx.args.every((a) => a.startsWith('-'))) return 0;
  if (ctx.args.includes('-n')) return 0;
  const names = [...sh.commands].filter(([, v]) => v.builtin).map(([k]) => k).sort();
  await ctx.out(names.map((n) => `enable ${n}`).join('\n') + '\n');
  return 0;
}

async function disownCmd(ctx) {
  const sh = ctx.shell;
  if (ctx.args.includes('-a') || !ctx.args.length) {
    if (!ctx.args.length) {
      const j = sh.findJob();
      if (!j) {
        await sh.report('disown: current: no such job', ctx.io);
        return 1;
      }
      sh.jobs = sh.jobs.filter((x) => x !== j);
      return 0;
    }
    sh.jobs = [];
    return 0;
  }
  for (const a of ctx.args.filter((x) => !x.startsWith('-'))) {
    const j = sh.findJob(a);
    if (!j) {
      await sh.report(`disown: ${a}: no such job`, ctx.io);
      return 1;
    }
    sh.jobs = sh.jobs.filter((x) => x !== j);
  }
  return 0;
}

export function install(reg) {
  const add = (names, fn, extra) => {
    for (const n of names.split(' ')) reg.set(n, B(fn, extra));
  };
  add(':', async () => 0);
  add('true', async () => 0);
  add('false', async () => 1);
  add('echo', echoCmd);
  add('printf', printfCmd);
  add('cd', cdCmd);
  add('pwd', pwdCmd);
  add('dirs', dirsCmd);
  add('pushd', pushdCmd);
  add('popd', popdCmd);
  add('read', readCmd);
  add('mapfile readarray', mapfileCmd);
  add('declare typeset local export readonly', declareCmd);
  add('unset', unsetCmd);
  add('set', setCmd);
  add('shopt', shoptCmd);
  add('source .', sourceCmd);
  add('eval', evalCmd);
  add('exec', execCmd);
  add('exit logout', exitCmd);
  add('return', returnCmd);
  add('break', loopCtl('break'));
  add('continue', loopCtl('continue'));
  add('shift', shiftCmd);
  add('alias', aliasCmd);
  add('unalias', unaliasCmd);
  add('type', typeCmd);
  add('command', commandCmd);
  add('builtin', builtinCmd);
  add('hash', hashCmd);
  add('history', historyCmd);
  add('fc', fcCmd);
  add('jobs', jobsCmd);
  add('fg bg', fgCmd);
  add('wait', waitCmd);
  add('kill', killCmd);
  add('trap', trapCmd);
  add('umask', umaskCmd);
  add('ulimit', ulimitCmd);
  add('getopts', getoptsCmd);
  add('let', letCmd);
  add('times', timesCmd);
  add('caller', callerCmd);
  add('compgen', compgenCmd);
  add('complete compopt bind', async () => 0);
  add('help', helpCmd);
  add('enable', enableCmd);
  add('disown', disownCmd);
  add('suspend', async (ctx) => {
    await ctx.shell.report('suspend: cannot suspend a login shell', ctx.io);
    return 1;
  });
  reg.set('test', B(testCmd, { unary: testUnary, binary: testBinary }));
  reg.set('[', B(testCmd));
}

export { printfEscapes, testEval };
