// File and directory commands: ls, cp, mv, rm, mkdir, find, stat, chmod, tar, gzip...

import { getopt, cmd, UsageError, inputs, abspath, basename, dirname, byteLength, humanSize, fmtDate, toBytes, fromBytes, compress, decompress, crc32, strWidth, posixRegex } from '../util.js';
import { FsError, modeString } from '../vfs.js';
import { matchPattern } from '../pattern.js';

const ext = (fn, help) => ({ fn: cmd(fn, { help }), help });

function nodeSize(n) {
  if (n.type === 'dir') return 4096;
  if (n.type === 'link') return byteLength(n.target);
  if (n.type === 'chr') return 0;
  if (n.gen) return 0;
  if (n.data.startsWith('\x7fELF')) {
    const m = /\0SIZE:(\d+)\0/.exec(n.data);
    if (m) return Number(m[1]);
  }
  return byteLength(n.data);
}

function blocks(n) {
  if (n.type === 'dir') return 8;
  if (n.type === 'link' || n.type === 'chr') return 0;
  const s = nodeSize(n);
  return Math.ceil(s / 4096) * 8;
}

// ---------- colors ----------

const COLOR_EXT = {
  '01;31': ['tar', 'tgz', 'gz', 'zip', 'bz2', 'xz', '7z', 'rar', 'deb', 'rpm', 'jar', 'zst', 'lz', 'tbz2', 'txz'],
  '01;35': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'ico', 'tif', 'tiff', 'mp4', 'mkv', 'avi', 'mov', 'webm'],
  '00;36': ['mp3', 'flac', 'ogg', 'wav', 'm4a', 'aac', 'opus'],
};

export function lsColor(name, node, vfs, path, cwd) {
  if (!node) return '';
  if (node.type === 'dir') {
    if (node.mode & 0o1000 && node.mode & 0o002) return '30;42';
    if (node.mode & 0o002) return '34;42';
    return '01;34';
  }
  if (node.type === 'link') {
    try {
      vfs.stat(path, cwd, true);
      return '01;36';
    } catch {
      return '40;31;01';
    }
  }
  if (node.type === 'chr') return '40;33;01';
  if (node.type === 'fifo') return '40;33';
  if (node.mode & 0o4000) return '37;41';
  if (node.mode & 0o2000) return '30;43';
  if (node.mode & 0o111) return '01;32';
  const e = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  for (const [c, list] of Object.entries(COLOR_EXT)) if (list.includes(e)) return c;
  return '';
}

function quoteName(name, style) {
  if (style === 'literal') return name;
  if (/[\s'"\\$`!*?&;|<>(){}[\]#~]/.test(name) || name === '') {
    if (!name.includes("'")) return `'${name}'`;
    return `"${name.replace(/(["\\$`])/g, '\\$1')}"`;
  }
  return name;
}

// ---------- ls ----------

