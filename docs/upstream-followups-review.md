# upstream-followups 批次评审报告

生成于 2026-09-21。分支 `upstream-followups`（自 develop `a755fc5` 切出——开工时
develop 已从计划时的 `7d7a452` 前移到 `0eb8d6c` 并在切支前再度前移至 `a755fc5`
"merge: subagent/vendor-pin"，按共识 Q7-d 用当时 HEAD 并在此注明）。

- 基线（开工实测）：npm test **755** 全过 / eslint **11 problems (3 errors, 8 warnings)** / tsc 干净
- 收尾实测：npm test **802** 全过（+47，逐项对账见下）/ eslint **11 problems 基线持平** / tsc 干净 / `next build --webpack` 过
- 工作树开工时干净（保护文件清单为空，stash 协议未启用）；零新依赖（gzip 用 Node 24 内置 CompressionStream）

## 工单三态

| # | 项 | 状态 | commit |
|---|---|---|---|
| 7 | request-security 同步 | ✅ 落地 | `e214299` |
| 1 | 会话 JSON gzip | ✅ 落地 | `d3ef787` |
| 2 | apply_patch split diff | ✅ 落地 | `76e5627` |
| 4 | 图片预览（消息 + composer） | ✅ 落地 | `31856ba` + `4972229` |
| 5 | /auto-compact 命令 | ✅ 落地 | `72507d7` |
| 6 | canClearBuiltinCommandInput | ⏭️ 跳过有据 | —（无 commit，见下） |
| 9 | 移动端 Ctrl/Cmd+Enter 强发 | ✅ 落地 | `5ff33ce` |
| 3 | scroll-to-latest 按钮 | ✅ 落地 | `350894e` |
| 8 | 阅读位置持久化 | ✅ 落地 | `e7771b2` |
| 10 | ModelsConfig 价格语义 | ✅ 落地 | `fd19305` |
| 11 | 会话列表虚拟化 | ✅ 落地 | `31b0c94` |
| 12 | 状态栏沉浸式 | ✅ 落地 | `d9a7d45` |

执行序按共识重排版 7→1→2→4→5→6→9→3→8→10→11→12（滚动簇 3+8 集中处理），
共 12 个 commit（#4 两个、#6 零个、其余各一）。

## 逐项记录

### #7 request-security（upstream d362764）— `e214299`

- **落点**：`lib/request-security.ts` +1 函数 +1 调用点；`app/api/sessions/[id]/export/route.ts` +3 安全头；测试 +1（`request-security.test.mjs` 10→11）。
- **适配**：原计划"同步 3 个函数"是旧账——实测本地仅落后 `isUserInitiatedSessionExportNavigation`
  一个函数（PWA 导出按钮 Origin:null 被 403 的修复；谓词只认 `sec-fetch-mode=navigate +
  dest=document + user=?1` 的 Fetch Metadata 形状）。上游附带的 export HTML 防嵌帧三头
  （frame-ancestors/nosniff/DENY）同 commit 语义一起移植。**249224e 的反代 fail-closed
  语义与详尽注释一字未动**（导出放行插在 host 检查后、origin 检查前，不碰
  isProxyRewrittenSameOrigin）。

### #1 gzip（upstream 09383ae）— `d3ef787`

- **落点**：新 `lib/json-response.ts`（≥1KiB 才压、Accept-Encoding q 值协商含 `*` 通配、
  Vary 去重追加、CompressionStream）+ 单测 5（上游 3 + 本地 2）；接线**四条**路由
  （列表含 archived 分支 / `[id]` 详情 / `[id]/earlier` / `sessions/search`）——超出
  上游两条的扩展来自本地 audit §4 建议（公网反代带宽）；集成测试 `gzip-etag.test.mjs` +1。
- **ETag 兼容**（原工单的关注点）：上游实现根本不生成 ETag（其路由无 304），本地集成后
  revision 仍基于 stat（size+mtimeMs）与压缩无关；ETag 经 init.headers 透传、Vary 由
  helper 追加、304 早退路径不经过 helper。集成测试锁定：gzip+ETag 共存、gunzip 往返、
  304 响应无 Content-Encoding。

