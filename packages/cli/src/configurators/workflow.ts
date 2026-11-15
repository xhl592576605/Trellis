import fs from "node:fs";
import path from "node:path";

import { DIR_NAMES } from "../constants/paths.js";
import { renderWorkflowPaths } from "../utils/external-store.js";
import { copyTrellisDir } from "../templates/extract.js";

// Import trellis templates (generic, not project-specific)
import {
  workflowMdTemplate,
  configYamlTemplate,
  gitignoreTemplate,
  gitattributesTemplate,
  getAllAgents,
} from "../templates/trellis/index.js";

// Import markdown templates
import {
  agentProgressIndexContent,
  // Backend structure (multi-doc)
  backendIndexContent,
  backendDirectoryStructureContent,
  backendDatabaseGuidelinesContent,
  backendLoggingGuidelinesContent,
  backendQualityGuidelinesContent,
  backendErrorHandlingContent,
  // Frontend structure (multi-doc)
  frontendIndexContent,
  frontendDirectoryStructureContent,
  frontendTypeSafetyContent,
  frontendHookGuidelinesContent,
  frontendComponentGuidelinesContent,
  frontendQualityGuidelinesContent,
  frontendStateManagementContent,
  // Guides structure
  guidesIndexContent,
  guidesCrossLayerThinkingGuideContent,
  guidesCodeReuseThinkingGuideContent,
} from "../templates/markdown/index.js";

import { writeFile, ensureDir } from "../utils/file-writer.js";
import { replacePythonCommandLiterals } from "./shared.js";
import {
  sanitizePkgName,
  type ProjectType,
  type DetectedPackage,
} from "../utils/project-detector.js";

interface DocDefinition {
  name: string;
  content: string;
}

/**
 * Options for creating workflow structure
 */
export interface WorkflowOptions {
  /** Detected or specified project type */
  projectType: ProjectType;
  /** Skip creating local spec templates (when using remote template) — single-repo mode */
  skipSpecTemplates?: boolean;
  /** Detected monorepo packages (enables monorepo spec creation) */
  packages?: DetectedPackage[];
  /** Package names that use remote templates (skip blank spec for these) */
  remoteSpecPackages?: Set<string>;
  /**
   * Optional override for `.trellis/workflow.md` content. When omitted the
   * bundled native template is written. Set by `init --workflow` (or
   * `--workflow-source`) after the resolver has fetched marketplace content.
   * Caller is still responsible for removing the `.trellis/workflow.md` hash
   * entry for non-native workflows so update.ts treats them as user-managed.
   */
  workflowMdOverride?: string;
  /**
   * Target directory for the workflow data tree. Defaults to
   * `<cwd>/.trellis` (legacy layout). External storage mode passes the
   * resolved external project dir here: all data files (scripts,
   * workflow.md, config.yaml, workspace, tasks, spec, agents) are written
   * to that directory instead, while platform wiring still targets `cwd`.
   */
  trellisRoot?: string;
}

/**
 * Regex used to detect an existing `journal-*.md merge=union` gitattributes
 * rule (any whitespace variant), so `ensureGitattributes` never appends a
 * duplicate entry to a project's pre-existing `.gitattributes`.
 */
const JOURNAL_MERGE_UNION_PATTERN = /journal-\*\.md\s+merge=union/;

/**
 * Ensure the project-root `.gitattributes` carries the journal `merge=union`
 * rule, without ever overwriting a user's existing file wholesale.
 *
 * - No `.gitattributes` yet: write the bundled template directly.
 * - Existing file that already has a `journal-*.md merge=union` rule (user's
 *   own or from a previous `trellis init`/`update`): no-op, avoids duplicates.
 * - Existing file without that rule: append the bundled template content.
 *
 * Intentionally does NOT go through the standard `writeFile` conflict-prompt
 * flow — this file is additive-only and never a candidate for whole-file
 * overwrite.
 */
