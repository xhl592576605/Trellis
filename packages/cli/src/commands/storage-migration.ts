/**
 * Explicit storage migration (`trellis update --migrate-storage`), design §8.
 *
 * Moves a legacy in-repo `.trellis` into the external local store as one
 * resumable transaction:
 *
 *   probe → prepare storage → copy + verify → split records → storage
 *   commit → write root config → swap (rename source to an explicit
 *   backup, create browse link) → verify config execution.
 *
 * The source is never deleted — the swap renames it to
 * `.trellis.pre-migration.<timestamp>/`, which IS the user's recovery copy.
 * An immutable import image and a checkout-scoped checkpoint make retries
 * resume without recopying over newer destination data.
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import path from "node:path";
import os from "node:os";
import { validateProjectName } from "../templates/shared-hooks/external-store.js";

import chalk from "chalk";

import { withStorageMigrationLock } from "../utils/storage-migration-lock.js";
import { productFiles, commitStorageFiles } from "../utils/storage-update.js";
import { VERSION } from "../constants/version.js";
import { DIR_NAMES } from "../constants/paths.js";
import {
  DEFAULT_STORAGE_ROOT,
  checkoutKey,
  createBrowseLink,
  isExternalMode,
  prepareExternalStorage,
  readExternalStore,
  writeRootConfig,
} from "../utils/external-store.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { ensureGitattributes } from "../configurators/workflow.js";
import {
  HASHES_SCHEMA_VERSION,
  loadHashes,
  computeHash,
} from "../utils/template-hash.js";

export interface StorageMigrationOptions {
  /** Storage root override (default `~/.trellis-wiki`). */
  storage?: string;
  /** External project directory name (default: code root basename). */
  project?: string;
  /** Primary developer dir when the legacy workspace has several. */
  workspace?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** Legacy entries that never become external product data. */
const SKIP_COPY_NAMES = new Set([
  ".runtime",
  "__pycache__",
  ".developer",
  ".current-task",
  ".template-hashes.json",
  ".version",
  ".git",
  ".gitattributes",
  ".cache",
  "worktrees",
]);

/** OS-generated metadata files (Finder/Explorer junk). Never migrated. */
const JUNK_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

function skippedByCopy(relSegments: string[]): boolean {
  const first = relSegments[0] ?? "";
  if (SKIP_COPY_NAMES.has(first)) return true;
  if (first.startsWith(".backup-")) return true;
  if (relSegments.includes("__pycache__")) return true;
  if (relSegments.some((name) => JUNK_FILE_NAMES.has(name))) return true;
  const last = relSegments[relSegments.length - 1] ?? "";
  return last.endsWith(".pyc");
}

/** Count OS junk files anywhere under the legacy tree, for the report. */
function countJunkFiles(source: string): number {
  let count = 0;
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (JUNK_FILE_NAMES.has(entry.name)) {
        count += 1;
        continue;
      }
      const rel = [...segments, entry.name];
      if (skippedByCopy(rel)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(source, []);
  return count;
}

function readDeveloperName(trellisDir: string): string | null {
  const devFile = path.join(trellisDir, ".developer");
  if (!fs.existsSync(devFile)) return null;
  const match = fs
    .readFileSync(devFile, "utf-8")
    .match(/^\s*name\s*=\s*(.+?)\s*$/m);
  return match?.[1] ?? null;
}

/** First non-empty trimmed value, or null (for `??`-friendly fallbacks). */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  return null;
}

interface WorkspacePlan {
  /** Flatten this dev dir to workspace/ (null = already flat). */
  primaryDev: string | null;
  /** Other dev dirs preserved under workspace/history/. */
  historyDevs: string[];
}

function planWorkspaceConversion(
  trellisDir: string,
  forced: string | undefined,
): WorkspacePlan {
  const wsDir = path.join(trellisDir, DIR_NAMES.WORKSPACE);
  if (!fs.existsSync(wsDir)) return { primaryDev: null, historyDevs: [] };
  const devDirs = fs
    .readdirSync(wsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "history")
    .map((e) => e.name)
    .sort();
  if (devDirs.length === 0) return { primaryDev: null, historyDevs: [] };
  if (devDirs.length === 1) {
    return { primaryDev: devDirs[0] as string, historyDevs: [] };
  }
  const developer = readDeveloperName(trellisDir);
  const primary =
    forced ??
    (developer && devDirs.includes(developer) ? developer : undefined);
  if (!primary) {
    throw new Error(
      `legacy workspace holds ${devDirs.length} developer directories (${devDirs.join(", ")}). ` +
        "Pass --workspace <name> to choose which one becomes the active flat workspace; " +
        "the others are preserved under workspace/history/.",
    );
  }
  if (!devDirs.includes(primary)) {
    throw new Error(
      `--workspace '${primary}' is not one of the legacy developer directories: ${devDirs.join(", ")}`,
    );
  }
  return {
    primaryDev: primary,
    historyDevs: devDirs.filter((d) => d !== primary),
  };
}

