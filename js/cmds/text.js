// Text processing: head tail wc sort uniq cut paste tr grep diff od xxd base64 hashes bc expr ...

import { getopt, cmd, UsageError, inputs, readInput, splitLines, toBytes, fromBytes, byteLength, md5, shaHex, posixCksum, strWidth, posixRegex, humanSize } from '../util.js';
import { FsError } from '../vfs.js';
import { matchPattern } from '../pattern.js';
import { formatPrintf } from './builtins.js';

const ext = (fn, help) => ({ fn: cmd(fn, { help }), help });

function parseCount(s, name) {
  const m = /^([+-]?)(\d+)(b|kB|K|KB|k|MB|M|GB|G|KiB|MiB|GiB)?$/.exec(String(s).trim());
  if (!m) throw new UsageError(`invalid number of lines: '${s}'`, 1, false);
  const mul = { b: 512, kB: 1000, K: 1024, KB: 1000, k: 1024, MB: 1e6, M: 1048576, GB: 1e9, G: 1073741824, KiB: 1024, MiB: 1048576, GiB: 1073741824 }[m[3]] || 1;
  return { sign: m[1], n: Number(m[2]) * mul };
}

// ---------- head / tail ----------

async function head(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'qvz', params: 'nc', long: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z' }, numeric: 'n' });
  const files = rest.length ? rest : ['-'];
  const showHeader = (files.length > 1 && !o.q) || o.v;
  let first = true;
  let st = 0;
  const lines = o.n !== undefined ? parseCount(o.n) : null;
  const bytes = o.c !== undefined ? parseCount(o.c) : null;
  const delim = o.z ? '\0' : '\n';
  for (const f of files) {
    if (showHeader) {
      await ctx.out(`${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`);
    }
    first = false;
    if (f === '-' && !bytes && (!lines || lines.sign !== '-')) {
      const n = lines ? lines.n : 10;
      for (let i = 0; i < n; i++) {
        const r = delim === '\n' ? await ctx.stdin.readLineRaw() : await ctx.stdin.readUntil(delim);
        if (!r) break;
        await ctx.out(r.line + (r.nl ? delim : ''));
      }
      continue;
    }
    let text;
    try {
      if (f === '-') text = await ctx.stdin.readAll();
      else {
        const node = ctx.vfs.stat(f, ctx.cwd);
        if (node.type === 'dir') throw new FsError('EISDIR', f);
        text = ctx.vfs.readFile(f, ctx.cwd);
      }
    } catch (e) {
      await ctx.err(`head: cannot open '${f}' for reading: ${e.message}\n`);
      st = 1;
      continue;
    }
    if (bytes) {
      const b = toBytes(text);
      await ctx.out(fromBytes(bytes.sign === '-' ? b.slice(0, Math.max(0, b.length - bytes.n)) : b.slice(0, bytes.n)));
      continue;
    }
    const parts = text.split(delim);
    const trailing = parts[parts.length - 1] === '';
    if (trailing) parts.pop();
    const n = lines ? lines.n : 10;
    const sel = lines && lines.sign === '-' ? parts.slice(0, Math.max(0, parts.length - n)) : parts.slice(0, n);
    let out = sel.join(delim);
    if (sel.length && (sel.length < parts.length || trailing)) out += delim;
    await ctx.out(out);
  }
  return st;
}

async function tail(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'qvfFrz',
    params: 'ncs',
    long: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', follow: '?', retry: '', 'sleep-interval': 's', pid: '=', 'zero-terminated': 'z' },
    numeric: 'n',
  });
  // obsolete +N form
  const files = [];
  let plusN = null;
  for (const r of rest) {
    if (/^\+\d+$/.test(r) && !files.length && plusN === null) plusN = r;
    else files.push(r);
  }
  if (plusN && o.n === undefined) o.n = plusN;
  if (!files.length) files.push('-');
  const follow = o.f || o.F || o.follow !== undefined;
  const showHeader = (files.length > 1 && !o.q) || o.v;
  const lines = o.n !== undefined ? parseCount(o.n) : { sign: '', n: 10 };
  const bytes = o.c !== undefined ? parseCount(o.c) : null;
  const delim = o.z ? '\0' : '\n';
  let st = 0;
  let first = true;
  const sizes = new Map();
  for (const f of files) {
    let text;
    try {
      text = f === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(f, ctx.cwd);
    } catch (e) {
      await ctx.err(`tail: cannot open '${f}' for reading: ${e.message}\n`);
      st = 1;
      continue;
    }
    if (showHeader) await ctx.out(`${first ? '' : '\n'}==> ${f === '-' ? 'standard input' : f} <==\n`);
    first = false;
    sizes.set(f, text.length);
    if (bytes) {
      const b = toBytes(text);
      await ctx.out(fromBytes(bytes.sign === '+' ? b.slice(Math.max(0, bytes.n - 1)) : b.slice(Math.max(0, b.length - bytes.n))));
      continue;
    }
    const parts = text.split(delim);
    const trailing = parts[parts.length - 1] === '';
    if (trailing) parts.pop();
    let sel = lines.sign === '+' ? parts.slice(Math.max(0, lines.n - 1)) : lines.n === 0 ? [] : parts.slice(-lines.n);
    if (o.r) sel = sel.reverse();
    let out = sel.join(delim);
    if (sel.length && (trailing || o.r)) out += delim;
    await ctx.out(out);
  }
  if (follow) {
    const watched = files.filter((f) => f !== '-');
    if (!watched.length) return st;
    for (;;) {
      await ctx.shell.sleep(Number(o.s || 1) * 500);
      for (const f of watched) {
        let text;
        try {
          text = ctx.vfs.readFile(f, ctx.cwd);
        } catch {
          continue;
        }
        const old = sizes.get(f) || 0;
        if (text.length < old) {
          await ctx.err(`tail: ${f}: file truncated\n`);
          sizes.set(f, 0);
          await ctx.out(text);
        } else if (text.length > old) await ctx.out(text.slice(old));
        sizes.set(f, text.length);
      }
    }
  }
  return st;
}

// ---------- wc ----------

async function wc(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'lwcmL', long: { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L', 'files0-from': '=', total: '=' } });
  let sel = ['l', 'w', 'm', 'c', 'L'].filter((k) => o[k]);
  if (!sel.length) sel = ['l', 'w', 'c'];
  const files = rest.length ? rest : ['-'];
  const rows = [];
  const tot = { l: 0, w: 0, c: 0, m: 0, L: 0 };
  let st = 0;
  let anyStdin = false;
  for (const f of files) {
    let text;
    try {
      if (f === '-') {
        anyStdin = true;
        text = await ctx.stdin.readAll();
      } else {
        const n = ctx.vfs.stat(f, ctx.cwd);
        if (n.type === 'dir') {
          await ctx.err(`wc: ${f}: Is a directory\n`);
          rows.push({ name: f, l: 0, w: 0, c: 0, m: 0, L: 0 });
          st = 1;
          continue;
        }
        text = ctx.vfs.readFile(f, ctx.cwd);
      }
    } catch (e) {
      await ctx.err(`wc: ${f}: ${e.message}\n`);
      st = 1;
      continue;
    }
    const r = { name: f === '-' && !rest.length ? '' : f };
    r.l = (text.match(/\n/g) || []).length;
    r.w = (text.match(/[^\s\udc80-\udcff]+/g) || []).length;
    r.c = byteLength(text);
    r.m = [...text].length;
    r.L = Math.max(0, ...text.split('\n').map((l) => strWidth(l.replace(/\t/g, '        '))));
    for (const k of Object.keys(tot)) tot[k] = k === 'L' ? Math.max(tot.L, r.L) : tot[k] + r[k];
    rows.push(r);
  }
  const showTotal = o.total === 'always' || (o.total !== 'never' && o.total !== 'only' && rows.length > 1);
  let width;
  if (sel.length === 1 && rows.length === 1 && !showTotal) width = 1;
  else {
    width = String(Math.max(tot.c, tot.l, tot.w)).length;
    if (anyStdin) width = Math.max(width, 7);
  }
  const fmt = (r) => sel.map((k) => String(r[k]).padStart(width)).join(' ') + (r.name ? ' ' + r.name : '') + '\n';
  let out = '';
  if (o.total !== 'only') for (const r of rows) out += fmt(r);
  if (showTotal) out += fmt({ ...tot, name: 'total' });
  if (o.total === 'only') out += sel.map((k) => String(tot[k])).join(' ') + '\n';
  await ctx.out(out);
  return st;
}

// ---------- sort ----------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function humanNum(s) {
  const m = /^\s*([+-]?\d*\.?\d+)([KMGTPEZY]?)/i.exec(s);
  if (!m) return 0;
  const p = m[2] ? 'KMGTPEZY'.indexOf(m[2].toUpperCase()) + 1 : 0;
  return parseFloat(m[1]) * 1024 ** p;
}

function leadNum(s) {
  const m = /^\s*([+-]?\d*\.?\d*)/.exec(s);
  const v = parseFloat(m[1]);
  return isNaN(v) ? 0 : v;
}

