// Installable extras: cowsay, fortune, figlet, lolcat, neofetch, jq.

import { getopt, cmd, UsageError, readInput, strWidth, splitLines } from '../util.js';

const ext = (fn, extra = {}) => ({ fn: cmd(fn), ...extra });

// ---------- cowsay ----------

const COWS = {
  default: (e, t, th) => `        ${th}   ^__^\n         ${th}  (${e})\\_______\n            (__)\\       )\\/\\\n             ${t} ||----w |\n                ||     ||\n`,
  tux: (e, t, th) => `   ${th}\n    ${th}\n        .--.\n       |o_o |\n       |:_/ |\n      //   \\ \\\n     (|     | )\n    /'\\_   _/\`\\\n    \\___)=(___/\n`,
  moose: (e, t, th) => `  ${th}\n   ${th}   \\_\\_    _/_/\n    ${th}      \\__/\n           (${e})\\_______\n           (__)\\       )\\/\\\n               ||----w |\n               ||     ||\n`,
  sheep: (e, t, th) => `  ${th}\n   ${th}\n       __     \n      UooU\\.'@@@@@@\`.\n      \\__/(@@@@@@@@@@)\n           (@@@@@@@@)\n           \`YY~~~~YY'\n            ||    ||\n`,
  dragon: (e, t, th) => `      ${th}                    / \\  //\\\n       ${th}    |\\___/|      /   \\//  \\\\\n            /0  0  \\__  /    //  | \\ \\    \n           /     /  \\/_/    //   |  \\  \\  \n           @_^_@'/   \\/_   //    |   \\   \\ \n           //_^_/     \\/_ //     |    \\    \\\n        ( //) |        \\///      |     \\     \\\n      ( / /) _|_ /   )  //       |      \\     _\\\n    ( // /) '/,_ _ _/  ( ; -.    |    _ _\\.-~        .-~~~^-.\n  (( / / )) ,-{        _      \`-.|.-~-.           .~         \`.\n (( // / ))  '/\\      /                 ~-. _ .-~      .-~^-.  \\\n (( /// ))      \`.   {            }                   /      \\  \\\n  (( / ))     .----~-.\\        \\-'                 .~         \\  \`. \\^-.\n             ///.----..>        \\             _ -~             \`.  ^-\`  ^-_\n               ///-._ _ _ _ _ _ _}^ - - - - ~                     ~-- ,.-~\n                                                                  /.-~\n`,
};

