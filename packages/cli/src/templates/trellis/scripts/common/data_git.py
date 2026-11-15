"""
Product-data git repository context, commit serialization and recovery state.

Two git repositories are involved once Trellis data lives in an external
store (design §7 of the external local storage task):

- the CODE repository at the checkout root — current branch, code diff,
  commit evidence, PR/base branch;
- the STORAGE repository at the storage root — tasks, workspace journals,
  spec and research data.

Legacy layouts have exactly one repository; every helper here degrades to
it so callers need no mode branches of their own.
"""

from __future__ import annotations

import sys
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterator

from .active_task import resolve_context_key
from .external_store import resolve_store_for_root
from .io import read_json_checked, write_json
from .paths import DIR_WORKFLOW, get_repo_root, workflow_dir

# Recovery state for an archive whose directory move succeeded but whose
# data commit did not. Lives in the project runtime dir (gitignored in both
# layouts), one list so several archives failing in one finish-work round
# are all recoverable.
PENDING_COMMIT_FILENAME = "pending-task-commit.json"


@dataclass(frozen=True)
class DataGitContext:
    """The git repository that owns Trellis product data for a code root."""

    code_root: Path
    git_root: Path
    # Pathspec prefix prepended to data-relative paths so they resolve
    # against git_root: ``.trellis/`` in the legacy layout, ``<project>/``
    # in external mode.
    prefix: str

    @property
    def is_external(self) -> bool:
        """True when product data lives in the separate storage repository."""
        return self.git_root != self.code_root

    @property
    def project_name(self) -> str:
        """Project identifier for storage-commit scopes.

        External mode names the project directory inside the shared
        storage repository; legacy mode falls back to the code repo's
        directory name.
        """
        if self.is_external:
            return self.prefix.rstrip("/") or self.code_root.name
        return self.code_root.name

    def to_pathspec(self, logical: str) -> str:
        """Map a logical ``.trellis/...`` path to a git_root-relative pathspec.

        Bare data-relative paths (``tasks/<task>``, ``spec/...``) pass
        through unchanged, so callers may hand either form to this one
        chokepoint.
        """
        rel = logical
        if rel == DIR_WORKFLOW:
            rel = ""
        elif rel.startswith(f"{DIR_WORKFLOW}/"):
            rel = rel[len(DIR_WORKFLOW) + 1 :]
        return f"{self.prefix}{rel}"


def data_git_context(repo_root: Path | None = None) -> DataGitContext:
    """Resolve the data repository for ``repo_root`` (code root)."""
    if repo_root is None:
        repo_root = get_repo_root()
    store = resolve_store_for_root(repo_root)
    if store is None:
        # Legacy layout: the data repo IS the code repo and product data
        # lives under ``.trellis/`` — pathspecs keep that prefix.
        return DataGitContext(
            code_root=repo_root, git_root=repo_root, prefix=f"{DIR_WORKFLOW}/"
        )
    return DataGitContext(
        code_root=repo_root,
        git_root=store.storage_root,
        prefix=f"{store.project}/",
    )


# In-process reentrancy for the storage commit lock. ``flock`` is held
# per file descriptor, so a second ``LOCK_EX`` on a *new* descriptor for
# the same file from the same process blocks against itself — e.g.
# ``add_session``'s recovery flush calling ``commit_task_archive`` while
# already inside its own commit critical section. A refcount makes nested
# acquisitions from one process free; cross-process exclusion is still
# entirely the OS lock's job.
_LOCK_REFCOUNTS: dict[Path, int] = {}


