/**
 * Integration tests for the end-of-init automatic wiki commit in external
 * storage mode (task 11-16-init-wiki-autocommit).
 *
 * #1 Fresh wiki → one initialization commit covering the whole project
 *    directory plus newly created root ignore/attribute files.
 * #2 Re-init → only files this init rewrote are committed; user-owned
 *    uncommitted edits stay out (same ownership rule as update).
 * #3 Commit failure (failing pre-commit hook) → init still succeeds with a
 *    warning; a later plain re-init retries the initialization commit.
 * #4 Re-init fast path with no wiki changes → no new commit.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "../../src/commands/init.js";
import { VERSION } from "../../src/constants/version.js";

vi.mock("figlet", () => ({ default: { textSync: vi.fn(() => "TRELLIS") } }));
vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({}) },
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
  "init automatic wiki commit (external storage)",
  () => {
    let base: string;
    let code: string;
    let storage: string;
    let project: string;
    const projectName = "演示 project";

    beforeEach(() => {
      base = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "trellis-init-commit-"),
      );
      code = path.join(base, "code checkout");
      storage = path.join(base, "wiki store");
      project = path.join(storage, projectName);
      fs.mkdirSync(code);
      // The storage repository is created by init itself and carries no
      // repo-local identity; the env stub provides one in CI.
      for (const role of ["AUTHOR", "COMMITTER"]) {
        vi.stubEnv(`GIT_${role}_NAME`, "Init Test");
        vi.stubEnv(`GIT_${role}_EMAIL`, "init@example.com");
      }
      vi.spyOn(process, "cwd").mockReturnValue(code);
      vi.spyOn(console, "log").mockImplementation(noop);
      vi.spyOn(console, "error").mockImplementation(noop);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(base, { recursive: true, force: true });
    });

    function commitFiles(): string[] {
      return git(
        storage,
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--name-only",
        "-r",
        "HEAD",
      ).split("\n");
    }

    it("#1 fresh init commits the whole wiki as an initialization commit", async () => {
      await init({ storage, project: projectName, pi: true, yes: true });

      expect(git(storage, "log", "-1", "--format=%s")).toBe(
        `chore(${projectName}): initialize Trellis wiki`,
      );
      const files = commitFiles();
      for (const member of [
        `${projectName}/project.json`,
        `${projectName}/workflow.md`,
        `${projectName}/scripts/get_context.py`,
        `${projectName}/.version`,
        `${projectName}/.template-hashes.json`,
        `${projectName}/tasks/00-bootstrap-guidelines/prd.md`,
        ".gitignore",
        ".gitattributes",
      ]) {
        expect(files).toContain(member);
      }
      expect(git(storage, "status", "--porcelain")).toBe("");
    });

    it("#2 re-init commits only files init rewrote, leaving user edits out", async () => {
      await init({ storage, project: projectName, pi: true, yes: true });
      // Simulate an older install plus an uncommitted user file.
      fs.writeFileSync(
        path.join(project, "scripts/get_context.py"),
        "# old release\n",
      );
      fs.writeFileSync(path.join(project, ".version"), "0.7.0");
      fs.writeFileSync(path.join(project, "spec/manual.md"), "manual spec\n");
      // Stage only the aged product files: manual.md must stay uncommitted so
      // the later assertion proves init did not sweep user files into its commit.
      git(
        storage,
        "add",
        "--",
        `${projectName}/scripts/get_context.py`,
        `${projectName}/.version`,
      );
      git(storage, "commit", "-qm", "old templates");

      await init({ pi: true, yes: true, force: true });

      expect(git(storage, "log", "-1", "--format=%s")).toBe(
        `chore(${projectName}): update wiki from trellis init`,
      );
      const files = commitFiles();
      expect(files).toContain(`${projectName}/scripts/get_context.py`);
      expect(files).toContain(`${projectName}/.version`);
      expect(files).not.toContain(`${projectName}/spec/manual.md`);
      expect(git(storage, "show", `HEAD:${projectName}/.version`)).toBe(
        VERSION,
      );
      expect(
        git(storage, "show", `HEAD:${projectName}/scripts/get_context.py`),
      ).not.toBe("# old release\n");
      // The user's file stays uncommitted in the worktree.
      expect(git(storage, "status", "--porcelain")).toContain("manual.md");
    });

    it("#3 commit failure warns without failing init, and a later init retries", async () => {
      // Pre-create the storage repository so the failing hook is installed
      // before init's own commit runs; prepareExternalStorage adopts it.
      fs.mkdirSync(storage);
      git(storage, "init", "-q");
      const hooks = path.join(base, "hooks");
      fs.mkdirSync(hooks);
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n", {
        mode: 0o755,
      });
      git(storage, "config", "core.hooksPath", hooks);
      const warnings: string[] = [];
      vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) =>
        warnings.push(a.join(" ")),
      );

      await init({ storage, project: projectName, pi: true, yes: true });

      // Init completed its writes; only the commit failed.
      expect(fs.existsSync(path.join(project, "workflow.md"))).toBe(true);
      expect(() => git(storage, "log", "-1", "--format=%H")).toThrow();
      expect(warnings.join("\n")).toContain(
        "Could not commit the external wiki",
      );

      fs.unlinkSync(path.join(hooks, "pre-commit"));
      await init({ pi: true, yes: true });
      expect(git(storage, "log", "-1", "--format=%s")).toBe(
        `chore(${projectName}): initialize Trellis wiki`,
      );
      expect(git(storage, "status", "--porcelain")).toBe("");
    });

    it("#4 re-init without wiki changes creates no new commit", async () => {
      await init({ storage, project: projectName, pi: true, yes: true });
      const head = git(storage, "rev-parse", "HEAD");
      await init({ pi: true, yes: true });
      expect(git(storage, "rev-parse", "HEAD")).toBe(head);
      expect(git(storage, "status", "--porcelain")).toBe("");
    });
  },
);
