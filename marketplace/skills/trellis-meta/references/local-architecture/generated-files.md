# Files Generated After Init

`trellis-wiki init` writes a locator and platform integrations into the code
checkout, and workflow data into an external local wiki Git repository.
First read `.treills.conf.json` and resolve its `storage` and `project` fields.
Do not require the optional `.trellis` browse link to exist.

## Storage And Checkout Boundaries

```text
code-checkout/
├── .treills.conf.json
├── .trellis -> <storage>/<project>/   # optional browsing only
└── platform directories

<storage>/<project>/
├── workflow.md
├── config.yaml
├── project.json
├── .template-hashes.json              # shared data template hashes
├── scripts/
├── spec/
├── tasks/
├── workspace/
└── .runtime/checkouts/<checkout-key>/
    ├── .version
    ├── .template-hashes.json          # checkout platform template hashes
    ├── backups/
    └── sessions/
```

Keep command cwd at the code checkout. Invoke task and context scripts from
the resolved external `scripts/` directory. Shared data belongs to the
storage Git repository; platform integration changes belong to the code Git
repository. Never blanket-stage unrelated tasks or journals.

## Editable Data

| Path relative to the external project root | Customization boundary |
| --- | --- |
| `workflow.md` | Workflow phases and routing. |
| `config.yaml` | Packages, lifecycle hooks, and journal settings. |
| `spec/` | User-owned coding conventions and design constraints. |
| `tasks/` | Task PRDs, design, plans, and research. |
| `workspace/` | Session journals maintained by task/session scripts. |
| `scripts/` | Local runtime; understand callers before editing. |
| `project.json`, `.runtime/`, `.template-hashes.json` | Binding and management records; do not hand-edit as business configuration. |

The `.trellis/...` spelling in other references is a logical browse path to
these data files. A legacy project with a real `.trellis` directory must use
`trellis-wiki update --migrate-storage` before ordinary updates can proceed.

## Platform Directories

Hooks, settings, agents, skills, commands, prompts, and extensions stay in the
code checkout. Read `../platform-files/platform-map.md` for platform-specific
paths. Preserve user modifications, frontmatter, managed-block markers, and
shared `.agents/skills/` rendering.

## Template Hashes And Local Customization

`trellis-wiki update` uses the shared and checkout-specific hash records to
distinguish pristine templates from user-modified files:

| State | Update behavior |
| --- | --- |
| Disk content matches the recorded template hash | Safe automatic template update. |
| Disk content differs from the recorded hash | Conflict: overwrite, keep, or generate `.new` according to the user choice. |
| File is retired from current templates | Apply the explicit migration and ownership rules. |

Editing a template locally does not require rewriting its hash. It is normal
for update to report such edits as user modifications. Keep project-private
rules in specs or project-local skills, and avoid editing global npm installs
or `node_modules/trellis-wiki` / `node_modules/trellis-wiki-core`.
