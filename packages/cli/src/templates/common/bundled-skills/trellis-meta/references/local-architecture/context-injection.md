# Local Context Injection System

Trellis context injection aims to make AI read the right files at the right time instead of relying on model memory. In a user project, injection is implemented by `.trellis/` scripts together with platform hooks, agents, and skills.

## Injected Context Types

| Type | Source | Purpose |
| --- | --- | --- |
| session context | `.trellis/scripts/get_context.py` | Current developer, git status, active task, active tasks, journal, packages. |
| workflow context | `.trellis/workflow.md` | Current Trellis flow and next action. |
| spec context | `.trellis/spec/` + task JSONL | Specs that must be followed during implementation/checking. |
| task context | `.trellis/tasks/<task>/prd.md`, `design.md`, `implement.md`, `research/` | Current task requirements, design, execution plan, and research. |
| platform context | Platform hooks/settings/agents | Lets different AI tools read the files above through their own mechanisms. |

## session-start

Platforms with session-start support inject a Trellis overview when a session starts, clears, compacts, or receives a similar event. Injected content usually includes:

- workflow summary.
- current task status.
- active tasks.
- spec index paths.
- developer identity and git status.

If the user feels the AI does not know the current task in a new session, first check whether the platform's session-start hook or equivalent mechanism is installed and running.

## workflow-state

workflow-state is a lightweight hint injected around each user turn. Based on current task status, it selects a block from `.trellis/workflow.md`, such as `no_task`, `planning`, `in_progress`, or `completed`.

If the user wants to change "what the AI should do next in a given state," edit the corresponding state block in `.trellis/workflow.md` first.

## Task and Spec Context

The current agent reads `prd.md`, optional `design.md` / `implement.md`, research, and applicable specs directly. Use `trellis-before-dev` to discover and read guidelines and `trellis-check` for verification. Existing legacy JSONL files remain user-owned task material; they are not generated or required for task start.

## Active Task And Context Key

Active task state lives in `.trellis/.runtime/sessions/` and is isolated per session. Hooks try to resolve the context key from platform events, environment variables, transcript paths, or `TRELLIS_CONTEXT_ID`.

If shell commands cannot see the same context key, `task.py current --source` may report no active task. In that case, check whether the platform passes session identity into the shell instead of hand-writing a global current-task file.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Change session-start injected content | The platform's `session-start` hook or plugin file. |
| Change per-turn workflow-state rules | `[workflow-state:STATUS]` block in `.trellis/workflow.md`. The platform workflow-state hook parses these blocks verbatim and embeds no fallback text. |
| Change task/spec preparation | `.trellis/workflow.md`, `trellis-before-dev`, and task artifacts. |
| Change JSONL validation/display | `.trellis/scripts/common/task_context.py`. |
| Change active task resolution | `.trellis/scripts/common/active_task.py`. |

When modifying context injection, verify two things: new sessions can see the correct task, and the current agent loads the correct task artifacts/spec/research.