### #2 apply_patch split diff（upstream e70c367）— `76e5627`

- **落点**：新 `lib/apply-patch.ts`（V4A 文档 + details.preview 双源解析到共享
  SplitDiffFile 模型）+ 8 单测（原文）；`MessageView.tsx` ToolCallBlock 接线（patchFiles
  视图 / 失败按错误渲染 / 头部文件列表摘要）；`session-changed-files.ts` 计入
  apply_patch（+2 测试）；`MessageView.test.mjs` +2。
- **本地适配**：① 本地无 `lib/tool-names.ts` / `turn-written-files.ts`——
  `isApplyPatchToolName` 落 session-changed-files（本地工具名谓词的归宿）；"本轮写入文件"
  在本地是"会话改动文件"派生（与用户约定过的纯 assistant 流语义、无 result 通道），故按
  **调用即计数**计 Add(write)/Update(edit)、跳过 Delete（上游同语义），上游基于
  `details.result.appliedFiles` 的失败感知细化在本地架构下不适用。② 本地无 rawInput
  流式半成品通道，getApplyPatchFiles 只走 input 源。③ **响应式（共识 Q2-b）**：
  SplitFilesView 共享渲染层宽屏 split / 窄屏单列 unified（removed 前 added 后、context
  单次），edit 工具 diff 同时受益——判定复用 useIsMobile 与 shell 分叉同源。

### #4 图片预览（upstream e851d30 + d2056b6）— `31856ba` + `4972229`

- 前置事实：本地无 ImagePreview 组件（e851d30 引入），#4 被事实强制拆成两个 commit。
- `31856ba`：组件（原生 `<dialog>.showModal` + 焦点还原 + Escape/backdrop/关闭钮三路
  关闭 + CSS safe-area 与粗指针 44px 关闭钮）原文移植；user 与 custom 消息图片包进组件；
  i18n 双语；测试 4（原文）+ MessageView +2。
- `4972229`：composer 56px 缩略图包进组件 + 删除钮补 type=button（上游原文）。
- 上游 d11d344（折叠工具卡里显示结果图片）不在本批范围，未动。

### #5 /auto-compact（upstream f2d600b）— `72507d7`

- **落点**：BUILTIN_SLASH_COMMANDS 注册 + useAgentSession `case "auto-compact"`
  （先 get_state 读实时 wrapper 再翻转——idle 会话无 wrapper，防 runtime 默认 true 覆盖
  settings.json）+ i18n 双语；测试 +1（source 切片断言）。
- **零 SDK 风险的实证**：本地 `lib/daemon/rpc-manager.ts:613` 早有 `set_auto_compaction`
  case、`:489` 已透出 `autoCompactionEnabled`、SDK 0.84.4 有 `setAutoCompactionEnabled`。
- **本地适配**：上游的 useState 镜像 → 本地 per-session runtime slice
  （session-runtime-store 加 autoCompactionEnabled 字段，live / 轮询 reconcile 两处镜像，
  hook return 透出）；本地流式门控本就整体隐藏内置命令（`ChatInput` commands 数组的
  `isStreaming ? [] :` 分支），无需上游 availableWhileStreaming 逐命令标记。

### #6 canClearBuiltinCommandInput（upstream d5ec3bc/d10988d）— ⏭️ 跳过有据

对账结论（共识 Q3-a 规则：发现真实缺口才移植）：

| 上游谓词守的边 | 本地等价物 | 判定 |
|---|---|---|
| 命令在飞期间消息被改 → 不清 | 输入区整体 `disabled={builtinCommandPending}`，飞行期不可编辑 | 覆盖（更严） |
| 带图提交内置命令 → 不清 | `runBuiltinCommand` 入口 `attachedImages.length ||` 直接 return false，带图根本进不了内置路径 | 覆盖（更严） |
| 重复提交（d10988d） | `builtinCommandPendingRef` 在飞时二次 Enter 直接吞 | 覆盖 |
| 仅成功才清 | `if (!result.error) clearInput()` | 同语义 |

本地机制是"整输入区锁死"的有意设计（比上游谓词宽），叠加上游谓词只会制造双真相源。无缺口，不移植。

