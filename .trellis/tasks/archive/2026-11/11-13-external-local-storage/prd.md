# Trellis 外部本地存储与项目连接配置

## 目标

将真实项目内的 `.trellis` 数据外移到用户统一管理的本地目录，保留现有 agent 初始化、任务、规范注入、continue 和 finish-work 使用流程。运行依靠项目根配置解析并注入外部路径；项目内目录链接只用于查看。

## 背景

当前实现将项目识别、数据、脚本、开发者 workspace、安装管理信息和部分 Git 操作共同放在项目内 `.trellis`。本次改变存储位置及必要的寻址、Git 和迁移边界，不引入 LLM Wiki 知识能力。

代码核查记录在 [实际代码影响核查](research/20261113-1651-code-impact.md)。现有 Python task 的外部链接回归测试已通过，但多平台路径检查、配置 bootstrap、外部 Git 与安装清单仍需实施。

## 已确认决策

| ID | 决策 |
| --- | --- |
| D1 | 默认外部根目录为 `~/.trellis-wiki`，可在 init 时指定；不存在时创建为独立本地 Git 仓库。外部仅做本地提交，不设计 remote/pull/push。 |
| D2 | 外部按项目名称组织原 `.trellis` 内容，并关联真实项目地址。真实代码仓库的分支、remote 和 PR 能力保持原意。 |
| D3 | 项目根使用一个 `.treills.conf.json` 定位配置；文件名沿用用户明确写法。配置是运行时定位依据。 |
| D4 | 初始化或迁移后创建项目内 `.trellis` 目录链接，仅用于浏览和编辑。用户进一步明确：脚本根据配置解析后的真实路径注入和执行，不能依赖此链接。 |
| D5 | 真实项目继续安装 agent 的 skills/hooks/commands/plugins/extensions；不增加 CLI 脚本转发入口。 |
| D6 | 保留 workspace 日志、索引和轮转，取消按开发者分目录及身份初始化前置；复用 task 分支与已有 session 机制。 |
| D7 | finish-work 最终必须提交外部仓库中本次任务相关变更，保留其他项目、同项目其他任务和其他 staged 修改。 |
| D8 | 旧项目由用户显式执行更新/迁移脚本切换，不静默搬迁；以单一外部运行模式规划，不默认长期维护双存储模式。 |
| D9 | uninstall 保留外部数据；ablate/restore 仅保存与恢复当前 checkout 接入、配置和浏览链接，不回滚共享任务、规范与日志。 |

## 需求与约束

### R1 外部本地存储

任务、规范、工作流、workspace、脚本、业务配置及必要管理数据保存到外部项目目录。浏览链接访问同一份数据，不额外复制独立副本。运行态、缓存、锁与备份不进入产品数据提交。

### R2 配置寻址与项目归属

从真实项目根目录或子目录可定位配置及外部项目数据，不以 `.trellis` 链接存在作为项目识别前提。验证绑定，防止同名不同项目误用数据。配置无效时可诊断；错链/断链可以修复，但不得改变有效配置决定的运行目标。

### R3 Agent 工作流

所有现有支持平台的接入方式均纳入适配范围。模型读取上下文之前执行的 hook/plugin/extension 能自行解析配置；无 hook 的 skill 入口也能读取同一配置。启动、压缩恢复、workflow-state、continue 和脚本执行使用注入的外部真实路径，代码操作 cwd 保持当前真实 checkout。

### R4 Task、workspace 与并行会话

任务生命周期、上下文、分支/PR/worktree 与日志继续可用。取消对 `.developer` 的强制依赖，保留首次规范 bootstrap 与中断初始化恢复，不再生成新开发者 joiner onboarding。保留历史作者、负责人、日志和 canonical task schema 的有效性。并行会话不能混用当前任务或丢失日志。

### R5 两仓库与任务级提交

代码分支/提交证据指向真实代码 Git，journal 历史与外部产品数据提交指向外部 Git。提交覆盖归档源删除、目标新增、实际改变的父子任务、journal/index 和本次规范/研究等文件。保留其他任务修改及暂存状态，包括共享文件中无法归属本任务的内容。遇到无法安全归属的混合修改不得默认整文件夹带；提交失败应保留产物并可重试，不得重复写入或误报完成。旧 auto-commit 开关不得使 finish-work 跳过最终要求的外部提交后报告成功。

### R6 初始化、显式迁移与生命周期

init/update/migration 区分代码接入、浏览链接和外部产品数据，保护用户修改。迁移显式触发、复制校验后切换配置，保留原件与恢复能力，旧代码 Git 历史不改写。uninstall 不删除外部数据；ablate/restore 不快照或覆盖共享外部产品数据。

### R7 工作副本安装归属

同项目多个 checkout 可共用任务、规范与日志，但各自安装的 agent 和模板用户修改必须分别识别。对一个 checkout 进行 init/update/uninstall，不能误用另一 checkout 的安装清单或操作其接入。

### R8 路径边界与跨平台可用性

