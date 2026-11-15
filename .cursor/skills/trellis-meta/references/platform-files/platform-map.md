Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Platform File Map

This page lists common Trellis file locations in a user project by platform. Whether a platform directory exists in an actual project depends on which `trellis init --<platform>` commands the user ran.

## Matrix

| Platform | CLI flag | Main directory | Skill directory | Agent directory | Hooks/extensions |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `--claude` | `.claude/` | `.claude/skills/` | None | `.claude/hooks/` + `.claude/settings.json` |
| Cursor | `--cursor` | `.cursor/` | `.cursor/skills/` | None | `.cursor/hooks.json` + `.cursor/hooks/` |
| OpenCode | `--opencode` | `.opencode/` | `.opencode/skills/` | None | `.opencode/plugins/` |
| Codex | `--codex` | `.codex/` | `.agents/skills/` | None | `.codex/hooks/` + `.codex/hooks.json` |
| Kilo | `--kilo` | `.kilocode/` | `.kilocode/skills/` | None | `.kilocode/workflows/` |
| Kiro | `--kiro` | `.kiro/` | `.kiro/skills/` | `.kiro/agents/trellis.json` (main agent) | `.kiro/hooks/` |
| Gemini CLI | `--gemini` | `.gemini/` | `.agents/skills/` | None | `.gemini/settings.json` + `.gemini/hooks/` |
| Antigravity | `--antigravity` | `.agent/` | `.agent/skills/` | None | `.agent/workflows/` |
| Devin | `--devin` | `.devin/` | `.devin/skills/` | None | `.devin/workflows/` |
| Qoder | `--qoder` | `.qoder/` | `.qoder/skills/` | None | `.qoder/hooks/` + `.qoder/settings.json` |
| CodeBuddy | `--codebuddy` | `.codebuddy/` | `.codebuddy/skills/` | None | `.codebuddy/hooks/` + `.codebuddy/settings.json` |
| GitHub Copilot | `--copilot` | `.github/` | `.github/skills/` | None | `.github/copilot/hooks/` + prompts |
| Factory Droid | `--droid` | `.factory/` | `.factory/skills/` | None | `.factory/hooks/` + settings |
| DeepSeek Harness (dsh) | `--dsh` | `.dsh/` | `.agents/skills/` (shared) + `.dsh/skills/` (entry skills) | None | No project hooks/settings; current-agent skills |
| Pi Agent | `--pi` | `.pi/` | `.agents/skills/` | None | `.pi/extensions/trellis/` (main-session context) + `.pi/settings.json` |
| Trae IDE | `--trae` | `.trae/` | `.trae/skills/` | None | `.trae/hooks/` + `.trae/hooks.json` |
| Reasonix | `--reasonix` | `.reasonix/` | `.reasonix/skills/` | None | None |
| ZCode | `--zcode` | `.zcode/` | `.zcode/skills/` | None | `.zcode/hooks/` + `.zcode/config.json` (session, workflow state, shell identity) |
| Grok Build | `--grok` | `.grok/` | `.grok/skills/` | None | No hooks; flat `.grok/commands/trellis-*.md` |
| Kimi Code | `--kimi` | `.kimi-code/` | `.agents/skills/` (shared) + `.kimi-code/skills/` | None | No project hooks/settings; current-agent skills |
| Snow CLI | `--snow` | `.snow/` | `.snow/skills/` | None | `.snow/hooks/` session/user context + flat prompt commands |

## Execution Model

Research, implementation, and checking run in the current agent on every platform. Workflow skills and task materials provide context directly; platform hooks and extensions supply main-session orientation and session identity. Kiro keeps a main `trellis` agent definition.

### Shared `.agents/skills/`

Codex, Gemini CLI, Pi Agent, Kimi Code, and DeepSeek Harness (dsh) write the shared `.agents/skills/` layer. Some tools that support agentskills.io can also read this directory. If the user wants multiple compatible tools to share one skill, consider `.agents/skills/` first, but do not assume every platform reads it. ZCode keeps Trellis-managed skills under `.zcode/skills/`.

## Decision Rules When Modifying Platform Files

1. User specified a platform: modify only that platform directory unless shared workflow/spec files must also change.
2. User says "all platforms should do this": synchronize equivalent entry points platform by platform; do not modify only one directory.
3. User only says "my AI": inspect the configuration directories that actually exist in the project and infer the current AI platform.
4. User wants project rules: prefer `/Users/xuhuale/.trellis-wiki/Trellis/spec/` or a project-local skill.
5. User wants Trellis behavior: edit `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` plus platform hooks/skills/commands.

## When Paths Differ

Platform ecosystems change, and user projects may already be customized. If this table disagrees with local files, use the actual settings/config in the user project as authoritative:

- Check the hook that settings registers.
- Check the script that a command/prompt/workflow points to.
- Judge behavior by the read rules currently written in workflow skills.

Do not delete a custom file just because it is not listed in this path table.

### `.omp/` — Oh My Pi (OMP)

Extension-backed platform. OMP native provider auto-discovers all subdirectories.

```text
.omp/
├── commands/          # Slash commands (flat .md)
├── skills/            # Auto-triggered skills (SKILL.md per dir)
└── extensions/
    └── trellis/
        └── index.ts   # Trellis extension (context injection)
```

No `settings.json` — OMP scans `.omp/` subdirectories automatically.
No Python hooks — hook-equivalent behavior lives in the TypeScript extension.
