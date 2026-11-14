import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The package ships three command names — trellis-wiki (primary), trellis
 * and tl (compatibility aliases from the @mindfoldhq/trellis era. All three
 * must point at the same entry file so installed aliases behave identically.
 */
describe("CLI command aliases", () => {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(path.dirname(fileURLToPath(import.meta.url))),
        "..",
        "package.json",
      ),
      "utf-8",
    ),
  ) as { name: string; bin: Record<string, string> };

  it("primary package name is trellis-wiki", () => {
    expect(pkg.name).toBe("trellis-wiki");
  });

  it("trellis-wiki, trellis, and tl all resolve to one entry file", () => {
    expect(Object.keys(pkg.bin).sort()).toEqual(
      ["tl", "trellis", "trellis-wiki"].sort(),
    );
    const targets = new Set(Object.values(pkg.bin));
    expect(targets.size).toBe(1);
    expect(pkg.bin["trellis-wiki"]).toBe("./bin/trellis.js");
  });
});
