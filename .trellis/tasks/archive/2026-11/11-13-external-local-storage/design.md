# Trellis 外部本地存储设计

## 状态与范围

状态：实施中；用户已授权实施并授权修复阶段 1–4 的复核发现。修复与验证记录见 research/20261113-2149-stage-1-4-review.md。阶段 5–7 已实施并经专项复核修复和验证（research/20261114-0905-stage-5-7-review.md）；阶段 8 本机验收与使用说明已完成（research/20261114-1032-stage-8-acceptance.md）；Windows 与真实宿主 sandbox 限制明确保留，用户手测及提交收尾尚待进行。需求以 `prd.md` 为准，代码证据见 `research/20261113-1651-code-impact.md`。

用户已确定：默认 `~/.trellis-wiki`、外部本地 Git、项目根 `.treills.conf.json`、配置驱动脚本与上下文寻址、`.trellis` 链接只用于查看、取消 developer workspace、显式更新迁移、finish-work 提交本任务外部变更、卸载保留外部数据。不引入知识体系、远程数据同步或 CLI 转发层。

## 1. 目录与所有权

```text
真实代码 checkout/
├── .treills.conf.json
├── .trellis -> <storage>/<project>/     # 浏览入口，可缺失
├── .claude/、.codex/、.pi/、.agents/…  # 原有 agent 接入
└── 源码和测试

~/.trellis-wiki/                       # 或 init 指定的本地目录
├── .git/
├── .gitignore
├── .gitattributes                     # 如需 journal Git 属性，作用于本仓库
└── <project>/
    ├── project.json                   # 项目反向绑定
    ├── config.yaml                    # 原有业务配置
    ├── workflow.md
    ├── scripts/
    ├── agents/                        # 原有 channel runtime agent 定义
    ├── spec/
    ├── tasks/
    ├── workspace/
    │   ├── index.md
    │   └── journal-N.md
    └── .runtime/                      # 忽略：session、ticket、锁、安装管理信息
```

根配置的最小形状：

```json
{
  "storage": "~/.trellis-wiki",
  "project": "Trellis"
}
```

- storage 在读取端显式展开 `~`；自定义目录由 init 参数指定，持久化时消除对临时 cwd 的依赖。
- project 为外部根下的单个目录名，校验路径分隔符、点段、保留目录及实际文件系统大小写冲突。同名不同项目不自动共享。
- project.json 保存项目名称、默认真实 checkout 路径，以及可验证的 Git common-dir 绑定信息。它是外部管理的反向索引，不能覆盖明确的当前 worktree。
- 根配置可以随代码仓库的项目配置政策跟踪；init/migration 不自动提交代码仓库。机器相关的浏览链接应进入本机 Git 排除规则，不应把绝对链接默认提交到代码仓库。
- 外部运行态、锁、缓存、备份与 checkout 安装记录不进入产品数据提交；从现有 ignore 规则迁移并补齐新管理目录。

## 2. 路径契约：配置是唯一运行时定位依据

统一解析结果至少包含：

| 字段 | 含义 |
| --- | --- |
| codeRoot | 当前真实项目/checkout 根，Git、测试和生命周期 hook 的 cwd |
| storageRoot | 外部独立本地 Git 根 |
| trellisDir | 当前项目外部数据根，等于 storageRoot/project |
| scriptsDir | trellisDir/scripts |
| runtimeDir | 当前项目外部运行目录，必要时按 checkout 区分 |
| checkoutKey | 由规范化真实 checkout 路径派生的本机管理标识 |

解析顺序：

1. 使用宿主提供的当前项目/cwd，从当前代码目录向上寻找 `.treills.conf.json`。
2. 解析配置、展开路径并验证 storageRoot 与 project 目录边界。
3. 检查反向绑定：当前代码目录必须是登记项目或其合法 linked worktree；同名无关目录不自动绑定。
4. 派生外部路径，返回带明确根域的结果。
5. 独立检查浏览链接。错链/断链给出诊断和修复方式，绝不让链接决定运行目标。

显式配置损坏或外部数据不存在时不得静默回退。新运行时不把实体 `.trellis` 当作另一个长期存储模式；旧布局仅在显式迁移的探测路径中读取。

