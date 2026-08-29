# pi-loop kit 推进状态与 TODO

> 活文档：Phase B 演练、拆除队列、所有顺延项的唯一入口。更新于 2026-08-29。
> 设计：`docs/pi-loop-kit-design.md`（含 D9–D14）｜计划：`docs/pi-loop-kit-plan-1-build.md`（✅ 已合并）、`docs/pi-loop-kit-plan-2-teardown.md`（进行中，Task 1 Phase A ✅）

## 当前状态

| 项 | 状态 |
|---|---|
| pi-web develop | `85a515e`（C2 daemon 重构 `1289921` + kit 建设期合并） |
| workspace-c | `kit-rehearsal` 分支 `1b9c8ea`（kit 文件落位 + SKILL.md 六点改造，已过评审；v3 `loop.yaml` 保持 `enabled: false` 未动） |
| 拆除期 worktree | `pi-web-worktrees/loop-kit-teardown`（feature/loop-kit-teardown @ 85a515e，Tasks 2–6 在这里做） |
| daemon | 仍是旧进程（pid 见 `ps aux | grep pi-daemon`）——**等一次空闲窗口重启** |

## 下一步：Phase B 演练轮（人工操作）

1. **挑空闲窗口**：`curl -s http://127.0.0.1:30142/v1/sessions/running` → `{"ids":[],"stalled":[]}` 才动手（ids 非空=有会话在跑，等它完成；对话不会因重启丢失，daemon 重启后按需从 .jsonl 冷恢复）。
2. **重启**：
   ```bash
   kill <旧daemon pid>
   cd /Users/qiancheng/Documents/Workspace/qyinf-workspace/pi-web
   PI_LOOP_KIT=1 npm run daemon      # 前台跑看日志；应见 loop-kit-heartbeats 注册
   ```
3. **触发**：等 cron（`*/30 9-22 * * 1-5`）或临时把 `~/.pi/workspaces/workspace-c/loops/dev-loop/LOOP.md` 的 cron 改成下一分钟（演练完改回）。
4. **可选（练收养）**：把 STATE.md Watch List 里的 BUG-0015 挪进 High Priority。
5. **验收**（§11.2，两处口径已按 kit 调整）：
   - 轮会话 `dev-loop · <时间>` 出现，五角色子代理跑起，无确认弹窗；
   - `loop.started`/`loop.gate` 里程碑由**轮自己**盖（原为引擎代盖）；
   - gate → 工作项详情出现会话链接，**在会话 composer 答复**继续；
   - 干净轮自动归档；STATE.md 每轮更新；**全程无 orchestrator 会话、无 RUNS.jsonl 新行**。
6. **演练通过** → 回到对话/本文档，启动 Tasks 2–6（SDD 流程，worktree `loop-kit-teardown`）。
   **不过** → 把现象 + daemon 日志带回来，回修 spawner（`lib/daemon/loop-spawner.ts`）。

## 拆除队列（演练通过后执行，顺序敏感）

| # | 任务 | 要点 |
|---|---|---|
| T2 | loop UI 拆除 | ActivityBar/MobileShell/WorkspaceSidebar/WorkspaceOverview/LoopConfig/useAppShellState/HomeLanding + session-tag 消费点（`subagentChild` 保留） |
| T3 | capability 剥离 | `loop` 进 `LEGACY_READ_CAPABILITIES`（`overview` 先例），读路径剥离 |
| T4 | run-contract 预填 | 新 `GET /api/workspaces/[id]/loops`（导入 `lib/daemon/loop-kit`，纯 fs）+ draft-store 预填 + composerEpoch 重挂；删 daemon seed 路由 |
| T5 | 引擎删除 + 翻转 | `lib/loop/` 全删（process-cleanup 搬 `lib/daemon/loop-process-cleanup.ts`，更新 loop-spawner 导入）；host.ts 去 v3 装配、**kit spawner 去门控转正**；client.ts loop 方法删；workspace-c 合并 kit-rehearsal |
| T6 | 文档 + 验收 | AGENTS.md Loop 章节重写；v2/v3/loop-runtime 设计文档退役横幅；§11 验收 1/2/4/5 |

## 顺延 TODO（按去向分组）

### 演练时顺手确认
- [ ] SKILL.md `loop.started` 有两个盖章点（开场步骤1 vs 派发步骤7）——观察轮实际盖哪个，收敛成单点（workspace-c 小改）

### Task 5 翻转前
- [ ] LOOP.md 指针5 分支措辞收紧：merge 终点是 develop（loop-integ），master 晋级是人合——与 `loop-constraints.md` 对齐
- [ ] SKILL.md 开场步骤1 补回 report-only 两表定义（待人工验证=phase==verification；疑似中断=非终态且 events>2h 无新事件）

### Task 6 / 验收时
- [ ] §11.2 验收措辞更新：`loop.started` 由轮自盖（原"seeder 代盖"表述已过时）
- [ ] 同名 loop 槽位键碰撞（parked）：同 workspace 两 loop 同名 → 分钟槽互撞静默饿死；把 slot 键改用 `dir` 或发现期拒绝重名
- [ ] 清理 kit 建设期评审 Minor：cron.test.mjs 时区注释（"前一日的 2 点"→同日）；slot 标签用 UTC（本地差 8h，纯装饰）；`waitForRoundSettle` 无直接用例；creation-signal 传参无断言；dedup-guard/never-throws 注入用例缺口；`inspectRoundImpact` per-item 静默 continue；archive-only 组合路径未直测

### 带外（§11.3 / phase 2）
- [ ] GitHub demo 仓库：Actions cron + `pi -p` + 社区 subagent 包跑 L1 triage；**workflow 模板需补 STATE/ledger 持久化**（ephemeral runner 上写盘会丢——git commit/push 步骤或 artifact 策略）
- [ ] 社区包审计（§6 清单，第一周）：`@henryqw/pi-subagent` 源码/依赖链（pi-multi-codex 是否必要）/角色发现/并行上限/超时语义；不过则兜底抽 `lib/subagent/` 成包
- [ ] phase 2：pi-web `lib/subagent/` 切社区包；`npx pi-loop init` CLI；STATE.md viewer；ledger token 对账（D13）
- [ ] phase 2：并发 tick 下 busy 检查竞态（两个 await 间隔，>30s 停顿可击穿；同分钟同 loop 有 emittedSlots 兜底）
- [ ] phase 2：gate 已答复后会话留存策略（hasPendingGate 只看"盖过"，不管"答没答"——可结合工作项终态或答复里程碑）

### 备忘（不打算做）
- kit/README 布局块不列 workflows 行（Actions 节已覆盖）；readdirSync 把 EACCES 与 ENOENT 同归 []；`max_minutes` 字符串形态静默回退 30（文档提醒写数字）
