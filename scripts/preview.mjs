#!/usr/bin/env node
// Serve public/ on http://127.0.0.1:4747 to preview the site locally.
//   node scripts/preview.mjs [--port 4747]

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const i = process.argv.indexOf('--port');
const PORT = Number(i > 0 ? process.argv[i + 1] : process.env.PORT || 4747);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
    const file = path.resolve(PUBLIC, `.${decodeURIComponent(rel)}`);
    if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Preview on http://127.0.0.1:${PORT}/`));
