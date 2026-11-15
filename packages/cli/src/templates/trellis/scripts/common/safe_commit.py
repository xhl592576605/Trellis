"""
Safe git-add helpers for Trellis-owned paths.

Why this module exists
----------------------
A real user incident: a project's `.gitignore` listed `.trellis/` (company-wide
template / personal habit). When `add_session.py` and `task.py archive` ran
their auto-commit and `git add` failed with `ignored by .gitignore`, the AI
agent driving the workflow "fixed" it by retrying with
`git add -f .trellis/` — which fan-out-included every ignored subtree
(`.trellis/.backup-*/`, `.trellis/worktrees/`, `.trellis/.template-hashes.json`,
`.trellis/.runtime/`), committing 548 files / 83474 lines of caches/backups.

Design
------
- Scripts only stage SPECIFIC product paths (journal files, index.md, the
  current task dir, the archive dir). Never the whole `.trellis/` tree.
- If plain `git add <specific>` fails with "ignored by", DO NOT retry with
  ``-f``. The presence of `.trellis/` in `.gitignore` is treated as user
  intent ("keep .trellis/ local-only"). The script warns and skips the
  auto-commit; users who want auto-staging can either fix their `.gitignore`
  or set ``session_auto_commit: false`` and manage git themselves.
- The warning includes a negative example: ``Do NOT use `git add -f .trellis/` ...``
  so any AI rereading the log doesn't reinvent the bug.

History note: 0.5.10 introduced an automatic ``git add -f`` retry on the
specific paths. That was reverted in 0.5.11 — auto-forcing into a tree the
user had gitignored violates user intent even when the path list is narrow.
The wider-grain forbidden command stays forbidden, and the narrow-grain auto
``-f`` is gone too.
"""

from __future__ import annotations

import sys
from pathlib import Path

from .git import (
    INDEX_LOCK_RETRY_ATTEMPTS,
    index_lock_path,
    run_git,
    run_git_retry_index_lock,
    stderr_indicates_index_lock,
)
from .data_git import DataGitContext, data_git_context, storage_commit_lock
from .paths import (
    DIR_ARCHIVE,
    DIR_TASKS,
    DIR_WORKFLOW,
    DIR_WORKSPACE,
    FILE_JOURNAL_PREFIX,
    get_workspace_dir,
    workflow_dir,
    workspace_display_dir,
)


# Paths under .trellis/ that must NEVER be auto-staged. Listed here so the
# warning to the user can show concrete subpaths to ignore individually
# instead of ignoring the whole `.trellis/` tree.
TRELLIS_IGNORED_SUBPATHS = (
    ".trellis/.backup-*",
    ".trellis/worktrees/",
    ".trellis/.template-hashes.json",
    ".trellis/.runtime/",
    ".trellis/.cache/",
)