/** Reject linked input before copying: relocating a relative link changes its meaning. */
function sourceDigest(source: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = [...segments, entry.name];
      if (skippedByCopy(rel)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(
          "Resolve symlinks/unsupported objects before storage migration: " +
            abs,
        );
      }
      hash.update(JSON.stringify([rel, entry.isDirectory()]));
      if (entry.isDirectory()) walk(abs, rel);
      else hash.update(fs.readFileSync(abs));
    }
  };
  walk(source, []);
  return hash.digest("hex");
}

function copyData(source: string, dest: string): void {
  fs.cpSync(source, dest, {
    recursive: true,
    filter: (candidate: string) =>
      candidate === source ||
      !skippedByCopy(path.relative(source, candidate).split(path.sep)),
  });
}

function verifyCopy(source: string, dest: string): number {
  const mismatches: string[] = [];
  let verified = 0;
  const walk = (dir: string, relSegments: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = [...relSegments, entry.name];
      if (skippedByCopy(rel)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      verified += 1;
      const target = path.join(dest, ...rel);
      if (!fs.existsSync(target)) {
        mismatches.push(rel.join("/"));
        continue;
      }
      const a = fs.readFileSync(abs);
      const b = fs.readFileSync(target);
      if (Buffer.compare(a, b) !== 0) mismatches.push(rel.join("/"));
    }
  };
  walk(source, []);
  if (mismatches.length > 0) {
    throw new Error(
      `storage copy verification failed for ${mismatches.length} file(s), e.g. ${mismatches[0]}. ` +
        "Nothing was switched — the legacy .trellis tree is untouched; fix the storage issue and re-run.",
    );
  }
  return verified;
}

function convertWorkspace(projectDir: string, plan: WorkspacePlan): void {
  const ws = path.join(projectDir, DIR_NAMES.WORKSPACE);
  if (!fs.existsSync(ws) || plan.primaryDev === null) return;
  const srcDir = path.join(ws, plan.primaryDev);
  if (!fs.existsSync(srcDir)) return; // already converted (retry)
  // Legacy workspace/index.md is an author directory, while the selected
  // author has an index with the same name. Preserve both.
  const rootIndex = path.join(ws, "index.md");
  if (fs.existsSync(rootIndex)) {
    const history = path.join(ws, "history");
    fs.mkdirSync(history, { recursive: true });
    const historicalIndex = path.join(history, "index.md");
    if (fs.existsSync(historicalIndex))
      throw new Error("workspace history index conflict: " + historicalIndex);
    fs.renameSync(rootIndex, historicalIndex);
  }
  for (const entry of fs.readdirSync(srcDir)) {
    const dest = path.join(ws, entry);
    if (fs.existsSync(dest)) {
      throw new Error(
        `workspace conversion conflict: ${dest} already exists. Resolve by hand, then re-run.`,
      );
    }
    fs.renameSync(path.join(srcDir, entry), dest);
  }
  fs.rmdirSync(srcDir);
  for (const dev of plan.historyDevs) {
    const histDir = path.join(ws, "history");
    fs.mkdirSync(histDir, { recursive: true });
    const dest = path.join(histDir, dev);
    if (fs.existsSync(dest))
      throw new Error("workspace history conflict: " + dest);
    fs.renameSync(path.join(ws, dev), dest);
  }
}

function splitHashRecords(
  cwd: string,
  projectDir: string,
): { shared: number; checkout: number } {
  const hashes = loadHashes(cwd); // legacy: full logical map
  const shared: Record<string, string> = {};
  const checkout: Record<string, string> = {};
  for (const [key, value] of Object.entries(hashes)) {
    if (
      key === `${DIR_NAMES.WORKFLOW}` ||
      key.startsWith(`${DIR_NAMES.WORKFLOW}/`)
    ) {
      shared[key] = value;
    } else {
      checkout[key] = value;
    }
  }
  const write = (filePath: string, entries: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileAtomic(
      filePath,
      JSON.stringify(
        { __version: HASHES_SCHEMA_VERSION, hashes: entries },
        null,
        2,
      ) + "\n",
    );
  };
  write(path.join(projectDir, ".template-hashes.json"), shared);
  const runtimeDir = path.join(
    projectDir,
    ".runtime",
    "checkouts",
    checkoutKey(cwd),
  );
  if (Object.keys(checkout).length > 0) {
    write(path.join(runtimeDir, ".template-hashes.json"), checkout);
  }
  return {
    shared: Object.keys(shared).length,
    checkout: Object.keys(checkout).length,
  };
}

