import { AI_TOOLS } from "../types/ai-tools.js";
import {
  resolvePlaceholders,
  collectBothTemplates,
  collectSharedHooks,
} from "./shared.js";
import { getSettingsTemplate } from "../templates/codebuddy/index.js";

/**
 * The CodeBuddy file set — written at init and diffed by `trellis update`.
 * - commands/trellis/ — start + finish-work as slash commands
 * - skills/trellis-{name}/SKILL.md — auto-triggered skills from `common/skills/`
 * - hooks/*.py — shared hook scripts
 * - settings.json — hook configuration
 */
export function collectCodebuddyTemplates(): Map<string, string> {
  const files = collectBothTemplates(
    AI_TOOLS.codebuddy.templateContext,
    (n) => `.codebuddy/commands/trellis/${n}.md`,
    ".codebuddy/skills",
  );
  for (const [k, v] of collectSharedHooks(".codebuddy/hooks", "codebuddy")) {
    files.set(k, v);
  }
  const settings = getSettingsTemplate();
  files.set(
    `.codebuddy/${settings.targetPath}`,
    resolvePlaceholders(settings.content),
  );
  return files;
}
