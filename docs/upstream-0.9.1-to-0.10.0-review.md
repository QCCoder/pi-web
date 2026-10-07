# upstream v0.9.1→v0.10.0 升级审查(review)

> 生成于 2026-10-07。本地分支 `upstream-sync/0.10.0`(基点 develop `428c6f0`,含 WIP checkpoint)。
> 范围:`6885309..upstream/main`(`fdeea87`,477 个非合并提交,对应 upstream Release v0.9.2…v0.10.0)。
> 所有 `upstream <hash>` 均指 `agegr/pi-web`;file:line 均指本分支工作树。
> 前序文档:`docs/upstream-0.8.2-to-0.9.1-review.md` / `-audit.md`。

## 0. 方法与总体结论

- **为什么不整体 `git merge upstream/main`**:试合并实测 137 个冲突文件(70 双改 / 63 双增 / 4 删改)。fork 与 upstream 已架构分叉(daemon 独占 AgentSession、web 纯代理、Workspace/loops 子系统、subagent 内置化、i18n、持久 session 索引),大量"冲突"是刻意分叉;且仓库惯例(0.8.2→0.9.1)即"审查清单 → 选择性移植 → 批次审计"。
- **审查方法**:477 个提交按子系统分 6 桶并行审查;每桶先主题聚类,代表提交 `git show` 读真实机理(不看标题望文生义),再对照 fork 工作树逐 file:line 判定。四栏+⏭️:✅ 可直接移植 / 🔧 需适配移植 / 🛡️ 本地已规避或等价 / ➖ 不适用 / ⏭️ 有意分叉不放。

| 桶 | 提交数 | ✅ | 🔧 | 🛡️ | ➖ | ⏭️ |
|---|---|---|---|---|---|---|
| A chat/流式/SSE/滚动 | 120 | 20 行 | 21 | 29 | 8 | 2 |
| B shell/文件面板/markdown | 78 | 4 | 21 | 21 | 12 | 12 |
| C subagents/terminal/plugins/skills | 58 | 30 | 15 | 5 | 4 | 4 |
| D models 配置/auth | 39 | 4 | 7 | 11 | 13 | 2 |
| E sessions/i18n/PWA | 54 | 12 | 13 | 16 | 12 | 1 |
| F core 杂项/依赖/安全 | 128 | 5 | 33 | 11 | 9 | 70 |
| **合计** | **477** | **~75 行** | **~110 行** | **93** | **58** | **91** |

(✅/🔧 按主题行计,非提交数;⏭️ 大头是 MCP 全家族 31 提交 + release/docs/CI。)

### 跨桶五条硬结论

1. **安全双缺口(F/D/E 桶)**:`PI_WEB_PASSWORD` 经 daemon sidecar env 继承(`lib/session-daemon/sidecar.ts:48-59`)与 terminal env 复制(`lib/terminal-manager.ts:45-49`)进模型上下文/会话转录;Basic Auth 无节流;登录跳转 `lib/safe-destination.ts` 不挡 TAB 变体;文件引用授权不设防(`session-file-references-core.ts:67-72`);`/_next/image` 未认证可达。
2. **数据丢失级(D 桶)**:`readModelsConfig`(`lib/models-config-store.ts:64-73`)对 pi 可读的 models.json(BOM/注释/尾逗号)静默读空,面板下一次 Save 整稿覆盖删光 provider。
3. **SDK 依赖是分水岭(F/C 桶)**:fork 锁 `@earendil-works/*` 0.84.4,upstream 已到 1.0.0(链:0.84.1→0.84.2→0.85.1→0.87.1→1.0.0)。最有价值的 subagent 新能力(profile 按 `extensions:` 加载、预载 skills、turn-limit 边界)**硬依赖 SDK 1.0.0**(缺 `finishTurn`/`exposure`/`extensionsOverride`)。升级需三点适配:0.85 Theme 构造键(daemon PlainTextTheme)、**0.86 起 `agent.state.systemPrompt` 变 getter 禁赋值(fork `lib/daemon/rpc-manager.ts:375,1525` 两处赋值会坏)**、快照事件语义重验(前审计 🛡️ 根基)。0.87 的模型目录/compaction 修复是主要收益;0.99/1.0 变更基本全挂 MCP(fork 无落点)。
4. **fork 现存真 bug(A 桶)**:#1009 "Edit from here" 点击即切叶不可回退(`MessageView.tsx:374`,修复前形态);#700 新会话强制 toolNames 覆盖 settings.json defaultTools(`useAgentSession.ts:764`);#1008 压缩期间显示"等待模型"且压缩按钮不可达;#777 流式时 reasoning 控件整个隐藏(SDK 0.84.4 已验证支持 mid-run 改档/换模型,纯 UI 解禁)。
5. **宣称与实际不符(E 桶)**:fork 实无繁体中文(仅 en/zh-CN,`lib/i18n/registry.ts:46-47`),且键集已分叉,不能直接抄上游 zh-TW。

### 落地路线图

