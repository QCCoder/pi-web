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
automations/
  jobs/<name>.yaml        schedule + 引用哪个模版 + watchlist + push + produce
  templates/<name>.md     自然语言"做什么"（= 调研模版/提示词）+ 期望产出
  watchlist.md            用户随时改的自选股
```
- job 触发 = 开一个**独立 automation session**（走 rpc-manager，**复用唯一 session owner**，绝不另起进程开 session）→ 按 template 跑（取数 + 总结）→ 出产物 → 调 feishu-transport 推送。
- automation session 与聊天 session 隔离：推送是单向的；用户回复进聊天 session。
- 起步 job：每日盘后简报（行情+涨跌+成交+一句话点评 → 飞书卡片）。
- run 历史：每次跑记录（时间、成功否、产物路径、错误），存本地（学 openclaw tasks/runs 思路）。

## 5. 实现进度

已完成（已提交）：
- `d495861 feat(modules): capability-gated workspace extension registry` —— `lib/workspaces/extensions.ts` + rpc-manager 改造。
- `d98c80c feat(feishu): feishu-transport module + capability toggling` —— `lib/feishu/{types,client,config,extension}.ts`、`feishu-transport` capability、`UpdateWorkspaceInput.capabilities`、`GET/PUT/DELETE /api/workspaces/[id]/feishu`。
- `3f617f1 fix(workspaces): register feishu-transport in capability registry` —— `ALL_WORKSPACE_CAPABILITIES` 之前漏登 `feishu-transport`，`parseCapabilities` 拒收、PATCH 切换会报 400；补登记后切换才真正生效。
- `9d80539 feat(feishu): feishu-transport settings panel`（**PIECE A**）—— `components/FeishuConfig.tsx`（开关 capability + 填 appId/appSecret/receiveIdType/receiveId + 测试发送）+ `POST /api/workspaces/[id]/feishu/test`，嵌入 WorkspaceManager 设置视图。
- `45bc847 / e7cf442 / b1be0f1 feat(loop): …`（**PIECE B**）—— `lib/loop/{types,schedule,store,runner,scheduler}.ts` + API 路由（`/api/workspaces/[id]/loop/jobs`、`/jobs/[name]`、`/jobs/[name]/run`、`/runs`）+ `components/LoopConfig.tsx`，详见下方「Loop 实现说明」。
- `8f64e25 test(rpc): update stale extension-preload assertion` —— 修掉 d495861 重构后遗留的红测。

### 5.1 Loop 实现说明（PIECE B 落地决策）

- **提示词内嵌在 job**：`LoopJob.prompt` 字段就是「做什么」的模版/提示词（任务描述明确该字段 = prompt/template）。v1 不单设 `automations/templates/` 目录，后续需要复用模版时再加。
- **推送由 runner 服务端执行**：开 automation session 跑提示词 → 抓 `get_last_assistant_text` 作为产物 → 由 runner 用 `FeishuClient` 推送（card/text）。确定性、可记录 push 结果、可控制目标与格式；提示词里要求 agent **不要**自己调 feishu 工具（避免双推）。
- **调度器在 pi-web 进程内**：`getLoopScheduler()` 是 globalThis 单例（抗 hot-reload），60s tick；经 `instrumentation.ts` 在 server 启动时拉起（跳过 `next build`，且 try/catch 不阻塞启动）。每个 job 复用 `startRpcSession` 开**独立 automation session**（唯一 session owner，绝不另起进程）。
- **同日补跑**：`isJobDue(now, schedule, lastRunAt)` 依上次 run 标记 + Asia/Shanghai 当日 HH:MM 判断；服务重启后同日错过的槽位会补跑一次，跨过上海午夜错过的槽位不补（下一槽按时跑）。
- **schedule 零依赖纯函数**：CST 固定 UTC+8、无夏令时，固定偏移换算；配 `lib/loop/schedule.test.mjs`（node:test，9 例）。
- **loop 是后台服务**，**不**登记进 `WORKSPACE_EXTENSION_FACTORIES`；`loop` capability 已加入 `WorkspaceCapability` + registry。
- **job/run 不自动 git commit**（避免每次调度的提交噪音）；runs 走 append-only JSONL（`automations/runs/<name>.jsonl`）。
- **手动触发** `POST .../jobs/[name]/run` 返回 202，run 脱离请求生命周期，结果落 runs 历史；UI 触发后短轮询拉历史。
- **automation session 可见**：它们是真实 session（独立 .jsonl），会出现在会话列表里便于复查；与聊天 session「隔离」指推送单向、用户回复进聊天 session。

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