### #9 移动端 Ctrl/Cmd+Enter（本地项）— `5ff33ce`

- `forceSend = (ctrlKey || metaKey) && !altKey`：Alt 族（T10 桌面专属）在移动端保持
  原生，**T6 既有锁死用例语义零改动**，只新增 4 个 case（Ctrl/Cmd 强发 ×2、idle 发送、
  Enter 单独仍 native）。桌面行为不变（Enter 分支本就覆盖 Ctrl+Enter）。

### #3 scroll-to-latest（upstream 1eb5e66）— `350894e`

- **落点**：`shouldShowScrollToLatest` 纯谓词（距尾 >8px 且可滚）落 `lib/chat-lazy-load`
  （连带移植上游同文件的 `isScrollAtTail`/`CHAT_SCROLL_TAIL_TOLERANCE`，本地此前没有）；
  ChatWindow composer 上方悬浮圆钮（避开 minimap、空会话不渲染、160ms 淡入/28% 透明度/
  reduced-motion CSS 原文）；i18n 双语；lazy-load 测试 +1、`ChatWindow.scroll-to-latest.test.mjs` +5。
- **接进状态机（不旁路，工单红线）**：点击 = 共享 `scrollToBottom("smooth")`——它内部先
  `noteProgrammaticScroll()` 武装 700ms 忽略窗，滚动到底后的 scroll 事件由
  chat-scroll-follow 状态机自身的近底转换（≤120px + 佐证）重挂跟随。可见性谓词与跟随
  启发相互独立（上游同设计，两者的容差语义不同：8px 是"在尾部"，120px 是"重附着窗"）。
- **本地适配**：可见性 state 放 ChatWindow 并搭 T13 的 rAF 节流 scroll capture 的车
  （上游放在 hook 的未节流 scroll 监听里——本地方案少一类 re-render）；换会话复位；
  恢复期抑制读 `pendingScrollRestoreRef.current`（ref，上游为 hook state，1 帧级
  cosmetic 差异）。

### #8 阅读位置持久化（本地项）

- **落点**：`lib/chat-scroll-position.ts` store 从纯内存 Map 改为**写穿 localStorage 单条
  blob**（key=`chat-scroll-positions`，LRU 保留最近 30 个会话）；内存 Map 仍是读路径权威
  （rAF 高频写不做每帧 JSON.parse）；模块加载时水合；API 不变、ChatWindow 零改动。
- **共识 Q2 的落地**：选 localStorage 而非 sessionStorage——iOS PWA 后台回收/杀进程时
  sessionStorage 与内存同归于尽，正是本项要治的场景。水合时机不变（T13 渲染期读点）。
- 降级：localStorage 不可用/写失败/损坏 blob → 纯内存，行为同旧版。测试 +3（水合往返/
  LRU/降级，jiti moduleCache:false 模拟重载）。

### #10 ModelsConfig（upstream c3b741e）— `fd19305`

- **范围**（共识 Q4-a：语义核心必落、UI 结构能嵌则嵌）：本地 ModelDetail 内部与上游改前
  状态几乎逐行一致（inline 改版动的是外层），①②③③ 全部干净嵌入，无打架项。
- **语义核心**：价格四项全有或全无（只读展示 `$值`/Not provided + Edit prices + 不完整
  草稿 costAllRequired 不落盘 + 全空删组 + costTemplateRef 保编辑中途的已存完整价）；
  目录推荐价补 0（`CompleteModelCatalogCost` + priceFromEntry/consensusPrice 缺失 cache
  项按 0 + fillEmptyModelFields 填后补 0 才落盘）；`CONSENSUS_MIN_SUPPORT=5`；catalog
  成功自动退出价格编辑态。
- **已有资产**：store 层 `normalizeModelsConfigCosts`（写盘归一）本地**已经同步**（含
  writeModelsConfig 接线与既有测试断言），本批补专项测试。
- **本地适配**：本地无 model 级 Headers 编辑器与 developer-role Check（上游更早提交的
  功能，不在本批范围）——Advanced 折叠只收本地现有项，摘要行无 Headers 计数（少 3 个
  i18n 键）；i18n 双语 +25 键。测试 +5（ModelsConfig.test.mjs 新建）+4（catalog）+1（store）。

