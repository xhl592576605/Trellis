Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Local Customization Overview

This directory is for local AI working in a user project where Trellis was installed through npm and `trellis init` has already been run. The AI should modify generated `.trellis/` and platform directories inside the project, not Trellis CLI upstream source code.

## First Determine What The User Actually Wants To Change

| User wording | Read first |
| --- | --- |
| "Change the Trellis flow / phases / next prompt" | `change-workflow.md` |
| "Change task creation, status, archive, or hooks" | `change-task-lifecycle.md` |
| "AI did not read context / change injected content" | `change-context-loading.md` |
| "A platform hook is not behaving as expected" | `change-hooks.md` |
| "Change implement/check/research agent behavior" | `change-agents.md` |
| "Add a skill/command/workflow/prompt" | `change-skills-or-commands.md` |
| "Adjust the project spec structure" | `change-spec-structure.md` |
| "Add team conventions and local notes" | `add-project-local-conventions.md` |

## General Operation Order

1. **Confirm platform and directories**: inspect which directories exist, such as `.claude/`, `.codex/`, `.cursor/`, `.zcode/`.
2. **Confirm the current active task**: run `python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/task.py current --source`.
3. **Read the local source of truth**: prefer `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md`, `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml`, and relevant platform files.
4. **Modify narrowly**: edit only files related to the user's request.
5. **Synchronize semantics**: if a shared flow changes, check whether platform entry points also need changes; if a platform entry changes, check whether `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` still agrees.

## Local File Priority

| Layer | Files |
| --- | --- |
| Workflow | `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` |
| Project configuration | `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml` |
| Task material | `/Users/xuhuale/.trellis-wiki/Trellis/tasks/<task>/` |
| Project specs | `/Users/xuhuale/.trellis-wiki/Trellis/spec/` |
| Runtime scripts | `/Users/xuhuale/.trellis-wiki/Trellis/scripts/` |
| Platform integration | `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, `.zcode/`, and similar directories |
| Shared skill | `.agents/skills/` |

## Things Not To Do By Default

- Do not edit the global npm install directory.
- Do not edit `node_modules/@mindfoldhq/trellis`.
- Do not assume the user has the Trellis GitHub repository.
- Do not overwrite local files already modified by the user with default templates.
- Do not put team project rules into public `trellis-meta`; project rules belong in `/Users/xuhuale/.trellis-wiki/Trellis/spec/` or a local skill.

## When To Inspect Upstream Source

Switch to an upstream source-code perspective only when the user explicitly expresses one of these goals:

- "I want to open a PR to Trellis"
- "I want to change npm package publish contents"
- "I want to fork Trellis"
- "I want to modify the generation logic for `trellis init/update`"

Otherwise, default to modifying local Trellis files inside the user project.
