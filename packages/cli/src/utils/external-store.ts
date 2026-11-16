/**
 * External store resolution from the project-root config file.
 *
 * The root config (`.treills.conf.json` — the filename is the user's explicit
 * spelling, kept verbatim) is the single runtime source of truth for where a
 * project's Trellis data lives:
 *
 *     {"storage": "~/.trellis-wiki", "project": "Trellis"}
 *
 * The in-project `.trellis` entry is a browse-only link. It may be missing,
 * broken, or pointed elsewhere; nothing here reads it, and no caller may
 * treat its existence as a precondition for running. Legacy projects without
 * a root config keep working unchanged (fall back to `<root>/.trellis`).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DIR_NAMES } from "../constants/paths.js";
import { writeFileAtomic } from "./atomic-write.js";
import {
  assertProjectDirectory,
  canonicalPath,
  checkBinding,
  gitCommonDirOf,
  renderWorkflowPaths as renderStandaloneWorkflowPaths,
  validateProjectName,
  workflowDirOf,
} from "../templates/shared-hooks/external-store.js";

export {
  checkoutKey,
  readExternalStore,
  runtimeDirOf,
} from "../templates/shared-hooks/external-store.js";

/** Root config filename (the double-l is the user's explicit spelling). */
export const CONF_FILENAME = ".treills.conf.json";

/** Resolve workflow data from the locator; invalid explicit configs fail closed. */
export function resolveWorkflowDir(codeRoot: string): string {
  return workflowDirOf(codeRoot);
}

/** Resolve a template manifest key without depending on the browse link. */
export function resolveManagedPath(
  codeRoot: string,
  relativePath: string,
): string {
  const key = relativePath.replaceAll("\\", "/");
  return key === ".trellis" || key.startsWith(".trellis/")
    ? path.join(
        resolveWorkflowDir(codeRoot),
        key.slice(".trellis".length).replace(/^\/+/, ""),
      )
    : path.join(codeRoot, key);
}

/** Render agent-facing logical references as direct, shell-safe external paths. */
export function renderWorkflowPaths(
  content: string,
  projectDir: string,
): string {
  return renderStandaloneWorkflowPaths(content, projectDir);
}

export const DEFAULT_STORAGE_ROOT = "~/.trellis-wiki";
const BINDING_FILENAME = "project.json";

/** Create an independent local store without taking over another project's data. */
export function prepareExternalStorage(
  storageRoot: string,
  project: string,
  codeRoot: string,
): { project: string; projectDir: string; storageRoot: string } {
  validateProjectName(project);
  if (
    !storageRoot.trim() ||
    (storageRoot.startsWith("~") &&
      storageRoot !== "~" &&
      !/^~[/\\]/.test(storageRoot))
  ) {
    throw new Error("invalid storage root: use a directory or ~/directory");
  }
  const expanded =
    storageRoot === "~"
      ? os.homedir()
      : /^~[/\\]/.test(storageRoot)
        ? path.join(os.homedir(), storageRoot.slice(2))
        : storageRoot;
  const storage = path.resolve(codeRoot, expanded);
  const code = canonicalPath(codeRoot);
  if (
    storage === code ||
    storage.startsWith(code + path.sep) ||
    code.startsWith(storage + path.sep)
  ) {
    throw new Error("storage root must be outside the code checkout");
  }
  fs.mkdirSync(storage, { recursive: true });
  const realStorage = canonicalPath(storage);
  if (
    realStorage === code ||
    realStorage.startsWith(code + path.sep) ||
    code.startsWith(realStorage + path.sep)
  ) {
    throw new Error("storage root must be outside the code checkout");
  }
  if (!fs.existsSync(path.join(realStorage, ".git"))) {
    if (findEnclosingGitRoot(realStorage) !== null) {
      throw new Error(
        "storage root " +
          realStorage +
          " is inside another git repository; choose a location outside it",
      );
    }
    execFileSync("git", ["init", "-q", realStorage], { stdio: "ignore" });
  }
  if (
    gitCommonDirOf(realStorage) === gitCommonDirOf(code) &&
    gitCommonDirOf(code) !== null
  ) {
    throw new Error(
      "storage root must use a different git repository from the code checkout",
    );
  }
  const projectDir = path.join(realStorage, project);
  if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir);
  assertProjectDirectory(realStorage, projectDir);
  const bindingPath = path.join(projectDir, BINDING_FILENAME);
  if (fs.existsSync(bindingPath)) {
    checkBinding(projectDir, project, code);
  } else {
    if (fs.readdirSync(projectDir).length > 0) {
      throw new Error(
        "external project directory has data but no project binding: " +
          projectDir,
      );
    }
    const gitCommonDir = gitCommonDirOf(code);
    writeFileAtomic(
      bindingPath,
      JSON.stringify(
        {
          name: project,
          codeRoot: code,
          ...(gitCommonDir ? { gitCommonDir } : {}),
        },
        null,
        2,
      ) + "\n",
    );
  }
  const ignorePath = path.join(realStorage, ".gitignore");
  if (!fs.existsSync(ignorePath)) {
    writeFileAtomic(
      ignorePath,
      "**/.runtime/\n**/__pycache__/\n**/*.pyc\n**/.backup-*/\n",
    );
  }
  return { project, projectDir, storageRoot: realStorage };
}

