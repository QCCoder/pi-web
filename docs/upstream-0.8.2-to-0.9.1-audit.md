# 批次 4 对照审计：上游 v0.8.2→v0.9.1 流式/SSE 与会话管理修复 vs 本地 daemon 化运行时

> 生成于 2026-09-20（T12）。分支 `upstream-sync/0.9.1-batch2`（HEAD `d2030c4`）。
> 所有 `upstream <hash>` 均指 `agegr/pi-web`；本地 file:line 均指本分支工作树（`WorkspaceSessionList.tsx`、`ChatInput.tsx`、`globals.css` 等用户保护文件按工作树现状只读引用）。

## 0. 范围与方法

- **范围**：移植计划 `docs/upstream-0.8.2-to-0.9.1-review.md` §2.1（流式/SSE 稳定性，11 行）与 §2.2（会话管理，8 行，其中一行拆 3 个子判定）逐条四栏判定；§3-10 性能专项三条 + 两条附注；§2.3–§2.7 计划外遗漏扫描。
- **方法**：每条先 `git show <hash>` 理解上游 bug 机理（不看标题望文生义），再在本地 daemon 架构中找对应路径，给 commit 哈希或 file:line 证据。判定从严：证据不闭合的标 ⚠️「待验证」。
- **四栏**：✅ 已随批次移植（本分支 commit）／🛡️ 本地已规避或已有等价物（架构机理 + file:line）／⚠️ 本地同样存在需修（复现推理 + 修复草图）／➖ 不适用（说明对应物）。

## 1. 本地架构一页纸

**进程拓扑**：Next（web）是主进程；`pi-daemon`（`bin/pi-daemon.js` → `lib/daemon/host.ts`）是**独占 AgentSession 的独立 daemon**，web 重启/hot-reload 时 daemon 存活（`lib/session-daemon/sidecar.ts:8-15`，probe-first attach，不在本机才 spawn detached）。web 路由是纯代理（`lib/agent-proxy.ts` → `lib/daemon/client.ts`），web 进程从不持有 live session。

**daemon 侧**：`lib/daemon/rpc-manager.ts` 的 `AgentSessionWrapper` 独占一个 SDK AgentSession（registry 挂 globalThis，键=真实 session id；交互会话、subagent child、kit 轮都在同一 registry）。wrapper `start()` 订阅 SDK 事件**原样转发**（`rpc-manager.ts:245-257`）；`onEvent` 支持多监听者，新订阅者只重放 `pendingUiRequests`（扩展阻塞对话框），`rpc-manager.ts:408-415`。事件出口 `lib/daemon/http-sessions.ts` 的 `serveSessionSse`（每连接独立监听 + 30s 心跳注释 + `onDestroy` 断流 + stall-bounded 写 `lib/daemon/sse-writer.ts`，防 2026-08-30 类 OOM）。生命周期安全网：10min idle timer、心跳监控（silent-running 自动打断，`rpc-manager.ts:1239-1262`，豁免 pendingUi 会话）。

**web/浏览器侧**：`lib/sse/global-agent-events.ts` 单例管理器，每个 running（或被观看 pin 住的）session 一条 `/api/agent/[id]/events` SSE；事件进 `applyAgentEvent`（`lib/agent/agent-event-reducer.ts`，纯函数）写 **SessionRuntimeStore**（per-session 分片）+ **SessionMessagesCache**（per-session 分片，SWR/ETag）；session-scoped effects（reloadSession/refreshAgentState）对所有 session 执行，UI effects 只送 active。韧性三层：EventSource 原生重连 + fatal 1s 重连（`global-agent-events.ts:110-155`）、pinned 会话断线后重探 `/state`（:160-185）、running 期间 15s reconcile 轮询 + visibility/online 触发（`hooks/useAgentSession.ts:956-975`）。会话列表走 mtime+size 增量的**持久磁盘索引**（`lib/session-index.ts`，schema v2）+ 3s TTL/代数失效（`lib/session-reader.ts:69-129`）；详情 GET 走 ETag/304 + tail=100 尾窗 + `/earlier` 回翻（`app/api/sessions/[id]/route.ts:147-217`、`lib/session-reader.ts:232-332`）。

