# 股票工作区模板 — 设计与实现说明

> 实现分支：`feature/stock-workspace-modules`
> 工作区 worktree：`/Users/qiancheng/Documents/Workspace/qyinf-workspace/pi-web-worktrees/stock-workspace-modules`
> 目标：在 pi-web 里建立"模块"体系，第一个实例是股票工作区（stock-assistant）的飞书推送 + 定时 Loop。

---

## 1. 已锁定的设计决策（共识，不要再改）

| # | 决策 |
|---|---|
| 目标 | 一套可复用**积木**（模块）+ 一个把它们拼成股票工作区的**模板**；股票是第一个实例 |
| 运行时 | **pi-web 当唯一 gateway / session owner**，常驻；飞书用**长连接**模式（不需公网 URL） |
| 飞书 | 一分为二：**transport=工具**（出站、无状态）+ **channel=服务**（入站，pi-web 内置，后续做） |
| 绑定 | 1 app ↔ 1 workspace、仅单聊、1 会话 ↔ 1 长 session（compaction + `/new`） |
| Loop | pi-web **内调度器**；job 持久化 + 启动补跑；automation session 与聊天 session **隔离** |
| 模块定义 | 模块 = **capability（清单开关）+ extension（工具）/服务 + 配置面板** |
| 模板机制 | 数据驱动模板注册表 + "从模板新建" UI + 生成器（后续阶段） |

## 2. 分层架构

```
┌─ 模板层 Template        stock-research（数据化定义，后续阶段）
├─ 模块层 Modules         每个模块 = capability + extension/服务 + 配置面板
│   ├─ feishu-transport   工具：发消息/卡片/文件（出站，无状态）   [后端已做]
│   ├─ feishu-channel     服务：入站长连接监听 + chat↔session 绑定  [后续阶段]
│   ├─ loop               服务：pi-web 内调度器 + job 持久化 + 补跑 + run 历史  [待做]
│   ├─ work-management    能力开关（Work Items）                    [已解耦]
│   └─ git-changes        能力开关（差异跟踪）                      [待解耦]
├─ 领域 Skill             stock-* 7 个（已就绪，全局 ~/.pi/agent/skills/，自包含）
└─ 运行时 Runtime         pi-web（唯一 session owner，常驻）+ 飞书长连接
```

## 3. 模块挂载机制（已实现）

- **唯一挂载点**：`lib/workspaces/extensions.ts` 的 `buildWorkspaceExtensions(manifest, path)`。
- rpc-manager（`lib/rpc-manager.ts` ~L1170）调用它，按 `effectiveCapabilities(manifest)` 过滤挂载。
- 新增工具模块步骤：① 在 `WorkspaceCapability`（`lib/workspaces/types.ts`）加 capability；② 写 InlineExtension factory（参考 `lib/work-items/extension.ts`、`lib/feishu/extension.ts`）；③ 在 `WORKSPACE_EXTENSION_FACTORIES` 注册；④ 加配置面板。
- 模块开关 = 改 workspace manifest 的 capabilities（`PATCH /api/workspaces/[id] {capabilities:[...]}`，已支持）。

## 4. Loop 任务模型（待实现）

```
loops/<loop-id>/
  loop.yaml               触发源 + autonomy + enabled
  LOOP.md                 怎么做 + 怎么验 + Gate + Improve 边界
  STATE.md                下轮需要的已验证状态
  RUNS.jsonl              append-only Round 状态与证据
  agents/                 可选的任务专用 Worker 指令
  audit/                  人工审计与改进建议
```
- `pi-loop` 独立进程接受 cron、手动、消息和 webhook Trigger，创建一个可见的 Pi Orchestrator Conversation。
- AI 先读取 Loop 契约并推断 Maker/Checker/Gate 结构，创建者确认一次后才在同一主会话执行。
- Maker 与 Checker 是隔离的临时 Worker，不形成需要管理的持久子会话。
- 每轮状态变化追加到 `RUNS.jsonl`；执行成功与业务 verdict（changed/unchanged/unknown）分开记录。

## 5. 实现进度

