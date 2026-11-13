import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type JsonObject = Record<string, unknown>;
interface PiExtensionContext {
  cwd?: string;
  hasUI?: boolean;
  model?: {
    provider?: string;
    id?: string;
  };
  sessionManager?: {
    getSessionId?: () => string;
    getSessionFile?: () => string | undefined;
  };
  ui?: {
    notify?: (msg: string, type?: "info" | "warning" | "error") => void;
  };
}

const SESSION_OVERVIEW_TIMEOUT_MS = 1500;
const FIRST_REPLY_NOTICE = `<first-reply-notice>
On the first visible assistant reply in this session, briefly acknowledge that Trellis SessionStart context loaded.
Choose the acknowledgment language in this order:
1. Use the language of the user's current request (the user message that triggered this reply).
2. If that request has no clear natural language, use an explicitly established project communication language.
3. If neither provides a language, output the language-neutral fallback exactly: \`Trellis SessionStart ✓\`.
Continue directly with the user's request after the acknowledgment.
The acknowledgment must not alter the language used for the remainder of the response.
This notice is one-shot: do not repeat it after the first visible assistant reply in this session.
</first-reply-notice>`;

function isObj(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function hash(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 24);
}
function readText(p: string) {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}
function exists(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
function callStr(
  cb: (() => string | undefined) | undefined,
  receiver?: unknown,
): string | null {
  if (!cb) return null;
  try {
    return str(cb.call(receiver));
  } catch {
    return null;
  }
}
function lookupStr(data: unknown, keys: string[]): string | null {
  if (!isObj(data)) return null;
  for (const k of keys) {
    const v = str(data[k]);
    if (v) return v;
  }
  for (const nk of [
    "input",
    "properties",
    "event",
    "hook_input",
    "hookInput",
  ]) {
    const nested = data[nk];
    const v = lookupStr(nested, keys);
    if (v) return v;
  }
  return null;
}
function cmdHasTrellisCtx(cmd: string) {
  const t = cmd.trimStart();
  return (
    /^export\s+TRELLIS_CONTEXT_ID=/.test(t) ||
    /^TRELLIS_CONTEXT_ID=/.test(t) ||
    /^env\s+.*TRELLIS_CONTEXT_ID=/.test(t)
  );
}

function findRoot(start: string): string {
  let c = resolve(start);
  while (true) {
    if (existsSync(join(c, ".trellis")) || existsSync(join(c, ".pi"))) return c;
    const p = dirname(c);
    if (p === c) return resolve(start);
    c = p;
  }
}
// Resolve the project root from the session working directory when available
// (pi's ExtensionContext.cwd), falling back to the pi host process cwd.
// process.cwd() is the host's launch directory and can differ from the
// session cwd (pi-web / RPC / multi-project hosts), which made .pi/agents
// lookups fail or resolve to the wrong project.
function resolveRoot(ctx?: PiExtensionContext): string {
  return findRoot(ctx?.cwd ?? process.cwd());
}
// Cache key scoping per-session state by both the session key and the
// resolved project root. With dynamic root resolution a session can observe
// different ctx.cwd values over its lifetime (pi-web / RPC / project
// switching); keying caches by the session key alone would leak one
// project's startup/task context into another.
function cacheKey(k: string | null, ctx?: PiExtensionContext): string {
  return `${k ?? "default"}::${resolveRoot(ctx)}`;
}
function contextKey(input?: unknown, ctx?: PiExtensionContext): string | null {
  const sessionId =
    callStr(ctx?.sessionManager?.getSessionId, ctx?.sessionManager) ??
    str(process.env.PI_SESSION_ID) ??
    str(process.env.PI_SESSIONID) ??
    lookupStr(input, ["session_id", "sessionId", "sessionID"]);
  if (sessionId) {
    const normalized = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_");
    if (!normalized) return `pi_${hash(sessionId)}`;
    return `pi_${normalized}${normalized === sessionId ? "" : `_${hash(sessionId)}`}`;
  }
  const transcriptPath =
    callStr(ctx?.sessionManager?.getSessionFile, ctx?.sessionManager) ??
    lookupStr(input, ["transcript_path", "transcriptPath", "transcript"]);
  if (transcriptPath) return `pi_transcript_${hash(transcriptPath)}`;
  return null;
}

/**
 * Return `candidate` when it lands inside `root`, else null.
 *
 * A session pointer is not always something the user typed. `task.py` now
 * refuses to store a ref that leaves the project, but a session file written
 * before that fix can still hold one, and `trellis update` does not rewrite
 * session files — so a poisoned pointer outlives the upgrade that closed the
 * writer. Both sides are resolved so a task directory symlinked outside is
 * refused too, but the original `candidate` is returned on success: callers do
 * `relative(root, dir)`, and handing them a realpath would break that whenever
 * `root` itself sits behind a symlink (`/tmp` does on macOS).
 */
function containInRoot(root: string, candidate: string): string | null {
  try {
    const rel = relative(realpathSync(root), realpathSync(candidate));
    if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
    return candidate;
  } catch {
    return null;
  }
}

function readTaskDir(root: string, key: string | null): string | null {
  if (!key) return null;
  try {
    const ctx = JSON.parse(
      readText(join(root, ".trellis", ".runtime", "sessions", `${key}.json`)),
    ) as JsonObject;
    let ref = str(ctx.current_task);
    if (!ref) return null;
    ref = ref;
    ref = ref.replace(/\\/g, "/").replace(/^\.\//, "");
    if (ref.startsWith("tasks/")) ref = `.trellis/${ref}`;
    const candidate = ref.startsWith(".trellis/")
      ? join(root, ref)
      : isAbsolute(ref)
        ? ref
        : join(root, ".trellis", "tasks", ref);
    return containInRoot(root, candidate);
  } catch {
    return null;
  }
}

// ── Workflow State Breadcrumb ─────────────────────────────────────────
const WF_RE =
  /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;
function workflowBreadcrumb(root: string, key: string | null): string {
  const wf = readText(join(root, ".trellis", "workflow.md"));
  if (!wf) return "";
  const templates: Record<string, string> = {};
  for (const m of wf.matchAll(WF_RE)) {
    const s = m[1] ?? "",
      b = (m[2] ?? "").trim();
    if (s && b) templates[s] = b;
  }
  const dir = readTaskDir(root, key);
  let header = "Status: no_task",
    lookup = "no_task";
  if (dir) {
    try {
      const d = JSON.parse(readText(join(dir, "task.json"))) as JsonObject;
      const status = str(d.status) ?? "";
      const id = str(d.id) ?? dir.split(/[\\/]/).pop() ?? "";
      if (status) {
        header = `Task: ${id} (${status})`;
        lookup = status;
      }
    } catch {}
  }
  const body = templates[lookup] ?? "Refer to workflow.md for current step.";
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`;
}

// ── Session Overview ───────────────────────────────────────────────────
function runContextScript(root: string, key: string | null, args: string[]): string {
  const script = join(root, ".trellis", "scripts", "get_context.py");
  if (!exists(script)) return "";
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(py, [script, ...args], {
      cwd: root,
      env: key ? { ...process.env, TRELLIS_CONTEXT_ID: key } : process.env,
      encoding: "utf-8",
      timeout: SESSION_OVERVIEW_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.status !== 0) return "";
    const stdout = (result.stdout ?? "").trim();
    return stdout;
  } catch {
    return "";
  }
}

function sessionOverview(root: string, key: string | null): string {
  const stdout = runContextScript(root, key, []);
  return stdout ? `<session-overview>\n${stdout}\n</session-overview>` : "";
}

function workflowOverview(root: string, key: string | null): string {
  const stdout = runContextScript(root, key, [
    "--mode",
    "phase",
    "--platform",
    "pi",
  ]);
  return stdout ? `<trellis-workflow>\n${stdout}\n</trellis-workflow>` : "";
}

function buildStartupContext(
  root: string,
  key: string | null,
  overview: string,
): string {
  const workflow = workflowOverview(root, key);
  return [
    "<session-context>\nTrellis compact SessionStart context. Use it to orient the session; load details on demand.\n</session-context>",
    FIRST_REPLY_NOTICE,
    overview,
    workflow,
    "<ready>\nUse the current workflow state to decide whether to create, continue, or skip a Trellis task.\n</ready>",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Main-session integration: stable startup prefix, mutable state in messages.
export default function trellisExtension(pi: {
  on?: (
    event: string,
    handler: (event: unknown, ctx?: PiExtensionContext) => unknown,
  ) => void;
}): void {
  const procKey = `pi_process_${hash([resolveRoot(), process.pid, Date.now(), randomBytes(8).toString("hex")].join(":"))}`;
  let curKey: string | null = null;
  const getKey = (input?: unknown, ctx?: PiExtensionContext): string => {
    const key = contextKey(input, ctx) ?? curKey ?? procKey;
    curKey = key;
    return key;
  };
  const startupCache = new Map<string, string>();
  const lastRuntime = new Map<string, string>();
  const lastRoot = new Map<string, string>();

  pi.on?.("session_start", (event, ctx) => {
    getKey(event, ctx);
    ctx?.ui?.notify?.(
      "Trellis project context is available. Use /trellis-start to bootstrap or /trellis-continue to resume.",
      "info",
    );
  });
  pi.on?.("tool_call", (event, ctx) => {
    const key = getKey(event, ctx);
    const ev = event as { toolName?: string; input?: JsonObject };
    if (ev.toolName === "bash" && isObj(ev.input) &&
        typeof ev.input.command === "string" && !cmdHasTrellisCtx(ev.input.command)) {
      ev.input.command = `export TRELLIS_CONTEXT_ID=${shellQuote(key)}; ${ev.input.command}`;
    }
  });
  pi.on?.("before_agent_start", (event, ctx) => {
    const key = getKey(event, ctx);
    const root = resolveRoot(ctx);
    const scopedKey = cacheKey(key, ctx);
    const overview = sessionOverview(root, key);
    let startup = startupCache.get(scopedKey);
    if (startup === undefined) {
      startup = buildStartupContext(root, key, overview);
      startupCache.set(scopedKey, startup);
    }
    const runtime = [workflowBreadcrumb(root, key), overview].filter(Boolean).join("\n\n");
    const changed = runtime !== lastRuntime.get(scopedKey) || root !== lastRoot.get(key);
    lastRuntime.set(scopedKey, runtime);
    lastRoot.set(key, root);
    return {
      message: changed && runtime ? {
        customType: "trellis-runtime-context",
        content: runtime,
        display: false,
      } : undefined,
      systemPrompt: [(event as { systemPrompt?: string }).systemPrompt ?? "", startup]
        .filter(Boolean).join("\n\n"),
    };
  });
  pi.on?.("context", (event, ctx) => { getKey(event, ctx); });
}
