// System commands: date, cal, sleep, uname, id, ps, kill helpers, env, sudo, su,
// user management, xargs, timeout, watch, sh/bash, bc, network and package simulations.

import { getopt, cmd, UsageError, inputs, readInput, splitLines, humanSize, abspath, strWidth } from '../util.js';
import { FsError } from '../vfs.js';
import { ExitEx, InterruptEx, ReturnEx, SIGNALS } from '../shell.js';
import { ShellError } from '../expand.js';
import { StringReader, CollectWriter, EmptyReader } from '../streams.js';

const ext = (fn, help) => ({ fn: cmd(fn, { help }), help });

// ---------- date ----------

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function tzParts(d, tz) {
  if (!tz || tz === 'local') {
    const off = -d.getTimezoneOffset();
    let abbr = 'UTC';
    try {
      const n = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName');
      if (n) abbr = n.value;
    } catch {}
    if (off === 0) abbr = 'UTC';
    return { Y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), H: d.getHours(), M: d.getMinutes(), S: d.getSeconds(), ms: d.getMilliseconds(), w: d.getDay(), off, abbr: abbr.replace(/^GMT$/, 'UTC') };
  }
  if (tz === 'UTC' || tz === 'UTC0' || tz === 'GMT' || tz === 'Etc/UTC' || tz === ':UTC') {
    return { Y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), w: d.getUTCDay(), off: 0, abbr: tz === 'GMT' ? 'GMT' : 'UTC' };
  }
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz.replace(/^:/, ''), year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hour12: false, timeZoneName: 'short' });
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    const H = Number(p.hour) % 24;
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), H, Number(p.minute), Number(p.second));
    const off = Math.round((asUtc - (d.getTime() - d.getMilliseconds())) / 60000);
    return { Y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day), H, M: Number(p.minute), S: Number(p.second), ms: d.getMilliseconds(), w: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), off, abbr: p.timeZoneName };
  } catch {
    return tzParts(d, 'UTC');
  }
}

function isoWeek(Y, m, d) {
  const date = new Date(Date.UTC(Y, m, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7), year: date.getUTCFullYear() };
}

export function strftime(d, fmt, utc = false, tz = null) {
  const t = tzParts(d, utc ? 'UTC' : tz);
  const doy = Math.floor((Date.UTC(t.Y, t.m, t.d) - Date.UTC(t.Y, 0, 1)) / 86400000) + 1;
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    let flag = '';
    let j = i + 1;
    while ('-_0^#'.includes(fmt[j]) && fmt[j]) flag += fmt[j++];
    let width = '';
    while (/\d/.test(fmt[j] || '')) width += fmt[j++];
    let colons = '';
    while (fmt[j] === ':') colons += fmt[j++];
    const k = fmt[j];
    i = j;
    const num = (v, w, padc = '0') => {
      let s = String(v);
      const W = width ? Number(width) : w;
      if (flag.includes('-')) return s;
      const pc = flag.includes('_') ? ' ' : flag.includes('0') ? '0' : padc;
      return s.padStart(W, pc);
    };
    const txt = (s) => {
      if (flag.includes('^')) s = s.toUpperCase();
      if (flag.includes('#')) s = s === s.toUpperCase() ? s.toLowerCase() : s.toUpperCase();
      return width ? s.padStart(Number(width)) : s;
    };
    const offStr = () => {
      const sign = t.off >= 0 ? '+' : '-';
      const a = Math.abs(t.off);
      const hh = String(Math.floor(a / 60)).padStart(2, '0');
      const mm = String(a % 60).padStart(2, '0');
      if (colons === ':') return `${sign}${hh}:${mm}`;
      if (colons === '::') return `${sign}${hh}:${mm}:00`;
      return `${sign}${hh}${mm}`;
    };
    switch (k) {
      case 'a': out += txt(DAYS[t.w].slice(0, 3)); break;
      case 'A': out += txt(DAYS[t.w]); break;
      case 'b':
      case 'h': out += txt(MONTHS[t.m].slice(0, 3)); break;
      case 'B': out += txt(MONTHS[t.m]); break;
      case 'c': out += strftime(d, '%a %b %e %H:%M:%S %Y', utc, tz); break;
      case 'C': out += num(Math.floor(t.Y / 100), 2); break;
      case 'd': out += num(t.d, 2); break;
      case 'D': out += strftime(d, '%m/%d/%y', utc, tz); break;
      case 'e': out += num(t.d, 2, ' '); break;
      case 'F': out += strftime(d, '%Y-%m-%d', utc, tz); break;
      case 'g': out += num(isoWeek(t.Y, t.m, t.d).year % 100, 2); break;
      case 'G': out += num(isoWeek(t.Y, t.m, t.d).year, 4); break;
      case 'H': out += num(t.H, 2); break;
      case 'I': out += num(t.H % 12 || 12, 2); break;
      case 'j': out += num(doy, 3); break;
      case 'k': out += num(t.H, 2, ' '); break;
      case 'l': out += num(t.H % 12 || 12, 2, ' '); break;
      case 'm': out += num(t.m + 1, 2); break;
      case 'M': out += num(t.M, 2); break;
      case 'n': out += '\n'; break;
      case 'N': out += String(t.ms * 1000000 + Math.floor(Math.random() * 1000000)).padStart(9, '0').slice(0, width ? Number(width) : 9); break;
      case 'p': out += txt(t.H < 12 ? 'AM' : 'PM'); break;
      case 'P': out += t.H < 12 ? 'am' : 'pm'; break;
      case 'q': out += num(Math.floor(t.m / 3) + 1, 1); break;
      case 'r': out += strftime(d, '%I:%M:%S %p', utc, tz); break;
      case 'R': out += strftime(d, '%H:%M', utc, tz); break;
      case 's': out += String(Math.floor(d.getTime() / 1000)); break;
      case 'S': out += num(t.S, 2); break;
      case 't': out += '\t'; break;
      case 'T': out += strftime(d, '%H:%M:%S', utc, tz); break;
      case 'u': out += String(t.w || 7); break;
      case 'U': out += num(Math.floor((doy + 6 - t.w) / 7), 2); break;
      case 'V': out += num(isoWeek(t.Y, t.m, t.d).week, 2); break;
      case 'w': out += String(t.w); break;
      case 'W': out += num(Math.floor((doy + 6 - ((t.w + 6) % 7)) / 7), 2); break;
      case 'x': out += strftime(d, '%m/%d/%y', utc, tz); break;
      case 'X': out += strftime(d, '%H:%M:%S', utc, tz); break;
      case 'y': out += num(t.Y % 100, 2); break;
      case 'Y': out += num(t.Y, 4); break;
      case 'z': out += offStr(); break;
      case 'Z': out += txt(t.abbr); break;
      case '%': out += '%'; break;
      case '+': out += strftime(d, '%a %b %e %H:%M:%S %Z %Y', utc, tz); break;
      default: out += '%' + flag + width + colons + (k ?? '');
    }
  }
  return out;
}

export function parseDate(s, now = Date.now()) {
  s = s.trim();
  if (s === '' || s === 'now' || s === 'today') return now;
  if (s.startsWith('@')) {
    const v = Number(s.slice(1));
    return isNaN(v) ? null : v * 1000;
  }
  if (s === 'yesterday') return now - 86400e3;
  if (s === 'tomorrow') return now + 86400e3;
  if (s === 'noon' || s === 'midnight') {
    const d = new Date(now);
    d.setHours(s === 'noon' ? 12 : 0, 0, 0, 0);
    return d.getTime();
  }
  const units = { sec: 1, second: 1, min: 60, minute: 60, hour: 3600, day: 86400, week: 604800, fortnight: 1209600, month: 2592000, year: 31536000 };
  let m = /^(.*?)\s*([+-]?\s*\d+)?\s*(sec|second|min|minute|hour|day|week|fortnight|month|year)s?(\s+ago)?$/i.exec(s);
  if (m && (m[2] !== undefined || /^(next|last)$/i.test(m[1]))) {
    let n = m[2] !== undefined ? Number(m[2].replace(/\s/g, '')) : /next/i.test(m[1]) ? 1 : -1;
    if (m[4]) n = -n;
    const base = m[1] && !/^(next|last)$/i.test(m[1]) ? parseDate(m[1], now) : now;
    if (base === null) return null;
    const unit = m[3].toLowerCase();
    const d = new Date(base);
    if (unit === 'month') {
      d.setMonth(d.getMonth() + n);
      return d.getTime();
    }
    if (unit === 'year') {
      d.setFullYear(d.getFullYear() + n);
      return d.getTime();
    }
    return base + n * units[unit] * 1000;
  }
  m = /^(next|last|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)$/i.exec(s);
  if (m) {
    const target = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[2].slice(0, 3).toLowerCase());
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    let diff = (target - d.getDay() + 7) % 7;
    if (m[1] && m[1].toLowerCase() === 'last') diff = diff === 0 ? -7 : diff - 7;
    else if (m[1] && m[1].toLowerCase() === 'next' && diff === 0) diff = 7;
    return d.getTime() + diff * 86400e3;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const [Y, Mo, D, H = 0, Mi = 0, S = 0] = m.slice(1, 7).map((x) => Number(x || 0));
    if (m[7]) {
      let off = 0;
      if (!/^(Z|UTC)$/i.test(m[7])) {
        const z = m[7].replace(':', '');
        off = (Number(z.slice(1, 3)) * 60 + Number(z.slice(3))) * (z[0] === '-' ? -1 : 1);
      }
      return Date.UTC(Y, Mo - 1, D, H, Mi, S) - off * 60000;
    }
    return new Date(Y, Mo - 1, D, H, Mi, S).getTime();
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(s);
  if (m) {
    const d = new Date(now);
    let H = Number(m[1]);
    if (m[4] && /pm/i.test(m[4]) && H < 12) H += 12;
    if (m[4] && /am/i.test(m[4]) && H === 12) H = 0;
    d.setHours(H, Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

async function date(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'uRI',
    params: 'drsf',
    long: { utc: 'u', universal: 'u', date: 'd', reference: 'r', set: 's', 'rfc-email': 'R', 'iso-8601': '?', 'rfc-3339': '=', file: 'f', debug: '' },
  });
  const tz = ctx.shell.getVar('TZ') || null;
  let t = Date.now();
  if (o.s) {
    await ctx.err(`date: cannot set date: Operation not permitted\n`);
    return 1;
  }
  if (o.d !== undefined) {
    const v = parseDate(o.d);
    if (v === null) {
      await ctx.err(`date: invalid date '${o.d}'\n`);
      return 1;
    }
    t = v;
  }
  if (o.r) {
    try {
      t = ctx.vfs.stat(o.r, ctx.cwd).mtime;
    } catch (e) {
      await ctx.err(`date: ${o.r}: ${e.message}\n`);
      return 1;
    }
  }
  const d = new Date(t);
  let fmt = '%a %b %e %H:%M:%S %Z %Y';
  const plus = rest.find((r) => r.startsWith('+'));
  if (rest.length && !plus) {
    await ctx.err(`date: invalid date '${rest[0]}'\n`);
    return 1;
  }
  if (plus) fmt = plus.slice(1);
  else if (o.R) fmt = '%a, %d %b %Y %H:%M:%S %z';
  else if (o.I || o['iso-8601'] !== undefined) {
    const k = o['iso-8601'] === true || o['iso-8601'] === undefined ? 'date' : o['iso-8601'];
    fmt = { date: '%F', hours: '%FT%H%:z', minutes: '%FT%H:%M%:z', seconds: '%FT%T%:z', ns: '%FT%T,%N%:z' }[k] || '%F';
  } else if (o['rfc-3339']) fmt = { date: '%F', seconds: '%F %T%:z', ns: '%F %T.%N%:z' }[o['rfc-3339']] || '%F %T%:z';
  if (o.f) {
    for (const line of splitLines(ctx.vfs.readFile(o.f, ctx.cwd))) {
      const v = parseDate(line);
      await ctx.out(v === null ? `date: invalid date '${line}'\n` : strftime(new Date(v), fmt, !!o.u, tz) + '\n');
    }
    return 0;
  }
  await ctx.out(strftime(d, fmt, !!o.u, tz) + '\n');
  return 0;
}

// ---------- cal ----------

function monthLines(Y, M, today, highlight, mondayFirst = false) {
  const title = `${MONTHS[M]} ${Y}`;
  const lines = [title.padStart(Math.floor((20 + title.length) / 2)).padEnd(20)];
  lines.push(mondayFirst ? 'Mo Tu We Th Fr Sa Su' : 'Su Mo Tu We Th Fr Sa');
  const first = new Date(Y, M, 1).getDay();
  const offset = mondayFirst ? (first + 6) % 7 : first;
  const days = new Date(Y, M + 1, 0).getDate();
  let row = '   '.repeat(offset);
  let col = offset;
  for (let dd = 1; dd <= days; dd++) {
    let s = String(dd).padStart(2);
    if (highlight && today && today.y === Y && today.m === M && today.d === dd) s = `\x1b[7m${s}\x1b[27m`;
    row += s + (col === 6 ? '' : ' ');
    col++;
    if (col === 7) {
      lines.push(row);
      row = '';
      col = 0;
    }
  }
  if (row) lines.push(row);
  while (lines.length < 8) lines.push('');
  return lines.map((l) => l + ' '.repeat(Math.max(0, 20 - l.replace(/\x1b\[\d+m/g, '').length)));
}

async function cal(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: '3ymjsh', params: 'AB', long: { year: 'y', three: '3', monday: 'm', sunday: 's' } });
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth(), d: now.getDate() };
  const hl = !!ctx.stdout.isTerminalWriter && !o.h;
  let Y = today.y;
  let M = today.m;
  const monthNames = MONTHS.map((x) => x.toLowerCase());
  if (rest.length === 1) {
    if (/^\d+$/.test(rest[0])) {
      Y = Number(rest[0]);
      o.y = true;
    } else {
      const k = monthNames.findIndex((x) => x.startsWith(rest[0].toLowerCase()));
      if (k < 0) throw new UsageError(`${rest[0]} is neither a month number (1..12) nor a name`, 1, false);
      M = k;
    }
  } else if (rest.length >= 2) {
    M = /^\d+$/.test(rest[0]) ? Number(rest[0]) - 1 : monthNames.findIndex((x) => x.startsWith(rest[0].toLowerCase()));
    Y = Number(rest[1]);
    if (M < 0 || M > 11) throw new UsageError(`${rest[0]} is neither a month number (1..12) nor a name`, 1, false);
  }
  let out = '';
  const join = (blocks) => {
    const h = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < h; i++) out += blocks.map((b) => b[i] ?? ' '.repeat(20)).join('  ') + '  \n';
  };
  if (o.y) {
    out += String(Y).padStart(32).padEnd(64) + '\n';
    for (let q = 0; q < 12; q += 3) {
      const blocks = [q, q + 1, q + 2].map((mm) => {
        const l = monthLines(Y, mm, today, hl, o.m);
        l[0] = MONTHS[mm].padStart(Math.floor((20 + MONTHS[mm].length) / 2)).padEnd(20);
        return l;
      });
      join(blocks);
    }
  } else if (o['3']) {
    const ms = [-1, 0, 1].map((k) => {
      const dt = new Date(Y, M + k, 1);
      return monthLines(dt.getFullYear(), dt.getMonth(), today, hl, o.m);
    });
    join(ms);
  } else join([monthLines(Y, M, today, hl, o.m)]);
  await ctx.out(out);
  return 0;
}

// ---------- sleep / timeout / watch ----------

function parseDuration(s) {
  const m = /^(\d*\.?\d+)([smhd]?)$/.exec(s);
  if (!m) return null;
  return parseFloat(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

async function sleep(ctx) {
  if (!ctx.args.length) throw new UsageError('missing operand');
  let total = 0;
  for (const a of ctx.args) {
    if (a === 'infinity' || a === 'inf') {
      total = Infinity;
      continue;
    }
    const v = parseDuration(a);
    if (v === null) throw new UsageError(`invalid time interval '${a}'`);
    total += v;
  }
  if (total === Infinity) total = 1e9;
  await ctx.shell.sleep(total * 1000);
  return 0;
}

async function timeout(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'pv', params: 'sk', long: { signal: 's', 'kill-after': 'k', 'preserve-status': 'p', foreground: '', verbose: 'v' }, stopAtOperand: true });
  if (rest.length < 2) throw new UsageError(rest.length ? `missing operand after '${rest[0]}'` : 'missing operand', 125);
  const dur = parseDuration(rest[0]);
  if (dur === null) throw new UsageError(`invalid time interval '${rest[0]}'`, 125);
  const sh = ctx.shell.subshell();
  sh.ctl = { interrupted: false, waiters: new Set() };
  const parentInt = () => sh.interrupt('INT');
  ctx.shell.ctl.onInterrupt = ctx.shell.ctl.onInterrupt || new Set();
  ctx.shell.ctl.onInterrupt.add(parentInt);
  let timedOut = false;
  const timer = dur > 0 ? setTimeout(() => {
    timedOut = true;
    sh.interrupt(o.s ? o.s.replace(/^SIG/i, '').toUpperCase() : 'TERM');
  }, dur * 1000) : null;
  let st;
  try {
    st = await sh.runCommand(rest.slice(1), ctx.io, { skipFunctions: true });
  } catch (e) {
    if (e instanceof InterruptEx) st = 128 + SIGNALS.indexOf(e.sig);
    else if (e instanceof ExitEx) st = e.code;
    else throw e;
  } finally {
    clearTimeout(timer);
    ctx.shell.ctl.onInterrupt.delete(parentInt);
  }
  if (timedOut) {
    if (o.v) await ctx.err(`timeout: sending signal ${o.s || 'TERM'} to command '${rest[1]}'\n`);
    return o.p ? st : 124;
  }
  return st;
}

