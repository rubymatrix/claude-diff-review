#!/usr/bin/env node
'use strict';
// Local review server. Binds to 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./store');

const UI = path.join(__dirname, '..', 'ui', 'index.html');
const allowedHosts = new Set([`127.0.0.1:${S.PORT}`, `localhost:${S.PORT}`]);
const clients = new Set();

function send(res, code, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}
const readBody = (req) => new Promise((r) => {
  let d = ''; req.on('data', (c) => { d += c; if (d.length > 20e6) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});

// Change signature for live updates (cheap stat poll).
function signature() {
  const parts = [];
  const st = (f) => { try { const s = fs.statSync(f); parts.push(f + s.mtimeMs + ':' + s.size); } catch {} };
  st(S.p('config.json'));
  try { parts.push('fb:' + fs.readdirSync(S.p('feedback')).join(',')); } catch {}
  let ids = []; try { ids = fs.readdirSync(S.p('sessions')); } catch {}
  for (const id of ids) for (const n of ['changes.jsonl', 'state.json', 'review.json', 'meta.json']) st(path.join(S.sdir(id), n));
  return parts.join('|');
}
let lastSig = '';
let lastReviewWriter = null;
setInterval(() => {
  const sig = signature();
  if (sig !== lastSig) { lastSig = sig; for (const c of clients) c.write(`data: ${JSON.stringify({ t: Date.now(), by: lastReviewWriter })}\n\n`); lastReviewWriter = null; }
}, 700);
setInterval(() => { for (const c of clients) c.write(': ka\n\n'); }, 20000);

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, { error: 'bad host' });
    if (req.method !== 'GET' && req.headers.origin && !allowedHosts.has(req.headers.origin.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'bad origin' });
    const url = new URL(req.url, S.URL);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(UI, 'utf8'), 'text/html');
    if (parts[0] !== 'api') return send(res, 404, { error: 'not found' });
    const [, a, b, c] = parts;

    if (a === 'ping') return send(res, 200, { app: 'diff-review', version: S.VERSION, home: S.HOME });
    if (a === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: {"hello":1}\n\n');
      clients.add(res); req.on('close', () => clients.delete(res));
      return;
    }
    if (a === 'config') {
      if (req.method === 'PUT') { const body = await readBody(req); const allowed = {}; for (const k of ['gate', 'gateTimeoutSec', 'openOnGate', 'captureBash']) if (k in body) allowed[k] = body[k]; return send(res, 200, S.setConfig(allowed)); }
      return send(res, 200, S.config());
    }
    if (a === 'blob' && b) {
      if (!/^[a-f0-9]{64}$/.test(b)) return send(res, 400, { error: 'bad sha' });
      try { return send(res, 200, fs.readFileSync(S.blobPath(b), 'utf8'), 'text/plain'); } catch { return send(res, 404, { error: 'missing' }); }
    }
    if (a === 'feedback' && b && req.method === 'DELETE') return send(res, 200, { ok: S.cancelFeedback(b) });
    if (a === 'sessions' && !b) return send(res, 200, S.listSessions());
    if (a === 'sessions' && b) {
      const sid = S.safeId(b);
      if (req.method === 'DELETE' && !c) { S.deleteSession(sid); return send(res, 200, { ok: true }); }
      if (!c) {
        return send(res, 200, {
          meta: S.readJSON(path.join(S.sdir(sid), 'meta.json'), { id: sid }),
          state: S.getState(sid), changes: S.listChanges(sid), review: S.getReview(sid),
          queued: S.listFeedback().filter((f) => f.sessionId === sid),
        });
      }
      if (c === 'review' && req.method === 'PUT') { const body = await readBody(req); S.setReview(sid, body.review || body); lastReviewWriter = body.clientId || null; return send(res, 200, { ok: true }); }
      if (c === 'feedback' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.text || !String(body.text).trim()) return send(res, 400, { error: 'empty feedback' });
        const meta = S.readJSON(path.join(S.sdir(sid), 'meta.json'), {});
        const item = S.enqueueFeedback({ sessionId: sid, cwd: meta.cwd, text: String(body.text), target: body.target === 'project' ? 'project' : 'session' });
        S.setState(sid, { releasedThrough: Date.now() });
        return send(res, 200, item);
      }
      if (c === 'release' && req.method === 'POST') { S.setState(sid, { releasedThrough: Date.now() }); return send(res, 200, { ok: true }); }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: String(e && e.message) });
  }
});

server.on('error', (e) => { if (e.code === 'EADDRINUSE') process.exit(0); throw e; });
server.listen(S.PORT, '127.0.0.1', () => {
  if (process.stdout.isTTY) console.log(`diff-review listening on ${S.URL}  (data: ${S.HOME})`);
});
