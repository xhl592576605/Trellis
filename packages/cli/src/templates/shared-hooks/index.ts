/**
 * Shared hook templates — platform-independent Python hook scripts.
 *
 * These scripts read only from .trellis/ paths (JSONL, prd.md, spec/) and
 * have no platform-specific placeholders. They can be written as-is to any
 * platform's hooks directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readTemplate(relativePath: string): string {
  return readFileSync(join(__dirname, relativePath), "utf-8");
}

/** Standalone source emitted into each host; one contract for all bootstrap readers. */
export function getExternalStoreBootstrap(language: "js" | "py"): string {
  return language === "js"
    ? readTemplate("external-store.js")
    : readTemplate("../trellis/scripts/common/external_store.py").replace(
        "from __future__ import annotations\n",
        "",
      );
}

export interface HookScript {
  /** Filename (e.g., "session-start.py") */
  name: string;
  /** Script content — no placeholders, ready to write directly */
  content: string;
}

export type SharedHookName =
  | "session-start.py"
  | "inject-shell-session-context.py"
  | "inject-workflow-state.py";

export type SharedHookPlatform =
  | "claude"
  | "cursor"
  | "codex"
  | "gemini"
  | "qoder"
  | "copilot"
  | "codebuddy"
  | "droid"
  | "kiro"
  | "trae"
  | "zcode";

/**
 * Main-session hook distribution, shared by init and update.
 * Session-start loads orientation, workflow-state emits per-turn guidance,
 * and shell-session-context carries session identity into task.py children.
 * Kiro uses its main agent spawn hook for startup and a per-turn hook for
 * workflow state. Codex and Copilot retain platform-specific startup files.
 */
export const SHARED_HOOKS_BY_PLATFORM: Record<
  SharedHookPlatform,
  readonly SharedHookName[]
> = {
  claude: ["session-start.py", "inject-workflow-state.py"],
  cursor: ["session-start.py", "inject-shell-session-context.py"],
  codex: ["inject-workflow-state.py"],
  gemini: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
  qoder: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
  copilot: ["inject-workflow-state.py"],
  codebuddy: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
  droid: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
  kiro: ["session-start.py", "inject-workflow-state.py"],
  trae: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
  zcode: [
    "session-start.py",
    "inject-shell-session-context.py",
    "inject-workflow-state.py",
  ],
};

/**
 * Get all shared hook scripts. Content is platform-independent and can be
 * written directly without placeholder resolution.
 */
export function getSharedHookScripts(): HookScript[] {
  const scripts: HookScript[] = [];
  const files = readdirSync(__dirname)
    .filter((f) => f.endsWith(".py"))
    .sort();

  for (const file of files) {
    scripts.push({ name: file, content: readTemplate(file) });
  }

  return scripts;
}

/**
 * Get the shared hook scripts that a given platform actually registers.
 * Drives `collectSharedHooks` so distribution never drifts from the
 * per-platform capability declared above.
 */
export function getSharedHookScriptsForPlatform(
  platform: SharedHookPlatform,
): HookScript[] {
  const allowed = new Set<string>(SHARED_HOOKS_BY_PLATFORM[platform]);
  return getSharedHookScripts().filter((h) => allowed.has(h.name));
}