async function ls(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'laAhRrtS1dFinsGgopUuXcCmxvLHQNkZ',
    params: 'wIT',
    long: {
      all: 'a', 'almost-all': 'A', 'human-readable': 'h', recursive: 'R', reverse: 'r', directory: 'd', classify: '?', inode: 'i',
      'numeric-uid-gid': 'n', size: 's', color: '?', colour: '?', 'full-time': '', 'group-directories-first': '', si: '', width: 'w',
      ignore: 'I', 'hide': '=', literal: 'N', 'quote-name': 'Q', 'indicator-style': '=', 'time-style': '=', sort: '=', time: '=', format: '=',
      'dereference': 'L', 'file-type': '', 'no-group': 'G', 'quoting-style': '=', 'hide-control-chars': '', 'show-control-chars': '', context: 'Z',
    },
    multi: 'I',
  });
  const vfs = ctx.vfs;
  const cwd = ctx.cwd;
  const tty = !!ctx.stdout.isTerminalWriter;
  const colorOpt = o.color === undefined ? 'never' : o.color === true ? 'always' : o.color;
  const color = colorOpt === 'always' || colorOpt === 'yes' || colorOpt === 'force' || ((colorOpt === 'auto' || colorOpt === 'tty' || colorOpt === 'if-tty') && tty);
  if (o['full-time']) {
    o.l = true;
    o['time-style'] = 'full-iso';
  }
  const long = o.l || o.g || o.o || o.n;
  const all = o.a;
  const almost = o.A && !o.a;
  let format = o.format || (long ? 'long' : o['1'] ? 'single' : o.m ? 'commas' : o.x ? 'across' : o.C ? 'vertical' : tty ? 'vertical' : 'single');
  if (o['1'] && !long) format = 'single';
  const classify = o.F || o.classify === true || o.classify === 'always' || (o.classify === 'auto' && tty);
  const fileType = o['file-type'];
  const width = parseInt(o.w || ctx.shell.getVar('COLUMNS') || '80', 10) || 80;
  const quoting = o['quoting-style'] || (o.N ? 'literal' : o.Q ? 'c' : tty ? 'shell-escape' : 'literal');
  const ignores = o.I || [];
  if (o.hide && !all && !almost) ignores.push(o.hide);
  const timeKey = o.c || o.time === 'ctime' || o.time === 'status' ? 'ctime' : o.u || o.time === 'atime' || o.time === 'access' ? 'atime' : 'mtime';
  let sort = o.sort || (o.U ? 'none' : o.t ? 'time' : o.S ? 'size' : o.X ? 'extension' : o.v ? 'version' : 'name');
  let status = 0;

  const fmtName = (name, node, path, isArgPath) => {
    let s = quoting === 'c' ? JSON.stringify(name) : quoting === 'literal' ? name : quoteName(name, quoting);
    let suffix = '';
    if ((classify || fileType) && node) {
      if (node.type === 'dir') suffix = '/';
      else if (node.type === 'link') suffix = long ? '' : '@';
      else if (node.type === 'fifo') suffix = '|';
      else if (node.mode & 0o111 && classify && node.type === 'file') suffix = '*';
    }
    if (o.p && node && node.type === 'dir') suffix = '/';
    if (color) {
      const c = lsColor(name, node, vfs, path, cwd);
      if (c) s = `\x1b[${c}m${s}\x1b[0m`;
    }
    return s + suffix;
  };

  const entryInfo = (name, path, isArg) => {
    let node;
    try {
      node = vfs.stat(path, cwd, !!o.L || (isArg && (o.H || (!long && !o.d && !o.F))));
      if (isArg && long && !o.L && !o.H) node = vfs.stat(path, cwd, false);
      if (isArg && !long && !o.d) {
        const l = vfs.stat(path, cwd, false);
        if (l.type === 'link') {
          try {
            node = vfs.stat(path, cwd, true);
          } catch {
            node = l;
          }
        }
      }
    } catch (e) {
      return { name, path, err: e };
    }
    return { name, path, node };
  };

  const sortEntries = (list) => {
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const verCmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    if (sort === 'none') return o.r ? list.reverse() : list;
    let f = byName;
    if (sort === 'time') f = (a, b) => b.node[timeKey] - a.node[timeKey] || byName(a, b);
    else if (sort === 'size') f = (a, b) => nodeSize(b.node) - nodeSize(a.node) || byName(a, b);
    else if (sort === 'extension') {
      const e = (x) => (x.name.lastIndexOf('.') > 0 ? x.name.slice(x.name.lastIndexOf('.') + 1) : '');
      f = (a, b) => (e(a) < e(b) ? -1 : e(a) > e(b) ? 1 : byName(a, b));
    } else if (sort === 'version') f = verCmp;
    list.sort(f);
    if (o['group-directories-first']) list.sort((a, b) => (b.node.type === 'dir') - (a.node.type === 'dir'));
    if (o.r) list.reverse();
    return list;
  };

  const fmtTime = (t) => {
    const style = o['time-style'];
    const d = new Date(t);
    const p = (x, n = 2) => String(x).padStart(n, '0');
    if (style === 'full-iso') {
      const tz = -d.getTimezoneOffset();
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000000 ${tz >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(tz) / 60))}${p(Math.abs(tz) % 60)}`;
    }
    if (style === 'long-iso') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    if (style === 'iso') return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return fmtDate(t);
  };

  const sizeStr = (n) => {
    if (n.type === 'chr') return '1, 3';
    const s = nodeSize(n);
    return o.h ? humanSize(s, !!o.si) : String(s);
  };

  const blkStr = (n) => {
    const b = blocks(n) / 2;
    return o.h ? (b ? humanSize(b * 1024, !!o.si) : '0') : String(b);
  };

  const printLong = async (list, showTotal) => {
    if (showTotal) {
      const tot = list.reduce((a, e) => a + (e.node ? blocks(e.node) / 2 : 0), 0);
      await ctx.out(`total ${o.h ? (tot ? humanSize(tot * 1024, !!o.si) : '0') : tot}\n`);
    }
    const rows = list.map((e) => {
      const n = e.node;
      const owner = o.n ? String(n.uid) : ctx.shell.system.userName(n.uid);
      const group = o.n ? String(n.gid) : ctx.shell.system.groupName(n.gid);
      let name = fmtName(e.name, n, e.path);
      if (n.type === 'link') {
        let tnode = null;
        try {
          tnode = vfs.stat(e.path, cwd, true);
        } catch {}
        let target = n.target;
        if (color && tnode) {
          const c = lsColor(basename(n.target), tnode, vfs, e.path, cwd);
          if (c) target = `\x1b[${c}m${target}\x1b[0m`;
        } else if (color && !tnode) target = `\x1b[40;31;01m${target}\x1b[0m`;
        name += ` -> ${target}`;
        if (classify && tnode) name += tnode.type === 'dir' ? '/' : tnode.mode & 0o111 ? '*' : '';
      }
      return {
        ino: String(n.ino),
        blk: blkStr(n),
        mode: modeString(n),
        links: String(n.nlink),
        owner,
        group,
        size: sizeStr(n),
        time: fmtTime(n[timeKey]),
        name,
      };
    });
    const w = (k) => Math.max(0, ...rows.map((r) => strWidth(r[k])));
    const W = { ino: w('ino'), blk: w('blk'), links: w('links'), owner: w('owner'), group: w('group'), size: w('size') };
    let out = '';
    for (const r of rows) {
      let line = '';
      if (o.i) line += r.ino.padStart(W.ino) + ' ';
      if (o.s) line += r.blk.padStart(W.blk) + ' ';
      line += `${r.mode} ${r.links.padStart(W.links)} `;
      if (!o.g) line += r.owner.padEnd(W.owner) + ' ';
      if (!o.o && !o.G) line += r.group.padEnd(W.group) + ' ';
      line += `${r.size.padStart(W.size)} ${r.time} ${r.name}`;
      out += line + '\n';
    }
    await ctx.out(out);
  };

  const printShort = async (list) => {
    const cells = list.map((e) => {
      let s = fmtName(e.name, e.node, e.path);
      let prefix = '';
      if (o.i) prefix += String(e.node.ino) + ' ';
      if (o.s) prefix += blkStr(e.node) + ' ';
      return prefix + s;
    });
    if (!cells.length) return;
    const plain = (s) => strWidth(s.replace(/\x1b\[[0-9;]*m/g, ''));
    if (format === 'single') {
      await ctx.out(cells.join('\n') + '\n');
      return;
    }
    if (format === 'commas') {
      let out = '';
      let col = 0;
      cells.forEach((c, i) => {
        const piece = c + (i < cells.length - 1 ? ',' : '');
        const pw = plain(piece);
        if (col && col + 1 + pw > width) {
          out += '\n';
          col = 0;
        } else if (col) {
          out += ' ';
          col++;
        }
        out += piece;
        col += pw;
      });
      await ctx.out(out + '\n');
      return;
    }
    // columns (vertical by default, across with -x)
    const n = cells.length;
    const widths = cells.map(plain);
    let best = { cols: 1, colW: [Math.max(...widths)] };
    for (let cols = Math.min(n, Math.floor(width / 3) || 1); cols >= 1; cols--) {
      const rows = Math.ceil(n / cols);
      const realCols = Math.ceil(n / rows);
      const colW = [];
      for (let c = 0; c < realCols; c++) {
        let m = 0;
        for (let r = 0; r < rows; r++) {
          const i = format === 'across' ? r * realCols + c : c * rows + r;
          if (i < n) m = Math.max(m, widths[i]);
        }
        colW.push(m);
      }
      const total = colW.reduce((a, b) => a + b, 0) + 2 * (realCols - 1);
      if (total < width || cols === 1) {
        best = { cols: realCols, colW, rows };
        break;
      }
    }
    const rows = best.rows || n;
    let out = '';
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < best.cols; c++) {
        const i = format === 'across' ? r * best.cols + c : c * rows + r;
        if (i >= n) continue;
        const last = c === best.cols - 1 || (format === 'across' ? i + 1 >= n : (c + 1) * rows + r >= n);
        line += cells[i] + (last ? '' : ' '.repeat(best.colW[c] - widths[i] + 2));
      }
      out += line + '\n';
    }
    await ctx.out(out);
  };

  const listDir = async (path, showHeader, first) => {
    let names;
    try {
      names = vfs.readdir(path, cwd);
    } catch (e) {
      await ctx.err(`ls: cannot open directory '${path}': ${e.message}\n`);
      status = 2;
      return;
    }
    if (all) names = ['.', '..', ...names];
    else names = names.filter((n) => !n.startsWith('.') || (almost && n !== '.' && n !== '..'));
    if (ignores.length) names = names.filter((n) => !ignores.some((p) => matchPattern(p, n)));
    const base = path === '/' ? '' : path.replace(/\/+$/, '');
    let entries = names.map((n) => {
      const p = n === '.' ? path : n === '..' ? (base || '/') + '/..' : base + '/' + n;
      let node;
      try {
        node = vfs.stat(p, cwd, !!o.L);
      } catch {
        try {
          node = vfs.stat(p, cwd, false);
        } catch {
          node = null;
        }
      }
      return { name: n, path: p, node };
    }).filter((e) => e.node);
    entries = sortEntries(entries);
    if (showHeader) await ctx.out(`${first ? '' : '\n'}${path}:\n`);
    if (long) await printLong(entries, true);
    else {
      if (o.s) {
        const tot = entries.reduce((a, e) => a + blocks(e.node) / 2, 0);
        await ctx.out(`total ${tot}\n`);
      }
      await printShort(entries);
    }
    if (o.R) {
      for (const e of entries) {
        if (e.name === '.' || e.name === '..') continue;
        if (e.node.type === 'dir') {
          let real;
          try {
            real = vfs.stat(e.path, cwd, false);
          } catch {
            continue;
          }
          if (real.type === 'dir') await listDir(e.path, true, false);
        }
      }
    }
  };

  const targets = rest.length ? rest : ['.'];
  const files = [];
  const dirs = [];
  for (const t of targets) {
    const e = entryInfo(t, t, true);
    if (e.err) {
      await ctx.err(`ls: cannot access '${t}': ${e.err.message}\n`);
      status = 2;
      continue;
    }
    if (e.node.type === 'dir' && !o.d) dirs.push(e);
    else files.push(e);
  }
  sortEntries(files);
  if (files.length) {
    if (long) await printLong(files, false);
    else await printShort(files);
  }
  const multi = targets.length > 1 || o.R;
  sortEntries(dirs);
  let first = !files.length;
  for (const d of dirs) {
    await listDir(d.path, multi, first);
    first = false;
  }
  return status;
}

// ---------- cat / tac ----------

async function cat(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'nbsEAvTetu',
    long: { number: 'n', 'number-nonblank': 'b', 'squeeze-blank': 's', 'show-ends': 'E', 'show-all': 'A', 'show-nonprinting': 'v', 'show-tabs': 'T' },
  });
  if (o.A) o.v = o.E = o.T = true;
  if (o.e) o.v = o.E = true;
  if (o.t) o.v = o.T = true;
  const plain = !o.n && !o.b && !o.s && !o.E && !o.v && !o.T;
  let lineNo = 0;
  let prevBlank = false;
  let atLineStart = true;
  const files = rest.length ? rest : ['-'];
  for (const f of files) {
    if (f === '-' && plain) {
      // stream stdin chunk by chunk (interactive cat)
      for (;;) {
        const chunk = await ctx.stdin.read();
        if (chunk === null) break;
        await ctx.out(chunk);
      }
      continue;
    }
    for await (const inp of inputs(ctx, [f])) {
      let text = inp.text;
      if (plain) {
        await ctx.out(text);
        continue;
      }
      const lines = text.split('\n');
      const endsNl = text.endsWith('\n');
      if (endsNl) lines.pop();
      let out = '';
      lines.forEach((line, i) => {
        const blank = line === '';
        if (o.s && blank && prevBlank) return;
        prevBlank = blank;
        if (o.v) {
          line = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\x7f' ? '^?' : '^' + String.fromCharCode(c.charCodeAt(0) + 64)));
          line = line.replace(/[\udc80-\udcff]/g, (c) => {
            const b = c.charCodeAt(0) - 0xdc00;
            const lo = b - 128;
            return 'M-' + (lo < 32 ? '^' + String.fromCharCode(lo + 64) : lo === 127 ? '^?' : String.fromCharCode(lo));
          });
        }
        if (o.T) line = line.replace(/\t/g, '^I');
        if (atLineStart && (o.b ? !blank : o.n)) line = `${String(++lineNo).padStart(6)}\t${line}`;
        if (o.E) line += '$';
        const last = i === lines.length - 1 && !endsNl;
        out += line + (last ? '' : '\n');
        atLineStart = !last;
      });
      await ctx.out(out);
    }
  }
  return ctx.failed ? 1 : 0;
}

async function tac(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'br', params: 's', long: { separator: 's', before: 'b', regex: 'r' } });
  const sep = o.s ?? '\n';
  for await (const inp of inputs(ctx, rest)) {
    const parts = inp.text.split(sep);
    const trailing = parts[parts.length - 1] === '';
    if (trailing) parts.pop();
    let out = '';
    for (let i = parts.length - 1; i >= 0; i--) out += parts[i] + (i === parts.length - 1 && !trailing ? '' : sep);
    if (!trailing && parts.length) out = parts[parts.length - 1] + sep + parts.slice(0, -1).reverse().map((p) => p + sep).join('');
    await ctx.out(out);
  }
  return ctx.failed ? 1 : 0;
}

// ---------- prompting helper (cp -i, rm -i, mv -i) ----------

async function ask(ctx, question) {
  await ctx.err(question);
  const line = await ctx.stdin.readLine();
  return /^[yY]/.test(line || '');
}

// ---------- mkdir / rmdir / touch ----------

function parseModeArg(spec, base = 0o777, isDir = true, umask = 0) {
  if (/^[0-7]+$/.test(spec)) return parseInt(spec, 8);
  let mode = base;
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/.exec(clause);
    if (!m) throw new UsageError(`invalid mode: '${spec}'`, 1, false);
    const who = m[1];
    const ops = m[2].match(/[-+=][rwxXstugo]*/g);
    for (const op of ops) {
      const sign = op[0];
      const perms = op.slice(1);
      let bits = 0;
      for (const c of perms) {
        if (c === 'r') bits |= 0o444;
        else if (c === 'w') bits |= 0o222;
        else if (c === 'x') bits |= 0o111;
        else if (c === 'X') {
          if (isDir || mode & 0o111) bits |= 0o111;
        } else if (c === 's') bits |= 0o6000;
        else if (c === 't') bits |= 0o1000;
        else if ('ugo'.includes(c)) {
          const sh = c === 'u' ? 6 : c === 'g' ? 3 : 0;
          const v = (mode >> sh) & 7;
          bits |= (v << 6) | (v << 3) | v;
        }
      }
      let mask = 0;
      const whoSet = who || 'a';
      for (const w of whoSet === 'a' ? 'ugo' : whoSet) {
        if (w === 'u') mask |= 0o4700;
        if (w === 'g') mask |= 0o2070;
        if (w === 'o') mask |= 0o1007;
      }
      if (!who) mask = mask & ~(sign === '=' ? 0 : umask);
      bits &= mask | (perms.includes('t') ? 0o1000 : 0);
      if (sign === '+') mode |= bits;
      else if (sign === '-') mode &= ~bits;
      else mode = (mode & ~mask) | bits;
    }
  }
  return mode;
}

async function mkdir(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'pv', params: 'm', long: { parents: 'p', verbose: 'v', mode: 'm' } });
  if (!rest.length) throw new UsageError('missing operand');
  const sh = ctx.shell;
  let st = 0;
  for (const d of rest) {
    try {
      const mode = o.m ? parseModeArg(o.m, 0o777 & ~sh.umask) : 0o777;
      const created = ctx.vfs.mkdir(d, ctx.cwd, { parents: !!o.p, mode, umask: o.m ? 0 : sh.umask });
      if (o.v) for (const c of created) await ctx.out(`mkdir: created directory '${o.p ? relTo(d, c, ctx.cwd) : d}'\n`);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      await ctx.err(`mkdir: cannot create directory ‘${d}’: ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

function relTo(arg, created, cwd) {
  if (arg.startsWith('/')) return created;
  const base = cwd === '/' ? '/' : cwd + '/';
  return created.startsWith(base) ? created.slice(base.length) : created;
}

async function rmdir(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'pv', long: { parents: 'p', verbose: 'v', 'ignore-fail-on-non-empty': '' } });
  if (!rest.length) throw new UsageError('missing operand');
  let st = 0;
  for (let d of rest) {
    const list = [d];
    if (o.p) {
      let x = d.replace(/\/+$/, '');
      while (x.includes('/')) {
        x = x.slice(0, x.lastIndexOf('/'));
        if (x) list.push(x);
      }
    }
    for (const x of list) {
      try {
        ctx.vfs.rmdir(x, ctx.cwd);
        if (o.v) await ctx.out(`rmdir: removing directory, '${x}'\n`);
      } catch (e) {
        if (!(e instanceof FsError)) throw e;
        if (e.code === 'ENOTEMPTY' && o['ignore-fail-on-non-empty']) break;
        await ctx.err(`rmdir: failed to remove '${x}': ${e.message}\n`);
        st = 1;
        break;
      }
    }
  }
  return st;
}

function parseTouchDate(s) {
  // -d accepts many formats; support ISO-ish, "now", "yesterday", "N days ago", @epoch
  if (s.startsWith('@')) return Number(s.slice(1)) * 1000;
  const now = Date.now();
  if (s === 'now' || s === 'today') return now;
  if (s === 'yesterday') return now - 86400e3;
  if (s === 'tomorrow') return now + 86400e3;
  let m = /^(\d+)\s*(second|sec|minute|min|hour|day|week|month|year)s?\s+ago$/.exec(s);
  if (m) {
    const mul = { second: 1, sec: 1, minute: 60, min: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }[m[2]];
    return now - Number(m[1]) * mul * 1000;
  }
  const t = Date.parse(s.replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  if (!isNaN(t)) return t;
  return null;
}

async function touch(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'acmfh', params: 'dtr', long: { 'no-create': 'c', date: 'd', reference: 'r', time: '=', 'no-dereference': 'h' } });
  if (!rest.length) throw new UsageError('missing file operand');
  let t = Date.now();
  if (o.d) {
    t = parseTouchDate(o.d);
    if (t === null) throw new UsageError(`invalid date format '${o.d}'`, 1, false);
  }
  if (o.t) {
    const m = /^(?:(\d\d)?(\d\d))?(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d\d))?$/.exec(o.t);
    if (!m) throw new UsageError(`invalid date format '${o.t}'`, 1, false);
    const year = m[2] ? Number((m[1] || '20') + m[2]) : new Date().getFullYear();
    t = new Date(year, Number(m[3]) - 1, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] || 0)).getTime();
  }
  if (o.r) {
    try {
      t = ctx.vfs.stat(o.r, ctx.cwd).mtime;
    } catch (e) {
      await ctx.err(`touch: failed to get attributes of '${o.r}': ${e.message}\n`);
      return 1;
    }
  }
  const onlyA = o.a && !o.m;
  const onlyM = o.m && !o.a;
  let st = 0;
  for (const f of rest) {
    try {
      if (!ctx.vfs.exists(f, ctx.cwd)) {
        if (o.c) continue;
        ctx.vfs.writeFile(f, ctx.cwd, '', { umask: ctx.shell.umask });
      }
      ctx.vfs.utimes(f, ctx.cwd, onlyM ? null : t, onlyA ? null : t);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      await ctx.err(`touch: cannot touch '${f}': ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

// ---------- cp / mv / rm / ln ----------

function isDir(vfs, p, cwd) {
  try {
    return vfs.stat(p, cwd).type === 'dir';
  } catch {
    return false;
  }
}

function copyNode(vfs, src, dst, cwd, opts, report) {
  const s = vfs.stat(src, cwd, opts.deref);
  if (s.type === 'dir') {
    if (!opts.recursive) {
      report(`cp: -r not specified; omitting directory '${src}'`);
      return false;
    }
    const dabs = abspath(cwd, dst);
    const sabs = abspath(cwd, src);
    if (dabs === sabs || dabs.startsWith(sabs + '/')) {
      report(`cp: cannot copy a directory, '${src}', into itself, '${dst}'`);
      return false;
    }
    if (!vfs.exists(dst, cwd)) vfs.mkdir(dst, cwd, { mode: opts.preserve ? s.mode : s.mode, umask: opts.preserve ? 0 : 0 });
    else if (!isDir(vfs, dst, cwd)) {
      report(`cp: cannot overwrite non-directory '${dst}' with directory '${src}'`);
      return false;
    }
    let ok = true;
    for (const n of vfs.readdir(src, cwd)) {
      if (!copyNode(vfs, src.replace(/\/+$/, '') + '/' + n, dst.replace(/\/+$/, '') + '/' + n, cwd, { ...opts, deref: opts.derefAll }, report)) ok = false;
    }
    if (opts.preserve) {
      try {
        const d = vfs.stat(dst, cwd);
        d.mtime = s.mtime;
        d.mode = s.mode;
      } catch {}
    }
    return ok;
  }
  if (s.type === 'link') {
    if (vfs.exists(dst, cwd, false)) vfs.unlink(dst, cwd);
    vfs.symlink(s.target, dst, cwd);
    return true;
  }
  if (opts.update && vfs.exists(dst, cwd)) {
    const d = vfs.stat(dst, cwd);
    if (d.mtime >= s.mtime) return true;
  }
  if (opts.noClobber && vfs.exists(dst, cwd)) return true;
  if (opts.hardlink) {
    if (vfs.exists(dst, cwd, false)) vfs.unlink(dst, cwd);
    vfs.link(src, dst, cwd);
    return true;
  }
  if (opts.symlink) {
    if (vfs.exists(dst, cwd, false)) vfs.unlink(dst, cwd);
    vfs.symlink(abspath(cwd, src), dst, cwd);
    return true;
  }
  const data = vfs.readNode(s, src);
  const existed = vfs.exists(dst, cwd);
  if (existed && opts.force) {
    const d = vfs.stat(dst, cwd);
    if (!vfs.can(d, 2)) vfs.unlink(dst, cwd);
  }
  const node = vfs.writeFile(dst, cwd, data, { mode: s.mode, umask: existed ? 0 : opts.umask });
  if (opts.preserve) {
    node.mode = s.mode;
    node.mtime = s.mtime;
    node.atime = s.atime;
    if (vfs.cred.uid === 0) {
      node.uid = s.uid;
      node.gid = s.gid;
    }
  }
  return true;
}

async function cp(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'rRaipfnvulsPLHdTx',
    params: 't',
    long: { recursive: 'r', archive: 'a', interactive: 'i', force: 'f', 'no-clobber': 'n', verbose: 'v', update: 'u', link: 'l', 'symbolic-link': 's', 'target-directory': 't', 'no-target-directory': 'T', preserve: '?', 'no-dereference': 'P', dereference: 'L', parents: '' },
  });
  let files = rest;
  let dest;
  if (o.t) dest = o.t;
  else {
    if (files.length < 2) throw new UsageError(files.length ? `missing destination file operand after '${files[0]}'` : 'missing file operand');
    dest = files[files.length - 1];
    files = files.slice(0, -1);
  }
  const vfs = ctx.vfs;
  const destIsDir = !o.T && isDir(vfs, dest, ctx.cwd);
  if (files.length > 1 && !destIsDir) {
    await ctx.err(`cp: target '${dest}' is not a directory\n`);
    return 1;
  }
  const opts = {
    recursive: o.r || o.R || o.a,
    preserve: o.a || o.p || o.preserve,
    deref: !(o.P || o.a || o.d || ((o.r || o.R) && !o.L)),
    derefAll: !!o.L,
    update: o.u,
    noClobber: o.n,
    hardlink: o.l,
    symlink: o.s,
    force: o.f,
    umask: ctx.shell.umask,
  };
  let st = 0;
  for (const f of files) {
    let target = destIsDir ? dest.replace(/\/+$/, '') + '/' + (o.parents ? f.replace(/^\/+/, '') : basename(f)) : dest;
    try {
      if (o.parents) vfs.mkdir(dirname(target), ctx.cwd, { parents: true });
      vfs.stat(f, ctx.cwd, false);
      if (vfs.exists(target, ctx.cwd) && abspath(ctx.cwd, f) === abspath(ctx.cwd, target)) {
        await ctx.err(`cp: '${f}' and '${target}' are the same file\n`);
        st = 1;
        continue;
      }
      if (o.i && vfs.exists(target, ctx.cwd) && !isDir(vfs, target, ctx.cwd)) {
        if (!(await ask(ctx, `cp: overwrite '${target}'? `))) continue;
      }
      const msgs = [];
      const ok = copyNode(vfs, f, target, ctx.cwd, opts, (m) => msgs.push(m));
      for (const m of msgs) await ctx.err(m + '\n');
      if (!ok) st = 1;
      if (o.v && ok) await ctx.out(`'${f}' -> '${target}'\n`);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code === 'ENOENT' && !vfs.exists(f, ctx.cwd, false)) await ctx.err(`cp: cannot stat '${f}': ${e.message}\n`);
      else await ctx.err(`cp: cannot create regular file '${target}': ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

async function mv(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'ifnvuTb',
    params: 't',
    long: { interactive: 'i', force: 'f', 'no-clobber': 'n', verbose: 'v', update: 'u', 'target-directory': 't', 'no-target-directory': 'T', backup: '?' },
  });
  let files = rest;
  let dest;
  if (o.t) dest = o.t;
  else {
    if (files.length < 2) throw new UsageError(files.length ? `missing destination file operand after '${files[0]}'` : 'missing file operand');
    dest = files[files.length - 1];
    files = files.slice(0, -1);
  }
  const vfs = ctx.vfs;
  const destIsDir = !o.T && isDir(vfs, dest, ctx.cwd);
  if (files.length > 1 && !destIsDir) {
    await ctx.err(`mv: target '${dest}' is not a directory\n`);
    return 1;
  }
  let st = 0;
  for (const f of files) {
    const target = destIsDir ? dest.replace(/\/+$/, '') + '/' + basename(f) : dest;
    try {
      vfs.stat(f, ctx.cwd, false);
      const exists = vfs.exists(target, ctx.cwd, false);
      if (exists && o.n) continue;
      if (exists && o.u && vfs.stat(target, ctx.cwd).mtime >= vfs.stat(f, ctx.cwd).mtime) continue;
      if (exists && o.i && !o.f) {
        if (!(await ask(ctx, `mv: overwrite '${target}'? `))) continue;
      }
      if (exists && o.backup !== undefined) vfs.rename(target, target + '~', ctx.cwd);
      if (abspath(ctx.cwd, f) === abspath(ctx.cwd, target)) {
        await ctx.err(`mv: '${f}' and '${target}' are the same file\n`);
        st = 1;
        continue;
      }
      const tnode = exists ? vfs.stat(target, ctx.cwd, false) : null;
      const snode = vfs.stat(f, ctx.cwd, false);
      if (tnode && tnode.type === 'dir' && snode.type !== 'dir') {
        await ctx.err(`mv: cannot overwrite directory '${target}' with non-directory\n`);
        st = 1;
        continue;
      }
      if (tnode && tnode.type !== 'dir' && snode.type !== 'dir') vfs.unlink(target, ctx.cwd);
      vfs.rename(f, target, ctx.cwd);
      if (o.v) await ctx.out(`renamed '${f}' -> '${target}'\n`);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code === 'ENOENT' && !vfs.exists(f, ctx.cwd, false)) await ctx.err(`mv: cannot stat '${f}': ${e.message}\n`);
      else if (e.code === 'EINVAL') await ctx.err(`mv: cannot move '${f}' to a subdirectory of itself, '${target}'\n`);
      else await ctx.err(`mv: cannot move '${f}' to '${target}': ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

async function rm(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'rRfiIdv',
    long: { recursive: 'r', force: 'f', interactive: '?', dir: 'd', verbose: 'v', 'no-preserve-root': '', 'preserve-root': '', 'one-file-system': '' },
  });
  if (!rest.length) {
    if (o.f) return 0;
    throw new UsageError('missing operand');
  }
  const vfs = ctx.vfs;
  const rec = o.r || o.R;
  let st = 0;
  if (o.I && (rest.length > 3 || rec)) {
    if (!(await ask(ctx, `rm: remove ${rest.length} argument${rest.length > 1 ? 's' : ''}${rec ? ' recursively' : ''}? `))) return 0;
  }
  const removeOne = async (p) => {
    let node;
    try {
      node = vfs.stat(p, ctx.cwd, false);
    } catch (e) {
      if (o.f && e.code === 'ENOENT') return;
      await ctx.err(`rm: cannot remove '${p}': ${e.message}\n`);
      st = 1;
      return;
    }
    if (node.type === 'dir') {
      if (!rec) {
        if (o.d) {
          try {
            vfs.rmdir(p, ctx.cwd);
            if (o.v) await ctx.out(`removed directory '${p}'\n`);
          } catch (e) {
            await ctx.err(`rm: cannot remove '${p}': ${e.message}\n`);
            st = 1;
          }
          return;
        }
        await ctx.err(`rm: cannot remove '${p}': Is a directory\n`);
        st = 1;
        return;
      }
      if (o.i === true && !(await ask(ctx, `rm: descend into directory '${p}'? `))) return;
      let names = [];
      try {
        names = vfs.readdir(p, ctx.cwd);
      } catch (e) {
        await ctx.err(`rm: cannot remove '${p}': ${e.message}\n`);
        st = 1;
        return;
      }
      for (const n of names) {
        await ctx.tick();
        await removeOne(p.replace(/\/+$/, '') + '/' + n);
      }
      if (o.i === true && !(await ask(ctx, `rm: remove directory '${p}'? `))) return;
      try {
        vfs.rmdir(p, ctx.cwd);
        if (o.v) await ctx.out(`removed directory '${p}'\n`);
      } catch (e) {
        await ctx.err(`rm: cannot remove '${p}': ${e.message}\n`);
        st = 1;
      }
      return;
    }
    if (o.i === true && !(await ask(ctx, `rm: remove ${node.type === 'file' ? (nodeSize(node) ? 'regular file' : 'regular empty file') : node.type === 'link' ? 'symbolic link' : 'file'} '${p}'? `))) return;
    if (!o.f && !o.i && node.type === 'file' && !vfs.can(node, 2) && ctx.stdin.isTerminal) {
      if (!(await ask(ctx, `rm: remove write-protected regular file '${p}'? `))) return;
    }
    try {
      vfs.unlink(p, ctx.cwd);
      if (o.v) await ctx.out(`removed '${p}'\n`);
    } catch (e) {
      await ctx.err(`rm: cannot remove '${p}': ${e.message}\n`);
      st = 1;
    }
  };
  for (const p of rest) {
    const clean = p.replace(/\/+$/, '');
    if (/(^|\/)\.\.?$/.test(clean)) {
      await ctx.err(`rm: refusing to remove '.' or '..' directory: skipping '${p}'\n`);
      st = 1;
      continue;
    }
    if (rec && abspath(ctx.cwd, p) === '/' && !o['no-preserve-root']) {
      await ctx.err(`rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n`);
      st = 1;
      continue;
    }
    await removeOne(p);
  }
  return st;
}

async function ln(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'sfnvTrbiL', params: 't', long: { symbolic: 's', force: 'f', 'no-dereference': 'n', verbose: 'v', 'target-directory': 't', 'no-target-directory': 'T', relative: 'r' } });
  let files = rest;
  let dest;
  if (o.t) dest = o.t;
  else if (files.length === 1) {
    dest = '.';
  } else {
    if (!files.length) throw new UsageError('missing file operand');
    dest = files[files.length - 1];
    files = files.slice(0, -1);
  }
  const vfs = ctx.vfs;
  const destIsDir = !o.T && !(o.n && vfs.exists(dest, ctx.cwd, false) && vfs.stat(dest, ctx.cwd, false).type === 'link') && isDir(vfs, dest, ctx.cwd);
  if (files.length > 1 && !destIsDir) {
    await ctx.err(`ln: target '${dest}' is not a directory\n`);
    return 1;
  }
  let st = 0;
  for (const f of files) {
    const target = destIsDir ? dest.replace(/\/+$/, '') + '/' + basename(f) : dest;
    try {
      if (vfs.exists(target, ctx.cwd, false)) {
        if (o.f) vfs.unlink(target, ctx.cwd);
        else if (o.i) {
          if (!(await ask(ctx, `ln: replace '${target}'? `))) continue;
          vfs.unlink(target, ctx.cwd);
        } else {
          await ctx.err(`ln: failed to create ${o.s ? 'symbolic' : 'hard'} link '${target}': File exists\n`);
          st = 1;
          continue;
        }
      }
      if (o.s) {
        let t = f;
        if (o.r) {
          const from = dirname(abspath(ctx.cwd, target)).split('/').filter(Boolean);
          const to = abspath(ctx.cwd, f).split('/').filter(Boolean);
          let k = 0;
          while (k < from.length && from[k] === to[k]) k++;
          t = [...Array(from.length - k).fill('..'), ...to.slice(k)].join('/') || '.';
        }
        vfs.symlink(t, target, ctx.cwd);
      } else {
        const n = vfs.stat(f, ctx.cwd, false);
        if (n.type === 'dir') {
          await ctx.err(`ln: ${f}: hard link not allowed for directory\n`);
          st = 1;
          continue;
        }
        vfs.link(f, target, ctx.cwd);
      }
      if (o.v) await ctx.out(`'${target}' ${o.s ? '->' : '=>'} '${f}'\n`);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (!o.s && e.code === 'ENOENT') await ctx.err(`ln: failed to access '${f}': ${e.message}\n`);
      else await ctx.err(`ln: failed to create ${o.s ? 'symbolic' : 'hard'} link '${target}': ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

// ---------- chmod / chown ----------

async function chmod(ctx) {
  const args = [];
  const flags = {};
  let modeArg = null;
  for (const a of ctx.args) {
    if (modeArg === null && /^[-+=][rwxXstugo]+/.test(a) && !/^-[Rvcf]+$/.test(a)) {
      modeArg = a;
      continue;
    }
    if (/^-[Rvcf]+$/.test(a)) {
      for (const c of a.slice(1)) flags[c] = true;
      continue;
    }
    if (a === '--recursive') flags.R = true;
    else if (a === '--verbose') flags.v = true;
    else if (a === '--changes') flags.c = true;
    else if (a.startsWith('--reference=')) {
      modeArg = (ctx.vfs.stat(a.slice(12), ctx.cwd).mode & 0o7777).toString(8);
    } else if (modeArg === null) modeArg = a;
    else args.push(a);
  }
  if (modeArg === null) throw new UsageError('missing operand');
  if (!args.length) throw new UsageError(`missing operand after '${modeArg}'`);
  const vfs = ctx.vfs;
  let st = 0;
  const apply = async (p) => {
    let node;
    try {
      node = vfs.stat(p, ctx.cwd);
    } catch (e) {
      await ctx.err(`chmod: cannot access '${p}': ${e.message}\n`);
      st = 1;
      return;
    }
    let mode;
    try {
      mode = parseModeArg(modeArg, node.mode & 0o7777, node.type === 'dir', ctx.shell.umask);
    } catch (e) {
      await ctx.err(`chmod: invalid mode: '${modeArg}'\n`);
      st = 1;
      return;
    }
    const old = node.mode & 0o7777;
    try {
      vfs.chmod(p, ctx.cwd, mode);
    } catch (e) {
      await ctx.err(`chmod: changing permissions of '${p}': ${e.message}\n`);
      st = 1;
      return;
    }
    if (flags.v || (flags.c && old !== mode)) {
      const fakeOld = { ...node, mode: old };
      const fakeNew = { ...node, mode };
      await ctx.out(old === mode ? `mode of '${p}' retained as ${old.toString(8).padStart(4, '0')} (${modeString(fakeOld).slice(1)})\n` : `mode of '${p}' changed from ${old.toString(8).padStart(4, '0')} (${modeString(fakeOld).slice(1)}) to ${mode.toString(8).padStart(4, '0')} (${modeString(fakeNew).slice(1)})\n`);
    }
    if (flags.R && node.type === 'dir') {
      for (const n of vfs.readdir(p, ctx.cwd)) {
        const child = p.replace(/\/+$/, '') + '/' + n;
        if (vfs.stat(child, ctx.cwd, false).type === 'link') continue;
        await apply(child);
      }
    }
  };
  for (const p of args) await apply(p);
  return st;
}

async function chown(ctx) {
  const isChgrp = ctx.name === 'chgrp';
  const { o, rest } = getopt(ctx.args, { flags: 'Rvchf', long: { recursive: 'R', verbose: 'v', changes: 'c', 'no-dereference': 'h', reference: '=' } });
  if (rest.length < (o.reference ? 1 : 2)) throw new UsageError('missing operand');
  const spec = o.reference ? null : rest.shift();
  const sys = ctx.shell.system;
  let uid = null;
  let gid = null;
  if (o.reference) {
    const r = ctx.vfs.stat(o.reference, ctx.cwd);
    uid = isChgrp ? null : r.uid;
    gid = r.gid;
  } else if (isChgrp) {
    const g = /^\d+$/.test(spec) ? { gid: Number(spec) } : sys.groupByName(spec);
    if (!g) {
      await ctx.err(`chgrp: invalid group: '${spec}'\n`);
      return 1;
    }
    gid = g.gid;
  } else {
    const [u, g] = spec.split(/[:.]/);
    if (u) {
      const uu = /^\d+$/.test(u) ? { uid: Number(u) } : sys.userByName(u);
      if (!uu) {
        await ctx.err(`chown: invalid user: '${spec}'\n`);
        return 1;
      }
      uid = uu.uid;
      if (spec.includes(':') && g === '' && uu.gid !== undefined) gid = uu.gid;
    }
    if (g) {
      const gg = /^\d+$/.test(g) ? { gid: Number(g) } : sys.groupByName(g);
      if (!gg) {
        await ctx.err(`chown: invalid group: '${spec}'\n`);
        return 1;
      }
      gid = gg.gid;
    }
  }
  let st = 0;
  const vfs = ctx.vfs;
  const apply = async (p) => {
    try {
      const n = vfs.stat(p, ctx.cwd);
      vfs.chown(p, ctx.cwd, uid, gid, !o.h);
      if (o.v) await ctx.out(`ownership of '${p}' retained/changed\n`);
      if (o.R && n.type === 'dir') for (const c of vfs.readdir(p, ctx.cwd)) await apply(p.replace(/\/+$/, '') + '/' + c);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (e.code === 'ENOENT') await ctx.err(`${ctx.name}: cannot access '${p}': ${e.message}\n`);
      else await ctx.err(`${ctx.name}: changing ${isChgrp || uid === null ? 'group' : 'ownership'} of '${p}': ${e.message}\n`);
      st = 1;
    }
  };
  for (const p of rest) await apply(p);
  return st;
}

// ---------- stat ----------

function fileTypeName(n) {
  if (n.type === 'dir') return 'directory';
  if (n.type === 'link') return 'symbolic link';
  if (n.type === 'chr') return 'character special file';
  if (n.type === 'fifo') return 'fifo';
  return nodeSize(n) ? 'regular file' : 'regular empty file';
}

function isoTime(t, nanos = true) {
  const d = new Date(t);
  const p = (x, n = 2) => String(x).padStart(n, '0');
  const tz = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${nanos ? '.' + p(d.getMilliseconds(), 3) + '000000' : ''} ${tz >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(tz) / 60))}${p(Math.abs(tz) % 60)}`;
}

async function stat(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'LtfZ', params: 'c', long: { format: 'c', printf: '=', dereference: 'L', terse: 't', 'file-system': 'f' } });
  if (!rest.length) throw new UsageError('missing operand');
  const sys = ctx.shell.system;
  let st = 0;
  for (const f of rest) {
    let n;
    try {
      n = ctx.vfs.stat(f, ctx.cwd, !!o.L);
    } catch (e) {
      await ctx.err(`stat: cannot statx '${f}': ${e.message}\n`);
      st = 1;
      continue;
    }
    if (o.f) {
      await ctx.out(`  File: "${f}"\n    ID: 0        Namelen: 255     Type: ext2/ext3\nBlock size: 4096       Fundamental block size: 4096\nBlocks: Total: 8191486    Free: 6012345    Available: 5594321\nInodes: Total: 2097152    Free: 1834567\n`);
      continue;
    }
    const fmt = o.c ?? o.printf;
    const fields = {
      n: f,
      N: n.type === 'link' ? `'${f}' -> '${n.target}'` : `'${f}'`,
      s: String(nodeSize(n)),
      b: String(blocks(n)),
      B: '512',
      o: '4096',
      a: (n.mode & 0o7777).toString(8),
      A: modeString(n),
      f: (n.mode | (n.type === 'dir' ? 0o40000 : n.type === 'link' ? 0o120000 : 0o100000)).toString(16),
      F: fileTypeName(n),
      u: String(n.uid),
      U: sys.userName(n.uid),
      g: String(n.gid),
      G: sys.groupName(n.gid),
      h: String(n.nlink),
      i: String(n.ino),
      d: '2049',
      D: '801',
      t: '0',
      T: '0',
      m: '/',
      x: isoTime(n.atime),
      X: String(Math.floor(n.atime / 1000)),
      y: isoTime(n.mtime),
      Y: String(Math.floor(n.mtime / 1000)),
      z: isoTime(n.ctime),
      Z: String(Math.floor(n.ctime / 1000)),
      w: '-',
      W: '0',
    };
    if (fmt !== undefined) {
      let s = fmt.replace(/%([a-zA-Z%])/g, (m, c) => (c === '%' ? '%' : fields[c] ?? m));
      if (o.printf !== undefined) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      else s += '\n';
      await ctx.out(s);
      continue;
    }
    if (o.t) {
      await ctx.out(`${f} ${fields.s} ${fields.b} ${fields.f} ${n.uid} ${n.gid} 801 ${n.ino} ${n.nlink} 0 0 ${fields.X} ${fields.Y} ${fields.Z} 0 4096\n`);
      continue;
    }
    const name = n.type === 'link' ? `${f} -> ${n.target}` : f;
    await ctx.out(
      `  File: ${name}\n` +
        `  Size: ${fields.s.padEnd(15)}\tBlocks: ${fields.b.padEnd(10)} IO Block: 4096   ${fields.F}\n` +
        `Device: 8,1\tInode: ${String(n.ino).padEnd(11)} Links: ${n.nlink}\n` +
        `Access: (${(n.mode & 0o7777).toString(8).padStart(4, '0')}/${fields.A})  Uid: (${String(n.uid).padStart(5)}/${fields.U.padStart(8)})   Gid: (${String(n.gid).padStart(5)}/${fields.G.padStart(8)})\n` +
        `Access: ${fields.x}\nModify: ${fields.y}\nChange: ${fields.z}\n Birth: -\n`
    );
  }
  return st;
}

// ---------- find ----------

function parseFindExpr(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = tokens[i++];
    if (t === undefined) throw new UsageError('expected an expression', 1, false);
    if (t === '(') {
      const e = orE();
      if (tokens[i++] !== ')') throw new UsageError("invalid expression; I was expecting to find a ')' somewhere but did not see one.", 1, false);
      return e;
    }
    if (t === '!' || t === '-not') return { op: 'not', a: primary() };
    const arg = () => {
      const v = tokens[i++];
      if (v === undefined) throw new UsageError(`missing argument to \`${t}'`, 1, false);
      return v;
    };
    switch (t) {
      case '-name':
      case '-iname':
      case '-path':
      case '-ipath':
      case '-wholename':
      case '-iwholename':
      case '-regex':
      case '-iregex':
      case '-type':
      case '-xtype':
      case '-size':
      case '-mtime':
      case '-mmin':
      case '-atime':
      case '-amin':
      case '-ctime':
      case '-cmin':
      case '-newer':
      case '-perm':
      case '-user':
      case '-group':
      case '-uid':
      case '-gid':
      case '-links':
      case '-inum':
      case '-samefile':
      case '-lname':
      case '-ilname':
      case '-fprint':
        return { op: t, v: arg() };
      case '-printf':
      case '-fprintf':
        return { op: t, v: arg() };
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir': {
        const cmdv = [];
        for (;;) {
          const v = tokens[i++];
          if (v === undefined) throw new UsageError(`missing argument to \`${t}'`, 1, false);
          if (v === ';') return { op: t, cmd: cmdv, plus: false };
          if (v === '+' && cmdv[cmdv.length - 1] === '{}') return { op: t, cmd: cmdv, plus: true };
          cmdv.push(v);
        }
      }
      case '-maxdepth':
      case '-mindepth':
        return { op: t, v: arg(), global: true };
      case '-print':
      case '-print0':
      case '-ls':
      case '-delete':
      case '-prune':
      case '-quit':
      case '-true':
      case '-false':
      case '-empty':
      case '-readable':
      case '-writable':
      case '-executable':
      case '-nouser':
      case '-nogroup':
      case '-depth':
      case '-xdev':
      case '-mount':
      case '-follow':
      case '-noleaf':
      case '-daystart':
        return { op: t };
    }
    throw new UsageError(`unknown predicate \`${t}'`, 1, false);
  };
  const andE = () => {
    let l = primary();
    for (;;) {
      const t = peek();
      if (t === undefined || t === ')' || t === '-o' || t === '-or' || t === ',') break;
      if (t === '-a' || t === '-and') i++;
      l = { op: 'and', a: l, b: primary() };
    }
    return l;
  };
  const orE = () => {
    let l = andE();
    while (peek() === '-o' || peek() === '-or' || peek() === ',') {
      const comma = peek() === ',';
      i++;
      l = { op: comma ? 'comma' : 'or', a: l, b: andE() };
    }
    return l;
  };
  if (!tokens.length) return null;
  const e = orE();
  if (i < tokens.length) throw new UsageError(`paths must precede expression: \`${tokens[i]}'`, 1, false);
  return e;
}

