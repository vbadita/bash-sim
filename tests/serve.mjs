// Static server for local testing with the same headers nginx sends (CSP!).
//   node tests/serve.mjs [port]   -> serves site/ at http://127.0.0.1:<port>/bash/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const conf = fs.readFileSync(path.join(root, '..', 'deploy', 'nginx', 'bash-headers.inc'), 'utf8');
const headers = {};
for (const m of conf.matchAll(/^add_header\s+(\S+)\s+"([^"]*)"/gm)) headers[m[1]] = m[2];
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8', svg: 'image/svg+xml', json: 'application/json', flf: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8' };

export function serve(port) {
  const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/bash') {
      res.writeHead(301, { Location: '/bash/' });
      return res.end();
    }
    if (!url.startsWith('/bash/')) {
      res.writeHead(404);
      return res.end();
    }
    let rel = url.slice('/bash/'.length) || 'index.html';
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, headers);
      return res.end('not found');
    }
    res.writeHead(200, { ...headers, 'Content-Type': types[path.extname(file).slice(1)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 8080);
  await serve(port);
  console.log(`serving http://127.0.0.1:${port}/bash/`);
}
