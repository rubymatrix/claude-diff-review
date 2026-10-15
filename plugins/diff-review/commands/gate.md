---
description: Turn the review gate on or off (on = Claude waits for your review after each turn that changes files)
argument-hint: on | off
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.js" gate $ARGUMENTS`

Report the gate status printed above in one line.