已完成（已提交）：
- `d495861 feat(modules): capability-gated workspace extension registry` —— `lib/workspaces/extensions.ts` + rpc-manager 改造。
- `d98c80c feat(feishu): feishu-transport module + capability toggling` —— `lib/feishu/{types,client,config,extension}.ts`、`feishu-transport` capability、`UpdateWorkspaceInput.capabilities`、`GET/PUT/DELETE /api/workspaces/[id]/feishu`。
- `3f617f1 fix(workspaces): register feishu-transport in capability registry` —— `ALL_WORKSPACE_CAPABILITIES` 之前漏登 `feishu-transport`，`parseCapabilities` 拒收、PATCH 切换会报 400；补登记后切换才真正生效。
- `9d80539 feat(feishu): feishu-transport settings panel`（**PIECE A**）—— `components/FeishuConfig.tsx`（开关 capability + 填 appId/appSecret/receiveIdType/receiveId + 测试发送）+ `POST /api/workspaces/[id]/feishu/test`，嵌入 WorkspaceManager 设置视图。
- `45bc847 / e7cf442 / b1be0f1 feat(loop): …`（历史实验）—— 进程内 job/scheduler 原型，已由下面的通用 Loop Runtime 取代，不保留数据或 API 兼容。
- `8f64e25 test(rpc): update stale extension-preload assertion` —— 修掉 d495861 重构后遗留的红测。

### 5.1 通用 Loop Runtime 落地决策

- **Workspace 文件是权威来源**：每个任务独占 `loops/<loop-id>/`，Host registry 可从目录重建。
- **深接口**：所有 Adapter 只依赖 `listLoops`、`trigger`、`getRun`、`answerGate`；任务领域内容不进入 Runtime。
- **独立 Host**：timer、去重和派发由 `pi-loop` 拥有，Pi Web 仅代理管理 API；Pi extension factory 不启动 timer。
- **统一触发**：cron/manual/message/webhook 使用同一个 `TriggerCommand` 和稳定 `eventId`。
- **Maker/Checker 分离**：每个产出步骤必须有独立 verifier；人 Gate 通过 `waiting_for_gate` 暂停同一 Pi 主会话。
- **渐进自治**：L1/L2 不自动改写规则；Improve 把真实证据写入 `audit/`，由 Loop Audit 决定规则修改和 L1→L2→L3 晋级。
- 完整契约与启动方式见 `docs/loop-runtime.md`。

待做（按顺序）：
1. **feishu-channel 入站**（后续阶段）：长连接客户端 + chat↔session 绑定 + 入站路由（复用 rpc-manager）+ `/new`。
2. **模板系统 + 解耦 work-management/git-changes**（后续阶段）。

## 6. 编码约定（必读，来自 pi-web AGENTS.md）

- 类型检查：`node_modules/.bin/tsc --noEmit`
- Lint：`npm run lint`
- **绝对不要跑 `next build`**（会污染 .next、搞坏 dev）。
- dev：`npm run dev`（端口 30141）。
- worktree 的 `node_modules` 是从主仓库 symlink 来的，够用。
- 工具模块一律走 InlineExtension 模式（见 `lib/work-items/extension.ts`、`lib/feishu/extension.ts`）。
- 每个 capability 必须在 `WorkspaceCapability` union 里登记；`parseCapabilities` 会拒绝未知值。
- 配置面板：参考 `components/{ModelsConfig,PluginsConfig,SkillsConfig}.tsx` 的 modal 模式，按 capability 条件渲染。
- 提交风格：conventional commits（`feat(loop): ...`），每个自洽的改动一个提交，提交前过 tsc + lint。

## 7. 需要用户后续提供（不挡实现，挡真实运行）

- 真实自选股 + 盯哪几个市场（A股 15:00 / 港股 16:00 / 美股盘前盘后，"盘后"要拆 job）。
- 想要的定时任务和时间点。
- 飞书 app 凭证：可沿用 openclaw 那个 app（appId `cli_aa828c97da309cd3`），**appSecret 用户自己填进 UI，不要写进代码/文档**。
- pi-web 常驻部署位置（本机 / 服务器 / docker）。
