// Drive the real page in headless Chromium: type commands, read the xterm buffer.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { serve } from './serve.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const port = 8765 + Math.floor(Math.random() * 1000);
const server = await serve(port);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => (m.type() === 'error' || /Content Security Policy|Refused/.test(m.text())) && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/bash/`);
await page.waitForSelector('.xterm-rows');

const screen = () => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((d) => d.textContent.replace(/ /g, ' ').trimEnd()).join('\n'));
const waitFor = async (re, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await screen();
    if (re.test(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n--- screen ---\n${s}`);
    await page.waitForTimeout(100);
  }
};
const type = async (s) => {
  await page.keyboard.type(s, { delay: 5 });
};
const run = async (cmd) => {
  await type(cmd);
  await page.keyboard.press('Enter');
};

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log('ok   ', name);
  } catch (e) {
    failed++;
    console.log('FAIL ', name, '\n', e.message.slice(0, 1500));
  }
};

await check('prompt appears', () => waitFor(/user@badita:~\$$/m));
await check('echo', async () => {
  await run('echo hello $((6*7))');
  await waitFor(/^hello 42$/m);
});
await check('ls colors and files', async () => {
  await run('ls');
  await waitFor(/README\.md/);
});
await check('tab completion', async () => {
  await type('cat REA');
  await page.keyboard.press('Tab');
  await waitFor(/cat README\.md$/m);
  await page.keyboard.press('Enter');
  await waitFor(/Welcome to bash in the browser/);
});
await check('history up arrow', async () => {
  await page.keyboard.press('Control+L');
  await page.keyboard.press('ArrowUp');
  await waitFor(/\$ cat README\.md$/m);
  await page.keyboard.press('Control+U');
  await run('history | tail -2');
  await waitFor(/history \| tail -2/);
});
await check('multi-line if', async () => {
  await page.keyboard.press('Control+L');
  await run('if true; then');
  await waitFor(/^>$/m);
  await run('echo inside');
  await run('fi');
  await waitFor(/^inside$/m);
});
await check('ctrl-c interrupts sleep', async () => {
  await page.keyboard.press('Control+L');
  await run('sleep 100');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+C');
  await run('echo after-$?');
  await waitFor(/^after-130$/m);
});
await check('read from terminal', async () => {
  await page.keyboard.press('Control+L');
  await run('read -p "name? " n; echo "hi $n"');
  await waitFor(/name\?$/m);
  await run('Ana');
  await waitFor(/^hi Ana$/m);
});
await check('cat interactive with ctrl-d', async () => {
  await page.keyboard.press('Control+L');
  await run('cat > typed.txt');
  await run('line one');
  await page.keyboard.press('Control+D');
  await run('wc -l typed.txt');
  await waitFor(/^1 typed\.txt$/m);
});
await check('nano edits and saves', async () => {
  await page.keyboard.press('Control+L');
  await run('nano new.txt');
  await waitFor(/GNU nano/);
  await type('written in nano');
  await page.keyboard.press('Control+O');
  await waitFor(/File Name to Write/);
  await page.keyboard.press('Enter');
  await waitFor(/Wrote 1 line/);
  await page.keyboard.press('Control+X');
  await run('cat new.txt');
  await waitFor(/^written in nano$/m);
});
await check('vim edits and saves', async () => {
  await page.keyboard.press('Control+L');
  await run('vim v.txt');
  await waitFor(/~/);
  await type('ihello vim');
  await page.keyboard.press('Escape');
  await type(':wq');
  await page.keyboard.press('Enter');
  await run('cat v.txt');
  await waitFor(/^hello vim$/m);
});
await check('less pager', async () => {
  await page.keyboard.press('Control+L');
  await run('seq 200 | less');
  await waitFor(/^1$/m);
  await page.keyboard.press('G');
  await waitFor(/\(END\)/);
  await page.keyboard.press('q');
  await run('echo pager-done');
  await waitFor(/^pager-done$/m);
});
await check('background job notification', async () => {
  await page.keyboard.press('Control+L');
  await run('sleep 0.3 &');
  await waitFor(/^\[1\] \d+$/m);
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await waitFor(/\[1\]\+\s+Done\s+sleep 0\.3/);
});
await check('sudo and apt install cowsay', async () => {
  await page.keyboard.press('Control+L');
  await run('sudo apt install -y cowsay && cowsay moo');
  await waitFor(/< moo >/, 15000);
});
await check('top quits with q', async () => {
  await page.keyboard.press('Control+L');
  await run('top');
  await waitFor(/load average/);
  await page.keyboard.press('q');
  await run('echo top-done');
  await waitFor(/^top-done$/m);
});
await check('man page', async () => {
  await page.keyboard.press('Control+L');
  await run('man ls');
  await waitFor(/list directory contents/);
  await page.keyboard.press('q');
});
await check('persistence across reload', async () => {
  await run('echo persisted > keep.txt');
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.xterm-rows');
  await waitFor(/user@badita:~\$$/m);
  await run('cat keep.txt');
  await waitFor(/^persisted$/m);
});
await check('exit and relogin', async () => {
  await page.keyboard.press('Control+L');
  await run('exit');
  await waitFor(/Press Enter to log in again/);
  await page.keyboard.press('Enter');
  await waitFor(/user@badita:~\$$/m);
});
await check('nested bash and exit', async () => {
  await page.keyboard.press('Control+L');
  await run('bash');
  await run('echo level $SHLVL');
  await waitFor(/^level 2$/m);
  await run('exit');
  await run('echo back $SHLVL');
  await waitFor(/^back 1$/m);
});
await check('sudo -i gives a root prompt', async () => {
  await page.keyboard.press('Control+L');
  await run('sudo -i');
  await waitFor(/root@badita:~#$/m);
  await run('whoami; pwd');
  await waitFor(/^root\n\/root$/m);
  await run('exit');
  await run('whoami');
  await waitFor(/^user$/m);
});
await check('su fails without password', async () => {
  await page.keyboard.press('Control+L');
  await run('su');
  await waitFor(/Password:/);
  await run('guess');
  await waitFor(/su: Authentication failure/, 6000);
});
await check('ctrl-r reverse search', async () => {
  await page.keyboard.press('Control+L');
  await run('echo unique-marker-123');
  await page.keyboard.press('Control+R');
  await type('marker');
  await waitFor(/reverse-i-search\)`marker': echo unique-marker-123/);
  await page.keyboard.press('Enter');
  await waitFor(/unique-marker-123\n[^\n]*\n?unique-marker-123|unique-marker-123[\s\S]*unique-marker-123[\s\S]*unique-marker-123/);
});
await check('script with shebang and chmod', async () => {
  await page.keyboard.press('Control+L');
  await run("printf '#!/bin/bash\\necho script-ran $1\\n' > s.sh; chmod +x s.sh; ./s.sh ok");
  await waitFor(/^script-ran ok$/m);
});
await check('yes floods and ctrl-c stops it', async () => {
  await page.keyboard.press('Control+L');
  await run('yes hello');
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(300);
  await run('echo stopped-$?');
  await waitFor(/^stopped-130$/m, 15000);
});
await check('no page errors', async () => {
  if (errors.length) throw new Error(errors.join('\n'));
});
await page.screenshot({ path: path.join(root, '..', 'tests', 'screenshot.png') });
await browser.close();
server.close();
console.log(failed ? `${failed} UI checks failed` : 'all UI checks passed');
process.exit(failed ? 1 : 0);
