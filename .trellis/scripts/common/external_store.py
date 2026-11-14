#!/usr/bin/env python3
"""External store resolution from the project-root config file.

The root config (``.treills.conf.json`` — the filename is the user's explicit
spelling, kept verbatim) is the single runtime source of truth for where a
project's Trellis data lives:

    {"storage": "~/.trellis-wiki", "project": "Trellis"}

The in-project ``.trellis`` entry is a browse-only link. It may be missing,
broken, or pointed elsewhere; nothing in this module reads it, and no caller
may treat its existence as a precondition for running.

Legacy projects without a root config keep working unchanged: every resolver
here returns ``None``/falls back to the in-repo ``.trellis`` layout.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import subprocess
from dataclasses import dataclass
from pathlib import Path

# Root config filename. The double-l in "treills" is intentional: the user
# specified this exact spelling when designing the external storage feature.
CONFIG_FILENAME = ".treills.conf.json"

# Reverse-binding file inside an external project dir. Written by init /
# migration; read here to refuse "same project name, different project"
# accidental sharing.
BINDING_FILENAME = "project.json"

DIR_RUNTIME = ".runtime"


class ExternalStoreError(Exception):
    """A root config exists but cannot be used as-is.

    The message is user-facing: it names the config file and the exact reason,
    because a silent fallback to the legacy layout here would hide a broken
    binding behind "works for a different reason than configured".
    """


@dataclass(frozen=True)
class ExternalStore:
    """Resolved external storage locations for one code checkout."""

    code_root: Path
    storage_root: Path
    project: str

    @property
    def project_dir(self) -> Path:
        return self.storage_root / self.project

    @property
    def scripts_dir(self) -> Path:
        return self.project_dir / "scripts"

    @property
    def checkout_key(self) -> str:
        """Stable local key shared with the Node bootstrap resolver."""
        root = os.path.normcase(str(self.code_root.resolve()))
        return hashlib.sha256(root.encode("utf-8")).hexdigest()[:16]

    @property
    def runtime_dir(self) -> Path:
        return self.project_dir / DIR_RUNTIME / "checkouts" / self.checkout_key


def validate_project_name(name: str) -> str:
    """Validate a project directory name (single path segment)."""
    if (
        not name or name != name.strip() or name.endswith(".")
        or name.lower() in (".", "..", ".git", ".runtime", ".trellis")
        or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", name, re.I)
    ):
        raise ExternalStoreError(
            f"invalid 'project' value {name!r} in root config: "
            "expected a single directory name"
        )
    if re.search(r'[\/\\:*?"<>|\x00-\x1f]', name):
        raise ExternalStoreError(
            f"invalid 'project' value {name!r} in root config: "
            "path separators are not allowed"
        )
    return name


def find_code_root(start_path: Path | None = None) -> Path | None:
    """Walk up from ``start_path`` looking for the root config file."""
    current = (start_path or Path.cwd()).resolve()
    while True:
        if (current / CONFIG_FILENAME).is_file():
            return current
        if current == current.parent:
            return None
        current = current.parent


def _git_common_dir(code_root: Path) -> str | None:
    """Git common dir of the code checkout, for same-repo binding checks.

    Returns None when git is unavailable or the checkout is not a repo —
    absence of git must not block config resolution (a plain directory with
    a config still has a valid external store).
    """
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=str(code_root),
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    value = result.stdout.strip()
    if not value:
        return None
    try:
        return str((code_root / value).resolve())
    except OSError:
        return None


def _check_binding(store: ExternalStore, binding: dict) -> None:
    """Refuse same-name-different-project accidental sharing (AC2).

    A binding records the code root and git common dir this external project
    dir was created for. A different checkout may still bind when it belongs
    to the same git repository (linked worktrees share the common dir); a
    checkout from a *different* repository with the same project name is
    refused rather than silently reusing another project's data.
    """
    recorded_root = binding.get("codeRoot")
    recorded_common = binding.get("gitCommonDir")
    if (binding.get("name") != store.project or not isinstance(recorded_root, str)
            or not Path(recorded_root).is_absolute()):
        raise ExternalStoreError(f"invalid project binding: {store.project_dir / BINDING_FILENAME}")

    if "gitCommonDir" in binding:
        if not isinstance(recorded_common, str) or not Path(recorded_common).is_absolute():
            raise ExternalStoreError(f"invalid git common dir in project binding: {store.project_dir}")
        same_project = _git_common_dir(store.code_root) == str(Path(recorded_common).resolve())
    else:
        same_project = Path(recorded_root).resolve() == store.code_root.resolve()
    if not same_project:
        raise ExternalStoreError(
            f"external project dir {store.project_dir} is bound to a different project "
            f"({recorded_root}); refusing to reuse data across same-named projects"
        )


def load_store(code_root: Path) -> ExternalStore:
    """Load and fully validate the external store for a configured code root.

    Raises ExternalStoreError with a user-actionable message on any invalid
    config. Callers must let it propagate: falling back to the legacy layout
    would silently run against the wrong data location.
    """
    config_path = code_root / CONFIG_FILENAME
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except OSError as e:
        raise ExternalStoreError(f"cannot read root config {config_path}: {e}") from e
    except ValueError as e:
        raise ExternalStoreError(f"root config {config_path} is not valid JSON: {e}") from e

    if not isinstance(raw, dict):
        raise ExternalStoreError(
            f"root config {config_path} must be a JSON object with "
            "'storage' and 'project' keys"
        )

    storage = raw.get("storage")
    project = raw.get("project")
    if not isinstance(storage, str) or not storage.strip():
        raise ExternalStoreError(
            f"root config {config_path}: 'storage' must be a non-empty string"
        )
    if not isinstance(project, str):
        raise ExternalStoreError(
            f"root config {config_path}: 'project' must be a string"
        )

    project = validate_project_name(project)

    if storage.startswith("~") and storage != "~" and not re.match(r"^~[/\\]", storage):
        raise ExternalStoreError(f"root config {config_path}: storage supports only ~ or ~/directory home expansion")
    storage_root = Path.home() / storage[2:] if re.match(r"^~[/\\]", storage) else Path(os.path.expanduser(storage))
    if not storage_root.is_absolute():
        # Persisted configs are absolute by convention; a relative value is
        # resolved against the code root so it cannot depend on the caller's
        # cwd at read time.
        storage_root = code_root / storage_root
    try:
        storage_root = storage_root.resolve()
    except OSError as e:
        raise ExternalStoreError(f"cannot resolve storage root {storage_root}: {e}") from e

    if not storage_root.is_dir():
        raise ExternalStoreError(
            f"storage root {storage_root} does not exist; run "
            f"`trellis init` or fix 'storage' in {config_path}"
        )

    store = ExternalStore(code_root=code_root.resolve(), storage_root=storage_root, project=project)

    project_dir = store.project_dir
    if not project_dir.is_dir():
        raise ExternalStoreError(
            f"external project dir {project_dir} does not exist; run "
            f"`trellis init` or fix 'project' in {config_path}"
        )

    if project_dir.resolve().parent != storage_root:
        raise ExternalStoreError(f"external project directory escapes storage root: {project_dir}")

    binding_path = project_dir / BINDING_FILENAME
    try:
        binding = json.loads(binding_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise ExternalStoreError(f"cannot read project binding {binding_path}: {e}") from e
    if not isinstance(binding, dict):
        raise ExternalStoreError(f"invalid project binding: {binding_path}")
    _check_binding(store, binding)

    return store


def resolve_store(start_path: Path | None = None) -> ExternalStore | None:
    """Resolve the external store for the current directory, or None.

    None means "legacy layout": no root config anywhere above the start path.
    A present-but-invalid config raises ExternalStoreError instead.
    """
    code_root = find_code_root(start_path)
    if code_root is None:
        return None
    return load_store(code_root)


def resolve_store_for_root(repo_root: Path) -> ExternalStore | None:
    """Like resolve_store, for an already-resolved code root."""
    if not (repo_root / CONFIG_FILENAME).is_file():
        return None
    return load_store(repo_root)


def workflow_dir(repo_root: Path) -> Path:
    """The workflow data directory for a code root.

    External mode: the external project dir (the real data location — never
    accessed through the in-project browse link). Legacy mode: ``<root>/.trellis``.
    """
    store = resolve_store_for_root(repo_root)
    if store is not None:
        return store.project_dir
    return repo_root / ".trellis"


def render_workflow_paths(content: str, project_dir: Path) -> str:
    """Render executable/document refs with shell-safe real workflow paths."""
    def replace(match: re.Match[str]) -> str:
        target = str(project_dir / match.group(1))
        return ('"' + target + '"') if os.name == "nt" else shlex.quote(target)
    return re.sub(r"""(?<![\w/\\])(?:\./)?\.trellis/([^\s`"'<>]+)""", replace, content)


def runtime_dir(repo_root: Path) -> Path:
    """Checkout-scoped runtime; shared product data stays outside this directory."""
    store = resolve_store_for_root(repo_root)
    return store.runtime_dir if store is not None else repo_root / ".trellis" / DIR_RUNTIME


def find_workflow_root(start_path: Path | None = None) -> Path | None:
    """Find the code root: config first, then the legacy ``.trellis`` marker.

    Config wins when both exist at different levels: the config is the
    declared binding, a stray ``.trellis`` directory is not.
    """
    code_root = find_code_root(start_path)
    if code_root is not None:
        return code_root
    current = (start_path or Path.cwd()).resolve()
    while True:
        if (current / ".trellis").is_dir():
            return current
        if current == current.parent:
            return None
        current = current.parent
