# dev Loop v3 实施计划

> **状态：已实施**（workspace-c commit `4b5d302`；pi-web commits `d2fdb7b` Phase B / `8eea0ca` Phase C / 后续 Phase D 文档）。
> 与计划的偏差：① Phase C 因类型耦合合并为单一 commit（仍保持全绿）；② C7 孤儿回收器**未**挂执行会话 destroy——挂上会让每次 idle 过期都触发 pgrep/lsof 扫描，且收益与普通会话被杀的既有暴露面相同，改为保留选品回合清理 + 疑似中断报告（见 commit message）；③ 手动触发的终态无 seed 时不再显示状态条——verdict 在 Loop 视图 run 记录查看。
> 依据：`docs/dev-loop-v3-design.md`（已确认）。本计划把它切成可独立验证的 commit。
> 规则：每个 commit 过 `node_modules/.bin/tsc --noEmit` + 相关单测；Phase C 结束跑全量 `npm test`；**全程不跑 `next build`**。TDD 用在预先约定的纯函数缝上（标 ★）。

## Phase A — workspace-c 合同搬家（纯文件，零 pi-web 代码）

| # | 内容 |
|---|------|
| A1 | 新建 `.agents/skills/dev-loop/SKILL.md`：v2 LOOP.md 正文原样 + 三处改（gate→「盖 `loop.gate` 戳 + terse 提问后本轮结束」；删 `LOOP_VERDICT`；新增开场步骤——读 AGENTS.md/README、三重判定定稿 predictedConf、证据包、纯展示代写薄 SPEC、组合派发计划初版；收养版开场 = 读 dispatch + 里程碑缺口续跑） |
| A2 | `loops/dev-loop/agents/` 五角色 → `.pi/agents/`（brainstorm/checker/implementer/learner/writing-plans），删 selector.md；改写角色文内 selector 引用（predictedConf 来源 →「开场步骤」） |
| A3 | `loops/dev-loop/LOOP.md` 重写为 ~15 行：活性判定（intake 且无 parked）+ 泊车关键词 + 挑 KEY（前 3）+ 输出 `LOOP_SEED: <KEY>` / `LOOP_VERDICT: idle`（附 pendingVerify + 疑似中断清单：非终态 phase + 会话/事件 >2h 无活动） |
| A4 | `.pi/workspace.yaml` manifest `skills: [dev-loop]`（skillsOverride 白名单——不加则工作区会话看不见 skill，`/skill:` 展开同样落空） |

验证：手动在新会话里发 `/skill:dev-loop dry-run 检查 <某个 REQ>`，确认展开装载、开场步骤引用的角色可发现（`.pi/agents` 审批弹一次属预期——B1 后播种链路免审批）。

## Phase B — pi-web 引擎：播种 + 守卫 + 透传（只加不拆）

| # | 内容 |
|---|------|
| B1 ★ | host `POST /v1/sessions` 加 `extraAgentDirs?: string[]` → 透传 `startRpcSession` options（rpc-manager 已支持该字段）；`client.ts` `CreateSessionInput` 补字段 |
| B2 ★ | 新 `lib/loop/seed.ts`：`evaluateSeedGuard({stampEvent, phase, probeAlive})` 纯函数（放行矩阵：无戳→放行；有戳+probe 活+非终态 phase→拒绝；戳在但 probe 死或 phase 终态→放行覆盖）+ `buildSeedPrompt(key, mode)`（`/skill:dev-loop 执行|收养 <KEY>`）+ 宿主侧 `seedExecutionSession(workspacePath, key, mode)`：guard → probe（本地 registry，host 进程内）→ `startRpcSession(一次性key, prompt, 工作区根, undefined, {extraAgentDirs})` → 写 `conversations` + `loop.started` + `loop.active_session` 里程碑（work-items service，host 已依赖） |
| B3 ★ | `parseLoopSeed(text)` 纯函数（regex `LOOP_SEED:\s*(REQ|BUG)-\d+`）；pi-execution：选品回合落定后（现 sessionNamer 钩子位置）解析终末 assistant 文本 → 命中则调 `seedExecutionSession` → 终态 run 快照补 `seededSessionId` |
| B4 | host `POST /v1/workspaces/:id/seed` `{key, mode}`；web `POST /api/workspaces/[id]/work-items/[key]/run-contract` 转发（同 importers/sync 模式）；client 方法 |
| B5 | 前端：工作项详情「按合同执行」按钮（execute；item 非终态且无活戳时显示「收养续跑」变体）——调 B4 路由，成功后打开新会话 |

