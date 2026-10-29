// Full-screen programs: nano, vi/vim, less/more, top/htop, sl, cmatrix.

import { strWidth, splitLines, abspath, byteLength } from '../util.js';
import { FsError } from '../vfs.js';
import { InterruptEx } from '../shell.js';

const ESC = '\x1b';
const ALT_ON = '\x1b[?1049h\x1b[H\x1b[2J';
const ALT_OFF = '\x1b[?1049l';
const at = (r, c) => `\x1b[${r + 1};${c + 1}H`;
const REV = '\x1b[7m';
const RST = '\x1b[0m';

export function keyName(k) {
  const map = {
    '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOC': 'right', '\x1bOD': 'left',
    '\x1b[H': 'home', '\x1b[F': 'end', '\x1bOH': 'home', '\x1bOF': 'end', '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn',
    '\x1b[3~': 'del', '\x1b[2~': 'ins', '\r': 'enter', '\n': 'enter', '\x7f': 'backspace', '\b': 'backspace', '\t': 'tab', '\x1b': 'esc',
    '\x1b[1;5C': 'C-right', '\x1b[1;5D': 'C-left', '\x1b[1;5A': 'C-up', '\x1b[1;5B': 'C-down', '\x1bOP': 'F1', '\x1b[21~': 'F10', '\x1b[Z': 'S-tab',
  };
  if (map[k]) return map[k];
  if (k.length === 1 && k.charCodeAt(0) < 32) return 'C-' + String.fromCharCode(k.charCodeAt(0) + 96);
  if (k.length === 2 && k[0] === '\x1b') return 'M-' + k[1];
  return k;
}

// display helpers: expand tabs, compute columns
function expandTabs(line, tab = 8) {
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = tab - (col % tab);
      out += ' '.repeat(n);
      col += n;
    } else if (ch.charCodeAt(0) < 32) {
      out += '^' + String.fromCharCode(ch.charCodeAt(0) + 64);
      col += 2;
    } else {
      out += ch;
      col += strWidth(ch);
    }
  }
  return out;
}

function colOf(line, idx, tab = 8) {
  return strWidth(expandTabs([...line].slice(0, idx).join(''), tab));
}

function idxOfCol(line, col, tab = 8) {
  const chars = [...line];
  let c = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = chars[i] === '\t' ? tab - (c % tab) : strWidth(chars[i]) || 1;
    if (c + w > col) return i;
    c += w;
  }
  return chars.length;
}

function sliceCols(s, start, width) {
  // s has no tabs; cut by display columns
  let out = '';
  let c = 0;
  for (const ch of s) {
    const w = strWidth(ch);
    if (c >= start && c + w <= start + width) out += ch;
    c += w;
    if (c >= start + width) break;
  }
  return out;
}

function loadFile(ctx, path) {
  const vfs = ctx.vfs;
  try {
    const node = vfs.stat(path, ctx.cwd);
    if (node.type === 'dir') return { error: `"${path}" is a directory`, dir: true };
    const text = vfs.readFile(path, ctx.cwd);
    return { text, exists: true };
  } catch (e) {
    if (e instanceof FsError && e.code === 'ENOENT') return { text: '', exists: false };
    if (e instanceof FsError) return { error: `Error reading ${path}: ${e.message}`, text: '' };
    throw e;
  }
}

// ---------------------------------------------------------------- nano

