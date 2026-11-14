# Filesystem Safety — Atomic Writes & Destructive-Op Guards

> Cross-cutting contract for any code that **writes, deletes, moves, or
> overwrites** files in a user's repo. Trellis ships as a CLI that runs inside
> real git repos, so a truncated write or a mistargeted delete is user data
> loss, not a transient bug. These are the guardrails the 2026-07-10 audit's
> two root causes distilled to.

Applies to: `commands/update.ts`, `commands/uninstall.ts`, `utils/*`,
`core/channel/**`, and the shipped Python under `templates/trellis/scripts/`.

---

## 1. Atomic writes — never truncate a state file in place

**Rule**: a file that holds durable state (attribution manifest, `task.json`,
`config.yaml`, session pointer, channel events cursor) must be written
**temp-in-same-dir + rename**, never `fs.writeFileSync(path, ...)` /
`path.write_text(...)` directly. In-place writes truncate the target as their
first step, so a crash / Ctrl-C / ENOSPC mid-write leaves a half-file. A
truncated `.template-hashes.json` heals to `{}` (every managed file then looks
user-modified); a truncated `task.json` reads back as `None` (the task vanishes
from `task.py list`).

### Signatures

```ts
// packages/cli/src/utils/atomic-write.ts
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void
// writes `<dir>/.<basename>.<pid>.tmp` then fs.renameSync over filePath;
// removes the tmp and rethrows on failure. Same-dir tmp keeps rename atomic.
```

```python
# templates/trellis/scripts/common/io.py
def write_json(path: Path, data: dict) -> bool
def write_text_atomic(path: Path, text: str) -> bool
# tempfile.mkstemp(dir=path.parent) -> os.fdopen write -> os.replace(tmp, path);
# unlinks tmp and re-raises on BaseException (Ctrl-C included).
# write_json serializes and delegates, so both share one implementation.
```

`write_text_atomic` covers the Markdown state files, not just JSON:
`add_session.py` appends to `journal-*.md` and rewrites `index.md` through it.
Those two carry the session record that a retry classifies, so a half-written
one is not a cosmetic defect — it is pending evidence nothing can resume from.
The append is read-all + write-all rather than `open("a")` for exactly that
reason.

### Wrong vs Correct

```ts
// Wrong — truncates on entry; a crash here corrupts the manifest to {}
fs.writeFileSync(hashesPath, JSON.stringify(payload, null, 2));

// Correct
writeFileAtomic(hashesPath, JSON.stringify(payload, null, 2));
```

> **Note**: atomic write fixes the *crash window*. It does **not** fix
> concurrent last-writer-wins (multiple processes RMW the same file). External
> workspace recording additionally holds a project-wide OS lock across the
> complete operation; other writers need their own concurrency contract.

---

## 2. Path & name safety — validate at the chokepoint, before `path.join`

**Rule**: any user- or agent-supplied string that becomes a path segment must be
validated **before** it flows into `path.join` / `shutil.move` / `rmSync`. A
name like `../../x` resolves outside the intended tree and a later recursive
delete escapes the store.

| Concern | Guard | Location |
|---|---|---|
| channel / worker name | `assertSafeName(name, kind)` — `^[A-Za-z0-9._-]+$`, rejects `.`/`..` — called inside `channelDir` (the single chokepoint every path helper passes through) | `core` + `cli` `channel/store/paths.ts` |
| `task.py archive <name>` target | `is_within_tasks_dir(task_dir_abs, repo_root)` — dir must be a direct child of `.trellis/tasks/` | `scripts/common/task_utils.py` |
| rename-dir migration source | `dirHasManifestEntries(fromDir, hashes)` — only auto-move a dir Trellis provably created | `commands/update.ts` |

> **Why the chokepoint, not the entrypoint**: validating inside `channelDir`
> (not in each of create/rm/run) means one guard covers every current and future
> caller. `spawn.ts` had long *asserted* this — a "CLI layer already validates
> names" comment — while no such validation existed; adding the guard at the
> `channelDir` chokepoint is what finally made that comment true.