function versionCmp(a, b) {
  const re = /(\d+|\D+)/g;
  const pa = a.match(re) || [];
  const pb = b.match(re) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function parseKey(spec, globalOpts) {
  const m = /^(\d+)(?:\.(\d+))?([bdfghiMnRrV]*)(?:,(\d+)(?:\.(\d+))?([bdfghiMnRrV]*))?$/.exec(spec);
  if (!m) throw new UsageError(`invalid number at field start: invalid count at start of '${spec}'`, 2, false);
  const opts = (m[3] || '') + (m[6] || '');
  return {
    f1: Number(m[1]),
    c1: m[2] ? Number(m[2]) : 1,
    f2: m[4] ? Number(m[4]) : null,
    c2: m[5] ? Number(m[5]) : 0,
    opts: opts || null,
    sb: (m[3] || '').includes('b'),
    eb: (m[6] || '').includes('b'),
  };
}

function extractKey(line, k, sep) {
  // fields
  let starts = [];
  let ends = [];
  if (sep !== null) {
    let pos = 0;
    const parts = line.split(sep);
    for (const p of parts) {
      starts.push(pos);
      ends.push(pos + p.length);
      pos += p.length + sep.length;
    }
  } else {
    // fields are separated by the empty string between non-blank and blank
    const re = /\s*\S*/g;
    let m;
    let pos = 0;
    while ((m = re.exec(line)) && m[0] !== '') {
      starts.push(m.index);
      ends.push(m.index + m[0].length);
      pos = re.lastIndex;
    }
    if (!starts.length) {
      starts = [0];
      ends = [line.length];
    }
  }
  const fi = k.f1 - 1;
  if (fi >= starts.length) return '';
  let s = starts[fi];
  if (k.sb || (k.opts && k.opts.includes('b'))) {
    while (s < line.length && /\s/.test(line[s])) s++;
  }
  s += k.c1 - 1;
  let e;
  if (k.f2 === null) e = line.length;
  else {
    const fe = k.f2 - 1;
    if (fe >= starts.length) e = line.length;
    else if (k.c2 === 0) e = ends[fe];
    else {
      let b = starts[fe];
      if (k.eb) while (b < line.length && /\s/.test(line[b])) b++;
      e = Math.min(b + k.c2, ends[fe]);
    }
  }
  return line.slice(s, Math.max(s, e));
}

function makeComparator(opts) {
  return (a, b) => {
    let x = a;
    let y = b;
    if (opts.includes('b')) {
      x = x.replace(/^\s+/, '');
      y = y.replace(/^\s+/, '');
    }
    if (opts.includes('d')) {
      x = x.replace(/[^\w\s]/g, '');
      y = y.replace(/[^\w\s]/g, '');
    }
    if (opts.includes('i')) {
      x = x.replace(/[^\x20-\x7e]/g, '');
      y = y.replace(/[^\x20-\x7e]/g, '');
    }
    if (opts.includes('f')) {
      x = x.toUpperCase();
      y = y.toUpperCase();
    }
    let r;
    if (opts.includes('n')) r = leadNum(x) - leadNum(y);
    else if (opts.includes('g')) {
      const fx = parseFloat(x);
      const fy = parseFloat(y);
      r = (isNaN(fx) ? -Infinity : fx) - (isNaN(fy) ? -Infinity : fy);
      if (isNaN(r)) r = 0;
    } else if (opts.includes('h')) r = humanNum(x) - humanNum(y);
    else if (opts.includes('M')) r = MONTHS.indexOf(x.trim().slice(0, 3).toUpperCase()) - MONTHS.indexOf(y.trim().slice(0, 3).toUpperCase());
    else if (opts.includes('V')) r = versionCmp(x, y);
    else r = x < y ? -1 : x > y ? 1 : 0;
    if (opts.includes('r')) r = -r;
    return r;
  };
}

async function sort(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'nrufbdghiMVRscCzm',
    params: 'kto',
    long: {
      'numeric-sort': 'n', reverse: 'r', unique: 'u', 'ignore-case': 'f', 'ignore-leading-blanks': 'b', 'dictionary-order': 'd',
      'general-numeric-sort': 'g', 'human-numeric-sort': 'h', 'ignore-nonprinting': 'i', 'month-sort': 'M', 'version-sort': 'V',
      'random-sort': 'R', stable: 's', check: '?', key: 'k', 'field-separator': 't', output: 'o', 'zero-terminated': 'z', merge: 'm',
      parallel: '=', 'buffer-size': '=', 'temporary-directory': '=',
    },
    multi: 'k',
  });
  if (o.check !== undefined) o.c = true;
  const sep = o.t !== undefined ? (o.t === '\\0' ? '\0' : o.t) : null;
  if (sep !== null && sep.length > 1) throw new UsageError(`multi-character tab '${sep}'`, 2, false);
  const gopts = 'nrfbdghiMVR'.split('').filter((c) => o[c]).join('');
  const keys = (o.k || []).map((k) => parseKey(k, gopts));
  const delim = o.z ? '\0' : '\n';
  let text = '';
  for await (const f of inputs(ctx, rest)) text += f.text.length && !f.text.endsWith(delim) ? f.text + delim : f.text;
  if (ctx.failed) return 2;
  const lines = text.split(delim);
  if (lines[lines.length - 1] === '') lines.pop();
  const cmps = keys.length
    ? keys.map((k) => {
        const c = makeComparator(k.opts ?? gopts);
        return (a, b) => c(extractKey(a, k, sep), extractKey(b, k, sep));
      })
    : [makeComparator(gopts)];
  let rnd = null;
  if (o.R) {
    rnd = new Map();
    for (const l of lines) if (!rnd.has(l)) rnd.set(l, Math.random());
  }
  const full = (a, b) => {
    if (rnd) return rnd.get(a) - rnd.get(b);
    for (const c of cmps) {
      const r = c(a, b);
      if (r) return r;
    }
    if (o.s || o.u) return 0;
    const r = a < b ? -1 : a > b ? 1 : 0;
    return o.r ? -r : r;
  };
  if (o.c || o.C) {
    for (let i = 1; i < lines.length; i++) {
      const r = full(lines[i - 1], lines[i]);
      if (r > 0 || (o.u && r === 0)) {
        if (o.c) await ctx.err(`sort: ${rest[0] || '-'}:${i + 1}: disorder: ${lines[i]}\n`);
        return 1;
      }
    }
    return 0;
  }
  const idx = lines.map((l, i) => i);
  idx.sort((i, j) => full(lines[i], lines[j]) || i - j);
  let out = idx.map((i) => lines[i]);
  if (o.u) {
    const u = [];
    for (const l of out) if (!u.length || full(u[u.length - 1], l) !== 0) u.push(l);
    out = u;
  }
  const s = out.length ? out.join(delim) + delim : '';
  if (o.o) ctx.vfs.writeFile(o.o, ctx.cwd, s, { umask: ctx.shell.umask });
  else await ctx.out(s);
  return 0;
}

// ---------- uniq ----------

async function uniq(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'cduiDz',
    params: 'fsw',
    long: { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i', 'all-repeated': '?', 'skip-fields': 'f', 'skip-chars': 's', 'check-chars': 'w', 'zero-terminated': 'z', group: '?' },
  });
  const [input = '-', output] = rest;
  let text = '';
  for await (const f of inputs(ctx, [input])) text = f.text;
  if (ctx.failed) return 1;
  const delim = o.z ? '\0' : '\n';
  const lines = text.split(delim);
  if (lines[lines.length - 1] === '') lines.pop();
  const keyOf = (l) => {
    let k = l;
    if (o.f) {
      const n = Number(o.f);
      const m = new RegExp(`^(?:[ \\t]*[^ \\t]+){${n}}`).exec(k);
      k = m ? k.slice(m[0].length) : '';
    }
    if (o.s) k = k.slice(Number(o.s));
    if (o.w) k = k.slice(0, Number(o.w));
    if (o.i) k = k.toLowerCase();
    return k;
  };
  const groups = [];
  for (const l of lines) {
    const k = keyOf(l);
    const g = groups[groups.length - 1];
    if (g && g.key === k) g.lines.push(l);
    else groups.push({ key: k, lines: [l] });
  }
  let out = '';
  const allRep = o.D || o['all-repeated'] !== undefined;
  let firstGroup = true;
  for (const g of groups) {
    const n = g.lines.length;
    if (o.group !== undefined) {
      if (!firstGroup) out += delim;
      out += g.lines.join(delim) + delim;
      firstGroup = false;
      continue;
    }
    if (allRep) {
      if (n > 1) {
        if (!firstGroup && (o['all-repeated'] === 'separate' || o['all-repeated'] === 'prepend')) out += delim;
        out += g.lines.join(delim) + delim;
        firstGroup = false;
      }
      continue;
    }
    if (o.d && n < 2) continue;
    if (o.u && n > 1) continue;
    out += (o.c ? String(n).padStart(7) + ' ' : '') + g.lines[0] + delim;
  }
  if (output) ctx.vfs.writeFile(output, ctx.cwd, out, { umask: ctx.shell.umask });
  else await ctx.out(out);
  return 0;
}

// ---------- cut / paste ----------

function parseRanges(spec) {
  const ranges = [];
  for (const part of spec.split(',')) {
    const m = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new UsageError(part === '' ? 'fields are numbered from 1' : `invalid field range`, 1);
    const a = m[1] ? Number(m[1]) : 1;
    const b = m[2] ? (m[3] ? Number(m[3]) : Infinity) : a;
    if (a === 0) throw new UsageError('fields are numbered from 1');
    if (b < a) throw new UsageError('invalid decreasing range');
    ranges.push([a, b]);
  }
  return (i) => ranges.some(([a, b]) => i >= a && i <= b);
}

async function cut(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'snz',
    params: 'bcdf',
    long: { bytes: 'b', characters: 'c', delimiter: 'd', fields: 'f', 'only-delimited': 's', complement: '', 'output-delimiter': '=', 'zero-terminated': 'z' },
  });
  const modes = ['b', 'c', 'f'].filter((k) => o[k] !== undefined);
  if (modes.length !== 1) throw new UsageError(modes.length ? 'only one type of list may be specified' : 'you must specify a list of bytes, characters, or fields');
  const sel0 = parseRanges(o[modes[0]]);
  const sel = o.complement ? (i) => !sel0(i) : sel0;
  const d = o.d ?? '\t';
  if (o.d !== undefined && [...o.d].length !== 1) throw new UsageError('the delimiter must be a single character');
  const od = o['output-delimiter'];
  const delim = o.z ? '\0' : '\n';
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    const lines = f.text.split(delim);
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      if (modes[0] === 'f') {
        if (!line.includes(d)) {
          if (!o.s) out += line + delim;
          continue;
        }
        const parts = line.split(d);
        out += parts.filter((_, i) => sel(i + 1)).join(od ?? d) + delim;
      } else {
        const units = modes[0] === 'b' ? [...toBytes(line)] : [...line];
        let s = '';
        let prevSel = false;
        let any = false;
        units.forEach((u, i) => {
          if (sel(i + 1)) {
            if (od !== undefined && any && !prevSel) s += od;
            s += modes[0] === 'b' ? String.fromCharCode(u) : u;
            any = true;
            prevSel = true;
          } else prevSel = false;
        });
        out += (modes[0] === 'b' ? fromBytes(Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 255))) : s) + delim;
      }
    }
  }
  await ctx.out(out);
  return ctx.failed ? 1 : 0;
}

async function paste(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'sz', params: 'd', long: { delimiters: 'd', serial: 's', 'zero-terminated': 'z' } });
  const files = rest.length ? rest : ['-'];
  const delims = o.d !== undefined ? [...o.d.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\0/g, '')] : ['\t'];
  if (!delims.length) delims.push('');
  const nl = o.z ? '\0' : '\n';
  const contents = [];
  let stdinText = null;
  let stdinLines = null;
  let stdinPos = 0;
  for (const f of files) {
    if (f === '-') {
      if (stdinText === null) {
        stdinText = await ctx.stdin.readAll();
        stdinLines = splitLines(stdinText);
      }
      contents.push({ stdin: true });
      continue;
    }
    try {
      contents.push({ lines: splitLines(ctx.vfs.readFile(f, ctx.cwd)) });
    } catch (e) {
      await ctx.err(`paste: ${f}: ${e.message}\n`);
      return 1;
    }
  }
  let out = '';
  if (o.s) {
    for (const c of contents) {
      const lines = c.stdin ? stdinLines.splice(0) : c.lines;
      let s = '';
      lines.forEach((l, i) => (s += (i ? delims[(i - 1) % delims.length] : '') + l));
      out += s + nl;
    }
  } else {
    // stdin used multiple times takes lines in round-robin
    const nStdin = contents.filter((c) => c.stdin).length;
    const rows = Math.max(...contents.map((c) => (c.stdin ? Math.ceil(stdinLines.length / nStdin) : c.lines.length)), 0);
    for (let r = 0; r < rows; r++) {
      let s = '';
      contents.forEach((c, i) => {
        if (i) s += delims[(i - 1) % delims.length];
        s += c.stdin ? stdinLines[stdinPos++] ?? '' : c.lines[r] ?? '';
      });
      out += s + nl;
    }
  }
  await ctx.out(out);
  return 0;
}

// ---------- tr ----------

const TR_CLASSES = {
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', digit: '0123456789', alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('').sort().join(''),
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', lower: 'abcdefghijklmnopqrstuvwxyz', space: '\t\n\v\f\r ', blank: '\t ', punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef', cntrl: Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f',
  print: Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(''), graph: Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(''),
};

