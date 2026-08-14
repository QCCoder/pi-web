# Loop 引擎 free-run 重设计 · 实施方案

> 来源：grilling 共识架构 → planner subagent 产出。本文件是 worker/test/reviewer 的执行依据。

## Goal

把 Loop 引擎（`lib/loop/`）重写为领域无关的「触发 → 跑 LOOP.md → 见 `LOOP_GATE` 暂停 → 自由文本恢复 → `LOOP_VERDICT`/结束完成 → 独立 abort」运行时；删除 maker/checker 流水线、autonomy、infer/gate1、approve/reject、severity、workItemKey、死代码 checkers.ts；把 cxin dev-loop 从「引擎代码生成 cxin 专属文件」改成「shipped 通用静态模板 + 项目事实各归各位」；LearnScheduler 加「completed run 无 LEARN」检测；修 cxin AGENTS.md 过期路径段。**保持 stock-assistant/daily-new-stock-pick 继续可跑。**

## 共识架构

### 引擎（领域无关）
- 职责：触发（loop.yaml triggers）+ 托管 orchestrator 会话 + 见 `LOOP_GATE:` 暂停/等自由文本答/喂回 + 独立 abort（杀会话→failed）+ 写 RUNS.jsonl + 把 `run.id` 和 orchestrator 的 `sessionId` 传给 orchestrator。
- 删除：autonomy(L1/L2/L3)、infer 阶段、gate1、`InferredLoopPlan`/`steps:[{maker,verifier}]` JSON、approve/reject、severity(must/auto)、workItemKey（死字段）、`lib/loop/checkers.ts`（死代码）。
- 生命周期：`queued → running ↔ waiting_for_gate → succeeded | failed`。删 `inferring`/`waiting_for_confirmation`/`cancelled`。
- gate 答案 = 自由文本 `{message}`，原样作为下一轮发给 orchestrator。另设独立 abort 动作。
- orchestrator 一条贯穿会话：跨 gate 保活（修 execute 返回前 `sessions.delete` 导致 gate2 恢复抛错的 bug）；恢复 = `session.send({type:"prompt",message})`。
- 完成：`LOOP_VERDICT:` 或自然结束 → succeeded；`LOOP_GATE:` → waiting_for_gate。

### LOOP.md（每个 loop 唯一领域权威）
- orchestrator 按 LOOP.md 跑；要人就发 `LOOP_GATE`，做完发 `LOOP_VERDICT`。何时停全由 LOOP.md 决定。

### dev-loop（纯文件 + 项目事实各归各位）
- `loops/dev-loop/{LOOP.md, agents/developer.md, agents/tester.md}` 通用可移植，零 cxin 事实。
- 删 `lib/loop/dev-loop/contract.ts` + `authoring.ts`（生成器）→ dev-loop 变静态模板。
- 构建/checker 命令 → 工作区 AGENTS.md（已自动注入所有会话含 subagent）。
- 敏感模块 → cargo-knowledge（已在），kb_search 查。
- 仓库路径 → 从 alias 推导 `<根>/repositories/<alias>`。
- 会话↔工作项 → orchestrator 把 sessionId 挂进工作项 `conversations` + 记 `loop.started` milestone（带 runId）。
- LEARN → 信任 LOOP.md「learn 排在 LOOP_VERDICT 前」+ LearnScheduler 缺 LEARN 告警。聚合数学暂留 `lib/loop/learn/`。

---

## Plan（按依赖排序，每步小而安全）

### Phase A — 引擎类型层 `lib/loop/types.ts`
1. `LoopRunStatus` 瘦身为 `"queued"|"running"|"waiting_for_gate"|"succeeded"|"failed"`。删 `inferring`/`waiting_for_confirmation`/`cancelled`。
2. 删 `AutonomyLevel` 类型 + `LoopDefinition.autonomy` 字段。
3. 删 `MonitorVerdict`；`LoopRun.verdict` 改 `verdict?: string`（`LOOP_VERDICT:` 后任意文本）。
4. 删 `InferredLoopPlan`；删 `LoopRun.plan`；`gateRequest?: string` 保留（存 `LOOP_GATE:` 的自由文本载荷）。
5. 删 `LoopRun.workItemKey`（死字段）。
6. `GateCommand` → `GateAnswer = { workspaceId; runId; message: string }`。
7. `LoopRuntime`：保留 listLoops/trigger/getRun；`answerGate(command: GateAnswer)`；**新增** `abortRun({workspaceId,runId}): Promise<LoopRun>`。
8. `RoundExecutionBackend` 整体替换为：
   ```ts
   startRound(definition, run, onSessionReady?): Promise<{output; verdict?; gateRequest?}>;
   resumeRound(run, message): Promise<{output; verdict?; gateRequest?}>;
   abortRound(run): Promise<void>;
   ```
   （删 infer/execute/reject）

