# pi-loop kit 设计文档

> 状态：已评审定稿（2026-09；评审决议 D9–D14 已并入正文）
> 背景：用 loop-engineering（cobusgreyling/loop-engineering，10.7k★）的设计理念，替换 pi-web 现有 v3 loop 引擎。
> 决策记录见本文档末尾"已确认决策"。

## 1. 背景与动机

pi-web 现有 loop 子系统（v3：daemon orchestrator session + 确定性 seeder + RUNS.jsonl + 里程碑机器）被判定为过重，三类痛点并存：

- **A 维护/理解成本**：v1→v2→v3 演化残留多，改一处要懂全链路，无法复制到其他仓库；
- **B 运行时重**：每轮一个 orchestrator selection session + seed 二段跳，浪费 token 和进程；
- **C 绑定 pi-web**：loop 依赖 daemon 引擎，脱离 pi-web（纯 pi CLI 场景）无法运行。

loop-engineering 的解法是**文件即程序**：协议文件（LOOP.md/STATE.md/约束/预算）+ agent CLI 冷启动读文件 + cron 心跳。运行保障从"机器保证"降维为"文件协议 + 分级放权 + 人类纪律"。

同时确立 pi-web 的定位原则：**pi-web 是壳，通用 agent 能力归 pi 生态**（subagent、权限等走社区 pi package，pi-web 只做观测、装配、域工具）。

## 2. 终态架构

```
能力层   pi 内核（read/bash/edit/write + skills + AGENTS.md 注入）
         + 社区 pi 扩展（pi-subagent 系、pi-permission-system、按需 pi-mcp-adapter）
         ——通用 agent 能力，我们不拥有代码，只做选型与审计
协议层   pi-loop kit（loops/*/LOOP.md、STATE.md、loop-constraints.md、loop-budget.md、
         .agents/skills/<name>/SKILL.md、.pi/agents/*.md）
         ——纯文件，跑在任何有 pi 的仓库/workspace 上
壳层     pi-web（工作区管理、会话 UI、工作项、禅道 importer）+ daemon（session 宿主 + 心跳 spawner）
         ——不再内置通用 agent 能力；work-items/kb_search 是域工具，保留
```

**文件即声明**：`loops/*/LOOP.md` 存在即 loop 存在，删除即消失。没有能力开关、没有 manifest 字段、没有中央注册表。

## 3. 范围与分期

- **第一阶段（本设计）**：
  1. pi-loop kit：协议文件规范 + 模板库（phase 1 手动复制，不做 npx CLI）；
  2. pi-web 拆除 v3 loop 引擎，daemon 换装极简心跳 spawner；
  3. workspace-c 迁移到 kit 形态；
  4. subagent 依赖社区包（kit 场景先行，天然审计）。
- **第二阶段（kit 验证后另行设计）**：
  1. pi-web 的 `lib/subagent/` 切换到同一社区包，删除自有实现；
  2. `npx pi-loop init` CLI 与模式库打磨、开源发布；
  3. work-items / kb_search 可选打包下沉为 pi package（域工具外溢）。

## 4. Kit 文件规范

目标仓库（或 workspace 根）布局：

```
loops/<loop-name>/
  LOOP.md            # 声明 + 合同指针（见下）
  STATE.md           # 记忆脊柱：每轮读写，唯一运行状态
  PAUSED             # 暂停标记（可选，存在即跳过起轮，见 §7）
loop-constraints.md  # 绑定约束（宪法文件，agent 禁改）
loop-budget.md       # token/轮数预算（宪法文件，agent 禁改）
loop-ledger.json     # 断路器账本（agent 可追加，禁删改历史）
.agents/skills/<pattern>/SKILL.md   # 模式合同（本轮做什么、产出什么、如何写 STATE）
.pi/agents/*.md                      # 角色（maker/checker/brainstorm…，社区 subagent 包消费）
.pi/settings.json                    # packages 依赖（pin 版本，项目信任后 pi 自动安装）
.github/workflows/loop.yml           # 仅 GitHub 托管仓库生成；workspace 不需要
```

**共享语义（评审决议 D13）**：三份宪法文件与账本位于仓库/workspace **根**，被该根下所有 loop **共享**——`loop-budget.md` 是全 workspace 的总帽（所有 loop 合计），STATE.md 的 `[BUDGET]` 节只是本轮视角的自报快照，**不是权威计数**（phase 2 由 spawner 对账 ledger 后回写）。