function wrapWords(text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (line && strWidth(line) + 1 + strWidth(w) > width) {
        out.push(line);
        line = w;
      } else line = line ? line + ' ' + w : w;
      while (strWidth(line) > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

async function cowsay(ctx) {
  const think = ctx.name === 'cowthink';
  const { o, rest } = getopt(ctx.args, { flags: 'lnbdgpstwy', params: 'feTW', long: {} });
  if (o.l) {
    await ctx.out(`Cow files in /usr/share/cowsay/cows:\n${Object.keys(COWS).join(' ')}\n`);
    return 0;
  }
  let text = rest.length ? rest.join(' ') : await ctx.stdin.readAll();
  text = text.replace(/\n$/, '');
  const width = Number(o.W || 40);
  const lines = o.n ? text.split('\n') : wrapWords(text, width);
  const w = Math.max(...lines.map(strWidth), 0);
  let bubble = ' ' + '_'.repeat(w + 2) + '\n';
  if (lines.length === 1) bubble += think ? `( ${lines[0]} )\n` : `< ${lines[0]} >\n`;
  else {
    lines.forEach((l, i) => {
      const pad = l + ' '.repeat(w - strWidth(l));
      if (think) bubble += `( ${pad} )\n`;
      else if (i === 0) bubble += `/ ${pad} \\\n`;
      else if (i === lines.length - 1) bubble += `\\ ${pad} /\n`;
      else bubble += `| ${pad} |\n`;
    });
  }
  bubble += ' ' + '-'.repeat(w + 2) + '\n';
  let eyes = o.e ? o.e.padEnd(2).slice(0, 2) : 'oo';
  if (o.b) eyes = '==';
  if (o.d) eyes = 'xx';
  if (o.g) eyes = '$$';
  if (o.p) eyes = '@@';
  if (o.s) eyes = '**';
  if (o.t) eyes = '--';
  if (o.w) eyes = 'OO';
  if (o.y) eyes = '..';
  const tongue = o.T ? o.T.padEnd(2).slice(0, 2) : o.d || o.s ? 'U ' : '  ';
  const cow = COWS[o.f || 'default'];
  if (!cow) {
    await ctx.err(`cowsay: Could not find ${o.f} cowfile!\n`);
    return 1;
  }
  await ctx.out(bubble + cow(eyes, tongue, think ? 'o' : '\\'));
  return 0;
}

// ---------- fortune ----------

const FORTUNES = [
  'There are only two hard things in Computer Science: cache invalidation and naming things.\n\t\t-- Phil Karlton',
  'Unix is simple. It just takes a genius to understand its simplicity.\n\t\t-- Dennis Ritchie',
  'Talk is cheap. Show me the code.\n\t\t-- Linus Torvalds',
  'Programs must be written for people to read, and only incidentally for machines to execute.\n\t\t-- Harold Abelson',
  'The best way to predict the future is to invent it.\n\t\t-- Alan Kay',
  'Simplicity is prerequisite for reliability.\n\t\t-- Edsger W. Dijkstra',
  'Premature optimization is the root of all evil.\n\t\t-- Donald Knuth',
  'If debugging is the process of removing bugs, then programming must be the process of putting them in.\n\t\t-- Edsger W. Dijkstra',
  'Any sufficiently advanced technology is indistinguishable from magic.\n\t\t-- Arthur C. Clarke',
  'Those who do not understand Unix are condemned to reinvent it, poorly.\n\t\t-- Henry Spencer',
  'Controlling complexity is the essence of computer programming.\n\t\t-- Brian Kernighan',
  'Everyone knows that debugging is twice as hard as writing a program in the first place.\n\t\t-- Brian Kernighan',
  'When in doubt, use brute force.\n\t\t-- Ken Thompson',
  'One of my most productive days was throwing away 1000 lines of code.\n\t\t-- Ken Thompson',
  'Beware of bugs in the above code; I have only proved it correct, not tried it.\n\t\t-- Donald Knuth',
  'The computer was born to solve problems that did not exist before.\n\t\t-- Bill Gates',
  'Real programmers count from 0.',
  'There is no place like 127.0.0.1',
  'rm -rf / is not a backup strategy.',
  'To understand recursion, you must first understand recursion.',
  'A day without sunshine is like, you know, night.\n\t\t-- Steve Martin',
  'Do or do not. There is no try.\n\t\t-- Yoda',
  'You will be successful in your work.',
  'Your lucky number has been disconnected.',
  'Today is the first day of the rest of your shell session.',
  'It works on my machine.',
  'Have you tried turning it off and on again?',
  'Weinberg\'s Second Law: If builders built buildings the way programmers wrote programs, then the first woodpecker that came along would destroy civilization.',
  'The nice thing about standards is that you have so many to choose from.\n\t\t-- Andrew S. Tanenbaum',
  'Walking on water and developing software from a specification are easy if both are frozen.\n\t\t-- Edward V. Berard',
];

async function fortune(ctx) {
  await ctx.out(FORTUNES[Math.floor(Math.random() * FORTUNES.length)] + '\n');
  return 0;
}

// ---------- figlet ----------

let fontCache = null;

async function loadFont() {
  if (fontCache) return fontCache;
  let text = null;
  if (typeof fetch !== 'undefined' && typeof location !== 'undefined') {
    try {
      const r = await fetch(new URL('../../vendor/standard.flf', import.meta.url));
      if (r.ok) text = await r.text();
    } catch {}
  }
  if (text === null && typeof process !== 'undefined') {
    try {
      const fs = await import('node:fs');
      text = fs.readFileSync(new URL('../../vendor/standard.flf', import.meta.url), 'utf8');
    } catch {}
  }
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const h = lines[0].split(' ');
  const hardblank = h[0].slice(-1);
  const height = Number(h[1]);
  const comments = Number(h[5]);
  const full = h[7] !== undefined ? Number(h[7]) : Number(h[4]) === 0 ? 64 : Number(h[4]) < 0 ? 0 : (Number(h[4]) & 31) | 128;
  const chars = new Map();
  let li = 1 + comments;
  const readChar = () => {
    const rows = [];
    for (let r = 0; r < height; r++) {
      const l = lines[li++] ?? '';
      const end = l[l.length - 1];
      rows.push(l.replace(new RegExp('[' + end.replace(/[\]\\^-]/g, '\\$&') + ']+$'), ''));
    }
    return rows;
  };
  for (let c = 32; c <= 126; c++) chars.set(c, readChar());
  for (const c of [196, 214, 220, 228, 246, 252, 223]) chars.set(c, readChar());
  fontCache = { hardblank, height, full, chars };
  return fontCache;
}

function smushChars(lch, rch, font, rules) {
  if (lch === ' ') return rch;
  if (rch === ' ') return lch;
  const hb = font.hardblank;
  if (lch === hb || rch === hb) return rules & 32 && lch === hb && rch === hb ? lch : null;
  if (rules & 1 && lch === rch) return lch;
  if (rules & 2) {
    if (lch === '_' && '|/\\[]{}()<>'.includes(rch)) return rch;
    if (rch === '_' && '|/\\[]{}()<>'.includes(lch)) return lch;
  }
  if (rules & 4) {
    const classes = ['|', '/\\', '[]', '{}', '()', '<>'];
    const cl = classes.findIndex((c) => c.includes(lch));
    const cr = classes.findIndex((c) => c.includes(rch));
    if (cl >= 0 && cr >= 0 && cl !== cr) return cl > cr ? lch : rch;
  }
  if (rules & 8) {
    const pairs = ['[]', '][', '{}', '}{', '()', ')('];
    if (pairs.includes(lch + rch)) return '|';
  }
  if (rules & 16) {
    if (lch === '/' && rch === '\\') return '|';
    if (lch === '\\' && rch === '/') return 'Y';
    if (lch === '>' && rch === '<') return 'X';
  }
  return null;
}

export async function figletRender(text, width = 80) {
  const font = await loadFont();
  if (!font) return null;
  const rules = font.full & 63;
  const smush = (font.full & 128) !== 0;
  const outLines = [];
  for (const line of text.split('\n')) {
    let out = Array(font.height).fill('');
    const flush = () => {
      outLines.push(...out.map((r) => r.split(font.hardblank).join(' ').replace(/\s+$/, '')));
      out = Array(font.height).fill('');
    };
    for (const ch of line) {
      const g = font.chars.get(ch.codePointAt(0)) || font.chars.get(63);
      const gw = Math.max(...g.map((r) => r.length));
      const cur = Math.max(...out.map((r) => r.length));
      // compute overlap
      let amt = gw;
      for (let r = 0; r < font.height; r++) {
        const ol = out[r].padEnd(cur);
        let lb = ol.length - 1;
        while (lb >= 0 && ol[lb] === ' ') lb--;
        const cr = g[r];
        let rb = 0;
        while (rb < cr.length && cr[rb] === ' ') rb++;
        let a = rb + ol.length - 1 - lb;
        const ch1 = lb >= 0 ? ol[lb] : null;
        const ch2 = rb < cr.length ? cr[rb] : null;
        if (!ch1 || ch1 === ' ') a++;
        else if (ch2 && smush && smushChars(ch1, ch2, font, rules) !== null) a++;
        amt = Math.min(amt, a);
      }
      if (cur === 0) amt = 0;
      if (cur - amt + gw > width && cur > 0) {
        flush();
        amt = 0;
      }
      const base = Math.max(...out.map((r) => r.length));
      for (let r = 0; r < font.height; r++) {
        let ol = out[r].padEnd(base);
        const cr = g[r].padEnd(gw);
        for (let k = 0; k < amt; k++) {
          const pos = ol.length - amt + k;
          if (pos < 0) continue;
          const merged = smush ? smushChars(ol[pos], cr[k], font, rules) : ol[pos] === ' ' ? cr[k] : ol[pos];
          ol = ol.slice(0, pos) + (merged ?? cr[k]) + ol.slice(pos + 1);
        }
        out[r] = ol + cr.slice(amt);
      }
    }
    flush();
  }
  return outLines.join('\n') + '\n';
}

async function figlet(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'clrktSWxLRp', params: 'wfdmD', long: {} });
  const text = rest.length ? rest.join(' ') : (await ctx.stdin.readAll()).replace(/\n$/, '');
  const width = Number(o.w || (o.t ? ctx.shell.getVar('COLUMNS') : 80) || 80);
  const r = await figletRender(text, width);
  if (r === null) {
    await ctx.err('figlet: standard: Unable to open font file\n');
    return 1;
  }
  let out = r;
  if (o.c) out = out.split('\n').map((l) => (l ? ' '.repeat(Math.max(0, Math.floor((width - l.length) / 2))) + l : l)).join('\n');
  if (o.r) out = out.split('\n').map((l) => (l ? ' '.repeat(Math.max(0, width - l.length)) + l : l)).join('\n');
  await ctx.out(out);
  return 0;
}

// ---------- lolcat ----------

async function lolcat(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'fat', params: 'pSF', long: { spread: 'p', seed: 'S', freq: 'F', force: 'f', animate: 'a', truecolor: 't' } });
  const text = await readInput(ctx, rest);
  const freq = Number(o.F || 0.1);
  const spread = Number(o.p || 3);
  let seed = o.S ? Number(o.S) : Math.floor(Math.random() * 256);
  const color = ctx.stdout.isTerminalWriter || o.f;
  if (!color) {
    await ctx.out(text);
    return 0;
  }
  let out = '';
  let lineNo = 0;
  for (const line of text.split('\n')) {
    let i = 0;
    for (const ch of line) {
      const v = freq * (seed + lineNo + i / spread);
      const r = Math.floor(Math.sin(v) * 127 + 128);
      const g = Math.floor(Math.sin(v + (2 * Math.PI) / 3) * 127 + 128);
      const b = Math.floor(Math.sin(v + (4 * Math.PI) / 3) * 127 + 128);
      out += `\x1b[38;2;${r};${g};${b}m${ch}`;
      i++;
    }
    out += '\x1b[0m\n';
    lineNo++;
  }
  await ctx.out(out.replace(/\x1b\[0m\n$/, text.endsWith('\n') ? '\x1b[0m\n' : '\x1b[0m'));
  return 0;
}

