> **已退役（2026-09）**：v3 loop 引擎已被 pi-loop kit 取代，本文仅作历史参考。
> 现行设计见 `docs/pi-loop-kit-design.md`。

# dev Loop v2：动态编排 + 学习整备 设计稿

日期：2026-08-19 · 状态：待评审 · 前身：`docs/autonomous-dev-loop.md` §7（dev Loop）
改动面：**仅模板文件**（`lib/loop/dev-loop/template/`）+ cxin 部署副本，零引擎代码改动。

---

## 0. 背景与问题

cxin（workspace-c）已跑 12 个 run（4 merged / 6 blocked-parked / 2 竞态处置），暴露两类结构性问题：

**P1 流程定死、与项的大小不匹配。**
固定 6 角色 × 各自全新上下文 = 同一批产物（AGENTS.md/工作项/SPEC/PLAN/diff）在一个 run 内被复读 5-6 遍；rework 循环再放大（REQ-0024 实际派发近 10 次）。小需求被迫走全套仪式；大需求的跨仓落点反而不能并行。

**P2 学习产物在"总结运行"而非沉淀抽象。**
一篇一 run、永不合并 → 6 篇笔记已有 2 篇主题重叠（"trace 不能只看可见层"写了两遍）；泛化测试只测"删掉具体名还是不是规则"，不查重、不抬象；`LEARN.jsonl` 漂移成几百字 `humanDecision` 的叙事日志。

**P3 边界审计发现的规则打架 / 无主职责**（详见 §6）。

## 1. 目标 / 非目标

**目标**
1. orchestrator 从"跑固定流水线"改为"按任务 DAG 编排"——拆解有据（trace 证据）、依赖显式、可并行、可恢复。
2. 派发次数对项的规模连续伸缩：小项 3 次，大项按任务数。
3. 学习闭环改为"整备"：查重 → 合并磨尖 → 允许抬象 → 实例内联；运行档案与知识库分离。
4. 修复 §6 全部边界缺陷。

**非目标**
- 不改 Loop 引擎（runtime/pi-execution/store/scheduler）、不改 subagent 工具、不改 web UI。
- 不动 maker-checker 分席、不动 L0 安全边界（分支纪律、人手合主干、单工作项）。
- 不做同仓多 implementer 并行（仅跨仓并行——天然无文件冲突）。

## 2. 设计总览：四层 LOOP.md

```
┌ ① 角色菜单（6 契约）────────────────────────────┐
│ selector  brainstorm  writing-plans             │
│ implementer(×N 并行)  checker(合并 reviewer+     │
│ verifier)  learner(整备员)                       │
├ ② 硬不变式（全程约束，非步骤序列）───────────────┤
│ L0 七条（git 政策+单一基线合一条）+ N1-N3（§2.2）   │
├ ③ 拆解策略（指引）──────────────────────────────┤
│ 证据→派发计划 · SPEC 含任务 DAG · 拓扑序派发 │
└ ④ 恢复契约（按最成熟产物定位断点）────────────────┘
   里程碑盖戳 + DAG 缺口续跑（收养归 selector）
```

### 2.1 流程形态：角色菜单 + 组合规则（非预设路径）

**v2 没有内置“快路/全路”两套工作流。** 流程骨架由 orchestrator 每个 run 现场组合：角色菜单 + 启用证据 + 硬不变式，输出一份**派发计划**（显式产物，见 2.4）。动态性不限于 implementer 段的 DAG——包括“审”与“跑”要不要分席、要不要独立 writing-plans，全部由证据决定。

**角色菜单（合同制）：**

| 角色 | 必须上的证据 | 可选条件 | 永远 |
|---|---|---|---|
| selector | — | — | ✔（入口：选活 + 活性/收养 + 证据包） |
| brainstorm | 数据流跨层（FE↔BE）/ selector 拿不准 | — | — |
| writing-plans | 多任务耦合 / 敏感 / 多仓 | 单任务且 implementer 档位够 | — |
| implementer | — | — | ✔（maker，可 ×N 并行） |
| checker | — | — | ✔（唯一 checker 席，敏感升 strongest） |
| reviewer/verifier 分立 | — | checker 判断“审”与“跑”需独立视角（如敏感大项） | — |
| learner | 有教训候选 | — | — |

