// Browser entry point: xterm.js <-> Terminal <-> Shell, persistence, login loop.

import { createMachine, VERSION } from './boot.js';
import { Terminal as Term } from './terminal.js';
import { ExitEx } from './shell.js';

const STORE_KEY = 'bashsim.fs.v1';
const XTerm = window.Terminal;
const FitAddon = window.FitAddon && window.FitAddon.FitAddon;

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

let storageWarned = false;

const xterm = new XTerm({
  cursorBlink: true,
  fontFamily: '"DejaVu Sans Mono", "Ubuntu Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: window.matchMedia('(max-width: 600px)').matches ? 13 : 15,
  lineHeight: 1.1,
  scrollback: 5000,
  allowProposedApi: false,
  macOptionIsMeta: true,
  theme: {
    background: '#300a24',
    foreground: '#ffffff',
    cursor: '#ffffff',
    selectionBackground: '#b5d5ff66',
    black: '#2e3436', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
    brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
  },
});
const fit = FitAddon ? new FitAddon() : null;
if (fit) xterm.loadAddon(fit);
xterm.open(document.getElementById('terminal'));
const refit = () => {
  try {
    if (fit) fit.fit();
  } catch {}
};
refit();
window.addEventListener('resize', refit);
if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

// backpressure: xterm.js parses asynchronously; when a program floods output
// (yes, cat of a big file) wait for the backlog to drain so the page stays
// responsive and Ctrl-C is seen
let backlog = 0;
let drainWaiters = [];
const HIGH = 256 * 1024;
const term = new Term({
  write: (s) => {
    backlog += s.length;
    xterm.write(s, () => {
      backlog -= s.length;
      if (backlog < HIGH / 4 && drainWaiters.length) {
        const w = drainWaiters;
        drainWaiters = [];
        w.forEach((f) => f());
      }
    });
    if (backlog > HIGH) return new Promise((r) => drainWaiters.push(r));
    return undefined;
  },
  get cols() {
    return xterm.cols;
  },
  get rows() {
    return xterm.rows;
  },
});
xterm.onData((d) => term.feed(d));
const titleEl = document.querySelector('.bar .title');
term.onPrompt = (sh) => {
  const t = `${sh.user.name}@${sh.system.hostname}: ${sh.tildeShort(sh.getVar('PWD') || sh.cwd)}`;
  if (titleEl) titleEl.textContent = t;
  document.title = t;
};
// window title from OSC sequences (PS1 may set it)
xterm.onTitleChange((t) => (document.title = t || 'bash'));

// on-screen keys for touch devices
const keybar = document.getElementById('keybar');
if (keybar) {
  let ctrl = false;
  const ctrlBtn = keybar.querySelector('[data-key="ctrl"]');
  keybar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = b.dataset.key;
    const map = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C', 'ctrl-c': '\x03', 'ctrl-d': '\x04', pipe: '|', tilde: '~', slash: '/', dash: '-' };
    if (k === 'ctrl') {
      ctrl = !ctrl;
      ctrlBtn.classList.toggle('on', ctrl);
    } else term.feed(map[k] || '');
    xterm.focus();
  });
  xterm.onData(() => {});
  const origFeed = term.feed.bind(term);
  term.feed = (d) => {
    if (ctrl && d.length === 1 && /[a-z@[\\\]^_]/i.test(d)) {
      ctrl = false;
      ctrlBtn.classList.remove('on');
      return origFeed(String.fromCharCode(d.toUpperCase().charCodeAt(0) & 31));
    }
    return origFeed(d);
  };
}

const extraCommands = {
  'reset-sim': {
    fn: async (ctx) => {
      if (ctx.stdin.isTerminal && !ctx.args.includes('-f')) {
        await ctx.out('This deletes every file and setting of this simulated machine and starts fresh. Continue? [y/N] ');
        const a = await ctx.stdin.readLine();
        if (!/^[yY]/.test(a || '')) return 1;
      }
      try {
        localStorage.removeItem(STORE_KEY);
      } catch {}
      window.removeEventListener('beforeunload', saveNow);
      location.reload();
      await new Promise(() => {});
    },
  },
};

let machine = createMachine({ restore: readStore(), extraCommands });
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const data = { v: 1, version: VERSION, saved: Date.now(), hostname: machine.system.hostname, installed: [...machine.system.installed], fs: machine.vfs.serialize() };
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      term.write('\r\n\x1b[33mwarning: could not save the filesystem in this browser (storage full or disabled); changes last until you close the tab.\x1b[0m\r\n');
    }
  }
}
machine.vfs.onChange = () => {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 700);
};
window.addEventListener('beforeunload', saveNow);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow());

function lastLoginLine() {
  let prev = null;
  try {
    prev = localStorage.getItem('bashsim.lastlogin');
    localStorage.setItem('bashsim.lastlogin', String(Date.now()));
  } catch {}
  if (!prev) return '';
  const d = new Date(Number(prev));
  return `Last login: ${d.toString().slice(0, 24)} from 192.168.1.10\r\n`;
}

async function session() {
  const sh = machine.newShell();
  sh.term = term;
  // restore history
  try {
    const h = machine.vfs.readFile('/home/user/.bash_history', '/');
    sh.history.push(...h.split('\n').filter(Boolean));
  } catch {}
  let motd = '';
  try {
    motd = machine.vfs.readFile('/etc/motd', '/');
  } catch {}
  term.write(motd + '\n');
  xterm.write(lastLoginLine());
  try {
    await term.repl(sh, { rcFiles: ['/etc/profile', '/home/user/.profile'] });
    return { reason: 'logout' };
  } catch (e) {
    if (e instanceof ExitEx) return { reason: 'exit', detail: e.code };
    throw e;
  }
}

async function waitForEnter(msg) {
  term.write(msg);
  for (;;) {
    const k = await term.nextKey();
    if (k === '\r' || k === '\n' || k === ' ') return;
  }
}

async function main() {
  xterm.focus();
  for (;;) {
    let r;
    try {
      r = await session();
    } catch (e) {
      console.error(e);
      term.write(`\r\n\x1b[31minternal error: ${e && e.message}\x1b[0m\r\n`);
      r = { reason: 'crash' };
    }
    saveNow();
    const detail = r.detail && typeof r.detail === 'object' ? r.detail : null;
    if (detail && detail.reboot) {
      term.write(`\r\nConnection to ${machine.system.hostname} closed by remote host.\r\n`);
      await new Promise((res) => setTimeout(res, 800));
      machine = createMachine({ restore: JSON.parse(JSON.stringify({ fs: machine.vfs.serialize(), installed: [...machine.system.installed], hostname: machine.system.hostname })), extraCommands });
      machine.vfs.onChange = () => {
        if (!saveTimer) saveTimer = setTimeout(saveNow, 700);
      };
      if (detail.reboot === 'poweroff') await waitForEnter('\r\nThe machine is powered off. Press Enter to power it on again.');
      xterm.write('\x1bc');
      continue;
    }
    if (detail && detail.restart && !detail.killed) {
      continue;
    }
    term.write(`Connection to ${machine.system.hostname} closed.\r\n`);
    await waitForEnter('\r\n\x1b[2m[Press Enter to log in again]\x1b[0m');
    xterm.write('\x1bc');
  }
}

main();