function trExpand(set, forPad = null) {
  const out = [];
  const esc = (s, i) => {
    const c = s[i + 1];
    const map = { n: '\n', t: '\t', r: '\r', v: '\v', f: '\f', a: '\x07', b: '\b', '\\': '\\' };
    if (c in map) return [map[c], 2];
    const m = /^[0-7]{1,3}/.exec(s.slice(i + 1));
    if (m) return [String.fromCharCode(parseInt(m[0], 8)), 1 + m[0].length];
    if (c === undefined) return ['\\', 1];
    return [c, 2];
  };
  for (let i = 0; i < set.length; ) {
    if (set.startsWith('[:', i)) {
      const k = set.indexOf(':]', i + 2);
      if (k > 0) {
        const name = set.slice(i + 2, k);
        if (TR_CLASSES[name]) {
          out.push(...TR_CLASSES[name]);
          i = k + 2;
          continue;
        }
      }
    }
    if (set[i] === '[' && set[i + 2] === '*') {
      const k = set.indexOf(']', i + 3);
      if (k > 0) {
        const ch = set[i + 1];
        const n = set.slice(i + 3, k);
        const count = n === '' ? (forPad === null ? 0 : -1) : parseInt(n, n.startsWith('0') ? 8 : 10);
        if (count === -1) out.push({ fill: ch });
        else for (let r = 0; r < count; r++) out.push(ch);
        i = k + 1;
        continue;
      }
    }
    if (set.startsWith('[=', i)) {
      const k = set.indexOf('=]', i + 2);
      if (k > 0) {
        out.push(set.slice(i + 2, k));
        i = k + 2;
        continue;
      }
    }
    let c;
    let len;
    if (set[i] === '\\') [c, len] = esc(set, i);
    else {
      c = set[i];
      len = 1;
    }
    if (set[i + len] === '-' && i + len + 1 < set.length) {
      let d;
      let l2;
      if (set[i + len + 1] === '\\') [d, l2] = esc(set, i + len + 1);
      else {
        d = set[i + len + 1];
        l2 = 1;
      }
      const a = c.charCodeAt(0);
      const b = d.charCodeAt(0);
      if (b < a) throw new UsageError(`range-endpoints of '${c}-${d}' are in reverse collating sequence order`, 1, false);
      for (let x = a; x <= b; x++) out.push(String.fromCharCode(x));
      i += len + 1 + l2;
      continue;
    }
    out.push(c);
    i += len;
  }
  if (forPad !== null) {
    const fi = out.findIndex((x) => typeof x === 'object');
    if (fi >= 0) {
      const fill = out[fi].fill;
      const need = Math.max(0, forPad - (out.length - 1));
      out.splice(fi, 1, ...Array(need).fill(fill));
    }
  }
  return out;
}

async function tr(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'cCdst', long: { complement: 'c', delete: 'd', 'squeeze-repeats': 's', 'truncate-set1': 't' } });
  if (o.C) o.c = true;
  if (!rest.length) throw new UsageError('missing operand');
  if (rest.length > 2) throw new UsageError(`extra operand '${rest[2]}'`);
  const text = await ctx.stdin.readAll();
  let set1 = trExpand(rest[0]);
  const s1 = new Set(set1);
  const inSet1 = o.c ? (ch) => !s1.has(ch) : (ch) => s1.has(ch);
  let out = '';
  if (o.d) {
    const s2 = rest[1] !== undefined ? new Set(trExpand(rest[1])) : null;
    let last = null;
    for (const ch of text) {
      if (inSet1(ch)) continue;
      if (o.s && s2 && s2.has(ch) && ch === last) continue;
      out += ch;
      last = ch;
    }
    await ctx.out(out);
    return 0;
  }
  if (rest.length === 1) {
    if (!o.s) throw new UsageError(`missing operand after '${rest[0]}'\nTwo strings must be given when translating.`, 1);
    let last = null;
    for (const ch of text) {
      if (inSet1(ch) && ch === last) continue;
      out += ch;
      last = ch;
    }
    await ctx.out(out);
    return 0;
  }
  let set2 = trExpand(rest[1], set1.length);
  if (o.t) set1 = set1.slice(0, set2.length);
  const map = new Map();
  if (o.c) {
    const fill = set2[set2.length - 1];
    // complement: every char not in set1 maps to the last char of set2
    for (const ch of new Set(text)) if (!s1.has(ch)) map.set(ch, fill);
  } else {
    set1.forEach((c, i) => map.set(c, set2[Math.min(i, set2.length - 1)] ?? c));
  }
  const s2 = new Set(set2);
  let last = null;
  for (const ch of text) {
    const t = map.has(ch) ? map.get(ch) : ch;
    if (o.s && s2.has(t) && t === last) continue;
    out += t;
    last = t;
  }
  await ctx.out(out);
  return 0;
}

// ---------- simple line tools ----------

async function rev(ctx) {
  let out = '';
  for await (const f of inputs(ctx, ctx.args)) {
    const parts = f.text.split('\n');
    out += parts.map((l) => [...l].reverse().join('')).join('\n');
  }
  await ctx.out(out);
  return ctx.failed ? 1 : 0;
}

async function nl(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'p', params: 'bnwsvihdf', long: { 'body-numbering': 'b', 'number-format': 'n', 'number-width': 'w', 'number-separator': 's', 'starting-line-number': 'v', 'line-increment': 'i' } });
  const style = o.b || 't';
  const fmt = o.n || 'rn';
  const w = Number(o.w || 6);
  const sep = o.s ?? '\t';
  let n = Number(o.v || 1);
  const inc = Number(o.i || 1);
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    for (const line of splitLines(f.text)) {
      const number = style === 'a' || (style === 't' && line.trim() !== '') || (style.startsWith('p') && new RegExp(style.slice(1)).test(line));
      if (number) {
        const s = String(n);
        const num = fmt === 'ln' ? s.padEnd(w) : fmt === 'rz' ? s.padStart(w, '0') : s.padStart(w);
        out += num + sep + line + '\n';
        n += inc;
      } else out += ' '.repeat(w + sep.length) + line + '\n';
    }
  }
  await ctx.out(out.replace(/ +\n/g, (m) => (m.length > 1 ? '\n' : m)).replace(/^ {7,}$/gm, ''));
  return 0;
}

async function fold(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'bs', params: 'w', long: { bytes: 'b', spaces: 's', width: 'w' }, numeric: 'w' });
  const width = Number(o.w || 80);
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    const lines = f.text.split('\n');
    out += lines.map((line) => {
      const res = [];
      let cur = '';
      let col = 0;
      for (const ch of line) {
        const cw = ch === '\t' && !o.b ? 8 - (col % 8) : 1;
        if (col + cw > width) {
          if (o.s && /\s/.test(cur) && cur.search(/\s[^\s]*$/) >= 0) {
            const k = cur.search(/\s[^\s]*$/) + 1;
            res.push(cur.slice(0, k));
            cur = cur.slice(k);
            col = cur.length;
          } else {
            res.push(cur);
            cur = '';
            col = 0;
          }
        }
        cur += ch;
        col += cw;
      }
      res.push(cur);
      return res.join('\n');
    }).join('\n');
  }
  await ctx.out(out);
  return 0;
}

async function fmt(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'sutc', params: 'wp', long: { width: 'w', 'split-only': 's', 'uniform-spacing': 'u' }, numeric: 'w' });
  const width = Number(o.w || 75);
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    const paras = f.text.split(/\n\s*\n/);
    out += paras.map((p) => {
      const indent = /^\s*/.exec(p)[0];
      const words = p.split(/\s+/).filter(Boolean);
      const lines = [];
      let cur = indent;
      for (const w of words) {
        if (cur.trim() && cur.length + 1 + w.length > width) {
          lines.push(cur);
          cur = indent + w;
        } else cur += (cur.trim() ? ' ' : '') + w;
      }
      if (cur.trim()) lines.push(cur);
      return lines.join('\n');
    }).filter((x) => x !== '').join('\n\n') + '\n';
  }
  await ctx.out(out);
  return 0;
}

async function expand(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'i', params: 't', long: { tabs: 't', initial: 'i' }, numeric: 't' });
  const t = Number(o.t || 8);
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    out += f.text.split('\n').map((line) => {
      let s = '';
      let lead = true;
      for (const ch of line) {
        if (ch === '\t' && (!o.i || lead)) s += ' '.repeat(t - (s.length % t));
        else {
          if (ch !== ' ') lead = false;
          s += ch;
        }
      }
      return s;
    }).join('\n');
  }
  await ctx.out(out);
  return 0;
}

async function unexpand(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'a', params: 't', long: { all: 'a', tabs: 't', 'first-only': '' } });
  const t = Number(o.t || 8);
  const all = o.a || o.t;
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    out += f.text.split('\n').map((line) => {
      const re = all ? / {2,}/g : /^ +/;
      return line.replace(re, (m, off) => {
        let col = off;
        let s = '';
        let end = off + m.length;
        while (col < end) {
          const next = (Math.floor(col / t) + 1) * t;
          if (next <= end && next - col > 1) {
            s += '\t';
            col = next;
          } else {
            s += ' ';
            col++;
          }
        }
        return s;
      });
    }).join('\n');
  }
  await ctx.out(out);
  return 0;
}

async function column(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'txenJR', params: 'socNWlH', long: { table: 't', separator: 's', 'output-separator': 'o', 'table-columns': 'N', 'fillrows': 'x', 'table-right': 'R' } });
  let text = '';
  for await (const f of inputs(ctx, rest)) text += f.text;
  const lines = splitLines(text).filter((l) => o.e || l.trim() !== '');
  if (o.t) {
    const sepRe = o.s ? new RegExp('[' + o.s.replace(/[\]\\^-]/g, '\\$&') + ']' + (o.n ? '' : '+')) : /\s+/;
    let rows = lines.map((l) => (o.s ? l.split(sepRe) : l.trim().split(sepRe)));
    if (o.N) rows.unshift(o.N.split(','));
    const ncol = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: ncol }, (_, i) => Math.max(...rows.map((r) => strWidth(r[i] ?? ''))));
    const osep = o.o ?? '  ';
    const right = (o.R || '').split(',');
    let out = '';
    for (const r of rows) {
      out += r.map((c, i) => (i === r.length - 1 ? c : right.includes(String(i + 1)) ? c.padStart(widths[i]) : c + ' '.repeat(widths[i] - strWidth(c)))).join(osep).replace(/\s+$/, '') + '\n';
    }
    await ctx.out(out);
    return 0;
  }
  const width = Number(o.c || ctx.shell.getVar('COLUMNS') || 80);
  const maxw = Math.max(0, ...lines.map(strWidth));
  const colw = Math.ceil((maxw + 1) / 8) * 8;
  const ncol = Math.max(1, Math.floor(width / colw));
  const nrow = Math.ceil(lines.length / ncol);
  let out = '';
  for (let r = 0; r < nrow; r++) {
    let s = '';
    for (let c = 0; c < ncol; c++) {
      const i = o.x ? r * ncol + c : c * nrow + r;
      if (i >= lines.length) continue;
      const cell = lines[i];
      const isLast = c === ncol - 1 || (o.x ? i + 1 >= lines.length : (c + 1) * nrow + r >= lines.length);
      if (isLast) s += cell;
      else {
        s += cell;
        let w = strWidth(cell);
        while (w < colw) {
          s += '\t';
          w = (Math.floor(w / 8) + 1) * 8;
        }
      }
    }
    out += s + '\n';
  }
  await ctx.out(out);
  return 0;
}

async function join(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'i', params: '12tavoej', long: { 'ignore-case': 'i', 'check-order': '', 'nocheck-order': '', header: '' }, multi: 'av' });
  if (rest.length !== 2) throw new UsageError(rest.length < 2 ? `missing operand after '${rest[0] || ''}'` : `extra operand '${rest[2]}'`);
  const read = async (f) => {
    if (f === '-') return splitLines(await ctx.stdin.readAll());
    return splitLines(ctx.vfs.readFile(f, ctx.cwd));
  };
  const A = await read(rest[0]);
  const Bl = await read(rest[1]);
  const sep = o.t;
  const split = (l) => (sep !== undefined ? l.split(sep) : l.trim().split(/\s+/));
  const f1 = Number(o['1'] || o.j || 1) - 1;
  const f2 = Number(o['2'] || o.j || 1) - 1;
  const osep = sep ?? ' ';
  const norm = (s) => (o.i ? s.toLowerCase() : s);
  const unp = new Set([...(o.a || []), ...(o.v || [])]);
  const only = new Set(o.v || []);
  const fmtLine = (key, ra, rb) => {
    if (o.o) {
      return o.o.split(/[, ]/).map((spec) => {
        if (spec === '0') return key;
        const [fi, fn] = spec.split('.').map(Number);
        const r = fi === 1 ? ra : rb;
        return r ? r[fn - 1] ?? o.e ?? '' : o.e ?? '';
      }).join(osep);
    }
    const parts = [key];
    if (ra) parts.push(...ra.filter((_, i) => i !== f1));
    if (rb) parts.push(...rb.filter((_, i) => i !== f2));
    return parts.join(osep);
  };
  let out = '';
  const ra = A.map(split);
  const rb = Bl.map(split);
  let i = 0;
  let j = 0;
  while (i < ra.length || j < rb.length) {
    const ka = i < ra.length ? norm(ra[i][f1] ?? '') : null;
    const kb = j < rb.length ? norm(rb[j][f2] ?? '') : null;
    if (kb === null || (ka !== null && ka < kb)) {
      if (unp.has('1')) out += fmtLine(ra[i][f1], ra[i], null) + '\n';
      i++;
    } else if (ka === null || kb < ka) {
      if (unp.has('2')) out += fmtLine(rb[j][f2], null, rb[j]) + '\n';
      j++;
    } else {
      let j2 = j;
      while (j2 < rb.length && norm(rb[j2][f2] ?? '') === ka) {
        if (!only.size) out += fmtLine(ra[i][f1], ra[i], rb[j2]) + '\n';
        j2++;
      }
      i++;
      if (i >= ra.length || norm(ra[i][f1] ?? '') !== ka) j = j2;
    }
  }
  await ctx.out(out);
  return 0;
}

