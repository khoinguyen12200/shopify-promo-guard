---
description: Run make verify (lint + typecheck + test) and report results
disable-model-invocation: true
allowed-tools: Bash(make verify)
---

Run the full CI verification suite:

1. Run `make verify` (lint + typecheck + all tests)
2. If it passes, report success
3. If it fails, show the failing step and error output
4. Remind user: a failing `make verify` on main is a stop-the-line event
