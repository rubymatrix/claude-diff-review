#!/usr/bin/env node
'use strict';
// diff-review CLI
//   node cli.js open            start the server (if needed) and open the UI
//   node cli.js serve           run the server in the foreground
//   node cli.js status          show server/config status
//   node cli.js gate on|off     toggle the review gate
//   node cli.js take            print (and claim) queued feedback for the current directory
//   node cli.js install [--project]   add hooks to ~/.claude/settings.json (or ./.claude/settings.json)
//   node cli.js uninstall [--project]
const fs = require('fs');
const path = require('path');
const os = require('os');
const S = require('./store');

const [cmd, ...args] = process.argv.slice(2);
const EVENTS = { SessionStart: ['session-start', null, 15], PreToolUse: ['pre', 'Edit|Write|MultiEdit|NotebookEdit|Bash', 60], PostToolUse: ['post', 'Edit|Write|MultiEdit|NotebookEdit|Bash', 60], UserPromptSubmit: ['prompt', null, 15], Stop: ['stop', null, 3600] };
const HOOK = path.join(__dirname, 'hook.js');
const MARK = 'diff-review/scripts/hook.js';

function settingsPath() {
  return args.includes('--project') ? path.join(process.cwd(), '.claude', 'settings.json') : path.join(os.homedir(), '.claude', 'settings.json');
}
function stripOurs(settings) {
  const h = settings.hooks || {};
  for (const ev of Object.keys(h)) {
    h[ev] = (h[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((x) => !String(x.command || '').replace(/\\/g, '/').includes(MARK)) })).filter((g) => g.hooks.length);
    if (!h[ev].length) delete h[ev];
  }
  settings.hooks = h;
  return settings;
}

(async () => {
  switch (cmd) {
    case 'open': {
      const ok = await S.ensureServer();
      const url = S.URL + '/';
      if (!ok) { console.log(`Could not start the diff-review server on port ${S.PORT}. Run: node "${path.join(__dirname, 'server.js')}"`); break; }
      S.openBrowser(url);
      console.log(`Diff review UI: ${url}`);
      break;
    }
    case 'serve': require('./server'); break;
    case 'status': {
      const up = await S.ping();
      console.log(JSON.stringify({ server: up ? S.URL : 'not running', data: S.HOME, config: S.config(), queuedFeedback: S.listFeedback().length }, null, 2));
      break;
    }
    case 'gate': {
      if (args[0] === 'on' || args[0] === 'off') S.setConfig({ gate: args[0] === 'on' });
      console.log(`Review gate is ${S.config().gate ? 'ON — Claude will wait for your review after each turn that changes files' : 'OFF — feedback is delivered when Claude finishes a turn or on your next prompt'}.`);
      break;
    }
    case 'take': {
      const fb = S.takeFeedback('__cli__', process.cwd(), true);
      console.log(fb || 'No pending review feedback for this project.');
      break;
    }
    case 'install':
    case 'uninstall': {
      const f = settingsPath();
      let settings = {};
      if (fs.existsSync(f)) { settings = JSON.parse(fs.readFileSync(f, 'utf8')); fs.copyFileSync(f, f + '.bak-diff-review'); }
      stripOurs(settings);
      if (cmd === 'install') {
        for (const [ev, [arg, matcher, timeout]] of Object.entries(EVENTS)) {
          const group = { hooks: [{ type: 'command', command: `node "${HOOK}" ${arg}`, timeout }] };
          if (matcher) group.matcher = matcher;
          (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
        }
      }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(settings, null, 2) + '\n');
      console.log(`${cmd === 'install' ? 'Installed' : 'Removed'} diff-review hooks in ${f}`);
      if (cmd === 'install') console.log(`Restart Claude Code, then open ${S.URL}/ (or run: node "${__filename}" open)`);
      break;
    }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
})();