验证：单测（guard 矩阵、parseLoopSeed、prompt builder）+ 手动触发一次选品回合观察 seed 全链路。

## Phase C — 退役（一刀切，逐层 commit，每层独立绿）

| # | 层 | 拆除物 |
|---|----|--------|
| C1 | runtime/store/types | gate 状态机（`waiting_for_gate`/`answerGate`/`resumeRound` 重水化）、`reapOrphanedGates`、run 快照 gate 字段、`LoopRun` 类型瘦身 |
| C2 | pi-execution | `LOOP_GATE:` 处理、gate 暂停会话保活、`runAgentDirs` 跨 gate 保留、sessionNamer 注入（钩子位已被 B3 seeder 接管） |
| C3 | host | `/gate/approve|reject` 路由、commands 路由 409 拦截（`execution.getBySessionId` 分支）、probe 的 `loop.run` 载荷；answerGate 等 client 方法 |
| C4 | web 路由 | `loop/runs/[runId]/gate` 删除；runs 路由去 work-item join（选品回合无关联）；state 路由 `loop` 载荷删除 |
| C5 | 前端 | LoopStatusBar + `loopPollTarget` + `useAgentSession` 的 `loopOwned`/`loopRunMeta`/pin-reprobe 专属分支 + `ChatInput.disabledNotice` loop 分支；Loop 视图 run 行点击 → `seededSessionId` 存在则经 locate 打开该会话 |
| C6 | session-tags | 删 conversations 反扫 join 与 `loopWorkItem`；保留瘦身版 RUNS 扫描给选品编排会话打 `loopOrchestrator`（继续从会话列表隐藏，唯一入口是 Loop 视图 run 记录） |
| C7 | process-cleanup | 回收器触发点改挂执行会话 destroy（host 注册 wrapper onDestroy 回调——同 `serveSessionSse` 用的机制；实现期核对 wrapper API，parser 已测不动） |

## Phase D — 收尾

| # | 内容 |
|---|------|
| D1 | 全量 `npm test` + `npm run lint` + tsc；测试基线与退役前快照比对（gate/session-tags/runs 相关旧测试随拆随删，不许留红） |
| D2 | 文档同步：根 `AGENTS.md` Loop 节重写（删 gate/重水化/409/LoopStatusBar 段落，补 seed/守卫/戳语义）、`docs/loop-runtime.md`、workspace-c 相关说明 |
| D3 | workspace-c 真实验证清单：手动触发选品 → LOOP_SEED → 播种会话跑 skill 开场 → 中途插话 steer → gate 提问+回话续轮 → 终态里程碑；双开拦截（戳活着再点按钮 → 拒绝）；陈旧戳无害（杀会话后再点 → 放行覆盖收养）；idle 报告列疑似中断 |

## 风险与回退

- 一刀切中间态不可运行：Phase C 每 commit 独立可编译可测，回退单位 = commit；整体回退 = git revert。
- B3 的 `LOOP_SEED` 解析若模型没按薄 LOOP.md 输出标记 → run 正常终态但无播种（idle 同形）。观测手段：run 快照 + 选品会话可打开。若高频漏标，收紧 A3 措辞后再看，不回机制。
- Phase A 完成而 B 未上时老 loop 仍跑老协议 → **A 与 B/C 同一天内完成切换**（老 LOOP.md 已薄化，老 gate 机制对薄 LOOP.md 无害——它不输出 `LOOP_GATE:` 即永不进 gate 态）。
