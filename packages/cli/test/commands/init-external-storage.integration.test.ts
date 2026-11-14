/**
 * Integration tests for `trellis init --storage` (external storage mode).
 *
 * Covers PRD AC1/AC2/AC12/AC14 for the init path: default/custom storage
 * root becomes an independent local Git repository, project data lands under
 * `<storage>/<project>`, the code root gets the `.treills.conf.json` locator
 * and a browse-only `.trellis` link, no developer registration is required,
 * and no joiner onboarding task is generated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "TRELLIS") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
}));

import { execFileSync, spawnSync } from "node:child_process";
import { loadHashes, computeHash } from "../../src/utils/template-hash.js";
import { getConfiguredPlatforms } from "../../src/configurators/index.js";
import { update } from "../../src/commands/update.js";
import { VERSION } from "../../src/constants/version.js";
import { init } from "../../src/commands/init.js";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};
const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("init --storage (external storage mode)", () => {
  let tmpDir: string;
  let storeBase: string;
  let storageDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ext-init-"));
    // The store must live OUTSIDE the code checkout — a store inside a git
    // repository is refused by design (nested repo misconfiguration).
    storeBase = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ext-store-"));
    storageDir = path.join(storeBase, "store");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(storeBase, { recursive: true, force: true });
  });

  it("creates the external store, locator config, and browse link", async () => {
    gitInit(tmpDir);
    await init({ storage: storageDir, claude: true, yes: true });

    const project = path.basename(tmpDir);
    const projectDir = path.join(storageDir, project);

    // External store is its own git repo, not nested in the code checkout.
    expect(fs.existsSync(path.join(storageDir, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "project.json"))).toBe(true);

    // Workflow data lives in the external project dir.
    for (const entry of [
      "scripts",
      "workflow.md",
      "config.yaml",
      "tasks",
      "spec",
      "workspace",
      "agents",
    ]) {
      expect(fs.existsSync(path.join(projectDir, entry))).toBe(true);
    }

    // Journal merge rule applies to the storage repo, not the code root.
    expect(fs.readFileSync(path.join(storageDir, ".gitattributes"), "utf-8")).toContain(
      "*/workspace/journal-*.md merge=union",
    );
    expect(fs.existsSync(path.join(tmpDir, ".gitattributes"))).toBe(false);

    // Code root: locator config + browse link, no real .trellis directory.
    const conf = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".treills.conf.json"), "utf-8"),
    ) as { storage: string; project: string };
    expect(conf.project).toBe(project);
    expect(fs.realpathSync(conf.storage)).toBe(fs.realpathSync(storageDir));
    expect(fs.lstatSync(path.join(tmpDir, ".trellis")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(tmpDir, ".trellis"))).toBe(
      fs.realpathSync(projectDir),
    );

    // Platform wiring stays in the checkout.
    expect(fs.existsSync(path.join(tmpDir, ".claude"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "AGENTS.md"))).toBe(true);
  });

  it("renders bootstrap document targets and commands without requiring a browse link", async () => {
    await init({ storage: storageDir, project: "中文 bootstrap", pi: true, yes: true });
    const projectDir = fs.realpathSync(path.join(storageDir, "中文 bootstrap"));
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    const prdPath = path.join(projectDir, "tasks/00-bootstrap-guidelines/prd.md");
    const prd = fs.readFileSync(prdPath, "utf8");
    expect(prd).not.toContain(".trellis/");
    for (const ref of prd.matchAll(/`([^`]+)`/g)) {
      const target = ref[1];
      if (target.startsWith(`${projectDir}/spec/`)) {
        expect(fs.existsSync(target), target).toBe(true);
      }
    }
    expect(prd).toContain(`\`${projectDir}/spec/backend/directory-structure.md\``);
    expect(prd).toContain(`\`${projectDir}/spec/frontend/component-guidelines.md\``);
    expect(prd).toContain(`\`${projectDir}/spec/guides/\``);
    const finish = prd.split("\n").find((line) => /^python3 .*task\.py.* finish$/.test(line));
    expect(finish).toBeDefined();
    const result = spawnSync("sh", ["-c", finish ?? "exit 1"], { cwd: tmpDir, encoding: "utf8", env: { ...process.env, TRELLIS_CONTEXT_ID: "bootstrap-prd" } });
    expect(result.status, result.stderr).toBe(0);
    fs.appendFileSync(prdPath, "\nUser bootstrap notes\n");
    await init({ pi: true, yes: true });
    expect(fs.readFileSync(prdPath, "utf8")).toBe(prd + "\nUser bootstrap notes\n");
  });

  it("renders monorepo bootstrap sections against the external spec root", async () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    for (const name of ["web", "api"]) {
      const dir = path.join(tmpDir, "packages", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@demo/${name}` }));
      fs.writeFileSync(path.join(dir, name === "web" ? "vite.config.ts" : "go.mod"), "");
    }
    await init({ storage: storageDir, project: "monorepo", pi: true, yes: true });
    const root = fs.realpathSync(path.join(storageDir, "monorepo"));
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    const prd = fs.readFileSync(path.join(root, "tasks/00-bootstrap-guidelines/prd.md"), "utf8");
    expect(prd).not.toContain(".trellis/");
    for (const name of ["web", "api"]) {
      expect(prd).toContain(`\`${root}/spec/${name}/\``);
    }
    for (const ref of prd.matchAll(/`([^`]+)`/g)) {
      if (ref[1].startsWith(`${root}/spec/`)) expect(fs.existsSync(ref[1]), ref[1]).toBe(true);
    }
  });

  it("requires no developer registration and creates no joiner task", async () => {
    await init({ storage: storageDir, yes: true });

    const projectDir = path.join(storageDir, path.basename(tmpDir));
    const tasks = fs.readdirSync(path.join(projectDir, "tasks"));
    // Bootstrap spec task only — no joiner-<developer> onboarding (AC14).
    expect(tasks).toContain("00-bootstrap-guidelines");
    expect(tasks.some((t) => t.startsWith("joiner-"))).toBe(false);
    // No .developer anywhere: not in the checkout, not in the store.
    expect(fs.existsSync(path.join(projectDir, ".developer"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".developer"))).toBe(false);
    // Flat single-user workspace: no developer subdirectory.
    expect(
      fs.existsSync(path.join(projectDir, "workspace", os.userInfo().username)),
    ).toBe(false);
  });

  it("re-init over the same store is idempotent and keeps the binding", async () => {
    await init({ storage: storageDir, yes: true });
    const projectDir = path.join(storageDir, path.basename(tmpDir));
    const bindingBefore = fs.readFileSync(
      path.join(projectDir, "project.json"),
      "utf-8",
    );

    await init({ storage: storageDir, yes: true });

    const bindingAfter = fs.readFileSync(
      path.join(projectDir, "project.json"),
      "utf-8",
    );
    expect(bindingAfter).toBe(bindingBefore);
    // Still exactly one project dir in the store.
    expect(fs.readdirSync(storageDir).filter((e) => !e.startsWith("."))).toEqual([
      path.basename(tmpDir),
    ]);
  });

  it("resumes init after a platform write fails without requiring developer onboarding", async () => {
    fs.writeFileSync(path.join(tmpDir, ".pi"), "occupied");
    await expect(init({ storage: storageDir, pi: true, yes: true })).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, ".treills.conf.json"))).toBe(true);
    const projectDir = path.join(storageDir, path.basename(tmpDir));
    fs.writeFileSync(path.join(projectDir, "spec", "preserved.md"), "user data from interrupted init");
    fs.unlinkSync(path.join(tmpDir, ".pi"));
    await init({ pi: true, yes: true });
    expect([...getConfiguredPlatforms(tmpDir)]).toEqual(["pi"]);
    expect(fs.readFileSync(path.join(projectDir, "spec", "preserved.md"), "utf8")).toBe("user data from interrupted init");
    expect(fs.readdirSync(path.join(projectDir, "tasks")).some((name) => name.startsWith("joiner-"))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, ".developer"))).toBe(false);
  });

  it("uses ~/.trellis-wiki by default without developer onboarding", async () => {
    const home = path.join(storeBase, "home");
    fs.mkdirSync(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    await init({ pi: true, yes: true });
    const conf = JSON.parse(fs.readFileSync(path.join(tmpDir, ".treills.conf.json"), "utf8"));
    expect(conf.storage).toBe(fs.realpathSync(path.join(home, ".trellis-wiki")));
    expect(fs.existsSync(path.join(conf.storage, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(conf.storage, conf.project, ".developer"))).toBe(false);
  });

  it("records the first journal after init, without a browse link, and retries idempotently", async () => {
    await init({ storage: storageDir, pi: true, yes: true });
    const project = path.join(storageDir, path.basename(tmpDir));
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    const args = [path.join(project, "scripts/add_session.py"), "--title", "first journal", "--no-commit"];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync("python3", args, { cwd: tmpDir, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const index = fs.readFileSync(path.join(project, "workspace/index.md"), "utf8");
    expect(index).toContain("**Total Sessions**: 1");
    expect(fs.readFileSync(path.join(project, "workspace/journal-1.md"), "utf8")).toContain("first journal");
  });

  it("reuses the locator and preserves the journal when init is repeated without --storage", async () => {
    await init({ storage: storageDir, yes: true });
    const locator = fs.readFileSync(path.join(tmpDir, ".treills.conf.json"), "utf8");
    const project = path.join(storageDir, path.basename(tmpDir));
    fs.appendFileSync(path.join(project, "workspace/index.md"), "\nUser notes\n");
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    await init({ pi: true, yes: true });
    expect(fs.readFileSync(path.join(tmpDir, ".treills.conf.json"), "utf8")).toBe(locator);
    expect(fs.lstatSync(path.join(tmpDir, ".trellis")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(tmpDir, ".trellis"))).toBe(fs.realpathSync(project));
    expect(fs.readFileSync(path.join(project, "workspace/index.md"), "utf8")).toContain("User notes");
    expect(fs.existsSync(path.join(project, ".developer"))).toBe(false);
  });

  it("keeps Pi/Codex manifests separate and preserves shared template modification evidence", async () => {
    gitInit(tmpDir);
    execFileSync("git", ["commit", "--allow-empty", "-qm", "initial"], { cwd: tmpDir });
    await init({ storage: storageDir, project: "shared", pi: true, yes: true });
    const firstHashes = loadHashes(tmpDir);
    expect(firstHashes[".trellis/scripts/get_context.py"]).toBe(computeHash(fs.readFileSync(path.join(storageDir, "shared/scripts/get_context.py"), "utf8")));
    expect(Object.keys(firstHashes).some((key) => key.startsWith(".runtime/") || key.includes("/.runtime/"))).toBe(false);
    const workflow = path.join(storageDir, "shared/workflow.md");
    fs.appendFileSync(workflow, "\nUser workflow notes\n");
    const other = path.join(storeBase, "worktree");
    execFileSync("git", ["worktree", "add", "-qb", "feature", other], { cwd: tmpDir });
    vi.spyOn(process, "cwd").mockReturnValue(other);
    await init({ storage: storageDir, project: "shared", codex: true, yes: true });
    expect([...getConfiguredPlatforms(tmpDir)]).toEqual(["pi"]);
    expect([...getConfiguredPlatforms(other)]).toEqual(["codex"]);
    expect(loadHashes(tmpDir)[".trellis/workflow.md"]).toBe(firstHashes[".trellis/workflow.md"]);
    expect(loadHashes(other)[".trellis/workflow.md"]).toBe(firstHashes[".trellis/workflow.md"]);
    expect(fs.readFileSync(workflow, "utf8")).toContain("User workflow notes");
    expect(loadHashes(tmpDir)).toHaveProperty(".treills.conf.json");
    expect(loadHashes(tmpDir)).toHaveProperty(".trellis");
    expect(loadHashes(other)).not.toHaveProperty(".pi/extensions/trellis/index.ts");
  });

  it("renders a directly executable continue command for paths with spaces and Chinese", async () => {
    await init({ storage: storageDir, project: "中文 工作流", pi: true, yes: true });
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    const prompt = fs.readFileSync(path.join(tmpDir, ".pi/prompts/trellis-continue.md"), "utf8");
    expect(prompt).not.toContain("./.trellis/scripts/");
    expect(prompt).toContain(".treills.conf.json");
    const command = prompt.split("\n").find((line) => /^python3 .*--mode phase$/.test(line));
    expect(command).toBeDefined();
    const result = spawnSync("sh", ["-c", command ?? "exit 1"], { cwd: tmpDir, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Phase Index");
  });

  it("recognizes an external installation during update without the browse link", async () => {
    await init({ storage: storageDir, claude: true, yes: true });
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: VERSION }) }));
    await update({ dryRun: true });
    const output = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(output).toContain("Trellis Update");
    expect(output).toContain("Project version:");
    expect(output).not.toContain("Trellis not initialized");
    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(false);
  });

  it("runs installed Python hooks without a browse link and renders structured host prompts", async () => {
    await init({ storage: storageDir, project: "protocol", claude: true, codex: true, copilot: true, snow: true, kiro: true, yes: true });
    const project = path.join(storageDir, "protocol");
    const taskDir = path.join(project, "tasks/protocol-task");
    fs.mkdirSync(taskDir);
    fs.writeFileSync(path.join(taskDir, "task.json"), JSON.stringify({ id: "protocol-task", name: "protocol-task", title: "Protocol task", status: "in_progress", meta: {}, children: [] }));
    fs.unlinkSync(path.join(tmpDir, ".trellis"));
    const env = { ...process.env, TRELLIS_CONTEXT_ID: "protocol-session" };
    const start = spawnSync("python3", [path.join(project, "scripts/task.py"), "start", "protocol-task"], { cwd: tmpDir, env, encoding: "utf8" });
    expect(start.status, start.stderr).toBe(0);
    for (const rel of [".claude/hooks/session-start.py", ".claude/hooks/inject-workflow-state.py", ".codex/hooks/session-start.py", ".github/copilot/hooks/session-start.py", ".snow/hooks/write-trellis-context.py"]) {
      const hook = spawnSync("python3", [path.join(tmpDir, rel)], { cwd: tmpDir, env, encoding: "utf8", input: JSON.stringify({ cwd: tmpDir, session_id: "protocol-session" }) });
      expect(hook.status, rel + hook.stderr).toBe(0);
      expect(hook.stdout, rel).toContain("protocol-task");
      expect(hook.stdout, rel).not.toContain("./.trellis/scripts/");
    }
    const snow = JSON.parse(fs.readFileSync(path.join(tmpDir, ".snow/commands/trellis-continue.json"), "utf8"));
    expect(snow.command).not.toContain("./.trellis/scripts/");
    const kiro = JSON.parse(fs.readFileSync(path.join(tmpDir, ".kiro/agents/trellis.json"), "utf8"));
    expect(kiro.prompt).not.toContain("./.trellis/scripts/");
    expect(kiro.resources[0]).not.toContain("file://.trellis/");
  });

  it("refuses a same-named project from a different repository", async () => {
    gitInit(tmpDir);
    await init({ storage: storageDir, yes: true });

    // A second, different code checkout using the same project name: its git
    // common dir differs from the recorded binding → must be refused.
    const otherRepo = path.join(storeBase, "other-checkout");
    fs.mkdirSync(otherRepo, { recursive: true });
    gitInit(otherRepo);
    vi.spyOn(process, "cwd").mockReturnValue(otherRepo);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    // basename(otherRepo) differs, so force the same project name. The
    // refusal path prints a diagnostic and exits(1) rather than throwing.
    await expect(
      init({ storage: storageDir, project: path.basename(tmpDir), yes: true }),
    ).rejects.toThrow();
    expect(errors.join("\n")).toMatch(/different project/);
  });
});
