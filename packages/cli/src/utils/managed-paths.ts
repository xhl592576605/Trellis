import fs from "node:fs";
import path from "node:path";

import { isManagedPath, isManagedRootDir } from "../configurators/index.js";

export const TRELLIS_BLOCK_START = "<!-- TRELLIS:START -->";
export const TRELLIS_BLOCK_END = "<!-- TRELLIS:END -->";

/** Remove complete, unambiguous legacy blocks without normalizing user text.
 * Returns null when there is no block or any marker cannot be paired safely.
 */
export function removeTrellisManagedBlocks(content: string): string | null {
  const markers = [...content.matchAll(/<!-- TRELLIS:(START|END) -->/g)];
  if (markers.length === 0 || markers.length % 2 !== 0) return null;
  let result = "";
  let offset = 0;
  for (let i = 0; i < markers.length; i += 2) {
    const start = markers[i];
    const end = markers[i + 1];
    if (start[1] !== "START" || end[1] !== "END") return null;
    result += content.slice(offset, start.index);
    offset = end.index + end[0].length;
  }
  return result + content.slice(offset);
}

/** Remove empty managed parents without deleting a managed root directory. */
export function cleanupEmptyDirs(cwd: string, dirPath: string): void {
  const dirPosix = dirPath.replace(/\\/g, "/");
  const segments = dirPosix.split("/");

  if (
    path.posix.isAbsolute(dirPosix) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    !isManagedPath(dirPosix) ||
    isManagedRootDir(dirPosix)
  ) {
    return;
  }

  const canonicalCwd = fs.realpathSync(cwd);
  const fullPath = path.resolve(canonicalCwd, ...segments);
  const relative = path.relative(canonicalCwd, fullPath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return;
  }
  if (!fs.existsSync(fullPath)) return;

  try {
    const canonicalFullPath = fs.realpathSync(fullPath);
    const canonicalRelative = path.relative(canonicalCwd, canonicalFullPath);
    if (
      canonicalRelative === "" ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(canonicalRelative)
    ) {
      return;
    }

    const stat = fs.lstatSync(fullPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;

    if (fs.readdirSync(fullPath).length === 0) {
      fs.rmdirSync(fullPath);
      const parent = path.posix.dirname(dirPosix);
      if (parent !== "." && parent !== dirPosix && !isManagedRootDir(parent)) {
        cleanupEmptyDirs(cwd, parent);
      }
    }
  } catch {
    // Cleanup is best-effort; permission/race failures leave the directory.
  }
}
