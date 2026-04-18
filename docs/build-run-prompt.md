# Build Run Prompt

The single prompt you paste into a fresh Claude Code session to build Promo Guard from T01 to T54 autonomously.

---

## How to use

1. Open a fresh Claude Code session in this repo.
2. Copy the block below, paste, send.
3. Claude works task by task, spawning sub-agents per task.
4. It stops automatically when:
   - A task needs user input (OAuth login, secret value, etc.)
   - `make verify` fails after a sub-agent claims completion
   - It hits a task that genuinely requires a human decision

If it stops, tell it what to do about the stop reason, then type `continue`.

---

## The prompt

```
You are the build coordinator for Promo Guard.

Your job: execute the build plan in docs/build-plan.md from the first
unchecked task onwards, using sub-agents for each task so your own
context stays small. Write progress to STATE.md after each task.

START-OF-RUN:
  1. Read CLAUDE.md. Take the hard rules and the CLI-first rule
     as absolute constraints.
  2. Read STATE.md if it exists. Resume from its "next task" pointer.
     Otherwise start at the first unchecked task in docs/build-plan.md.
  3. Read docs/build-plan.md — but only the current task's entry
     in detail.
  4. PRE-FLIGHT (once, before T01):
     - Check `.env` exists and contains non-empty APP_KEK_HEX,
       SESSION_SECRET, SHOPIFY_API_KEY, SHOPIFY_API_SECRET,
       PLATFORM_ADMIN_ALLOWED_EMAILS.
     - Run `docker info >/dev/null` — if Docker isn't running, stop.
     - Run `shopify --version` — if missing, stop.
     - Run `rustup target list --installed | grep -q wasm32-wasip1` —
       if missing, run `rustup target add wasm32-wasip1`.
     - If `.env` is missing required keys, print the exact openssl +
       shopify-env-pull commands the user needs, then stop.

AUTO-DECISIONS (do NOT ask the user for these — decide and proceed):
  - T24: if `cart.discountCodes` is absent from the Validation
    Function schema, switch to Plan C (use
    `cart.lines.discountAllocations.discountApplication.title`),
    update `docs/function-queries-spec.md §3` in the same commit.
  - T42: accept unit-test-only coverage. Skip the integration test
    against a live dev store. Note this in STATE.md so the user can
    run it later manually.
  - Verify failures: dispatch a repair sub-agent. Retry up to 3
    times. Only stop if the 3rd repair fails.
  - Missing scaffold flags: always pass `--template`, `--flavor`,
    and `--name` to `shopify app generate extension` so it never
    prompts. If a new flag is introduced that the CLI requires,
    stop and ask.
  - Unknown package version: pin to the latest stable
    (`npm install pkg@latest`) unless the spec demands otherwise.

FOR EACH UNCHECKED TASK, IN ORDER:

  1. PREP (you, the coordinator):
     - Parse the task entry (ID, Specs, Depends, Files, Acceptance).
     - Verify all "Depends" tasks are checked. If not, stop and ask.
     - Read ONLY the spec sections the task references. Collect them
       as plain-text excerpts (not the whole spec file).

  2. DISPATCH (spawn one Agent with subagent_type=general-purpose):
     - Give it:
         * The full task entry text
         * The spec section excerpts you just collected
         * The absolute rules from CLAUDE.md §"Hard rules" and
           §"CLI-first rule"
         * These orders:

           "You are implementing task <Txx>. Follow the CLI-first
           rule strictly — scaffold files with the Shopify CLI,
           Prisma CLI, npm, etc., then edit the generated files.
           Do NOT hand-write files a CLI would generate.

           If a CLI prompts interactively, STOP and return with
           a report saying what the user needs to run manually.

           If a required env var or secret is missing, STOP and
           return with a report saying which one and why.

           Otherwise: implement the task, run `make verify`, and
           report whether every acceptance bullet is true.

           Do NOT commit — the coordinator handles commits."

  3. VERIFY (you, the coordinator, after the Agent returns):
     - If the Agent reports a blocker, write it to STATE.md and
       stop. Tell the user what's needed.
     - If the Agent claims completion:
         a) Run `make verify` yourself via Bash. If red, return
            the failure to a new sub-agent with the error log and
            ask it to fix.
         b) If green: review the git diff yourself via Bash
            (`git status`, `git diff --stat`) for obvious issues
            (files outside the task's declared Files list,
            suspiciously large changes, new dependencies the task
            didn't justify).
         c) If the diff looks right, `git add` the changed files
            and commit with message `T<xx>: <task title>`.
            Body should note any spec deviations.

  4. RECORD (you, the coordinator):
     - Edit docs/build-plan.md to flip `☐` → `☑` for this task.
     - Update STATE.md with the task just completed and the next
       task ID.
     - Commit the build-plan update as a separate commit
       `docs: mark T<xx> done`.

  5. LOOP: go to the next unchecked task.

STOP CONDITIONS (not failures — just pauses):
  - Pre-flight missing env or Docker/CLI/toolchain.
  - 3 repair attempts in a row all fail on the same task.
  - T50–T54: GCP not configured and user didn't pre-set DATABASE_URL /
    gcloud project. In that case, create the files (Dockerfile,
    cloudbuild.yaml, scripts) without running any `gcloud` commands
    and mark the files as "scaffolded, awaiting user deploy."
  - T55, T56: Shopify-side human submissions. Unavoidable.
  - All tasks complete.

UNATTENDED MODE (default for `run unattended` invocations):
When the user runs the prompt with the phrase "unattended" or tells
you they are leaving, override the stop conditions:

  - DO NOT ask the user anything. Never prompt.
  - Pre-flight handling:
      * Missing .env keys → generate `APP_KEK_HEX` and `SESSION_SECRET`
        via `openssl rand -hex 32`. Put placeholders for
        `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL`/
        `PLATFORM_ADMIN_ALLOWED_EMAILS`/`DATABASE_URL`/
        `DIRECT_DATABASE_URL` and log them in STATE.md under BLOCKED.
      * Missing Docker / Shopify CLI / Rust toolchain → try to proceed
        anyway. Any task that genuinely needs them will fail and get
        marked BLOCKED; non-dependent tasks still run.
  - Task blockers:
      * If a task cannot complete for any reason (interactive prompt
        needed, missing credential, network error after retry, CLI
        bug, schema mismatch) → DO NOT stop. Instead:
          - Revert any partial changes for that task
            (`git checkout -- .` on only the task's declared files).
          - Append a BLOCKED entry to STATE.md with: task ID, timestamp,
            failure reason, exact command/file that failed, what the
            user will need to do later.
          - Move the checkbox in docs/build-plan.md to `⚠` (blocked
            marker, not done).
          - Skip to the next task.
      * Before starting a task, check its `Depends`. If any dep is
        `⚠` blocked → mark current task `⊖` deferred with reason
        "depends on blocked T_x" and skip.
  - Verify failures:
      * After 3 repair attempts, mark BLOCKED and continue (do NOT
        stop).
  - CLI decisions when multiple choices exist:
      * Always pick the Shopify-recommended default (Rust for Function
        extensions, TypeScript for UI extensions).
      * Always pass every flag a CLI supports to avoid prompts. If
        the CLI still prompts, kill it, mark task BLOCKED.
  - Deploy tasks (T50–T54):
      * ALWAYS create the files (Dockerfile.prod, cloudbuild.yaml,
        scripts/setup-gcp-secrets.sh, scripts/deploy.sh). NEVER run
        `gcloud` commands. Mark the task as "files scaffolded" in
        STATE.md; don't mark it blocked — the code work is done.
  - Shopify App Store tasks (T55–T56):
      * Mark as BLOCKED immediately. Human-only.
  - End of run:
      * Produce STATE.md with three sections:
          ## Completed — list of ☑ tasks
          ## Blocked — list of ⚠ tasks with what the user must do
          ## Deferred — list of ⊖ tasks waiting on blockers
      * Commit final state as `docs: unattended run complete
        (N done, M blocked)`.
      * Stop gracefully. Do not keep trying.

Proceed through ALL 56 tasks. Don't stop until every task is in one
of: ☑ done, ⚠ blocked, ⊖ deferred.

COORDINATOR CONTEXT DISCIPLINE (critical — do not skip):

Every task you finish, AGGRESSIVELY drop context to stay lean:

  1. Sub-agent return values: read the report, extract ONLY:
       { taskId, status, oneLineSummary, blockedReason? }
     Throw away the full verbose return text. Do not re-reference it.
  2. Spec excerpts: after dispatching, discard the extracted spec
     text. The sub-agent has it. You don't need it anymore.
  3. Git diffs: review via `git diff --stat` (summary only), not
     full diff. Only read a specific file's diff if something
     looks suspicious in the stat output.
  4. File reads for task lookup: read ONE task entry from
     docs/build-plan.md at a time (use Grep with `-A 15` and the
     task ID as the pattern). Never read the whole build-plan file
     into memory in the loop.
  5. CLAUDE.md: read ONCE at run start. Do not re-read it
     per task.

SUB-AGENT REPORT FORMAT (enforce this):

When dispatching, tell the sub-agent to END its final message with
exactly this JSON block (nothing after it):

```
RESULT:
{
  "task_id": "T<xx>",
  "status": "done" | "blocked" | "deferred",
  "summary": "<one sentence under 120 chars>",
  "files_changed": ["path1", "path2"],
  "blocked_reason": "<only if status=blocked, one sentence>",
  "spec_deviations": "<only if spec was updated, one sentence>"
}
```

You only retain this JSON. Parse, act, discard everything else.

BIG-TASK GUARDRAIL:

Before dispatching, inspect the task's Files list:
  - If 1–3 files → dispatch one sub-agent for the whole task.
  - If 4–6 files → ask the sub-agent to pace itself but single dispatch.
  - If 7+ files OR the task is explicitly flagged "large" (T18, T25,
    T27, T45, T48) → split into sub-dispatches:
      * First dispatch: implement core logic files only.
      * Second dispatch: implement tests + run verify.
      * Third dispatch: if verify fails, repair.
    Each sub-dispatch returns its own RESULT JSON.

STATE.md HYGIENE:

Keep STATE.md under 5 KB. Structure:
  - Completed section: one line per task (e.g., "☑ T01 — docker-compose.yml").
    No details beyond task ID and title.
  - Blocked section: full detail per entry, max 8 lines each.
  - Deferred section: one line per task with "depends on T_x".
  - No chronological event log in unattended mode (that goes in git commits).

If STATE.md exceeds 5 KB, compact old Completed entries into a
single line "☑ T01–T20 (20 tasks, see git log for detail)".

IF THE COORDINATOR ITSELF HITS A CONTEXT LIMIT:

If your own context is approaching the cap before the run is done:
  1. Finalize STATE.md with everything you know.
  2. Write a final commit "checkpoint: coordinator context limit
     at T<xx>, <M> tasks remain".
  3. Leave a note in STATE.md saying "Resume with a fresh session
     using docs/build-run-prompt.md; next task is T<xx>".
  4. Stop gracefully.

The next session starts clean, reads STATE.md, resumes. No data lost.

IMPORTANT CONSTRAINTS:
  - You (the coordinator) never write implementation code yourself.
    Only sub-agents write code. You coordinate, run verify, and commit.
  - Spec documents are the source of truth. If implementation
    reality differs, update the spec in the SAME commit.
  - Do not push to any git remote.
  - Do not run `prisma migrate deploy` against a production URL.
  - Do not run `shopify app deploy` without the user's explicit
    go-ahead.
  - When in doubt, stop and ask.

Begin now. Read CLAUDE.md first.
```

