'use strict';
/*
 * Local test server for browser tests:
 *   /            -> the PWA from docs/ (config.js rewritten to point at /api)
 *   POST /api    -> the REAL apps-script/Code.gs running in the Apps Script mock
 *   /__test/...  -> helpers for the tests (issue sessions, inspect sheets, simulate failures)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createRuntime } = require('./gas-mock');

const DOCS = path.join(__dirname, '..', 'docs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.jpg': 'image/jpeg' };

function start(port) {
  const rt = createRuntime({ ownerEmail: 'admin@example.com' });
  rt.g.setup();
  rt.g.setSetting_('ClientID', 'test-client');
  const tok = (e) => rt.g.issueSession_(e);
  rt.g.handle_({ action: 'saveUser', token: tok('admin@example.com'), email: 'team@example.com', name: 'Ali Team', role: 'Team' });
  rt.g.handle_({ action: 'saveUser', token: tok('admin@example.com'), email: 'boss@example.com', name: 'Bos', role: 'Boss' });
  rt.g.handle_({ action: 'saveUser', token: tok('admin@example.com'), email: 'admin@example.com', name: 'Admin Satu', role: 'Admin' });

  const flags = { down: false, dropNextResponse: 0, calls: [], configMarker: 'v1' };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (req.method === 'OPTIONS') { flags.calls.push({ action: 'PREFLIGHT' }); res.writeHead(204); return res.end(); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (flags.down) { req.socket.destroy(); return; }
        const out = rt.g.doPost({ postData: { contents: body }, parameter: {} }).getContent();
        let action = '?';
        try { action = JSON.parse(body).action; } catch (e) { /* ignore */ }
        flags.calls.push({ action, contentType: req.headers['content-type'] });
        if (flags.dropNextResponse > 0 && action === 'uploadPhoto') {
          flags.dropNextResponse--; // server did the work but the phone never hears back
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(out);
      });
      return;
    }
    if (url.pathname.startsWith('/__test/')) {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const what = url.pathname.slice(8);
      if (what === 'session') return send({ token: tok(url.searchParams.get('email')) });
      if (what === 'sheet') return send(rt.state.sheets[url.searchParams.get('name')].rowsAsObjects());
      if (what === 'flags') {
        ['down'].forEach((k) => { if (url.searchParams.has(k)) flags[k] = url.searchParams.get(k) === '1'; });
        if (url.searchParams.has('configMarker')) flags.configMarker = url.searchParams.get('configMarker');
        if (url.searchParams.has('dropNextResponse')) flags.dropNextResponse = Number(url.searchParams.get('dropNextResponse'));
        return send({ down: flags.down, dropNextResponse: flags.dropNextResponse, calls: flags.calls });
      }
      if (what === 'rotateSecret') { rt.state.props.SESSION_SECRET = 'rotated-' + Date.now(); return send({ ok: true }); }
      res.writeHead(404); return res.end();
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(DOCS, p);
    if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let data = fs.readFileSync(file);
    if (p === '/js/config.js') {
      data = Buffer.from(`window.SOLAR_CONFIG = { API_URL: 'http://localhost:${server.address().port}/api', CLIENT_ID: 'test-client', marker: '${flags.configMarker}' };`);
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
  return new Promise((resolve) => server.listen(port || 0, () => resolve({ server, rt, flags, port: server.address().port })));
}

module.exports = { start };
if (require.main === module) {
  start(Number(process.argv[2]) || 8080).then(({ port }) => console.log('Test server on http://localhost:' + port));
}