@contextmanager
def storage_commit_lock(ctx: DataGitContext) -> Iterator[None]:
    """Serialize the stage→commit interval on the shared storage repository.

    External mode: every project under the storage root shares one index and
    HEAD, so the short window between ``git add`` and ``git commit`` must not
    interleave across processes. The lock sits under
    ``<storage>/.runtime/``, which the storage .gitignore excludes, and OS
    file locks release on process exit — a crash leaves no stale owner.

    Legacy mode: no shared index exists, so this is a no-op; same-repo
    contention is already covered by the bounded index.lock retry.

    Lock ordering (design §7, deadlock rule): the project workspace lock is
    acquired FIRST (``add_session``'s serializer), this repository commit
    lock SECOND. No code path acquires them in the reverse order.
    """
    if not ctx.is_external:
        yield
        return

    lock_path = ctx.git_root / ".runtime" / "commit.lock"
    if _LOCK_REFCOUNTS.get(lock_path, 0) > 0:
        _LOCK_REFCOUNTS[lock_path] = _LOCK_REFCOUNTS.get(lock_path, 0) + 1
        try:
            yield
        finally:
            _LOCK_REFCOUNTS[lock_path] -= 1
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        if sys.platform == "win32":
            import msvcrt

            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        _LOCK_REFCOUNTS[lock_path] = 1
        try:
            yield
        finally:
            _LOCK_REFCOUNTS[lock_path] = 0
            if sys.platform == "win32":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def pending_commit_path(repo_root: Path) -> Path:
    """Path of the pending archive-commit recovery state for this project."""
    return workflow_dir(repo_root) / ".runtime" / PENDING_COMMIT_FILENAME


def read_pending_commits(repo_root: Path) -> list[dict]:
    """All pending archive-commit entries (possibly empty)."""
    path = pending_commit_path(repo_root)
    if not path.exists():
        return []
    data, reason = read_json_checked(path)
    if data is None or not isinstance(data.get("pending"), list):
        raise ValueError(f"Invalid pending archive recovery state: {path} ({reason})")
    entries = data["pending"]
    if any(not isinstance(e, dict) or not isinstance(e.get("task"), str)
           or not e.get("task") for e in entries):
        raise ValueError(f"Invalid pending archive entry: {path}")
    return entries


def pending_commit_owner(repo_root: Path) -> str:
    """Checkout plus stable session identity; never recover a foreign session."""
    return f"{repo_root.resolve()}:{resolve_context_key() or 'unidentified'}"


def upsert_pending_commit(
    repo_root: Path,
    entry: dict,
) -> bool:
    """Record (or refresh) one task's pending archive commit.

    Keyed by task name so a retry of the same archive replaces its own entry
    instead of piling up duplicates; other tasks' entries are preserved.
    """
    with storage_commit_lock(data_git_context(repo_root)):
        path = pending_commit_path(repo_root)
        entries = [
            e for e in read_pending_commits(repo_root)
            if e.get("task") != entry.get("task")
        ]
        stamped = {**entry, "owner": pending_commit_owner(repo_root),
                   "attempted_at": datetime.now().isoformat(timespec="seconds")}
        entries.append(stamped)
        path.parent.mkdir(parents=True, exist_ok=True)
        return write_json(path, {"pending": entries})


def remove_pending_commit(repo_root: Path, task: str) -> None:
    """Drop one task's entry after its data commit finally landed."""
    with storage_commit_lock(data_git_context(repo_root)):
        path = pending_commit_path(repo_root)
        entries = [
            e for e in read_pending_commits(repo_root) if e.get("task") != task
        ]
        if entries:
            if not write_json(path, {"pending": entries}):
                raise OSError(f"Cannot update pending archive state: {path}")
        elif path.exists():
            path.unlink()


def print_pending_notice(repo_root: Path) -> None:
    """Tell the user (and any AI reading the log) where recovery state lives."""
    print(
        "[BLOCKED] The archive move is on disk but its data commit did not "
        "complete. Recovery state saved to:",
        file=sys.stderr,
    )
    print(f"[BLOCKED]   {pending_commit_path(repo_root)}", file=sys.stderr)
    print(
        "[BLOCKED] The next add_session.py run retries it; finish-work's "
        "final step (add_session.py --require-commit) must report success "
        "before the task counts as finished. Do NOT re-archive the task.",
        file=sys.stderr,
    )