### LOOP.md 格式

```markdown
---
name: dev-loop
pattern: dev-loop          # 对应 .agents/skills/<pattern>/
cron: "0 8 * * 1-5"        # 心跳节奏（daemon spawner 解析）
level: L1                  # L1 report-only / L2 assisted / L3 unattended
max_minutes: 30            # 单轮进程超时
---

# 本轮合同指针
1. 读 loop-constraints.md 与 loop-budget.md（绑定）
2. 读 STATE.md 恢复上下文
3. 执行 /skill:<pattern>
4. 更新 STATE.md；L2+ 才允许 git 操作（worktree → checker → draft 分支）
```

frontmatter 是机器可读声明（spawner 解析 cron/level/max_minutes），正文是人类/模型可读的开场合同。**合同本体在 SKILL.md**（复用 pi 的 `/skill:` 展开机制），LOOP.md 只做指针——这与 v3 的 LOOP.md（选择合同）+ SKILL.md（执行合同）二分不同，kit 里选择与执行合并在同一轮。

### STATE.md 格式

```markdown
# Loop State — <name>

Last run: <ISO 时间> · outcome: report-only|escalated|failed

## High Priority（等待人或循环正在处理）
- [ ] REQ-0042 — 主链路 flaky test：本轮已定位到 X，卡在 <问题>，需要人决定 <选项>

## Watch List
- PR #38 开了 4 天无人评审

## Recent Noise（本轮忽略）
- Dependabot PR（走独立自动化）

## [BUDGET]
- 今日已用 ~120k / 300k

## Post-run critique
- 误报：#52 不是 flaky 是超时配置 → 下轮先查 CI 配置
```

规则：`Last run`/优先级分区/复盘必填；已解决项从分区删除（git log 留痕）；**STATE.md 是唯一运行状态**——没有 RUNS.jsonl，没有 orchestrator 快照。

### 宪法文件与账本

- `loop-constraints.md`：路径黑名单（.env/secrets/auth/payments/migrations…）、"先测试后修"、单轮单修、尝试上限、push/merge 规则、沟通规则。SKILL.md 开场必读。
- `loop-budget.md`：每日 token 上限、每日最大轮数、每轮最大 subagent 派生数；超 80% 转 report-only；超 90% 只能在 STATE.md `[BUDGET]` 节**请求**提额（人改预算文件后才生效）。
- `loop-ledger.json`：`{attempts:[{at,item,error,digest}], consecutiveFailures}`。同一 error digest 连续 3 次或单项尝试 >3 → 本轮停止该项，标 escalated。数字规则是协议（模型自查），phase 2 可加 daemon 硬校验。

**三份宪法文件（LOOP.md level 字段 / constraints / budget）agent 一律禁改**——写进每份 SKILL.md 的硬性条款。

## 5. 执行模型与心跳

### 两种心跳，一套协议

> 修订（2026-08-30，见 docs/pi-loop-host-design.md）：心跳宿主新增 `pi-loop beat`（一次性幂等，任意外部 cron 可每分钟调用）；fire 判定改 `.lastrun` + nextDue（错过槽位恢复后至多补一轮），起轮统一 per-loop `.round.lock`（双宿主互斥）。

| 场景 | 心跳 | 轮进程 | 扩展装配 |
|---|---|---|---|
| pi-web workspace（本地） | daemon DaemonJob（扫 `loops/*/LOOP.md` 解析 cron） | **daemon 内起一次性 AgentSession**（startRpcSession，cwd=workspace 根） | pi-web workspace 装配保留（work-items/kb_search/skills 过滤/extraAgentDirs） |
| GitHub 托管仓库 | GitHub Actions cron | `pi -p --approve "<seed prompt>"`（headless，凭证走 repo secrets） | 仅 `.pi/settings.json` 声明的社区包 |

workspace 轮不走裸 `pi -p` 的原因：需要保留 workspace 域工具装配（work-items 工具、kb_search、角色目录注入）。这**不是** v3 复辟——没有 orchestrator 索引、没有 seed 二段跳、没有 RUNS.jsonl，AgentSession 跑完一轮自然销毁。

**subagent 装配（评审决议 D10）**：daemon 轮一律使用 pi-web **内置** `subagent` 扩展（rpc-manager 全局挂载现状不变，phase 2 才整体切换社区包）；`@henryqw/pi-subagent` 等**只在 GitHub Actions 场景**经 `.pi/settings.json` 声明。同会话双 subagent 工具的命名冲突因此不存在，daemon 无头环境下 `.pi/settings.json` 自动装包所需的项目信任问题也一并规避。

