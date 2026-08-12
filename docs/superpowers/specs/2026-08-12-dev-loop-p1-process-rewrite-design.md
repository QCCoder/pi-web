# dev-loop P1：流程层重写（正确性 + 范围纪律 + 砍浪费 + gate 收敛）

- **状态**：Draft（brainstorm 输出，待 review）
- **日期**：2026-08-12
- **范围**：P1 — dev-loop 模板文件（`lib/loop/dev-loop/template/`，pi-web 仓库）+ cxin 工作区落地（`~/.pi/workspaces/workspace-c/`，含已安装实例刷新与 cxin 专属规则同步）。**零引擎改动**
- **验证案例**：run `01KZSZPXH3028AZR4CAS9ENCG0`（REQ-0012「目的港服务查询新增等于判断」）

---

## 1. 背景

cxin dev-loop 首次跑一个小需求（REQ-0012），暴露两类成本：

- **人工介入多**：约 6 小时（03:19→09:24）、约 8 次人触点。
- **token 大**：约 10 次 subagent 派发 + 一次整轮"白跑"。

根因（按杠杆排序）：

1. **判断错**：designer 结论"纯前端"，漏看 `JobUtil.buildDestinationPortServiceCondition`（OR 硬编码）→ 整轮白做 + 靠人纠根因（事件 `loop.rootcause_corrected`）。这一条同时是最大 token 浪费和那次人兜底介入的源头。
2. **token 冗余**：subagent 各自重建上下文、重复全量编译、orchestrator 长寿命会话累积上下文。
3. **gate 多/碎**：在 1/3 范围上 gate、自建 follow-up 需求（REQ-0016）、gate1 反复 re-open。

用户补充的不满（逐条）：

- (a) 3 处只改 1 处就 gate 验收；"不应该全部做完吗？"
- (b) 自作主张创建需求 / 开别的分支。
- (c) 分析不完整，东西都改错了。
- (d) subagent 开来开去，中间编译很耗时。
- (e) 开始 prompt 把 STATE 带出来，而 LOOP.md 里写了它会自己读 → 重复喂。

其中 (e) 是**引擎**问题，归 P2。(a)(b)(c)(d) 在 P1 治。

## 2. 范围

- **P1（本 spec）**：改 dev-loop 模板文件（`LOOP.md` + `agents/*.md`，pi-web 仓库）+ cxin 工作区落地（见 §5）。不动 `lib/loop/` 引擎。
- **P2（后续独立 spec）**：引擎层 —— 去 `buildFirstPrompt` 预喂 STATE（用户 e 条）、长跑会话上下文管理、同仓库串行调度守卫。
- **P3（后续独立 spec）**：e2e / 契约自动验证，把 final-verify 从"人浏览器验"降为"脚本验 + 人盖章"。

## 3. 设计总览

四节规则 + 一条贯穿的文档风格。

### 文档风格（贯穿，所有 .md）

动作优先（先 Round 步骤、再硬规则框）；硬规则单独成框；一句能说清不写两句；哲学 / 为什么删或放末尾。现行 LOOP.md 开头 5 行哲学引言要砍成 2 行。

### §1 范围纪律（治 a / b）

加两条 L0 不变式（写入 LOOP.md "硬、不可违"段）：

> **7. 单工作项 · 单分支。** 只动 planner 选中的**那一个**工作项、**唯一一条** feature/hotfix 分支。
> - 禁止创建任何新工作项（含 follow-up、子需求）。
> - 禁止开第二条分支。
> - **范围超限判定**：需人介入的（需求方澄清 / 拆需求 / 跨团队 / 依赖外部）→ 立即停、泊车、交人，绝不自建自拆。**纯技术工作（跨仓、给别的菜单加字段）一律做完，不算超限。**
>
> **8. 全范围做完才验收。** 工作项声明的**所有**改动点必须在**同一次 run 内全部完成**后才发 `LOOP_GATE`。
> - 整 run 只允许两个 gate：① `plan-approval`（写代码前，非全绿项才发）② `final-verify`（全做完后）。
> - **中间禁止插任何 gate；禁止在部分范围上 gate。**

### §2 正确性前置（治 c）

- **2.1 designer · 全链路追 + 反证**：下 scope 结论前逐跳追全链路（UI 控件 → 前端查询组装 → 请求 → 后端解析/组装器 → SQL），每跳核实 file:line；必做**反证搜索**（"通用路径之外有没有专用拦截 / 组装器也在碰这个字段"）。DESIGN.md 必含「全链路清单」+「反证结果」两段。反证范围框死：本字段链路 + grep 该字段 / flag 的所有调用点，不扩成全仓漫游。
- **2.2 诊断 · 复现优先**：修任何**已上报失败**（gate7 打回 / tester red / 自检失败）前，先写复现该症状的失败测试、看红、再改看绿。禁止"读码猜改"。复现测试对准**上报症状**，不是自己猜的纯函数。
- **2.3 tester · 边界覆盖**：覆盖**症状所在边界**（查询类 = UI 输入 → 组装出的查询 + 查询 → SQL 条件两段），不只测孤立纯函数。
- **2.4 信心定义**：`high` 仅当"全链路追完 ∧ 反证搜索做完 ∧ 能写出复现路径"三条满足；否则 `med` / `low` 且**必须 gate**。