### Phase B — `lib/loop/store.ts`
9. 删 `AUTONOMY_LEVELS`、AutonomyLevel import、autonomy 校验块。**容忍** legacy loop.yaml 里残留的 `autonomy` 键（不抛错，只是不读）。返回的 LoopDefinition 不带 autonomy。其余不变。

### Phase C — `lib/loop/authoring.ts`
10. `CreateLoopInput`/`UpdateLoopInput` 删 `autonomy?`；create/update 不再默认/校验/写 autonomy。
11. `renderInstructions`：删「不得超越当前 Autonomy Level 自动扩权」那行。其余 maker/checker/gate/improve 草稿结构保留（只产 LOOP.md 文本，引擎不再假设）。

### Phase D — 运行时核心 `runtime.ts` + `pi-execution.ts`
12. **`pi-execution.ts` 重写** `PiRoundExecutionBackend`：
    - 删 `extractJson`/`normalizePlan`/`hasSubagentTool` + maker/checker roleLine/delegationLine。
    - 保留 `capturePrompt`、`gateFrom`；`verdictFrom` 泛化为 `string|undefined`（去 `changed|unchanged|unknown` 限制）。
    - `startRound(definition, run, onSessionReady)`：`startRpcSession(__loop_host__${run.id}, "", workspacePath, undefined, {extraAgentDirs:[agentsDir] if exists})` → 注册 sessions/sessionBySid + onDestroy 清理 → onSessionReady(realSessionId) → 构造**领域无关**首 prompt（见 step 14，内嵌 run.id + realSessionId）→ capturePrompt → 解析 gate/verdict → **非 gate（终态）销毁会话**（destroy + sessions.delete）；**gate 保活**（修 gate2 恢复 bug）。返回 `{output,verdict?,gateRequest?}`。
    - `resumeRound(run, message)`：`sessions.get(run.id)`（缺失才抛）→ `capturePrompt(session, message)`（自由文本答即下一 prompt）→ 解析 → 终态销毁/gate 保活。
    - `abortRound(run)`：`session = sessions.get(run.id)`；在则 `destroy()` + 两 map 删。（不 prompt。）
    - `getBySessionId`/`getLiveSessionMeta` 不变。
13. **`runtime.ts` 重写** `DefaultLoopRuntime`：
    - 加 `private readonly aborted = new Set<string>()`。
    - `acceptTrigger`：建 queued run + append 后，调 `this.start(...)`（替代 infer）。
    - `start(workspace,definition,run)`（替代 infer）：patch→running + append → `try{ result = await execution.startRound(..., async sid => append(patch({sessionId}))); settle(...) }catch{ aborted-guard / fail }finally{ active.delete }`。
    - `answerGate(GateAnswer)`：要求 `status==="waiting_for_gate"`（删 waiting_for_confirmation 分支 + approve/reject）→ patch running + append → `active.set(run.id, resume(...))`。
    - `resume(workspace,definition,run,message)`（替代 execute）：`try{ result = await execution.resumeRound(run,message); settle }catch{ aborted-guard / fail }finally{ active.delete }`。
    - `settle(workspace,run,result)`（新，从旧 execute 尾部抽出）：gateRequest → patch waiting_for_gate+output+gateRequest；否则 → succeeded+output+verdict+finishedAt。
    - `abortRun({workspaceId,runId})`（新）：get run；要求 status ∈ {running,waiting_for_gate} 否则 LoopConflictError；`aborted.add(run.id)` → `await execution.abortRound(run)` → patch failed+error:"aborted"+finishedAt + append。in-flight start/resume 见 session 被毁、catch 命中 aborted-guard 直接 return 不覆盖。
    - 删 infer/execute/reject 私有方法 + `definition.autonomy==="L3"` 分支 + waiting_for_confirmation append。
14. **领域无关首 prompt**（startRound 内），原文：
    ```
    你是这一 generic Loop 的常驻 orchestrator 会话。完整按下面的 LOOP.md 执行本轮。
    - 本轮 run id：${run.id}（写 LEARN / 产物时引用它）。
    - 你的会话 id（sessionId）：${realSessionId}（如需关联到工作项的 conversations 字段，用这个值）。
    - 你的 cwd 就是工作区根目录；LOOP.md 里提到的仓库相对路径都相对这里解析。
    - 需要人判断时，输出一行 `LOOP_GATE: <需要人决定的事>` 然后停下，不要自己越过。
    - 本轮完成时输出 `LOOP_VERDICT: <结论>`（或直接自然结束）。
    - 本 loop 的子代理已在其 agents/ 目录注册，按 LOOP.md 指引用 subagent 调用。

    # LOOP.md
    ${instructions}
    # STATE.md
    ${state}
    ```