async function comm(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: '123iz', long: { 'output-delimiter': '=', 'check-order': '', 'nocheck-order': '', total: '' } });
  if (rest.length !== 2) throw new UsageError(rest.length < 2 ? `missing operand after '${rest[0] || ''}'` : `extra operand '${rest[2]}'`);
  const read = async (f) => (f === '-' ? splitLines(await ctx.stdin.readAll()) : splitLines(ctx.vfs.readFile(f, ctx.cwd)));
  const a = await read(rest[0]);
  const b = await read(rest[1]);
  const d = o['output-delimiter'] ?? '\t';
  let i = 0;
  let j = 0;
  let out = '';
  const cnt = [0, 0, 0];
  const col = (n, s) => {
    cnt[n - 1]++;
    if (o[n]) return;
    let pre = '';
    for (let k = 1; k < n; k++) if (!o[k]) pre += d;
    out += pre + s + '\n';
  };
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) col(1, a[i++]);
    else if (i >= a.length || b[j] < a[i]) col(2, b[j++]);
    else {
      col(3, a[i]);
      i++;
      j++;
    }
  }
  if (o.total) out += `${cnt[0]}${d}${cnt[1]}${d}${cnt[2]}${d}total\n`;
  await ctx.out(out);
  return 0;
}

// ---------- diff ----------

// Myers O(ND) diff; returns ['=', i, j] / ['-', i, null] / ['+', null, j] ops
function lcsDiff(a, b, eq) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max > 40000) {
    const ops = [];
    let i = 0;
    while (i < n && i < m && eq(a[i], b[i])) ops.push(['=', i, i++]);
    for (let k = i; k < n; k++) ops.push(['-', k, null]);
    for (let k = i; k < m; k++) ops.push(['+', null, k]);
    return ops;
  }
  const off = max + 1;
  let V = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) x = V[off + k + 1];
      else x = V[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break outer;
      }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const Vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && Vd[off + k - 1] < Vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = Vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['=', x - 1, y - 1]);
      x--;
      y--;
    }
    if (x === prevX) ops.push(['+', null, prevY]);
    else ops.push(['-', prevX, null]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push(['=', x - 1, y - 1]);
    x--;
    y--;
  }
  ops.reverse();
  // like GNU diff's shift_boundaries: slide runs of changes over equal lines
  // so that they merge with a preceding run
  const da = new Uint8Array(n);
  const db = new Uint8Array(m);
  for (const o of ops) {
    if (o[0] === '-') da[o[1]] = 1;
    else if (o[0] === '+') db[o[2]] = 1;
  }
  const shift = (flags, lines) => {
    let i = 0;
    while (i < flags.length) {
      if (!flags[i]) {
        i++;
        continue;
      }
      const start = i;
      while (i < flags.length && flags[i]) i++;
      let s0 = start;
      let e0 = i;
      while (s0 > 0 && !flags[s0 - 1] && eq(lines[s0 - 1], lines[e0 - 1])) {
        s0--;
        e0--;
      }
      if (s0 < start && s0 > 0 && flags[s0 - 1]) {
        for (let k = start; k < i; k++) flags[k] = 0;
        for (let k = s0; k < e0; k++) flags[k] = 1;
      }
    }
  };
  shift(da, a);
  shift(db, b);
  ops.length = 0;
  for (let i = 0, j = 0; i < n || j < m; ) {
    if (i < n && da[i]) ops.push(['-', i++, null]);
    else if (j < m && db[j]) ops.push(['+', null, j++]);
    else ops.push(['=', i++, j++]);
  }
  // within each change block, emit deletions before insertions (GNU order)
  const out = [];
  for (let i = 0; i < ops.length; ) {
    if (ops[i][0] === '=') {
      out.push(ops[i++]);
      continue;
    }
    const del = [];
    const ins = [];
    while (i < ops.length && ops[i][0] !== '=') (ops[i][0] === '-' ? del : ins).push(ops[i++]);
    out.push(...del, ...ins);
  }
  return out;
}

function hunks(ops) {
  // group consecutive non-equal ops
  const out = [];
  let cur = null;
  ops.forEach((op, idx) => {
    if (op[0] === '=') {
      if (cur) {
        out.push(cur);
        cur = null;
      }
    } else {
      if (!cur) cur = { start: idx, ops: [] };
      cur.ops.push(op);
    }
  });
  if (cur) out.push(cur);
  return out;
}

async function diffFiles(ctx, o, nameA, nameB, ta, tb) {
  const la = splitLines(ta);
  const lb = splitLines(tb);
  const normalize = (s) => {
    if (o.i) s = s.toLowerCase();
    if (o.w) s = s.replace(/\s+/g, '');
    else if (o.b) s = s.replace(/\s+/g, ' ').replace(/ $/, '');
    return s;
  };
  const eq = (x, y) => normalize(x) === normalize(y);
  const ops = lcsDiff(la, lb, eq);
  const changed = ops.some((x) => x[0] !== '=');
  if (!changed) {
    if (o.s) await ctx.out(`Files ${nameA} and ${nameB} are identical\n`);
    return 0;
  }
  if (o.q) {
    await ctx.out(`Files ${nameA} and ${nameB} differ\n`);
    return 1;
  }
  const noNlA = ta.length && !ta.endsWith('\n');
  const noNlB = tb.length && !tb.endsWith('\n');
  const color = o.color === 'always' || (o.color === 'auto' && ctx.stdout.isTerminalWriter) || o.color === true;
  const C = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  let out = '';
  const range = (a, b) => (a === b ? String(a) : `${a},${b}`);
  if (o.u !== undefined || o.U !== undefined) {
    const ctxN = Number(o.U ?? (o.u === true ? 3 : o.u) ?? 3);
    const fmtT = (name) => {
      let t = Date.now();
      try {
        t = ctx.vfs.stat(name, ctx.cwd).mtime;
      } catch {}
      const d = new Date(t);
      const p = (x, n = 2) => String(x).padStart(n, '0');
      const tz = -d.getTimezoneOffset();
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000000 ${tz >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(tz) / 60))}${p(Math.abs(tz) % 60)}`;
    };
    out += C('1', `--- ${o.label?.[0] ?? `${nameA}\t${fmtT(nameA)}`}`) + '\n' + C('1', `+++ ${o.label?.[1] ?? `${nameB}\t${fmtT(nameB)}`}`) + '\n';
    // build hunks with context
    const idxs = [];
    ops.forEach((op, k) => op[0] !== '=' && idxs.push(k));
    let k = 0;
    while (k < idxs.length) {
      let start = Math.max(0, idxs[k] - ctxN);
      let end = Math.min(ops.length - 1, idxs[k] + ctxN);
      while (k + 1 < idxs.length && idxs[k + 1] - ctxN <= end + 1) {
        k++;
        end = Math.min(ops.length - 1, idxs[k] + ctxN);
      }
      k++;
      const seg = ops.slice(start, end + 1);
      let aStart = null;
      let bStart = null;
      let aLen = 0;
      let bLen = 0;
      // find positions
      let ai = 0;
      let bi = 0;
      for (let x = 0; x < start; x++) {
        if (ops[x][0] !== '+') ai++;
        if (ops[x][0] !== '-') bi++;
      }
      aStart = ai;
      bStart = bi;
      let body = '';
      for (const op of seg) {
        if (op[0] === '=') {
          body += ' ' + la[op[1]] + '\n';
          aLen++;
          bLen++;
          if (op[1] === la.length - 1 && noNlA) body += '\\ No newline at end of file\n';
        } else if (op[0] === '-') {
          body += C('31', '-' + la[op[1]]) + '\n';
          aLen++;
          if (op[1] === la.length - 1 && noNlA) body += '\\ No newline at end of file\n';
        } else {
          body += C('32', '+' + lb[op[2]]) + '\n';
          bLen++;
          if (op[2] === lb.length - 1 && noNlB) body += '\\ No newline at end of file\n';
        }
      }
      const r = (s, l) => (l === 1 ? `${s + 1}` : l === 0 ? `${s},0` : `${s + 1},${l}`);
      out += C('36', `@@ -${r(aStart, aLen)} +${r(bStart, bLen)} @@`) + '\n' + body;
    }
    await ctx.out(out);
    return 1;
  }
  if (o.y) {
    const w = Number(o.W || 130);
    const half = Math.floor((w - 3) / 2);
    for (const op of ops) {
      const l = op[1] !== null ? la[op[1]] : '';
      const r = op[2] !== null ? lb[op[2]] : '';
      const mark = op[0] === '=' ? ' ' : op[0] === '-' ? '<' : '>';
      if (o['suppress-common-lines'] && mark === ' ') continue;
      out += `${l.slice(0, half - 1).padEnd(half - 1)}${mark === ' ' ? '   ' : ` ${mark} `}${r.slice(0, half)}`.replace(/\s+$/, '') + '\n';
    }
    // merge adjacent -/+ into | pairs
    await ctx.out(out);
    return 1;
  }
  // normal diff
  let ai = 0;
  let bi = 0;
  const hs = [];
  let cur = null;
  for (const op of ops) {
    if (op[0] === '=') {
      if (cur) {
        hs.push(cur);
        cur = null;
      }
      ai++;
      bi++;
      continue;
    }
    if (!cur) cur = { a: ai, b: bi, del: [], add: [] };
    if (op[0] === '-') {
      cur.del.push(la[op[1]]);
      ai++;
    } else {
      cur.add.push(lb[op[2]]);
      bi++;
    }
  }
  if (cur) hs.push(cur);
  for (const h of hs) {
    if (h.del.length && h.add.length) out += `${range(h.a + 1, h.a + h.del.length)}c${range(h.b + 1, h.b + h.add.length)}\n`;
    else if (h.del.length) out += `${range(h.a + 1, h.a + h.del.length)}d${h.b}\n`;
    else out += `${h.a}a${range(h.b + 1, h.b + h.add.length)}\n`;
    for (const l of h.del) out += C('31', `< ${l}`) + '\n';
    if (h.del.length && noNlA && h.a + h.del.length === la.length) out += '\\ No newline at end of file\n';
    if (h.del.length && h.add.length) out += '---\n';
    for (const l of h.add) out += C('32', `> ${l}`) + '\n';
    if (h.add.length && noNlB && h.b + h.add.length === lb.length) out += '\\ No newline at end of file\n';
  }
  void hunks;
  await ctx.out(out);
  return 1;
}

async function diff(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'uqsiwbBryNac',
    params: 'UW',
    long: { unified: '?', brief: 'q', 'report-identical-files': 's', 'ignore-case': 'i', 'ignore-all-space': 'w', 'ignore-space-change': 'b', recursive: 'r', 'side-by-side': 'y', color: '?', 'suppress-common-lines': '', label: '=', 'new-file': 'N', text: 'a', width: 'W' },
    multiLong: ['label'],
  });
  if (o.c && o.u === undefined) o.u = true;
  if (rest.length !== 2) {
    await ctx.err(rest.length < 2 ? `diff: missing operand after '${rest[0] || 'diff'}'\ndiff: Try 'diff --help' for more information.\n` : `diff: extra operand '${rest[2]}'\n`);
    return 2;
  }
  const [a, b] = rest;
  const vfs = ctx.vfs;
  const read = async (f) => (f === '-' ? ctx.stdin.readAll() : vfs.readFile(f, ctx.cwd));
  const isD = (f) => {
    try {
      return vfs.stat(f, ctx.cwd).type === 'dir';
    } catch {
      return false;
    }
  };
  try {
    if (isD(a) && isD(b)) {
      if (!o.r) {
        // compare common files only at top level
      }
      let st = 0;
      const walk = async (pa, pb) => {
        const na = new Set(vfs.readdir(pa, ctx.cwd));
        const nb = new Set(vfs.readdir(pb, ctx.cwd));
        const all = [...new Set([...na, ...nb])].sort();
        for (const n of all) {
          const fa = pa + '/' + n;
          const fb = pb + '/' + n;
          if (!nb.has(n)) {
            await ctx.out(`Only in ${pa}: ${n}\n`);
            st = 1;
            continue;
          }
          if (!na.has(n)) {
            await ctx.out(`Only in ${pb}: ${n}\n`);
            st = 1;
            continue;
          }
          const da = isD(fa);
          const db = isD(fb);
          if (da && db) {
            if (o.r) await walk(fa, fb);
            else await ctx.out(`Common subdirectories: ${fa} and ${fb}\n`);
            continue;
          }
          if (da !== db) {
            await ctx.out(`File ${da ? fa : fb} is a directory while file ${da ? fb : fa} is a regular file\n`);
            st = 1;
            continue;
          }
          const ta = await read(fa);
          const tb = await read(fb);
          if (ta !== tb) {
            if (!o.q) await ctx.out(`diff ${ctx.args.filter((x) => x.startsWith('-')).join(' ')}${ctx.args.some((x) => x.startsWith('-')) ? ' ' : ''}${fa} ${fb}\n`);
            const r = await diffFiles(ctx, o, fa, fb, ta, tb);
            if (r) st = 1;
          }
        }
      };
      await walk(a.replace(/\/+$/, ''), b.replace(/\/+$/, ''));
      return st;
    }
    let fa = a;
    let fb = b;
    if (isD(a)) fa = a.replace(/\/+$/, '') + '/' + b.split('/').pop();
    if (isD(b)) fb = b.replace(/\/+$/, '') + '/' + a.split('/').pop();
    let ta;
    let tb;
    try {
      ta = await read(fa);
    } catch (e) {
      if (o.N) ta = '';
      else throw Object.assign(e, { path: fa });
    }
    try {
      tb = await read(fb);
    } catch (e) {
      if (o.N) tb = '';
      else throw Object.assign(e, { path: fb });
    }
    if (!o.a && (/[\0\udc80-\udcff]/.test(ta.slice(0, 4000)) || /[\0\udc80-\udcff]/.test(tb.slice(0, 4000)))) {
      if (ta === tb) return 0;
      await ctx.out(`Binary files ${fa} and ${fb} differ\n`);
      return 1;
    }
    return diffFiles(ctx, o, fa, fb, ta, tb);
  } catch (e) {
    if (e instanceof FsError) {
      await ctx.err(`diff: ${e.path}: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

async function cmp(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'lsbz', params: 'in', long: { verbose: 'l', silent: 's', quiet: 's', 'print-bytes': 'b', bytes: 'n', 'ignore-initial': 'i' } });
  if (!rest.length) throw new UsageError("missing operand after 'cmp'", 2);
  const [a, b = '-'] = rest;
  let A;
  let Bb;
  try {
    A = toBytes(a === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(a, ctx.cwd));
  } catch (e) {
    await ctx.err(`cmp: ${a}: ${e.message}\n`);
    return 2;
  }
  try {
    Bb = toBytes(b === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(b, ctx.cwd));
  } catch (e) {
    await ctx.err(`cmp: ${b}: ${e.message}\n`);
    return 2;
  }
  const limit = o.n !== undefined ? Number(o.n) : Infinity;
  let line = 1;
  let differ = false;
  const n = Math.min(A.length, Bb.length, limit);
  for (let i = 0; i < n; i++) {
    if (A[i] !== Bb[i]) {
      differ = true;
      if (o.s) return 1;
      if (o.l) {
        await ctx.out(`${String(i + 1).padStart(String(n).length)} ${A[i].toString(8).padStart(3)} ${Bb[i].toString(8).padStart(3)}\n`);
        continue;
      }
      await ctx.out(`${a} ${b} differ: byte ${i + 1}, line ${line}\n`);
      return 1;
    }
    if (A[i] === 10) line++;
  }
  if (A.length !== Bb.length && n < limit) {
    if (!o.s) await ctx.err(`cmp: EOF on ${A.length < Bb.length ? a : b} after byte ${n}${n ? `, line ${line - (A[n - 1] === 10 ? 1 : 0)}` : ''}\n`.replace(`after byte ${n}, line ${line - 1}`, `after byte ${n}, line ${line - 1}`));
    return 1;
  }
  return differ ? 1 : 0;
}

