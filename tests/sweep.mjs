// Run every command with a few argument shapes; report JS exceptions and hangs.
import { sim } from './harness.mjs';
import { makeRegistry } from '../site/js/boot.js';
const reg = makeRegistry();
const shapes = ['', '--help', 'README.md', '-x nofile', 'data/fruits.txt data/numbers.txt', '-l', '-a', '/etc'];
const skipInfinite = new Set(['watch', 'ping', 'cmatrix', 'top', 'htop', 'sl', 'tail']);
let bad = 0;
for (const name of [...reg.keys()].sort()) {
  for (const shape of shapes) {
    if (skipInfinite.has(name) && shape === '') continue;
    if (name === 'reset-sim') continue;
    const src = `${name} ${shape} </dev/null`;
    let r;
    let shell = null;
    let timer;
    try {
      r = await Promise.race([sim(src, { onShell: (s) => (shell = s) }), new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('TIMEOUT')), 3000)))]);
      clearTimeout(timer);
    } catch (e) {
      clearTimeout(timer);
      if (shell) shell.interrupt('KILL');
      if (String(e.message) === 'TIMEOUT' && (['sleep', 'yes', 'ping', 'tail', 'watch', 'top', 'apt', 'apt-get'].includes(name))) continue;
      console.log(`EXC  ${src}: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      bad++;
      continue;
    }
    if (/internal error|TypeError|ReferenceError|is not a function|undefined is not|Cannot read prop/.test(r.err + r.out)) {
      console.log(`ERR  ${src}: ${(r.err + r.out).slice(0, 300).replace(/\n/g, ' | ')}`);
      bad++;
    }
  }
}
console.log(`sweep done, ${bad} problems`);