```ts
// Correct: guard lives in the shared path builder
export function channelDir(name: string, project = currentProjectKey()): string {
  assertSafeName(name);
  return path.join(projectDir(project), name);
}
```

---

## 3. Destructive-op ownership / backup gate

Before deleting, moving, or overwriting anything that **could be user data**,
one of these must hold. Pick by operation:

| Operation | Required guard |
|---|---|
| Delete a mixed-ownership file (e.g. `AGENTS.md`) | Strip only the managed block (`scrubManagedMarkdownBlock`); delete only if nothing user-authored remains. Never `unlinkSync` the whole file. |
| Move a dir that may be user-owned (rename-dir) | Ownership check (`dirHasManifestEntries`); unowned + target-absent → **skip** (safe even under `--force`, since skip never executes). |
| Overwrite a dir from a remote source | Download to a temp dir; `rm` + copy the old dir **only after** the download succeeds (`downloadWithStrategy` `overwrite`). Never delete-then-download. |
| Rename onto a possibly-existing target | `fs.existsSync(newPath)` first; skip/renumber instead of clobbering (`renameTracesToJournal`). Especially when the dir is excluded from backup. |
| `rm -rf` a tree with user data (`uninstall`) | `collectUncommittedTrellisData(cwd)` (git status over `spec/tasks/workspace`); scripted `--yes` fails closed unless `TRELLIS_ALLOW_DIRTY_UNINSTALL=1`. Disclosure must name what user data is deleted. |

**Env override precedent**: a fail-closed guard on a `--yes`/`--force` path gets
an explicit env bypass, mirroring `TRELLIS_ALLOW_HOMEDIR`
(`TRELLIS_ALLOW_DIRTY_UNINSTALL=1`). Warn-and-continue is not enough on
`--yes` — nobody reads scrollback in a script.

---

## 4. Dogfood twin sync

Shipped Python (`packages/cli/src/templates/trellis/scripts/**`) has a dogfood
twin at repo `.trellis/scripts/**`. **Every `.py` under the two trees must be
byte-identical, and the build fails if it is not** — there is no such thing as
acceptable local drift. Edit both copies, never one.

The full contract, including what the test does and does not cover, is in
`script-conventions.md` → "Two script trees, one content". `packages/cli/dist/**`
and `.trellis/.backup-*/**` are generated/history — never hand-edit.

---

## 5. Tests required

Every guard here leaves a runnable regression test whose assertion **fails
without the guard**:

- Atomic write: write-succeeds + no tmp leftover + original survives a failed write (`test/utils/atomic-write.test.ts`; Python covered via `task-archive` integration).
- Path traversal: `create '../../victim' --force` / `rm '../../victim'` throw and the external dir survives — reproduce in a sandbox (`test/channel/name-safety`, `test/commands/channel-name-safety`).
- Ownership/backup gates: unowned source skipped (`update-internals` rename-dir gate), `archive src` refused with `src/` intact (`task-archive` integration), overwrite-fails-preserves-spec (`template-fetcher-overwrite`), uninstall refuses dirty `--yes` (`uninstall-dirty-guard`, real git).
- Dogfood twin sync: identical `.py` path sets in both trees, plus one byte-compare case per file (`regression.test.ts` → "regression: .trellis/scripts stays byte-identical to templates/trellis/scripts"). The file list is derived from the filesystem, so a new script is covered the moment it is added.

---

## Related

- [`trellis update` Command](./commands-update.md) — migration classification/apply
- [`trellis uninstall` Command](./commands-uninstall.md) — plan/execute phases
- [`trellis channel` Command](./commands-channel.md) — store paths, project buckets
- [Script Conventions](./script-conventions.md) — Python `io.py` contract
- [Migrations](./migrations.md) — rename/rename-dir/delete semantics

## Channel Context Trust Set (`channel.trusted_context_dirs`, #414)