def safe_trellis_paths_to_add(
    repo_root: Path,
    task_name: str | None = None,
) -> list[str]:
    """Return the list of repo-relative paths the auto-commit should stage.

    Only includes paths that exist on disk so callers don't pass non-existent
    arguments to git. The caller is responsible for `git diff --cached`
    checking afterwards.

    Included:
      - .trellis/workspace/<developer>/journal-*.md
      - .trellis/workspace/<developer>/index.md
      - .trellis/tasks/<task_name>/   (ONLY the current task dir when
        ``task_name`` is passed; plus its archive location if the task
        already lives under archive/)

    Excluded (intentionally — these must not be staged):
      - .trellis/.backup-*, .trellis/worktrees/,
        .trellis/.template-hashes.json, .trellis/.runtime/, .trellis/.cache/

    Scope contract (see #303 / break-loop analysis): when ``task_name`` is
    passed, the task segment stages ONLY that task directory — it never walks
    ``tasks_dir.iterdir()`` over all active tasks. This mirrors
    :func:`safe_archive_paths_to_add` and prevents dirty changes in OTHER
    parallel-window task dirs from being bundled into the session auto-commit.

    Backwards-compat: with no ``task_name``, the function walks every active
    task directory (+ the archive subtree) the old wide way. New callers
    should always pass ``task_name``.
    """
    paths: list[str] = []

    # Workspace journal files + index.md. Flat in external single-user mode,
    # developer-scoped in the legacy layout.
    ws = get_workspace_dir(repo_root)
    display = workspace_display_dir(repo_root)
    if ws is not None and display and ws.is_dir():
        for f in sorted(ws.glob(f"{FILE_JOURNAL_PREFIX}*.md")):
            if f.is_file():
                paths.append(f"{display}/{f.name}")
        index_md = ws / "index.md"
        if index_md.is_file():
            paths.append(f"{display}/index.md")

    tasks_dir = workflow_dir(repo_root) / DIR_TASKS
    if not tasks_dir.is_dir():
        return paths

    if task_name is not None:
        # Narrow scope — ONLY the current task directory (active or archived).
        # Never iterdir() all tasks: parallel-window dirty task dirs must not
        # leak into the session auto-commit.
        active_task = tasks_dir / task_name
        if active_task.is_dir():
            paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{task_name}")
        archived_task = tasks_dir / DIR_ARCHIVE / task_name
        if archived_task.is_dir():
            paths.append(
                f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}/{task_name}"
            )
        return paths

    # Legacy wide scope (no task_name): each direct child of tasks/ that is a
    # directory and not the archive root, plus the whole archive subtree.
    for child in sorted(tasks_dir.iterdir()):
        if not child.is_dir():
            continue
        if child.name == DIR_ARCHIVE:
            continue
        paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{child.name}")

    archive_dir = tasks_dir / DIR_ARCHIVE
    if archive_dir.is_dir():
        paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}")

    return paths


def safe_archive_paths_to_add(
    repo_root: Path,
    task_name: str | None = None,
    modified_children: list[str] | None = None,
) -> list[str]:
    """Return paths to stage after `task.py archive`.

    Scoped to ONLY the paths the archive operation actually touched:

      - ONLY the archived task's own destination directory
        (.trellis/tasks/archive/<YYYY-MM>/<task>)
      - the source task directory (for source-side deletes; caller pairs
        this with `git rm --cached` since `git add` won't stage deletes
        for a path that no longer exists in the working tree)
      - the task.json of child task directories edited to drop the
        archived parent (parent-children relationship update)

    This narrow scope avoids "scope creep" — dirty changes in OTHER
    active task dirs (parallel-window edits) are NOT bundled into the
    archive commit. Callers handle each kind of change in its own
    commit boundary.

    Backwards-compat: with no arguments, the function walks the whole
    `.trellis/tasks/` subtree the old way (active tasks + archive). New
    callers should always pass `task_name`.
    """
    paths: list[str] = []
    tasks_dir = workflow_dir(repo_root) / DIR_TASKS
    if not tasks_dir.is_dir():
        return paths

    archive_dir = tasks_dir / DIR_ARCHIVE

    if task_name is not None:
        # Narrow scope — only the archived task's own destination
        # directory, never the whole archive subtree: other months hold
        # other tasks' uncommitted changes that must not ride along in
        # this commit (stage-5 / AC6). Source-side deletes are staged by
        # the caller via `git rm --cached`; modified children contribute
        # their task.json only — staging a whole child dir would bundle
        # whatever else is dirty inside that sibling task's directory.
        # Exact-name lookup per month dir, so a task name is never
        # reinterpreted as a glob pattern.
        if archive_dir.is_dir():
            for month in sorted(archive_dir.iterdir()):
                if not month.is_dir():
                    continue
                dest = month / task_name
                if dest.is_dir():
                    paths.append(
                        f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}/{month.name}/{task_name}"
                    )
        for child_name in modified_children or []:
            child_json = tasks_dir / child_name / "task.json"
            if child_json.is_file():
                paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{child_name}/task.json")
        return paths

    # Legacy wide scope (no task_name): preserve old behavior so callers
    # that have not been updated keep working.
    if archive_dir.is_dir():
        paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}")
    for child in sorted(tasks_dir.iterdir()):
        if not child.is_dir():
            continue
        if child.name == DIR_ARCHIVE:
            continue
        paths.append(f"{DIR_WORKFLOW}/{DIR_TASKS}/{child.name}")
    return paths