function hasAction(e) {
  if (!e) return false;
  if (['-print', '-print0', '-ls', '-exec', '-execdir', '-ok', '-okdir', '-delete', '-printf', '-fprint', '-fprintf', '-quit'].includes(e.op)) return true;
  return hasAction(e.a) || hasAction(e.b);
}

function cmpNum(spec, value) {
  const m = /^([+-]?)(\d+)$/.exec(spec);
  if (!m) return false;
  const n = Number(m[2]);
  if (m[1] === '+') return value > n;
  if (m[1] === '-') return value < n;
  return value === n;
}

async function find(ctx) {
  const args = ctx.args.slice();
  let follow = false;
  while (args[0] === '-L' || args[0] === '-H' || args[0] === '-P') {
    follow = args[0] === '-L';
    args.shift();
  }
  const paths = [];
  while (args.length && !/^[-!(),]/.test(args[0])) paths.push(args.shift());
  if (args[0] === '-' && false) paths.push(args.shift());
  if (!paths.length) paths.push('.');
  let expr;
  try {
    expr = parseFindExpr(args);
  } catch (e) {
    if (e instanceof UsageError) {
      await ctx.err(`find: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  let maxdepth = Infinity;
  let mindepth = 0;
  let depthFirst = false;
  const scan = (e) => {
    if (!e) return;
    if (e.op === '-maxdepth') maxdepth = Number(e.v);
    if (e.op === '-mindepth') mindepth = Number(e.v);
    if (e.op === '-depth' || e.op === '-delete') depthFirst = true;
    if (e.op === '-follow') follow = true;
    scan(e.a);
    scan(e.b);
  };
  scan(expr);
  const printDefault = !hasAction(expr);
  const vfs = ctx.vfs;
  const sys = ctx.shell.system;
  let st = 0;
  let quit = false;
  const pending = [];
  const now = Date.now();
  const sh = ctx.shell;

  const runExec = async (e, path, node) => {
    const dir = e.op.endsWith('dir');
    const argv = e.cmd.map((x) => x.split('{}').join(dir ? './' + basename(path) : path));
    if (e.op.startsWith('-ok')) {
      await ctx.err(`< ${argv.join(' ')} ... ${path} > ? `);
      const ans = await ctx.stdin.readLine();
      if (!/^[yY]/.test(ans || '')) return false;
    }
    const savedCwd = sh.cwd;
    if (dir) sh.cwd = abspath(savedCwd, dirname(path));
    try {
      const r = await sh.runCommand(argv, ctx.io, {});
      return r === 0;
    } finally {
      if (dir) sh.cwd = savedCwd;
    }
  };

  const evalE = async (e, path, node, depth, startPath) => {
    if (!e) return true;
    const name = depth === 0 ? basename(path) : basename(path);
    switch (e.op) {
      case 'and':
        return (await evalE(e.a, path, node, depth, startPath)) && evalE(e.b, path, node, depth, startPath);
      case 'or':
        return (await evalE(e.a, path, node, depth, startPath)) || evalE(e.b, path, node, depth, startPath);
      case 'comma':
        await evalE(e.a, path, node, depth, startPath);
        return evalE(e.b, path, node, depth, startPath);
      case 'not':
        return !(await evalE(e.a, path, node, depth, startPath));
      case '-name':
        return matchPattern(e.v, name, { extglob: false });
      case '-iname':
        return matchPattern(e.v, name, { extglob: false, nocase: true });
      case '-path':
      case '-wholename':
        return matchPattern(e.v, path, { extglob: false });
      case '-ipath':
      case '-iwholename':
        return matchPattern(e.v, path, { extglob: false, nocase: true });
      case '-regex':
      case '-iregex':
        try {
          return new RegExp('^(?:' + posixRegex(e.v, { extended: false }).source + ')$', e.op === '-iregex' ? 'i' : '').test(path);
        } catch {
          return false;
        }
      case '-lname':
      case '-ilname':
        return node.type === 'link' && matchPattern(e.v, node.target, { nocase: e.op === '-ilname' });
      case '-type':
      case '-xtype': {
        let n = node;
        if (e.op === '-xtype' && node.type === 'link') {
          try {
            n = vfs.stat(path, ctx.cwd, true);
          } catch {}
        }
        const t = { f: 'file', d: 'dir', l: 'link', c: 'chr', p: 'fifo' };
        return e.v.split(',').some((c) => t[c] === n.type);
      }
      case '-size': {
        const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(e.v);
        if (!m) return false;
        const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1048576, G: 1073741824, '': 512 }[m[3]];
        const size = Math.ceil(nodeSize(node) / unit);
        return cmpNum(m[1] + m[2], size);
      }
      case '-mtime':
      case '-atime':
      case '-ctime': {
        const k = e.op[1] + 'time';
        return cmpNum(e.v, Math.floor((now - node[k]) / 86400000));
      }
      case '-mmin':
      case '-amin':
      case '-cmin': {
        const k = e.op[1] + 'time';
        const m = /^([+-]?)(\d+)$/.exec(e.v);
        const v = (now - node[k]) / 60000;
        if (!m) return false;
        const n = Number(m[2]);
        return m[1] === '+' ? v > n : m[1] === '-' ? v < n : Math.ceil(v) === n;
      }
      case '-newer': {
        try {
          return node.mtime > vfs.stat(e.v, ctx.cwd).mtime;
        } catch {
          return false;
        }
      }
      case '-perm': {
        const m = /^([-/]?)(.*)$/.exec(e.v);
        const want = /^[0-7]+$/.test(m[2]) ? parseInt(m[2], 8) : parseModeArg(m[2], 0, false);
        const have = node.mode & 0o7777;
        if (m[1] === '-') return (have & want) === want;
        if (m[1] === '/') return want === 0 || (have & want) !== 0;
        return have === want;
      }
      case '-user':
        return sys.userName(node.uid) === e.v || String(node.uid) === e.v;
      case '-group':
        return sys.groupName(node.gid) === e.v || String(node.gid) === e.v;
      case '-uid':
        return cmpNum(e.v, node.uid);
      case '-gid':
        return cmpNum(e.v, node.gid);
      case '-links':
        return cmpNum(e.v, node.nlink);
      case '-inum':
        return cmpNum(e.v, node.ino);
      case '-samefile':
        try {
          return vfs.stat(e.v, ctx.cwd) === node;
        } catch {
          return false;
        }
      case '-empty':
        return node.type === 'dir' ? node.children.size === 0 : node.type === 'file' && nodeSize(node) === 0;
      case '-readable':
        return vfs.can(node, 4);
      case '-writable':
        return vfs.can(node, 2);
      case '-executable':
        return vfs.can(node, 1);
      case '-nouser':
        return !sys.userById(node.uid);
      case '-nogroup':
        return !sys.groupById(node.gid);
      case '-true':
        return true;
      case '-false':
        return false;
      case '-print':
        await ctx.out(path + '\n');
        return true;
      case '-print0':
        await ctx.out(path + '\0');
        return true;
      case '-fprint':
        vfs.writeFile(e.v, ctx.cwd, path + '\n', { append: true });
        return true;
      case '-ls': {
        const t = fmtDate(node.mtime);
        await ctx.out(`${String(node.ino).padStart(8)} ${String(blocks(node) / 2).padStart(6)} ${modeString(node)} ${String(node.nlink).padStart(3)} ${sys.userName(node.uid).padEnd(8)} ${sys.groupName(node.gid).padEnd(8)} ${String(nodeSize(node)).padStart(8)} ${t} ${path}${node.type === 'link' ? ' -> ' + node.target : ''}\n`);
        return true;
      }
      case '-printf':
      case '-fprintf': {
        const s = findPrintf(e.v, path, node, depth, startPath, sys);
        await ctx.out(s);
        return true;
      }
      case '-delete':
        try {
          if (node.type === 'dir') vfs.rmdir(path, ctx.cwd);
          else vfs.unlink(path, ctx.cwd);
        } catch (err) {
          await ctx.err(`find: cannot delete '${path}': ${err.message}\n`);
          st = 1;
          return false;
        }
        return true;
      case '-exec':
      case '-execdir':
      case '-ok':
      case '-okdir':
        if (e.plus) {
          pending.push([e, path]);
          return true;
        }
        return runExec(e, path, node);
      case '-prune':
        node.__prune = true;
        return true;
      case '-quit':
        quit = true;
        return true;
      default:
        return true;
    }
  };

  const walk = async (path, depth, startPath) => {
    if (quit) return;
    await ctx.tick();
    let node;
    try {
      node = vfs.stat(path, ctx.cwd, follow || depth === 0 && false);
      if (depth === 0) {
        const l = vfs.stat(path, ctx.cwd, false);
        node = l.type === 'link' && !follow ? l : node;
      }
    } catch (e) {
      await ctx.err(`find: '${path}': ${e.message}\n`);
      st = 1;
      return;
    }
    const visit = async () => {
      if (depth >= mindepth) {
        delete node.__prune;
        const r = await evalE(expr, path, node, depth, startPath);
        if (r && printDefault) await ctx.out(path + '\n');
      }
    };
    if (!depthFirst) await visit();
    const pruned = node.__prune;
    delete node.__prune;
    if (node.type === 'dir' && depth < maxdepth && !pruned) {
      let names;
      try {
        names = vfs.readdir(path, ctx.cwd);
      } catch (e) {
        await ctx.err(`find: '${path}': ${e.message}\n`);
        st = 1;
        names = [];
      }
      for (const n of names) {
        if (quit) break;
        await walk(path === '/' ? '/' + n : path.replace(/\/+$/, '') + '/' + n, depth + 1, startPath);
      }
    }
    if (depthFirst) await visit();
  };
  for (const p of paths) {
    await walk(p, 0, p);
    if (quit) break;
  }
  // -exec ... {} +
  const groups = new Map();
  for (const [e, p] of pending) {
    if (!groups.has(e)) groups.set(e, []);
    groups.get(e).push(p);
  }
  for (const [e, list] of groups) {
    const argv = [];
    for (const x of e.cmd) {
      if (x === '{}') argv.push(...list);
      else argv.push(x);
    }
    const r = await sh.runCommand(argv, ctx.io, {});
    if (r !== 0) st = 1;
  }
  return st;
}

function findPrintf(fmt, path, node, depth, start, sys) {
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === '\\') {
      const d = fmt[++i];
      out += { n: '\n', t: '\t', '\\': '\\', 0: '\0', a: '\x07', r: '\r' }[d] ?? '\\' + d;
      continue;
    }
    if (c !== '%') {
      out += c;
      continue;
    }
    const m = /^(-?\d*)([a-zA-Z%])/.exec(fmt.slice(i + 1));
    if (!m) {
      out += '%';
      continue;
    }
    i += m[0].length;
    let v;
    switch (m[2]) {
      case 'p': v = path; break;
      case 'f': v = basename(path); break;
      case 'h': v = dirname(path); break;
      case 'P': v = path === start ? '' : path.slice(start.replace(/\/+$/, '').length + 1); break;
      case 'H': v = start; break;
      case 's': v = String(nodeSize(node)); break;
      case 'd': v = String(depth); break;
      case 'm': v = (node.mode & 0o7777).toString(8); break;
      case 'M': v = modeString(node); break;
      case 'u': v = sys.userName(node.uid); break;
      case 'U': v = String(node.uid); break;
      case 'g': v = sys.groupName(node.gid); break;
      case 'G': v = String(node.gid); break;
      case 'i': v = String(node.ino); break;
      case 'n': v = String(node.nlink); break;
      case 'y': v = { file: 'f', dir: 'd', link: 'l', chr: 'c', fifo: 'p' }[node.type]; break;
      case 'l': v = node.type === 'link' ? node.target : ''; break;
      case 't': v = new Date(node.mtime).toString().replace(/ GMT.*$/, '').replace(/^(\w+ \w+ \d+) (\d+) (.*)$/, '$1 $3 $2'); break;
      case 'T': {
        const k = fmt[i + 1];
        i++;
        const d = new Date(node.mtime);
        const p = (x) => String(x).padStart(2, '0');
        v = { '@': String(node.mtime / 1000), Y: String(d.getFullYear()), m: p(d.getMonth() + 1), d: p(d.getDate()), H: p(d.getHours()), M: p(d.getMinutes()), S: p(d.getSeconds()), F: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, T: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` }[k] ?? '';
        break;
      }
      case '%': v = '%'; break;
      default: v = '';
    }
    const w = m[1];
    if (w) v = w.startsWith('-') ? v.padEnd(Number(w.slice(1))) : v.padStart(Number(w));
    out += v;
  }
  return out;
}

