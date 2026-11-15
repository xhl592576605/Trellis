import fs from "node:fs";
import { execSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyNpm } from "../../scripts/release-preflight.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));
const version = (
  JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

describe("public npm visibility retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.stubEnv("GITHUB_REF_NAME", "");
    vi.stubEnv("GITHUB_REF", "");
    vi.mocked(execSync).mockReturnValue(JSON.stringify(version));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(execSync).mockReset();
  });

  it.each(["0.0.0-stage", null])(
    "retries an unexpected version %j without exiting",
    async (visible) => {
      vi.mocked(execSync).mockReturnValueOnce(JSON.stringify(visible));
      const check = verifyNpm({ packageFilter: "core" });
      await vi.runAllTimersAsync();
      await check;
      expect(process.exit).not.toHaveBeenCalled();
      expect(execSync).toHaveBeenCalledTimes(3);
    },
  );

  it("retries when the exact version is visible but latest still points to the old version", async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(JSON.stringify(version))
      .mockReturnValueOnce('"0.7.0"');
    const check = verifyNpm({ packageFilter: "core" });
    await vi.runAllTimersAsync();
    await check;
    expect(process.exit).not.toHaveBeenCalled();
    expect(execSync).toHaveBeenCalledTimes(4);
  });

  it("waits beyond the previous 50-second window for a processing package", async () => {
    for (let i = 0; i < 7; i++) {
      vi.mocked(execSync).mockImplementationOnce(() => {
        throw new Error("npm E404: package processing");
      });
    }
    const check = verifyNpm({ packageFilter: "core" });
    await vi.runAllTimersAsync();
    await check;
    expect(execSync).toHaveBeenCalledTimes(9);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("rejects after bounded retries instead of claiming success", async () => {
    vi.mocked(execSync).mockReturnValue('"0.0.0-stage"');
    const check = verifyNpm({ packageFilter: "core" });
    const rejected = expect(check).rejects.toThrow(/not visible/);
    await vi.runAllTimersAsync();
    await rejected;
    expect(execSync).toHaveBeenCalledTimes(30);
    expect(process.exit).not.toHaveBeenCalled();
  });
});
