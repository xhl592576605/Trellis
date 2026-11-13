import { AI_TOOLS } from "../types/ai-tools.js";
import {
  resolvePlaceholders,
  collectBothTemplates,
  collectSharedHooks,
} from "./shared.js";
import { getHooksConfig } from "../templates/cursor/index.js";

/**
 * The Cursor file set — written at init and diffed by `trellis update`.
 * - commands/ — start + finish-work as slash commands (trellis- prefix, flat)
 * - skills/trellis-{name}/SKILL.md — auto-triggered skills from `common/skills/`
 * - hooks/*.py — shared hook scripts
 * - hooks.json — hook configuration (separate file, not settings.json)
 */
export function collectCursorTemplates(): Map<string, string> {
  const files = collectBothTemplates(
    AI_TOOLS.cursor.templateContext,
    (n) => `.cursor/commands/trellis-${n}.md`,
    ".cursor/skills",
  );
  for (const [k, v] of collectSharedHooks(".cursor/hooks", "cursor")) {
    files.set(k, v);
  }
  files.set(".cursor/hooks.json", resolvePlaceholders(getHooksConfig()));
  return files;
}