// ---------- du / df / tree ----------

async function du(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'shacbkmxLDPS0', params: 'd', long: { summarize: 's', 'human-readable': 'h', all: 'a', total: 'c', 'max-depth': 'd', bytes: 'b', 'apparent-size': '', si: '', null: '0', exclude: '=' } });
  const paths = rest.length ? rest : ['.'];
  const vfs = ctx.vfs;
  const maxd = o.s ? 0 : o.d !== undefined ? Number(o.d) : Infinity;
  const apparent = o.b || o['apparent-size'];
  const unitSize = (b) => {
    if (o.h) return humanSize(b, !!o.si);
    if (o.b) return String(b);
    if (o.m) return String(Math.ceil(b / 1048576));
    return String(Math.ceil(b / 1024));
  };
  let total = 0;
  let st = 0;
  const end = o['0'] ? '\0' : '\n';
  const seen = new Set();
  const walk = async (p, depth) => {
    let node;
    try {
      node = vfs.stat(p, ctx.cwd, depth === 0);
    } catch (e) {
      await ctx.err(`du: cannot access '${p}': ${e.message}\n`);
      st = 1;
      return 0;
    }
    if (seen.has(node.ino)) return 0;
    seen.add(node.ino);
    let size = apparent ? nodeSize(node) : blocks(node) * 512;
    if (node.type === 'dir') {
      let names = [];
      try {
        names = vfs.readdir(p, ctx.cwd);
      } catch (e) {
        await ctx.err(`du: cannot read directory '${p}': ${e.message}\n`);
        st = 1;
      }
      for (const n of names) {
        if (o.exclude && matchPattern(o.exclude, n)) continue;
        size += await walk(p.replace(/\/+$/, '') + '/' + n, depth + 1);
      }
      if (depth <= maxd) await ctx.out(`${unitSize(size)}\t${p}${end}`);
    } else if ((o.a && depth <= maxd) || depth === 0) await ctx.out(`${unitSize(size)}\t${p}${end}`);
    return size;
  };
  for (const p of paths) total += await walk(p, 0);
  if (o.c) await ctx.out(`${unitSize(total)}\ttotal${end}`);
  return st;
}

