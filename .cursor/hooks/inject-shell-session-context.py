#!/usr/bin/env python3
"""Pre-shell hook: bridge the host's session identity into task.py.

No researched platform exports a session id into its shell tool's child
process, but every hook-capable one puts that id on hook stdin. So the hook
that fires just before a shell command writes a short-lived runtime ticket
whenever the pending command calls `task.py start/current/finish`, and the
task script consumes it when it has no native session environment.

Registered on whichever pre-shell event the host provides — Cursor's
`beforeShellExecution`, Claude-shaped `PreToolUse`, Gemini's `BeforeTool` —
which is why the only thing here that knows about payload variation is
`_pending_shell_command`.
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import sys
import time
from pathlib import Path
from typing import Any

# Hook hosts send UTF-8 JSON regardless of the process locale.
_stdin_reconfigure = getattr(sys.stdin, "reconfigure", None)
if callable(_stdin_reconfigure):
    try:
        _stdin_reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        pass


DIR_WORKFLOW = ".trellis"
DIR_RUNTIME = ".runtime"
DIR_SHELL_TICKETS = "shell-tickets"
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
SESSION_SUBCOMMANDS = {"start", "current", "finish"}
TICKET_TTL_SECONDS = 30
CONTEXT_IDENTITY_KEYS = (
    "session_id",
    "sessionId",
    "sessionID",
    "conversation_id",
    "conversationId",
    "conversationID",
    "transcript_path",
    "transcriptPath",
    "transcript",
)
# Tool-call payloads nest the command one level down; same casing spread as
# CONTEXT_IDENTITY_KEYS above.
TOOL_INPUT_KEYS = ("tool_input", "toolInput")
# Answering a shell-execution event with an explicit allow is what keeps
# Cursor from re-prompting for a command Trellis itself asked for. Tool-call
# hosts read a different response schema, so they get no answer at all rather
# than a key they would have to ignore.
SHELL_EVENT_RESPONSE = {"permission": "allow"}


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _resolve_trellis_root(hook_input: dict[str, Any]) -> Path | None:
    """Locate the project root, trying the payload cwd and then our own.

    Hosts disagree about what `cwd` means. CodeBuddy IDE 4.10.4 sends `"/"` for
    every PreToolUse event, so trusting the payload alone finds no `.trellis`
    and the bridge silently does nothing — the hook is invoked, writes no
    ticket, and `task.py start` degrades. Observed with a wildcard probe:

        {"cwd": "/", "tool_name": "Bash", "tool_input": {"command": "ls …"}}

    The hook's own cwd is reliable where the payload is not: hosts launch it
    from the project root, which is why a relative `command` in settings.json
    resolves at all. Try the payload first (it is right on hosts that set it,
    and survives a host that runs hooks from elsewhere), then fall back.
    """
    candidates: list[Path] = []
    payload_cwd = _string_value(hook_input.get("cwd"))
    if payload_cwd:
        candidates.append(Path(payload_cwd))
    try:
        candidates.append(Path(os.getcwd()))
    except OSError:
        pass

    for candidate in candidates:
        root = _find_trellis_root(candidate)
        if root is not None:
            return root
    return None


def _find_trellis_root(start: Path) -> Path | None:
    candidates = [start.resolve(), *start.resolve().parents]
    for root in candidates:
        if (root / CONF_FILENAME).is_file():
            return root
    return next((root for root in candidates if (root / DIR_WORKFLOW).is_dir()), None)



def _workflow_dir_for_root(root: Path) -> Path:
    return load_store(root).project_dir if (root / CONF_FILENAME).is_file() else root / DIR_WORKFLOW



def _runtime_ticket_dir(root: Path) -> Path:
    if (root / CONF_FILENAME).is_file():
        return load_store(root).runtime_dir / DIR_SHELL_TICKETS
    return _workflow_dir_for_root(root) / DIR_RUNTIME / DIR_SHELL_TICKETS


def _pending_shell_command(hook_input: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Read the pending shell command out of either hook payload shape.

    Returns the command plus the response envelope that shape expects:

    - shell-execution event (Cursor `beforeShellExecution`) — the command sits
      at the top level and the host wants a permission decision back;
    - tool-call event (`PreToolUse`, `BeforeTool`) — the command sits under
      `tool_input`, and the host reads a schema this hook has no opinion on.

    An ordered fallback, not a platform switch: a third payload shape extends
    the same function. Anything else yields ("", None) so main() no-ops.
    """
    command = _string_value(hook_input.get("command"))
    if command:
        return command, SHELL_EVENT_RESPONSE

    for key in TOOL_INPUT_KEYS:
        tool_input = hook_input.get(key)
        if not isinstance(tool_input, dict):
            continue
        command = _string_value(tool_input.get("command"))
        if command:
            return command, None

    return "", None


