# Trellis 外部本地存储实施计划

## 执行前提

- 当前任务为 `in_progress`；阶段 1–4 的本轮复核发现已修复，85 文件 / 1701 测试通过。详见 research/20261113-2149-stage-1-4-review.md。
- 本计划已与 `prd.md`、`design.md`、代码研究一起评审并获得实施授权；task.py start 已执行。未完成的后续阶段仍按本计划推进。
- 本次产品目标是配置驱动的外部存储。`.trellis` 仅为浏览链接，不能用现有外链测试通过来替代新模式验收。
- 不自动提交本次规划或后续实现；Git commit/push 遵守用户授权。产品 finish-work 的外部提交能力属于要实现的功能。

## 阶段状态

- 阶段 1–4：已完成。含专项复核（research/20261113-2149-stage-1-4-review.md）、F1–F9 修复与回归：85 文件 / 1701 测试、build/lint/typecheck/lint:py、git diff --check 全部通过。
- 阶段 5：已完成。新增 `common/data_git.py`（两仓库上下文、storage 级提交锁、待恢复状态）、精确归档路径、混合共享文件守卫、`--require-commit`/`--include-path`、finish-work 模板更新。
- 阶段 6：已完成。`commands/storage-migration.ts`（只读探测→复制校验→workspace 转换→hash 拆分→外部提交→配置+链接切换，持久化阶段检查点、源/快照摘要、同一命令刷新接入、源目录保留为 `.trellis.pre-migration.*`）；`trellis update --migrate-storage` 接入；0.7.0 breaking manifest（migrationGuide/aiInstructions/requiresStorageMigration）与 update 存储迁移门禁 + `crossesStorageMigration` 助手。
- 阶段 7：已完成。uninstall 外部模式（过滤 `.trellis/*` 清单、删根配置+链接、跳过 dirty guard、保留外部数据）；ablate/restore 外部模式（清单过滤、CONF 入事务、restore 前验证外部绑定、保留兄弟 worktree 写入）；`managed-removal` 链接感知删除（link 只 unlink 不递归）。
- 阶段 5–7 专项复核：已修复提交归属、延迟归档身份、源删除恢复、迁移 gate/检查点/接入刷新和移除/还原边界；详见 [复核记录](research/20261114-0905-stage-5-7-review.md)。
- 阶段 5–7 验证：88 文件 / 1741 测试、lint/typecheck/build、lint:py（0 errors / 74 warnings 既有基线）、双树字节一致、git diff --check 全部通过；编译产物在真实临时 Git 项目完成迁移→无链接 context→延迟归档/required journal→ablate/restore/uninstall 冒烟。
- 阶段 8：已完成本机集成验收、入口修复、规范及手测说明；详见 [验收矩阵](research/20261114-1032-stage-8-acceptance.md) 和 [.agents/handoff/20261114-1032-external-storage-manual-test.md](../../../.agents/handoff/20261114-1032-external-storage-manual-test.md)。最终 89 文件 / 1750 测试、lint/typecheck/build/lint:py、双树字节检查及 git diff --check 通过；新建/迁移编译 CLI、链接故障探测及说明路线 A 已实跑。Windows 和真实宿主 sandbox 限制明确保留，未提交/归档开发任务。

环境注记：本机全局 `~/.gitignore` 含 `.trellis`（正是 safe_commit 文档记载的事故类别），会使 legacy Git fixture 的 `git add -A` 静默失效；相关测试 fixture 已统一加 `core.excludesFile=/dev/null` 隔离。

## 手测后修复：bootstrap PRD 路径

- 用户发现 `00-bootstrap-guidelines/prd.md` 的表格仍依赖 `.trellis` 浏览入口。已将独立 PRD 生成器接入实际外部根，覆盖单项目文件表、guides、monorepo 标题/目录及收尾命令；命令复用 shell 安全渲染。task.json 的逻辑 relatedFiles 与重复 init 不覆盖用户 PRD 的契约保持不变。
- 新增两项回归：无链接时所有文档目标存在、空格/中文命令可执行并保留 re-init 用户编辑；monorepo 引用指向对应外部包规范。
- 相关 4 个文件 / 82 个测试、lint、typecheck、build、编译 CLI 完整冒烟及 diff 检查通过。提交前已重新执行全量 89 文件 / 1752 测试，全部通过；lint、typecheck、build、lint:py（0 errors / 74 条既有 warnings）也通过。
- 已对用户之前默认沙盒 `/Users/xuhuale/.trellis-wiki/code/tasks/00-bootstrap-guidelines/prd.md` 做 19 处明确路径替换，保留其余内容；没有批量改写其他已存在 PRD，也没有提交。

