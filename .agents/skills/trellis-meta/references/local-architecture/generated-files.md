Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Local Files Generated After Init

`trellis init` writes the Trellis runtime into the user project. Later, `trellis update` tries to update Trellis-managed template files, but it uses `/Users/xuhuale/.trellis-wiki/Trellis/.template-hashes.json` to determine which files have already been modified by the user.

This page only describes files that are visible and editable inside the user project.

## `.trellis/`

```text
.trellis/
├── workflow.md
├── config.yaml
├── .developer
├── .version
├── .template-hashes.json
├── .runtime/
├── scripts/
├── spec/
├── tasks/
└── workspace/
```

| Path | Usually editable? | Notes |
| --- | --- | --- |
| `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` | Yes | Local workflow documentation and AI routing rules. |
| `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml` | Yes | Project configuration, hooks, packages, journal line limits, and related settings. |
| `/Users/xuhuale/.trellis-wiki/Trellis/spec/` | Yes | Project specs, intended to be updated regularly by users and AI. |
| `/Users/xuhuale/.trellis-wiki/Trellis/tasks/` | Yes | Task material and research artifacts, maintained by the task workflow. |
| `/Users/xuhuale/.trellis-wiki/Trellis/workspace/` | Yes | Session records, usually written by `add_session.py`. |
| `/Users/xuhuale/.trellis-wiki/Trellis/scripts/` | Carefully | Local runtime. It can be customized, but only after understanding the call chain. |
| `/Users/xuhuale/.trellis-wiki/Trellis/.runtime/` | No | Runtime state, usually written automatically by hooks/scripts. |
| `/Users/xuhuale/.trellis-wiki/Trellis/.developer` | Carefully | Current developer identity. |
| `/Users/xuhuale/.trellis-wiki/Trellis/.version` | No | Trellis version record used by update/migration logic. |
| `/Users/xuhuale/.trellis-wiki/Trellis/.template-hashes.json` | No | Template hash record. Do not hand-write business rules here. |

## Platform Directories

Different platforms generate different directories. Common categories:

| Category | Example paths | Purpose |
| --- | --- | --- |
| hooks | `.claude/hooks/`, `.codex/hooks/`, `.cursor/hooks/` | Inject session context, workflow-state, and shell session identity. |
| settings | `.claude/settings.json`, `.codex/hooks.json`, `.qoder/settings.json`, `.trae/hooks.json` | Tell the platform when to run hooks or plugins. |
| agents | `.claude/agents/`, `.codex/agents/`, `.kiro/agents/`, `.zcode/agents/` | Define agents such as `trellis-research`, `trellis-implement`, and `trellis-check`. |
| skills | `.claude/skills/`, `.agents/skills/`, `.qoder/skills/`, `.zcode/skills/` | Skills that auto-trigger or can be read by AI. |
| commands/prompts/workflows | `.cursor/commands/`, `.github/prompts/`, `.devin/workflows/`, `.zcode/commands/` | Explicit user-invoked command or workflow entry points. |

When modifying a platform directory, also confirm whether `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` still describes the same flow.

## Meaning Of Template Hashes

`/Users/xuhuale/.trellis-wiki/Trellis/.template-hashes.json` records the content hash from the last time Trellis wrote a template file. `trellis update` uses it to distinguish three cases:

| Case | Update behavior |
| --- | --- |
| File was not modified by the user | It can be updated automatically. |
| File was modified by the user | Prompt the user to overwrite, keep, or generate `.new`. |
| File is no longer a current template | It may be deleted, renamed, or preserved according to migration rules. |

When an AI customizes local Trellis files, it does not need to maintain hashes manually. It is normal for Trellis update to recognize the result as "modified by the user."

## Local Customization Boundaries

Editable by default:

- `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md`
- `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml`
- `'/Users/xuhuale/.trellis-wiki/Trellis/spec/**'`
- `'/Users/xuhuale/.trellis-wiki/Trellis/scripts/**'`
- Platform hooks, settings, agents, skills, commands, prompts, and workflows

Do not edit by default:

- Global npm install directory
- `node_modules/@mindfoldhq/trellis`
- Trellis GitHub repository source code
- Concrete state files under `'/Users/xuhuale/.trellis-wiki/Trellis/.runtime/**'`
- Hash contents inside `/Users/xuhuale/.trellis-wiki/Trellis/.template-hashes.json`

Switch to the Trellis CLI source-code perspective only when the user explicitly wants to contribute upstream.