def _stderr_indicates_ignored(stderr: str) -> bool:
    """git add error indicates the path is excluded by .gitignore."""
    if not stderr:
        return False
    lowered = stderr.lower()
    return "ignored by" in lowered


def safe_git_add(
    paths: list[str], repo_root: Path, retry_on_index_lock: bool = False
) -> tuple[bool, bool, str]:
    """Run `git add` on specific paths; never retry with -f.

    ``paths`` are logical ``.trellis/...`` paths; they are mapped through
    the data-git context and staged in the repository that actually owns
    Trellis product data — the storage root in external mode, the code
    root in the legacy layout (design §7 two-repository split).

    Returns ``(success, used_force, stderr)``. The ``used_force`` field is
    kept for signature compatibility with the 0.5.10 implementation but is
    always ``False`` — we never auto-force.

    Behavior:
      - No paths passed → success, no force, empty stderr.
      - Plain ``git add -- <paths>`` succeeds → return success.
      - Plain fails (any reason — ignored or otherwise) → return failure with
        the stderr. Callers should inspect the stderr (see
        :func:`print_gitignore_warning`) and skip the auto-commit.

    ``retry_on_index_lock`` opts into the bounded backoff-retry for a held
    ``.git/index.lock`` (see :func:`~.git.run_git_retry_index_lock`). It is
    off by default: only the archive path, which has already moved the task
    directory on disk by the time it stages, needs to wait out a transient
    lock rather than fail.
    """
    if not paths:
        return True, False, ""

    ctx = data_git_context(repo_root)
    specs = [f":(literal){ctx.to_pathspec(p)}" for p in paths]
    runner = run_git_retry_index_lock if retry_on_index_lock else run_git
    rc, _, err = runner(["add", "--", *specs], cwd=ctx.git_root)
    if rc == 0:
        return True, False, ""
    return False, False, err


# Outcome constants for :func:`commit_task_archive` — one vocabulary shared
# by `task.py archive` and the add_session recovery flush so their retry and
# reporting semantics stay aligned.
ARCHIVE_COMMIT_DONE = "done"
ARCHIVE_COMMIT_SKIPPED = "skipped"  # nothing to commit for this task
ARCHIVE_COMMIT_FAILED = "failed"  # git error; state must stay recoverable


def _print_index_lock_hint(ctx: DataGitContext, task_name: str) -> None:
    """Report an archive commit that gave up on a held index.lock.

    The move itself already succeeded, so the state is consistent — the
    task lives in archive/ and only its commit is outstanding. The caller
    persists recovery state; this hint names the lock and the recovery
    path so neither a user nor an agent reading the log re-archives the
    task or invents a blanket `git add -f`.
    """
    lock = index_lock_path(ctx.git_root)
    print(
        f"[WARN] git gave up after {INDEX_LOCK_RETRY_ATTEMPTS} attempts: "
        f"another process is holding {lock}",
        file=sys.stderr,
    )
    print(
        "[WARN] The task was moved into archive/ on disk; only the commit is pending.",
        file=sys.stderr,
    )
    print(
        "[WARN] Close whatever holds the lock (an IDE git integration, a status",
        file=sys.stderr,
    )
    print(
        f"[WARN] daemon, another session), or delete {lock} if it is stale. The",
        file=sys.stderr,
    )
    print(
        f"[WARN] next add_session.py run (finish-work: --require-commit) retries "
        f"the project-scoped 'archive task {task_name}' commit; do NOT re-archive the task.",
        file=sys.stderr,
    )