async function df(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'hHTiakmlP', params: 't', long: { 'human-readable': 'h', si: 'H', 'print-type': 'T', inodes: 'i', all: 'a', type: 't', output: '?', total: '' } });
  const used = Math.ceil(ctx.vfs.totalBytes() / 1024) + 5242880;
  const rows = [
    ['/dev/sda1', 'ext4', 30297152, used, '/'],
    ['tmpfs', 'tmpfs', 1629384, 1984, '/run'],
    ['tmpfs', 'tmpfs', 8146900, 0, '/dev/shm'],
    ['tmpfs', 'tmpfs', 5120, 4, '/run/lock'],
    ['/dev/sda15', 'vfat', 106858, 6182, '/boot/efi'],
    ['tmpfs', 'tmpfs', 1629380, 112, '/run/user/1000'],
  ];
  let selected = rows;
  if (rest.length) {
    selected = [rows[0]];
  }
  const fmt = (k) => (o.h ? humanSize(k * 1024) : o.H ? humanSize(k * 1000, true) : String(o.m ? Math.ceil(k / 1024) : k));
  const header = o.i
    ? ['Filesystem', ...(o.T ? ['Type'] : []), 'Inodes', 'IUsed', 'IFree', 'IUse%', 'Mounted on']
    : ['Filesystem', ...(o.T ? ['Type'] : []), o.h || o.H ? 'Size' : o.m ? '1M-blocks' : '1K-blocks', 'Used', o.h || o.H ? 'Avail' : 'Available', 'Use%', 'Mounted on'];
  const table = [header];
  for (const [fs, type, size, u, mnt] of selected) {
    if (o.t && type !== o.t) continue;
    if (o.i) {
      const inodes = Math.floor(size / 16);
      const iu = Math.floor(u / 40) + 12;
      table.push([fs, ...(o.T ? [type] : []), String(inodes), String(iu), String(inodes - iu), Math.ceil((iu / inodes) * 100) + '%', mnt]);
    } else {
      const avail = size - u;
      table.push([fs, ...(o.T ? [type] : []), fmt(size), fmt(u), fmt(avail), (size ? Math.ceil((u / size) * 100) : 0) + '%', mnt]);
    }
  }
  const widths = header.map((_, i) => Math.max(...table.map((r) => r[i].length)));
  let out = '';
  for (const r of table) {
    out += r.map((c, i) => (i === 0 || (o.T && i === 1) || i === r.length - 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' ').trimEnd() + '\n';
  }
  await ctx.out(out);
  return 0;
}

async function tree(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'adfspugDFCniJrthQ', params: 'LIP', long: { noreport: '', dirsfirst: '', charset: '=' } });
  const vfs = ctx.vfs;
  const tty = !!ctx.stdout.isTerminalWriter;
  const color = (o.C || tty) && !o.n;
  let dirs = 0;
  let files = 0;
  const maxL = o.L ? Number(o.L) : Infinity;
  const roots = rest.length ? rest : ['.'];
  let out = '';
  const nameOf = (n, node, p) => {
    let s = n;
    if (color) {
      const c = lsColor(n, node, vfs, p, ctx.cwd);
      if (c) s = `\x1b[${c}m${s}\x1b[0m`;
    }
    if (o.F) s += node.type === 'dir' ? '/' : node.type === 'link' ? '@' : node.mode & 0o111 ? '*' : '';
    if (node.type === 'link') s += ` -> ${node.target}`;
    return s;
  };
  const walk = async (p, prefix, depth) => {
    let names;
    try {
      names = vfs.readdir(p, ctx.cwd);
    } catch (e) {
      out += ` [error opening dir]\n`;
      return;
    }
    if (!o.a) names = names.filter((n) => !n.startsWith('.'));
    if (o.I) names = names.filter((n) => !o.I.split('|').some((pat) => matchPattern(pat, n)));
    let entries = names.map((n) => {
      const cp = p.replace(/\/+$/, '') + '/' + n;
      let node;
      try {
        node = vfs.stat(cp, ctx.cwd, false);
      } catch {
        node = null;
      }
      return { n, cp, node };
    }).filter((e) => e.node);
    if (o.d) entries = entries.filter((e) => e.node.type === 'dir' || (e.node.type === 'link' && isDir(vfs, e.cp, ctx.cwd)));
    if (o.P) entries = entries.filter((e) => e.node.type === 'dir' || matchPattern(o.P, e.n));
    if (o.dirsfirst) entries.sort((a, b) => (b.node.type === 'dir') - (a.node.type === 'dir'));
    if (o.r) entries.reverse();
    for (let i = 0; i < entries.length; i++) {
      await ctx.tick();
      const { n, cp, node } = entries[i];
      const last = i === entries.length - 1;
      let info = '';
      if (o.p || o.u || o.g || o.s || o.h) {
        const parts = [];
        if (o.p) parts.push(modeString(node));
        if (o.u) parts.push(ctx.shell.system.userName(node.uid).padEnd(8));
        if (o.g) parts.push(ctx.shell.system.groupName(node.gid).padEnd(8));
        if (o.s || o.h) parts.push((o.h ? humanSize(nodeSize(node)) : String(nodeSize(node))).padStart(o.h ? 4 : 11));
        info = `[${parts.join(' ')}]  `;
      }
      out += `${prefix}${last ? '└── ' : '├── '}${info}${nameOf(o.f ? cp : n, node, cp)}\n`;
      if (node.type === 'dir') {
        dirs++;
        if (depth + 1 < maxL) await walk(cp, prefix + (last ? '    ' : '│   '), depth + 1);
      } else files++;
    }
  };
  for (const r of roots) {
    let node;
    try {
      node = vfs.stat(r, ctx.cwd);
    } catch (e) {
      out += `${r}  [error opening dir]\n`;
      continue;
    }
    out += (color ? `\x1b[01;34m${r}\x1b[0m` : r) + '\n';
    if (node.type === 'dir') await walk(r, '', 0);
  }
  if (!o.noreport) out += `\n${dirs} director${dirs === 1 ? 'y' : 'ies'}${o.d ? '' : `, ${files} file${files === 1 ? '' : 's'}`}\n`;
  await ctx.out(out);
  return 0;
}