**组合规则：**

1. 必须项由**证据**触发，不是 orchestrator 心情——“跨层了就必须 brainstorm”是硬规则；跳过必须项仅当证据明确不支持（如 selector 数据流快筛判零跨层、零查询跳）。
2. L0 + N1-N3 对**任何**计划形状成立——安全性不依赖流程长什么样，这是组合自由的全部边界。
3. “必须”与“永远”之外的一切（writing-plans 上不上、checker 拆不拆、implementer 模型档、并行粒度）由 orchestrator 据证据包自定，落在派发计划里可审计。
4. 不合法计划（违 N1-N3/L0）在执行前判无效 → 有界重规划（≤2 次）；再挂泊车。
5. 反自欺表（§7 交付的 LOOP.md 内保留并扩充）是“合理化跳步”的对冲——“该想没想”的风险由证据触发 + 计划落产物事后校准两头压。

**典型形态（仅举例，非定义）：**

```
纯展示小项（零跨层证据）：selector(薄SPEC) → implementer → checker          （3 步）
中项（跨层单仓）：selector → brainstorm(SPEC+DAG) → implementer → checker   （4 步）
大项（跨3仓3落点）：selector → brainstorm → writing-plans → implementer×3并行 → checker（join）（5-7 步）
敏感大项：同上 + checker 拆回 reviewer+verifier 分席 + strongest
```

### 2.2 硬不变式（②层）

L0 精简为七条（原①git 政策权威与②单一基线同源于 AGENTS.md，合为一条：受保护分支/切分支基线/合并终点/命名/合并方式全按工作区 AGENTS.md，未声明→泊车不猜；单一基线贯穿 worktree 起点与 diff，交付前对齐合并终点）。其余保留：写范围限制、每仓至多一条分支、gate 纪律（两常规 gate + 合同修正唯一例外）、可观测、自治代理安全底线（永不 force-push/删远端）。编排自由追加三条边界，**违反任一条即拆法本身错误**：

- **N1 maker≠checker**：implementer 永不自验；checker 一席两职（diff 审查 + 全量 gate），敏感项 checker 模型升 strongest。
- **N2 全量 gate 合并前唯一一次**：AGENTS.md 仓库 gate 命令是唯一定义（见 §6-C9）；修复循环内 targeted，修完由 checker 重跑全量。
- **N3 拆分不得切过耦合点**：trace 识别出的耦合落点必须并成一个任务或有向串行；无证据不许拍脑袋切。

### 2.3 gate 语义（三种，均有 terse 格式）

| gate | 触发 | 内容 |
|---|---|---|
| plan gate | 非全绿（`tracedConf!=high ∨ 敏感 ∨ 无 gate`） | 人审 SPEC（含 DAG，可否决拆法）+ 一次性问全待澄清 |
| final-verify | 合并后 | 去哪验 + 怎么操作 + 期望结果 |
| 合同修正 gate（新增，罕见） | gate 批过的 SPEC 被 checker 判误读 README | 三个选项：A 改 SPEC+rework / B 否决 checker 照走 / C 泊车。**这是 L0"只许两 gate"的唯一例外口子**，必须 terse |

### 2.4 派发计划（显式产物，自主性的审计落点）

- **证据包**：selector/brainstorm 返回的是**证据**而非档位（跨层吗/敏感吗/几个落点/耦合在哪/有无 gate）——ceremony 从“流程档位”降为证据包 + 模型档。
- **派发计划**：orchestrator 据证据组合本次 run 的执行计划（步骤、并行结构、每步模型、每步派发对象），作为产物盖戳：`loop.dispatch{steps[]}`。plan gate 时人看得见并可否决（“别拆/拆错了/这个不需要独立 plan”）。两个作用：
  - **安全**：不合法计划（违 N1-N3/L0）执行前判无效，有界重规划；
  - **恢复**：run 挂了，收养读 dispatch 计划 + 盖戳缺口——任意形状的流程都能续，与“按最成熟产物定位断点”自洽（比固定序列更自洽）。
