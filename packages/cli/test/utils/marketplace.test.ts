import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const downloadMock = vi.hoisted(() => vi.fn());
vi.mock("giget", () => ({ downloadTemplate: downloadMock }));

import { getBundledSkillTemplates } from "../../src/templates/common/index.js";
import { downloadTemplateById, type SpecTemplate } from "../../src/utils/template-fetcher.js";
import { resolveWorkflowTemplate } from "../../src/utils/workflow-resolver.js";

const root = fileURLToPath(new URL("../../../../marketplace/", import.meta.url));
const index = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf-8")) as {
  templates: SpecTemplate[];
};
const indexUrl = "https://raw.githubusercontent.com/xhl592576605/Trellis/main/marketplace/index.json";

afterEach(() => {
  vi.unstubAllGlobals();
  downloadMock.mockReset();
});

describe("repository marketplace", () => {
  it("indexes existing templates with unique ids and matching skill names", () => {
    const ids = index.templates.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of index.templates) {
      const target = path.join(root, entry.path);
      expect(fs.existsSync(target), entry.path).toBe(true);
      if (entry.type === "skill") {
        expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf-8")).toMatch(
          new RegExp(`^name: ${entry.id}$`, "m"),
        );
      }
    }
    const skills = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(index.templates.filter((entry) => entry.type === "skill")
      .map((entry) => entry.id).sort()).toEqual(skills);
  });

  it("keeps overlapping market skills identical to the CLI bundled skills", () => {
    for (const skill of getBundledSkillTemplates()) {
      const marketRoot = path.join(root, "skills", skill.name);
      if (!fs.existsSync(marketRoot)) continue;
      const files = fs.readdirSync(marketRoot, { recursive: true })
        .filter((file) => fs.statSync(path.join(marketRoot, file)).isFile())
        .map((file) => file.split(path.sep).join("/"));
      expect(files.sort()).toEqual(skill.files.map((file) => file.relativePath).sort());
      for (const file of skill.files) {
        expect(fs.readFileSync(path.join(marketRoot, file.relativePath), "utf-8"),
          `${skill.name}/${file.relativePath}`).toBe(file.content);
      }
    }
  });

  it("downloads every default spec from this fork with its marketplace prefix", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wiki-marketplace-"));
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(indexUrl);
      return new Response(JSON.stringify(index), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    downloadMock.mockImplementation(async (source: string, options: { dir: string }) => {
      const prefix = "gh:xhl592576605/Trellis/marketplace/";
      expect(source.startsWith(prefix)).toBe(true);
      fs.cpSync(path.join(root, source.slice(prefix.length)), options.dir, { recursive: true });
    });
    try {
      for (const entry of index.templates.filter((item) => item.type === "spec")) {
        const result = await downloadTemplateById(cwd, entry.id, "overwrite");
        expect(result.success, result.message).toBe(true);
        expect(fs.existsSync(path.join(cwd, ".trellis/spec/README.md"))).toBe(true);
      }
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolves default workflow files relative to this fork marketplace index", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === indexUrl) return new Response(JSON.stringify(index), { status: 200 });
      const entry = index.templates.find((item) => item.type === "workflow" &&
        url === indexUrl.replace("index.json", item.path));
      expect(entry, url).toBeDefined();
      return new Response(fs.readFileSync(path.join(root, entry?.path ?? ""), "utf-8"), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    for (const entry of index.templates.filter((item) => item.type === "workflow" && item.id !== "native")) {
      const resolved = await resolveWorkflowTemplate(entry.id);
      expect(resolved.content).toBe(fs.readFileSync(path.join(root, entry.path), "utf-8"));
    }
    expect(fetchMock).toHaveBeenCalled();
  });
});
