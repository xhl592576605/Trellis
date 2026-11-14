# 阶段 8 集成验收

## 范围与结论

按当前 PRD AC1–AC15 完成可在 macOS 执行的集成验证，修复入口遗漏，形成可复制的用户试用说明。没有迁移本仓库自身数据，没有代码 commit/push，没有派发或启动 AI worker。任务继续保持 in_progress，等待用户手测及后续明确授权的提交/收尾。GitNexus 沿用用户明确跳过的决定。

使用说明：`.agents/handoff/20261114-1032-external-storage-manual-test.md`。其中路线 A 的 Bash 命令块已按顺序实际执行（复用已构建 CLI，作者身份仅用于临时测试仓库），全部退出 0；真实 AI 宿主交互步骤由用户手测。

## 本阶段发现与修复

| 项 | 实际问题 | 修复与回归 |
| --- | --- | --- |
| S8-F1 | channel agent、信任配置和 worker policy 仍从 browse link 读取；逻辑 JSONL/文件/通配符在无链接时无法定位 | 使用统一外部解析器；逻辑引用映射后保留 realpath jail；绝对 glob 保留文件系统根 |
| S8-F2 | 配置有效时，错误 browse link 下的 tasks/workspace symlink 仍可被旧 auto-trust 扩大为其他根；无效配置被吞掉 | 外部绑定不使用 legacy auto-trust；无效显式配置抛出诊断，不返回默认策略 |
| S8-F3 | 新 init 预先生成未提交的 workspace index，首次 required journal 被归属守卫判为手工修改 | init 仅创建 workspace 目录，首次日志写入在项目锁和所有权检查点内创建 journal/index；不放宽归属检查 |
| S8-F4 | 无链接 update 将备份写到代码目录 .trellis，制造实体目录，导致之后 uninstall 拒绝；共享源备份也漏读 | 备份放当前 checkout runtime；按 locator 读共享模板、按逻辑键保存，排除 runtime/cache，避免自身递归 |
| S8-F5 | breaking migration 提示任务和 legacy developer 读取仍使用物理 .trellis | 改为配置解析后的外部目录，外部模式身份回退系统用户；该分支为源码核查，原 legacy update 回归保留 |

新增回归：channel-context-trust.test.ts 5 个场景，external-workflow.integration.test.ts 3 个场景，init-external-storage.integration.test.ts 1 个中断 init 恢复场景。阶段 8 合计新增 9 个测试。

## 验收矩阵

下表测试路径相对 packages/cli/test；“限制”明确区分未执行的真实宿主或平台环境。

