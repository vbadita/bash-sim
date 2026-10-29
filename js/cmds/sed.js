// GNU sed: addresses, ranges, s///, y, a/i/c, hold space, branches, -n -i -E -s -z.

import { posixRegex, splitLines } from '../util.js';
import { FsError } from '../vfs.js';

class SedError extends Error {}

function parseScript(src, extended) {
  const cmds = [];
  let i = 0;
  const n = src.length;
  const blocks = [];
  const err = (m) => {
    throw new SedError(`-e expression #1, char ${i}: ${m}`);
  };
  const skipWs = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };
  const readDelimited = (delim, isRegex) => {
    let s = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        const d = src[i + 1];
        if (d === delim) {
          s += isRegex && '.*[]^$\\+?(){}|/'.includes(delim) && delim !== '/' ? '\\' + d : d;
          i += 2;
          continue;
        }
        if (d === 'n') {
          s += isRegex ? '\\n' : '\n';
          i += 2;
          continue;
        }
        if (d === '\n') {
          s += '\n';
          i += 2;
          continue;
        }
        s += '\\' + (d ?? '');
        i += 2;
        continue;
      }
      if (isRegex && src[i] === '[') {
        // bracket expressions may contain the delimiter
        let j = i + 1;
        if (src[j] === '^') j++;
        if (src[j] === ']') j++;
        while (j < n && src[j] !== ']') {
          if (src[j] === '[' && /[:.=]/.test(src[j + 1] || '')) {
            const close = src[j + 1] + ']';
            const k = src.indexOf(close, j + 2);
            j = k > 0 ? k + 2 : j + 1;
            continue;
          }
          j++;
        }
        if (j < n) {
          s += src.slice(i, j + 1);
          i = j + 1;
          continue;
        }
      }
      if (src[i] === '\n' && isRegex) err(`unterminated address regex`);
      s += src[i++];
    }
    if (i >= n) return null;
    i++;
    return s;
  };
  const parseRegexAddr = () => {
    let delim = '/';
    if (src[i] === '\\') {
      delim = src[i + 1];
      i += 2;
    } else i++;
    const re = readDelimited(delim, true);
    if (re === null) err('unterminated address regex');
    let flags = '';
    while (src[i] === 'I' || src[i] === 'M') flags += src[i++];
    return { re, flags };
  };
  const parseAddr = () => {
    skipWs();
    const c = src[i];
    if (c === undefined) return null;
    if (/\d/.test(c)) {
      let m = /^(\d+)(?:~(\d+))?/.exec(src.slice(i));
      i += m[0].length;
      if (m[2] !== undefined) return { step: [Number(m[1]), Number(m[2])] };
      return { line: Number(m[1]) };
    }
    if (c === '$') {
      i++;
      return { last: true };
    }
    if (c === '/' || c === '\\') return parseRegexAddr();
    return null;
  };
  const readLabel = () => {
    skipWs();
    let s = '';
    while (i < n && src[i] !== '\n' && src[i] !== ';' && src[i] !== '}') s += src[i++];
    return s.trim();
  };
  const readFilename = () => {
    skipWs();
    let s = '';
    while (i < n && src[i] !== '\n') s += src[i++];
    return s;
  };
  const readText = () => {
    // a\ <newline> text  |  a text (GNU one-liner)
    skipWs();
    if (src[i] === '\\') {
      i++;
      if (src[i] === '\n') i++;
      else skipWs();
    }
    let s = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const d = src[i + 1];
        if (d === '\n') {
          s += '\n';
          i += 2;
          continue;
        }
        if (d === undefined) {
          i++;
          break;
        }
        s += { t: '\t', n: '\n', a: '\x07', f: '\f', v: '\v', r: '\r' }[d] ?? d;
        i += 2;
        continue;
      }
      if (c === '\n') {
        i++;
        break;
      }
      s += c;
      i++;
    }
    return s;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(src[i])) i++;
    if (i >= n) break;
    if (src[i] === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    const cmd = { a1: null, a2: null, neg: false };
    cmd.a1 = parseAddr();
    if (cmd.a1) {
      skipWs();
      if (src[i] === ',') {
        i++;
        skipWs();
        if (src[i] === '+' || src[i] === '~') {
          const k = src[i++];
          const m = /^\d+/.exec(src.slice(i));
          if (!m) err('expected address');
          i += m[0].length;
          cmd.a2 = k === '+' ? { plus: Number(m[0]) } : { mult: Number(m[0]) };
        } else {
          cmd.a2 = parseAddr();
          if (!cmd.a2) err('unexpected `,\'');
        }
      }
    }
    skipWs();
    while (src[i] === '!') {
      cmd.neg = true;
      i++;
      skipWs();
    }
    const c = src[i++];
    if (c === undefined) err('missing command');
    cmd.c = c;
    switch (c) {
      case '{':
        blocks.push(cmds.length);
        break;
      case '}':
        if (!blocks.length) err("unexpected `}'");
        cmds[blocks.pop()].end = cmds.length;
        break;
      case 's': {
        const delim = src[i++];
        if (!delim || delim === '\n' || delim === '\\') err('unterminated `s\' command');
        const re = readDelimited(delim, true);
        if (re === null) err("unterminated `s' command");
        // replacement: keep backslashes for later processing
        let rep = '';
        while (i < n && src[i] !== delim) {
          if (src[i] === '\\') {
            if (src[i + 1] === delim) {
              rep += delim === '&' ? '\\&' : delim;
              i += 2;
              continue;
            }
            rep += src.slice(i, i + 2);
            i += 2;
            continue;
          }
          rep += src[i++];
        }
        if (i >= n) err("unterminated `s' command");
        i++;
        const fl = { g: false, p: false, n: 0, i: false, m: false, w: null, e: false };
        while (i < n && !/[\n;}#]/.test(src[i])) {
          const f = src[i];
          if (f === 'g') fl.g = true;
          else if (f === 'p') fl.p = true;
          else if (f === 'i' || f === 'I') fl.i = true;
          else if (f === 'm' || f === 'M') fl.m = true;
          else if (f === 'e') fl.e = true;
          else if (/\d/.test(f)) {
            const m = /^\d+/.exec(src.slice(i));
            fl.n = Number(m[0]);
            i += m[0].length - 1;
          } else if (f === 'w') {
            i++;
            fl.w = readFilename();
            break;
          } else if (f === ' ' || f === '\t') {} else err(`unknown option to \`s'`);
          i++;
        }
        cmd.re = re;
        cmd.rep = rep;
        cmd.fl = fl;
        break;
      }
      case 'y': {
        const delim = src[i++];
        const a = readDelimited(delim, false);
        const b = readDelimited(delim, false);
        if (a === null || b === null) err("unterminated `y' command");
        const ua = [...a.replace(/\\\\/g, '\\')];
        const ub = [...b.replace(/\\\\/g, '\\')];
        if (ua.length !== ub.length) err("strings for `y' command are different lengths");
        cmd.map = new Map(ua.map((x, k) => [x, ub[k]]));
        break;
      }
      case 'a':
      case 'i':
      case 'c':
        cmd.text = readText();
        break;
      case 'b':
      case 't':
      case 'T':
        cmd.label = readLabel();
        break;
      case ':': {
        if (cmd.a1) err(': doesn\'t want any addresses');
        const l = readLabel();
        if (!l) err('":" lacks a label');
        cmd.label = l;
        break;
      }
      case 'r':
      case 'R':
      case 'w':
      case 'W':
        cmd.file = readFilename();
        break;
      case 'q':
      case 'Q':
      case 'l':
      case 'L': {
        skipWs();
        const m = /^\d+/.exec(src.slice(i));
        if (m) {
          cmd.num = Number(m[0]);
          i += m[0].length;
        }
        break;
      }
      case 'e':
        cmd.file = readFilename();
        break;
      case '=':
      case 'd':
      case 'D':
      case 'g':
      case 'G':
      case 'h':
      case 'H':
      case 'n':
      case 'N':
      case 'p':
      case 'P':
      case 'x':
      case 'z':
      case 'F':
        break;
      default:
        i--;
        err(`unknown command: \`${c}'`);
    }
    cmds.push(cmd);
    skipWs();
    if (i < n && src[i] === '}' ) continue;
  }
  if (blocks.length) throw new SedError(`-e expression #1, char 0: unmatched \`{'`);
  // resolve labels
  const labels = new Map();
  cmds.forEach((c, k) => c.c === ':' && labels.set(c.label, k));
  for (const c of cmds) {
    if ('btT'.includes(c.c) && c.label) {
      if (!labels.has(c.label)) throw new SedError(`-e expression #1, char 0: can't find label for jump to \`${c.label}'`);
      c.target = labels.get(c.label);
    }
  }
  for (const c of cmds) {
    if (c.c === 's') c.regex = compile(c.re, extended, c.fl.i, c.fl.m, true);
    for (const a of [c.a1, c.a2]) if (a && a.re !== undefined) a.regex = a.re === '' ? null : compile(a.re, extended, a.flags.includes('I'), a.flags.includes('M'), false);
  }
  return cmds;
}