async function watch(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'tdebgx', params: 'n', long: { interval: 'n', 'no-title': 't', differences: 'd', errexit: 'e', beep: 'b', chgexit: 'g', exec: 'x' }, stopAtOperand: true });
  if (!rest.length) throw new UsageError('', 1);
  const interval = Math.max(0.1, parseFloat(o.n || '2'));
  const cmdline = rest.join(' ');
  const term = ctx.shell.term;
  let prev = null;
  try {
    if (term) await ctx.out('\x1b[?1049h\x1b[?25l');
    for (;;) {
      const w = new CollectWriter();
      const sh = ctx.shell.subshell();
      try {
        await sh.runSource(o.x ? rest.map((x) => sh.quoteValue(x)).join(' ') : cmdline, { 0: new EmptyReader(), 1: w, 2: w });
      } catch (e) {
        if (!(e instanceof ExitEx)) throw e;
      }
      const text = w.text;
      let screen = '\x1b[H\x1b[2J';
      if (!o.t) {
        const left = `Every ${interval.toFixed(1)}s: ${cmdline}`;
        const right = `${ctx.shell.system.hostname}: ${strftime(new Date(), '%a %b %e %H:%M:%S %Y')}`;
        const cols = term ? term.cols : 80;
        screen += left + ' '.repeat(Math.max(1, cols - left.length - right.length)) + right + '\n\n';
      }
      screen += text;
      await ctx.out(screen.replace(/\n/g, '\n'));
      if (o.g && prev !== null && prev !== text) break;
      prev = text;
      await ctx.shell.sleep(interval * 1000);
    }
  } catch (e) {
    if (!(e instanceof InterruptEx)) throw e;
    ctx.shell.ctl.interrupted = false;
  } finally {
    if (term) await ctx.out('\x1b[?25h\x1b[?1049l');
  }
  return 0;
}

// ---------- system info ----------

async function uname(ctx) {
  const { o } = getopt(ctx.args, { flags: 'asnrvmpio', long: { all: 'a', 'kernel-name': 's', nodename: 'n', 'kernel-release': 'r', 'kernel-version': 'v', machine: 'm', processor: 'p', 'hardware-platform': 'i', 'operating-system': 'o' } });
  const sys = ctx.shell.system;
  const f = {
    s: 'Linux', n: sys.hostname, r: sys.kernel, v: '#48-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep 27 14:04:52 UTC 2024',
    m: 'x86_64', p: 'x86_64', i: 'x86_64', o: 'GNU/Linux',
  };
  let keys = o.a ? ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'] : ['s', 'n', 'r', 'v', 'm', 'p', 'i', 'o'].filter((k) => o[k]);
  if (!keys.length) keys = ['s'];
  await ctx.out(keys.map((k) => f[k]).join(' ') + '\n');
  return 0;
}

async function hostname(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'IifsdAaFvy', long: { 'all-ip-addresses': 'I', 'ip-address': 'i', fqdn: 'f', short: 's', domain: 'd', long: 'f' } });
  const sys = ctx.shell.system;
  if (rest.length) {
    if (ctx.vfs.cred.uid !== 0) {
      await ctx.err('hostname: you must be root to change the host name\n');
      return 1;
    }
    sys.hostname = rest[0];
    ctx.vfs.writeFile('/etc/hostname', '/', rest[0] + '\n');
    return 0;
  }
  if (o.I) await ctx.out('10.0.2.15 \n');
  else if (o.i) await ctx.out('127.0.1.1\n');
  else if (o.f) await ctx.out(sys.hostname + '.localdomain\n');
  else if (o.d) await ctx.out('localdomain\n');
  else await ctx.out(sys.hostname + '\n');
  return 0;
}

async function whoami(ctx) {
  await ctx.out(ctx.shell.system.userName(ctx.vfs.cred.uid) + '\n');
  return 0;
}

async function id(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'ugGnrz', long: { user: 'u', group: 'g', groups: 'G', name: 'n', real: 'r', zero: 'z' } });
  const sys = ctx.shell.system;
  let u;
  if (rest.length) {
    u = sys.userByName(rest[0]) || (/^\d+$/.test(rest[0]) ? sys.userById(Number(rest[0])) : null);
    if (!u) {
      await ctx.err(`id: '${rest[0]}': no such user\n`);
      return 1;
    }
  } else u = sys.userById(ctx.vfs.cred.uid) || { name: String(ctx.vfs.cred.uid), uid: ctx.vfs.cred.uid, gid: ctx.vfs.cred.gid };
  const groups = rest.length || ctx.vfs.cred.uid !== ctx.shell.user.uid ? sys.groupsOf(u.name) : ctx.vfs.cred.groups;
  if (o.u) await ctx.out((o.n ? u.name : u.uid) + '\n');
  else if (o.g) await ctx.out((o.n ? sys.groupName(u.gid) : u.gid) + '\n');
  else if (o.G) await ctx.out(groups.map((g) => (o.n ? sys.groupName(g) : g)).join(' ') + '\n');
  else await ctx.out(`uid=${u.uid}(${u.name}) gid=${u.gid}(${sys.groupName(u.gid)}) groups=${groups.map((g) => `${g}(${sys.groupName(g)})`).join(',')}\n`);
  return 0;
}

async function groups(ctx) {
  const sys = ctx.shell.system;
  if (!ctx.args.length) {
    await ctx.out(ctx.vfs.cred.groups.map((g) => sys.groupName(g)).join(' ') + '\n');
    return 0;
  }
  for (const n of ctx.args) {
    if (!sys.userByName(n)) {
      await ctx.err(`groups: '${n}': no such user\n`);
      return 1;
    }
    await ctx.out(`${n} : ${sys.groupsOf(n).map((g) => sys.groupName(g)).join(' ')}\n`);
  }
  return 0;
}

function loginTime(sys) {
  return new Date(sys.boot + 180000);
}

async function who(ctx) {
  const sys = ctx.shell.system;
  const { o } = getopt(ctx.args, { flags: 'abHqrmuT', long: { boot: 'b', heading: 'H', count: 'q', runlevel: 'r' } });
  const t = strftime(loginTime(sys), '%Y-%m-%d %H:%M');
  if (o.b) {
    await ctx.out(`         system boot  ${strftime(new Date(sys.boot), '%Y-%m-%d %H:%M')}\n`);
    return 0;
  }
  if (o.r) {
    await ctx.out(`         run-level 5  ${strftime(new Date(sys.boot), '%Y-%m-%d %H:%M')}\n`);
    return 0;
  }
  if (o.q) {
    await ctx.out(`${ctx.shell.user.name}\n# users=1\n`);
    return 0;
  }
  if (o.H) await ctx.out('NAME     LINE         TIME             COMMENT\n');
  await ctx.out(`${ctx.shell.user.name.padEnd(8)} pts/0        ${t} (192.168.1.10)\n`);
  return 0;
}

async function w(ctx) {
  const sys = ctx.shell.system;
  const up = await uptimeString(sys);
  await ctx.out(` ${up}\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n${ctx.shell.user.name.padEnd(8)} pts/0    192.168.1.10     ${strftime(loginTime(sys), '%H:%M')}    0.00s  0.04s  0.00s w\n`);
  return 0;
}

async function uptimeString(sys) {
  const s = sys.uptimeSeconds();
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const now = strftime(new Date(), '%H:%M:%S');
  const upStr = (days ? `${days} day${days > 1 ? 's' : ''}, ` : '') + (h ? `${String(h).padStart(2)}:${String(m).padStart(2, '0')}` : `${m} min`);
  const l = [0.08 + Math.random() * 0.1, 0.05 + Math.random() * 0.05, 0.01 + Math.random() * 0.03].map((x) => x.toFixed(2));
  return `${now} up ${upStr},  1 user,  load average: ${l.join(', ')}`;
}

async function uptime(ctx) {
  const { o } = getopt(ctx.args, { flags: 'ps', long: { pretty: 'p', since: 's' } });
  const sys = ctx.shell.system;
  if (o.s) {
    await ctx.out(strftime(new Date(sys.boot), '%F %T') + '\n');
    return 0;
  }
  if (o.p) {
    const s = sys.uptimeSeconds();
    const parts = [];
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) parts.push(`${d} day${d > 1 ? 's' : ''}`);
    if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
    parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
    await ctx.out(`up ${parts.join(', ')}\n`);
    return 0;
  }
  await ctx.out(' ' + (await uptimeString(sys)) + '\n');
  return 0;
}

async function users(ctx) {
  await ctx.out(ctx.shell.user.name + '\n');
  return 0;
}

async function last(ctx) {
  const sys = ctx.shell.system;
  const u = ctx.shell.user.name;
  const t = (d) => strftime(d, '%a %b %e %H:%M');
  await ctx.out(`${u.padEnd(8)} pts/0        192.168.1.10     ${t(loginTime(sys))}   still logged in\n${u.padEnd(8)} pts/0        192.168.1.10     ${t(new Date(sys.boot - 86400e3 * 2))} - ${strftime(new Date(sys.boot - 86400e3 * 2 + 5400e3), '%H:%M')}  (01:30)\nreboot   system boot  ${sys.kernel.padEnd(16)} ${t(new Date(sys.boot))}   still running\n\nwtmp begins ${t(new Date(sys.boot - 86400e3 * 30))} 2026\n`);
  return 0;
}

function procList(ctx) {
  const sys = ctx.shell.system;
  const list = [...sys.procs.values()];
  const me = ctx.proc;
  // the shell and current command
  const shellPid = ctx.shell.rootPid;
  if (!sys.procs.has(shellPid)) list.push({ pid: shellPid, ppid: 951, user: ctx.shell.user.name, cmd: '-bash', tty: 'pts/0', start: sys.boot + 200000 });
  if (me && !list.includes(me)) list.push(me);
  return list.sort((a, b) => a.pid - b.pid);
}

async function ps(ctx) {
  let args = ctx.args.slice();
  // BSD style: ps aux
  let bsd = false;
  if (args[0] && !args[0].startsWith('-') && /^[auxwefjlr]+$/.test(args[0])) {
    bsd = true;
    args = ['-' + args[0], ...args.slice(1)];
  }
  const { o } = getopt(args, { flags: 'eAfFlauxjwHr', params: 'opCUuqt', long: { forest: '', sort: '=', format: 'o', pid: 'p', user: 'u', 'no-headers': '' } });
  const sys = ctx.shell.system;
  let list = procList(ctx);
  const all = o.e || o.A || (bsd && o.a && o.x) || (bsd && o.x);
  const meName = ctx.shell.system.userName(ctx.vfs.cred.uid);
  if (!all) {
    if (bsd && o.a) list = list.filter((p) => p.tty !== '?');
    else list = list.filter((p) => p.tty === 'pts/0' && (p.user === meName || p.user === ctx.shell.user.name));
  }
  if (o.p) list = list.filter((p) => o.p.split(',').map(Number).includes(p.pid));
  if (o.C) list = list.filter((p) => p.cmd.split(' ')[0].split('/').pop() === o.C);
  if (o.U || (o.u && !bsd)) list = list.filter((p) => p.user === (o.U || o.u));
  const elapsed = (p) => {
    const s = Math.floor((Date.now() - p.start) / 1000);
    return `00:00:${String(Math.min(59, Math.floor(s / 600))).padStart(2, '0')}`;
  };
  const stime = (p) => strftime(new Date(p.start), Date.now() - p.start > 86400e3 ? '%b%d' : '%H:%M');
  const cmdName = (p) => (p.cmd.startsWith('[') ? p.cmd : p.cmd.split(' ')[0].split('/').pop());
  let out = '';
  if (o.o) {
    const cols = o.o.split(/[,\s]+/).filter(Boolean);
    const val = (p, c) => {
      const [k] = c.split('=');
      switch (k) {
        case 'pid': return String(p.pid);
        case 'ppid': return String(p.ppid);
        case 'user':
        case 'uname':
        case 'euser': return p.user;
        case 'uid': return String(sys.userByName(p.user)?.uid ?? 0);
        case 'comm':
        case 'ucomm': return cmdName(p);
        case 'cmd':
        case 'args':
        case 'command': return p.cmd;
        case 'tty':
        case 'tt': return p.tty;
        case '%cpu':
        case 'pcpu': return '0.0';
        case '%mem':
        case 'pmem': return '0.1';
        case 'stat': return p.pid === ctx.proc?.pid ? 'R+' : 'Ss';
        case 'etime': return '   ' + elapsed(p).slice(3);
        case 'time': return elapsed(p);
        case 'stime':
        case 'start': return stime(p);
        case 'rss': return String(4000 + (p.pid % 997) * 7);
        case 'vsz': return String(10000 + (p.pid % 991) * 31);
        case 'ni':
        case 'nice': return '0';
        case 'pri': return '19';
        default: return '-';
      }
    };
    const heads = cols.map((c) => (c.includes('=') ? c.split('=')[1] : c.toUpperCase().replace(/^ARGS$/, 'COMMAND').replace(/^COMM$/, 'COMMAND').replace(/^CMD$/, 'CMD').replace(/^UNAME$/, 'USER')));
    const rows = list.map((p) => cols.map((c) => val(p, c)));
    const widths = heads.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmtRow = (r) => r.map((x, i) => (i === r.length - 1 ? x : /^\d/.test(x) || x === '-' ? x.padStart(widths[i]) : x.padEnd(widths[i]))).join(' ');
    if (!o['no-headers'] && heads.some((h) => h)) out += fmtRow(heads) + '\n';
    for (const r of rows) out += fmtRow(r) + '\n';
  } else if (bsd && o.u) {
    out += 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n';
    for (const p of list) {
      out += `${p.user.slice(0, 8).padEnd(8)} ${String(p.pid).padStart(7)}  0.0  0.1 ${String(10000 + (p.pid % 991) * 31).padStart(6)} ${String(4000 + (p.pid % 997) * 7).padStart(5)} ${p.tty.padEnd(8)} ${(p === ctx.proc ? 'R+' : p.tty === '?' ? 'Ss' : 'Ss+').padEnd(4)} ${stime(p).padStart(5)}   0:00 ${p.cmd}\n`;
    }
  } else if (o.f || o.F) {
    out += 'UID          PID    PPID  C STIME TTY          TIME CMD\n';
    for (const p of list) out += `${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)}  0 ${stime(p)} ${p.tty.padEnd(8)} ${elapsed(p)} ${p.cmd}\n`;
  } else {
    out += '    PID TTY          TIME CMD\n';
    for (const p of list) out += `${String(p.pid).padStart(7)} ${p.tty.padEnd(8)} ${elapsed(p)} ${cmdName(p).replace(/^-/, '')}\n`;
  }
  await ctx.out(out);
  return 0;
}

async function pgrep(ctx) {
  const kill = ctx.name === 'pkill';
  const { o, rest } = getopt(ctx.args, { flags: 'lafxnovc', params: 'ud', long: { 'list-name': 'l', 'list-full': 'a', full: 'f', exact: 'x', newest: 'n', oldest: 'o', count: 'c' } });
  const pat = rest.find((r) => !r.startsWith('-'));
  let sig = 'TERM';
  for (const r of rest) if (/^-[A-Z0-9]+$/.test(r)) sig = r.slice(1);
  if (!pat) {
    await ctx.err(`${ctx.name}: no matching criteria specified\nTry \`${ctx.name} --help' for more information.\n`);
    return 2;
  }
  let re;
  try {
    re = new RegExp(o.x ? `^(?:${pat})$` : pat);
  } catch {
    await ctx.err(`${ctx.name}: invalid regex\n`);
    return 2;
  }
  let list = procList(ctx).filter((p) => p !== ctx.proc && re.test(o.f ? p.cmd : p.cmd.split(' ')[0].split('/').pop().replace(/^-/, '')));
  if (o.u) list = list.filter((p) => p.user === o.u);
  if (o.n) list = list.slice(-1);
  if (o.o) list = list.slice(0, 1);
  if (!list.length) return 1;
  if (o.c) {
    await ctx.out(list.length + '\n');
    return 0;
  }
  for (const p of list) {
    if (kill) {
      await ctx.shell.runCommand(['kill', '-' + sig, String(p.pid)], ctx.io, { skipFunctions: true });
      continue;
    }
    await ctx.out(o.a ? `${p.pid} ${p.cmd}\n` : o.l ? `${p.pid} ${p.cmd.split(' ')[0].split('/').pop()}\n` : `${p.pid}${o.d ? o.d : '\n'}`);
  }
  return 0;
}

async function killall(ctx) {
  const names = ctx.args.filter((a) => !a.startsWith('-'));
  let st = 0;
  for (const n of names) {
    const list = procList(ctx).filter((p) => p.cmd.split(' ')[0].split('/').pop() === n);
    if (!list.length) {
      await ctx.err(`${n}: no process found\n`);
      st = 1;
      continue;
    }
    for (const p of list) await ctx.shell.runCommand(['kill', String(p.pid)], ctx.io, { skipFunctions: true });
  }
  return st;
}

function memInfo(vfs) {
  const total = 16293800;
  const used = 2456320 + Math.floor(vfs.totalBytes() / 1024);
  const shared = 18432;
  const buff = 3145728;
  const free = total - used - buff;
  return { total, used, free, shared, buff, avail: total - used, swapTotal: 2097148, swapUsed: 0 };
}

async function free(ctx) {
  const { o } = getopt(ctx.args, { flags: 'hbkmgtwl', params: 'sc', long: { human: 'h', bytes: 'b', kibi: 'k', mebi: 'm', gibi: 'g', total: 't', wide: 'w', si: '' } });
  const m = memInfo(ctx.vfs);
  const f = (k) => {
    if (o.h) return humanSize(k * 1024, !!o.si).replace(/(\d)([KMGT])$/, '$1$2i').replace(/^(\d+)$/, '$1B');
    if (o.b) return String(k * 1024);
    if (o.m) return String(Math.floor(k / 1024));
    if (o.g) return String(Math.floor(k / 1048576));
    return String(k);
  };
  let out = '               total        used        free      shared  buff/cache   available\n';
  out += `Mem:   ${f(m.total).padStart(13)} ${f(m.used).padStart(11)} ${f(m.free).padStart(11)} ${f(m.shared).padStart(11)} ${f(m.buff).padStart(11)} ${f(m.avail).padStart(11)}\n`;
  out += `Swap:  ${f(m.swapTotal).padStart(13)} ${f(m.swapUsed).padStart(11)} ${f(m.swapTotal - m.swapUsed).padStart(11)}\n`;
  if (o.t) out += `Total: ${f(m.total + m.swapTotal).padStart(13)} ${f(m.used).padStart(11)} ${f(m.free + m.swapTotal).padStart(11)}\n`;
  await ctx.out(out);
  return 0;
}