### §3 砍流水线浪费（治 d）

- **3.1 信任上游产物**：每阶段从上一阶段的 `.md` 产物起手（designer←PLAN，developer←PLAN+DESIGN，tester←IMPLEMENTATION），不许把上游已做的探查重做一遍。要推翻上游须显式标"上游错了，理由…"。
- **3.2 worktree 隔离**：每 run 用**唯一 worktree**（带 runId 命名）；交付前 `git status` 核，工作区有**非自己产生的改动 → 立即停下报告，不许盲目 reconcile**。
- **3.3 增量构建**：开发期 developer 只跑**受影响的测试文件 / 模块**（targeted）；**全量 gate 只 tester 阶段跑一次**；已知基线就红的全量套件（如 `npm run test:ci` 的 1788 lint error）不当"我的改动红没红"的信号 —— 跑 targeted + 和基线 diff。

### §4 gate 收敛（治 #3 的 gate 部分）

- **4.1** 最多一个 plan gate（普通项 gate 在 PLAN；敏感项 gate 在 PLAN+DESIGN，一起审）。plan gate 后、final-verify 前**禁再插 gate**。
- **4.2 一次性问全**：plan gate 必须把所有待澄清项一次列尽；答后若冒出真·新未知，最多再**合并**问一次，不得反复 re-open。
- **4.3 全绿才免 gate**：全绿项（§2.4）直接跑到 final-verify，不 plan gate。
- **4.4 gate 消息 terse**：plan gate = 待决项 + 选项（A/B）；final-verify = 去哪验 + 怎么操作 + 期望结果。**不写长总结**。

## 4. 文件级改动

| 文件 | 改动 |
|------|------|
| `template/LOOP.md` | 砍哲学引言 → 2 行；加 L0 不变式 7、8（§1）；Round 序列改 gate 逻辑（只剩 plan-approval + final-verify，删"部分范围 gate / 中间 gate"分支）；加"范围超限判定"段（§1.7）；删"自建 follow-up / 新分支"相关分支（§1.7）；rework 路径指向 developer 的"复现优先"（§2.2）；designer 派发 task 内含反证搜索要求（§2.1）；输出 terse 规则（§4.4 + 文档风格）。 |
| `template/agents/planner.md` | 信心判定改 §2.4 三条；plan gate 一次性列全所有待澄清项（§4.2）；不推断 / 不开新需求（§1.7）。 |
| `template/agents/designer.md` | 加 §2.1 全链路追 + 反证搜索（范围框死）；DESIGN.md 必含「全链路清单」「反证结果」；scope 结论须全链路支撑，否则降信心（§2.4）。 |
| `template/agents/developer.md` | rework / 诊断 §2.2 复现优先；§3.1 从 PLAN+DESIGN 起手不重探查；§3.2 唯一 worktree + 交付前 `git status` 核脏（脏则停报不擦）；§3.3 开发期 targeted 测试。 |
| `template/agents/tester.md` | §2.3 边界覆盖（不只纯函数）；§3.3 全量 gate 在此跑一次。 |
| `template/STATE.md` / `LEARN.jsonl` / `loop.yaml` / `audit/.gitkeep` | 不变。 |

**部署**：见 §5。

## 5. cxin 工作区落地

P1 改完 pi-web 的 `template/` 后，cxin（`~/.pi/workspaces/workspace-c/`）的**已安装实例**和 **cxin 专属规则**必须同步，否则新 LOOP.md 会和旧 cxin 规则打架。以下都是工作区文件系统的改动（不在 pi-web 仓库，无 git）。

**A. 刷新已安装的 dev-loop 实例**
覆盖 `loops/dev-loop/{LOOP.md, agents/*.md}` 为 P1 新版；**保留** `RUNS.jsonl` / `LEARN.jsonl`（历史轨迹）。

**B. 同步 cxin 专属规则 `knowledge/cargo-knowledge/standards/dev-loop-modules.md`**
- L25「全绿」定义对齐 §2.4：`high 信心` = 全链路追完 ∧ 反证搜索 ∧ 可复现路径（不再是旧笼统 high）。
- L61 过期引用 `lib/loop/checkers.ts`（重设计时已删死代码）→ 改指工作区 `AGENTS.md` 的构建/checker 段。
- 「全绿 → 自动推进」对齐 P1 流程：全绿直跑 final-verify、不发 plan gate（§4.3）。
- 术语 `gate1` → `plan gate`（求一致，可选）。
- 注：本表人工编辑即权威（见其文末「维护」段，Loop 不覆写），所以 B 是**人手改**，不是 loop 自己改。