**关键协议事实**：SDK 0.84.4 的 in-process `message_update` 事件携带**全量 message 快照**（`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:389-392`）；delta-only 的 JSON 协议（snapshot 剥除，见 `pi-coding-agent/dist/modes/json-event.d.ts:13-19` 注释）只用于 stdout JSON 模式——daemon in-process 订阅不走它。这是本地多处「快照语义自愈」的根据。

## 2. 主表：§2.1 流式与 SSE 稳定性（11 行）

| # | 上游 bug | 哈希 | 判定 | 证据与机理 |
|---|---|---|---|---|
| 1 | SSE 重连后丢 shell 输出 | `def1478` | 🛡️ | 上游机理：tool partial 单发，重连的新订阅者收不到、客户端丢弃流式工具输出。本地：partial 存 **per-session runtime store**（`agent-event-reducer.ts:181-212` 写 `toolExecutionUpdates`），不随 SSE 连接生命周期清空；bash partial 以 10Hz **全量快照**重发（`lib/daemon/sse-writer.ts:5-12`），1s 重连（`global-agent-events.ts:134-153`）后下一条即重新对齐；bash 期间另有 1s 结算轮询+reload（`useAgentSession.ts:882-906`）；ChatWindow 把 partial 并入流式渲染（`components/ChatWindow.tsx:466-489,715-716`）。残留差异：daemon 不在订阅时重放 active tool events（`rpc-manager.ts:408-415` 仅重放 pendingUi），断开窗口内 UI 停在旧快照——受 10Hz 快照特性自愈，无永久丢失。 |
| 2 | agent SSE 断线韧性／跨窗口恢复 | `e4fded0`、`05db5b2` | 🛡️ | 上游机理：SSE 脆弱（无心跳/退避）+ 多 tab 抢同一 in-process 订阅。本地：每 tab 独立 EventSource → web 纯代理 → daemon `listeners` 数组广播，**多订阅者天然共存**（`rpc-manager.ts:373-375`、`http-sessions.ts:58`），不存在「抢订阅者」；断线韧性=EventSource 自动重连 + fatal 1s 重连（`global-agent-events.ts:134-153`）+ 15s reconcile/visibility/online 轮询（`useAgentSession.ts:956-913,956-975`）+ slash 命令 settlement 轮询（:859-880）+ daemon 30s SSE 心跳（`http-sessions.ts:59`）+ pinned 会话重探（`global-agent-events.ts:160-185`）+ 扩展对话框对新订阅者重放（`rpc-manager.ts:410`）。无 Last-Event-ID 逐段补传，靠快照协议+轮询兜底（见第 1、3 行）。 |
| 3 | 打开活动会话时流式输出丢失 | `4787a14` | 🛡️ | 上游机理：恢复 running 会话时 `dispatch(start)` 清空已收到的流式 partial，且其 delta-only 协议下后续 delta 追加到空消息 → **永久**丢失。本地：切会话同样 reset/start（`useAgentSession.ts:1482-1510`），但 `message_update` 是全量快照（§1 协议事实；reducer `agent-event-reducer.ts:128-141` 直接置 `streamingMessage`），下一条事件（流式时亚秒级）全量重建，仅瞬时闪烁无永久丢失。后台已流入的文本走 per-session cache/store，不受连接切换影响。 |
| 4 | Pi 0.84 流式 delta 协议适配 | `6a76151` | 🛡️ | 本地 SDK 0.84.4（`package.json:49-51`）。本地**无需** delta 适配：daemon in-process 订阅转发的是含快照的事件（§1）；reducer 只消费 `event.message` 快照，不消费 `assistantMessageEvent` delta（`agent-event-reducer.ts:128-141`）。上游 05db5b2 的 `lib/agent-event-wire/streaming-message` 是为其 stdout-JSON（快照剥除）形态服务的，本地架构不需要。 |
| 5 | 重复提交内置命令 | `d10988d` | ✅ | `590fd54` port(fix): prevent duplicate built-in command submissions (upstream d10988d)。 |
| 6 | 首条消息无法 fork | `585d56c` | ⚠️ | **半移植**。daemon 半场已有：fork 在 `!entry.parentId` 时创建空会话并以 parentSession 链接（`rpc-manager.ts:540-545`，C2 起，先于上游）。UI 半场缺失：`ChatWindow.tsx:791` 仍保留 `idx === 0 && msg.role === "user"` 禁 fork 的门（上游 585d56c 恰好删掉了它）。且本地 tail=100 尾窗下 `idx===0` 是**加载窗口头**——长会话窗口头即使是历史中间消息也被禁 fork，影响被分页放大。修复草图：删除该 `idx===0` 条件（daemon 对任意 entry 的 parentId 分叉已正确），小时级。 |
| 7 | prompt anchor 更新死循环 | `d251bb3` | ➖ | 上游 bug 在其「prompt anchor spacer」（把刚发的用户消息钉在顶部、用 spacer 补高的特性）的 measure→setState→再 measure 振荡。本地已**主动移除**该特性：「We no longer pin the user message to the top (which required a full-viewport blank spacer below it)」（`useAgentSession.ts:1655-1660` 注释），滚动跟随用纯逻辑门控 `lib/chat-scroll-follow.ts`（含竞态护栏，未被指出的同类振荡）。bug 面不存在；无 spacer 状态可振荡。 |
| 8 | 被拒绝的 prompt 提交丢失 | `6ac87ec` | ✅ | 本批 T10c 四连：`ab7b3c6`（保留被拒提交）、`7c9ac91`（draft key 穿线）、`ef27c9a`（reconcile 防陈旧/防串会话）、`d2030c4`（现有会话卸载后恢复）。落点 `useAgentSession.ts:438-461,1077-1104`、`lib/composer-draft-key.ts`、`lib/draft-store.ts`。 |
| 9 | 每条 dispose 路径都发 session_shutdown | `d728526` | ⚠️ | 上游机理：destroy/dispose 前向 extensionRunner 发 `session_shutdown`，否则扩展（MCP 子进程）无法回收；并强制「abort 后 idle 到点仍关停」。本地 `destroy()`（`rpc-manager.ts:766-787`）**既不发 session_shutdown 也不调 `inner.dispose()`**——只 unsubscribe、取消 pending UI、摘除 registry。idle 超时、心跳击杀、会话删除（`http-sessions.ts:290`）、fork-destroy（`rpc-manager.ts:556`）所有路径皆然；daemon 长寿进程下扩展按会话持有的资源（MCP 子进程等）无通知不回收。上游另一半「stuck-running 关不掉」本地已由心跳监控更好覆盖（`rpc-manager.ts:1239-1262`）。修复草图：destroy() 内 guard 发 `{type:"session_shutdown",reason:"quit"}`（经 `inner.extensionRunner.emit`）再调 `inner.dispose?.()`；小时级。**这是本批 ⚠️ 中风险最高的一条**。 |
| 10 | Next 子进程停止原因报告／信号转发 | `36f01a3`、`7152653` | ➖ | 上游拓扑是 wrapper（`bin/pi-web.js`）→ Next 子进程，才有「子进程为何死了」「wrapper 信号转发给子进程」问题。本地无 wrapper：Next 是主进程，daemon 是独立 sidecar，web 退出后 daemon **按设计**存活（`sidecar.ts:8-15` 注释）；spawn 竞争败方静默退出（`bin/pi-daemon.js:30-33`）。对应物即 sidecar 生命周期，问题形态不存在。 |
| 11 | 关机僵尸 node 进程（v0.9.1 后） | `1f79174` | ⚠️ 待验证（低） | 上游机理：Next 16 graceful drain 被未关闭的 SSE 连接拖住，stranding 一个半死 node。本地 web 进程 `instrumentation.ts` 只有启动逻辑，无 SIGTERM 时关闭代理 SSE 的处理；browser↔web↔daemon 的 SSE 管道在 web 收到 SIGTERM 后仍算 in-flight，drain 可能挂满 grace 期（docker stop 变慢/半死进程）。缓解：SSE 是纯管道、daemon 独立存活、浏览器自动重连，故只是停止时延问题而非数据问题。修复草图：web 进程 SIGTERM handler 主动断开 daemon SSE 代理连接（`req.signal` 已贯通，`app/api/agent/[id]/events/route.ts:26`），小时级。待验证：实测本地 `docker stop`/`next start` 重启时延是否异常。 |

