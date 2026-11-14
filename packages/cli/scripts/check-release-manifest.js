#!/usr/bin/env node
/**
 * Pre-release guard: the migration manifest for the target release version
 * MUST exist and carry complete release notes before `release:beta` /
 * `release:rc` / `release:promote` run.
 *
 * Replaces the old docs-site changelog gate. Release notes live in this
 * repository (src/migrations/manifests/<version>.json), so completeness is
 * checkable locally with no docs submodule or network access.
 *
 * Usage:
 *   node scripts/check-release-manifest.js --type beta
 *   node scripts/check-release-manifest.js --type rc
 *   node scripts/check-release-manifest.js --type promote
 *
 * Env overrides (used by the integration test to point at fixtures):
 *   TRELLIS_RELEASE_MANIFEST_DIR  defaults to ../src/migrations/manifests
 *   TRELLIS_RELEASE_CLI_PKG       defaults to ../package.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeNext } from "./bump-versions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = process.env.TRELLIS_RELEASE_MANIFEST_DIR
  ? path.resolve(process.env.TRELLIS_RELEASE_MANIFEST_DIR)
  : path.join(__dirname, "../src/migrations/manifests");
const CLI_PKG = process.env.TRELLIS_RELEASE_CLI_PKG
  ? path.resolve(process.env.TRELLIS_RELEASE_CLI_PKG)
  : path.join(__dirname, "../package.json");

function fail(message) {
  console.error(`\n❌ Cannot release: ${message}\n`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const typeIdx = args.indexOf("--type");
  if (typeIdx === -1 || !args[typeIdx + 1]) {
    console.error("Error: --type <beta|rc|promote> required");
    process.exit(2);
  }
  const type = args[typeIdx + 1];
  if (!["beta", "rc", "promote"].includes(type)) {
    console.error(`Error: --type must be one of beta/rc/promote (got "${type}")`);
    process.exit(2);
  }

  const current = JSON.parse(fs.readFileSync(CLI_PKG, "utf-8")).version;
  const target = computeNext(current, type);
  const manifestPath = path.join(MANIFESTS_DIR, `${target}.json`);

  if (!fs.existsSync(manifestPath)) {
    fail(
      `release manifest ${manifestPath} does not exist.\n` +
        `Author it before retrying (see scripts/create-manifest.js). The manifest\n` +
        `changelog/description fields are the user-facing release notes of this\n` +
        `repository.`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    fail(`${manifestPath} is not valid JSON: ${err.message}`);
  }

  const missing = [];
  if (manifest.version !== target) {
    missing.push(`version (expected "${target}", found "${manifest.version}")`);
  }
  if (typeof manifest.description !== "string" || !manifest.description.trim()) {
    missing.push("description (non-empty text)");
  }
  if (typeof manifest.changelog !== "string" || !manifest.changelog.trim()) {
    missing.push("changelog (non-empty text)");
  }
  if (!Array.isArray(manifest.migrations)) {
    missing.push("migrations (array)");
  }
  if (
    (manifest.breaking === true || manifest.requiresStorageMigration === true) &&
    (typeof manifest.migrationGuide !== "string" ||
      !manifest.migrationGuide.trim())
  ) {
    missing.push(
      "migrationGuide (required because breaking/requiresStorageMigration is true)",
    );
  }
  if (
    manifest.breaking === true &&
    manifest.recommendMigrate === true &&
    (typeof manifest.aiInstructions !== "string" ||
      !manifest.aiInstructions.trim())
  ) {
    missing.push(
      "aiInstructions (required because breaking + recommendMigrate is true)",
    );
  }

  if (missing.length > 0) {
    fail(`${manifestPath} is incomplete:\n  - ${missing.join("\n  - ")}`);
  }

  console.log(`✅ release manifest wired for v${target}`);
}

main();