**C. 核 `AGENTS.md` 不与 §1 冲突**
现有「plan approved 后才开分支」「feature/hotfix 命名」与 §1 单工作项·单分支一致，预期无需改；确认无"允许 loop 自建工作项 / 多分支"之类字样即可。

**D. REQ-0012 saga 残留清理**（P1 部署前把 cxin 拔回已知干净态）
实测后真实残留比预想小——REQ-0016 已由人 `cancelled`+`archived`、STATE In-flight 已清空、parked 项与 STATE 校准均合法不动。要处理的只有：
1. **RUNS.jsonl 记录矛盾**：run `01KZSZPXH3028AZR4CAS9ENCG0` 末条快照 = `failed "Pi round timed out"` @04:00，但实际跑到 done @09:24（events + STATE 均证）。RUNS 是 append-only 证据日志，**不手改**；根因（round 超时标 failed 但会话继续）记进 P2 修引擎。
2. **REQ-0011 孤儿**：停在 `plan_approval`/`blocked`，它的 run（`01KZSYKR`）已 aborted。P1 §1 下新 run 只接 `intake` 项 → 它会永久卡死。→ **重开回 `intake`**（让人在下个 run 干净重评；已定）。
3. **REQ-0016**：已 closed，无需动；要零残留可删 archived 目录（可选）。

## 6. 验证案例：REQ-0012 若按 P1 重跑

| 当年发生 | P1 规则 | 会怎样不同 |
|---------|---------|-----------|
| designer 结论"纯前端"，漏 `JobUtil` OR 硬编码 | §2.1 反证搜索 | 追到通用路径外的 `buildDestinationPortServiceCondition` → scope 改"前后端都动"，首轮判对 |
| 整轮前端实现 + gate7 打回 | §2.1 + §1.8 | 首轮判对 → 不白跑、不打回 |
| 多选值没传全 → 改 multiple=1（错根因） | §2.2 复现优先 | 先写"等于{清关,派车} 返回 B"的失败测试 → 定位真因（后端 OR），一次改对 |
| 单测全绿却漏 bug | §2.3 边界覆盖 | tester 加接线层测试 → 抓到 |
| 做了 1/3 菜单就 gate7 | §1.8 | 必须三菜单全做完才 gate |
| 建 REQ-0016 follow-up | §1.7 | 禁止；那两菜单加字段属本需求，直接做 |
| gate1 列 5 项后又 re-open | §4.2 | 一次性问全，不 re-open |
| gateRequest 几百字 | §4.4 | terse：待决项 + 选项 |

**预期效果**：REQ-0012 从 ~8 次人触点 / ~10 subagent / 6h → 大幅下降（plan gate 一次 + final-verify 一次；planner + designer + developer + tester 各一次，无 rework）。

## 7. 测试与验收

- `lib/loop/dev-loop/install.test.mjs`：扩断言 —— 安装出的 LOOP.md 含不变式 7/8、无"创建 follow-up"分支、含 gate terse 规则；planner / designer / developer / tester.md 各含对应 §2/§3 关键句。
- 人工 dry-run：拿 REQ-0012 的 PLAN，按新 LOOP.md 走一遍 Round 序列，确认每步规则可执行、无矛盾。
- 真跑一次（P1 落地后）：workspace-c 上跑一个小需求，数人触点 / subagent 次数 / 是否白跑，对照本 spec 预期。

## 8. 风险

- **反证搜索 / 全链路追可能过度烧 token**：用 §2.1 的范围框（本字段链路 + grep 调用点，不扩成全仓）兜。
- **"全范围做完才验收"可能让单 run 过长**：靠 §1.7 超限判定（纯技术做完、需人介入才停）+ P2 上下文管理兜。
- **删"自建 follow-up"可能让大需求无处放**：超限就泊车交人、由人拆 —— 有意为之（不越权）。
- **terse gate 消息可能漏关键信息**：final-verify 仍须给足"去哪验 / 怎么验 / 期望结果"，terse ≠ 缺信息。

## 9. 不在本 spec

- **P2 引擎**：去 `buildFirstPrompt` 预喂 STATE（用户 e 条）、长跑会话上下文管理、同仓库串行调度守卫。
- **P3**：e2e / 契约自动验证（降 final-verify 人工）。
- 合并或删除 `STATE.md` / `LEARN.jsonl`（它们是运行时数据，不是文档，保留）。