### 单轮生命周期

```
心跳到点
  → 读 LOOP.md（cron/level/max_minutes）
  → 起轮进程（daemon 会话 / pi -p）
  → 开场合同：读 constraints → budget → ledger → STATE.md
  → /skill:<pattern> 执行（L1 只写；L2 worktree+maker/checker+draft 分支；L3 同 L2 但可自动合并白名单路径）
  → 更新 STATE.md + 追加 ledger
  → 进程退出（超时由 spawner/Actions 强制 SIGTERM）
  → 【仅 daemon 场景】spawner 事后钩子：回填 conversations 链接 +
     无待决 gate 则自动归档轮会话（见 §9 spawner）
```

无状态恢复问题：轮进程崩溃 → 下轮冷启动读 STATE.md 自然接续（v3 的双开 guard/僵尸收割问题在"每轮短进程"模型下天然消失；孤儿 bash 树问题仅 L2+ 存在，由 constraints 的 worktree 纪律 + 超时强杀兜底）。

### 为什么不用社区 pi-loop 扩展做心跳

已验证（2026-09 调研）：`@bramburn/pi-loop`、`@hank-warren/pi-loop` 均为**进程内调度**——触发器随 pi 进程存活（`/loop-resume` 的存在即证明），适合"开着 pi 时的交互循环"，不适合无人值守。`@hank-warren/pi-loop` 的持久 ledger / 无进展断路器 / 证据门完成理念与 kit 断路器同源，列为 SKILL.md 编写参考。

## 6. 扩展选型与审计

| 能力 | 首选候选 | 备选 | 兜底 |
|---|---|---|---|
| Subagent（maker/checker） | `@henryqw/pi-subagent` v6.1.0（single/parallel/chain + role，API 形态与 pi-web 现有最接近） | `@smoose/pi-subagent`（极简）、`@eggmasonvalue/pi-subagent`（thin primitive） | 抽 pi-web `lib/subagent/` 成独立 pi package |
| 权限/硬规则 | `@gotgenes/pi-permission-system` | 自写薄 extension（工具拦截 API） | constraints 软约束（phase 1 默认） |
| MCP（可选，非必需） | `pi-mcp-adapter`（1354★） | `pi-web-access`（网页检索） | 不用（CLI + gh 够用） |

**审计清单**（第一阶段第一周完成，审计不过走备选/兜底）：

1. 源码通读（官方警告：Pi packages 拥有完整系统权限）；
2. 依赖链审查——`@henryqw/pi-subagent` 依赖 `@henryqw/pi-multi-codex`（Codex 向伴生包），确认其在我们 provider 栈下是否必要、可否裁剪；
3. 集成点核对：自定义角色发现（是否读 `.pi/agents/*.md`）、parallel 上限、per-child model 覆盖、超时语义；
4. 观测钩子：子会话 id 是否有可发现途径（pi-web sidebar 隐藏/打开子会话依赖 `subagent-children.txt` 模式）——无则提 PR 或薄适配层（phase 2 问题，kit 场景先不管）；
5. 版本 pin 进 `.pi/settings.json`。

## 7. 安全与预算纪律（L1/L2/L3）

- **L1 report-only**：只读 + 写 STATE.md，不动代码不 git 操作。新 loop 强制从 L1 起步。
- **L2 assisted**：可改代码，硬规则：worktree 隔离 → maker/checker 分离（checker 不得由 maker 同角色兼任）→ 只开 draft 分支/PR，人类合并。
- **L3 unattended**：解锁条件 = L2 连续 7 天 verifier 通过、零 escalated 误判；即使 L3 也只允许自动合并 gate.yaml 式白名单路径（docs/测试）。
- **晋级**：人类手动改 LOOP.md 的 level——晋级条件与"agent 禁自改宪法"写进 SKILL.md 硬条款。
- **Kill switch**（评审决议 D12）：`loops/<name>/PAUSED` 标记文件（单 loop 暂停）或根目录 `loop-pause-all`（全停）存在 → spawner 识别并跳过起轮；已在跑的轮读到标记立即收尾退出。标记文件与 kit"文件即声明"习惯一致（存在即生效，机器解析无歧义）。
- **Post-run critique**：每轮 STATE.md 复盘节必填（误报/重复项/下轮一个调整）——喂 workspace 的 LEARN 机制。