- **任务 DAG**（brainstorm 产出，SPEC 的“任务拆解”节）：每任务 `{id, scope, repos[], deps[], 验收引用}`；切分依据 = trace 后的耦合点分析（跨仓/链路无交集 → 可并行；有耦合 → 合并或串行）；join 在 checker（全部任务盖戳才派）；checker rework 清单带 task id。
- **运行中发现未声明依赖**：报回 orchestrator，**有界重拆/重规划合计 ≤2 次**（milestone `loop.resplit{round,reason}`），不算失败；到顶泊车。
- **人可否决**：plan gate 对 DAG 或整个派发计划说“拆错了/这个组合不对” → brainstorm/orchestrator 重排一次（计入重规划预算）。

### 2.5 恢复契约（④层）

- 断点 = 最成熟产物（里程碑盖戳），不再是序列位置：无 SPEC → brainstorm 起；有 SPEC 无 PLAN → plan/impl 起；部分任务盖戳 → 只补缺口任务；分支已推 → 合并起。
- **收养判定归 selector**（原 round 0 orient 删除）：读 RUNS + 工作项 + 里程碑，判定"这个非 intake 项的归属 run 是否已死、可否收养"；不可收养的孤儿按 park 处理。
- 无活时 selector 返回 `decision=idle` + 待人验清单（`phase==verification` 项），orchestrator 出 terse 提醒后收工。

### 2.6 派发成本对照

| 场景 | 现状 | v2 |
|---|---|---|
| 纯展示小项 | 6 次 | **3**（典型组合：selector/implementer/checker） |
| 中项（跨层单仓） | 6 次 | **4**（selector/brainstorm/implementer/checker 的典型组合） |
| 大项（跨 3 仓 3 落点） | 6 次串行 | **5-7 但并行**（implementer×3 并行后 checker join） |
| 每次 rework | 2 席可能各冷启动 | 1 席 |

## 3. 角色契约变更

| 角色 | 变更 |
|---|---|
| **selector** | 吸收 orient：活性/收养判定、idle 裁决；输出**证据包 + 模型档**（跨层吗/敏感吗/几个落点/耦合在哪/有无 gate），不再定“流程档”；`predictedConf` 定稿为**选中后不可变**的选品预测（校准数据源）；`repos` 初判仅作 claim 占位（权威归 brainstorm 的 SPEC） |
| **brainstorm** | SPEC 增加"任务拆解"节（DAG + 耦合点分析）；frontmatter `repos[]` 为仓集合权威；`tracedConf` 取代原 predictedConf 覆盖写；gate 否决后由它重派改稿（带人的意见）；plan gate 否决拆法后由它重拆 |
| **writing-plans** | 合同为“任务内步骤 + 测试计划”；上不上由派发计划定（默认仅多任务耦合/敏感/多仓时进计划）；跨任务顺序归 SPEC DAG；可被 rework 重派（PLAN 缺陷路由，共享总预算） |
| **implementer** | 每任务一个实例（任务 id + 范围传入）；无独立 writing-plans 步时在 IMPLEMENTATION.md 自带计划节；单一基线按 AGENTS.md（§6-C8）；并行实例各管各的分支/worktree |
| **checker**（新，默认形态合并 reviewer+verifier，可拆回分席） | join 点：全任务盖戳才派。两职：**先审后跑**——审全量 diff（SPEC 合规 / README 原始验收点 / 质量），过审后跑全量 gate（AGENTS.md 命令 + PLAN 接线测试核对）。敏感大项可自清拆回 reviewer+verifier 两席（独立视角，orchestrator 按证据组合）。verdict worst-wins；rework 清单 `<taskId> <file>:<line> <问题> <期望>` + 缺陷源头标注（code/plan/spec）。跨仓逐仓跑、按仓分节出 VERDICT.md |
| **learner** | 从"归档员"改为"整备员"（§4） |

ceremony 形态（证据包 + 模型档；流程组合不再由 selector 定，由 orchestrator 据证据组合）：
```
ceremony: {
  evidence: {crossLayer: bool, sensitive: bool, touchpoints: N, couplings: [...], hasGate: bool},
  brainstormModel: strongest,          // 上 brainstorm 时永远 strongest
  planModel: cheap|standard,
  implementerModel: cheap|standard,
  checkerModel: cheap|standard|strongest(敏感),
  learnerModel: cheap
}
```

## 4. Learning 子系统

### 4.1 learner = 整备员