def commit_task_archive(
    repo_root: Path,
    task_name: str,
    modified_children: list[str] | None = None,
    archive_ref: str | None = None,
) -> tuple[str, str]:
    """Stage + commit ONE task's archive move in the data repository.

    Enclosed by the storage commit lock (external mode shares one index and
    HEAD across projects; the stage→commit window must not interleave).
    The commit uses an explicit pathspec so unrelated staged work — another
    project's, or this project's — is never swept in (#579) and stays
    staged afterwards.

    Returns ``(outcome, stderr)`` with outcome one of
    ``ARCHIVE_COMMIT_DONE`` / ``ARCHIVE_COMMIT_SKIPPED`` /
    ``ARCHIVE_COMMIT_FAILED``. Callers persist recovery state on anything
    that is not DONE/SKIPPED (see :mod:`common.data_git`).
    """
    ctx = data_git_context(repo_root)
    source_rel = f"{DIR_WORKFLOW}/{DIR_TASKS}/{task_name}"
    source_spec = f":(literal){ctx.to_pathspec(source_rel)}"

    rc, tracked_out, _ = run_git(
        ["ls-files", "--", source_spec],
        cwd=ctx.git_root,
    )
    source_was_tracked = rc == 0 and bool(tracked_out.strip())
    if not source_was_tracked:
        # A failed previous attempt may already have staged source deletes.
        # ls-files sees only the index; HEAD still owns those deletions and
        # they must remain in the retry's explicit commit pathspec.
        rc, head_source, _ = run_git(
            ["ls-tree", "-r", "--name-only", "HEAD", "--", source_spec],
            cwd=ctx.git_root,
        )
        source_was_tracked = rc == 0 and bool(head_source.strip())

    paths = safe_archive_paths_to_add(
        repo_root, task_name=task_name, modified_children=modified_children
    )
    archive_prefix = f"{DIR_WORKFLOW}/{DIR_TASKS}/{DIR_ARCHIVE}/"
    if archive_ref is not None:
        parts = archive_ref.split("/")
        if (len(parts) != 5 or not archive_ref.startswith(archive_prefix)
                or parts[-1] != task_name or any(p in ("", ".", "..") for p in parts)):
            return ARCHIVE_COMMIT_FAILED, "invalid exact archive destination"
        dest = workflow_dir(repo_root).joinpath(*parts[1:])
        try:
            dest.resolve().relative_to((workflow_dir(repo_root) / DIR_TASKS).resolve())
        except (OSError, ValueError):
            return ARCHIVE_COMMIT_FAILED, "archive destination escapes this project"
        if not dest.is_dir():
            return ARCHIVE_COMMIT_FAILED, "archive destination is missing"
        paths = [p for p in paths if not p.startswith(archive_prefix) or p == archive_ref]
    else:
        destinations = [p for p in paths if p.startswith(archive_prefix)]
        if len(destinations) > 1:
            return ARCHIVE_COMMIT_FAILED, "multiple archive destinations require an exact recovery reference"
    specs = [f":(literal){ctx.to_pathspec(p)}" for p in paths]

    with storage_commit_lock(ctx):
        if specs:
            success, _, err = safe_git_add(paths, repo_root, retry_on_index_lock=True)
            if not success:
                if err and "ignored by" in err.lower():
                    print_gitignore_warning(paths)
                elif stderr_indicates_index_lock(err):
                    _print_index_lock_hint(ctx, task_name)
                else:
                    print(
                        f"[WARN] git add failed: {err.strip() if err else 'unknown error'}",
                        file=sys.stderr,
                    )
                return ARCHIVE_COMMIT_FAILED, err

        # Belt-and-suspenders for the phantom-delete bug: `git add` stages
        # additions/modifications only, so the moved-away source tree needs
        # an explicit `git rm --cached` for its deletions to land in this
        # commit. `--ignore-unmatch` keeps it a no-op for never-tracked
        # tasks.
        rc, _, err = run_git_retry_index_lock(
            ["rm", "-r", "--cached", "--ignore-unmatch", "--", source_spec],
            cwd=ctx.git_root,
        )
        if rc != 0:
            if stderr_indicates_index_lock(err):
                _print_index_lock_hint(ctx, task_name)
            return ARCHIVE_COMMIT_FAILED, err

        # A pathspec may only appear in `git commit -- <pathspec>` while git
        # still knows that path; a never-tracked task has no source-side
        # deletions staged either.
        commit_specs = [*specs, source_spec] if source_was_tracked else list(specs)
        if not commit_specs:
            return ARCHIVE_COMMIT_SKIPPED, ""
        rc, _, _ = run_git(
            ["diff", "--cached", "--quiet", "--", *commit_specs],
            cwd=ctx.git_root,
        )
        if rc == 0:
            return ARCHIVE_COMMIT_SKIPPED, ""

        commit_msg = (
            f"chore({ctx.project_name}): archive task {task_name}"
        )
        rc, _, err = run_git_retry_index_lock(
            ["commit", "-m", commit_msg, "--", *commit_specs], cwd=ctx.git_root
        )
        if rc == 0:
            print(f"[OK] Auto-committed: {commit_msg}", file=sys.stderr)
            return ARCHIVE_COMMIT_DONE, ""
        if stderr_indicates_index_lock(err):
            _print_index_lock_hint(ctx, task_name)
        return ARCHIVE_COMMIT_FAILED, err