async function vmstat(ctx) {
  const m = memInfo(ctx.vfs);
  await ctx.out(`procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n 1  0      0 ${String(m.free).padStart(6)} ${String(Math.floor(m.buff / 3)).padStart(6)} ${String(Math.floor((m.buff * 2) / 3)).padStart(6)}    0    0    12    20  110  190  1  1 98  0  0\n`);
  return 0;
}

async function nproc(ctx) {
  await ctx.out('4\n');
  return 0;
}

async function lscpu(ctx) {
  await ctx.out(`Architecture:             x86_64
  CPU op-mode(s):         32-bit, 64-bit
  Address sizes:          46 bits physical, 48 bits virtual
  Byte Order:             Little Endian
CPU(s):                   4
  On-line CPU(s) list:    0-3
Vendor ID:                GenuineIntel
  Model name:             Intel(R) Xeon(R) CPU @ 2.20GHz
    CPU family:           6
    Model:                79
    Thread(s) per core:   2
    Core(s) per socket:   2
    Socket(s):            1
    Stepping:             0
    BogoMIPS:             4400.36
Virtualization features:
  Hypervisor vendor:      KVM
  Virtualization type:    full
Caches (sum of all):
  L1d:                    64 KiB (2 instances)
  L1i:                    64 KiB (2 instances)
  L2:                     512 KiB (2 instances)
  L3:                     55 MiB (1 instance)
`);
  return 0;
}

// ---------- environment ----------

async function env(ctx) {
  const args = ctx.args.slice();
  let clear = false;
  const unset = [];
  let nul = false;
  while (args.length && args[0].startsWith('-') && args[0] !== '-') {
    const a = args.shift();
    if (a === '-i' || a === '--ignore-environment') clear = true;
    else if (a === '-u' || a === '--unset') unset.push(args.shift());
    else if (a.startsWith('--unset=')) unset.push(a.slice(8));
    else if (a === '-0' || a === '--null') nul = true;
    else if (a === '-C' || a === '--chdir') args.shift();
    else if (a === '-S' || a === '--split-string') {
      args.unshift(...args.shift().split(/\s+/));
    } else if (a === '--') break;
    else {
      await ctx.err(`env: invalid option -- '${a.slice(1)}'\nTry 'env --help' for more information.\n`);
      return 125;
    }
  }
  if (args[0] === '-') {
    clear = true;
    args.shift();
  }
  const vars = clear ? {} : { ...ctx.env };
  for (const u of unset) delete vars[u];
  while (args.length && /^[^=]+=/.test(args[0])) {
    const a = args.shift();
    const i = a.indexOf('=');
    vars[a.slice(0, i)] = a.slice(i + 1);
  }
  if (!args.length) {
    await ctx.out(Object.entries(vars).map(([k, v]) => `${k}=${v}${nul ? '\0' : '\n'}`).join(''));
    return 0;
  }
  // run command with this environment
  const sh = ctx.shell.subshell({ fresh: true });
  sh.globals = new Map(Object.entries(vars).map(([k, v]) => [k, { v, x: true }]));
  sh.cwd = ctx.shell.cwd;
  sh.ctl = ctx.shell.ctl;
  try {
    const path = sh.findInPath(args[0]);
    if (!path) {
      await ctx.err(`env: '${args[0]}': No such file or directory\n`);
      return 127;
    }
    return await sh.runCommand(args, ctx.io, { skipFunctions: true });
  } catch (e) {
    if (e instanceof ExitEx) return e.code;
    throw e;
  }
}

async function printenv(ctx) {
  const vars = ctx.env;
  const names = ctx.args.filter((a) => !a.startsWith('-'));
  const nul = ctx.args.includes('-0');
  if (!names.length) {
    await ctx.out(Object.entries(vars).map(([k, v]) => `${k}=${v}${nul ? '\0' : '\n'}`).join(''));
    return 0;
  }
  let st = 0;
  for (const n of names) {
    if (n in vars) await ctx.out(vars[n] + (nul ? '\0' : '\n'));
    else st = 1;
  }
  return st;
}

// ---------- terminal control ----------

async function clear(ctx) {
  await ctx.out('\x1b[H\x1b[2J\x1b[3J');
  return 0;
}

async function reset(ctx) {
  await ctx.out('\x1bc');
  return 0;
}

const TPUT = {
  clear: '\x1b[H\x1b[2J', bold: '\x1b[1m', dim: '\x1b[2m', sitm: '\x1b[3m', ritm: '\x1b[23m', smul: '\x1b[4m', rmul: '\x1b[24m', rev: '\x1b[7m', blink: '\x1b[5m',
  sgr0: '\x1b(B\x1b[m', smso: '\x1b[7m', rmso: '\x1b[27m', el: '\x1b[K', el1: '\x1b[1K', ed: '\x1b[J', civis: '\x1b[?25l', cnorm: '\x1b[?12l\x1b[?25h', cvvis: '\x1b[?12;25h',
  smcup: '\x1b[?1049h\x1b[22;0;0t', rmcup: '\x1b[?1049l\x1b[23;0;0t', sc: '\x1b7', rc: '\x1b8', home: '\x1b[H', bel: '\x07', cr: '\r', cud1: '\n', cuu1: '\x1b[A',
  cuf1: '\x1b[C', cub1: '\b', ind: '\n', ri: '\x1bM', invis: '\x1b[8m', hpa: '', op: '\x1b[39;49m', kbs: '\x7f',
};

async function tput(ctx) {
  const args = ctx.args.filter((a) => !a.startsWith('-T'));
  if (!args.length) {
    await ctx.err('tput: unknown terminfo capability \'\'\n');
    return 2;
  }
  const term = ctx.shell.term;
  const cols = term ? term.cols : Number(ctx.shell.getVar('COLUMNS') || 80);
  const rows = term ? term.rows : Number(ctx.shell.getVar('LINES') || 24);
  const [cap, ...p] = args;
  switch (cap) {
    case 'cols':
      await ctx.out(cols + '\n');
      return 0;
    case 'lines':
      await ctx.out(rows + '\n');
      return 0;
    case 'colors':
      await ctx.out('256\n');
      return 0;
    case 'longname':
      await ctx.out('xterm with 256 colors');
      return 0;
    case 'setaf':
    case 'setf': {
      const n = Number(p[0] || 0);
      await ctx.out(n < 8 ? `\x1b[3${n}m` : n < 16 ? `\x1b[9${n - 8}m` : `\x1b[38;5;${n}m`);
      return 0;
    }
    case 'setab':
    case 'setb': {
      const n = Number(p[0] || 0);
      await ctx.out(n < 8 ? `\x1b[4${n}m` : n < 16 ? `\x1b[10${n - 8}m` : `\x1b[48;5;${n}m`);
      return 0;
    }
    case 'cup':
      await ctx.out(`\x1b[${Number(p[0] || 0) + 1};${Number(p[1] || 0) + 1}H`);
      return 0;
    case 'cuu':
    case 'cud':
    case 'cuf':
    case 'cub':
      await ctx.out(`\x1b[${p[0] || 1}${{ cuu: 'A', cud: 'B', cuf: 'C', cub: 'D' }[cap]}`);
      return 0;
    case 'hpa':
      await ctx.out(`\x1b[${Number(p[0] || 0) + 1}G`);
      return 0;
    case 'ech':
      await ctx.out(`\x1b[${p[0] || 1}X`);
      return 0;
    case 'init':
    case 'reset':
      await ctx.out('\x1b[!p\x1b[?3;4l\x1b[4l\x1b>');
      return 0;
  }
  if (cap in TPUT) {
    await ctx.out(TPUT[cap]);
    return 0;
  }
  await ctx.err(`tput: unknown terminfo capability '${cap}'\n`);
  return 4;
}

async function stty(ctx) {
  const term = ctx.shell.term;
  const cols = term ? term.cols : 80;
  const rows = term ? term.rows : 24;
  if (ctx.args.includes('size')) {
    await ctx.out(`${rows} ${cols}\n`);
    return 0;
  }
  if (ctx.args.includes('-a') || ctx.args.includes('--all')) {
    await ctx.out(`speed 38400 baud; rows ${rows}; columns ${cols}; line = 0;
intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>; eol2 = <undef>; swtch = <undef>; start = ^Q; stop = ^S; susp = ^Z; rprnt = ^R; werase = ^W; lnext = ^V; discard = ^O; min = 1; time = 0;
-parenb -parodd -cmspar cs8 -hupcl -cstopb cread -clocal -crtscts
-ignbrk -brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff -iuclc -ixany -imaxbel iutf8
opost -olcuc -ocrnl onlcr -onocr -onlret -ofill -ofdel nl0 cr0 tab0 bs0 vt0 ff0
isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt echoctl echoke -flusho -extproc
`);
    return 0;
  }
  if (!ctx.args.length) {
    await ctx.out('speed 38400 baud; line = 0;\n-brkint -imaxbel iutf8\n');
    return 0;
  }
  if (term) {
    for (const a of ctx.args) {
      if (a === '-echo') term.noEcho = true;
      if (a === 'echo' || a === 'sane') term.noEcho = false;
    }
  }
  return 0;
}

async function tty(ctx) {
  if (ctx.stdin.isTerminal) {
    if (!ctx.args.includes('-s')) await ctx.out('/dev/pts/0\n');
    return 0;
  }
  if (!ctx.args.includes('-s')) await ctx.out('not a tty\n');
  return 1;
}

// ---------- privilege ----------

async function asUser(ctx, user, fn) {
  const sh = ctx.shell;
  const sys = sh.system;
  const savedCred = sh.vfs.cred;
  const savedUser = sh.user;
  sh.vfs.cred = { uid: user.uid, gid: user.gid, groups: sys.groupsOf(user.name) };
  sh.user = { uid: user.uid, gid: user.gid, name: user.name, groups: sys.groupsOf(user.name) };
  try {
    return await fn();
  } finally {
    sh.vfs.cred = savedCred;
    sh.user = savedUser;
  }
}

function loginShell(ctx, user, { login = true, keepEnv = false } = {}) {
  const sh = ctx.shell.subshell({ fresh: true });
  if (!keepEnv) {
    sh.globals = new Map();
    for (const k of ['TERM', 'LANG', 'COLORTERM', 'LS_COLORS']) {
      const v = ctx.shell.getVar(k);
      if (v !== undefined) sh.globals.set(k, { v, x: true });
    }
  }
  const set = (k, v) => sh.globals.set(k, { v, x: true });
  set('HOME', user.home);
  set('USER', user.name);
  set('LOGNAME', user.name);
  set('SHELL', user.shell || '/bin/bash');
  set('PATH', user.uid === 0 ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin' : ctx.shell.getVar('PATH') || '/usr/local/bin:/usr/bin:/bin');
  if (!sh.globals.has('PS1')) sh.globals.set('PS1', { v: ctx.shell.getVar('PS1') ?? '\\u@\\h:\\w\\$ ' });
  sh.user = { uid: user.uid, gid: user.gid, name: user.name, groups: ctx.shell.system.groupsOf(user.name) };
  sh.cwd = login ? user.home : ctx.shell.cwd;
  set('PWD', sh.cwd);
  sh.ctl = ctx.shell.ctl;
  sh.argv0 = login ? '-bash' : 'bash';
  return sh;
}

async function runNestedInteractive(ctx, sh, user, rcFiles) {
  const term = ctx.shell.term;
  if (!term) return 0;
  const sys = ctx.shell.system;
  const savedCred = ctx.vfs.cred;
  ctx.vfs.cred = { uid: user.uid, gid: user.gid, groups: sys.groupsOf(user.name) };
  sh.interactive = true;
  sh.history = ctx.shell.history;
  try {
    return await term.repl(sh, { rcFiles });
  } finally {
    ctx.vfs.cred = savedCred;
  }
}

async function sudo(ctx) {
  const args = ctx.args.slice();
  let target = 'root';
  let login = false;
  let shell = false;
  let keepEnv = false;
  while (args.length && args[0].startsWith('-')) {
    const a = args.shift();
    if (a === '--') break;
    if (a === '-u' || a === '--user') target = args.shift();
    else if (a.startsWith('-u')) target = a.slice(2);
    else if (a === '-i' || a === '--login') login = true;
    else if (a === '-s' || a === '--shell') shell = true;
    else if (a === '-E' || a === '--preserve-env') keepEnv = true;
    else if (a === '-k' || a === '-K' || a === '-v' || a === '--validate' || a === '--reset-timestamp') {
      if (!args.length) return 0;
    } else if (a === '-l' || a === '--list') {
      await ctx.out(`Matching Defaults entries for ${ctx.shell.user.name} on ${ctx.shell.system.hostname}:\n    env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty\n\nUser ${ctx.shell.user.name} may run the following commands on ${ctx.shell.system.hostname}:\n    (ALL : ALL) ALL\n    (ALL) NOPASSWD: ALL\n`);
      return 0;
    } else if (a === '-h' || a === '--help') {
      await ctx.out('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\n');
      return 0;
    } else if (a === '-V' || a === '--version') {
      await ctx.out('Sudo version 1.9.15p5\n');
      return 0;
    } else if (a === '-n' || a === '-H' || a === '-S' || a === '-b' || a === '-A' || a === '-P') {} else {
      await ctx.err(`sudo: invalid option -- '${a.replace(/^-+/, '')}'\nusage: sudo -h | -K | -k | -V\n`);
      return 1;
    }
  }
  const sys = ctx.shell.system;
  const me = sys.userById(ctx.vfs.cred.uid);
  const groupsMe = sys.groupsOf(me ? me.name : '');
  if (ctx.vfs.cred.uid !== 0 && !groupsMe.includes(27)) {
    await ctx.err(`${me ? me.name : 'user'} is not in the sudoers file.\n`);
    return 1;
  }
  const user = /^#\d+$/.test(target) ? sys.userById(Number(target.slice(1))) : sys.userByName(target);
  if (!user) {
    await ctx.err(`sudo: unknown user ${target}\nsudo: error initializing audit plugin sudoers_audit\n`);
    return 1;
  }
  if (!args.length) {
    if (login || shell) {
      const sh = loginShell(ctx, user, { login, keepEnv: shell });
      if (shell) sh.cwd = ctx.shell.cwd;
      return runNestedInteractive(ctx, sh, user, login ? ['/etc/profile', user.home + '/.profile', user.home + '/.bashrc'] : [user.home + '/.bashrc']);
    }
    await ctx.err('usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]\nusage: sudo -l [-ABkNnS] [-g group] [-h host] [-p prompt] [-U user] [-u user] [command [arg ...]]\nusage: sudo [-ABbEHkNnPS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] [VAR=value] [-i | -s] [command [arg ...]]\nusage: sudo -e [-ABkNnS] [-r role] [-t type] [-C num] [-D directory] [-g group] [-h host] [-p prompt] [-R directory] [-T timeout] [-u user] file ...\n');
    return 1;
  }
  // env assignments
  const envAssign = [];
  while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0])) envAssign.push(args.shift());
  if (login || shell) {
    const sh = loginShell(ctx, user, { login, keepEnv: shell });
    return asUser(ctx, user, async () => {
      try {
        return await sh.runSource(args.map((a) => sh.quoteValue(a)).join(' '), ctx.io);
      } catch (e) {
        if (e instanceof ExitEx) return typeof e.code === 'number' ? e.code : 0;
        throw e;
      }
    });
  }
  return asUser(ctx, user, async () => {
    const sh = ctx.shell.subshell({ fresh: true });
    sh.ctl = ctx.shell.ctl;
    sh.user = { uid: user.uid, gid: user.gid, name: user.name, groups: sys.groupsOf(user.name) };
    if (!keepEnv) {
      const set = (k, v) => sh.globals.set(k, { v, x: true });
      set('HOME', user.home);
      set('USER', user.name);
      set('LOGNAME', user.name);
      set('SUDO_USER', ctx.shell.user.name);
      set('SUDO_UID', String(ctx.shell.user.uid));
      set('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin');
    }
    for (const a of envAssign) {
      const i = a.indexOf('=');
      sh.globals.set(a.slice(0, i), { v: a.slice(i + 1), x: true });
    }
    const name = args[0];
    if (!name.includes('/') && !sh.findInPath(name)) {
      await ctx.err(`sudo: ${name}: command not found\n`);
      return 1;
    }
    try {
      return await sh.runCommand(args, ctx.io, { skipFunctions: true });
    } catch (e) {
      if (e instanceof ExitEx) return typeof e.code === 'number' ? e.code : 0;
      throw e;
    }
  });
}

async function readPassword(ctx, prompt) {
  if (ctx.stdin.isTerminal) {
    await ctx.err(prompt);
    const r = await ctx.stdin.term.readInput({ echo: false });
    await ctx.err('\n');
    return r ? r.text : null;
  }
  return ctx.stdin.readLine();
}

async function su(ctx) {
  const args = ctx.args.slice();
  let login = false;
  let command = null;
  let target = 'root';
  while (args.length) {
    const a = args.shift();
    if (a === '-' || a === '-l' || a === '--login') login = true;
    else if (a === '-c' || a === '--command') command = args.shift();
    else if (a === '-s' || a === '--shell') args.shift();
    else if (a.startsWith('-')) {} else target = a;
  }
  const sys = ctx.shell.system;
  const user = sys.userByName(target);
  if (!user) {
    await ctx.err(`su: user ${target} does not exist or the user entry does not contain all the required fields\n`);
    return 1;
  }
  if (ctx.vfs.cred.uid !== 0) {
    const pw = await readPassword(ctx, 'Password: ');
    await ctx.shell.sleep(1500);
    void pw;
    await ctx.err('su: Authentication failure\n');
    return 1;
  }
  const sh = loginShell(ctx, user, { login });
  if (command !== null) {
    return asUser(ctx, user, async () => {
      try {
        return await sh.runSource(command, ctx.io);
      } catch (e) {
        if (e instanceof ExitEx) return typeof e.code === 'number' ? e.code : 0;
        throw e;
      }
    });
  }
  return runNestedInteractive(ctx, sh, user, login ? ['/etc/profile', user.home + '/.profile'] : [user.home + '/.bashrc']);
}