派发输入不变（一句话教训候选 + 触发场景 + module + runId）。流程改为：

1. **泛化测试两问**（硬）：
   - 问一（原有）：删掉具体 key/类名/方法名，剩的还是不是一条规则？
   - 问二（新增）：它是不是知识库某条已有规则的实例？（`kb_search` 查近似笔记）
2. 问一不过 → `written=none`（代码指针级事实归工作项文档，在 git 里）。
3. 问二命中**loop 自建的可维护笔记**（`autoManaged: true` 且 hash 校验通过，见 4.2）→ **合并磨尖**：规则表述收紧、必要时**抬一层抽象**（如"trace 含后端拦截器"+"参照页参数面 diff"→"trace 范围必须覆盖不可见层"）、触发场景**内联追加**到笔记的实例区（人不用另开文件翻）。
4. 问二命中**人的笔记**（hash 不匹配）或**主题确实是新规则** → 开新文件（路径含 runId），并在文中引用近亲笔记。
5. 模块级陷阱也写 learnings/（强 module tags，kb_search 命中）——`standards/dev-loop-modules.md` 改为**纯人维护**，删除"loop append"字句（§6-A1）。
6. 一 run 最多触达/新增 1 篇笔记（合并算触达）。

### 4.2 防覆写人的修改（hash 机制）

笔记 frontmatter 增加 `contentHash`（正文哈希，learner 写入/合并时更新）。learner 合并前重算：
- 匹配 → 未被人改过，可合并；
- 不匹配 → 人改过，该笔记即权威 → 降级为开新文件 + 引用。
机制化，不靠自觉。

### 4.3 运行档案与知识库分离

- **`LEARN.jsonl` 退役冻结**：留在原地当历史，不再 append（`humanDecision` 叙事正是 P2 病灶；丰富结论归 VERDICT.md / 工作项里程碑）。
- **`LEARN/<runId>.md` 新增**（loop 目录下）：纯档案，人可翻"每次 LEARN 了什么"——教训候选、learner 处置结果（合并进哪篇/新开哪篇/丢弃及原因）、索引字段（`predictedConf`/`tracedConf`/`outcome`/`tests`/`module`）。**无任何流程读它做决策**；校准参考由 selector 自愿 `ls -t` 翻阅。
- 知识唯一载体 = 知识库 learnings/ 笔记（整备后的）。

### 4.4 存量回填（一次性）

- 2 篇重叠笔记手工归并：以"trace 覆盖不可见层"为主题合出一篇（抬象后），实例区挂 REQ-0012 / REQ-0024 两个场景；原 2 篇删除（备份进 git——cargo-knowledge 本就是 git 仓）。
- 其余 4 篇补 `contentHash`。

## 5. md 契约（里程碑更新）

```
loop.started{runId,repo,module}
loop.dispatch{steps[]}                  ← 新（显式派发计划，含 DAG/并行结构/模型档）
loop.spec_ready{specPath,tracedConf,scope,repos[],tasks[]}
loop.resplit{round,reason}              ← 新（有界重规划）
loop.plan_ready{planPath}               ← 仅当派发计划含 writing-plans 步
loop.impl_ready{taskId,branch,worktree} ← per-task
loop.check{verdict,perRepo{}}           ← 合并原 review+verdict
loop.rework{round,source,taskId}        ← source: code|plan|spec
loop.merged{branches,mergeCommits}
loop.adopted{prevRunId,dispatchResumed}
```

结构化信号（ceremony / tracedConf / verdict / DAG / branch / worktree / 修复轮次）一律以文件 frontmatter / 里程碑 data 为准，subagent 返回文本只作即时定位——**这条不变，它是收养与断点恢复的全部依据**。

## 6. 边界缺陷修复清单（审计结论）