### Phase E — host/client/web/路由（gate 自由文本 + abort）
15. `lib/loop/host.ts`：gate handler body 类型 `{message:string}`；import GateAnswer。新增路由 `POST /v1/workspaces/:id/runs/:runId/abort` → `runtime.abortRun(...)`。
16. `lib/loop/client.ts`：`answerGate(GateAnswer)` 发 `{message}`；新增 `abortRun(workspaceId,runId)`。
17. `lib/loop/web.ts`：仅保证编译（只 import error 类）。
18. `app/api/workspaces/[id]/loop/runs/[runId]/gate/route.ts`：body `{message:string}` → answerGate；缺 message → 400。
19. 新增 `app/api/workspaces/[id]/loop/runs/[runId]/abort/route.ts`：POST → abortRun；502 on host error。

### Phase F — 删死代码
20. 删 `lib/loop/checkers.ts` + `lib/loop/checkers.test.mjs`。

### Phase G — dev-loop：生成器 → shipped 静态模板
21. 删 `lib/loop/dev-loop/contract.ts` + `contract.test.mjs` + `authoring.ts` + `authoring.test.mjs`。
22. 新增 shipped 模板（真实文件，零 cxin 事实）`lib/loop/dev-loop/template/`：
    - `loop.yaml`：schema_version:1, id:dev-loop, name:"研发 Loop（通用）", enabled:true, triggers:[{weekday 09:00 cron Asia/Shanghai},{manual}]，**无 autonomy**。
    - `LOOP.md`：通用方法论 OODA + 三重判定 + L0 不变式 + phase 映射 + **cwd 从 alias 推导 `<根>/repositories/<alias>`** + **构建/checker 查工作区 AGENTS.md** + **敏感/模块映射 kb_search 查 KB** + **选定工作项 X 后** `workspace_update_work_item(X,{conversations:[...,<sessionId>]})` + `workspace_record_milestone(X,{type:"loop.started",data:{runId,repo,module}})` + **learn 是 LOOP_VERDICT 前硬步骤**（append 一条 LEARN，schema runId/workItemKey/module/repo/predictedConf/riskTier/outcome/tests/humanDecision?/ts）+ LOOP_GATE 合并 / LOOP_VERDICT 完成。
    - `STATE.md`：同现 renderDevLoopState 形状（通用化 Accepted baseline + 空 derived block `<!-- dev-loop:derived:start/end -->` + In-flight + Last audited）。
    - `agents/developer.md`：通用 TDD maker（branch_rules、test-first、永不合并主干、永不自证）；repo 路径「orchestrator 给的 cwd」；checker 命令「查 AGENTS.md」。
    - `agents/tester.md`：通用二元 checker（跑 AGENTS.md 里的 gate，报 `LOOP_VERDICT: green|red`，永不写生产代码）。
    - `LEARN.jsonl`：空。`audit/.gitkeep`：空。
23. 新增 `lib/loop/dev-loop/install.ts`（替代删掉的 authoring.ts）：`export const DEV_LOOP_ID="dev-loop"` + `ensureDevLoopDefinition(workspace)`（可读则返回 existing，否则递归拷 template/ → loops/dev-loop/，flag:wx + rollback，再 readLoopDefinition）+ `createDevLoopDefinition(workspace)`（存在抛 LoopConflictError，否则拷）。模板目录用 `import.meta.url` 解析。
24. `app/api/workspaces/[id]/dev-loop/route.ts`：import 从 authoring 改 install。
25. `lib/loop/learn/scheduler.ts`：`DEV_LOOP_ID` import 从 contract.ts 改 install.ts。

### Phase H — LearnScheduler 缺 LEARN 检测
26. 新增 `lib/loop/learn/completeness.ts`（纯）：`runsWithoutLearn(runs:{id,status}[], learnRunIds:Set<string>): string[]` —— status ∈ {succeeded,failed} 且 id 不在 learnRunIds。
27. 新增 `lib/loop/learn/completeness.test.mjs`。
28. `lib/loop/learn/scheduler.ts` runOnce：解析 LEARN 后，`import {listRunSnapshots} from "../store.ts"` 读 dev-loop runs → `missing = runsWithoutLearn(runs, new Set(records.map(r=>r.runId)))` → 有则 log 告警（不写）。try/catch 防 RUNS.jsonl 缺失炸聚合。