Worker context containment (context-loader `jailedRealpath`, agent-loader,
OMP extension `resolveProjectFile`) accepts realpaths inside worker cwd **or**
inside a trusted root. Trusted roots resolve once per spawn
(`channel/context-trust.ts` `resolveTrustedRoots(cwd)`):

1. `.trellis/config.yaml` → `channel.trusted_context_dirs` (list; relative
   entries resolve against cwd; missing dirs warn + skip; each entry is
   realpath-canonicalized).
2. Auto-trust (disable with `channel.auto_trust_trellis_symlinks: false`):
   ONLY the top-level `.trellis/tasks` and `.trellis/workspace` entries, when
   they are themselves symlinks, contribute their realpath targets. No
   recursion — a nested symlink planted inside a task dir stays refused.

Containment predicate (identical at all three sites, byte-comparable):
`real === root || real.startsWith(root + path.sep)` — the `path.sep` suffix is
load-bearing (blocks `/work/ws-evil` matching trusted `/work/ws`). The OMP
template carries a standalone verbatim copy of the parser/resolver; changes
must be mirrored there. Do not relax to lexical checks — realpath containment
is the defense from the 2026-07-10 audit (#409 family).


## External local storage bootstrap (phases 1–4)

### 1. Scope / Trigger

Applies when a checkout has .treills.conf.json, including when its .trellis
browse link is missing. The spelling of the locator is intentional. Fresh
init defaults to ~/.trellis-wiki; existing physical layouts remain unchanged
until explicit migration. External task commits, migration, and removal/restore
are subsequent implementation phases and must not be inferred from bootstrap support.

### 2. Signatures

- CLI: init --storage [dir] --project <name>; both flags are optional.
- Node: readExternalStore(codeRoot), workflowDirOf(codeRoot), runtimeDirOf(codeRoot).
- Python: load_store(code_root), workflow_dir(repo_root), runtime_dir(repo_root).
- Python context refs: resolve_project_path(path_ref, repo_root) returns Path or None.
- Installation tracking: loadHashes(cwd) and saveHashes(cwd, hashes) expose one
  logical map while persisting shared and checkout records separately.

### 3. Contracts

- Locator shape: {"storage": "~/.trellis-wiki", "project": "project-name"}.
  Resolve relative storage against codeRoot; expand only ~ and ~/directory.
- project.json contains name, absolute codeRoot, and gitCommonDir when available.
  A plain directory must match codeRoot; Git checkouts must match the canonical
  Git common directory. Linked worktrees may share data without replacing the
  default reverse binding. Missing/damaged bindings fail closed.
- Project names are single non-reserved directory names. Reject separators,
  controls, Windows reserved names, trailing dots/whitespace, and dot segments.
  The real project directory must remain a direct child of the real storage root.
- Trust only codeRoot and the validated project directory. Logical .trellis/...
  refs map to external data before realpath containment; code refs stay in codeRoot.
- checkoutKey = first 16 hex characters of SHA256 of the canonical checkout path
  (case-normalized on Windows), identical in Node and Python.
- Shared hashes: project/.template-hashes.json, with .trellis/... keys only.
  Checkout hashes/version: project/.runtime/checkouts/<checkoutKey>/.
  Session pointers and shell tickets use that same checkout runtime directory.
- Journal numbering, fingerprint classification, append, index update and optional
  commit are enclosed by project/.runtime/workspace.lock. OS locks release on exit.
  Atomic file replacement remains required inside the lock.
- External init creates the workspace directory but leaves journal/index creation
  to the first locked journal writer. Precreating untracked shared files makes
  required commits fail the clean-baseline ownership check. Never bypass that
  check to compensate for initialization. Re-init preserves existing journals.
- Record actual writes in logical manifest keys, including writes outside codeRoot.
  Re-init preserves shared template baselines for files it skipped. The root
  locator and browse link belong to the checkout installation manifest.
- Browse links are locally excluded via Git info/exclude. Runtime/cache files are
  ignored in the storage repository. Links do not grant host sandbox permissions.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| No locator | Legacy read compatibility; fresh init chooses external storage |
| Invalid explicit config or binding | Diagnose the configured path; never fall back |
| Different plain project / different Git repository | Refuse without replacing the binding |
| Same repository, another worktree | Allow; isolate session and installation records |
| Project path/link escapes storage | Refuse before project data writes |
| Browse link absent/wrong/broken | Config execution still works; init may repair the link |
| Browse entry is a real directory | Preserve it; report that browsing could not be installed |
| Two journal writers | Preserve both records, monotonic numbering and retry checkpoints |

### 5. Good / Base / Bad Cases

- Good: Pi and Codex in two worktrees share task/spec data, but load distinct
  platform manifests and session pointers, even with the same session ID.
- Base: remove the browse link, then run the external task/context/journal scripts.
- Bad: use link existence as an initialization guard, rehash skipped user edits,
  or treat atomic replace as a concurrent read/modify/write transaction.

### 6. Tests Required

- test/utils/external-store.test.ts: traversal, binding preservation, worktrees,
  invalid JSON, ownership and symlink escape guards.
- test/scripts/external-store-config.integration.test.ts: no-link phase/materials,
  record context, concurrent journals, checkout/session isolation and rendered hooks.
- test/commands/init-external-storage.integration.test.ts: default/custom init,
  first journal and retry, re-init, separate Pi/Codex records, shared edit evidence,
  shell quoting, update discovery and installed multi-platform hooks/JSON prompts.
- Preserve the byte-identical Python dogfood/template regression. Actual Windows
  junctions and host sandbox permissions require their corresponding environments.

### 7. Wrong vs Correct

Wrong: codeRoot / '.trellis' / 'workflow.md', assuming a browse link exists.
Correct: workflow_dir(codeRoot) / 'workflow.md', after validating the locator.

Wrong: save every checkout's platform hashes into the shared project manifest.
Correct: shared workflow hashes plus one checkout-scoped installation manifest.


## External transactions: commits, migration and removal (phases 5–7)

### 1. Scope / Trigger

Archive/journal commits, explicit storage migration, and checkout lifecycle
commands with a root locator extend the bootstrap contracts above.

### 2. Signatures

- Python: `data_git_context(code_root)`, `storage_commit_lock(ctx)`,
  `commit_task_archive(..., archive_ref=None)`.
- CLI: `add_session.py --require-commit [--include-path <file>]`,
  `task.py archive <task> [--no-commit]`.
- CLI: `trellis update --migrate-storage [--storage <dir>] [--project <name>]
  [--workspace <developer>] [--dry-run]`.
- Node: `readExternalStore(codeRoot, configPath?)`; restore validates its
  backed-up locator without publishing it first.

### 3. Contracts

**Commit ownership**

- Code evidence/branches stay in the code repository. Journal HEAD/refs,
  numbering and product commits use the storage repository.
- Lock order is project workspace, then storage commit. Migration holds the
  same OS locks through a Python child; stdin EOF releases the descriptors.
- Use literal explicit product paths. Preserve unrelated staged work. Never
  force-add ignored paths or commit the complete archive tree.
- Persist exact archive destination, changed children and checkout/session
  owner even for `--no-commit`. Retry only the caller's entries, or exact tasks
  explicitly selected with `--require-commit --recover-archive <task>`. Invalid
  recovery state fails closed; mutations of that state hold the storage lock.
- A failed attempt can already have staged source deletes: consult HEAD as
  well as the index before omitting source paths on retry.
- Refuse before archive mutation if related child metadata is already dirty;
  a JSON pathspec cannot distinguish another task's fields.
- Journal/index commits require a clean pre-write baseline and exact writer
  snapshots. Foreign markers, unmarked edits and later edits block commits,
  including `session_auto_commit: false` plus `--require-commit`.
- Required commits fail on ignored paths/Git failures. A committed idempotency
  key still processes includes and owned archives. Includes name individual
  product files or tracked deletions; directories/runtime/cache paths fail.

**Storage migration**

- The release gate runs before manifest/template mutation, independently of
  whether the release contains rename/delete operations.
- Dry-run never repairs links or creates storage/config/checkpoints.
- Reject source symlinks/unsupported objects before creating storage. Build
  and verify a separate import image; never overwrite destination edits.
- Preserve the root workspace directory index at `workspace/history/index.md`,
  flatten the selected author, and move other authors to history subdirectories.
  Existing history/name conflicts fail rather than overwrite.
- Checkout-scoped `storage-migration.json` records source/image digests,
  backup name, initialization files, refresh baseline and phases
  `prepared → committed → switched → refreshed → complete`.
- Commit before switching, using the user's Git identity/hooks. Retain source
  and checkpoint on failure. Only newly created root ignore/attribute files
  join the initialization commit.
- Rename source to the recorded backup, publish the locator, create the browse
  link, and refresh current-checkout integration in the same command. Default
  conflict handling preserves modified templates.
- Persist the refresh baseline before writing templates. Refresh commits use
  actual template/migration outputs; newer sibling task edits remain outside.

**Checkout removal/restore**

- Filter shared `.trellis/*` manifest keys before planning; handle locator
  config and browse link explicitly. Pruning is in memory.
- Missing browse links do not imply a missing install. Physical browse entries
  in external mode are conflicts, never recursive-delete/backup targets.
- Ablate snapshots local files/config/link only. Restore uses the runtime
  parser's path, containment and Git-identity checks on the saved locator
  before writing any checkout surface. Never roll back shared data.

### 4. Validation & Error Matrix

| Condition | Outcome |
| --- | --- |
| Other project's staged work | Excluded and left staged |
| Foreign/manual shared journal edits | Non-zero checkpoint; bytes retained |
| Hook fails after staging archive deletes | Retry includes source deletes and exact destination |
| Same task name in older archive months | Only recorded destination committed |
| Import into storage with existing HEAD | New untracked import is committed |
| Copy/switch/refresh interrupted | Resume checkpoint; preserve originals and sibling writes |
| Migration Git identity/hook failure | No identity override or false completion |
| Missing browse link | Local lifecycle operations still work |
| Physical browse entry | Refuse before mutation |
| Missing/rebound external target | Restore rejects with zero checkout writes |

### 5. Good / Base / Bad Cases

- Good: deferred archive followed by the same session's final journal command.
- Base: repeated migration repairs the link; its dry-run remains read-only.
- Bad: deciding import emptiness using `git diff HEAD` before staging new
  files; treating `project.json` existence as sufficient restore validation.

### 6. Tests Required

- `external-task-commit.integration.test.ts`: commit file lists, staged-work
  preservation, simultaneous projects, manual/mixed journals, file/deletion
  includes, pending ownership, staged-delete retry and exact archive month.
- `update-migrate-storage.integration.test.ts`: previews, full import, existing
  HEAD, workspace index, commit rejection, switch/refresh fault injection,
  sibling preservation and empty-operation migration gate.
- `external-lifecycle.integration.test.ts`: shared bytes unchanged, missing link,
  physical-entry refusal, sibling writes and missing/rebound binding refusal.
- CLI lint/typecheck/tests/build, Python checks and twin-tree comparison.
  Windows junction and host sandbox behavior require their own environments.

### 7. Wrong vs Correct

```python
# Wrong: a final commit skips ownership checks when auto-commit was disabled.
if auto_commit_enabled:
    check_foreign_records()

# Correct: committing always requires attribution.
if not verify_workspace_ownership() or foreign_pending_markers():
    return COMMIT_MIXED
```

```ts
// Wrong: existence can accept another project's rebound target.
if (existsSync(join(projectDir, "project.json"))) restoreLocalFiles();
// Correct: validate the saved locator against the current checkout.
readExternalStore(transaction.state.projectRoot, backupConf);
restoreAblationTransaction(transaction, options);
```
