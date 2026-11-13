import { describe, expect, it } from "vitest";
import { collectReasonixTemplates } from "../../src/configurators/reasonix.js";

describe("Reasonix current-agent skills", () => {
  it("keeps checking in the current session", () => {
    const files = collectReasonixTemplates();
    expect(files.has(".reasonix/skills/trellis-before-dev/SKILL.md")).toBe(
      true,
    );
    expect(files.get(".reasonix/skills/trellis-check/SKILL.md")).toContain(
      "# Code Quality Check",
    );
    expect(files.has(".reasonix/skills/trellis-implement/SKILL.md")).toBe(
      false,
    );
    for (const content of files.values())
      expect(content).not.toMatch(/^runAs:.*subagent/m);
  });
});