// ---------- generators ----------

async function seq(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'w', params: 'sf', long: { separator: 's', 'equal-width': 'w', format: 'f' }, negNumbers: true });
  if (!rest.length) throw new UsageError('missing operand');
  if (rest.length > 3) throw new UsageError(`extra operand '${rest[3]}'`);
  const nums = rest.map((x) => {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x)) throw new UsageError(`invalid floating point argument: '${x}'`);
    return parseFloat(x);
  });
  let [first, inc, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
  if (inc === 0) throw new UsageError(`invalid Zero increment value: '${rest[1]}'`);
  const decimals = Math.max(...rest.map((x) => (x.includes('.') && !/e/i.test(x) ? x.split('.')[1].length : 0)));
  const sep = (o.s ?? '\n').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  let fmt = (v) => (decimals ? v.toFixed(decimals) : String(Math.round(v * 1e10) / 1e10));
  if (o.f) fmt = (v) => formatPrintf(o.f, [String(v)], ctx).out;
  const vals = [];
  const n = Math.floor((last - first) / inc + 1e-10);
  for (let i = 0; i <= n; i++) {
    vals.push(first + i * inc);
    if (vals.length % 5000 === 0) {
      await ctx.out(vals.splice(0).map(fmt).join(sep) + sep);
      await ctx.tick();
    }
  }
  let strs = vals.map(fmt);
  if (o.w) {
    const w = Math.max(fmt(first).length, fmt(first + n * inc).length);
    strs = strs.map((s) => (s.startsWith('-') ? '-' + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0')));
  }
  if (strs.length) await ctx.out(strs.join(sep) + '\n');
  return 0;
}

async function yes(ctx) {
  const s = (ctx.args.length ? ctx.args.join(' ') : 'y') + '\n';
  const chunk = s.repeat(Math.max(1, Math.floor(4096 / s.length)));
  for (;;) {
    await ctx.out(chunk);
    await ctx.tick();
  }
}

async function shuf(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'erz', params: 'nio', long: { echo: 'e', 'input-range': 'i', 'head-count': 'n', repeat: 'r', output: 'o', 'random-source': '=' } });
  let items;
  if (o.e) items = rest;
  else if (o.i) {
    const [a, b] = o.i.split('-').map(Number);
    items = [];
    for (let x = a; x <= b; x++) items.push(String(x));
  } else items = splitLines(await readInput(ctx, rest));
  const n = o.n !== undefined ? Number(o.n) : o.r ? Infinity : items.length;
  const out = [];
  if (o.r) {
    if (!items.length) return 0;
    for (let i = 0; i < n; i++) {
      out.push(items[Math.floor(Math.random() * items.length)]);
      if (n === Infinity && out.length >= 1000) {
        await ctx.out(out.splice(0).join('\n') + '\n');
        await ctx.tick();
      }
    }
  } else {
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    out.push(...a.slice(0, n));
  }
  const s = out.length ? out.join('\n') + '\n' : '';
  if (o.o) ctx.vfs.writeFile(o.o, ctx.cwd, s);
  else await ctx.out(s);
  return 0;
}

// ---------- grep ----------