async function nano(ctx) {
  const term = ctx.shell.term;
  const files = ctx.args.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  const plus = ctx.args.find((a) => /^\+\d+/.test(a));
  let showNumbers = ctx.args.includes('-l') || ctx.args.includes('--linenumbers');
  const viewOnly = ctx.args.includes('-v') || ctx.args.includes('--view');
  if (!term || !ctx.stdout.isTerminalWriter) {
    await ctx.err('Too many errors from stdin\n');
    return 1;
  }
  let filename = files[0] || '';
  let lines = [''];
  let status = '';
  let eolMissing = false;
  if (filename) {
    const r = loadFile(ctx, filename);
    if (r.dir) {
      status = `${r.error}`;
      filename = '';
    } else if (r.error) status = r.error;
    else if (!r.exists) status = 'New File';
    else {
      lines = r.text.split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      else if (r.text.length) eolMissing = true;
      const n = lines.length;
      status = `Read ${n} line${n === 1 ? '' : 's'}${eolMissing ? ' (Converted from Mac format)'.replace(' (Converted from Mac format)', '') : ''}`;
    }
  }
  let cy = 0;
  let cx = 0;
  let top = 0;
  let modified = false;
  let cutBuf = [];
  let lastWasCut = false;
  let lastSearch = '';
  const undo = [];
  const redo = [];
  if (plus) {
    cy = Math.min(lines.length - 1, Math.max(0, parseInt(plus.slice(1), 10) - 1));
  }
  const snapshot = () => {
    undo.push({ lines: lines.slice(), cy, cx });
    if (undo.length > 200) undo.shift();
    redo.length = 0;
  };
  return term.raw(async (io) => {
    const W = () => io.cols();
    const H = () => io.rows();
    const textRows = () => Math.max(1, H() - 4);
    const gutter = () => (showNumbers ? String(lines.length).length + 2 : 0);
    let hscroll = 0;
    const help1 = [['^G', 'Help'], ['^O', 'Write Out'], ['^W', 'Where Is'], ['^K', 'Cut'], ['^T', 'Execute'], ['^C', 'Location'], ['M-U', 'Undo'], ['M-A', 'Set Mark']];
    const help2 = [['^X', 'Exit'], ['^R', 'Read File'], ['^\\', 'Replace'], ['^U', 'Paste'], ['^J', 'Justify'], ['^/', 'Go To Line'], ['M-E', 'Redo'], ['M-6', 'Copy']];
    const helpLine = (items) => {
      const w = Math.floor(W() / items.length);
      let s = '';
      for (const [k, l] of items) {
        const cell = `${REV}${k}${RST} ${l}`;
        s += cell + ' '.repeat(Math.max(1, w - k.length - 1 - l.length));
      }
      return s;
    };
    const draw = (prompt = null) => {
      const cols = W();
      const rows = H();
      if (cy < top) top = cy;
      if (cy >= top + textRows()) top = cy - textRows() + 1;
      let s = '\x1b[?25l\x1b[H';
      const title = '  GNU nano 7.2';
      const name = filename || 'New Buffer';
      const right = modified ? 'Modified  ' : '';
      const mid = Math.max(title.length + 1, Math.floor((cols - name.length) / 2));
      let bar = title.padEnd(mid) + name;
      bar = bar.padEnd(cols - right.length) + right;
      s += REV + bar.slice(0, cols) + RST + '\x1b[K';
      const g = gutter();
      const avail = cols - g;
      // cursor line horizontal scroll
      const ccol = colOf(lines[cy], cx);
      if (ccol - hscroll >= avail - 1) hscroll = ccol - avail + 2;
      if (ccol < hscroll) hscroll = Math.max(0, ccol - Math.floor(avail / 2));
      if (ccol < avail - 1) hscroll = 0;
      for (let r = 0; r < textRows(); r++) {
        const i = top + r;
        s += at(r + 1, 0) + '\x1b[K';
        if (i >= lines.length) continue;
        if (g) s += `\x1b[2m${String(i + 1).padStart(g - 1)} ${RST}`;
        const disp = expandTabs(lines[i]);
        const off = i === cy ? hscroll : 0;
        let shown = sliceCols(disp, off, avail);
        if (strWidth(disp) - off > avail) shown = sliceCols(disp, off, avail - 1) + '>';
        if (off > 0) shown = '<' + shown.slice(1);
        s += shown;
      }
      s += at(rows - 3, 0) + '\x1b[K';
      if (prompt) {
        const p = prompt.label + prompt.value;
        s += REV + p.padEnd(cols).slice(0, cols) + RST;
      } else if (status) {
        const msg = `[ ${status} ]`;
        s += ' '.repeat(Math.max(0, Math.floor((cols - msg.length) / 2))) + REV + msg + RST;
      }
      const h1 = prompt ? prompt.help1 || [['^G', 'Help'], ['^C', 'Cancel']] : help1;
      const h2 = prompt ? prompt.help2 || [] : help2;
      s += at(rows - 2, 0) + '\x1b[K' + helpLine(h1);
      s += at(rows - 1, 0) + '\x1b[K' + (h2.length ? helpLine(h2) : '');
      if (prompt) s += at(rows - 3, Math.min(cols - 1, strWidth(prompt.label) + strWidth(prompt.value.slice(0, prompt.pos ?? prompt.value.length))));
      else s += at(cy - top + 1, g + colOf(lines[cy], cx) - hscroll);
      s += '\x1b[?25h';
      io.write(s);
    };
    const ask = async (label, initial = '', extra = {}) => {
      const p = { label, value: initial, pos: initial.length, ...extra };
      for (;;) {
        draw(p);
        const k = keyName(await io.key());
        if (k === 'enter') return p.value;
        if (k === 'C-c') return null;
        if (extra.keys && extra.keys[k]) return extra.keys[k];
        if (k === 'backspace') {
          if (p.pos > 0) {
            p.value = p.value.slice(0, p.pos - 1) + p.value.slice(p.pos);
            p.pos--;
          }
        } else if (k === 'left') p.pos = Math.max(0, p.pos - 1);
        else if (k === 'right') p.pos = Math.min(p.value.length, p.pos + 1);
        else if (k === 'home' || k === 'C-a') p.pos = 0;
        else if (k === 'end' || k === 'C-e') p.pos = p.value.length;
        else if (k.length === 1 && k >= ' ') {
          if (extra.yesno) {
            if (/[yYnNaA]/.test(k)) return k.toLowerCase();
            continue;
          }
          p.value = p.value.slice(0, p.pos) + k + p.value.slice(p.pos);
          p.pos++;
        }
      }
    };
    const write = async (name) => {
      const text = lines.join('\n') + '\n';
      try {
        ctx.vfs.writeFile(name, ctx.cwd, text, { umask: ctx.shell.umask });
        modified = false;
        filename = name;
        status = `Wrote ${lines.length} line${lines.length === 1 ? '' : 's'}`;
        return true;
      } catch (e) {
        status = `Error writing ${name}: ${e.message}`;
        return false;
      }
    };
    const edit = (fn) => {
      if (viewOnly) {
        status = 'Key is invalid in view mode';
        return;
      }
      snapshot();
      fn();
      modified = true;
      lastWasCut = false;
    };
    io.write(ALT_ON);
    try {
      for (;;) {
        draw();
        const raw = await io.key();
        const k = keyName(raw);
        if (k !== 'C-k') lastWasCut = false;
        status = '';
        const line = lines[cy];
        const len = [...line].length;
        switch (k) {
          case 'C-x': {
            if (modified) {
              const a = await ask('Save modified buffer?  ', '', { yesno: true, help1: [[' Y', 'Yes']], help2: [[' N', 'No'], ['^C', 'Cancel']] });
              if (a === null) {
                status = 'Cancelled';
                break;
              }
              if (a === 'y') {
                const name = await ask('File Name to Write: ', filename);
                if (name === null || name === '') {
                  status = 'Cancelled';
                  break;
                }
                if (!(await write(name))) break;
              }
            }
            return 0;
          }
          case 'C-o':
          case 'C-s': {
            const name = k === 'C-s' && filename ? filename : await ask('File Name to Write: ', filename);
            if (name === null || name === '') {
              status = 'Cancelled';
              break;
            }
            await write(name);
            break;
          }
          case 'C-r': {
            const name = await ask('File to insert [from ./]: ', '');
            if (!name) {
              status = 'Cancelled';
              break;
            }
            const r = loadFile(ctx, name);
            if (r.error || !r.exists) {
              status = r.error || `No such file or directory`;
              break;
            }
            const ins = splitLines(r.text);
            edit(() => {
              lines.splice(cy, 0, ...ins);
              cy += ins.length;
            });
            status = `Read ${ins.length} line${ins.length === 1 ? '' : 's'}`;
            break;
          }
          case 'C-w': {
            const q = await ask(`Search${lastSearch ? ` [${lastSearch}]` : ''}: `, '');
            if (q === null) {
              status = 'Cancelled';
              break;
            }
            const term_ = q || lastSearch;
            lastSearch = term_;
            if (!term_) break;
            let found = false;
            for (let d = 0; d <= lines.length && !found; d++) {
              const i = (cy + d) % lines.length;
              const from = d === 0 ? cx + 1 : 0;
              const chars = [...lines[i]];
              const pos = chars.join('').indexOf(term_, chars.slice(0, from).join('').length);
              if (pos >= 0) {
                cy = i;
                cx = [...lines[i].slice(0, pos)].length;
                found = true;
                if (d === lines.length || (i < cy)) status = 'Search Wrapped';
              }
            }
            if (!found) status = `"${term_}" not found`;
            break;
          }
          case 'C-\\': {
            const q = await ask('Search (to replace): ', '');
            if (!q) {
              status = 'Cancelled';
              break;
            }
            const rep = await ask(`Replace with: `, '');
            if (rep === null) {
              status = 'Cancelled';
              break;
            }
            let n = 0;
            edit(() => {
              lines = lines.map((l) => {
                const parts = l.split(q);
                n += parts.length - 1;
                return parts.join(rep);
              });
            });
            status = `Replaced ${n} occurrence${n === 1 ? '' : 's'}`;
            break;
          }
          case 'C-k':
            edit(() => {
              const removed = lines.splice(cy, 1);
              if (lastWasCut) cutBuf.push(...removed);
              else cutBuf = removed;
              if (!lines.length) lines = [''];
              if (cy >= lines.length) cy = lines.length - 1;
              cx = 0;
            });
            lastWasCut = true;
            break;
          case 'C-u':
            if (cutBuf.length) edit(() => {
              lines.splice(cy, 0, ...cutBuf);
              cy += cutBuf.length;
              cx = 0;
            });
            break;
          case 'M-6':
            cutBuf = [lines[cy]];
            status = 'Copied 1 line';
            break;
          case 'C-c': {
            const total = lines.reduce((a, l) => a + [...l].length + 1, 0);
            let ch = 0;
            for (let i = 0; i < cy; i++) ch += [...lines[i]].length + 1;
            ch += cx + 1;
            status = `line ${cy + 1}/${lines.length} (${Math.round(((cy + 1) / lines.length) * 100)}%), col ${cx + 1}/${len + 1} (${Math.round(((cx + 1) / (len + 1)) * 100)}%), char ${ch}/${total} (${Math.round((ch / total) * 100)}%)`;
            break;
          }
          case 'C-_':
          case 'C-/':
          case 'M-g': {
            const v = await ask('Enter line number, column number: ', '');
            if (!v) {
              status = 'Cancelled';
              break;
            }
            const [l, c] = v.split(/[,\s]+/).map(Number);
            cy = Math.min(lines.length - 1, Math.max(0, (l || 1) - 1));
            cx = Math.min([...lines[cy]].length, Math.max(0, (c || 1) - 1));
            break;
          }
          case 'C-g':
          case 'F1':
            io.write('\x1b[H\x1b[2J');
            io.write(at(0, 0) + REV + ' GNU nano 7.2 '.padEnd(W()) + RST);
            io.write(at(2, 0) + 'Main nano help text\r\n\r\n The nano editor is designed to emulate the functionality and ease-of-use of the\r\n UW Pico text editor.\r\n\r\n ^G   Display this help text          ^X   Close the current buffer / Exit\r\n ^O   Write the current buffer        ^R   Insert another file\r\n ^W   Search forward                  ^\\   Replace a string\r\n ^K   Cut current line                ^U   Paste\r\n ^C   Report cursor position          ^_   Go to line and column\r\n M-U  Undo                            M-E  Redo\r\n ^A   Go to beginning of line         ^E   Go to end of line\r\n ^Y   One page up                     ^V   One page down\r\n M-\\  Go to first line                M-/  Go to last line\r\n M-#  Toggle line numbers\r\n\r\n Press any key to return.');
            await io.key();
            break;
          case 'M-u':
            if (undo.length) {
              redo.push({ lines: lines.slice(), cy, cx });
              const u = undo.pop();
              lines = u.lines;
              cy = u.cy;
              cx = u.cx;
              modified = true;
              status = 'Undid action';
            } else status = 'Nothing to undo';
            break;
          case 'M-e':
            if (redo.length) {
              undo.push({ lines: lines.slice(), cy, cx });
              const u = redo.pop();
              lines = u.lines;
              cy = u.cy;
              cx = u.cx;
              status = 'Redid action';
            } else status = 'Nothing to redo';
            break;
          case 'M-#':
          case 'M-n':
            showNumbers = !showNumbers;
            break;
          case 'C-t':
            status = 'Executing commands is not supported in this nano';
            break;
          case 'C-j':
            status = 'Justify is not supported in this nano';
            break;
          case 'up':
          case 'C-p':
            if (cy > 0) {
              const col = colOf(line, cx);
              cy--;
              cx = idxOfCol(lines[cy], col);
            }
            break;
          case 'down':
          case 'C-n':
            if (cy < lines.length - 1) {
              const col = colOf(line, cx);
              cy++;
              cx = idxOfCol(lines[cy], col);
            }
            break;
          case 'left':
          case 'C-b':
            if (cx > 0) cx--;
            else if (cy > 0) {
              cy--;
              cx = [...lines[cy]].length;
            }
            break;
          case 'right':
          case 'C-f':
            if (cx < len) cx++;
            else if (cy < lines.length - 1) {
              cy++;
              cx = 0;
            }
            break;
          case 'home':
          case 'C-a':
            cx = 0;
            break;
          case 'end':
          case 'C-e':
            cx = len;
            break;
          case 'pgup':
          case 'C-y':
            cy = Math.max(0, cy - textRows());
            top = Math.max(0, top - textRows());
            cx = Math.min(cx, [...lines[cy]].length);
            break;
          case 'pgdn':
          case 'C-v':
            cy = Math.min(lines.length - 1, cy + textRows());
            top = Math.min(Math.max(0, lines.length - 1), top + textRows());
            cx = Math.min(cx, [...lines[cy]].length);
            break;
          case 'M-\\':
          case 'C-home':
            cy = 0;
            cx = 0;
            break;
          case 'M-/':
          case 'C-end':
            cy = lines.length - 1;
            cx = [...lines[cy]].length;
            break;
          case 'C-right': {
            const rest = [...line].slice(cx).join('');
            const m = /^\W*\w*/.exec(rest);
            cx += [...m[0]].length;
            break;
          }
          case 'C-left': {
            const before = [...line].slice(0, cx).join('');
            const m = /\w*\W*$/.exec(before);
            cx -= [...m[0]].length;
            break;
          }
          case 'enter':
            edit(() => {
              const chars = [...line];
              lines[cy] = chars.slice(0, cx).join('');
              lines.splice(cy + 1, 0, chars.slice(cx).join(''));
              cy++;
              cx = 0;
            });
            break;
          case 'backspace':
          case 'C-h':
            if (cx > 0) {
              edit(() => {
                const chars = [...line];
                chars.splice(cx - 1, 1);
                lines[cy] = chars.join('');
                cx--;
              });
            } else if (cy > 0) {
              edit(() => {
                const prevLen = [...lines[cy - 1]].length;
                lines[cy - 1] += line;
                lines.splice(cy, 1);
                cy--;
                cx = prevLen;
              });
            }
            break;
          case 'del':
          case 'C-d':
            if (cx < len) {
              edit(() => {
                const chars = [...line];
                chars.splice(cx, 1);
                lines[cy] = chars.join('');
              });
            } else if (cy < lines.length - 1) {
              edit(() => {
                lines[cy] += lines[cy + 1];
                lines.splice(cy + 1, 1);
              });
            }
            break;
          case 'tab':
            edit(() => {
              const chars = [...line];
              chars.splice(cx, 0, '\t');
              lines[cy] = chars.join('');
              cx++;
            });
            break;
          case 'C-l':
            io.write('\x1b[2J');
            break;
          case 'esc':
            break;
          default:
            if (raw.startsWith('\x1b') || (raw.length === 1 && raw.charCodeAt(0) < 32)) {
              status = 'Unknown sequence';
              break;
            }
            edit(() => {
              const chars = [...line];
              const ins = [...raw.replace(/\r\n?/g, '\n')];
              // pasted text may contain newlines
              let cur = chars.slice(0, cx).join('');
              const after = chars.slice(cx).join('');
              let row = cy;
              for (const ch of ins) {
                if (ch === '\n') {
                  lines[row] = cur;
                  row++;
                  lines.splice(row, 0, '');
                  cur = '';
                } else cur += ch;
              }
              lines[row] = cur + after;
              cy = row;
              cx = [...cur].length;
            });
        }
      }
    } finally {
      io.write(ALT_OFF);
    }
  });
}