def print_gitignore_warning(paths: list[str]) -> None:
    """Explain to the user (and any AI reading the log) what to do.

    CRITICAL: includes the negative example
    ``Do NOT use `git add -f .trellis/``` — agents reading the warning are
    known to invent that command, which fans out to ignored caches/backups.
    """
    print(
        "[WARN] git add failed because .trellis/ paths are ignored by your .gitignore.",
        file=sys.stderr,
    )
    print(
        "[WARN] Skipping auto-commit. The journal/task files were still written to disk;",
        file=sys.stderr,
    )
    print(
        "[WARN] git was not touched.",
        file=sys.stderr,
    )
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Trellis manages these specific paths and they should be tracked:",
        file=sys.stderr,
    )
    if paths:
        for p in paths:
            print(f"[WARN]   {p}", file=sys.stderr)
    else:
        print(
            "[WARN]   .trellis/workspace/<developer>/{journal-*.md,index.md}",
            file=sys.stderr,
        )
        print(
            "[WARN]   .trellis/tasks/<task-dir>/",
            file=sys.stderr,
        )
        print(
            "[WARN]   .trellis/tasks/archive/",
            file=sys.stderr,
        )
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Recommended: change your .gitignore from `.trellis/` to specific",
        file=sys.stderr,
    )
    print(
        "[WARN] subpaths that should remain ignored, e.g.:",
        file=sys.stderr,
    )
    for sub in TRELLIS_IGNORED_SUBPATHS:
        print(f"[WARN]   {sub}", file=sys.stderr)
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Or, if you intentionally keep .trellis/ local-only, set in",
        file=sys.stderr,
    )
    print(
        "[WARN] .trellis/config.yaml:",
        file=sys.stderr,
    )
    print(
        "[WARN]   session_auto_commit: false",
        file=sys.stderr,
    )
    print(
        "[WARN] so the scripts skip git entirely and you can review / commit",
        file=sys.stderr,
    )
    print(
        "[WARN] manually with `git status` / `git add` / `git commit`.",
        file=sys.stderr,
    )
    print("[WARN]", file=sys.stderr)
    print(
        "[WARN] Do NOT use `git add -f .trellis/` — it pulls in backups, worktrees,",
        file=sys.stderr,
    )
    print(
        "[WARN] and runtime caches that should never be committed.",
        file=sys.stderr,
    )