## 提交与收尾授权

2026-11-14 用户确认任务完成并授权本地提交，继续此前 finish-work 的归档与日志步骤，不推送。最终检查通过 89 文件 / 1752 测试、lint/typecheck/build/lint:py、双树回归；提交前恢复了此前读取截断导致遗漏的 channel 规范尾部，仅保留 68 行追加内容。本任务在 main 上直接完成，未创建 PR，归档时按本地非 PR 任务使用 --skip-branch-validation。

## 适用规范

执行对应阶段前按 `.trellis/spec/cli/backend/index.md` 读取具体规范全文，重点为 filesystem-safety、script-conventions、platform-integration、configurator-shared、workflow-state-contract、commands-update、migrations、commands-uninstall、commands-ablate、commands-channel。涉及 core 时读取 core/backend/index 与 trellis-core-sdk；测试读取 unit-test/conventions、mock-strategies、integration-patterns。跨平台契约读取 shared guides。

用户已明确允许本任务跳过 GitNexus；当前 agent 直接核查调用路径、跨层边界与回归，不派发 Trellis 子代理，不冒称已执行图索引 impact。

## 1. 固定路径契约与最小端到端测试

对应：R1/R2/R3/R8，AC1/AC2/AC9/AC11/AC15。

- [x] 读取当前任务与最新用户确认，检查 Git 状态，不覆盖用户已有修改。
- [x] 以新模式 fixture 描述 codeRoot、storageRoot、trellisDir、checkoutKey；覆盖默认/自定义根、空格/中文和无浏览链接。
- [x] 先增加最小失败测试：配置存在、项目内没有 `.trellis`，仍能执行 context/task。
- [x] 在 CLI 既有工具层和 Python common 路径层实现配置解析与绑定验证，不新增 public CLI 转发命令或无必要 core API。
- [x] 统一项目名/路径边界、独立 Git 根和绑定校验；只给当前项目外部目录授权。
- [x] 明确外部资料与代码资料引用的根域，转换旧 `.trellis/...` 引用；保持旧历史内容不被全局替换。

重点文件：`src/constants/paths.ts`、`src/utils/` 中必要的新存储解析工具、`src/templates/trellis/scripts/common/paths.py`、`active_task.py`、`config.py`、`trellis_config.py`、`task_context.py`、`packages_context.py`、`session_context.py`、`workflow_phase.py`。

评审门：配置无效时清楚失败；浏览链接是否存在完全不参与运行成功判定；代码 Git 根不漂移。

## 2. 单用户 workspace 与任务运行时

对应：R4，AC3/AC4/AC5/AC7/AC14/AC15。

- [x] 为 task create、journal 和 record context 无 developer 场景增加行为测试。
- [x] 扁平化新 workspace 的目录定位，保留 index/journal-N 轮转。
- [x] 取消运行时对 `.developer` 的强制前置；保留 canonical task 字段与历史作者。
- [x] 保留 session identity 与 shell ticket 协议，按统一外部 runtime 位置读写；验证同项目两个 checkout 的隔离。
- [x] 拆分代码提交证据查询与外部 journal Git 历史查询（代码侧证据查询按代码仓库 cwd 解析；外部 journal 编号/HEAD/refs 查询按 storage 解析，随阶段 5 落地）。
- [x] 项目级保护编号分配、journal 追加和 index 更新，保持现有幂等 checkpoint。
- [x] 更新单用户任务列表和上下文显示，移除新运行中错误的开发者初始化提示。

重点文件：`task_store.py`、`task_queue.py`、`developer.py` 的调用点、`add_session.py`、`common/paths.py`、`common/active_task.py`、`common/session_context.py`、`common/task_utils.py`。

评审门：不改变 branch/base_branch/PR/worktree 语义；若无需修改 core schema/records，就保持其实现不动。

## 3. Agent 配置 bootstrap 与真实路径注入

对应：R3/R8，AC3/AC4/AC13/AC15。

