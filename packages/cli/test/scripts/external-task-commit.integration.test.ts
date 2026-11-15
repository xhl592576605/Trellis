/**
 * External storage task-level commits (stage 5 of the external local
 * storage design).
 *
 * Product data (tasks/workspace) lives in a SEPARATE local git repository
 * (the storage root) shared by every project under it. These tests pin the
 * two-repository contract:
 *
 *   - archive / journal auto-commits run in the STORAGE repo against
 *     project-scoped pathspecs; the code repo is never touched.
 *   - the storage repo is shared: another project's staged work, other
 *     tasks' dirty files and older archive entries must survive untouched.
 *   - a journal file holding a foreign uncommitted record must not be
 *     committed whole (mixed shared file → blocked, clearly unfinished).
 *   - a failed archive commit persists a recoverable pending state that the
 *     finish-work final journal step (`--require-commit`) flushes.
 *   - `session_auto_commit: false` cannot silently skip the finish-work
 *     final commit.
 *   - commit evidence resolves against the CODE repo; session numbering
 *     converges against STORAGE repo refs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_DIR = path.resolve(__dirname, "../../src/templates/trellis");

const PROJECT = "demo";
const CTX_ENV = { ...process.env, TRELLIS_CONTEXT_ID: "test-ctx" } as const;

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
  storage: string;
  projectDir: string;
  repo: string;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr}`,
    );
  }
  return r.stdout.trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  // Hermetic: never inherit a host's global excludes file.
  git(dir, "config", "core.excludesFile", "/dev/null");
}

function makeExternalFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-ext-commit-"));
  const storage = path.join(base, "storage");
  const projectDir = path.join(storage, PROJECT);
  const repo = path.join(base, "repo");

  // Storage repo: shared by every project, must have HEAD before scripts
  // classify records against it.
  initRepo(storage);
  fs.writeFileSync(
    path.join(storage, ".gitignore"),
    "**/.runtime/\n**/__pycache__/\n**/*.pyc\n**/.backup-*/\n",
  );

  // External project dir with real scripts + binding, as init would stamp.
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(
    path.join(TEMPLATE_DIR, "scripts"),
    path.join(projectDir, "scripts"),
    {
      recursive: true,
    },
  );
  fs.copyFileSync(
    path.join(TEMPLATE_DIR, "workflow.md"),
    path.join(projectDir, "workflow.md"),
  );
  fs.writeFileSync(
    path.join(projectDir, "config.yaml"),
    "session_auto_commit: true\n",
  );
  fs.writeFileSync(
    path.join(projectDir, "project.json"),
    JSON.stringify({ name: PROJECT, codeRoot: repo }, null, 2) + "\n",
  );

  // Code repo.
  initRepo(repo);
  git(repo, "commit", "-q", "--allow-empty", "-m", "code initial");
  fs.writeFileSync(
    path.join(repo, ".treills.conf.json"),
    JSON.stringify({ storage, project: PROJECT }) + "\n",
  );
  // Binding needs the real git common dir of the code repo.
  const commonDir = git(repo, "rev-parse", "--git-common-dir");
  fs.writeFileSync(
    path.join(projectDir, "project.json"),
    JSON.stringify(
      {
        name: PROJECT,
        codeRoot: repo,
        gitCommonDir: path.resolve(repo, commonDir),
      },
      null,
      2,
    ) + "\n",
  );

  git(storage, "add", "-A");
  git(storage, "commit", "-q", "-m", "storage initial");

  return { base, storage, projectDir, repo };
}

function makeTask(fx: Fixture, name: string): string {
  const dir = path.join(fx.projectDir, "tasks", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "prd.md"),
    `# ${name}\n` + "x".repeat(40) + "\n",
  );
  fs.writeFileSync(
    path.join(dir, "task.json"),
    JSON.stringify({
      id: name,
      name,
      title: name,
      status: "in_progress",
      priority: "P2",
      createdAt: "2026-11-14",
      assignee: "tester",
      creator: "tester",
      subtasks: [],
      children: [],
      relatedFiles: [],
      meta: {},
    }) + "\n",
  );
  return dir;
}