export function ensureGitattributes(cwd: string, externalStore = false): void {
  const targetPath = path.join(cwd, ".gitattributes");
  // External store: journals live at <project>/workspace/journal-*.md (flat,
  // single-user); the pattern spans any project dir in the storage repo.
  const template = externalStore
    ? "# Trellis: append-only developer journals should merge cleanly across\n# parallel sessions/worktrees — each session only appends a new block.\n*/workspace/journal-*.md merge=union\n"
    : gitattributesTemplate;

  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, template);
    return;
  }

  const existing = fs.readFileSync(targetPath, "utf-8");
  if (
    JOURNAL_MERGE_UNION_PATTERN.test(existing) ||
    /workspace\/journal-\*\.md\s+merge=union/.test(existing)
  ) {
    return;
  }

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(targetPath, existing + separator + template);
}

/**
 * Create workflow structure based on project type
 *
 * This function creates the .trellis/ directory structure by:
 * 1. Copying scripts/ directory directly (dogfooding)
 * 2. Copying workflow.md and .gitignore (dogfooding)
 * 3. Creating workspace/ with index.md
 * 4. Creating tasks/ directory
 * 5. Creating spec/ with templates (not dogfooded - generic templates)
 *
 * @param cwd - Current working directory
 * @param options - Workflow options including project type
 */
export async function createWorkflowStructure(
  cwd: string,
  options?: WorkflowOptions,
): Promise<void> {
  const projectType = options?.projectType ?? "fullstack";
  const skipSpecTemplates = options?.skipSpecTemplates ?? false;
  const packages = options?.packages;
  const remoteSpecPackages = options?.remoteSpecPackages;
  const workflowMd = options?.workflowMdOverride ?? workflowMdTemplate;

  // External storage mode: the data tree lives in the resolved external
  // project dir, not `<cwd>/.trellis` (which is a browse-only link).
  const wfRoot = options?.trellisRoot ?? path.join(cwd, DIR_NAMES.WORKFLOW);
  const wf = (rel: string): string => path.join(wfRoot, rel);

  // Create base workflow directory
  ensureDir(wfRoot);

  // Copy scripts/ directory from templates
  await copyTrellisDir("scripts", wf("scripts"), {
    executable: true,
  });

  // Match update rendering, including the canonical external root on macOS.
  const externalRoot = options?.trellisRoot ? fs.realpathSync(wfRoot) : null;
  const renderMarkdown = (content: string): string => {
    const rendered = replacePythonCommandLiterals(content);
    return externalRoot
      ? renderWorkflowPaths(rendered, externalRoot)
      : rendered;
  };

  // Copy workflow.md (native bundled template or selected marketplace variant)
  await writeFile(wf("workflow.md"), renderMarkdown(workflowMd));

  // Copy .gitignore from templates
  await writeFile(wf(".gitignore"), gitignoreTemplate);

  // Copy config.yaml from templates
  await writeFile(wf("config.yaml"), configYamlTemplate);

  // Ensure the journal merge=union rule exists. In legacy mode it goes to
  // the code root; in external mode the journal Git attributes belong to the
  // external storage repository (where journals live at <project>/workspace/),
  // not the code checkout.
  if (options?.trellisRoot) {
    ensureGitattributes(path.dirname(wfRoot), true);
  } else {
    ensureGitattributes(cwd, false);
  }

  // Dispatch channel runtime agent definitions. These are platform-agnostic
  // Trellis runtime files consumed by `trellis channel spawn --agent <name>`
  // through `packages/cli/src/commands/channel/agent-loader.ts`. They are
  // dispatched on every init regardless of selected workflow because the user
  // can switch to a channel-driven workflow at any time via `trellis workflow
  // --template`.
  ensureDir(wf("agents"));
  for (const [agentFile, content] of getAllAgents()) {
    await writeFile(
      wf(path.join("agents", agentFile)),
      renderMarkdown(content),
    );
  }

  // Create workspace/ with index.md (flat in external single-user mode —
  // no developer subdirectory is created; add_session bootstraps it lazily).
  ensureDir(wf("workspace"));
  // External journals/index are created by the first journal writer, inside
  // its ownership checkpoint. Precreating untracked shared files here would
  // make a fresh finish-work look like it contains another writer's edits.
  if (!options?.trellisRoot) {
    await writeFile(
      wf(path.join("workspace", "index.md")),
      replacePythonCommandLiterals(agentProgressIndexContent),
    );
  }

  // Create tasks/ directory
  ensureDir(wf("tasks"));

  // Create spec templates based on project type
  // These are NOT dogfooded - they are generic templates for new projects
  if (packages && packages.length > 0) {
    // Monorepo mode: create per-package spec directories
    await createSpecTemplates(
      cwd,
      projectType,
      packages,
      remoteSpecPackages,
      options?.trellisRoot,
    );
  } else if (!skipSpecTemplates) {
    // Single-repo mode: create global spec (skip if using remote template)
    await createSpecTemplates(
      cwd,
      projectType,
      undefined,
      undefined,
      options?.trellisRoot,
    );
  }
}

