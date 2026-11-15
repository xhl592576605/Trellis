Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Change Local Spec Structure

When the user wants to change the engineering conventions AI follows, add new spec layers, or adjust monorepo package mapping, edit `/Users/xuhuale/.trellis-wiki/Trellis/spec/` and `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml`.

## Read These Files First

1. `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml`
2. `/Users/xuhuale/.trellis-wiki/Trellis/spec/`
3. `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` planning artifact guidance and Phase 3.3
4. Current task `prd.md` / `design.md` / `implement.md`

## Common Needs

| Need | Edit location |
| --- | --- |
| Add backend/frontend/docs/test spec layer | `/Users/xuhuale/.trellis-wiki/Trellis/spec/<layer>/` or `/Users/xuhuale/.trellis-wiki/Trellis/spec/<package>/<layer>/` |
| Add shared thinking guides | `/Users/xuhuale/.trellis-wiki/Trellis/spec/guides/` |
| Adjust monorepo packages | `packages` in `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml` |
| Change default package | `default_package` in `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml` |
| Control spec scanning scope | `spec_scope` in `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml` |
| Make a task read a new spec | Task `prd.md` / `design.md` / `implement.md` |

## Add A Spec Layer

Single-repository example:

```text
/Users/xuhuale/.trellis-wiki/Trellis/spec/security/
├── index.md
└── auth.md
```

Monorepo example:

```text
/Users/xuhuale/.trellis-wiki/Trellis/spec/webapp/security/
├── index.md
└── auth.md
```

`index.md` should include:

- What code this layer applies to.
- Pre-Development Checklist.
- Quality Check.
- Links to specific guideline files.

## Update Context

Adding a spec does not mean every task automatically reads it. The current task must reference it in JSONL:

```bash
python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/task.py add-context <task> implement "/Users/xuhuale/.trellis-wiki/Trellis/spec/webapp/security/index.md" "Security conventions"
python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/task.py add-context <task> check "/Users/xuhuale/.trellis-wiki/Trellis/spec/webapp/security/index.md" "Security review rules"
```

## Change Monorepo Packages

Example `/Users/xuhuale/.trellis-wiki/Trellis/config.yaml`:

```yaml
packages:
  webapp:
    path: apps/web
  api:
    path: apps/api
default_package: webapp
```

After editing, run:

```bash
python3 /Users/xuhuale/.trellis-wiki/Trellis/scripts/get_context.py --mode packages
```

Use this output to confirm AI can see the correct packages and spec layers.

## Notes

- Specs are user project conventions and can be changed according to project needs.
- Do not put temporary task information into specs; put temporary information in the task.
- Do not put long-term conventions only in agents or commands; preserve them in specs.
- After changing spec structure, check whether existing task JSONL files still point to files that exist.
