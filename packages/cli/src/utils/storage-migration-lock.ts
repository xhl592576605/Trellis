/** Hold the same OS locks as Python journal/task writers across a migration. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getPythonCommandForPlatform } from "../configurators/shared.js";

// The child owns the OS file descriptors; EOF (including a parent crash)
// releases them. Import the bundled lock instead of a second lock protocol.
const LOCK_SCRIPT = String.raw`
import sys
from pathlib import Path
from common.data_git import DataGitContext, storage_commit_lock

code, storage, project = map(Path, sys.argv[1:])
workspace_lock = project / ".runtime" / "workspace.lock"
workspace_lock.parent.mkdir(parents=True, exist_ok=True)
with workspace_lock.open("a+b") as handle:
    if sys.platform == "win32":
        import msvcrt
        handle.write(b"\0")
        handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    with storage_commit_lock(DataGitContext(code, storage, project.name + "/")):
        print("ready", flush=True)
        sys.stdin.read()
`;

export async function withStorageMigrationLock<T>(
  codeRoot: string,
  storageRoot: string,
  projectDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const child = spawn(
    getPythonCommandForPlatform(),
    ["-c", LOCK_SCRIPT, codeRoot, storageRoot, projectDir],
    {
      cwd: fileURLToPath(
        new URL("../templates/trellis/scripts/", import.meta.url),
      ),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () =>
        reject(new Error("Cannot acquire storage migration locks: " + stderr)),
      );
      child.stdout.once("data", () => resolve());
    });
    return await action();
  } finally {
    child.stdin.end();
    await closed;
  }
}