/**
 * Write backend spec docs into a target spec directory.
 */
async function writeBackendDocs(specBase: string): Promise<void> {
  const backendDir = path.join(specBase, "backend");
  ensureDir(backendDir);
  const docs: DocDefinition[] = [
    { name: "index.md", content: backendIndexContent },
    {
      name: "directory-structure.md",
      content: backendDirectoryStructureContent,
    },
    {
      name: "database-guidelines.md",
      content: backendDatabaseGuidelinesContent,
    },
    { name: "logging-guidelines.md", content: backendLoggingGuidelinesContent },
    { name: "quality-guidelines.md", content: backendQualityGuidelinesContent },
    { name: "error-handling.md", content: backendErrorHandlingContent },
  ];
  for (const doc of docs) {
    await writeFile(path.join(backendDir, doc.name), doc.content);
  }
}

/**
 * Write frontend spec docs into a target spec directory.
 */
async function writeFrontendDocs(specBase: string): Promise<void> {
  const frontendDir = path.join(specBase, "frontend");
  ensureDir(frontendDir);
  const docs: DocDefinition[] = [
    { name: "index.md", content: frontendIndexContent },
    {
      name: "directory-structure.md",
      content: frontendDirectoryStructureContent,
    },
    { name: "type-safety.md", content: frontendTypeSafetyContent },
    { name: "hook-guidelines.md", content: frontendHookGuidelinesContent },
    {
      name: "component-guidelines.md",
      content: frontendComponentGuidelinesContent,
    },
    {
      name: "quality-guidelines.md",
      content: frontendQualityGuidelinesContent,
    },
    { name: "state-management.md", content: frontendStateManagementContent },
  ];
  for (const doc of docs) {
    await writeFile(path.join(frontendDir, doc.name), doc.content);
  }
}

/**
 * Write spec docs for a given project type into a target spec directory.
 */
async function writeSpecForType(
  specBase: string,
  projectType: ProjectType,
): Promise<void> {
  if (projectType !== "frontend") {
    await writeBackendDocs(specBase);
  }
  if (projectType !== "backend") {
    await writeFrontendDocs(specBase);
  }
}

async function createSpecTemplates(
  cwd: string,
  projectType: ProjectType,
  packages?: DetectedPackage[],
  remoteSpecPackages?: Set<string>,
  wfRoot?: string,
): Promise<void> {
  // Ensure spec directory exists (external mode: inside the workflow root)
  const specBase = wfRoot ?? path.join(cwd, DIR_NAMES.WORKFLOW);
  ensureDir(path.join(specBase, "spec"));

  // Guides - always created regardless of mode
  const guidesDir = path.join(specBase, "spec", "guides");
  ensureDir(guidesDir);
  const guidesDocs: DocDefinition[] = [
    { name: "index.md", content: guidesIndexContent },
    {
      name: "cross-layer-thinking-guide.md",
      content: guidesCrossLayerThinkingGuideContent,
    },
    {
      name: "code-reuse-thinking-guide.md",
      content: guidesCodeReuseThinkingGuideContent,
    },
  ];
  for (const doc of guidesDocs) {
    await writeFile(path.join(guidesDir, doc.name), doc.content);
  }

  if (packages && packages.length > 0) {
    // Monorepo mode: create spec/<name>/ for each package
    for (const pkg of packages) {
      const dirName = sanitizePkgName(pkg.name);
      if (remoteSpecPackages?.has(dirName)) continue;
      const pkgSpecBase = path.join(specBase, "spec", dirName);
      ensureDir(pkgSpecBase);
      const pkgType = pkg.type === "unknown" ? "fullstack" : pkg.type;
      await writeSpecForType(pkgSpecBase, pkgType);
    }
  } else {
    // Single-repo mode
    await writeSpecForType(path.join(specBase, "spec"), projectType);
  }
}
