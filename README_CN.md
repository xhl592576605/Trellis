# trellis-wiki

**把规范、任务与会话记忆移出代码仓库的 AI 编码工作流框架——数据保存在你自己的本地 wiki 存储中。**

trellis-wiki 是 [Trellis](https://github.com/mindfold-ai/Trellis) 的 fork（AGPL-3.0-only）。它保留了 Trellis 的工作流——任务头脑风暴、规范注入、工作日志——并把全部工作流数据迁移到外部本地 Git 存储，让任意 Coding Agent 按你的工程标准工作，同时不弄乱源码树。

[English](./README.md)

## 为什么用 trellis-wiki？

| 能力 | 带来的改变 |
| --- | --- |
| 外部 wiki 存储 | 任务、规范、日志和脚本存放在 `~/.trellis-wiki`（所有项目共享一个本地 Git 仓库），不再进入代码仓库。 |
| 定位配置 | 代码仓库只保留一个 `.treills.conf.json` 定位配置和各平台接入；`.trellis` 链接仅用于浏览。 |
| 清晰的双重 Git 边界 | 代码提交留在代码仓库；任务与日志提交由 finish-work 写入存储仓库。 |
| 多平台接入 | 同一套工作流可安装到 Claude Code、Codex、Cursor、Pi、OpenCode 等平台——运行 `trellis-wiki init --help` 查看当前支持列表。 |
| 命令兼容 | `trellis` 与 `tl` 继续可用，`/trellis:*` 命令、skills 和 `TRELLIS_*` 环境变量保持不变。 |

## 前置要求

- Node.js >= 18.17.0
- Python >= 3.9

## 安装

```bash
npm install -g trellis-wiki
```

> `trellis-wiki` npm 包是本 fork 的正式发布入口。尚未发布期间可本地构建：
>
> ```bash
> git clone https://github.com/xhl592576605/Trellis.git
> cd Trellis && pnpm install && pnpm build
> node packages/cli/bin/trellis.js --version   # 0.7.0
> ```

## 初始化项目

```bash
# 选择你实际使用的 AI 平台
trellis-wiki init --pi --codex

# 外部存储为默认模式（存储根目录默认 ~/.trellis-wiki）
trellis-wiki init --pi --storage ~/my-wiki --project my-project
```

无需注册开发者身份。初始化后会创建：

```text
your-code-repo/
├── .treills.conf.json      # 定位配置: { "storage": "~/.trellis-wiki", "project": "my-project" }
├── .trellis -> ~/.trellis-wiki/my-project/   # 仅浏览用链接（可删除）
├── .pi/  .codex/ …         # 平台接入（hooks、skills、commands）

~/.trellis-wiki/            # 所有项目共享的本地 Git 仓库
└── my-project/
    ├── tasks/  spec/  workspace/   # PRD、规范、日志
    ├── scripts/  config.yaml  project.json
```

运行时始终先读取 `.treills.conf.json` 解析真实目录——`.trellis` 链接不是执行的前提。

## 日常工作流

1. 用自然语言描述需求；AI 与你一起规划任务（一次一个问题），并把 PRD 写入存储。
2. 实现与质量检查对照你的规范、lint、type-check 和测试执行。
3. 输入 `/trellis:finish-work` 收尾：任务归档、日志提交——写入**存储仓库**且仅限本任务范围。代码变更照常提交到代码仓库。

## 从 @mindfoldhq/trellis 切换

切换 npm 包与迁移项目数据是两个独立步骤。

**1. 更换全局 CLI**（不要为此运行项目级 `uninstall`——那会移除平台接入）：

```bash
npm uninstall -g @mindfoldhq/trellis
npm install -g trellis-wiki
trellis-wiki --version && trellis --version && tl --version   # 均为 0.7.0
```

**2. 迁移旧的仓库内 `.trellis`：**

```bash
trellis-wiki update --migrate-storage --dry-run     # 预览，不写入
trellis-wiki update --migrate-storage               # 复制 + 校验 + 切换
```

- 可选参数：`--storage <dir>`、`--project <name>`；仅当旧 workspace 有多个开发者目录且无 `.developer` 时才需要 `--workspace <name>`。
- 原 `.trellis` 会保留为 `.trellis.pre-migration.<timestamp>/`——这是你的恢复副本，确认无误后可自行删除。
- 中断后重新执行同一命令即可从持久化检查点续跑。
- 迁移不会提交你的代码仓库；相关删除变更请自行提交。

已经在外部存储上的项目无需再次迁移——直接运行 `trellis-wiki update`，现有存储目录、绑定与数据原样复用。

## 兼容性说明

- 命令：`trellis-wiki`（主命令），`trellis` 与 `tl`（别名）运行同一 CLI。
- AI 入口：`/trellis:*` 斜杠命令、`trellis-*` skills、`TRELLIS_*` 环境变量与 `.trellis` 浏览路径保持不变。
- SDK 使用方：core 包更名为 `trellis-wiki-core`，请更新依赖名与 import：

```ts
import { createChannel } from "trellis-wiki-core/channel";
import { searchMemSessions } from "trellis-wiki-core/mem";
```

旧 `@mindfoldhq` scope 下没有重定向包。

## upgrade 与 update 的区别

- `trellis-wiki upgrade` —— 升级全局安装的 CLI（执行 `npm install -g trellis-wiki@<tag>`）。
- `trellis-wiki update` —— 刷新项目模板、hooks 与平台接入并应用文件迁移。跨越 0.7.0 的旧仓库内布局会被拒绝，直到执行 `--migrate-storage`。

## 卸载与数据保留

`trellis-wiki uninstall` 移除当前 checkout 的平台接入、管理块、定位配置和浏览链接。它不会删除外部存储——任务、规范与日志在卸载和重装后依然保留。

## 本地开发

```bash
pnpm install
pnpm build          # 先 trellis-wiki-core 后 trellis-wiki
pnpm test           # core + cli 测试套件
pnpm lint && pnpm typecheck
node packages/cli/scripts/release-preflight.js check-versions
node packages/cli/scripts/release-preflight.js verify-packed-cli
```

| 包 | 职责 |
| --- | --- |
| `packages/cli`（`trellis-wiki`） | CLI 命令、平台配置器、模板、迁移与发布脚本。 |
| `packages/core`（`trellis-wiki-core`） | channel/task/mem 领域 SDK，提供 `/channel`、`/mem`、`/task`、`/testing` 子路径导出。 |

发布仅通过 CI（先 core 后 CLI，一个 git tag 对应一个版本）；见 `.trellis/spec/cli/backend/release-process.md`。

## 路线图（TODO）

- [ ] **UI 开发细化**：基于本地数据的 Web UI——任务看板（状态/负责人视图）、channel 会话列表与事件时间线、mem 召回结果浏览、update/迁移状态面板。先做只读本地版，不引入云端服务。
- [ ] **Bug 处理流程**：报告 → 复现 → 定位（mem / channel 日志）→ 修复 → 回归测试 → 规范沉淀（`trellis-break-loop`）的标准闭环，以及本 fork 的 issue 分诊约定。

## 来源与许可

trellis-wiki 维护于 [xhl592576605/Trellis](https://github.com/xhl592576605/Trellis)。它是 Mindfold [Trellis](https://github.com/mindfold-ai/Trellis) 的 fork——保留原始理念、代码与 AGPL-3.0-only 许可证。见 [LICENSE](./LICENSE)。