// ---------------------------------------------------------------- vim

async function vim(ctx) {
  const term = ctx.shell.term;
  if (!term || !ctx.stdout.isTerminalWriter) {
    await ctx.err('Vim: Warning: Output is not to a terminal\n');
  }
  if (!term) return 1;
  const files = ctx.args.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  const plus = ctx.args.find((a) => a.startsWith('+'));
  const readonly = ctx.name === 'view' || ctx.args.includes('-R');
  let filename = files[0] || '';
  let lines = [''];
  let msg = '';
  let number = false;
  let relnum = false;
  const open = (name) => {
    const r = loadFile(ctx, name);
    if (r.dir) {
      msg = `"${name}" is a directory`;
      lines = [''];
      return;
    }
    if (r.error) {
      msg = `"${name}" [Permission Denied]`;
      lines = [''];
      return;
    }
    if (!r.exists) {
      msg = `"${name}" [New]`;
      lines = [''];
      return;
    }
    lines = r.text.split('\n');
    const noEol = r.text.length && !r.text.endsWith('\n');
    if (!noEol) lines.pop();
    if (!lines.length) lines = [''];
    msg = `"${name}" ${noEol ? '[noeol] ' : ''}${r.text === '' ? '0L, 0B' : `${lines.length}L, ${byteLength(r.text)}B`}`;
  };
  if (filename) open(filename);
  let cy = 0;
  let cx = 0;
  let top = 0;
  let mode = 'normal';
  let modified = false;
  let reg = { text: '', linewise: false };
  const undo = [];
  const redo = [];
  let lastSearch = '';
  let searchBack = false;
  let lastFind = null;
  let lastChange = null;
  let visualStart = null;
  if (plus) {
    const n = plus === '+' ? Infinity : parseInt(plus.slice(1), 10);
    if (!isNaN(n)) cy = Math.min(lines.length - 1, Math.max(0, (n === Infinity ? lines.length : n) - 1));
  }
  const snapshot = () => {
    undo.push({ lines: lines.slice(), cy, cx });
    if (undo.length > 500) undo.shift();
    redo.length = 0;
  };
  const L = (i = cy) => [...lines[i]];
  const clampX = (insert = false) => {
    const n = L().length;
    const max = insert ? n : Math.max(0, n - 1);
    if (cx > max) cx = max;
    if (cx < 0) cx = 0;
  };
  return term.raw(async (io) => {
    const W = () => io.cols();
    const H = () => io.rows();
    const textRows = () => Math.max(1, H() - 1);
    const draw = (cmdline = null) => {
      const cols = W();
      if (cy < top) top = cy;
      if (cy >= top + textRows()) top = cy - textRows() + 1;
      const g = number || relnum ? Math.max(3, String(lines.length).length) + 1 : 0;
      let s = '\x1b[?25l\x1b[H';
      for (let r = 0; r < textRows(); r++) {
        const i = top + r;
        s += at(r, 0) + '\x1b[K';
        if (i >= lines.length) {
          s += '\x1b[94m~' + RST;
          continue;
        }
        if (g) {
          const n = relnum && i !== cy ? Math.abs(i - cy) : i + 1;
          s += `\x1b[33m${String(n).padStart(g - 1)} ${RST}`;
        }
        let disp = expandTabs(lines[i]);
        if (visualStart && mode.startsWith('visual')) {
          const [a, b] = [visualStart, { y: cy, x: cx }].sort((p, q) => p.y - q.y || p.x - q.x);
          if (i >= a.y && i <= b.y) {
            if (mode === 'visual-line') disp = REV + disp + RST;
            else {
              const chars = [...lines[i]];
              const from = i === a.y ? a.x : 0;
              const to = i === b.y ? b.x + 1 : chars.length;
              disp = expandTabs(chars.slice(0, from).join('')) + REV + expandTabs(chars.slice(from, to).join('')) + RST + expandTabs(chars.slice(to).join(''));
            }
          }
        }
        s += disp.includes('\x1b') ? disp : sliceCols(disp, 0, cols - g);
      }
      s += at(H() - 1, 0) + '\x1b[K';
      if (cmdline !== null) s += cmdline;
      else if (mode === 'insert') s += '\x1b[1m-- INSERT --' + RST;
      else if (mode === 'replace') s += '\x1b[1m-- REPLACE --' + RST;
      else if (mode === 'visual') s += '\x1b[1m-- VISUAL --' + RST;
      else if (mode === 'visual-line') s += '\x1b[1m-- VISUAL LINE --' + RST;
      else s += msg.slice(0, cols - 20);
      const pos = `${cy + 1},${cx + 1}`;
      const pct = lines.length <= textRows() ? 'All' : top === 0 ? 'Top' : top + textRows() >= lines.length ? 'Bot' : `${Math.round((top / (lines.length - textRows())) * 100)}%`;
      if (cmdline === null) s += at(H() - 1, cols - 18) + pos.padEnd(14) + pct;
      if (cmdline !== null) s += at(H() - 1, Math.min(cols - 1, strWidth(cmdline)));
      else s += at(cy - top, g + colOf(lines[cy], cx));
      s += '\x1b[?25h';
      io.write(s);
    };
    const readCmdline = async (prefix) => {
      let v = '';
      for (;;) {
        draw(prefix + v);
        const k = keyName(await io.key());
        if (k === 'enter') return v;
        if (k === 'esc' || k === 'C-c') return null;
        if (k === 'backspace') {
          if (!v) return null;
          v = v.slice(0, -1);
        } else if (k === 'C-u') v = '';
        else if (k.length === 1 && k >= ' ') v += k;
      }
    };
    const write = (name, force = false) => {
      if (!name) {
        msg = 'E32: No file name';
        return false;
      }
      if (readonly && !force) {
        msg = "E45: 'readonly' option is set (add ! to override)";
        return false;
      }
      const text = lines.length === 1 && lines[0] === '' ? '' : lines.join('\n') + '\n';
      try {
        const existed = ctx.vfs.exists(name, ctx.cwd);
        ctx.vfs.writeFile(name, ctx.cwd, text, { umask: ctx.shell.umask });
        msg = `"${name}" ${existed ? '' : '[New] '}${lines.length}L, ${byteLength(text)}B written`;
        modified = false;
        return true;
      } catch (e) {
        msg = `"${name}" E212: Can't open file for writing`;
        return false;
      }
    };
    const findChar = (ch, kind, count, line) => {
      let x = cx;
      for (let n = 0; n < count; n++) {
        if (kind === 'f' || kind === 't') {
          let i = line.indexOf(ch, x + 1 + (kind === 't' && n === 0 ? 1 : 0) - (kind === 't' && n === 0 ? 1 : 0));
          if (kind === 't') i = line.indexOf(ch, x + 2) >= 0 && line[x + 1] === ch && n === 0 ? line.indexOf(ch, x + 2) : line.indexOf(ch, x + 1);
          if (i < 0) return null;
          x = kind === 't' ? i - 1 : i;
          if (kind === 't' && n < count - 1) x = i;
        } else {
          const i = line.lastIndexOf(ch, x - 1 - (kind === 'T' ? 1 : 0));
          if (i < 0) return null;
          x = kind === 'T' ? i + 1 : i;
        }
      }
      return x;
    };
    // motion: returns {y, x, linewise, inclusive} or null
    const motion = async (k, count) => {
      const line = L();
      const isWord = (c) => /\w/.test(c);
      const cls = (c) => (c === undefined ? -1 : /\s/.test(c) ? 0 : isWord(c) ? 1 : 2);
      switch (k) {
        case 'h':
        case 'left':
        case 'backspace':
          return { y: cy, x: Math.max(0, cx - count) };
        case 'l':
        case 'right':
        case ' ':
          return { y: cy, x: Math.min(Math.max(0, line.length - (mode === 'op' ? 0 : 1)), cx + count) };
        case 'j':
        case 'down':
        case 'C-n':
        case 'enter':
        case '+':
          return { y: Math.min(lines.length - 1, cy + count), x: k === 'enter' || k === '+' ? (/\S/.exec(lines[Math.min(lines.length - 1, cy + count)]) || { index: 0 }).index : cx, linewise: true };
        case 'k':
        case 'up':
        case 'C-p':
        case '-':
          return { y: Math.max(0, cy - count), x: k === '-' ? (/\S/.exec(lines[Math.max(0, cy - count)]) || { index: 0 }).index : cx, linewise: true };
        case '0':
        case 'home':
          return { y: cy, x: 0 };
        case '^':
          return { y: cy, x: (/\S/.exec(lines[cy]) || { index: 0 }).index };
        case '$':
        case 'end':
          return { y: Math.min(lines.length - 1, cy + count - 1), x: Math.max(0, L(Math.min(lines.length - 1, cy + count - 1)).length - 1), inclusive: true, toEnd: true };
        case 'G':
          return { y: count > 1 || pendingCount ? Math.min(lines.length, count) - 1 : lines.length - 1, x: 0, linewise: true };
        case 'gg':
          return { y: Math.min(lines.length, pendingCount ? count : 1) - 1, x: 0, linewise: true };
        case 'w':
        case 'W': {
          let y = cy;
          let x = cx;
          for (let n = 0; n < count; n++) {
            const ln = L(y);
            const c0 = cls(ln[x]);
            if (k === 'W') while (x < ln.length && !/\s/.test(ln[x])) x++;
            else while (x < ln.length && cls(ln[x]) === c0 && c0 !== 0) x++;
            while (true) {
              const l2 = L(y);
              while (x < l2.length && /\s/.test(l2[x])) x++;
              if (x < l2.length) break;
              if (y >= lines.length - 1 || (mode === 'op' && n === count - 1)) {
                x = l2.length;
                break;
              }
              y++;
              x = 0;
              if (L(y).length === 0) break;
            }
          }
          return { y, x };
        }
        case 'b':
        case 'B': {
          let y = cy;
          let x = cx;
          for (let n = 0; n < count; n++) {
            x--;
            while (true) {
              if (x < 0) {
                if (y === 0) {
                  x = 0;
                  break;
                }
                y--;
                x = L(y).length - 1;
                if (x < 0) {
                  x = 0;
                  break;
                }
                continue;
              }
              if (/\s/.test(L(y)[x])) {
                x--;
                continue;
              }
              break;
            }
            const ln = L(y);
            const c0 = cls(ln[x]);
            while (x > 0 && (k === 'B' ? !/\s/.test(ln[x - 1]) : cls(ln[x - 1]) === c0)) x--;
          }
          return { y, x };
        }
        case 'e':
        case 'E': {
          let y = cy;
          let x = cx;
          for (let n = 0; n < count; n++) {
            x++;
            while (true) {
              const ln = L(y);
              while (x < ln.length && /\s/.test(ln[x])) x++;
              if (x < ln.length) break;
              if (y >= lines.length - 1) {
                x = Math.max(0, ln.length - 1);
                break;
              }
              y++;
              x = 0;
            }
            const ln = L(y);
            const c0 = cls(ln[x]);
            while (x < ln.length - 1 && (k === 'E' ? !/\s/.test(ln[x + 1]) : cls(ln[x + 1]) === c0)) x++;
          }
          return { y, x, inclusive: true };
        }
        case 'f':
        case 't':
        case 'F':
        case 'T': {
          const ch = await io.key();
          if (ch.length !== 1) return null;
          lastFind = { k, ch };
          const x = findChar(ch, k, count, lines[cy]);
          if (x === null) return null;
          return { y: cy, x, inclusive: k === 'f' || k === 't' };
        }
        case ';':
        case ',': {
          if (!lastFind) return null;
          let kk = lastFind.k;
          if (k === ',') kk = { f: 'F', F: 'f', t: 'T', T: 't' }[kk];
          const x = findChar(lastFind.ch, kk, count, lines[cy]);
          return x === null ? null : { y: cy, x, inclusive: kk === 'f' || kk === 't' };
        }
        case 'H':
          return { y: top, x: 0, linewise: true };
        case 'M':
          return { y: Math.min(lines.length - 1, top + Math.floor(Math.min(textRows(), lines.length - top) / 2)), x: 0, linewise: true };
        case 'L':
          return { y: Math.min(lines.length - 1, top + textRows() - 1), x: 0, linewise: true };
        case '%': {
          const pairs = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
          let x = cx;
          const ln = lines[cy];
          while (x < ln.length && !pairs[ln[x]]) x++;
          if (x >= ln.length) return null;
          const open = ln[x];
          const close = pairs[open];
          const fwd = '([{'.includes(open);
          let depth = 0;
          let y = cy;
          let xx = x;
          for (;;) {
            const c = lines[y][xx];
            if (c === open) depth++;
            else if (c === close) {
              depth--;
              if (depth === 0) return { y, x: xx, inclusive: true };
            }
            if (fwd) {
              xx++;
              if (xx >= lines[y].length) {
                y++;
                xx = 0;
                if (y >= lines.length) return null;
              }
            } else {
              xx--;
              if (xx < 0) {
                y--;
                if (y < 0) return null;
                xx = lines[y].length - 1;
              }
            }
          }
        }
        case 'n':
        case 'N':
        case '*':
        case '#': {
          if (k === '*' || k === '#') {
            const m = /\w+/.exec(lines[cy].slice(cx)) || /\w+$/.exec(lines[cy].slice(0, cx + 1));
            if (!m) return null;
            lastSearch = `\\b${m[0]}\\b`;
            searchBack = k === '#';
          }
          return searchMotion(k === 'N' ? !searchBack : searchBack, count);
        }
      }
      return null;
    };
    const searchMotion = (back, count = 1) => {
      if (!lastSearch) {
        msg = 'E35: No previous regular expression';
        return null;
      }
      let re;
      try {
        re = new RegExp(lastSearch.replace(/\\</g, '\\b').replace(/\\>/g, '\\b'));
      } catch {
        msg = `E486: Pattern not found: ${lastSearch}`;
        return null;
      }
      let y = cy;
      let x = cx;
      for (let n = 0; n < count; n++) {
        let found = false;
        for (let d = 0; d <= lines.length; d++) {
          const i = back ? (y - d + lines.length * 2) % lines.length : (y + d) % lines.length;
          const ln = lines[i];
          if (!back) {
            const start = d === 0 ? x + 1 : 0;
            const g = new RegExp(re.source, 'g');
            g.lastIndex = start;
            const m = g.exec(ln);
            if (m && m.index >= start) {
              if (i < y || (i === y && d > 0)) msg = 'search hit BOTTOM, continuing at TOP';
              y = i;
              x = m.index;
              found = true;
              break;
            }
          } else {
            const g = new RegExp(re.source, 'g');
            let best = -1;
            let m;
            while ((m = g.exec(ln))) {
              if (d === 0 && m.index >= x) break;
              best = m.index;
              if (m[0] === '') g.lastIndex++;
            }
            if (best >= 0) {
              if (i > y) msg = 'search hit TOP, continuing at BOTTOM';
              y = i;
              x = best;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          msg = `E486: Pattern not found: ${lastSearch}`;
          return null;
        }
      }
      return { y, x };
    };
    // delete/yank a region between cursor and motion target
    const region = (m, linewise) => {
      let a = { y: cy, x: cx };
      let b = { y: m.y, x: m.x };
      if (b.y < a.y || (b.y === a.y && b.x < a.x)) [a, b] = [b, a];
      if (linewise || m.linewise) {
        return { linewise: true, y1: a.y, y2: b.y };
      }
      return { linewise: false, a, b: { y: b.y, x: b.x + (m.inclusive ? 1 : 0) } };
    };
    const regionText = (r) => {
      if (r.linewise) return lines.slice(r.y1, r.y2 + 1).join('\n');
      if (r.a.y === r.b.y) return L(r.a.y).slice(r.a.x, r.b.x).join('');
      const parts = [L(r.a.y).slice(r.a.x).join('')];
      for (let y = r.a.y + 1; y < r.b.y; y++) parts.push(lines[y]);
      parts.push(L(r.b.y).slice(0, r.b.x).join(''));
      return parts.join('\n');
    };
    const deleteRegion = (r) => {
      if (r.linewise) {
        lines.splice(r.y1, r.y2 - r.y1 + 1);
        if (!lines.length) lines = [''];
        cy = Math.min(r.y1, lines.length - 1);
        cx = (/\S/.exec(lines[cy]) || { index: 0 }).index;
        return;
      }
      const head = L(r.a.y).slice(0, r.a.x).join('');
      const tail = L(r.b.y).slice(r.b.x).join('');
      lines.splice(r.a.y, r.b.y - r.a.y + 1, head + tail);
      cy = r.a.y;
      cx = r.a.x;
    };
    const put = (after) => {
      if (!reg.text && !reg.linewise) return;
      snapshot();
      if (reg.linewise) {
        const ins = reg.text.split('\n');
        const at_ = after ? cy + 1 : cy;
        lines.splice(at_, 0, ...ins);
        cy = at_;
        cx = (/\S/.exec(lines[cy]) || { index: 0 }).index;
      } else {
        const chars = L();
        const pos = after && chars.length ? cx + 1 : cx;
        const parts = reg.text.split('\n');
        const head = chars.slice(0, pos).join('');
        const tail = chars.slice(pos).join('');
        if (parts.length === 1) {
          lines[cy] = head + parts[0] + tail;
          cx = pos + [...parts[0]].length - 1;
        } else {
          lines.splice(cy, 1, head + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + tail);
        }
      }
      modified = true;
    };
    let pendingCount = false;
    const exCommand = async (cmd) => {
      cmd = cmd.trim();
      let m;
      if (cmd === '') return null;
      if (/^\d+$/.test(cmd)) {
        cy = Math.min(lines.length - 1, Math.max(0, Number(cmd) - 1));
        cx = (/\S/.exec(lines[cy]) || { index: 0 }).index;
        return null;
      }
      if (cmd === '$') {
        cy = lines.length - 1;
        return null;
      }
      if ((m = /^(%|\d+(?:,\d+)?|\.|'<,'>)?s(.)(.*?)\2(.*?)(?:\2([gic]*))?$/.exec(cmd))) {
        let [y1, y2] = [cy, cy];
        if (m[1] === '%') [y1, y2] = [0, lines.length - 1];
        else if (m[1] === "'<,'>" && visualStart) [y1, y2] = [Math.min(visualStart.y, cy), Math.max(visualStart.y, cy)];
        else if (m[1] && /\d/.test(m[1])) {
          const [a, b] = m[1].split(',').map(Number);
          y1 = a - 1;
          y2 = (b || a) - 1;
        }
        const pat = m[3] || lastSearch;
        lastSearch = pat;
        let re;
        try {
          re = new RegExp(pat.replace(/\\</g, '\\b').replace(/\\>/g, '\\b').replace(/\\([(){}|+?])/g, '$1'), (m[5] || '').includes('g') ? 'g' : '' + ((m[5] || '').includes('i') ? 'i' : ''));
        } catch {
          return 'E486: Pattern not found: ' + pat;
        }
        const rep = m[4].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&').replace(/\\n/g, '\n');
        snapshot();
        let n = 0;
        let lastLine = -1;
        for (let y = y1; y <= Math.min(y2, lines.length - 1); y++) {
          const before = lines[y];
          const after = before.replace(re, rep);
          if (after !== before) {
            n++;
            lastLine = y;
            lines[y] = after;
          }
        }
        if (!n) {
          undo.pop();
          return `E486: Pattern not found: ${pat}`;
        }
        // split replacements containing newlines
        lines = lines.flatMap((l) => l.split('\n'));
        modified = true;
        cy = Math.min(lastLine, lines.length - 1);
        cx = 0;
        return n > 1 ? `${n} substitutions on ${n} lines` : null;
      }
      if ((m = /^(w|write|wq|x|xit|exit|q|quit|wq!|w!|q!|qa|qa!|wa|wqa|xa)(?:\s+(.+))?$/.exec(cmd))) {
        const c = m[1];
        const arg = m[2];
        if (c.startsWith('w') || c.startsWith('x') || c === 'exit') {
          if (c.startsWith('x') || c === 'exit') {
            if (modified || arg) {
              if (!write(arg || filename, true)) return msg;
              if (arg && !filename) filename = arg;
            }
            return 'QUIT';
          }
          const name = arg || filename;
          if (!write(name, c.includes('!'))) return msg;
          if (!filename) filename = name;
          if (c.startsWith('wq')) return 'QUIT';
          return msg;
        }
        if (c === 'q' || c === 'quit' || c === 'qa') {
          if (modified) return 'E37: No write since last change (add ! to override)';
          return 'QUIT';
        }
        return 'QUIT';
      }
      if ((m = /^e(dit)?(!)?(?:\s+(.+))?$/.exec(cmd))) {
        if (modified && !m[2]) return 'E37: No write since last change (add ! to override)';
        const name = m[3] || filename;
        if (!name) return 'E32: No file name';
        filename = name;
        open(name);
        cy = 0;
        cx = 0;
        modified = false;
        return msg;
      }
      if ((m = /^r(?:ead)?\s+(.+)$/.exec(cmd))) {
        if (m[1].startsWith('!')) {
          const out = await runShell(m[1].slice(1));
          snapshot();
          lines.splice(cy + 1, 0, ...splitLines(out));
          modified = true;
          return null;
        }
        const r = loadFile(ctx, m[1]);
        if (!r.exists) return `E484: Can't open file ${m[1]}`;
        snapshot();
        lines.splice(cy + 1, 0, ...splitLines(r.text));
        modified = true;
        return null;
      }
      if ((m = /^set?\s+(.+)$/.exec(cmd))) {
        for (const opt of m[1].split(/\s+/)) {
          if (opt === 'nu' || opt === 'number') number = true;
          else if (opt === 'nonu' || opt === 'nonumber') number = false;
          else if (opt === 'rnu' || opt === 'relativenumber') relnum = true;
          else if (opt === 'nornu' || opt === 'norelativenumber') relnum = false;
        }
        return null;
      }
      if (/^(noh|nohlsearch|syntax|syn|filetype|colorscheme|colo)\b/.test(cmd)) return null;
      if (/^h(elp)?\b/.test(cmd)) return 'Help is not available in this vim; try :q to quit, i to insert, :w to save';
      if ((m = /^!(.*)$/.exec(cmd))) {
        io.write(ALT_OFF);
        const out = await runShell(m[1]);
        io.write(out.replace(/\n/g, '\r\n') + '\r\nPress ENTER or type command to continue');
        await io.key();
        io.write(ALT_ON);
        return null;
      }
      if ((m = /^(\d+)?d(elete)?$/.exec(cmd))) {
        snapshot();
        reg = { text: lines[cy], linewise: true };
        deleteRegion({ linewise: true, y1: cy, y2: cy });
        modified = true;
        return null;
      }
      return `E492: Not an editor command: ${cmd}`;
    };
    const runShell = async (cmdline) => {
      const { CollectWriter, EmptyReader } = await import('../streams.js');
      const w = new CollectWriter();
      try {
        await ctx.shell.subshell().runSource(cmdline, { 0: new EmptyReader(), 1: w, 2: w });
      } catch {}
      return w.text;
    };
    const enterInsert = () => {
      mode = 'insert';
      insertStart = { lines: null };
    };
    let insertStart = null;
    let count = '';
    io.write(ALT_ON);
    try {
      for (;;) {
        if (mode === 'normal') clampX();
        draw();
        const raw = await io.key();
        const k = keyName(raw);
        if (mode === 'insert' || mode === 'replace') {
          const chars = L();
          if (k === 'esc' || k === 'C-c' || k === 'C-[') {
            mode = 'normal';
            cx = Math.max(0, cx - 1);
            msg = '';
            continue;
          }
          modified = true;
          if (k === 'enter') {
            const indent = '';
            lines[cy] = chars.slice(0, cx).join('');
            lines.splice(cy + 1, 0, indent + chars.slice(cx).join(''));
            cy++;
            cx = indent.length;
          } else if (k === 'backspace' || k === 'C-h') {
            if (cx > 0) {
              chars.splice(cx - 1, 1);
              lines[cy] = chars.join('');
              cx--;
            } else if (cy > 0) {
              const p = L(cy - 1).length;
              lines[cy - 1] += lines[cy];
              lines.splice(cy, 1);
              cy--;
              cx = p;
            }
          } else if (k === 'del') {
            if (cx < chars.length) {
              chars.splice(cx, 1);
              lines[cy] = chars.join('');
            }
          } else if (k === 'left') cx = Math.max(0, cx - 1);
          else if (k === 'right') cx = Math.min(chars.length, cx + 1);
          else if (k === 'up') {
            if (cy > 0) cy--;
            clampX(true);
          } else if (k === 'down') {
            if (cy < lines.length - 1) cy++;
            clampX(true);
          } else if (k === 'home') cx = 0;
          else if (k === 'end') cx = chars.length;
          else if (k === 'C-w') {
            const m = /\w*\W*$/.exec(chars.slice(0, cx).join(''));
            const n = [...m[0]].length || 1;
            chars.splice(cx - n, n);
            lines[cy] = chars.join('');
            cx -= n;
          } else if (k === 'tab' || !(raw.startsWith('\x1b') || (raw.length === 1 && raw.charCodeAt(0) < 32))) {
            const text = k === 'tab' ? '\t' : raw.replace(/\r\n?/g, '\n');
            for (const ch of text) {
              const cur = L();
              if (ch === '\n') {
                lines[cy] = cur.slice(0, cx).join('');
                lines.splice(cy + 1, 0, cur.slice(cx).join(''));
                cy++;
                cx = 0;
                continue;
              }
              if (mode === 'replace' && cx < cur.length) cur[cx] = ch;
              else cur.splice(cx, 0, ch);
              lines[cy] = cur.join('');
              cx++;
            }
          }
          continue;
        }
        if (mode === 'visual' || mode === 'visual-line') {
          if (k === 'esc' || k === 'C-c') {
            mode = 'normal';
            visualStart = null;
            continue;
          }
          if (k === 'd' || k === 'x' || k === 'y' || k === 'c' || k === '>' || k === '<' || k === '~' || k === 'U' || k === 'u' && false) {
            const r = mode === 'visual-line' ? { linewise: true, y1: Math.min(visualStart.y, cy), y2: Math.max(visualStart.y, cy) } : region({ y: visualStart.y, x: visualStart.x, inclusive: true }, false);
            if (mode !== 'visual-line') {
              const [a, b] = [visualStart, { y: cy, x: cx }].sort((p, q) => p.y - q.y || p.x - q.x);
              r.a = a;
              r.b = { y: b.y, x: b.x + 1 };
            }
            reg = { text: regionText(r), linewise: r.linewise };
            if (k === 'y') {
              cy = r.linewise ? r.y1 : r.a.y;
              cx = r.linewise ? 0 : r.a.x;
            } else if (k === '>' || k === '<') {
              snapshot();
              const y1 = r.linewise ? r.y1 : r.a.y;
              const y2 = r.linewise ? r.y2 : r.b.y;
              for (let y = y1; y <= y2; y++) lines[y] = k === '>' ? '\t' + lines[y] : lines[y].replace(/^(\t| {1,8})/, '');
              modified = true;
            } else if (k === '~' || k === 'U') {
              snapshot();
              const t = regionText(r);
              const conv = k === 'U' ? t.toUpperCase() : [...t].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
              deleteRegion(r);
              reg = { text: conv, linewise: r.linewise };
              put(false);
              modified = true;
            } else {
              snapshot();
              deleteRegion(r);
              modified = true;
              if (k === 'c') {
                if (r.linewise) lines.splice(cy, 0, '');
                mode = 'insert';
                visualStart = null;
                continue;
              }
            }
            mode = 'normal';
            visualStart = null;
            continue;
          }
          if (k === ':') {
            const c = await readCmdline(":'<,'>");
            if (c !== null) {
              const r = await exCommand("'<,'>" + c);
              if (r === 'QUIT') return 0;
              msg = r || '';
            }
            mode = 'normal';
            visualStart = null;
            continue;
          }
          if (k === 'o') {
            const t = visualStart;
            visualStart = { y: cy, x: cx };
            cy = t.y;
            cx = t.x;
            continue;
          }
          const m = await motion(k, Number(count || 1));
          count = '';
          if (m) {
            cy = m.y;
            cx = m.toEnd ? Math.max(0, L(m.y).length - 1) : m.x;
          }
          continue;
        }
        // normal mode
        msg = msg && k !== ':' ? msg : msg;
        if (/^[1-9]$/.test(k) || (k === '0' && count)) {
          count += k;
          continue;
        }
        const n = Number(count || 1);
        pendingCount = !!count;
        count = '';
        if (k === ':') {
          const c = await readCmdline(':');
          if (c === null) {
            msg = '';
            continue;
          }
          const r = await exCommand(c);
          if (r === 'QUIT') return 0;
          msg = r || '';
          continue;
        }
        if (k === '/' || k === '?') {
          const q = await readCmdline(k);
          if (q === null) continue;
          if (q) lastSearch = q;
          searchBack = k === '?';
          msg = '';
          const m = searchMotion(searchBack);
          if (m) {
            cy = m.y;
            cx = m.x;
          }
          continue;
        }
        msg = '';
        switch (k) {
          case 'i':
          case 'ins':
            snapshot();
            enterInsert();
            continue;
          case 'a':
            snapshot();
            if (L().length) cx++;
            enterInsert();
            continue;
          case 'I':
            snapshot();
            cx = (/\S/.exec(lines[cy]) || { index: 0 }).index;
            enterInsert();
            continue;
          case 'A':
            snapshot();
            cx = L().length;
            enterInsert();
            continue;
          case 'o':
          case 'O':
            snapshot();
            lines.splice(k === 'o' ? cy + 1 : cy, 0, '');
            if (k === 'o') cy++;
            cx = 0;
            modified = true;
            enterInsert();
            continue;
          case 'R':
            snapshot();
            mode = 'replace';
            continue;
          case 'v':
            mode = 'visual';
            visualStart = { y: cy, x: cx };
            continue;
          case 'V':
            mode = 'visual-line';
            visualStart = { y: cy, x: cx };
            continue;
          case 'x':
          case 'del':
          case 'X':
          case 's': {
            const chars = L();
            if (!chars.length) {
              if (k === 's') {
                snapshot();
                enterInsert();
              }
              continue;
            }
            snapshot();
            if (k === 'X') {
              const from = Math.max(0, cx - n);
              reg = { text: chars.slice(from, cx).join(''), linewise: false };
              chars.splice(from, cx - from);
              cx = from;
            } else {
              reg = { text: chars.slice(cx, cx + n).join(''), linewise: false };
              chars.splice(cx, n);
            }
            lines[cy] = chars.join('');
            modified = true;
            lastChange = { k, n };
            if (k === 's') enterInsert();
            continue;
          }
          case 'r': {
            const ch = await io.key();
            if (ch.length !== 1 || ch < ' ') continue;
            const chars = L();
            if (cx + n > chars.length) continue;
            snapshot();
            for (let i = 0; i < n; i++) chars[cx + i] = ch;
            lines[cy] = chars.join('');
            cx += n - 1;
            modified = true;
            continue;
          }
          case '~': {
            const chars = L();
            if (!chars.length) continue;
            snapshot();
            for (let i = 0; i < n && cx < chars.length; i++, cx++) {
              const c = chars[cx];
              chars[cx] = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
            }
            lines[cy] = chars.join('');
            modified = true;
            continue;
          }
          case 'J': {
            if (cy >= lines.length - 1) continue;
            snapshot();
            for (let i = 0; i < Math.max(1, n - 1) && cy < lines.length - 1; i++) {
              const a = lines[cy].replace(/\s+$/, '');
              const b = lines[cy + 1].replace(/^\s+/, '');
              cx = [...a].length;
              lines[cy] = a + (b && a ? ' ' : '') + b;
              lines.splice(cy + 1, 1);
            }
            modified = true;
            continue;
          }
          case 'p':
          case 'P':
            for (let i = 0; i < n; i++) put(k === 'p');
            continue;
          case 'u':
            if (!undo.length) {
              msg = 'Already at oldest change';
              continue;
            }
            redo.push({ lines: lines.slice(), cy, cx });
            ({ lines, cy, cx } = undo.pop());
            lines = lines.slice();
            modified = true;
            msg = '1 change; before #' + (undo.length + 1);
            continue;
          case 'C-r':
            if (!redo.length) {
              msg = 'Already at newest change';
              continue;
            }
            undo.push({ lines: lines.slice(), cy, cx });
            ({ lines, cy, cx } = redo.pop());
            lines = lines.slice();
            continue;
          case 'D':
          case 'C': {
            snapshot();
            const chars = L();
            reg = { text: chars.slice(cx).join(''), linewise: false };
            lines[cy] = chars.slice(0, cx).join('');
            modified = true;
            if (k === 'C') enterInsert();
            else cx = Math.max(0, cx - 1);
            continue;
          }
          case 'Y':
            reg = { text: lines.slice(cy, cy + n).join('\n'), linewise: true };
            continue;
          case 'S':
            snapshot();
            reg = { text: lines[cy], linewise: true };
            lines[cy] = '';
            cx = 0;
            modified = true;
            enterInsert();
            continue;
          case '.':
            if (lastChange && lastChange.k === 'dd') {
              snapshot();
              reg = { text: lines.slice(cy, cy + lastChange.n).join('\n'), linewise: true };
              deleteRegion({ linewise: true, y1: cy, y2: Math.min(lines.length - 1, cy + lastChange.n - 1) });
              modified = true;
            } else if (lastChange && (lastChange.k === 'x')) {
              const chars = L();
              if (chars.length) {
                snapshot();
                chars.splice(cx, lastChange.n);
                lines[cy] = chars.join('');
                modified = true;
              }
            }
            continue;
          case 'Z': {
            const k2 = await io.key();
            if (k2 === 'Z') {
              if (modified && !write(filename)) continue;
              return 0;
            }
            if (k2 === 'Q') return 0;
            continue;
          }
          case 'C-f':
          case 'pgdn':
            cy = Math.min(lines.length - 1, cy + textRows() - 2);
            top = Math.min(Math.max(0, lines.length - 1), top + textRows() - 2);
            continue;
          case 'C-b':
          case 'pgup':
            cy = Math.max(0, cy - textRows() + 2);
            top = Math.max(0, top - textRows() + 2);
            continue;
          case 'C-d':
            cy = Math.min(lines.length - 1, cy + Math.floor(textRows() / 2));
            continue;
          case 'C-u':
            cy = Math.max(0, cy - Math.floor(textRows() / 2));
            continue;
          case 'C-g':
            msg = `"${filename || '[No Name]'}"${modified ? ' [Modified]' : ''} ${lines.length} line${lines.length === 1 ? '' : 's'} --${Math.round(((cy + 1) / lines.length) * 100)}%--`;
            continue;
          case 'C-l':
            io.write('\x1b[2J');
            continue;
          case 'esc':
            continue;
          case '>':
          case '<': {
            const k2 = await io.key();
            if (k2 !== k) continue;
            snapshot();
            for (let y = cy; y < Math.min(lines.length, cy + n); y++) lines[y] = k === '>' ? '\t' + lines[y] : lines[y].replace(/^(\t| {1,8})/, '');
            modified = true;
            continue;
          }
          case 'g': {
            const k2 = await io.key();
            if (k2 === 'g') {
              const m = await motion('gg', n);
              cy = m.y;
              cx = (/\S/.exec(lines[cy]) || { index: 0 }).index;
            } else if (k2 === 'J') {
              if (cy < lines.length - 1) {
                snapshot();
                lines[cy] += lines[cy + 1];
                lines.splice(cy + 1, 1);
                modified = true;
              }
            } else if (k2 === 'u' || k2 === 'U') {
              const k3 = await io.key();
              if (k3 === k2) {
                snapshot();
                lines[cy] = k2 === 'u' ? lines[cy].toLowerCase() : lines[cy].toUpperCase();
                modified = true;
              }
            }
            continue;
          }
          case 'd':
          case 'c':
          case 'y': {
            let k2 = keyName(await io.key());
            let n2 = '';
            while (/^[0-9]$/.test(k2) && !(k2 === '0' && !n2)) {
              n2 += k2;
              k2 = keyName(await io.key());
            }
            const total = n * Number(n2 || 1);
            let r;
            if (k2 === k) {
              r = { linewise: true, y1: cy, y2: Math.min(lines.length - 1, cy + total - 1) };
            } else if (k2 === 'i' || k2 === 'a') {
              const obj = await io.key();
              const line = lines[cy];
              let a = cx;
              let b = cx;
              if (obj === 'w') {
                const isW = (c) => /\w/.test(c);
                const t = isW(line[cx]);
                while (a > 0 && isW(line[a - 1]) === t && !/\s/.test(line[a - 1]) === !/\s/.test(line[cx])) a--;
                while (b < line.length - 1 && isW(line[b + 1]) === t && !/\s/.test(line[b + 1]) === !/\s/.test(line[cx])) b++;
                if (k2 === 'a') while (b < line.length - 1 && /\s/.test(line[b + 1])) b++;
              } else if ('"\'`'.includes(obj)) {
                a = line.lastIndexOf(obj, cx - (line[cx] === obj ? 1 : 0));
                b = line.indexOf(obj, Math.max(a + 1, cx));
                if (a < 0 || b < 0) continue;
                if (k2 === 'i') {
                  a++;
                  b--;
                }
              } else if ('()b[]{}B<>'.includes(obj)) {
                const open = { ')': '(', b: '(', '(': '(', ']': '[', '[': '[', '}': '{', B: '{', '{': '{', '<': '<', '>': '<' }[obj];
                const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[open];
                let depth = 0;
                a = -1;
                for (let i = cx; i >= 0; i--) {
                  if (line[i] === close && i !== cx) depth++;
                  if (line[i] === open) {
                    if (depth === 0) {
                      a = i;
                      break;
                    }
                    depth--;
                  }
                }
                if (a < 0) continue;
                depth = 0;
                b = -1;
                for (let i = a + 1; i < line.length; i++) {
                  if (line[i] === open) depth++;
                  if (line[i] === close) {
                    if (depth === 0) {
                      b = i;
                      break;
                    }
                    depth--;
                  }
                }
                if (b < 0) continue;
                if (k2 === 'i') {
                  a++;
                  b--;
                }
              } else continue;
              r = { linewise: false, a: { y: cy, x: a }, b: { y: cy, x: b + 1 } };
            } else {
              const saveMode = mode;
              mode = 'op';
              let mk = k2;
              if (k2 === 'g') mk = (await io.key()) === 'g' ? 'gg' : null;
              if (k === 'c' && (k2 === 'w' || k2 === 'W')) mk = k2 === 'w' ? 'e' : 'E';
              const m = mk ? await motion(mk, total) : null;
              mode = saveMode;
              if (!m) continue;
              r = region(m, false);
            }
            reg = { text: regionText(r), linewise: r.linewise };
            if (k === 'y') {
              if (!r.linewise) {
                cy = r.a.y;
                cx = r.a.x;
              }
              if (r.linewise && r.y2 > r.y1) msg = `${r.y2 - r.y1 + 1} lines yanked`;
              continue;
            }
            snapshot();
            if (k === 'c' && r.linewise) {
              lines.splice(r.y1, r.y2 - r.y1 + 1, '');
              cy = r.y1;
              cx = 0;
            } else deleteRegion(r);
            modified = true;
            if (k === 'd' && k2 === 'd') lastChange = { k: 'dd', n: total };
            if (r.linewise && r.y2 - r.y1 >= 2 && k === 'd') msg = `${r.y2 - r.y1 + 1} fewer lines`;
            if (k === 'c') enterInsert();
            continue;
          }
          default: {
            const m = await motion(k, n);
            if (m) {
              cy = m.y;
              cx = m.toEnd ? Math.max(0, L(m.y).length - 1) : m.x;
            } else if (!msg && k.length > 1 && !['esc'].includes(k)) {}
          }
        }
      }
    } finally {
      io.write(ALT_OFF);
    }
  });
}

// ---------------------------------------------------------------- less / more

export async function pager(ctx, text, { name = '', prompt = null, isMore = false, quitAtEnd = false } = {}) {
  const term = ctx.shell.term;
  if (!term || !ctx.stdout.isTerminalWriter) {
    await ctx.out(text);
    return 0;
  }
  let lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return term.raw(async (io) => {
    const H = () => Math.max(1, io.rows() - 1);
    const W = () => io.cols();
    // wrap long lines into display rows
    const wrap = () => {
      const rows = [];
      const w = W();
      lines.forEach((l, li) => {
        const plain = l.replace(/\x1b\[[0-9;]*m/g, '');
        const disp = expandTabs(plain);
        if (strWidth(disp) <= w) rows.push({ li, s: l.includes('\x1b') ? l : disp });
        else for (let i = 0; i < strWidth(disp); i += w) rows.push({ li, s: sliceCols(disp, i, w) });
      });
      return rows;
    };
    let rows = wrap();
    let top = 0;
    let search = null;
    let msg = '';
    if (isMore && rows.length <= H()) {
      io.write(rows.map((r) => r.s).join('\r\n') + '\r\n');
      return 0;
    }
    const highlight = (s) => {
      if (!search) return s;
      try {
        return s.replace(new RegExp(search, 'gi'), (m) => `\x1b[7m${m}\x1b[27m`);
      } catch {
        return s;
      }
    };
    const draw = () => {
      let s = '\x1b[H\x1b[2J';
      for (let i = 0; i < H(); i++) {
        const r = rows[top + i];
        s += at(i, 0) + (r ? highlight(r.s) : '~') + RST;
      }
      s += at(H(), 0) + '\x1b[K';
      const atEnd = top + H() >= rows.length;
      if (msg) s += REV + msg + RST;
      else if (isMore) s += `${REV}--More--(${Math.min(100, Math.round(((top + H()) / Math.max(1, rows.length)) * 100))}%)${RST}`;
      else if (atEnd) s += `${REV}(END)${RST}`;
      else if (top === 0 && (prompt || name)) s += `${REV}${prompt || name}${RST}`;
      else s += ':';
      io.write(s);
    };
    const doSearch = (from, back) => {
      if (!search) return;
      let re;
      try {
        re = new RegExp(search, 'i');
      } catch {
        msg = 'Invalid pattern';
        return;
      }
      if (!back) {
        for (let i = from; i < rows.length; i++) if (re.test(rows[i].s.replace(/\x1b\[[0-9;]*m/g, ''))) {
          top = Math.min(i, Math.max(0, rows.length - H()));
          if (i > top) top = i;
          return;
        }
      } else {
        for (let i = from; i >= 0; i--) if (re.test(rows[i].s.replace(/\x1b\[[0-9;]*m/g, ''))) {
          top = i;
          return;
        }
      }
      msg = 'Pattern not found  (press RETURN)';
    };
    io.write(ALT_ON);
    try {
      for (;;) {
        const maxTop = Math.max(0, rows.length - H());
        if (top > maxTop) top = maxTop;
        if (top < 0) top = 0;
        draw();
        if ((isMore || quitAtEnd) && top >= maxTop && top + H() >= rows.length && isMore) {
          const k0 = keyName(await io.key());
          if (k0 !== 'b') return 0;
        }
        const k = keyName(await io.key());
        msg = '';
        switch (k) {
          case 'q':
          case 'Q':
          case 'C-c':
            return 0;
          case ' ':
          case 'f':
          case 'pgdn':
          case 'C-f':
          case 'C-v':
          case 'z':
            if (isMore && top >= maxTop) return 0;
            top += H();
            break;
          case 'b':
          case 'pgup':
          case 'C-b':
          case 'M-v':
          case 'w':
            top -= H();
            break;
          case 'j':
          case 'down':
          case 'enter':
          case 'e':
          case 'C-n':
          case 'C-e':
            if (isMore && top >= maxTop) return 0;
            top++;
            break;
          case 'k':
          case 'up':
          case 'y':
          case 'C-p':
          case 'C-y':
            top--;
            break;
          case 'd':
          case 'C-d':
            top += Math.floor(H() / 2);
            break;
          case 'u':
          case 'C-u':
            top -= Math.floor(H() / 2);
            break;
          case 'g':
          case '<':
          case 'home':
            top = 0;
            break;
          case 'G':
          case '>':
          case 'end':
            top = maxTop;
            break;
          case '/':
          case '?': {
            let q = '';
            for (;;) {
              io.write(at(H(), 0) + '\x1b[K' + k + q);
              const c = keyName(await io.key());
              if (c === 'enter') break;
              if (c === 'esc' || c === 'C-c') {
                q = null;
                break;
              }
              if (c === 'backspace') {
                if (!q) {
                  q = null;
                  break;
                }
                q = q.slice(0, -1);
              } else if (c.length === 1) q += c;
            }
            if (q === null) break;
            if (q) search = q;
            doSearch(k === '/' ? top + 1 : top - 1, k === '?');
            break;
          }
          case 'n':
            doSearch(top + 1, false);
            break;
          case 'N':
            doSearch(top - 1, true);
            break;
          case 'h':
          case 'H':
            msg = 'SUMMARY: q quit, space/f page down, b page up, j/k line, g/G top/bottom, /pattern search, n/N next/prev';
            break;
          default:
            break;
        }
      }
    } finally {
      io.write(ALT_OFF);
    }
  });
}

async function less(ctx) {
  const files = ctx.args.filter((a) => !a.startsWith('-') && !a.startsWith('+'));
  const isMore = ctx.name === 'more';
  if (!files.length) {
    if (ctx.stdin.isTerminal) {
      await ctx.err(isMore ? 'Usage: more [options] <file>...\n' : 'Missing filename ("less --help" for help)\n');
      return 1;
    }
    const text = await ctx.stdin.readAll();
    return pager(ctx, text, { isMore });
  }
  let st = 0;
  for (const f of files) {
    let text;
    try {
      const node = ctx.vfs.stat(f, ctx.cwd);
      if (node.type === 'dir') {
        await ctx.err(`${f} is a directory\n`);
        st = 1;
        continue;
      }
      text = ctx.vfs.readFile(f, ctx.cwd);
    } catch (e) {
      await ctx.err(`${f}: ${e.message}\n`);
      st = 1;
      continue;
    }
    if (!isMore && /[\0\udc80-\udcff]/.test(text.slice(0, 4000)) && ctx.shell.term) {
      await ctx.out(`"${f}" may be a binary file.  See it anyway? `);
      const k = await ctx.stdin.readLine();
      if (!/^[yY]/.test(k || '')) continue;
    }
    await pager(ctx, text, { name: f, isMore });
  }
  return st;
}

// ---------------------------------------------------------------- top / htop

function topSnapshot(ctx, htop = false) {
  const sh = ctx.shell;
  const sys = sh.system;
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const up = sys.uptimeSeconds();
  const upStr = up > 86400 ? `${Math.floor(up / 86400)} days, ${Math.floor((up % 86400) / 3600)}:${p(Math.floor((up % 3600) / 60))}` : `${Math.floor(up / 3600)}:${p(Math.floor((up % 3600) / 60))}`;
  const procs = [...sys.procs.values()];
  if (!sys.procs.has(sh.rootPid)) procs.push({ pid: sh.rootPid, ppid: 951, user: sh.user.name, cmd: '-bash', tty: 'pts/0', start: sys.boot });
  const total = 15912.0;
  const used = 2398.7 + sh.vfs.totalBytes() / 1048576;
  const cpu = (Math.random() * 2).toFixed(1);
  const rows = procs.map((pr) => ({
    ...pr,
    cpu: pr.cmd.includes('top') ? (Math.random() * 1.5).toFixed(1) : Math.random() < 0.1 ? (Math.random() * 0.7).toFixed(1) : '0.0',
    mem: ((pr.pid % 17) / 10).toFixed(1),
    virt: 10000 + (pr.pid % 991) * 131,
    res: 4000 + (pr.pid % 997) * 7,
  })).sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
  const load = [0.08 + Math.random() * 0.1, 0.05 + Math.random() * 0.05, 0.01 + Math.random() * 0.03].map((x) => x.toFixed(2));
  return { now, p, upStr, rows, total, used, cpu, load, procs };
}

async function top(ctx) {
  const batch = ctx.args.includes('-b');
  const nIdx = ctx.args.indexOf('-n');
  const iterations = nIdx >= 0 ? Number(ctx.args[nIdx + 1]) : batch ? 1 : Infinity;
  const term = ctx.shell.term;
  const render = (cols, maxRows) => {
    const s = topSnapshot(ctx);
    let out = `top - ${s.p(s.now.getHours())}:${s.p(s.now.getMinutes())}:${s.p(s.now.getSeconds())} up ${s.upStr},  1 user,  load average: ${s.load.join(', ')}\n`;
    out += `Tasks: ${String(s.procs.length + 180).padStart(3)} total,   1 running, ${String(s.procs.length + 179).padStart(3)} sleeping,   0 stopped,   0 zombie\n`;
    out += `%Cpu(s):  ${s.cpu} us,  0.3 sy,  0.0 ni, ${(99.5 - s.cpu).toFixed(1)} id,  0.0 wa,  0.0 hi,  0.1 si,  0.0 st \n`;
    out += `MiB Mem :  ${s.total.toFixed(1)} total,  ${(s.total - s.used - 3072).toFixed(1)} free,   ${s.used.toFixed(1)} used,   3072.0 buff/cache     \n`;
    out += `MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.  ${(s.total - s.used).toFixed(1)} avail Mem \n\n`;
    out += `${batch ? '' : REV}    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND${batch ? '' : ' '.repeat(Math.max(0, cols - 79)) + RST}\n`;
    const list = s.rows.slice(0, maxRows ? Math.max(0, maxRows - 7) : undefined);
    for (const r of list) {
      out += `${String(r.pid).padStart(7)} ${r.user.slice(0, 8).padEnd(8)}  20   0 ${String(r.virt).padStart(7)} ${String(r.res).padStart(6)} ${String(Math.floor(r.res * 0.7)).padStart(6)} ${r.cmd.includes('top') ? 'R' : 'S'} ${String(r.cpu).padStart(5)} ${String(r.mem).padStart(5)}   0:00.${String(r.pid % 100).padStart(2, '0')} ${r.cmd.split(' ')[0].split('/').pop().replace(/^-/, '').replace(/:$/, '')}\n`;
    }
    return out;
  };
  if (batch || !term || !ctx.stdout.isTerminalWriter) {
    for (let i = 0; i < (iterations === Infinity ? 1 : iterations); i++) {
      await ctx.out(render(80, 0) + '\n');
      if (i < iterations - 1) await ctx.shell.sleep(3000);
    }
    return 0;
  }
  return term.raw(async (io) => {
    io.write(ALT_ON + '\x1b[?25l');
    try {
      let n = 0;
      for (;;) {
        io.write('\x1b[H\x1b[2J' + render(io.cols(), io.rows()).replace(/\n/g, '\r\n'));
        if (++n >= iterations) return 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          const k = await Promise.race([io.key(), new Promise((r) => setTimeout(() => r(null), 3000 - (Date.now() - t0)))]);
          if (k === null) break;
          if (k === 'q' || k === '\x03' || k === '\x1b[21~') return 0;
          if (k === ' ') break;
        }
      }
    } finally {
      io.write('\x1b[?25h' + ALT_OFF);
    }
  });
}

async function htop(ctx) {
  const term = ctx.shell.term;
  if (!term || !ctx.stdout.isTerminalWriter) return top(ctx);
  return term.raw(async (io) => {
    io.write(ALT_ON + '\x1b[?25l');
    try {
      for (;;) {
        const s = topSnapshot(ctx, true);
        const cols = io.cols();
        const bar = (label, frac, color, text) => {
          const w = Math.max(10, Math.floor(cols / 2) - 8);
          const filled = Math.round(frac * w);
          const t = text.padStart(w - filled > text.length ? 0 : 0);
          const inner = `\x1b[${color}m${'|'.repeat(filled)}${RST}${' '.repeat(Math.max(0, w - filled - text.length))}\x1b[90m${t}${RST}`;
          return `\x1b[36m${label.padStart(3)}\x1b[0m\x1b[1m[${RST}${inner}\x1b[1m]${RST}`;
        };
        let out = '\x1b[H\x1b[2J';
        for (let c = 0; c < 4; c++) {
          const f = Math.random() * 0.06;
          out += ' ' + bar(String(c), f, '32', `${(f * 100).toFixed(1)}%`) + (c % 2 === 0 ? '   ' : '\r\n');
        }
        const memF = s.used / s.total;
        out += ' ' + bar('Mem', memF, '32', `${(s.used / 1024).toFixed(2)}G/${(s.total / 1024).toFixed(1)}G`) + `   Tasks: \x1b[1m${s.procs.length + 40}\x1b[0m, 72 thr; \x1b[32m1\x1b[0m running\r\n`;
        out += ' ' + bar('Swp', 0, '31', `0K/2.00G`) + `   Load average: ${s.load.join(' ')}\r\n`;
        out += `${' '.repeat(Math.floor(cols / 2) + 4)}Uptime: ${s.upStr}\r\n\r\n`;
        out += `\x1b[30;42m    PID USER       PRI  NI  VIRT   RES   SHR S CPU%▽MEM%   TIME+  Command${' '.repeat(Math.max(0, cols - 80))}${RST}\r\n`;
        for (const r of s.rows.slice(0, Math.max(0, io.rows() - 11))) {
          out += `${String(r.pid).padStart(7)} ${r.user.slice(0, 9).padEnd(9)}   20   0 ${String(Math.floor(r.virt / 1024)).padStart(4)}M ${String(Math.floor(r.res / 1024)).padStart(4)}M ${String(Math.floor(r.res / 1500)).padStart(4)}M ${r.cmd.includes('top') ? '\x1b[32mR\x1b[0m' : 'S'} ${String(r.cpu).padStart(4)} ${String(r.mem).padStart(4)}  0:00.${String(r.pid % 100).padStart(2, '0')} ${r.cmd}\r\n`;
        }
        out += at(io.rows() - 1, 0) + 'F1\x1b[30;46mHelp  \x1b[0mF2\x1b[30;46mSetup \x1b[0mF3\x1b[30;46mSearch\x1b[0mF4\x1b[30;46mFilter\x1b[0mF5\x1b[30;46mTree  \x1b[0mF6\x1b[30;46mSortBy\x1b[0mF7\x1b[30;46mNice -\x1b[0mF8\x1b[30;46mNice +\x1b[0mF9\x1b[30;46mKill  \x1b[0mF10\x1b[30;46mQuit  \x1b[0m';
        io.write(out);
        const k = await Promise.race([io.key(), new Promise((r) => setTimeout(() => r(null), 1500))]);
        if (k === 'q' || k === '\x03' || k === '\x1b[21~') return 0;
      }
    } finally {
      io.write('\x1b[?25h' + ALT_OFF);
    }
  });
}

// ---------------------------------------------------------------- sl / cmatrix

const D51 = [
  [
    '      ====        ________                ___________ ',
    '  _D _|  |_______/        \\__I_I_____===__|_________| ',
    '   |(_)---  |   H\\________/ |   |        =|___ ___|   ',
    '   /     |  |   H  |  |     |   |         ||_| |_||   ',
    '  |      |  |   H  |__--------------------| [___] |   ',
    '  | ________|___H__/__|_____/[][]~\\_______|       |   ',
    '  |/ |   |-----------I_____I [][] []  D   |=======|__ ',
  ],
  [
    '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ',
    ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ',
    '  \\_/      \\O=====O=====O=====O_/      \\_/            ',
  ],
  [
    '__/ =| o |=-~~\\  /~~\\  /~~\\  /~~\\ ____Y___________|__ ',
    ' |/-=|___|=O=====O=====O=====O   |_____/~\\___/        ',
    '  \\_/      \\__/  \\__/  \\__/  \\__/      \\_/            ',
  ],
  [
    '__/ =| o |=-O=====O=====O=====O \\ ____Y___________|__ ',
    ' |/-=|___|=    ||    ||    ||    |_____/~\\___/        ',
    '  \\_/      \\__/  \\__/  \\__/  \\__/      \\_/            ',
  ],
];
const COAL = [
  '                              ',
  '                              ',
  '    _________________         ',
  '   _|                \\_____A  ',
  ' =|                        |  ',
  ' -|                        |  ',
  '__|________________________|_ ',
  '|__________________________|_ ',
  '   |_D__D__D_|  |_D__D__D_|   ',
  '    \\_/   \\_/    \\_/   \\_/    ',
];
const SMOKE = ['                      (@@) (  ) (@)  ( )  @@    ()    @     O     @     O      @', '                 (   )', '             (@@@@)', '          (    )', '', '        (@@@)'];

async function sl(ctx) {
  const term = ctx.shell.term;
  if (!term || !ctx.stdout.isTerminalWriter) return 0;
  return term.raw(async (io) => {
    io.write(ALT_ON + '\x1b[?25l');
    try {
      const cols = io.cols();
      const rows = io.rows();
      const body = D51[0];
      const engineW = 54;
      const totalW = engineW + 30;
      const baseRow = Math.max(0, Math.floor(rows / 2) - 5);
      for (let x = cols; x > -totalW; x--) {
        const wheels = D51[1 + (((x % 3) + 3) % 3)];
        const loco = [...body, ...wheels];
        const lines = loco.map((l, i) => l + (COAL[i] || ''));
        let s = '\x1b[H\x1b[2J';
        const smokeRow = baseRow - 3;
        const smoke = (x % 4 < 2 ? SMOKE[0] : SMOKE[0].replace(/@/g, 'O').replace(/\(/g, ' (')).slice(0, 30);
        const put = (r, text, startX) => {
          if (r < 0 || r >= rows) return;
          let from = 0;
          let col = startX;
          if (col < 0) {
            from = -col;
            col = 0;
          }
          const seg = text.slice(from, from + Math.max(0, cols - col));
          if (seg) s += at(r, col) + seg;
        };
        put(smokeRow, smoke, x + 5);
        lines.forEach((l, i) => put(baseRow + i, l, x));
        io.write(s);
        await new Promise((r) => setTimeout(r, 35));
      }
    } finally {
      io.write('\x1b[?25h' + ALT_OFF);
    }
  });
}

async function cmatrix(ctx) {
  const term = ctx.shell.term;
  if (!term || !ctx.stdout.isTerminalWriter) return 0;
  return term.raw(async (io) => {
    io.write(ALT_ON + '\x1b[?25l\x1b[40m\x1b[2J');
    const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ0123456789ABCDEFZ:.=*+-<>¦|';
    try {
      const cols = io.cols();
      const rows = io.rows();
      const drops = Array.from({ length: Math.floor(cols / 2) }, () => ({ y: -Math.floor(Math.random() * rows), speed: 1 + Math.floor(Math.random() * 2), len: 5 + Math.floor(Math.random() * rows) }));
      for (;;) {
        let s = '';
        drops.forEach((d, i) => {
          const x = i * 2;
          for (let k = 0; k < d.speed; k++) {
            d.y++;
            const head = d.y;
            if (head >= 0 && head < rows) s += at(head, x) + '\x1b[1;37m' + chars[Math.floor(Math.random() * chars.length)];
            if (head - 1 >= 0 && head - 1 < rows) s += at(head - 1, x) + '\x1b[0;32m\x1b[40m' + chars[Math.floor(Math.random() * chars.length)];
            const tail = head - d.len;
            if (tail >= 0 && tail < rows) s += at(tail, x) + ' ';
            if (tail > rows) {
              d.y = -Math.floor(Math.random() * 10);
              d.len = 5 + Math.floor(Math.random() * rows);
            }
          }
        });
        io.write(s);
        const k = await Promise.race([io.key(), new Promise((r) => setTimeout(() => r(null), 50))]);
        if (k !== null && (k === 'q' || k === '\x03' || k === '\x1b')) return 0;
      }
    } finally {
      io.write('\x1b[0m\x1b[2J\x1b[?25h' + ALT_OFF);
    }
  }, { interruptible: false });
}

export function install(reg) {
  reg.set('nano', { fn: nano });
  reg.set('pico', { fn: nano });
  reg.set('vi', { fn: vim });
  reg.set('vim', { fn: vim });
  reg.set('vim.basic', { fn: vim });
  reg.set('view', { fn: vim });
  reg.set('editor', { fn: nano });
  reg.set('sensible-editor', { fn: nano });
  reg.set('less', { fn: less });
  reg.set('more', { fn: less });
  reg.set('pager', { fn: less });
  reg.set('top', { fn: top });
  reg.set('htop', { fn: htop, pkg: 'htop' });
  reg.set('sl', { fn: sl, pkg: 'sl' });
  reg.set('cmatrix', { fn: cmatrix, pkg: 'cmatrix' });
}

void abspath;
void InterruptEx;