// ---------- neofetch ----------

async function neofetch(ctx) {
  const sh = ctx.shell;
  const sys = sh.system;
  const up = sys.uptimeSeconds();
  const h = Math.floor(up / 3600);
  const m = Math.floor((up % 3600) / 60);
  const user = sh.system.userName(sh.vfs.cred.uid);
  const title = `${user}@${sys.hostname}`;
  const term = sh.term;
  const R = '\x1b[31m';
  const B = '\x1b[1m';
  const X = '\x1b[0m';
  const logo = [
    '            .-/+oossssoo+/-.',
    '        `:+ssssssssssssssssss+:`',
    '      -+ssssssssssssssssssyyssss+-',
    '    .ossssssssssssssssssdMMMNysssso.',
    '   /ssssssssssshdmmNNmmyNMMMMhssssss/',
    '  +ssssssssshmydMMMMMMMNddddyssssssss+',
    ' /sssssssshNMMMyhhyyyyhmNMMMNhssssssss/',
    '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
    '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
    'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
    'ossyNMMMNyMMhsssssssssssssshmmmhssssssso',
    '+sssshhhyNMMNyssssssssssssyNMMMysssssss+',
    '.ssssssssdMMMNhsssssssssshNMMMdssssssss.',
    ' /sssssssshNMMMyhhyyyyhdNMMMNhssssssss/',
    '  +sssssssssdmydMMMMMMMMddddyssssssss+',
    '   /ssssssssssshdmNNNNmyNMMMMhssssss/',
    '    .ossssssssssssssssssdMMMNysssso.',
    '      -+sssssssssssssssssyyyssss+-',
    '        `:+ssssssssssssssssss+:`',
    '            .-/+oossssoo+/-.',
  ];
  const mem = Math.floor(2342 + sh.vfs.totalBytes() / 1048576);
  const info = [
    `${R}${B}${title.split('@')[0]}${X}@${R}${B}${sys.hostname}${X}`,
    '-'.repeat(title.length),
    `${R}${B}OS${X}: Ubuntu 24.04.1 LTS x86_64`,
    `${R}${B}Host${X}: KVM/QEMU (Standard PC (i440FX + PIIX, 1996) pc-i440fx-8.2)`,
    `${R}${B}Kernel${X}: ${sys.kernel}`,
    `${R}${B}Uptime${X}: ${h ? `${h} hour${h > 1 ? 's' : ''}, ` : ''}${m} min${m !== 1 ? 's' : ''}`,
    `${R}${B}Packages${X}: ${612 + sys.installed.size} (dpkg)`,
    `${R}${B}Shell${X}: bash 5.2.21`,
    `${R}${B}Resolution${X}: ${term ? `${term.cols}x${term.rows} (cells)` : 'n/a'}`,
    `${R}${B}Terminal${X}: xterm.js (apps.badita.com/bash)`,
    `${R}${B}CPU${X}: Intel Xeon (4) @ 2.200GHz`,
    `${R}${B}GPU${X}: 00:02.0 Red Hat, Inc. QXL paravirtual graphic card`,
    `${R}${B}Memory${X}: ${mem}MiB / 15912MiB`,
    '',
    [40, 41, 42, 43, 44, 45, 46, 47].map((c) => `\x1b[${c}m   `).join('') + X,
    [100, 101, 102, 103, 104, 105, 106, 107].map((c) => `\x1b[${c}m   `).join('') + X,
  ];
  let out = '';
  for (let i = 0; i < Math.max(logo.length, info.length); i++) {
    const l = logo[i] || '';
    out += `${R}${B}${l.padEnd(41)}${X} ${info[i] || ''}\n`;
  }
  await ctx.out(out);
  return 0;
}

// ---------- jq (a useful subset) ----------

class JqError extends Error {}

function jqTokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const d = src[j + 1];
          if (d === '(') {
            // string interpolation \( ... )
            let depth = 1;
            let k = j + 2;
            while (k < src.length && depth) {
              if (src[k] === '(') depth++;
              else if (src[k] === ')') depth--;
              k++;
            }
            s += '\u0000' + src.slice(j + 2, k - 1) + '\u0001';
            j = k;
            continue;
          }
          s += { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' }[d] ?? d;
          j += 2;
          continue;
        }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    let m;
    if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i)))) {
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\$?[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i)))) {
      toks.push({ t: m[0].startsWith('$') ? 'var' : 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const ops = ['|=', '+=', '-=', '//=', '==', '!=', '<=', '>=', '//', '?//', '..', '|', ',', '.', '[', ']', '(', ')', '{', '}', ':', ';', '+', '-', '*', '/', '%', '<', '>', '=', '?'];
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new JqError(`syntax error, unexpected '${c}'`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  toks.push({ t: 'eof' });
  return toks;
}

function jqParse(src) {
  const toks = jqTokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v) => toks[p].t === 'op' && toks[p].v === v;
  const isId = (v) => toks[p].t === 'id' && toks[p].v === v;
  const expect = (v) => {
    if (!isOp(v)) throw new JqError(`syntax error: expected '${v}'`);
    p++;
  };
  function pipe() {
    let l = comma();
    if (isId('as')) {
      next();
      const v = next().v;
      expect('|');
      const body = pipe();
      return { k: 'as', src: l, v, body };
    }
    while (isOp('|')) {
      next();
      l = { k: 'pipe', a: l, b: pipe() };
      return l;
    }
    return l;
  }
  function comma() {
    let l = alt();
    while (isOp(',')) {
      next();
      l = { k: 'comma', a: l, b: alt() };
    }
    return l;
  }
  function alt() {
    let l = orE();
    while (isOp('//')) {
      next();
      l = { k: 'alt', a: l, b: orE() };
    }
    if (isOp('|=') || isOp('=') || isOp('+=') || isOp('-=')) {
      const op = next().v;
      l = { k: 'update', op, path: l, v: alt() };
    }
    return l;
  }
  function orE() {
    let l = andE();
    while (isId('or')) {
      next();
      l = { k: 'or', a: l, b: andE() };
    }
    return l;
  }
  function andE() {
    let l = cmpE();
    while (isId('and')) {
      next();
      l = { k: 'and', a: l, b: cmpE() };
    }
    return l;
  }
  function cmpE() {
    let l = addE();
    if (peek().t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(peek().v)) {
      const op = next().v;
      l = { k: 'bin', op, a: l, b: addE() };
    }
    return l;
  }
  function addE() {
    let l = mulE();
    while (isOp('+') || isOp('-')) {
      const op = next().v;
      l = { k: 'bin', op, a: l, b: mulE() };
    }
    return l;
  }
  function mulE() {
    let l = postfix();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = next().v;
      l = { k: 'bin', op, a: l, b: postfix() };
    }
    return l;
  }
  function postfix() {
    let e = primary();
    for (;;) {
      if (isOp('[')) {
        e = { k: 'pipe', a: e, b: bracket() };
        continue;
      }
      if (isOp('.') && (toks[p + 1].t === 'id' || toks[p + 1].t === 'str' || (toks[p + 1].t === 'op' && toks[p + 1].v === '['))) {
        next();
        if (isOp('[')) e = { k: 'pipe', a: e, b: bracket() };
        else e = { k: 'pipe', a: e, b: { k: 'field', name: next().v } };
        continue;
      }
      if (isOp('?')) {
        next();
        e = { k: 'try', a: e };
        continue;
      }
      break;
    }
    return e;
  }
  function bracket() {
    expect('[');
    if (isOp(']')) {
      next();
      return { k: 'iter' };
    }
    let a = isOp(':') ? null : pipe();
    if (isOp(':')) {
      next();
      const b = isOp(']') ? null : pipe();
      expect(']');
      return { k: 'slice', a, b };
    }
    expect(']');
    return { k: 'index', e: a };
  }
  function primary() {
    const t = next();
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'var') return { k: 'var', v: t.v };
    if (t.t === 'op') {
      if (t.v === '.') {
        if (peek().t === 'id' && !['and', 'or', 'as'].includes(peek().v)) return { k: 'field', name: next().v };
        if (peek().t === 'str') return { k: 'field', name: next().v };
        if (isOp('[')) return bracket();
        return { k: 'identity' };
      }
      if (t.v === '..') return { k: 'recurse' };
      if (t.v === '(') {
        const e = pipe();
        expect(')');
        return e;
      }
      if (t.v === '[') {
        if (isOp(']')) {
          next();
          return { k: 'array', e: null };
        }
        const e = pipe();
        expect(']');
        return { k: 'array', e };
      }
      if (t.v === '{') {
        const entries = [];
        while (!isOp('}')) {
          const kt = next();
          let key;
          if (kt.t === 'id' || kt.t === 'str') key = { k: 'lit', v: kt.v };
          else if (kt.t === 'var') key = { k: 'lit', v: kt.v.slice(1) };
          else if (kt.t === 'op' && kt.v === '(') {
            key = pipe();
            expect(')');
          } else throw new JqError('syntax error in object');
          let val;
          if (isOp(':')) {
            next();
            val = alt();
          } else val = kt.t === 'var' ? { k: 'var', v: kt.v } : { k: 'field', name: kt.v };
          entries.push([key, val]);
          if (isOp(',')) next();
        }
        next();
        return { k: 'object', entries };
      }
      if (t.v === '-') return { k: 'neg', a: postfix() };
    }
    if (t.t === 'id') {
      if (t.v === 'if') {
        const c = pipe();
        if (!isId('then')) throw new JqError('expected then');
        next();
        const a = pipe();
        let b = { k: 'identity' };
        if (isId('elif')) {
          toks[p] = { t: 'id', v: 'if' };
          b = primary();
          return { k: 'if', c, a, b };
        }
        if (isId('else')) {
          next();
          b = pipe();
        }
        if (!isId('end')) throw new JqError('expected end');
        next();
        return { k: 'if', c, a, b };
      }
      if (t.v === 'try') {
        const a = postfix();
        let b = null;
        if (isId('catch')) {
          next();
          b = postfix();
        }
        return { k: 'try', a, b };
      }
      if (t.v === 'reduce' || t.v === 'foreach') {
        const src = postfix();
        if (!isId('as')) throw new JqError('expected as');
        next();
        const v = next().v;
        expect('(');
        const init = pipe();
        expect(';');
        const upd = pipe();
        let ext = null;
        if (t.v === 'foreach' && isOp(';')) {
          next();
          ext = pipe();
        }
        expect(')');
        return { k: t.v, src, v, init, upd, ext };
      }
      if (t.v === 'def') throw new JqError('def is not supported in this jq');
      const args = [];
      if (isOp('(')) {
        next();
        args.push(pipe());
        while (isOp(';')) {
          next();
          args.push(pipe());
        }
        expect(')');
      }
      return { k: 'call', name: t.v, args };
    }
    throw new JqError(`syntax error, unexpected ${t.t === 'eof' ? 'end of input' : `'${t.v}'`}`);
  }
  const e = pipe();
  if (peek().t !== 'eof') throw new JqError(`syntax error, unexpected '${peek().v}'`);
  return e;
}

const jqType = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);