合法外部范围仅限经过验证的当前项目绑定目录。Python 与各平台读取规则一致，继续拒绝其他项目、任意越界路径、目录穿越和任务子目录链接逃逸。配置解析、外部读写和浏览链接分别验证跨平台能力，不以链接存在代替宿主权限验证。

## 验收标准

| ID | 可观察结果 | 对应需求 |
| --- | --- | --- |
| AC1 | 默认/自定义外部目录是预期独立本地 Git 仓库，项目内生成根配置、所选 agent 接入和对应项目的浏览链接。 | R1/R6 |
| AC2 | 同名不同项目不会静默复用；从子目录启动找到正确数据与真实代码根。 | R2 |
| AC3 | 任务在外部位置继续 context/continue、读取材料、检查、归档并记录日志。 | R3/R4 |
| AC4 | 代码 branch/diff/commit/PR 和命令 cwd 保持当前 checkout；外部 Git 只操作对应数据。 | R3/R5 |
| AC5 | workspace 不要求 developer 文件或用户目录，保留日志、索引、轮转和历史。 | R4 |
| AC6 | 两项目及同项目两任务并行时，本次提交不包含其他任务变更，其他 staged/未 staged 修改保留；无法安全归属时明确未完成。 | R5 |
| AC7 | 日志/归档后 Git 失败可重试，内容和编号不重复、任务身份不遗漏、未提交不误报完成。 | R4/R5 |
| AC8 | update 保护两处用户修改；uninstall 不删外部数据；ablate/restore 保留期间其他 checkout 对共享数据的更新。 | R6/R7 |
| AC9 | 空格、中文和用户目录缩写正确解析；显式配置无效给出可定位错误。 | R2/R8 |
| AC10 | 显式迁移后上下文、管理信息和平台入口正确，旧日志、历史作者及代码 Git 历史不丢失。 | R4/R6 |
| AC11 | 错链、断链、目标占用可诊断且不覆盖用户数据；验证 POSIX 链接和 Windows 可用目录链接。 | R2/R8 |
| AC12 | 同项目两个 checkout 分别安装 Pi/Codex 等不同平台时，识别、更新保护和卸载清单各自正确。 | R7 |
| AC13 | 各语言入口读取同一合法外部任务；其他项目文件仍被拒绝。 | R3/R8 |
| AC14 | 首次/重复 init 均不要求开发者姓名，不生成多余 joiner；中断 init 可恢复。 | R4/R6 |
| AC15 | 删除 `.trellis` 浏览链接后，配置有效时仍能完成 context/continue/task/journal/finish-work，执行入口指向外部真实脚本。 | R2/R3 |

## 不在范围

- LLM Wiki 知识摄入、更新、沉淀、向量检索或新模型服务。
- 外部仓库远程同步、push/pull、跨项目管理 UI。
- 重设计任务阶段、分支领域模型、公共 CLI 转发层或多用户 workspace。
- 自动提交本次规划、启动实施，或在本任务规划过程中迁移本仓库自身数据。

## 研究与规范

- [代码影响、证据位置与验证矩阵](research/20261113-1651-code-impact.md)。
- [技术设计](design.md)；[实施计划](implement.md)。
- `.trellis/spec/cli/backend/index.md`：CLI 后端约束入口。
- `filesystem-safety.md`、`script-conventions.md`、`workflow-state-contract.md`：路径、写入、恢复、Python 和会话契约。
- `platform-integration.md`、`configurator-shared.md`：平台和公共模板。
- `commands-update.md`、`migrations.md`：更新与迁移。
- `commands-uninstall.md`、`commands-ablate.md`：移除与恢复。
- `.trellis/spec/core/backend/index.md`、`.trellis/spec/cli/backend/trellis-core-sdk.md`：task schema 与包边界。
- `.trellis/spec/cli/unit-test/index.md`、`.trellis/spec/guides/index.md`：测试、跨层与跨平台检查。

上述无目录前缀的规范文件位于 `.trellis/spec/cli/backend/`。

## 当前状态与验证

任务已获实施授权并处于 in_progress。阶段 1–4 经过专项复核、修复与回归；具体缺陷、证据和修复结果见 [复核记录](research/20261113-2149-stage-1-4-review.md)。

最新验证：89 个测试文件、1752 个测试全部通过；build、lint、TypeScript typecheck 与 git diff --check 通过；Python 检查 0 errors、74 warnings。验证包括默认/自定义外部 init、无浏览链接的核心脚本与已安装 hooks、首次/重复日志、并发与 checkout 隔离，以及 Pi/Codex 安装清单和用户修改保护。

阶段 5–7 的外部任务级提交、显式迁移、卸载/恢复已实施并经 [专项复核](research/20261114-0905-stage-5-7-review.md) 修复和验证；已额外执行编译产物真实临时项目冒烟。阶段 8 本机验收、入口修复和使用说明已完成，见 [AC 验收矩阵](research/20261114-1032-stage-8-acceptance.md)；说明中的新建项目命令已实际执行。Windows junction 与真实平台 sandbox 权限仍需对应环境验收，用户已于 2026-11-14 确认任务完成并授权本地提交，随后按 finish-work 归档和记录日志；不执行 push，不迁移本仓库自身数据。