---

## Why this works

- **Coordinator stays lean.** It only holds: current task ID, spec excerpts for that task, recent git log. Context never grows unbounded.
- **Sub-agents get fresh context per task.** Each Agent invocation starts clean, reads only what it needs, finishes, returns. No cross-task drift.
- **CLI-first.** Sub-agents scaffold with `shopify app generate extension` and `prisma migrate dev` rather than hand-writing boilerplate — far fewer bugs, matches Shopify's actual scaffold output.
- **Verify-gated commits.** Coordinator never commits until `make verify` is green, and reviews the diff for scope creep.
- **STATE.md is the resume pointer.** If you close and re-open, the coordinator picks up where it left off.

## Recovering from a stop

Common stop reasons and what to do:

| Stop reason | What you do |
|---|---|
| `shopify auth login` needed | Run `shopify auth login` yourself in terminal, then send `continue` to Claude |
| Missing env var (e.g., `APP_KEK_HEX`) | Generate the value (`openssl rand -hex 32`), put it in `.env`, send `continue` |
| Interactive prompt (template picker) | Ask Claude to re-dispatch the task with the exact `--template` and `--flavor` flags so it doesn't prompt |
| `make verify` fails | Send `continue — fix the failure`. Claude spawns a repair sub-agent. |
| Unknown Shopify schema field | Claude will flag it; decide with the user whether to update the spec or pick Plan B |
| Task needs human judgment (e.g., T55 app approval) | Handle externally, mark the checkbox manually in `docs/build-plan.md`, send `continue` |

## Safety notes

- The coordinator will NOT push to git or deploy anywhere without explicit go-ahead.
- It WILL write/edit files locally, run local commands, create commits, and install dependencies.
- If you're uncomfortable with any commit it's about to make, review via `git log --stat -5` before letting it continue.

## Abort

To stop mid-run: Ctrl+C the Claude Code session. Progress is preserved in `STATE.md` and committed tasks are already in git. A new session with the prompt above resumes where you left off.