### Phase I — UI（自由文本 gate + abort；去 autonomy/plan）
29. `components/LoopLaunchOverlay.tsx`：STATUS_LABEL 去 inferring/waiting_for_confirmation，加 queued/running/waiting_for_gate/succeeded/failed；`LoopStatusBar` `onDecide(approve|reject)` → `onAnswer(message)` + `onAbort()`；两按钮改 input + 回复 + 终止；删 run.plan 渲染，留 gateRequest。
30. `components/AppShell.tsx`：`handleLoopGate` → `handleLoopAnswer(message)`（POST {message}）+ `handleLoopAbort()`（POST .../abort）；接到 LoopStatusBar。
31. `components/LoopConfig.tsx`：删 AutonomyLevel import + autonomy 表单 + 两处 Autonomy Level 选择栅格；`decide()` → `answer(loopId,runId,message)` + `abort(loopId,runId)`；run 面板删 plan 块、approve/reject 改小 gate 表单（input+回复+终止）；`TERMINAL=new Set(["succeeded","failed"])`，删 cancelled；删 loop.autonomy 显示。

### Phase J — 测试
32. `lib/loop/runtime.test.mjs`：mock backend 改 `{startRound,resumeRound,abortRound}`；新流：trigger→running→waiting_for_gate（startRound 返 gateRequest）→ answerGate({message:"ok"})→resumeRound 返 verdict→succeeded；加 abortRun 在 waiting_for_gate→failed。fixture loop.yaml 删 autonomy。
33. `lib/loop/authoring.test.mjs`：validInput 去 autonomy；其余保留。
34. 新增 `lib/loop/dev-loop/install.test.mjs`：createDevLoopDefinition 写 loop.yaml（断言无 autonomy + cron 0 9 * * 1-5）、LOOP.md（断言 /三重判定/、alias 推导、/kb_search/、/loop.started/、/conversations/、/runId/）、agents、STATE.md、空 LEARN.jsonl、audit/；重复拒绝；ensure 幂等。
35. `lib/loop/learn/scheduler.test.mjs`：验证 DEV_LOOP_ID 路径迁移后仍 import 干净。
36. 跑 `node_modules/.bin/tsc --noEmit`、`npm test`、`npm run lint`，修所有 fallout。

### Phase K — cxin workspace 落地（磁盘文件，不碰引擎代码）
37. 把通用模板写进 `~/.pi/workspaces/workspace-c/loops/dev-loop/`：覆盖 loop.yaml（去 autonomy）、LOOP.md、STATE.md、agents/{developer,tester}.md。**保留**现有 RUNS.jsonl（历史）和 LEARN.jsonl。
38. 修 `~/.pi/workspaces/workspace-c/AGENTS.md`：
    - repositories 段：regex 替换为 `renderWorkspaceRepositories(manifest, resolveRelativePath)`（扁平 `repositories/<alias>`）。
    - knowledge 段：在 repositories 段后插入 `renderKnowledgeSection(manifest, resolveRelativePath)`（带 markers，目前缺失，一并补）。
    - Build environment 段：补每个 repo 的确切 test 命令（cargoware→JDK8 + `mvn -pl <module> -am test`；cargoware-h5→`npm run test:ci`；cargo-report-server-haichuang→`mvn test`；cargoapi/cargo-h5-mp→无可用自动 gate）。保留其余段不动。

### Phase L — stock-loop 兼容（无需改代码）
39. 已核实 stock LOOP.md 已发 `LOOP_GATE:`（推送失败/高敏）并以 `LOOP_VERDICT:` 收尾。新引擎下它**不再停 gate1**（原本 L2→waiting_for_confirmation）；直接跑到自报 LOOP_GATE。其 loop.yaml 的 `autonomy:L2` 被新 readLoopDefinition **静默忽略**（不抛错），故加载/运行不变。**无需编辑**；PR 说明里标注行为变化 =「不再有执行前确认暂停」（符合其 LOOP.md 意图）。

---