- [x] 使用平台注册表建立受影响入口清单，覆盖 Python hooks、Pi/OMP、OpenCode、Snow 与无 hook skills。
- [x] 在模型看到上下文之前解析根配置，加载外部脚本；直接宿主调用使用 argv 和真实 codeRoot cwd。
- [x] 更新 start/continue/finish-work、before-dev/check 等提示词中实际执行的脚本和文件入口，使用解析后的外部路径。
- [x] 所有平台的任务/spec/research 读取统一限定在 codeRoot 和当前绑定 trellisDir，不放开整个用户存储根。
- [x] 同步 shell bridge 写端、Python task 读端与平台直接 session 读取。
- [x] 保留 neutral shared skills 与现有 Python/Windows 渲染约束。
- [x] 验证宿主的外部读写配置；无法验证的平台明确记录限制，不以存在软链接代替权限验证。

重点目录：`templates/shared-hooks/`、`templates/claude/hooks/`、`templates/codex/hooks/`、`templates/copilot/hooks/`、`templates/opencode/lib/` 与 plugins、Pi/OMP extension 模板、Snow hook、`templates/common/commands/`、skills 和 bundled-skills；`configurators/shared.ts` 及必要平台 collector。

评审门：在没有浏览链接的 fixture 上，task current、workflow-state、context 和手动 skill 入口看到同一任务；跨项目逃逸仍被拒绝。

## 4. 外部 init、安装清单与浏览链接

对应：R1/R2/R4/R6/R7，AC1/AC2/AC9/AC11/AC12/AC14。

- [x] init 增加 storage/project 选项，默认创建 `~/.trellis-wiki` 本地 Git 仓库；已有目录检查 Git 根和项目归属。
- [x] 首次初始化、重复初始化、添加平台和中断恢复依据项目/安装状态，不依据 `.developer`。
- [x] 保留首次 bootstrap，停止单用户模式下的 joiner 生成。
- [x] 公共外部模板 hash 与每个 checkout 的平台安装 hash 分开管理，复用实际写入和用户修改保护。
- [x] 平台识别、版本检查、manifest pruning 和更新计划读取正确的归属域。
- [x] 根配置及浏览链接进入准确的管理清单；不把外部产品数据纳入 checkout 删除清单。
- [x] 创建浏览链接：正确链接幂等，错链/断链可诊断，实体目录不覆盖；Windows 评估 junction（实机 junction 验证仍属平台限制）。
- [x] 迁移 journal 相关 Git 属性与 ignore 规则；链接作为本机入口排除，不自动提交真实代码仓库。

重点文件：`cli/index.ts`、`commands/init.ts`、`configurators/workflow.ts`、`configurators/index.ts`、`utils/template-hash.ts`、`manifest-prune.ts`、`registry-config.ts`、`templates/markdown/agents.md` 和 gitignore/gitattributes 模板。

评审门：同一外部项目的 main/Pi 与 feature/Codex 安装记录互不覆盖；删除浏览链接后仍可正常运行。

## 5. 外部任务级提交与 finish-work 恢复

对应：R5，AC4/AC6/AC7。

- [x] 先构造回归场景：另一个项目有 staged 修改、同项目其他任务有修改、archive 子树有别的未提交任务（test/scripts/external-task-commit.integration.test.ts）。
- [x] 精确计算当前 task 的归档源/目标与实际变更的父子任务，收紧原来收集整个 archive 子树的路径（只收集 archive/<YYYY-MM>/<task> 与子任务 task.json）。
- [x] 外部仓库级串行保护 stage/commit，保留其他 staged/未 staged 文件状态（storage .runtime/commit.lock，进程内重入计数；项目锁→仓库锁固定顺序）。
- [x] journal 按项目串行写入；已有混合共享文件不能整文件当作当前任务提交（干净基线/写后快照 + foreign marker 守卫 + COMMIT_MIXED；session_auto_commit=false 不再绕过最终提交归属检查）。
- [x] finish-work 显式记录本次任务身份、归档目标和外部相关文件，补齐 spec/research 等本次数据变更的提交检查（--include-path 显式声明；模板与 dogfood 技能同步更新）。
- [x] 归档后 Git 失败保存待恢复状态；重试不重复归档、不重复 journal、不因当前 session 指针已清而遗漏提交（pending-task-commit.json 保存精确目标及 checkout/session owner，含 --no-commit；同会话自动冲刷，跨会话须 --recover-archive 显式选择；幂等早退同样处理恢复及 include）。
- [x] 保留脚本中间步骤开关，但最终收尾提交要求不能被 session_auto_commit=false 静默绕过（--require-commit 显式覆盖并报告；与 --no-commit 互斥）。
- [x] 区分输出代码提交与外部数据提交，不进行任何外部 remote 操作（证据查询走 codeRoot，编号/HEAD 走 storageRoot，外部提交报告附 storage 路径）。