async function grep(ctx) {
  let name = ctx.name;
  const { o, rest } = getopt(ctx.args, {
    flags: 'ivnclLoqsrRwxEFGPhHbzaUTZ',
    params: 'efmABCd',
    long: {
      'ignore-case': 'i', 'invert-match': 'v', 'line-number': 'n', count: 'c', 'files-with-matches': 'l', 'files-without-match': 'L',
      'only-matching': 'o', quiet: 'q', silent: 'q', 'no-messages': 's', recursive: 'r', 'dereference-recursive': 'R', 'word-regexp': 'w',
      'line-regexp': 'x', 'extended-regexp': 'E', 'fixed-strings': 'F', 'basic-regexp': 'G', 'perl-regexp': 'P', 'no-filename': 'h',
      'with-filename': 'H', 'byte-offset': 'b', regexp: 'e', file: 'f', 'max-count': 'm', 'after-context': 'A', 'before-context': 'B',
      context: 'C', color: '?', colour: '?', include: '=', exclude: '=', 'exclude-dir': '=', 'null-data': 'z', text: 'a', label: '=',
      'ignore-case-no': '', 'no-ignore-case': '', null: 'Z', 'initial-tab': 'T', binary: 'U', 'binary-files': '=', directories: 'd', 'line-buffered': '',
    },
    multi: 'e',
    multiLong: ['include', 'exclude', 'exclude-dir'],
    numeric: 'C',
  });
  if (name === 'egrep') {
    o.E = true;
    await ctx.err('egrep: warning: egrep is obsolescent; using grep -E\n');
  }
  if (name === 'fgrep') {
    o.F = true;
    await ctx.err('fgrep: warning: fgrep is obsolescent; using grep -F\n');
  }
  let patterns = o.e ? o.e.slice() : [];
  if (o.f) {
    try {
      patterns.push(...splitLines(o.f === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(o.f, ctx.cwd)));
    } catch (e) {
      await ctx.err(`grep: ${o.f}: ${e.message}\n`);
      return 2;
    }
  }
  let files = rest;
  if (!o.e && !o.f) {
    if (!files.length) {
      await ctx.err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n");
      return 2;
    }
    patterns = files[0].split('\n');
    files = files.slice(1);
  }
  const recursive = o.r || o.R;
  if (!files.length) files = recursive ? ['.'] : ['-'];
  const icase = o.i && !o['no-ignore-case'];
  let re;
  try {
    const srcs = patterns.map((p) => {
      let s;
      if (o.F) s = p.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&');
      else if (o.P) s = p;
      else s = posixRegex(p, { extended: !!o.E }).source;
      if (o.w) s = `(?<![A-Za-z0-9_])(?:${s})(?![A-Za-z0-9_])`;
      if (o.x) s = `^(?:${s})$`;
      return s;
    });
    re = new RegExp(srcs.map((s) => `(?:${s})`).join('|'), 'g' + (icase ? 'i' : '') + 'u');
  } catch (e) {
    try {
      const srcs = patterns.map((p) => (o.F ? p.replace(/[\\^$.*+?()[\]{}|\/]/g, '\\$&') : o.P ? p : posixRegex(p, { extended: !!o.E }).source));
      re = new RegExp(srcs.map((s) => `(?:${s})`).join('|'), 'g' + (icase ? 'i' : ''));
    } catch {
      await ctx.err(`grep: ${o.E || o.P ? 'Unmatched ( or \\(' : 'Invalid regular expression'}\n`);
      return 2;
    }
  }
  const emptyPattern = patterns.some((p) => p === '');
  const colorOpt = o.color ?? o.colour;
  const color = colorOpt === 'always' || colorOpt === true && false || ((colorOpt === 'auto' || colorOpt === true) && ctx.stdout.isTerminalWriter);
  const C = (code, s) => (color ? `\x1b[${code}m\x1b[K${s}\x1b[m\x1b[K` : s);
  const after = Number(o.A ?? o.C ?? 0);
  const before = Number(o.B ?? o.C ?? 0);
  const maxCount = o.m !== undefined ? Number(o.m) : Infinity;
  let anyMatch = false;
  let hadError = false;
  const targets = [];
  const vfs = ctx.vfs;
  const incl = o.include || [];
  const excl = o.exclude || [];
  const exclDir = o['exclude-dir'] || [];
  const addTarget = (f, top) => {
    if (f === '-') {
      targets.push({ name: o.label || '(standard input)', stdin: true });
      return;
    }
    let node;
    try {
      node = vfs.stat(f, ctx.cwd, top || o.R);
    } catch (e) {
      if (!o.s) targets.push({ name: f, error: e.message });
      else targets.push({ name: f, silentError: true });
      return;
    }
    if (node.type === 'link' && !top && !o.R) return;
    if (node.type === 'dir') {
      if (!recursive) {
        if (o.d !== 'skip') targets.push({ name: f, isDir: true });
        return;
      }
      if (!top && exclDir.some((p) => matchPattern(p, f.split('/').pop()))) return;
      let names = [];
      try {
        names = vfs.readdir(f, ctx.cwd);
      } catch (e) {
        targets.push({ name: f, error: e.message });
        return;
      }
      for (const n of names) addTarget(f === '.' && !rest.length ? n : f.replace(/\/+$/, '') + '/' + n, false);
      return;
    }
    const base = f.split('/').pop();
    if (!top || recursive) {
      if (incl.length && !incl.some((p) => matchPattern(p, base))) return;
      if (excl.some((p) => matchPattern(p, base))) return;
    }
    targets.push({ name: f });
  };
  for (const f of files) addTarget(f, true);
  const showName = o.H || (!o.h && (targets.length > 1 || recursive));
  const delim = o.z ? '\0' : '\n';
  for (const t of targets) {
    if (t.error) {
      await ctx.err(`grep: ${t.name}: ${t.error}\n`);
      hadError = true;
      continue;
    }
    if (t.silentError) {
      hadError = true;
      continue;
    }
    if (t.isDir) {
      await ctx.err(`grep: ${t.name}: Is a directory\n`);
      hadError = true;
      continue;
    }
    let text;
    try {
      text = t.stdin ? await ctx.stdin.readAll() : vfs.readFile(t.name, ctx.cwd);
    } catch (e) {
      if (!o.s) await ctx.err(`grep: ${t.name}: ${e.message}\n`);
      hadError = true;
      continue;
    }
    const binary = !o.a && /[\0\udc80-\udcff]/.test(text.slice(0, 32768)) && !o.z;
    const lines = text.split(delim);
    if (lines[lines.length - 1] === '') lines.pop();
    let count = 0;
    let out = '';
    let lastPrinted = -1;
    let afterLeft = 0;
    let offset = 0;
    const offsets = [];
    for (const l of lines) {
      offsets.push(offset);
      offset += byteLength(l) + 1;
    }
    const prefix = (i, sepCh) => {
      let p = '';
      if (showName) p += C('35', t.name) + (o.Z ? '\0' : C('36', sepCh));
      if (o.n) p += C('32', String(i + 1)) + C('36', sepCh);
      if (o.b) p += C('32', String(offsets[i])) + C('36', sepCh);
      if (o.T && p) p += '\t';
      return p;
    };
    for (let i = 0; i < lines.length; i++) {
      if (count >= maxCount) {
        // still print trailing context
        if (afterLeft > 0 && !o.c && !o.l && !o.L && !o.q) {
          out += prefix(i, '-') + lines[i] + '\n';
          lastPrinted = i;
          afterLeft--;
          continue;
        }
        break;
      }
      const line = lines[i];
      re.lastIndex = 0;
      const m = emptyPattern ? true : re.test(line);
      const matched = o.v ? !m : m;
      if (!matched) {
        if (afterLeft > 0) {
          out += prefix(i, '-') + line + '\n';
          lastPrinted = i;
          afterLeft--;
        }
        continue;
      }
      count++;
      anyMatch = true;
      if (o.q) return 0;
      if (o.l || o.L || o.c) continue;
      if (binary) continue;
      if (before || after) {
        const from = Math.max(lastPrinted + 1, i - before);
        if (lastPrinted >= 0 && from > lastPrinted + 1) out += C('36', '--') + '\n';
        for (let k = from; k < i; k++) out += prefix(k, '-') + lines[k] + '\n';
      }
      if (o.o) {
        if (!o.v) {
          re.lastIndex = 0;
          let mm;
          while ((mm = re.exec(line))) {
            if (mm[0] === '') {
              re.lastIndex++;
              continue;
            }
            out += prefix(i, ':') + C('01;31', mm[0]) + delim;
          }
        }
      } else {
        let body = line;
        if (color && !o.v && !emptyPattern) body = line.replace(re, (x) => (x ? C('01;31', x) : x));
        out += prefix(i, ':') + body + delim;
      }
      lastPrinted = i;
      afterLeft = after;
    }
    if (o.c) out += (showName ? C('35', t.name) + C('36', ':') : '') + count + '\n';
    if (o.l && count) out += C('35', t.name) + (o.Z ? '\0' : '\n');
    if (o.L && !count) out += C('35', t.name) + (o.Z ? '\0' : '\n');
    if (binary && count && !o.c && !o.l && !o.L) out += `grep: ${t.name}: binary file matches\n`;
    if (out) await ctx.out(out);
  }
  if (o.L) return anyMatch && !hadError ? 0 : hadError ? 2 : 0;
  return hadError && !(o.q && anyMatch) ? 2 : anyMatch ? 0 : 1;
}

// ---------- binary views ----------

async function od(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'bcdxovsilfh', params: 'AtNjw', long: { 'address-radix': 'A', format: 't', 'read-bytes': 'N', 'skip-bytes': 'j', 'output-duplicates': 'v', width: 'w' }, multi: 't' });
  let bytes = toBytes(await readInput(ctx, rest));
  if (o.j) bytes = bytes.slice(Number(o.j));
  if (o.N) bytes = bytes.slice(0, Number(o.N));
  const radix = o.A || 'o';
  const width = Number(o.w || 16);
  const types = o.t ? o.t.slice() : [];
  if (o.b) types.push('o1');
  if (o.c) types.push('c');
  if (o.d) types.push('u2');
  if (o.x || o.h) types.push('x2');
  if (o.o) types.push('o2');
  if (o.i) types.push('d4');
  if (o.l) types.push('d8');
  if (o.s) types.push('d2');
  if (!types.length) types.push('o2');
  const addr = (n) => (radix === 'n' ? '' : radix === 'x' ? n.toString(16).padStart(6, '0') : radix === 'd' ? String(n).padStart(7, '0') : n.toString(8).padStart(7, '0'));
  const named = ['nul', 'soh', 'stx', 'etx', 'eot', 'enq', 'ack', 'bel', 'bs', 'ht', 'nl', 'vt', 'ff', 'cr', 'so', 'si', 'dle', 'dc1', 'dc2', 'dc3', 'dc4', 'nak', 'syn', 'etb', 'can', 'em', 'sub', 'esc', 'fs', 'gs', 'rs', 'us', 'sp'];
  let out = '';
  let prev = null;
  let starred = false;
  for (let off = 0; off < bytes.length; off += width) {
    const chunk = bytes.slice(off, off + width);
    const key = chunk.join(',');
    if (!o.v && prev === key && chunk.length === width) {
      if (!starred) out += '*\n';
      starred = true;
      continue;
    }
    starred = false;
    prev = key;
    types.forEach((t, ti) => {
      let line = ti === 0 ? addr(off) : ' '.repeat(addr(off).length);
      const kind = t[0];
      const size = Number(t.slice(1).replace(/[CSIL]/, (c) => ({ C: 1, S: 2, I: 4, L: 8 }[c])) || (kind === 'c' || kind === 'a' ? 1 : kind === 'f' ? 4 : 4));
      if (kind === 'c' || kind === 'a') {
        for (const b of chunk) {
          let s;
          if (kind === 'a') s = b === 127 ? 'del' : b < 33 ? named[b] : String.fromCharCode(b & 127);
          else s = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' }[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'));
          line += s.padStart(4);
        }
      } else {
        const w = { o: { 1: 3, 2: 6, 4: 11, 8: 22 }, x: { 1: 2, 2: 4, 4: 8, 8: 16 }, u: { 1: 3, 2: 5, 4: 10, 8: 20 }, d: { 1: 4, 2: 6, 4: 11, 8: 20 } }[kind]?.[size] ?? 8;
        for (let i = 0; i < chunk.length; i += size) {
          let v = 0n;
          for (let k = size - 1; k >= 0; k--) v = (v << 8n) | BigInt(chunk[i + k] ?? 0);
          if (kind === 'd' && v >= 1n << BigInt(size * 8 - 1)) v -= 1n << BigInt(size * 8);
          const s = kind === 'o' ? v.toString(8).padStart(w, '0') : kind === 'x' ? v.toString(16).padStart(w, '0') : v.toString();
          line += ' ' + s.padStart(w);
        }
      }
      out += line + '\n';
    });
  }
  if (radix !== 'n') out += addr(bytes.length) + '\n';
  await ctx.out(out);
  return 0;
}

async function xxd(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'prubiEe', params: 'cglsn', long: { plain: 'p', ps: 'p', revert: 'r', uppercase: 'u', bits: 'b', include: 'i', cols: 'c', groupsize: 'g', len: 'l', seek: 's' } });
  const [inFile, outFile] = rest;
  const text = inFile && inFile !== '-' ? ctx.vfs.readFile(inFile, ctx.cwd) : await ctx.stdin.readAll();
  let out;
  if (o.r) {
    const bytes = [];
    if (o.p) {
      for (const m of text.matchAll(/[0-9a-fA-F]{2}/g)) bytes.push(parseInt(m[0], 16));
    } else {
      for (const line of splitLines(text)) {
        const m = /^[0-9a-fA-F]+:\s*((?:[0-9a-fA-F]{2}\s?)+)/.exec(line);
        if (!m) continue;
        const hexPart = line.slice(line.indexOf(':') + 1).split('  ')[0];
        for (const h of hexPart.match(/[0-9a-fA-F]{2}/g) || []) bytes.push(parseInt(h, 16));
      }
    }
    out = fromBytes(Uint8Array.from(bytes));
  } else {
    let bytes = toBytes(text);
    if (o.s) bytes = bytes.slice(Number(o.s));
    if (o.l) bytes = bytes.slice(0, Number(o.l));
    const hex = (b) => (o.u ? b.toString(16).toUpperCase() : b.toString(16)).padStart(2, '0');
    if (o.p) {
      const cols = Number(o.c || 30);
      out = '';
      for (let i = 0; i < bytes.length; i += cols) out += [...bytes.slice(i, i + cols)].map(hex).join('') + '\n';
    } else if (o.i) {
      const name = (inFile || 'stdin').replace(/[^A-Za-z0-9]/g, '_');
      out = inFile ? `unsigned char ${name}[] = {\n` : '';
      const parts = [...bytes].map((b) => '0x' + hex(b));
      for (let i = 0; i < parts.length; i += 12) out += '  ' + parts.slice(i, i + 12).join(', ') + (i + 12 < parts.length ? ',' : '') + '\n';
      if (inFile) out += `};\nunsigned int ${name}_len = ${bytes.length};\n`;
    } else {
      const cols = Number(o.c || (o.b ? 6 : 16));
      const group = Number(o.g || (o.b ? 1 : 2));
      out = '';
      for (let i = 0; i < bytes.length; i += cols) {
        const chunk = [...bytes.slice(i, i + cols)];
        let h = '';
        chunk.forEach((b, k) => {
          h += o.b ? b.toString(2).padStart(8, '0') : hex(b);
          if ((k + 1) % group === 0) h += ' ';
        });
        const fullW = o.b ? cols * 9 : cols * 2 + Math.ceil(cols / group);
        const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
        out += `${(i + Number(o.s || 0)).toString(16).padStart(8, '0')}: ${h.padEnd(fullW)} ${ascii}\n`;
      }
    }
  }
  if (outFile) ctx.vfs.writeFile(outFile, ctx.cwd, out);
  else await ctx.out(out);
  return 0;
}

