/** Stage 8: real Git/Python workflow across checkout and external data roots. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { uninstall } from "../../src/commands/uninstall.js";
import { getConfiguredPlatforms } from "../../src/configurators/index.js";
import { buildFilter } from "../../src/commands/mem.js";
import {
  projectKey,
  currentProjectKey,
} from "../../src/commands/channel/store/paths.js";
import {
  resolveWorkflowDir,
  runtimeDirOf,
} from "../../src/utils/external-store.js";
import { VERSION } from "../../src/constants/version.js";

vi.mock("figlet", () => ({ default: { textSync: vi.fn(() => "TRELLIS") } }));
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TRELLIS_CONTEXT_ID: "external-e2e" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

describe.skipIf(process.platform === "win32")(
  "external workflow integration",
  () => {
    let base: string;
    let code: string;
    let storage: string;
    let project: string;
    let previousCwd: string;

    beforeEach(() => {
      previousCwd = process.cwd();
      base = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "trellis-workflow-"),
      );
      code = path.join(base, "中文 code");
      storage = path.join(base, "外部 store");
      project = path.join(storage, "演示 项目");
      fs.mkdirSync(code);
      run(code, "git", ["init", "-q", "-b", "main"]);
      run(code, "git", ["config", "user.name", "Test"]);
      run(code, "git", ["config", "user.email", "test@example.com"]);
      run(code, "git", ["config", "core.excludesFile", "/dev/null"]);
      run(code, "git", [
        "commit",
        "--allow-empty",
        "-qm",
        "real code evidence",
      ]);
      process.chdir(code);
      vi.spyOn(console, "log").mockImplementation(noop);
      vi.spyOn(console, "error").mockImplementation(noop);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ version: VERSION }),
        }),
      );
    });

    afterEach(() => {
      process.chdir(previousCwd);
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      fs.rmSync(base, { recursive: true, force: true });
    });

    function py(cwd: string, script: string, ...args: string[]): string {
      return run(cwd, "python3", [
        path.join(project, "scripts", script),
        ...args,
      ]);
    }

    function createTask(cwd: string, slug: string): string {
      py(
        cwd,
        "task.py",
        "create",
        slug,
        "--slug",
        slug,
        "--description",
        "Verify external workflow acceptance",
      );
      const name = fs
        .readdirSync(path.join(project, "tasks"))
        .find((name) => name.endsWith(slug));
      expect(name).toBeDefined();
      const task = name ?? "missing";
      fs.writeFileSync(
        path.join(project, "tasks", task, "prd.md"),
        "# Acceptance\nVerify config-driven execution, code evidence, archive and journal commits.\n",
      );
      py(cwd, "task.py", "start", task);
      return task;
    }

    it("resolves a home-relative locator consistently in Node and Python", async () => {
      const homeStore = fs.mkdtempSync(
        path.join(os.homedir(), ".trellis-tilde-test-"),
      );
      try {
        const storageRef = `~/${path.basename(homeStore)}`;
        await init({
          storage: storageRef,
          project: "tilde",
          pi: true,
          yes: true,
        });
        fs.writeFileSync(
          path.join(code, ".treills.conf.json"),
          JSON.stringify({ storage: storageRef, project: "tilde" }),
        );
        fs.unlinkSync(path.join(code, ".trellis"));
        const data = path.join(fs.realpathSync(homeStore), "tilde");
        expect(resolveWorkflowDir(code)).toBe(data);
        const resolved = run(code, "python3", [
          "-c",
          "import sys; sys.path.insert(0, sys.argv[1]); from common.paths import workflow_dir; print(workflow_dir())",
          path.join(data, "scripts"),
        ]);
        expect(resolved).toBe(data);
      } finally {
        fs.rmSync(homeStore, { recursive: true, force: true });
      }
    });

    it("finishes a fresh init without a manual storage baseline commit or browse link", async () => {
      await init({ storage, project: "演示 项目", pi: true, yes: true });
      run(storage, "git", ["config", "user.name", "Test"]);
      run(storage, "git", ["config", "user.email", "test@example.com"]);
      run(storage, "git", ["config", "core.excludesFile", "/dev/null"]);
      fs.unlinkSync(path.join(code, ".trellis"));
      const task = createTask(code, "workflow-probe");
      fs.mkdirSync(path.join(code, "src"));
      expect(py(path.join(code, "src"), "get_context.py")).toContain(task);
      const prompt = fs.readFileSync(
        path.join(code, ".pi/prompts/trellis-continue.md"),
        "utf8",
      );
      const continuation = prompt
        .split("\n")
        .find((line) => /^python3 .*--mode phase$/.test(line));
      expect(continuation).toBeDefined();
      expect(run(code, "sh", ["-c", continuation ?? "exit 1"])).toContain(
        "Phase",
      );
      fs.writeFileSync(
        path.join(project, "spec", "probe.md"),
        "This task's explicit spec edit.\n",
      );
      const oid = run(code, "git", ["rev-parse", "HEAD"]);
      py(
        code,
        "task.py",
        "archive",
        task,
        "--no-commit",
        "--skip-branch-validation",
      );
      const args = [
        "--idempotency-key",
        "workflow-acceptance",
        "--title",
        "workflow acceptance",
        "--commit",
        oid,
        "--require-commit",
        "--include-path",
        ".trellis/spec/probe.md",
      ];
      py(code, "add_session.py", ...args);
      const head = run(storage, "git", ["rev-parse", "HEAD"]);
      py(code, "add_session.py", ...args);
      expect(run(storage, "git", ["rev-parse", "HEAD"])).toBe(head);
      const journal = fs.readFileSync(
        path.join(project, "workspace/journal-1.md"),
        "utf8",
      );
      expect(journal).toContain("real code evidence");
      expect(
        fs.readFileSync(path.join(project, "workspace/index.md"), "utf8"),
      ).toContain("**Total Sessions**: 1");
      expect(
        fs.existsSync(path.join(project, ".runtime/pending-task-commit.json")),
      ).toBe(false);
      const changes = run(storage, "git", [
        "-c",
        "core.quotePath=false",
        "log",
        "--format=",
        "--name-only",
      ]);
      expect(changes).toContain("演示 项目/spec/probe.md");
      expect(changes).toContain("/archive/");
      expect(run(code, "git", ["rev-list", "--count", "HEAD"])).toBe("1");
      await init({ pi: true, yes: true });
      expect(fs.realpathSync(path.join(code, ".trellis"))).toBe(project);
      expect(
        fs.readFileSync(path.join(project, "workspace/journal-1.md"), "utf8"),
      ).toBe(journal);
    });

    it("isolates task sessions and platform updates/removal across worktrees, keeping mem/channel code cwd", async () => {
      await init({ storage, project: "演示 项目", pi: true, yes: true });
      fs.unlinkSync(path.join(code, ".trellis"));
      const mainTask = createTask(code, "main-probe");
      const other = path.join(base, "feature code");
      run(code, "git", ["worktree", "add", "-qb", "feature", other]);
      process.chdir(other);
      await init({ storage, project: "演示 项目", codex: true, yes: true });
      fs.unlinkSync(path.join(other, ".trellis"));
      const otherTask = createTask(other, "feature-probe");
      expect(py(code, "task.py", "current")).toContain(mainTask);
      expect(py(other, "task.py", "current")).toContain(otherTask);
      expect([...getConfiguredPlatforms(code)]).toEqual(["pi"]);
      expect([...getConfiguredPlatforms(other)]).toEqual(["codex"]);
      const piFile = path.join(code, ".pi/extensions/trellis/index.ts");
      const codexFile = path.join(other, ".codex/hooks/session-start.py");
      fs.appendFileSync(piFile, "\n// main user edit\n");
      fs.appendFileSync(codexFile, "\n# feature user edit\n");
      const piBytes = fs.readFileSync(piFile, "utf8");
      const codexBytes = fs.readFileSync(codexFile, "utf8");
      await update({ skipAll: true });
      expect(fs.existsSync(path.join(other, ".trellis"))).toBe(false);
      const backups = path.join(runtimeDirOf(other), "backups");
      const backup = path.join(
        backups,
        fs.readdirSync(backups)[0] ?? "missing",
      );
      expect(
        fs.readFileSync(
          path.join(backup, ".codex/hooks/session-start.py"),
          "utf8",
        ),
      ).toBe(codexBytes);
      expect(fs.existsSync(path.join(backup, ".trellis/workflow.md"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(backup, ".trellis/.runtime"))).toBe(false);
      expect(fs.readFileSync(piFile, "utf8")).toBe(piBytes);
      expect(fs.readFileSync(codexFile, "utf8")).toBe(codexBytes);
      expect(buildFilter({}).cwd).toBe(other);
      expect(currentProjectKey()).toBe(projectKey(other));
      expect(currentProjectKey()).not.toBe(projectKey(project));
      await uninstall({ yes: true });
      expect(fs.readFileSync(piFile, "utf8")).toBe(piBytes);
      expect(fs.existsSync(path.join(code, ".treills.conf.json"))).toBe(true);
      expect([...getConfiguredPlatforms(code)]).toEqual(["pi"]);
      expect(py(code, "task.py", "current")).toContain(mainTask);
    });
  },
);