重点文件：`common/safe_commit.py`、`common/git.py` 的调用点、`common/task_store.py`、`add_session.py`、`templates/common/commands/finish-work.md` 和 workflow 收尾说明。

评审门：实际检查外部 commit 的文件列表；发生混合归属或提交失败时保留数据并明确未完成，绝不假成功。

## 6. 显式存储迁移与 update 适配

对应：R6，AC3/AC5/AC8/AC10/AC14。

- [x] 复用现有 update 操作模型，新增专门命令 `trellis update --migrate-storage`（commands/storage-migration.ts），不扩展普通 rename-dir 为任意越界移动（test/commands/update-migrate-storage.integration.test.ts）。
- [x] 为新 breaking 发布准备 migrationGuide、aiInstructions 和显式 migration gate（0.7.0 manifest + requiresStorageMigration + update 门禁 + crossesStorageMigration 助手）；普通模板更新不生成半迁移状态（门禁硬失败，允许 --dry-run 预览）。
- [x] dry-run 只读；正式迁移在完整用户数据复制并逐文件字节校验后切换配置（verifyCopy，不匹配则中止且源目录未动）。
- [x] 检查源/目标 realpath 包含关系（prepareExternalStorage 复用：storage 不得在代码 checkout 内、不得同 Git 根）。
- [x] 处理旧 `.developer`、单历史 workspace、多目录歧义（无 `.developer` 且多目录时报错要求 `--workspace`；其余作者入 workspace/history/，不丢弃历史）。
- [x] 转换安装清单引用（hash 拆分为 shared + checkout 双清单）；保留旧代码 Git 历史（迁移不提交代码仓库，删除差异留给用户）。
- [x] 复制、校验、根配置切换、浏览链接、外部迁移提交分别可恢复（独立导入快照与 prepared/committed/switched/refreshed/complete 持久检查点；源数据和目标变更校验、精确导入/刷新提交，源原件保留于 `.trellis.pre-migration.*`）。
- [x] 新运行只接受配置模式；旧布局检测仅用于显式迁移引导（已有配置时 update 提示；迁移幂等重入）。
- [x] 新版本更新继续保护外部用户数据与当前 checkout 的平台自定义内容（外部模式 update 走阶段 4 已有 hash/manifest 分域）。

重点文件：`commands/storage-migration.ts`（新增）、`commands/update.ts`、`cli/index.ts`、`migrations/index.ts`、`types/migration.ts`、`migrations/manifests/0.7.0.json`（新增）、`utils/external-store.ts`、`utils/template-hash.ts`、`configurators/workflow.ts`。

评审门：中断点注入后的重试收敛；已有用户修改、新旧目标冲突、其他项目不受影响；用户有明确原件恢复位置。

## 7. Uninstall / ablate / restore 只处理接入

对应：R6/R7，AC8/AC12。

- [x] 按当前 checkout 的安装清单生成删除/修改计划，过滤外部产品数据模板（uninstall/ablate 外部模式过滤 `.trellis/*` key）。
- [x] uninstall 只删除本地 agent 接入、根配置和浏览链接，外部数据字节保持不变（含 `.trellis` 链接只 unlink 不递归；外部模式跳过 dirty-data guard 并声明保留）。
- [x] ablate 保存本地配置、平台文件、管理块与链接目标，不对共享外部数据建回滚快照（`.trellis` 链接按链接指纹备份；CONF 入事务；不备份外部目录）。
- [x] restore 验证当前外部绑定并恢复本地接入，保留另一 worktree 在期间写入的任务/日志（备份 CONF 复用运行时解析/包含关系/Git 绑定验证；缺失或改绑则零 checkout 写入报冲突）。
- [x] 保持严格路径保护、结构化配置 scrubber、用户非管理字段、dry-run 与恢复冲突检查（test/commands/external-lifecycle.integration.test.ts；既有 uninstall/ablate 套件全绿）。

