import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { collectPiTemplates } from "../../src/configurators/pi.js";
import { getExtensionTemplate } from "../../src/templates/pi/index.js";

interface Context {
  cwd: string;
  sessionManager: { getSessionId: () => string };
}
type Handler = (
  event: unknown,
  ctx: Context,
) => { systemPrompt?: string; message?: { content: string } } | undefined;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function project(label: string): {
  root: string;
  ctx: Context;
  setStatus: (status: string) => void;
} {
  const root = mkdtempSync(join(tmpdir(), "trellis-pi-main-"));
  roots.push(root);
  const dir = join(root, ".trellis/tasks/demo");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, ".trellis/scripts"));
  mkdirSync(join(root, ".trellis/.runtime/sessions"), { recursive: true });
  writeFileSync(
    join(root, ".trellis/scripts/get_context.py"),
    'print("Session overview")\n',
  );
  writeFileSync(
    join(root, ".trellis/.runtime/sessions/pi_session.json"),
    JSON.stringify({ current_task: ".trellis/tasks/demo" }),
  );
  writeFileSync(
    join(root, ".trellis/workflow.md"),
    ["no_task", "planning", "in_progress"]
      .map(
        (status) => `[workflow-state:${status}]
${label}:${status}
[/workflow-state:${status}]`,
      )
      .join("\n"),
  );
  const setStatus = (status: string): void => {
    writeFileSync(
      join(dir, "task.json"),
      JSON.stringify({ id: "demo", status }),
    );
  };
  setStatus("planning");
  return {
    root,
    ctx: { cwd: root, sessionManager: { getSessionId: () => "session" } },
    setStatus,
  };
}

function handlers(): Map<string, Handler> {
  const compiled = ts.transpileModule(getExtensionTemplate(), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  expect(
    compiled.diagnostics?.filter(
      (item) => item.category === ts.DiagnosticCategory.Error,
    ),
  ).toEqual([]);
  const moduleObject: { exports: { default?: (pi: unknown) => void } } = {
    exports: {},
  };
  const sandboxProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(sandboxProcess, "env", { value: { ...process.env } });
  vm.runInNewContext(compiled.outputText, {
    Buffer,
    process: sandboxProcess,
    require: createRequire(import.meta.url),
    module: moduleObject,
    exports: moduleObject.exports,
  });
  const result = new Map<string, Handler>();
  const tools: unknown[] = [];
  moduleObject.exports.default?.({
    on: (name: string, handler: Handler) => result.set(name, handler),
    registerTool: (tool: unknown) => tools.push(tool),
  });
  expect(tools).toEqual([]);
  return result;
}

describe("Pi current-agent integration", () => {
  it("keeps shared skills and a manual startup fallback", () => {
    const files = collectPiTemplates();
    expect(files.has(".agents/skills/trellis-before-dev/SKILL.md")).toBe(true);
    expect(files.has(".agents/skills/trellis-check/SKILL.md")).toBe(true);
    expect(files.has(".pi/prompts/trellis-start.md")).toBe(true);
    expect(
      [...files.keys()].some((name) => name.startsWith(".pi/agents/")),
    ).toBe(false);
  });

  it("preserves the session identity bridge and explicit shell assignments", () => {
    const { ctx } = project("A");
    const hook = handlers().get("tool_call");
    const event = {
      toolName: "bash",
      input: { command: "python3 .trellis/scripts/task.py current" },
    };
    hook?.(event, ctx);
    expect(event.input.command).toContain(
      "export TRELLIS_CONTEXT_ID='pi_session';",
    );
    const explicit = {
      toolName: "bash",
      input: { command: "TRELLIS_CONTEXT_ID=other python3 task.py current" },
    };
    hook?.(explicit, ctx);
    expect(explicit.input.command).toBe(
      "TRELLIS_CONTEXT_ID=other python3 task.py current",
    );
  });

  it("delivers state changes through messages while keeping the system prefix stable", () => {
    const { ctx, setStatus } = project("A");
    const hook = handlers().get("before_agent_start");
    const first = hook?.({ systemPrompt: "base" }, ctx);
    expect(first?.message?.content).toContain("A:planning");
    expect(hook?.({ systemPrompt: "base" }, ctx)?.message).toBeUndefined();
    setStatus("in_progress");
    const changed = hook?.({ systemPrompt: "base" }, ctx);
    expect(changed?.systemPrompt).toBe(first?.systemPrompt);
    expect(changed?.message?.content).toContain("A:in_progress");
  });

  it("reasserts the current project's state after switching A to B to A", () => {
    const a = project("A");
    const b = project("B");
    const hook = handlers().get("before_agent_start");
    expect(hook?.({}, a.ctx)?.message?.content).toContain("A:planning");
    expect(hook?.({}, b.ctx)?.message?.content).toContain("B:planning");
    expect(hook?.({}, a.ctx)?.message?.content).toContain("A:planning");
  });
});
