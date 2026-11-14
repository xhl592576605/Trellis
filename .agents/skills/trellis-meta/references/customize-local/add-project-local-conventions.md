Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Add Project-Local Conventions

Often the user does not need to change Trellis mechanics; they need local AI to understand their team's conventions. In that case, prefer `/Users/xuhuale/.trellis-wiki/Trellis/spec/` or a project-local skill instead of editing `trellis-meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `/Users/xuhuale/.trellis-wiki/Trellis/spec/<layer>/` |
| Cross-layer thinking methods | `/Users/xuhuale/.trellis-wiki/Trellis/spec/guides/` |
| AI capability for a project-specific flow | Platform-local skill |
| One-off task material | `/Users/xuhuale/.trellis-wiki/Trellis/tasks/<task>/` |
| Session summary | `/Users/xuhuale/.trellis-wiki/Trellis/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes Trellis," create a local skill:

```text
.claude/skills/trellis-local/
└── SKILL.md
```

Example:

```md
---
name: trellis-local
description: "Project-local Trellis customizations for this repository. Use when changing this project's Trellis workflow, hooks, local agents, or team-specific conventions."
---

# Trellis Local

## Local Scope

This skill documents this repository's Trellis customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

For multi-platform projects, place equivalent versions in other platform skill directories, or use `.agents/skills/` for platforms that support the shared layer.

## Write To `/Users/xuhuale/.trellis-wiki/Trellis/spec/`

If the content is a coding convention, write it to spec. Examples:

```text
/Users/xuhuale/.trellis-wiki/Trellis/spec/backend/error-handling.md
/Users/xuhuale/.trellis-wiki/Trellis/spec/frontend/components.md
/Users/xuhuale/.trellis-wiki/Trellis/spec/guides/cross-platform-thinking-guide.md
```

After writing it, update the corresponding `index.md` so AI can find the new rule from the entry point.

## Make The Current Task Use New Conventions

After writing a spec, add it to the current task context:

```bash
python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/task.py add-context <task> implement "/Users/xuhuale/.trellis-wiki/Trellis/spec/backend/error-handling.md" "Error handling conventions"
python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/task.py add-context <task> check "/Users/xuhuale/.trellis-wiki/Trellis/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `trellis-meta`

`trellis-meta` is a public skill for understanding Trellis architecture and local customization entry points. Put project-private content in:

- `/Users/xuhuale/.trellis-wiki/Trellis/spec/`
- a project-local skill
- the current task
- workspace journal

This prevents future updates to Trellis's built-in `trellis-meta` from overwriting the team's own conventions.