function jqCmp(a, b) {
  const order = ['null', 'boolean', 'number', 'string', 'array', 'object'];
  const ta = order.indexOf(jqType(a) === 'boolean' ? 'boolean' : jqType(a));
  const tb = order.indexOf(jqType(b) === 'boolean' ? 'boolean' : jqType(b));
  if (ta !== tb) return ta - tb;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = jqCmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const c = jqCmp(ka, kb);
    if (c) return c;
    for (const k of ka) {
      const d = jqCmp(a[k], b[k]);
      if (d) return d;
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function* jqEval(e, input, env) {
  switch (e.k) {
    case 'identity':
      yield input;
      return;
    case 'lit':
      yield e.v;
      return;
    case 'str': {
      if (!e.v.includes('\u0000')) {
        yield e.v;
        return;
      }
      let s = '';
      const parts = e.v.split(/\u0000|\u0001/);
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 0) s += parts[i];
        else {
          const v = jqFirst(jqParse(parts[i]), input, env);
          s += typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
      yield s;
      return;
    }
    case 'var':
      if (!(e.v in env)) throw new JqError(`${e.v} is not defined`);
      yield env[e.v];
      return;
    case 'field':
      if (input === null) {
        yield null;
        return;
      }
      if (typeof input !== 'object' || Array.isArray(input)) throw new JqError(`Cannot index ${jqType(input)} with "${e.name}"`);
      yield input[e.name] === undefined ? null : input[e.name];
      return;
    case 'index':
      for (const k of jqEval(e.e, input, env)) {
        if (input === null) {
          yield null;
          continue;
        }
        if (Array.isArray(input) && typeof k === 'number') {
          const i = k < 0 ? input.length + k : Math.floor(k);
          yield input[i] === undefined ? null : input[i];
        } else if (typeof input === 'object' && !Array.isArray(input) && typeof k === 'string') yield input[k] === undefined ? null : input[k];
        else throw new JqError(`Cannot index ${jqType(input)} with ${jqType(k)}`);
      }
      return;
    case 'slice': {
      const a = e.a ? jqFirst(e.a, input, env) : 0;
      const b = e.b ? jqFirst(e.b, input, env) : undefined;
      if (input === null) {
        yield null;
        return;
      }
      yield input.slice(a, b === undefined ? undefined : b);
      return;
    }
    case 'iter':
      if (Array.isArray(input)) yield* input;
      else if (input && typeof input === 'object') yield* Object.values(input);
      else throw new JqError(`Cannot iterate over ${jqType(input)}${input === null ? '' : ` (${JSON.stringify(input)})`}`);
      return;
    case 'recurse': {
      const rec = function* (v) {
        yield v;
        if (Array.isArray(v)) for (const x of v) yield* rec(x);
        else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* rec(x);
      };
      yield* rec(input);
      return;
    }
    case 'pipe':
      for (const v of jqEval(e.a, input, env)) yield* jqEval(e.b, v, env);
      return;
    case 'comma':
      yield* jqEval(e.a, input, env);
      yield* jqEval(e.b, input, env);
      return;
    case 'as':
      for (const v of jqEval(e.src, input, env)) yield* jqEval(e.body, input, { ...env, [e.v]: v });
      return;
    case 'alt': {
      const vals = [];
      try {
        for (const v of jqEval(e.a, input, env)) if (v !== null && v !== false) vals.push(v);
      } catch {}
      if (vals.length) yield* vals;
      else yield* jqEval(e.b, input, env);
      return;
    }
    case 'or':
      for (const a of jqEval(e.a, input, env)) {
        if (a !== null && a !== false) yield true;
        else for (const b of jqEval(e.b, input, env)) yield b !== null && b !== false;
      }
      return;
    case 'and':
      for (const a of jqEval(e.a, input, env)) {
        if (a === null || a === false) yield false;
        else for (const b of jqEval(e.b, input, env)) yield b !== null && b !== false;
      }
      return;
    case 'neg':
      for (const v of jqEval(e.a, input, env)) yield -v;
      return;
    case 'bin':
      for (const b of jqEval(e.b, input, env)) for (const a of jqEval(e.a, input, env)) yield jqBin(e.op, a, b);
      return;
    case 'array':
      yield e.e ? [...jqEval(e.e, input, env)] : [];
      return;
    case 'object': {
      let results = [{}];
      for (const [ke, ve] of e.entries) {
        const next = [];
        for (const r of results) for (const k of jqEval(ke, input, env)) for (const v of jqEval(ve, input, env)) next.push({ ...r, [k]: v });
        results = next;
      }
      yield* results;
      return;
    }
    case 'if':
      for (const c of jqEval(e.c, input, env)) yield* jqEval(c !== null && c !== false ? e.a : e.b, input, env);
      return;
    case 'try':
      try {
        yield* [...jqEval(e.a, input, env)];
      } catch (err) {
        if (e.b) yield* jqEval(e.b, err.message, env);
      }
      return;
    case 'reduce': {
      let acc = jqFirst(e.init, input, env);
      for (const v of jqEval(e.src, input, env)) acc = jqFirst(e.upd, acc, { ...env, [e.v]: v });
      yield acc;
      return;
    }
    case 'foreach': {
      let acc = jqFirst(e.init, input, env);
      for (const v of jqEval(e.src, input, env)) {
        acc = jqFirst(e.upd, acc, { ...env, [e.v]: v });
        if (e.ext) yield* jqEval(e.ext, acc, { ...env, [e.v]: v });
        else yield acc;
      }
      return;
    }
    case 'update': {
      // supports simple paths: .a.b |= f, .a = v
      const paths = jqPaths(e.path, input, env);
      let out = structuredClone(input);
      for (const path of paths) {
        const cur = path.reduce((o, k) => (o == null ? null : o[k]), out);
        let nv;
        if (e.op === '|=') nv = jqFirst(e.v, cur, env);
        else if (e.op === '=') nv = jqFirst(e.v, input, env);
        else nv = jqBin(e.op[0], cur, jqFirst(e.v, input, env));
        out = jqSetPath(out, path, nv);
      }
      yield out;
      return;
    }
    case 'call':
      yield* jqCall(e, input, env);
      return;
  }
  throw new JqError('unsupported expression');
}

function jqPaths(e, input, env) {
  switch (e.k) {
    case 'identity':
      return [[]];
    case 'field':
      return [[e.name]];
    case 'index':
      return [...jqEval(e.e, input, env)].map((k) => [k]);
    case 'iter':
      return Array.isArray(input) ? input.map((_, i) => [i]) : Object.keys(input || {}).map((k) => [k]);
    case 'pipe': {
      const out = [];
      for (const p of jqPaths(e.a, input, env)) {
        const v = p.reduce((o, k) => (o == null ? null : o[k]), input);
        for (const q of jqPaths(e.b, v, env)) out.push([...p, ...q]);
      }
      return out;
    }
    case 'comma':
      return [...jqPaths(e.a, input, env), ...jqPaths(e.b, input, env)];
    case 'call':
      if (e.name === 'select') return [...jqEval(e.args[0], input, env)].some((c) => c !== null && c !== false) ? [[]] : [];
  }
  throw new JqError('Invalid path expression');
}

function jqSetPath(obj, path, v) {
  if (!path.length) return v;
  const [k, ...rest] = path;
  const base = obj == null ? (typeof k === 'number' ? [] : {}) : obj;
  const copy = Array.isArray(base) ? base.slice() : { ...base };
  copy[k] = jqSetPath(base[k], rest, v);
  return copy;
}

function jqFirst(e, input, env) {
  for (const v of jqEval(e, input, env)) return v;
  return null;
}

function jqBin(op, a, b) {
  switch (op) {
    case '+':
      if (a === null) return b;
      if (b === null) return a;
      if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
      if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) return { ...a, ...b };
      if (typeof a !== typeof b) throw new JqError(`${jqType(a)} (${JSON.stringify(a)}) and ${jqType(b)} (${JSON.stringify(b)}) cannot be added`);
      return a + b;
    case '-':
      if (Array.isArray(a)) return a.filter((x) => !b.some((y) => jqCmp(x, y) === 0));
      if (typeof a !== 'number' || typeof b !== 'number') throw new JqError(`${jqType(a)} (${JSON.stringify(a)}) and ${jqType(b)} (${JSON.stringify(b)}) cannot be subtracted`);
      return a - b;
    case '*':
      if (typeof a === 'string' && typeof b === 'number') return b > 0 ? a.repeat(b) : null;
      if (typeof a === 'object' && typeof b === 'object') return { ...a, ...b };
      return a * b;
    case '/':
      if (typeof a === 'string') return a.split(b);
      if (b === 0) throw new JqError(`${a} and ${b} cannot be divided because the divisor is zero`);
      return a / b;
    case '%':
      return Math.trunc(a) % Math.trunc(b);
    case '==':
      return jqCmp(a, b) === 0;
    case '!=':
      return jqCmp(a, b) !== 0;
    case '<':
      return jqCmp(a, b) < 0;
    case '<=':
      return jqCmp(a, b) <= 0;
    case '>':
      return jqCmp(a, b) > 0;
    case '>=':
      return jqCmp(a, b) >= 0;
  }
}

function* jqCall(e, input, env) {
  const A = (i) => e.args[i];
  const all = (i, v = input) => [...jqEval(A(i), v, env)];
  const truthy = (v) => v !== null && v !== false;
  switch (e.name) {
    case 'empty':
      return;
    case 'not':
      yield !truthy(input);
      return;
    case 'length':
      yield input === null ? 0 : typeof input === 'number' ? Math.abs(input) : typeof input === 'object' && !Array.isArray(input) ? Object.keys(input).length : typeof input === 'boolean' ? (() => { throw new JqError('boolean (' + input + ') has no length'); })() : [...input].length;
      return;
    case 'utf8bytelength':
      yield new TextEncoder().encode(input).length;
      return;
    case 'keys':
    case 'keys_unsorted':
      if (Array.isArray(input)) yield input.map((_, i) => i);
      else if (input && typeof input === 'object') yield e.name === 'keys' ? Object.keys(input).sort() : Object.keys(input);
      else throw new JqError(`${jqType(input)} (${JSON.stringify(input)}) has no keys`);
      return;
    case 'values':
      if (input !== null) yield input;
      return;
    case 'has':
      for (const k of all(0)) yield Array.isArray(input) ? k >= 0 && k < input.length : Object.prototype.hasOwnProperty.call(input, k);
      return;
    case 'in':
      for (const o of all(0)) yield Object.prototype.hasOwnProperty.call(o, input);
      return;
    case 'map':
      if (!Array.isArray(input) && (input === null || typeof input !== 'object')) throw new JqError(`Cannot iterate over ${jqType(input)}`);
      yield (Array.isArray(input) ? input : Object.values(input)).flatMap((x) => all(0, x));
      return;
    case 'map_values': {
      if (Array.isArray(input)) yield input.map((x) => jqFirst(A(0), x, env));
      else yield Object.fromEntries(Object.entries(input).map(([k, v]) => [k, jqFirst(A(0), v, env)]));
      return;
    }
    case 'select':
      for (const c of all(0)) if (truthy(c)) yield input;
      return;
    case 'recurse':
      yield* jqEval({ k: 'recurse' }, input, env);
      return;
    case 'to_entries':
      yield Object.entries(input).map(([key, value]) => ({ key, value }));
      return;
    case 'from_entries':
      yield Object.fromEntries(input.map((x) => [x.key ?? x.k ?? x.name ?? x.Name ?? x.Key, x.value ?? x.v ?? x.Value]));
      return;
    case 'with_entries':
      yield Object.fromEntries(Object.entries(input).flatMap(([key, value]) => all(0, { key, value })).map((x) => [x.key, x.value]));
      return;
    case 'add':
      yield (Array.isArray(input) ? input : Object.values(input)).reduce((a, b) => (a === null ? b : jqBin('+', a, b)), null);
      return;
    case 'any':
      yield e.args.length ? input.some((x) => all(0, x).some(truthy)) : input.some(truthy);
      return;
    case 'all':
      yield e.args.length ? input.every((x) => all(0, x).some(truthy)) : input.every(truthy);
      return;
    case 'range': {
      const vals = e.args.map((a) => jqFirst(a, input, env));
      let [from, upto, by] = vals.length === 1 ? [0, vals[0], 1] : [vals[0], vals[1], vals[2] ?? 1];
      for (let i = from; by > 0 ? i < upto : i > upto; i += by) yield i;
      return;
    }
    case 'floor':
      yield Math.floor(input);
      return;
    case 'ceil':
      yield Math.ceil(input);
      return;
    case 'round':
      yield Math.round(input);
      return;
    case 'sqrt':
      yield Math.sqrt(input);
      return;
    case 'fabs':
    case 'abs':
      yield Math.abs(input);
      return;
    case 'pow':
      yield jqFirst(A(0), input, env) ** jqFirst(A(1), input, env);
      return;
    case 'log':
      yield Math.log(input);
      return;
    case 'tostring':
      yield typeof input === 'string' ? input : JSON.stringify(input);
      return;
    case 'tonumber':
      if (typeof input === 'number') yield input;
      else {
        const n = Number(input);
        if (isNaN(n)) throw new JqError(`Cannot parse '${input}' as JSON`);
        yield n;
      }
      return;
    case 'type':
      yield jqType(input);
      return;
    case 'arrays':
    case 'objects':
    case 'strings':
    case 'numbers':
    case 'booleans':
    case 'nulls':
    case 'iterables':
    case 'scalars': {
      const t = jqType(input);
      const want = { arrays: ['array'], objects: ['object'], strings: ['string'], numbers: ['number'], booleans: ['boolean'], nulls: ['null'], iterables: ['array', 'object'], scalars: ['null', 'boolean', 'number', 'string'] }[e.name];
      if (want.includes(t)) yield input;
      return;
    }
    case 'sort':
      yield input.slice().sort(jqCmp);
      return;
    case 'sort_by':
      yield input.slice().sort((a, b) => jqCmp(all(0, a), all(0, b)));
      return;
    case 'group_by': {
      const sorted = input.slice().sort((a, b) => jqCmp(all(0, a), all(0, b)));
      const groups = [];
      for (const x of sorted) {
        const k = all(0, x);
        const g = groups[groups.length - 1];
        if (g && jqCmp(g.k, k) === 0) g.v.push(x);
        else groups.push({ k, v: [x] });
      }
      yield groups.map((g) => g.v);
      return;
    }
    case 'unique':
      yield input.slice().sort(jqCmp).filter((x, i, a) => i === 0 || jqCmp(a[i - 1], x) !== 0);
      return;
    case 'unique_by': {
      const seen = [];
      const out = [];
      for (const x of input.slice().sort((a, b) => jqCmp(all(0, a), all(0, b)))) {
        const k = all(0, x);
        if (!seen.some((s) => jqCmp(s, k) === 0)) {
          seen.push(k);
          out.push(x);
        }
      }
      yield out;
      return;
    }
    case 'min':
    case 'max':
      yield input.length ? input.slice().sort(jqCmp)[e.name === 'min' ? 0 : input.length - 1] : null;
      return;
    case 'min_by':
    case 'max_by': {
      const s = input.slice().sort((a, b) => jqCmp(all(0, a), all(0, b)));
      yield s.length ? s[e.name === 'min_by' ? 0 : s.length - 1] : null;
      return;
    }
    case 'reverse':
      yield typeof input === 'string' ? [...input].reverse().join('') : input.slice().reverse();
      return;
    case 'first':
      if (e.args.length) {
        for (const v of jqEval(A(0), input, env)) {
          yield v;
          return;
        }
        return;
      }
      yield input[0] ?? null;
      return;
    case 'last':
      if (e.args.length) {
        const vs = all(0);
        if (vs.length) yield vs[vs.length - 1];
        return;
      }
      yield input[input.length - 1] ?? null;
      return;
    case 'limit': {
      const n = jqFirst(A(0), input, env);
      let i = 0;
      if (n <= 0) return;
      for (const v of jqEval(A(1), input, env)) {
        yield v;
        if (++i >= n) return;
      }
      return;
    }
    case 'nth':
      yield e.args.length > 1 ? all(1)[jqFirst(A(0), input, env)] ?? null : input[jqFirst(A(0), input, env)] ?? null;
      return;
    case 'flatten': {
      const depth = e.args.length ? jqFirst(A(0), input, env) : 1e9;
      const fl = (a, d) => a.flatMap((x) => (Array.isArray(x) && d > 0 ? fl(x, d - 1) : [x]));
      yield fl(input, depth);
      return;
    }
    case 'indices':
    case 'index':
    case 'rindex': {
      const t = jqFirst(A(0), input, env);
      const idx = [];
      if (typeof input === 'string') {
        let i = input.indexOf(t);
        while (i >= 0 && t !== '') {
          idx.push(i);
          i = input.indexOf(t, i + 1);
        }
      } else input.forEach((x, i) => jqCmp(x, t) === 0 && idx.push(i));
      yield e.name === 'indices' ? idx : e.name === 'index' ? idx[0] ?? null : idx[idx.length - 1] ?? null;
      return;
    }
    case 'contains': {
      const b = jqFirst(A(0), input, env);
      const cont = (a, b) => (typeof b === 'string' ? typeof a === 'string' && a.includes(b) : Array.isArray(b) ? b.every((y) => a.some((x) => cont(x, y))) : b && typeof b === 'object' ? Object.keys(b).every((k) => k in a && cont(a[k], b[k])) : jqCmp(a, b) === 0);
      yield cont(input, b);
      return;
    }
    case 'inside':
      yield* jqCall({ name: 'contains', args: [{ k: 'lit', v: input }] }, jqFirst(A(0), input, env), env);
      return;
    case 'startswith':
      yield input.startsWith(jqFirst(A(0), input, env));
      return;
    case 'endswith':
      yield input.endsWith(jqFirst(A(0), input, env));
      return;
    case 'ltrimstr': {
      const s = jqFirst(A(0), input, env);
      yield typeof input === 'string' && input.startsWith(s) ? input.slice(s.length) : input;
      return;
    }
    case 'rtrimstr': {
      const s = jqFirst(A(0), input, env);
      yield typeof input === 'string' && input.endsWith(s) && s ? input.slice(0, -s.length) : input;
      return;
    }
    case 'trim':
      yield input.trim();
      return;
    case 'ltrim':
      yield input.trimStart();
      return;
    case 'rtrim':
      yield input.trimEnd();
      return;
    case 'ascii_downcase':
      yield input.toLowerCase();
      return;
    case 'ascii_upcase':
      yield input.toUpperCase();
      return;
    case 'explode':
      yield [...input].map((c) => c.codePointAt(0));
      return;
    case 'implode':
      yield String.fromCodePoint(...input);
      return;
    case 'split':
      if (e.args.length > 1) yield input.split(new RegExp(jqFirst(A(0), input, env), (jqFirst(A(1), input, env) || '').replace('g', '')));
      else yield input.split(jqFirst(A(0), input, env));
      return;
    case 'join': {
      const sep = jqFirst(A(0), input, env);
      yield input.map((x) => (x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x))).join(sep);
      return;
    }
    case 'test':
    case 'match':
    case 'capture':
    case 'sub':
    case 'gsub':
    case 'scan': {
      const re = jqFirst(A(0), input, env);
      const flagArg = e.name === 'sub' || e.name === 'gsub' ? A(2) : A(1);
      let flags = flagArg ? jqFirst(flagArg, input, env) || '' : '';
      if (e.name === 'gsub' || e.name === 'scan') flags += 'g';
      const r = new RegExp(re, [...new Set(flags.replace(/[^gimsx]/g, '').replace('x', ''))].join(''));
      if (e.name === 'test') {
        yield r.test(input);
        return;
      }
      if (e.name === 'sub' || e.name === 'gsub') {
        yield input.replace(r, (...m) => {
          const groups = typeof m[m.length - 1] === 'object' ? m[m.length - 1] : {};
          return jqFirst(A(1), groups || {}, env);
        });
        return;
      }
      if (e.name === 'scan') {
        for (const m of input.matchAll(new RegExp(r.source, r.flags.includes('g') ? r.flags : r.flags + 'g'))) yield m.length > 1 ? m.slice(1) : m[0];
        return;
      }
      const m = r.exec(input);
      if (!m) return;
      if (e.name === 'capture') {
        yield { ...(m.groups || {}) };
        return;
      }
      yield { offset: m.index, length: m[0].length, string: m[0], captures: m.slice(1).map((c) => ({ offset: input.indexOf(c), length: c ? c.length : 0, string: c ?? null, name: null })) };
      return;
    }
    case 'tojson':
      yield JSON.stringify(input);
      return;
    case 'fromjson':
      yield JSON.parse(input);
      return;
    case 'ascii':
      yield String.fromCharCode(input);
      return;
    case 'env':
    case '$ENV':
      yield env.$ENV || {};
      return;
    case 'paths': {
      const out = [];
      const rec = (v, p) => {
        if (p.length) out.push(p);
        if (Array.isArray(v)) v.forEach((x, i) => rec(x, [...p, i]));
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) rec(x, [...p, k]);
      };
      rec(input, []);
      yield* out;
      return;
    }
    case 'getpath': {
      const p = jqFirst(A(0), input, env);
      yield p.reduce((o, k) => (o == null ? null : o[k] ?? null), input);
      return;
    }
    case 'setpath':
      yield jqSetPath(input, jqFirst(A(0), input, env), jqFirst(A(1), input, env));
      return;
    case 'del': {
      const paths = jqPaths(A(0), input, env).sort((a, b) => jqCmp(b, a));
      let out = structuredClone(input);
      for (const p of paths) {
        const parent = p.slice(0, -1).reduce((o, k) => (o == null ? null : o[k]), out);
        if (parent == null) continue;
        const k = p[p.length - 1];
        if (Array.isArray(parent)) parent.splice(k, 1);
        else delete parent[k];
      }
      yield out;
      return;
    }
    case 'to_array':
      yield Array.isArray(input) ? input : [input];
      return;
    case 'tostream':
    case 'input':
    case 'inputs':
    case 'debug':
    case 'stderr':
      yield input;
      return;
    case 'error':
      throw new JqError(e.args.length ? String(jqFirst(A(0), input, env)) : JSON.stringify(input));
    case 'null':
      yield null;
      return;
    case 'true':
      yield true;
      return;
    case 'false':
      yield false;
      return;
    case 'now':
      yield Date.now() / 1000;
      return;
    case 'todate':
    case 'todateiso8601':
      yield new Date(input * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
      return;
    case 'fromdate':
    case 'fromdateiso8601':
      yield Date.parse(input) / 1000;
      return;
    case 'splits':
      yield* input.split(new RegExp(jqFirst(A(0), input, env)));
      return;
    case 'isnan':
      yield Number.isNaN(input);
      return;
    case 'infinite':
      yield Infinity;
      return;
    case 'nan':
      yield NaN;
      return;
    case 'halt':
      return;
    case 'input_line_number':
      yield 0;
      return;
    case '@base64':
      yield btoa(input);
      return;
  }
  throw new JqError(`${e.name}/${e.args.length} is not defined`);
}

