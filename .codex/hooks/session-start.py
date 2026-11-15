#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Codex Session Start Hook - Inject Trellis context into Codex sessions.

Output format follows Codex hook protocol:
  stdout JSON → { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import warnings
from io import StringIO
from pathlib import Path

# Force UTF-8 on stdin/stdout/stderr on Windows. Default codepage there is
# cp936 / cp1252 / etc. — non-ASCII content (Chinese task names, prd snippets)
# both in stdin (hook payload from host CLI) and stdout (our emitted blocks)
# raises UnicodeDecodeError / UnicodeEncodeError. Equivalent to `python -X utf8`
# but applied per-stream so we don't depend on host CLI's command wiring.
if sys.platform.startswith("win"):
    import io as _io
    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
        elif hasattr(_stream, "detach"):
            try:
                setattr(sys, _stream_name, _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"))
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.


def _normalize_windows_shell_path(path_str: str) -> str:
    """Normalize Unix-style shell paths to real Windows paths.

    On Windows, shells like Git Bash / MSYS2 / Cygwin may report paths like
    `/d/Users/...` or `/cygdrive/d/Users/...`. `Path.resolve()` will misinterpret
    these as `D:/d/Users...` on drive D: (or similar), breaking repo root
    detection.

    This function is intentionally conservative: it only rewrites patterns that
    unambiguously represent a drive letter mount.
    """
    if not isinstance(path_str, str) or not path_str:
        return path_str

    # Only relevant on Windows; keep other platforms untouched.
    if not sys.platform.startswith("win"):
        return path_str

    p = path_str.strip()

    # Already a Windows drive path (C:\... or C:/...)
    if re.match(r"^[A-Za-z]:[\/]", p):
        return p

    # MSYS/Git-Bash style: /c/Users/... or /d/Work/...
    m = re.match(r"^/([A-Za-z])/(.*)", p)
    if m:
        drive, rest = m.group(1).upper(), m.group(2)
        rest = rest.replace('/', '\\')
        return f"{drive}:\\{rest}"

    # Cygwin style: /cygdrive/c/Users/...
    m = re.match(r"^/cygdrive/([A-Za-z])/(.*)", p)
    if m:
        drive, rest = m.group(1).upper(), m.group(2)
        rest = rest.replace('/', '\\')
        return f"{drive}:\\{rest}"

    # WSL mounted drive (sometimes leaked into env): /mnt/c/Users/...
    m = re.match(r"^/mnt/([A-Za-z])/(.*)", p)
    if m:
        drive, rest = m.group(1).upper(), m.group(2)
        rest = rest.replace('/', '\\')
        return f"{drive}:\\{rest}"

    return path_str


warnings.filterwarnings("ignore")

FIRST_REPLY_NOTICE = """<first-reply-notice>
On the first visible assistant reply in this session, briefly acknowledge that Trellis SessionStart context loaded.
Choose the acknowledgment language in this order:
1. Use the language of the user's current request (the user message that triggered this reply).
2. If that request has no clear natural language, use an explicitly established project communication language.
3. If neither provides a language, output the language-neutral fallback exactly: `Trellis SessionStart ✓`.
Continue directly with the user's request after the acknowledgment.
The acknowledgment must not alter the language used for the remainder of the response.
This notice is one-shot: do not repeat it after the first visible assistant reply in this session.
</first-reply-notice>"""


# Root-config filename (the double-l is the user's explicit spelling).
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


CONF_FILENAME = ".treills.conf.json"


def _resolve_trellis_dir(project_dir: Path) -> tuple[Path, Path]:
    """Resolve config before legacy markers; a damaged binding never falls back."""
    start = project_dir.resolve()
    candidates = [start, *start.parents]
    for root in candidates:
        if (root / CONF_FILENAME).is_file():
            return root, load_store(root).project_dir
    for root in candidates:
        if (root / ".trellis").is_dir():
            return root, root / ".trellis"
    return start, start / ".trellis"



def _config_workflow_dir(conf: Path, code_root: Path) -> Path:
    """Validate the explicit locator rather than reading a browse link."""
    return load_store(code_root).project_dir



def should_skip_injection() -> bool:
    if os.environ.get("TRELLIS_HOOKS") == "0":
        return True
    if os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return True
    return os.environ.get("CODEX_NON_INTERACTIVE") == "1"


def configure_project_encoding(project_dir: Path) -> None:
    """Reuse Trellis' shared Windows stdio encoding helper before JSON output."""
    _code_root, trellis_dir = _resolve_trellis_dir(project_dir)
    scripts_dir = trellis_dir / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    try:
        from common import configure_encoding  # type: ignore[import-not-found]

        configure_encoding()
    except Exception:
        pass  # Optional encoding helper; host defaults are still usable.


def read_file(path: Path, fallback: str = "") -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError):
        return fallback


def _resolve_context_key(project_dir: Path, hook_input: dict) -> str | None:
    _code_root, trellis_dir = _resolve_trellis_dir(project_dir)
    scripts_dir = trellis_dir / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from common.active_task import resolve_context_key  # type: ignore[import-not-found]
    except Exception:
        return None
    return resolve_context_key(hook_input, platform="codex")


def _resolve_active_task(code_root: Path, trellis_dir: Path, hook_input: dict):
    scripts_dir = trellis_dir / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from common.active_task import resolve_active_task  # type: ignore[import-not-found]

    return resolve_active_task(code_root, hook_input, platform="codex")


def run_script(script_path: Path, context_key: str | None = None) -> str:
    try:
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        if context_key:
            env["TRELLIS_CONTEXT_ID"] = context_key
        cmd = [sys.executable, "-W", "ignore", str(script_path)]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            cwd=str(script_path.parent.parent.parent),
            env=env,
        )
        return result.stdout if result.returncode == 0 else "No context available"
    except (subprocess.TimeoutExpired, FileNotFoundError, PermissionError):
        return "No context available"