function findEnclosingGitRoot(start: string): string | null {
  let cur = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Write the project-root `.treills.conf.json` locator config (D3).
 */
export function writeRootConfig(
  codeRoot: string,
  storageRoot: string,
  project: string,
): void {
  writeFileAtomic(
    path.join(codeRoot, CONF_FILENAME),
    JSON.stringify({ storage: storageRoot, project }, null, 2) + "\n",
  );
}

/**
 * Create the in-project `.trellis` browse link (D4). POSIX uses a directory
 * symlink; Windows uses a junction so no symlink privilege is needed. An
 * existing correct link is a no-op; an existing real directory is NEVER
 * overwritten (returns false — the caller reports it).
 */
export function createBrowseLink(
  codeRoot: string,
  projectDir: string,
): { ok: boolean; reason?: string } {
  const linkPath = path.join(codeRoot, DIR_NAMES.WORKFLOW);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(linkPath);
  } catch {
    // No entry — create below.
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(linkPath);
      if (
        path.resolve(path.dirname(linkPath), target) ===
        path.resolve(projectDir)
      ) {
        excludeBrowseLink(codeRoot);
        return { ok: true };
      }
      // Wrong target: repointable (design §9) — replace the link, never data.
      try {
        fs.unlinkSync(linkPath);
        fs.symlinkSync(
          projectDir,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        excludeBrowseLink(codeRoot);
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    }
    if (stat.isDirectory()) {
      return { ok: false, reason: "real directory exists" };
    }
    return { ok: false, reason: "non-directory entry exists" };
  }
  try {
    fs.symlinkSync(
      projectDir,
      linkPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    excludeBrowseLink(codeRoot);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Keep the machine-specific link out of this local Git repository's index. */
function excludeBrowseLink(codeRoot: string): void {
  let excludePath: string;
  try {
    excludePath = path.resolve(
      codeRoot,
      execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
        cwd: codeRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return; // Plain code directories have no Git exclusion file.
  }
  const previous = fs.existsSync(excludePath)
    ? fs.readFileSync(excludePath, "utf8")
    : "";
  if (previous.split(/\r?\n/).includes("/.trellis")) return;
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  writeFileAtomic(
    excludePath,
    previous +
      (previous && !previous.endsWith("\n") ? "\n" : "") +
      "/.trellis\n",
  );
}

/**
 * True when the code root carries a root config (external storage mode).
 */
export function isExternalMode(codeRoot: string): boolean {
  return fs.existsSync(path.join(codeRoot, CONF_FILENAME));
}