function requireRoot(ctx, what) {
  if (ctx.vfs.cred.uid !== 0) {
    ctx.err(`${what}: Permission denied.\n${what}: cannot lock /etc/passwd; try again later.\n`);
    return false;
  }
  return true;
}

async function useradd(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'mMrNU', params: 'dsugGcpe', long: { 'create-home': 'm', home: 'd', shell: 's', uid: 'u', gid: 'g', groups: 'G', comment: 'c', system: 'r' } });
  if (!rest.length) throw new UsageError('missing user name', 2, false);
  if (!requireRoot(ctx, ctx.name)) return 1;
  const sys = ctx.shell.system;
  const name = rest[0];
  if (sys.userByName(name)) {
    await ctx.err(`${ctx.name}: user '${name}' already exists\n`);
    return 9;
  }
  const uid = o.u ? Number(o.u) : Math.max(999, ...sys.users().filter((u) => u.uid < 60000).map((u) => u.uid)) + 1;
  const home = o.d || `/home/${name}`;
  const isAdduser = ctx.name === 'adduser';
  let gid = o.g ? (/^\d+$/.test(o.g) ? Number(o.g) : sys.groupByName(o.g)?.gid) : uid;
  if (!o.g) {
    const g = ctx.vfs.readFile('/etc/group', '/');
    ctx.vfs.writeFile('/etc/group', '/', g + `${name}:x:${uid}:\n`);
    gid = uid;
  }
  const p = ctx.vfs.readFile('/etc/passwd', '/');
  ctx.vfs.writeFile('/etc/passwd', '/', p + `${name}:x:${uid}:${gid}:${o.c || (isAdduser ? ',,,' : '')}:${home}:${o.s || (isAdduser ? '/bin/bash' : '/bin/sh')}\n`);
  if (o.G) {
    for (const gname of o.G.split(',')) await ctx.shell.runCommand(['usermod', '-aG', gname, name], ctx.io, { skipFunctions: true });
  }
  if (o.m || isAdduser) {
    try {
      ctx.vfs.mkdir(home, '/', { parents: true, mode: 0o750, umask: 0 });
      for (const f of ['.bashrc', '.profile', '.bash_logout']) {
        try {
          ctx.vfs.writeFile(`${home}/${f}`, '/', ctx.vfs.readFile(`/etc/skel/${f}`, '/'));
          ctx.vfs.chown(`${home}/${f}`, '/', uid, gid);
        } catch {}
      }
      ctx.vfs.chown(home, '/', uid, gid);
    } catch {}
  }
  if (isAdduser) await ctx.out(`info: Adding user \`${name}' ...\ninfo: Selecting UID/GID from range 1000 to 59999 ...\ninfo: Adding new group \`${name}' (${gid}) ...\ninfo: Adding new user \`${name}' (${uid}) with group \`${name} (${gid})' ...\ninfo: Creating home directory \`${home}' ...\ninfo: Copying files from \`/etc/skel' ...\npasswd: password updated successfully\ninfo: Adding user \`${name}' to supplemental / extra groups \`users' ...\n`);
  return 0;
}

async function userdel(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'rf', long: { remove: 'r', force: 'f' } });
  if (!rest.length) throw new UsageError('missing user name', 2, false);
  if (!requireRoot(ctx, ctx.name)) return 1;
  const sys = ctx.shell.system;
  const u = sys.userByName(rest[0]);
  if (!u) {
    await ctx.err(`${ctx.name}: user '${rest[0]}' does not exist\n`);
    return 6;
  }
  const p = ctx.vfs.readFile('/etc/passwd', '/').split('\n').filter((l) => !l.startsWith(u.name + ':')).join('\n');
  ctx.vfs.writeFile('/etc/passwd', '/', p);
  const g = ctx.vfs.readFile('/etc/group', '/').split('\n').filter((l) => !l.startsWith(u.name + ':')).map((l) => l.replace(new RegExp(`([:,])${u.name}(,|$)`), (m, a, b) => (a === ':' ? ':' : b === ',' ? ',' : ''))).join('\n');
  ctx.vfs.writeFile('/etc/group', '/', g);
  if (o.r) {
    try {
      ctx.vfs.removeTree(u.home, '/');
    } catch {}
  }
  return 0;
}

async function groupadd(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'rf', params: 'g', long: { gid: 'g', system: 'r', force: 'f' } });
  if (!rest.length) throw new UsageError('missing group name', 2, false);
  if (!requireRoot(ctx, ctx.name)) return 1;
  const sys = ctx.shell.system;
  if (sys.groupByName(rest[0])) {
    await ctx.err(`groupadd: group '${rest[0]}' already exists\n`);
    return 9;
  }
  const gid = o.g ? Number(o.g) : Math.max(999, ...sys.groups().filter((g) => g.gid < 60000).map((g) => g.gid)) + 1;
  ctx.vfs.writeFile('/etc/group', '/', ctx.vfs.readFile('/etc/group', '/') + `${rest[0]}:x:${gid}:\n`);
  return 0;
}

async function groupdel(ctx) {
  if (!ctx.args.length) throw new UsageError('missing group name', 2, false);
  if (!requireRoot(ctx, ctx.name)) return 1;
  const name = ctx.args[0];
  const text = ctx.vfs.readFile('/etc/group', '/');
  if (!text.split('\n').some((l) => l.startsWith(name + ':'))) {
    await ctx.err(`groupdel: group '${name}' does not exist\n`);
    return 6;
  }
  ctx.vfs.writeFile('/etc/group', '/', text.split('\n').filter((l) => !l.startsWith(name + ':')).join('\n'));
  return 0;
}

async function usermod(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'aLU', params: 'GgsdlcHu', long: { append: 'a', groups: 'G', shell: 's', home: 'd', login: 'l', comment: 'c' } });
  if (!rest.length) throw new UsageError('missing user name', 2, false);
  if (!requireRoot(ctx, ctx.name)) return 1;
  const sys = ctx.shell.system;
  const name = rest[0];
  if (!sys.userByName(name)) {
    await ctx.err(`usermod: user '${name}' does not exist\n`);
    return 6;
  }
  if (o.G) {
    const want = o.G.split(',');
    const lines = ctx.vfs.readFile('/etc/group', '/').split('\n').map((l) => {
      if (!l) return l;
      const parts = l.split(':');
      const members = (parts[3] || '').split(',').filter(Boolean);
      const has = members.includes(name);
      if (want.includes(parts[0]) && !has) members.push(name);
      else if (!want.includes(parts[0]) && has && !o.a) members.splice(members.indexOf(name), 1);
      parts[3] = members.join(',');
      return parts.join(':');
    });
    for (const g of want) if (!sys.groupByName(g)) {
      await ctx.err(`usermod: group '${g}' does not exist\n`);
      return 6;
    }
    ctx.vfs.writeFile('/etc/group', '/', lines.join('\n'));
  }
  if (o.s || o.d || o.c) {
    const lines = ctx.vfs.readFile('/etc/passwd', '/').split('\n').map((l) => {
      const parts = l.split(':');
      if (parts[0] !== name) return l;
      if (o.c) parts[4] = o.c;
      if (o.d) parts[5] = o.d;
      if (o.s) parts[6] = o.s;
      return parts.join(':');
    });
    ctx.vfs.writeFile('/etc/passwd', '/', lines.join('\n'));
  }
  return 0;
}

async function passwd(ctx) {
  const sys = ctx.shell.system;
  const target = ctx.args.find((a) => !a.startsWith('-')) || sys.userName(ctx.vfs.cred.uid);
  if (ctx.args.includes('-S')) {
    await ctx.out(`${target} P ${strftime(new Date(sys.boot), '%m/%d/%Y')} 0 99999 7 -1\n`);
    return 0;
  }
  if (target !== sys.userName(ctx.vfs.cred.uid) && ctx.vfs.cred.uid !== 0) {
    await ctx.err(`passwd: You may not view or modify password information for ${target}.\n`);
    return 1;
  }
  if (ctx.vfs.cred.uid !== 0) {
    await ctx.out(`Changing password for ${target}.\n`);
    if ((await readPassword(ctx, 'Current password: ')) === null) return 1;
  }
  const a = await readPassword(ctx, 'New password: ');
  if (a === null) return 1;
  const b = await readPassword(ctx, 'Retype new password: ');
  if (a !== b) {
    await ctx.err('Sorry, passwords do not match.\npasswd: Authentication token manipulation error\npasswd: password unchanged\n');
    return 10;
  }
  if (a.length < 8 && ctx.vfs.cred.uid !== 0) {
    await ctx.err('BAD PASSWORD: The password is shorter than 8 characters\n');
  }
  await ctx.out('passwd: password updated successfully\n');
  return 0;
}

async function getent(ctx) {
  const [db, ...keys] = ctx.args;
  const files = { passwd: '/etc/passwd', group: '/etc/group', hosts: '/etc/hosts', services: '/etc/services', shells: '/etc/shells', protocols: '/etc/protocols' };
  if (!db || !files[db]) {
    await ctx.err(`Unknown database: ${db || ''}\nTry \`getent --help' or \`getent --usage' for more information.\n`);
    return 1;
  }
  let lines = [];
  try {
    lines = splitLines(ctx.vfs.readFile(files[db], '/')).filter((l) => l && !l.startsWith('#'));
  } catch {}
  if (!keys.length) {
    await ctx.out(lines.map((l) => l + '\n').join(''));
    return 0;
  }
  let st = 0;
  for (const k of keys) {
    const l = lines.find((x) => (db === 'hosts' ? x.split(/\s+/).includes(k) : x.split(':')[0] === k || x.split(':')[2] === k));
    if (l) await ctx.out((db === 'hosts' ? l.replace(/\s+/, '       ') : l) + '\n');
    else st = 2;
  }
  return st;
}

// ---------- xargs / nohup / nice / time ----------

async function xargs(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: '0rtpx',
    params: 'nILdaPsE',
    long: { null: '0', 'no-run-if-empty': 'r', verbose: 't', interactive: 'p', 'max-args': 'n', replace: '?', 'max-lines': 'L', delimiter: 'd', 'arg-file': 'a', 'max-procs': 'P', 'max-chars': 's', 'eof': 'E' },
    stopAtOperand: true,
  });
  if (o.replace !== undefined) o.I = o.replace === true ? '{}' : o.replace;
  let text;
  if (o.a) text = ctx.vfs.readFile(o.a, ctx.cwd);
  else text = await ctx.stdin.readAll();
  let items;
  if (o['0']) items = text.split('\0').filter((x, i, a) => !(x === '' && i === a.length - 1));
  else if (o.d) items = text.split(o.d.replace(/^\\n$/, '\n').replace(/^\\t$/, '\t')).filter((x, i, a) => !(x === '' && i === a.length - 1));
  else if (o.I) items = splitLines(text).map((l) => l.replace(/^\s+/, '')).filter((l) => l !== '');
  else {
    items = [];
    const re = /"([^"]*)"|'([^']*)'|((?:\\.|[^\s'"])+)/g;
    let m;
    const src = text;
    let buf = null;
    let lastEnd = -1;
    while ((m = re.exec(src))) {
      const piece = m[1] ?? m[2] ?? m[3].replace(/\\(.)/g, '$1');
      if (buf !== null && m.index === lastEnd) buf += piece;
      else {
        if (buf !== null) items.push(buf);
        buf = piece;
      }
      lastEnd = re.lastIndex;
    }
    if (buf !== null) items.push(buf);
    if (o.E) {
      const k = items.indexOf(o.E);
      if (k >= 0) items = items.slice(0, k);
    }
  }
  const base = rest.length ? rest : ['echo'];
  if (!items.length && (o.r || o.I)) return 0;
  const batches = [];
  if (o.I) for (const it of items) batches.push(base.map((a) => a.split(o.I).join(it)));
  else if (o.n) {
    const n = Number(o.n);
    for (let i = 0; i < items.length; i += n) batches.push([...base, ...items.slice(i, i + n)]);
    if (!items.length) batches.push(base);
  } else if (o.L) {
    const lines = splitLines(text).filter(Boolean);
    const n = Number(o.L);
    for (let i = 0; i < lines.length; i += n) batches.push([...base, ...lines.slice(i, i + n).flatMap((l) => l.trim().split(/\s+/))]);
  } else batches.push([...base, ...items]);
  let st = 0;
  for (const argv of batches) {
    if (o.t || o.p) await ctx.err(argv.join(' ') + (o.p ? ' ?...' : '\n'));
    if (o.p) {
      const ans = await (ctx.shell.term ? ctx.shell.term.reader().readLine() : '');
      if (!/^[yY]/.test(ans || '')) continue;
    }
    let r;
    try {
      r = await ctx.shell.runCommand(argv, { ...ctx.io, 0: new EmptyReader() }, { skipFunctions: true });
    } catch (e) {
      if (e instanceof ExitEx) r = e.code;
      else throw e;
    }
    if (r === 127) {
      return 127;
    }
    if (r === 255) {
      await ctx.err(`xargs: ${argv[0]}: exited with status 255; aborting\n`);
      return 124;
    }
    if (r !== 0) st = 123;
  }
  return st;
}

async function nohup(ctx) {
  if (!ctx.args.length) throw new UsageError('missing operand', 125);
  let io = { ...ctx.io };
  if (ctx.stdout.isTerminalWriter) {
    await ctx.err("nohup: ignoring input and appending output to 'nohup.out'\n");
    io[1] = ctx.shell.openWrite('nohup.out', io, true, true);
    if (ctx.stderr.isTerminalWriter) io[2] = io[1];
  }
  return ctx.shell.runCommand(ctx.args, io, { skipFunctions: true });
}

async function nice(ctx) {
  const args = ctx.args.slice();
  if (args[0] === '-n') args.splice(0, 2);
  else if (/^-\d+$/.test(args[0] || '') || /^--adjustment/.test(args[0] || '')) args.shift();
  if (!args.length) {
    await ctx.out('0\n');
    return 0;
  }
  return ctx.shell.runCommand(args, ctx.io, { skipFunctions: true });
}

async function timeCmd(ctx) {
  const args = ctx.args.filter((a, i) => !(i === 0 && (a === '-p' || a === '-v')));
  const t0 = Date.now();
  const st = args.length ? await ctx.shell.runCommand(args, ctx.io, { skipFunctions: true }) : 0;
  const dt = (Date.now() - t0) / 1000;
  if (ctx.args[0] === '-p') await ctx.err(`real ${dt.toFixed(2)}\nuser ${(dt * 0.01).toFixed(2)}\nsys ${(dt * 0.005).toFixed(2)}\n`);
  else await ctx.err(`${(dt * 0.01).toFixed(2)}user ${(dt * 0.005).toFixed(2)}system ${Math.floor(dt / 60)}:${(dt % 60).toFixed(2).padStart(5, '0')}elapsed ${dt ? 2 : 0}%CPU (0avgtext+0avgdata 2048maxresident)k\n0inputs+0outputs (0major+90minor)pagefaults 0swaps\n`);
  return st;
}

// ---------- sh / bash ----------

async function bashCmd(ctx) {
  const args = ctx.args.slice();
  const sh = ctx.shell.subshell({ fresh: true });
  sh.ctl = ctx.shell.ctl;
  let command = null;
  let interactive = false;
  let login = false;
  let readStdin = false;
  const name = ctx.name;
  while (args.length && /^[-+]/.test(args[0]) && args[0] !== '-' && args[0] !== '--') {
    const a = args.shift();
    if (a === '--version') {
      await ctx.out(`GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)\nCopyright (C) 2022 Free Software Foundation, Inc.\nLicense GPLv3+: GNU GPL version 3 or later <http://gnu.org/licenses/gpl.html>\n\nThis is free software; you are free to change and redistribute it.\nThere is NO WARRANTY, to the extent permitted by law.\n`);
      return 0;
    }
    if (a === '--help') {
      await ctx.out(`GNU bash, version 5.2.21(1)-release-(x86_64-pc-linux-gnu)\nUsage:\tbash [GNU long option] [option] ...\n\tbash [GNU long option] [option] script-file ...\nGNU long options:\n\t--debug\n\t--help\n\t--login\n\t--noprofile\n\t--norc\n\t--posix\n\t--version\nShell options:\n\t-ilrsD or -c command or -O shopt_option\t\t(invocation only)\n\t-abefhkmnptuvxBCEHPT or -o option\n`);
      return 0;
    }
    if (a === '--login' || a === '-l') {
      login = true;
      continue;
    }
    if (a === '--norc' || a === '--noprofile' || a === '--posix' || a === '--debug' || a === '--restricted' || a === '-r') continue;
    if (a === '-o' || a === '+o') {
      const opt = args.shift();
      if (opt in sh.opts) sh.opts[opt] = a === '-o';
      continue;
    }
    if (a === '-O' || a === '+O') {
      const opt = args.shift();
      if (opt in sh.shopt) sh.shopt[opt] = a === '-O';
      continue;
    }
    for (const c of a.slice(1)) {
      if (c === 'c') command = args.shift();
      else if (c === 'i') interactive = true;
      else if (c === 'l') login = true;
      else if (c === 's') readStdin = true;
      else {
        const map = { e: 'errexit', u: 'nounset', x: 'xtrace', v: 'verbose', f: 'noglob', n: 'noexec', C: 'noclobber', a: 'allexport', h: 'hashall', B: 'braceexpand', H: 'histexpand', m: 'monitor', E: 'errtrace', T: 'functrace', P: 'physical', k: 'keyword', b: 'notify', p: 'privileged', t: 'onecmd' };
        if (map[c]) sh.opts[map[c]] = a[0] === '-';
        else {
          await ctx.err(`${name}: ${a[0]}${c}: invalid option\n`);
          return 2;
        }
      }
    }
  }
  if (args[0] === '--' || args[0] === '-') args.shift();
  sh.argv0 = name;
  const savedCwd = ctx.shell.cwd;
  sh.cwd = savedCwd;
  if (name === 'sh' || name === 'dash') sh.opts.posix = true;
  const run = async (src) => {
    try {
      const st = await sh.runSource(src, ctx.io);
      await sh.finishPsubs();
      if (sh.traps.EXIT) await sh.runTrap('EXIT', ctx.io);
      return st;
    } catch (e) {
      await sh.finishPsubs();
      if (e instanceof ExitEx) {
        if (sh.traps.EXIT) {
          sh.status = e.code;
          await sh.runTrap('EXIT', ctx.io);
        }
        return typeof e.code === 'number' ? e.code : 0;
      }
      if (e instanceof ShellError) {
        await sh.report(e.message, ctx.io);
        return e.status;
      }
      if (e instanceof ReturnEx) return e.code;
      throw e;
    }
  };
  if (command !== null) {
    if (args.length) {
      sh.argv0 = args[0];
      sh.positional = args.slice(1);
    }
    sh.scriptName = null;
    return run(command);
  }
  if (args.length && !readStdin) {
    const file = args[0];
    let text;
    try {
      const node = ctx.vfs.stat(file, ctx.cwd);
      if (node.type === 'dir') {
        await ctx.err(`${name}: ${file}: Is a directory\n`);
        return 126;
      }
      text = ctx.vfs.readFile(file, ctx.cwd);
    } catch (e) {
      await ctx.err(`${name}: ${file}: ${e.message}\n`);
      return 127;
    }
    sh.argv0 = file;
    sh.scriptName = file;
    sh.positional = args.slice(1);
    sh.sourceStack = [file];
    return run(text);
  }
  if (ctx.stdin.isTerminal || interactive) {
    if (!ctx.shell.term) return 0;
    sh.interactive = true;
    sh.history = ctx.shell.history;
    sh.user = ctx.shell.user;
    const lvl = (parseInt(ctx.shell.getVar('SHLVL') || '1', 10) || 1) + 1;
    sh.globals.set('SHLVL', { v: String(lvl), x: true });
    sh.shopt.expand_aliases = true;
    const home = ctx.shell.getVar('HOME') || '/root';
    return ctx.shell.term.repl(sh, { rcFiles: login ? ['/etc/profile', home + '/.profile'] : [home + '/.bashrc'], nested: true });
  }
  sh.positional = args;
  return run(await ctx.stdin.readAll());
}

