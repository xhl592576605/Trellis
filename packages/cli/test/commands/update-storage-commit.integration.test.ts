import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";
import { VERSION } from "../../src/constants/version.js";
import { runtimeDirOf } from "../../src/utils/external-store.js";
import {
  computeHash,
  loadHashes,
  saveHashes,
} from "../../src/utils/template-hash.js";

vi.mock("figlet", () => ({ default: { textSync: vi.fn(() => "TRELLIS") } }));
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

describe.skipIf(process.platform === "win32")(
  "ordinary update storage commits",
  () => {
    let base: string;
    let code: string;
    let storage: string;
    let project: string;

    beforeEach(async () => {
      base = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "trellis-update-commit-"),
      );
      code = path.join(base, "code checkout");
      storage = path.join(base, "wiki store");
      project = path.join(storage, "演示 project");
      fs.mkdirSync(code);
      git(code, "init", "-q");
      for (const role of ["AUTHOR", "COMMITTER"]) {
        vi.stubEnv(`GIT_${role}_NAME`, "Update Test");
        vi.stubEnv(`GIT_${role}_EMAIL`, "update@example.com");
      }
      git(code, "commit", "--allow-empty", "-qm", "code baseline");
      vi.spyOn(process, "cwd").mockReturnValue(code);
      vi.spyOn(console, "log").mockImplementation(noop);
      vi.spyOn(console, "error").mockImplementation(noop);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: true,
            json: async () => ({ version: VERSION }),
          }),
      );
      await init({ storage, project: "演示 project", pi: true, yes: true });
      // init now creates the wiki baseline commit itself (initialize-commit
      // behavior); only neutralize the host's global excludes file here.
      git(storage, "config", "core.excludesFile", "/dev/null");
      fs.unlinkSync(path.join(code, ".trellis"));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      fs.rmSync(base, { recursive: true, force: true });
    });

    function installOldTemplate(): void {
      const rel = "scripts/get_context.py";
      const content =
        fs.readFileSync(path.join(project, rel), "utf8") + "\n# old release\n";
      fs.writeFileSync(path.join(project, rel), content);
      saveHashes(code, {
        ...loadHashes(code),
        [".trellis/" + rel]: computeHash(content),
      });
      fs.writeFileSync(path.join(project, ".version"), "0.7.0");
      git(storage, "add", "--", "演示 project");
      git(storage, "commit", "-qm", "old templates");
    }

    it.each([{}, { migrate: true }])(
      "commits updated wiki templates with %j, preserving unrelated staged work",
      async (flags) => {
        installOldTemplate();
        fs.writeFileSync(
          path.join(storage, "other.txt"),
          "other project staged\n",
        );
        git(storage, "add", "--", "other.txt");
        fs.writeFileSync(path.join(project, "spec/manual.md"), "manual spec\n");
        const head = git(code, "rev-parse", "HEAD");
        await update({ ...flags, force: true });
        expect(git(storage, "log", "-1", "--format=%s")).toBe(
          `chore(演示 project): update workflow to ${VERSION}`,
        );
        const files = git(
          storage,
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "HEAD",
        );
        expect(files).toContain("scripts/get_context.py");
        expect(files).toContain(".version");
        expect(files).toContain(".template-hashes.json");
        expect(files).not.toContain("manual.md");
        expect(files).not.toContain("other.txt");
        expect(files).not.toContain(".runtime");
        expect(git(storage, "diff", "--cached", "--name-only")).toBe(
          "other.txt",
        );
        expect(git(code, "rev-parse", "HEAD")).toBe(head);
        expect(fs.existsSync(path.join(code, ".trellis"))).toBe(false);
        const updatedHead = git(storage, "rev-parse", "HEAD");
        await update({ ...flags, force: true });
        expect(git(storage, "rev-parse", "HEAD")).toBe(updatedHead);
      },
    );

    it("commits a version-only update on the early-return path", async () => {
      // The checkout receipt is authoritative; both stamps must model the old install.
      // Previous init/update template churn accidentally masked this fixture gap.
      fs.writeFileSync(path.join(runtimeDirOf(code), ".version"), "0.7.0");
      fs.writeFileSync(path.join(project, ".version"), "0.7.0");
      git(storage, "add", "--", "演示 project/.version");
      git(storage, "commit", "-qm", "old version");
      await update({ force: true });
      expect(git(storage, "show", "HEAD:演示 project/.version")).toBe(VERSION);
      expect(git(storage, "status", "--porcelain")).toBe("");
    });

    it("commits a real orphaned rename without a browse link and recovers staged deletions", async () => {
      fs.writeFileSync(
        path.join(project, "scripts/feature.sh"),
        "#!/bin/sh\necho legacy\n",
      );
      saveHashes(code, {
        ...loadHashes(code),
        ".trellis/scripts/feature.sh": computeHash("#!/bin/sh\necho legacy\n"),
      });
      git(storage, "add", "--", "演示 project");
      git(storage, "commit", "-qm", "legacy rename source");
      const hooks = path.join(base, "hooks");
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      git(storage, "config", "core.hooksPath", hooks);
      await expect(update({ force: true, migrate: true })).rejects.toThrow(
        /storage.*commit/i,
      );
      expect(fs.existsSync(path.join(project, "scripts/feature.sh"))).toBe(
        false,
      );
      expect(fs.existsSync(path.join(project, "scripts/task.sh"))).toBe(true);
      fs.unlinkSync(path.join(hooks, "pre-commit"));
      await update({ force: true, migrate: true });
      // The next analysis can also apply the later task.sh -> task.py migration.
      expect(git(storage, "log", "-2", "--format=", "--name-only")).toContain(
        "scripts/task.sh",
      );
      expect(git(storage, "status", "--porcelain")).toBe("");
    });

    it("leaves dry-run bytes, index and HEAD untouched", async () => {
      installOldTemplate();
      const head = git(storage, "rev-parse", "HEAD");
      const before = fs.readFileSync(
        path.join(project, "scripts/get_context.py"),
        "utf8",
      );
      await update({ force: true, migrate: true, dryRun: true });
      expect(git(storage, "rev-parse", "HEAD")).toBe(head);
      expect(git(storage, "status", "--porcelain")).toBe("");
      expect(
        fs.readFileSync(path.join(project, "scripts/get_context.py"), "utf8"),
      ).toBe(before);
    });

    it("recovers a rejected commit even when the retry has no template changes", async () => {
      installOldTemplate();
      const hooks = path.join(base, "hooks");
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      git(storage, "config", "core.hooksPath", hooks);
      await expect(update({ force: true })).rejects.toThrow(/storage.*commit/i);
      const head = git(storage, "rev-parse", "HEAD");
      fs.unlinkSync(path.join(hooks, "pre-commit"));
      await update({ force: true });
      expect(git(storage, "rev-parse", "HEAD")).not.toBe(head);
      expect(git(storage, "status", "--porcelain")).toBe("");
    });

    it("refuses recovery when an output has newer manual edits", async () => {
      installOldTemplate();
      const hooks = path.join(base, "hooks");
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      git(storage, "config", "core.hooksPath", hooks);
      await expect(update({ force: true })).rejects.toThrow();
      fs.unlinkSync(path.join(hooks, "pre-commit"));
      fs.appendFileSync(
        path.join(project, "scripts/get_context.py"),
        "\n# newer manual edit\n",
      );
      const head = git(storage, "rev-parse", "HEAD");
      await expect(update({ force: true })).rejects.toThrow(
        /changed|modified/i,
      );
      expect(git(storage, "rev-parse", "HEAD")).toBe(head);
    });
  },
);