def _normalize_task_ref(task_ref: str) -> str:
    normalized = task_ref.strip()
    if not normalized:
        return ""

    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return str(path_obj)

    normalized = normalized.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]

    if normalized.startswith("tasks/"):
        return f".trellis/{normalized}"

    return normalized


def _resolve_task_dir(trellis_dir: Path, task_ref: str) -> Path:
    normalized = _normalize_task_ref(task_ref)
    path_obj = Path(normalized)
    if path_obj.is_absolute():
        return path_obj
    if normalized.startswith(".trellis/"):
        # Lexical `.trellis/...` display refs map onto the workflow dir.
        # lstrip keeps doubled separators from making the rest absolute.
        return trellis_dir / path_obj.relative_to(".trellis").as_posix().lstrip("/")
    return trellis_dir / "tasks" / path_obj


def _get_task_status(code_root: Path, trellis_dir: Path, hook_input: dict) -> str:
    active = _resolve_active_task(code_root, trellis_dir, hook_input)
    if not active.task_path:
        return (
            "Status: NO ACTIVE TASK\n"
            "Next: Classify the current turn and ask for task-creation consent "
            "before creating any Trellis task."
        )

    task_ref = active.task_path
    task_dir = _resolve_task_dir(trellis_dir, task_ref)
    if active.stale or not task_dir.is_dir():
        return (
            f"Status: STALE POINTER\nTask: {task_ref}\n"
            "Next: Task directory not found. Run: python3 ./.trellis/scripts/task.py finish"
        )

    task_json_path = task_dir / "task.json"
    task_data: dict = {}
    if task_json_path.is_file():
        try:
            task_data = json.loads(task_json_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, PermissionError):
            pass  # Optional task metadata; fall back to generic status.

    task_title = task_data.get("title", task_ref)
    task_status = task_data.get("status", "unknown")

    if task_status == "completed":
        return (
            f"Status: COMPLETED\nTask: {task_title}\n"
            f"Next: Archive with `python3 ./.trellis/scripts/task.py archive {task_dir.name}` "
            "or start a new task."
        )

    has_prd = (task_dir / "prd.md").is_file()
    has_design = (task_dir / "design.md").is_file()
    has_implement = (task_dir / "implement.md").is_file()
    present = [
        name
        for name in ("prd.md", "design.md", "implement.md")
        if (task_dir / name).is_file()
    ]
    present_line = ", ".join(present) if present else "none"

    if not has_prd:
        return (
            f"Status: PLANNING\nTask: {task_title}\nPresent: {present_line}\n"
            "Next: Load trellis-brainstorm and write prd.md. Stay in planning."
        )

    if task_status == "planning":
        if has_design and has_implement:
            next_action = "Review planning artifacts with the user before `task.py start`."
        else:
            next_action = (
                "Lightweight task can ask for start review with PRD-only; "
                "complex task must add design.md and implement.md before `task.py start`."
            )
        return (
            f"Status: PLANNING\nTask: {task_title}\nPresent: {present_line}\n"
            f"Next: {next_action}"
        )

    return (
        f"Status: {task_status.upper()}\nTask: {task_title}\nPresent: {present_line}\n"
        "Next: Follow the matching per-turn workflow-state. Context order is jsonl entries, "
        "prd.md, design.md if present, implement.md if present."
    )


