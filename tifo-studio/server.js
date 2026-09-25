#!/usr/bin/env node
// Tiny zero-dependency local server for Tifo Studio.
// Serves ./public and stores projects as JSON files in ./projects.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'public');
const PROJECTS = path.join(__dirname, 'projects');
const MAX_BODY = 500 * 1024 * 1024;
fs.mkdirSync(PROJECTS, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const safeName = (n) => String(n).replace(/[^a-z0-9_\- ]/gi, '').trim().slice(0, 80);

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function api(req, res, p) {
  if (p === '/api/projects' && req.method === 'GET') {
    const items = fs.readdirSync(PROJECTS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const st = fs.statSync(path.join(PROJECTS, f));
        return { name: f.slice(0, -5), mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return send(res, 200, JSON.stringify(items), TYPES['.json']);
  }
  const m = p.match(/^\/api\/projects\/(.+)$/);
  if (!m) return send(res, 404, 'Not found');
  const name = safeName(decodeURIComponent(m[1]));
  if (!name) return send(res, 400, 'Bad name');
  const file = path.join(PROJECTS, name + '.json');

  if (req.method === 'GET') {
    if (!fs.existsSync(file)) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'DELETE') {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return send(res, 204, '');
  }
  if (req.method === 'PUT') {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return send(res, 413, 'Project too large');
      chunks.push(c);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    try {
      JSON.parse(body);
    } catch {
      return send(res, 400, 'Invalid JSON');
    }
    fs.writeFileSync(file + '.tmp', body);
    fs.renameSync(file + '.tmp', file);
    return send(res, 200, JSON.stringify({ ok: true, name }), TYPES['.json']);
  }
  return send(res, 405, 'Method not allowed');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (p.startsWith('/api/')) return await api(req, res, p);
    const file = path.normalize(path.join(ROOT, p === '/' ? 'index.html' : p));
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  } catch (err) {
    send(res, 500, String(err));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ⚽ Tifo Studio running at  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  console.log(`  Projects are saved in ${PROJECTS}\n`);
});