function runPy(
  fx: Fixture,
  script: string,
  ...args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(fx.projectDir, "scripts", script), ...args],
    { cwd: fx.repo, encoding: "utf-8", env: CTX_ENV },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function addSession(
  fx: Fixture,
  title: string,
  ...extra: string[]
): { status: number | null; stdout: string; stderr: string } {
  return runPy(fx, "add_session.py", "--title", title, ...extra);
}

function headFiles(fx: Fixture): string[] {
  return git(fx.storage, "show", "HEAD", "--name-only", "--pretty=format:")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function storageLog(fx: Fixture): string[] {
  return git(fx.storage, "log", "--pretty=%s").split("\n");
}

describe.skipIf(!hasPython() || process.platform === "win32")(
  "external storage task-level commits",
  () => {
    let fx: Fixture;

    beforeEach(() => {
      fx = makeExternalFixture();
    });

    afterEach(() => {
      fs.rmSync(fx.base, { recursive: true, force: true });
    });

    it("serializes simultaneous commits from two projects sharing a storage repo", async () => {
      const otherRepo = path.join(fx.base, "other-code");
      const otherData = path.join(fx.storage, "other");
      initRepo(otherRepo);
      fs.cpSync(fx.projectDir, otherData, { recursive: true });
      fs.writeFileSync(
        path.join(otherData, "project.json"),
        JSON.stringify({ name: "other", codeRoot: otherRepo }),
      );
      fs.writeFileSync(
        path.join(otherRepo, ".treills.conf.json"),
        JSON.stringify({ storage: fx.storage, project: "other" }),
      );
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "both projects");
      const record = (
        repo: string,
        data: string,
        title: string,
      ): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            "python3",
            [
              path.join(data, "scripts", "add_session.py"),
              "--title",
              title,
              "--require-commit",
            ],
            {
              cwd: repo,
              env: { ...CTX_ENV, TRELLIS_CONTEXT_ID: title },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stderr = "";
          child.stdout.resume();
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(stderr)),
          );
        });
      await Promise.all([
        record(fx.repo, fx.projectDir, "project-one"),
        record(otherRepo, otherData, "project-two"),
      ]);
      for (const oid of git(fx.storage, "rev-list", "-2", "HEAD").split("\n")) {
        const files = git(
          fx.storage,
          "show",
          "--pretty=format:",
          "--name-only",
          oid,
        ).split("\n");
        expect(new Set(files.map((file) => file.split("/")[0])).size).toBe(1);
      }
      expect(git(fx.storage, "status", "--porcelain")).toBe("");
    });

    it("commits the archive in the storage repo, scoped to this task only", () => {
      makeTask(fx, "alpha");
      makeTask(fx, "beta");
      // An older archived task with a dirty (uncommitted) edit.
      const oldArchived = path.join(
        fx.projectDir,
        "tasks",
        "archive",
        "2026-01",
        "old-task",
      );
      fs.mkdirSync(oldArchived, { recursive: true });
      fs.writeFileSync(
        path.join(oldArchived, "task.json"),
        '{"status":"completed"}\n',
      );
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-q", "-m", "tasks initial");

      // Foreign work: another project's staged file in the SHARED repo.
      const otherProj = path.join(fx.storage, "other-project");
      fs.mkdirSync(otherProj, { recursive: true });
      fs.writeFileSync(path.join(otherProj, "note.txt"), "other project\n");
      git(fx.storage, "add", "other-project/note.txt");

      // Dirty sibling task + dirty older archive entry.
      fs.appendFileSync(
        path.join(fx.projectDir, "tasks", "beta", "prd.md"),
        "DIRTY BETA\n",
      );
      fs.appendFileSync(path.join(oldArchived, "task.json"), "\n");

      const r = runPy(fx, "task.py", "archive", "alpha");
      expect(r.status, r.stderr).toBe(0);

      // The archive commit landed in the storage repo, scoped to alpha.
      const files = headFiles(fx);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((f) => f.startsWith(`${PROJECT}/tasks/`))).toBe(true);
      expect(files.some((f) => f.startsWith(`${PROJECT}/tasks/alpha/`))).toBe(
        true,
      );
      expect(
        files.some(
          (f) =>
            f.startsWith(`${PROJECT}/tasks/archive/`) && f.includes("alpha"),
        ),
      ).toBe(true);

      // NOT the sibling task, NOT the older archive entry.
      expect(files.some((f) => f.includes("/beta/"))).toBe(false);
      expect(files.some((f) => f.includes("/old-task/"))).toBe(false);

      // The code repo was not touched.
      expect(git(fx.repo, "log", "--pretty=%s")).toEqual(
        ["code initial"].join("\n"),
      );

      // Foreign staged file still staged; dirty files still in the worktree.
      const status = git(fx.storage, "status", "--porcelain");
      expect(status).toMatch(/^A\s+other-project\/note\.txt/m);
      expect(status).toMatch(new RegExp(`M\\s+${PROJECT}/tasks/beta/prd\\.md`));
      expect(status).toMatch(
        new RegExp(
          `M\\s+${PROJECT}/tasks/archive/2026-01/old-task/task\\.json`,
        ),
      );
    });

    it("blocks the journal commit while a foreign uncommitted record shares the journal", () => {
      // Session A writes a record but its commit never happens.
      expect(addSession(fx, "first record", "--no-commit").status).toBe(0);
      const logBefore = storageLog(fx).length;

      // Session B must not bundle A's pending record into its own commit.
      const r = addSession(
        fx,
        "second record",
        "--idempotency-key",
        "second-record",
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/another session|mixed/i);

      // Nothing was committed; both records survive on disk.
      expect(storageLog(fx).length).toBe(logBefore);
      const journal = fs.readFileSync(
        path.join(fx.projectDir, "workspace", "journal-1.md"),
        "utf8",
      );
      expect(journal).toContain("first record");
      expect(journal).toContain("second record");

      // A human resolves the mixed file; B's retry must resume, not append.
      git(fx.storage, "add", `${PROJECT}/workspace`);
      git(fx.storage, "commit", "-q", "-m", "manual resolve");
      const retry = addSession(
        fx,
        "second record",
        "--idempotency-key",
        "second-record",
      );
      expect(retry.status, retry.stderr).toBe(0);
      expect(retry.stderr).toMatch(/already recorded and committed/i);
      const journalAfter = fs.readFileSync(
        path.join(fx.projectDir, "workspace", "journal-1.md"),
        "utf8",
      );
      expect(journalAfter.match(/## Session \d+:/g)?.length).toBe(2);
    });

    it("persists a failed archive commit and flushes it via add_session --require-commit", () => {
      makeTask(fx, "alpha");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-q", "-m", "tasks initial");

      // Make the storage repo reject commits (pre-commit hook).
      const hooks = path.join(fx.base, "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
      fs.chmodSync(path.join(hooks, "pre-commit"), 0o755);
      git(fx.storage, "config", "core.hooksPath", hooks);

      const r = runPy(fx, "task.py", "archive", "alpha");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/pending/i);

      // Recovery state persisted under the project runtime dir.
      const pending = path.join(
        fx.projectDir,
        ".runtime",
        "pending-task-commit.json",
      );
      expect(fs.existsSync(pending)).toBe(true);
      const pendingList = JSON.parse(fs.readFileSync(pending, "utf8")).pending;
      expect(Array.isArray(pendingList)).toBe(true);
      expect(pendingList.length).toBe(1);
      const state = pendingList[0];
      expect(state.task).toBe("alpha");
      expect(state.dest).toContain("archive/");

      // The archive did not complete: no archive commit in storage.
      expect(storageLog(fx)).not.toContain("chore(demo): archive task alpha");

      // Repair git, then the finish-work final step flushes the pending
      // archive commit AND the journal commit.
      git(fx.storage, "config", "--unset", "core.hooksPath");
      const flush = addSession(fx, "finish-work record", "--require-commit");
      expect(flush.status, flush.stderr).toBe(0);

      const log = storageLog(fx);
      expect(log).toContain("chore(demo): archive task alpha");
      expect(log.some((s) => s.includes("journal"))).toBe(true);
      expect(fs.existsSync(pending)).toBe(false);
      expect(
        git(fx.storage, "status", "--porcelain", "--", PROJECT + "/tasks"),
      ).toBe("");

      // The flushed archive commit is still precisely scoped.
      const archiveCommitFiles = git(
        fx.storage,
        "show",
        "--name-only",
        "--pretty=format:",
        "--grep",
        "archive task alpha",
        "-1",
      )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(archiveCommitFiles.length).toBeGreaterThan(0);
      expect(
        archiveCommitFiles.every((f) => f.startsWith(`${PROJECT}/tasks/`)),
      ).toBe(true);
    });

    it("archives only the recorded destination when the same name exists in an older month", () => {
      makeTask(fx, "repeat");
      const old = path.join(
        fx.projectDir,
        "tasks",
        "archive",
        "2020-01",
        "repeat",
      );
      fs.mkdirSync(old, { recursive: true });
      fs.writeFileSync(path.join(old, "note.md"), "old\n");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "baseline");
      fs.appendFileSync(path.join(old, "note.md"), "foreign edit\n");
      const result = runPy(fx, "task.py", "archive", "repeat");
      expect(result.status, result.stderr).toBe(0);
      expect(headFiles(fx).some((name) => name.includes("2020-01"))).toBe(
        false,
      );
      expect(git(fx.storage, "status", "--porcelain")).toContain(
        "2020-01/repeat/note.md",
      );
    });

    it("--no-commit archives remain discoverable by the final session commit", () => {
      makeTask(fx, "alpha");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "tasks initial");
      expect(
        runPy(fx, "task.py", "archive", "alpha", "--no-commit").status,
      ).toBe(0);
      const result = addSession(fx, "final record", "--require-commit");
      expect(result.status, result.stderr).toBe(0);
      expect(storageLog(fx)).toContain("chore(demo): archive task alpha");
      expect(
        git(fx.storage, "status", "--porcelain", "--", PROJECT + "/tasks"),
      ).toBe("");
    });

    it("does not flush another session's pending archive", () => {
      makeTask(fx, "foreign");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "tasks initial");
      expect(
        runPy(fx, "task.py", "archive", "foreign", "--no-commit").status,
      ).toBe(0);
      const result = spawnSync(
        "python3",
        [
          path.join(fx.projectDir, "scripts", "add_session.py"),
          "--title",
          "other session",
          "--require-commit",
        ],
        {
          cwd: fx.repo,
          encoding: "utf8",
          env: { ...CTX_ENV, TRELLIS_CONTEXT_ID: "other-context" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(storageLog(fx)).not.toContain("chore(demo): archive task foreign");
      expect(
        fs.existsSync(
          path.join(fx.projectDir, ".runtime", "pending-task-commit.json"),
        ),
      ).toBe(true);
      const recover = spawnSync(
        "python3",
        [
          path.join(fx.projectDir, "scripts", "add_session.py"),
          "--title",
          "explicit recovery",
          "--require-commit",
          "--recover-archive",
          "foreign",
        ],
        {
          cwd: fx.repo,
          encoding: "utf8",
          env: { ...CTX_ENV, TRELLIS_CONTEXT_ID: "other-context" },
        },
      );
      expect(recover.status, recover.stderr).toBe(0);
      expect(storageLog(fx)).toContain("chore(demo): archive task foreign");
    });

    it("blocks unmarked manual edits in shared journals", () => {
      expect(addSession(fx, "committed").status).toBe(0);
      const journal = path.join(fx.projectDir, "workspace", "journal-1.md");
      fs.appendFileSync(journal, "\nUNRELATED MANUAL EDIT\n");
      const before = storageLog(fx).length;
      const result = addSession(
        fx,
        "own record",
        "--require-commit",
        "--idempotency-key",
        "own",
      );
      expect(result.status, result.stderr).toBe(1);
      const retry = addSession(
        fx,
        "own record",
        "--require-commit",
        "--idempotency-key",
        "own",
      );
      expect(retry.status, retry.stderr).toBe(1);
      expect(storageLog(fx)).toHaveLength(before);
      expect(
        fs.readFileSync(journal, "utf8").match(/## Session [0-9]+:/g),
      ).toHaveLength(2);
    });

    it("session_auto_commit=false cannot silently skip the finish-work final commit", () => {
      fs.writeFileSync(
        path.join(fx.projectDir, "config.yaml"),
        "session_auto_commit: false\n",
      );

      const plain = addSession(fx, "mid-flow record");
      expect(plain.status).toBe(0);
      expect(plain.stderr).toMatch(/session_auto_commit: false/);
      expect(storageLog(fx).length).toBe(1); // only "storage initial"

      const logBefore = storageLog(fx).length;
      const final = addSession(fx, "mid-flow record", "--require-commit");
      expect(final.status, final.stderr).toBe(0);
      expect(final.stderr).toMatch(/require-commit/i);
      expect(storageLog(fx).length).toBe(logBefore + 1);
    });

    it("require-commit blocks foreign records even when automatic commits are disabled", () => {
      fs.writeFileSync(
        path.join(fx.projectDir, "config.yaml"),
        "session_auto_commit: false\n",
      );
      expect(addSession(fx, "foreign record").status).toBe(0);
      const before = storageLog(fx).length;
      const result = addSession(fx, "own record", "--require-commit");
      expect(result.status, result.stderr).toBe(1);
      expect(storageLog(fx)).toHaveLength(before);
    });

    it("a committed idempotency key still commits newly requested include files", () => {
      expect(
        addSession(fx, "done", "--idempotency-key", "done", "--require-commit")
          .status,
      ).toBe(0);
      const spec = path.join(fx.projectDir, "spec", "guide.md");
      fs.mkdirSync(path.dirname(spec), { recursive: true });
      fs.writeFileSync(spec, "# Later fix\n");
      const result = addSession(
        fx,
        "done",
        "--idempotency-key",
        "done",
        "--require-commit",
        "--include-path",
        "spec/guide.md",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(headFiles(fx)).toContain(PROJECT + "/spec/guide.md");
    });

    it("require-commit fails when Git ignores the journal", () => {
      fs.appendFileSync(path.join(fx.storage, ".gitignore"), "**/workspace/\n");
      const result = addSession(fx, "ignored", "--require-commit");
      expect(result.status, result.stderr).toBe(1);
    });

    it("resolves commit evidence in the code repo and numbers sessions across storage refs", () => {
      // A real code commit; the storage repo does NOT have this object.
      const codeFile = path.join(fx.repo, "feature.txt");
      fs.writeFileSync(codeFile, "code work\n");
      git(fx.repo, "add", "feature.txt");
      git(fx.repo, "commit", "-q", "-m", "feat: code work");
      const oid = git(fx.repo, "rev-parse", "--short", "HEAD");

      const r1 = addSession(fx, "session one", "--commit", oid);
      expect(r1.status, r1.stderr).toBe(0);
      const r2 = addSession(fx, "session two");
      expect(r2.status, r2.stderr).toBe(0);

      const journal = fs.readFileSync(
        path.join(fx.projectDir, "workspace", "journal-1.md"),
        "utf8",
      );
      expect(journal).toContain("feat: code work");
      expect(journal).toContain("## Session 1:");
      expect(journal).toContain("## Session 2:");

      // A parallel storage branch records session 3 and is not merged.
      git(fx.storage, "checkout", "-q", "-b", "feature");
      expect(addSession(fx, "parallel session").status).toBe(0);
      git(fx.storage, "checkout", "-q", "main");

      // Numbering must converge against storage refs: next is 4, not 3.
      expect(addSession(fx, "session four").status).toBe(0);
      const journalAfter = fs.readFileSync(
        path.join(fx.projectDir, "workspace", "journal-1.md"),
        "utf8",
      );
      expect(journalAfter).toContain("## Session 4:");
      expect(journalAfter).not.toContain("## Session 3: session four");

      // The journal commits stayed in the storage repo; the code repo has
      // exactly its own two commits.
      expect(git(fx.repo, "log", "--pretty=%s").split("\n").length).toBe(2);
    });

    it("refuses to mix a child's pre-existing metadata edits into an archive", () => {
      const parent = makeTask(fx, "parent");
      const child = makeTask(fx, "child");
      const parentJson = path.join(parent, "task.json");
      const childJson = path.join(child, "task.json");
      const parentData = JSON.parse(fs.readFileSync(parentJson, "utf8"));
      parentData.children = ["child"];
      fs.writeFileSync(parentJson, JSON.stringify(parentData));
      const childData = JSON.parse(fs.readFileSync(childJson, "utf8"));
      childData.parent = "parent";
      fs.writeFileSync(childJson, JSON.stringify(childData));
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "linked tasks");
      childData.title = "another task's uncommitted work";
      fs.writeFileSync(childJson, JSON.stringify(childData));
      const result = runPy(fx, "task.py", "archive", "parent");
      expect(result.status, result.stderr).toBe(1);
      expect(JSON.parse(fs.readFileSync(parentJson, "utf8")).status).toBe(
        "in_progress",
      );
      expect(JSON.parse(fs.readFileSync(childJson, "utf8"))).toEqual(childData);
    });

    it("include paths reject directories and include explicitly named tracked deletions", () => {
      const dir = path.join(fx.projectDir, "spec");
      fs.mkdirSync(dir);
      const file = path.join(dir, "old.md");
      fs.writeFileSync(file, "# Old\n");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-qm", "spec baseline");
      expect(addSession(fx, "directory", "--include-path", "spec").status).toBe(
        1,
      );
      // Fail-fast: the argument error leaves no half-recorded journal
      // behind, so there is nothing on disk to resolve.
      expect(
        fs.existsSync(path.join(fx.projectDir, "workspace")),
      ).toBe(false);
      fs.unlinkSync(file);
      const result = addSession(
        fx,
        "deletion",
        "--include-path",
        "spec/old.md",
        "--require-commit",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(headFiles(fx)).toContain(PROJECT + "/spec/old.md");
    });

    it("stages this session's spec edits via --include-path", () => {
      const specFile = path.join(fx.projectDir, "spec", "cli", "guide.md");
      fs.mkdirSync(path.dirname(specFile), { recursive: true });
      fs.writeFileSync(specFile, "# Guide v1\n");
      git(fx.storage, "add", "-A");
      git(fx.storage, "commit", "-q", "-m", "spec initial");
      fs.writeFileSync(specFile, "# Guide v2\n");

      // Absolute paths inside the project data directory are the form
      // platform docs receive after renderWorkflowPaths rewrites them.
      const r = addSession(
        fx,
        "spec session",
        "--include-path",
        specFile,
      );
      expect(r.status, r.stderr).toBe(0);

      const files = headFiles(fx);
      expect(files).toContain(`${PROJECT}/spec/cli/guide.md`);
      expect(files.some((f) => f.startsWith(`${PROJECT}/workspace/`))).toBe(
        true,
      );
    });
  },
);