## 8. workspace-c 迁移路径

现状：v3 形态（thin LOOP.md + `.agents/skills/dev-loop/SKILL.md` + 五角色 + LEARN 冻结 + `LEARN/` + `loop.active_session` 双开戳）。

迁移（一次性 PR，先在演练分支走通一轮再上）：

1. `.agents/skills/dev-loop/SKILL.md` 基本保留（已是合同形态），改造点：
   - 选择与执行合并为一轮（删"选择轮/执行轮"二分；开场三重判断保留）；
   - gate 里程碑（`loop.gate`）调用方式核对：工作项域工具经 daemon 装配依然可用，`workspace_record_milestone` 保留原调用形态，仅在验收时核对装配路径；
   - 双开 guard / `loop.active_session` 戳删除——由"每轮短进程 + STATE.md 记录当前持有项"替代。
2. `loops/dev-loop/LOOP.md` 换 kit 格式（cron/level=L2 起步——迁移例外：dev-loop 已在 v3 真实运行多月，视为已过 L1 验证；全新 loop 一律 L1 起步/max_minutes=45）；
3. 新增 STATE.md（从现有 LEARN/ 与最近 run 记录初始化 Watch List）、loop-constraints.md（从 workspace AGENTS.md 的硬不变量抽取）、loop-budget.md、loop-ledger.json；
4. `.pi/agents/` 五角色保留，subagent 工具**沿用 pi-web 内置扩展**（daemon 全局挂载不变，见 §5 评审决议 D10）；workspace-c 的 `.pi/settings.json` **不**声明 subagent 包；
5. 角色注入：v3 的 `extraAgentDirs` 机制保留（daemon 装配路径不变），GitHub repo 场景靠 `.pi/agents/` 原生发现；
6. 迁移当天禅道 importer 无感（独立 DaemonJob，不动）；
7. 旧 `loop.yaml` / `RUNS.jsonl` 原地保留不再读取（git 历史即审计），不迁移不删除。

## 9. pi-web 拆除清单

**删**：
- `lib/loop/`：`runtime.ts`、`pi-execution.ts`、`seed.ts`、`store.ts`、`session-tags.ts`（orchestrator 隐藏）；
  `process-cleanup.ts` 的跨 workspace 孤儿扫描删除——但**进程组强杀逻辑收窄保留**：并入 spawner 的超时路径（对轮进程组 SIGTERM→SIGKILL），§10 风险表所指即此
- `lib/loop/scheduler.ts` → 重写为极简 spawner（保留 DaemonJob 接口，见下）
- `lib/loop/authoring.ts`、`http.ts` 中 loop 引擎路由（trigger/run/abort/seed）及 `app/api/workspaces/[id]/loop/**` 路由文件；`lib/loop/` 剩余的 `types.ts`、`web.ts`、`workspace-resolver.ts`、全部 `*.test.mjs` 一并删除
- `lib/daemon/client.ts` 的 loop 管理方法（listLoops/trigger/abort/seedExecution 等）及对 `lib/loop/types.ts` 的类型导入
- **run-contract 链路改造（评审决议 D11）**：工作项「开始对话/收养续跑」从代理 daemon seed 路由改为**客户端预填**——新建会话并在 composer 预填 `/skill:<loop> 执行 <KEY>`（不自动发送，符合"pi 不预建会话"原则）；`run-contract` 路由与 daemon `/v1/.../seed` 删除
- UI：ActivityBar 的 Loop 图标与视图（`ACTIVITY_VIEW_ORDER`）、`LoopConfig` 组件、WorkspaceOverview 的 Loop 区块、WorkspaceSidebar loop-list、MobileShell 的 `TAB_ORDER`/`TAB_CAPABILITY` loop 项、`useAppShellState` 的 loop 轮询/handleLoopTriggered 等 handler、HomeLanding/WorkspaceSidebar 的 `loopOrchestrator` tag 过滤（`session-tags.ts` 消费点）；`lib/types.ts` 的 tag 字段（`subagentChild` 保留）
- 能力注册表：`ALL_WORKSPACE_CAPABILITIES` 与类型中移除 `loop`（读路径对存量 manifest 做剥离迁移，同 `overview` 退休先例——`loop` 进 `LEGACY_READ_CAPABILITIES`，避免存量 manifest 解析失败）
- manifest 实际核对：schema 无 loop 专属字段，仅 `capabilities` 含 `loop`（随上条剥离）与 `skills` 可能含 loop skill 名（合法 skill，保留）
- 文档：pi-web 自身 `AGENTS.md` 的 Loop 章节重写为 kit/spawner 形态；`docs/dev-loop-v2-design.md`、`dev-loop-v3-design.md` 头部加"已退役"横幅指向本文档

