import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectPlatformTemplates,
  PLATFORM_IDS,
} from "../src/configurators/index.js";
import {
  getAllScripts,
  workflowMdTemplate,
} from "../src/templates/trellis/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(): { root: string; run: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "trellis-current-agent-"));
  roots.push(root);
  for (const [name, content] of getAllScripts()) {
    const file = join(root, ".trellis", "scripts", name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  writeFileSync(join(root, ".trellis", "workflow.md"), workflowMdTemplate);
  const run = (...args: string[]): string =>
    execFileSync("python3", [join(root, ".trellis/scripts/task.py"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TRELLIS_CONTEXT_ID: "current_agent_test" },
    }).trim();
  return { root, run };
}

describe("current-agent workflow", () => {
  it.each(PLATFORM_IDS)(
    "%s keeps preparation/check skills and installs no workflow subagents",
    (id) => {
      const files = collectPlatformTemplates(id);
      expect(files).toBeDefined();
      const paths = [...(files?.keys() ?? [])];
      expect(paths.some((name) => /trellis-before-dev/.test(name))).toBe(true);
      expect(paths.some((name) => /trellis-check/.test(name))).toBe(true);
      expect(
        paths.filter((name) =>
          /\/(agents|droids)\/trellis-(implement|check|research)\./.test(name),
        ),
      ).toEqual([]);
      expect(
        paths.some((name) => /inject-subagent|beforeSubAgentStart/.test(name)),
      ).toBe(false);
      for (const [name, content] of files ?? []) {
        if (/\.(json|txt)$/.test(name)) {
          expect(content, name).not.toContain('name: "trellis_subagent"');
          expect(content, name).not.toContain('"SubagentStart"');
        }
      }
    },
  );

  it("preserves task creation, hierarchy, start and finish without handoff manifests", () => {
    const { root, run } = project();
    mkdirSync(join(root, ".pi"));
    const parent = run(
      "create",
      "Parent",
      "--description",
      "Parent task",
      "--slug",
      "parent",
      "--assignee",
      "test",
    );
    const child = run(
      "create",
      "Child",
      "--description",
      "Child task",
      "--slug",
      "child",
      "--assignee",
      "test",
      "--parent",
      parent,
    );
    const taskDir = join(root, child);
    expect(readFileSync(join(taskDir, "prd.md"), "utf8")).toContain(
      "Child task",
    );
    expect(existsSync(join(taskDir, "implement.jsonl"))).toBe(false);
    expect(existsSync(join(taskDir, "check.jsonl"))).toBe(false);
    // Legacy empty manifests must not prevent starting the existing task.
    writeFileSync(join(taskDir, "implement.jsonl"), "");
    writeFileSync(join(taskDir, "check.jsonl"), "");
    run("start", child);
    expect(
      JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8")).status,
    ).toBe("in_progress");
    expect(run("current")).toContain(child);
    expect(
      JSON.parse(readFileSync(join(root, parent, "task.json"), "utf8"))
        .children,
    ).toContain(child.split("/").pop());
    run("finish");
    expect(
      existsSync(
        join(root, ".trellis/.runtime/sessions/current_agent_test.json"),
      ),
    ).toBe(false);
  });

  it.each(["claude", "codex", "pi", "omp", "kimi", "snow"])(
    "%s renders direct execution steps",
    (platform) => {
      const { root } = project();
      for (const step of ["1.2", "1.3", "2.1", "2.2"]) {
        const output = execFileSync(
          "python3",
          [
            join(root, ".trellis/scripts/get_context.py"),
            "--mode",
            "phase",
            "--step",
            step,
            "--platform",
            platform,
          ],
          { cwd: root, encoding: "utf8" },
        );
        expect(output).toContain(step);
        expect(output).not.toMatch(
          /Spawn the|dispatch.*sub-agent|implement.jsonl|check.jsonl/,
        );
      }
    },
  );
});