def _host_platform_name() -> str | None:
    """Name the host from the config directory this hook was installed into.

    Every platform puts its hooks under its own dotted directory
    (`.cursor/hooks/`, `.factory/hooks/`, …), so the deepest dotted path
    segment identifies the host without a table of platform names here. It
    matters because the context key must agree with the one the platform's
    other hooks compute — a ticket keyed differently would write a session
    file no later hook ever reads.
    """
    for part in reversed(Path(sys.argv[0]).parts):
        if part.startswith(".") and part not in (".", "..") and len(part) > 1:
            return part[1:]
    return None


def _load_active_task_resolver(root: Path):
    scripts_dir = _workflow_dir_for_root(root) / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from common.active_task import resolve_context_key  # type: ignore[import-not-found]

    return resolve_context_key


def _extract_task_subcommands(command: str) -> list[dict[str, str]]:
    try:
        tokens = shlex.split(command, posix=os.name != "nt")
    except ValueError:
        return []

    subcommands: list[dict[str, str]] = []
    for index, token in enumerate(tokens[:-1]):
        if Path(token.strip("\"'")).name != "task.py":
            continue
        name = tokens[index + 1]
        if name not in SESSION_SUBCOMMANDS:
            continue
        item = {"name": name}
        if name == "start" and index + 2 < len(tokens):
            item["task_ref"] = tokens[index + 2]
        subcommands.append(item)
    return subcommands


def _cleanup_expired_tickets(ticket_dir: Path, now: float) -> None:
    if not ticket_dir.is_dir():
        return
    for ticket_path in ticket_dir.glob("*.json"):
        try:
            data = json.loads(ticket_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        expires_at = data.get("expires_at_epoch")
        if isinstance(expires_at, (int, float)) and expires_at < now:
            try:
                ticket_path.unlink()
            except OSError:
                pass


def _has_context_identity(hook_input: dict[str, Any]) -> bool:
    return any(_string_value(hook_input.get(key)) for key in CONTEXT_IDENTITY_KEYS)


def _write_ticket(
    root: Path,
    hook_input: dict[str, Any],
    context_key: str,
    command: str,
    platform_name: str | None,
    subcommands: list[dict[str, str]],
) -> None:
    now = time.time()
    ticket_dir = _runtime_ticket_dir(root)
    ticket_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_expired_tickets(ticket_dir, now)

    digest = hashlib.sha256(
        f"{context_key}\0{command}\0{now}".encode("utf-8"),
    ).hexdigest()[:16]
    ticket_path = ticket_dir / f"{int(now * 1000)}-{digest}.json"

    payload = {
        # Debugging metadata. The consumer accepts a ticket on freshness, repo
        # and subcommand — never on this field.
        "platform": platform_name,
        "context_key": context_key,
        "conversation_id": _string_value(hook_input.get("conversation_id")),
        "session_id": _string_value(hook_input.get("session_id")),
        "generation_id": _string_value(hook_input.get("generation_id")),
        # The resolved project root, not the payload's cwd. The consumer
        # rejects a ticket whose cwd is outside the repo, and CodeBuddy IDE
        # 4.10.4 reports "/" for every PreToolUse event — a ticket carrying
        # that is written correctly and then discarded on arrival. Recording
        # the root we actually resolved keeps the containment check meaningful
        # without trusting a field the host may not populate.
        "cwd": str(root),
        # Kept separately so a wrong host cwd stays visible when debugging.
        "host_cwd": _string_value(hook_input.get("cwd")),
        "command": command,
        "subcommands": subcommands,
        "created_at_epoch": now,
        "expires_at_epoch": now + TICKET_TTL_SECONDS,
    }
    ticket_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    if os.environ.get("TRELLIS_HOOKS") == "0" or os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return 0

    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        hook_input = {}
    if not isinstance(hook_input, dict):
        hook_input = {}

    command, response = _pending_shell_command(hook_input)
    subcommands = _extract_task_subcommands(command)
    if not subcommands:
        return 0

    root = _resolve_trellis_root(hook_input)
    if root is None:
        return 0

    if not _has_context_identity(hook_input):
        return 0

    platform_name = _host_platform_name()
    resolve_context_key = _load_active_task_resolver(root)
    context_key = resolve_context_key(hook_input, platform=platform_name)
    if not context_key:
        return 0

    try:
        _write_ticket(root, hook_input, context_key, command, platform_name, subcommands)
    except OSError:
        return 0

    if response is not None:
        print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
