---
description: Pull any queued review feedback for this project and implement it
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" take`

If review feedback is shown above, implement every item in it now, then summarize what you changed for each item. If it says there is no pending feedback, say so in one line.