| # | 缺陷 | 修法 |
|---|---|---|
| A1 | learner 双归宿但只许写一个，standards 的"loop append"无执行者 | 单一归宿：loop 写的全进 learnings/（强 tags）；standards 纯人维护 |
| A2 | reviewer 可单方面推翻人批准的 SPEC 且不回 gate，与 L0⑤ 咬死 | 按权威来源分流：gate 批过的 → 合同修正 gate 交人（§2.3）；跳 gate 的 → README 即权威，brainstorm/selector 重派改 SPEC 后 rework |
| A3 | predictedConf 双写者覆盖，校准信号被销毁 | 拆 `predictedConf`（selector，不可变）+ `tracedConf`（brainstorm）；LEARN 档案记两者 |
| B4 | 工作项 repositories 三角色伸手无权威 | SPEC frontmatter `repos[]` 权威（brainstorm trace 后写）；orchestrator 机械写回；selector 初判仅占位 |
| B5 | 打回一律塞给 implementer，PLAN/SPEC 缺陷无路由 | 按源头路由：code→implementer；plan→重派 writing-plans；spec→A2 路径。共享 5 轮总预算，orchestrator 到顶裁决 |
| B6 | 跨仓 N 份裁决聚合未定义 | checker worst-wins 聚合；VERDICT.md 按仓分节；里程碑存 per-repo map |
| B7 | gate 否决后改 SPEC 的执行者未指定 | 重派 brainstorm（skip 路径重派 selector）带人的意见改稿；orchestrator 永不亲手改产物 |
| C8 | "主干"vs"集成分支"混用，diff 基线被 develop 领先 master 的分叉污染 | 单一基线 = AGENTS.md 通用流程声明的切分支基线（cxin=`origin/master`）：worktree 起点与 diff 同源；交付前对齐合并终点（集成分支-ready）；checker 对齐带入的他人改动按 filesChanged 剔除 |
| C9 | targeted/全量/"单个测试"三档靠自觉；verifier 两个命令来源优先级不明 | 全量 gate 唯一定义=AGENTS.md 仓库 gate 命令；targeted=文件/模块级；checker 先审后跑；PLAN 只选 targeted 套餐+必须引用 gate 命令 |
| C10 | writing-plans"任务排序"与新 DAG 撞车 | 跨任务顺序=SPEC DAG（brainstorm）；PLAN 只排任务内步骤 |

## 7. 交付物

> **后记（实现时架构调整）**：实现期间 pi-web 退役了 dev-loop 的代码特化路径（`lib/loop/dev-loop/` 模板 + `install.ts` + 专用 API）——**loop 是每个工作区自定义的资产**，pi-web 只提供通用引擎与授权面。因此交付物以工作区部署为准，仓库内不再有模板：

| 对象 | 动作 |
|---|---|
| `~/.pi/workspaces/workspace-c/loops/dev-loop/LOOP.md` | v2 四层重写（以旧部署版实战补丁——收养、跨仓 worktree、md 契约、幂等 learn——为基底）；旧版 `.bak` 留档 |
| 同目录 `agents/{selector,brainstorm,writing-plans,implementer,checker,learner}.md` | 六角色 v2 契约（checker 合并原 reviewer+verifier，两文件退役） |
| 同目录 `LEARN/` | 新建（per-run 档案）；`LEARN.jsonl` 冻结退役 |
| cargo-knowledge learnings | 一次性回填（§4.4） |
| pi-web `AGENTS.md` / 本设计稿 | 文档同步 |

验证：纯 prompt 资产，无单测；验证靠下一次真实 run 观测（RUNS 里程碑新字段 + LEARN/ 目录出现）。
## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| orchestrator 拆解失控（拆太碎/漏依赖） | N3 硬边界 + plan gate 人可否决拆法 + 有界重拆 ≤2 + 收养按盖戳续跑兜底 |
| checker 一席两职，跑绿 gate 后放松审 diff | 契约写死顺序：**先审后跑**（审不过不烧全量 gate）；敏感项 strongest；反自欺表加条目 |
| learner 抬象过头产出废话规则 | 两问闸门 + 实例内联锚定（规则必须挂着已见场景）+ 一 run 最多 1 篇 |
| 合同修正 gate 被滥用变相开第三个 gate | L0 明文标注"唯一例外口子，必须 terse"；gate 计数进 RUNS 可审计 |
| 部署版与代码库再漂移 | n/a——代码库已不携带 loop 模板；每个工作区的 loop 是自定义资产，自身即权威（v2 起点已归一） |

## 9. 开放决策（审稿时确认）

1. 存量回填（§4.4）现在做 vs 跑通 v2 后再做 —— 建议现在做。
2. 部署基底用 cxin 版归一（§7 已按此写）—— 已按建议值 A 落稿，可否决。