§2.1 小计：✅2　🛡️4　⚠️3　➖2

## 3. 主表：§2.2 会话管理（8 行 → 10 个判定）

| # | 上游 bug | 哈希 | 判定 | 证据与机理 |
|---|---|---|---|---|
| 1 | compaction/分页后历史缺失、最新回复丢失、minimap 失效 | `cd6032b`、`0ddb21f` | 🛡️ | 历史完整性：服务端尾窗 + `/earlier` 回翻（`lib/session-reader.ts:232-332`；`useAgentSession.ts:665-704`），compaction entry 映射为 custom 消息并在 details 带 `firstKeptEntryId`（`session-reader.ts:411-422`）；compaction_end → `reloadSession` 全量替换缓存（`agent-event-reducer.ts:267-286` → `global-agent-events.ts:251-266`，ETag 条件 GET），不存在「分页偏移在 compaction 后错位」的机制。最新回复：live 事件追加写 cache（`global-agent-events.ts:187-207`），`loadEarlier` 只前插（`useAgentSession.ts:688-696`），不动尾部。minimap：本地 `ChatMinimap` 从**渲染列表**构建节点+refs（`components/ChatMinimap.tsx:16-24`，useMessageRefs），结构自洽；compaction custom 条目作为无预览节点仍在图中，不存在上游「显示列表与 minimap 索引脱节」的形态。 |
| 2 | 长会话深层栈溢出 → 尾部分页加载 | `68cd261`、`1906134` | 🛡️ | L3 尾窗等价物齐全：初始 `tail=100`（`useAgentSession.ts:557,640`；`route.ts:172-176`），服务端**从尾向**收集窗口不全量物化 thinking/tool payload（`session-reader.ts:255-270` 注释），`/earlier` 锚点回翻（:284-332）；树投影为迭代栈 + `MAX_PROJECTED_TREE_DEPTH=200` 收缩链（`route.ts:20,28-117`），非递归。`1906134`（免全表扫描解析路径）对应本地持久索引 + path cache（`session-reader.ts:141-157`、`lib/session-index.ts`，mtime+size 增量）。 |
| 3 | 新会话未发送草稿（文字+图片）丢失 | `77ffe3c` | ⚠️ | 本地 draft 持久化含图片、localStorage 落盘（`lib/draft-store.ts:7-9,44-70`）；新会话键为确定性的 `new:<cwd>`（`lib/composer-draft-key.ts:17`）。同 shell 内切走再回来**不丢**（unmount 清理有 microtask 反悔窗，`useAgentSession.ts:1548-1560`）。但 ChatWindow **整体卸载**（切 workspace/关面板）时，从未 promote 的新会话草稿被 `clearDraft(abandonedDraftKey)` **主动删除**（`useAgentSession.ts:1553-1559`）——文字+图片丢失，与上游 #720 的「保存」语义相反（T10c 移植 6ac87ec 时有意为之，防下次同 cwd 新会话吃到残稿）。修复草图：去掉卸载即清，改为「显式放弃动作才清」或上游式 parked 键；小时级。**需产品确认**：残稿复现 vs 草稿丢失哪个更伤。 |
| 4 | 每会话独立阅读位置恢复 | `430fe4d` | ⚠️（低） | 本地每次打开/切回一律贴底：`initialScrollDoneRef` 按会话切换重置（`useAgentSession.ts:1487`）+ 首帧 `scrollToBottom("instant")`（:1663-1666）。无 per-session 位置记忆——长会话阅读中途切走再切回，位置丢失。上游 #723 的 `lib/chat-scroll-position.ts`（30 行纯逻辑 + ChatWindow 挂钩）可低成本移植。属 UX 决策类缺口而非正确性 bug；小时级。 |
| 5a | 删除未持久化运行时会话 | `edf0deb` | ⚠️ | 复现链：`/api/agent/new` 创建后 pi 延迟到首次 append 才写 .jsonl（`route.ts:130-134` 注释），但 web 侧已 seed 路径缓存（`app/api/agent/new/route.ts:58`、daemon `http-sessions.ts:181-187`）。此时 DELETE：先 `destroySession`（成功），再 `resolveSessionPath` 命中缓存 → `readSessionHeader(filePath)` 对不存在文件 `openSync` 抛 ENOENT（`app/api/sessions/[id]/route.ts:279`；`lib/session-reader.ts:195` 无 try）→ 外层 catch 返回 500，缓存也不失效（`invalidateSessionPathCache` 在成功路径 :310 才走）。GET 有 `!existsSync` 占位（:135-145），DELETE 没有。修复草图：DELETE 对 `!existsSync(filePath)` 视为已删（teardown+双缓存失效后直接 ok）；小时级。 |
| 5b | 父文件缺失会话可删 | `9cf8d4d` | 🛡️ | 本地删除路径**不读父文件**：只读被删会话自身 header 取 parentSession（`route.ts:279`），把孙辈 header 的 parentSession 重写为该值（:283-307）——父文件缺失只意味着「重指向一个不存在的路径」，无读取无崩溃；会话树对缺失父的容忍与上游修复后语义一致。 |
| 5c | 含扩展任务会话保留 | `f57b565` | ➖ | 上游机理：liveness 注册表让扩展登记「本会话还有我名下的活跃工作」，删除/idle 清扫时豁免。本地无该注册表，但损失面不同：① 本地 destroy 从不 dispose inner（见 §2.1-9 ⚠️），扩展任务不随 wrapper 销毁而死（subagent child 是 registry 里独立会话，另见 `rpc-manager.ts:1464` 完成通知豁免）；② 心跳击杀已豁免「人在等回答」的 pendingUi 会话（`rpc-manager.ts:1246-1248`）；③ 扩展以工具形式干活时 tool 事件持续喂心跳（:244-247）。残留风险：纯后台、无任何事件/pendingUi 的扩展任务仍可能被 idle/心跳回收——当前已知扩展形态（pi-subagent 工具、widget/status）均不属此类。 |
| 6 | token/成本计数 compaction 后回退 | `93633c8` | ⚠️ | 本地默认 stats 从**可见消息**累加 usage（`useAgentSession.ts:463-503`）；compaction 后 reloadSession 以压缩后上下文替换消息（§3-1）→ tokens/cost 回退。权威口径其实存在：daemon `get_session_stats`（SDK 全文件口径，`rpc-manager.ts:599-604`），但只有手动 `/session` 命令写 `sessionStatsOverride`（`useAgentSession.ts:1286-1294`）。修复草图（二选一）：compaction_end/agent_end 的 refreshAgentState 顺带拉 `get_session_stats` 写 override；或在 `/api/sessions/[id]` 服务端附带全量 stats（=上游 lib/session-stats 方案）。小时级。 |
| 7 | compaction 后标题生成失效 | `06bb7ac` | ✅ | `f703c75` port(fix): enable title generation after compaction (upstream 06bb7ac)；daemon 侧标题生成 `http-sessions.ts:260-282`。 |
| 8 | 看到其它 pi 进程写的会话 | `b44017a` | 🛡️ | 上游机理：进程内缓存的会话视图看不到外部 pi 进程的追加写。本地 web 读取**每次新开** `SessionManager.open`（`session-reader.ts:227-230`、`route.ts:165`），无长驻解析缓存；列表走 mtime+size 增量索引（`lib/session-index.ts`）+ 3s TTL（`session-reader.ts:119`）+ 变更即失效（agent_end `rpc-manager.ts:249-251` 等），外部写者变化可靠反映。残留：daemon 持有的 live wrapper 对外部并发 append 不可见——上游 live 会话同样，感知面一致。 |