// ---------- file ----------

export function describeFile(vfs, p, cwd, follow = false) {
  const node = vfs.stat(p, cwd, follow);
  if (node.type === 'dir') return node.mode & 0o1000 ? 'sticky, directory' : 'directory';
  if (node.type === 'link') {
    try {
      vfs.stat(p, cwd, true);
      return `symbolic link to ${node.target}`;
    } catch {
      return `broken symbolic link to ${node.target}`;
    }
  }
  if (node.type === 'chr') return 'character special (1/3)';
  const data = node.gen ? node.gen() : node.data;
  if (!data.length) return 'empty';
  if (data.startsWith('\x7fELF')) return 'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=4b2f, for GNU/Linux 3.2.0, stripped';
  const b = toBytes(data.slice(0, 600));
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip compressed data, original size modulo 2^32 ' + String(data.length);
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 'Zip archive data, at least v2.0 to extract, compression method=deflate';
  if (data.length > 262 && data.slice(257, 262) === 'ustar') return 'POSIX tar archive (GNU)';
  if (b[0] === 0x89 && data.slice(1, 4) === 'PNG') return 'PNG image data';
  if (data.startsWith('%PDF')) return 'PDF document, version 1.4';
  if (data.startsWith('#!')) {
    const line = data.split('\n')[0];
    const interp = line.slice(2).trim().split(/\s+/);
    const name = /env$/.test(interp[0]) ? interp[1] : interp[0].split('/').pop();
    const kinds = { bash: 'Bourne-Again shell script', sh: 'POSIX shell script', python3: 'Python script', python: 'Python script', perl: 'Perl script', awk: 'awk or perl script', node: 'Node.js script', ruby: 'Ruby script', zsh: 'Paul Falstad\'s zsh script' };
    return `${kinds[name] || `a ${interp.join(' ')} script`}, ASCII text executable`;
  }
  const t = data.trimStart();
  const unicode = /[^\x00-\x7f]/.test(data);
  const bin = /[\x00-\x08\x0e-\x1f\udc80-\udcff]/.test(data.slice(0, 2000));
  if (bin) return 'data';
  const lines = data.includes('\r\n') ? ', with CRLF line terminators' : '';
  const enc = unicode ? 'Unicode text, UTF-8 text' : 'ASCII text';
  if (/^<!DOCTYPE html|^<html/i.test(t)) return `HTML document, ${enc}${lines}`;
  if (/^<\?xml/.test(t)) return `XML 1.0 document, ${enc}${lines}`;
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(data);
      return 'JSON text data';
    } catch {}
  }
  if (/\.csv$/i.test(p)) return `CSV ${enc}${lines}`;
  if (/^(import |from \S+ import |def |class )/m.test(data) && /\.py$/.test(p)) return `Python script, ${enc} executable${lines}`;
  return enc + lines;
}

async function file(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'bLiz', long: { brief: 'b', dereference: 'L', mime: 'i', 'mime-type': '' } });
  if (!rest.length) {
    await ctx.err('Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding] [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>] [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet] <file> ...\n');
    return 1;
  }
  const w = Math.max(...rest.map((r) => r.length)) + 1;
  for (const f of rest) {
    let d;
    try {
      d = describeFile(ctx.vfs, f, ctx.cwd, !!o.L);
      if (o.i || o['mime-type']) {
        const mime = d === 'directory' ? 'inode/directory' : d.startsWith('symbolic') ? 'inode/symlink' : d === 'empty' ? 'inode/x-empty' : d.startsWith('gzip') ? 'application/gzip' : d.startsWith('Zip') ? 'application/zip' : d.startsWith('POSIX tar') ? 'application/x-tar' : d.startsWith('ELF') ? 'application/x-pie-executable' : d.includes('shell script') ? 'text/x-shellscript' : d.startsWith('HTML') ? 'text/html' : d.startsWith('JSON') ? 'application/json' : d === 'data' ? 'application/octet-stream' : 'text/plain';
        d = o['mime-type'] ? mime : `${mime}; charset=${d.includes('UTF-8') ? 'utf-8' : d === 'data' ? 'binary' : 'us-ascii'}`;
      }
    } catch (e) {
      d = `cannot open \`${f}' (${e.message})`;
    }
    await ctx.out(o.b ? d + '\n' : `${(f + ':').padEnd(w)} ${d}\n`);
  }
  return 0;
}

// ---------- path helpers ----------

async function realpath(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'emsqzLP', long: { 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-symlinks': 's', quiet: 'q', zero: 'z', 'relative-to': '=' } });
  if (!rest.length) throw new UsageError('missing operand');
  let st = 0;
  for (const p of rest) {
    try {
      let r;
      if (o.s || o.m) r = abspath(ctx.cwd, p);
      else {
        const w = ctx.vfs.walk(p, ctx.cwd, true);
        if (!w.node && (o.e || !w.parent)) throw new FsError('ENOENT', p);
        r = '/' + w.canon.join('/');
      }
      if (o['relative-to']) {
        const from = abspath(ctx.cwd, o['relative-to']).split('/').filter(Boolean);
        const to = r.split('/').filter(Boolean);
        let k = 0;
        while (k < from.length && from[k] === to[k]) k++;
        r = [...Array(from.length - k).fill('..'), ...to.slice(k)].join('/') || '.';
      }
      await ctx.out(r + (o.z ? '\0' : '\n'));
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (!o.q) await ctx.err(`realpath: ${p}: ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

async function readlink(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'femnqsvz', long: { canonicalize: 'f', 'canonicalize-existing': 'e', 'canonicalize-missing': 'm', 'no-newline': 'n', quiet: 'q', silent: 's', verbose: 'v', zero: 'z' } });
  if (!rest.length) throw new UsageError('missing operand');
  let st = 0;
  for (const p of rest) {
    try {
      let r;
      if (o.f || o.e || o.m) {
        const w = ctx.vfs.walk(p, ctx.cwd, true);
        if (!w.node && (o.e || (!o.m && !w.parent))) throw new FsError('ENOENT', p);
        r = '/' + w.canon.join('/');
      } else r = ctx.vfs.readlink(p, ctx.cwd);
      await ctx.out(r + (o.n ? '' : o.z ? '\0' : '\n'));
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      if (o.v) await ctx.err(`readlink: ${p}: ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

async function basenameCmd(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'az', params: 's', long: { multiple: 'a', suffix: 's', zero: 'z' } });
  if (!rest.length) throw new UsageError('missing operand');
  let names = rest;
  let suffix = o.s;
  if (!o.a && !o.s) {
    if (rest.length > 2) throw new UsageError(`extra operand '${rest[2]}'`);
    names = [rest[0]];
    suffix = rest[1];
  }
  for (const n of names) {
    let b = basename(n);
    if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
    await ctx.out(b + (o.z ? '\0' : '\n'));
  }
  return 0;
}

async function dirnameCmd(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'z', long: { zero: 'z' } });
  if (!rest.length) throw new UsageError('missing operand');
  for (const n of rest) await ctx.out(dirname(n) + (o.z ? '\0' : '\n'));
  return 0;
}

async function mktemp(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'dutq', params: 'p', long: { directory: 'd', 'dry-run': 'u', quiet: 'q', tmpdir: '?', suffix: '=' } });
  let tpl = rest[0] || 'tmp.XXXXXXXXXX';
  const m = /(X{3,})([^X]*)$/.exec(tpl);
  if (!m) {
    await ctx.err(`mktemp: too few X's in template '${tpl}'\n`);
    return 1;
  }
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const rnd = () => [...m[1]].map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  let dir = '';
  if (o.p || o.t || o.tmpdir || !rest[0]) dir = (o.p || (typeof o.tmpdir === 'string' ? o.tmpdir : null) || ctx.shell.getVar('TMPDIR') || '/tmp') + '/';
  if (rest[0] && rest[0].includes('/') && !o.p && !o.t) dir = '';
  const path = dir + tpl.slice(0, m.index) + rnd() + m[2] + (o.suffix || '');
  try {
    if (!o.u) {
      if (o.d) ctx.vfs.mkdir(path, ctx.cwd, { mode: 0o700, umask: 0 });
      else ctx.vfs.writeFile(path, ctx.cwd, '', { mode: 0o600, umask: 0 });
    }
  } catch (e) {
    if (!o.q) await ctx.err(`mktemp: failed to create ${o.d ? 'directory' : 'file'} via template '${dir + tpl}': ${e.message}\n`);
    return 1;
  }
  await ctx.out(path + '\n');
  return 0;
}

async function truncate(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'co', params: 'sr', long: { size: 's', 'no-create': 'c', reference: 'r' } });
  if (o.s === undefined && o.r === undefined) throw new UsageError("you must specify either '--size' or '--reference'");
  let st = 0;
  for (const f of rest) {
    try {
      let data = ctx.vfs.exists(f, ctx.cwd) ? ctx.vfs.readFile(f, ctx.cwd) : o.c ? null : '';
      if (data === null) continue;
      let size;
      const cur = byteLength(data);
      if (o.r) size = nodeSize(ctx.vfs.stat(o.r, ctx.cwd));
      else {
        const m = /^([+\-<>/%]?)(\d+)([KMG]?)(i?B?)$/.exec(o.s);
        if (!m) throw new UsageError(`invalid number: '${o.s}'`, 1, false);
        let n = Number(m[2]) * ({ K: 1024, M: 1048576, G: 1073741824 }[m[3]] || 1);
        size = m[1] === '+' ? cur + n : m[1] === '-' ? Math.max(0, cur - n) : m[1] === '<' ? Math.min(cur, n) : m[1] === '>' ? Math.max(cur, n) : n;
      }
      const bytes = toBytes(data);
      const nb = new Uint8Array(size);
      nb.set(bytes.slice(0, size));
      ctx.vfs.writeFile(f, ctx.cwd, fromBytes(nb), { umask: ctx.shell.umask });
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      await ctx.err(`truncate: cannot open '${f}' for writing: ${e.message}\n`);
      st = 1;
    }
  }
  return st;
}

async function tee(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'aip', long: { append: 'a', 'ignore-interrupts': 'i' } });
  const writers = [];
  let st = 0;
  for (const f of rest) {
    try {
      writers.push(ctx.shell.openWrite(f, ctx.io, !!o.a, true));
    } catch (e) {
      await ctx.err(`tee: ${f}: ${e.message}\n`);
      st = 1;
    }
  }
  for (;;) {
    const chunk = await ctx.stdin.read();
    if (chunk === null) break;
    for (const w of writers) await w.write(chunk);
    await ctx.out(chunk);
  }
  return st;
}

async function which(ctx) {
  const all = ctx.args.includes('-a');
  const names = ctx.args.filter((a) => !a.startsWith('-'));
  let st = 0;
  for (const n of names) {
    let found = false;
    if (n.includes('/')) {
      try {
        const node = ctx.vfs.stat(n, ctx.cwd);
        if (node.type === 'file' && node.mode & 0o111) {
          await ctx.out(n + '\n');
          found = true;
        }
      } catch {}
    } else {
      for (const d of (ctx.shell.getVar('PATH') || '').split(':')) {
        const p = (d || '.') + '/' + n;
        try {
          const node = ctx.vfs.stat(p, ctx.cwd);
          if (node.type === 'file' && node.mode & 0o111) {
            await ctx.out(p + '\n');
            found = true;
            if (!all) break;
          }
        } catch {}
      }
    }
    if (!found) st = 1;
  }
  return st;
}

async function whereis(ctx) {
  for (const n of ctx.args.filter((a) => !a.startsWith('-'))) {
    const found = [];
    for (const d of ['/usr/bin', '/usr/sbin', '/usr/local/bin', '/bin', '/sbin']) {
      try {
        ctx.vfs.stat(d + '/' + n, '/', false);
        if (!found.some((f) => f.endsWith('/' + n) && (d === '/bin' || d === '/sbin'))) found.push(d + '/' + n);
      } catch {}
    }
    const man = ctx.shell.commands.get(n) ? [`/usr/share/man/man1/${n}.1.gz`] : [];
    await ctx.out(`${n}:${[...found.filter((f) => !f.startsWith('/bin/') && !f.startsWith('/sbin/')), ...man].map((x) => ' ' + x).join('')}\n`);
  }
  return 0;
}

async function install(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'dDvCcbsp', params: 'mogt', long: { directory: 'd', mode: 'm', owner: 'o', group: 'g', 'target-directory': 't', verbose: 'v' } });
  const mode = o.m ? parseModeArg(o.m, 0o755) : 0o755;
  if (o.d) {
    for (const d of rest) {
      ctx.vfs.mkdir(d, ctx.cwd, { parents: true, mode, umask: 0 });
      ctx.vfs.chmod(d, ctx.cwd, mode);
    }
    return 0;
  }
  let files = rest;
  let dest = o.t;
  if (!dest) {
    dest = files[files.length - 1];
    files = files.slice(0, -1);
  }
  if (!files.length) throw new UsageError('missing destination file operand');
  for (const f of files) {
    const target = isDir(ctx.vfs, dest, ctx.cwd) ? dest.replace(/\/+$/, '') + '/' + basename(f) : dest;
    if (o.D) ctx.vfs.mkdir(dirname(target), ctx.cwd, { parents: true });
    ctx.vfs.writeFile(target, ctx.cwd, ctx.vfs.readFile(f, ctx.cwd), { umask: 0 });
    ctx.vfs.chmod(target, ctx.cwd, mode);
    if (o.v) await ctx.out(`'${f}' -> '${target}'\n`);
  }
  return 0;
}

