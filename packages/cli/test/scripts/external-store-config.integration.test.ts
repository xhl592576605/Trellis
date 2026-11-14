/**
 * External storage mode: a root config (`.treills.conf.json`) at the code
 * root is the single runtime source of truth; the in-project `.trellis`
 * browse link is optional and never required for execution.
 *
 * These tests run task.py from the *external* scripts location with cwd on
 * the real code checkout — exactly what context injection must produce in
 * external mode.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { checkoutKey } from "../../src/utils/external-store.js";
import { replacePythonCommandLiterals } from "../../src/configurators/shared.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);

const TASK = "11-14-demo";
const PROJECT = "demo-project";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  base: string;
  storage: string;
  projectDir: string;
  repo: string;
}

function writeBinding(fx: Fixture, codeRoot: string) {
  const gitCommon = spawnSync(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: codeRoot, encoding: "utf-8" },
  );
  fs.writeFileSync(
    path.join(fx.projectDir, "project.json"),
    JSON.stringify(
      {
        name: PROJECT,
        codeRoot,
        gitCommonDir: path.resolve(codeRoot, gitCommon.stdout.trim()),
      },
      null,
      2,
    ) + "\n",
  );
}

function runExternal(
  fx: Fixture,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(fx.projectDir, "scripts", "task.py"), ...args],
    {
      cwd: fx.repo,
      encoding: "utf-8",
      env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!hasPython() || process.platform === "win32")(
  "external storage via root config (.treills.conf.json)",
  () => {
    let base: string;
    let storage: string;
    let projectDir: string;
    let repo: string;

    beforeEach(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ext-"));
      storage = path.join(base, "storage");
      projectDir = path.join(storage, PROJECT);
      repo = path.join(base, "repo");

      fs.mkdirSync(path.join(projectDir, "tasks", TASK), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "tasks", TASK, "task.json"),
        JSON.stringify({
          id: TASK,
          name: TASK,
          title: TASK,
          status: "in_progress",
          meta: {},
          children: [],
        }) + "\n",
      );
      fs.cpSync(TEMPLATE_SCRIPTS, path.join(projectDir, "scripts"), {
        recursive: true,
      });

      fs.mkdirSync(repo, { recursive: true });
      spawnSync("git", ["init", "-q", repo], { encoding: "utf-8" });

      fs.writeFileSync(
        path.join(repo, ".treills.conf.json"),
        JSON.stringify({ storage, project: PROJECT }) + "\n",
      );
      writeBinding({ base, storage, projectDir, repo }, repo);
      fs.copyFileSync(path.join(TEMPLATE_SCRIPTS, "../workflow.md"), path.join(projectDir, "workflow.md"));
    });

    afterEach(() => {
      fs.rmSync(base, { recursive: true, force: true });
    });

    it("task.py start works with no in-project .trellis at all", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const r = runExternal(fx, "start", TASK);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`Current task set to: .trellis/tasks/${TASK}`);

      // Session runtime state lives under the EXTERNAL project dir.
      const sessionFile = path.join(
        projectDir,
        ".runtime",
        "checkouts",
        checkoutKey(repo),
        "sessions",
        "test-ctx.json",
      );
      expect(fs.existsSync(sessionFile)).toBe(true);
      // And nothing created an in-project .trellis.
      expect(fs.existsSync(path.join(repo, ".trellis"))).toBe(false);
    });

    it("task.py current resolves the task from a subdirectory of the repo", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const r0 = runExternal(fx, "start", TASK);
      expect(r0.status).toBe(0);

      const sub = path.join(repo, "packages", "app");
      fs.mkdirSync(sub, { recursive: true });
      const r = spawnSync(
        "python3",
        [path.join(projectDir, "scripts", "task.py"), "current"],
        {
          cwd: sub,
          encoding: "utf-8",
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(TASK);
    });

    it("still refuses `..` traversal in external mode", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);
      const r = runExternal(fx, "set-meta", "../escape", "pwned", "yes");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("refusing to use");
    });

    it("refuses a same-named project from a different repo", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const other = path.join(base, "other-repo");
      fs.mkdirSync(other, { recursive: true });
      spawnSync("git", ["init", "-q", other], { encoding: "utf-8" });
      fs.writeFileSync(
        path.join(other, ".treills.conf.json"),
        JSON.stringify({ storage, project: PROJECT }) + "\n",
      );

      const r = spawnSync(
        "python3",
        [path.join(projectDir, "scripts", "task.py"), "current"],
        {
          cwd: other,
          encoding: "utf-8",
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("different");
    });

    it("fails clearly when the config points at a missing project dir", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);
      // Point the config at a project that does not exist in storage; the
      // scripts still run from the real project dir, as injection would.
      fs.writeFileSync(
        path.join(repo, ".treills.conf.json"),
        JSON.stringify({ storage, project: "nope" }) + "\n",
      );

      const r = runExternal(fx, "current");
      expect(r.status).not.toBe(0);
      expect(r.stderr + r.stdout).toContain("external project dir");
    });

    it("task.py create works with no developer registration", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const r = runExternal(
        fx,
        "create",
        "External demo",
        "--slug",
        "ext-demo",
        "--description",
        "demo task for external mode",
      );
      expect(r.status).toBe(0);

      const created = fs
        .readdirSync(path.join(projectDir, "tasks"))
        .find((d) => d.endsWith("-ext-demo"));
      expect(created).toBeTruthy();
      const taskJson = JSON.parse(
        fs.readFileSync(
          path.join(projectDir, "tasks", created as string, "task.json"),
          "utf-8",
        ),
      );
      // System-user fallback identity — no init_developer required (D6).
      expect(taskJson.assignee).toBeTruthy();
      expect(taskJson.creator).toBeTruthy();
    });

    it("add_session journals into the flat workspace without a developer", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const r = spawnSync(
        "python3",
        [
          path.join(projectDir, "scripts", "add_session.py"),
          "--title",
          "planning session",
          "--no-commit",
        ],
        {
          cwd: repo,
          encoding: "utf-8",
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(r.status).toBe(0);

      // Flat single-user workspace: journal directly under workspace/.
      const journal = path.join(projectDir, "workspace", "journal-1.md");
      expect(fs.existsSync(journal)).toBe(true);
      const index = fs.readFileSync(
        path.join(projectDir, "workspace", "index.md"),
        "utf-8",
      );
      expect(index).toContain("planning session");
      // No developer subdirectory was created.
      expect(
        fs.existsSync(path.join(projectDir, "workspace", "tester")),
      ).toBe(false);
    });

    it("reads phase, task materials and record context without a browse link", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      expect(runExternal(fx, "start", TASK).status).toBe(0);
      const spec = path.join(projectDir, "spec/guides/index.md");
      fs.mkdirSync(path.dirname(spec), { recursive: true });
      fs.writeFileSync(spec, "# External guide\n");
      expect(runExternal(fx, "add-context", TASK, "implement", ".trellis/spec/guides/index.md").status).toBe(0);
      const script = path.join(projectDir, "scripts/get_context.py");
      const opts = { cwd: repo, encoding: "utf8" as const, env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" } };
      const phase = spawnSync("python3", [script, "--mode", "phase"], opts);
      expect(phase.status, phase.stderr).toBe(0);
      expect(phase.stdout).toContain("Phase Index");
      const record = spawnSync("python3", [script, "--mode", "record", "--json"], opts);
      expect(record.status, record.stderr).toBe(0);
      expect(JSON.parse(record.stdout).currentTask.name).toBe(TASK);
      expect(fs.existsSync(path.join(repo, ".trellis"))).toBe(false);
    });

    it("isolates one session key across two checkouts of the same repository", () => {
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=t@example.com", "commit", "--allow-empty", "-qm", "initial"], { cwd: repo });
      const other = path.join(base, "worktree");
      execFileSync("git", ["worktree", "add", "-qb", "feature", other], { cwd: repo });
      fs.copyFileSync(path.join(repo, ".treills.conf.json"), path.join(other, ".treills.conf.json"));
      const fx: Fixture = { base, storage, projectDir, repo };
      const second = "second-task";
      fs.mkdirSync(path.join(projectDir, "tasks", second));
      fs.writeFileSync(path.join(projectDir, "tasks", second, "task.json"), JSON.stringify({ id: second, name: second, status: "in_progress", meta: {} }));
      expect(runExternal(fx, "start", TASK).status).toBe(0);
      expect(runExternal({ ...fx, repo: other }, "start", second).status).toBe(0);
      expect(runExternal(fx, "current").stdout).toContain(TASK);
      expect(runExternal({ ...fx, repo: other }, "current").stdout).toContain(second);
    });

    it("preserves both journal records and their numbering under concurrent writers", async () => {
      const ready = path.join(base, "ready");
      fs.mkdirSync(ready);
      const script = [
        "import sys,time", "from pathlib import Path", "sys.path.insert(0,sys.argv[1])", "import add_session as m",
        "ready=Path(sys.argv[2]); title=sys.argv[3]", "(ready/title).touch()", "deadline=time.monotonic()+5",
        "while len(list(ready.iterdir()))<2 and time.monotonic()<deadline: time.sleep(0.01)", "original=m.write_text_atomic",
        "def delayed(path,content):", "    if path.name.startswith('journal-'): time.sleep(0.4)", "    return original(path,content)",
        "m.write_text_atomic=delayed", "sys.exit(m.add_session(title,auto_commit=False))",
      ].join("\n");
      const worker = (title: string): Promise<{ status: number | null; stderr: string }> => new Promise((resolve, reject) => {
        const child = spawn("python3", ["-c", script, path.join(projectDir, "scripts"), ready, title], {
          cwd: repo, env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        });
        let stderr = "";
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
      });
      for (const result of await Promise.all([worker("parallel-A"), worker("parallel-B")])) {
        expect(result.status, result.stderr).toBe(0);
      }
      const journal = fs.readFileSync(path.join(projectDir, "workspace/journal-1.md"), "utf8");
      const index = fs.readFileSync(path.join(projectDir, "workspace/index.md"), "utf8");
      expect(journal).toContain("parallel-A");
      expect(journal).toContain("parallel-B");
      expect(journal).toContain("Session 1:");
      expect(journal).toContain("Session 2:");
      expect(index).toContain("**Total Sessions**: 2");
    });

    function installedHook(name: string): string {
      const target = path.join(base, name);
      fs.writeFileSync(target, replacePythonCommandLiterals(fs.readFileSync(
        path.join(__dirname, "../../src/templates/shared-hooks", name), "utf8")));
      return target;
    }

    it("workflow-state hook resolves the active task without a browse link", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);

      const r0 = runExternal(fx, "start", TASK);
      expect(r0.status).toBe(0);

      const hook = spawnSync(
        "python3",
        [
          installedHook("inject-workflow-state.py"),
        ],
        {
          cwd: repo,
          encoding: "utf-8",
          input: JSON.stringify({ cwd: repo, prompt: "continue", session_id: "s1" }),
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(hook.status).toBe(0);
      expect(hook.stdout).toContain("<workflow-state>");
      expect(hook.stdout).toContain(TASK);
    });

    it("session-start hook emits context from the external store", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);
      // Minimal spec tree so the spec index collection has something to walk.
      fs.mkdirSync(path.join(projectDir, "spec"), { recursive: true });

      const r0 = runExternal(fx, "start", TASK);
      expect(r0.status).toBe(0);

      const hook = spawnSync(
        "python3",
        [
          installedHook("session-start.py"),
        ],
        {
          cwd: repo,
          encoding: "utf-8",
          input: JSON.stringify({ cwd: repo, session_id: "s2" }),
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(hook.status).toBe(0);
      expect(hook.stdout).toContain("SessionStart context");
      expect(hook.stdout).toContain(TASK);
    });

    it("get_context.py runs and shows the flat workspace", () => {
      const fx: Fixture = { base, storage, projectDir, repo };
      writeBinding(fx, repo);
      fs.mkdirSync(path.join(projectDir, "workspace"), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, "workspace", "journal-1.md"),
        "# Journal\n",
      );

      const r = spawnSync(
        "python3",
        [path.join(projectDir, "scripts", "get_context.py")],
        {
          cwd: repo,
          encoding: "utf-8",
          env: { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" },
        },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(path.join(fs.realpathSync(projectDir), "workspace", "journal-1.md"));
      expect(r.stdout).not.toContain("init_developer");
    });
  },
);