§2.2 小计：✅1　🛡️4　⚠️4　➖1（5 拆 5a/5b/5c）

**合计（§2.1+§2.2，21 个判定）**：✅3　🛡️8　⚠️7　➖3

## 4. 性能思路对照（计划 §3-10）

| 上游项 | 哈希 | 本地状态 | 值得做吗 |
|---|---|---|---|
| 会话列表虚拟化 | `5f8f47b` | **缺**。`WorkspaceSessionList.tsx:105` 仅 `SESSION_PREVIEW_COUNT` 截断 + show all 全量 mount，无窗口化（工作树未提交改动状态）。默认截断下无问题；「show all」+ 数百会话时 rows 全挂载会卡。 | 值得（中）：简单自写窗口化（scrollOffset→range，2-4h）或仅给 show-all 路径加分页。 |
| 元数据缓存 | `8cbafdd` | **已有更强等价物**：`lib/session-index.ts` 是持久化磁盘索引（schema v2、mtime+size 增量重解析、跨重启复用）；`session-reader.ts:69-129` 另有列表 TTL/并发合流/代数失效。上游仅为内存跨扫描缓存，本地覆盖面（跨重启、增量、schema 迁移）更广。 | 不需要。 |
| 大 JSON gzip | `09383ae` | **缺（建议移植）**。本地大响应已大幅削减：`deferThinking`/`deferMedia`（thinking 置空、tool 结果 base64 图片摘除，`session-reader.ts:361-409`）、tail=100、ETag 304——但**无压缩**。上游专门写 `lib/json-response.ts`（56 行）说明其 Next 不自动压缩 Route Handler JSON；本地同为 Next 16，大概率相同（待验证：`curl -H 'Accept-Encoding: gzip' -I` 实测）。 | 值得（中高）：文本重的长会话详情/搜索仍可达数百 KB；把上游 json-response 移植到 `sessions/[id]`、`/earlier`、sessions 列表、search，半天内。 |
| 语法高亮缓存 | `55485b9` | 缺：`components/FileViewer.tsx` 直接用 react-syntax-highlighter，无高亮树缓存。 | 低优先（动画流畅度收益小）。 |
| 跳过长源高亮 | `5014aaf` | **部分覆盖**：批次 3 已移植大文本分页 `f69acb5`（0e71201），单次高亮体量被页界限住；无独立长度闸。 | 可不做；若分页页仍超大再补一条 max-bytes 跳过。 |

