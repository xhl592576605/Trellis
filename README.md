# trellis-wiki

**An AI coding workflow framework that keeps specs, tasks, and session memory out of your code repository — in a local wiki store you own.**

trellis-wiki is a fork of [Trellis](https://github.com/mindfold-ai/Trellis) (AGPL-3.0-only). It preserves the Trellis workflow — brainstorm-driven tasks, spec injection, journals — and moves all workflow data into an external local Git store, so any coding agent works to your engineering standards without cluttering your source tree.

[简体中文](./README_CN.md)

## Why trellis-wiki?

| Capability | What it changes |
| --- | --- |
| External wiki store | Tasks, specs, journals, and scripts live in `~/.trellis-wiki` (one local Git repository shared by all projects), not inside your code repo. |
| Locator config | The code repository keeps a single `.treills.conf.json` locator plus per-platform wiring; a `.trellis` link remains for browsing only. |
| Two clean Git boundaries | Code commits stay in your code repository; task/journal commits land in the storage repository via finish-work. |
| Multi-platform wiring | The same workflow installs into Claude Code, Codex, Cursor, Pi, OpenCode, and more — run `trellis-wiki init --help` for the current platform list. |
| Compatible commands | `trellis` and `tl` keep working, along with `/trellis:*` commands, skills, and `TRELLIS_*` environment variables. |

## Prerequisites

- Node.js >= 18.17.0
- Python >= 3.9

## Install

```bash
npm install -g trellis-wiki
```

> The `trellis-wiki` npm package is the published entry point of this fork. Until it is published, build and install locally:
>
> ```bash
> git clone https://github.com/xhl592576605/Trellis.git
> cd Trellis && pnpm install && pnpm build
> node packages/cli/bin/trellis.js --version   # 0.7.0
> ```

## Initialize a project

```bash
# pick the AI platforms you actually use
trellis-wiki init --pi --codex

# external storage is the default mode (store root defaults to ~/.trellis-wiki)
trellis-wiki init --pi --storage ~/my-wiki --project my-project
```

No developer registration is required. Initialization creates:

```text
your-code-repo/
├── .treills.conf.json      # locator: { "storage": "~/.trellis-wiki", "project": "my-project" }
├── .trellis -> ~/.trellis-wiki/my-project/   # browse-only link (safe to delete)
├── .pi/  .codex/ …         # platform wiring (hooks, skills, commands)

~/.trellis-wiki/            # one local Git repository for all projects
└── my-project/
    ├── tasks/  spec/  workspace/   # PRDs, guidelines, journals
    ├── scripts/  config.yaml  project.json
```

Runtime resolution always reads `.treills.conf.json` first — the `.trellis` link is never required for execution.

## Daily workflow

1. Describe what you want in natural language; the AI plans the task with you (one question at a time) and writes a PRD into the store.
2. Implementation and quality checks run against your specs, lint, type-check, and tests.
3. Finish with `/trellis:finish-work`: the task is archived and the journal is committed — in the **storage** repository, scoped to this task. Code changes are committed in your code repository as usual.

## Switch from @mindfoldhq/trellis

Switching the npm package and migrating project data are two separate steps.

**1. Swap the global CLI** (do not run project `uninstall` for this — it removes platform wiring):

```bash
npm uninstall -g @mindfoldhq/trellis
npm install -g trellis-wiki
trellis-wiki --version && trellis --version && tl --version   # all 0.7.0
```

**2. Migrate a legacy in-repo `.trellis`:**

```bash
trellis-wiki update --migrate-storage --dry-run     # preview, no writes
trellis-wiki update --migrate-storage               # copy + verify + switch
```

- Options: `--storage <dir>`, `--project <name>`; add `--workspace <name>` only when the old workspace has multiple developer directories and no `.developer`.
- The original `.trellis` is preserved as `.trellis.pre-migration.<timestamp>/` — your recovery copy; delete it at your leisure.
- Interrupted runs resume from a persisted checkpoint by re-running the same command.
- The migration never commits your code repository; commit the resulting deletions yourself.

Projects already on the external store need no re-migration — just run `trellis-wiki update`; existing storage directories, bindings, and data are reused as-is.

## Compatibility notes

- Commands: `trellis-wiki` (primary), `trellis` and `tl` (aliases) run the same CLI.
- AI surface: `/trellis:*` slash commands, `trellis-*` skills, `TRELLIS_*` environment variables, and the `.trellis` browse path are unchanged.
- SDK consumers: the core package is now `trellis-wiki-core`. Update your dependency and imports:

```ts
import { createChannel } from "trellis-wiki-core/channel";
import { searchMemSessions } from "trellis-wiki-core/mem";
```

There is no redirect package under the old `@mindfoldhq` scope.

## Upgrade vs update

- `trellis-wiki upgrade` — upgrade the globally installed CLI (`npm install -g trellis-wiki@<tag>`).
- `trellis-wiki update` — refresh a project's templates, hooks, and platform wiring; applies file migrations. A legacy in-repo layout crossing 0.7.0 is refused until you run `--migrate-storage`.

## Uninstall and data retention

`trellis-wiki uninstall` removes this checkout's platform wiring, managed blocks, locator config, and browse link. It never deletes the external store — tasks, specs, and journals survive uninstalling and re-installing.

## Local development

```bash
pnpm install
pnpm build          # trellis-wiki-core then trellis-wiki
pnpm test           # core + cli suites
pnpm lint && pnpm typecheck
node packages/cli/scripts/release-preflight.js check-versions
node packages/cli/scripts/release-preflight.js verify-packed-cli
```

| Package | Role |
| --- | --- |
| `packages/cli` (`trellis-wiki`) | CLI commands, platform configurators, templates, migrations, release scripts. |
| `packages/core` (`trellis-wiki-core`) | Channel/task/mem domain SDK with `/channel`, `/mem`, `/task`, `/testing` subpath exports. |

Publishing is CI-only (core first, then CLI, one version per git tag); see `.trellis/spec/cli/backend/release-process.md`.

## Roadmap (TODO)

- [ ] **Detailed UI development**: a web UI on top of the local data — task board with status/owner views, channel thread list with event timelines, mem recall browsing, and update/migration status panels. Read-only local mode first; no cloud service.
- [ ] **Bug handling workflow**: a standard loop from report → reproduce → locate (mem / channel logs) → fix → regression test → spec capture (`trellis-break-loop`), plus issue triage expectations for this fork.

## Source and license

trellis-wiki is maintained at [xhl592576605/Trellis](https://github.com/xhl592576605/Trellis). It is a fork of [Trellis](https://github.com/mindfold-ai/Trellis) by Mindfold — original concept, code, and AGPL-3.0-only license retained. See [LICENSE](./LICENSE).