从外部管理目录启动的命令必须明确区分管理与代码上下文。没有明确 checkout 时，可使用已验证的反向绑定作为默认入口；不得把 storageRoot 当作代码 Git 根。第一版不增加跨项目 dashboard 或批量管理命令。

## 3. Agent 引导和脚本调用

```text
真实项目根配置
    ↓
本地 hook/plugin/extension 或手动 start skill
    ↓
解析 codeRoot / trellisDir / scriptsDir
    ↓
从外部脚本生成上下文，注入真实路径
    ↓
agent 直接调用外部脚本，cwd 保持 codeRoot
```

例如注入后的脚本命令应等价于：

```bash
python3 "/Users/me/.trellis-wiki/Trellis/scripts/get_context.py"
```

而不要求 `.trellis/scripts/get_context.py` 存在。

- Python hook 在导入外部 common 模块前，需要独立的最小配置 bootstrap；不能依赖 agent 先读到提示词。
- Pi/OMP/OpenCode/Snow 等独立入口，以及没有 hook 的 skill fallback，都遵守同一配置契约。
- 使用现有平台注册表、公共模板和各语言现有路径模块组织代码；对确需重复的生成内容使用共享模板源与契约测试，不增加用户可见转发命令。
- 生成到 `.agents/skills/` 的共享内容继续遵守 neutral rendering，避免不同平台写出互相覆盖的专属内容。
- Python 运行时从真实 codeRoot 配置定位外部数据，避免把脚本所在目录误当源码根。
- 代码项目路径、package.path、生命周期 hook 的 cwd 和 TASK_JSON_PATH 含义保持原契约。
- 外部脚本通过 argv 执行，保留现有 Python 选择机制和 Windows/UTF-8 处理。

## 4. Task 引用与路径边界

- canonical task schema 的分支、PR、worktree 和历史作者字段保留，避免破坏 core SDK。
- 新运行时区分代码根下的 docs/源码与外部根下的 spec/task/research。上下文引用的根域必须明确；可为现有 JSONL 增加可选根域信息，旧 `.trellis/...` 前缀按配置转换，不能通过浏览链接解析。
- task 的活动引用使用外部项目内的规范逻辑引用，例如 tasks/<task>；迁移读取器接受并转换旧 `.trellis/tasks/...` 引用。禁止存任意越界绝对路径。
- Python、Pi、OpenCode、OMP、channel 等读取端采用一致的合法根：当前 codeRoot，以及经过绑定验证的当前 trellisDir。现有用户显式声明的其他 trusted roots 按原有配置规则处理，不因外移自动扩大。
- 对目录穿越、跨项目引用和任务子目录逃逸继续进行 realpath 校验；不能为了外部目录去掉现有保护。
- 文件系统链接不代表平台 sandbox 自动授权外部读写；使用平台已有能力验证最窄的项目数据目录访问，不自动放开整个 storageRoot。

## 5. Workspace、身份与并行状态

- workspace/index.md、journal-N.md 直接位于外部项目目录，不再要求 developer 子目录。
- 取消 task create、add_session、record context、list --mine 等对 `.developer` 的强制依赖；新记录可使用当前系统用户作为显示身份，但不再要求注册 Trellis 开发者。
- 保留 canonical creator/assignee 字段与历史内容；单用户下“我的任务”与当前项目任务视图保持合理兼容。
- init 首次 bootstrap 按项目初始化完成状态判断，保留中断恢复与重复执行幂等；不再因缺少 `.developer` 创建 joiner onboarding。
- 继续使用已验证的平台 session 身份与 shell-ticket bridge。外部 runtime 的各读写端使用相同目录与命名规则。
- 同项目多个 checkout 共享数据，但保留 checkout/session 的当前任务隔离。checkoutKey 是本机运行管理信息，不增加用户的分支操作。
- workspace 的编号分配、追加、索引更新及本次日志提交在项目级临界区内串行完成。进程失败后依靠现有 journal fingerprint/checkpoint 恢复。

## 6. 安装与更新记录

不能让共享的一份模板 manifest 混淆不同 checkout 安装的 agent。