### #11 会话列表虚拟化（upstream 5f8f47b 技术移植）— `31b0c94`

- **目标修正**：上游虚拟化落在 SessionSidebar——本地该文件**未被挂载**（2026-09 树形
  改版后仅剩两处注释引用），真实会话列表是 WorkspaceSessionList（WorkspaceOverview +
  MobileShell 使用）。故为**技术移植**而非 blob 移植，这也解释了工单把前置条件押在
  WorkspaceSessionList 上（开工实测干净 ✓，轮到时复测仍干净 ✓）。
- **外科手术式落点**（共识 i）：仅 `showAllSessions` 展开且行数 >60 时在**内嵌滚动容器**
  （maxHeight min(70vh,640px)）里窗口化；默认 20 条预览渲染零改动。行高按本地实测
  （11+11 padding + 2 border + 28px 删除钮 = 52px + 8 行距 = 60 节距，不硬搬上游 54）；
  删除确认两步的焦点行钉在窗口内防状态丢失（对应上游 inline rename 保留）。
- **条件子项 (iii) 判定**：5f8f47b 顺带的 ChatWindow entryIds-key 稳定化——本地
  `ChatWindow.tsx:888-894` 已按 entryId 作 key（注释明确写了 loadEarlier 前插稳定性
  理由），**跳过**。纯函数测试 +3。

### #12 状态栏（本地项）— `d9a7d45`

- `appleWebApp.statusBarStyle` default → **black-translucent** + `viewport.viewportFit:
  "cover"`。安全区**中心化**让出：DesktopShell/MobileShell 根容器加
  `env(safe-area-inset-top/left/right)` padding（桌面 env=0 无感；根容器本有
  `background: var(--bg)` 状态栏区域着色不露白；MobileShell 根补 boxSizing border-box
  防 padding 撑爆 --app-vh）。底部不重复让出（底部 tab 栏/键盘体系各自已带
  safe-area-inset-bottom）。audit 记录的既有 safe-area 资产（globals.css、ImagePreview
  modal、offline.html）原样兼容。
- **遗留**：真机 PWA 视觉验收需你在手机上做（刘海遮挡/横屏左右 inset/键盘弹出）。

## 测试对账（755 → 802，+47）

| commit | 新增 | 小计 |
|---|---|---|
| e214299 security | +1 | 756 |
| d3ef787 gzip | +5（helper）+1（gzip-etag） | 762 |
| 76e5627 apply_patch | +8（apply-patch）+2（changed-files）+2（MessageView） | 774 |
| 31856ba ImagePreview | +4（组件）+2（MessageView） | 780 |
| 72507d7 auto-compact | +1 | 781 |
| 5ff33ce 强发 | 0（case 并入既有用例） | 781 |
| 350894e scroll-to-latest | +1（lazy-load）+5（ChatWindow） | 787 |
| e7771b2 阅读位置 | +3 | 790 |
| fd19305 models | +5（ModelsConfig）+4（catalog）+1（store） | 800 |
| 31b0c94 窗口化 | +3 | 802* |

\* 802 为 `npm test` 最终整体通过值（分支内每次全量验证均为全过、零 flake）；eslint 基线 11 problems 全程持平，tsc 全程干净，`next build --webpack` 过。

## 遗留与分歧记录

1. **#12 真机验收**：模拟器/代码审查无法替代 iPhone PWA 的刘海/横屏实测。
2. **#10 的 Headers/developer-role**：上游 Advanced 区里的 model 级 Headers 编辑器与
   developer-role Check 来自 c3b741e 之前的上游提交，本批未带入——如需要可作后续批次。
3. **#2 的窄屏 unified 依赖 useIsMobile**（shell 级四信号判定）：桌面窄窗（三列布局压
   窄但不触发移动判定）时 diff 仍为 split——按共识"视口宽窄"语义如此，未按容器宽自适应。
4. **gzip 与反代的交互**：已带 `Vary: Accept-Encoding`；若你的 nginx 另开了 gzip 模块，
   对已带 Content-Encoding 的上游响应不会再压（nginx 默认行为），无需配置改动。
