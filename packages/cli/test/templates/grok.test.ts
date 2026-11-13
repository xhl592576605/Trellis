import { describe, expect, it } from "vitest";
import { collectGrokTemplates } from "../../src/configurators/grok.js";

describe("Grok current-agent templates", () => {
  it("keeps flat commands and private workflow skills", () => {
    const files = collectGrokTemplates();
    for (const name of ["start", "continue", "finish-work"]) {
      expect(files.has(`.grok/commands/trellis-${name}.md`)).toBe(true);
    }
    expect(files.has(".grok/commands/trellis/start.md")).toBe(false);
    expect(files.has(".grok/skills/trellis-check/SKILL.md")).toBe(true);
    expect(files.has(".grok/skills/trellis-before-dev/SKILL.md")).toBe(true);
    expect(
      [...files.keys()].some((key) => key.startsWith(".grok/agents/")),
    ).toBe(false);
    expect(
      [...files.keys()].some((key) => key.startsWith(".agents/skills/")),
    ).toBe(false);
  });
});
