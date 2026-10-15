'use strict';
// Shared storage layer for diff-review. Zero dependencies.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const HOME = process.env.DIFF_REVIEW_HOME || path.join(os.homedir(), '.claude', 'diff-review');
const PORT = Number(process.env.DIFF_REVIEW_PORT) || 7337;
const URL = `http://127.0.0.1:${PORT}`;
const MAX_BLOB = 5 * 1024 * 1024;
const VERSION = '1.0.0';

const p = (...a) => path.join(HOME, ...a);
const mkd = (d) => (fs.mkdirSync(d, { recursive: true }), d);
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeId = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 128);
const newId = () => Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');

function readJSON(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}
function writeJSON(f, v) {
  mkd(path.dirname(f));
  const tmp = `${f}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, f);
}

// ---------- config ----------
const DEFAULT_CONFIG = { gate: false, gateTimeoutSec: 1800, openOnGate: true, captureBash: true };
const config = () => ({ ...DEFAULT_CONFIG, ...readJSON(p('config.json'), {}) });
const setConfig = (patch) => { const c = { ...config(), ...patch }; writeJSON(p('config.json'), c); return c; };

// ---------- content-addressed blobs ----------
function readFileMaybe(f) {
  try { const st = fs.statSync(f); if (!st.isFile()) return null; return fs.readFileSync(f); }
  catch { return null; }
}
function putBlob(buf) {
  if (buf == null) return null;
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  const size = buf.length;
  if (size > MAX_BLOB) return { sha: null, tooLarge: true, size };
  const binary = buf.subarray(0, 8000).includes(0);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const f = p('blobs', sha.slice(0, 2), sha);
  if (!fs.existsSync(f)) { mkd(path.dirname(f)); fs.writeFileSync(f, buf); }
  return { sha, binary, size };
}
const blobPath = (sha) => p('blobs', sha.slice(0, 2), sha);

// ---------- pending pre-tool snapshots ----------
const writePending = (key, v) => writeJSON(p('pending', key + '.json'), v);
function takePending(key) {
  const f = p('pending', key + '.json');
  const v = readJSON(f, null);
  try { fs.unlinkSync(f); } catch {}
  return v;
}

// ---------- sessions ----------
const sdir = (sid) => p('sessions', safeId(sid));
function touchSession(sid, input) {
  const f = path.join(sdir(sid), 'meta.json');
  const m = readJSON(f, null) || { id: sid, firstTs: Date.now() };
  m.lastTs = Date.now();
  if (input && input.cwd) m.cwd = input.cwd;
  if (input && input.transcript_path) m.transcript = input.transcript_path;
  writeJSON(f, m);
}
function appendChange(sid, rec) {
  const r = { id: newId(), ts: Date.now(), ...rec };
  mkd(sdir(sid));
  fs.appendFileSync(path.join(sdir(sid), 'changes.jsonl'), JSON.stringify(r) + '\n');
  return r;
}
function listChanges(sid) {
  let txt = '';
  try { txt = fs.readFileSync(path.join(sdir(sid), 'changes.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of txt.split('\n')) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  out.sort((a, b) => a.ts - b.ts);
  out.forEach((c, i) => (c.seq = i + 1));
  return out;
}
const getState = (sid) => readJSON(path.join(sdir(sid), 'state.json'), { state: 'idle', waiting: false, releasedThrough: 0 });
function setState(sid, patch) {
  const s = { ...getState(sid), ...patch, updatedAt: Date.now() };
  writeJSON(path.join(sdir(sid), 'state.json'), s);
  return s;
}
function hasUnreviewed(sid) {
  const rt = getState(sid).releasedThrough || 0;
  return listChanges(sid).some((c) => c.ts > rt);
}
const getReview = (sid) => readJSON(path.join(sdir(sid), 'review.json'), { verdicts: {}, notes: {}, comments: [], general: '', sent: {} });
const setReview = (sid, r) => writeJSON(path.join(sdir(sid), 'review.json'), r);
function listSessions() {
  let ids = [];
  try { ids = fs.readdirSync(p('sessions')); } catch {}
  const q = listFeedback();
  return ids.map((id) => {
    const meta = readJSON(path.join(sdir(id), 'meta.json'), { id });
    const ch = listChanges(id);
    return {
      ...meta, id,
      changeCount: ch.length,
      files: new Set(ch.map((c) => c.file)).size,
      lastChangeTs: ch.length ? ch[ch.length - 1].ts : 0,
      ...getState(id),
      queued: q.filter((f) => f.sessionId === id).length,
    };
  }).filter((s) => s.changeCount > 0 || s.waiting).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}
function deleteSession(sid) { fs.rmSync(sdir(sid), { recursive: true, force: true }); }

// ---------- feedback queue ----------
function enqueueFeedback({ sessionId, cwd, text, target }) {
  const item = { id: newId(), sessionId: safeId(sessionId), cwd: cwd || null, target: target || 'session', text, createdAt: Date.now() };
  writeJSON(p('feedback', item.id + '.json'), item);
  return item;
}
function listFeedback() {
  let names = [];
  try { names = fs.readdirSync(p('feedback')).filter((n) => n.endsWith('.json')); } catch {}
  return names.map((n) => readJSON(p('feedback', n), null)).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt);
}
function cancelFeedback(id) { try { fs.unlinkSync(p('feedback', safeId(id) + '.json')); return true; } catch { return false; } }
// Atomically claim every queued item for this session (or project-targeted items for this cwd).
function takeFeedback(sid, cwd, anyInCwd = false) {
  sid = safeId(sid);
  const sameCwd = (f) => cwd && f.cwd && path.resolve(cwd) === path.resolve(f.cwd);
  const mine = listFeedback().filter((f) => f.sessionId === sid || ((f.target === 'project' || anyInCwd) && sameCwd(f)));
  const texts = [];
  for (const f of mine) {
    const src = p('feedback', f.id + '.json');
    const dst = p('delivered', f.id + '.json');
    mkd(p('delivered'));
    try { fs.renameSync(src, dst); } catch { continue; } // someone else claimed it
    writeJSON(dst, { ...f, deliveredTo: sid, deliveredAt: Date.now() });
    texts.push(f.text);
  }
  if (!texts.length) return null;
  return texts.join('\n\n---\n\n');
}

// ---------- shadow git (captures Bash-driven changes in git repos) ----------
function gitTop(cwd) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; }
  catch { return null; }
}
function shadowDir(top) {
  const gd = p('shadow', hash(top).slice(0, 16) + '.git');
  if (!fs.existsSync(path.join(gd, 'HEAD'))) {
    mkd(gd);
    execFileSync('git', ['init', '-q', '--bare', gd], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', gd, 'config', 'core.bare', 'false'], { stdio: 'ignore' });
    execFileSync('git', ['--git-dir', gd, 'config', 'core.autocrlf', 'false'], { stdio: 'ignore' });
  }
  try { // honour the real repo's info/exclude
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: top, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const ex = path.resolve(top, common, 'info', 'exclude');
    if (fs.existsSync(ex)) { mkd(path.join(gd, 'info')); fs.copyFileSync(ex, path.join(gd, 'info', 'exclude')); }
  } catch {}
  return gd;
}
function sgit(top, gd, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: top, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_DIR: gd, GIT_WORK_TREE: top, GIT_INDEX_FILE: path.join(gd, 'index') }, ...opts,
  });
}
function shadowTree(top) {
  try {
    const gd = shadowDir(top);
    sgit(top, gd, ['add', '-A', '--ignore-errors', '.'], { timeout: 25000 });
    return sgit(top, gd, ['write-tree']).toString().trim();
  } catch { return null; }
}
function treeDiff(top, t1, t2, limit = 200) {
  const gd = shadowDir(top);
  const parts = sgit(top, gd, ['diff-tree', '-r', '-z', '--no-renames', t1, t2]).toString('utf8').split('\0');
  const res = [];
  const blob = (sha, mode) => (/^0+$/.test(sha) || mode === '160000') ? null : putBlob(sgit(top, gd, ['cat-file', 'blob', sha]));
  for (let i = 0; i + 1 < parts.length && res.length < limit; i += 2) {
    const h = parts[i];
    if (!h.startsWith(':')) break;
    const [m1, m2, s1, s2] = h.slice(1).split(' ');
    if (m1 === '160000' || m2 === '160000') continue;
    res.push({ file: path.join(top, parts[i + 1]), before: blob(s1, m1), after: blob(s2, m2) });
  }
  return res;
}

// ---------- server lifecycle ----------
function ping() {
  return new Promise((r) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/ping', timeout: 400 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(d.includes('diff-review')));
    });
    req.on('error', () => r(false));
    req.on('timeout', () => { req.destroy(); r(false); });
  });
}
async function ensureServer() {
  if (await ping()) return true;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 25; i++) { await sleep(150); if (await ping()) return true; }
  return false;
}
function openBrowser(url) {
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

module.exports = {
  HOME, PORT, URL, VERSION, p, mkd, hash, sleep, safeId, readJSON, writeJSON,
  config, setConfig, readFileMaybe, putBlob, blobPath, writePending, takePending,
  sdir, touchSession, appendChange, listChanges, getState, setState, hasUnreviewed,
  getReview, setReview, listSessions, deleteSession,
  enqueueFeedback, listFeedback, cancelFeedback, takeFeedback,
  gitTop, shadowTree, treeDiff, ping, ensureServer, openBrowser,
};
