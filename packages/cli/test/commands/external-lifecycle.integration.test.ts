/**
 * Stage 7 of the external local storage design (§10): uninstall / ablate /
 * restore only touch the CURRENT CHECKOUT's integration — platform files,
 * the root locator config and the browse link. External product data
 * (tasks/spec/workspace/scripts in the storage repository) is never
 * deleted, snapshotted, or rolled back, and other worktrees' writes during
 * an ablation must survive restore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { init } from "../../src/commands/init.js";
import { uninstall } from "../../src/commands/uninstall.js";
import { ablate, restore } from "../../src/commands/ablate.js";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "TRELLIS") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function countCommits(cwd: string): number {
  const r = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd,
    encoding: "utf-8",
  });
  return r.status === 0 ? Number.parseInt(r.stdout.trim(), 10) : 0;
}

interface Fixture {
  base: string;
  storage: string;
  projectDir: string;
  repo: string;
  stateRoot: string;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-life-"));
  const storage = path.join(base, "store");
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "core.excludesFile", "/dev/null");
  const projectDir = path.join(storage, path.basename(repo));
  return {
    base,
    storage,
    projectDir,
    repo,
    stateRoot: path.join(base, "ablations"),
  };
}

/** Trellis-owned surfaces are gone; user-residual platform files may remain. */
function trellisSurfacesGone(repo: string): void {
  expect(fs.existsSync(path.join(repo, ".trellis"))).toBe(false);
  expect(fs.existsSync(path.join(repo, ".treills.conf.json"))).toBe(false);
  const settings = path.join(repo, ".claude", "settings.json");
  if (fs.existsSync(settings)) {
    expect(fs.readFileSync(settings, "utf-8")).not.toMatch(/trellis/i);
  }
  expect(fs.existsSync(path.join(repo, ".claude", "hooks"))).toBe(false);
  expect(fs.existsSync(path.join(repo, ".claude", "commands", "trellis"))).toBe(
    false,
  );
}
function snapshotDir(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(root, {
    recursive: true,
    withFileTypes: false,
  }) as string[]) {
    const abs = path.join(root, entry);
    if (abs.includes(`${path.sep}.git${path.sep}`)) continue;
    if (fs.statSync(abs).isFile()) {
      out.set(path.relative(root, abs), fs.readFileSync(abs, "utf-8"));
    }
  }
  return out;
}

async function initExternal(fx: Fixture): Promise<void> {
  const cwd = process.cwd();
  process.chdir(fx.repo);
  try {
    await init({ storage: fx.storage, claude: true, yes: true });
  } finally {
    process.chdir(cwd);
  }
}

