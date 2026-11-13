#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Snow CLI Trellis context writer + additionalContext emitter.

Used by onSessionStart / onUserMessage hooks.

1. Writes a breadcrumb file the current agent can read:
     .snow/log/trellis-context.txt
2. Prints stdout JSON for the Snow inject protocol:
     { "additionalContext": "...", "display": "..." }

Modes (compact vs full):
- argv: session | user  (preferred)
- env:  TRELLIS_SNOW_HOOK_MODE
- stdin JSON from Snow may include agentId/agentName/prompt/cwd/sessionId

Non-JSON hosts ignore stdout; Snow injects it into model context.
Fail-open: never raise out of main().
"""

from __future__ import annotations

from collections.abc import Mapping
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Force UTF-8 on Windows consoles (cp936/cp1252 otherwise corrupt Chinese paths).
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
                pass
        elif hasattr(_stream, "detach"):
            try:
                setattr(
                    sys,
                    _stream_name,
                    _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"),
                )
            except Exception:
                pass


DEFAULT_MAX_BYTES = 7500
COMPACT_MAX_BYTES = 2800


def _find_repo_root(start: Path) -> Path:
    cur = start.resolve()
    for candidate in [cur, *cur.parents]:
        if (candidate / ".trellis").is_dir():
            return candidate
    return cur


def _run(cmd: list[str], cwd: Path) -> str:
    try:
        completed = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            # Keep below Snow user hook timeout (15s) so fail-open JSON
            # can still emit if task.py stalls.
            timeout=5,
            check=False,
        )
    except Exception as exc:  # noqa: BLE001 — hooks must never crash the host
        return f"(command failed: {exc})"
    out = (completed.stdout or "").strip()
    if out:
        return out
    err = (completed.stderr or "").strip()
    return err or "(no output)"


def _read_text(path: Path, limit: int = 4000) -> str:
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    data = data.strip()
    if len(data) > limit:
        return data[: limit - 20] + "\n... (truncated)"
    return data


def _parse_active_task_path(current_out: str, repo: Path) -> Path | None:
    # Prefer "Current task: .trellis/tasks/..." line from task.py --source.
    for line in current_out.splitlines():
        m = re.search(r"Current task:\s*(.+)\s*$", line.strip(), re.I)
        if not m:
            continue
        raw = m.group(1).strip().strip('"').strip("'")
        if not raw or raw.lower() in {"none", "(none)", "n/a"}:
            return None
        p = Path(raw)
        if not p.is_absolute():
            p = repo / p
        return p
    # Fallback: first path-like token containing tasks/
    m = re.search(r"(\.trellis[/\\]tasks[/\\][^\s]+)", current_out)
    if m:
        return repo / m.group(1).replace("\\", "/")
    return None


def _drain_stdin(timeout_sec: float = 0.5) -> str:
    """Best-effort drain of host-piped hook context without hanging on TTY."""
    chunks: list[str] = []
    try:
        if sys.stdin is None or sys.stdin.closed:
            return ""
        # Interactive terminal: do not block waiting for EOF.
        if hasattr(sys.stdin, "isatty") and sys.stdin.isatty():
            return ""

        # Hosts (Snow) pipe JSON then close stdin. Manual CLI runs must not hang.
        if sys.platform.startswith("win"):
            import threading

            box: list[str] = []

            def _read() -> None:
                try:
                    box.append(sys.stdin.read())
                except Exception:
                    pass

            t = threading.Thread(target=_read, daemon=True)
            t.start()
            t.join(timeout_sec)
            return box[0] if box else ""

        import select

        while True:
            ready, _, _ = select.select([sys.stdin], [], [], timeout_sec)
            if not ready:
                break
            chunk = sys.stdin.read(4096)
            if not chunk:
                break
            chunks.append(chunk)
    except Exception:
        pass
    return "".join(chunks)


def _parse_stdin_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        # Some hosts may wrap payload; try first JSON object substring.
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                data = json.loads(text[start : end + 1])
                return data if isinstance(data, dict) else {}
            except Exception:
                return {}
        return {}


def _resolve_mode(
    argv: list[str], env: Mapping[str, str], stdin_ctx: dict[str, Any]
) -> str:
    for arg in argv[1:]:
        mode = arg.strip().lower()
        if mode in {"session", "user", "full", "compact"}:
            return {"full": "session", "compact": "user"}.get(mode, mode)
    mode = (env.get("TRELLIS_SNOW_HOOK_MODE") or "").strip().lower()
    if mode in {"session", "user"}:
        return mode
    if stdin_ctx.get("message") is not None or stdin_ctx.get("source") in {"normal", "pending"}:
        return "user"
    return "session"


def _task_artifact_summary(task_dir: Path, *, detailed: bool) -> list[str]:
    lines = [f"## Active task artifacts ({task_dir.as_posix()})"]
    for name in ("prd.md", "design.md", "implement.md", "task.json"):
        artifact = task_dir / name
        lines.append(f"- {name}: {'present' if artifact.is_file() else 'missing'}")
        if detailed and artifact.is_file() and name.endswith(".md"):
            body = _read_text(artifact, 1800 if name == "prd.md" else 900)
            if body:
                lines.extend([f"## {name} summary", body, ""])
    lines.append("")
    return lines


def _sanitize_session_key(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (value or "").strip())
    return cleaned.strip("._-")


def _current_session_ids(stdin_ctx: dict[str, Any] | None = None) -> list[str]:
    # Prefer explicit Trellis context, then Snow session identity.
    ids: list[str] = []
    candidates = [
        os.environ.get("TRELLIS_CONTEXT_ID"),
        os.environ.get("SNOW_SESSION_ID"),
    ]
    if stdin_ctx:
        candidates.extend(
            [
                stdin_ctx.get("sessionId"),
                stdin_ctx.get("session_id"),
            ]
        )
    for raw in candidates:
        if not isinstance(raw, str):
            continue
        key = _sanitize_session_key(raw)
        if key and key not in ids:
            ids.append(key)
        # Snow injects TRELLIS_CONTEXT_ID=snow-<sessionId>
        if key.startswith("snow_"):
            bare = key[5:]
            if bare and bare not in ids:
                ids.append(bare)
        if key.startswith("snow-"):
            bare = key[5:]
            if bare and bare not in ids:
                ids.append(bare)
    return ids


def _resolve_runtime_session_file(
    repo: Path,
    stdin_ctx: dict[str, Any] | None = None,
) -> Path | None:
    # Resolve only the current session runtime file; never pick by mtime.
    sessions_dir = repo / ".trellis" / ".runtime" / "sessions"
    if not sessions_dir.is_dir():
        return None
    for sid in _current_session_ids(stdin_ctx):
        for name in (f"{sid}.json", sid):
            candidate = sessions_dir / name
            if candidate.is_file():
                return candidate
    return None


def _workflow_phase_summary(
    repo: Path,
    stdin_ctx: dict[str, Any] | None = None,
) -> list[str]:
    lines: list[str] = []
    workflow = repo / ".trellis" / "workflow.md"
    if workflow.is_file():
        body = _read_text(workflow, 900)
        if body:
            lines.extend(["## workflow.md excerpt", body, ""])

    # Prefer classic path; fall back only to the *current* runtime session file.
    session_md = repo / ".trellis" / "session" / "current.md"
    if session_md.is_file():
        body = _read_text(session_md, 1200)
        if body:
            lines.extend(["## .trellis/session/current.md", body, ""])
    else:
        current_session = _resolve_runtime_session_file(repo, stdin_ctx)
        if current_session is not None:
            body = _read_text(current_session, 900)
            if body:
                lines.extend(
                    [
                        f"## runtime session ({current_session.name})",
                        body,
                        "",
                    ]
                )
    return lines


def build_context(
    repo: Path,
    *,
    mode: str,
    stdin_ctx: dict[str, Any],
) -> str:
    compact = mode == "user"

    lines: list[str] = [
        "# Trellis context (Snow CLI)",
        "",
        f"Mode: {mode}",
        f"Repo: {repo}",
        "",
    ]

    if stdin_ctx.get("sessionId"):
        lines.append(f"Snow sessionId: {stdin_ctx.get('sessionId')}")
    if stdin_ctx.get("cwd"):
        lines.append(f"Hook cwd: {stdin_ctx.get('cwd')}")
    task_py = repo / ".trellis" / "scripts" / "task.py"
    current = ""
    task_dir: Path | None = None
    if task_py.is_file():
        py = sys.executable or "python3"
        current = _run([py, "-X", "utf8", str(task_py), "current", "--source"], repo)
        lines.extend(["## task.py current --source", "```", current, "```", ""])
        task_dir = _parse_active_task_path(current, repo)
    else:
        lines.append("(no .trellis/scripts/task.py — run trellis init first)")
        lines.append("")

    if task_dir and task_dir.exists():
        lines.extend(
            _task_artifact_summary(
                task_dir,
                detailed=not compact,
            )
        )
    elif current:
        lines.append("(could not resolve active task directory from task.py output)")
        lines.append("")

    if not compact:
        lines.extend(_workflow_phase_summary(repo, stdin_ctx))

        identity = repo / ".trellis" / "identity.md"
        if identity.is_file():
            body = _read_text(identity, 1200)
            if body:
                lines.extend(["## .trellis/identity.md", body, ""])
    else:
        # Compact: short identity one-liner if file exists.
        identity = repo / ".trellis" / "identity.md"
        if identity.is_file():
            body = _read_text(identity, 280)
            if body:
                first = body.splitlines()[0].strip()
                lines.append(f"Identity: {first}")
                lines.append("")

    lines.extend([
        "## Main-session checklist",
        "1. Follow .trellis/workflow.md in the current agent.",
        "2. Read task artifacts and applicable specs with trellis-before-dev.",
        "3. Implement directly, then run trellis-check and project validation.",
        "",
    ])

    return "\n".join(lines).strip() + "\n"


def _truncate(text: str, max_bytes: int) -> str:
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    suffix = "\n... (truncated)\n"
    budget = max(0, max_bytes - len(suffix.encode("utf-8")))
    return encoded[:budget].decode("utf-8", errors="ignore") + suffix


def main() -> int:
    try:
        raw_stdin = _drain_stdin()
        stdin_ctx = _parse_stdin_json(raw_stdin)
        mode = _resolve_mode(sys.argv, os.environ, stdin_ctx)

        cwd_hint = stdin_ctx.get("cwd") if isinstance(stdin_ctx.get("cwd"), str) else None
        cwd = Path(cwd_hint or os.environ.get("SNOW_CWD") or os.getcwd())
        repo = _find_repo_root(cwd)
        context = build_context(repo, mode=mode, stdin_ctx=stdin_ctx)

        log_dir = repo / ".snow" / "log"
        try:
            log_dir.mkdir(parents=True, exist_ok=True)
            # Keep trellis-context.txt as the richest practical breadcrumb for
            # pull-based reads. User-mode inject stays compact, but must not
            # clobber a prior full snapshot.
            log_path = log_dir / "trellis-context.txt"
            if mode == "user":
                full_context = build_context(repo, mode="session", stdin_ctx=stdin_ctx)
                log_path.write_text(full_context, encoding="utf-8")
            else:
                log_path.write_text(context, encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"trellis-context write failed: {exc}\n")

        max_bytes = COMPACT_MAX_BYTES if mode == "user" else DEFAULT_MAX_BYTES
        inject = _truncate(context, max_bytes)
        display = {
            "session": "Trellis session context injected",
            "user": "Trellis compact breadcrumb",
        }.get(mode, "Trellis context refreshed")
        display = f"{display} (.snow/log/trellis-context.txt)"

        payload = {
            "additionalContext": inject,
            "display": display,
        }
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:  # noqa: BLE001 — absolute fail-open
        try:
            sys.stderr.write(f"write-trellis-context failed: {exc}\n")
            # Still emit empty-safe JSON so host can continue.
            sys.stdout.write(
                json.dumps(
                    {
                        "additionalContext": "# Trellis context unavailable (hook error)\n",
                        "display": "Trellis context hook error (fail-open)",
                    },
                    ensure_ascii=False,
                )
            )
            sys.stdout.write("\n")
        except Exception:
            pass
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