async function shred(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'uvzfx', params: 'ns', long: { remove: '?', verbose: 'v', iterations: 'n', zero: 'z' } });
  if (!rest.length) throw new UsageError('missing file operand');
  for (const f of rest) {
    let n;
    try {
      n = ctx.vfs.stat(f, ctx.cwd);
    } catch (e) {
      await ctx.err(`shred: ${f}: failed to open for writing: ${e.message}\n`);
      continue;
    }
    if (n.type !== 'file') {
      await ctx.err(`shred: ${f}: failed to open for writing: ${n.type === 'dir' ? 'Is a directory' : 'Invalid argument'}\n`);
      continue;
    }
    const len = byteLength(n.data);
    const bytes = new Uint8Array(len);
    globalThis.crypto.getRandomValues(bytes);
    if (o.v) await ctx.err(`shred: ${f}: pass 1/3 (random)...\nshred: ${f}: pass 2/3 (random)...\nshred: ${f}: pass 3/3 (random)...\n`);
    ctx.vfs.writeFile(f, ctx.cwd, o.z ? '\0'.repeat(len) : fromBytes(bytes));
    if (o.u || o.remove) {
      ctx.vfs.unlink(f, ctx.cwd);
      if (o.v) await ctx.err(`shred: ${f}: removed\n`);
    }
  }
  return 0;
}

async function split(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'de', params: 'lbna', long: { lines: 'l', bytes: 'b', number: 'n', 'suffix-length': 'a', 'numeric-suffixes': 'd', 'additional-suffix': '=', verbose: '' } });
  const [input = '-', prefix = 'x'] = rest;
  let text = '';
  for await (const f of inputs(ctx, [input])) text += f.text;
  const sl = Number(o.a || 2);
  const suffix = (i) => {
    if (o.d) return String(i).padStart(sl, '0');
    let s = '';
    for (let k = 0; k < sl; k++) {
      s = String.fromCharCode(97 + (i % 26)) + s;
      i = Math.floor(i / 26);
    }
    return s;
  };
  let chunks = [];
  if (o.b) {
    const m = /^(\d+)([KMG]?)/.exec(o.b);
    const size = Number(m[1]) * ({ K: 1024, M: 1048576, G: 1073741824 }[m[2]] || 1);
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  } else if (o.n) {
    const n = Number(o.n);
    const size = Math.ceil(text.length / n);
    for (let i = 0; i < n; i++) chunks.push(text.slice(i * size, (i + 1) * size));
  } else {
    const per = Number(o.l || 1000);
    const lines = text.split(/(?<=\n)/);
    for (let i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per).join(''));
  }
  chunks.forEach((c, i) => {
    ctx.vfs.writeFile(prefix + suffix(i) + (o['additional-suffix'] || ''), ctx.cwd, c, { umask: ctx.shell.umask });
  });
  if (o.verbose) for (let i = 0; i < chunks.length; i++) await ctx.out(`creating file '${prefix + suffix(i)}'\n`);
  return 0;
}

async function dd(ctx) {
  const opts = {};
  for (const a of ctx.args) {
    const i = a.indexOf('=');
    if (i < 0) {
      await ctx.err(`dd: unrecognized operand '${a}'\n`);
      return 1;
    }
    opts[a.slice(0, i)] = a.slice(i + 1);
  }
  const num = (s) => {
    if (s === undefined) return undefined;
    const m = /^(\d+)([cwbkKMG]?)(B?)$/.exec(s);
    if (!m) return NaN;
    return Number(m[1]) * ({ c: 1, w: 2, b: 512, k: 1024, K: 1024, M: 1048576, G: 1073741824, '': 1 }[m[2]] || 1);
  };
  const bs = num(opts.bs) || num(opts.ibs) || 512;
  const t0 = Date.now();
  let data;
  if (opts.if) {
    if (opts.if === '/dev/zero') data = '\0'.repeat(bs * (num(opts.count) || 1));
    else if (opts.if === '/dev/urandom' || opts.if === '/dev/random') {
      const b = new Uint8Array(Math.min(bs * (num(opts.count) || 1), 16 * 1048576));
      for (let i = 0; i < b.length; i += 65536) globalThis.crypto.getRandomValues(b.subarray(i, i + 65536));
      data = fromBytes(b);
    } else data = ctx.vfs.readFile(opts.if, ctx.cwd);
  } else data = await ctx.stdin.readAll();
  let bytes = toBytes(data);
  const skip = (num(opts.skip) || 0) * bs;
  bytes = bytes.slice(skip);
  if (opts.count !== undefined) bytes = bytes.slice(0, num(opts.count) * bs);
  let out = fromBytes(bytes);
  const conv = (opts.conv || '').split(',');
  if (conv.includes('ucase')) out = out.toUpperCase();
  if (conv.includes('lcase')) out = out.toLowerCase();
  if (opts.of) {
    const seek = (num(opts.seek) || 0) * bs;
    let existing = '';
    if (seek || conv.includes('notrunc')) {
      try {
        existing = ctx.vfs.readFile(opts.of, ctx.cwd);
      } catch {}
    }
    const eb = toBytes(existing);
    const total = new Uint8Array(Math.max(conv.includes('notrunc') ? eb.length : 0, seek + bytes.length));
    total.set(eb.slice(0, Math.max(seek, conv.includes('notrunc') ? eb.length : seek)));
    total.set(toBytes(out), seek);
    if (opts.of === '/dev/null') {} else ctx.vfs.writeFile(opts.of, ctx.cwd, fromBytes(total), { umask: ctx.shell.umask });
  } else await ctx.out(out);
  if (opts.status !== 'none') {
    const n = bytes.length;
    const recs = Math.floor(n / bs);
    const part = n % bs ? 1 : 0;
    const secs = Math.max((Date.now() - t0) / 1000, 0.000123);
    await ctx.err(`${recs}+${part} records in\n${recs}+${part} records out\n${n} bytes${n >= 1024 ? ` (${humanSize(n, true)}B, ${humanSize(n)}iB)` : ''} copied, ${secs.toFixed(6)} s, ${humanSize(Math.round(n / secs), true)}B/s\n`);
  }
  return 0;
}

// ---------- archives ----------