**新增（daemon）**：
- `lib/daemon/loop-spawner.ts`（~150-200 行，含事后钩子）：DaemonJob，每 30s 扫描已注册 workspace 根的 `loops/*/LOOP.md`（frontmatter：cron/level/max_minutes），分钟槽去重复用 `cronMatches`；到点且非 paused（`PAUSED` / `loop-pause-all`）→ `startRpcSession` 起一次性会话（一次性 key + 创建超时等现有机制复用）跑开场合同，`max_minutes` 超时 → `destroy()` + 按该 workspace cwd 收窄收割孤儿进程树。RUNS 记录 = STATE.md + workspace git log，不建新索引。
  **事后钩子（评审决议 D9，gate 可发现性 + 会话列表防污染）**：轮结束后 spawner 扫该 workspace 的 `requirements/*/bugs/*/events.jsonl`，把 `conversationId === 轮会话 id` 的事件对应的工作项回填 `conversations` 链接（待决 gate 的轮会话从工作项详情「继续对话」可达）；本轮**无** `loop.gate` 里程碑 → 自动 `archiveSession()` 归档轮会话（有事在身的留在会话列表）。全部复用现有服务（work-items service / session-archive），不新建状态。

> 修订（2026-08-30，见 docs/pi-loop-host-design.md）：spawner 改用 `pi-loop/` 包内统一 fire 序列（protocol/cron/due/round-lock/contract/reap），删分钟槽 `emittedSlots` 与 `busyWorkspaces`，`.lastrun` + per-loop 锁判定。

**留**：daemon 本体、DaemonJob registry、work-items 全套、importer、`lib/subagent/`（phase 2 切换）、`authoring` 的文件写入逻辑可并入模板库。

**观测**：phase 1 无 web UI（STATE.md 人类可读 + workspace git log）；STATE.md viewer 作为 pi-web 后续可选增强，不在本阶段。

## 10. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 社区 subagent 包审计不过（依赖链/角色发现缺失） | 兜底：抽 `lib/subagent/` 成包（原方案），kit 依赖我们自己的包，phase 2 pi-web 同样切它 |
| 协议纪律 vs 机器强制：模型可能违反 budget/constraints | 宪法文件硬条款 + 复盘节自检；phase 2 daemon 加 budget 硬校验（读 ledger 对账） |
| 观测退化（无 Loop 视图/run 卡片） | STATE.md + git log；接受为代价，viewer 后补；轮会话噪音由 spawner 自动归档钩子（D9）收敛 |
| 选择/执行合并后，无事可做的 tick 也付开场三重判断成本 | cron 粒度 ≥30min 起步 + `loop-budget.md` 每日轮数帽；kit README 写调参指引 |
| 轮会话 running 中静默构建 >20min 被心跳监视器 STALL_KILL_MS 误杀 | 与 v3 相同暴露，接受；`max_minutes` 与 STALL_KILL_MS 的关系写入 spawner 注释（不引入豁免机制） |
| workspace-c 迁移当天生产中断 | 演练分支先走一轮完整 REQ 流程；迁移 PR 与 spawner 上线同一提交 |
| `pi -p` 在 Actions 的项目信任/凭证配置 | `--approve` 已验证支持；provider key 走 repo secrets，文档给出模板 |
| L2+ 孤儿 bash 树（超时强杀后） | constraints 强制 worktree；超时 SIGTERM→SIGKILL 由 spawner 对整进程组执行（复用 v3 收割经验，仅保留这一个收割点） |

开放问题（剩余，实现计划阶段裁决）：
1. ~~spawner 与 LoopHostScheduler 注册关系~~ 已裁决：过渡期 env 旗子 `PI_LOOP_KIT=1` 并存（新 job id），拆除 PR 中同槽位替换；
2. STATE.md 并发写（同 workspace 多 loop 并行轮）——phase 1 约束单 workspace 串行；
3. ledger 的 token 统计来源——phase 1 模型自报（STATE `[BUDGET]`），phase 2 spawner 从轮会话 usage 事件对账回写 ledger（权威计数，见 D13）。

