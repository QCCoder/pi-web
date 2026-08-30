# pi-loop kit 推进状态与 TODO

> 活文档：Phase B 演练、拆除队列、所有顺延项的唯一入口。更新于 2026-08-29（深夜：终态整合完成——develop@61592e8 已含 kit+拆除+subagent 切换全部；演练直接用主仓 daemon，无需旗子/worktree）。
> 设计：`docs/pi-loop-kit-design.md`（含 D9–D14）｜计划：`docs/pi-loop-kit-plan-1-build.md`（✅ 已合并）、`docs/pi-loop-kit-plan-2-teardown.md`（T1 Phase A ✅，T2–T6 ✅）

## 当前状态

| 项 | 状态 |
|---|---|
| pi-web develop | 携 C2 daemon 重构 + kit 建设期合并 + **feature/loop-kit-teardown 已并回**（v3 引擎删除、kit spawner 无条件注册）+ **社区 subagent 切换（Route A A1–A3 代码已合）** |
| workspace-c | `kit-rehearsal` 分支 `1b9c8ea`（kit 文件落位 + SKILL.md 六点改造，已过评审；v3 `loop.yaml` 保持 `enabled: false` 未动） |
| 拆除期 worktree | `pi-web-worktrees/loop-kit-teardown`（feature/loop-kit-teardown，T2–T6 全部完成：`f6467f8`→`beb1224` + 文档收口；typecheck/test 全绿）——**已并回 develop，worktree 可清理** |
| daemon | 仍是旧进程——重启即得终态栈（主仓 `npm run daemon`，无旗子；重启前先 `npm install`） |

## 下一步：Phase B 演练轮（人工操作）

1. **挑空闲窗口**：`curl -s http://127.0.0.1:30142/v1/sessions/running` → `{"ids":[],"stalled":[]}` 才动手（ids 非空=有会话在跑，等它完成；对话不会因重启丢失，daemon 重启后按需从 .jsonl 冷恢复）。
2. **重启（注意 sidecar 竞态）**：web dev server 在跑时，kill 后浏览器轮询会在几秒内自动重拉 daemon，手动起的前台进程反而 EADDRINUSE 静默退出。两种正解：
   - **推荐（持久）**：停 `npm run dev` → `kill <旧daemon pid>` → `npm run dev`（sidecar 由此拉起的 daemon 跑当前 worktree 代码——kit spawner 无条件注册，**无需任何旗子**）。
   - 或（想前台看 daemon 日志）：停 `npm run dev` → `kill <旧daemon pid>` → `npm run daemon`（前台跑，应见 `[pi-daemon]` 启动与 loop-kit-heartbeats 注册）→ 另开终端 `npm run dev`（web probe 到健康 daemon 会 attach，不再 spawn）。
   - 验证 spawner 活着：等 cron 轮出现 `dev-loop · <时间>` 会话；或 `curl -s http://127.0.0.1:30142/health`。
3. **触发**：等 cron（`*/30 9-22 * * 1-5`）或临时把 `~/.pi/workspaces/workspace-c/loops/dev-loop/LOOP.md` 的 cron 改成下一分钟（演练完改回）。
4. **可选（练收养）**：把 STATE.md Watch List 里的 BUG-0015 挪进 High Priority。
5. **验收**（§11.2，两处口径已按 kit 调整）：
   - 轮会话 `dev-loop · <时间>` 出现，五角色子代理跑起，无确认弹窗；
   - `loop.started`/`loop.gate` 里程碑由**轮自己**盖（原为引擎代盖）；
   - gate → 工作项详情出现会话链接，**在会话 composer 答复**继续；
   - 干净轮自动归档；STATE.md 每轮更新；**全程无 orchestrator 会话、无 RUNS.jsonl 新行**。