describe.skipIf(process.platform === "win32")(
  "external storage lifecycle: uninstall/ablate keep external data",
  () => {
    let fx: Fixture;

    beforeEach(() => {
      fx = makeFixture();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(fx.base, { recursive: true, force: true });
    });

    it("uninstall removes the checkout integration and preserves external data bytes", async () => {
      await initExternal(fx);
      expect(
        fs.lstatSync(path.join(fx.repo, ".trellis")).isSymbolicLink(),
      ).toBe(true);

      // External data exists; the storage repo may have zero or more commits.
      const commitsBefore = countCommits(fx.storage);

      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...a: unknown[]) =>
        logs.push(a.join(" ")),
      );
      vi.spyOn(console, "error").mockImplementation((...a: unknown[]) =>
        logs.push(a.join(" ")),
      );
      const dataBefore = snapshotDir(fx.projectDir);

      const cwd = process.cwd();
      process.chdir(fx.repo);
      try {
        await uninstall({ yes: true });
      } finally {
        process.chdir(cwd);
      }

      // Checkout integration is gone: link, locator config, trellis surfaces.
      trellisSurfacesGone(fx.repo);

      // External product data is byte-identical; nothing new was committed.
      expect(snapshotDir(fx.projectDir)).toEqual(dataBefore);
      expect(countCommits(fx.storage)).toBe(commitsBefore);

      // The plan said so.
      expect(logs.join("\n")).toMatch(/preserv/i);
    });

    it("ablate removes link+config+platform, keeps external data; restore survives sibling writes", async () => {
      await initExternal(fx);
      const dataBefore = snapshotDir(fx.projectDir);

      const run = async (fn: () => Promise<void>): Promise<string> => {
        const out: string[] = [];
        const spy = vi
          .spyOn(console, "log")
          .mockImplementation((...a: unknown[]) => out.push(a.join(" ")));
        vi.spyOn(console, "error").mockImplementation((...a: unknown[]) =>
          out.push(a.join(" ")),
        );
        const prev = process.cwd();
        process.chdir(fx.repo);
        try {
          await fn();
        } finally {
          process.chdir(prev);
          spy.mockRestore();
        }
        return out.join("\n");
      };

      process.env.TRELLIS_ABLATION_STATE_ROOT = fx.stateRoot;
      try {
        const ablateOut = await run(() => ablate({ yes: true }));
        expect(ablateOut).toContain("ablated");
        trellisSurfacesGone(fx.repo);
        expect(snapshotDir(fx.projectDir)).toEqual(dataBefore);

        // Another worktree keeps working on the shared external data while
        // this checkout is ablated.
        const siblingTask = path.join(fx.projectDir, "tasks", "11-20-sibling");
        fs.mkdirSync(siblingTask, { recursive: true });
        fs.writeFileSync(
          path.join(siblingTask, "task.json"),
          '{"status":"planning"}\n',
        );

        await run(() => restore({ yes: true }));
        const link = path.join(fx.repo, ".trellis");
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.join(fx.repo, ".treills.conf.json"))).toBe(
          true,
        );
        expect(
          fs.existsSync(path.join(fx.repo, ".claude", "settings.json")),
        ).toBe(true);
        // The sibling's write survived the restore.
        expect(fs.existsSync(siblingTask)).toBe(true);
        // And the pre-ablation external content is untouched.
        for (const [rel, content] of dataBefore) {
          expect(fs.readFileSync(path.join(fx.projectDir, rel), "utf-8")).toBe(
            content,
          );
        }
      } finally {
        delete process.env.TRELLIS_ABLATION_STATE_ROOT;
      }
    });

    it("ablate and restore work without a browse link", async () => {
      await initExternal(fx);
      fs.unlinkSync(path.join(fx.repo, ".trellis"));
      process.env.TRELLIS_ABLATION_STATE_ROOT = fx.stateRoot;
      const prev = process.cwd();
      process.chdir(fx.repo);
      try {
        await ablate({ yes: true });
        trellisSurfacesGone(fx.repo);
        await restore({ yes: true });
        expect(fs.existsSync(path.join(fx.repo, ".treills.conf.json"))).toBe(
          true,
        );
        expect(fs.existsSync(path.join(fx.repo, ".trellis"))).toBe(false);
      } finally {
        process.chdir(prev);
        delete process.env.TRELLIS_ABLATION_STATE_ROOT;
      }
    });

    it.each(["uninstall", "ablate"])(
      "%s refuses a physical browse directory",
      async (command) => {
        await initExternal(fx);
        fs.unlinkSync(path.join(fx.repo, ".trellis"));
        fs.mkdirSync(path.join(fx.repo, ".trellis"));
        fs.writeFileSync(path.join(fx.repo, ".trellis", "user.txt"), "keep\n");
        const before = snapshotDir(fx.projectDir);
        process.env.TRELLIS_ABLATION_STATE_ROOT = fx.stateRoot;
        const prev = process.cwd();
        process.chdir(fx.repo);
        try {
          await expect(
            command === "uninstall"
              ? uninstall({ yes: true })
              : ablate({ yes: true }),
          ).rejects.toThrow(/browse|directory/i);
          expect(
            fs.readFileSync(path.join(fx.repo, ".trellis", "user.txt"), "utf8"),
          ).toBe("keep\n");
          expect(snapshotDir(fx.projectDir)).toEqual(before);
        } finally {
          process.chdir(prev);
          delete process.env.TRELLIS_ABLATION_STATE_ROOT;
        }
      },
    );

    it("restore rejects a redirected project binding before any checkout writes", async () => {
      await initExternal(fx);
      process.env.TRELLIS_ABLATION_STATE_ROOT = fx.stateRoot;
      const prev = process.cwd();
      process.chdir(fx.repo);
      try {
        await ablate({ yes: true });
        const other = path.join(fx.base, "other");
        fs.mkdirSync(other);
        fs.writeFileSync(
          path.join(fx.projectDir, "project.json"),
          JSON.stringify({ name: "repo", codeRoot: other }),
        );
        await expect(restore({ yes: true })).rejects.toThrow(
          /binding|bound|external/i,
        );
        trellisSurfacesGone(fx.repo);
      } finally {
        process.chdir(prev);
        delete process.env.TRELLIS_ABLATION_STATE_ROOT;
      }
    });

    it("restore reports a clear conflict when the external project dir disappeared", async () => {
      await initExternal(fx);
      process.env.TRELLIS_ABLATION_STATE_ROOT = fx.stateRoot;
      try {
        const prev = process.cwd();
        process.chdir(fx.repo);
        try {
          await ablate({ yes: true });
        } finally {
          process.chdir(prev);
        }

        // The external store is lost (disk failure / manual deletion).
        fs.rmSync(fx.projectDir, { recursive: true, force: true });

        const prev2 = process.cwd();
        process.chdir(fx.repo);
        await expect(restore({ yes: true })).rejects.toThrow(
          /external|binding|storage/i,
        );
        process.chdir(prev2);

        // Zero project writes on conflict: nothing came back.
        trellisSurfacesGone(fx.repo);
      } finally {
        delete process.env.TRELLIS_ABLATION_STATE_ROOT;
      }
    });
  },
);