function tarHeader(name, node, size, typeflag, linkname = '') {
  const h = new Uint8Array(512);
  const put = (off, len, s) => {
    const b = toBytes(s);
    h.set(b.slice(0, len), off);
  };
  const oct = (off, len, n) => put(off, len, n.toString(8).padStart(len - 1, '0') + '\0');
  let prefix = '';
  if (name.length > 100) {
    const i = name.lastIndexOf('/', 155);
    prefix = name.slice(0, i);
    name = name.slice(i + 1);
  }
  put(0, 100, name);
  oct(100, 8, node.mode & 0o7777);
  oct(108, 8, node.uid);
  oct(116, 8, node.gid);
  oct(124, 12, size);
  oct(136, 12, Math.floor(node.mtime / 1000));
  put(148, 8, '        ');
  put(156, 1, typeflag);
  put(157, 100, linkname);
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(265, 32, 'user');
  put(297, 32, 'user');
  put(345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function tarCreate(vfs, cwd, paths, report, exclude) {
  const parts = [];
  const add = (p) => {
    if (exclude && exclude.some((x) => matchPattern(x, basename(p)))) return;
    const node = vfs.stat(p, cwd, false);
    const name = p.replace(/^\/+/, '');
    report(p + (node.type === 'dir' ? '/' : ''));
    if (node.type === 'dir') {
      parts.push(tarHeader(name.replace(/\/?$/, '/'), node, 0, '5'));
      for (const n of vfs.readdir(p, cwd)) add(p.replace(/\/+$/, '') + '/' + n);
    } else if (node.type === 'link') {
      parts.push(tarHeader(name, node, 0, '2', node.target));
    } else {
      const bytes = toBytes(vfs.readNode(node, p));
      parts.push(tarHeader(name, node, bytes.length, '0'));
      const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
      padded.set(bytes);
      parts.push(padded);
    }
  };
  for (const p of paths) add(p);
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(Math.ceil(total / 10240) * 10240);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function tarParse(bytes) {
  const entries = [];
  const dec = (a, b) => fromBytes(bytes.slice(a, b)).replace(/\0.*$/s, '');
  let off = 0;
  let longName = null;
  while (off + 512 <= bytes.length) {
    const hdr = bytes.slice(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    let name = dec(off, off + 100);
    const mode = parseInt(dec(off + 100, off + 108).trim() || '644', 8);
    const size = parseInt(dec(off + 124, off + 136).trim() || '0', 8);
    const mtime = parseInt(dec(off + 136, off + 148).trim() || '0', 8) * 1000;
    const type = String.fromCharCode(bytes[off + 156] || 48);
    const link = dec(off + 157, off + 257);
    const prefix = dec(off + 345, off + 500);
    if (prefix && dec(off + 257, off + 262) === 'ustar') name = prefix + '/' + name;
    off += 512;
    const data = bytes.slice(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = fromBytes(data).replace(/\0.*$/s, '');
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    entries.push({ name, mode, size, mtime, type, link, data });
  }
  return entries;
}

async function tar(ctx) {
  let args = ctx.args.slice();
  // old-style bundled first argument: tar czvf x.tgz dir
  if (args[0] && !args[0].startsWith('-') && /^[ctxrufvzjJpkC]+$/.test(args[0])) args[0] = '-' + args[0];
  const { o, rest } = getopt(args, {
    flags: 'ctxrufvzjJpkhOaS',
    params: 'fCT',
    long: { create: 'c', list: 't', extract: 'x', get: 'x', append: 'r', file: 'f', verbose: 'v', gzip: 'z', gunzip: 'z', directory: 'C', 'to-stdout': 'O', exclude: '=', 'strip-components': '=', 'keep-old-files': 'k', 'files-from': 'T', 'auto-compress': 'a' },
    multiLong: ['exclude'],
  });
  const vfs = ctx.vfs;
  const mode = o.c ? 'c' : o.t ? 't' : o.x ? 'x' : o.r || o.u ? 'r' : null;
  if (!mode) {
    await ctx.err("tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry 'tar --help' or 'tar --usage' for more information.\n");
    return 2;
  }
  if (o.j || o.J) {
    await ctx.err('tar: bzip2/xz compression is not available in this simulation; use -z (gzip)\n');
    return 2;
  }
  const gz = o.z || (o.a && /\.(tgz|tar\.gz)$/.test(o.f || ''));
  const base = o.C || '.';
  const baseAbs = abspath(ctx.cwd, base);
  if (mode === 'c' || mode === 'r') {
    let files = rest;
    if (o.T) files = files.concat(vfs.readFile(o.T, ctx.cwd).split('\n').filter(Boolean));
    if (!files.length) {
      await ctx.err('tar: Cowardly refusing to create an empty archive\nTry \'tar --help\' or \'tar --usage\' for more information.\n');
      return 2;
    }
    const verbose = [];
    let bytes;
    try {
      for (const f of files) {
        if (f.startsWith('/')) verbose.push(null);
      }
      bytes = tarCreate(vfs, baseAbs, files, (p) => o.v && verbose.push(p), Array.isArray(o.exclude) ? o.exclude : o.exclude ? [o.exclude] : null);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      await ctx.err(`tar: ${e.path}: Cannot stat: ${e.message}\ntar: Exiting with failure status due to previous errors\n`);
      return 2;
    }
    if (files.some((f) => f.startsWith('/'))) await ctx.err('tar: Removing leading `/\' from member names\n');
    if (o.v) {
      const w = o.f && o.f !== '-' ? ctx.out : ctx.err;
      for (const v of verbose) if (v) await w(v.replace(/^\/+/, '') + '\n');
    }
    if (gz) bytes = await compress('gzip', bytes);
    const s = fromBytes(bytes);
    if (!o.f || o.f === '-') await ctx.out(s);
    else vfs.writeFile(o.f, ctx.cwd, s, { umask: ctx.shell.umask });
    return 0;
  }
  let data;
  try {
    data = !o.f || o.f === '-' ? await ctx.stdin.readAll() : vfs.readFile(o.f, ctx.cwd);
  } catch (e) {
    await ctx.err(`tar: ${o.f}: Cannot open: ${e.message}\ntar: Error is not recoverable: exiting now\n`);
    return 2;
  }
  let bytes = toBytes(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = await decompress('gzip', bytes);
    } catch {
      await ctx.err('gzip: stdin: invalid compressed data--format violated\ntar: Child returned status 1\ntar: Error is not recoverable: exiting now\n');
      return 2;
    }
  }
  const entries = tarParse(bytes);
  if (!entries.length && bytes.length) {
    await ctx.err('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n');
    return 2;
  }
  const strip = Number(o['strip-components'] || 0);
  const sys = ctx.shell.system;
  const want = rest.length ? (n) => rest.some((r) => n === r || n.startsWith(r.replace(/\/?$/, '/'))) : () => true;
  for (const e of entries) {
    if (!want(e.name.replace(/\/$/, '')) && !want(e.name)) continue;
    if (mode === 't') {
      if (o.v) {
        const fake = { type: e.type === '5' ? 'dir' : e.type === '2' ? 'link' : 'file', mode: e.mode };
        const d = new Date(e.mtime);
        const p = (x) => String(x).padStart(2, '0');
        await ctx.out(`${modeString(fake)} user/user ${String(e.size).padStart(9)} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${e.name}${e.type === '2' ? ' -> ' + e.link : ''}\n`);
      } else await ctx.out(e.name + '\n');
      continue;
    }
    let name = e.name.split('/').filter(Boolean).slice(strip).join('/');
    if (!name) continue;
    if (o.v) await ctx.out(e.name + '\n');
    if (o.O) {
      if (e.type === '0' || e.type === '\0') await ctx.out(fromBytes(e.data));
      continue;
    }
    const target = baseAbs.replace(/\/$/, '') + '/' + name;
    try {
      if (e.type === '5') vfs.mkdir(target, '/', { parents: true, mode: e.mode, umask: 0 });
      else {
        vfs.mkdir(dirname(target), '/', { parents: true });
        if (vfs.exists(target, '/', false)) {
          if (o.k) {
            await ctx.err(`tar: ${name}: Cannot open: File exists\n`);
            continue;
          }
          if (vfs.stat(target, '/', false).type !== 'dir') vfs.unlink(target, '/');
        }
        if (e.type === '2') vfs.symlink(e.link, target, '/');
        else {
          const n = vfs.writeFile(target, '/', fromBytes(e.data), { umask: 0, mode: e.mode });
          n.mode = e.mode;
          n.mtime = e.mtime || Date.now();
        }
      }
    } catch (err) {
      if (!(err instanceof FsError)) throw err;
      await ctx.err(`tar: ${name}: Cannot open: ${err.message}\n`);
    }
  }
  void sys;
  return 0;
}

async function gzip(ctx) {
  const prog = ctx.name;
  const { o, rest } = getopt(ctx.args, { flags: 'dcfkvlqrnNt123456789', long: { decompress: 'd', stdout: 'c', 'to-stdout': 'c', force: 'f', keep: 'k', verbose: 'v', list: 'l', quiet: 'q', recursive: 'r', test: 't', uncompress: 'd', best: '9', fast: '1' } });
  const decompressMode = o.d || prog === 'gunzip' || prog === 'zcat';
  const toStdout = o.c || prog === 'zcat';
  const files = rest.length ? rest : ['-'];
  let st = 0;
  for (const f of files) {
    let data;
    try {
      data = f === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(f, ctx.cwd);
    } catch (e) {
      await ctx.err(`${prog}: ${f}: ${e.message}\n`);
      st = 1;
      continue;
    }
    const bytes = toBytes(data);
    if (decompressMode) {
      if (f !== '-' && !/\.(gz|tgz|z)$/i.test(f) && !toStdout) {
        await ctx.err(`${prog}: ${f}: unknown suffix -- ignored\n`);
        st = 2;
        continue;
      }
      let out;
      try {
        if (o.f && toStdout && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) out = bytes;
        else out = await decompress('gzip', bytes);
      } catch {
        await ctx.err(`${prog}: ${f === '-' ? 'stdin' : f}: not in gzip format\n`);
        st = 1;
        continue;
      }
      if (o.l) {
        await ctx.out(`         compressed        uncompressed  ratio uncompressed_name\n${String(bytes.length).padStart(19)} ${String(out.length).padStart(19)} ${(out.length ? (100 * (1 - bytes.length / out.length)).toFixed(1) : '0.0').padStart(5)}% ${f.replace(/\.gz$/, '')}\n`);
        continue;
      }
      if (o.t) continue;
      if (toStdout || f === '-') await ctx.out(fromBytes(out));
      else {
        const target = f.replace(/\.tgz$/i, '.tar').replace(/\.(gz|z)$/i, '');
        if (ctx.vfs.exists(target, ctx.cwd) && !o.f) {
          await ctx.err(`${prog}: ${target} already exists; not overwritten\n`);
          st = 2;
          continue;
        }
        ctx.vfs.writeFile(target, ctx.cwd, fromBytes(out), { umask: ctx.shell.umask });
        if (!o.k) ctx.vfs.unlink(f, ctx.cwd);
        if (o.v) await ctx.err(`${f}:\t${(100 * (1 - bytes.length / Math.max(out.length, 1))).toFixed(1)}% -- replaced with ${target}\n`);
      }
    } else {
      const out = await compress('gzip', bytes);
      if (toStdout || f === '-') await ctx.out(fromBytes(out));
      else {
        if (/\.gz$/.test(f)) {
          await ctx.err(`gzip: ${f} already has .gz suffix -- unchanged\n`);
          continue;
        }
        if (ctx.vfs.exists(f + '.gz', ctx.cwd) && !o.f) {
          await ctx.err(`gzip: ${f}.gz already exists; not overwritten\n`);
          st = 2;
          continue;
        }
        ctx.vfs.writeFile(f + '.gz', ctx.cwd, fromBytes(out), { umask: ctx.shell.umask });
        if (!o.k) ctx.vfs.unlink(f, ctx.cwd);
        if (o.v) await ctx.err(`${f}:\t${(100 * (1 - out.length / Math.max(bytes.length, 1))).toFixed(1)}% -- replaced with ${f}.gz\n`);
      }
    }
  }
  return st;
}

async function zip(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'rqjv0123456789', long: { recurse: 'r', quiet: 'q', 'junk-paths': 'j' } });
  if (rest.length < 2) {
    await ctx.err('zip error: Nothing to do!\n');
    return 12;
  }
  let [archive, ...paths] = rest;
  if (!/\.zip$/i.test(archive) && !ctx.vfs.exists(archive, ctx.cwd)) archive += '.zip';
  const vfs = ctx.vfs;
  const entries = [];
  const add = (p) => {
    const node = vfs.stat(p, ctx.cwd);
    if (node.type === 'dir') {
      if (!o.j) entries.push({ name: p.replace(/^\/+/, '').replace(/\/?$/, '/'), data: new Uint8Array(0), node });
      if (o.r) for (const n of vfs.readdir(p, ctx.cwd)) add(p.replace(/\/+$/, '') + '/' + n);
    } else entries.push({ name: o.j ? basename(p) : p.replace(/^\/+/, ''), data: toBytes(vfs.readNode(node, p)), node });
  };
  for (const p of paths) {
    try {
      add(p);
    } catch (e) {
      await ctx.err(`\tzip warning: name not matched: ${p}\n`);
    }
  }
  const parts = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const comp = e.data.length ? await compress('deflate-raw', e.data) : new Uint8Array(0);
    const useStore = o['0'] || comp.length >= e.data.length;
    const body = useStore ? e.data : comp;
    const crc = crc32(e.data);
    const nameB = toBytes(e.name);
    const d = new Date(e.node.mtime);
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(8, useStore ? 0 : 8, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(new Uint8Array(lh.buffer), nameB, body);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 0x031e, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(10, useStore ? 0 : 8, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(38, ((e.node.type === 'dir' ? 0o40000 : 0o100000) | (e.node.mode & 0o7777)) << 16, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nameB);
    off += 30 + nameB.length + body.length;
    if (!o.q) {
      const pct = e.data.length ? Math.round(100 * (1 - body.length / e.data.length)) : 0;
      await ctx.out(`  adding: ${e.name} (${useStore ? 'stored 0%' : `deflated ${pct}%`})\n`);
    }
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  vfs.writeFile(archive, ctx.cwd, fromBytes(out), { umask: ctx.shell.umask });
  return 0;
}

async function unzip(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'lovqnpj', params: 'd', long: {} });
  if (!rest.length) {
    await ctx.out('UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\nUsage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]\n');
    return 0;
  }
  let archive = rest[0];
  let data;
  try {
    data = ctx.vfs.readFile(archive, ctx.cwd);
  } catch {
    try {
      archive += '.zip';
      data = ctx.vfs.readFile(archive, ctx.cwd);
    } catch {
      await ctx.err(`unzip:  cannot find or open ${rest[0]}, ${rest[0]}.zip or ${rest[0]}.ZIP.\n`);
      return 9;
    }
  }
  const b = toBytes(data);
  const dv = new DataView(b.buffer);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) {
    eocd = i;
    break;
  }
  if (eocd < 0) {
    await ctx.err(`  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.\nunzip:  cannot find zipfile directory in ${archive}.\n`);
    return 9;
  }
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let k = 0; k < count; k++) {
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const usize = dv.getUint32(off + 24, true);
    const nlen = dv.getUint16(off + 28, true);
    const elen = dv.getUint16(off + 30, true);
    const clen = dv.getUint16(off + 32, true);
    const attr = dv.getUint32(off + 38, true) >>> 16;
    const lho = dv.getUint32(off + 42, true);
    const name = fromBytes(b.slice(off + 46, off + 46 + nlen));
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    entries.push({ name, method, csize, usize, attr, body: b.slice(start, start + csize) });
    off += 46 + nlen + elen + clen;
  }
  if (o.l) {
    let out = `Archive:  ${archive}\n  Length      Date    Time    Name\n---------  ---------- -----   ----\n`;
    let tot = 0;
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    for (const e of entries) {
      out += `${String(e.usize).padStart(9)}  ${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}   ${e.name}\n`;
      tot += e.usize;
    }
    out += `---------                     -------\n${String(tot).padStart(9)}                     ${entries.length} file${entries.length === 1 ? '' : 's'}\n`;
    await ctx.out(out);
    return 0;
  }
  if (!o.q && !o.p) await ctx.out(`Archive:  ${archive}\n`);
  const dest = abspath(ctx.cwd, o.d || '.');
  for (const e of entries) {
    const content = e.method === 8 ? await decompress('deflate-raw', e.body) : e.body;
    if (o.p) {
      await ctx.out(fromBytes(content));
      continue;
    }
    const name = o.j ? basename(e.name) : e.name;
    const target = dest.replace(/\/$/, '') + '/' + name;
    if (e.name.endsWith('/')) {
      if (!o.j) {
        ctx.vfs.mkdir(target, '/', { parents: true });
        if (!o.q) await ctx.out(`   creating: ${(o.d ? o.d.replace(/\/$/, '') + '/' : '') + name}\n`);
      }
      continue;
    }
    ctx.vfs.mkdir(dirname(target), '/', { parents: true });
    if (ctx.vfs.exists(target, '/') && o.n) continue;
    const n = ctx.vfs.writeFile(target, '/', fromBytes(content), { umask: 0 });
    if (e.attr) n.mode = e.attr & 0o7777;
    if (!o.q) await ctx.out(`  ${e.method === 8 ? 'inflating' : ' extracting'}: ${(o.d ? o.d.replace(/\/$/, '') + '/' : '') + name}\n`);
  }
  return 0;
}

async function link(ctx) {
  if (ctx.args.length !== 2) throw new UsageError(ctx.args.length < 2 ? 'missing operand' : `extra operand '${ctx.args[2]}'`);
  try {
    ctx.vfs.link(ctx.args[0], ctx.args[1], ctx.cwd);
  } catch (e) {
    await ctx.err(`link: cannot create link '${ctx.args[1]}' to '${ctx.args[0]}': ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function unlink(ctx) {
  if (ctx.args.length !== 1) throw new UsageError(ctx.args.length < 1 ? 'missing operand' : `extra operand '${ctx.args[1]}'`);
  try {
    ctx.vfs.unlink(ctx.args[0], ctx.cwd);
  } catch (e) {
    await ctx.err(`unlink: cannot unlink '${ctx.args[0]}': ${e.message}\n`);
    return 1;
  }
  return 0;
}

async function mkfifo(ctx) {
  const { rest } = getopt(ctx.args, { params: 'm', long: { mode: 'm' } });
  for (const f of rest) {
    try {
      const n = ctx.vfs.writeFile(f, ctx.cwd, '', { umask: ctx.shell.umask });
      n.type = 'fifo';
    } catch (e) {
      await ctx.err(`mkfifo: cannot create fifo '${f}': ${e.message}\n`);
      return 1;
    }
  }
  return 0;
}

export function install_(reg) {
  const add = (names, fn, help) => {
    for (const n of names.split(' ')) reg.set(n, ext(fn, help));
  };
  add('ls dir vdir', ls, 'Usage: ls [OPTION]... [FILE]...\nList information about the FILEs (the current directory by default).\n\n  -a, --all                  do not ignore entries starting with .\n  -A, --almost-all           do not list implied . and ..\n  -d, --directory            list directories themselves, not their contents\n  -F, --classify             append indicator (one of */=>@|) to entries\n  -h, --human-readable       with -l and -s, print sizes like 1K 234M 2G etc.\n  -i, --inode                print the index number of each file\n  -l                         use a long listing format\n  -r, --reverse              reverse order while sorting\n  -R, --recursive            list subdirectories recursively\n  -S                         sort by file size, largest first\n  -t                         sort by time, newest first\n  -1                         list one file per line\n      --color[=WHEN]         color the output WHEN; more info below\n');
  add('cat', cat, 'Usage: cat [OPTION]... [FILE]...\nConcatenate FILE(s) to standard output.\n\n  -A, --show-all           equivalent to -vET\n  -b, --number-nonblank    number nonempty output lines, overrides -n\n  -E, --show-ends          display $ at end of each line\n  -n, --number             number all output lines\n  -s, --squeeze-blank      suppress repeated empty output lines\n  -T, --show-tabs          display TAB characters as ^I\n  -v, --show-nonprinting   use ^ and M- notation, except for LFD and TAB\n');
  add('tac', tac);
  add('mkdir', mkdir, 'Usage: mkdir [OPTION]... DIRECTORY...\nCreate the DIRECTORY(ies), if they do not already exist.\n\n  -m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask\n  -p, --parents     no error if existing, make parent directories as needed\n  -v, --verbose     print a message for each created directory\n');
  add('rmdir', rmdir);
  add('touch', touch);
  add('cp', cp, 'Usage: cp [OPTION]... SOURCE... DIRECTORY\nCopy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.\n\n  -a, --archive    same as -dR --preserve=all\n  -f, --force      remove destination files that cannot be opened\n  -i, --interactive  prompt before overwrite\n  -n, --no-clobber   do not overwrite an existing file\n  -r, -R, --recursive  copy directories recursively\n  -u, --update     copy only when the SOURCE file is newer\n  -v, --verbose    explain what is being done\n');
  add('mv', mv);
  add('rm', rm, 'Usage: rm [OPTION]... [FILE]...\nRemove (unlink) the FILE(s).\n\n  -f, --force           ignore nonexistent files and arguments, never prompt\n  -i                    prompt before every removal\n  -I                    prompt once before removing more than three files\n  -r, -R, --recursive   remove directories and their contents recursively\n  -d, --dir             remove empty directories\n  -v, --verbose         explain what is being done\n');
  add('ln', ln);
  add('chmod', chmod);
  add('chown chgrp', chown);
  add('stat', stat);
  add('find', find);
  add('du', du);
  add('df', df);
  add('tree', tree);
  add('file', file);
  add('realpath', realpath);
  add('readlink', readlink);
  add('basename', basenameCmd);
  add('dirname', dirnameCmd);
  add('mktemp', mktemp);
  add('truncate', truncate);
  add('tee', tee);
  add('which', which);
  add('whereis', whereis);
  add('install', install);
  add('shred', shred);
  add('split', split);
  add('dd', dd);
  add('tar', tar);
  add('gzip gunzip zcat', gzip);
  add('zip', zip);
  add('unzip', unzip);
  add('link', link);
  add('unlink', unlink);
  add('mkfifo', mkfifo);
  add('sync', async () => 0);
}

export { nodeSize, parseModeArg };