## 5. 修复建议清单（⚠️ 按风险降序）

| 优先 | 项 | 上游 | 概要 | 工作量 |
|---|---|---|---|---|
| 1 | 扩展资源不回收（session_shutdown 缺失） | `d728526` | `rpc-manager.ts:766-787` destroy() 补发 session_shutdown + `inner.dispose?.()`，覆盖 idle/心跳/删除/fork 全路径 | 小时级（4h 含测试） |
| 2 | compaction 后 token/成本回退 | `93633c8` | refreshAgentState/reloadSession 附带 `get_session_stats` 写 override，或服务端附全量 stats | 小时级（3h） |
| 3 | 首条消息/窗口头 fork 被禁 | `585d56c` | 删 `ChatWindow.tsx:791` 的 `idx === 0 &&` 条件（daemon 半场已备） | 小时级（1h） |
| 4 | 删除未 flush 会话 500 | `edf0deb` | DELETE 对 `!existsSync` 走 teardown+失效+ok | 小时级（1-2h） |
| 5 | 未发送新会话草稿卸载即清 | `77ffe3c` | 去掉 `useAgentSession.ts:1553-1559` 的清理或改显式放弃；**先产品确认** | 小时级（2h） |
| 6 | web 停机 SSE 拖住 drain | `1f79174` | SIGTERM 关闭代理 SSE；先实测时延确认必要性（待验证） | 小时级（2h） |
| 7 | 无每会话阅读位置恢复 | `430fe4d` | 移植上游 chat-scroll-position 思路（30 行纯逻辑） | 小时级（3h） |