## Files to Modify
- `lib/loop/types.ts` — 删 AutonomyLevel/MonitorVerdict/InferredLoopPlan；瘦身 LoopRunStatus；重塑 LoopRun（删 plan/workItemKey，verdict?:string）；GateCommand→GateAnswer{message}；加 abortRun；重写 RoundExecutionBackend。
- `lib/loop/store.ts` — 删 autonomy 校验+字段；容忍 legacy 键。
- `lib/loop/authoring.ts` — 删 autonomy；trim renderInstructions。
- `lib/loop/runtime.ts` — infer/execute/reject → start/resume/settle；加 abortRun + aborted-guard；answerGate 取 {message}。
- `lib/loop/pi-execution.ts` — 删 JSON-plan 解析 + maker/checker prompt；实现 startRound/resumeRound/abortRound；跨 gate 保活、终态/abort 销毁；首 prompt 嵌 run.id+sessionId；verdictFrom 泛化。
- `lib/loop/host.ts` — gate body {message}；加 POST .../abort。
- `lib/loop/client.ts` — answerGate({message})；加 abortRun。
- `app/api/workspaces/[id]/loop/runs/[runId]/gate/route.ts` — body {message}。
- `app/api/workspaces/[id]/dev-loop/route.ts` — import dev-loop/install。
- `lib/loop/learn/scheduler.ts` — DEV_LOOP_ID 从 install.ts import；加缺 LEARN 检测 log。
- `components/LoopLaunchOverlay.tsx` — 状态标签；LoopStatusBar 自由文本 onAnswer+onAbort；删 plan。
- `components/AppShell.tsx` — handleLoopAnswer/handleLoopAbort。
- `components/LoopConfig.tsx` — 删 autonomy UI + plan 块；gate 表单；TERMINAL set。
- `lib/loop/runtime.test.mjs`、`lib/loop/authoring.test.mjs` — 重写。
- `~/.pi/workspaces/workspace-c/loops/dev-loop/{loop.yaml,LOOP.md,STATE.md,agents/*}` — 覆盖为通用模板。
- `~/.pi/workspaces/workspace-c/AGENTS.md` — 扁平 repositories 段 + 补 knowledge 段 + 每 repo 构建/checker 命令。

## New Files
- `lib/loop/dev-loop/install.ts` — DEV_LOOP_ID + ensure/createDevLoopDefinition（拷 template/）。
- `lib/loop/dev-loop/template/{loop.yaml,LOOP.md,STATE.md,LEARN.jsonl,agents/developer.md,agents/tester.md,audit/.gitkeep}`。
- `lib/loop/dev-loop/install.test.mjs`。
- `lib/loop/learn/completeness.ts` + `completeness.test.mjs`。
- `app/api/workspaces/[id]/loop/runs/[runId]/abort/route.ts`。

## Files to Delete
- `lib/loop/checkers.ts`、`lib/loop/checkers.test.mjs`。
- `lib/loop/dev-loop/contract.ts`、`contract.test.mjs`、`authoring.ts`、`authoring.test.mjs`。

## Risks
- **Abort 并发**：abortRun 销毁 in-flight 会话时 capturePrompt 还在等。aborted-set guard 防 double failed 快照；abort 的快照必须赢。worker 要验 guard 顺序并在 runtime.test.mjs 显式测。
- **删 cancelled 状态**：历史 RUNS.jsonl 行可能带 cancelled/waiting_for_confirmation/inferring/plan。listRunSnapshots JSON.parse 不受影响（TS 不校验运行时 JSON）；UI 对旧状态无标签（显示原串）。可接受；要历史干净可一次性迁移（非必须）。
- **gate 答案语义现由 loop 定义**：引擎原样转 `{message}`。dev-loop（"已合并"/"打回"）与 stock-loop（推送失败决策）都须在 LOOP.md 写清。通用模板会写；stock LOOP.md 已隐含自由文本人审（读起来自然）。
- **终态后 live-session probe**：会话在 success/failure 后销毁（正确——run 结束），getLiveSessionMeta 终态后返 undefined。web SSE proxy 已对非 live 会话回落 .jsonl；确认 UI 不假设 orchestrator 在 succeeded 后仍 live。
- **模板目录在 jiti/Next 下解析**：install.ts 用 `fileURLToPath(new URL("./template", import.meta.url))` 定位。验 node:test(jiti) 与 Next server 都解析对。
- **learn/types.ts 保留 workItemKey**：故意不动（不工具化 learn 数学）。模板里 LEARN schema 仍写 workItemKey，一致。
- **AGENTS.md knowledge 段插入**是手工文本插入（markers 缺失→updateManagedRepositoryInstructions 不会建）。放 repositories 段相邻，使将来托管重渲染维护两段。
- **dev-loop 现有 cxin RUNS.jsonl**：那条历史 run 带 workItemKey:null、无 LEARN、旧 schema 状态。新 completeness 检测首 tick 会标它「completed without LEARN」——预期/信息性，非 bug。
