# Platform Files Overview

Trellis connects the same local architecture to different AI tools. `.trellis/` stores the shared runtime; platform directories store adapter files that define how each AI tool enters Trellis.

When a local AI modifies Trellis, it should distinguish two file categories first:

- **Shared files**: `.trellis/workflow.md`, `.trellis/tasks/`, `.trellis/spec/`, `.trellis/scripts/`.
- **Platform files**: `.claude/`, `.snow/`, `.codex/`, `.cursor/`, `.opencode/`, `.kiro/`, `.gemini/`, `.qoder/`, `.codebuddy/`, `.github/`, `.factory/`, `.pi/`, `.trae/`, `.kilocode/`, `.agent/`, `.devin/`, `.reasonix/`, `.zcode/`, `.kimi-code/`, and similar directories.

Platform files do not store business state. They let the corresponding AI tool read Trellis state, call Trellis scripts, and load Trellis skills/agents/hooks.

## Platform File Categories

| Category | Common paths | Purpose |
| --- | --- | --- |
| settings/config | `.claude/settings.json`, `.codex/hooks.json`, `.qoder/settings.json`, `.trae/hooks.json` | Register hooks, plugins, extensions, or platform behavior. |
| hooks/plugins/extensions | `.claude/hooks/`, `.opencode/plugins/`, `.pi/extensions/` | Inject context at session start, user input, agent startup, shell execution, and similar events. |
| main agent | `.kiro/agents/trellis.json` | Kiro main-session workflow entry and lifecycle hooks. |
| skills | `.claude/skills/`, `.agents/skills/`, `.qoder/skills/`, `.zcode/skills/` | Capability descriptions that auto-trigger or can be read on demand. |
| commands/prompts/workflows | `.cursor/commands/`, `.github/prompts/`, `.devin/workflows/`, `.zcode/commands/` | Entry points explicitly invoked by the user. |

## Platform Integration

Every platform executes research, implementation, and checking in the current agent. Skills and entry commands load project workflow steps and task/spec materials directly.

Where supported, hooks and extensions provide startup orientation, per-turn workflow state, and session identity for shell children. Platforms without lifecycle hooks use the start/continue entry points to load the same materials explicitly.

To change behavior, inspect project workflow.md and the relevant skills/commands. To change when context is delivered, inspect main-session hooks/extensions and their settings.

## Local Modification Order

When the user asks to customize behavior for a platform, the AI should inspect files in this order:

1. Read `.trellis/workflow.md` to confirm the shared flow.
2. Read the target platform's settings/config to see which hooks/agents/skills/commands are registered.
3. Read the target platform's agents/skills/commands/hooks.
4. Modify the local file closest to the user's need.
5. If the change affects the shared flow, synchronize `.trellis/workflow.md` or `.trellis/spec/`.

Do not modify only platform files and forget the shared workflow. Do not modify only `.trellis/workflow.md` and forget that platform entry points may still contain old descriptions.