const MigrationState = z
  .object({
    codeRoot: z.string(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    imageDigest: z.string().regex(/^[a-f0-9]{64}$/),
    infrastructure: z
      .object({
        ".gitignore": z.string().optional(),
        ".gitattributes": z.string().optional(),
      })
      .strict(),
    imageName: z.string().regex(/^storage-import-[a-zA-Z0-9]+$/),
    backupName: z.string().regex(/^\.trellis\.pre-migration\.[0-9TZ-]+$/),
    phase: z.enum([
      "prepared",
      "committed",
      "switched",
      "refreshed",
      "complete",
    ]),
    refreshHashes: z.record(z.string(), z.string().nullable()).optional(),
    refreshBefore: z.record(z.string(), z.string()).optional(),
    refreshKeys: z.array(z.string()).optional(),
    refreshTaskPrefix: z.string().optional(),
  })
  .strict();
type MigrationState = z.infer<typeof MigrationState>;

/** Publish only missing or identical snapshot bytes; never overwrite target edits. */
function publishImage(image: string, dest: string, copy: boolean): void {
  for (const entry of fs.readdirSync(image, { withFileTypes: true })) {
    const source = path.join(image, entry.name);
    const target = path.join(dest, entry.name);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(target);
    } catch {
      /* missing */
    }
    if (stat?.isSymbolicLink())
      throw new Error("Migration target link conflict: " + target);
    if (entry.isDirectory()) {
      if (stat && !stat.isDirectory())
        throw new Error("Migration target conflict: " + target);
      if (copy) fs.mkdirSync(target, { recursive: true });
      publishImage(source, target, copy);
    } else if (stat) {
      if (
        !stat.isFile() ||
        !fs.readFileSync(source).equals(fs.readFileSync(target))
      ) {
        throw new Error(
          "Migration target changed; refusing to overwrite: " + target,
        );
      }
    } else if (copy) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
}

function commitStorageImport(
  storageRoot: string,
  projectName: string,
  paths: string[],
): void {
  try {
    commitStorageFiles(
      storageRoot,
      paths,
      `chore(${projectName}): import external workflow data`,
    );
  } catch (error) {
    throw new Error(
      "Storage import commit failed; source and checkpoint preserved. Fix Git identity/hooks/locks and rerun --migrate-storage.",
      { cause: error },
    );
  }
}

/** Explicit, checkpointed migration. No data is deleted and retries never recopy over edits. */
export async function runStorageMigration(
  cwd: string,
  options: StorageMigrationOptions,
  refreshIntegrations: () => Promise<void>,
): Promise<void> {
  const codeRoot = fs.realpathSync(cwd);
  const trellisPath = path.join(codeRoot, DIR_NAMES.WORKFLOW);
  const existing = readExternalStore(codeRoot);
  if (!existing && fs.existsSync(path.join(trellisPath, "project.json"))) {
    throw new Error(
      "Legacy project.json conflicts with the external binding; move it aside before migration.",
    );
  }
  const projectName =
    nonEmpty(options.project) ?? existing?.project ?? path.basename(codeRoot);
  const storageArg =
    nonEmpty(options.storage) ?? existing?.storageRoot ?? DEFAULT_STORAGE_ROOT;
  validateProjectName(projectName);
  const expanded =
    storageArg === "~"
      ? os.homedir()
      : /^~[/\\]/.test(storageArg)
        ? path.join(os.homedir(), storageArg.slice(2))
        : storageArg;
  const candidateRoot = path.resolve(codeRoot, expanded);
  const checkpoint = path.join(
    candidateRoot,
    projectName,
    ".runtime",
    "checkouts",
    checkoutKey(codeRoot),
    "storage-migration.json",
  );
  const legacy = isLegacyLayout(codeRoot);
  // A committed checkpoint survives the rename-before-config crash window.
  if (!existing && !legacy && !fs.existsSync(checkpoint)) {
    throw new Error(
      "Nothing to migrate: no legacy .trellis directory or migration checkpoint.",
    );
  }
  const workspacePlan = legacy
    ? planWorkspaceConversion(
        trellisPath,
        nonEmpty(options.workspace) ?? undefined,
      )
    : null;
  // Traverse before preparing any destination, including for a dry run.
  const digest = legacy ? sourceDigest(trellisPath) : null;
  console.log(chalk.bold("\nTrellis storage migration: " + projectName));
  console.log("  Storage: " + storageArg);
  if (options.dryRun) {
    console.log(
      chalk.gray(
        "Dry run — no storage, config, backups or browse links modified.",
      ),
    );
    return;
  }
  const infrastructure = [".gitignore", ".gitattributes"].filter(
    (name) => !fs.existsSync(path.join(candidateRoot, name)),
  );
  const store =
    existing ?? prepareExternalStorage(storageArg, projectName, codeRoot);
  await withStorageMigrationLock(
    codeRoot,
    store.storageRoot,
    store.projectDir,
    async () => {
      const runtime = path.join(
        store.projectDir,
        ".runtime",
        "checkouts",
        checkoutKey(codeRoot),
      );
      const statePath = path.join(runtime, "storage-migration.json");
      let state: MigrationState;
      if (fs.existsSync(statePath)) {
        state = MigrationState.parse(
          JSON.parse(fs.readFileSync(statePath, "utf8")),
        );
        if (state.codeRoot !== codeRoot)
          throw new Error("Migration checkpoint belongs to another checkout.");
      } else if (existing) {
        createBrowseLink(codeRoot, store.projectDir);
        console.log(
          chalk.green(
            "This project already uses external storage: " + store.projectDir,
          ),
        );
        return;
      } else {
        // An init-created or another checkout's project is not an import target.
        if (
          fs
            .readdirSync(store.projectDir)
            .some((name) => name !== "project.json" && name !== ".runtime")
        ) {
          throw new Error(
            "Migration target already contains product data; choose a new project name.",
          );
        }
        fs.mkdirSync(runtime, { recursive: true });
        const image = fs.mkdtempSync(path.join(runtime, "storage-import-"));
        copyData(trellisPath, image);
        verifyCopy(trellisPath, image);
        const junk = countJunkFiles(trellisPath);
        if (junk > 0) {
          console.log(
            chalk.gray(
              `Skipped ${junk} OS junk file(s) (.DS_Store/Thumbs.db).`,
            ),
          );
        }
        if (workspacePlan) convertWorkspace(image, workspacePlan);
        const version = path.join(trellisPath, ".version");
        if (fs.existsSync(version))
          fs.copyFileSync(version, path.join(image, ".version"));
        splitHashRecords(codeRoot, image);
        ensureGitattributes(store.storageRoot, true);
        state = {
          codeRoot,
          sourceDigest: digest ?? "",
          imageDigest: sourceDigest(image),
          infrastructure: Object.fromEntries(
            infrastructure.map((name) => [
              name,
              createHash("sha256")
                .update(fs.readFileSync(path.join(store.storageRoot, name)))
                .digest("hex"),
            ]),
          ),
          imageName: path.basename(image),
          backupName:
            ".trellis.pre-migration." +
            new Date().toISOString().replace(/[:.]/g, "-"),
          phase: "prepared",
        };
        writeFileAtomic(statePath, JSON.stringify(state));
      }
      if (state.phase === "complete") {
        const link = createBrowseLink(codeRoot, store.projectDir);
        if (!link.ok)
          throw new Error("Cannot repair browse link: " + link.reason);
        console.log(
          chalk.green(
            "This project already uses external storage: " + store.projectDir,
          ),
        );
        return;
      }
      const image = path.join(runtime, state.imageName);
      if (state.phase === "prepared") {
        if (sourceDigest(trellisPath) !== state.sourceDigest)
          throw new Error(
            "Legacy source changed since migration checkpoint; original and snapshot preserved.",
          );
        if (sourceDigest(image) !== state.imageDigest)
          throw new Error(
            "Migration import snapshot changed; refusing to publish it.",
          );
        for (const [name, hash] of Object.entries(state.infrastructure)) {
          if (
            createHash("sha256")
              .update(fs.readFileSync(path.join(store.storageRoot, name)))
              .digest("hex") !== hash
          ) {
            throw new Error(
              "Migration infrastructure changed; refusing to commit it: " +
                name,
            );
          }
        }
        // Complete validation before the first destination write.
        publishImage(image, store.projectDir, false);
        publishImage(image, store.projectDir, true);
        commitStorageImport(store.storageRoot, projectName, [
          ...["project.json", ...Object.keys(productFiles(image))].map(
            (name) => projectName + "/" + name,
          ),
          ...Object.keys(state.infrastructure),
        ]);
        state.phase = "committed";
        writeFileAtomic(statePath, JSON.stringify(state));
      }
      const backupPath = path.join(codeRoot, state.backupName);
      if (state.phase === "committed") {
        if (
          isLegacyLayout(codeRoot) ||
          (!fs
            .lstatSync(trellisPath, { throwIfNoEntry: false })
            ?.isSymbolicLink() &&
            fs.existsSync(trellisPath))
        ) {
          if (sourceDigest(trellisPath) !== state.sourceDigest)
            throw new Error(
              "Legacy source changed before switch; refusing to rename it.",
            );
          if (fs.existsSync(backupPath))
            throw new Error("Migration backup already exists: " + backupPath);
          fs.renameSync(trellisPath, backupPath);
        }
        // The checkpoint also recovers a crash between rename and config write.
        if (!fs.existsSync(backupPath))
          throw new Error("Migration source backup is missing: " + backupPath);
        writeRootConfig(codeRoot, store.storageRoot, projectName);
        state.phase = "switched";
        writeFileAtomic(statePath, JSON.stringify(state));
      }
      const link = createBrowseLink(codeRoot, store.projectDir);
      if (!link.ok)
        console.log(chalk.yellow("Browse link unavailable: " + link.reason));
      // Update current-checkout hooks and the copied legacy runtime together;
      // no manual second command is required to obtain config-aware execution.
      if (state.phase === "switched") {
        const current = productFiles(store.projectDir);
        const hashes = loadHashes(codeRoot);
        if (state.refreshBefore) {
          // An interrupted refresh may have published files before its final
          // checkpoint. Only accept changed templates that still match their
          // installation receipts; newer manual edits need human attribution.
          for (const [key, hash] of Object.entries(hashes)) {
            if (!key.startsWith(".trellis/")) continue;
            const name = key.slice(".trellis/".length);
            if (
              current[name] &&
              current[name] !== state.refreshBefore[name] &&
              computeHash(
                fs.readFileSync(path.join(store.projectDir, name), "utf8"),
              ) !== hash
            ) {
              throw new Error(
                "Interrupted refresh has unowned template edits: " + name,
              );
            }
          }
        } else {
          state.refreshBefore = current;
          state.refreshKeys = Object.keys(hashes)
            .filter((key) => key.startsWith(".trellis/"))
            .map((key) => key.slice(".trellis/".length));
          const today = new Date();
          state.refreshTaskPrefix =
            "tasks/" +
            String(today.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(today.getDate()).padStart(2, "0") +
            "-migrate-to-" +
            VERSION +
            "/";
          writeFileAtomic(statePath, JSON.stringify(state));
        }
        await refreshIntegrations();
        const after = productFiles(store.projectDir);
        const allowed = new Set([
          ...(state.refreshKeys ?? []),
          ".version",
          ".template-hashes.json",
          ...Object.keys(loadHashes(codeRoot))
            .filter((key) => key.startsWith(".trellis/"))
            .map((key) => key.slice(".trellis/".length)),
        ]);
        state.refreshHashes = {};
        for (const name of new Set([
          ...Object.keys(state.refreshBefore),
          ...Object.keys(after),
        ])) {
          if (
            !allowed.has(name) &&
            !name.startsWith(state.refreshTaskPrefix ?? "tasks/__invalid__/")
          )
            continue;
          if (state.refreshBefore[name] !== after[name])
            state.refreshHashes[name] = after[name] ?? null;
        }
        state.phase = "refreshed";
        writeFileAtomic(statePath, JSON.stringify(state));
      }
      const actual = productFiles(store.projectDir);
      for (const [name, hash] of Object.entries(state.refreshHashes ?? {})) {
        if ((actual[name] ?? null) !== hash)
          throw new Error(
            "Migration refresh target changed; refusing to commit: " + name,
          );
      }
      commitStorageImport(
        store.storageRoot,
        projectName,
        Object.keys(state.refreshHashes ?? {}).map(
          (name) => projectName + "/" + name,
        ),
      );
      if (!readExternalStore(codeRoot))
        throw new Error("Migration config verification failed.");
      state.phase = "complete";
      writeFileAtomic(statePath, JSON.stringify(state));
      console.log(chalk.green("Migrated data to " + store.projectDir));
      console.log(chalk.green("Original tree preserved at: " + backupPath));
      console.log(
        "Commit the code-repository changes yourself after reviewing the migration.",
      );
    },
  );
}

/** True when this checkout still runs the legacy in-repo layout. */
export function isLegacyLayout(cwd: string): boolean {
  if (isExternalMode(cwd)) return false;
  try {
    return fs.lstatSync(path.join(cwd, DIR_NAMES.WORKFLOW)).isDirectory();
  } catch {
    return false;
  }
}
