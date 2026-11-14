# Change Agent Behavior

The default workflow runs research, implementation, and checking in the current agent on every platform.

- Edit `.trellis/workflow.md` for phase order and execution instructions.
- Use the `trellis-before-dev` skill for guideline loading.
- Use the `trellis-check` skill for quality verification.
- Keep task materials under `.trellis/tasks/`; record essential spec/research references in task documents.
- Kiro retains `.kiro/agents/trellis.json` as its main workflow agent with session and per-turn hooks.

## Independent Channel Workers

The separate `trellis channel` runtime uses `.trellis/agents/{implement,check}.md`. These definitions belong to explicitly requested channel collaboration and are not part of default workflow execution. Customize them only when changing channel worker behavior.