- 公共 scripts/workflow 等模板的修改追踪按外部项目保存。
- `.pi/*`、`.codex/*`、AGENTS.md 管理块等安装追踪按当前 checkout 保存，可以放入外部 `.runtime` 管理区域，不新增项目根配置文件。
- 优先复用现有 hash 计算、v2 manifest 内容和实际写入记录机制；迁移时拆分归属，不因旧 manifest 版本或位置变化丢失用户修改保护。
- getConfiguredPlatforms、update、manifest pruning、uninstall 和 ablate 都必须读取当前 checkout 的接入清单。
- 新根配置和浏览链接作为显式受管入口注册，不能被 orphan pruning 丢弃，也不能把外部数据误认作当前 checkout 可删除的接入文件。
- 外部公共脚本版本与各 checkout 的接入安装版本分别管理。更新一个 checkout 不擅自写入兄弟 checkout；其他 checkout 下次更新或启动时可诊断需要适配的版本差异。

## 7. 两个 Git 仓库与任务级提交

| 行为 | Git 根 |
| --- | --- |
| 当前分支、代码 diff、代码提交主题、PR/base branch | codeRoot |
| journal 历史、已提交 checkpoint、产品数据差异、归档/日志提交 | storageRoot，严格限定当前项目和任务路径 |

finish-work 保留原有代码先提交、再归档/日志的阶段关系：

1. 确认当前任务代码提交与质量检查已完成，保留其他代码工作的修改。
2. 确定本次外部变更清单，包含 task、规范/研究等实际修改；禁止扫描全部项目或整个 archive 后一并提交。
3. 归档当前任务，精确包含原 task 路径删除、目标归档目录及实际改变的父/子任务。
4. 记录 workspace journal/index，并引用真实代码提交。
5. 验证本任务要求的外部变更实际已提交，再报告收尾完成；代码提交和数据提交分别报告。

实现约束：

- 外部 store 共用 index/HEAD，暂存到提交的短区间要按 storageRoot 串行，保留其他 staged 修改；不使用全库 add 或裸 commit。
- 项目级日志锁与仓库级提交锁按固定顺序获取，防止死锁。
- 显式 pathspec 是已有基础，但整文件可能含其他任务的修改。对于无法证明归属的共享文件，保留修改并阻止自动提交，不能自动把混合内容归给当前任务；第一版不提供自动整理混合 hunk 的工具。
- journal 追加前检查已有未提交内容，不能把另一个任务尚未完成的日志混入本次提交。
- 归档清 session 后仍要保存本次任务身份与归档目标作为待恢复信息；Git 失败不能因为任务未曾被跟踪而报告提交成功。
- 保留单独脚本的 auto-commit/--no-commit 控制用于编排，但 finish-work 的最终成功条件不能被旧 session_auto_commit=false 绕过。
- Git 作者未配置或 hook 拒绝时保留数据与恢复说明，不自动更改 Git 身份或跳过 hook。
- 所有外部 Git 功能均为本地行为，不添加 remote/pull/push。

## 8. 显式更新与存储迁移

复用现有用户更新模型：用户升级 CLI 后，显式执行更新/迁移。建议承接 `trellis update --migrate`，并允许指定 storage/project；不增加脚本执行转发命令。

当前迁移 manifest 只描述项目相对的文件 rename/delete，无法单独表达存储事务。增加专门的存储迁移步骤/脚本，由现有更新 gate 和迁移说明引导；不将任意外部目录迁移塞进普通 rename-dir。

迁移顺序：

