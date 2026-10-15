# Claude Diff Review

A local review app that plugs straight into Claude Code. Every file change Claude makes (Edit, Write, MultiEdit, NotebookEdit, and files touched by Bash commands in git repos) is captured as a before/after snapshot with its **full absolute path**. You review the diffs in your browser, and **Send to Claude** feeds your notes back so Claude can implement them.

No dependencies, just Node 18+ (which Claude Code already needs) and git.

## Install

**Option A: as a Claude Code plugin (recommended)**

```
/plugin marketplace add rubymatrix/claude-diff-review
/plugin install diff-review@claude-diff-review
```

Restart Claude Code. The review server starts with each session at **http://127.0.0.1:7337**.

**Option B: plain hooks (no plugin system)**

```
git clone https://github.com/rubymatrix/claude-diff-review.git
node claude-diff-review/plugins/diff-review/scripts/cli.js install            # user-wide (~/.claude/settings.json)
node claude-diff-review/plugins/diff-review/scripts/cli.js install --project  # this repo only
```

Your existing settings are kept, and a backup is written to `settings.json.bak-diff-review`. To remove the hooks, run `cli.js uninstall`.

## Use

1. Work with Claude Code as usual. Open the UI with `/diff-review:open` (or just browse to http://127.0.0.1:7337).
2. **Every change** shows each edit in order, with its tool, timestamp and Bash command. **By file** shows the combined diff per file (first before → latest after). You can switch between unified and split views.
3. You can mark a change **Approve**, **Needs work** or **Reject**, add a note to it, or click any line number to leave a line comment. Shortcuts: `j`/`k` to move, `a`/`n`/`r` to set a verdict.
4. The right panel builds the prompt for Claude (rejected and needs-work changes with their diffs, line comments with file:line and code, your general notes). You can edit it, then click **Send to Claude**.

### How feedback reaches Claude

| Claude's state | Delivery |
|---|---|
| Mid-turn | The `Stop` hook blocks the stop and hands Claude your feedback, so it keeps working right away. |
| Idle | Your feedback is attached to your next message (`UserPromptSubmit` hook); typing "go" is enough. You can also run `/diff-review:feedback`. |
| **Hold Claude for review** on | At the end of every turn that changed files, Claude waits for you. **Send to Claude** starts it on your feedback immediately; **Approve all & let Claude continue** releases it. |

Turn the gate on with the header toggle or `/diff-review:gate on`. Under **Deliver to**, choose "next session in this project" if the current session has ended.

## Configuration

| Env var | Default | |
|---|---|---|
| `DIFF_REVIEW_PORT` | `7337` | UI/server port |
| `DIFF_REVIEW_HOME` | `~/.claude/diff-review` | data directory (snapshots, reviews, queue) |

`config.json` in the data directory has these settings: `gate`, `gateTimeoutSec` (default 1800), `openOnGate` (opens the browser the first time Claude waits), and `captureBash`.

## How it works

- `PreToolUse` snapshots the target file (or a shadow-git tree of the repo, for Bash). `PostToolUse` snapshots it again and records the change. Content is stored once by hash under `blobs/`.
- Bash capture uses a separate shadow git dir under the data directory. Your repo's `.git` is never touched, and `.gitignore` is respected.
- The server only listens on 127.0.0.1 and rejects foreign `Host`/`Origin` headers.
- Hooks never fail Claude Code: errors go to `hook-errors.log` in the data directory.

## Files

```
.claude-plugin/marketplace.json
plugins/diff-review/
  .claude-plugin/plugin.json
  hooks/hooks.json          SessionStart, Pre/PostToolUse, UserPromptSubmit, Stop
  commands/                 /diff-review:open, :gate, :feedback
  scripts/hook.js           hook entry point
  scripts/store.js          storage, feedback queue, shadow git
  scripts/server.js         local HTTP + SSE server
  scripts/cli.js            open | serve | status | gate | take | install | uninstall
  ui/index.html             the review app
```
