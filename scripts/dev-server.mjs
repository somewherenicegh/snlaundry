// Lightweight local dev server so you can run the whole app without netlify-cli.
//   node scripts/dev-server.mjs   →   http://localhost:8888
// Data is stored as JSON files under ./.data (Netlify Blobs is used in production).

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
process.env.FORCE_FILE_STORE = process.env.FORCE_FILE_STORE || '1';
process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.data');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'local-dev-secret';

const { handleRequest } = await import('../netlify/functions/api.js');

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const PRETTY = { '/order': 'order.html', '/track': 'track.html', '/app': 'app.html', '/': 'index.html' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const query = Object.fromEntries(url.searchParams.entries());
    let parsed = {}; try { parsed = body ? JSON.parse(body) : {}; } catch {}
    const result = await handleRequest({ method: req.method, path: pathname, query, body: parsed, headers: req.headers });
    if (result.contentType === 'text/csv') {
      res.writeHead(result.status, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${result.filename}"` });
      return res.end(result.body);
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result.body));
  }

  const rel = PRETTY[pathname] || pathname.replace(/^\//, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

const PORT = process.env.PORT || 8888;
server.listen(PORT, () => console.log(`Laundry app running at http://localhost:${PORT}`));
