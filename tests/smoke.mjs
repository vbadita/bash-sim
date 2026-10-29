import { sim } from './harness.mjs';
const src = process.argv[2];
const r = await sim(src);
process.stdout.write(r.out);
process.stderr.write(r.err);
console.error(`[status ${r.status}]`);
