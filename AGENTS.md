# AGENTS.md — AI 开发工作规则

Pi Web：[pi coding agent](https://github.com/earendil-works/pi-coding-agent) 的 Web UI（Next.js 单进程 = 会话宿主，其上叠加 Workspace 子系统：工作区/能力/仓库/工作项/交付流/loops）。

**项目介绍与架构总览读 [`knowledge/architecture.md`](./knowledge/architecture.md)**（人类入口 = [`README.md`](./README.md)）。本文只放**干活必须遵守的规则**与**细节去哪找**。

## 开发命令

```bash
npm run dev                        # http://127.0.0.1:30141 —— Next.js server 即会话宿主（单进程）
node_modules/.bin/tsc --noEmit     # typecheck
npm run lint
npm test                           # node:test，lib/**/*.test.mjs
```

- **Never run `next build` during dev** —— 污染 `.next/`、弄坏 `npm run dev`；构建留给 release。
- 可选 `node scripts/adopt-pi-home.mjs`：把 `~/.pi/` 数据家搬进 `<repo>/.pi/`（`.pi/agent` + `.pi/workspaces` 有密钥，gitignored、tsc/eslint/git-discovery 排除；细节 `knowledge/reference/session-host.md`）。

## 硬规则

### 通用

- globalThis 单例（session 注册表 / start-locks / role-grants）：HMR/jiti 双载必须共享同一实例——Map 分裂会让授予与校验落在两个登记簿，身份门全瞎。
- 高度链用 `--app-vh` 的 @supports 分层写法，**绝不直写** `height: var(--app-height, 100dvh)`（老内核里 var fallback 在计算值阶段整体失效）——键盘适配全量见 `knowledge/reference/ui-shell.md`。
- 主题 CSS 变量（`app/globals.css`）：`--bg --bg-panel --bg-hover --bg-selected --border --text --text-muted --text-dim --accent --user-bg --tool-bg --font-mono`。
- 手机端（<768px）导航走统一原语，禁止各页面自绘：页头只有 MobilePageTitle（tab 根）/ MobileNavBar（推入页）两形态（聊天页 ChatToolbar 唯一特例）；工作区模块入口（文件/工作项/知识库/Loops/工作区设置）唯一出处 = `workspaceModuleEntries`（`components/shell/workspace-modules.tsx`），不得内联图标+门控；推入栈非空 = 隐藏底部 tab 栏（唯一规则，设置子页 settings-sub 也在栈里）——细节见 `knowledge/reference/ui-shell.md`「移动端导航」。

### 工作区（Workspace）

- `withWorkspaceWriteLock` 双层锁**不可重入**；锁内路径取 key 计数/查重必须走 `*Unlocked` 变体。
- `ALL_WORKSPACE_CAPABILITIES`（`lib/workspaces/service.ts`）是能力唯一合法值表；`manifest.capabilities` 必填、直读（`effectiveCapabilities` 不得复活）。新增可开关模块三步：值加注册表+类型 → 加 extension factory（`lib/workspaces/extensions.ts`）→ 加设置 UI 面板。
- 工作区 AGENTS.md 被 pi **逐字**注入 system prompt（不展开任何引用）；managed segments 的标记被用户删掉则静默停止同步、**永不重建**。delivery managed 块（`lib/workspaces/delivery-managed.ts`）与 repositories 块同机制：有标记才改写；配置保存 / init 成功后同步，失败只记日志、不挡操作。
- Skill **不区分工作区**（2026-10 拆除 manifest.skills 白名单 + skillsOverride）：生效面 = 全局 frontmatter 开关 `disable-model-invocation`（停用 = 从模型视野抹掉）+ 安装位置（global/project，安装位置即作用域）；manifest **不得复活 skills 字段**。

### 工作项 / 交付流

- `events.jsonl` **只追加**，永不重写；更新一律带 `expectedRevision` 乐观并发。
- 带 `conversationId` 的事件/更新会自动把会话合并进 `item.conversations`——调用方只传 conversationId，**不传全量列表**。
- managed（delivery 块）项的 phase/status 只走流程动作：generic PATCH 改 = 400；`released` 基线冻结，unblock 恢复 `done`。
- confirm-design / record-verification / record-acceptance / record-release 等人工动作**刻意不做 LLM 工具**——确认、验收、放行与发布登记是人的手。
- delivery 工具参数**禁止 union/any-of schema**（该 pi SDK 调用侧解析不工作，真 LLM 会话实测，测试钉死）。
- `delivery_run_check` 之外的检查结果（LLM 自述 / bash 自跑）**不构成证据**。
- verifier 已退役（legacy 记录永可读）：checks 由引擎 **system 步**执行——claim `role: "system"` 占槽，`delivery.verification` 的 `actor: "system"` 记录是唯一机器证据；reviewer 的 `delivery_run_check` 只是评审佐证。
- reviewer 裁定（pass / rework，先审后跑 `stages.review.enabled` 缺省关）与 checks 结果**不计失败预算**；checks unverified → `blocked`，人 unblock 才再次 due（**不自动重试**）。
- checks 启动失败（claim 写入前抛错，如候选 sha 不可解析）落 `delivery.checks_start_failed` 事件并进 attention blocked 类（每连续失败串一条，不改重试语义）。
- integrate 集成段（`stages.integrate.enabled` + command）是 checks 步的**延伸段**：checks 全过后在同一候选 checkout 内逐仓执行（`{repositoryId}`/`{branch}` 占位符，单仓 10 分钟上限）；任一仓失败 = `blocked`（同 unverified：不写 verification、不进失败预算、unblock 后**整回合重跑**）。integrate 仅对后续新的 checks 回合生效——已带当前 digest verification 的项不会补跑集成（候选变化才会）。
- acceptance 验收门（`stages.acceptance.enabled`）只卡 `record-release`——开启时无当前候选摘要的 `delivery.acceptance` 记录即拒，与 release-preparer 起草**并行**（不互等）；`record-acceptance` 刻意不做 LLM 工具（验收不通过走 rework 重开下游）。
- confirm-design 归一 `status: "open"`——人工 rework target=design 后的项确认设计即回队列，可重新被 LLM 角色领取（领取谓词只要 open）。
- 返工过渡唯一实现 `reworkTransition`（`lib/work-items/delivery.ts`）——禁止出现第二份「清下游证据」的代码。
- ask 是一等回合结果：`delivery_ask_human` 清 claim、phase 不变、不计失败预算；答复走人工动作 `answer-clarification`（刻意不做 LLM 工具）；工具面恰六件（list / claim / submit / fail / ask / run_check），run_check 身份门 = reviewer。
- attention 队列是派生视图：催办/泊车只落事件（`delivery.nudged` / `delivery.parked`）+ 既有 automation-paused，不加运行态文件；年龄线 `attention.{nudgeAfterDays,parkAfterDays}`。
- 角色剧本住工作区 `.pi/agents/<role>.md`（缺省同名）；lib 只持不变式合同 `AGENT_INVARIANT_CONTRACT`（全文钉于终局 spec §4.3.1，改文先改 spec）与剧本模板——lib 的装配文本内禁写干活指令与工作区专属事实（模板除外：模板本就是要播进工作区的干活内容）。
- 剧本播种每角色只播一次（记录 `.pi/delivery-seeded.json`）：从未播过且缺文件才写、永不改写、删了不重建；播种失败不影响配置保存（响应 `seeded: null` + `seedingError`）。
- 交付初始化（`POST …/delivery/init`）**只补缺、只建议**：delivery.yaml 缺失才写默认（`enabled` 恒 false，启用是人的手）、缺剧本才播种、from 目录的文件缺才复制；探测与 from 的检查命令只作草稿进响应 `suggestedChecks`——不执行、不自动落盘。就绪清单（`GET …/delivery/readiness`，带 `currentTemplateVersion`）是常驻只读投影，**非门禁**。
- 模板另存（`POST …/delivery/roles/[role]/template`）把当前内置模板写 `<ws>/.pi/agents/<role>.template.md`：写即全新（存在 409），**永不覆盖** `<role>.md`、永不碰播种记录。
- `.pi/agents` profile 经 AgentsConfig 保存走 `content_hash` 乐观并发：显式带 `expectedContentHash` 才设防（409 = 外部改动过，重载再存），不带 = 不设防。AgentsConfig 交付感知（不变式锁定段 / 组合预览）只在宿主显式传 `workspaceId` 时启用——不发明「路径→id」查找。
- `branches` 分支登记只存分支名（每仓库至多一条）；是否合入 develop/master 是**实时派生**（`/git` 端点现算，30s TTL）——永不落盘、永不进 events。

### Loop

- agent **禁改禁删**：`.lastrun`、`.round.lock`、`PAUSED`、LOOP.md 的 level/cron。
- loop = 定时巡逻（cron + max_minutes + 入口，跑完即走、无状态）；交付执行一律走 delivery 引擎——loop 会话无 role grant，`delivery_*` 工具不可用；`item.loop` 仅为巡逻参考，不路由流水线。
- 定时轮时长治理两段：`stall_minutes`（缺省 15）= 轮会话**整棵树**连续静默即判死（子代理活性经 `AgentSessionWrapper.touchActivity` 沿 `parentSessionId` 上传，父会话阻塞在 `get_subagent_result {wait}` 不算静默）；`max_minutes` = 硬天花板（成本保险，编排型 loop 放到 180–240）。宿主僵尸监视器（`heartbeat.ts` 20min）仍是全局兜底，实际停滞阈值取两者之小；手动轮两者都不管（人在场）。

### 会话宿主

- `destroy()` 会中止在飞 prompt；fork 之后必须立即销毁旧 wrapper（fork 原地改写内部状态）。
- 会话创建必须可中止（`StartSessionOptions.signal` + `raceAbort`）；新会话 start-lock key 是一次性 `__new__<uuid>`，**绝不为空串**。
- SSE 慢客户端 stall 判定是 drain-aware（只看未排水字节），不是累计流量。
- routes 不直接 import `lib/session-host/registry.ts`——一律经 facade（错误→HTTP 映射与冷 revive 语义归 facade 所有）。

## 细节去哪找

| 文档 | 何时读 |
|---|---|
| `knowledge/architecture.md` | 项目介绍与架构总览（子系统职责、数据流、目录速览） |
| `knowledge/reference/session-host.md` | 改会话宿主 / SSE / 会话索引 / 生命周期与 fork / 认证·插件·技能 / 会话文件格式 |
| `knowledge/reference/workspace.md` | 改 manifest / capability / 仓库扫描登记 / 索引 v2 / OKF 知识库 / kb_search / managed segments |
| `knowledge/reference/work-items.md` | 改工作项服务 / delivery 状态机 / 四角色自动执行 / 工作项前端 |
| `knowledge/reference/loops.md` | 改 loop 协议 / 心跳 / 恢复门禁；了解 dev Loop 模式、Learn 与 cxin 实例 |
| `knowledge/reference/ui-shell.md` | 改布局 / 导航 / 移动端 / 键盘适配 / 附件与改动文件 UI |
| `knowledge/reference/file-map.md` | 找文件、看全仓结构与逐文件注释 |
| `knowledge/designs/`（设计稿）· `knowledge/adr/`（决策记录） | 设计决策与历史；`workspace-redesign.md` §1 = 文档失同步的教训 |

> **维护规则**：改模块时，影响「干活规则/不变式」的更新本文对应小节；架构与用法的更新 `knowledge/architecture.md`；实现细节的更新对应 knowledge/reference 文档。三层都要同步。
