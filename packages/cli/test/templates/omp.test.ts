import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { getExtensionTemplate } from "../../src/templates/omp/index.js";
import { collectOmpTemplates } from "../../src/configurators/omp.js";

type OmpEventHandler = (event: unknown, ctx?: unknown) => unknown;
type OmpExtension = (pi: {
  on: (event: string, handler: OmpEventHandler) => void;
  sendMessage?: (message: unknown) => Promise<void>;
}) => void;

function loadOmpExtension(): OmpExtension {
  const compiled = ts.transpileModule(getExtensionTemplate(), {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const require = createRequire(import.meta.url);
  const moduleObject: { exports: { default?: OmpExtension } } = { exports: {} };
  const sandboxProcess = Object.create(process) as NodeJS.Process;
  const sandboxEnv = { ...process.env };
  delete sandboxEnv.TRELLIS_CONTEXT_ID;
  Object.defineProperty(sandboxProcess, "env", { value: sandboxEnv });
  const sandbox = vm.createContext({
    Buffer,
    console,
    exports: moduleObject.exports,
    module: moduleObject,
    process: sandboxProcess,
    require,
  });
  vm.runInContext(compiled, sandbox);
  const extension = moduleObject.exports.default;
  if (!extension)
    throw new Error("OMP extension template has no default export");
  return extension;
}

function captureOmpHandlers(): Map<string, OmpEventHandler> {
  const handlers = new Map<string, OmpEventHandler>();
  loadOmpExtension()({
    on: (event, handler) => handlers.set(event, handler),
  });
  return handlers;
}

function makeOmpProject(): {
  root: string;
  taskDir: string;
  sessionId: string;
} {
  const root = fs.mkdtempSync(
    path.join(process.env.TMPDIR ?? "/tmp", "trellis-omp-"),
  );
  const taskDir = path.join(root, ".trellis", "tasks", "08-13-context-limits");
  const sessionId = "context_limits";
  fs.mkdirSync(path.join(root, ".trellis", ".runtime", "sessions"), {
    recursive: true,
  });
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({ status: "in_progress", title: "Context limits" }),
  );
  fs.writeFileSync(
    path.join(
      root,
      ".trellis",
      ".runtime",
      "sessions",
      "omp_context_limits.json",
    ),
    JSON.stringify({ current_task: ".trellis/tasks/08-13-context-limits" }),
  );
  return { root, taskDir, sessionId };
}

async function runSessionStart(
  root: string,
  sessionId: string,
): Promise<string> {
  const messages: { customType?: string; content?: string }[] = [];
  const handlers = new Map<string, OmpEventHandler>();
  loadOmpExtension()({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: async (message: { customType?: string; content?: string }) => {
      messages.push(message);
    },
  } as never);
  const handler = handlers.get("session_start");
  if (!handler) throw new Error("OMP extension did not register session_start");
  await handler(
    {},
    {
      cwd: root,
      sessionManager: { getSessionId: () => sessionId },
      ui: { notify: () => undefined },
    },
  );
  return (
    messages.find((message) => message.customType === "trellis-task-context")
      ?.content ?? ""
  );
}

describe("OMP current-agent integration", () => {
  it("keeps commands, skills and the main-session extension", () => {
    const files = collectOmpTemplates();
    expect(files.has(".omp/commands/trellis-continue.md")).toBe(true);
    expect(files.has(".omp/skills/trellis-before-dev/SKILL.md")).toBe(true);
    expect(
      [...files.keys()].some((name) => name.startsWith(".omp/agents/")),
    ).toBe(false);
  });

  it("injects native session identity into shell params without changing explicit overrides", async () => {
    const handler = captureOmpHandlers().get("tool_call");
    const event = {
      toolName: "bash",
      input: { command: "pwd", env: {} as Record<string, string> },
    };
    const ctx = { sessionManager: { getSessionId: () => "session" } };
    await handler?.(event, ctx);
    expect(event.input.env.TRELLIS_CONTEXT_ID).toBe("omp_session");
    event.input.env.TRELLIS_CONTEXT_ID = "explicit";
    await handler?.(event, ctx);
    expect(event.input.env.TRELLIS_CONTEXT_ID).toBe("explicit");
  });

  it("loads planning artifacts directly without legacy manifest references", async () => {
    const { root, taskDir, sessionId } = makeOmpProject();
    try {
      for (const name of ["prd.md", "design.md", "implement.md"])
        fs.writeFileSync(path.join(taskDir, name), name + " contents");
      fs.writeFileSync(
        path.join(root, "secret.md"),
        "legacy-reference-must-not-load",
      );
      fs.writeFileSync(
        path.join(taskDir, "implement.jsonl"),
        JSON.stringify({ file: "secret.md" }),
      );
      const content = await runSessionStart(root, sessionId);
      expect(content).toContain("prd.md contents");
      expect(content).toContain("design.md contents");
      expect(content).toContain("implement.md contents");
      expect(content).not.toContain("legacy-reference-must-not-load");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds task artifact context without splitting UTF-8 characters", async () => {
    const { root, taskDir, sessionId } = makeOmpProject();
    try {
      fs.writeFileSync(
        path.join(root, ".trellis/config.yaml"),
        "context_injection:\n  max_artifact_bytes: 97\n  max_total_bytes: 600\n",
      );
      fs.writeFileSync(path.join(taskDir, "prd.md"), "中文".repeat(200));
      const content = await runSessionStart(root, sessionId);
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(600);
      expect(content).not.toContain("\uFFFD");
      expect(content).toMatch(/truncated|omitted/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
