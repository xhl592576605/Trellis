/**
 * Explicit storage migration (`trellis update --migrate-storage`), stage 6
 * of the external local storage design (§8): move a legacy in-repo
 * `.trellis` into the external store, verify the copy, then switch the
 * root config + browse link — never deleting the source before it is
 * provably redundant.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { update } from "../../src/commands/update.js";
import { crossesStorageMigration } from "../../src/migrations/index.js";
import { checkoutKey } from "../../src/utils/external-store.js";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "TRELLIS") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

const TEMPLATE_DIR = path.resolve(__dirname, "../../src/templates/trellis");
const PROJECT = "demo-app";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

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
  tmp: string;
  trellis: string;
  storage: string;
  projectDir: string;
  projectName: string;
}

function hashOf(rel: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(rel, "utf-8"), "utf-8")
    .digest("hex");
}

function stampLegacy(fx: Fixture, opts: { secondDev?: boolean } = {}): void {
  fs.cpSync(
    path.join(TEMPLATE_DIR, "scripts"),
    path.join(fx.trellis, "scripts"),
    {
      recursive: true,
    },
  );
  fs.copyFileSync(
    path.join(TEMPLATE_DIR, "workflow.md"),
    path.join(fx.trellis, "workflow.md"),
  );
  fs.writeFileSync(
    path.join(fx.trellis, "config.yaml"),
    "session_auto_commit: true\n",
  );

  const taskDir = path.join(fx.trellis, "tasks", "11-14-demo");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "task.json"),
    JSON.stringify({
      id: "11-14-demo",
      name: "11-14-demo",
      title: "demo",
      status: "in_progress",
      createdAt: "2026-11-14",
      assignee: "alice",
      creator: "alice",
      subtasks: [],
      children: [],
      relatedFiles: [],
      meta: {},
    }) + "\n",
  );
  fs.mkdirSync(path.join(fx.trellis, "spec", "guides"), { recursive: true });
  fs.writeFileSync(
    path.join(fx.trellis, "spec", "guides", "index.md"),
    "# Guides\n",
  );

  const dev = opts.secondDev ? undefined : "alice";
  const wsRoot = path.join(fx.trellis, "workspace");
  if (dev) {
    fs.writeFileSync(
      path.join(fx.trellis, ".developer"),
      `name=${dev}\ninitialized_at=2026-01-01T00:00:00\n`,
    );
    fs.mkdirSync(path.join(wsRoot, dev), { recursive: true });
    fs.writeFileSync(
      path.join(wsRoot, dev, "journal-1.md"),
      "# Journal\nSession 1: legacy\n",
    );
    fs.writeFileSync(path.join(wsRoot, dev, "index.md"), "# Index\n");
  } else {
    for (const d of ["alice", "bob"]) {
      fs.mkdirSync(path.join(wsRoot, d), { recursive: true });
      fs.writeFileSync(
        path.join(wsRoot, d, "journal-1.md"),
        `# Journal (${d})\n`,
      );
    }
  }

  fs.mkdirSync(path.join(fx.trellis, ".runtime", "sessions"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(fx.trellis, ".runtime", "sessions", "stale.json"),
    "{}\n",
  );
  fs.writeFileSync(path.join(fx.trellis, ".version"), "0.6.16\n");
  fs.writeFileSync(
    path.join(fx.trellis, ".template-hashes.json"),
    JSON.stringify(
      {
        __version: 2,
        hashes: {
          ".trellis/scripts/task.py": hashOf(
            path.join(fx.trellis, "scripts", "task.py"),
          ),
          "AGENTS.md": hashOf(
            path.resolve(__dirname, "../fixtures/legacy-agents.md"),
          ),
        },
      },
      null,
      2,
    ) + "\n",
  );

  git(fx.tmp, "add", "-A");
  git(fx.tmp, "commit", "-q", "-m", "legacy initial");
}

function makeFixture(
  opts: { secondDev?: boolean; project?: string; base?: string } = {},
): Fixture {
  const base =
    opts.base ?? fs.mkdtempSync(path.join(os.tmpdir(), "trellis-mig-"));
  const projectName = opts.project ?? PROJECT;
  const repo = path.join(base, projectName);
  const storage = path.join(base, "store");
  const fx: Fixture = {
    base,
    tmp: repo,
    trellis: path.join(repo, ".trellis"),
    storage,
    projectDir: path.join(storage, projectName),
    projectName,
  };
  fs.mkdirSync(fx.trellis, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "core.excludesFile", "/dev/null");
  stampLegacy(fx, opts);
  return fx;
}

function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, {
    recursive: true,
    withFileTypes: false,
  }) as string[]) {
    const abs = path.join(root, entry);
    const rel = path.relative(root, abs);
    if (fs.statSync(abs).isFile()) {
      out.set(rel, fs.readFileSync(abs, "utf-8"));
    }
  }
  return out;
}

describe.skipIf(!hasPython() || process.platform === "win32")(
  "update --migrate-storage (explicit storage migration)",
  () => {
    let fx: Fixture;

    beforeEach(() => {
      fx = makeFixture();
      for (const role of ["AUTHOR", "COMMITTER"]) {
        vi.stubEnv(`GIT_${role}_NAME`, "Migration Test");
        vi.stubEnv(`GIT_${role}_EMAIL`, "migration@example.com");
      }
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
      } as Response);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(fx.base, { recursive: true, force: true });
    });

    const runUpdate = async (
      opts: Parameters<typeof update>[0],
    ): Promise<void> => {
      const prev = process.cwd();
      process.chdir(fx.tmp);
      try {
        await update(opts);
      } finally {
        process.chdir(prev);
      }
    };

    it("dry-run probes read-only: no storage, no config, no link", async () => {
      const before = snapshotDir(fx.tmp);
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => {
          logs.push(args.join(" "));
        });
      try {
        await runUpdate({
          migrateStorage: true,
          dryRun: true,
          storage: fx.storage,
        });
      } finally {
        spy.mockRestore();
      }
      const out = logs.join("\n");
      expect(out).toContain(PROJECT);

      expect(fs.existsSync(fx.storage)).toBe(false);
      expect(fs.existsSync(path.join(fx.tmp, ".treills.conf.json"))).toBe(
        false,
      );
      expect(snapshotDir(fx.tmp)).toEqual(before);
    });

    it("migrates data, verifies the copy, swaps config+link, keeps the original", async () => {
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });

      // Root config + browse link swapped in.
      const conf = path.join(fx.tmp, ".treills.conf.json");
      expect(fs.existsSync(conf)).toBe(true);
      const trellisStat = fs.lstatSync(path.join(fx.tmp, ".trellis"));
      expect(trellisStat.isSymbolicLink()).toBe(true);

      // Project data landed under the storage root.
      expect(
        fs.existsSync(
          path.join(fx.projectDir, "tasks", "11-14-demo", "task.json"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fx.projectDir, "spec", "guides", "index.md")),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fx.projectDir, "scripts", "task.py")),
      ).toBe(true);
      expect(fs.existsSync(path.join(fx.projectDir, "config.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(fx.projectDir, "project.json"))).toBe(
        true,
      );

      // Workspace converted flat (single dev, from .developer).
      expect(
        fs.readFileSync(
          path.join(fx.projectDir, "workspace", "journal-1.md"),
          "utf-8",
        ),
      ).toContain("legacy");

      // Runtime/cache state did NOT migrate.
      expect(
        fs.existsSync(
          path.join(fx.projectDir, ".runtime", "sessions", "stale.json"),
        ),
      ).toBe(false);

      // Hash manifest split: shared keeps .trellis/* keys only; the
      // checkout's installation records live under the checkout runtime.
      const shared = JSON.parse(
        fs.readFileSync(
          path.join(fx.projectDir, ".template-hashes.json"),
          "utf-8",
        ),
      );
      expect(Object.keys(shared.hashes)).toContain(".trellis/scripts/task.py");
      expect(
        Object.keys(shared.hashes).every((key) => key.startsWith(".trellis/")),
      ).toBe(true);
      const checkoutHashes = path.join(
        fx.projectDir,
        ".runtime",
        "checkouts",
        checkoutKey(fx.tmp),
        ".template-hashes.json",
      );
      expect(
        JSON.parse(fs.readFileSync(checkoutHashes, "utf-8")).hashes[
          "AGENTS.md"
        ],
      ).toBeUndefined();

      // The storage repository committed the import.
      const subjects = git(fx.storage, "log", "--pretty=%s").split("\n");
      expect(
        subjects.some((s) => s.includes("migrate") || s.includes("import")),
      ).toBe(true);
      expect(subjects).toContain(
        `chore(${fx.projectName}): import external workflow data`,
      );

      // The original tree is preserved at an explicit backup location.
      const entries = fs
        .readdirSync(fx.tmp)
        .filter((e) => e.startsWith(".trellis.pre-migration"));
      expect(entries.length).toBe(1);
      expect(
        fs.existsSync(
          path.join(
            fx.tmp,
            entries[0] as string,
            "workspace",
            "alice",
            "journal-1.md",
          ),
        ),
      ).toBe(true);

      // The code repo was not auto-committed: old paths show as deletions.
      expect(git(fx.tmp, "log", "--pretty=%s").split("\n").length).toBe(1);
      const status = git(fx.tmp, "status", "--porcelain");
      expect(status).toContain(".trellis/scripts/task.py");

      // Runtime works from the config alone: remove the browse link first.
      fs.unlinkSync(fx.trellis);
      const r = spawnSync(
        "python3",
        [path.join(fx.projectDir, "scripts", "task.py"), "list"],
        { cwd: fx.tmp, encoding: "utf-8" },
      );
      expect(r.status, r.stderr).toBe(0);
    });

    it("skips OS junk files even when the user's global gitignore ignores them", async () => {
      // Reproduces the macOS failure: a global excludesFile ignoring
      // .DS_Store used to make the migration's `git add` fail outright.
      const excludes = path.join(fx.base, "global-excludes");
      fs.writeFileSync(excludes, ".DS_Store\nThumbs.db\n");
      vi.stubEnv("GIT_CONFIG_COUNT", "1");
      vi.stubEnv("GIT_CONFIG_KEY_0", "core.excludesFile");
      vi.stubEnv("GIT_CONFIG_VALUE_0", excludes);

      fs.writeFileSync(path.join(fx.trellis, ".DS_Store"), "junk");
      fs.writeFileSync(path.join(fx.trellis, "spec", ".DS_Store"), "junk");
      fs.writeFileSync(path.join(fx.trellis, "tasks", "Thumbs.db"), "junk");

      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });

      // Junk never reaches the storage repository …
      expect(fs.existsSync(path.join(fx.projectDir, ".DS_Store"))).toBe(false);
      expect(fs.existsSync(path.join(fx.projectDir, "spec", ".DS_Store"))).toBe(
        false,
      );
      expect(
        fs.existsSync(path.join(fx.projectDir, "tasks", "Thumbs.db")),
      ).toBe(false);
      expect(git(fx.storage, "ls-files")).not.toContain(".DS_Store");

      // … and the import commit landed, scoped to the project.
      const subjects = git(fx.storage, "log", "--pretty=%s").split("\n");
      expect(subjects).toContain(
        `chore(${fx.projectName}): import external workflow data`,
      );
    });

    it("re-running on a migrated project is an idempotent no-op", async () => {
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      const before = snapshotDir(fx.projectDir);
      const logs: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...a: unknown[]) => {
          logs.push(a.join(" "));
        });
      try {
        await runUpdate({
          migrateStorage: true,
          storage: fx.storage,
          yes: true,
        });
      } finally {
        spy.mockRestore();
      }
      expect(logs.join("\n").toLowerCase()).toContain("already");
      expect(snapshotDir(fx.projectDir)).toEqual(before);
    });

    it("refuses multi-developer workspace ambiguity without --workspace", async () => {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
      fx = makeFixture({
        secondDev: true,
        project: "multi-app",
        base: fx.base,
      });

      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/--workspace/i);
      // Nothing was switched.
      expect(fs.existsSync(path.join(fx.tmp, ".treills.conf.json"))).toBe(
        false,
      );
      expect(fs.lstatSync(path.join(fx.tmp, ".trellis")).isDirectory()).toBe(
        true,
      );
    });

    it("multi-developer workspace: primary flattens, others keep history", async () => {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
      fx = makeFixture({
        secondDev: true,
        project: "multi-app",
        base: fx.base,
      });

      await runUpdate({
        migrateStorage: true,
        storage: fx.storage,
        workspace: "alice",
        yes: true,
      });

      expect(
        fs.readFileSync(
          path.join(fx.projectDir, "workspace", "journal-1.md"),
          "utf-8",
        ),
      ).toContain("alice");
      expect(
        fs.existsSync(
          path.join(
            fx.projectDir,
            "workspace",
            "history",
            "bob",
            "journal-1.md",
          ),
        ),
      ).toBe(true);
    });

    it("refuses a same-named project bound to a different repository", async () => {
      // Pre-create the target project dir bound elsewhere.
      fs.mkdirSync(fx.projectDir, { recursive: true });
      const otherRepo = path.join(fx.base, "other-repo");
      fs.mkdirSync(otherRepo, { recursive: true });
      git(otherRepo, "init", "-q", "-b", "main");
      fs.writeFileSync(
        path.join(fx.projectDir, "project.json"),
        JSON.stringify({ name: fx.projectName, codeRoot: otherRepo }) + "\n",
      );

      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/different|bound/i);
      expect(fs.existsSync(path.join(fx.tmp, ".treills.conf.json"))).toBe(
        false,
      );
      expect(fs.lstatSync(path.join(fx.tmp, ".trellis")).isDirectory()).toBe(
        true,
      );
    });

    it("preserves the legacy workspace directory index as history", async () => {
      fs.writeFileSync(
        path.join(fx.trellis, "workspace", "index.md"),
        "# All developers\n",
      );
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(
        fs.readFileSync(
          path.join(fx.projectDir, "workspace", "index.md"),
          "utf8",
        ),
      ).toContain("# Index");
      expect(
        fs.readFileSync(
          path.join(fx.projectDir, "workspace", "history", "index.md"),
          "utf8",
        ),
      ).toContain("All developers");
    });

    it("imports untracked data even when the storage repo already has HEAD", async () => {
      fs.mkdirSync(fx.storage);
      git(fx.storage, "init", "-q");
      fs.writeFileSync(path.join(fx.storage, "other.txt"), "other project\n");
      git(fx.storage, "add", "other.txt");
      git(fx.storage, "commit", "-qm", "other initial");
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(git(fx.storage, "ls-tree", "-r", "--name-only", "HEAD")).toContain(
        PROJECT + "/tasks/11-14-demo/task.json",
      );
    });

    it("keeps the source active on commit rejection and retries without workspace conflicts", async () => {
      fs.mkdirSync(fx.storage);
      git(fx.storage, "init", "-q");
      const hooks = path.join(fx.base, "hooks");
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      git(fx.storage, "config", "core.hooksPath", hooks);
      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/commit/i);
      expect(fs.existsSync(path.join(fx.tmp, ".treills.conf.json"))).toBe(
        false,
      );
      git(fx.storage, "config", "--unset", "core.hooksPath");
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(fs.lstatSync(fx.trellis).isSymbolicLink()).toBe(true);
    });

    it("resumes a crash after source rename and before locator publication", async () => {
      const rename = fs.renameSync;
      const fault = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (
            String(to) ===
            path.join(fs.realpathSync(fx.tmp), ".treills.conf.json")
          ) {
            throw new Error("injected config failure");
          }
          rename(from, to);
        });
      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/injected/);
      fault.mockRestore();
      expect(fs.existsSync(fx.trellis)).toBe(false);
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(fs.lstatSync(fx.trellis).isSymbolicLink()).toBe(true);
    });

    it("resumes a crash after locator publication without reimporting", async () => {
      const rename = fs.renameSync;
      let configWritten = false;
      const fault = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (configWritten && String(to).endsWith("storage-migration.json"))
            throw new Error("injected checkpoint failure");
          rename(from, to);
          if (String(to).endsWith(".treills.conf.json")) configWritten = true;
        });
      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/injected/);
      fault.mockRestore();
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(fs.lstatSync(fx.trellis).isSymbolicLink()).toBe(true);
      expect(
        fs
          .readdirSync(fx.tmp)
          .filter((name) => name.startsWith(".trellis.pre-migration")),
      ).toHaveLength(1);
    });

    it("resumes an interrupted integration refresh and preserves a newer sibling task", async () => {
      const rename = fs.renameSync;
      const fault = vi
        .spyOn(fs, "renameSync")
        .mockImplementation((from, to) => {
          if (
            String(to).endsWith("storage-migration.json") &&
            fs.readFileSync(from, "utf8").includes('"phase":"refreshed"')
          ) {
            throw new Error("injected refresh failure");
          }
          rename(from, to);
        });
      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/injected/);
      fault.mockRestore();
      const sibling = path.join(fx.projectDir, "tasks", "sibling");
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, "task.json"), "{}\n");
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      expect(git(fx.storage, "status", "--porcelain")).toContain(
        "tasks/sibling",
      );
      expect(
        git(
          fx.storage,
          "status",
          "--porcelain",
          "--",
          PROJECT + "/.template-hashes.json",
        ),
      ).toBe("");
      expect(fs.lstatSync(fx.trellis).isSymbolicLink()).toBe(true);
    });

    it("dry-run on an external project does not repair a missing browse link", async () => {
      await runUpdate({ migrateStorage: true, storage: fx.storage, yes: true });
      fs.unlinkSync(fx.trellis);
      await runUpdate({
        migrateStorage: true,
        storage: fx.storage,
        dryRun: true,
      });
      expect(fs.existsSync(fx.trellis)).toBe(false);
    });

    it("refuses source symlinks before creating storage", async () => {
      fs.symlinkSync(fx.tmp, path.join(fx.trellis, "spec", "escape"), "dir");
      await expect(
        runUpdate({ migrateStorage: true, storage: fx.storage, yes: true }),
      ).rejects.toThrow(/symlink|link/i);
      expect(fs.existsSync(fx.storage)).toBe(false);
    });

    it("blocks a plain upgrade even when the storage release has no rename/delete items", async () => {
      const before = snapshotDir(fx.tmp);
      vi.resetModules();
      vi.doMock("../../src/constants/version.js", async () => ({
        ...(await vi.importActual<
          typeof import("../../src/constants/version.js")
        >("../../src/constants/version.js")),
        VERSION: "0.7.0",
      }));
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("blocked upgrade");
      });
      const prev = process.cwd();
      process.chdir(fx.tmp);
      try {
        const { update: futureUpdate } =
          await import("../../src/commands/update.js");
        await expect(futureUpdate({ force: true })).rejects.toThrow(
          "blocked upgrade",
        );
        expect(exit).toHaveBeenCalledWith(1);
        expect(snapshotDir(fx.tmp)).toEqual(before);
      } finally {
        process.chdir(prev);
        vi.doUnmock("../../src/constants/version.js");
        vi.resetModules();
      }
    });

    it("gate helper: crossings of the storage-migration release require the explicit step", () => {
      expect(crossesStorageMigration("0.6.16", "0.7.0")).toBe(true);
      expect(crossesStorageMigration("0.6.16", "0.7.3")).toBe(true);
      expect(crossesStorageMigration("0.7.0", "0.7.3")).toBe(false);
      expect(crossesStorageMigration("0.6.16", "0.6.17")).toBe(false);
    });
  },
);
