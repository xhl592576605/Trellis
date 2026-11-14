/**
 * Integration tests for scripts/check-release-manifest.js — the local
 * release-notes gate that replaced the docs-site changelog guard.
 *
 * Runs the real script as a subprocess against fixture manifests via the
 * TRELLIS_RELEASE_MANIFEST_DIR / TRELLIS_RELEASE_CLI_PKG env overrides, so
 * the repo\u0027s own manifests are never touched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "..", "scripts", "check-release-manifest.js");

let tmpDir: string;
let manifestsDir: string;
let pkgPath: string;

function writeFixture(
  manifest: unknown,
  version = "0.7.0",
  target = "0.7.1-beta.0",
): void {
  fs.rmSync(manifestsDir, { recursive: true, force: true });
  fs.mkdirSync(manifestsDir, { recursive: true });
  fs.writeFileSync(
    pkgPath,
    JSON.stringify({ name: "trellis-wiki", version }, null, 2) + "\n",
  );
  if (manifest !== null) {
    fs.writeFileSync(
      path.join(manifestsDir, `${target}.json`),
      typeof manifest === "string"
        ? manifest
        : JSON.stringify(manifest, null, 2) + "\n",
    );
  }
}

function runGate(
  args: string[] = ["--type", "beta"],
): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf-8",
      env: {
        ...process.env,
        TRELLIS_RELEASE_MANIFEST_DIR: manifestsDir,
        TRELLIS_RELEASE_CLI_PKG: pkgPath,
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

const COMPLETE = {
  version: "0.7.1-beta.0",
  description: "fixture release",
  changelog: "**Fixes:** fixture notes",
  migrations: [],
};

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-manifest-"));
  manifestsDir = path.join(tmpDir, "manifests");
  pkgPath = path.join(tmpDir, "package.json");
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("check-release-manifest gate", () => {
  it("passes when the target manifest is complete", () => {
    writeFixture({ ...COMPLETE, breaking: true, recommendMigrate: true, migrationGuide: "guide", aiInstructions: "ai" });
    const r = runGate();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("release manifest wired for v0.7.1-beta.0");
  });

  it.each([
    ["rc", "0.7.1-beta.0", "0.7.1-rc.0"],
    ["promote", "0.7.1-rc.0", "0.7.1"],
  ])("validates the computed %s release target", (type, current, target) => {
    writeFixture({ ...COMPLETE, version: target }, current, target);
    const r = runGate(["--type", type]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`release manifest wired for v${target}`);
  });

  it.each([
    [{ ...COMPLETE, description: " " }, "description (non-empty text)"],
    [{ ...COMPLETE, migrations: null }, "migrations (array)"],
    [{ ...COMPLETE, requiresStorageMigration: true }, "migrationGuide"],
  ])("rejects incomplete manifest fields: %j", (manifest, message) => {
    writeFixture(manifest);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  it("fails when the target manifest is missing", () => {
    writeFixture(null);
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not exist");
  });

  it("fails on invalid JSON", () => {
    writeFixture("{ not json");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
  });

  it("fails on version mismatch", () => {
    writeFixture({ ...COMPLETE, version: "0.8.0" });
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('version (expected "0.7.1-beta.0"');
  });

  it("fails on empty changelog or description", () => {
    writeFixture({ ...COMPLETE, changelog: "   " });
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("changelog (non-empty text)");
  });

  it("fails when breaking lacks migrationGuide", () => {
    writeFixture({ ...COMPLETE, breaking: true, recommendMigrate: true, aiInstructions: "ai" });
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("migrationGuide");
  });

  it("fails when breaking+recommendMigrate lacks aiInstructions", () => {
    writeFixture({ ...COMPLETE, breaking: true, recommendMigrate: true, migrationGuide: "guide" });
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("aiInstructions");
  });

  it("rejects an invalid --type with exit code 2", () => {
    writeFixture(COMPLETE);
    const r = runGate(["--type", "patch"]);
    expect(r.status).toBe(2);
  });

  it("never modifies fixture files", () => {
    writeFixture(COMPLETE);
    const before = fs.readFileSync(path.join(manifestsDir, "0.7.1-beta.0.json"), "utf-8");
    runGate();
    runGate(["--type", "rc"]);
    const after = fs.readFileSync(path.join(manifestsDir, "0.7.1-beta.0.json"), "utf-8");
    expect(after).toBe(before);
  });
});