function compile(re, extended, icase, multi, global) {
  if (re === '') return null;
  try {
    return posixRegex(re, { extended, icase, global, multiline: multi });
  } catch (e) {
    throw new SedError(`-e expression #1, char 0: Invalid regular expression: ${re}`);
  }
}

function applyReplacement(rep, m) {
  let out = '';
  let mode = null; // 'U' | 'L'
  let once = null; // 'u' | 'l'
  const add = (s) => {
    for (const ch of s) {
      let c = ch;
      if (once) {
        c = once === 'u' ? c.toUpperCase() : c.toLowerCase();
        once = null;
      } else if (mode === 'U') c = c.toUpperCase();
      else if (mode === 'L') c = c.toLowerCase();
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '&') {
      add(m[0]);
      continue;
    }
    if (c === '\\') {
      const d = rep[++i];
      if (d === undefined) break;
      if (/\d/.test(d)) add(m[Number(d)] ?? '');
      else if (d === 'n') add('\n');
      else if (d === 't') add('\t');
      else if (d === 'r') add('\r');
      else if (d === 'a') add('\x07');
      else if (d === 'f') add('\f');
      else if (d === 'v') add('\v');
      else if (d === 'U' || d === 'L') {
        mode = d;
        once = null;
      } else if (d === 'E') {
        mode = null;
        once = null;
      } else if (d === 'u' || d === 'l') once = d;
      else if (d === '\n') add('\n');
      else add(d);
      continue;
    }
    add(c);
  }
  return out;
}