重点文件：`commands/uninstall.ts`、`commands/ablate.ts`、`utils/managed-removal.ts`、`utils/ablation-store.ts`（未改，复用 symlink 指纹/恢复）、`utils/manifest-prune.ts`（未改）。

评审门：在其他 worktree 持续使用同一项目的 fixture 上执行移除/恢复，外部数据和兄弟 checkout 接入均不被修改。

## 8. 集成检查与文档

验收证据与平台限制见 research/20261114-1032-stage-8-acceptance.md。此阶段完成不代表 Windows 或真实 AI 宿主交互已实测；代码提交与当前开发任务收尾仍待用户授权。

- [x] 用一个真实临时 Git 项目串联 init → context → task → continue → code evidence → archive/journal → 外部 commit。
- [x] 移除 `.trellis` 浏览链接后重跑核心流程；再修复浏览入口确认指向同一份数据。
- [x] 覆盖两个项目、同项目两个 worktree、不同 agent 安装、已有 staged 修改、提交失败重试与共享文件冲突。
- [x] 检查 mem/channel 的代码 cwd 与项目筛选保持原意。
- [x] 更新相关 spec、模板说明和迁移指南，区分新实际能力与旧路径说明。
- [x] 本仓库 dogfood `.trellis/scripts` 与发行模板按项目规范同步，迁移本仓库自身数据必须另经明确授权，不夹在产品开发中执行。
- [x] 最后一轮按 trellis-check 执行跨层质量检查，报告未验证的平台行为。

## 验证命令

规划阶段已执行且通过：

```bash
pnpm --filter @mindfoldhq/trellis exec vitest run test/scripts/symlinked-workflow-dir.integration.test.ts
```

该测试是旧 Python 链接支持的基线（4 tests），不是配置模式或外部 Git 的完成证明。

实施时优先运行实际改动对应的测试文件：

```bash
pnpm --filter @mindfoldhq/trellis exec vitest run test/scripts/add-session.integration.test.ts test/scripts/task-archive.integration.test.ts
pnpm --filter @mindfoldhq/trellis exec vitest run test/commands/init.integration.test.ts test/commands/update.integration.test.ts
pnpm --filter @mindfoldhq/trellis exec vitest run test/commands/uninstall.integration.test.ts test/commands/ablate.integration.test.ts test/commands/init-uninstall-overdelete.integration.test.ts
pnpm --filter @mindfoldhq/trellis exec vitest run test/configurators/platforms.test.ts test/configurators/index.test.ts
```

新增配置、外部 Git、并发与无链接端到端测试的实际路径在实现时确定，避免计划列出尚不存在的测试文件冒充已执行。

由于最终影响跨整套平台和更新流程，完成时运行一次 CLI 全范围验证：

```bash
pnpm --filter @mindfoldhq/trellis lint
pnpm --filter @mindfoldhq/trellis typecheck
pnpm --filter @mindfoldhq/trellis lint:py
pnpm --filter @mindfoldhq/trellis build
pnpm --filter @mindfoldhq/trellis test
```

仅实际修改 core 或其声明消费边界时增加 core lint/typecheck/test 与根 typecheck。Windows/junction 和宿主 sandbox 需要对应环境验证；未执行时明确列为限制。

## 回滚边界

- 实现阶段：只回退本任务改动，不覆盖用户工作。
- 用户迁移：配置切换前保留原目录；切换后的恢复依赖明确检查点和原件备份，不覆盖用户后续修改。
- Git 失败：保留待提交产物和恢复身份，不做 reset/clean 或自动移除 index.lock。
- 移除/恢复：只恢复当前 checkout 接入，不回滚外部产品数据。

## 最终评审门

- [x] 所有 PRD AC 有实际验证或明确平台限制。
- [x] 配置运行、链接浏览的职责在所有入口一致。
- [x] 外部提交范围经 commit 文件列表核对，其他修改保留。
- [x] 迁移与移除恢复无数据丢失，用户显式触发契约可解释。
- [x] 未自动提交/推送本任务代码；后续 commit 按用户授权及 GitNexus detect_changes 要求执行。