1. 只读探测旧布局、目标、Git 根、项目名冲突、开发者日志、用户修改和已有迁移检查点；dry-run 不创建目录、Git 仓库、配置或链接。
2. 取得目标项目 workspace→storage OS 锁，建立独立导入快照与 checkout-scoped 持久检查点。现有 update full backup 排除用户 tasks/spec/workspace，不能直接复用为数据备份。
3. 创建/验证独立本地 storage Git 根，复制原有数据并校验，不提前删除原目录或改写代码 Git 历史。
4. 转换 workspace：有旧 `.developer` 时可确定当前历史目录；无该文件且只有一个目录时可确定；多目录歧义时要求显式迁移输入。其他人的历史保存在可追溯的历史子目录，不能覆盖同名 journal/index。新运行不再依赖作者目录。
5. 转换运行引用、模板安装记录与业务配置，保存历史 creator/assignee/代码提交证据；缓存和备份不进入产品提交。
6. 更新当前 checkout 的 agent 接入并验证配置模式。普通 update 不得先覆盖旧运行时，再因尚未外移而留下不可用项目。
7. 数据校验与导入提交完成后，将原目录改名为检查点记录的备份，发布根定位配置并替换浏览链接；配置发布前后的中断均由同一检查点恢复。链接失败可诊断，不能把运行路径退回旧目录或复制一份数据冒充链接。
8. 验证无链接时的配置执行，以及有链接时的浏览目标。提交本次外部迁移相关产品文件，保留原代码仓库可见的旧文件删除差异和新接入变更，代码提交仍遵守用户原流程。

重复执行识别已完成/中断/冲突状态。失败时不丢失任何一边的用户修改，版本标记只在对应阶段成功后更新。根 `.gitignore`/`.gitattributes` 等外部仓库初始化文件仅在首次初始化事务中按明确范围处理，不夹入后续无关任务提交。

## 9. 浏览链接的创建与修复

- POSIX 创建目录符号链接；Windows 本地目录优先评估 junction 以减少 symlink 权限要求。
- 已有正确链接时幂等；错误链接、断链和实体目录分别处理，绝不直接覆盖实体目录。
- 链接目标由配置派生，配置和反向绑定仍负责归属验证。
- init/migration 负责首次创建；重复 init 可按已有项目处理并修复浏览入口，不重新生成另一份数据。
- 删除浏览链接不改变 task/runtime 状态，不影响脚本执行；不根据链接失效自动删除外部数据。

## 10. 卸载与可逆移除

用户已选择保留外部数据：

- uninstall 仅处理当前 checkout 的 agent 接入文件、Trellis 管理块、根定位配置和浏览链接。
- 不遍历外部模板 manifest 后删除数据，不修改其他 checkout，也不删除 shared scripts/spec/tasks/workspace。
- ablate 对同一组本地入口做可恢复事务，记录配置字节、平台文件和链接目标；不快照外部产品数据。
- restore 恢复这些入口，验证外部绑定仍存在且未重定向。数据丢失或目标冲突时清楚报告，不恢复旧数据快照覆盖新内容。
- 另一 worktree 在 ablate 期间产生的 task/journal 更新应保留。删除配置后，配置驱动的注入必须停止，不能仅依赖链接是否存在。

## 11. 风险与控制

| 风险 | 控制与验证 |
| --- | --- |
| 多语言路径规则分叉 | 同一 fixture 驱动 CLI/Python/JS/TS；无链接、错链、跨项目均验收 |
| 不同 checkout 的平台安装记录混用 | 公共模板与 checkout 接入清单分域；双 worktree 不同平台测试 |
| 同一共享文件含多任务修改 | 串行日志写入、精确提交清单；无法归属时保留并停止自动提交 |
| 已归档但提交失败 | 持久待恢复身份/目标；重试不重复归档或追加日志 |
| 迁移备份遗漏用户数据 | 独立数据快照与复制校验；不复用排除用户数据的模板备份 |
| sandbox/Windows 链接 | 分别验证外部读写和浏览链接，运行路径与链接解耦 |
| 更新覆盖不匹配旧运行时 | 显式 migration gate、阶段检查点与版本更新顺序 |

## 12. 不改动和不新增的部分

- task 阶段、branch/base branch/PR 的领域含义和 core task schema。
- 用户使用各 agent 的 start/continue/finish-work 流程。
- mem 原始对话路径与代码项目筛选；channel 的代码 cwd 与项目 bucket 含义。
- 不新增 Wiki 知识能力、外部远程同步、公共 CLI 转发层、全局多用户 workspace 或跨项目管理 UI。

本任务用户已明确允许跳过 GitNexus；采用当前 agent 直接源码核查及跨层回归验证。需求以 PRD 为准，实际实现与限制以两轮专项复核和阶段 8 验收记录为准。