// ---------- bc ----------

class Dec {
  // value = n / 10^s
  constructor(n, s = 0) {
    this.n = n;
    this.s = s;
  }
  static from(str, ibase = 10) {
    str = str.trim();
    if (ibase !== 10) {
      const [ip, fp = ''] = str.split('.');
      let n = 0n;
      for (const c of ip) n = n * BigInt(ibase) + BigInt(parseInt(c, 36));
      if (!fp) return new Dec(n, 0);
      let frac = new Dec(0n, 0);
      let scale = new Dec(1n, 0);
      for (const c of fp) {
        scale = scale.div(new Dec(BigInt(ibase)), 20);
        frac = frac.add(scale.mul(new Dec(BigInt(parseInt(c, 36)))));
      }
      return new Dec(n).add(frac);
    }
    const neg = str.startsWith('-');
    if (neg) str = str.slice(1);
    const [ip, fp = ''] = str.split('.');
    const n = BigInt((ip || '0') + fp);
    return new Dec(neg ? -n : n, fp.length);
  }
  align(o) {
    const s = Math.max(this.s, o.s);
    return [this.n * 10n ** BigInt(s - this.s), o.n * 10n ** BigInt(s - o.s), s];
  }
  add(o) {
    const [a, b, s] = this.align(o);
    return new Dec(a + b, s);
  }
  sub(o) {
    const [a, b, s] = this.align(o);
    return new Dec(a - b, s);
  }
  mul(o, scale = null) {
    const r = new Dec(this.n * o.n, this.s + o.s);
    const maxS = scale === null ? r.s : Math.min(r.s, Math.max(scale, this.s, o.s));
    return r.trunc(maxS);
  }
  div(o, scale) {
    if (o.n === 0n) throw new Error('Divide by zero');
    // (a/10^sa) / (b/10^sb) with result scale
    const num = this.n * 10n ** BigInt(scale + o.s);
    const den = o.n * 10n ** BigInt(this.s);
    return new Dec(num / den, scale);
  }
  mod(o, scale) {
    const q = this.div(o, scale);
    return this.sub(q.mul(o));
  }
  trunc(s) {
    if (this.s <= s) return this;
    return new Dec(this.n / 10n ** BigInt(this.s - s), s);
  }
  pow(e, scale) {
    let k = e.trunc(0).n;
    let neg = k < 0n;
    if (neg) k = -k;
    let r = new Dec(1n);
    let b = this;
    const sc = Math.min(this.s * Number(k), Math.max(scale, this.s));
    while (k > 0n) {
      if (k & 1n) r = r.mul(b);
      b = b.mul(b);
      k >>= 1n;
      if (r.s > 200) r = r.trunc(200);
      if (b.s > 200) b = b.trunc(200);
    }
    if (neg) return new Dec(1n).div(r, scale);
    return r.trunc(sc);
  }
  sqrt(scale) {
    if (this.n < 0n) throw new Error('Square root of a negative number');
    const s = Math.max(scale, this.s);
    const N = this.n * 10n ** BigInt(2 * s - this.s);
    if (N === 0n) return new Dec(0n, s);
    let x = BigInt(Math.floor(Math.sqrt(Number(N)))) || 1n;
    for (let i = 0; i < 200; i++) {
      const y = (x + N / x) / 2n;
      if (y === x || y === x + 1n || y === x - 1n) {
        x = y;
        break;
      }
      x = y;
    }
    while (x * x > N) x--;
    while ((x + 1n) * (x + 1n) <= N) x++;
    return new Dec(x, s);
  }
  cmp(o) {
    const [a, b] = this.align(o);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  toNumber() {
    return Number(this.n) / 10 ** this.s;
  }
  // bc truncates: keep `scale` digits of x without rounding
  static fromNumber(x, scale) {
    const sc = Math.min(scale, 20);
    let str = x.toFixed(Math.min(sc + 3, 20));
    if (sc + 3 <= 20) str = str.slice(0, str.length - 3);
    if (str.endsWith('.')) str = str.slice(0, -1);
    return Dec.from(str);
  }
  toString(obase = 10) {
    let neg = this.n < 0n;
    let n = neg ? -this.n : this.n;
    if (obase !== 10) {
      const ip = n / 10n ** BigInt(this.s);
      let s = ip.toString(obase).toUpperCase();
      if (obase > 16) s = ip.toString().replace(/./g, (x) => x);
      return (neg ? '-' : '') + s;
    }
    let str = n.toString().padStart(this.s + 1, '0');
    let ip = str.slice(0, str.length - this.s);
    let fp = str.slice(str.length - this.s);
    if (ip === '0' && this.s > 0) ip = '';
    const out = (neg && n !== 0n ? '-' : '') + ip + (this.s > 0 ? '.' + fp : '');
    return out === '' ? '0' : out;
  }
}

function bcTokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const k = src.indexOf('*/', i + 2);
      i = k < 0 ? src.length : k + 2;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n' || c === ';') {
      toks.push({ t: 'sep', v: c });
      i++;
      continue;
    }
    let m;
    if ((m = /^[0-9A-F]+(\.[0-9A-F]*)?|^\.[0-9A-F]+/.exec(src.slice(i)))) {
      toks.push({ t: 'num', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ((m = /^[a-z_][a-z0-9_]*/.exec(src.slice(i)))) {
      toks.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if (c === '"') {
      const k = src.indexOf('"', i + 1);
      toks.push({ t: 'str', v: src.slice(i + 1, k < 0 ? src.length : k) });
      i = k < 0 ? src.length : k + 1;
      continue;
    }
    const ops = ['^=', '*=', '/=', '%=', '+=', '-=', '==', '<=', '>=', '!=', '&&', '||', '++', '--', '+', '-', '*', '/', '%', '^', '=', '<', '>', '!', '(', ')', '{', '}', '[', ']', ','];
    const op = ops.find((o) => src.startsWith(o, i));
    if (!op) throw new Error(`illegal character: ${c}`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  toks.push({ t: 'eof' });
  return toks;
}

class Bc {
  constructor(mathlib) {
    this.vars = new Map();
    this.arrays = new Map();
    this.funcs = new Map();
    this.scale = mathlib ? 20 : 0;
    this.ibase = 10;
    this.obase = 10;
    this.last = new Dec(0n);
    this.out = '';
    this.locals = [];
    if (mathlib) this.defineMath();
  }
  defineMath() {
    const self = this;
    const f = (fn) => ({ native: (args) => Dec.fromNumber(fn(...args.map((x) => x.toNumber())), self.scale).trunc(self.scale) });
    this.funcs.set('s', f(Math.sin));
    this.funcs.set('c', f(Math.cos));
    this.funcs.set('a', f(Math.atan));
    this.funcs.set('l', f(Math.log));
    this.funcs.set('e', f(Math.exp));
    this.funcs.set('j', { native: (args) => Dec.fromNumber(besselJ(Math.trunc(args[0].toNumber()), args[1].toNumber()), self.scale).trunc(self.scale) });
  }
  getVar(n) {
    for (let i = this.locals.length - 1; i >= 0 && i === this.locals.length - 1; i--) if (this.locals[i].has(n)) return this.locals[i].get(n);
    if (n === 'scale') return new Dec(BigInt(this.scale));
    if (n === 'ibase') return new Dec(BigInt(this.ibase));
    if (n === 'obase') return new Dec(BigInt(this.obase));
    if (n === 'last') return this.last;
    return this.vars.get(n) || new Dec(0n);
  }
  setVar(n, v) {
    const l = this.locals[this.locals.length - 1];
    if (l && l.has(n)) {
      l.set(n, v);
      return;
    }
    if (n === 'scale') this.scale = Math.max(0, Number(v.trunc(0).n));
    else if (n === 'ibase') this.ibase = Math.min(16, Math.max(2, Number(v.trunc(0).n)));
    else if (n === 'obase') this.obase = Math.max(2, Number(v.trunc(0).n));
    else this.vars.set(n, v);
  }
  fmt(v) {
    let s = v.toString(this.obase);
    // bc wraps long lines at 70 chars with backslash-newline
    let out = '';
    while (s.length > 69) {
      out += s.slice(0, 69) + '\\\n';
      s = s.slice(69);
    }
    return out + s;
  }
  run(src) {
    const toks = bcTokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => toks[p].t === 'op' && toks[p].v === v;
    const expect = (v) => {
      if (!isOp(v)) throw new Error(`syntax error`);
      p++;
    };
    const self = this;
    // parse into closures
    function primary() {
      const t = next();
      if (t.t === 'num') return () => Dec.from(t.v, self.ibase);
      if (t.t === 'op' && t.v === '(') {
        const e = expr();
        expect(')');
        return e;
      }
      if (t.t === 'op' && t.v === '-') {
        const e = unaryE();
        return () => new Dec(0n).sub(e());
      }
      if (t.t === 'op' && t.v === '!') {
        const e = unaryE();
        return () => new Dec(e().n === 0n ? 1n : 0n);
      }
      if (t.t === 'op' && (t.v === '++' || t.v === '--')) {
        const name = next().v;
        return () => {
          const v = self.getVar(name).add(new Dec(t.v === '++' ? 1n : -1n));
          self.setVar(name, v);
          return v;
        };
      }
      if (t.t === 'id') {
        const name = t.v;
        if (name === 'sqrt' || name === 'length' || name === 'scale' && isOp('(')) {
          expect('(');
          const e = expr();
          expect(')');
          if (name === 'sqrt') return () => e().sqrt(self.scale);
          if (name === 'length') return () => {
            const v = e();
            const s = (v.n < 0n ? -v.n : v.n).toString().replace(/^0+/, '');
            return new Dec(BigInt(Math.max(s.length, v.s, 1)));
          };
          return () => new Dec(BigInt(e().s));
        }
        if (name === 'read') {
          expect('(');
          expect(')');
          return () => new Dec(0n);
        }
        if (isOp('(')) {
          next();
          const args = [];
          if (!isOp(')')) {
            args.push(expr());
            while (isOp(',')) {
              next();
              args.push(expr());
            }
          }
          expect(')');
          return () => self.call(name, args.map((a) => a()));
        }
        if (isOp('[')) {
          next();
          const idx = expr();
          expect(']');
          const get = () => {
            const a = self.arrays.get(name) || new Map();
            return a.get(String(idx().trunc(0).n)) || new Dec(0n);
          };
          if (peek().t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(peek().v)) {
            const op = next().v;
            const r = expr();
            return () => {
              const k = String(idx().trunc(0).n);
              let v = r();
              if (op !== '=') v = self.binop(op[0], get(), v);
              if (!self.arrays.has(name)) self.arrays.set(name, new Map());
              self.arrays.get(name).set(k, v);
              return v;
            };
          }
          return get;
        }
        if (peek().t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(peek().v)) {
          const op = next().v;
          const r = expr();
          return () => {
            let v = r();
            if (op !== '=') v = self.binop(op[0], self.getVar(name), v);
            self.setVar(name, v);
            return v;
          };
        }
        if (isOp('++') || isOp('--')) {
          const op = next().v;
          return () => {
            const old = self.getVar(name);
            self.setVar(name, old.add(new Dec(op === '++' ? 1n : -1n)));
            return old;
          };
        }
        return () => self.getVar(name);
      }
      throw new Error('syntax error');
    }
    function unaryE() {
      return powE();
    }
    function powE() {
      const b = primary();
      if (isOp('^')) {
        next();
        const e = isOp('-') ? (next(), ((x) => () => new Dec(0n).sub(x()))(powE())) : powE();
        return () => b().pow(e(), self.scale);
      }
      return b;
    }
    function mulE() {
      let l = powE();
      while (isOp('*') || isOp('/') || isOp('%')) {
        const op = next().v;
        const r = powE();
        const ll = l;
        l = () => self.binop(op, ll(), r());
      }
      return l;
    }
    function addE() {
      let l = mulE();
      while (isOp('+') || isOp('-')) {
        const op = next().v;
        const r = mulE();
        const ll = l;
        l = () => self.binop(op, ll(), r());
      }
      return l;
    }
    function relE() {
      let l = addE();
      while (peek().t === 'op' && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v)) {
        const op = next().v;
        const r = addE();
        const ll = l;
        l = () => {
          const c = ll().cmp(r());
          return new Dec({ '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0, '==': c === 0, '!=': c !== 0 }[op] ? 1n : 0n);
        };
      }
      return l;
    }
    function andE() {
      let l = relE();
      while (isOp('&&')) {
        next();
        const r = relE();
        const ll = l;
        l = () => new Dec(ll().n !== 0n && r().n !== 0n ? 1n : 0n);
      }
      return l;
    }
    function expr() {
      let l = andE();
      while (isOp('||')) {
        next();
        const r = andE();
        const ll = l;
        l = () => new Dec(ll().n !== 0n || r().n !== 0n ? 1n : 0n);
      }
      return l;
    }
    function block() {
      expect('{');
      const stmts = [];
      while (!isOp('}')) {
        if (peek().t === 'sep') {
          next();
          continue;
        }
        if (peek().t === 'eof') throw new Error('syntax error: unexpected EOF');
        stmts.push(statement());
      }
      next();
      return () => {
        for (const s of stmts) s();
      };
    }
    function statement() {
      const t = peek();
      if (t.t === 'op' && t.v === '{') return block();
      if (t.t === 'str') {
        next();
        return () => (self.out += t.v.replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
      }
      if (t.t === 'id') {
        switch (t.v) {
          case 'quit':
            next();
            return () => {
              throw new QuitEx();
            };
          case 'halt':
            next();
            return () => {
              throw new QuitEx();
            };
          case 'print': {
            next();
            const items = [];
            do {
              if (peek().t === 'str') {
                const s = next().v;
                items.push(() => s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\'));
              } else {
                const e = expr();
                items.push(() => self.fmt(e()));
              }
            } while (isOp(',') && next());
            return () => {
              for (const i of items) self.out += i();
            };
          }
          case 'if': {
            next();
            expect('(');
            const c = expr();
            expect(')');
            while (peek().t === 'sep' && peek().v === '\n') next();
            const then = statement();
            let els = null;
            const save = p;
            while (peek().t === 'sep') next();
            if (peek().t === 'id' && peek().v === 'else') {
              next();
              els = statement();
            } else p = save;
            return () => (c().n !== 0n ? then() : els && els());
          }
          case 'while': {
            next();
            expect('(');
            const c = expr();
            expect(')');
            const body = statement();
            return () => {
              let guard = 0;
              while (c().n !== 0n) {
                if (++guard > 1e6) throw new Error('loop limit');
                try {
                  body();
                } catch (e) {
                  if (e instanceof BreakBc) break;
                  if (e instanceof ContinueBc) continue;
                  throw e;
                }
              }
            };
          }
          case 'for': {
            next();
            expect('(');
            const init = isOp(';') ? null : expr();
            next();
            const cond = peek().t === 'sep' ? null : expr();
            next();
            const step = isOp(')') ? null : expr();
            expect(')');
            const body = statement();
            return () => {
              let guard = 0;
              for (init && init(); !cond || cond().n !== 0n; step && step()) {
                if (++guard > 1e6) throw new Error('loop limit');
                try {
                  body();
                } catch (e) {
                  if (e instanceof BreakBc) break;
                  if (e instanceof ContinueBc) continue;
                  throw e;
                }
              }
            };
          }
          case 'break':
            next();
            return () => {
              throw new BreakBc();
            };
          case 'continue':
            next();
            return () => {
              throw new ContinueBc();
            };
          case 'return': {
            next();
            let e = null;
            if (isOp('(')) {
              next();
              e = isOp(')') ? null : expr();
              expect(')');
            } else if (peek().t !== 'sep' && !isOp('}') && peek().t !== 'eof') e = expr();
            return () => {
              throw new ReturnBc(e ? e() : new Dec(0n));
            };
          }
          case 'define': {
            next();
            const name = next().v;
            expect('(');
            const params = [];
            while (!isOp(')')) {
              params.push(next().v);
              if (isOp('[')) {
                next();
                expect(']');
              }
              if (isOp(',')) next();
            }
            next();
            while (peek().t === 'sep') next();
            // auto vars
            expect('{');
            const autos = [];
            while (peek().t === 'sep') next();
            if (peek().t === 'id' && peek().v === 'auto') {
              next();
              while (peek().t === 'id') {
                autos.push(next().v);
                if (isOp('[')) {
                  next();
                  expect(']');
                }
                if (isOp(',')) next();
              }
            }
            p--;
            toks[p] = { t: 'op', v: '{' };
            const body = block();
            return () => {
              self.funcs.set(name, { params, autos, body });
            };
          }
        }
      }
      const e = expr();
      const isAssign = toks.slice(0, p).reverse().find((x) => x.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(x.v));
      const startTok = t;
      const assignStmt = (() => {
        // statement is an assignment if its top-level operator was assignment
        let k = toks.indexOf(startTok);
        let depth = 0;
        for (; k < p; k++) {
          const x = toks[k];
          if (x.t === 'op' && (x.v === '(' || x.v === '[')) depth++;
          if (x.t === 'op' && (x.v === ')' || x.v === ']')) depth--;
          if (depth === 0 && x.t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(x.v)) return true;
        }
        return false;
      })();
      void isAssign;
      return () => {
        const v = e();
        if (!assignStmt) {
          self.last = v;
          self.out += self.fmt(v) + '\n';
        }
      };
    }
    const prog = [];
    while (peek().t !== 'eof') {
      if (peek().t === 'sep') {
        next();
        continue;
      }
      prog.push(statement());
    }
    for (const s of prog) s();
  }
  binop(op, a, b) {
    switch (op) {
      case '+':
        return a.add(b);
      case '-':
        return a.sub(b);
      case '*':
        return a.mul(b, this.scale);
      case '/':
        return a.div(b, this.scale);
      case '%':
        return a.mod(b, this.scale);
      case '^':
        return a.pow(b, this.scale);
    }
  }
  call(name, args) {
    const f = this.funcs.get(name);
    if (!f) throw new Error(`Function ${name} not defined.`);
    if (f.native) return f.native(args);
    const frame = new Map();
    f.params.forEach((p, i) => frame.set(p, args[i] || new Dec(0n)));
    for (const a of f.autos) frame.set(a, new Dec(0n));
    this.locals.push(frame);
    try {
      f.body();
      return new Dec(0n);
    } catch (e) {
      if (e instanceof ReturnBc) return e.v;
      throw e;
    } finally {
      this.locals.pop();
    }
  }
}
class QuitEx {}
class BreakBc {}
class ContinueBc {}
class ReturnBc {
  constructor(v) {
    this.v = v;
  }
}

function besselJ(n, x) {
  let sum = 0;
  for (let m = 0; m < 30; m++) {
    let f = 1;
    for (let k = 2; k <= m; k++) f *= k;
    let g = 1;
    for (let k = 2; k <= m + n; k++) g *= k;
    sum += ((m % 2 ? -1 : 1) / (f * g)) * (x / 2) ** (2 * m + n);
  }
  return sum;
}

async function bc(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'lqsiwv', long: { mathlib: 'l', quiet: 'q', standard: 's', interactive: 'i', warn: 'w', version: 'v' } });
  const b = new Bc(!!o.l);
  const runText = async (text) => {
    b.out = '';
    try {
      b.run(text);
    } catch (e) {
      await ctx.out(b.out);
      if (e instanceof QuitEx) return 'quit';
      const msg = e.message === 'Divide by zero' ? 'Runtime error (func=(main), adr=0): Divide by zero' : e.message;
      await ctx.err(`${msg.startsWith('Runtime') ? '' : '(standard_in) 1: '}${msg}\n`);
      return 'err';
    }
    await ctx.out(b.out);
    return 'ok';
  };
  for (const f of rest) {
    try {
      if ((await runText(ctx.vfs.readFile(f, ctx.cwd))) === 'quit') return 0;
    } catch (e) {
      await ctx.err(`File ${f} is unavailable.\n`);
      return 1;
    }
  }
  if (ctx.stdin.isTerminal) {
    if (!o.q) await ctx.out('bc 1.07.1\nCopyright 1991-1994, 1997, 1998, 2000, 2004, 2006, 2008, 2012-2017 Free Software Foundation, Inc.\nThis is free software with ABSOLUTELY NO WARRANTY.\nFor details type `warranty\'. \n');
    for (;;) {
      const line = await ctx.stdin.readLine();
      if (line === null) return 0;
      if ((await runText(line)) === 'quit') return 0;
    }
  }
  const text = await ctx.stdin.readAll();
  await runText(text);
  return 0;
}

// ---------- package management (simulated) ----------

export const PACKAGES = {
  cowsay: { version: '3.03+dfsg2-8', size: '18.6 kB', bins: ['cowsay', 'cowthink'], dir: '/usr/games', desc: 'configurable talking cow' },
  fortune: { pkg: 'fortune-mod', version: '1:1.99.1-7.3build1', size: '39.7 kB', bins: ['fortune'], dir: '/usr/games', desc: 'provides fortune cookies on demand' },
  'fortune-mod': { version: '1:1.99.1-7.3build1', size: '39.7 kB', bins: ['fortune'], dir: '/usr/games', desc: 'provides fortune cookies on demand' },
  sl: { version: '5.02-1', size: '12.9 kB', bins: ['sl'], dir: '/usr/games', desc: 'Correct you if you type `sl\' by mistake' },
  figlet: { version: '2.2.5-3', size: '133 kB', bins: ['figlet'], dir: '/usr/bin', desc: 'Make large character ASCII banners out of ordinary text' },
  cmatrix: { version: '2.0-6', size: '17.4 kB', bins: ['cmatrix'], dir: '/usr/bin', desc: 'simulates the display from "The Matrix"' },
  lolcat: { version: '100.0.1-3', size: '8,914 B', bins: ['lolcat'], dir: '/usr/games', desc: 'colorful `cat`' },
  neofetch: { version: '7.1.0-4', size: '81.6 kB', bins: ['neofetch'], dir: '/usr/bin', desc: 'Shows Linux System Information with Distribution Logo' },
  htop: { version: '3.3.0-4build1', size: '171 kB', bins: ['htop'], dir: '/usr/bin', desc: 'interactive processes viewer' },
  jq: { version: '1.7.1-3build1', size: '65.7 kB', bins: ['jq'], dir: '/usr/bin', desc: 'lightweight and flexible command-line JSON processor' },
  tree: { version: '2.1.1-2ubuntu3', size: '47.9 kB', bins: [], dir: '/usr/bin', desc: 'displays an indented directory tree, in color', preinstalled: true },
};

async function apt(ctx) {
  const sub = ctx.args.find((a) => !a.startsWith('-'));
  const pkgs = ctx.args.filter((a) => !a.startsWith('-') && a !== sub);
  const yes = ctx.args.includes('-y') || ctx.args.includes('--yes') || ctx.args.includes('-qq');
  const sh = ctx.shell;
  const installed = sh.system.installed;
  const isRoot = ctx.vfs.cred.uid === 0;
  const lockErr = async () => {
    await ctx.err(`E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n`);
    return 100;
  };
  const say = (s) => ctx.out(s);
  if (ctx.name === 'apt' && ctx.stdout && !ctx.stdout.isTerminalWriter && sub) await ctx.err('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n');
  switch (sub) {
    case undefined:
      await say('apt 2.7.14 (amd64)\nUsage: apt [options] command\n\nMost used commands:\n  list - list packages based on package names\n  search - search in package descriptions\n  show - show package details\n  install - install packages\n  remove - remove packages\n  update - update list of available packages\n  upgrade - upgrade the system by installing/upgrading packages\n\nThis is a simulation: a few packages can be "installed" (cowsay, fortune, sl, figlet, cmatrix, lolcat, neofetch, htop, jq).\n');
      return 0;
    case 'update': {
      if (!isRoot) return lockErr();
      const lines = [
        'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease',
        'Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]',
        'Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]',
        'Hit:4 http://archive.ubuntu.com/ubuntu noble-backports InRelease',
        'Fetched 252 kB in 1s (312 kB/s)',
        'Reading package lists... Done',
        'Building dependency tree... Done',
        'Reading state information... Done',
        'All packages are up to date.',
      ];
      for (const l of lines) {
        await sh.sleep(150 + Math.random() * 250);
        await say(l + '\n');
      }
      return 0;
    }
    case 'upgrade':
    case 'full-upgrade':
    case 'dist-upgrade':
      if (!isRoot) return lockErr();
      await say('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nCalculating upgrade... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
      return 0;
    case 'install':
    case 'reinstall': {
      if (!pkgs.length) {
        await say('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
        return 0;
      }
      if (!isRoot) return lockErr();
      await say('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n');
      const unknown = pkgs.filter((p) => !PACKAGES[p]);
      if (unknown.length) {
        await ctx.err(`E: Unable to locate package ${unknown[0]}\n`);
        return 100;
      }
      const todo = pkgs.filter((p) => !installed.has(PACKAGES[p].pkg || p) && !PACKAGES[p].preinstalled);
      for (const p of pkgs.filter((x) => !todo.includes(x))) await say(`${PACKAGES[p].pkg || p} is already the newest version (${PACKAGES[p].version}).\n`);
      if (!todo.length) {
        await say('0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
        return 0;
      }
      const names = todo.map((p) => PACKAGES[p].pkg || p);
      await say(`The following NEW packages will be installed:\n  ${names.join(' ')}\n0 upgraded, ${names.length} newly installed, 0 to remove and 0 not upgraded.\nNeed to get ${todo.map((p) => PACKAGES[p].size).join(' + ')} of archives.\nAfter this operation, ${(todo.length * 61.4).toFixed(1)} kB of additional disk space will be used.\n`);
      if (!yes && ctx.stdin.isTerminal && todo.length > 1) {
        await say('Do you want to continue? [Y/n] ');
        const ans = await ctx.stdin.readLine();
        if (ans !== null && /^[nN]/.test(ans)) {
          await say('Abort.\n');
          return 1;
        }
      }
      let k = 1;
      for (const p of todo) {
        await sh.sleep(300);
        await say(`Get:${k++} http://archive.ubuntu.com/ubuntu noble/universe amd64 ${PACKAGES[p].pkg || p} all ${PACKAGES[p].version} [${PACKAGES[p].size}]\n`);
      }
      await say(`Fetched ${todo.map((p) => PACKAGES[p].size).join(' + ')} in 1s\n`);
      for (const p of todo) {
        const name = PACKAGES[p].pkg || p;
        await sh.sleep(200);
        await say(`Selecting previously unselected package ${name}.\n(Reading database ... 74213 files and directories currently installed.)\nPreparing to unpack .../${name}_${PACKAGES[p].version.replace(/^\d+:/, '')}_all.deb ...\nUnpacking ${name} (${PACKAGES[p].version}) ...\nSetting up ${name} (${PACKAGES[p].version}) ...\n`);
        installed.add(name);
        for (const b of PACKAGES[p].bins) {
          ctx.vfs.put(`${PACKAGES[p].dir}/${b}`, elfStub(b), 0o755);
        }
      }
      await say('Processing triggers for man-db (2.12.0-4build2) ...\n');
      ctx.vfs.changed();
      sh.hash.clear();
      return 0;
    }
    case 'remove':
    case 'purge':
    case 'autoremove': {
      if (!isRoot) return lockErr();
      await say('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n');
      for (const p of pkgs) {
        const info = PACKAGES[p];
        if (!info || !installed.has(info.pkg || p)) {
          await say(`Package '${p}' is not installed, so not removed\n`);
          continue;
        }
        await say(`The following packages will be REMOVED:\n  ${info.pkg || p}\n0 upgraded, 0 newly installed, 1 to remove and 0 not upgraded.\nRemoving ${info.pkg || p} (${info.version}) ...\n`);
        installed.delete(info.pkg || p);
        for (const b of info.bins) {
          try {
            ctx.vfs.unlink(`${info.dir}/${b}`, '/');
          } catch {}
        }
      }
      sh.hash.clear();
      return 0;
    }
    case 'list': {
      await say('Listing... Done\n');
      const onlyInstalled = ctx.args.includes('--installed');
      for (const [p, info] of Object.entries(PACKAGES)) {
        if (info.pkg) continue;
        const inst = installed.has(p) || info.preinstalled;
        if (onlyInstalled && !inst) continue;
        await say(`${p}/noble ${info.version} amd64${inst ? ' [installed]' : ''}\n`);
      }
      if (onlyInstalled) for (const p of ['bash', 'coreutils', 'gawk', 'grep', 'sed', 'tar', 'gzip', 'findutils', 'diffutils', 'bc', 'nano', 'vim']) await say(`${p}/noble,now 1.0 amd64 [installed]\n`);
      return 0;
    }
    case 'search': {
      await say('Sorting... Done\nFull Text Search... Done\n');
      for (const [p, info] of Object.entries(PACKAGES)) {
        if (info.pkg) continue;
        if (pkgs.every((q) => p.includes(q) || info.desc.includes(q))) await say(`${p}/noble ${info.version} all\n  ${info.desc}\n\n`);
      }
      return 0;
    }
    case 'show': {
      for (const p of pkgs) {
        const info = PACKAGES[p];
        if (!info) {
          await ctx.err(`E: No packages found\n`);
          return 100;
        }
        await say(`Package: ${info.pkg || p}\nVersion: ${info.version}\nPriority: optional\nSection: universe/games\nOrigin: Ubuntu\nInstalled-Size: ${info.size}\nDownload-Size: ${info.size}\nAPT-Sources: http://archive.ubuntu.com/ubuntu noble/universe amd64 Packages\nDescription: ${info.desc}\n\n`);
      }
      return 0;
    }
    default:
      await ctx.err(`E: Invalid operation ${sub}\n`);
      return 100;
  }
}

// a tiny stand-in for an executable; the apparent size is stored inside so
// ls -l shows binary-like sizes without storing the bytes
export function elfStub(name) {
  let h = 7;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const size = 14328 + (h % 140000);
  return `\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0BASHSIM:${name}\0SIZE:${size}\0`;
}

async function dpkg(ctx) {
  const sh = ctx.shell;
  if (ctx.args[0] === '-l' || ctx.args[0] === '--list') {
    let out = 'Desired=Unknown/Install/Remove/Purge/Hold\n| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend\n|/ Err?=(none)/Reinst-required (Status,Err: uppercase=bad)\n||/ Name           Version          Architecture Description\n+++-==============-================-============-=================================\n';
    const base = [['bash', '5.2.21-2ubuntu4', 'GNU Bourne Again SHell'], ['coreutils', '9.4-3ubuntu6', 'GNU core utilities'], ['gawk', '1:5.2.1-2build3', 'GNU awk, a pattern scanning and processing language'], ['grep', '3.11-4build1', 'GNU grep, egrep and fgrep'], ['nano', '7.2-2build1', 'small, friendly text editor inspired by Pico'], ['sed', '4.9-2build1', 'GNU stream editor for filtering/transforming text'], ['tar', '1.35+dfsg-3build1', 'GNU version of the tar archiving utility'], ['vim', '2:9.1.0016-1ubuntu7', 'Vi IMproved - enhanced vi editor']];
    for (const p of sh.system.installed) base.push([p, PACKAGES[p]?.version || '1.0', PACKAGES[p]?.desc || '']);
    for (const [n, v, d] of base.sort()) out += `ii  ${n.padEnd(14)} ${v.padEnd(16)} amd64        ${d}\n`;
    await ctx.out(out);
    return 0;
  }
  if (ctx.args[0] === '-s' || ctx.args[0] === '--status') {
    const p = ctx.args[1];
    if (['bash', 'coreutils', 'grep', 'sed', 'nano', 'vim', 'tar', 'gawk'].includes(p) || sh.system.installed.has(p)) {
      await ctx.out(`Package: ${p}\nStatus: install ok installed\nPriority: required\nArchitecture: amd64\n`);
      return 0;
    }
    await ctx.err(`dpkg-query: package '${p}' is not installed and no information is available\n`);
    return 1;
  }
  await ctx.err('dpkg: error: need an action option\n\nType dpkg --help for help about installing and deinstalling packages [*];\nUse \'apt\' or \'aptitude\' for user-friendly package management;\n');
  return 2;
}

async function snap(ctx) {
  await ctx.err('error: cannot communicate with server: Post "http://localhost/v2/snaps": dial unix /run/snapd.socket: connect: no such file or directory\n');
  return 1;
}

// ---------- services (simulated) ----------

const SERVICES = {
  ssh: { desc: 'OpenBSD Secure Shell server', pid: 744, active: true, enabled: true, cmd: '/usr/sbin/sshd -D' },
  cron: { desc: 'Regular background program processing daemon', pid: 688, active: true, enabled: true, cmd: '/usr/sbin/cron -f -P' },
  rsyslog: { desc: 'System Logging Service', pid: 705, active: true, enabled: true, cmd: '/usr/sbin/rsyslogd -n -iNONE' },
  'systemd-resolved': { desc: 'Network Name Resolution', pid: 602, active: true, enabled: true, cmd: '/lib/systemd/systemd-resolved' },
  'dbus': { desc: 'D-Bus System Message Bus', pid: 691, active: true, enabled: true, cmd: '@dbus-daemon --system' },
};

async function systemctl(ctx) {
  const args = ctx.args.filter((a) => !a.startsWith('-'));
  const [sub = 'list-units', ...units] = args;
  const svc = (u) => SERVICES[u.replace(/\.service$/, '')];
  const needRoot = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask', 'daemon-reload', 'reboot', 'poweroff', 'halt'];
  if (needRoot.includes(sub) && ctx.vfs.cred.uid !== 0) {
    await ctx.err(`Failed to ${sub} ${units[0] || ''}${units[0] && !units[0].includes('.') ? '.service' : ''}: Interactive authentication required.\nSee system logs and 'systemctl status ${units[0] || ''}' for details.\n`);
    return 1;
  }
  switch (sub) {
    case 'status': {
      if (!units.length) {
        await ctx.out(`● ${ctx.shell.system.hostname}\n    State: running\n    Units: 243 loaded (incl. loaded aliases)\n     Jobs: 0 queued\n   Failed: 0 units\n    Since: ${strftime(new Date(ctx.shell.system.boot), '%a %Y-%m-%d %H:%M:%S %Z')}\n`);
        return 0;
      }
      let st = 0;
      for (const u of units) {
        const s = svc(u);
        const name = u.replace(/\.service$/, '');
        if (!s) {
          await ctx.err(`Unit ${name}.service could not be found.\n`);
          st = 4;
          continue;
        }
        const since = strftime(new Date(ctx.shell.system.boot + 30000), '%a %Y-%m-%d %H:%M:%S %Z');
        await ctx.out(`${s.active ? '\x1b[0;1;32m●\x1b[0m' : '○'} ${name}.service - ${s.desc}\n     Loaded: loaded (/usr/lib/systemd/system/${name}.service; ${s.enabled ? 'enabled' : 'disabled'}; preset: enabled)\n     Active: ${s.active ? `\x1b[0;1;32mactive (running)\x1b[0m since ${since}` : 'inactive (dead)'}\n${s.active ? `   Main PID: ${s.pid} (${name})\n      Tasks: 1 (limit: 19020)\n     Memory: 2.1M (peak: 2.6M)\n        CPU: 41ms\n     CGroup: /system.slice/${name}.service\n             └─${s.pid} ${s.cmd}\n` : ''}\n`);
        if (!s.active) st = 3;
      }
      return st;
    }
    case 'start':
    case 'restart':
    case 'reload':
      for (const u of units) {
        const s = svc(u);
        if (!s) {
          await ctx.err(`Failed to ${sub} ${u}.service: Unit ${u}.service not found.\n`);
          return 5;
        }
        s.active = true;
      }
      return 0;
    case 'stop':
      for (const u of units) {
        const s = svc(u);
        if (s) s.active = false;
      }
      return 0;
    case 'enable':
    case 'disable':
      for (const u of units) {
        const s = svc(u);
        if (!s) {
          await ctx.err(`Failed to ${sub} unit: Unit file ${u}.service does not exist.\n`);
          return 1;
        }
        s.enabled = sub === 'enable';
        if (sub === 'enable') await ctx.err(`Synchronizing state of ${u}.service with SysV service script with /usr/lib/systemd/systemd-sysv-install.\nExecuting: /usr/lib/systemd/systemd-sysv-install enable ${u}\n`);
      }
      return 0;
    case 'is-active':
      for (const u of units) await ctx.out((svc(u)?.active ? 'active' : 'inactive') + '\n');
      return units.every((u) => svc(u)?.active) ? 0 : 3;
    case 'is-enabled':
      for (const u of units) await ctx.out((svc(u)?.enabled ? 'enabled' : svc(u) ? 'disabled' : 'not-found') + '\n');
      return units.every((u) => svc(u)?.enabled) ? 0 : 1;
    case 'list-units':
    case 'list-unit-files': {
      let out = sub === 'list-units' ? '  UNIT                             LOAD   ACTIVE SUB     DESCRIPTION\n' : 'UNIT FILE                        STATE   PRESET\n';
      for (const [n, s] of Object.entries(SERVICES)) {
        out += sub === 'list-units' ? `  ${(n + '.service').padEnd(32)} loaded ${s.active ? 'active  running' : 'inactive dead  '} ${s.desc}\n` : `${(n + '.service').padEnd(32)} ${s.enabled ? 'enabled ' : 'disabled'} enabled\n`;
      }
      out += `\n${Object.keys(SERVICES).length} ${sub === 'list-units' ? 'loaded units listed.' : 'unit files listed.'}\n`;
      await ctx.out(out);
      return 0;
    }
    case 'daemon-reload':
      return 0;
    case 'reboot':
    case 'poweroff':
    case 'halt':
      throw new ExitEx({ restart: true, code: 0, reboot: sub });
    default:
      await ctx.err(`Unknown command verb '${sub}'.\n`);
      return 1;
  }
}

async function service(ctx) {
  const [name, action] = ctx.args;
  if (ctx.args[0] === '--status-all') {
    for (const [n, s] of Object.entries(SERVICES)) await ctx.out(` [ ${s.active ? '+' : '-'} ]  ${n}\n`);
    return 0;
  }
  if (!name || !action) {
    await ctx.err('Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n');
    return 1;
  }
  return ctx.shell.runCommand(['systemctl', action, name], ctx.io, { skipFunctions: true });
}

async function journalctl(ctx) {
  let text = '';
  try {
    text = ctx.vfs.readFile('/var/log/syslog', '/');
  } catch (e) {
    await ctx.err(`Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n`);
    return 0;
  }
  const n = ctx.args.includes('-n') ? Number(ctx.args[ctx.args.indexOf('-n') + 1]) : null;
  let lines = splitLines(text);
  if (n) lines = lines.slice(-n);
  await ctx.out(lines.map((l) => l + '\n').join(''));
  return 0;
}

async function shutdown(ctx) {
  if (ctx.vfs.cred.uid !== 0) {
    await ctx.err('Call to PowerOff failed: Interactive authentication required.\n');
    return 1;
  }
  if (ctx.args.includes('-c')) return 0;
  await ctx.out(`Broadcast message from root@${ctx.shell.system.hostname} on pts/0 (${strftime(new Date(), '%a %Y-%m-%d %H:%M:%S %Z')}):\n\nThe system will ${ctx.name === 'reboot' || ctx.args.includes('-r') ? 'reboot' : 'power off'} now!\n\n`);
  await ctx.shell.sleep(1200);
  throw new ExitEx({ restart: true, code: 0, reboot: ctx.name === 'reboot' || ctx.args.includes('-r') ? 'reboot' : 'poweroff' });
}

// ---------- disks ----------

async function lsblk(ctx) {
  await ctx.out(`NAME    MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
loop0     7:0    0 63.9M  1 loop /snap/core20/2318
loop1     7:1    0 87.0M  1 loop /snap/lxd/29351
sda       8:0    0   30G  0 disk
├─sda1    8:1    0 29.9G  0 part /
├─sda14   8:14   0    4M  0 part
└─sda15   8:15   0  106M  0 part /boot/efi
sr0      11:0    1 1024M  0 rom
`);
  return 0;
}

async function mount(ctx) {
  if (ctx.args.length) {
    if (ctx.vfs.cred.uid !== 0) {
      await ctx.err('mount: only root can do that.\n');
      return 1;
    }
    await ctx.err(`mount: ${ctx.args[ctx.args.length - 1]}: special device ${ctx.args[0]} does not exist.\n`);
    return 32;
  }
  await ctx.out(`/dev/sda1 on / type ext4 (rw,relatime,discard,errors=remount-ro)
proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)
sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)
devpts on /dev/pts type devpts (rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000)
tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=1629384k,mode=755,inode64)
tmpfs on /dev/shm type tmpfs (rw,nosuid,nodev,inode64)
/dev/sda15 on /boot/efi type vfat (rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=iso8859-1,shortname=mixed,errors=remount-ro)
tmpfs on /run/user/1000 type tmpfs (rw,nosuid,nodev,relatime,size=1629380k,nr_inodes=407345,mode=700,uid=1000,gid=1000,inode64)
`);
  return 0;
}

async function dmesg(ctx) {
  if (ctx.vfs.cred.uid !== 0) {
    await ctx.err('dmesg: read kernel buffer failed: Operation not permitted\n');
    return 1;
  }
  await ctx.out(`[    0.000000] Linux version 6.8.0-48-generic (buildd@lcy02-amd64-040) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0, GNU ld (GNU Binutils for Ubuntu) 2.42) #48-Ubuntu SMP PREEMPT_DYNAMIC Fri Sep 27 14:04:52 UTC 2024 (Ubuntu 6.8.0-48.48-generic 6.8.12)
[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-48-generic root=UUID=4f2a7c1e ro console=tty1 console=ttyS0
[    0.000000] KERNEL supported cpus:
[    0.000000]   Intel GenuineIntel
[    0.004211] DMI: QEMU Standard PC (i440FX + PIIX, 1996), BIOS 1.16.3 04/01/2014
[    0.412353] smpboot: Allowing 4 CPUs, 0 hotplug CPUs
[    1.208734] EXT4-fs (sda1): mounted filesystem 4f2a7c1e r/w with ordered data mode. Quota mode: none.
[    2.981102] systemd[1]: Hostname set to <${ctx.shell.system.hostname}>.
[    3.320077] virtio_net virtio0 ens3: renamed from eth0
`);
  return 0;
}

// ---------- network (simulated, the browser sandbox has no raw network) ----------

function fakeIp(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${(h % 200) + 20}.${(h >>> 8) % 256}.${(h >>> 16) % 256}.${((h >>> 24) % 250) + 2}`;
}

function resolveHost(ctx, host) {
  if (host === 'localhost' || host === '127.0.0.1' || host === ctx.shell.system.hostname) return '127.0.0.1';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  try {
    const hosts = ctx.vfs.readFile('/etc/hosts', '/');
    for (const l of splitLines(hosts)) {
      const parts = l.trim().split(/\s+/);
      if (parts.slice(1).includes(host)) return parts[0];
    }
  } catch {}
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  return fakeIp(host);
}

async function ping(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'qn46', params: 'ciWsw', long: {} });
  const host = rest[0];
  if (!host) {
    await ctx.err('ping: usage error: Destination address required\n');
    return 1;
  }
  const ip = resolveHost(ctx, host);
  if (!ip) {
    await ctx.err(`ping: ${host}: Temporary failure in name resolution\n`);
    return 2;
  }
  const local = ip.startsWith('127.');
  const count = o.c ? Number(o.c) : Infinity;
  const interval = Number(o.i || 1) * 1000;
  const size = Number(o.s || 56);
  await ctx.out(`PING ${host} (${ip}) ${size}(${size + 28}) bytes of data.\n`);
  const times = [];
  let sent = 0;
  const t0 = Date.now();
  const base = local ? 0.03 : 8 + (parseInt(ip.split('.')[1], 10) % 60);
  const summary = async () => {
    const recv = times.length;
    await ctx.out(`\n--- ${host} ping statistics ---\n${sent} packets transmitted, ${recv} received, ${sent ? Math.round((100 * (sent - recv)) / sent) : 0}% packet loss, time ${Date.now() - t0}ms\n`);
    if (recv) {
      const min = Math.min(...times);
      const max = Math.max(...times);
      const avg = times.reduce((a, b) => a + b, 0) / recv;
      const mdev = Math.sqrt(times.reduce((a, b) => a + (b - avg) ** 2, 0) / recv);
      await ctx.out(`rtt min/avg/max/mdev = ${min.toFixed(3)}/${avg.toFixed(3)}/${max.toFixed(3)}/${mdev.toFixed(3)} ms\n`);
    }
  };
  try {
    while (sent < count) {
      sent++;
      const t = base + Math.random() * (local ? 0.05 : base * 0.2);
      await ctx.shell.sleep(Math.min(t, 500));
      times.push(t);
      if (!o.q) await ctx.out(`64 bytes from ${local ? 'localhost' : host === ip ? ip : `${host} (${ip})`}: icmp_seq=${sent} ttl=${local ? 64 : 117} time=${t < 1 ? t.toFixed(3) : t.toFixed(1)} ms\n`);
      if (sent < count) await ctx.shell.sleep(Math.max(0, interval - Math.min(t, 500)));
    }
  } catch (e) {
    if (e instanceof InterruptEx) {
      ctx.shell.ctl.interrupted = false;
      await ctx.out('^C');
      await summary();
      return 0;
    }
    throw e;
  }
  await summary();
  return 0;
}

const CANNED = {
  'example.com': '<!doctype html>\n<html>\n<head>\n    <title>Example Domain</title>\n</head>\n<body>\n<div>\n    <h1>Example Domain</h1>\n    <p>This domain is for use in illustrative examples in documents. You may use this\n    domain in literature without prior coordination or asking for permission.</p>\n    <p><a href="https://www.iana.org/domains/example">More information...</a></p>\n</div>\n</body>\n</html>\n',
  'ifconfig.me': '203.0.113.42',
  'icanhazip.com': '203.0.113.42\n',
  'api.ipify.org': '203.0.113.42',
  'wttr.in': 'Weather report: Bucharest\n\n     \\   /     Sunny\n      .-.      +17(15) °C\n   ― (   ) ―   ↙ 9 km/h\n      `-’      10 km\n     /   \\     0.0 mm\n',
  'httpbin.org/get': '{\n  "args": {}, \n  "headers": {\n    "Accept": "*/*", \n    "Host": "httpbin.org", \n    "User-Agent": "curl/8.5.0"\n  }, \n  "origin": "203.0.113.42", \n  "url": "https://httpbin.org/get"\n}\n',
  'httpbin.org/ip': '{\n  "origin": "203.0.113.42"\n}\n',
};

function canned(url) {
  const m = /^(?:(https?):\/\/)?([^/:?#]+)(?::\d+)?(\/[^?#]*)?/i.exec(url);
  if (!m) return null;
  const host = m[2].replace(/^www\./, '');
  const path = (m[3] || '/').replace(/\/$/, '');
  return { host, path, body: CANNED[host + path] ?? (path === '' ? CANNED[host] : undefined) };
}

async function curl(ctx) {
  const { o, rest } = getopt(ctx.args, {
    flags: 'sSLIikfvOJ#',
    params: 'oXHdAuemw',
    long: { silent: 's', 'show-error': 'S', location: 'L', head: 'I', include: 'i', insecure: 'k', fail: 'f', verbose: 'v', output: 'o', 'remote-name': 'O', request: 'X', header: 'H', data: 'd', 'user-agent': 'A', user: 'u', 'max-time': 'm', 'write-out': 'w', version: 'V', 'connect-timeout': '=', compressed: '', 'fail-with-body': '' },
    multi: 'H',
  });
  if (ctx.args.includes('--version') || ctx.args.includes('-V')) {
    await ctx.out('curl 8.5.0 (x86_64-pc-linux-gnu) libcurl/8.5.0 OpenSSL/3.0.13 zlib/1.3 brotli/1.1.0 zstd/1.5.5 libidn2/2.3.7 libpsl/0.21.2 (+libidn2/2.3.7) libssh/0.10.6/openssl/zlib nghttp2/1.59.0 librtmp/2.3 OpenLDAP/2.6.7\nRelease-Date: 2023-12-06, security patched: 8.5.0-2ubuntu10.4\nProtocols: dict file ftp ftps gopher gophers http https imap imaps ldap ldaps mqtt pop3 pop3s rtmp rtsp scp sftp smb smbs smtp smtps telnet tftp\n');
    return 0;
  }
  const url = rest[0];
  if (!url) {
    await ctx.err("curl: try 'curl --help' or 'curl --manual' for more information\n");
    return 2;
  }
  if (url.startsWith('file://')) {
    try {
      await ctx.out(ctx.vfs.readFile(url.slice(7), ctx.cwd));
      return 0;
    } catch (e) {
      await ctx.err(`curl: (37) Couldn't open file ${url.slice(7)}\n`);
      return 37;
    }
  }
  const c = canned(url);
  if (!c || !resolveHost(ctx, c.host)) {
    if (!o.s || o.S) await ctx.err(`curl: (6) Could not resolve host: ${c ? c.host : url}\n`);
    return 6;
  }
  await ctx.shell.sleep(250);
  if (c.body === undefined) {
    if (!o.s || o.S) await ctx.err(`curl: (7) Failed to connect to ${c.host} port 443 after 129 ms: Couldn't connect to server\n(this browser simulation has no real network access; try: curl example.com, curl ifconfig.me, curl wttr.in)\n`);
    return 7;
  }
  const headers = `HTTP/2 200 \ncontent-type: ${c.body.startsWith('{') ? 'application/json' : c.body.startsWith('<') ? 'text/html; charset=UTF-8' : 'text/plain; charset=utf-8'}\ncontent-length: ${c.body.length}\ndate: ${new Date().toUTCString()}\nserver: nginx\n\n`;
  let body = c.body;
  if (o.I) body = headers;
  else if (o.i) body = headers + body;
  if (o.o || o.O) {
    const name = o.o || c.path.split('/').pop() || 'index.html';
    ctx.vfs.writeFile(name, ctx.cwd, body, { umask: ctx.shell.umask });
    if (!o.s) await ctx.err(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${String(body.length).padStart(4)}  100  ${String(body.length).padStart(4)}    0     0   5123      0 --:--:-- --:--:-- --:--:--  5153\n`);
  } else await ctx.out(body);
  if (o.w) await ctx.out(o.w.replace(/%\{http_code\}/g, '200').replace(/%\{size_download\}/g, String(body.length)).replace(/\\n/g, '\n'));
  return 0;
}

async function wget(ctx) {
  const { o, rest } = getopt(ctx.args, { flags: 'qOcnvS', params: 'OPT', long: { quiet: 'q', 'output-document': 'O', 'no-verbose': 'n' } });
  const url = rest[0];
  if (!url) {
    await ctx.err("wget: missing URL\nUsage: wget [OPTION]... [URL]...\n\nTry `wget --help' for more options.\n");
    return 1;
  }
  const c = canned(url);
  const ts = strftime(new Date(), '%Y-%m-%d %H:%M:%S');
  const full = /^https?:/.test(url) ? url : `http://${url}/`;
  if (!o.q) await ctx.err(`--${ts}--  ${full}\nResolving ${c?.host || url} (${c?.host || url})... `);
  if (!c || c.body === undefined) {
    if (!o.q) await ctx.err(c && resolveHost(ctx, c.host) ? `${fakeIp(c.host)}\nConnecting to ${c.host} (${c.host})|${fakeIp(c.host)}|:443... failed: Network is unreachable (browser simulation).\n` : `failed: Name or service not known.\nwget: unable to resolve host address '${c?.host || url}'\n`);
    return 4;
  }
  const name = o.O || c.path.split('/').pop() || 'index.html';
  if (!o.q) await ctx.err(`${fakeIp(c.host)}\nConnecting to ${c.host} (${c.host})|${fakeIp(c.host)}|:443... connected.\nHTTP request sent, awaiting response... 200 OK\nLength: ${c.body.length} [text/html]\nSaving to: '${name}'\n\n${name.padEnd(20)}100%[===================>]   ${c.body.length}  --.-KB/s    in 0s      \n\n${ts} (24.3 MB/s) - '${name}' saved [${c.body.length}/${c.body.length}]\n\n`);
  if (name === '-') await ctx.out(c.body);
  else ctx.vfs.writeFile(name, ctx.cwd, c.body, { umask: ctx.shell.umask });
  return 0;
}

async function ssh(ctx) {
  const target = ctx.args.find((a) => !a.startsWith('-'));
  if (!target) {
    await ctx.err('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]\n           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n           destination [command [argument ...]]\n');
    return 255;
  }
  const host = target.split('@').pop();
  if (!resolveHost(ctx, host)) {
    await ctx.err(`ssh: Could not resolve hostname ${host}: Temporary failure in name resolution\n`);
    return 255;
  }
  await ctx.shell.sleep(800);
  await ctx.err(`ssh: connect to host ${host} port 22: Network is unreachable\n`);
  return 255;
}

async function nslookup(ctx) {
  const host = ctx.args.find((a) => !a.startsWith('-'));
  if (!host) return 1;
  const ip = resolveHost(ctx, host);
  if (ctx.name === 'host') {
    if (!ip) {
      await ctx.out(`Host ${host} not found: 3(NXDOMAIN)\n`);
      return 1;
    }
    await ctx.out(`${host} has address ${ip}\n`);
    return 0;
  }
  if (ctx.name === 'dig') {
    const short = ctx.args.includes('+short');
    if (short) {
      if (ip) await ctx.out(ip + '\n');
      return 0;
    }
    await ctx.out(`\n; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ${host}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${ip ? 'NOERROR' : 'NXDOMAIN'}, id: ${1000 + Math.floor(Math.random() * 60000)}\n;; flags: qr rd ra; QUERY: 1, ANSWER: ${ip ? 1 : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${host}.\t\t\tIN\tA\n\n${ip ? `;; ANSWER SECTION:\n${host}.\t\t300\tIN\tA\t${ip}\n\n` : ''};; Query time: 12 msec\n;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)\n;; WHEN: ${strftime(new Date(), '%a %b %d %H:%M:%S %Z %Y')}\n;; MSG SIZE  rcvd: 56\n\n`);
    return 0;
  }
  await ctx.out(`Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\n`);
  if (!ip) {
    await ctx.out(`** server can't find ${host}: NXDOMAIN\n\n`);
    return 1;
  }
  await ctx.out(`Non-authoritative answer:\nName:\t${host}\nAddress: ${ip}\n\n`);
  return 0;
}

async function ip(ctx) {
  const [obj = 'help', sub] = ctx.args.filter((a) => !a.startsWith('-'));
  const brief = ctx.args.includes('-br') || ctx.args.includes('-brief');
  if (/^a(d(dr?)?)?$/.test(obj) || obj === 'address') {
    if (brief) {
      await ctx.out('lo               UNKNOWN        127.0.0.1/8 ::1/128 \nens3             UP             10.0.2.15/24 fe80::5054:ff:fe12:3456/64 \n');
      return 0;
    }
    await ctx.out(`1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000
    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
    inet 127.0.0.1/8 scope host lo
       valid_lft forever preferred_lft forever
    inet6 ::1/128 scope host noprefixroute
       valid_lft forever preferred_lft forever
2: ens3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff
    altname enp0s3
    inet 10.0.2.15/24 metric 100 brd 10.0.2.255 scope global dynamic ens3
       valid_lft 85642sec preferred_lft 85642sec
    inet6 fe80::5054:ff:fe12:3456/64 scope link
       valid_lft forever preferred_lft forever
`);
    return 0;
  }
  if (/^r(o(u(te?)?)?)?$/.test(obj)) {
    await ctx.out('default via 10.0.2.2 dev ens3 proto dhcp src 10.0.2.15 metric 100 \n10.0.2.0/24 dev ens3 proto kernel scope link src 10.0.2.15 metric 100 \n10.0.2.2 dev ens3 proto dhcp scope link src 10.0.2.15 metric 100 \n');
    return 0;
  }
  if (/^l(i(nk?)?)?$/.test(obj)) {
    await ctx.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n2: ens3: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\n    link/ether 52:54:00:12:34:56 brd ff:ff:ff:ff:ff:ff\n    altname enp0s3\n');
    return 0;
  }
  if (/^n(e(i(gh?)?)?)?$/.test(obj)) {
    await ctx.out('10.0.2.2 dev ens3 lladdr 52:55:0a:00:02:02 REACHABLE\n');
    return 0;
  }
  void sub;
  await ctx.err('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\n       ip [ -force ] -batch filename\nwhere  OBJECT := { address | addrlabel | amt | fou | help | ila | ioam | l2tp |\n                   link | macsec | maddress | monitor | mptcp | mroute | mrule |\n                   neighbor | neighbour | netconf | netns | nexthop | ntable |\n                   ntbl | route | rule | sr | stats | tap | tcpmetrics |\n                   token | tunnel | tuntap | vrf | xfrm }\n');
  return 255;
}

async function ifconfig(ctx) {
  await ctx.out(`ens3: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 10.0.2.15  netmask 255.255.255.0  broadcast 10.0.2.255
        inet6 fe80::5054:ff:fe12:3456  prefixlen 64  scopeid 0x20<link>
        ether 52:54:00:12:34:56  txqueuelen 1000  (Ethernet)
        RX packets 48213  bytes 61234567 (61.2 MB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 21987  bytes 2345678 (2.3 MB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0

lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
        inet6 ::1  prefixlen 128  scopeid 0x10<host>
        loop  txqueuelen 1000  (Local Loopback)
        RX packets 312  bytes 28456 (28.4 KB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 312  bytes 28456 (28.4 KB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0

`);
  return 0;
}

async function ss(ctx) {
  await ctx.out(`Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
udp   UNCONN 0      0         127.0.0.53%lo:53         0.0.0.0:*
udp   UNCONN 0      0        10.0.2.15%ens3:68         0.0.0.0:*
tcp   LISTEN 0      4096      127.0.0.53%lo:53         0.0.0.0:*
tcp   LISTEN 0      4096            0.0.0.0:22         0.0.0.0:*
tcp   ESTAB  0      0             10.0.2.15:22    192.168.1.10:51834
tcp   LISTEN 0      4096               [::]:22            [::]:*
`);
  return 0;
}

async function netstat(ctx) {
  await ctx.out(`Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State
tcp        0      0 127.0.0.53:53           0.0.0.0:*               LISTEN
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN
tcp6       0      0 :::22                   :::*                    LISTEN
udp        0      0 127.0.0.53:53           0.0.0.0:*
udp        0      0 10.0.2.15:68            0.0.0.0:*
`);
  return 0;
}

async function traceroute(ctx) {
  const host = ctx.args.find((a) => !a.startsWith('-'));
  if (!host) {
    await ctx.err('Usage: traceroute [ -46dFITnreAUDV ] [ -f first_ttl ] [ -g gate,... ] [ -i device ] [ -m max_ttl ] [ -N squeries ] [ -p port ] [ -t tos ] [ -l flow_label ] [ -w MAX,HERE,NEAR ] [ -q nqueries ] [ -s src_addr ] [ -z sendwait ] [ --fwmark=num ] host [ packetlen ]\n');
    return 2;
  }
  const ipAddr = resolveHost(ctx, host);
  if (!ipAddr) {
    await ctx.err(`${host}: Name or service not known\nCannot handle "host" cmdline arg \`${host}' on position 1 (argc 1)\n`);
    return 2;
  }
  await ctx.out(`traceroute to ${host} (${ipAddr}), 30 hops max, 60 byte packets\n`);
  const hops = ['_gateway (10.0.2.2)', '192.168.1.1 (192.168.1.1)', '10.120.0.1 (10.120.0.1)', '* * *', `${host} (${ipAddr})`];
  for (let i = 0; i < hops.length; i++) {
    await ctx.shell.sleep(300);
    const t = () => (1 + i * 4 + Math.random() * 2).toFixed(3);
    await ctx.out(` ${i + 1}  ${hops[i] === '* * *' ? '* * *' : `${hops[i]}  ${t()} ms  ${t()} ms  ${t()} ms`}\n`);
  }
  return 0;
}

// ---------- misc ----------

async function locale(ctx) {
  if (ctx.args.includes('-a')) {
    await ctx.out('C\nC.utf8\nen_US.utf8\nPOSIX\n');
    return 0;
  }
  const lang = ctx.shell.getVar('LANG') || 'C.UTF-8';
  const all = ctx.shell.getVar('LC_ALL') || '';
  let out = `LANG=${lang}\nLANGUAGE=\n`;
  for (const k of ['LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME', 'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION']) out += `${k}="${all || ctx.shell.getVar(k) || lang}"\n`;
  out += `LC_ALL=${all}\n`;
  await ctx.out(out);
  return 0;
}

async function lsbRelease(ctx) {
  const { o } = getopt(ctx.args, { flags: 'aidrcs', long: { all: 'a', id: 'i', description: 'd', release: 'r', codename: 'c', short: 's' } });
  const all = o.a || (!o.i && !o.d && !o.r && !o.c);
  const f = [
    ['i', 'Distributor ID', 'Ubuntu'],
    ['d', 'Description', 'Ubuntu 24.04.1 LTS'],
    ['r', 'Release', '24.04'],
    ['c', 'Codename', 'noble'],
  ];
  if (all && !o.s) await ctx.err('No LSB modules are available.\n');
  for (const [k, label, v] of f) {
    if (!(all && (o.a || k !== 'x')) && !o[k]) continue;
    if (!o.a && all && !o[k] && !(k === 'd')) continue;
    await ctx.out(o.s ? v + '\n' : `${(label + ':').padEnd(16)}${v}\n`);
  }
  return 0;
}

async function logger(ctx) {
  const msg = ctx.args.filter((a) => !a.startsWith('-')).join(' ') || (await ctx.stdin.readAll()).trim();
  const line = `${strftime(new Date(), '%Y-%m-%dT%H:%M:%S.%6N%:z')} ${ctx.shell.system.hostname} ${ctx.shell.user.name}: ${msg}\n`;
  try {
    const saved = ctx.vfs.cred;
    ctx.vfs.cred = { uid: 0, gid: 0, groups: [0] };
    ctx.vfs.writeFile('/var/log/syslog', '/', line, { append: true });
    ctx.vfs.cred = saved;
  } catch {}
  return 0;
}

async function wall(ctx) {
  const msg = ctx.args.join(' ') || (await ctx.stdin.readAll()).trim();
  const term = ctx.shell.term;
  const text = `\nBroadcast message from ${ctx.shell.user.name}@${ctx.shell.system.hostname} (pts/0) (${strftime(new Date(), '%a %b %e %H:%M:%S %Y')}):\n\n${msg}\n\n`;
  if (term) term.write(text);
  else await ctx.out(text);
  return 0;
}

async function crontab(ctx) {
  const user = ctx.shell.system.userName(ctx.vfs.cred.uid);
  const file = `/var/spool/cron/crontabs/${user}`;
  const asRoot = (fn) => {
    const saved = ctx.vfs.cred;
    ctx.vfs.cred = { uid: 0, gid: 0, groups: [0] };
    try {
      return fn();
    } finally {
      ctx.vfs.cred = saved;
    }
  };
  if (ctx.args.includes('-l')) {
    try {
      await ctx.out(asRoot(() => ctx.vfs.readFile(file, '/')));
      return 0;
    } catch {
      await ctx.err(`no crontab for ${user}\n`);
      return 1;
    }
  }
  if (ctx.args.includes('-r')) {
    try {
      asRoot(() => ctx.vfs.unlink(file, '/'));
    } catch {
      await ctx.err(`no crontab for ${user}\n`);
      return 1;
    }
    return 0;
  }
  if (ctx.args.includes('-e')) {
    const tmp = `/tmp/crontab.${Math.random().toString(36).slice(2, 8)}`;
    let cur = '';
    try {
      cur = asRoot(() => ctx.vfs.readFile(file, '/'));
    } catch {
      cur = '# Edit this file to introduce tasks to be run by cron.\n#\n# m h  dom mon dow   command\n';
    }
    ctx.vfs.writeFile(tmp, '/', cur);
    const editor = ctx.shell.getVar('VISUAL') || ctx.shell.getVar('EDITOR') || 'nano';
    if (!ctx.shell.getVar('EDITOR')) await ctx.out(`no crontab for ${user} - using an empty one\n`);
    await ctx.shell.runCommand([editor, tmp], ctx.io, { skipFunctions: true });
    const text = ctx.vfs.readFile(tmp, '/');
    ctx.vfs.unlink(tmp, '/');
    if (text !== cur) {
      asRoot(() => {
        ctx.vfs.mkdir('/var/spool/cron/crontabs', '/', { parents: true });
        ctx.vfs.writeFile(file, '/', text);
      });
      await ctx.out('crontab: installing new crontab\n');
    } else await ctx.out('No modification made\n');
    return 0;
  }
  const src = ctx.args.find((a) => !a.startsWith('-'));
  if (src) {
    const text = src === '-' ? await ctx.stdin.readAll() : ctx.vfs.readFile(src, ctx.cwd);
    asRoot(() => {
      ctx.vfs.mkdir('/var/spool/cron/crontabs', '/', { parents: true });
      ctx.vfs.writeFile(file, '/', text);
    });
    return 0;
  }
  await ctx.err('crontab: usage error: file name or - (for stdin) must be specified\nusage:\tcrontab [-u user] file\n\tcrontab [ -u user ] [ -i ] { -e | -l | -r }\n');
  return 1;
}

async function chsh(ctx) {
  if (ctx.args.includes('-l')) {
    await ctx.out(ctx.vfs.readFile('/etc/shells', '/'));
    return 0;
  }
  await ctx.out('Password: \n');
  return 0;
}

async function lsof(ctx) {
  await ctx.out(`COMMAND  PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\nbash    ${ctx.shell.rootPid} ${ctx.shell.user.name.padEnd(5)}  cwd    DIR    8,1     4096    2 ${ctx.shell.cwd}\nbash    ${ctx.shell.rootPid} ${ctx.shell.user.name.padEnd(5)}    0u   CHR  136,0      0t0    3 /dev/pts/0\nbash    ${ctx.shell.rootPid} ${ctx.shell.user.name.padEnd(5)}    1u   CHR  136,0      0t0    3 /dev/pts/0\nbash    ${ctx.shell.rootPid} ${ctx.shell.user.name.padEnd(5)}    2u   CHR  136,0      0t0    3 /dev/pts/0\n`);
  return 0;
}

async function mesg(ctx) {
  await ctx.out(ctx.args.length ? '' : 'is y\n');
  return 0;
}

async function arch(ctx) {
  await ctx.out('x86_64\n');
  return 0;
}

async function hostnamectl(ctx) {
  const sys = ctx.shell.system;
  await ctx.out(` Static hostname: ${sys.hostname}\n       Icon name: computer-vm\n         Chassis: vm 🖴\n      Machine ID: 7f3e9d2a41c64b8a9a7e2f1c0d5b6a39\n         Boot ID: 3c1b7e44a0f94f2d8f5b2b1d6a9e8c70\n  Virtualization: kvm\nOperating System: Ubuntu 24.04.1 LTS\n          Kernel: Linux ${sys.kernel}\n    Architecture: x86-64\n Hardware Vendor: QEMU\n  Hardware Model: Standard PC _i440FX + PIIX, 1996_\nFirmware Version: 1.16.3-debian-1.16.3-2\n   Firmware Date: Tue 2014-04-01\n    Firmware Age: 12y 6month 4w\n`);
  return 0;
}

async function timedatectl(ctx) {
  const now = new Date();
  await ctx.out(`               Local time: ${strftime(now, '%a %Y-%m-%d %H:%M:%S %Z')}\n           Universal time: ${strftime(now, '%a %Y-%m-%d %H:%M:%S UTC', true)}\n                 RTC time: ${strftime(now, '%a %Y-%m-%d %H:%M:%S', true)}\n                Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} (${strftime(now, '%Z, %z')})\nSystem clock synchronized: yes\n              NTP service: active\n          RTC in local TZ: no\n`);
  return 0;
}

export function install(reg) {
  const add = (names, fn, help) => {
    for (const n of names.split(' ')) reg.set(n, ext(fn, help));
  };
  const date_ = ext(date);
  date_.format = (d, fmt, utc) => strftime(d, fmt, utc);
  reg.set('date', date_);
  add('cal ncal', cal);
  add('sleep', sleep);
  add('timeout', timeout);
  add('watch', watch);
  add('uname', uname);
  add('hostname', hostname);
  add('whoami', whoami);
  add('id', id);
  add('groups', groups);
  add('who', who);
  add('w', w);
  add('uptime', uptime);
  add('users', users);
  add('last', last);
  add('ps', ps);
  add('pgrep pkill', pgrep);
  add('killall', killall);
  add('free', free);
  add('vmstat', vmstat);
  add('nproc', nproc);
  add('lscpu', lscpu);
  add('env', env);
  add('printenv', printenv);
  add('clear', clear);
  add('reset', reset);
  add('tput', tput);
  add('stty', stty);
  add('tty', tty);
  add('sudo', sudo);
  add('su', su);
  add('useradd adduser', useradd);
  add('userdel deluser', userdel);
  add('groupadd addgroup', groupadd);
  add('groupdel delgroup', groupdel);
  add('usermod', usermod);
  add('passwd', passwd);
  add('getent', getent);
  add('xargs', xargs);
  add('nohup', nohup);
  add('nice ionice chrt taskset', nice);
  add('time', timeCmd);
  add('bash sh dash rbash', bashCmd);
  add('bc', bc);
  add('apt apt-get', apt);
  add('dpkg dpkg-query', dpkg);
  add('snap', snap);
  add('systemctl', systemctl);
  add('service', service);
  add('journalctl', journalctl);
  add('shutdown reboot poweroff halt', shutdown);
  add('lsblk', lsblk);
  add('mount', mount);
  add('dmesg', dmesg);
  add('ping', ping);
  add('curl', curl);
  add('wget', wget);
  add('ssh scp sftp', ssh);
  add('nslookup dig host', nslookup);
  add('ip', ip);
  add('ifconfig', ifconfig);
  add('ss', ss);
  add('netstat', netstat);
  add('traceroute tracepath', traceroute);
  add('locale', locale);
  add('lsb_release', lsbRelease);
  add('logger', logger);
  add('wall', wall);
  add('crontab', crontab);
  add('chsh chfn', chsh);
  add('lsof', lsof);
  add('mesg', mesg);
  add('arch', arch);
  add('hostnamectl', hostnamectl);
  add('timedatectl', timedatectl);
}

export { strftime as format };