| AC | 实际证据 | 状态 |
| --- | --- | --- |
| AC1 | init-external-storage：默认根（隔离 home）、自定义根、独立 Git、配置/链接/接入；编译 CLI 自定义根冒烟 | 通过 |
| AC2 | external-store-config：子目录 task/context、异仓库同名拒绝；external-workflow：真实 Git/中文路径 | 通过 |
| AC3 | external-workflow：init→task create/start→安装后 continue 命令→code evidence→archive/journal→外部 commit；编译 CLI 再验证 | 通过 |
| AC4 | journal 引用代码 commit subject，代码提交数量不因外部提交增加；mem 原始会话按 code cwd 过滤；channel create event cwd=code | 通过 |
| AC5 | 无 developer、扁平 workspace、日志编号/轮转及历史回归；首个日志无额外基线提交 | 通过 |
| AC6 | external-task-commit：两项目实际并发、其他 staged/active/archive 数据、共享手工修改阻止；external-store-config：同项目并发编号 | 通过 |
| AC7 | external-task-commit 与 add-session：Git hook 拒绝、待恢复身份、已暂存源删除、精确年月目标、required commit 与幂等键；编译 CLI 相同 keyed 重试 HEAD 不变 | 通过 |
| AC8 | external-lifecycle：共享数据逐字节不变、ablate 期间 sibling 写入保留、还原缺失/改绑失败；external-workflow：双 worktree update/uninstall | 通过 |
| AC9 | external-workflow：空格/中文、Node/Python 同一个 ~/storage 配置；channel-context-trust/external-store-config：错误配置显式失败 | 通过（macOS） |
| AC10 | update-migrate-storage 和编译 CLI legacy fixture：复制/历史作者/workspace index/hash 拆分/接入刷新/恢复/保留代码历史 | 通过；真实用户旧项目定制仍建议手测 |
| AC11 | 编译工具实测正确/错链/断链/实体占位，核对无关目标与占位内容保留；生命周期实体占位拒绝；repeat init 修复同一数据链接 | POSIX 通过；Windows junction 未执行 |
| AC12 | external-workflow：main/Pi 与 feature/Codex 同 session key，task 指针、修改保护、备份、平台识别、卸载隔离 | 通过 |
| AC13 | 安装后的 Python hooks/协议、OpenCode/Pi/OMP 现有入口回归，channel 的逻辑/绝对/通配符上下文与 sibling/nested-link 拒绝 | 自动化通过；真实宿主 sandbox 仍需手测 |
| AC14 | 首次/重复 init、平台占位引起中断后重试、用户数据保留、无 developer/joiner；bootstrap 保留 | 通过 |
| AC15 | 核心链路先 unlink 浏览入口后完成，配置始终决定执行根；重复 init 恢复链接且 journal 字节不变 | 自动化通过；真实宿主 continue/finish-work 待手测 |

## 构建产物冒烟

1. 新项目：本地 dist/cli/index.js，安装 Claude/OpenCode/Codex/Copilot/Pi/OMP/Snow，删除浏览链接后执行 task/context/安装的 continue 命令、读取 channel agent/context、归档和 required journal（相同 keyed 重试不新增提交）、update、ablate/restore/uninstall。核对共享产品数据与代码 Git 历史。
2. mem：隔离 PI_CODING_AGENT_DIR/PI_CODING_AGENT_SESSION_DIR，生成 code cwd 和 data cwd 两份原始会话；mem list --platform pi --json 只返回代码会话。
3. channel：隔离 TRELLIS_CHANNEL_ROOT，仅 create/list 本地 fixture，create event.cwd 等于代码目录。未启动 worker、未调用模型或发送外部消息。
4. 迁移：真实临时 legacy Git fixture，dist CLI 显式迁移→无链接 context→延迟归档/required journal→ablate/restore/uninstall；外部字节不变，代码历史未被自动提交。
5. ~/storage 一致性测试使用用户目录内独占 mkdtemp fixture，Node/Python 读取同一真实目录，测试结束完整清理。没有改写 HOME 或现有用户数据。

## 最终检查

最终全量：**89 文件 / 1750 测试全部通过**。lint、TypeScript typecheck、build、Python lint:py（0 errors / 74 条既有 warnings）、双树字节回归及 git diff --check 均通过。编译 CLI 新建/迁移、独立链接状态探测和说明中路线 A 的可复制命令块也全部通过。

规范同步：filesystem-safety（首次 workspace 所有权）、platform-integration（legacy developer 信号适用范围）、commands-update（外部备份/提示任务）、commands-channel（配置/信任根/映射契约）。

## 平台限制与用户下一步

- 未执行 Windows junction/msvcrt；本机是 macOS，不能由 POSIX 测试推断 Windows 实机通过。
- 未在全部 AI 宿主中真实交互，尤其外部路径 sandbox 权限、重启后扩展加载。用户按试用说明 A4 验证 Pi/Codex。
- 新 0.7.0 门禁在测试中模拟，CLI package 版本尚未变更或发布。手测须使用本地构建产物。
- 保留修改的旧模板可能仍需手工合并。跨机器路径可携带性不等价于根配置可直接复制到不同 Git identity 的任意 clone。
