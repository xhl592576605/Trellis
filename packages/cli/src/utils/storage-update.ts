/** Product snapshots and exact storage commits shared by update and migration. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readExternalStore } from "./external-store.js";
import { writeFileAtomic } from "./atomic-write.js";
import { loadHashes } from "./template-hash.js";
import { withStorageMigrationLock } from "./storage-migration-lock.js";

const JUNK_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

/** Product files only; runtime/cache/backup bytes never enter a migration commit. */
export function productFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, rel: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const parts = [...rel, entry.name];
      if (
        parts.some(
          (name) =>
            [".runtime", ".git", ".cache", "worktrees", "__pycache__"].includes(
              name,
            ) ||
            name.startsWith(".backup-") ||
            JUNK_FILE_NAMES.has(name),
        ) ||
        entry.name.endsWith(".pyc")
      )
        continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), parts);
      else if (entry.isFile())
        files[parts.join("/")] = createHash("sha256")
          .update(fs.readFileSync(path.join(dir, entry.name)))
          .digest("hex");
    }
  };
  walk(root, []);
  return files;
}

export function commitStorageFiles(
  storageRoot: string,
  paths: string[],
  message: string,
): void {
  if (paths.length === 0) return;
  const specs = paths.map((name) => ":(literal)" + name);
  try {
    // A retry may already have staged deletions, which no longer exist in the
    // index. Keep them in the commit pathspec, but do not try to add them again.
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z", "--", ...specs], {
        cwd: storageRoot,
        encoding: "utf8",
        stdio: "pipe",
      }).split("\0"),
    );
    const toAdd = paths.filter(
      (name) =>
        fs.existsSync(path.join(storageRoot, name)) || tracked.has(name),
    );
    if (toAdd.length > 0)
      execFileSync(
        "git",
        ["add", "--", ...toAdd.map((name) => ":(literal)" + name)],
        {
          cwd: storageRoot,
          stdio: "pipe",
        },
      );
    const changed = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--", ...specs],
      {
        cwd: storageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!changed.trim()) return;
    execFileSync("git", ["commit", "-m", message, "--", ...specs], {
      cwd: storageRoot,
      stdio: "pipe",
    });
  } catch (error) {
    throw new Error(
      "Storage commit failed; output and checkpoint preserved. Fix Git identity/hooks/locks and rerun update.",
      { cause: error },
    );
  }
}

const pendingSchema = z.object({
  version: z.string(),
  files: z.record(
    z
      .string()
      .refine(
        (name) =>
          !name.includes("\\") &&
          name
            .split("/")
            .every(
              (part) =>
                part !== "" &&
                part !== "." &&
                part !== ".." &&
                ![
                  ".git",
                  ".runtime",
                  ".cache",
                  "worktrees",
                  "__pycache__",
                ].includes(part) &&
                !part.startsWith(".backup-"),
            ),
      ),
    z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  ),
});

/** Commit only this invocation's shared outputs; preserve unrelated staged work. */
export async function withStorageUpdate(
  codeRoot: string,
  version: string,
  migrationPaths: string[],
  action: () => Promise<void>,
): Promise<void> {
  const store = readExternalStore(codeRoot);
  if (!store) return action();
  await withStorageMigrationLock(
    codeRoot,
    store.storageRoot,
    store.projectDir,
    async () => {
      const receipt = path.join(store.runtimeDir, "update-commit.json");
      const finish = (pending: z.infer<typeof pendingSchema>): void => {
        const actual = productFiles(store.projectDir);
        for (const [name, hash] of Object.entries(pending.files)) {
          if (
            (actual[name] ?? null) !== hash ||
            (hash === null && fs.existsSync(path.join(store.projectDir, name)))
          ) {
            throw new Error(
              "Storage update output changed; review and commit manually before removing " +
                receipt +
                ": " +
                name,
            );
          }
        }
        commitStorageFiles(
          store.storageRoot,
          Object.keys(pending.files).map((name) => store.project + "/" + name),
          `chore(${store.project}): update workflow to ${pending.version}`,
        );
        fs.unlinkSync(receipt);
        console.log(
          "Committed wiki update for " +
            store.project +
            " (" +
            pending.version +
            ").",
        );
      };
      // Failed commits are retried before analysis: templates may already be current.
      if (fs.existsSync(receipt)) {
        finish(
          pendingSchema.parse(JSON.parse(fs.readFileSync(receipt, "utf8"))),
        );
      }
      const before = productFiles(store.projectDir);
      const managed = Object.keys(loadHashes(codeRoot));
      const today = new Date();
      const taskPrefix =
        "tasks/" +
        String(today.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(today.getDate()).padStart(2, "0") +
        "-migrate-to-" +
        version +
        "/";
      await action();
      const after = productFiles(store.projectDir);
      const allowed = new Set([".version", ".template-hashes.json"]);
      for (const key of [
        ...managed,
        ...Object.keys(loadHashes(codeRoot)),
        ...migrationPaths,
      ]) {
        if (!key.startsWith(".trellis/")) continue;
        const name = key.slice(".trellis/".length);
        if (/^(tasks|spec|workspace)(\/|$)/.test(name)) continue;
        allowed.add(name);
        allowed.add(name + ".new");
      }
      const files: Record<string, string | null> = {};
      for (const name of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        const owned =
          [...allowed].some(
            (key) => name === key || name.startsWith(key + "/"),
          ) ||
          (name.startsWith(taskPrefix) && !before[name]);
        if (owned && before[name] !== after[name])
          files[name] = after[name] ?? null;
      }
      if (Object.keys(files).length === 0) return;
      fs.mkdirSync(store.runtimeDir, { recursive: true });
      writeFileAtomic(receipt, JSON.stringify({ version, files }));
      finish({ version, files });
    },
  );
}
