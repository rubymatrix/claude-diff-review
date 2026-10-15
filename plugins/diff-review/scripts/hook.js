#!/usr/bin/env node
'use strict';
// Single entry point for every Claude Code hook event used by diff-review.
//   node hook.js <session-start|pre|post|prompt|stop>
// Hooks must never break Claude Code, so every failure path exits 0 silently.
const path = require('path');
const S = require('./store');

const FILE_TOOLS = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
const event = process.argv[2];

const readStdin = () => new Promise((r) => {
  let d = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (d += c));
  process.stdin.on('end', () => r(d));
  process.stdin.on('error', () => r(d));
});
const out = (o) => process.stdout.write(JSON.stringify(o));
const keyFor = (input, extra) => S.safeId(input.tool_use_id || S.hash(`${input.session_id}|${extra}`).slice(0, 32));

function targetPath(input) {
  const field = FILE_TOOLS[input.tool_name];
  const v = field && input.tool_input && input.tool_input[field];
  return v ? path.resolve(input.cwd || process.cwd(), v) : null; // always absolute
}
const sameBlob = (a, b) => (a == null && b == null) || (a && b && a.sha && a.sha === b.sha);

function pre(input) {
  const t = input.tool_name;
  if (FILE_TOOLS[t]) {
    const f = targetPath(input);
    if (f) S.writePending(keyFor(input, f), { file: f, before: S.putBlob(S.readFileMaybe(f)) });
  } else if (t === 'Bash' && S.config().captureBash) {
    const top = S.gitTop(input.cwd || process.cwd());
    if (!top) return;
    const tree = S.shadowTree(top);
    if (tree) S.writePending(keyFor(input, 'bash'), { top, tree });
  }
}

// If no pre-snapshot exists (e.g. hooks installed mid-session) reconstruct "before" for Edit/MultiEdit.
function reconstruct(input, afterBuf) {
  if (!afterBuf) return null;
  const ti = input.tool_input || {};
  const edits = input.tool_name === 'Edit' ? [ti] : input.tool_name === 'MultiEdit' ? (ti.edits || []).slice().reverse() : null;
  if (!edits) return undefined;
  let txt = afterBuf.toString('utf8');
  for (const e of edits) {
    if (typeof e.new_string !== 'string' || typeof e.old_string !== 'string') return undefined;
    txt = e.replace_all ? txt.split(e.new_string).join(e.old_string) : txt.replace(e.new_string, () => e.old_string);
  }
  return S.putBlob(txt);
}

function post(input, sid) {
  const t = input.tool_name;
  const base = { cwd: input.cwd, toolUseId: input.tool_use_id || null };
  if (FILE_TOOLS[t]) {
    const f = targetPath(input);
    if (!f) return;
    const pend = S.takePending(keyFor(input, f));
    const afterBuf = S.readFileMaybe(f);
    const after = S.putBlob(afterBuf);
    let before = pend ? pend.before : reconstruct(input, afterBuf);
    const beforeUnknown = before === undefined;
    if (beforeUnknown) before = null;
    if (!beforeUnknown && sameBlob(before, after)) return;
    const meta = {};
    if (t === 'Edit' && input.tool_input.replace_all) meta.replaceAll = true;
    if (t === 'MultiEdit') meta.edits = (input.tool_input.edits || []).length;
    S.appendChange(sid, { ...base, tool: t, file: f, before, after, beforeUnknown, meta });
  } else if (t === 'Bash') {
    const pend = S.takePending(keyFor(input, 'bash'));
    if (!pend) return;
    const tree2 = S.shadowTree(pend.top);
    if (!tree2 || tree2 === pend.tree) return;
    const ti = input.tool_input || {};
    for (const ch of S.treeDiff(pend.top, pend.tree, tree2)) {
      S.appendChange(sid, { ...base, tool: 'Bash', file: ch.file, before: ch.before, after: ch.after,
        meta: { command: String(ti.command || '').slice(0, 2000), description: ti.description || '' } });
    }
  }
}

async function stop(input, sid) {
  const deliver = (fb) => { S.setState(sid, { state: 'working', waiting: false, releasedThrough: Date.now() }); out({ decision: 'block', reason: fb }); };
  let fb = S.takeFeedback(sid, input.cwd);
  if (fb) return deliver(fb);

  const cfg = S.config();
  if (!cfg.gate || !S.hasUnreviewed(sid)) { S.setState(sid, { state: 'idle', waiting: false }); return; }

  // Review gate: hold Claude at the end of its turn until the reviewer sends feedback or approves.
  await S.ensureServer();
  const st = S.setState(sid, { state: 'waiting', waiting: true, waitingSince: Date.now() });
  if (cfg.openOnGate && !st.opened) { S.openBrowser(`${S.URL}/#/s/${encodeURIComponent(sid)}`); S.setState(sid, { opened: true }); }
  const release = () => { S.setState(sid, { state: 'idle', waiting: false }); };
  process.on('SIGTERM', () => { release(); process.exit(0); });
  process.on('SIGINT', () => { release(); process.exit(0); });

  const deadline = Date.now() + (cfg.gateTimeoutSec || 1800) * 1000;
  while (Date.now() < deadline) {
    await S.sleep(1000);
    fb = S.takeFeedback(sid, input.cwd);
    if (fb) return deliver(fb);
    if (!S.config().gate || !S.hasUnreviewed(sid)) break;
  }
  release();
}

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || '{}'); } catch {}
  const sid = S.safeId(input.session_id);
  S.touchSession(sid, input);
  switch (event) {
    case 'session-start':
      await S.ensureServer();
      S.setState(sid, { state: 'idle', waiting: false });
      break;
    case 'prompt': {
      S.setState(sid, { state: 'working', waiting: false });
      const fb = S.takeFeedback(sid, input.cwd);
      if (fb) out({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: fb } });
      break;
    }
    case 'pre': S.setState(sid, { state: 'working' }); pre(input); break;
    case 'post': post(input, sid); break;
    case 'stop': await stop(input, sid); break;
  }
}

main().catch((e) => {
  try { require('fs').appendFileSync(S.p('hook-errors.log'), `${new Date().toISOString()} ${event} ${e && e.stack}\n`); } catch {}
}).finally(() => { process.exitCode = 0; });
