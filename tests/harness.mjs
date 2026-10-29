// Run bash source in the simulator from Node and capture stdout/stderr/status.
import { createMachine } from '../site/js/boot.js';
import { CollectWriter, StringReader } from '../site/js/streams.js';
import { ExitEx } from '../site/js/shell.js';

export async function sim(src, { stdin = '', cwd = null, setup = null, onShell = null } = {}) {
  const m = createMachine();
  const sh = m.newShell();
  if (onShell) onShell(sh);
  sh.interactive = false;
  sh.argv0 = 'bash';
  sh.scriptName = null;
  if (cwd) sh.cwd = cwd;
  const out = new CollectWriter();
  const err = new CollectWriter();
  const io = { 0: new StringReader(stdin), 1: out, 2: err };
  let status;
  try {
    if (setup) await setup(sh, m);
    status = await sh.runTop(src, io);
  } catch (e) {
    if (e instanceof ExitEx) status = typeof e.code === 'number' ? e.code : 0;
    else throw e;
  }
  await sh.finishPsubs();
  if (sh.traps.EXIT) await sh.runTrap('EXIT', io);
  return { out: out.text, err: err.text, status, sh, m };
}
