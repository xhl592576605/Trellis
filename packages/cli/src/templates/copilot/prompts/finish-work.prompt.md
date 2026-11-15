---
description: "Trellis Copilot prompt: Finish Work — survey + archive task + record session journal"
---

# Finish Work

Wrap up the current session: archive the active task (and any other completed-but-unarchived tasks the user wants to clean up) and record the session journal. Code commits are NOT done here — those happen in workflow Phase 3.4 before you invoke this prompt.

**Timing**: After Phase 3.4 (Commit changes) — when the working tree is already clean.

---

## Step 1: Survey current state

```bash
python3 ./.trellis/scripts/get_context.py --mode record
```

This prints:

- **My active tasks** — review whether any besides the current one are actually done (code merged, AC met) and should be archived this round.
- **Git status** — quick visual on what's dirty.
- **Recent commits** — you'll need their hashes in Step 4 for `--commit`.

If `--mode record` surfaces other completed tasks not tied to the current session, surface them to the user with a one-shot confirmation: "These N tasks look done — archive them too in this round? [y/N]". Default is no; the current active task is always archived in Step 3 regardless.

## Step 2: Sanity check — classify dirty paths

Run:

```bash
git status --porcelain
```

Filter out paths under `.trellis/workspace/` and `.trellis/tasks/` — those are managed by `add_session.py` and `task.py archive` auto-commits and will appear dirty as part of this prompt's own work.

For each remaining dirty path, decide whether it belongs to **the current task** or to **other parallel work** (e.g., another terminal window editing the same repo). Heuristics:

- Paths referenced in the current task's `prd.md` / `implement.jsonl` / `check.jsonl` → current task
- Paths in code areas matching the task's stated scope, or that you remember editing this session → current task
- Paths in unrelated areas you have no recollection of touching this session → other parallel work

Then route:

- **Any remaining path looks like current-task work** — bail out with:
  > "Working tree has uncommitted code changes from this task: `<list>`. Return to workflow Phase 3.4 to commit them before running `/finish-work`."

  Do NOT run `git commit` here. Do NOT prompt the user to commit. The user goes back to Phase 3.4 and the AI drives the batched commit there.
- **All remaining paths look unrelated** (other parallel-window work) — report them once and continue to Step 3:
  > "FYI, dirty files outside this task's scope — leaving them for the other window: `<list>`."
- **Genuinely unsure** — ask the user once: "Are `<list>` this task's work I forgot to commit, or another window's? (commit / ignore)" — then route per their answer.

## Step 3: Archive task(s)

```bash
python3 ./.trellis/scripts/task.py archive <task-name>
```

At minimum: the current active task (if any). Plus any extra tasks the user confirmed in Step 1. Each archive produces a `chore(<project>): archive task ...` commit — in the project's data repository (the external storage repo when a root config is present, otherwise the code repo), never both.

If a task was moved into `archive/` but its commit failed, the script persists a recovery state under the project's `.runtime/` and exits non-zero. Do NOT re-archive the task and do NOT hand-copy the directory back — the next `add_session.py` run in the same checkout/session (Step 4) retries exactly that commit. Other sessions' pending archives stay untouched. After a session change, explicitly name the archive being resumed with `--require-commit --recover-archive <task-name>` (repeatable); do not adopt every pending task.

If there is no active task and the user did not confirm any cleanup archives, skip this step.

## Step 4: Record session journal (the final external-data commit)

```bash
python3 ./.trellis/scripts/add_session.py \
  --title "Session Title" \
  --commit "hash1,hash2" \
  --summary "Brief summary" \
  --require-commit
```

Use the work-commit hashes produced in Phase 3.4 (visible in Step 1's `Recent commits` list, or via `git log --oneline`) for `--commit`. Do not include the archive commit hashes from Step 3. This produces a `chore(<project>): record journal` commit in the data repository (the project-scope prefix is injected automatically).

`--require-commit` is the finish-work success condition: this task's external data changes MUST be committed before the task counts as finished. It also overrides `session_auto_commit: false` for this one invocation and retries any pending archive commit left by a failed Step 3 — report its exit code honestly; a non-zero exit means the finish is NOT complete.

If this session edited Trellis data files outside the task directory (e.g. `.trellis/spec/...`), include each explicitly:

```bash
  --include-path .trellis/spec/cli/backend/<file>.md
```

Never list files you did not edit this session — attribution comes from this explicit list, not from scanning for dirty files. Files inside the task directory need no flag; they are covered automatically.

Two repositories, two reports. When a root config is present, report separately:

- Code commits (Phase 3.4): hashes + subjects from the CODE repository.
- Data commits (Step 3 + Step 4): archive/journal commits in the STORAGE repository.

Final commit order: `<work commits from 3.4 in the code repo>` → `chore(<project>): archive task ...` → `chore(<project>): record journal` (the latter two in the data repo).

---

## Relationship to Other Commands

```
Development Flow (workflow.md Phase 3):
  3.2 Debug retrospective (on demand)
  3.3 Spec update
  3.4 Commit changes  -> AI drafts batched commits, user confirms
  3.5 Wrap-up         -> /finish-work (this prompt: survey + archive + journal)
  (3.1 was folded into 2.2 + 3.4 — see workflow.md "Phase 3: Finish" note)

Debug Flow:
  Hit bug -> Fix -> /break-loop -> Knowledge capture
```

- `/finish-work` — survey + archive + record session (this prompt)
- `/break-loop` — deep analysis after debugging

---

## Core Principle

> **Finish-work is pure bookkeeping.** Code is already committed before this runs. If the working tree is dirty, this prompt refuses to proceed.