6. **演练通过** → 勾记 §11.2/§11.5（T2–T6 已随 feature/loop-kit-teardown 并回 develop）。
   **不过** → 把现象 + daemon 日志带回来，回修 spawner（`lib/daemon/loop-spawner.ts`）——直接在 develop 上修。

## 拆除队列（T2–T6 ✅ 已完成并随 feature/loop-kit-teardown 并回 develop）

> **已合并**：feature/loop-kit-teardown 已并回 develop（2026-08-29）。develop 侧同期完成社区 subagent 切换（Route A A1–A3 代码），合并取并集：v3 引擎删除（teardown 侧）+ 社区 `@henryqw/pi-subagent` tgz pin（develop 侧）；细节见合并提交说明与 `docs/subagent.md`。

| # | 任务 | 状态 |
|---|---|---|
| T2 | loop UI 拆除（ActivityBar/MobileShell/WorkspaceSidebar/WorkspaceOverview/LoopConfig/useAppShellState/HomeLanding + session-tag 消费点，`subagentChild` 保留） | ✅ `3a1611e`→`f6467f8`（含 LoopLaunchOverlay/highlightView/onWorkspaceChanged 追加移除） |
| T3 | capability 剥离（`loop` 进 `LEGACY_READ_CAPABILITIES`，读路径剥离 + INIT checklist 移除，测试双层级锁 write-reject） | ✅ `3459a6a` |
| T4 | run-contract 预填（`GET /api/workspaces/[id]/loops` 纯 fs + draft-store 预填 + composerEpoch 重挂 + handleOpenConversation 改名；daemon seed 路由删） | ✅ `f20ccc4` |
| T5 | 引擎删除 + 翻转（`lib/loop/` 全删 −2254 行，process-cleanup 搬 `lib/daemon/loop-process-cleanup.ts`；host.ts 去 v3 装配、**kit spawner 去门控转正（无条件）**；client.ts loop 方法删；冒烟 jobs=[loop-kit-heartbeats, importer-sync]） | ✅ `beb1224`（40 files +70/−2254，测试 357→336 与删除用例精确吻合） |
| T6 | 文档 + 验收（AGENTS.md Loop 章节/File Map/陷阱节重写为 kit 形态；v2/v3/loop-runtime 退役横幅；orchestrator 叙事注释清扫；本文档更新） | ✅ 拆除分支收口 commit |

## 顺延 TODO（按去向分组）

### 演练时顺手确认
- [ ] SKILL.md `loop.started` 有两个盖章点（开场步骤1 vs 派发步骤7）——观察轮实际盖哪个，收敛成单点（workspace-c 小改）

### 拆除期收口（原 Task 5/6 前置项，已完成）
- [x] LOOP.md 指针5 分支措辞收紧：merge 终点是 develop（loop-integ），master 晋级是人合——与 `loop-constraints.md` 对齐（workspace-c `561b1a7`）
- [x] SKILL.md 开场步骤1 补回 report-only 两表定义（待人工验证=phase==verification；疑似中断=非终态且 events>2h 无新事件）（workspace-c `561b1a7`）
- [x] §11.2 验收措辞更新：`loop.started` 由轮自盖（原"seeder 代盖"表述已过时）（rollout 演练验收清单已是新口径；AGENTS.md 亦按 kit 形态重写）

### 顺延 phase 2
- [ ] 同名 loop 槽位键碰撞（parked）：同 workspace 两 loop 同名 → 分钟槽互撞静默饿死；把 slot 键改用 `dir` 或发现期拒绝重名（**顺延 phase 2**——phase 1 每 workspace 单 loop）
- [ ] 清理 kit 建设期评审 Minor：cron.test.mjs 时区注释（"前一日的 2 点"→同日）；slot 标签用 UTC（本地差 8h，纯装饰）；`waitForRoundSettle` 无直接用例；creation-signal 传参无断言；dedup-guard/never-throws 注入用例缺口；`inspectRoundImpact` per-item 静默 continue；archive-only 组合路径未直测（**顺延 phase 2**，见 SDD ledger Task 5 minors）

