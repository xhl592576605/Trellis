# Current-agent workflow

## Goal

Keep the existing Plan / Execute / Finish workflow and task system, with all research, implementation, and checking performed by the current agent.

## Requirements

- Replace the default workflow rather than adding a template or execution-mode switch.
- Preserve task creation, start, finish, archive, hierarchy, planning artifacts, specs, and journals.
- Remove workflow subagent roles, dispatch tools, context injection, and manifest preparation requirements across supported platforms.
- Keep development preparation and quality-check skills as current-agent instructions.
- Init and update must distribute the same current-agent integration and safely retire managed legacy dispatch files.
- Preserve existing user task materials and customized integration files.

## Acceptance Criteria

- Every platform renders non-empty current-agent research, implementation, and check steps.
- New tasks have no implement/check JSONL files; existing empty manifests do not block start.
- Generated platform integrations do not register workflow subagents or subagent hooks/tools.
- Task lifecycle, state breadcrumbs, main-session identity hooks, and quality checks continue to work.
- Relevant regression tests, lint, typecheck, and build pass.

## Scope

Independent channel CLI/SDK functionality and historical conversation/archive records are outside the default workflow dispatch path and remain intact. No automatic commit or push.