def _run_git(repo_root: Path, args: list[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=3,
            cwd=str(repo_root),
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, PermissionError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _format_git_state(repo_root: Path) -> str:
    branch = _run_git(repo_root, ["branch", "--show-current"]) or "(detached)"
    dirty_lines = [
        line for line in _run_git(repo_root, ["status", "--porcelain"]).splitlines()
        if line.strip()
    ]
    dirty_text = "clean" if not dirty_lines else f"dirty {len(dirty_lines)} paths"
    return f"Git: branch {branch}; {dirty_text}."


def _repo_relative(repo_root: Path, path: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return str(path)


def _collect_spec_index_paths(trellis_dir: Path) -> list[str]:
    paths: list[str] = []
    guides_index = trellis_dir / "spec" / "guides" / "index.md"
    if guides_index.is_file():
        paths.append(".trellis/spec/guides/index.md")

    spec_dir = trellis_dir / "spec"
    if not spec_dir.is_dir():
        return paths

    for sub in sorted(spec_dir.iterdir()):
        if not sub.is_dir() or sub.name.startswith(".") or sub.name == "guides":
            continue
        index_file = sub / "index.md"
        if index_file.is_file():
            paths.append(f".trellis/spec/{sub.name}/index.md")
            continue
        for nested in sorted(sub.iterdir()):
            if not nested.is_dir():
                continue
            nested_index = nested / "index.md"
            if nested_index.is_file():
                paths.append(f".trellis/spec/{sub.name}/{nested.name}/index.md")

    return paths


def _build_compact_current_state(
    code_root: Path,
    trellis_dir: Path,
    hook_input: dict,
    spec_index_paths: list[str],
) -> str:
    repo_root = code_root
    lines: list[str] = []

    try:
        from common.paths import get_active_journal_file, get_developer, get_tasks_dir, count_lines  # type: ignore[import-not-found]
        from common.tasks import iter_active_tasks  # type: ignore[import-not-found]
    except Exception:
        get_active_journal_file = None  # type: ignore[assignment]
        get_developer = None  # type: ignore[assignment]
        get_tasks_dir = None  # type: ignore[assignment]
        count_lines = None  # type: ignore[assignment]
        iter_active_tasks = None  # type: ignore[assignment]

    developer = get_developer(repo_root) if get_developer else None
    lines.append(f"Developer: {developer or '(not initialized)'}")
    lines.append(_format_git_state(repo_root))

    active = _resolve_active_task(code_root, trellis_dir, hook_input)
    if active.task_path:
        task_dir = _resolve_task_dir(trellis_dir, active.task_path)
        status = "unknown"
        task_json = task_dir / "task.json"
        if task_json.is_file():
            try:
                data = json.loads(task_json.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    status = str(data.get("status") or "unknown")
            except (json.JSONDecodeError, OSError):
                pass  # Optional task metadata; fall back to generic status.
        lines.append(f"Current task: {_repo_relative(repo_root, task_dir)}; status={status}.")
    else:
        lines.append("Current task: none.")

    if get_tasks_dir and iter_active_tasks:
        try:
            task_count = sum(1 for _ in iter_active_tasks(get_tasks_dir(repo_root)))
            lines.append(
                f"Active tasks: {task_count} total. Use `python3 ./.trellis/scripts/task.py list --mine` only if needed."
            )
        except Exception:
            pass  # Optional task summary; keep compact state available.

    if get_active_journal_file and count_lines:
        journal = get_active_journal_file(repo_root)
        if journal:
            lines.append(
                f"Journal: {_repo_relative(repo_root, journal)}, {count_lines(journal)} / 2000 lines."
            )

    if spec_index_paths:
        lines.append(f"Spec indexes: {len(spec_index_paths)} available.")

    return "\n".join(lines)


def _extract_range(content: str, start_header: str, end_header: str) -> str:
    """Extract lines starting at `## start_header` up to (but excluding) `## end_header`."""
    lines = content.splitlines()
    start: "int | None" = None
    end: int = len(lines)
    start_match = f"## {start_header}"
    end_match = f"## {end_header}"
    for i, line in enumerate(lines):
        stripped = line.strip()
        if start is None and stripped == start_match:
            start = i
            continue
        if start is not None and stripped == end_match:
            end = i
            break
    if start is None:
        return ""
    return "\n".join(lines[start:end]).rstrip()


_BREADCRUMB_TAG_RE = re.compile(
    r"\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n.*?\n\s*\[/workflow-state:\1\]",
    re.DOTALL,
)


def _strip_breadcrumb_tag_blocks(content: str) -> str:
    stripped = _BREADCRUMB_TAG_RE.sub("", content)
    stripped = re.sub(r"<!--.*?-->", "", stripped, flags=re.DOTALL)
    stripped = re.sub(r"^\[(?!/?workflow-state:)/?[^\]\n]+\]\s*\n?", "", stripped, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", stripped).strip()


def _build_workflow_toc(workflow_path: Path) -> str:
    """Inject only the compact Phase Index summary for SessionStart."""
    content = read_file(workflow_path)
    if not content:
        return "No workflow.md found"

    out_lines = [
        "# Development Workflow - Session Summary",
        "Full guide: .trellis/workflow.md. Step detail: `python3 ./.trellis/scripts/get_context.py --mode phase --step <X.Y>`.",
        "",
    ]

    phases = _extract_range(content, "Phase Index", "Phase 1: Plan")
    if phases:
        out_lines.append(_strip_breadcrumb_tag_blocks(phases).rstrip())

    return "\n".join(out_lines).rstrip()


def main() -> None:
    if should_skip_injection():
        sys.exit(0)

    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read())
        if not isinstance(hook_input, dict):
            hook_input = {}
        project_dir = Path(_normalize_windows_shell_path(hook_input.get("cwd", "."))).resolve()
    except (json.JSONDecodeError, KeyError):
        hook_input = {}
        project_dir = Path(".").resolve()

    configure_project_encoding(project_dir)

    code_root, trellis_dir = _resolve_trellis_dir(project_dir)
    spec_index_paths = _collect_spec_index_paths(trellis_dir)

    from common.session_context import get_trellis_instructions  # type: ignore[import-not-found]

    output = StringIO()

    output.write("""<session-context>
Trellis compact SessionStart context. Use it to orient the session; load details on demand.
</session-context>

""")
    output.write(FIRST_REPLY_NOTICE)
    output.write("\n\n")

    output.write(get_trellis_instructions(code_root))
    output.write("\n\n")
    output.write("<current-state>\n")
    output.write(
        _build_compact_current_state(code_root, trellis_dir, hook_input, spec_index_paths)
    )
    output.write("\n</current-state>\n\n")

    output.write("<trellis-workflow>\n")
    output.write(_build_workflow_toc(trellis_dir / "workflow.md"))
    output.write("\n</trellis-workflow>\n\n")

    output.write("<guidelines>\n")
    output.write(
        "Task context order for implementation/check: jsonl entries -> `prd.md` -> "
        "`design.md if present` -> `implement.md if present`. Missing optional artifacts "
        "are skipped for lightweight tasks.\n\n"
    )

    if spec_index_paths:
        output.write("## Available indexes (read on demand)\n")
        for p in spec_index_paths:
            output.write(f"- {p}\n")
        output.write("\n")

    output.write(
        "Discover more via: "
        "`python3 ./.trellis/scripts/get_context.py --mode packages`\n"
    )
    output.write("</guidelines>\n\n")

    task_status = _get_task_status(code_root, trellis_dir, hook_input)
    output.write(f"<task-status>\n{task_status}\n</task-status>\n\n")

    output.write("""<ready>
Context loaded. Follow <task-status>. Load workflow/spec/task details only when needed.
</ready>""")

    context = output.getvalue()
    if (code_root / CONF_FILENAME).is_file():
        context = render_workflow_paths(context, trellis_dir)
    result = {
        "suppressOutput": True,
        "systemMessage": f"Trellis context injected ({len(context)} chars)",
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        },
    }

    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