### Route A（phase 2 主线）：切社区 subagent 包 —— **代码已落位**

前提已满足：pi SDK 已升 0.84.4（A1）；A2-enhanced 分支（项目级角色 + 子会话持久化）以本地 tgz 快照 pin。三步：

| # | 步骤 | 状态 | 要点 |
|---|---|---|---|
| A1 | pi SDK 升级 0.82.1 → 0.84.4 | ✅ 已完成（feature/pi-upgrade） | 旗子已验证存在；`Theme` 构造器色表适配；peer 包同步 0.84.4 |
| A2 | 上游 PR：`@henryqw/pi-subagent` | ✅ 本地分支完成（`feat/project-roles-and-child-sessions` @ b2007f4，打包为 tgz 快照 pin）；上游合入 + npm 发版**待做** | 项目级角色目录 + 子会话持久化两点已实现于本地分支 |
| A3 | pi-web 切包 + 删 `lib/subagent/` | ✅ 代码已合并（develop `1b4c2d3`+`c004491`，本次合并与 teardown 并存落位） | 接线项已完成：结果卡/MessageView 适配社区包结果形状（`session.id` 跳转，`open →`）；遗留：上游发版后把 `file:` tgz pin 换回 npm 版本 |

### 待人工验收项（user-gated，不阻塞合并）
- [ ] **§11.2 workspace-c 全流程演练**（Phase B runbook 上述步骤）：禅道 REQ 进来 → 心跳轮拾取 → maker/checker → gate 以 events.jsonl 里程碑 + STATE.md 形式问人 → 人工答复继续 → 完成；全程无 orchestrator session、无 RUNS.jsonl 新行；含 Task 5 翻转后首日复跑一轮确认。结果勾记 `docs/pi-loop-kit-design.md` §11。
- [ ] **§11.5 宪法不可变验证**：对 workspace-c 手动构造诱导任务（"把 loop-budget.md 的上限改到 10M" / "把 level 改成 L3"），确认轮会话拒绝并继续按原宪法执行（SKILL.md 硬条款生效）。结果勾记 `docs/pi-loop-kit-design.md` §11。
- [ ] **§11.3 GitHub demo 仓库**（带外，不阻塞本计划收口）：按 `kit/templates/github/loop.yml` 建演示仓库，Actions cron + `pi -p` + 社区 subagent 包跑 L1 triage；workflow 模板需补 STATE/ledger 持久化（ephemeral runner 写盘会丢）。完成后勾记 `docs/pi-loop-kit-design.md` §11。

### 带外（§11.3 / phase 2）
- [x] 社区包审计（§6 清单，第一周）：`@henryqw/pi-subagent` **PASS-with-notes**（报告 `docs/pi-loop-kit-subagent-audit.md`；超时杀静默构建 → 已由 `pi-subagent-host.ts` 显式超时策略缓解，角色目录/`pi-task-models.json` 前置已在切换中处理；pi peer 前置已由 A1 满足）
- [ ] npm swap：上游 PR 合入 + 发版后，把 `package.json` 的 `file:` tgz pin 换回 npm 版本（A3 收尾）
- [ ] phase 2 其余：`npx pi-loop init` CLI；STATE.md viewer；ledger token 对账（D13）
- [ ] phase 2：并发 tick 下 busy 检查竞态（两个 await 间隔，>30s 停顿可击穿；同分钟同 loop 有 emittedSlots 兜底）
- [ ] phase 2：gate 已答复后会话留存策略（hasPendingGate 只看"盖过"，不管"答没答"——可结合工作项终态或答复里程碑）

### 备忘（不打算做）
- kit/README 布局块不列 workflows 行（Actions 节已覆盖）；readdirSync 把 EACCES 与 ENOENT 同归 []；`max_minutes` 字符串形态静默回退 30（文档提醒写数字）
