import fs from "node:fs";
import path from "node:path";
import { init } from "../../src/commands/init.js";
import { isCwdHomedir, homedirBypassEnabled } from "../../src/utils/cwd-guard.js";

/** Existing lifecycle tests exercise the legacy layout until explicit migration.
 * Fresh external initialization is covered in init-external-storage.integration.test.ts.
 */
export async function initLegacy(options: Parameters<typeof init>[0]): Promise<void> {
  if (!isCwdHomedir() || homedirBypassEnabled()) {
    fs.mkdirSync(path.join(process.cwd(), ".trellis"), { recursive: true });
  }
  await init(options);
}