- **批次 1(本次执行,安全+数据丢失+一行级修复)**:见 §1 执行清单。
- **批次 2(建议顺序)**:A 桶 ✅ 组 20 项(reasoning 显示/中途改档、压缩状态、截断横幅、流式切模型/附图、超大图压缩、发送键配置)→ C 桶无 SDK 依赖 7 提交整组 cherry-pick(后台通知系列/孤儿 run/resume 拒绝/ext: 解析/单内置开关)→ D 桶 discovery/catalog 成对移植(d8f89c51→7aaeff97)→ B 桶 markdown 四小件(#976 货币数学、#971/#972 CJK autolink、#1015 换行、#1019 Safari 16.2)。
- **需要 owner 决策**:①SDK 0.84.4→1.0.0 升级(三点适配+全量回归,subagent 大件解锁的前提);②zh-TW 补齐(按自有键集翻译);③大件独立排期:enabledModels 开关体系(3100+ 行)、#1009 编辑状态机、跨窗口 SSE 单例化、#1042 SMIL→CSS。
- **版本号**:待批次 2 吸收 upstream 主要特性后再 bump `0.10.0-qcc.1`(现在 bump 会虚标)。

## 1. 批次 1 执行清单(随本 review 一并提交)

| # | upstream | 内容 | 类型 |
|---|---|---|---|
| 1 | `499aa4fb` | models.json 按 pi 语义读(BOM/注释/尾逗号)+ 不可读时禁止覆盖 | 数据丢失 |
| 2 | `5d07375`+`6ad18cd` | PI_WEB_PASSWORD 不进 daemon/terminal env | 安全 |
| 3 | `beb32a99` | Basic Auth 尝试共享全局节流 | 安全 |
| 4 | `3e1f4361` | 登录跳转挡 TAB/换行跨 origin 变体 | 安全 |
| 5 | `a3f24ea` | rpc-manager listeners mid-emit splice 丢事件(→ Set) | 正确性 |
| 6 | `31f0505` | proxy 大 body 截断守卫 | 正确性 |
| 7 | `81e5b03`(#1056) | 表格 th/td max-width 防挤压 | UI 一行 |
| 8 | `7473ac6`(#460) | `span.token.table{display:inline}` 抗 Tailwind | UI 一行 |
| 9 | `98f09d7` | DOCX 预览 sandbox 放行 same-origin(Safari) | UI 一行 |
| 10 | `e2ea7da`(#1060) | 代码块背景随主题保留(MermaidBlock 两处) | UI 一行 |

执行状态以 git log(`port(...)` 前缀)为准;全部通过 `tsc --noEmit` + `npm run lint` + `npm test`(基线 909/909 绿)。

## 2-7. 各桶明细


---
# 桶 A：chat / 流式 / SSE / 滚动 / draft — upstream 6885309..main (v0.10.0) 审查

> 生成于 2026-10-07。本地分支 `upstream-sync/0.10.0`（HEAD `428c6f0`，工作树只读）。
> 范围 `/tmp/upreview/A-chat-streaming.tsv` 的 120 个提交（merge-base 早于 v0.9.1，故含 0.9.1 之前已选择性移植过的提交）。
> 方法：主题聚类 → 代表提交 `git show` 读机理 → fork 工作树找落点。四栏+⏭️：✅ 可直接移植 / 🔧 需适配移植 / 🛡️ 本地已规避或等价 / ➖ 不适用 / ⏭️ fork 有意分叉不放。

## 桶级总结

- **本桶 120 个提交中约 22 个（18%）已随 0.8.2→0.9.1 选择性移植落地**（表末"已移植"行有 hash→本地 commit 对照），无需动作。剩下 98 个里，上游 v0.9.2–v0.10.0 的新修复有一批落在 fork 同样存在的真实缺口上（✅ 约 20 项、🔧 约 21 项），其中正确性/可用性收益最高的四件：**#777/#851 运行中 reasoning level（SDK 0.84.4 已验证支持 mid-run 生效）**、**#1008 auto-compaction 期间的状态/Stop compaction 控件**、**#1009 历史编辑"点击即切叶"不可回退（fork 是修复前的老 bug 形态）**、**#700 新会话强制 toolNames 覆盖 settings.json defaultTools**。
- **SSE/流式架构类（05db5b2/125e55d/def1478/e4fded0/6b0c6a5 等）上次 0.9.1 审计的 🛡️ 结论基本仍成立**（daemon 多监听者广播 + 全量快照 + sse-writer 1MB stall 断线），新增需动作的只有两件：web 进程 SIGTERM 不关代理 SSE（1f79174，上次 ⚠️ 待验证仍未做）与跨窗口 running-events 连接数（125e55d，fork 每 tab 最多 3 条同端点 SSE）。
- **任务重点项核对**：#1058 上下文用量刷新=🔧（fork 有 15s reconcile 兜底，缺 model 调用间即时刷新）；#777/#851=✅；#1008=✅；滚动到底/prompt anchor/宽表格=已移植或 ➖；**#826 工具卡图片、#1024 write() 可读文本不在本桶 hash 清单**（属工具视图桶），#744 apply_patch 分栏 diff 已移植（本地 76e5627）。
- 建议批次顺序：先 ✅ 组（多数是 ChatInput/ChatWindow/message-display 小 diff，合计约 1-2 天），再 🔧 组按"#1009 编辑状态机 → #700 configured 预设 → SSE 两件 → 扩展 UI 队列"排期。

## ✅ 可直接移植（建议做）

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 3f07a5f | #777 运行中 turn 显示 reasoning level | ✅ | 上游：流式时控件整个隐藏，连"当前档位"也看不见；改为只读标签 + turn 开始时采纳 runtime 实际档位（防"auto"误标）。fork 同缺口：`components/ChatInput.tsx:2498` `{!isStreaming && onThinkingLevelChange && (`；fork refreshAgentState 已回填 thinkingLevel（`hooks/useAgentSession.ts:1566`），只差采纳逻辑 + 标签 UI。 |
| d0bf6be | #851/#1022 流式中途改 reasoning level | ✅ | 上游：pi-agent-core 的 `prepareNextTurnWithContext` 每次模型请求前重读 `agent.state.thinkingLevel`，mid-run set 生效。**已验证 fork 的 SDK 0.84.4 同样如此**（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:288-310`）；daemon `set_thinking_level` 已通（`lib/daemon/rpc-manager.ts:574`，web 侧 `useAgentSession.ts:1432-1440`）。剩纯 UI diff：去 `disabled={isStreaming}`（ChatInput.tsx:2498 区）。 |
| 2e66e40 | #1008 auto-compaction 期间报告"Compacting…" | ✅ | 上游：agentPhase 发送时定一次 `waiting_model`，compaction 开始无人更新 → 显示像挂死；且压缩按钮 `{!isStreaming && onCompact}` 渲染门使 mid-turn 永不可达，只剩泛用 Stop。fork 同形态：`components/ChatWindow.tsx:77-88` phaseLabel 不看 isCompacting；`components/ChatInput.tsx:2662` 同款渲染门。新 `lib/chat-phase-label.ts` + 两处 guard 改 `(!isStreaming \|\| isCompacting)`。 |
| c844973, 342fc9a | #830/#968 输出上限截断横幅 + "去 compact"CTA | ✅ | 上游：`stopReason==="length"` 的 assistant 消息渲染黄色横幅（全花在 reasoning 上、无最终答案时看起来像挂死），#968 让 CTA 指向 compact 而非 retry。fork 完全无 stopReason 处理（grep 0 hits；`message.truncated` 是 bash 输出截断，另一码事）。SDK 0.84.4 `pi-ai` StopReason 含 `"length"`（`pi-ai/dist/types.d.ts:287`）。落点 `lib/message-display.ts` + MessageView + ChatWindow 终答分类。 |
| 0611857 | #891 subagent 完成通知不吞掉更早回复 | ✅ | 上游：后台 subagent 完成的 custom 消息不作为组锚点，导致本 turn 的既有回复被折进 process 分组。fork 的 customType `pi-web:subagent-notification` 存在（`lib/subagent-runtime.ts:593`）但 `isGroupAnchor`（`components/ChatWindow.tsx:133-136`）只认 user/compaction —— 同 bug。一行谓词扩展。 |
| 69882b9 | #941 锚点落在首页窗口外的 turn 也分组 | ✅ | 上游：详情路由默认 50 条尾窗，超长 turn 丢锚点后整个平铺。fork 同机制同 bug：tail=100 尾窗 + 渲染循环 `components/ChatWindow.tsx:957-963` 无 `idx !== 0` 分支（首段无锚直接 push 平铺）。上游修法（userIdx=-1/groupStartIdx=0）可原样套。 |
| ed840ed | 会话模型精确恢复与显示 | ✅ | 上游：加 `liveModel`（get_agent_state 的 `model` 字段）插进 currentModel 链。fork daemon get_state **已经返回** `model:{id,provider}`（`lib/daemon/rpc-manager.ts:494`），web 侧 refreshAgentState（`useAgentSession.ts:1559-1571`）没消费 —— 补一个 liveModel 分支即可。 |
| 81767f4 | 模型切换即时响应（流式期间可切） | ✅ | 上游：乐观 override + 解禁流式期切换。fork 的 override 机器已在（`useAgentSession.ts:1208-1232` handleModelChange + `currentModelOverride`，:427 已优先取）；SDK 每 turn 重读 `state.model`（同上 agent-session.js）。只差 UI 门 `components/ChatInput.tsx:2263` `disabled={isStreaming}`。 |
| 546dc5d, d5ec3bc | 内置 slash 命令流式可用 + 输入行为 | ✅ | 上游：`availableWhileStreaming` 让 /session /copy 在流式期间可用（BuiltinSlashCommand 类型化）。fork：`components/ChatInput.tsx:936` `isStreaming ? [] : BUILTIN_SLASH_COMMANDS` 一刀切。d10988d（防重复提交）已移植，这半截没跟；d5ec3bc 是同期输入微调，顺手。 |
| 5df8278 | #1001 发送键可配置（Enter / Ctrl+Enter） | ✅ | 自包含：新 `hooks/useEnterSendMode.ts` + SettingsPanel 项 + ChatInput keydown。fork 无对应物（grep 0 hits），ChatInput 键处理区未大改。 |
| fd037e4 | #884 composer 续行 Markdown 列表 | ✅ | 纯逻辑 lib（list continuation）+ Enter 处理。fork 无 `lib/markdown-list-continuation.ts`。 |
| 243016e | 流式期间允许附加图片 | ✅ | 上游解禁 attach（图随 steering/follow-up 走）。fork 仍禁：`components/ChatInput.tsx:2228` attach `disabled={isStreaming}`、`:795-801` processDroppedFiles `if (isStreaming) return`。小 diff。 |
| 9d7cd52 | #590 上传时压缩超大图片 | ✅ | fork ChatInput 无 compress/canvas/toBlob（grep 0 hits）；上游为 ChatInput 自包含 diff。 |
| 7ee7818 | #558 toast 全文展开 + hover 暂停 | ✅ | fork NoticeShelf（`components/ChatWindow.tsx:1259-1300`）已有右对齐 + 620px，但无 pre-line 全文/换行保留与 hover-pause 计时冻结；NoticeShelf 是本地小组件，diff 小。 |
| caa3bb8 | 扩展对话框出现时提示音 | ✅ | fork 声音只挂在 agent end（`components/ChatWindow.tsx:210-228` playDoneSound）；pendingUi 到达无音。复用 useAudio 加一个触发点。 |
| faccb23 | #310 enabledModels 支持 glob | ✅ | 上游：字面匹配使 `my-gateway/*` 全部消失。fork `app/api/models/route.ts:31-41` `filterByExactEnabledModels` 仅字面匹配；失配时回退全量（比上游温和：过滤被静默忽略）。加 minimatch/glob 匹配，函数 fork 未大改。 |
| 5e9b997 | #841 PDF 链接 #page= 片段 | ✅ | fork FileViewer 有 PDF（`components/FileViewer.tsx:678`）但不读 `#page=N`；需 file-links 透传 hash + FileViewer 初始页参数。 |
| f4a700d | #699 扩展对话框 prompt 渲染 markdown | ✅ | fork ExtensionDialog（ChatWindow.tsx:1330）纯文本 lines；换 MarkdownBody 渲染即可。 |
| 46b5235, fcd94bf, ed0eea9, 03dad64 | 扩展对话框微调（长标题收缩/保留换行/scroll-margin/select 可滚动） | ✅ | 四个都是 fork ExtensionDialog（`components/ChatWindow.tsx:1330` 起，基础版）上的小 diff；无架构牵连，价值中等偏低。 |
| ea8a278, 5933184 | 滚动条可抓取 + 稳定显示 | ✅ | 纯 CSS（`app/globals.css:304-321` fork 有基础 scrollbar 样式）；上游调 min-width/常显。低优先。 |

## ✅ 已随 0.9.1 升级移植（无需动作）

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 1eb5e66, d2056b6, f2d600b, 1b88ec7, dab9850, d10988d, 5173f6a | 滚到底按钮/图片预览/auto-compact 命令/@ 选择器×2/防重复提交/富文本粘贴 | ✅ | 本地：350894e、4972229、72507d7、c9b281c、eb5c1aa、590fd54、50a2d86（fork log "upstream <hash>" 引用齐备）。 |
| 585d56c, 6ac87ec, 44e595f, 0ada6c7, be428cf, abb74bf, 8aec7a1, 430fe4d | 首消息 fork/被拒提交保留/编辑恢复图片/iOS PWA/移动滚动跟随/Alt+Enter/thinking 默认展开/阅读位置 | ✅ | 本地：a0ceaca、ab7b3c6+7c9ac91+ef27c9a+d2030c4、dcca570、4551ecf、38dad8f、0049f63、b4861d4、1129395。 |
| 1cbd96f, 5f8f47b, 93633c8, 360667c, 51e0510, 64ae8d7, 5158faf | 会话搜索/侧栏窗口化/计数单调/活跃时长/turn 产出文件/Web Push/模型恢复测试 | ✅ | 本地：098f52d+a8c3088+cc03372+9faf1fa、31b0c94、0b3c8ef、474817b、0ddbbc8+cb56ca8、df3857e+83cb73d+32f07a1+2d75ad3、7031c58。 |

## 🔧 需适配移植（有价值，按 daemon 架构改写）

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 9182fdf | #1058 model 调用之间刷新 context usage | 🔧 | 上游：每条 assistant message_end 立即读一次 usage + 单调 request-id 守卫（旧读不覆盖新读、新读失败不丢旧读）。fork 现状：15s reconcile（`useAgentSession.ts:956`）+ agent_end（`lib/sse/global-agent-events.ts:268-276`）+ 切回 liveState（:624），**多工具长 turn 中途 usage 最多 15s 旧**。适配：global-agent-events 在 assistant message_end 后触发一次 daemon `/state` 拉取写 store（或 daemon 在事件流内捎带 usage）。 |
| 7303179, 94c1f5c | #1009 历史编辑只在发送时分支 + 保留草稿 | 🔧 | **fork 是上游修复前的 bug 形态**："Edit from here" 点击即 `onNavigate(prevAssistantEntryId)`（`components/MessageView.tsx:374`）——未提交编辑就持久化叶移动、无法回退；且 replaceMessage 覆盖当前草稿（`ChatWindow.tsx:234-237`，无 editEntryId 状态机）。需按 fork 架构补"编辑中"状态：发送时才 navigate/branch，取消/切走恢复草稿。 |
| 03a9f5d | #700/#936 不覆盖 settings.json defaultTools | 🔧 | fork `ensureNewSession` 每次都发 `toolNames`（`hooks/useAgentSession.ts:764`，默认 PRESET_DEFAULT）→ 新会话被钉死在硬编码四工具，settings.json/codemode 配置被静默收窄。适配：加 "configured" 预设=省略 toolNames（daemon `rpc-manager.ts:1379` 注释确认 undefined=pi 默认）；注意 fork 的 `withExtensionTools` 合并（:179-188）只在显式选预设时用。 |
| 19774b8 | #1023 运行中的会话可 fork | 🔧 | fork daemon 侧**已是上游修后语义**（仅拒运行中 `!` shell：`rpc-manager.ts:529-531`；拷贝走独立 SessionManager，源 AgentSession 不动），但：①fork 结束时无条件 `this.destroy()`（:563）会销毁运行中的源会话 —— 必须改成 running 源不销毁；②UI 全禁（`ChatWindow.tsx:934` `sessionBusy ? undefined : handleFork`）；③BranchNavigator 需加 locked 只读态。 |
| 1f79174 | #809 web SIGTERM 关闭代理 SSE，防 Next 16 drain 僵尸 | 🔧 | 上次审计 ⚠️ 待验证项，至今未做：`instrumentation.ts` 只有启动逻辑无信号处理；浏览器↔web↔daemon 的 SSE 纯管道（`app/api/agent/[id]/events/route.ts` req.signal 已贯通）在 SIGTERM 后仍算 in-flight，server.close() 无限等。适配：全局（Symbol.for/globalThis）注册代理 controller，SIGINT/SIGTERM 全断。 |
| 125e55d | 跨窗口减少 SSE 占用 | 🔧 | 上游：侧栏 running 状态从 SSE 改 2.5s 可见性门控轮询 + 会话流"prompt 结算后才关"。fork 每 tab 有多条同端点连接：`SessionSidebar.tsx:483`、`hooks/useSessionActivity.ts:114`、`components/shell/useAppShellState.ts:189` 都开 `/api/agent/running/events`。daemon 广播便宜但 web 代理连接×窗口数线性涨。适配：tab 内共享单例（或按上游改轮询；fork 已有轻量轮询先例 `app/api/sessions/version/route.ts:5-8` 注释）。 |
| 70470ca, e17d2cc | 扩展 UI 请求按 id 排队 + 断线期关闭的请求出队 | 🔧 | fork 单 dialog/单 custom panel 状态（`components/ChatWindow.tsx:774-786`）：两个并发 permission 请求互相覆盖，被藏住的永不作答挂死 run —— 上游 #70470ca 的原 bug。daemon 侧已是 Map（`rpc-manager.ts:199,871` pendingUiRequests）且重连重放；需 web 队列（FIFO + "+N more"）+ daemon connected 帧带存活请求 id 清单（对齐 e17d2cc 的 `pendingExtensionUiIds`）。 |
| b8e0b71 | SSE 投影瘦身（嵌套 tool 事件/coalesce/去 result） | 🔧 | fork daemon 对 SDK 事件原样转发（无 wire 投影层）：嵌套 tool_execution_*（parentToolCallId）全量上线、tool_execution_end 携带 result（bash 可达 1MiB）、entry_appended 不省。适配：在 daemon `serveSessionSse`/rpc-manager 出口加投影（slim start/end、丢嵌套 update、150ms per-toolCallId coalesce）。对 codemode 长脚本收益大。 |
| 9dc822e | codemode 调用渲染为脚本+其工具调用 | 🔧 | fork 无任何 codemode 渲染（grep 0 hits；codemode 设置工作在未合并分支 ba044f9 系）。事件会经 daemon 原样到达，视图可先行移植；与 b8e0b71 配套。 |
| 1333c80 | #1030 状态栏扩展命令按钮（chip:） | 🔧 | 上游：extension status 键 `chip:*` 渲染为可点按钮，点击发命令。fork `components/ExtensionStatusBar.tsx`（58 行）无该语义；需 extensionStatuses 透传 chip 键 + 命令回发通路（daemon extension command）。 |
| 2356904, 7c5f4e6 | #612 对话框可折叠 + 键盘导航 + 倒计时 | 🔧 | fork ExtensionDialog 基础版（仅 Escape：`ChatWindow.tsx:1417,1437`）。上游叠加了折叠（不挡输入/Stop）、方向键导航、服务端 deadline 展示；按 fork 对话框组件重写。 |
| 981e270 | #947/#1032 扩展对话框/自定义面板可加宽 | 🔧 | fork 自定义面板已有宽度机制（daemon `getCustomUiWidth` 读 overlayOptions.width，`rpc-manager.ts:847-861`，40-140 列钳制）；dialog 侧无 dialogSize 语义 —— 对齐上游 dialogSize（含 e2e 断言的 fit 逻辑）。 |
| c0abfc2, (f3a4ff6➖) | #698 从选中文本分支对话 | 🔧 | fork 无 quoted-branch（grep 0 hits）。功能跨 ChatInput/ChatWindow/MessageView（fork 均大改），按机理重写；上游 #855 工具栏层级修复随之（单列 ➖）。 |
| 6d7c5e0 | #636 图片发给无图像输入模型时警告 | 🔧 | fork `/api/models` 不带 input modalities（grep supportsImage 0 hits）。需模型元数据透传 + composer 可关闭警告条。 |
| b9bb1d9 | 工具执行进度显示 | 🔧 | fork agentPhase running_tools 只有 `{id,name}`（`lib/agent/agent-event-reducer.ts:197-229`），phaseLabel 无 progress（`ChatWindow.tsx:77-88`）。需从 tool_execution_update 提取进度进 phase。 |
| 556e2ec | provider/compaction 错误呈现 | 🔧 | fork 有 notice 通道（reducer prompt_error→notice：`agent-event-reducer.ts:110-115`）与 compactError 状态，但消息内联错误横幅（挂在出错 assistant 消息上）缺失；上游 message-display 的 getAssistantErrorMessage/横幅可借。 |
| 598c3c6 | #417 其他 workspace 任务完成提示音 | 🔧 | fork 声音所有权在 ChatWindow（`ChatWindow.tsx:210-228`），非活跃 workspace 的 ChatWindow 未挂载 → 不响。fork 有 workspace 体系；需把 useAudio 上移到 shell 层 + completedInBackground（`SessionSidebar.tsx:503-514`）回调。 |
| 4b95a44 | 静默 subagent 完成提醒 | 🔧 | daemon 完成通知已豁免子会话（`rpc-manager.ts:1597-1600`），但 `getRunningRpcSessionIds`（:1246-1252）不过滤 `pi-subagent-` 前缀 → 侧栏 running 广播含子会话，completedInBackground 仍为其触发 unread+列表刷新（`SessionSidebar.tsx:503-514`）。半适配：广播侧过滤或侧栏侧过滤。 |
| 7c74e93 | #518 /clone 命令（复制会话不销毁源） | 🔧 | 需 daemon 加 clone case（复用 fork 拷贝路径 `createBranchedSession` 但不 `destroy()`，见 rpc-manager.ts:529-563）+ web builtin 命令注册 + 替换期命令门。 |
| 039e843 | #704 聊天内容宽度/字号设置 | 🔧 | fork SettingsPanel 外观区无该项；ChatWindow 布局分叉（minimap 列/列宽常量 `ChatWindow.tsx:92-94`），需按 fork 布局重做 CSS 变量。 |
| f748f52, 20a47a2, c0a6083 | 系统面板拆分/工具定义展示/懒加载 | 🔧 | fork 面板体系分叉为 `components/shell/ChatToolbar.tsx` + 右 dock；systemPrompt 已按需拉取（refreshAgentState 懒取，等价 c0a6083）。缺口主要是"工具定义查看"面板；按 fork shell 结构适配。 |

## 🛡️ 本地已规避或等价

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 6b0c6a5 | #997 per-client SSE backlog 上限 | 🛡️ | daemon `lib/daemon/sse-writer.ts` 1MB 未排水即断（`SSE_STALL_BYTES_DEFAULT=1_000_000`，onStall 拆订阅）—— 与上游"不可重建积压→断线重连重快照"同药方且更早；可重建事件丢弃策略无需复制。 |
| 05db5b2, e4fded0, def1478, 4787a14, 002400d | Pi 0.84 delta 适配/SSE 韧性/重连保 shell 输出/打开活动会话保流式/首 chunk 重复 | 🛡️ | 上次 0.9.1 审计 §2.1 结论不变：daemon 多监听者广播（`rpc-manager.ts` listeners + `http-sessions.ts:58-89`）无"抢订阅"；`message_update` 全量快照（reducer `agent-event-reducer.ts:128-141` 直接置 streamingMessage）自愈 delta 类 bug（002400d 是 delta-only 协议 bug，fork 无 streaming-message/delta 链路）；EventSource 自动重连 + fatal 1s + 15s reconcile（`global-agent-events.ts:134-153`、`useAgentSession.ts:956-975`）；partial 存 per-session runtime store 不随连接清空。 |
| 0ff1138 | 选中会话保活（lease） | 🛡️ | fork 观看语义：pin 集合保 SSE（`lib/sse/global-agent-events.ts:57,81`）+ idle 会话观看时冷启动 wrapper（`lib/daemon/http-sessions.ts:276-278`）；idle 回收对持久会话无损。 |
| 68223e0 | prompt 完成后保留事件流 | 🛡️ | running+pin 政策（`global-agent-events.ts:81` 不 running 且不 pin 才断）+ 发送前 ensureSseConnected（`useAgentSession.ts` ensureSseConnected）。 |
| 0b307d5 | #933 Strict Mode 下重开事件流 | 🛡️ | fork SSE 单例在 React 外（`lib/sse/global-agent-events.ts`），hook 仅 syncRunningIds（`hooks/useGlobalAgentEvents.ts:12-16`）；无"卸载 cleanup 关流不再开"的形态。 |
| 390e70f | #992 移动 composer 让位键盘 | 🛡️ | fork 有更强体系：`hooks/useVisualViewportKeyboard.ts` + `lib/keyboard-layout.ts`（双判据、X5 内核 innerHeight 回退、布局分治、globals.css pi-kb-squeeze:261-266）。 |
| 0bae9b6 | #1011 答案出现后收起 process 分组 | 🛡️ | fork 分组恒折叠起步（`ChatWindow.tsx:148` `useState(false)`，无 defaultExpanded），不存在"曾经展开的组因答案后到而滞留展开"；流式看过的块由 hasExpandedChild 自动张开一次（:152-156）。 |
| 0cbdf40 | #447 无最终答案也暴露过程详情 | 🛡️ | fork 对无终答 turn 平铺渲染不折叠（`ChatWindow.tsx:970-975` finalAssistantIdx===-1 分支直接 push）。 |
| 67d65a5 | 进程分组恢复 + thinking 控件简化 | 🛡️ | fork 自有分组体系（`ChatWindow.tsx:94-135` hasFinalAssistantAnswer/findFinalAssistantIndex/compaction 锚）+ #639 thinking 独立渲染已移植（b4861d4）。 |
| 6a1246e | #871 新会话模型选择不写入全局默认 | 🛡️ | bug 面 fork 不存在：新会话选择只走 daemon create 命令（`useAgentSession.ts:755-788`），无 persistExplicitStartupPreferences 调用（grep 0 hits）。save-as-default 特性半依赖 SDK 0.87 的 `writeDefaultPreferences`（0.84.4 未导出）—— 需要 SDK 升级再议。 |
| 18923e6 | #711 加载失败时模型选择器仍可见 | 🛡️ | fork 渲染门已含 modelError（`ChatInput.tsx:2254` `modelOptions.length>0 \|\| currentName \|\| modelError`）+ ModelErrorBanner（:1552）。 |
| 29b2d3e | idle 会话恢复偏好工具 | 🛡️ | loadTools 每次挂载 get_tools（daemon 冷启动 wrapper）→ getPresetFromTools（`useAgentSession.ts:720-731`）。 |
| a5738cf | 持久化 chat-only 会话 | 🛡️ | fork "none" 预设=空 toolNames+强制空 system prompt（`rpc-manager.ts:678-681` setForceEmptySystemPrompt）；无 per-session 持久化条目（每次挂载从 live 状态推断），语义弱化但场景已覆盖。 |
| d60c547 | read-only 工具预设 | 🛡️ | `lib/tool-presets.ts:10` `PRESET_READ_ONLY`。 |
| 8df5132 | #839 扩展 widget 更新保序 | 🛡️ | daemon `extensionWidgets` 为 Map，`Array.from(values())` 插入序输出（`rpc-manager.ts:843-845`）；Map.set 已存在键不换位，更新不打乱顺序。 |
| 9e4ca65, 864b8a1 | widget 靠近编辑器渲染 / 收进状态栏 | 🛡️ | fork：composer 上/下双区渲染（`ChatWindow.tsx:715-716,841,1201`）+ `components/ExtensionStatusBar.tsx`；布局自有方案。 |
| 77e482d | 参数流式期间显示 toolCall | 🛡️ | 快照协议：partial toolCall 块随 message_update 全量到达并直接渲染（`MessageView.tsx:704` BlockView；`:38` 参数预览）。 |
| 68cd261 | #509/#555 会话历史尾窗加载 | 🛡️ | 上次审计 🛡️：tail=100 + `/earlier` 锚点回翻（`lib/session-reader.ts:232-332`）+ 迭代树投影，非本桶新差异。 |
| b44017a | #796 看到其它 pi 进程写的会话 | 🛡️ | 上次审计 🛡️：读取每次新开 SessionManager + mtime+size 持久索引（`lib/session-index.ts`）+ TTL/代数失效。 |
| 3095198, 3a37c04 | 流式滚动跟随稳定化 / 随屏滚动+底部占位 | 🛡️ | fork 有专用 `lib/chat-scroll-follow.ts`（shouldFollowStream/noteProgrammaticScroll/noteUserScrollIntent，含竞态护栏，`useAgentSession.ts:1712` 使用）；prompt anchor 已随特性移除（见 ➖）。 |
| 0ddb21f, dbd583b | minimap compaction 后导航 / minimap 导航改进 | 🛡️ | 上次审计 🛡️：fork ChatMinimap 从渲染列表构建节点（结构与显示一致），compaction custom 条目仍为图中节点。 |
| d5ec3bc | 保留 slash 命令输入行为 | 🛡️ | 与 546dc5d 同期的输入微调；d10988d（防重复提交）已移植后未见对应复发面，随 546dc5d 一并核过即可。 |
| 582b261 | slash 菜单保持在视口内 | 🛡️ | fork palette 已有视口钳制（`ChatInput.tsx:1747,1833` maxHeight min(44vh/56vh)）+ `lib/dropdown-layout.ts` 布局库。 |
| 5d6342a | #433 流式期间跳过语法高亮 | 🛡️ | `components/MarkdownBody.tsx:44` `plain={isStreaming}`。 |
| fcfac31 | #472 移动端 Enter 换行 | 🛡️ | `ChatInput.tsx:1350` `!e.shiftKey && (!isMobile \|\| forceSend)` —— 移动端 Enter 默认换行、发送键强制。 |
| 6ac72b2 | #668 本地化硬编码 tooltip/aria | 🛡️ | fork 自身 i18n 体系（useI18n + zh-CN）；ChatMinimap 无硬编码标签（grep 0 hits），ChatInput 标签均走 t()。 |
| 3d9acf6 | agent 需要关注时通知 | 🛡️ | `lib/browser-notifications.ts`（shouldShowBrowserNotification/claimExtensionAttentionNotification）已随 push 移植链落地（2d75ad3）。 |
| d35c61f | extension 注入消息的流式保留 | 🛡️ | daemon 将 extension 注入 run 的事件与用户 run 同流广播，reducer 快照协议直接建 streamingMessage；agent_settled/reconcile 兜底结算。 |
| 0475e14 | 移动工具栏 + ESM 配置 | 🛡️ | ESM：fork next.config.ts 已有 native-module 外置处理；移动工具栏：fork 自有 MobilePwaLayout/移动 drawer 体系（HEAD 428c6f0 主题）。 |
| 4ec3c5c | 内置 subagent 集成回归修复 | 🛡️ | fork 从 upstream v0.9.1 整体移植 builtin subagent 系统（5e656e2 "core builtin system from upstream v0.9.1"），该 pre-v0.9.1 修复已包含在移植基线里。 |

## ➖ 不适用

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| ce615e7 | /mcp 打开设置 › MCP | ➖ | fork HEAD 无 MCP 设置面板（MCP/codemode 设置工作在未合并分支 00647b0/ba044f9 系）；待该线合并后再看。 |
| d251bb3 | prompt anchor 更新死循环 | ➖ | fork 已主动移除 prompt anchor 特性（grep promptAnchor 0 hits；`useAgentSession.ts` 注释明言不再钉顶 + 空白 spacer），振荡面不存在（上次审计同判）。 |
| f3a4ff6 | #855 选区工具栏不被侧栏遮挡 | ➖ | 依赖 c0abfc2 的选区工具栏（未移植）；若移植 c0abfc2 随手带上 z-index。 |
| 135517b | 新会话品牌对齐 chat input | ➖ | fork 新会话/首页品牌完全分叉（HomeLanding.tsx/HomeNewSession.tsx + ChatWindow isEmptyNew）。 |
| 602b1b6 | 裁剪未用前端基础设施 | ➖ | fork 保留了 auth/push 等并做了自己的清理；上游删的 push unsubscribe/auth all-providers 等 fork 均在用或已改造。 |
| fb8e295 | #491 通知居中 | ➖ | 历史中间态（后被 7ee7818 改为右上）；fork NoticeShelf 终态已是右对齐（ChatWindow.tsx:816,835）。 |
| 2517174 | Pi Web 更新提示 | ➖ | 私有 fork（@qccoder/pi-web）无上游发布通道可比对；fork 用 CI upstream drift guard（3891c42）承担对应职责。 |
| 5f74a19 | #588 测试 harness 双 React 修复 | ➖ | test-only；fork 组件测试栈自成体系（.test.mjs + vm transpile 模式），无 dual-React 问题。 |

## ⏭️ fork 有意分叉不放

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| da1b28b | 升级 pi 至 0.87.0（#931） | ⏭️ | SDK 版本是 fork 独立决策（现 0.84.4）。本桶依赖 0.87 新能力的只有 6a1246e 的 save-as-default 半边；#777/#851 所需的 per-turn 重读机制已验证 0.84.4 具备。0.84→0.87+ 差异（事件协议/JSON 模式等）需专项评估，不随本桶走。 |
| 448e146 | 多主题 + 工具栏主题选择器 | ⏭️ | fork 有自己的 useTheme（light/dark，localStorage pi-theme）+ ConfigCenter 外观体系；多色主题是可选增强而非缺口。 |

## 小计

判定分布（按聚类行）：✅ 建议移植 20 行 / ✅ 已移植 3 行（22 个提交）/ 🔧 21 行（26 个提交）/ 🛡️ 29 行（39 个提交）/ ➖ 8 行 / ⏭️ 2 行；合计覆盖 TSV 全部 120 个提交。

任务重点项落位：#1058=🔧、#777=✅、#851=✅、#1008=✅、滚动到底=已移植、prompt anchor=➖、宽表格=已移植（78ff7d6，不在本桶）、apply_patch #744=已移植（76e5627）、#826/#1024=不在本桶（工具视图桶）。

---
# 批次 B 审查:UI shell / 文件面板 / markdown 渲染(upstream 6885309..v0.10.0,78 提交)

> 2026-10-07。fork 工作树 = 分支 `upstream-sync/0.10.0`(HEAD `428c6f0`),基于 merge-base `6885309`(v0.9.1 之前 288 个提交的基点,故 TSV 内混有 v0.8.x→v0.9.1 时代的 UI 提交,此前仅流式/会话批次被审)。所有 file:line 指本分支工作树;`upstream <hash>` 指 `agegr/pi-web`。
> 方法:按主题聚类后逐条 `git show` 理解机理,再对照 fork 工作树 + fork 移植史(`git log --grep="port("`);判定:✅ 可直接移植(或已移植,给 fork commit)/ 🔧 需适配移植 / 🛡️ 本地已规避或等价(file:line)/ ➖ 不适用 / ⏭️ fork 有意分叉。

## 桶级总结

- **9/78 已随历次移植落在 fork**(#332/#392/backticks/#650/#520/#591/分页/#693/终端 #695),另有约 18 条 fork 以自有架构等价规避(侧栏状态、git 可见性、Windows 路径、iOS 视口、分支门控等)。
- **真实缺口集中在 markdown 渲染与文件面板**:宽表格单元格换行(#1056)、Prism 表格 token(#460)、DOCX Safari(#753 关联)是一行级 ✅;货币数学(#976)、CJK autolink(#971)、Safari 16.2(#1019,含 fork 自身两处 lookbehind)、用户消息换行(#1015)、mermaid 状态(ab0ea58)、Ctrl/Cmd 文件链接(#708)、视频预览(#655)、文件 tab 保活(#451)、失败上传保旧档(#1039)为 🔧,合计 21 条。
- **MCP-in-Settings 五连与 codemode 是 fork 未引入的子系统**(无 app/api/mcp、无 McpConfig/package.json mcp 依赖),整体 ⏭️;上游 SettingsUi 样式四连同样打在 fork 不存在的设置面上。
- **移动端/iOS 三连与 hydration** 上一轮审计已确认 fork 自有 visualViewport/safe-area 体系覆盖,本次复核维持 🛡️。
- 用户强调的 #1060/#790/#981/#947/#1032/#1030 不在本 TSV(属范围内但分桶遗漏),已在 §3 补判:#1060 ✅(fork 正是修复前形态)、#947/#1032 🔧(fork 对话框同样硬编 560px)。

## 1. 主表:✅ 可直接移植(含已移植)

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 81e5b039 | #1056 宽表格单元格换行而不挤压 | ✅ | 上游=一行 CSS:`.markdown-body th/td { max-width: 240px }`。fork globals.css:450-470 的 `.markdown-table-wrap`/`> table {width:max-content}` 结构与上游逐行同源(`#650` 已移植),仅缺 max-width → 补一行即合。e2e 部分 fork 无 e2e,可略。 |
| 7473ac60 | #460 Prism markdown 表格 token 保持 inline | ✅ | 上游=一行 CSS:`span.token.table{display:inline}`(Prism 的 `.token.table` 类名撞 Tailwind 的 `display:table` 工具类)。fork 同用 Tailwind 4 + Prism,globals.css 无此规则,markdown 源码预览同样中招 → 一行。 |
| 98f09d72 | DOCX 预览 Safari 同源 | ✅ | 上游=FileViewer iframe `sandbox=""` → `"allow-same-origin"`。fork FileViewer.tsx:781 正是修复前 `sandbox={isPdf ? undefined : ""}` → 一行。 |
| dc4c0ec4 | #332 数学围栏规范化(粘尾/嵌套列表) | ✅ | 已移植:`1df335a port(fix): normalize display math fences glued to content or nested in lists`。fork lib/markdown.ts:122-196 含 lazy-continuation 缩进修复(带原理解释注释)。 |
| f355928d | #392 单波浪线不删词(CJK 区间) | ✅ | 已移植:`5c78685`。fork lib/markdown.ts:330-333 `singleTilde:false`(注释引 #385)。 |
| a26cc68e | 行内代码转义反引号 | ✅ | 已移植:`947907b`。fork lib/markdown.ts:17-26,78 rewriteEscapedInlineCodeBackticks。 |
| 07dd093f | #650 宽表格横向滚动 | ✅ | 已移植:`78ff7d6`。fork globals.css:464 `.markdown-table-wrap > table{width:max-content}` + wrap 的 overflow-x:auto。 |
| 9db0cce1 | #520 内联 SVG 预览禁脚本执行 | ✅ | 已移植:`460acb9 port(fix): block script execution when an inline SVG preview is opened as a document (#520)`。 |
| b24ecadf | #591 文件搜索 | ✅ | 已移植:`05bd753 port(explorer): quick file search`。fork FileExplorer.tsx:524-551 + lib/search-tree。 |
| 0e712013 | 大文本分页预览 | ✅ | 已移植:`f69acb5 port(files): paginate large text file previews`。fork FileViewer.tsx:831-842,1245-1276(nextOffset/truncated/loadMore)。 |
| f3925bf0 | #693 Mermaid 完成图预览 + SVG 下载 | ✅ | 已移植:`9a56fd2 port(mermaid): preview completed by default + SVG download`。fork MermaidBlock.tsx:37-146(defaultPreview、key 化 renderState、下载)。 |
| 9290c272 | #695 文件面板工作区终端 tab | ✅ | 已移植(适配):`3c38f60/641b063/fcfd8c8/7e41987/4323ca9` 五连,落 fork 右侧 dock 的 TabBar 尾部,DesktopShell.tsx:1083-1091 hidden 保活。 |

## 2. 主表:🔧 需适配移植

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 80cd55ecc | #1042 SMIL spinner → CSS 动画 | 🔧 | 机理:SMIL `<animateTransform>` 每帧整页主线程重绘;上游改 Tailwind `animate-spin` + CSS `unread-ping`(仅动 opacity,合成器线程)。fork 有 4 处同款 SMIL:SessionSidebar.tsx:1784、SessionTabBar.tsx:404、SessionRow.tsx:130、WorkspaceSwitcherPanel.tsx:189 → 全部换 class + globals.css 加 keyframes(含 prefers-reduced-motion)。 |
| 6a97d0b1 | #976 货币格式与行内数学共存 | 🔧 | 机理:`$20 … $6` 被单 `$` 数学吞并;上游 remarkCurrencySafeMath 包装 remarkMath 的 mathText tokenizer(金额开头+闭前数字/单侧空格即拒)。fork lib/markdown.ts:335-336 用裸 `remarkMath` → 同样中招。纯 lib 自包含插件,直接移植。 |
| 4a5081a3 | #971/#972 autolink 在 CJK 标点截断 | 🔧 | 机理:GFM autolink literal 只认 ASCII 空白/标点,URL 粘中文正文会把正文吞进 href;上游在 remark 树上按 CJK 标点切回文本节点(汉字本身不是边界,zh.wikipedia 链接不受影响)。fork 无此处理,中文对话高价值 → 移植 splitAutolinkLiteralsAtCjk + 接入 markdownRemarkPlugins。 |
| f52fd840 | #1019 Safari/iOS 16.2 白屏 | 🔧 | 机理:Safari<16.4 无法解析的正则字面量=整个 chunk SyntaxError;两个来源:(a) mdast-util-gfm-autolink-literal ≥2.0.1 的 email lookbehind——fork package-lock 锁的正是 2.0.1;(b) fork 自身 lib/markdown.ts:17(`(?<![\\`])`)与 :325(`(?<!\\)`)两处 lookbehind 字面量,随首屏 chunk 下发。移植 loader(lib/gfm-autolink-email-loader.cjs + next.config.ts turbopack/webpack 双规则)并改写自有两处正则。 |
| faeff036 | #1015 用户消息保留手打换行 | 🔧 | 机理:自定义 remark 插件把段落/标题/表格单元内的行尾换成自定义 `<br>` 节点(绕开 remark-rehype 的 break+`\n` 双断行),代码/数学/raw HTML 不动;另把 `\r\n?` 归一为 `\n`。fork 仅 `.markdown-user-message p{white-space:pre-wrap}`(globals.css:494),列表项/标题内换行仍被折叠;MarkdownBody 无 keepLineBreaks prop。移植插件 + prop + MessageView.tsx:318 接线。 |
| 5f35d6fc | #595 松散方括号数学块 | 🔧 | 上游在 `\[..\]` 之外增加裸 `[x = \alpha]` 单行/多行 → `$$` 转换(isLikelyMathExpression 启发式:含 `\命令` 且非 URL/盘符)。fork markdown.ts:86-120 只认转义形 `\[ \]` → 模型输出的松散括号块仍渲染为正文。fork 的 normalizeDisplayMath 结构同型,补分支即可。 |
| ab0ea587 | Mermaid 预览状态跨渲染保持 | 🔧 | 机理:MarkdownBody 的 components 对象每次渲染新建 → react-markdown 视为新组件类型 → MermaidBlock 卸载重挂丢 showPreview;上游用 useMemo 稳定 identity。fork MarkdownBody.tsx:27-105 正是内联对象字面量(且捕获 onOpenFile/renderInlineCode,需入 deps)。 |
| 5f8056d3 | #708 Ctrl/Cmd 点本地文件链接 | 🔧 | 机理:HTTP 源导航 file:// 被浏览器拦,相对路径则破坏 SPA 路由;上游 shouldOpenLocalFileInApp=「非 shift/alt 都走应用内」,Shift 才开新 tab(urlTransform 保留 file: href)。fork MarkdownBody.tsx:73-80 与 FileViewer.tsx:1363-1370 都把修饰键直接放行给默认导航 → 同样中招;两处都要改。 |
| d11d3448 | #826 工具卡折叠时图片仍可见 | 🔧 | 上游把 result 图片从折叠 details 内提到外面常显(MarkdownImage+ImagePreview 部分 fork 已由 e851d30 移植具备)。fork MessageView.tsx:1145-1153 工具结果(含图)全在 `expanded` 门内;可套 fork 自己的用户附件常显模式(MessageView.tsx:290-311)。 |
| 5ae71529 | #391 YAML frontmatter 渲染为元数据卡 | 🔧 | 机理:react-markdown 不认 frontmatter,开头 `---` 块渲染成 hr+setext 标题泄漏元数据;上游加 lib/frontmatter + FrontmatterCard。fork FileViewer.tsx:980-983 markdownPreview 仅 normalizeDisplayMath → 同样泄漏。移植(预览路径;聊天内 frontmatter 少见)。 |
| 9dceb238 | #655 文件面板内联视频预览 | 🔧 | 机理:VIDEO_EXT_TO_MIME 表 + VideoViewer(镜像 AudioViewer 的 live watch/duration/download),webm 不再误判 audio。fork file-types.ts:19-29 `webm:"audio/webm"`(修复前状态)、无视频支持;files route 已有完整 Range(route.ts:425-489)→ 照 fork AudioViewer(FileViewer.tsx:552-667)镜像 + 分发点 :795 + i18n ×3。 |
| 2e9e0d61 | #451 文件 tab 切换保住查看器状态 | 🔧 | 机理:右面板只挂 active tab → 切换即卸载,丢滚动/预览状态;上游让所有 tab 常挂、非活跃 `display:none`。fork DesktopShell.tsx:1092 只渲染单个 FileViewer;而 fork 的终端 tab 已经用同一手法保活(:1083-1091 hidden)→ 照抄即可(注意与右 dock 模块面板共存)。 |
| 1ddaf11f | #1039 失败上传保旧档 + git diff 目标授权 | 🔧 | 上传半场:fork "app/api/files/[...path]/route.ts":344-355 替换冲突文件时先 `unlinkSync` 再 `wx` 写 → 写失败旧档已删(数据丢失);上游 replaceUploadFile 用私有暂存目录 + rename 原子替换 → 移植。git-diff 半场 fork 已等价:route.ts:14-26 注释明说「file 可能已被 Git 报删,getGitFileDiff 校验归属」。junction 半场 fork 一律拒(nonReplaceable)更严,无缺口。 |
| 0c525c89 | #703 Windows 盘根路径还原 | 🔧 | 上游 filePathFromApiSegments 补 `/^[a-zA-Z]:$/` → `C:/`。fork route.ts:75-81 缺该分支,裸盘根请求变 `/C` → 一分支补齐(fork 有 Windows 路径规则体系,值得补)。 |
| be38e5d8 | #853 变更文件行 mention 按钮 + 中省略路径 | 🔧(半) | 文件树半场 fork 已有 hover mention(FileExplorer.tsx:396-424);缺 SessionChangedFiles 变更行(无 mention、无目录中省略)。fork 已有中省略技术(SessionSidebar.tsx:181 rtl 容器)可复用。 |
| 433d09ea | #996 默认目录按本地日期 | 🔧 | fork app/api/default-cwd/route.ts:10 `toISOString()`=UTC 日期(UTC+8 零点后差一天);上游改 localDateStamp(本地日历日期)+ `~/pi-cwd/<YYYYMMDD>` 父目录。至少换本地日期;目录命名是否跟随是产品选择。 |
| 55485b9a | #653 高亮树缓存 | 🔧(低) | fork FileViewer 直连 react-syntax-highlighter 无缓存(上轮 audit §4 同判);若做 #451 tab 保活则切 tab 不再重高亮,此项优先级更低。 |
| 30faaf79 | #367 文件树折叠状态持久化 | 🔧(低) | fork FileExplorer.tsx:515 expandedPaths 是内存 useState(仅 cwd 变化时重置,:748),刷新丢失;上游 lib/file-explorer-state.ts 持久化到存储。小改。 |
| 687af277 | #1018 打开项目外 symlink 目录 | 🔧(可选) | fork lib/path-security.ts:26-44 realpath 双侧判定,链接目标在 allowed roots 外一律拒(与上游修复前一致)。fork 的等价出路=把目标目录纳入 workspace(3122ad2 workspace-owned dirs);上游方案=操作员显式 allow-link 批准(重启失效)。若用户有 symlink 聚合项目习惯再移。 |
| a0c00f37 | #907 在系统文件管理器中打开 | 🔧(可选) | 纯新增特性(app/api/open-in-explorer + 路由 + 按钮 + i18n),fork 无对应物。 |
| a5630c15 | 记住上次自定义 cwd | 🔧(可选) | fork DirectoryPicker.tsx(190 行)无持久化;上游记住上次选择。小改。 |

## 3. 主表:🛡️ 本地已规避或等价

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| fdeea873 | #1059 移动端缩放后桌面侧栏状态恢复 | 🛡️ | 上游 bug:移动抽屉动作覆写桌面侧栏记忆。fork:`sidebarOpen`(shell/useAppShellState.ts:264)只有桌面 ChatToolbar 触发(ChatToolbar.tsx:112-113),MobileShell 用底部 tab + ProjectSidebar(MobileShell.tsx:617,786),从不写 sidebarOpen → 断点往返天然不丢。(fork 本就不跨刷新持久化 sidebarOpen,属自有选择,非本 bug 面。) |
| 13bc2b0b | #1014 由 Git 决定文件树可见性 | 🛡️ | fork 的 file-index 本来就是 git 原生口径:`git ls-files --cached --others --exclude-standard`(app/api/file-index/route.ts:47-68),tracked build/dist 天然可见,不存在上游的固定名过滤清单问题。 |
| 5014aaf4 | #469 跳过长源高亮 | 🛡️(部分) | 分页已移植(f69acb5)界住单次高亮体量;无独立长度闸。上轮 audit §4 同判:可不做。 |
| 626f3279 | 线性会话隐藏分支控件 | 🛡️ | fork BranchNavigator.tsx:80,256 以 hasBranch 门控(noBranches 理由态),入口收在 ⋯ 菜单(ChatToolbar.tsx:67,438)。 |
| 93716a5a | #412 暗色主题文件图标单色 | 🛡️ | fork FileIcons.tsx:1 平面单色设计,全部 currentColor/var(--text-dim)。 |
| ec3c4191 | #357 重命名预填标题并全选 | 🛡️ | SessionSidebar.tsx:1860-1865:预填 session.name + `inputRef.select()`。 |
| 776fcb19 | #414 工作区选择器运行/未读活动 | 🛡️ | WorkspaceSwitcherPanel.tsx:40,114,184-194 workspaceActivity running/completed 徽标。 |
| f61a3f7b | #410 重点击当前会话不重载 | 🛡️ | shell/useAppShellState.ts:640,670 同 tab 激活守卫(`activeTabId !== id` 才导航)。 |
| 3ea687c9 | #457 自动命名剥离 skill XML | 🛡️ | fork 标题生成器自带 lib/session-title.ts:207 sanitizeSkillUserContent(lib/skill-message)。残留(低):SessionSidebar.tsx:1858 的 fallback 标题仍用原始 firstMessage。 |
| b3e1eed7 | #388 Windows 下 git 路径比较 | 🛡️ | lib/paths.ts:6-10,29-40 samePath 明确为「git 在 Windows 也发 POSIX 风格 + 盘符大小写」设计。 |
| fa323360 | #490 Windows 项目身份归一 | 🛡️(低残留) | fork 以 workspace.path 为键的工作区子系统替代 project-groups;Windows 大小写/分隔符残留可复用 samePath。 |
| ff57028d | #535 扩展状态多行换行 | 🛡️ | fork ExtensionStatusBar.tsx:7-12,44-51 自有设计:换行折叠为空格 + 单行省略,不做多行换行布局。 |
| cc1394d63 | #675 长扩展标签滚动 | 🛡️ | 同上:单行 ellipsis(title 提示全文),无滚动动画需求面。 |
| 2eb95b99 | #772 主题/语言控件保持可达 | 🛡️ | fork 主题/语言常驻 ChatToolbar ⋯ 菜单(桌面+移动,ChatToolbar.tsx:71-72,189,741),从未移入又移出设置。 |
| f101948e | 会话列表滚动 perf | 🛡️ | fork WorkspaceSessionList.tsx:65,168 已是 rAF 节流窗口化(注释引 upstream 5f8f47b 手法);上游增量(滚动位置量化 + useMemo)价值小。 |
| ed52b611 | #547 iOS standalone 视口填充 | 🛡️ | fork 自有 visualViewport/`--app-height` 体系(useVisualViewportKeyboard,AppShell.tsx:48-50;globals.css pi-keyboard-open/pi-kb-squeeze)。上轮 audit §6 已录。 |
| 5eb71d89 | #387 iOS 键盘收起后视口 | 🛡️ | 同上。 |
| a3bbdee4 | #604 iOS 状态栏下 modal | 🛡️ | fork safe-area 处理(globals.css:125 等),上轮 audit §6 已录。 |
| b8a3c535 | #463 hydration mismatch | 🛡️ | app/layout.tsx:68 `<html suppressHydrationWarning>`;fork 无 useResizablePanel(右坞宽度走 ref+CSS),aria-valuemax 半场无对象。 |
| 55164b50 | pi 依赖升 0.84.3 | 🛡️ | fork 已在 0.84.4(package.json @earendil-works/*),被超越。 |
| ab614db9 | #352 文本查看器统一 mention | 🛡️ | fork 原生更强:onMentionLines + Cmd/Cmd+I 行区间 mention(FileViewer.tsx:33,90,988-1030),选区边界修剪逻辑齐备。 |

## 4. 主表:➖ 不适用 / ⏭️ fork 有意分叉

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 8716e708, 00647b01, eeda8624, cea11aab, c8fc3c0a | Settings›MCP 全簇(只读列表/开关删除撤销/粘贴添加+信任) | ⏭️ | fork 无 MCP 子系统:无 app/api/mcp、无 McpConfig/McpAddServer 组件、package.json 无 mcp 依赖(daemon 侧亦未暴露)。与上游 ADR-0006 产品线整体分叉,不逐条移植。 |
| 82e553988 | codemode 脚本盒渲染 | ⏭️ | fork 无 codemode 工具视图;renderInlineCode 机制 fork 自有(SkillMessageContent.tsx:181 skill 引用芯片)。 |
| ef1de895 | #887 每浏览器 tab 记忆打开会话 | ⏭️ | fork 的 SessionTabBar 多 tab 体系(localStorage 全局共享 tab 集,useAppShellState.ts:877,920)与 sessionStorage 每 tab 记忆语义相反——共享 tab 集是 fork 的可见设计,非 bug。 |
| c8692e48 | #416 切工作区恢复上次会话 | ⏭️ | fork tab 体系自带 per-tab 视图状态持久(useAppShellState.ts:126-156),记忆粒度更细。 |
| 77ffe3c9 | #720 未发送新会话草稿保留 | ⏭️ | 上轮 audit §3-3 已裁:T10c 有意选择「卸载即清」防残稿复现(draft-store/composer-draft-key),与上游 parked 语义相反,待产品确认,非本轮移植项。 |
| 8463025a, b8d00439, 7047460e, 4de9f777 | SettingsUi/chat 外观样式四连 | ⏭️ | 打在 upstream app/settings.css + SettingsUi.tsx 上;fork 设置面=自有 SettingsPanel(408 行)+ConfigCenter,无对应结构。 |
| ac7ccbca, cbb464d5 | 本地系统字体栈(改后即回退) | ➖ | 上游净零(引入+revert 相互抵消);fork 用 Noto Sans Mono(next/font,app/layout.tsx:2)不受影响。 |
| 2e1c402a | #670 扩展 shelf 触发区收缩 | ➖ | fork 状态栏无 widget 触发区(flex 布局单行,ExtensionStatusBar.tsx:29-40)。 |
| 460da477 | #549 窄侧栏下工具栏动作可见 | ➖ | fork 工具栏位于中列 ChatToolbar 且收纳进 ⋯ 菜单,无「窄侧栏工具栏」形态。 |
| 5de2d9ae | #630 子路径部署 router.replace 相对化 | ➖ | 上轮 audit §6 已录:fork next.config 无 basePath,无该部署形态。 |
| a74aef85 | #712 sidebar=collapsed 嵌入参数 | ➖ | fork 无嵌入(iframe)启动形态与 URL 参数解析。 |
| 860698a6 | #733 扩展 widget 字号设置 | ➖ | fork 无字号设置面(上游挂在 fork 不存在的 SettingsUi);若要可作独立小特性。 |
| c8de95e8 | 设置直达捷径(#settings/… 深链) | ➖ | fork ConfigCenter 无 hash 路由;可选增强。 |
| 96966e5f, 4857da3 | demo(GitHub Pages 静态站) | ➖ | fork 无 demo/ 目录与 pages 工作流。 |
| 279e2285 | docs(agents 规则修订) | ➖ | 纯文档;fork AGENTS.md 自有维护。 |

## 5. 补充:范围内但不在本 TSV 的重点提交(分桶遗漏)

| hash | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| e2ea7da3 | #1060 代码块背景随主题切换保留 | ✅ | 机理:Prism 亮色主题用 `backgroundColor`、暗色用 `background` 简写,React style diff 二者互踩 → 切主题丢背景;修复=customStyle 全改 `backgroundColor` + 删除 vscDarkPlus 的 `pre` background 简写。fork components/MermaidBlock.tsx:280,295 正是修复前形态(简写 + 原始 vscDarkPlus)→ 直接照抄 3 处小改(注意 fork FileViewer 源码视图 customStyle 用的是 `background:"var(--bg)"` 独立体系,不受影响)。 |
| ffb2daf | #790 文件面板全宽开关 | 🔧(可选) | 临时全宽展开挂载中的查看器、不动已存分栏宽度;fork 右坞是拖宽+模块 tab 体系(DesktopShell.tsx:276-289),需适配「全宽=压过中列」的层级,非直接套。 |
| 680db65 | #981 目录选择器内建目录 | 🔧(可选) | fork DirectoryPicker(190 行)无创建能力;需 mkdir API(fork files route 无 POST 目录)+ picker UI「新建并进入」+ i18n ×3。 |
| 981e270 | #947/#1032 扩展对话框/自定义面板可加宽 | 🔧 | fork 扩展对话框正是同样的硬编码:`width:"min(560px,100%)"`(ChatWindow.tsx:1369);移植 dialogSize(sm/md/lg/full)提示 + 最大化/还原按钮;fork 对话框是 fork 重写版,机制同型。 |
| 1333c80 | #1030 状态栏显示扩展命令按钮(chip:) | 🔧(可选) | `chip:` 前缀 status → 可点按钮发命令;fork ExtensionStatusBar 是纯文本单行,需加 chip 解析 + 点击→命令回发通道(fork 自有 UI 请求链路)。 |

## 6. 小计

- **TSV 78 条**:✅ 12(其中 9 条为已移植,3 条一行级新移植)· 🔧 21(高价值 11:SMIL spinner、货币数学、CJK autolink、Safari 16.2、用户换行、松散数学、mermaid 状态、Ctrl/Cmd 链接、工具图常显、视频预览、文件 tab 保活、上传保旧档中再挑)· 🛡️ 21 · ➖ 12 · ⏭️ 12(两 hash 合并计 1 处字体对)。
- **补充 5 条**:✅ 1(#1060)· 🔧 4(其中 #947/#1032 建议随扩展对话框一起做)。
- 建议第一批动手(一行级):#1056、#460、DOCX same-origin、#1060 —— 四个合计约 10 行改动。

---
# 桶 C:subagents / terminal / plugins / skills / AgentsConfig — upstream 0.9.1→0.10.0 升级审查

范围:`/tmp/upreview/C-subagents.tsv` 58 个提交。仓库:`/Users/qiancheng/Documents/Workspace/pi/pi-web`,分支 `upstream-sync/0.10.0` @ 428c6f0,merge-base 6885309。

## 桶级总结

1. **基线事实**:merge-base(6885309)根本没有 subagent 系统 —— upstream 的整套内置 subagent 是 merge-base 之后(baa600b 起)才长出来的。fork 的"内置化"是 upstream **2026-09-19 状态(9d282da/20a2579)的忠实快照移植** + 三处有意的适配:① 子会话保持 `pi-subagent-<uuid>` ID 前缀(社区包兼容);② 去掉 PowerShell 工具名重映射(fork 面 darwin/linux/docker);③ 内置 subagent 默认 ON(ADR 0003,替代社区包的连续性)。逐文件 drift 验证:`lib/subagents.ts` vs 20a2579 仅差 yaml 库替换,`subagent-runtime/extension/settings`、`AgentsConfig.tsx`、`app/api/subagents/profiles/route.ts` 差异均在 13–58 行的适配范围。**因此本桶 30 个 pre-base 提交已全部随 port 吸收(✅)**,含 ID 规范化(b4760fd)、tintinweb profiles(bbe2f7d)、worktree 隔离(2661247)、并发队列(b77a25f)、resume 持久会话(a31d5c5)、ext: 工具选择器(e3fbbf6)。
2. **port 之后 upstream 又演进了 12 个 subagent 提交(2026-09-22 起),fork 全部缺失**。其中 7 个是纯 web 侧修复,不依赖 SDK 升级,建议整组 cherry-pick:后台完成通知正确性系列(12d3599 静音已收集结果 → c8ff7e8 按 run 键控 → 54aa49c 非用户消息前缀 → 2a71c57 resumed-run 标注)、00156d5 重启孤儿 run 报 interrupted、6f2b4f0 resume 拒绝 creation options、162a749 ext: 选择器对 scoped npm 包名的解析修复。接线点:`lib/subagent-extension.ts`(notifyParent/markResultConsumed 契约)、`lib/subagent-runtime.ts`;fork 侧注意 `lib/daemon/rpc-manager.ts` 的 registry 语境。
3. **三个大特性 + 一个 refactor 硬依赖 pi SDK 1.0.0**:fork 锁在 `pi-agent-core/pi-coding-agent 0.84.4`,已验证 0.84.4 的类型里没有 `finishTurn`、`exposure`(model-only 工具)、`extensionsOverride`(#1091 依赖)。所以 **#1034(profiles 预载指定 skills)、#1091(profiles 只加载 `extensions:` 点名的扩展)、#1093(turn limit 与 terminal outcomes 在 SDK finishTurn 边界处理)、62542da(控制工具 model-only)** 必须排在 SDK 0.84.4→1.0.0 升级之后 —— 这是 fork 内置化版本最值得吸收的能力:profile 级资源收敛(skills/extensions 最小加载)与失控 run 的优雅终止(保留 partial output、区分 abort/provider error、报告未投递队列)。
4. **f07d4a2(单个内置 subagent 关闭,`disabledBuiltIns`)单独强调**:fork 把内置 subagent 当社区包替代品默认 ON,却没有"逐个关"的粒度(只能整组关或复制同名 profile 覆盖),这个提交与 fork 定位互补,值得优先移植;移植时注意 fork 的 `settingsValue(builtInEnabled !== false, ...)` 默认值分叉要保留。
5. **UI/平台系大多不适用**:upstream 的 SettingsUi Config* 块体系重构(197a3e5/b9622a1/3eb8a9d)与 fork 自研 config center(`ConfigCenterPage` + 精简版 `SettingsUi.tsx` 257 行)平行演进,fork 的 `PluginsConfig/SkillsConfig`(1672/1937 行)是重写的安装/同步模型;fork **没有 MCP 设置面**(92489b7/dba11f4 无落点)、不面向 Windows(afd2575/fce666a 无效);dormant skills(d63b55a/a2deab3)在 fork 的 skills 模型里无对应概念。`024be0b`(删 running SSE)在 fork 是反向分叉:fork 把该端点重建为 session daemon 的 SSE 代理,是负载承载的(🛡️)。eceac13 的批量 Enable/Disable 端点机制(list 请求 + 逐项结果)可吸收进 fork 的 config center。

## 明细

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| 12d3599, c8ff7e8, 54aa49c, 2a71c57 | 后台完成通知正确性系列(#889/#987/#875/#991) | 🔧 | `get_subagent_result` 收走结果后,后台完成仍以 `triggerTurn` 通知父会话 → 重复 turn 把最终总结顶走。12d3599 加 `markResultConsumed` + `notifyParent` 消费标记(globalThis Map);c8ff7e8 把标记从 sessionId 改为 `(sessionId, completedAt)` 键控,防 `resume` 复用 session ID 时吞掉新 run 的通知(#987);54aa49c 给通知文本加 `SUBAGENT_NOTIFICATION_PREFIX` 前缀,防 compaction 把子代理报告当 user intent 写进 Goal/Constraints;2a71c57 给 resumed run 的报告加 "supersedes earlier report" 头。fork 全部缺失(`lib/subagent-extension.ts` 仍是基线状态);纯 web 侧、无 SDK 依赖,建议整组移植,`extensionRuntime` 契约新增 `markResultConsumed` 时同步 fork 的 `lib/daemon/rpc-manager.ts` 接线 |
| f07d4a2 | 单个内置 subagent 开关(#874/#934) | 🔧 | 内置三 profile 无文件可挂 `enabled: false`,upstream 在 subagent settings 里存 `disabledBuiltIns: string[]`(大小写不敏感、保留未知名防降级),Agents 面板逐个可关。fork 缺失且痛点更大(内置默认 ON 替代社区包,只能整组关/同名覆盖)。落点:`lib/subagent-settings.ts`(注意保留 fork 的 `builtInEnabled !== false` 默认)、`app/api/subagents/settings/route.ts`、`components/AgentsConfig.tsx`、fork 无 docs/adr/0005 |
| 00156d5 | 重启孤儿 run 报 interrupted(#990) | 🔧 | 持久化 `running/queued` 状态的 run 若 `get()` 时既无结果条目也无活动 wrapper,说明进程中途死掉,报 `interrupted` 让 `wait:true` 的父调用返回、`resume` 可接手。fork 缺失;`lib/subagent-runtime.ts` 两处 `settleOrphanedRun` 包装,fork 的 daemon 重启场景同样需要 |
| 6f2b4f0 | resume 拒绝不支持的选项覆盖(#1055 系) | 🔧 | `resume` 时若同时传 `model/thinking/max_turns/inherit_context/input_files/isolation` 报错并列出违规项("only apply to new subagents")。fork 的 `lib/subagent-extension.ts` resume 工具无此校验(基线状态);小而独立,直接可移 |
| 162a749 | ext: 选择器按真实扩展源解析(#946) | 🔧 | 旧解析按第一个 `/` 切分,scoped 包名(`@vndv/pi-codegraph`)被读成 `@vndv`,`ext:name/*` 变 no-op,深层段静默截断。改为对每个已加载扩展导出候选名集合(父目录/文件名/npm source 名/去 scope 名)再匹配,deny 列表同源解析(解析期过滤只是快路径)。fork 有 e3fbbf6 的 ext: 机制但仍是旧解析;`lib/subagents.ts`(parse/profile `disallowedExtensionTools`)+ `lib/subagent-runtime.ts`(spawn 期解析)。注意 fork 的 `lib/plugin-updates.ts` 已有自己的 `parseNpmSource` 可复用 |
| 496611c | turn limits 与 terminal outcomes 在 SDK 边界(#1093) | 🔧 | fork 现状是旧的 soft-steer + `turnLimit+1` 强 abort(`lib/subagent-runtime.ts:298-308`),会丢 partial output、混淆 abort 与 provider error。upstream 改为包装 `inner.agent.finishTurn`(SDK 边界):保留自然完成与 `terminate:true` 工具的终止、预算失败保留 partial output、`stopReason: error/aborted` 区分、达限后拒 steer、报告未投递的排队消息。**前置:fork 的 pi SDK 0.84.4 无 `finishTurn` API,需先升 1.0.0** |
| 17bbadb | profile `extensions:` 列表只加载点名扩展(#1091) | 🔧 | `extensions:` 原来只是开关语义,列表也会加载全部扩展。新增 `scopeSubagentExtensions()` 作为 `extensionsOverride`:SDK 全量加载后按名裁剪(目录/文件/包名、大小写不敏感,重名双弃),同时撤掉被裁扩展排队的 provider/native/virtual-model 注册;`<inline:>` 永留,路径条目不加载(project trust 不被绕过);`*`/`none`/`false` 语义;resume 与 RPC reopen 经 `subagentExtensionLoaderOptions()` 同口径。**前置:SDK 1.0.0 `extensionsOverride`**;落点 `lib/subagent-runtime.ts`(fork 现为 `noExtensions: !profile.loadExtensions`)、`lib/subagents.ts` 解析、fork 的 `lib/daemon/rpc-manager.ts` reopen 路径、`components/AgentsConfig.tsx` 只读展示 |
| 5d5a69e | profiles 预载指定 skills(#1034) | 🔧 | profile `skills:` 从开关升级为名单:新文件 `lib/subagent-skills.ts`(`createSubagentSkillsBinding`:loader options + activeTools getter + exactSystemPrompt 联动),spawn/resume/reopen 三路同口径;lenient 解析(空项/尾逗号不再让整个 profile 不可读,`none/false` 仍是开关拼写,save 与 `load_skills` 保持一致)。fork 现为 `noSkills: !profile.loadSkills` 全有全无。**前置:SDK 1.0.0 skills loader options**;与 #1091 是同一族"profile 级资源收敛",建议同批移植 |
| 62542da | subagent 控制工具注册为 model-only | 🔧 | Agent/get_subagent_result 等 5 个控制工具声明 `exposure: "model-only"`,防 codemode 脚本经 `ctx.executeTool()` 嵌套调用(嵌套 call id 会断掉 transcript 关联)。fork 的 `lib/subagent-extension.ts` 无 exposure 参数。**前置:SDK 1.0.0 `ToolExposure`**;一行式改动但随 SDK 升级走 |
| 38cba2b, ef51ffd | plugins 面板:包描述 + 顶层扩展(#868 等) | 🔧 | 38cba2b: `readPackageMetadata` 读 `description` 进 `PluginUpdateInfo`,Plugins 面板显示包描述;ef51ffd: 插件设置显示 top-level(`origin === "top-level"`)独立扩展,不再只按包分组。fork 的 `app/api/plugins/route.ts` 是移植后改写版,两者均缺(`readPackageMetadata` 无 description、无 standaloneExtensions);小改,可随 fork 面板节奏吸收 |
| eceac13 | Skills/Plugins 批量 Enable/Disable all(#1020) | 🔧 | `/api/skills`、`/api/plugins` PATCH 接受名单,逐项返回结果(路径越界/SKILL.md 改不动/untrusted 包/已删包不阻断整批)。fork 只有逐项 PATCH;**端点机制**(list + per-item result)值得吸收进 fork config center,UI 层则按 fork 自有面板重写 |
| baa600b, 60b7413, 7de0506 | 内置可检视 subagents 基座 + 资源恢复 | ✅ | baa600b 建立整套系统(API routes、AgentsConfig、runtime、extension);60b7413 session reopen 时恢复 subagent 资源;7de0506 恢复改纯快照。fork port(37cffc0/5e656e2/cd684dc)完整包含:`lib/subagents.ts` vs 20a2579 仅差 yaml 库替换 |
| 21be0cc, d1e346e, b79982c, 44d36e2 | 早期安全/正确性修复 | ✅ | 21be0cc profile 限定项目内(路径逃逸防护);d1e346e 工具白名单只读化;b79982c 后台完成安全投递;44d36e2 legacy subagent 替换限定作用域。均在 port 快照内 |
| edb1335, b4760fd, bbe2f7d, 2661247, e3fbbf6, a31d5c5, b77a25f | runtime 抽取 + ID 规范化 + tintinweb + worktree + ext: 选择器 + resume + 队列 | ✅ | 内置 subagent ID 规范化(b4760fd:`Explore`→`explore` 小写名)在 fork `lib/subagents.ts:361` 名称校验处可见;tintinweb keys(name/color/prompt_mode/persist_session)、worktree isolation、并发队列(fork `lib/subagent-queue.ts` vs upstream 至 496611c 均为 0 diff)、resume 持久会话均在 |
| 0d2930f, ec98e1c, c8ede4f, 024be0b* | 内置开关 ADR 0003 / profiles 资源 / 文本文件输入 | ✅ | 0d2930f builtInEnabled 开关 + `app/api/subagents/settings/route.ts`;ec98e1c `load_skills/load_extensions` 资源开关;c8ede4f `input_files` 传文本文件(fork `lib/subagent-extension.ts:148` 可见)。(*024be0b 本体见下方 🛡️ 行,subagent 侧改动已含) |
| 553f2d7, 9d282da, 20a2579 | port 基线本身(#794/#886/#847) | ✅ | fork port 提交信息明确 "core builtin system from upstream v0.9.1 + fixes 9d282da/20a2579";20a2579 的"完成文本带 sessionId 供 resume/get_subagent_result"在 fork `lib/subagent-extension.ts:110` 带上游标注注释 |
| a7f6ab5, 4903dcb, 868b8b5, b5b52f0, b6416c5 | AgentsConfig UI 修缮系列 | ✅ | 保存成功反馈、profile 配置澄清(i18n)、prompt 编辑区加高、紧凑布局、配置动作增强。fork 的 `components/AgentsConfig.tsx` vs 20a2579 仅 22 行适配差异(onClose 可选),均已含 |
| a8b68b1, adae260, c7b550a | settings 面板统一(体验/结构/记忆导航) | ✅ | fork port 携带;后续 fork 演化出自己的 `ConfigCenterPage` + 精简 `SettingsUi.tsx`(仅 ConfigSidebarText/ConfigStatusDot 原语),但基线已含 |
| ce18006 | terminal Linux prebuilds + 原生加载失败报告(#734) | ✅ | fork port 提交 641b063 明确含 9290c27/2e914db/ce18006;`lib/terminal-manager.ts` vs 9d282da 为 0 diff。port 之后 upstream 仅 6ad18cd(terminal shell 过滤 PI_WEB_PASSWORD)再动此文件 —— 不在本桶,但 fork 侧是反向差异(fork 不过滤),merge 时留意 |
| 50b7f79 | plugin 更新检查 + 批量更新(#611) | ✅ | fork 0525206 "port(plugins): plugin update check core + check API route (upstream 50b7f79)" 已移植 `lib/plugin-updates.ts` 核心(fork 版后来为 daemon/project-trust 语境大幅扩展,drift ~360 行属 fork 演化) |
| 96c643a, 237d0ca | release 时关/开内置 subagents | 🛡️ | upstream 发布前默认 OFF(96c643a)、下版再开(237d0ca)。fork ADR 0003 有意默认 ON(替代社区包连续性),`lib/subagent-settings.ts` 里 `builtInEnabled !== false` 与注释均有记录;保留 fork 行为,merge 时以 fork 为准 |
| 024be0b | 移除 running sessions SSE | 🛡️ | upstream 认为无用删掉;fork 把 `app/api/agent/running/events/route.ts` 重建为 session daemon 的 SSE 代理(daemon registry 含交互会话+subagent children+loop rounds),是 fork 架构的负载承载 —— 不移除,保留 fork 版本 |
| d63b55a, a2deab3 | dormant skills 分组 + 列表简化(#288) | 🛡️ | dormant = `disable-model-invocation` 技能在面板/斜杠面板单独分组。fork 的 skills 系统已重写为安装/同步模型(`lib/skills-service.ts`/`skill-updates.ts`/`skill-lock.ts`,1937 行 SkillsConfig),无 dormant 概念;除非 fork 引入同名开关,否则不适用 |
| 197a3e5, b9622a1 | settings 块共享重构 + 分组标题开关(#1021) | ⏭️ | upstream 把 Plugins/Skills 面板迁到共享 SettingsUi Config* 块体系(ConfigSaveTarget/ConfigAddSourceHeading 等)。fork 有自己的 257 行精简 SettingsUi + config center,平行演化;机制理念可参考,代码不适用 |
| afd2575, fce666a | Windows npm 修复(#837/#827) | ⏭️ | afd2575 经 node 跑 npm-cli.js 绕过 npm.cmd(需 `lib/node-cli.ts`,fork 无);fce666a relativePath 反斜杠归一(仅 win32 有效,darwin/linux 上为 no-op)。fork 面 darwin/linux/docker(其代码注释自述),两者无实际收益;若未来支持 Windows 再补 |
| 27935aa | plugin 包安装改进 | ⏭️ | pre-base 的 PluginsConfig 安装流程 UI 微调(43 行);fork 的 PluginsConfig(1672 行)已按自有 npm 安装模型重写,无对应代码 |
| 3eb8a9d, 92489b7, dba11f4 | add pane 统一 scope 选择 / MCP trust / MCP catalogs | ➖ | 全部围绕 Settings › MCP 与 upstream Config 块体系。fork **没有任何 MCP 设置面**(components/ 下无 Mcp*),add-pane scope 统一针对 upstream 四面板结构;fork config center 自有 scope UI(SkillsConfig 内建 global/project)。无落点;若 fork 将来加 MCP 面板,dba11f4 的四目录链接列表可复用 |

---
# 桶 D 审查:models 配置与认证安全(upstream merge-base 6885309 → v0.10.0/后续,39 提交)

> 分支 `upstream-sync/0.10.0`(HEAD `428c6f0`),工作树只读分析。风格对齐 `docs/upstream-0.8.2-to-0.9.1-audit.md`。
> 判定:✅ 可直接移植 / 🔧 需适配 / 🛡️ 本地已规避或已移植(file:line)/ ⏭️ 有意分叉 / ➖ 不适用。

## 桶级总结

- **models 存储与安全面已被前两轮同步拉平**:`lib/atomic-file.ts`、`lib/web-auth.ts`、`lib/auth-throttle.ts`、`app/api/web-auth/route.ts` 与 upstream v0.10.0 **逐字节一致**(port 435965b/398abfe/86b1855 等已覆盖 #295、#473、c3b741e、48e83009、20ad98bc、c1e544ba、d3627646、e44639f0+b80ed3d1)。
- **最大的真实缺口是 499aa4fb**:fork 的 `readModelsConfig` 仍是 plain `JSON.parse` + 静默吞错(pi 接受 BOM/注释/尾逗号),Models 面板把不可读文件读成空 → 下一次 Save **整稿覆盖删除全部 provider**。数据丢失级,建议本批最高优先。
- **安全缺口两处**:beb32a99(Basic Auth 全速爆破,fork proxy.ts 与 upstream 该版逐字节同形、可直接套)与 3e1f4361(fork 的 `lib/safe-destination.ts` 挡住了 `//` 与 `/\`,但 **`/\t/evil`(TAB/换行变体)仍解析为跨 origin**,需换 URL-resolve 语义)。
- **discovery/catalog 链是成对移植项**:d8f89c51(#1006,fork 的 `lib/model-discovery-auth.ts` 与 discover 路由就是 upstream 前置版,lib+route 可平移)先行,7aaeff97(#1050,删掉 fork `ModelsConfig.tsx:330-332` 的 api 默认化 effect)随后;50f6cce9 enabledModels 开关体系是 3000+ 行大件,面板侧与 fork 配置中心分叉重,须独立排期。
- **8 个 MCP/trust/codemode/PowerShell 提交与 2 个 pi 升级提交不属本桶主语义**:fork 无 MCP 子系统(无 `app/api/mcp`、无 ADR-0006),fork 的 project-trust 是 SDK 扩展门控的另一套实现(`lib/project-trust.ts`);SDK 0.84.4→1.0.0 升级归运行时桶。**#1058(context 用量刷新,9182fdf)不在此桶**,在 chat 桶。

## 主表:✅ 可直接移植

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `beb32a99` | Basic Auth 尝试与登录表单共享全局节流 | ✅(安全优先) | 上游机理:节流只盖 POST /api/web-auth,proxy 对每个 `/api` 请求直接校验 Authorization: Basic,GET /api/web-auth 又是免节流口令预言机 → LAN 内全速猜密码。fork 现状:`proxy.ts:36` 同样无节流直查 `isValidBasicAuthorization`,`app/api/web-auth/route.ts:59` 的 GET 同样以 Basic 判 authenticated(预言机)。fork 已有 `lib/auth-throttle.ts`(globalThis Symbol.for 共享,与 route handler 同进程状态),且 fork 的 `proxy.ts` 与 upstream 此提交前版本**逐字节同形**(仅缺节流块)——diff 近乎干净套用。 |
| `92ae057b` | #1012 移动端打开模型选择器不弹键盘 | ✅ | 上游机理:过滤输入 `autoFocus` 在手机上唤起软键盘压缩视口、把模型列表挤出屏外;改 `autoFocus={!isMobile}`。fork 现场:`components/ModelSelector.tsx:258` 仍裸 `autoFocus`,同组件 L63 已有 `const isMobile = useIsMobile()`——一行修复,作用域现成。 |
| `586d72ee` | 守卫 model provider 响应形状 | ✅ | 上游机理:`/api/auth/providers` 出错时返回 `{error}` 而非 `{providers}` → `setOauthProviders(undefined)` 使后续 `.map` 崩溃;补 `Array.isArray` 守卫。fork 现场:`components/ModelsConfig.tsx:1832,1839` 两处 `d.providers` 无守卫,bug 原样存在;改动两行,冲突面近零。 |
| `79894b9a` | #833 auth/列表路由纳入扩展注册的 provider | ✅ | 上游机理:裸 `ModelRuntime.create()` 只见内置+models.json;扩展经 `registerProvider` 注册的 provider 在 Models 面板与 auth 路由中不可见、密钥无法管理。新增 `lib/model-runtime.ts` 的 `createModelRuntimeWithExtensions()`(以 agentDir 为 cwd 走 `createAgentSessionServices`,项目级扩展不进),换 5 个路由一行。fork 现状:所有 auth 路由(`providers`/`all-providers`/`api-key`/`login`/`logout`)都是裸 `ModelRuntime.create()`;fork 的 `/api/models/route.ts:51-56` 已有 `createAgentSessionServices` 先例(且带 project-trust 门控,cwd=agentDir 不触发信任)。fork 的 login 路由与 v0.10.0 的 diff **仅此一处**,直接套用。 |

## 主表:🔧 需适配

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `499aa4fb` | models.json 按 pi 语义读取;不可读文件绝不覆盖 | 🔧(高优,数据丢失) | 上游机理:pi 接受 BOM/`//` 注释/尾逗号,而 `readModelsConfig` plain JSON.parse 失败即返回 `{providers:{}}`,面板下次 Save 把整稿写回 → **删光所有 provider**。修复:stripJsonComments 宽松解析(v0.10.0 又抽出 `lib/jsonc.ts` 含块注释,2ac2a0f)、不可读抛 `ModelsConfigReadError`,GET 422 / PUT 409 不落盘,面板展示错误并禁用 Save。fork 现状:`lib/models-config-store.ts:64-73` 恰是修复前形态(吞错返回空)。适配点:store+route 语义可平移(可用上游 jsonc.ts 终态);面板 Save 禁用+错误条需按 fork 的 i18n 与 2264 行分叉面板手移。**本桶优先级第一**。 |
| `d8f89c51` | #1006 discovery endpoint 从 pi 的 provider catalog 解析 | 🔧 | 上游机理:models-only provider 条目(只列模型、无 baseUrl/api)与 pi 内置 provider 无法导入模型列表,尽管 pi 自己能解析其端点;`resolveModelDiscoveryAuth()` 增加 `baseUrl`/`api` 返回(从 ModelRuntime 组合 provider),discover 路由回落,面板取消「必须填 Base URL」的门控。fork 现状:`lib/model-discovery-auth.ts` 与 `app/api/models-config/discover/route.ts` 就是 upstream 前置版(与 v0.10.0 的 diff 仅缺本提交内容)——lib+route **近乎干净套用**;fork 的 SDK 0.84.4 已具备 `getProvider/getModels/getAuth`(`node_modules/.../model-runtime.d.ts:62-79`),无升级依赖。适配点:面板 Import 按钮门控与「仅内置 provider 适用回落」的 hint 需 i18n 手移(`ModelsConfig.tsx` 分叉)。 |
| `7aaeff97` | #1050 models-only provider 保留 catalog API 协议 | 🔧(依赖 d8f89c51 先行) | 上游机理:面板的 `useEffect` 给无 `api` 的 provider 强写 `openai-completions`,把靠 pi catalog 决定协议(如 anthropic-messages)的 models-only 条目改坏;删默认化 effect,API 下拉显示空、显式清除。fork 现场:bug 原样在 `components/ModelsConfig.tsx:330-332`(effect)与 `:441`(`?? "openai-completions"` + required);需在 #1006 落地后按新语义手移(去掉 effect、空值选项、`v \|\| undefined`),e2e 部分 fork 无 `e2e/model-discovery.mjs` 可略。 |
| `bd85004d` | #969 手输 provider 名随 Save 落盘 | 🔧 | 上游机理:名称输入框是 ProviderDetail 局部态,只有 Rename 按钮把它写进草稿;footer Save 原样序列化 → 只打字不点 Rename 的名字**静默丢失**。修复:名称草稿上提,Save 经 `renameProviderEntry()` 走与 Rename 相同路径(拒绝撞 id,防 Object.fromEntries 静默顶掉另一个 provider),并联动 enabledModels 重命名同步。fork 现场同样结构:`ModelsConfig.tsx:320`(局部 editingName)、`:418-420`(仅 Rename 生效)、`:1870,1991`。适配点:helper(`models-config-helpers.ts` 新增 50 行)可平移;fork 无 enabledModels 联动反而更简单;i18n 报错文案。 |
| `0b0d04c2` + `e932d979` | 双 auth provider 列出(Anthropic/Copilot/Codex);API key 保存不挂起 | 🔧 | 上游机理 ①(#311):`/api/auth/providers` 硬编码 `EXCLUDED={anthropic}`、all-providers 按 id 集合跳「OAuth-only」→ 持 API key 的双 auth provider 两边都不可见、无法增删轮换;换成能力驱动(`provider-listing.ts`:声明 `auth.apiKey.login` 即可列 API-key 项),登出按凭证类型门控(`provider-credential-store.ts`,proper-lockfile 原子删)。②:`ModelRuntime.login()` 落凭证后做**无界网络 catalog 刷新**→ 保存请求挂起;改为 `apiKeyAuth.login()` 取凭证直接 `storeProviderCredential()`。fork 现状:`app/api/auth/providers/route.ts:14` 硬编码 `EXCLUDED=["anthropic"]`;`all-providers/route.ts:5` 硬编码 `OAUTH_PROVIDER_IDS`;`api-key/[provider]/route.ts:33` `await modelRuntime.login(...)` 挂起风险原样。两提交同根(provider-credential-store),写于 pi 0.84.x 时代与 fork 的 0.84.4 同代,可整套移植;适配点是面板两列表联动刷新与 i18n。 |
| `50f6cce9` + `8800b5a0` + `058341d8` | enabledModels 开关体系(#930);开关禁用原因可见化;手动「Refresh catalog」(#914/#938) | 🔧(大件,独立排期) | 上游机理:#930 是 3100+ 行特性——Settings→Models 加 per-model 开关,最小编辑 settings.json 的 pattern 列表(保留陈旧 pattern、原位展开、glob 收敛、minimatch `*` 不跨 `/` 的嵌套 id 修正、枚举列表自愈清理),写走 SettingsManager 字段级 merge,项目级 enabledModels 只读;`/api/models/enabled` 路由 + `EnabledModelsSection`。8800b5a0 是其 a11y 后续(禁用原因必须可见文本,aria-describedby)。058341d8 是手动刷新:`/api/models/refresh` 经 `ModelRuntime.refresh({force:true})`(不带 allowNetwork,尊重 PI_OFFLINE),`shareModelCatalogRefresh` 合流并发。fork 现状:无 `/api/models/enabled`、无 EnabledModelsSection、无 model-catalog-refresh;fork 在 `/api/models/route.ts:32-64` 自实现了 enabledModels 只读过滤(含 thinking 后缀归一)——**读取语义已有,写入/UI 全缺**。SDK 0.84.4 有 `refresh(options?)`(model-runtime.d.ts:95)。适配面:fork 面板/配置中心分叉重,i18n 三语;lib 层(`lib/enabled-models*.ts`、`model-catalog-refresh.ts`)基本可平移。 |
| `3e1f4361` | 登录跳转拒绝解析到其它 origin | 🔧(安全) | 上游机理:只挡 `//` 不够——URL 解析器把 `/\evil.example` 和 `/<TAB>/evil.example`(TAB/换行被剥)都读成协议相对跳转,登录后直跳外部 host;改为对页面 origin `new URL(next, origin)` 解析并要求 origin 不变。fork 现状:`lib/safe-destination.ts` 是自实现的 startsWith 黑名单(挡了 `//` 和 `/\`),**未挡 TAB/CR/LF 变体**(`/\t/evil` 以 `/` 开头、不以 `//` 或 `/\` 开头 → 判为安全,`window.location.replace` 时被浏览器规范化为跨 origin)。落点:把 `safeDestination` 的实现换成 origin-resolve 语义(保留 fork 接口名或直接采上游 `lib/login-destination.ts`),`app/login/page.tsx:35` 调用点不变。 |

## 主表:🛡️ 本地已移植/已规避

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `ac81a965` | #295 模型配置原子写入 | 🛡️ | port `435965b`。`lib/atomic-file.ts` 与 upstream v0.10.0 逐字节一致(wx+0600+rename+finally 清理);`lib/models-config-store.ts:82` 写入走 `writePrivateFileAtomicSync`。 |
| `83c3757f` | #473 忽略空行模型配置 | 🛡️ | port `646dad6`。fork 自有 `sanitizeModelsConfig`(`models-config-store.ts:46-58`)过滤空白 id 行,并入写入路径(:81)。 |
| `c3b741ee` | 价格全有或全无语义 | 🛡️ | port `fd19305`。`normalizeModelsConfigCosts`/`normalizeModelCost`(`models-config-store.ts:13-44`):四项(input/output/cacheRead/cacheWrite)全合法才写、缺项补 0、全空删 cost 组;目录推荐价补 0 在 `lib/model-catalog.ts`(priceFromEntry/consensusPrice)。面板侧只读展示+Edit prices 流程亦随 port 落地。 |
| `d3627646` | PWA 会话导出导航放行 | 🛡️ | port `e214299`。`lib/request-security.ts:75-90` `isUserInitiatedSessionExportNavigation`(sec-fetch-mode/dest/user 三元组 + `/api/sessions/:id/export` 路径白名单),`isApiRequestAllowed`(:166)引用。 |
| `e44639f0` + `b80ed3d1` | scheme 改写代理下的同 origin 判定 | 🛡️ | port `249224e`。`lib/request-security.ts:124-142` `isProxyRewrittenSameOrigin`:Origin  authority===Host(跨源页不可伪造)+ `sec-fetch-site: same-origin`(b80ed3d 的 Fetch Metadata 加固)+ 必须存在 x-forwarded-proto;无转发头 fail-closed。fork 文件与 v0.10.0 仅注释位置差,功能一致。 |
| `20ad98bc` | web 密码全局指数退避 | 🛡️ | port `86b1855`。`lib/auth-throttle.ts`(与 v0.10.0 逐字节一致):全局单计数器、1s 起步/60s 封顶/5min 复位、globalThis Symbol.for 存活 hot-reload;`web-auth/route.ts:80-95` 接线。 |
| `48e83009` | 可选密码认证(Basic+签名会话) | 🛡️ | port `398abfe`。`lib/web-auth.ts`(与 v0.10.0 一致):timing-safe 比较(sha256 等长化)、HMAC 签名 `v1.<exp>.<nonce>` 会话 token;`proxy.ts` 全量接线。 |
| `c1e544ba` | #818 会话 cookie SameSite=Lax | 🛡️ | `app/api/web-auth/route.ts:44,101` 与 `:47` 清除路径均 `sameSite:"lax"`(+httpOnly+条件 secure)。 |
| `e685cac0` | #505 浏览器密码登录页 | 🛡️ | fork 经 `398abfe` + 自有实现完整拥有:登录页 `app/login/page.tsx`(i18n、429/Retry-After 文案、失败提示)、`/api/web-auth` POST/DELETE、globals.css 登录样式。README 多语部分无对应需求。 |
| `47a0bb2f` | #811 manual-code 握手 token 用 crypto randomUUID | 🛡️ | `app/api/auth/login/[provider]/route.ts:76-77` 已是 `${provider}-${randomUUID()}` 且注释同款(防 Math.random 预测劫持挂起中的 OAuth manual 流)。 |
| `6d53fd56` | provider 用量配额展示 | 🛡️ | port `531ae0b`+`77664a0`。`lib/provider-usage.ts` + `app/api/provider-usage/query/route.ts` + `components/ProviderUsageSummary.tsx` + 面板 i18n。注:上游 v0.10.0 之后 provider-usage 又有 opencode-go 与 catalog baseUrl 回退漂移(`provider.baseUrl ?? getModels()[0].baseUrl`),非本桶 TSV 提交,合并时顺带核对。 |

## 主表:⏭️ 有意分叉 / ➖ 不适用

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `d5dff1c3` | #456 自定义模型 headers/compat 编辑器 | ⏭️ | fork 类型层已支持(`ModelsConfig.tsx:141` ProviderEntry.headers/compat),但无 HeaderListEditor UI——`components/ModelsConfig.tsx:950-951` 注释明示:「本地无 model 级 headers/developer-role 编辑器,摘要里的 Headers 计数只反映手改 models.json 的存量」,是 c3b741e port 时的显式取舍。discovery 路径已吃 headers(`discover/route.ts` buildHeaders(configured))。若要补编辑器属增强非缺口。 |
| `b25ae6fc` | 设置分区切换保留草稿(keep-mounted) | ⏭️ | fork 2026-09 做「配置页拆分」:`SettingsPanel.tsx:292-302` 现为移动端专用推入式子页,桌面是独立 ConfigCenterPage(428c6f0 checkpoint)。上游的 mountedSections+hidden 方案建立在单面板多分区结构上,不映射;草稿保活若需要应按 fork 配置中心另设计。 |
| `bf9deccc`、`2ef137ce`、`dff71a07`、`26e409ed` | MCP 子系统(Sign-out 后 Test 写 token、敌意 .pi/mcp.json、会话连接状态上报、files-only 列出) | ➖ | fork 无 MCP 子系统:无 `app/api/mcp`、无 `lib/mcp-*`、无 McpConfig/相关组件。这些提交的主体(MCP host/ADR-0006)不在 fork 架构内;进此桶只因路径沾 `lib/api-types.ts`/i18n。归 MCP 桶评审。 |
| `baaf825a`、`3e693c7b` | trust 对话框(容器目录含未见项目不自动信任;列出项目 MCP servers) | ➖ | fork 的 project-trust 是另一套:SDK `ProjectTrustStore` + `hasTrustRequiringProjectResources` 的扩展门控(#236,`lib/project-trust.ts:1-40`),无 upstream 的信任对话框/继承决策模型。归 MCP/trust 桶。 |
| `1c387b47`、`081c5b16` | Code mode 写入 /api/tools/settings;PowerShell 工具开关 | ➖ | fork 无 `app/api/tools/settings`、无 `lib/global-settings-file.ts`/`codemode-settings.ts`/`powershell-settings.ts`(ADR-0006 体系)。上游依赖其 MCP/codemode 扩展注册机制,fork 无对应面。 |
| `d2668e21` | 设置侧栏尺寸标准化 | ➖ | 纯样式重构(settings.css 30px 行高/缩进类)。fork `app/settings.css` 已分叉为自有 1241 行体系(移动端子页+配置中心),无 bug 语义,不移植。 |
| `4e50c172` | 升级 Pi 到 v0.84.0 | ➖ | fork 已在 `@earendil-works/*` 0.84.4(package.json),高于该提交目标;其中 auth 路由相关改动已被 fork 现行文件覆盖。 |
| `2bb48f5e` | 升级 pi 到 0.99.1(v0.10.0 落在 SDK 1.0.0) | ➖(跨桶) | 依赖升级属运行时桶统一决策(fork 0.84.4 → 1.0.0 影响 rpc-manager/pi-types/models-cache 全链)。对本桶的影响面:`ModelRuntime` API 形状(本桶 ✅/🔧 项均已按 0.84.4 验证存在)、`lib/pi-types.ts`。models 侧无单独动作。 |

## 计数与优先级

✅4(beb32a99、92ae057b、586d72ee、79894b9a)· 🔧7 行 10 hash(499aa4fb、d8f89c51、7aaeff97、bd85004d、0b0d04c2+e932d979、50f6cce9+8800b5a0+058341d8、3e1f4361)· 🛡️11 hash · ⏭️2 · ➖13 hash(含 2 个升级提交)。合计 39。

建议落地顺序:① 499aa4fb(数据丢失)② beb32a99 + 3e1f4361(安全)③ 92ae057b/586d72ee/79894b9a/bd85004d(小件顺手)④ 0b0d04c2+e932d979(双 auth+挂起)⑤ d8f89c51→7aaeff97(discovery 成对)⑥ 50f6cce9 大件独立排期。

---
# 批次 E 审查:上游 v0.9.1→v0.10.0 session 命名/搜索/统计 + i18n + PWA vs fork(@qccoder/pi-web)

> 生成于 2026-10-07。分支 `upstream-sync/0.10.0`(HEAD `428c6f0`,工作树只读)。
> 上游 = `agegr/pi-web`;file:line 均指本分支工作树。判定:✅ 已移植/已带 / 🔧 需移植或需修 / 🛡️ 本地已有等价物或已规避(附 file:line)/ ➖ 不适用 / ⏭️ 纯测试基建。

## 桶级总结

- **总量**:54 个提交 → ✅12　🔧13　🛡️16　➖12　⏭️1。✅ 集中在 push/通知/manifest/图标/gzip/图片预览等 PWA 与已点名移植项;➖ 集中在 fork 无对应面的上游 UI(MCP 配置面板、设置面板整理、Catppuccin 图标、Windows 驱动器)。
- **最值得移植的 🔧(按价值降序)**:① `b3c7255` 会话文件引用授权不加区分地信任全部 transcript 字符串(system 消息/扩展工具结果可授权任意路径)——安全向;② `50a2fd4` 尾窗把 toolResult 消息计入 tail 预算,agent 重度会话可见消息被挤瘦;③ `974c8bb` 会话命名仍全量克隆 transcript(成本随会话长度线性涨,上游实测 74k tokens/3.8s);④ `b4a4539` sw.js 导航/资产 fetch 无超时,死上游可致 PWA 导航永久挂起;⑤ `e83f4b5` 删除会话不级联 subagent 后代,运行中的 child wrapper 留在 daemon 里继续烧 token。
- **i18n 关键发现**:**fork 当前分支完全没有繁体中文**——`lib/i18n/messages/` 仅 en.ts + zh-CN.ts,registry.ts:46-47 只注册两个 locale(`fd1593c` 的 zh-TW 从未进 fork;与「fork 自带英/简中/繁中」的预期不符)。其余 i18n 差距均为键级微修(894c735 一词、8b084d3 一个 format 函数)。
- **🛡️ 主因**:fork 的持久化 session 索引(mtime+size 增量、schemaVersion 2)+ 尾窗/ETag 架构把上游 #625/#526/#912/#928 的性能动机大部覆盖;daemon 拓扑把 #455(瞬态会话)/#440(未落盘删除)的等价机制放在了 `/v1/sessions/live` 合并层;push/通知系列移植时整体带入,已含 `renotify` 等后续修复。
- **意外收获**:上游 #457(`3ea687c`,TSV 外、任务点名)在 fork 已由**数据层统一折叠**覆盖(`lib/session-index.ts:174`、`lib/session-reader.ts:26`),比上游在 Sidebar 显示层折叠更早、更全(含截断 wrapper 场景)。

## 主表:✅ / 🔧 在前

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `09383ae` | 大 JSON 响应 gzip(#731) | ✅ | `d3ef787` port(sessions): `lib/json-response.ts` 已存在并用于 sessions 列表/详情/搜索路由(app/api/sessions/search/route.ts:6)。 |
| `edf0deb` | 删除未落盘运行时会话(#440) | ✅ | `0b52c89` fix(audit): DELETE 对 `!existsSync` 走 teardown+双缓存失效后答 ok(app/api/sessions/[id]/route.ts:297-305)。 |
| `3e9fcfa` | iOS 后台 push 真正可达(#728) | ✅ | `df3857e`+`32f07a1`+`2d75ad3` 三连移植:服务端 Web Push(`lib/web-push.ts`)、客户端订阅(`lib/push-client.ts`)、SW push/notificationclick(public/sw.js:66-131)、Settings 注册。sw.js:76-81 保留「有窗口也总是弹系统通知」的 iOS 订阅保活语义。 |
| `044af0e` | agent 会话结束浏览器通知(#356) | ✅ | 随 `2d75ad3` push 移植带入:`lib/browser-notifications.ts` + AppShell 接线 + i18n 键。 |
| `edf574a` | 重复完成通知 renotify(#701) | ✅ | 两处 `renotify: true` 均已带:`lib/browser-notifications.ts:75`、`public/sw.js:86`(push 系列移植整体晚于上游 #701,直接带入终态)。 |
| `99d4ea1` | manifest 去 orientation 尊重系统旋转锁(#379) | ✅ | `0f1db81` port(pwa):app/manifest.ts 已无 orientation。 |
| `b315bd3` | 不透明 PWA 图标保 iOS 主屏可读(#718) | ✅ | `a3a9122` port(pwa):图标二进制与该提交一致(blob hash 相符);但终版被 `8c18f21` 覆盖,见下。 |
| `06bb7ac` | compaction 后标题生成(#381) | ✅ | `f703c75` port(fix):lib/session-title.ts(在 `generateSessionTitle` 允许 compactionSummary 充当可命名内容,:223-227);daemon 侧入口 lib/daemon/http-sessions.ts:295-310。 |
| `8640559` | session token 统计含平均缓存命中率(#471) | ✅ | `fc58536` port(stats):hooks/useAgentSession.ts:476-516 统计口径含 cacheHitRate。 |
| `e851d30` | 聊天图片点击预览(#450) | ✅ | `31856ba` port(view):components/ImagePreview.tsx(另有 `4972229` composer 侧图片预览)。 |
| `9ebe18a` | 超大消息渲染防冻结(#418) | ✅ | `464381e` port(fix):MessageView 100KB+ 守卫已带。 |
| `edf4c5d` | 关机时 dispose agent 会话 | ✅ | 被更强移植覆盖:`d70452a`(upstream d728526)让**每条** destroy 路径都发 session_shutdown 并 `inner.dispose?.()`(lib/daemon/rpc-manager.ts:794-811),关机只是其中之一。 |
| `b3c7255` | 文件引用授权:不信任 system 消息与非编码工具结果 | 🔧 | 上游机理:`/api/files?sessionId=` 用「路径字符串是否出现在 transcript」授权读取根外文件;system 消息(含全部工具 schema)、codemode store、context_edit、MCP/第三方扩展工具结果都携带远方可控文本,任意字符串即授权 → 收窄为:仅 pi 编码工具 + subagent 工具的结果可信,不可信结果只授权其 `fullOutputPath` 与 nestedCalls 中编码工具参数。fork 同样漏洞:`lib/session-file-references-core.ts:67-72` 对**每个 entry 无差别** `collectStrings`(经 `lib/session-file-references.ts:14` 供 /api/files 使用)。fork 虽无 MCP 面,但 system 消息与扩展工具结果路径同在。修复:把上游 `collectEntryStrings`/`PATH_REPORTING_TOOL_NAMES` 移植进 core 模块(纯函数+测试,半天)。 |
| `50a2fd4` | 尾窗只数可见消息(#810) | 🔧 | 上游机理:tail 预算按原始 entry 计数,toolResult/隐藏 custom 也消耗额度 → agent 重度会话(实测 15 user/562 entries)50 条窗口只剩 1 条用户消息;修复=只有 user/assistant/compaction divider 计数,另加 raw 上限(`max(200, tail×6)`)。fork 同样形态:`lib/session-reader.ts:262-265`(以及 :313-316 的 /earlier)把 `entryToUiMessage` 非 null 的都计入——toolResult 消息映射非 null 即占预算,而 UI 可见消息只算 user/assistant(components/ChatWindow.tsx:567,toolResult 挂到 assistant 工具卡 :848-851)。tail=100 比上游 50 缓解但形态一致。修复:窗口收集循环只对 user/assistant/compaction 计数 + raw 上限,小时级。 |
| `974c8bb` | 有界 transcript 会话命名(#807) | 🔧 | 上游机理:旧法克隆整个 agent state(system prompt+全部消息+shadow 工具)再追加命名请求,成本随会话长度线性涨(实测 120 轮 74k tokens/3.8s);新法=纯文本 transcript(用户轮 800 字/回复 300/末回复 600/摘要 600,总预算 6000 字、40% 保头部)+ 一次性流(新 sessionId、cacheRetention none、maxTokens 256、最廉价 thinking 档),且不再 waitForIdle(可 mid-turn 命名)。fork 即旧法:`lib/session-title.ts:217-239` 全量 `sanitizeTitleMessages`(保留全部 tool call/result,仅剥 skill XML/悬空调用)+ `waitForIdle`(:219)+ 复用 sessionId(:65)。落点自洽:仅 daemon 侧此一个文件 + 测试。半天-一天。 |
| `b4a4539` | SW fetch 加超时防死上游挂死(#879) | 🔧 | 上游机理:可达端口后死上游 accept 连接后永不响应,`fetch()` 既不 resolve 也不 reject → 网络优先的导航 fallback 到 offline.html 的 catch 永不触发,PWA 导航无限挂起;修复=`fetchWithTimeout`(8s,响应头到达即清计时器,SSR 流式 body 不截断)。fork 原样存在:public/sw.js:47-55(navigate)与 :133-143(cacheFirst)均为裸 `fetch`。修复:照抄 `fetchWithTimeout` 包装两处+测试,1-2h。 |
| `e83f4b5` | 删除会话级联删除 subagent 后代 | 🔧 | 上游机理:合并持久目录+live registry(+目录兜底扫描)构建 parent→children 关系图,BFS 级联删除持久后代并 abort 运行中的 child(旧语义是 re-parent,孤儿 child 对用户不可达仍占磁盘/烧 token)。fork 即旧语义:DELETE 只把直接子文件 header 重指向祖父(app/api/sessions/[id]/route.ts:299-330);daemon `destroySession` 只销毁被删 id 的 wrapper,运行中的 child wrapper 留在 registry 继续跑。残留面:child 对每个列表都隐藏(subagent-child.ts),删除父后永久不可达。修复:web DELETE 前(listAllSessions+`/v1/sessions/live`)收集后代 → 逐个 destroy+unlink;半天含测试。 |
| `70c871b` | 工具结果图片内联渲染(#499) | 🔧 | 上游机理:详情 payload 剥离工具结果 base64 图,UI 内联渲染并经 `entries/[entryId]/tool-result-image` 路由懒加载历史图片。fork 有剥无回:`omitToolResultBase64Images` 把历史工具图片永久降级为占位文本(lib/session-reader.ts:360-384),useAgentSession 全部带 `deferMedia=1`(:570,:654,:693),无对应回取路由(thinking 有:entries/[entryId]/thinking;图片没有)→ 截图类工具的历史图片用户永远看不到(仅 live 事件可见)。修复:仿 thinking 路由加 tool-result-image 端点 + MessageView 展开加载;半天-一天。 |
| `f5e768e` | Stop 能终结被幸存者占住的命令(#1016) | 🔧 | 上游机理:pi 的 abort 杀进程树后仍等所有继承的 stdout/stderr 句柄静默,detached 幸存者可无限拖住工具调用(连带 Stop/steering);修复=project-command-env 包一层,abort/timeout 后 1s 宽限即 release 输出并以 pi 自身错误终结。fork 无此包装:daemon `abort_bash` → `inner.abortBash()`(lib/daemon/rpc-manager.ts:776)直通 SDK;幸存者可拖住 isBashRunning,粗安全网只有 10min idle→destroy→dispose(:794)。修复:在 daemon 创建 SDK 会话处包 BashOperations(移植上游 project-command-env 思路);需注入点论证,1 天内。 |
| `fd1593c` | 繁体中文 locale(#512) | 🔧 | **fork 全缺 zh-TW**:`lib/i18n/messages/` 仅 en.ts/zh-CN.ts;`lib/i18n/registry.ts:46-47` 只注册两者;`resolveBrowserLocale` 把所有 zh-* 归 zh-CN(:40-43);全历史无 zh-TW.ts。若确需繁中:新增 messages/zh-TW.ts + 注册 + resolve 增加 `zh-TW/zh-Hant` 分支(SessionSidebar 语言菜单自动出现)。注意 fork 侧 en/zh-CN 键集与上游已分叉,不能直接抄上游 zh-TW,需按 fork 键集翻译;1-2 天。 |
| `8b084d3` | provider 用量非当日更新时间显示相对时间 | 🔧 | 上游机理:旧 `formatUpdated` 恒显当日时刻,昨天的报表也显示成「今天 HH:MM」;修复=新增 `formatUpdatedTime`(今天显时刻、更早走 formatRelativeTime)+title 显示完整时间。fork 原样:components/ProviderUsageSummary.tsx:160 `toLocaleTimeString` 无日期判断。移植 `lib/i18n/format.ts`(已有 formatRelativeTime :47)加函数+替换调用点;1h。 |
| `776f801` | 外观跟随系统主题模式(#408) | 🔧 | 上游:theme 增加 "system" 档(matchMedia prefers-color-scheme + 变更跟随 + 无闪烁初始化)。fork 只有 light/dark 手动切换:hooks/useTheme.ts:5,无 system 档、无 OS 变更监听。低优先 UX 增强;半天。 |
| `680db65` | 文件夹选择器内新建目录(#981) | 🔧 | 上游:DirectoryPicker 支持就地 mkdir(含 i18n 键);fork 的 DirectoryPicker/directory-browser/cwd/browse 无任何建目录能力(grep mkdir 无命中)。fork 有新建工作区流,选 cwd 时无法直接建新目录;低优先,2-3h。 |
| `8c18f21` | 图标改透明底+不透明白 π(终版) | 🔧 | 纯二进制资产跟进:fork 图标 blob == b315bd3 版(apple-touch/icon-192/icon-512/favicon.ico 四件全比对),未更新到 8c18f21 终版(透明底避免 Android 圆角外黑块)。直接 `git checkout 8c18f21 -- <4 files>` 即可;10min。 |
| `894c735` | i18n:主工作树措辞修正 | 🔧 | zh-CN `sidebar.main` 应为「主工作树」而非「主分支」(git worktree 语义);fork `lib/i18n/messages/zh-CN.ts:122` 仍为「主分支」。一词修改,随其它 i18n 键批量带上。 |
| `3ea687c`(TSV 外,#457) | auto-name 回退标题剥离 skill XML | 🛡️ | 上游在 **Sidebar 显示层**折叠(displayFirstMessage)。fork 在**数据层**更早完成:`lib/session-index.ts:174`(索引期 firstMessage=skillMessageTitle(...))、`lib/session-reader.ts:26`、`app/api/sessions/[id]/route.ts:205`;`lib/skill-message.ts:41-56` 的 skillMessageTitle 还处理了「400 字截断导致 `</skill>` 丢失」的上游未覆盖形态。SessionSidebar.tsx:1858 / WorkspaceSessionList.tsx:259 拿到的 firstMessage 已是折叠后文本,XML 不可能泄漏。 |
| `234e19e` | 会话列表/搜索性能五合一(#928+#912) | 🛡️ | 子项对照:①搜索随 list 版本重拉——fork 保留 refreshKey=listVersion(components/SearchPalette.tsx:104;useSessionActivity.ts:85 注释为有意设计),残留在活跃 agent 场景结果重排,属低危 UX 取舍;②重建目录成本——fork 持久索引 mtime+size 增量,重建只花在变更文件,远强于上游「保留 stale 目录」的需求(lib/session-index.ts);③summary=1/延迟水合——索引跨重启持久,首屏成本仅首次冷启动付一次;④SessionManager 字节上限缓存——fork 无长驻解析缓存(每次读取重开 SessionManager.open,lib/session-reader.ts:227-231),无 1.1GB 钉死问题(代价是每次全量解析,fork 已知取舍);⑤context tail 50→200——fork 客户端固定 tail=100(useAgentSession.ts:570)+/earlier 回翻,数量级等同。 |
| `8cbafdd` | 跨扫描/重启缓存未变更会话元数据(#625) | 🛡️ | fork 的 `lib/session-index.ts` 是**持久化磁盘索引**(schemaVersion 2、mtime+size 增量、跨重启),覆盖面比上游内存级缓存更广;另有 3s TTL+代数失效+并发合流(lib/session-reader.ts:66-129)。(0.8.2→0.9.1 审计 §4 同判) |
| `1906134` | 免全目录扫描解析会话路径(#526) | 🛡️ | fork 双向 path cache(lib/session-reader.ts:141-157,sessionId↔path)+ 失效精确摘除;miss 时 `listAllSessions()` 走增量索引而非全量重解析。 |
| `cd6032b` | compaction 分页后历史完整 | 🛡️ | fork 服务端尾窗 + `/earlier` 锚点回翻(lib/session-reader.ts:232-332);compaction entry 映射为带 firstKeptEntryId 的 custom 消息(:405-419);compaction_end → reloadSession 全量替换缓存。分页偏移错位机制不存在。(0.8.2→0.9.1 审计 §3-1 同判) |
| `99fc442` | 有界读取会话关系 | 🛡️ | fork 无「逐文件读头部关系条目」的扫描面:`readSessionHeader` 本就有界(64KB 首行,lib/session-reader.ts:195-224);subagent 关系从已物化消息的工具流量派生(lib/session-subagents.ts:147)+索引 header.parentSession,无需再界。 |
| `9cf8d4d` | 父文件缺失的会话可删(#659) | 🛡️ | fork 删除路径不读父文件:只读被删会话自身 header 取 parentSession,把孙辈重指向该值(app/api/sessions/[id]/route.ts:299-330)——缺失父只意味着「重指向一个不存在的路径」,无崩溃。(0.8.2→0.9.1 审计 §3-5b 同判) |
| `39e50e0` | 删除时 subagent 关系双表示一致 | 🛡️ | fork 主关系表示=header.parentSession(DELETE 已重写)+ live map(随 wrapper 销毁消失);上游 persist 化 SUBAGENT_META 条目的双写问题在 fork 的主要链路不存在。残留:child 文件内持久化运行记录(lib/subagent-runtime.ts:246-247 写 parentSessionId/Path)在 re-parent 后不回写,仅影响 e83f4b5 落地后的孤儿场景,随其一并处理。 |
| `d2d7f22` | 瞬态(未落盘)会话可访问(#455) | 🛡️ | fork 等价物在 daemon 层:`/v1/sessions/live` 返回全部存活 wrapper 元信息(lib/daemon/http-sessions.ts:128-133),web 列表路由做「磁盘列表+live 合并」(app/api/sessions/route.ts:22-28 → lib/session-payload.ts);GET 详情先查 live 再查盘(http-sessions.ts:199)。 |
| `5179734` | 降低 agent 消息开销 | 🛡️ | 上游按事件类型门控 running 广播与 idle 重置。fork 的 `notifyRunningChange` 以运行 id 集合快照去重(lib/daemon/rpc-manager.ts:1366-1375),每事件成本仅为小数组 stringify;idle timer 按事件重置是 fork 的活性心跳语义(有意)。auto-name 无 SessionManager.open 取 cwd 的浪费(命名在 daemon 内直接持有 wrapper,http-sessions.ts:295-310)。 |
| `e4b4743` | subagent 会话切换器 | 🛡️ | fork 自有等价物:SessionSubagents 抽屉(components/SessionSubagents.tsx,工具栏按钮+最近优先列表+点击 `onOpenSession` 打开 child 会话,含 live 流式 partial 即时计入 lib/session-subagents.ts:150-160)。 |
| `c87a9a4` | 分支按首条消息命名(#449) | 🛡️ | fork BranchNavigator.getLabel 已按分支首条消息文本(40 字截断)标注(components/BranchNavigator.tsx:59-80),等价实现。 |
| `353757b` | 会话面板 Project Info(git 分支/worktree)(#605) | 🛡️ | fork 索引携带 worktreeBranch(lib/session-reader.ts:60),会话面板展示(components/SessionSidebar.tsx:2044-2055)。 |
| `1bd40e4` | minimap 悬停显示每轮工具调用数(#939) | 🛡️ | fork 的 ChatMinimap 悬停预览已展示该轮工具**名列表**(components/ChatMinimap.tsx:35-38 join(", ")),信息量 ≥ 上游的计数徽章。 |
| `9d1721f` | 侧栏拖拽调宽+localStorage(#266) | 🛡️ | fork 自有实现:DesktopShell 侧栏拖拽把手+双击重置(components/shell/DesktopShell.tsx:568-574),宽度持久化(:950 注释,localStorage,默认 CSS 42%)。 |
| `ed50d88` | 会话/文件面板可调宽(#825) | 🛡️ | 同上:右面板(文件/dock)拖拽把手+双击重置(DesktopShell.tsx:933-950)。fork 布局为自有 desktop shell 设计,非上游 AppShell 双栏。 |
| `4cc0770` | submodule worktree 强删确认(#1007) | 🛡️ | 底层已备:`removeWorktree(cwd, path, force)`(lib/worktree.ts:212-219)接受 --force;残缺「git 拒绝(dirty/submodule)→ 弹确认→ 带 force 重试」的 UX 流(worktreeRemovalRequiresForce 等价物无),低优先补齐即可。 |
| `9d5b077`+`de91212`+`570f355` | MCP 配置面板 UI 三连(Code mode 窗格/Add 输入框文案) | ➖ | fork 分支上零 MCP 面(`git ls-files | grep -i mcp` 为空,无 McpConfig/McpAddServer);此前 grep 到的 MCP 提交均属 upstream 分支而非本 fork。若未来移植上游 MCP 面板,这三个修复随附。 |
| `fe288c0` | #907/#946/#968 评审跟进 | ➖ | 主体是 open-in-explorer 授权顺序修复+注释英文化——fork 无 open-in-explorer 路由(基特性未移植);npm-source 拆分针对上游 subagents↔plugin-updates 依赖纠缠,fork lib/subagents.ts 无此 import;DismissButton/Sidebar 微调随各自特性。 |
| `092b5d4` | 设置外观控制简化+重置 | ➖ | 上游 SettingsPanel/settings.css 的整理;fork 有自己的 SettingsPanel/SettingsUi/ConfigCenterPage 体系,无对应整理需求。 |
| `ffb2daf` | 文件面板全宽开关(#790) | ➖ | fork 右面板(DesktopShell dock)为自有布局,已有拖拽调宽;全屏铺满开关为可选增强,缺之无害。 |
| `a3f6167` | 下游 fork 上下文菜单钩子 | ➖ | 上游为 downstream fork 提供的 SessionSidebar 注入 API;fork 用自有 WorkspaceSessionList(无右键菜单),钩子无宿主。若想要会话行右键菜单,直接在自有组件实现更简单。 |
| `248aaf4` | Windows 驱动器选择 | ➖ | fork 运行面为 macOS(darwin);directory-browser 虽有 win32 分支残迹(:22)但无驱动器列举。将来支持 Windows 再移植。 |
| `dc65365` | Catppuccin 彩色文件图标(#321) | ➖ | fork 文件图标为自有的扁平单色内联 SVG 设计(components/FileIcons.tsx 头注释言明 currentColor 设计);换 Catppuccin 为纯美学偏好,含数百个 SVG 资产。 |
| `f3c5aa5` | 活跃时长对齐会话信息(重构) | ➖ | 上游把「活跃时长」从独立脚标挪进信息行并改标签文案;fork 自有 ChatToolbar 布局(components/shell/ChatToolbar.tsx:1009-1018)已展示该指标(端口自 360667c=474817b),纯上游 UI 对齐无行为差异。 |
| `0ff32dd` | docs(i18n) 验证步骤用 npm test(#759) | ➖ | 纯文档:fork 的 docs/i18n.md:155 已按自有 runner 写 `node --test lib/*.test.mjs`,无错可修。 |
| `f57b565` | 保留含扩展工作的会话(#705) | ➖ | 上游 liveness 注册表让扩展登记活跃工作以豁免清扫。fork:destroy 已 dispose+发 shutdown(d70452a);心跳击杀豁免 pendingUi(rpc-manager.ts:1246-1248);扩展以工具形式干活时事件持续喂心跳;已知扩展形态(subagent 工具、widget)均不在残留风险面。(0.8.2→0.9.1 审计 §3-5c 同判) |
| `7672aa0` | i18n registry 测试模块加载修复 | ⏭️ | 纯测试基建:上游用 jiti 替代直 import .ts。fork 运行 Node v24.18.0(`npm test`=node --test)原生 strip-types,直 import 可用——fork 内 15 个直 import 测试与 35 个 jiti 测试并存且通过;无需改动。 |

## 🔧 修复建议清单(按风险/价值降序)

| # | 项 | 上游 | fork 落点 | 工作量 |
|---|---|---|---|---|
| 1 | 文件引用授权收窄(安全) | `b3c7255` | lib/session-file-references-core.ts:67-72 换 collectEntryStrings + 编码工具白名单 | 半天 |
| 2 | 尾窗按可见消息计数 | `50a2fd4` | lib/session-reader.ts:262-265/:313-316 计数条件 + raw 上限 | 半天 |
| 3 | 有界 transcript 命名 | `974c8bb` | lib/session-title.ts 重写(仅 daemon 用,自洽) | 半天-1天 |
| 4 | SW fetch 超时 | `b4a4539` | public/sw.js:47-55/:133-143 加 fetchWithTimeout | 1-2h |
| 5 | 删除级联 subagent 后代(含运行中 child) | `e83f4b5` | route.ts DELETE + daemon destroy 扩展 | 半天-1天 |
| 6 | 工具结果图片懒加载 | `70c871b` | 新路由 entries/[entryId]/tool-result-image + MessageView | 半天-1天 |
| 7 | bash 幸存者 release | `f5e768e` | daemon SDK 会话创建处包 BashOperations | 1天内 |
| 8 | 繁中 locale(如需) | `fd1593c` | messages/zh-TW.ts + registry + resolveBrowserLocale | 1-2天 |
| 9 | 微修包:formatUpdatedTime / 图标 4 件套 / 「主工作树」 | `8b084d3`+`8c18f21`+`894c735` | lib/i18n/format.ts、public/icons+favicon、zh-CN.ts:122 | 共 2h |
| 10 | 可选:system 主题档 / 选择器建目录 | `776f801`+`680db65` | hooks/useTheme.ts、DirectoryPicker | 各半天 |

---
# F 桶审查:core libs / 依赖 / 构建 / bin / docs / release(128 提交)

> 生成于 2026-10-07。fork 分支 `upstream-sync/0.10.0`(HEAD `428c6f0`),merge-base `6885309`(PWA,约 v0.8.2 期)。上游指 `agegr/pi-web` v0.8.3..v0.10.0。file:line 均指本 fork 工作树(只读核对)。
> 判定图例:✅ 已在 fork(移植或等价)/ 🔧 建议移植或需适配 / 🛡️ fork 架构已规避或有等价物(给 file:line)/ ➖ 不适用 / ⏭️ 整族或整类跳过。

## 桶级总结

1. **依赖版本对照(必读)**:fork `@earendil-works/pi-agent-core|pi-ai|pi-coding-agent|pi-tui` 全部 **0.84.4**(upstream 从未驻留的中间版)vs upstream v0.10.0 的 **1.0.0**;演进链(本桶内提交)= 0.84.1(`6a76151`)→0.84.2(`febcba5`)→0.85.1(`06ed14f`,需改 PlainTextTheme ctor)→0.87.1(`b908729`,模型目录/compaction 修复)→1.0.0(`e77a4e5`,MCP OAuth keying/codemode alias;链上另有 `55164b5`/`da1b28b`/`2bb48f5` 三跳不在本桶)。next **16.2.12 vs 16.3.6**(16.3.5 是安全版,`e5a2434`/`af0b592`/`79c2a44`),undici 8.5.0 vs 8.11.0;upstream 新增 prod `semver`/`proper-lockfile`/`js-yaml`,fork 另用 `yaml`+`typebox`。**结论:升级是 🔧 而非直接 bump**——0.86 起 `agent.state.systemPrompt` 变 getter「never assign」,而 fork 有两处赋值(`lib/daemon/rpc-manager.ts:375,1525`)会坏;0.85 的 Theme ctor 键需同步 daemon PlainTextTheme;前审计 §7 的「快照事件语义」🛡️ 根基升级后需重验。
2. **安全第一优先**:`5d07375`+`6ad18cd` —— fork 无任何 project-command-env 隔离,daemon sidecar 全量继承 web env(`lib/session-daemon/sidecar.ts:48-59`)、terminal 全量复制 env(`lib/terminal-manager.ts:45-49`)→ **`PI_WEB_PASSWORD` 经 agent bash `env` 进入模型上下文与会话转录**。
3. **正确性高优先三连**:`a3f24ea`(listeners 数组 mid-emit splice 丢事件,fork 同款且有 onStall 真实触发器)、`31f0505`(proxy body 10MB 截断,fork 有 proxy.ts + 100MB uploads 却无 `proxyClientMaxBodySize`)、`aed0f3c`/`34c8cdf`(wrapper 关闭竞态,fork `onDestroy` 按 id 无条件删 registry 会误删替代 wrapper)。
4. **推翻前审计一个 ➖**:fork 的 `pi-web` CLI 仍是 wrapper(`bin/pi-web.js:65` spawn Next 子进程)且**零信号转发** → `7152653`/`36f01a3`(SIGTERM 孤儿 Next 子进程)对 fork 成立。
5. **前审计 ⚠️#1 已修复**:`d728526`(session_shutdown+dispose)已在 fork `destroy()` 落地;`e70c367`(apply_patch)、`2e914db`(UTF-8 locale)、`1218381`(LAN dev)也已 ✅。
6. **前审计一个 ➖ 已过时**:fork 现在**确实写 SKILL.md**(`app/api/skills/route.ts:60-81` toggle)→ `ff63346`/`70d3896` 变为活风险(显式 `false` + 开启 = 重复键)。
7. **MCP/Code mode 全家族(31 提交)⏭️**:fork 零落点(`lib/mcp-*`、`lib/builtin-extensions`、`app/api/mcp`、`app/api/tools`、`components/Mcp*` 全缺),整族跳过;ADR-0006(`89bd25b`)留作未来路线图;`d1283eb` 的 trust-fresh 语义 fork 已由每次 start 新读天然满足。
8. 统计:✅5 / 🔧33 / 🛡️11 / ➖9 / ⏭️70(release 15 + docs 13 + CI/test 8 + chore 3 归并行)。

## 主表

| hash(es) | 主题 | 判定 | 机理与 fork 落点 |
|---|---|---|---|
| `d728526` | 每条 dispose 路径发 session_shutdown | ✅ | fork `destroy()` 已发 `session_shutdown`(经 extensionRunner.emit)+ `inner.dispose?.()`,覆盖 idle/心跳/删除/fork 全路径(`lib/daemon/rpc-manager.ts:805-830`)。前审计 ⚠️#1 已落地。 |
| `e70c367` | apply_patch 渲染为 split diff(#744) | ✅ | fork 已移植适配:`components/MessageView.tsx:13-14,1138,1197`(注释明示 upstream e70c367)+ `lib/apply-patch.ts`。 |
| `2e914db` | 终端默认 UTF-8 locale(#751) | ✅ | fork 逐字同款:`lib/terminal-manager.ts:54`(`!LANG/!LC_ALL/!LC_CTYPE → C.UTF-8`,含 Windows 大小写注释)。 |
| `1218381`+`1e20164` | LAN/loopback dev server 访问 | ✅ | fork `next.config.ts:27-31` `allowedDevOrigins`(127.0.0.1/100.64.0.10/192.168.*.*);dev 绑 127.0.0.1、`dev:lan`/`start:lan` 走 0.0.0.0(package.json scripts)。前审计 §6 已核对。 |
| `5d07375`+`6ad18cd` | 项目命令环境隔离 / PI_WEB_PASSWORD 防泄漏(#487) | 🔧 安全·最高 | 上游 `lib/project-command-env.ts` 剔除 PORT/NODE_ENV/NEXT_*,`6ad18cd` 再剔 `PI_WEB_PASSWORD`(密码会经 agent bash `env` 进模型上下文+转录)。fork 无该模块且两路全继承:① daemon spawn `{...baseEnv}`(`lib/session-daemon/sidecar.ts:48-59`)→ daemon 内 agent bash 泄密码;② web 终端 `shellEnvironment()` 全量复制(`lib/terminal-manager.ts:45-49`)。修法:`sidecarSpawnEnv` 剔 `PI_WEB_PASSWORD`(daemon 鉴权不依赖它,daemon HTTP 是 localhost)+ terminal env 剔除清单。 |
| `a3f24ea` | emit 中途 unsubscribe 丢事件 | 🔧 高 | 上游:listeners 数组 + splice 在 for..of 迭代中删当前项 → 下一 listener 被跳过(两 tab 场景第二个收不到 session_shutdown)。fork 同款(`lib/daemon/rpc-manager.ts:197,380,417-419`),且本地有真实触发器:SSE writer 的 `onStall` 在 `writeEvent` 内同步 fire(`lib/daemon/sse-writer.ts:57-63`)→ `http-sessions.ts:48-62` cleanup → unsubscribe,splice 发生在 `emit()` 循环里 → 多 viewer 同 session 时被 stall 切断者的下一个 viewer 丢当前事件。改 `Set`(3 行)。 |
| `31f0505` | proxy body buffer 10MB 截断(#846) | 🔧 高 | 上游:proxy/middleware 存在时 Next 缓冲请求体,默认上限 10MB;uploads 接受 100MB → 超限静默截断报 "Failed to parse body as FormData"(500)。fork 全中:有 `proxy.ts`(matcher `/api/:path*`,`proxy.ts:64`)、uploads 上限 100MB(`app/api/uploads/route.ts:16-17`)、`next.config.ts` 无 `experimental.proxyClientMaxBodySize`。一行配置修(128mb)。 |
| `6a76151`+`febcba5`+`06ed14f`+`b908729`+`e77a4e5`+`79c2a44`+`af0b592` | pi SDK / next / undici 依赖演进 | 🔧 | 见总结第 1 条版本对照。fork 升级时的适配点:① 0.85 Theme ctor 新 fg 键(`06ed14f` 给 PlainTextTheme 补 `muted/text` —— 同步到 daemon 的 PlainTextTheme);② 0.86+ `agent.state.systemPrompt` 变 transcript-replay getter:fork `get_state` 读(`rpc-manager.ts:508`)需改读 session 级 getter(对照 `6f92983`),**两处赋值**(`:375` 强制空 prompt、`:1525` subagent exact prompt)必须换机制,否则升级即坏;③ 0.87 收益 = 模型目录(Opus 5.5/GPT-6 等)+ compaction/provider 修复;④ 0.99/1.0 变更全在 MCP/codemode,fork 零落点;⑤ next 16.3.x 安全版 + `79c2a44` 的 prod install 裁剪(files 清表 fork 自有形态,不必跟)。 |
| `aed0f3c`+`34c8fdf` | wrapper 关闭即视为 gone / 等待 closing wrapper | 🔧 中 | fork 已有前半:`destroy()` 起点同步 `_alive=false`(`rpc-manager.ts:773-774`)。缺两点:① `startRpcSession` 见非 alive 即建替代(`:1414-1415`),不等旧 wrapper dispose → `session_shutdown` 处理器仍可能 append 同一 .jsonl 造成分叉、`dispose()` 按 sessionId 释放 provider 资源(如 Codex websocket)被替代共享(`34c8fdf` 机理);② `onDestroy(() => registry.delete(realSessionId))`(`:1554`)按 id 无条件删 → 旧 wrapper 迟到的清理会删掉**替代 wrapper** 的注册(aed0f3c 修的正是这个)。修:delete 前比对 entry 仍指向自己(3 行);可选移植 `PI_WEB_SHUTDOWN_DEADLINE_MS`(fork 现对 shutdown handler 无限等待,已有注释自觉接受)。 |
| `a8ba47e` | CJK 按 ~1 token 计 TPS(#467) | 🔧 中 | chars/4 对中文少估 4-5x。fork `components/MessageView.tsx` 无 estimateTokens/CJK 处理 → 中文会话 TPS 徽标与估 token 严重失真(fork 主场景即中文)。上游 estimateTokens+缓存纯函数可直接移植。 |
| `a3a79de` | in-hunk diff 行误判文件头(#394) | 🔧 中 | fork `lib/patch.ts:55-66` 对**每一行**(含 hunk 体内)做 `"--- "`/`"+++ "` 检测 → 内容以 `-- `/`++ ` 开头的增删行触发 mid-hunk flushChanges + 伪 SplitDiffFile,split diff 损坏(Markdown 列表、diff 套 diff 常见)。上游按 @@ 头行数预算只在 hunk 外找 header;parseUnifiedPatch 是纯函数+测试,整体移植。 |
| `ff63346`+`70d3896` | skill frontmatter 写坏 SKILL.md(#690/#519) | 🔧 中 | **前审计 §6 的 ➖ 已过时**:fork 现 skills toggle 确实写文件(`app/api/skills/route.ts:60-81`)。已见变体 bug:`alreadySet = Boolean(frontmatter[key])`(`:61`)把显式 `disable-model-invocation: false` 判为未设置 → 开启时再插一行 `true` ⇒ YAML 重复键(`70d3896` 同类);开栏 regex `^---\r?\n` 只认 `---` 栏,`...` 结尾/围栏变体(`ff63346`)未护。建议按上游把解析+写回归并单一 frontmatter 模块(带围栏变体测试)。 |
| `7152653`+`36f01a3` | wrapper 转发关机信号 / 报告子进程死因(#502/#597) | 🔧 中 | **推翻前审计 ➖**:fork 的 `pi-web` CLI 仍是 wrapper —— `bin/pi-web.js:65` spawn Next 子进程,但全文件(96 行)无任何 SIGINT/SIGTERM 处理 → `docker stop`/kill 只杀 wrapper,Next 子进程孤儿化(端口滞留到 grace 期 cgroup SIGKILL)。上游 `bin/process-lifecycle.js`(`wireChildProcessLifecycle`:转发信号+有界等待+死因诊断)可直接移植。daemon 存活不受影响(设计如此)。 |
| `e5a2434` | Next 16.3.5 + 关闭 image optimizer | 🔧 中 | fork 仅 `app/login/page.tsx:3` 用 next/image(静态 logo),但 `/_next/image` optimizer 开着且**不在 proxy matcher 内**(未认证面);上游动机即 GHSA-2xp9-vwfh-vxw4(sharp/libheif 攻击面)。`images:{unoptimized:true}` 一行 + 随依赖行升 next 16.3.x。 |
| `c04bab7` | file API 保 UNC 根 | 🔧 低(仅 Windows) | fork `encodeFilePathForApi`(`lib/file-paths.ts:8-14`)`split("/").filter(Boolean)` 把 `//host/share` 折成相对形 `host/share` —— 上游 AGENTS.md 明言这正是 403 根因;`getFileDirectory` 亦无 UNC 分支。fork 主打 macOS/Linux,Windows 部署才受影响;若支持 Windows 需整体移植(encode/decode 成对)。 |
| `82d1f54` | worktree 按真实路径匹配 | 🔧 低 | fork `removeWorktree` 直接 `w.path === worktreePath`(`lib/worktree.ts:214`),不先 realpath —— macOS `/var→/private/var` 下经链接的路径报 "Not a worktree"(上游 #1007 测试即因此在 macOS 恒挂)。包一层 `realPathOrSelf`。 |
| `744ee93` | worktree add 超时 / 远端起点(#732) | 🔧 低 | fork `git()` 固定 10s(`lib/worktree.ts:53`)→ 大仓(30k+ 文件)checkout 超时;新分支恒从本地 HEAD(`:197-205`)。上游终版 = 超时可参(`worktree add` 5min)+ 新分支优先 `refs/remotes/origin/<branch>`(不做隐式 fetch,离线安全)。 |
| `038057f` | write() 内容按文件文本渲染(#1024) | 🔧 低 | fork MessageView 无 `write` 特判(仅原始 JSON)。上游仅在 input 恰为 path+content 且非流式未完成时切文本视图,其余参数仍走 JSON —— 移植时注意这两个 guard。 |
| `a5fccdc`+`c8c63a1` | `pi-web --help` 启动选项(#574/#758) | 🔧 低 | fork `bin/pi-web-options.js:12-19` 仅 port/hostname/no-open,无 `--help` 与环境变量文档表。低成本补齐(fork 独有的 daemon/workspace 环境变量也应列入)。 |
| `16ef4a2` | DEP0190 自动开浏览器(#468) | 🔧 低 | fork `bin/pi-web.js:82-83` 仍 `spawn("start",[url],{shell:isWindows})` → Windows 启动打印 DEP0190。上游改 `cmd.exe /c start "" url`(argv 结构化)。 |
| `a84093e` | instrumentation Edge 入口分离 | 🔧 低 | fork `instrumentation.ts:2` 是上游修掉的「early return + 分支内动态 import Node 模块」同款形态 —— early return 不被 bundler 折叠,Edge 编译图仍含 Node API(dev 启动告警风险)。上游拆 `instrumentation-node.ts` + 正向 `NEXT_RUNTIME==="nodejs"` 分支。顺带:上游在同一处加的 SIGTERM 关 SSE(前审计 ⚠️#6)fork 仍未做,移植时一并考虑。 |
| `e2ea7da`+`cfcf2a1` | 代码块背景跨主题保持(#1060) | 🔧 低 | fork `components/MermaidBlock.tsx:280,295` 用 `background:` 简写 + `:286` 原样传 `vscDarkPlus` → 亮暗切换时 Prism 简写与 customStyle 的 backgroundColor 在 React diff 里互相重置(闪/丢背景)。上游:统一 `backgroundColor` + 剥离主题自带的 `background`。 |
| `d258d8d` | 用户消息气泡限高滚动(#419) | 🔧 低 | fork `UserMessageView`(`components/MessageView.tsx:228+`)无 maxHeight —— 超长粘贴把整个会话顶出屏幕。上游 cap 300px + 气泡内滚动。 |
| `90959d1` | minimap 数学公式轮廓(#349) | 🔧 低 | fork `components/ChatMinimap.tsx` 无 katex 处理,含公式消息的大纲显示原始 `$..$`(fork 有 katex 管线,消息本体已渲染)。 |
| `27cd09d` | slash 命令折叠显示(#338) | 🔧 低 | fork 有 slash 命令管线(`hooks/useAgentSession.ts:324`)但用户消息显示 SDK 展开全文;上游 `originalText` 注入(display-only)+ `lib/slash-display` 纯逻辑 + session-reader 逆匹配。UX 增强,可选。 |
| `b42d3f4` | 工具展开跨流式保持(#743) | 🛡️ | fork 自有 `usePersistentExpanded`(`components/MessageView.tsx:727-753`,注释即描述该问题:重挂载/流式更新不清用户展开态)。 |
| `18758b7`+`73104ba` | 工具选择跨导航保持 / withExtensionTools 不强开 | 🛡️ | fork 无 `setRpcSessionTools`/每次导航重设工具的路径:工具在 wrapper 创建期一次选定(`lib/daemon/rpc-manager.ts:1443-1451` setActiveToolsByName),wrapper 长寿(daemon),前端导航不触碰工具 → 上游竞态不存在。 |
| `9ede521` | 回收 Stop 无法收场的 run(#1017) | 🛡️ | 触发前提 `PI_WEB_IDLE_TIMEOUT_MS=0` 在 fork 不存在(idle 恒 10min);且 fork `destroy()` 主动 abort 在跑 run(`rpc-manager.ts:783-785`)+ 心跳监控击杀 silent-running(前审计 §1)双保险。 |
| `e9f954a` | idle 超时可配 PI_WEB_IDLE_TIMEOUT_MS(#665) | 🛡️ | fork 固定 10min(`rpc-manager.ts:383-391`)无开关;心跳体系下低价值,如需运维开关再移植(小时级)。 |
| `6f92983` | 首条消息前上报 system prompt(#974) | 🛡️ | SDK 0.84.4 下 `agent.state.systemPrompt` 仍是普通字段,fork `get_state` 读法(`rpc-manager.ts:508`)正确;**升级 ≥0.86 后此读法失效**——已并入依赖行 breaking 点②。 |
| `4fc2995` | 模型加载失败的安全文案 | 🛡️ | fork catch 直接返回裸 `EMPTY_MODELS`(`app/api/models/route.ts:117-119`),不插值异常文本;`modelError` 只经 `withModelRuntimeError` 定向构造 → 无路径/token 泄漏面。 |
| `f607816`+`06522eb` | enabledModels 警告抑制 / 裸 scope 歧义 | 🛡️ | fork 无 `lib/model-scope.ts`,models 路由精确匹配 + fail-open(前审计 §6:功能缺口非 bug,低优先)。 |
| `a6ba057` | factory 扩展 widget(#359) | 🛡️ | fork daemon 已支持 factory 自定义 UI:`factory(tui, PLAIN_TEXT_THEME, ...)`(`lib/daemon/rpc-manager.ts:914-945`);纯文本主题是 fork 有意取舍(前审计 §6)。 |
| `6960b2a` | Windows 目录浏览与打包(#399) | 🛡️ | fork `lib/directory-browser.ts:21-22` 已有 win32 路径分支;`outputFileTracingRoot` fork 未采用,但 npm 打包走自有 files 清表(package.json),形态不同、无该痛点。 |
| `6e95fba` | OpenCode Go 配额展示(#844) | ➖ | fork `lib/provider-usage-ids.ts` 无 `opencode-go`;功能增强,需要时按上游 adapter(含 baseUrl 回退到首个 model)补。 |
| `73008d5` | 版本检查开关(#485) | ➖ | fork 无 `app/api/app-update` 路由与更新检查,`PI_WEB_SKIP_VERSION_CHECK` 无落点。 |
| `404923e` | RISC-V 关 Wasm lazy(#823) | ➖ | fork 无 `bin/pi-web-node-args.js`;无 RISC-V 部署诉求。 |
| `fe684c8`+`9a103fb` | widget ANSI 渲染(#601)/单行 widget 展开(#539) | ➖ | fork widget 面向纯文本主题(前审计 §6:装 ANSI 风格扩展会显示转义码);两提交均无对应物,低优先。 |
| `80a44a5`+`88f7a77`+`19e6d25` | thinking 边框对齐 / 写文件标签主题图标(#415)/状态栏减淡 | ➖ | 纯样式微调;fork 自有 thinking 样式、无 TurnWrittenFiles 子系统、ExtensionStatusBar 自有配色,无逐一对齐价值。 |
| `101d08e` | 持久化显式新会话首选项 | ➖ | fork 无 `lib/startup-preferences.ts`;新会话默认模型走自有 workspace/会话机制,SDK 原子应用+持久化逻辑未移植(未逐点核对,低)。 |
| `58c1a21`+`04abe1c`+`dc460d1` | .gitignore(.agents/+skills-lock)/删除 bun.lock | ➖ | fork 根目录仍有 `bun.lock`(上游已删);若 fork 不用 bun 建议随上游删除防陈旧误导;`.agents/` ignore 与 fork 的 ~/.agents 用法不冲突。 |
| `30fe218`+`e299ab9`+`ba044f9`+`85f9cb1`+`d733d43`+`5d4c0b5`+`d1283eb`+`3dc123b`+`2ac2a0f`+`a2a31bd`+`207ce36`+`d85555e`+`922a9d7`+`6695979`+`9cf9547`+`0b2d4fa`+`d702bc6`+`6c599e9`+`7b3df71`+`834b6b8`+`e851b03`+`4e1edd8`+`b183176`+`0dee0f0`+`a87758e`+`cc697e6`+`eb6a4bd`+`4213e4b`+`89bd25b`+`2b93cbc`+`cb7003d`(31 提交) | MCP / Code mode 全家族(per-session host、readOnlyHint 策略、内置扩展、OAuth sign-in、Settings、粘贴导入、调用标签、ADR-0006) | ⏭️ | fork 零 MCP 落点:`lib/mcp-*`、`lib/builtin-extensions`、`lib/chat-phase-label`、`app/api/mcp`、`app/api/tools`、`components/Mcp*` 全缺。整族随 SDK 1.0.0 一起决策(见依赖行④)。备注:`d1283eb` 的「host sync 前新读 project trust」fork 已由 `projectTrustReloadOptions` 每次 start 新读(`rpc-manager.ts:1458`)天然满足;`834b6b8` 的工具描述保真只在 MCP/codemode 语境有意义(fork `get_tools` `:639-647` 报 SDK 注册描述,无 MCP 时与模型所见一致)。 |
| `804810e`+`c9b47e4`+`cbb080d`+`dfab585`+`07f873c`+`d9b534e`+`5a53c18`+`0877bff`+`2a6e537`+`28bab3c`+`0d1df12`+`8366762`+`040fadd`+`0876cf4`+`6fcd7d4`(15 提交) | Release v0.8.3→v0.10.0(含 beta) | ⏭️ | 纯 version + lockfile bump;实质变更已由依赖行与其余行覆盖。 |
| `99b2c3f`+`9f8447a`+`ed7a4d7`+`6edbecb`+`5b96a9d`+`17ad5c5`+`fad65c9`+`a91c830`+`a82cd54`+`cdaa6ba`+`afe9dc7`+`99dae1f`+`fdc28d5`(13 提交) | docs(AGENTS.md 结构/README 多语/排障) | ⏭️ | fork 的 AGENTS.md 已大改(daemon 架构),合并时不可直接套用;README 多语按需 cherry-pick。 |
| `dda61b2`+`effa464`+`2cae813`+`eac6f14`+`55df7d7`+`b1a7296`+`bf4713c`+`901f5ce`(8 提交) | CI(Node 22 pin、checks+e2e)与 test-only 更新 | ⏭️ | fork CI/e2e 自有形态;`2cae813` 引入的 playwright e2e 体系若想要需单独决策(devDeps 差异见依赖行)。 |

## 备注

- `e77a4e5`(pi 1.0.0)的 OAuth keying(`mcp__<name>|<url>`)、`codemode-deferred` 别名、`auth:{provider}` 等变更全部挂在 MCP 家族上,fork 无 MCP → 升级 1.0.0 的实际适配面只剩 Theme/systemPrompt/事件形状三点(见依赖行)。
- 判定随工作树状态而定:本文引用的 `rpc-manager.ts`/`MessageView.tsx` 行号基于 HEAD `428c6f0`,合并后需复核。