function jqFormat(v, { compact = false, raw = false, color = false, tab = false, indent = 2, sortKeys = false, asciiOut = false } = {}) {
  if (raw && typeof v === 'string') return v;
  const C = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const pad = (n) => (tab ? '\t'.repeat(n) : ' '.repeat(n * indent));
  const str = (s) => {
    let j = JSON.stringify(s);
    if (asciiOut) j = j.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return j;
  };
  const fmt = (x, d) => {
    if (x === null) return C('1;30', 'null');
    if (typeof x === 'boolean') return C('0;39', String(x));
    if (typeof x === 'number') return C('0;39', Number.isInteger(x) || !isFinite(x) ? (isFinite(x) ? String(x) : x > 0 ? '1.7976931348623157e+308' : '-1.7976931348623157e+308') : String(x));
    if (typeof x === 'string') return C('0;32', str(x));
    if (Array.isArray(x)) {
      if (!x.length) return C('1;39', '[]');
      if (compact) return C('1;39', '[') + x.map((y) => fmt(y, d + 1)).join(C('1;39', ',')) + C('1;39', ']');
      return C('1;39', '[') + '\n' + x.map((y) => pad(d + 1) + fmt(y, d + 1)).join(C('1;39', ',') + '\n') + '\n' + pad(d) + C('1;39', ']');
    }
    let keys = Object.keys(x);
    if (sortKeys) keys = keys.sort();
    if (!keys.length) return C('1;39', '{}');
    const kv = (k) => C('34;1', str(k)) + C('1;39', ':') + (compact ? '' : ' ') + fmt(x[k], d + 1);
    if (compact) return C('1;39', '{') + keys.map(kv).join(C('1;39', ',')) + C('1;39', '}');
    return C('1;39', '{') + '\n' + keys.map((k) => pad(d + 1) + kv(k)).join(C('1;39', ',') + '\n') + '\n' + pad(d) + C('1;39', '}');
  };
  return fmt(v, 0);
}

