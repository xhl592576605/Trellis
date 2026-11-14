/** Standalone resolver shared by the CLI and installed Node-based integrations. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

export function renderWorkflowPaths(content, projectDir) {
  return content.replace(/(?<![\w/\\])(?:\.\/)?\.trellis\/([^\s`"'<>]+)/g, (_match, suffix) => {
    const target = join(projectDir, suffix);
    if (process.platform === "win32") return '"' + target + '"';
    return /^[A-Za-z0-9_./:-]+$/.test(target) ? target : "'" + target.replaceAll("'", "'\\''") + "'";
  });
}

export const CONFIG_FILENAME = ".treills.conf.json";

export function validateProjectName(name) {
  if (typeof name !== "string" || !name || name !== name.trim() ||
      /[/\\:*?"<>|]/.test(name) || Array.from(name).some((c) => c.charCodeAt(0) < 32) || name.endsWith(".") ||
      [".", "..", ".git", ".runtime", ".trellis"].includes(name.toLowerCase()) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(
      "invalid project name " + JSON.stringify(name) + "; expected one non-reserved directory name",
    );
  }
  return name;
}

export function canonicalPath(value) {
  return realpathSync(resolve(value));
}

export function checkoutKey(codeRoot) {
  const root = canonicalPath(codeRoot);
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 16);
}

export function gitCommonDirOf(codeRoot) {
  try {
    const value = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: codeRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value ? canonicalPath(resolve(codeRoot, value)) : null;
  } catch {
    return null;
  }
}

export function assertProjectDirectory(storageRoot, projectDir) {
  if (dirname(canonicalPath(projectDir)) !== canonicalPath(storageRoot)) {
    throw new Error("external project directory escapes storage root: " + projectDir);
  }
}

export function checkBinding(projectDir, project, codeRoot) {
  const bindingPath = join(projectDir, "project.json");
  let binding;
  try {
    binding = JSON.parse(readFileSync(bindingPath, "utf8"));
  } catch (error) {
    throw new Error("cannot read project binding " + bindingPath + ": " + error.message);
  }
  if (!binding || binding.name !== project || typeof binding.codeRoot !== "string" || !isAbsolute(binding.codeRoot)) {
    throw new Error("invalid project binding: " + bindingPath);
  }
  const currentRoot = canonicalPath(codeRoot);
  // Git identity remains authoritative even if another repository replaces a checkout.
  if (binding.gitCommonDir !== undefined) {
    if (typeof binding.gitCommonDir !== "string" || !isAbsolute(binding.gitCommonDir) ||
        gitCommonDirOf(currentRoot) !== canonicalPath(binding.gitCommonDir)) {
      throw new Error("external project is bound to a different project: " + bindingPath);
    }
  } else if (canonicalPath(binding.codeRoot) !== currentRoot) {
    throw new Error("external project is bound to a different project: " + bindingPath);
  }
  return binding;
}

export function readExternalStore(codeRoot, configPath = join(codeRoot, CONFIG_FILENAME)) {
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    if (!raw || typeof raw.storage !== "string" || !raw.storage.trim()) {
      throw new Error("storage must be a non-empty string");
    }
    const project = validateProjectName(raw.project);
    const storageValue = raw.storage;
    if (storageValue.startsWith("~") && storageValue !== "~" && !/^~[/\\]/.test(storageValue)) {
      throw new Error("storage supports only ~ or ~/directory home expansion");
    }
    const expanded = storageValue === "~" ? homedir() : /^~[/\\]/.test(storageValue)
      ? join(homedir(), storageValue.slice(2)) : storageValue;
    const storageRoot = canonicalPath(isAbsolute(expanded) ? expanded : resolve(codeRoot, expanded));
    const projectDir = join(storageRoot, project);
    if (!statSync(projectDir).isDirectory()) throw new Error("external project dir is not a directory");
    assertProjectDirectory(storageRoot, projectDir);
    checkBinding(projectDir, project, codeRoot);
    const key = checkoutKey(codeRoot);
    return { codeRoot: canonicalPath(codeRoot), storageRoot, project, projectDir,
      checkoutKey: key, runtimeDir: join(projectDir, ".runtime", "checkouts", key) };
  } catch (error) {
    throw new Error("unusable root config " + configPath + ": " + error.message);
  }
}

export function workflowDirOf(codeRoot) {
  return readExternalStore(codeRoot)?.projectDir ?? join(codeRoot, ".trellis");
}

export function runtimeDirOf(codeRoot) {
  return readExternalStore(codeRoot)?.runtimeDir ?? join(codeRoot, ".trellis", ".runtime");
}

export function findCodeRoot(start) {
  let current = resolve(start);
  let legacy = null;
  while (true) {
    if (existsSync(join(current, CONFIG_FILENAME))) return current;
    if (legacy === null && existsSync(join(current, ".trellis")) && statSync(join(current, ".trellis")).isDirectory()) legacy = current;
    const parent = dirname(current);
    if (parent === current) return legacy;
    current = parent;
  }
}
