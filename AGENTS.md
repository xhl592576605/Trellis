# trellis-wiki 开发指南

trellis-wiki 是 [Trellis](https://github.com/mindfold-ai/Trellis) 的 fork（AGPL-3.0-only）：双 npm 包 + 外部本地 wiki 存储。本文件是项目事实的统一入口；目录导航见 [CODEMAP.md](./CODEMAP.md)。

## 常用命令（仓库根执行）

```bash
pnpm build                                 # 先 core 后 cli
pnpm test                                  # 全量测试（core + cli）
pnpm lint && pnpm typecheck
pnpm --filter trellis-wiki lint:py         # basedpyright，含模板 Python
node packages/cli/scripts/release-preflight.js check-versions
node packages/cli/scripts/release-preflight.js verify-packed-cli
node packages/cli/bin/trellis.js <cmd>     # 本地运行 CLI（需先 build 出 dist）
```

Trellis 任务脚本（task.py / get_context.py 等）不在本仓库：先读根目录 `.treills.conf.json`（storage + project），再调用 `<storage>/<project>/scripts/*.py`。本仓库的 `.trellis` 只是浏览链接，删除它不影响运行；脚本执行的 cwd 保持当前 checkout。

## 架构与包边界

- `packages/cli` = `trellis-wiki`：CLI 命令、平台 configurators、分发模板、迁移 manifest、发布脚本。
- `packages/core` = `trellis-wiki-core`：channel / mem / task / testing 领域 SDK；不得打印终端输出、不得 `process.exit`、不得依赖 Commander/Chalk。
- CLI 只通过公开子路径 import core（`trellis-wiki-core/channel` 等）；两包版本锁步，一个 git tag 一个版本。
- `marketplace/` 是内置模板市场目录（本仓库内容，`--registry`/`workflow -m` 默认拉取源，勿删）。
- 写码前读 `/Users/xuhuale/.trellis-wiki/Trellis/spec/cli/backend/index.md`（或 core/unit-test 对应层）的 Pre-Development Checklist。

## 双 Git 边界

- 代码提交 → 本仓库；任务 / 日志 / 归档提交 → 外部存储仓库（finish-work 自动完成，严格限定当前任务路径）。
- 禁止 `git add -A` 全库暂存；`.trellis` 相关暂存只能走 `safe_commit.py` 白名单。

## 兼容承诺（勿破坏）

`trellis` / `tl` 命令别名、`/trellis:*` 斜杠命令、`trellis-*` skills、`TRELLIS_*` 环境变量、`.treills.conf.json`、`~/.trellis-wiki` 存储布局、`.trellis` 浏览路径——全部保留；不为品牌更名做第二次数据迁移。

## 发布

CI-only：先 core 后 CLI；发布前 gate 为 `check-manifest-continuity` + `check-release-manifest`（本地 manifest 发布说明校验，取代旧 docs-site 检查）+ `verify-packed-cli`。禁止本地 `npm publish`。详见 `/Users/xuhuale/.trellis-wiki/Trellis/spec/cli/backend/release-process.md`。

## 文档地图

- [CODEMAP.md](./CODEMAP.md) — 目录职责导航。
- `/Users/xuhuale/.trellis-wiki/Trellis/spec/` — 分层编码规范（外部存储内）。
- 局部 `AGENTS.md` 仅在真实职责边界添加；默认继承本文件。

提交代码前，检查当前 staged 的文件并保持 CODEMAP.md 同步：新增文件或目录要添加条目，已删除的条目要移除，职责变化的目录要更新描述。

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `/Users/xuhuale/.trellis-wiki/Trellis/workflow.md` — development phases, when to create tasks, skill routing
- `/Users/xuhuale/.trellis-wiki/Trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `/Users/xuhuale/.trellis-wiki/Trellis/workspace/` — per-developer journals and session traces
- `/Users/xuhuale/.trellis-wiki/Trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