function escapeL(s, width = 70) {
  let out = '';
  let col = 0;
  const emit = (t) => {
    if (width > 1 && col + t.length > width - 1) {
      out += '\\\n';
      col = 0;
    }
    out += t;
    col += t.length;
  };
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    let t;
    if (ch === '\\') t = '\\\\';
    else if (code >= 0xdc80 && code <= 0xdcff) t = '\\' + (code - 0xdc00).toString(8).padStart(3, '0');
    else if (ch in { '\x07': 1, '\b': 1, '\f': 1, '\n': 1, '\r': 1, '\t': 1, '\v': 1 }) t = { '\x07': '\\a', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v' }[ch];
    else if (code < 32 || code === 127) t = '\\' + code.toString(8).padStart(3, '0');
    else t = ch;
    emit(t);
  }
  return out + '$\n';
}

export async function sedCmd(ctx) {
  const args = ctx.args;
  let quiet = false;
  let extended = false;
  let inPlace = null;
  let separate = false;
  let nulData = false;
  let debug = false;
  const scripts = [];
  const files = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a === '--') {
      files.push(...args.slice(k + 1));
      break;
    }
    if (a === '-n' || a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-E' || a === '-r' || a === '--regexp-extended') extended = true;
    else if (a === '-s' || a === '--separate') separate = true;
    else if (a === '-z' || a === '--null-data') nulData = true;
    else if (a === '-u' || a === '--unbuffered' || a === '--posix' || a === '--sandbox' || a === '--follow-symlinks') {} else if (a === '--debug') debug = true;
    else if (a === '-e' || a === '--expression') scripts.push(args[++k] ?? '');
    else if (a.startsWith('--expression=')) scripts.push(a.slice(13));
    else if (a === '-f' || a === '--file') {
      const f = args[++k];
      try {
        scripts.push(f === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(f, ctx.cwd).replace(/\n$/, ''));
      } catch (e) {
        await ctx.err(`sed: couldn't open file ${f}: ${e.message}\n`);
        return 1;
      }
    } else if (a.startsWith('-i') || a.startsWith('--in-place')) {
      inPlace = a.startsWith('-i') ? a.slice(2) : a.includes('=') ? a.split('=')[1] : '';
      separate = true;
    } else if (/^-[nErsz]+$/.test(a) && a.length > 2) {
      for (const c of a.slice(1)) {
        if (c === 'n') quiet = true;
        else if (c === 'E' || c === 'r') extended = true;
        else if (c === 's') separate = true;
        else if (c === 'z') nulData = true;
      }
    } else if (/^-[nErsz]*i/.test(a)) {
      for (const c of a.slice(1, a.indexOf('i'))) {
        if (c === 'n') quiet = true;
        else if (c === 'E' || c === 'r') extended = true;
      }
      inPlace = a.slice(a.indexOf('i') + 1);
      separate = true;
    } else if (a === '--help') {
      await ctx.out('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n\n  -n, --quiet, --silent\n                 suppress automatic printing of pattern space\n  -e script, --expression=script\n                 add the script to the commands to be executed\n  -f script-file, --file=script-file\n                 add the contents of script-file to the commands to be executed\n  -i[SUFFIX], --in-place[=SUFFIX]\n                 edit files in place (makes backup if SUFFIX supplied)\n  -E, -r, --regexp-extended\n                 use extended regular expressions in the script\n  -s, --separate\n                 consider files as separate rather than as a single\n                 continuous long stream.\n  -z, --null-data\n                 separate lines by NUL characters\n');
      return 0;
    } else if (a === '--version') {
      await ctx.out('sed (GNU sed) 4.9\n');
      return 0;
    } else if (a.startsWith('-') && a !== '-') {
      await ctx.err(`sed: invalid option -- '${a.slice(1, 2)}'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n`);
      return 1;
    } else files.push(a);
  }
  if (!scripts.length) {
    if (!files.length) {
      await ctx.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n');
      return 1;
    }
    scripts.push(files.shift());
  }
  let script = scripts.join('\n');
  if (script.startsWith('#n\n') || script === '#n') quiet = true;
  let cmds;
  try {
    cmds = parseScript(script, extended);
  } catch (e) {
    if (e instanceof SedError) {
      await ctx.err(`sed: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  if (debug) await ctx.out(`SED PROGRAM:\n${script.split('\n').map((l) => '  ' + l).join('\n')}\n`);
  if (inPlace !== null && !files.length) {
    await ctx.err('sed: no input files\n');
    return 1;
  }
  if (!files.length) files.push('-');
  const vfs = ctx.vfs;
  const delim = nulData ? '\0' : '\n';
  let status = 0;
  let exitCode = null;
  const wfiles = new Map();
  const writeTo = (f, s) => {
    if (f === '/dev/stdout') return ctx.out(s);
    if (f === '/dev/stderr') return ctx.err(s);
    if (!wfiles.has(f)) {
      wfiles.set(f, true);
      vfs.writeFile(f, ctx.cwd, '', { umask: ctx.shell.umask });
    }
    vfs.writeFile(f, ctx.cwd, s, { append: true });
  };
  // pre-create w files
  for (const c of cmds) {
    if (c.c === 'w' || c.c === 'W') writeTo(c.file, '');
    if (c.c === 's' && c.fl.w) writeTo(c.fl.w, '');
  }
  const rfilePos = new Map();

  // input stream over the files (or per-file when separate)
  const groups = separate ? files.map((f) => [f]) : [files];
  let lineNo = 0;
  let hold = '';
  let lastRegex = null;
  const rangeState = new Map();
  for (const group of groups) {
    // line source with one-line lookahead
    let fi = 0;
    let curName = '-';
    let curLines = null;
    let curIdx = 0;
    let curStdin = false;
    let outBuf = inPlace !== null ? [] : null;
    const out = async (s) => {
      if (outBuf) outBuf.push(s);
      else await ctx.out(s);
    };
    const openNext = async () => {
      while (fi < group.length) {
        const f = group[fi++];
        curName = f;
        if (f === '-') {
          curStdin = true;
          curLines = null;
          return true;
        }
        curStdin = false;
        try {
          const node = vfs.stat(f, ctx.cwd);
          if (node.type === 'dir') {
            await ctx.err(inPlace !== null ? `sed: couldn't edit ${f}: not a regular file\n` : `sed: read error on ${f}: Is a directory\n`);
            status = inPlace !== null ? 4 : 2;
            continue;
          }
          const text = vfs.readFile(f, ctx.cwd);
          const parts = text.split(delim);
          let lastNl = true;
          if (parts[parts.length - 1] === '') parts.pop();
          else lastNl = false;
          curLines = parts.map((l, k) => ({ line: l, nl: k < parts.length - 1 || lastNl }));
          curIdx = 0;
          return true;
        } catch (e) {
          await ctx.err(`sed: can't read ${f}: ${e.message}\n`);
          status = 2;
        }
      }
      return false;
    };
    let pending = null;
    let started = false;
    const rawNext = async () => {
      for (;;) {
        if (!started) {
          started = true;
          if (!(await openNext())) return null;
        }
        if (curStdin) {
          const r = delim === '\n' ? await ctx.stdin.readLineRaw() : await ctx.stdin.readUntil(delim);
          if (r) return r;
        } else if (curLines && curIdx < curLines.length) return curLines[curIdx++];
        if (!(await openNext())) return null;
      }
    };
    const nextLine = async () => {
      if (pending === null) pending = await rawNext();
      const cur = pending;
      if (cur === null) return null;
      pending = await rawNext();
      return { ...cur, last: pending === null };
    };
    let cur = await nextLine();
    if (!separate) lineNo = lineNo;
    else lineNo = 0;
    let quitNow = false;
    while (cur !== null && !quitNow) {
      lineNo++;
      let ps = cur.line;
      let isLast = cur.last;
      let lastNl = cur.nl;
      let tflag = false;
      const append = [];
      let deleted = false;
      let restartNoRead = false;
      let pc = 0;
      const matchAddr = (a) => {
        if (a.line !== undefined) return lineNo === a.line;
        if (a.last) return isLast;
        if (a.step) {
          const [f, s] = a.step;
          return s <= 0 ? lineNo === f : lineNo >= f && (lineNo - f) % s === 0;
        }
        const re = a.regex || lastRegex;
        if (!re) throw new SedError('no previous regular expression');
        if (a.regex) lastRegex = a.regex;
        re.lastIndex = 0;
        return re.test(ps);
      };
      const selected = (c, k) => {
        if (!c.a1) return true;
        if (!c.a2) return matchAddr(c.a1);
        let st = rangeState.get(k);
        if (st && st.active) {
          // check end
          let end = false;
          if (c.a2.line !== undefined) end = lineNo >= c.a2.line;
          else if (c.a2.plus !== undefined) end = lineNo >= st.start + c.a2.plus;
          else if (c.a2.mult !== undefined) end = c.a2.mult <= 0 || lineNo % c.a2.mult === 0;
          else end = matchAddr(c.a2);
          if (end) st.active = false;
          if (c.a2.line !== undefined && lineNo > c.a2.line) {
            st.active = false;
            return false;
          }
          return true;
        }
        const startMatch = c.a1.line === 0 ? !st && lineNo === 1 : matchAddr(c.a1);
        if (!startMatch) return false;
        st = { active: true, start: lineNo };
        rangeState.set(k, st);
        if (c.a1.line === 0 && c.a2.regex) {
          if (matchAddr(c.a2)) st.active = false;
          return true;
        }
        if (c.a2.line !== undefined && c.a2.line <= lineNo) st.active = false;
        if (c.a2.plus === 0) st.active = false;
        if (c.a2.mult !== undefined && (c.a2.mult <= 0 || lineNo % c.a2.mult === 0)) st.active = false;
        return true;
      };
      try {
        while (pc < cmds.length) {
          await ctx.tick();
          const c = cmds[pc];
          let sel = c.c === ':' || c.c === '}' ? true : selected(c, pc);
          if (c.neg) sel = !sel;
          if (!sel) {
            pc = c.c === '{' ? c.end + 1 : pc + 1;
            continue;
          }
          switch (c.c) {
            case '{':
            case '}':
            case ':':
              break;
            case '=':
              await out(lineNo + '\n');
              break;
            case 'a':
              append.push({ text: c.text + '\n' });
              break;
            case 'i':
              await out(c.text + '\n');
              break;
            case 'c': {
              const st = rangeState.get(pc);
              if (!c.a2 || c.neg || !st || !st.active) await out(c.text + '\n');
              deleted = true;
              pc = cmds.length;
              continue;
            }
            case 'd':
              deleted = true;
              pc = cmds.length;
              continue;
            case 'D': {
              const k = ps.indexOf('\n');
              if (k < 0) {
                deleted = true;
                pc = cmds.length;
                continue;
              }
              ps = ps.slice(k + 1);
              restartNoRead = true;
              pc = cmds.length;
              continue;
            }
            case 'e':
              break;
            case 'F':
              await out((curName === '-' ? '-' : curName) + '\n');
              break;
            case 'g':
              ps = hold;
              break;
            case 'G':
              ps += '\n' + hold;
              break;
            case 'h':
              hold = ps;
              break;
            case 'H':
              hold += '\n' + ps;
              break;
            case 'x':
              [ps, hold] = [hold, ps];
              break;
            case 'l':
              await out(escapeL(ps, c.num ?? 70));
              break;
            case 'n': {
              if (exitCode !== null) break;
              const nx = await nextLine();
              if (!nx) {
                // GNU: no next line -> print and exit
                quitNow = true;
                pc = cmds.length;
                continue;
              }
              if (!quiet) await out(ps + (lastNl ? delim : ''));
              for (const a of append.splice(0)) await out(a.text ?? '');
              cur = nx;
              ps = nx.line;
              isLast = nx.last;
              lastNl = nx.nl;
              lineNo++;
              break;
            }
            case 'N': {
              const nx = await nextLine();
              if (!nx) {
                quitNow = true;
                pc = cmds.length;
                continue;
              }
              for (const a of append.splice(0)) await out(a.text ?? '');
              ps += '\n' + nx.line;
              cur = nx;
              isLast = nx.last;
              lastNl = nx.nl;
              lineNo++;
              break;
            }
            case 'p':
              await out(ps + delim);
              break;
            case 'P': {
              const k = ps.indexOf('\n');
              await out((k < 0 ? ps : ps.slice(0, k)) + '\n');
              break;
            }
            case 'q':
              exitCode = c.num ?? 0;
              quitNow = true;
              pc = cmds.length;
              continue;
            case 'Q':
              exitCode = c.num ?? 0;
              quitNow = true;
              deleted = true;
              pc = cmds.length;
              continue;
            case 'r': {
              try {
                const t = c.file === '/dev/stdin' ? await ctx.stdin.readAll() : vfs.readFile(c.file, ctx.cwd);
                append.push({ text: t.length && !t.endsWith('\n') ? t + '\n' : t });
              } catch {}
              break;
            }
            case 'R': {
              try {
                const lines = splitLines(vfs.readFile(c.file, ctx.cwd));
                const p = rfilePos.get(c.file) || 0;
                if (p < lines.length) append.push({ text: lines[p] + '\n' });
                rfilePos.set(c.file, p + 1);
              } catch {}
              break;
            }
            case 'w':
              writeTo(c.file, ps + '\n');
              break;
            case 'W': {
              const k = ps.indexOf('\n');
              writeTo(c.file, (k < 0 ? ps : ps.slice(0, k)) + '\n');
              break;
            }
            case 'z':
              ps = '';
              break;
            case 'y':
              ps = [...ps].map((ch) => c.map.get(ch) ?? ch).join('');
              break;
            case 'b':
              pc = c.label ? c.target : cmds.length;
              continue;
            case 't':
              if (tflag) {
                tflag = false;
                pc = c.label ? c.target : cmds.length;
                continue;
              }
              break;
            case 'T':
              if (!tflag) {
                pc = c.label ? c.target : cmds.length;
                continue;
              }
              tflag = false;
              break;
            case 's': {
              let re = c.regex || lastRegex;
              if (!re) throw new SedError('no previous regular expression');
              if (c.regex) lastRegex = c.regex;
              if (!c.regex) re = new RegExp(re.source, re.flags.replace('g', '') + 'g');
              const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
              const gre = new RegExp(re.source, flags);
              let count = 0;
              let did = false;
              let result = '';
              let last = 0;
              let m;
              gre.lastIndex = 0;
              while ((m = gre.exec(ps))) {
                count++;
                const want = c.fl.n ? (c.fl.g ? count >= c.fl.n : count === c.fl.n) : c.fl.g || count === 1;
                if (want) {
                  result += ps.slice(last, m.index) + applyReplacement(c.rep, m);
                  last = m.index + m[0].length;
                  did = true;
                }
                if (m[0] === '') gre.lastIndex++;
                if (!c.fl.g && did && !(c.fl.n && count < c.fl.n)) break;
                if (gre.lastIndex > ps.length) break;
              }
              if (did) {
                ps = result + ps.slice(last);
                tflag = true;
                if (c.fl.p) await out(ps + delim);
                if (c.fl.w) writeTo(c.fl.w, ps + '\n');
              }
              break;
            }
          }
          pc++;
        }
      } catch (e) {
        if (e instanceof SedError) {
          await ctx.err(`sed: ${e.message}\n`);
          return 1;
        }
        if (e instanceof FsError) {
          await ctx.err(`sed: couldn't open file ${e.path}: ${e.message}\n`);
          return 4;
        }
        throw e;
      }
      if (!deleted && !quiet && !restartNoRead) await out(ps + (lastNl || !isLast ? delim : ''));
      for (const a of append) await out(a.text ?? '');
      if (restartNoRead) {
        // D with remaining text: start next cycle without reading new input
        lineNo--;
        cur = { line: ps, nl: lastNl, last: isLast };
        if (!quiet && false) await out('');
        continue;
      }
      if (quitNow) break;
      cur = await nextLine();
    }
    if (inPlace !== null) {
      const f = group[0];
      if (f !== '-' && status === 0) {
        try {
          if (inPlace) vfs.writeFile(f + inPlace, ctx.cwd, vfs.readFile(f, ctx.cwd));
          vfs.writeFile(f, ctx.cwd, outBuf.join(''));
        } catch (e) {
          await ctx.err(`sed: couldn't edit ${f}: ${e.message}\n`);
          status = 4;
        }
      }
    }
    if (exitCode !== null) break;
  }
  return exitCode ?? status;
}

export function install(reg) {
  reg.set('sed', { fn: sedCmd });
}
