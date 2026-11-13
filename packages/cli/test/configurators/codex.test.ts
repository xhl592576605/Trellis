import { describe, expect, it } from "vitest";
import { collectCodexTemplates } from "../../src/configurators/codex.js";

describe("Codex current-agent integration", () => {
  it("keeps workflow skills and the main-session hook without workflow roles", () => {
    const files = collectCodexTemplates();
    expect(files.has(".agents/skills/trellis-check/SKILL.md")).toBe(true);
    expect(files.has(".codex/hooks/inject-workflow-state.py")).toBe(true);
    expect(
      [...files.keys()].some((name) => name.startsWith(".codex/agents/")),
    ).toBe(false);
    expect(files.get(".codex/hooks.json")).not.toContain("SubagentStart");
    expect(files.get(".codex/config.toml")).not.toContain("max_depth");
  });
});