async function hexdump(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'Ccbdovx', params: 'nse', long: {} });
  let bytes = toBytes(await readInput(ctx, rest));
  if (o.s) bytes = bytes.slice(Number(o.s));
  if (o.n) bytes = bytes.slice(0, Number(o.n));
  let out = '';
  const canonical = o.C || ctx.name === 'hd';
  let prev = null;
  let star = false;
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = [...bytes.slice(i, i + 16)];
    const key = chunk.join(',');
    if (!o.v && key === prev && chunk.length === 16) {
      if (!star) out += '*\n';
      star = true;
      continue;
    }
    star = false;
    prev = key;
    if (canonical) {
      let h = '';
      for (let k = 0; k < 16; k++) {
        h += k < chunk.length ? chunk[k].toString(16).padStart(2, '0') + ' ' : '   ';
        if (k === 7) h += ' ';
      }
      out += `${i.toString(16).padStart(8, '0')}  ${h} |${chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('')}|\n`;
    } else if (o.c) {
      out += i.toString(16).padStart(7, '0') + chunk.map((b) => ({ 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r' }[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(4)).join('') + '\n';
    } else {
      let line = i.toString(16).padStart(7, '0');
      for (let k = 0; k < chunk.length; k += 2) {
        const v = chunk[k] | ((chunk[k + 1] ?? 0) << 8);
        line += ' ' + v.toString(16).padStart(4, '0');
      }
      out += line + '\n';
    }
  }
  out += (canonical ? bytes.length.toString(16).padStart(8, '0') : bytes.length.toString(16).padStart(7, '0')) + '\n';
  await ctx.out(out);
  return 0;
}

async function base64(ctx) {
  const is32 = ctx.name === 'base32';
  const { o, rest } = getopt(ctx.args, { flags: 'dit', params: 'w', long: { decode: 'd', 'ignore-garbage': 'i', wrap: 'w' } });
  const text = await readInput(ctx, rest);
  if (ctx.failed) return 1;
  const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  if (o.d) {
    let bytes;
    if (is32) {
      const clean = text.replace(/[\s=]/g, '').toUpperCase();
      bytes = [];
      let bits = 0;
      let val = 0;
      for (const c of clean) {
        const v = A32.indexOf(c);
        if (v < 0) {
          if (o.i) continue;
          await ctx.err('base32: invalid input\n');
          return 1;
        }
        val = (val << 5) | v;
        bits += 5;
        if (bits >= 8) {
          bytes.push((val >> (bits - 8)) & 255);
          bits -= 8;
        }
      }
      bytes = Uint8Array.from(bytes);
    } else {
      let clean = text.replace(/\s/g, '');
      if (o.i) clean = clean.replace(/[^A-Za-z0-9+/=]/g, '');
      if (/[^A-Za-z0-9+/=]/.test(clean) || /=[^=]/.test(clean)) {
        try {
          const partial = atob(clean.replace(/[^A-Za-z0-9+/=].*$/, '').replace(/=+$/, '').slice(0, Math.floor(clean.length / 4) * 4));
          await ctx.out(fromBytes(Uint8Array.from(partial, (c) => c.charCodeAt(0))));
        } catch {}
        await ctx.err('base64: invalid input\n');
        return 1;
      }
      try {
        const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } catch {
        await ctx.err('base64: invalid input\n');
        return 1;
      }
    }
    await ctx.out(fromBytes(bytes));
    return 0;
  }
  const bytes = toBytes(text);
  let enc;
  if (is32) {
    enc = '';
    let bits = 0;
    let val = 0;
    for (const b of bytes) {
      val = (val << 8) | b;
      bits += 8;
      while (bits >= 5) {
        enc += A32[(val >> (bits - 5)) & 31];
        bits -= 5;
      }
      val &= (1 << bits) - 1;
    }
    if (bits > 0) enc += A32[(val << (5 - bits)) & 31];
    while (enc.length % 8) enc += '=';
  } else {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    enc = btoa(bin);
  }
  const w = o.w !== undefined ? Number(o.w) : 76;
  let out = '';
  if (w > 0) for (let i = 0; i < enc.length; i += w) out += enc.slice(i, i + w) + '\n';
  else out = enc + (enc ? '' : '');
  if (w === 0) out = enc;
  if (w > 0 && !enc) out = '';
  await ctx.out(out + (w === 0 && enc ? '' : ''));
  return 0;
}

function hashCmd(algo) {
  return async (ctx) => {
    const { o, rest } = getopt(ctx.args, { flags: 'cbtwz', long: { check: 'c', binary: 'b', text: 't', quiet: '', status: '', strict: '', warn: 'w', tag: '', zero: 'z' } });
    const digest = async (text) => {
      const b = toBytes(text);
      if (algo === 'md5') return md5(b);
      return shaHex(algo, b);
    };
    const label = { md5: 'MD5', 'SHA-1': 'SHA1', 'SHA-256': 'SHA256', 'SHA-384': 'SHA384', 'SHA-512': 'SHA512' }[algo];
    if (o.c) {
      let bad = 0;
      let st = 0;
      for await (const f of inputs(ctx, rest)) {
        for (const line of splitLines(f.text)) {
          const m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(line) || /^\w+ \((.+)\) = ([0-9a-fA-F]+)$/.exec(line);
          if (!m) continue;
          const [hash, file] = m[1].length > 30 && /^[0-9a-f]+$/i.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
          let ok = false;
          try {
            ok = (await digest(ctx.vfs.readFile(file, ctx.cwd))) === hash.toLowerCase();
          } catch (e) {
            await ctx.err(`${ctx.name}: ${file}: ${e.message}\n`);
            await ctx.out(`${file}: FAILED open or read\n`);
            st = 1;
            continue;
          }
          if (!ok) bad++;
          if (!o.status && (!o.quiet || !ok)) await ctx.out(`${file}: ${ok ? 'OK' : 'FAILED'}\n`);
        }
      }
      if (bad && !o.status) await ctx.err(`${ctx.name}: WARNING: ${bad} computed checksum${bad > 1 ? 's' : ''} did NOT match\n`);
      return bad || st ? 1 : 0;
    }
    let st = 0;
    for await (const f of inputs(ctx, rest)) {
      const h = await digest(f.text);
      if (o.tag) await ctx.out(`${label} (${f.name}) = ${h}\n`);
      else await ctx.out(`${h}  ${f.name}${o.z ? '\0' : '\n'}`);
    }
    if (ctx.failed) st = 1;
    return st;
  };
}

async function cksum(ctx) {
  for await (const f of inputs(ctx, ctx.args)) {
    const b = toBytes(f.text);
    await ctx.out(`${posixCksum(b)} ${b.length}${f.stdin ? '' : ' ' + f.name}\n`);
  }
  return ctx.failed ? 1 : 0;
}

async function sum(ctx) {
  for await (const f of inputs(ctx, ctx.args.filter((a) => !a.startsWith('-')))) {
    const b = toBytes(f.text);
    let s = 0;
    for (const x of b) {
      s = (s >> 1) + ((s & 1) << 15);
      s = (s + x) & 0xffff;
    }
    await ctx.out(`${String(s).padStart(5, '0')} ${String(Math.ceil(b.length / 1024)).padStart(5)}${f.stdin ? '' : ' ' + f.name}\n`);
  }
  return 0;
}

async function strings(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'a', params: 'nt', long: { 'bytes': 'n', 'radix': 't', all: 'a' }, numeric: 'n' });
  const min = Number(o.n || 4);
  let out = '';
  for await (const f of inputs(ctx, rest)) {
    const b = toBytes(f.text);
    let cur = '';
    let start = 0;
    for (let i = 0; i <= b.length; i++) {
      const c = b[i];
      if (c !== undefined && ((c >= 32 && c < 127) || c === 9)) {
        if (!cur) start = i;
        cur += String.fromCharCode(c);
      } else {
        if (cur.length >= min) out += (o.t ? (o.t === 'x' ? start.toString(16) : o.t === 'o' ? start.toString(8) : String(start)).padStart(7) + ' ' : '') + cur + '\n';
        cur = '';
      }
    }
  }
  await ctx.out(out);
  return 0;
}

// ---------- expr ----------

async function expr(ctx) {
  const a = ctx.args;
  let i = 0;
  const isInt = (s) => /^[+-]?\d+$/.test(s);
  const syntax = () => {
    throw new UsageError('syntax error: unexpected argument' + (a[i] !== undefined ? ` '${a[i]}'` : ''), 2, false);
  };
  const primary = () => {
    const t = a[i++];
    if (t === undefined) throw new UsageError(i > 1 ? `syntax error: missing argument after '${a[i - 2]}'` : 'missing operand', 2, i > 1 ? false : true);
    if (t === '(') {
      const v = orE();
      if (a[i++] !== ')') throw new UsageError("syntax error: expecting ')' after '" + a[i - 2] + "'", 2, false);
      return v;
    }
    if (t === 'length') return String([...primary()].length);
    if (t === 'substr') {
      const s = primary();
      const p = Number(primary());
      const l = Number(primary());
      return p < 1 || l < 1 ? '' : [...s].slice(p - 1, p - 1 + l).join('');
    }
    if (t === 'index') {
      const s = primary();
      const chars = primary();
      for (let k = 0; k < s.length; k++) if (chars.includes(s[k])) return String(k + 1);
      return '0';
    }
    if (t === 'match') {
      const s = primary();
      return matchOp(s, primary());
    }
    if (t === '+') return a[i++];
    return t;
  };
  const matchOp = (s, p) => {
    const re = posixRegex(p.replace(/^\^/, ''), { extended: false });
    const m = new RegExp('^(?:' + re.source + ')').exec(s);
    if (re.source.includes('(')) return m ? m[1] ?? '' : '';
    return String(m ? m[0].length : 0);
  };
  const colon = () => {
    let l = primary();
    while (a[i] === ':') {
      i++;
      l = matchOp(l, primary());
    }
    return l;
  };
  const mul = () => {
    let l = colon();
    while (['*', '/', '%'].includes(a[i])) {
      const op = a[i++];
      const r = colon();
      if (!isInt(l) || !isInt(r)) throw new UsageError('non-integer argument', 2, false);
      const x = BigInt(l);
      const y = BigInt(r);
      if (op !== '*' && y === 0n) throw new UsageError('division by zero', 2, false);
      l = String(op === '*' ? x * y : op === '/' ? x / y : x % y);
    }
    return l;
  };
  const add = () => {
    let l = mul();
    while (a[i] === '+' || a[i] === '-') {
      const op = a[i++];
      const r = mul();
      if (!isInt(l) || !isInt(r)) throw new UsageError('non-integer argument', 2, false);
      l = String(op === '+' ? BigInt(l) + BigInt(r) : BigInt(l) - BigInt(r));
    }
    return l;
  };
  const cmpE = () => {
    let l = add();
    while (['<', '<=', '=', '==', '!=', '>=', '>'].includes(a[i])) {
      const op = a[i++];
      const r = add();
      let c;
      if (isInt(l) && isInt(r)) c = BigInt(l) < BigInt(r) ? -1 : BigInt(l) > BigInt(r) ? 1 : 0;
      else c = l < r ? -1 : l > r ? 1 : 0;
      l = { '<': c < 0, '<=': c <= 0, '=': c === 0, '==': c === 0, '!=': c !== 0, '>=': c >= 0, '>': c > 0 }[op] ? '1' : '0';
    }
    return l;
  };
  const isNull = (v) => v === '' || (isInt(v) && BigInt(v) === 0n);
  const andE = () => {
    let l = cmpE();
    while (a[i] === '&') {
      i++;
      const r = cmpE();
      l = isNull(l) || isNull(r) ? '0' : l;
    }
    return l;
  };
  const orE = () => {
    let l = andE();
    while (a[i] === '|') {
      i++;
      const r = andE();
      l = !isNull(l) ? l : !isNull(r) ? r : '0';
    }
    return l;
  };
  const v = orE();
  if (i < a.length) syntax();
  await ctx.out(v + '\n');
  return isNull(v) ? 1 : 0;
}

