import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareExternalStorage, resolveWorkflowDir, writeRootConfig } from "../../src/utils/external-store.js";

describe("external store ownership", () => {
  let base: string;
  let code: string;
  let storage: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trellis-store-guards-")));
    code = path.join(base, "code");
    storage = path.join(base, "storage");
    fs.mkdirSync(code);
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it.each(["../escaped", "..\\escaped", ".git", ".runtime", "CON", "x.", " x", "x:y"])("rejects unsafe project %s before creating storage", (project) => {
    expect(() => prepareExternalStorage(storage, project, code)).toThrow(/project/);
    expect(fs.existsSync(storage)).toBe(false);
    expect(fs.existsSync(path.join(base, "escaped"))).toBe(false);
  });

  it("preserves a plain-directory binding and refuses another plain project", () => {
    const { projectDir } = prepareExternalStorage(storage, "demo", code);
    const binding = fs.readFileSync(path.join(projectDir, "project.json"), "utf8");
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    writeRootConfig(other, storage, "demo");
    expect(() => prepareExternalStorage(storage, "demo", other)).toThrow(/different project/);
    expect(() => resolveWorkflowDir(other)).toThrow(/different project/);
    expect(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")).toBe(binding);
  });

  it("allows a linked worktree without replacing the default checkout binding", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: code, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial");
    const { projectDir } = prepareExternalStorage(storage, "demo", code);
    const binding = fs.readFileSync(path.join(projectDir, "project.json"), "utf8");
    const other = path.join(base, "worktree");
    git("worktree", "add", "-qb", "other", other);
    prepareExternalStorage(storage, "demo", other);
    writeRootConfig(other, storage, "demo");
    expect(resolveWorkflowDir(other)).toBe(projectDir);
    expect(fs.readFileSync(path.join(projectDir, "project.json"), "utf8")).toBe(binding);
  });

  it("does not fall back when an explicit config is damaged", () => {
    fs.mkdirSync(path.join(code, ".trellis"));
    fs.writeFileSync(path.join(code, ".treills.conf.json"), "{");
    expect(() => resolveWorkflowDir(code)).toThrow(/.treills.conf.json/);
  });

  it("refuses an existing project directory with no verifiable binding", () => {
    fs.mkdirSync(path.join(storage, "demo"), { recursive: true });
    fs.writeFileSync(path.join(storage, "demo", "user-data"), "keep");
    expect(() => prepareExternalStorage(storage, "demo", code)).toThrow(/binding/);
    expect(fs.readFileSync(path.join(storage, "demo", "user-data"), "utf8")).toBe("keep");
  });

  it("refuses a project link escaping the storage root", () => {
    const { projectDir } = prepareExternalStorage(storage, "demo", code);
    const outside = path.join(base, "outside");
    fs.renameSync(projectDir, outside);
    fs.symlinkSync(outside, projectDir, process.platform === "win32" ? "junction" : "dir");
    writeRootConfig(code, storage, "demo");
    expect(() => resolveWorkflowDir(code)).toThrow(/storage root/);
    expect(() => prepareExternalStorage(storage, "demo", code)).toThrow(/storage root/);
  });
});
