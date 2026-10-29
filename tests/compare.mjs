// Differential tests: run each snippet in the simulator and in real bash
// (inside a copy of the simulated home directory) and compare output.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sim } from './harness.mjs';
import { createMachine } from '../site/js/boot.js';
import { CASES as CASES1 } from './cases.mjs';
const CASES = process.env.CASES === '2' ? fs.readFileSync(new URL('./cases2.txt', import.meta.url), 'utf8').replace(/\n$/, '').split('\n%%\n') : CASES1;

function exportHome(dir) {
  const m = createMachine();
  const vfs = m.vfs;
  const walk = (p, rel) => {
    for (const name of vfs.readdir(p, '/')) {
      const full = p + '/' + name;
      const node = vfs.stat(full, '/', false);
      const target = path.join(dir, rel, name);
      if (node.type === 'dir') {
        fs.mkdirSync(target, { recursive: true });
        walk(full, path.join(rel, name));
      } else if (node.type === 'link') fs.symlinkSync(node.target, target);
      else {
        fs.writeFileSync(target, node.data);
        fs.chmodSync(target, node.mode & 0o777);
      }
    }
  };
  walk('/home/user', '');
}

const only = process.argv[2];
let pass = 0;
let fail = 0;
const failures = [];
for (const [i, c] of CASES.entries()) {
  const t = typeof c === 'string' ? { src: c } : c;
  if (only && !t.src.includes(only) && String(i) !== only) continue;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsim-'));
  exportHome(dir);
  let real;
  try {
    const r = execFileSync('bash', ['-c', t.src], {
      cwd: dir,
      env: { HOME: dir, PATH: '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', USER: 'user', TERM: 'dumb' },
      input: t.stdin || '',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    real = { out: r.toString(), err: '', status: 0 };
  } catch (e) {
    real = { out: e.stdout ? e.stdout.toString() : '', err: e.stderr ? e.stderr.toString() : '', status: e.status ?? -1 };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  let mine;
  try {
    mine = await Promise.race([sim(t.src, { stdin: t.stdin || '' }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]);
  } catch (e) {
    mine = { out: '', err: 'EXCEPTION ' + (e.stack || e), status: -2 };
  }
  const norm = (s) => s.split(dir).join('/home/user');
  const realOut = norm(real.out);
  const ok = realOut === mine.out && real.status === mine.status && (!t.err || norm(real.err) === mine.err);
  if (ok) pass++;
  else {
    fail++;
    failures.push({ i, src: t.src, real: { ...real, out: realOut, err: norm(real.err) }, mine: { out: mine.out, err: mine.err, status: mine.status } });
  }
}
for (const f of failures) {
  console.log(`\n=== FAIL #${f.i}: ${f.src}`);
  console.log('--- real (status ' + f.real.status + '):\n' + JSON.stringify(f.real.out) + (f.real.err ? '\nERR ' + JSON.stringify(f.real.err) : ''));
  console.log('--- sim  (status ' + f.mine.status + '):\n' + JSON.stringify(f.mine.out) + (f.mine.err ? '\nERR ' + JSON.stringify(f.mine.err) : ''));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