function parseJsonStream(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    // find the end of one JSON value
    let depth = 0;
    let inStr = false;
    let j = i;
    const start = text[i];
    if (start === '{' || start === '[') {
      for (; j < n; j++) {
        const c = text[j];
        if (inStr) {
          if (c === '\\') j++;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
    } else if (start === '"') {
      j++;
      for (; j < n; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '"') {
          j++;
          break;
        }
      }
    } else {
      while (j < n && !/[\s{}[\]"]/.test(text[j])) j++;
    }
    const piece = text.slice(i, j);
    try {
      out.push(JSON.parse(piece));
    } catch (e) {
      throw new JqError(`Invalid JSON text: ${piece.slice(0, 40)}`);
    }
    i = j;
  }
  return out;
}

async function jq(ctx) {
  const args = ctx.args.slice();
  const opts = { compact: false, raw: false, nullIn: false, slurp: false, join: false, exit: false, tab: false, indent: 2, sortKeys: false, color: null, rawIn: false, ascii: false };
  const vars = {};
  let filter = null;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--arg') {
      vars['$' + args[i + 1]] = args[i + 2];
      i += 2;
    } else if (a === '--argjson') {
      try {
        vars['$' + args[i + 1]] = JSON.parse(args[i + 2]);
      } catch {
        await ctx.err(`jq: Invalid JSON text passed to --argjson\n`);
        return 2;
      }
      i += 2;
    } else if (a === '--tab') opts.tab = true;
    else if (a === '--indent') opts.indent = Number(args[++i]);
    else if (a === '--version') {
      await ctx.out('jq-1.7.1\n');
      return 0;
    } else if (a.startsWith('--')) {
      const m = { '--compact-output': 'compact', '--raw-output': 'raw', '--null-input': 'nullIn', '--slurp': 'slurp', '--join-output': 'join', '--exit-status': 'exit', '--sort-keys': 'sortKeys', '--color-output': 'color', '--monochrome-output': 'mono', '--raw-input': 'rawIn', '--ascii-output': 'ascii' }[a];
      if (!m) {
        await ctx.err(`jq: Unknown option: ${a}\n`);
        return 2;
      }
      if (m === 'mono') opts.color = false;
      else opts[m] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) {
        const m = { c: 'compact', r: 'raw', n: 'nullIn', s: 'slurp', j: 'join', e: 'exit', S: 'sortKeys', C: 'color', R: 'rawIn', a: 'ascii' }[c];
        if (c === 'M') opts.color = false;
        else if (m) opts[m] = true;
        else {
          await ctx.err(`jq: Unknown option: -${c}\n`);
          return 2;
        }
      }
    } else if (filter === null) filter = a;
    else files.push(a);
  }
  if (opts.join) opts.raw = true;
  if (filter === null) {
    await ctx.err('Usage:\tjq [OPTIONS] FILTER [FILES...]\n\tjq [OPTIONS] --args FILTER [ARGUMENTS...]\n\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\n');
    return 2;
  }
  if (opts.color === null) opts.color = !!ctx.stdout.isTerminalWriter;
  let ast;
  try {
    ast = jqParse(filter);
  } catch (e) {
    await ctx.err(`jq: error: ${e.message}\njq: 1 compile error\n`);
    return 3;
  }
  const text = await readInput(ctx, files);
  if (ctx.failed) return 2;
  let inputs;
  try {
    if (opts.rawIn) inputs = opts.slurp ? [text] : splitLines(text);
    else inputs = parseJsonStream(text);
  } catch (e) {
    await ctx.err(`jq: error (at <stdin>:${text.split('\n').length}): ${e.message}\n`);
    return 2;
  }
  if (opts.slurp && !opts.rawIn) inputs = [inputs];
  if (opts.nullIn) inputs = [null];
  const env = { ...vars, $ENV: ctx.env, $__prog_args: [] };
  let last = undefined;
  let out = '';
  try {
    for (const input of inputs) {
      for (const v of jqEval(ast, input, env)) {
        last = v;
        out += jqFormat(v, { compact: opts.compact, raw: opts.raw, color: opts.color, tab: opts.tab, indent: opts.indent, sortKeys: opts.sortKeys, asciiOut: opts.ascii }) + (opts.join ? '' : '\n');
        if (out.length > 65536) {
          await ctx.out(out);
          out = '';
        }
      }
    }
  } catch (e) {
    await ctx.out(out);
    if (e instanceof JqError || e instanceof TypeError) {
      await ctx.err(`jq: error (at <stdin>:${text.split('\n').length - 1}): ${e.message}\n`);
      return 5;
    }
    throw e;
  }
  await ctx.out(out);
  if (opts.exit) return last === undefined ? 4 : last === null || last === false ? 1 : 0;
  return 0;
}

export function install(reg) {
  reg.set('cowsay', ext(cowsay, { pkg: 'cowsay' }));
  reg.set('cowthink', ext(cowsay, { pkg: 'cowsay' }));
  reg.set('fortune', ext(fortune, { pkg: 'fortune-mod' }));
  reg.set('figlet', ext(figlet, { pkg: 'figlet' }));
  reg.set('lolcat', ext(lolcat, { pkg: 'lolcat' }));
  reg.set('neofetch', ext(neofetch, { pkg: 'neofetch' }));
  reg.set('jq', ext(jq, { pkg: 'jq' }));
}

void UsageError;
