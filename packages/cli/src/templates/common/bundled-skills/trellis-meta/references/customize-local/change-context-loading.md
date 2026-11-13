# Change Context Loading

Read `.trellis/workflow.md`, `.trellis/config.yaml`, task artifacts, and the active platform entry files before changing context delivery.

## Main-Session Context

- Startup hooks/extensions provide orientation, developer identity, and current task status.
- Per-turn workflow hooks load the matching status block from project workflow.md.
- Shell bridges carry `TRELLIS_CONTEXT_ID` into task.py children. Preserve exact-session lookup and path containment.
- The current agent reads `prd.md`, optional `design.md` / `implement.md`, research, and relevant specs directly through `trellis-before-dev`.
- `trellis-check` loads the same task requirements and relevant quality guidelines for verification.

## Change Points

| Goal | Location |
| --- | --- |
| Change next-step guidance | `.trellis/workflow.md` state blocks and steps |
| Change which specs are read | Task artifact references and `trellis-before-dev` |
| Change compact session orientation | Main-session startup hook/extension and get_context.py |
| Change task lookup | `.trellis/scripts/common/active_task.py` |
| Recover earlier decisions | `trellis-session-insight` / `trellis mem` |

Existing legacy manifest files remain user-owned materials. New tasks do not create them or require them before start. Verify startup, resume, task switches, and compaction after changing main-session context.