// ---------- factor ----------

async function factor(ctx) {
  let nums = ctx.args;
  if (!nums.length) nums = (await ctx.stdin.readAll()).split(/\s+/).filter(Boolean);
  let st = 0;
  for (const s of nums) {
    if (!/^\+?\d+$/.test(s)) {
      await ctx.err(`factor: '${s}' is not a valid positive integer\n`);
      st = 1;
      continue;
    }
    let n = BigInt(s);
    const fs = [];
    for (const p of [2n, 3n, 5n]) while (n % p === 0n && n > 1n) {
      fs.push(p);
      n /= p;
    }
    let d = 7n;
    const inc = [4n, 2n, 4n, 2n, 4n, 6n, 2n, 6n];
    let k = 0;
    let iter = 0;
    while (d * d <= n) {
      while (n % d === 0n) {
        fs.push(d);
        n /= d;
      }
      d += inc[k++ % 8];
      if (++iter % 100000 === 0) await ctx.tick();
    }
    if (n > 1n) fs.push(n);
    await ctx.out(`${BigInt(s)}:${fs.map((x) => ' ' + x).join('')}\n`);
  }
  return st;
}

async function numfmt(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: '', params: 'd', long: { to: '=', from: '=', suffix: '=', padding: '=', format: '=', 'from-unit': '=', 'to-unit': '=', field: '=', delimiter: 'd', round: '=', invalid: '=', grouping: '' } });
  const values = rest.length ? rest : splitLines(await ctx.stdin.readAll());
  const SI = 'KMGTPEZY';
  const conv = (s) => {
    let v;
    const m = /^([+-]?\d*\.?\d+)([KMGTPEZY]?)(i?)$/i.exec(s.trim());
    if (!m) return null;
    v = parseFloat(m[1]);
    const p = SI.indexOf(m[2].toUpperCase()) + 1;
    if (p) {
      if (o.from === 'si') v *= 1000 ** p;
      else if (o.from === 'iec' || o.from === 'iec-i' || o.from === 'auto') v *= (o.from === 'auto' && !m[3] ? 1000 : 1024) ** p;
      else return null;
    }
    if (o['from-unit']) v *= Number(o['from-unit']);
    if (o['to-unit']) v /= Number(o['to-unit']);
    let out;
    if (o.to === 'si' || o.to === 'iec' || o.to === 'iec-i') {
      const base = o.to === 'si' ? 1000 : 1024;
      let k = 0;
      while (Math.abs(v) >= base && k < SI.length) {
        v /= base;
        k++;
      }
      out = k ? (Math.abs(v) < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + SI[k - 1] + (o.to === 'iec-i' ? 'i' : '') : String(Math.round(v));
    } else out = Number.isInteger(v) ? String(v) : String(Math.round(v));
    if (o.grouping) out = out.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    if (o.suffix) out += o.suffix;
    if (o.padding) {
      const p = Number(o.padding);
      out = p < 0 ? out.padEnd(-p) : out.padStart(p);
    }
    return out;
  };
  let st = 0;
  for (const v of values) {
    if (o.field) {
      const parts = v.split(o.d ?? /\s+/);
      const fi = Number(o.field) - 1;
      const c = conv(parts[fi] ?? '');
      if (c !== null) parts[fi] = c;
      await ctx.out(parts.join(o.d ?? ' ') + '\n');
      continue;
    }
    const c = conv(v);
    if (c === null) {
      await ctx.err(`numfmt: invalid number: '${v}'\n`);
      st = 2;
      if (o.invalid !== 'ignore') break;
      continue;
    }
    await ctx.out(c + '\n');
  }
  return st;
}

async function tsort(ctx) {
  const words = (await readInput(ctx, ctx.args)).split(/\s+/).filter(Boolean);
  const nodes = [];
  const edges = new Map();
  const indeg = new Map();
  const addNode = (x) => {
    if (!indeg.has(x)) {
      indeg.set(x, 0);
      edges.set(x, []);
      nodes.push(x);
    }
  };
  for (let i = 0; i + 1 < words.length; i += 2) {
    const [a, b] = [words[i], words[i + 1]];
    addNode(a);
    addNode(b);
    if (a !== b) {
      edges.get(a).push(b);
      indeg.set(b, indeg.get(b) + 1);
    }
  }
  const out = [];
  const q = nodes.filter((n) => indeg.get(n) === 0);
  while (q.length) {
    const n = q.shift();
    out.push(n);
    for (const m of edges.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) q.push(m);
    }
  }
  if (out.length < nodes.length) {
    await ctx.err('tsort: -: input contains a loop:\n');
    for (const n of nodes) if (!out.includes(n)) out.push(n);
    await ctx.out(out.join('\n') + '\n');
    return 1;
  }
  await ctx.out(out.join('\n') + (out.length ? '\n' : ''));
  return 0;
}

async function dos2unix(ctx) {
  const toDos = ctx.name === 'unix2dos';
  const files = ctx.args.filter((a) => !a.startsWith('-'));
  if (!files.length) {
    const t = await ctx.stdin.readAll();
    await ctx.out(toDos ? t.replace(/\r?\n/g, '\r\n') : t.replace(/\r\n/g, '\n'));
    return 0;
  }
  for (const f of files) {
    const t = ctx.vfs.readFile(f, ctx.cwd);
    ctx.vfs.writeFile(f, ctx.cwd, toDos ? t.replace(/\r?\n/g, '\r\n') : t.replace(/\r\n/g, '\n'));
    await ctx.err(`${ctx.name}: converting file ${f} to ${toDos ? 'DOS' : 'Unix'} format...\n`);
  }
  return 0;
}

async function iconv(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'cl', params: 'fto', long: { from: 'f', 'from-code': 'f', to: 't', 'to-code': 't', list: 'l', output: 'o' } });
  if (o.l) {
    await ctx.out('ASCII, ISO-8859-1, LATIN1, US-ASCII, UTF-8, UTF8\n');
    return 0;
  }
  let text = await readInput(ctx, rest);
  const to = (o.t || 'UTF-8').toUpperCase();
  if (to.startsWith('ASCII') || to === 'US-ASCII') {
    const translit = to.includes('TRANSLIT');
    text = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7f]/g, translit ? '?' : '');
  }
  if (o.o) ctx.vfs.writeFile(o.o, ctx.cwd, text);
  else await ctx.out(text);
  return 0;
}

async function look(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'dfab', params: 't', long: {} });
  const [prefix, file = '/usr/share/dict/words'] = rest;
  if (!prefix) throw new UsageError('missing operand', 2);
  const lines = splitLines(ctx.vfs.readFile(file, ctx.cwd));
  const out = lines.filter((l) => (o.f || rest.length < 2 ? l.toLowerCase().startsWith(prefix.toLowerCase()) : l.startsWith(prefix)));
  await ctx.out(out.map((l) => l + '\n').join(''));
  return out.length ? 0 : 1;
}

export function install(reg) {
  const add = (names, fn, help) => {
    for (const n of names.split(' ')) reg.set(n, ext(fn, help));
  };
  add('head', head, 'Usage: head [OPTION]... [FILE]...\nPrint the first 10 lines of each FILE to standard output.\n\n  -c, --bytes=[-]NUM       print the first NUM bytes of each file\n  -n, --lines=[-]NUM       print the first NUM lines instead of the first 10\n  -q, --quiet              never print headers giving file names\n  -v, --verbose            always print headers giving file names\n');
  add('tail', tail, 'Usage: tail [OPTION]... [FILE]...\nPrint the last 10 lines of each FILE to standard output.\n\n  -c, --bytes=[+]NUM       output the last NUM bytes\n  -f, --follow             output appended data as the file grows\n  -n, --lines=[+]NUM       output the last NUM lines, instead of the last 10\n');
  add('wc', wc, 'Usage: wc [OPTION]... [FILE]...\nPrint newline, word, and byte counts for each FILE.\n\n  -c, --bytes            print the byte counts\n  -m, --chars            print the character counts\n  -l, --lines            print the newline counts\n  -L, --max-line-length  print the maximum display width\n  -w, --words            print the word counts\n');
  add('sort', sort, 'Usage: sort [OPTION]... [FILE]...\nWrite sorted concatenation of all FILE(s) to standard output.\n\n  -b  ignore leading blanks      -f  fold lower case to upper case\n  -g  general numeric sort       -h  human numeric sort (2K 1G)\n  -k  sort via a key             -M  month sort\n  -n  numeric sort               -o  write result to FILE\n  -r  reverse                    -R  random sort\n  -s  stable                     -t  field separator\n  -u  unique                     -V  version sort\n');
  add('uniq', uniq);
  add('cut', cut);
  add('paste', paste);
  add('tr', tr, 'Usage: tr [OPTION]... STRING1 [STRING2]\nTranslate, squeeze, and/or delete characters from standard input.\n\n  -c, -C, --complement    use the complement of STRING1\n  -d, --delete            delete characters in STRING1\n  -s, --squeeze-repeats   replace each sequence of a repeated character\n  -t, --truncate-set1     first truncate STRING1 to length of STRING2\n');
  add('rev', rev);
  add('nl', nl);
  add('fold', fold);
  add('fmt', fmt);
  add('expand', expand);
  add('unexpand', unexpand);
  add('column', column);
  add('join', join);
  add('comm', comm);
  add('diff', diff);
  add('cmp', cmp);
  add('seq', seq);
  add('yes', yes);
  add('shuf', shuf);
  add('grep egrep fgrep rgrep', grep, 'Usage: grep [OPTION]... PATTERNS [FILE]...\nSearch for PATTERNS in each FILE.\n\n  -E  extended regexp     -F  fixed strings      -P  Perl-compatible regexp\n  -e  use PATTERNS        -i  ignore case        -v  select non-matching lines\n  -w  match whole words   -x  match whole lines  -c  count matching lines\n  -l  list matching files -L  list non-matching  -n  print line numbers\n  -o  only matching part  -q  quiet              -r  recursive\n  -A/-B/-C NUM  context lines                    --color[=WHEN]\n');
  add('od', od);
  add('xxd', xxd);
  add('hexdump hd', hexdump);
  add('base64 base32', base64);
  add('md5sum', hashCmd('md5'));
  add('sha1sum', hashCmd('SHA-1'));
  add('sha256sum', hashCmd('SHA-256'));
  add('sha384sum', hashCmd('SHA-384'));
  add('sha512sum', hashCmd('SHA-512'));
  add('cksum', cksum);
  add('sum', sum);
  add('strings', strings);
  add('expr', expr);
  add('factor', factor);
  add('numfmt', numfmt);
  add('tsort', tsort);
  add('dos2unix unix2dos', dos2unix);
  add('iconv', iconv);
  add('look', look);
}

export { humanSize };
