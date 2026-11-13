# Implementation plan

- [x] Inspect platform collectors, shared templates, task runtime, extension entry points, and update migration mechanisms.
- [x] Replace default and dogfood workflow plus common entry skills with current-agent instructions.
- [x] Remove task manifest generation/readiness and Codex dispatch selection; preserve task lifecycle.
- [x] Retire workflow subagent definitions/hooks/tools across platform integrations.
- [x] Add/update migration and regression coverage for init/update and current-agent execution.
- [x] Synchronize relevant specs and dogfood runtime.
- [x] Run pnpm lint, pnpm typecheck, pnpm build, and relevant/full CLI tests.

## Authorization

The user reviewed the workflow replacement and task-system preservation scope, then explicitly said to begin implementation. No further implementation approval is needed for that scope.

## Risks

Cross-platform integration changes have a broad blast radius. GitNexus MCP and the project runner are unavailable; CLI fallback installation was attempted but timed out. Use direct caller inspection and regression tests, report that graph analysis could not be completed.

## Verification Results

- `pnpm typecheck`: passed.
- `pnpm lint`: passed.
- `pnpm build`: passed.
- Full CLI regression suite: 1,663 passed, 0 failed.
- `pnpm --filter @mindfoldhq/trellis lint:py`: 0 errors; 68 pre-existing unused-import warnings in unchanged re-export modules.
- Changed Python scripts compile; local Claude/Codex breadcrumbs and local Pi extension syntax/no-dispatch smoke checks pass.
- `git diff --check` and marketplace diff check pass.
- Native and TDD marketplace templates are committed in the marketplace submodule as `a12743f`.
- GitNexus graph analysis was unavailable (missing MCP/local runner; CLI fallback timed out). Direct source inspection and regression tests were used instead.

## Completion State

Implementation is verified. The user explicitly invoked git-commit, authorizing work commits in the marketplace submodule and main repository. Archive and session recording follow the work commits. Existing task manifests and customized legacy role files are preserved. Independent channel runtime remains outside this default-workflow replacement.

## Follow-up: project ignore rules

Added `!/.trellis/` to the root .gitignore to override the developer-global `.trellis` exclusion. Verified task.json, PRD, design, and implementation plan are trackable; developer identity, session runtime, Python caches, and the existing explicitly ignored research task remain ignored. No staging or commits performed.