性能补充建议（非 bug）：`09383ae` gzip（半天）、`5f8f47b` 列表窗口化（2-4h）。

## 6. 发现的其他遗漏（§2.3–§2.7 中从未被任何工单认领者）

**已在本地覆盖（无需移植，避免后续误立工单）：**
- `edf574a`（通知重复不可再触发）：批次 1 push 移植自带 `renotify: true`（`lib/browser-notifications.ts:75`、`public/sw.js:86`）。
- `fcfac31`（移动端 Enter 换行）：本地原生实现（`ChatInput.tsx:1206-1210`，移动 Enter=换行、发送走按钮）。
- `5eb71d8`/`ed52b61`/`a3bbdee`（iOS 键盘视口/状态栏）：本地自有 visualViewport 键盘体系（`lib/keyboard-layout.ts`、`globals.css:103,261-272` 的 `pi-keyboard-open`/`pi-kb-squeeze`）+ safe-area 处理（`globals.css:125,1253`）。
- `b8a3c53`（浏览器扩展 hydration mismatch）：`app/layout.tsx:62` 已有 `<html suppressHydrationWarning>`（aria-valuemax 半场未逐点核对，低风险）。
- `1218381`（LAN dev server）：`next.config.ts:27` `allowedDevOrigins` + 生产构建走 LAN，dev 有意绑 127.0.0.1（`package.json:38`）。

