# AGENTS.md 重写：项目大方向 + 整体架构 + 功能使用

## 新定位

AGENTS.md = **项目说明书**：这个项目是什么、整体架构如何分层、每个子系统做什么怎么用、AI 在里面干活需要知道的少数硬规则。约 **300-400 行**（现 1313 行 / 60k tokens → 约 12-15k tokens）。

不再承担「维修日志」角色：布局演变史、键盘适配细节、逐条交互规则、状态机逐字段校验规则、逐文件注释地图，全部移出。

## 新 AGENTS.md 结构（整体重写，新写的说明文，不是剪贴现文）

1. **项目大方向**（~10 行）：pi-web 是 pi coding agent 的 Web UI；单进程 Next.js 服务器即会话宿主；之上是 Workspace 子系统（manifest/capability/仓库/工作项/交付自动化/loops）。文档分层声明：本文件 = 总览与用法；`docs/reference/` = 深细节基线；`docs/*.md` = 设计史。
2. **Quick Start**（~20 行，基本照搬）：dev/lint/test 命令、`Never run next build`、adopt-pi-home 一句话 + 指针。
3. **整体架构**（~60 行）：架构图照搬；单进程会话宿主（registry/facade/SSE/heartbeat 一段）；会话索引与浏览（要点化）；Workspace 层如何叠加。每个子系统一节「做什么 + 核心概念 + 关键入口文件」：
   - **Workspace**（~40 行）：manifest/capability/repository/index v2/默认工作区/能力注册表怎么加模块（三步）
   - **Work Items + 交付流**（~50 行）：REQ/BUG 文件布局；七阶段状态机一图（intake→design→rfi→implementation→verification→release_ready→released）；四角色自动执行流水线 + 双人工门（designer→人确认设计→developer→verifier→release-preparer→人发布）；失败预算/单槽位等运行规则要点各一行
   - **Loop**（~25 行）：文件协议（LOOP.md/STATE.md/宪法文件）、心跳双宿主、agent 禁改清单
   - **Subagent**（~15 行）：全局挂载、profile 发现层级、超时语义
   - **Git & Changes / 文件访问 / 附件**（~20 行）
4. **开发硬规则精选**（~30 行）：跨子系统、影响日常开发的陷阱只留一条一行（never next build、globalThis 单例防 HMR 双 owner、写锁不可重入、released 冻结、events.jsonl 只追加、union schema 禁用、destroy 会中止在飞 prompt 等），每条够触发警觉即可，细节指针到 reference。
5. **目录速览**（~25 行）：一级目录骨架（app/api、lib/ 各子目录、packages/pi-loop、kit/、components/、hooks/ 各一行）。
6. **docs 索引表**：reference 五件 + 关键设计文档，各配「何时读」。

## docs/reference/ 深细节基线（现 AGENTS.md 内容按域归档，近乎逐字保留，不重写事实）

1. `docs/reference/session-host.md` — 会话宿主全量：session browsing 细节、Session Host M1、AgentSession lifecycle、fork/分支、SSE/pin/badge、心跳、local pi data home、session file format、相关 traps
2. `docs/reference/work-items.md` — Work Items 服务面全量 + Delivery M2 状态机逐字段规则 + Delivery 自动执行 Phase-2~5 全量（池子谓词/领取事务/失败预算/role grants/工具/dispatcher/已知边角）+ 工作项前端（store/三宿主/深链/组件族）
3. `docs/reference/ui-shell.md` — Navigation 全部布局叙事 + 移动端抽屉 + shell split/SSR 预取 + 移动端键盘双策略 + 滚动跟随 + 侧栏/右坞拖宽 + 各 UI 组件描述 + Loops 配置面 UI
4. `docs/reference/loops.md` — Loop kit 深细节 + Dev Loop 模式 + Learn/cxin reference + 外部源适配
5. `docs/reference/file-map.md` — 现File Map 全文（带注释完整文件地图）

现有 AGENTS.md 的每一段内容都恰好落进一个家，无删除（布局史在 ui-shell.md 归档，将来想删随时可删单个文件）。

## 执行顺序

1. 建 docs/reference/ 五文件，按域搬移现内容（文件头注明「2026-10 自 AGENTS.md 迁出」）
2. 重写 AGENTS.md（全新行文，中文为主，代码标识符保留英文；每节末尾挂对应 reference 指针）
3. 验证：grep 新 AGENTS.md 无悬空内部引用；确认旧文每大节都有归宿；行数/token 对比报告
4. 不 commit（工作区有其他未提交改动，等你指示）

## 取舍说明

- Delivery Phase-2~5 的逐字段规则**不在**新 AGENTS.md 展开（太细），但一条不少地存进 work-items.md——改 delivery 代码时按指针读取。
- 键盘/布局内容按你的判断属「没什么用」：不进新 AGENTS.md，也不直接销毁，归档在 ui-shell.md（零成本保险，你随时可整文件删除）。