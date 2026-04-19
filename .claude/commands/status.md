---
description: Show project status — git, branch, recent commits, uncommitted changes
allowed-tools: Bash(git status) Bash(git log *) Bash(git branch *) Bash(git diff *)
---

Show current project status:

1. Current branch: `git branch --show-current`
2. Git status (unstaged/staged): `git status`
3. Recent commits (last 5): `git log --oneline -5`
4. Any uncommitted changes summary: `git diff --stat`

Report findings in a concise summary.