**真实遗漏候选（建议开小工单）：**
- `e44639f`/`b80ed3d`（同源校验在 scheme-rewriting 反代后）：本地 `lib/request-security.ts:48-52` 的 `getRequestOrigin` 用 `request.url` 的 protocol，**不读 `X-Forwarded-Proto`**——TLS 终结反代（https 入、http 出）后面，浏览器 Origin `https://host` 与请求原点 `http://host` 不匹配 → 带 Origin 的 API 会被 `isApiRequestOriginAllowed`（:74-82）拒绝。⚠️ 待验证：仅影响 https 反代部署；修法是透传链里采信 forwarded 头。

**判定为不适用/低优先（记录备查）：**
- `70d3896`/`ff63346`（skill frontmatter 写坏 SKILL.md）：本地不写 SKILL.md，skill 加载走 SDK resourceLoader → ➖。
- `5de2d9a`（子路径部署）：`next.config.ts` 无 basePath，无该部署形态 → ➖。
- `e932d97`（API key 保存卡死）：上游修的是其自有 credential-store 锁；本地 key 保存走 SDK `ModelRuntime.login`（`app/api/auth/api-key/[provider]/route.ts`），无该锁 → ➖。
- `7c5f4e6`/`2356904`（扩展对话框可收起+键盘导航+倒计时）：本地扩展对话框自有实现，未对齐这几个 UX 增强 → 低优先，待验证是否有感。
- `fe684c8`（widget ANSI 渲染）：本地 widget 设计为纯文本（PlainTextTheme，`rpc-manager.ts:1035-1054`），装 ANSI 风格扩展会显示转义码 → 低优先。
- §2.3 `faccb23`/`f607816`/`06522eb`（enabledModels glob/模糊/歧义 scope）：本地仅精确匹配且 fail-open（`app/api/models/route.ts:32-40`），glob 配置用户会拿到「全量列表」而非隐藏——功能缺口非 bug，低优先。
- §2.3 `ed840ed`/`18923e6`/`586d72e`（模型恢复显示/加载失败选择器/供应商异常守卫）：本地 models-store 失败保留旧列表 + epoch 防陈旧覆盖（`lib/stores/models-store.ts:85-108`）+ `withModelRuntimeError`（`app/api/models/route.ts:7`）大体覆盖；细节未逐点核对 → 低。
- §2.3 `b25ae6f`/`2eb95b9`（设置草稿跨区/主题语言控件）：本地设置面板为自有实现 → 低，待验证。

## 7. 疑虑与判定说明

- **快照语义是大量 🛡️ 的根基**（§2.1-1/3/4、§3-1）：依据是 SDK in-process 事件含全量 `message`（types.d.ts:389-392）+ daemon 原样转发。若未来 daemon 改走 JSON-stdout 协议或 SDK 变更事件形状，这批 🛡️ 需要重审。
- ⚠️ #6（1f79174）与「待验证」项（gzip 是否真未压缩、https 反代同源误拒）建议先用一条 curl/一次 docker stop 实测再立工单。
- 用户保护文件（`WorkspaceSessionList.tsx`、`ChatInput.tsx`、`globals.css`、`useAppShellState.ts`、`SessionRow.tsx`、`format-time.ts`、`AGENTS.md`）工作树有未提交改动，本文引用其现状行号，合并时需复核。
