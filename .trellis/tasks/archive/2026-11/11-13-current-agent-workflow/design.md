# Current-agent workflow design

## Execution

Use one shared workflow for all platforms. Keep phase and step numbers; replace 1.3 manifest curation with current-session context preparation. Research happens in the current session. Implementation loads trellis-before-dev; verification loads trellis-check. Remove Codex dispatch-mode variants and role-specific prompts.

## Integration

Stop collecting workflow role definitions and injection hooks in platform template maps. Keep main Kiro agent and all main-session lifecycle/session-identity integrations. Remove Pi workflow dispatch tool registration and OMP role context delivery. Remove pull-based subagent preludes when no longer used. Keep platform-native user extension points.

## Task compatibility

Stop seeding JSONL manifests and stop enforcing manifest readiness. Existing materials are not deleted. Preserve lifecycle/hierarchy and path validation. Preserve legacy manifest commands only if needed to safely maintain existing task data; they must not be required by workflow.

## Update safety

Use existing ownership/hash-aware migration mechanisms for retired managed artifacts; locally modified files must be preserved or surfaced as conflicts. Do not remove user-owned agents or task documents. Synchronize dogfood workflow and Python runtime twins.

## Verification

Exercise generated template maps, phase rendering, task lifecycle without manifests, main-session hooks, and safe update cleanup. Run package lint/typecheck/build and relevant tests, expanding to CLI suite for cross-platform template changes.