## 11. 验收标准

1. **新 workspace 冒烟**：创建 → 复制 kit 模板 → 下一心跳自动起轮，STATE.md 出现首轮记录，第二轮接续；
   > ✅ 2026-08-29 已验证（feature/loop-kit 分支）：scratch workspace（kit-smoke，L1，cron `* * * * *`）两轮接续（16:48/16:49），STATE.md 记 `Last run · outcome: report-only`，两轮会话均被 D9 钩子自动归档（命名 `smoke · <slot>`），`loop-pause-all` 后两分钟槽零起轮，无旗子对照 130s 零起轮、v3 无扰。
2. **workspace-c 全流程**：禅道 REQ 进来 → 心跳轮拾取 → maker/checker → gate 以 events.jsonl 里程碑 + STATE.md 形式问人 → 人工答复继续 → 完成；全程无 orchestrator session、无 RUNS.jsonl；
   > ✅ 2026-08-29 用户演练通过，workspace-c main 已翻转 @6f63cd2（详见 `docs/pi-loop-kit-rollout.md`）；
3. **GitHub demo 仓库**：Actions cron + `pi -p` + 社区 subagent 包跑通一个 triage 循环（L1）；
   > ☐ 带外，未做——见 `docs/pi-loop-kit-rollout.md`；
4. **拆除完成**：pi-web `npm test` / typecheck 全绿；loop 入口 UI 消失；存量 workspace manifest 的 `loop` 能力被读路径剥离；
   > ✅ 2026-08-30 develop 已验证（feature/loop-kit-teardown 并回后）：npm test 340 绿、typecheck 绿，loop 入口 UI 消失，存量 manifest 的 `loop` 能力读路径剥离；
5. **宪法不可变验证**：构造诱导性任务，确认 agent 拒绝自改 budget/level/constraints（SKILL.md 硬条款生效）。
   > ☐ 未做，可在任意活轮顺手验证——见 `docs/pi-loop-kit-rollout.md`。

## 已确认决策（对话记录）

| # | 决策 |
|---|---|
| D1 | 痛点 A/B/C 全有 → architectural 级重构 |
| D2 | 产出物按开源形态设计、自用先行验证（C） |
| D3 | v3 直接推翻，workspace-c 同步迁移（C） |
| D4 | 方案一：文件协议 + GitHub Actions（workspace 场景 daemon spawner），吸收社区扩展做底座 |
| D5 | 文件即声明：`loops/*/LOOP.md` 存在即 loop，无能力开关/中央注册 |
| D6 | pi-web 是壳：通用 agent 能力下沉 pi 生态（社区包），域工具（work-items/kb/importer）保留 |
| D7 | 分期：kit + 拆 v3 先行；pi-web subagent 切换与开源发布第二阶段 |
| D8 | 社区 pi-loop 扩展为进程内调度（已验证），不做无人值守心跳 |

### 评审决议（2026-09 评审会）

| # | 决策 |
|---|---|
| D9 | spawner 事后钩子：扫 events.jsonl 的 conversationId 回填工作项 conversations + 本轮无待决 `loop.gate` 里程碑则自动归档轮会话（解决 gate 可发现性与会话列表污染） |
| D10 | phase 1 daemon 轮一律内置 subagent（rpc-manager 全局挂载不变）；社区包仅 GitHub Actions 场景经 `.pi/settings.json` 声明 |
| D11 | run-contract 改客户端预填 `/skill:<loop> 执行 <KEY>`（不自动发送），删 daemon seed 路由 |
| D12 | 暂停用 `loops/<name>/PAUSED` 标记文件 + 根级 `loop-pause-all`（文件即声明，机器可解析；不用 STATE.md 字段） |
| D13 | constraints/budget/ledger 为根级共享（budget 是全 workspace 总帽），STATE `[BUDGET]` 仅本轮视角自报；phase 2 spawner 对账 |
| D14 | 拆除清单补全：`lib/loop/` 全部残留文件与测试、daemon client loop 方法、MobileShell/useAppShellState/HomeLanding 触点、run-contract 改造、AGENTS.md 重写、旧版设计文档退役横幅 |

> 修订（2026-08-30，见 docs/pi-loop-host-design.md）D13：ledger 改 per-loop（`loops/<name>/loop-ledger.json`）；constraints/budget 维持根共享（budget 仍是全 workspace 总帽）。
