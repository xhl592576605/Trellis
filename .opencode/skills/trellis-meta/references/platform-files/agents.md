Before executing Trellis commands, read .treills.conf.json in the current code checkout. Resolve storage/project (expanding ~) and use that project's real scripts and data paths. Keep command cwd in this checkout. The .trellis browse link is optional. If the locator changed since installation, resolve the current paths before using the examples below.

# Agent Execution

The default workflow runs research, implementation, and checking in the current agent on every platform.

- Edit `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` for phase order and execution instructions.
- Use the `trellis-before-dev` skill for guideline loading.
- Use the `trellis-check` skill for quality verification.
- Keep task materials under `/Users/xuhuale/.trellis-wiki/Trellis/tasks/`; record essential spec/research references in task documents.
- Kiro retains `.kiro/agents/trellis.json` as its main workflow agent with session and per-turn hooks.

## Independent Channel Workers

The separate `trellis channel` runtime uses `'/Users/xuhuale/.trellis-wiki/Trellis/agents/{implement,check}.md'`. These definitions belong to explicitly requested channel collaboration and are not part of default workflow execution. Customize them only when changing channel worker behavior.
