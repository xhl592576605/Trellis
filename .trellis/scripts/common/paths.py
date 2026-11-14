#!/usr/bin/env python3
"""
Common path utilities for Trellis workflow.

Provides:
    get_repo_root          - Get repository root directory
    get_developer          - Get developer name
    get_workspace_dir      - Get developer workspace directory
    get_tasks_dir          - Get tasks directory
    get_active_journal_file - Get current journal file
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path

from .external_store import find_workflow_root
from .git import main_worktree_root


# =============================================================================
# Path Constants (change here to rename directories)
# =============================================================================

# Directory names
DIR_WORKFLOW = ".trellis"
DIR_WORKSPACE = "workspace"
DIR_TASKS = "tasks"
DIR_ARCHIVE = "archive"
DIR_SPEC = "spec"
DIR_SCRIPTS = "scripts"

# File names
FILE_DEVELOPER = ".developer"
FILE_CURRENT_TASK = ".current-task"
FILE_TASK_JSON = "task.json"
FILE_JOURNAL_PREFIX = "journal-"

# Environment override for the developer identity, ahead of the .developer file.
ENV_DEVELOPER = "TRELLIS_DEVELOPER"

# Appended to every "no developer set" error so the two non-obvious sources are
# discoverable from the failure itself.
DEVELOPER_HINT = (
    f"  Or set {ENV_DEVELOPER}=<your-name> in the environment.\n"
    f"  A linked git worktree inherits {DIR_WORKFLOW}/{FILE_DEVELOPER} from its "
    f"main checkout — run init_developer.py there to cover every worktree."
)


# =============================================================================
# Repository Root
# =============================================================================

def get_repo_root(start_path: Path | None = None) -> Path:
    """Find the code root directory for the current location.

    External mode: walk up for the root config (``.treills.conf.json`` (the
    user's spelling)); when found, the config is fully validated — an invalid
    config raises ExternalStoreError instead of silently falling back to the
    legacy layout, which would run against the wrong data location.

    Legacy mode: walk up for a ``.trellis`` directory.

    This handles nested git repos correctly (e.g., test project inside another repo).

    Args:
        start_path: Starting directory to search from. Defaults to current directory.

    Returns:
        Path to repository root, or current directory if nothing found.
    """
    found = find_workflow_root(start_path)
    if found is not None:
        return found

    # Fallback to current directory if nothing found
    return Path.cwd().resolve()


def workflow_dir(repo_root: Path | None = None) -> Path:
    """Workflow data directory: external project dir or legacy ``.trellis``.

    The returned path is the *real* data location; it is never resolved
    through the in-project browse link. See external_store.workflow_dir.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    from .external_store import workflow_dir as _workflow_dir

    return _workflow_dir(repo_root)


def resolve_project_path(path_ref: str, repo_root: Path) -> Path | None:
    """Map lexical workflow refs and contain realpaths within the two trusted roots."""
    normalized = path_ref.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    root = repo_root.resolve()
    wf = workflow_dir(root).resolve()
    if normalized == DIR_WORKFLOW or normalized.startswith(f"{DIR_WORKFLOW}/"):
        candidate = wf / normalized[len(DIR_WORKFLOW):].lstrip("/")
    else:
        candidate = root / normalized
    try:
        real = candidate.resolve()
        for allowed in (root, wf):
            if real == allowed or allowed in real.parents:
                return real
    except (OSError, RuntimeError):
        return None
    return None


# =============================================================================
# Developer
# =============================================================================

def _read_developer_file(dev_file: Path) -> str | None:
    """Read the `name=` field out of a .developer file, or None."""
    if not dev_file.is_file():
        return None

    try:
        content = dev_file.read_text(encoding="utf-8")
    except (OSError, IOError):
        return None

    for line in content.splitlines():
        if line.startswith("name="):
            return line.split("=", 1)[1].strip() or None

    return None


def _is_external_mode(repo_root: Path) -> bool:
    """True when this code root runs against an external store (root config)."""
    from .external_store import resolve_store_for_root

    return resolve_store_for_root(repo_root) is not None


def workspace_display_dir(repo_root: Path | None = None) -> str | None:
    """Lexical display path of the workspace dir (`.trellis/workspace/...`).

    External mode is flat (single user): `.trellis/workspace`. Legacy mode
    keeps the developer segment. Returns None in legacy mode without a
    developer, matching get_workspace_dir.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    if _is_external_mode(repo_root):
        return f"{DIR_WORKFLOW}/{DIR_WORKSPACE}"
    developer = get_developer(repo_root)
    if not developer:
        return None
    return f"{DIR_WORKFLOW}/{DIR_WORKSPACE}/{developer}"


def get_developer(repo_root: Path | None = None) -> str | None:
    """Get the developer name for this checkout.

    Resolution order, first hit wins (a CLI `--assignee` flag overrides all of
    it, before this function is ever called):

        1. The ``TRELLIS_DEVELOPER`` environment variable.
        2. ``.trellis/.developer`` in this checkout.
        3. ``.trellis/.developer`` in the main checkout, when this checkout is a
           linked git worktree.

    Step 3 exists because `.developer` is gitignored on purpose — it carries a
    personal identity and no tracked file should. A fresh `git worktree add`
    therefore starts with no identity file of its own, which used to make every
    task.py command fail until init_developer.py was re-run per worktree. The
    main checkout's file is read, never copied: a copy would go stale and shadow
    later changes made in the main checkout.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Developer name or None if not initialized.
    """
    env_name = os.environ.get(ENV_DEVELOPER, "").strip()
    if env_name:
        return env_name

    if repo_root is None:
        repo_root = get_repo_root()

    local = _read_developer_file(workflow_dir(repo_root) / FILE_DEVELOPER)
    if local:
        return local

    main_root = main_worktree_root(repo_root)
    if main_root is not None:
        inherited = _read_developer_file(workflow_dir(main_root) / FILE_DEVELOPER)
        if inherited:
            return inherited

    # Single-user external mode: no registration step exists. The display
    # identity falls back to the system user so task create, journaling, and
    # context never require init_developer (D6 / R4).
    if _is_external_mode(repo_root):
        import getpass

        try:
            return getpass.getuser() or None
        except (OSError, KeyError):
            return None

    return None


def check_developer(repo_root: Path | None = None) -> bool:
    """Check if developer is initialized.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        True if developer is initialized.
    """
    return get_developer(repo_root) is not None


# =============================================================================
# Tasks Directory
# =============================================================================

def get_tasks_dir(repo_root: Path | None = None) -> Path:
    """Get tasks directory path.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Path to tasks directory.
    """
    if repo_root is None:
        repo_root = get_repo_root()
    return workflow_dir(repo_root) / DIR_TASKS


# =============================================================================
# Workspace Directory
# =============================================================================

def get_workspace_dir(repo_root: Path | None = None) -> Path | None:
    """Get developer workspace directory.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Path to workspace directory or None if developer not set.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    wf = workflow_dir(repo_root)
    if _is_external_mode(repo_root):
        # Single-user flat workspace (D6): journal files live directly under
        # workspace/, with no developer subdirectory.
        return wf / DIR_WORKSPACE

    developer = get_developer(repo_root)
    if developer:
        return wf / DIR_WORKSPACE / developer
    return None


# =============================================================================
# Journal File
# =============================================================================

def get_active_journal_file(repo_root: Path | None = None) -> Path | None:
    """Get the current active journal file.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Path to active journal file or None if not found.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    workspace_dir = get_workspace_dir(repo_root)
    if workspace_dir is None or not workspace_dir.is_dir():
        return None

    latest: Path | None = None
    highest = 0

    for f in workspace_dir.glob(f"{FILE_JOURNAL_PREFIX}*.md"):
        if not f.is_file():
            continue

        # Extract number from filename
        name = f.stem  # e.g., "journal-1"
        match = re.search(r"(\d+)$", name)
        if match:
            num = int(match.group(1))
            if num > highest:
                highest = num
                latest = f

    return latest


def count_lines(file_path: Path) -> int:
    """Count lines in a file.

    Args:
        file_path: Path to file.

    Returns:
        Number of lines, or 0 if file doesn't exist.
    """
    if not file_path.is_file():
        return 0

    try:
        return len(file_path.read_text(encoding="utf-8").splitlines())
    except (OSError, IOError):
        return 0


# =============================================================================
# Current Task Management
# =============================================================================

def normalize_task_ref(task_ref: str) -> str:
    """Normalize a task ref for stable runtime storage.

    Stored refs should prefer repo-relative POSIX paths like
    `.trellis/tasks/03-27-my-task`, even on Windows. Absolute paths are preserved
    unless they can later be converted back to repo-relative form by callers.
    """
    normalized = task_ref.strip()
    if not normalized:
        return ""

    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return str(path_obj)

    normalized = normalized.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]

    if normalized.startswith(f"{DIR_TASKS}/"):
        return f"{DIR_WORKFLOW}/{normalized}"

    return normalized


def resolve_task_ref(task_ref: str, repo_root: Path | None = None) -> Path | None:
    """Resolve a task ref to an absolute task directory path inside the repo.

    Returns None when the ref resolves outside `repo_root`. Every reader of the
    active task — `task.py`, the shared hooks, the platform extensions — comes
    through here, so containment is enforced at this one point rather than at
    each call site.

    It matters because a ref is not always something the user typed. It round
    trips through the session pointer under `.trellis/.runtime/sessions/`, and
    `..` segments used to survive that trip intact: `_canonical_task_ref`
    compares lexically, and a lexical `relative_to` accepts
    `<root>/.trellis/tasks/../../../elsewhere` because the string does start
    with the root. The ref was then stored verbatim and replayed on every later
    turn, so `task.py start .trellis/tasks/../../../elsewhere` both rewrote that
    directory's `task.json` and fed its files to the model.

    Resolving here also normalises the path, so callers get a ref without `..`
    to store.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    normalized = normalize_task_ref(task_ref)
    if not normalized:
        return None

    try:
        root = repo_root.resolve()
    except OSError:
        return None

    # Candidates are built from the workflow dir's real location, not
    # repo_root/.trellis: in external mode the in-project lexical path may not
    # exist at all (no browse link), and a name-only ref must resolve into the
    # external tasks dir. Lexical `.trellis/...` refs map onto the workflow
    # dir for the same reason.
    wf_dir = workflow_dir(root)
    path_obj = Path(normalized)
    if path_obj.is_absolute():
        candidate = path_obj
    elif normalized.startswith(f"{DIR_WORKFLOW}/"):
        # lstrip: doubled separators (`.trellis\\tasks`) leave a leading
        # `/` after the strip; pathlib would treat the rest as absolute.
        candidate = wf_dir / path_obj.relative_to(DIR_WORKFLOW).as_posix().lstrip("/")
    else:
        candidate = wf_dir / DIR_TASKS / path_obj

    # resolve() collapses `..` and follows symlinks, so a task directory that
    # links outside the repo is refused too. Both sides are resolved because
    # repo_root itself may sit behind a symlink (/tmp on macOS does).
    #
    # The containment bases are the code root and the workflow dir's real
    # location: in external mode that is the external project dir; in legacy
    # symlink mode (#567) it is the linked store. A ref escaping BOTH bases
    # (traversal, absolute path elsewhere, a task dir symlinked out of the
    # tree) is refused.
    try:
        resolved = candidate.resolve()
        workflow_real = workflow_dir(root).resolve()
    except OSError:
        return None

    try:
        resolved.relative_to(root)
        return resolved
    except ValueError:
        pass

    try:
        resolved.relative_to(workflow_real)
    except ValueError:
        return None

    # In legacy layouts the workflow dir is (or links to) a path inside the
    # repo, so callers get an in-repo absolute path. In external mode with no
    # browse link, the repo-relative lexical path does not exist on disk; the
    # resolved real path under the external project dir is the only usable
    # one. Ref canonicalization back to the `.trellis/...` display form is
    # done by the callers that store refs (_canonical_task_ref).
    if workflow_real == (root / DIR_WORKFLOW).resolve():
        rel = resolved.relative_to(workflow_real)
        return root / DIR_WORKFLOW / rel
    return resolved


def get_current_task(
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> str | None:
    """Get current task directory path (relative to repo_root).

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Relative path to current task directory or None.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    from .active_task import resolve_active_task

    return resolve_active_task(repo_root, platform_input, platform).task_path


def get_current_task_abs(
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> Path | None:
    """Get current task directory absolute path.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        Absolute path to current task directory or None.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    relative = get_current_task(repo_root, platform_input, platform)
    if relative:
        return resolve_task_ref(relative, repo_root)
    return None


def get_current_task_source(
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> tuple[str, str | None, str | None]:
    """Get active task source as (`source`, `context_key`, `task_path`)."""
    if repo_root is None:
        repo_root = get_repo_root()

    from .active_task import get_current_task_source as _get_source

    return _get_source(repo_root, platform_input, platform)


def set_current_task(
    task_path: str,
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> bool:
    """Set current task in session scope.

    Args:
        task_path: Task directory path (relative to repo_root).
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        True on success, False on error.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    from .active_task import set_active_task

    return set_active_task(
        task_path,
        repo_root,
        platform_input=platform_input,
        platform=platform,
    ) is not None


def clear_current_task(
    repo_root: Path | None = None,
    platform_input: dict | None = None,
    platform: str | None = None,
) -> bool:
    """Clear current task in session scope.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        True on success.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    from .active_task import clear_active_task

    clear_active_task(
        repo_root,
        platform_input=platform_input,
        platform=platform,
    )
    return True


def has_current_task(repo_root: Path | None = None) -> bool:
    """Check if has current task.

    Args:
        repo_root: Repository root path. Defaults to auto-detected.

    Returns:
        True if current task is set.
    """
    return get_current_task(repo_root) is not None


# =============================================================================
# Task ID Generation
# =============================================================================

def generate_task_date_prefix() -> str:
    """Generate task ID based on date (MM-DD format).

    Returns:
        Date prefix string (e.g., "01-21").
    """
    return datetime.now().strftime("%m-%d")


# =============================================================================
# Monorepo / Package Paths
# =============================================================================


def get_spec_dir(package: str | None = None, repo_root: Path | None = None) -> Path:
    """Get the spec directory path.

    Single-repo: .trellis/spec
    Monorepo with package: .trellis/spec/<package>

    Uses lazy import to avoid circular dependency with config.py.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    from .config import get_spec_base

    base = get_spec_base(package, repo_root)
    return workflow_dir(repo_root) / base


def get_package_path(package: str, repo_root: Path | None = None) -> Path | None:
    """Get a package's source directory absolute path from config.

    Returns:
        Absolute path to the package directory, or None if not found.
    """
    if repo_root is None:
        repo_root = get_repo_root()

    from .config import get_packages

    packages = get_packages(repo_root)
    if not packages or package not in packages:
        return None

    info = packages[package]
    if isinstance(info, dict):
        rel_path = info.get("path", package)
    else:
        rel_path = str(info)

    return repo_root / rel_path


# =============================================================================
# Main Entry (for testing)
# =============================================================================

if __name__ == "__main__":
    repo = get_repo_root()
    print(f"Repository root: {repo}")
    print(f"Developer: {get_developer(repo)}")
    print(f"Tasks dir: {get_tasks_dir(repo)}")
    print(f"Workspace dir: {get_workspace_dir(repo)}")
    print(f"Journal file: {get_active_journal_file(repo)}")
    print(f"Current task: {get_current_task(repo)}")
