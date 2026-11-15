# CODEMAP.md

## 项目代码地图

trellis-wiki（Trellis fork：双 npm 包 + 外部本地 wiki 存储）

```text
Trellis/
├── packages/cli/                  # trellis-wiki CLI 包
│   ├── src/cli/                   # commander 入口（trellis-wiki/trellis/tl 三 bin 同源）
│   ├── src/commands/              # init / update / upgrade / uninstall / ablate / mem / channel…
│   │   └── channel/               # 多 agent 协作运行时（store、supervisor、adapters）
│   ├── src/utils/storage-update.ts # 普通 update 与存储迁移共用的产品快照、精确提交及失败恢复
│   ├── src/configurators/         # 各 AI 平台接入；collectTemplates 是文件清单唯一来源
│   ├── src/templates/             # 分发模板（trellis 脚本、common skills、各平台目录）
│   │   └── trellis/scripts/       # 随项目安装的 Python（与外部存储 scripts 保持孪生一致；会话动态注入 wiki 导航）
│   ├── src/migrations/manifests/  # 版本迁移链（0.7.0 = 外部存储；0.7.4 = 动态导航与旧 AGENTS.md 托管退出）
│   ├── scripts/                   # 发布与预检（release.js、release-preflight、check-release-manifest）
│   ├── dist/                      # CLI 构建产物与复制后的分发模板（勿手改）
│   └── test/                      # vitest（含市场一致性回归）
│       ├── fixtures/legacy-agents.md # 旧版 AGENTS.md 兼容夹具，不再作为生产模板分发
│       ├── utils/managed-paths.test.ts # 旧托管块精确清理与歧义标记保护
│       ├── commands/update-storage-commit.integration.test.ts # 外部更新提交、隔离与失败恢复
│       └── scripts/release-preflight.test.ts # npm 处理延迟与版本/tag 重试
├── packages/core/                 # trellis-wiki-core SDK
│   ├── src/{channel,mem,task,testing}/   # 公开子路径领域（mem 不进根 barrel）
│   └── dist/                      # SDK 构建产物（勿手改）
├── marketplace/                   # 内置模板市场（--registry/workflow -m 默认拉取源，仓库内容）
├── .agents/ .claude/ .pi/ .codex/ …      # 平台接入安装副本（由 update 从模板刷新）
├── .trellis -> ~/.trellis-wiki/Trellis/  # 仅浏览链接；真实数据：
│   ├── spec/                      #   分层编码规范
│   ├── tasks/                     #   任务（prd/design/implement + 归档）
│   ├── workspace/                 #   开发者日志
│   └── scripts/                   #   运行脚本（task.py、get_context.py 等）
└── README.md / README_CN.md       # 用户文档（双语）
```

提交代码前，检查当前 staged 的文件并保持本地图同步：新增文件或目录要添加条目，已删除的条目要移除，职责变化的目录要更新描述。
