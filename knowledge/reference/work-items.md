# 工作项与交付流（服务面 + M2 状态机 + 四角色自动执行 + 前端）

> 深细节基线，2026-10 自 AGENTS.md 迁出（AGENTS.md 现为总览与用法说明，细节住此）。

> 内容与迁移时点一致；后续变更直接更新本文档。



---



### Work Items (`lib/work-items/`)

File-backed **Requirements (`REQ-####`)** and **Bugs (`BUG-####`)**. Storage under
`<workspace>/.pi/work-items/<requirements|bugs>/<KEY>-<slug>/`（2026-09 布局，`lib/work-items/service.ts` 的
`workItemRoot`；旧根级 requirements//bugs/ 目录已一次性收进 .pi/，迁移脚本已删）:

- `item.yaml` — structured metadata (status/phase/priority/repositories/conversations/… + optional top-level `loop?: string` kit-loop binding by loop NAME, S1 soft validation — existence NOT checked; protocol semantics in `kit/README.md` 工作项绑定一节; + optional `branches` 开发分支登记, see below; + optional `delivery` 标准交付流块, see below), `schemaVersion 1`.
- `README.md` — human body. **Original Description is preserved verbatim**; later analysis is appended, never overwriting it.
- `events.jsonl` — **append-only** timeline (id/at/type/actor/optional conversationId/data). Never rewrite it.
- `delivery/artifacts/design.md` — 设计文档（仅 `enableDelivery` 项；`start-design` 时若不存在则播种模板「# 设计：… ## 方案 ## 验收条件」）。空/纯空白视同未编写——`confirm-design` 会以 400 拒绝（缺设计依据）。

Key behavior:
- `listWorkItems()` reads ONLY `item.yaml` per directory (README/events are detail payloads — reading them here was the list hotspot) and returns `{ items, archivedItems, trashedItems, invalid }` in ONE pass — the sidebar's active+archived fetches, the recycle-bin read-only list, and external-source sync scripts' dedup scans (active ∪ archived) all consume this single result.
- The `KEY` counter lives in `manifest.work_items.next{Requirement,Bug}Number` and is incremented under the workspace
  write lock (`reserveWorkItemKey`; createWorkItem 在自己的锁窗内改用不可重入变体 `reserveWorkItemKeyUnlocked`——见下条)。
- **跨进程短写锁（2026-10 M2，spec §8.2）**：`withWorkspaceWriteLock`（lib/workspaces/service.ts）= **双层锁** —— 进程内
  per-workspace Promise 队列（同进程写串行）套 `withWorkspaceFileLock`（`lib/workspaces/file-lock.ts`：O_EXCL 创建
  `<ws>/.pi/.write-lock`，内容 = owner token `${pid}@${host}:${uuid}:${createdAt}`；获取失败读持有者——pid 已死或超 stale 窗
  （默认 30s，短事务）删锁重试一次，仍失败抛 `WorkItemConflictError`（HTTP 409）；释放前核对 token 再删，不误删被抢占重写
  的他人锁；不可解析的锁以 mtime 兜底防抢占「创建窗」内的锁）。文件层让 web 宿主与外部写者（pi-loop CLI / 外部脚本加载
  同一 workspace）互斥；**锁不可重入**——锁内路径要再取 key 计数/查重必须走 unlocked 变体。file-keyed 调用方（如 session
  index）用 sibling `<file>.write-lock`（`resolveLockPath`：目录 → `.pi/.write-lock`，文件 → sibling，不存在 → null 跳过文件层）。
- **导入去重（2026-10 M2，spec §8.1）**：`createWorkItem` 带 `external` 时，去重查找（`findExistingByExternal`：
  活动 ∪ 归档（`listWorkItems`）∪ 回收站——trash 里的 item.yaml 即来源去重墓碑，坏墓碑跳过不阻塞）+ key 预留 +
  落盘全在**同一工作区写锁窗**内（并发同源导入只建一项；锁不可重入故 key 预留走 unlocked 变体）。命中即**原样返回
  既有项**（`existing` 从活动布局读，`existing_trashed` 从 `.pi/trash/work-items/<dir>/` 读——`readWorkItemDirectory`
  支持显式目录），不覆盖任何字段、不消耗 key 计数。返回值 `{ detail, importOutcome: "created"|"existing"|"existing_trashed" }`；
  POST `/work-items` 响应 = detail 展开 + `importOutcome`，状态码 201 created / 200 existing*（旧脚本按 detail 字段读仍兼容）；
  extension `workspace_create_work_item` 取 `.detail` 附加 outcome；WorkspaceManager 创建流程把 existing 视为
  「已存在，未重复创建」提示（existing 打开既有项详情，existing_trashed 仅提示——回收站项路径不在活动布局，详情操作会 404）。
- **标准交付流 / delivery flow（2026-10 M2，`lib/work-items/delivery-types.ts` + `delivery.ts`；动作面是人工的——Phase-2/3/5 在其上加了 designer（intake→design）、developer（ready_for_implementation→implementation）与 release-preparer（release_ready 起草发布材料）角色自动执行，final-arch step-3（2026-10-26）增 reviewer（verification 先审后跑）并把检查执行收编为**引擎 system 检查步**（原 Phase-4 verifier 角色退役，见下节「Delivery 自动执行」）**：
  创建表单勾选「标准交付流程」（`CreateWorkItemInput.enableDelivery`，HTTP 表单专用——LLM 工具不透传；缺省不勾）即给
  `item.yaml` 顶层播种 `delivery: { protocolVersion: 1, mode: "manual" }` 块（`parseDelivery` 逐字段校验；未知
  protocolVersion / 非 manual mode 是硬错误 = 配置错误，不静默降级）。块内子结构：`designConfirmed`（requirementDigest +
  designDigest 双绑定）、`candidates[]`（{repositoryId, commit}）、`verification`（requirementDigest + candidateDigest +
  checks[]）、`review`（final-arch step-3：reviewer 判定，见「Delivery 自动执行」节）、`acceptance`（final-arch
  step-4：人工验收记录 notes/candidateDigest/at——record-release 验收门的证据）、`releasePlan`、`release`（version + candidates + notes/rollback）、`clarifications[]`（final-arch
  step-2：澄清问答——ask 的持久产物，追加式，见「Delivery 自动执行」节）、`lastRequest`（幂等指纹）。**七阶段**（phase 枚举
  扩展，与老子阶段共存）：`intake → design → ready_for_implementation → implementation → verification → release_ready →
  released`；`block`/`unblock` 改 status 不动 phase，`cancel` 终止。**状态机**：`planDeliveryTransition`（纯函数，无 fs——
  README/design.md 的 sha256 digest 由 apply 计算注入；`contentDigest`/`candidatesDigest` 在 delivery-types.ts）产出
  {phase, status, delivery, eventType, eventData}；`applyDeliveryAction` 在工作区写锁内编排（读现态 → 幂等检查 → revision
  检查 → plan → design.md 播种 → 写 item.yaml + appendEvent + workspace git commit）。**requestId 幂等**（spec §9）：同
  requestId+action 重放直接返回现态 `{detail, replayed: true}`，不 bump revision、不追加事件；每次受理把指纹写进
  `delivery.lastRequest`。**证据绑定**：confirm-design 绑定当时的 requirement+design digest、record-verification 绑定
  requirement+candidates digest——缺依据（无 design.md / 无 candidates / 有未通过检查项）一律 400 拒绝推进；rework 回退时
  撤销全部下游证据（designConfirmed/candidates/verification/acceptance/releasePlan 清空，须重新挣得；review 判定保留——
  人要看为什么打回）。**失效回退（确定性，spec §7.3）**：
  已确认设计后修改需求（README 正文，`updateWorkItemContent`）或修改已确认的 design.md（`updateDesignContent`）→ 清
  designConfirmed/candidates/verification + phase 回 `design` + 追加 `delivery.invalidated` 事件（reason
  requirement-changed / design-changed）。**门禁与冻结**：generic PATCH 对 managed 项改 phase/status → 400（阶段只走流程动作）；
  `released` 基线冻结——非展示性动作（block/unblock/cancel 外）、PATCH 的 repositories/branches/loop、design.md 编辑均拒绝（「请创建关联后续项」）；
  released 上 unblock 恢复 `done`（不是 in_progress——冻结基线上没有别的写者能修复它）。**动作 API**：
  `POST /api/workspaces/[id]/work-items/[key]/delivery/[action]`（body {expectedRevision, requestId, payload}；slug 门 =
  delivery-types 的 `DELIVERY_ACTIONS` 权威表；错误 400 Validation/404 NotFound|未播种 design.md/409 Conflict=revision 或锁忙）；
  `GET|POST .../[key]/design` = 设计文档读/写（POST 即 updateDesignContent，同样走失效回退）。**合法动作计算**：
  `legalDeliveryActions` 的 client-safe 家在 `lib/work-items/legal-actions.ts`（纯类型导入，浏览器 bundle 安全；delivery.ts
  re-export 保服务端旧消费面）；动作条投影 `legalActionBarActions` 在 released 上额外去掉 cancel（released+cancelled
  是不可能态——WorkItemActionbar 据此不渲染 cancel）。事件类型：`delivery.<action>` + `work_item.design_updated` +
  `delivery.invalidated`。错误类住在 `lib/work-items/errors.ts`（叶子模块；service.ts re-export——web.ts 的 instanceof →
  HTTP 映射要求所有 thrower 共享同一 class 身份）。
- **回收站（trash，2026-10 M2）**：DELETE（trash）把条目 rename 进 `.pi/trash/work-items/<KEY>-<ISO 时间戳>/`（同一 key 多次
  移入取最新 mtime）；恢复 = `restoreWorkItemFromTrashInRoot(workspacePath, key)`（锁内原子 rename 回 type 目录 + `work_item.restored`
  事件；key 已被任何活目录承载 → 409；墓碑 item.yaml 坏 → 400 不把垃圾搬回活树；无命中 → 404）——HTTP
  `POST .../work-items/[key]/restore-from-trash`，测试经 workspacePath 缝注入。回收站在 `listWorkItems().trashedItems`
  只读列出（中央页「回收站」筛选 + 恢复入口）；其 item.yaml 兼任外部源去重墓碑（见上条）。
- Updates take `expectedRevision` (optimistic concurrency); appending a milestone via `recordWorkItemMilestone` does
  **not** bump the revision.
- **会话自链接（服务层不变式，2026-09）**：任何带 `conversationId` 的事件/更新都把该会话合并进 `item.conversations` ——
  `updateWorkItem` 在锁内合并（bump revision），`recordWorkItemMilestone` 只写元数据不 bump。此前合并只存在于
  `workspace_update_work_item`（扩展显式预读全量再传回，存在覆盖其它会话新链接的竞窗，已删），而 conversations
  事后回填（D9）仅宿主心跳轮才有 —— loop 轮/交互会话只盖里程碑时（`loop.parked`/`loop.gate`/…）会话与工作项
  断链，详情页「关联会话」为空、回复结果无处可寻（cxin REQ-0013/0014 实证）。调用方（LLM 扩展 / D9 回填 /
  HTTP API）一律只传 `conversationId`，不传全量列表。UI 侧：详情页「执行里程碑」每行带 `conversationId` 时渲染
  「查看会话」按钮（`onOpenConversation` → locate 打开，含已归档轮会话）；详情头部为两行结构——第一排按钮区、
  第二排编号+标题（2026-09 反馈）；仓库范围在详情页只读展示（仅非空时，勾选交互已撤——2026-09 反馈无实际作用，
  字段仍由创建表单/外部源脚本/LLM 工具写入，loop 选品 verifiable 判定读它）。历史孤儿数据不迁移——旧行的「查看会话」按钮同样可达。
- The pi extension (`work-items/extension.ts`) registers `workspace_list_work_items`, `workspace_get_work_item`,
  `workspace_create_work_item`, `workspace_update_work_item`, `workspace_record_milestone`, `workspace_set_session_title`
  （2026-10：改当前会话显示名——`pi.setSessionName` + 会话列表缓存失效；供 loop 选品落定后把会话标题改成「KEY 标题」，一次一题不跟阶段刷）.
  create/update **透传可选 `loop` 绑定字段**（string；update 接受 null 清除——S1，软校验：存 loop 名、不验存在性，未命中按未绑定处理）。UI 入口 = 详情「Loop」下拉（WorkspaceManager，空=未绑定）。
  **LLM 工具 managed 门控（2026-10 M2）**：`list` 默认**排除 managed 项**（= 挂 delivery 块的标准流程项——loop 取项不该捡走
  流程管着的项），`include_managed: true` 显式opt-in 才附带；每项带 `managed` 标记（`get` 恒附）；`update` 不绕 service
  （直调 `updateWorkItem`，managed 项改 phase/status 即吃到 service 层 400 门禁，工具描述里写明引导走 delivery 动作）。
- **来源展示**: items carrying `external` (外部源脚本经 HTTP API 盖章) render their provenance — 详情「来源」行（禅道 #id ↗ + 最近同步时间）+ 列表 KEY 旁「禅道」小徽章（`source-labels.ts` 的标签映射；手动创建的项无此字段，不加徽章）。
- **Git 分支登记与合并状态（2026-10）**：`item.branches?: {repositoryId, branch}[]`（每关联仓库至多一条，只存分支名）记录工作项的开发分支；**合并状态（是否已合入 develop/master）是实时派生事实——永不落盘、不进 events**。落盘面：create/PATCH `branches`（空数组=清除；`normalizeBranchSelection` 校验 repositoryId ∈ 项 repositories、同仓去重；PATCH 同时收窄 repositories 时自动剪掉越界条目；`released` 冻结纳入 branches；变更进 `work_item.updated` 事件 diff）。实时面：`GET …/work-items/[key]/git?refresh=1`（`lib/work-items/branch-status.ts`）逐关联仓库返回 `{itemBranch, repoBranch(仓库当前 checkout), itemBranchExists, branchTargets[{target, merged}], deliveryBranches(pi-delivery/<KEY>/* 自动识别), latestDelivery, candidate(managed 项 delivery.candidates 的提交), error}`——目标分支=develop+master（两者全缺才兜底 main），合并判定 `git merge-base --is-ancestor`；单次 `for-each-ref refs/heads/` 取全部分支事实 + merge-base 结果各带 30s TTL 缓存（globalThis 单例，`?refresh=1` 与仓库列表缓存一起穿透）。UI：详情页「Git 分支」区块（`WorkItemGitSection.tsx`——徽标「已合入/未合入 <target>」、未登记时 inline 登记含「取仓库当前分支」与交付分支一键、released 只读）+ 列表行分支小徽标（只显示登记名，**列表不拉合并状态**——5s 轮询不为每项跑 git）；看板卡片不显示。LLM 面：`workspace_update_work_item` 透传 `branches`；AGENTS.md 的 Git collaboration 段提示代理建分支后登记。
- **附件（attachments）**: `addWorkItemAttachments`（service.ts）把上传文件落 `<item>/attachments/`（basename 剥离路径、去控制字符、磁盘/批内重名自动 `-1` 后缀，中文名保留）并在 README 维护单个 `## 附件` 小节（图片 `![]()`、其余 `[]()`，目标 URL 编码，重复引用不追加；README 变更时与 content 更新同构地 bump revision）。事件类型 `work_item.attachment_added`（data.files）。路由 `POST …/work-items/[key]/attachments`（multipart `files`，限额同 /api/files：单文件 25MB / 总 100MB）；创建表单（WorkspaceManager）在创建成功后上传，失败不静默丢——报错并保留已建工作项。详情页 `MarkdownBody cwd` 直接渲染这些相对引用（与外部源脚本同机制）。
- **前端（2026-10 M2 T7–T10）**：**共享缓存层** = `lib/work-items/store.ts`（per-workspace 模块级 snapshot
  {items, archivedItems, trashedItems, invalid} + listener 广播 + `shouldRefetch` 5s 年龄门——双宿主秒开不拉请求风暴）+
  `hooks/useWorkItems.ts`（**单轮询器引用计数**：同 workspaceId 无论挂几个宿主只有一个 interval（默认 5s，仅可见时轮询；
  visibilitychange 停表/回可见立即校验，focus 校验一次；单飞 in-flight 合并）；mutation 成功统一 `invalidate()`（清快照+强制
  重取，两宿主经订阅即时互见）；workspaceId 热切换时 loading/error 从新工作区的 store 状态复位（在飞的旧请求不得把错误漏到
  新工作区））。**中央管理整页** = `components/work-items/`：`WorkItemsPage`（页头 工作区选择器+列表|看板|卡片三段+＋新建 →
  Toolbar 筛选（活动|归档|回收站）→ `WorkItemsList`（行带状态色点徽章）/`WorkItemsBoard`（七列阶段看板，无拖拽跳阶段）/
  `WorkItemsStatusBoard`（**2026-10 状态卡板**：五列=WorkItemStatus，卡片 HTML5 拖拽换状态 → 页面 `handleMoveStatus`
  PATCH `{expectedRevision, status, actor:"user"}` + invalidate；409 → 内联提示+刷新重试；**标准流程项（delivery 块）与
  归档/回收站范围不可拖**——与服务层「managed 项 generic PATCH 改 status=400」门禁对齐，卡片带「🔒流程」徽章；窄屏/触屏
  回落列表）→ `WorkItemDetailView`
  （概况/设计编辑/证据（确认/候选/验证/发布）/动作条 `WorkItemActionbar`/事件审计 `WorkItemEvents`）+ `WorkItemCreateForm`
  （`enableDelivery` 复选框**缺省不勾**）。**手机宿主（2026-10，`knowledge/designs/mobile-work-items-design.md`）**：手机壳 `MobileTabShell`（<768px）
  不再推入 `WorkItemsPage`，改宿手机原生三页 `components/shell/MobileWorkItemsPages.tsx`——列表根页（搜索 / 范围分段 / 筹片形态原生 select 筛选，
  筛选持久化键与桌面同 `pi-work-items-filters:<wsId>` / **「需要你处理」琥珀带** = `GET …/attention` 队列、refreshToken 接快照 fetchedAt /
  按状态分组 进行中·待处理·已阻塞·已结束〔折叠〕，attention 命中优先；标准流程项每行七段**阶段轨迹**，老流程项只显原始 phase 文案）→
  推入详情子页（复用 `WorkItemDetailView hideClose`；执行状态经 `useDeliveryExecution.ts`——从 `WorkItemsPage` 内联逻辑抽出的同语义 hook，
  拉取/停止/重新检查并恢复/恢复自动领取，桌面页暂仍持自己一份）→ 推入新建子页（复用 `WorkItemCreateForm`，成功 replaceTop 成详情）。
  分组/attention 主条目/轨迹索引是纯模块 `mobile-groups.ts`（node:test）。平板壳 `MobileShell`（≥768px）与桌面深链仍宿 `WorkItemsPage`。
  **交付自动执行区（Phase-2 T9；Phase-3/Phase-4 T5 增量；Phase-5 T2 零配置增量；final-arch step-3 T5 增 system/review）**：`WorkItemExecution.tsx`（managed 项专属，
  挂在 DetailView 动作条下）：四态——活动 claim 卡（**role 徽标**[词表 = roles.ts `AnyDeliveryRole | "system"` type-only 直引：designer/developer/reviewer/release-preparer 原文渲染，`system` →「系统检查」徽标（引擎检查步非角色），legacy verifier 原样可读（旧 attempts/claim 永不坏）]/代数/心跳 + 查看会话[claim.sessionId→onOpenConversation] +
  「停止执行」+ **claim 卡标题**[角色会话「执行中」；system claim →「系统检查运行中」——引擎 checks 步占槽] + **claim.worktrees 列表**[每仓一条 `alias ?? repositoryId · 分支`——alias 由 GET delivery-execution 路由**读取时 manifest 联表富化**（展示元数据可改名、不落盘；无 alias/未登记回退 ULID id），完整检出路径进 title 提示] + **claim.checkResults
  证据行**[每条：outcome 徽章 通过/未通过/未验证 + 退出码（null=进程未跑完）+ 耗时 + 日志文件名——logRef 是相对工作项根的 POSIX 路径，basename 铺正文、全路径进 title；system 检查步的实时证据主要落在这里]）、`paused` 横幅（原因/连续失败计数 + 「恢复自动领取」）、`pendingInterruption` 横幅（「重新检查并恢复」）、
  最近 attempts（末 5 新→旧，outcome 徽章 + **role 徽标** + needsAttention「待处理」标记 + **submitted 项的候选摘要**[内联串 `repo@commit 前 8 位`] + **verificationOutcome 判定徽章**[已验证/需返工/环境未就绪（unverified——system 步落 blocked 等人修环境）——rework 是合法判定不是执行失败] 与全量 checkResults 紧凑 chips[rework 路径的失败证据只随 attempt 留痕] + **reviewer 的
  review 判定徽章**[final-arch step-3：pass →「评审通过」/ rework →「返工（code|spec）」——attempt.review 是 DeliveryReviewRecord 的客户端镜像，意见全文进 title] + **release-preparer 的
  releasePlan 摘要**[Phase-5 T2：`发布材料 <notes 首行（>40 字符截断）> · 含回滚 / 未附回滚`——完整 notes/rollback（或明示缺席）进 title，attempt.releasePlan 是发布材料的审计留痕]）；busy 全按钮禁用防双击，动作结果
  `{ok}|{ok:false,error}` 出参 → 内联 role=alert（recover 409 的 pids 由 WorkItemsPage 拼进 error 文案）。执行状态由
  WorkItemsPage 拉取（GET `.../delivery-execution`，仅 `item.delivery` 存在的非回收站选中项拉；revision 变化 + 动作成功
  重拉，effect 带切项取消守卫）；三动作 = POST `.../delivery-execution/stop|recover`（manual:true）与
  `/api/workspaces/[id]/delivery/resume`（body {key}），成功 → invalidate + 重拉。详情页 verification 证据块对 agent 登记的
  checks 增显 evidence 摘要（命令 · 退出码 · 耗时 · 日志文件名，完整 logRef 进 title——人工 record-verification 无此字段，Phase-4 T5）；详情页**评审块**（final-arch step-3 T5，`delivery.review` 在场才渲染）：结论徽章（评审通过 / 返工（code|spec））+ 候选摘要短码（前 8 位，完整 digest 进 title）+ 意见全文（pre-wrap）+ 时间——与验证证据块同区展示；**验收块**（final-arch step-4 T4，`delivery.acceptance` 在场才渲染，同区同款）：验收时间 + 候选摘要短码（前 8 位，完整 digest 进 title）+ 验收意见（pre-wrap）。
  设置›工作区（WorkspaceManager）：
  work-items+workflows 双开时显示「交付自动化」配置块（enabled 开关 + **评审阶段开关（final-arch step-3，`stages.review.enabled`——开 = 先审后跑：候选先进 reviewer 人工评审、pass 才跑检查；关 = 候选直接进系统检查步（缺省，旧流程零变化））** + **集成命令（final-arch step-4，`stages.integrate.{enabled,command}`——开关 + 命令输入（`{repositoryId}`/`{branch}` 占位符提示）；开启而命令空白在保存前客户端拦截（文案与服务端 parseStages 一致 `stages.integrate.command is required when integrate is enabled`）；关闭时命令保留——回开免重写）** + **验收门开关（final-arch step-4，`stages.acceptance.enabled`——开 = 发布前须人工登记验收）** + **三开关 PUT 原样回传——不带 stages 的保存会把手设开关打回 false** + **四行角色表（Seam-repositioning T4，DELIVERY_ROLES 序）× 四列——剧本下拉（选项 = `/api/subagents/profiles?cwd=<工作区路径>` 过滤出的 project 作用域剧本，首项「同名」= 不写 `roles.<role>.profile` 键）/ ModelSelector 模型覆写（占位 = 角色摘要的有效模型与来源，清空 = 删 model 键、profile 也空则整键剥掉）/ 状态列（GET `…/delivery/roles` 只读投影：存在〔模板 vN〕/ 缺失 + 播种或创建提示）/ 操作——编辑剧本（写 settings-navigation 选中记录 + `onOpenAgentsSettings` 请宿主切设置›Agents 预选该剧本）· 预览 prompt（抽屉三段：AGENTS.md ▸ 不变式锁定段 ▸ 剧本正文，composed 与 launch 同一函数）** + 预算只读「失败上限 N 次 ·
  执行上限 M 分钟」+ **verification.checks 行编辑器（Phase-4 T5：name/仓库/命令/超时（秒）四列 + 行删除；整行空白丢弃、名称/命令只填其一报错拒存、
  timeout 校验 1–3600；无有效行 = PUT 不带 verification 键 = 无配置；空清单有引导文案——系统检查步按此清单执行（final-arch step-3 起，原 verifier 领证语义），agent 只能触发不能自造）**
  + 保存 PUT `/delivery`——budget、stages 与各角色既有 model 覆写原样回传保 round-trip；响应 `seeded.written` 非空出「已播种 N 份剧本到 .pi/agents/」提示（`seeded` null 防御——播种失败时 `seeded: null` + `seedingError`，配置已保存，只出琥珀色非阻断警告不报错），保存成功一律重取角色摘要（播种落新文件、清覆写/切别名同样改投影）；配置结构是
  delivery-runner/config 的客户端镜像类型（角色词表从零依赖的 roles.ts 直引，不拖 node:fs 进浏览器 bundle）。
  看板投影在 `work-item-phases.ts`（纯模块）：老子阶段（analysis/
  requirement_approval/plan_approval）投影进 design 列但**显示原始 phase 标签**（不谎报已进标准列）；老 `complete` 投影进
  released 列但经 `isHistoricalComplete` 收进「历史已完成」折叠组——**不推断已发布**（「旧 complete ≠ 已发布」）。筛选/排序
  纯逻辑在 `work-item-queries.ts`，HTTP 封装在 `work-item-api.ts`。**深链**：`?workspace=<id>&page=work-items[&item=<key>]`
  （builder/parse 同居 `lib/work-items-page-url.ts`，`buildWorkItemsPageUrl` 返回**裸 query**——navigateUrl 自补 `?`；
  解析在 `applyUrlToTabs` 里先于 tab 投影，页面是 CenterPage 不是会话 tab；✕ 关闭/选中项变化 replace 重写 URL 不埋历史
  陷阱）。**入口与宿主（2026-10 弹窗改版）**：桌面「打开完整管理」（右坞快捷面板顶部 + 总览工作项卡头）→ **大弹窗**
  （DesktopShell 的 `workItemsManager` 态，`openWorkItemsManager(wsId)`：fixed 遮罩 zIndex 1100 + min(1280px,96vw)×
  min(860px,92vh) 圆角容器内宿同一 `WorkItemsPage`（不传 `onReplaceUrl`——弹窗不写 URL；Escape/遮罩/✕ 关闭；「查看会话」=
  关弹窗开聊天 tab + `openDockModule` 定位快捷面板）；rail 图标单击语义不变）；**中央整页（CenterPage kind="work-items"）保留
  给 URL 深链与移动端目的地页**——弹窗/整页/快捷面板三宿主共用同一 `useWorkItems` store，mutation 后即时互见；视图偏好
  `pi-work-items-view:<wsId>` 扩为 list/board/cards 三值（旧二值天然兼容）。快捷面板列表已切
  `useWorkItems` 共享层（与中央页单轮询器）。移动端 work-items 目的地页宿 `WorkItemsPage` 本体（capability 门控沿用模块条——入口不渲染则
  页面不可达；窄屏 ≤640px：看板/卡板回落为列表、详情全屏覆盖；`onBack`=‹返回回聊天；「查看会话」= 关目的地页回聊天再
  locate 开会话；`onOpenLoopsRecovery` → loops 目的地页）。中央页「查看会话」= 关中央页开会话 tab + `openDockModule(ws,
  WORK_ITEMS)` 定位快捷面板；工作项详情的**执行中断跳转**：`item.loop` 命中 loops interruptions → 「去处理」跳 Loops rail
  模块（`onOpenLoopsRecovery`）。
- **Archive cascade** (`lib/archive-cascade.ts`): archiving a work item tucks its conversations into the session
  archive **only if no other active work item references them**; restoring brings them back. Sessions are physically
  moved to a `.archived/` subdirectory (`lib/session-archive.ts`) so `SessionManager.listAll()` no longer sees them.

### Delivery 自动执行（designer + developer + reviewer + release-preparer 四角色 + 引擎 system 检查步；`lib/work-items/delivery-runner/`，2026-10 Phase-2 → Phase-3 → Phase-5 + final-arch step-3；Phase-4 verifier 已退役）

Phase-2 落了**首个自动化角色 designer**（intake 需求 → design.md + 验收条件 → 等人
confirm-design）；Phase-3（2026-10）**第二个角色 developer 上岗**（ready_for_implementation
领取 → `prepareWorktrees` 每仓 worktree 隔离 → 候选 commit 提交进 verification）；Phase-4
（2026-10）第三角色 verifier 上岗、**final-arch step-3（2026-10-26）退役**——verification
阶段的检查执行收编为**引擎 system 检查步**（`checks-step.ts`：无 LLM 会话，`role: "system"`
占槽跑配置命令，见下）；reviewer 接任「先审后跑」的人工审查轮；Phase-5（2026-10）**第四角色
release-preparer 上岗**（release_ready 领取 → 基于已确认设计/候选/验证证据起草发布说明与
回滚办法 → submit 写 `delivery.releasePlan`、phase 停 release_ready 等**人** record-release）。
**完整流水线 = designer（intake 起稿）→ 人 confirm-design（归一 status open——回队列可领）→ developer（rfi worktree
实现）→〔review 开启时〕reviewer（人工评审，pass 放行 / rework 按 code|spec 打回）→ 引擎
system 检查步（候选 checkout 执行人配置检查；checks 全过后**〔integrate 开启时〕在候选 checkout 内逐仓执行集成命令**——
失败 = blocked 整回合重跑）→ release-preparer（release_ready 起草发布
材料）→ 人 record-release（**〔acceptance 开启时〕须先人工 record-acceptance——验收门**）→ released——双人工门（confirm-design / record-release）+ 可选
评审门（`stages.review.enabled` 缺省关）/ 集成段（`stages.integrate.enabled` 缺省关）/ 验收门（`stages.acceptance.enabled` 缺省关）**。合并
角色池 + 按条目角色分派，角色共享单槽位/工作区与同一失败预算（reviewer 裁定与 system 检查
结果不计预算）。多槽位并发、任务依赖图、
并行检查（checks 顺序执行）、验证环境预装（依赖安装由命令自身负责，如 `npm ci && npm test`）、
worktree 自动清理均**未实现**（spec §2 留后续阶段——worktree 由人手动清理，
不合并不推送是合同纪律）；rework↔重提乒乓无闸是已知阶段级观察（见「已知边角」）。

- **配置 `.pi/delivery.yaml` v2**（`config.ts`；路由 `GET|PUT /api/workspaces/[id]/delivery`）：
  `{schemaVersion: 2, enabled, roles: { designer? / developer? / reviewer? / release-preparer?: {profile?, model?} }（Seam-repositioning T1：四键同形、各自可选，词表 = `roles.ts` 的 `DELIVERY_ROLES`——未知角色键（拼错如 desginer）→ Validation；legacy 键 `roles.verifier`（已退役）**接受并忽略** + 每进程恰一次 console.warn，旧配置文件 GET/PUT 都不 400；v1 旧文件照常解析、输出恒 2——落盘即迁移）, budget: {maxAttemptsPerInput, maxExecutionMinutes}, verification?: {checks: [{name, repositoryId?, command, timeout_seconds? 1–3600}]}（Phase-4 T1：人维护的验证命令——agent 只能触发不能自造；repositoryId 缺省 = 候选首仓）, stages: {review: {enabled: boolean}, integrate: {enabled: boolean, command?: string}, acceptance: {enabled: boolean}}（final-arch step-3 T1 / step-4 T1：解析后必有、缺块回填三开关全关。review = 先审后跑开关——开 = 候选先进 reviewer 人工评审，pass 才放行跑检查。integrate = 集成段开关——enabled 时 command 必填非空（精确文案 `stages.integrate.command is required when integrate is enabled`），关闭时 command 可选保留（回开免重写）。acceptance = 验收门开关——release 前须人工验收记录。未知 stage 键 → Validation）}`,
  budget 缺省 **3 次 / 30 分钟**、enabled **缺省 false**（文件缺失 = GET 返回 `{config: null}` = disabled）；
  坏 YAML/坏结构 → Validation（HTTP 400）；PUT 写入前过 capability 门 `assertAutomationCapable`——manifest 须
  同时含 **work-items + workflows**（`workflows` capability 自此激活自动执行含义：配置写入 + 工具挂载 +
  dispatcher 每拍复验都吃这道门）；**PUT 写入成功后播种剧本模板**（`role-templates.ts` 的 `seedRoleProfileTemplates`：每角色**只播一次**，一次性记录在产品持有的 `<ws>/.pi/delivery-seeded.json`（`{schemaVersion: 1, roles}`）——已记录角色 skipped（用户删了 `.pi/agents/<role>.md` 也不重建，删除即终局）；未记录且文件在场（或 `wx` 撞 EEXIST）→ 收养记 `"existing"`、永不写；未记录且缺文件 → `wx` 写模板、记 `"<role>@<ROLE_TEMPLATE_VERSION>"`（**final-arch step-3 T4 起版本 2**：全角色模板随 reviewer 上岗重写——`seeded_from` 含 `@2` 的工作区不再被覆盖）；记录不可读/畸形 → fail-safe 一字不写、全 skipped + `console.error` 一次。记录变更经 `writeAtomic` 回写。播种包在自身 try/catch 内：失败 → `console.error` + 200 `{config, seeded: null, seedingError}`——配置已落盘，保存不因播种失败而报错；成功则响应 `{config, seeded}` 带 written/skipped 角色列表）。UI = 设置›工作区「交付自动化」配置区（WorkspaceManager，双 capability 开
  时显示；`config:null` 播种默认镜像，budget/stages 与各角色既有 model 覆写原样回传——见「前端」条目）。
- **交付初始化 + 就绪清单（`lib/workspaces/delivery-init.ts`，final-arch step-6 T1；spec §13.2/§13.3/§13.5.1——「Nth project」故事：新建与导入一视同仁）**：
  `initializeDelivery(ws, input)` **只补缺、只建议**，重跑幂等，六步：①仓库扫描对账（`syncRepositoriesFromScan`，不走 list 的 TTL/每仓 git 子进程）→ ②delivery.yaml **缺失才写** v2 默认（`enabled` 恒 false——启用是人的手；checks 草稿经 parse 校验，integrate 开着没命令在此 400；**已存在一字不动**）→ ③剧本播种（一次性记录，同上条）→ ④from 同布局目录（`.pi/` 在场）四活角色剧本**缺文件才复制**（frontmatter `seeded_from` 剥换 `copied_from`——复制即新所有者，源改动不传播）+ integrate.sh（缺文件才写、755）；AGENTS.md / delivery.yaml **永不复制**，from 的 checks 剥 repositoryId 只进响应草稿 → ⑤工具链探测（活跃 code 仓根 marker 文件 → 命令草稿：pom.xml→`mvn -q test` / package.json→`npm test` 等；只读盘不执行）→ ⑥写后就绪投影。响应 `{actions[], suggestedChecks?[], readiness[]}`——探测与 from 草稿**只进响应**供人确认，不落盘、不执行、不翻任何开关。
  `deliveryReadiness(ws)` = 五类缺项**只读投影（非门禁，enabled 不受它约束）**：`no-checks` / `missing-profile:<role>` / `capabilities-missing` / `check-repo-unregistered` / `integrate-no-command`（kind 序即展示序），另带 `currentTemplateVersion`（`ROLE_TEMPLATE_VERSION`——角色表模板漂移提示的对照值）；strict 解析拒绝的手写坏配置按宽容读兜住投影（宁可报缺项不炸面板）。UI：设置›工作区配置块「初始化」区（from 目录输入 + 检查草稿行〔预填最近一次响应 suggestedChecks，可编辑〕+「运行初始化」→ 动作清单 + 建议命令表 +「采用为验证命令」〔只复制进 checks 编辑器，不自动保存〕）+「就绪清单」常驻（load / 保存成功 / init 成功三时机刷新，无新定时器；空 = 已就绪）。
- **模板另存（`role-templates.ts` 的 `writeRoleTemplateCopy`，final-arch step-6 T3）**：把**当前**内置模板写到
  `<ws>/.pi/agents/<role>.template.md`——flag `wx` 写即全新，副本已在 → `WorkItemConflictError`（409），**永不覆盖**；
  **永不碰 `<role>.md`**（剧本文件归工作区，另存不是应用）与播种记录（播种一次性语义不动）——副本只是参考件，用不用、怎么改是人的手。UI：WorkspaceManager 角色表状态列在 `seeded_from` 为 `"<role>@<n>"` 且 `n < currentTemplateVersion`（readiness 响应携带）时出「模板已更新 v<n>→v<cur>」+「另存新模板」（成功提示副本路径；409 → 「副本已存在」）。
- **`.pi/agents` profile 的 `content_hash` 乐观并发 + AgentsConfig 交付感知（final-arch step-6 T2/T3）**：AgentsConfig 保存 profile 时显式带列表态 `expectedContentHash` 才设防——文件被外部改过 → 409（内联提示 + 重载取新哈希再存）；不带 = 不设防（创建/改名/换作用域/global）。哈希 = 正文 sha256，读时现算不信任存储值（`lib/subagents.ts` + `subagents.profile-hash.test.mjs`）。AgentsConfig 交付感知（被绑定交付角色剧本的编辑区上方**锁定渲染**引擎不变式〔灰底 + §4.3 出处链〕+ 折叠「组合预览」段〔`composed` 与 launch 同一函数产出〕）只在宿主显式传 `workspaceId` 时启用——组件只有 cwd（可能来自会话而非登记工作区），**不发明「路径→id」查找**；角色徽标（列表侧栏）同因留待 workspaceId 接线后落。
- **池子（`pool.ts`，Phase-3 合并双角色 / Phase-5 增 release-preparer；final-arch step-3 起 verification 按 `reviewPending` 分流）**：就绪任务不是存储实体——
  `projectDeliveryPool` 是**纯投影**
  （零 fs，全部输入含每项 requirementDigest 与 manifest 仓库登记表由调用方传入，只比较/排序/只分桶）；
  `listDeliveryPool` 是读取端装配器（`listWorkItems` 活动项 + 配置 + 每项运行时信号 claim/未确认中断/
  paused/失败计数 + `contentDigest(README)` + 登记仓表）。**角色由项所处阶段决定**（`DeliveryRole` 四活值）：
  `ready_for_implementation` → developer，`verification` → **`reviewPending` 分流**（欠审 → reviewer；
  过审或 review 关闭 → **不再是 LLM 可领任务**——交给引擎 system 检查步，P2 语义落 designer wrong-phase 桶），
  `release_ready` → release-preparer，
  其余 → designer——designer 谓词
  P2 行为逐字节不变（phase===intake，非 intake 照旧 wrong-phase）。共用检查（各角色同）：无 claim ∧ 无未确认中断 ∧ 未 paused
  ∧ **任一未答澄清（`awaiting-answer`，final-arch step-2——人工答复是恢复可领的唯一出口，见 ask-a-human 条）** ∧ 尾部连续失败未达上限 ∧ **status ∈ {open, blocked}（白名单而非黑名单**——claim 事务写 in_progress 后
  即便 claim.json 未落盘也不再投影 ready，双派发窗口两头堵死）∧ 未归档；developer 谓词另加 **designConfirmed
  真值 ∧ 仓库范围非空 ∧ 范围内每仓已登记且 active**（新 reason：`design-unconfirmed` / `no-repo-scope` /
  `repo-not-registered`；manifest 缺失/损坏 → 空登记表，developer 项以 repo-not-registered 可见、designer 项不受影响）；
  reviewer 谓词（final-arch step-3 T2，先审后跑）另加 **review 阶段开关开启（`stages.review.enabled`——关闭时
  verification 项直接交给 system 检查步，不走 reviewer） ∧ 候选非空（候选即评审对象，空 → `no-repo-scope`）**
  ——reviewer 读代码与方案，不是检查执行者（claim 冻结的 checkContexts 仅供
  `delivery_run_check` 佐证）；release-preparer 谓词（Phase-5 §2）
  另加 **`delivery.verification` 存在（`verification-missing`） ∧ verification.candidateDigest ===
  candidatesDigest(现行候选)（`stale-verification`——候选被换**或**被清都失配，旧验证下的材料不许准备） ∧
  `delivery.releasePlan` 未存在（`release-plan-exists`——**循环闸**，Phase-5 T2 补：没有它 submit 写完
  releasePlan 后池子仍 ready，下一拍重领重写循环；已准备过的项不再自动重派，人重新起草走人工 prepare-release
  路由覆盖）**——纯文档角色谓词不消费登记仓表与 checks。**`reviewPending`（共用判定，永不漂移）= review 开启
  ∧ 候选集尚未「pass 审查」**（无 review 记录，或 review.candidateDigest ≠ candidatesDigest(现行候选)——候选
  被换即重新欠审）；同一判定三处消费：verification 角色投影（欠审 → reviewer）、checks-step 的 `checksDue`
  （欠审 → `awaiting-review`）、reviewer claim 事务的 poolRecheck。输出**多角色合并同一队列**
  P0→P3→key 排序（角色不作 tiebreaker），每条目带 role，原因累积不短路。
- **worktree 预建与候选核验（`worktrees.ts`，Phase-3 T2；Phase-4 T2 增候选 checkout）**：`prepareWorktrees`——项仓库范围内每**登记且
  active** 的仓建一个 git worktree（复用 `lib/worktree.ts` 的 `addWorktree`：分支 `pi-delivery/<KEY>/gen<N>`，
  目录在仓旁 `<repoRoot>-worktrees/<sanitized branch>`）；先整表解析登记（未登记/removed 建任何 worktree 之前
  拒绝），再逐仓建/复用；**幂等 = 同 generation 复用既有 worktree**（`listWorktrees` 按分支找现 path）；
  任一仓失败整体抛、**已建的不回滚**——孤儿 worktree 无害（下代领取用新分支，不与旧代冲突）。
  `verifyCandidateCommits`——每候选 `git rev-parse --verify <commit>^{commit}` 核验（repoPaths 必须含该
  repositoryId；ref 非 40-hex 也接受——rev-parse 语义，提交时原样存储展示）；同步 spawnSync（锁内纯读，毫秒级）。
  `prepareVerifyCheckouts`（Phase-4 T2；final-arch step-3 起消费方 = reviewer claim 与引擎 system 检查步——原
  verifier claim 前置）——每候选仓一个 detached checkout：两步法
  `addWorktree(repoPath, pi-verify/<KEY>/gen<N>)`（分支仅作目录名载体）→ `git checkout --detach <候选 commit>`；
  幂等 = 同 gen 目录在场则跳过创建但**仍 checkout 目标 commit**（修复半建残留；预检用确定性 existsSync——
  detached 后 porcelain 不报分支）；失败零状态已建不回滚（generation 单调）。
- **运行态与审计（`attempts.ts`）**：`<item>/delivery/runtime/{claim.json, automation-paused.json,
  failure-window.json}` 是 advisory 运行态（claim.json 带 `role`（final-arch step-3 起类型 = `AnyDeliveryRole | "system"`——活值四角色 ∪ legacy verifier（旧记录原样可读）∪ 引擎 system 步；developer 领取另附
  `designDigest`（锁内自算的 design.md 摘要快照）与 `worktrees`（prepareWorktrees 产物清单）；reviewer/system 步领取另附
  `candidateDigest`（候选集摘要快照）+ `worktrees`（候选 detached checkout 清单）+ `checkContexts`（领取时冻结的
  检查配置快照 [{name, repositoryId 已解析, command, timeout_seconds}]——配置变更不追溯）+ `checkResults`
  （证据仓：`recordCheckResult` 累积，同名覆盖/新名追加——LLM 无注入口）；release-preparer 领取（Phase-5）只附
  `candidateDigest` 快照——纯文档角色无 worktrees/checkContexts/checkResults；**system claim 无 ownerToken**
  （`ownerTokenHash` 空串占位——结算以 sessionId 归属校验替代，不经 requireActiveClaim 凭据）；**claim 首写
  runtime/ 时幂等接进工作区 .gitignore**；读路径宽松——缺失/坏 JSON 一律按「无」）；`<item>/delivery/attempts/
  <attemptId>.json` 是追加式审计（含中断记录与 role，developer 的 submit/fail 附 candidates/worktrees；reviewer 的
  submit 附 review 判定（DeliveryReviewRecord 全量）+ verificationOutcome 词表（verified|rework|unverified）随 system 步落全量 checkResults；release-preparer 的 submit 附 releasePlan
  （{notes, rollback?} 发布材料审计拷贝）；永不删
  除；resolveInterruptions 只清 needsAttention + 记诊断）。**ownerToken 只存 sha256 哈希**（`hashOwnerToken`）——
  明文只在进程内 role grant 存活，永不落盘。claim/paused 走同步原子写（`writeAtomicSync` 镜像 service 习语），
  attempts 异步追加（复用 `writeAtomic`）。
- **领取事务（`claim.ts`，designer 三函数 P2 + developer 三函数 Phase-3 T3 + reviewer 三函数 final-arch step-3 T2（接替退役的 verifier 三函数）+ release-preparer 三函数 Phase-5 T1 共用同一套重放/并发/复验骨架）**：
  `claimDesignerTask` / `claimDeveloperTask` 全程 `withWorkspaceWriteLock`——幂等重放（claim.lastRequest 同
  requestId → 现 grant、ownerToken 空串不重建）→ **事务内双检**（manifest capability + 配置 + 复用
  `projectDeliveryPool` 谓词且要求投影角色与本事务一致——claim 与池子读同一套规则，永不漂移）。designer：
  design.md 播种（复用 M2 `DESIGN_SEED`，缺失才播）→ claim.json（先于 item.yaml：崩溃窗口两头堵死）→ phase
  intake→design + status=in_progress + `delivery.claimed` 事件 + workspace git commit（产物先落盘、状态后改）。
  developer：**`prepareWorktrees` 在任何状态落盘之前**（任一仓失败整体抛 = 零状态，已建孤儿不回滚）→ designDigest
  锁内快照 → claim.json（带 worktrees 清单）→ phase ready_for_implementation→implementation（事件 data 带
  worktrees）。`submitDesignerResult`：写 design.md（正文 + 合成「## 验收条件」节）→ 清 claim → attempt
  submitted → status 回 **open**、phase 保持 design 等人 confirm-design（designer 不推进确认；人在领取窗口内
  抢先 confirm → Conflict 409，不让确认证据静默过期）。`submitDeveloperResult`：`requireActiveClaim` 三凭据 +
  **role 匹配**（developer 凭证不得释放 designer 的 claim，反之亦然）+ **双 digest 复验**（requirementDigest
  ∧ designDigest——任一漂移 → Conflict）+ designConfirmed 仍真值 + **项仍在 implementation**（人推进过阶段 →
  迟到提交不覆写新状态）→ `verifyCandidateCommits` 候选核验（范围仓 = 领取时预建的 worktree 集）→ 按 M2
  submit-verification 语义**同构内联**（不调 `applyDeliveryAction`——其自取写锁不可重入；candidates 写入、
  verification 清空、phase→verification、status→open；候选是既有 commit，无新产物落盘）。`failDesignerTask`
  /`failDeveloperTask`：blocked 可选（白名单内仍可领）→ **回退守卫**（designer 仅 design→intake、developer 仅
  implementation→ready_for_implementation——人中途动作改了阶段则不回滚人的状态）+ `delivery.attempt_failed`；
  reviewer 三函数（final-arch step-3 T2，先审后跑；verifier 同骨架退役）：claim = 候选 detached checkout（`prepareVerifyCheckouts`）预建在
  **任何状态落盘之前** + **phase 不变**（verification 就是评审活动的阶段）+ claim 冻结 candidateDigest/
  checkContexts/checkResults 空仓（谓词双检 = reviewer 投影——review 开启且候选集欠审，见池子条）；
  `submitReviewerResult` = 三凭据 + role 门 + candidateDigest 复验（候选被换 → 409 释放重领）+ 阶段守卫（人
  窗口内推进 → 409）+ designConfirmed 仍在场守卫 → 写 `delivery.review`（**DeliveryReviewRecord**：outcome
  pass 无 source / rework 必带 `source: code|spec`（code 打回 ready_for_implementation、spec 打回 design 等人重新
  confirm）；notes rework 必填非空、pass 允许空串；candidateDigest/at/attemptId 绑定审计）——**pass：phase 不变
  （verification 等系统检查步）、status open；rework：共享 `reworkTransition`（`delivery.ts`，唯一「回退 + 清全部
  下游证据」实现——designConfirmed/candidates/verification/acceptance/releasePlan 清空〔acceptance 为 final-arch
  step-4 增补：验收随候选集失效〕，review 判定刻意保留，人要看为什么
  打回）且 review 仍写入** + `delivery.reviewed` 事件 → attempt submitted（携 review 判定）→ 会话自链接 → 清
  claim → commit。**无失败预算**（判定不是失败——不写 failure-window、不触暂停）；`failReviewerTask` =
  **phase 不动**（无阶段可归还，只归还 status；blocked 可选——环境/依赖问题落 blocked 白名单内仍可领），
  fail **照常计失败预算**（与 pass/rework 判定的「无预算」刻意相反）；release-preparer 三函数（Phase-5 T1，spec §2）：claim = **无环境预建**（零 git 操作——
  纯文档角色）+ **phase 不变**（准备发布材料就是 release_ready 阶段的活动）+ claim 冻结 candidateDigest 快照
  （同 reviewer 先例）；submit = 三凭据 + role 门 + candidateDigest 复验（候选被换 → 409）+ **阶段守卫**（人
  record-release → released 冻结基线不被迟到提交覆写 → 409）+ **verification 仍在场守卫**（领取窗口内 block 清了
  验证 → 409——材料必须由验证证据支撑的 structural 不变量）→ 写 `delivery.releasePlan = {notes 必填, rollback?
  （空白省键）}`（**M2 prepare-release 语义的 actor=agent 变体**）、**phase 保持 release_ready**、status→open、
  `delivery.submitted`（data.outcome="release-plan"）→ attempt submitted 附 releasePlan 拷贝 → **永不写
  `delivery.release`——record-release 与实际发布永远是人**；fail = **phase 不动**（同 reviewer 形态，无阶段可归还）；`recordCheckResult` 无业务锁轻量（heartbeat 习语：claim.sessionId 匹配才写）。服务端检查
  执行器 `checks.ts` 的 `runConfiguredCheck`——在候选 checkout 内 spawnSync `/bin/sh`（timeout 缺省 600s，
  超时/ENOBUFS → unverified + exitCode null），日志尾部 32KiB/流写 `<logDir>/<safeName(name)>.log`、logRef
  相对工作项根；**logDir 传 spec §7 布局 `<item>/delivery/artifacts/verification-logs/<attemptId>/`**（tools.ts
  的 run_check；system 检查步锁外执行同用此执行器）。
  凭证过期/README 摘要变化 → Conflict；**全部 submit/fail 共用的 `requireActiveClaim` 另有一道 cancelled 守卫
  （final-review 修复）：人在领取窗口内 cancel（M2 cancel 只写 status=cancelled）→ 迟到 submit/fail 一律 409
  零状态（claim 保留给 recordInterruption 清——恢复路径不经 requireActiveClaim，不受守卫影响），终态不被复活**。
  `heartbeatActiveClaim` 20s 轻量续约 lastSeenAt（不 bump revision/不产
  事件/不进 git）；`recordInterruption`（锁内清 claim + needsAttention attempt[role 随 claim 流动] +
  `delivery.exec_interrupted`；**状态归还（final-fix，runtime-proven）：claim 借走的 status=in_progress 复位
  open + claim 推进的阶段退回可领阶段（designer design→intake / developer implementation→rfi，守卫同
  fail——人窗口内改过阶段/状态不回滚；reviewer/release-preparer claim 不改阶段，phaseBack 为 null 只归还
  status；终态 cancelled/done 的 item.yaml 整个不动），否则 recover 后项被池
  白名单 + wrong-phase 双重排除、dispatcher 永不重派**；不进 git——关停路径不 spawn git，events.jsonl
  落盘即持久）；`resumeAutomation`
  （人显式恢复：清 paused + 写 failure-window（since=now）+ `delivery.resumed`；未暂停 → 400）。
- **失败预算**：= **自最近 resume 起的尾部连续失败**（`countRecentFailures`：从最新往回数 outcome=failed ∧
  digest 匹配 ∧ 窗口内的记录，**遇第一个 submitted 即停**——成功提交重新起算；interrupted 不计也不断），
  **单工作项作用域**（fix-round 裁定：不跨项按 digest 聚合）且**跨角色共享**（Phase-3 §8：按 digest 计数不问
  角色——designer/developer/reviewer/release-preparer 各角色的环境失败互相消耗同一预算，防角色间互刷次数绕上限；
  **reviewer 的 pass/rework 裁定与 system 检查步的全部三种终局都记 submitted 不算失败**——判定/检查结果不是
  执行失败，见「已知边角」乒乓闸一条）。同 digest 连续失败 ≥
  maxAttemptsPerInput → writePaused + `delivery.automation_paused`，自动领取停等人显式 resume（resume 重置窗口）。
  （`asked` 与 `interrupted` 同——ask-a-human 澄清轮不计失败也不断链，final-arch step-2。）
- **引擎 system 检查步（`checks-step.ts`，final-arch step-3 T3，2026-10-26——verifier 退役后检查执行的家）**：
  dispatcher 每拍先于派发按 `checksDue` 找 due 项，`runChecksStep` 三段事务执行，**无 LLM 会话**（claim
  `role: "system"`、`sessionId: "system:<ulid>"`、无 ownerToken——`ownerTokenHash` 空串，结算以 sessionId
  归属校验替代）。**`checksDue`（纯谓词零 fs，原因累积不短路）**：due ⇔ managed ∧ enabled ∧
  phase==="verification" ∧ 候选非空 ∧ 配置 checks 非空（`checks-empty`） ∧ 仓解析门（每 check 的
  repositoryId 缺省解析候选首仓，须在候选集内且 manifest 登记 active——`repo-not-registered`） ∧ 过审门
  （`reviewPending` 共用判定——欠审 → `awaiting-review` 等 reviewer） ∧ **checks-done**（verification 记录
  candidateDigest 与当前候选集一致 = 已验证过，不重跑） ∧ **状态门（含 `blocked-awaiting-unblock`：unverified
  落 blocked 后硬停——人修环境 unblock 才再次 due，不自动重试；in_progress = unblock 落点可跑；open 直跑）**
  ∧ 共用门（无 claim ∧ 无未确认中断 ∧ 未 paused ∧ 未归档；失败预算刻意不是本步的门）。**`runChecksStep`
  三段**：锁1 复验 due → 候选 checkout 预建（`prepareVerifyCheckouts`——任何状态落盘之前，失败 = 零状态）→
  写 system claim（candidateDigest/checkContexts 冻结、worktrees、空证据仓）→ status in_progress +
  `delivery.checks_started`（actor system）→ commit；锁外 逐条 `runConfiguredCheck`（真 shell、真候选
  checkout）→ `recordCheckResult`（heartbeat 习语累积）；锁2 复读 item+claim（归属/阶段/候选 digest 三重守卫——
  迟到或候选被换 → 释放 claim 跳过，下一拍按新输入复评自愈）→ **`finalizeChecks`（claim.ts 共享结算，
  actor "system"）**：全 passed → `delivery.verification`（actor system——**唯一机器证据**；evidence 命令取自
  冻结快照）+ release_ready + `delivery.checks_passed`；有 failed → `reworkTransition` 清下游证据（含
  acceptance）+ ready_for_implementation + `delivery.checks_failed`；任一 unverified → **blocked**（阶段不动、verification
  不写、下游不清——环境问题不是实现失败）+ `delivery.checks_unverified`。三者均：清 claim、attempt（role
  system、outcome submitted + verificationOutcome 判定——**全步零失败预算**）、commit。**integrate 集成段
  （final-arch step-4 T2——checks 步的延伸段，`stages.integrate.enabled` + command 才跑）**：checks 全 passed
  ∧ 开关开 → **结算前锁外**在同一批候选 checkout 内按 `claim.worktrees` 冻结序逐仓执行集成命令（`bash -c`、
  cwd = 该仓 checkout、`{repositoryId}`/`{branch}` 占位符原样替换、单仓上限 `INTEGRATE_TIMEOUT_MS` 常量 =
  600s、顺序执行**首败短路**——失败现场只报首败仓）；任一仓失败 → 专属终局 `"integrate-failed"`：
  **blocked 硬停 + `delivery.integrate_failed` 事件**（actor system，data 带首败仓 / exitCode|signal /
  stderr 尾部 ≤400 字符）+ attempt outcome `"integrate-failed"`——**检查结算不发生**（不写 verification）、
  **不进失败预算**，同 unverified：人 unblock 后整回合重跑（checks + integrate 再次执行）；全成功 → 结算
  照旧（verified/rework/unverified 分支零变化）。integrate 仅对后续新的 checks 回合生效——已带当前
  digest verification 的项不会补跑集成（候选变化才会）。**启动失败表面化（step-7 T1，2026-10-27）**：
  claim 写入前抛错（如候选 sha 不可解析——`prepareVerifyCheckouts` 零状态失败面）→ 锁外追加
  `delivery.checks_start_failed`（actor system，data 带 reason ≤300 字符 + candidateDigest 可算则带）——不改重试语义
  （无状态落盘、无 status 变化），去重 = events 末条已是同类型且同 candidateDigest 则跳过（**每连续失败串一条**，
  digest 变化或任何其他事件再武装）；attention blocked 类以它为锚点（detail = reason 原文）。任何异常：
  recordInterruption 清 claim + needsAttention 中断（人「重新检查并恢复」）；宿主关停/崩溃的残留 system claim
  由既有超时清道夫回收（probeSession null → 只记中断，无会话可 destroy）——不设第二套机制。
- **ask-a-human 与人工答复（final-arch step-2，2026-10-26，spec §5.4/§7）**：角色会话执行中问人 = `delivery_ask_human`
  工具 → **`askHumanQuestion` 提问事务（`claim.ts`，四角色同一实现——行为跨角色逐字节相同，不按角色出副本）**：
  requireActiveClaim（三凭据 + expectedRole + cancelled 守卫 + requirementDigest 复验）→ 澄清（id=ULID，
  {role, question, options?, recommended?, askedAt, attemptId}）**追加**进 `delivery.clarifications`（数组缺则建；
  answer/answeredAt 同在同缺——未答/已答两态，parse 半对即坏形；step-7 T1 起 `askedAt`/`answeredAt` 须可解析为
  合法日期（Validation → 400）——askedAt 是 attention question 条目的 since 锚点，坏串会把条目锚成 NaN 天龄）→ 清 claim（fail 同序——崩溃窗口内池子不再投影
  ready）→ attempt 记 outcome **"asked"**（reason = 提问全文）→ **phase 不动、status 归还 open、revision+1** →
  `delivery.asked` 事件（actor=agent，data 带提问摘要 ≤120 字 + clarificationId）→ conversationId 自链接 →
  git commit。**与 fail 的差异（刻意不做）**：不还阶段（问的是输入澄清不是失败）、不写失败预算（asked 不计不断，
  澄清轮不消耗暂停闸）。**ask 不幂等**——凭据随 claim 清除一次性失效。**人工答复** = 动作面第六动作
  `answer-clarification`（planDeliveryTransition case，final-arch step-2 T4）：clarificationId 必填且须存在（400）/
  已答再答 → 409 / answer 非空白（400）；**phase/status 一概不动**（答复只是补全输入——池门解除后同阶段重新可领）；
  **答案不可变**（改主意是 agent 的新问题，不是改写历史）→ 写 answer+answeredAt + `delivery.answered` 事件；
  requestId 幂等 + revision 乐观并发同其余动作——**刻意不做 LLM 工具**（与 confirm-design / record-release 同款
  「人的手」）。
- **record-acceptance 与 record-release 验收门（final-arch step-4 Task 3，2026-10-26）**：人工动作
  `record-acceptance`（`planDeliveryTransition` case）= release_ready 原地记账——phase/status 一概不动，把验收
  记录 `delivery.acceptance`（notes 必填非空 + candidateDigest = `candidatesDigest(当前候选)` + at）落进块内；
  event = `delivery.accepted`（data.candidateDigest）；重登记 = 覆写（last write wins，同 verification）；**验收
  不通过不是 fail——走 rework 重开下游**（reworkTransition 清 acceptance，须重新挣得）；released 基线冻结不含
  此动作。**record-release 门（`stages.acceptance.enabled`）**：开关开启时放行必须先有 `delivery.acceptance`
  且其摘要与当前候选集绑定（无记录或候选换过 → 拒「先完成验收（record-acceptance）」）；开关由 apply 读
  workspace config 后经 `options.acceptanceRequired` 注入纯函数（与 digests 同款）；**开关未开（缺省）行为
  不变**；门只卡 record-release——与 release-preparer 的 releasePlan 起草**并行**（起草不问验收，放行才问）。
  `record-acceptance` 与 confirm-design / record-release 同款「人的手」**刻意不做 LLM 工具**。同批：M2 人工
  动作 `confirm-design` 归一 **`status: "open"`**（此前不写 status——人工 rework target=design 落 in_progress
  后原样保留，项进了 developer 可领阶段却永不能被 LLM 角色领取；设计确认即设计阶段收工 → 回队列）。
- **角色授权（`role-grants.ts`）**：**globalThis 单例** Map（sessionId → RoleGrant——`role` 为 `DeliveryRole`
  （designer|developer|reviewer|release-preparer 四活值，final-arch step-3 T1 起 reviewer 进表；HMR/jiti 双载共享同一张表——Map 分裂会让授予与校验落在两个登记簿、
  身份门全瞎）。dispatcher 拉起会话时 `grantRole`、结束钩子 `revokeRole`；`setGrantToken` 只由工具回调把 claim
  服务一次性核发的 ownerToken（连同 attemptId/generation）补进**已有** grant（工具层不能自授身份）；
  `hasAnyActiveExecution`——**裸授权即占槽**（授予到领取的窗口不许起第二个会话双派发；不问角色——跨角色
  单槽位天然成立；system 检查步不经 grant——readClaim 非空即占池槽位）。
- **LLM 工具（`tools.ts`，`createDeliveryRunnerExtension`，extension 名 `pi-delivery-runner`）**：六件
  `delivery_list_ready_tasks / delivery_claim_task / delivery_submit_result / delivery_fail_task /
  delivery_run_check / delivery_ask_human`（list 列多角色合并池、每条带 role；claim/submit/fail 按 `grant.role` 分派
  designer/developer 对应服务，Phase-5 T2 增 release-preparer、final-arch step-3 T4 增 reviewer 三路分派（claim/submit/fail
  三入口同补——否则 release-preparer 凭证落进 designer 服务被 role 门拒；退役的 verifier 分派已删——system
  检查步不经工具）；submit 参数是**扁平可选字段组**——key 必填 +
  design_markdown/acceptance_criteria（designer）、candidates/notes（developer）、outcome/source/notes
  （**reviewer——判定三元组，检查结果佐证走 run_check，参数里没有任何检查字段**）与 release_notes（**release-preparer 必填**——发布
  说明正文）/rollback_notes（可选，回滚步骤）全可选；**禁止 union/any-of 形参数
  schema**（2026-10-24 Phase-3 smoke 实测：联合
  schema 在该 pi SDK 的调用侧解析不工作，真 LLM 会话参数全落 `{}` 被 schema 校验全拒，测试钉死不回潮），**服务端按
  grant.role 校验形状**，错形状 → validation 结果文本不进服务）。**`delivery_run_check({name})`（Phase-4 T4，
  final-arch step-3 T4 起身份门 = **reviewer**（原 verifier 专属随角色退役换门——他角色 → denied 文本非异常）**：按 name 在 claim.checkContexts（冻结快照）找配置 → 对应仓的
  候选 checkout（claim.worktrees 按 repositoryId 匹配）→ 服务端 `runConfiguredCheck`（spawnSync 在业务锁外）→
  `recordCheckResult` 累积进 claim.checkResults（**同名覆盖 = 幂等重试**）→ 返回 {name, outcome, exitCode,
  durationMs, logRef}；**产物只是 reviewer 评审的佐证——机器证据的唯一来源是 system 检查步的
  `delivery.verification`（actor system）落块**；item 定位 = 本会话名下 reviewer claim 扫描（结束钩子兜底同习语）；未知名 → validation
  文本带可用名单。**身份 = `ctx.sessionManager.getSessionId()` +
  `roleGrantOf` 核对**（无 grant / grant 属他工作区 → denied 结果文本，非异常——cxin loop 轮/普通交互会话天然
  无角色身份，拿到拒绝）；凭证三元组（ownerToken/attemptId/generation）全程住进程内 grant，**不进参数
  schema、不进 LLM**；claim 工具结果 **developer/reviewer 附 worktrees 清单**（claim.json 随领取落盘，重放同样
  在场——开场合同不写死路径、以它为准；reviewer 另附 checks 冻结清单——run_check 的名字来源；designer/
  release-preparer 不带 worktrees/checks 键——纯文档/纯设计角色零环境）；requestId 确定性
  （`claim:<sessionId>:<key>` 等）——传输层重试命中服务幂等重放分支；submit/fail 成功后 grant 重置回裸授权
  （过期凭证不得复用）。**`delivery_ask_human`（final-arch step-2 T3）**：四角色通用的问人出口——参数
  {key 必填, question 必填, options?, recommended?}（同样扁平可选字段组、禁 union/any-of），服务端
  `askHumanQuestion` 单实现（expectedRole = grant.role，见 ask-a-human 条）；成功即清 claim / attempt 记 asked /
  凭据一次性失效（ask 不幂等，无重放键）；返回 clarificationId + 现态给会话收尾。confirm-design /
  record-verification / prepare-release（人工覆盖自动材料）/ record-release / block / unblock / cancel / rework 等
  **人工/动作面刻意不做 LLM 工具**
  （住 M2 delivery 路由——确认、放行与发布登记是人的手）。
- **角色会话（`role-session.ts`，Seam-repositioning T2 终形 `launchRoleSession`）**：两步创建序——
  `createSession` 不带 command → **`grantRole`（先于 prompt）** → `markDeliveryExecutionActive` →
  `set_session_name`（`${role} · <KEY>`）→ 开场 prompt（fire-and-forget，不 await 轮结束）。**系统提示
  装配序（spec §6.1 唯一通道）= 工作区 AGENTS.md（pi 从 cwd 注入，既有）+ `AGENT_INVARIANT_CONTRACT`（四角色
  一致的回合不变式，六条全文钉于终局 spec §4.3.1——lib 常量、工作区不可覆写，改文先改 spec；内插位仅 role
  与 key）+ 剧本正文**，经 facade `CreateSessionInput.appendSystemPrompt` 注入（`composeRoleSystemPrompt` =
  不变式 + 空行 + 正文；空白正文按缺席——仅不变式、无尾分隔符）。**剧本 = 角色差异的唯一载体（真接缝）**：
  剧本名 `resolveRoleProfileName` = `roles.<role>.profile ?? 角色名`（缺省同名约定
  `<ws>/.pi/agents/<role>.md`）；`readRoleProfile` 读剧本文件 → `{model?, body, seededFrom?}`（frontmatter 的
  model 按 `provider/modelId` 首个 `/` 拆分、正文 = frontmatter 之后全文 trim；缺文件/名字非法 → undefined；
  刻意只读工作区 `.pi/agents` 目录——不走 resolveSubagentProfile 的跨 user/project 作用域解析，交付剧本无
  同名歧义）。**模型优先级 = `roles.<role>.model` → 剧本 frontmatter model → 会话默认**（`CreateSessionInput.model`
  透传 StartSessionOptions）；剧本缺场（缺文件/非法名）→ `console.warn` 一条后仅以不变式开场，读盘异常 →
  error 记录当缺场——配了剧本读不到不打死 launch。四段角色专属硬编码合同（designer/developer/已退役的
  verifier/release-preparer）与 `readDesignerProfileModel` 已删——职责/产出/方法全部归剧本（产品缺省剧本 =
  `role-templates.ts` 模板播种，见配置条目；`LaunchDeps.readProfile` 为读剧本注入缝）。开场 prompt =
  `openingPromptFor` 单一通用四步（列池 → 领指派项〔本轮只领这一项，不可领取即说明并结束〕→ 按领取返回的
  上下文依剧本工作 → submit/fail 结束），仅首行 role 字样不同——领取上下文（需求、上游产物、worktree 或
  检查清单）由 `delivery_claim_task` 返回带给会话，不进系统提示；final-arch step-2：上下文携带已答澄清时
  四步之后追加「人的答复」段（`openingPromptFor`，按 askedAt 升序、仅已答——未答被 awaiting-answer 池门挡在
  ready 外，永不出现在任务包）。**心跳** 20s 续约（interval
  unref，四角色共用同一常量）；**结束钩子**（`wrapper.onDestroy`，先于开场 prompt 武装）：launch key 快路径 +
  **全活动项 claim 扫描兜底**（兜住违约领取——本会话 sessionId 名下每个未清 claim 都 recordInterruption）→
  revokeRole → 清 delivery 登记 → 停心跳（钩子/心跳/登记 role 无关——claim.sessionId 匹配，不问角色）；装配
  失败显式收尾 + destroy 后重抛。
- **角色摘要与组合预览（`role-preview.ts`，Seam-repositioning T4 只读投影）**：`summarizeRoles(ws, config|null)`
  按 DELIVERY_ROLES 序出四行——剧本名/路径/在场/是否显式（`roles.<role>.profile` 在场）/`seededFrom`（播种
  标记「模板 vN」的依据）+ 有效模型与来源（override|profile|default，优先级与 launch 同一解析序；config
  null = 文件缺失按全缺省投影）；`previewRolePrompt(ws, role, config|null)` = 摘要行 + 三段（`<ws>/AGENTS.md`
  全文——仅展示，pi 从 cwd 注入不参与 composed；`AGENT_INVARIANT_CONTRACT`；剧本正文）+ `composed`——与
  launch 的 appendSystemPrompt **同一函数**（key 用 `<KEY>` 占位），杜绝「预览与实际不一致」。复用
  role-session 的读取器（readRoleProfile；摘要与预览**每投影恰一次读盘**——共用同一次读取，读盘异常 →
  console.error 一条后按缺场，与 launch 同口径；`ProjectionDeps.readProfile` 为注入缝），不另建状态存储。
- **Dispatcher（`dispatcher.ts`，HostJob `delivery-dispatcher`）**：30s tick（首拍立即，timer unref），由
  `ensureHostBooted` 装配为**第二个 HostJob**（**lazy import**——work-item 服务不进 resident bundle；
  `PI_TEST_NO_BACKGROUND=1` 同豁免；关停 `stopBackgroundSafely` 双 stop）。每拍每可用工作区四件事，
  **顺序固定 = ① 清道夫（reap）→ ②′ system 检查步（checks）→ ② 派发（dispatch）→ ③ attention**：
  ① **超时清道夫**——claim.claimedAt **起算**（lastSeenAt 只是续约不重置上限）超 maxExecutionMinutes →
  probeSession 仍活则定向 destroy + recordInterruption("execution timeout")（记录幂等，与 destroy 触发的
  结束钩子竞写安全）；会话已死（宿主重启遗留）→ 跳过 destroy 仍记录（否则陈旧 claim 经 activeExecution
  永久占死槽位；清道夫 role 无关——claimedAt 起算不变，developer/reviewer claim 同样适用；system claim 无
  会话 → probeSession null 只记中断，无可销毁）。②′ **system 检查步（final-arch step-3 T3，先于派发）**——
  activeExecution 在场不并发（检查步占槽，与派发共享单槽位）；`checksCandidatesFor` due 扫描（失败记日志让路
  给派发——扫描坏不停整个 runner）→ 首个 due 项 `runChecksStep` fire-and-forget（catch 记日志，launch 同款）
  并**本拍 return**（检查步占槽——同拍不起 LLM 轮；attention 延一拍无碍；见 system 检查步条）。② **单槽位派发（跨角色
  共享）**——activeExecution（内存 role-grant ∪ claim 扫描，不问角色）在场跳过；ready 池空跳过；否则取**合并
  队列首条**并按 `entry.role` 起 `launchRoleSession`（fire-and-forget；角色由池子投影自带、dispatcher 只透传
  ——消除过渡窗口误派发；Phase-5：release-preparer 为
  第四角色同前（角色由池子投影自带），零机制变化；launch 的 grantRole 即时占槽，
  同 tick 多余 ready 与下一拍都被 activeExecution 拦住）。③ **attention 催办/泊车（`attend`，final-arch step-2
  T5，spec §8）**——在派发之后跑（本轮新派发的会话不当拍被催/泊）：collectAttention 投影（与 GET …/attention
  路由共用同一装配器）按 `config.attention` 阈值逐条——`ageDays ≥ parkAfterDays` 且未泊 →
  writePaused(reason=attention-parked) + `delivery.parked` 事件（复用 automation-paused 机制，人经既有
  resumeAutomation 恢复）；否则 ≥ `nudgeAfterDays` 且未催未泊 → `delivery.nudged` 事件。幂等由构造保证：
  事件只进 events.jsonl（不动 item.yaml——不 bump revision），下一拍投影翻起 nudged/parked 位不再命中。
- **attention 队列投影（`attention.ts`，final-arch step-2 T5，2026-10-26，spec §8——唯一的人工待办投影）**：
  不是新存储——`projectAttention` 是纯投影（零 fs，全部输入由调用方传入），`collectAttention` 是读取端装配
  （managed 项才付详情读；详情读失败的项跳过——nudge/park 幂等全靠事件推导，读不出事件的项宁缺勿错）。五类
  锚点（每项每 kind 至多一条）：`question` = 任一 delivery.clarifications 未答（since = 最早未答 askedAt，
  detail = 问题原文，带 clarificationId）；`confirm` = phase=design ∧ !designConfirmed（since = 最近
  delivery.start-design，否则 updatedAt）；`release` = phase=release_ready ∧ !release（since = 最近
  record-verification / verified submit，否则 updatedAt）；`acceptance`（final-arch step-4 Task 3，**待人工验收**
  ）= `stages.acceptance.enabled` ∧ phase=release_ready ∧ 候选非空 ∧（无 delivery.acceptance ∨ 其摘要 ≠
  candidatesDigest(现行候选)）（since = 最近 record-verification / verified submit，否则 updatedAt——匹配的
  验收记录落地即消失，候选换过则重现；enabled 标志由 collectAttention 读 config 后注入纯投影，与 digests /
  acceptanceRequired 同款）；`blocked` = status=blocked ∨ paused 集 ∨ 中断集
  （since = 五信号〔delivery.block / delivery.checks_unverified / delivery.integrate_failed
  （final-arch step-4 集成段失败——detail = 集成失败（首败仓），缺仓回落固定文案）/
  delivery.checks_start_failed（step-7 T1 检查步 claim 写入前失败——detail = reason 原文，缺则回落固定文案）/
  paused·interrupted 事件〕最新者，detail 跟随胜出信号；零事件回落 updatedAt）。**nudged/parked 判定** = events 中
  at 严格晚于 since 且 data.kind 同 kind 的 `delivery.nudged` / `delivery.parked`（旧事件不算——跨 kind 与跨
  轮次都不串）；**blocked 泊车抑制例外（step-7 T1）**：blocked 条目的 parked 位按「存在晚于锚点的**任一 kind**
  `delivery.parked`」判定——人工泊车写点的 kind 随当时投影条目走，与派生 blocked 条目的 kind 天然不同，同 kind
  判定会让 attend 对同一项反复二次泊车；parked 翻真即催办/泊车两分支双双跳过；其余 kind 仍按同 kind 判定。
  排序 P0→P3→key，同项多 kind 按 kind 字典序。配置无关（阈值消费在 dispatcher attend；
  acceptance 的 enabled 标志是唯一配置输入——纯投影不读 config）。
- **路由（T8；Seam-repositioning T4 增两条只读 GET；final-arch step-6 增 init/readiness/template 三条）**：`GET|PUT /api/workspaces/[id]/delivery`（配置；PUT 成功
  后播种剧本模板 + 同步 AGENTS.md delivery managed 块，响应带 `seeded`——播种失败降级 `seeded: null` + `seedingError`，保存仍 200）；`POST /api/workspaces/[id]/delivery/init`
  （交付初始化——capability 门先于写入；成功后同步 delivery managed 块〔失败记日志不挡 init〕；body 经 `parseInitInput` 形状校验 → 400）；`GET /api/workspaces/[id]/delivery/readiness`
  （就绪清单 + `currentTemplateVersion`——只读无门）；`GET /api/workspaces/[id]/delivery/roles`（四角色摘要
  `summarizeRoles`——只读无 capability 门，坏 YAML → 400）；`GET /api/workspaces/[id]/delivery/roles/[role]/preview`
  （组合预览 `previewRolePrompt`——role ∉ DELIVERY_ROLES → 404，同样只读无门）；`POST /api/workspaces/[id]/delivery/roles/[role]/template`
  （模板另存 `writeRoleTemplateCopy`——capability 门先于写入〔它写盘〕；role ∉ 词表 → 404；副本已存在 → `WorkItemConflictError` → 409）；`GET .../work-items/[key]/
  delivery-execution`（四读拼装：claim[**剥 ownerTokenHash**] / attempts 末 5 新→旧 / paused /
  pendingInterruption）；`POST .../delivery-execution/stop`（probeSession 活 → 定向 destroy →
  recordInterruption("stopped by user")——中断门禁挡自动重领等人 recover；无 claim → 404）；`POST .../
  delivery-execution/recover`（探测作用域 = **工作区根**——角色会话 cwd；`detectSurvivingRoundProcesses` 残留
  进程 → 409 带 pids，manual 也不放行；干净 → resolveInterruptions + `delivery.exec_recovered`）；`POST
  /api/workspaces/[id]/delivery/resume`（body `{key}`）；`GET /api/workspaces/[id]/attention`（final-arch
  step-2 T5：attention 队列只读——collectAttention 装配 `{entries: AttentionEntry[]}`；只读无 capability 门，
  与 GET /delivery/roles 同款）。
- **事件**：`delivery.claimed / submitted / attempt_failed / automation_paused / exec_interrupted /
  exec_recovered / resumed / rework_suggested / asked / answered / nudged / parked / reviewed`（final-arch
  step-3：reviewer 判定 data 带 outcome/source/candidateDigest/attemptId） + `work_item.design_updated`（designer 写 design.md 对齐 M2 事件名；
  system 检查步五件：`delivery.checks_started / checks_passed / checks_failed / checks_unverified`（actor
  system；started data 带 attemptId/generation/candidateDigest，failed 走 reworkTransition 清下游证据回
  ready_for_implementation，unverified 落 blocked 等人 unblock——见 system 检查步条）+ 启动失败
  `delivery.checks_start_failed`（step-7 T1，actor system——claim 写入前失败表面化，每连续失败串一条，
  data 带 reason + candidateDigest 可算则带）；集成段失败
  `delivery.integrate_failed`（final-arch step-4，actor system——data 带首败仓 / exitCode|signal / stderr 尾部，
  落 blocked 等人 unblock 后整回合重跑）；
  release-preparer submit 复用 `delivery.submitted`（Phase-5，data.outcome="release-plan" + data.notes）；
  final-arch step-2：asked data 带提问摘要（≤120 字）+ clarificationId，answered data 带 clarificationId，
  nudged/parked data.kind 标五类锚点 kind——只进 events.jsonl，不动 item.yaml；final-arch step-4：人工验收
  `delivery.accepted`（data.candidateDigest——record-acceptance 原地记账，phase/status 不动）。
- **人工通道 UI（final-arch step-2 T6，2026-10-26）**：`components/work-items/AttentionBar.tsx`——中央页顶部
  「待处理」条（`WorkItemsPage` 挂载，工具条与错误横幅之下、列表/详情分栏之上）：GET …/attention 五类条目按
  kind 计数 chips（固定序 待答问题/待确认设计/待登记发布/待人工验收/阻塞，kind 着色——acceptance =
  final-arch step-4「待人工验收」chip）+ 展开行 `KEY · 标题 · 已 N 天 ·
  [已催办][已泊车]`（detail 进 title），点行 → handleSelect 定位详情（草稿守卫 + URL 回写同列表行）；取数 =
  挂载 + refreshToken（宿主传共享快照 fetchedAt——复用既有 5s 轮询节拍，不自建第二个 timer）；空队列不渲染，
  取数失败降级一行 muted 提示（advisory——保留旧条目不清空）；`AttentionBarView` 纯展示子件供测试直染。
  `components/work-items/ClarificationPanel.tsx`——详情页人工答复面板（`WorkItemDetailView` 动作条旁）：
  clarifications 新→旧，已答只读 Q/A + 角色徽标 + 问答时间；未答 options 单选（recommended 预选 + 标「推荐」）
  或无 options 自由文本（recommended 预填），「回答」→ runDeliveryAction("answer-clarification")（body =
  {expectedRevision, requestId, payload: {clarificationId, answer}}，requestId 幂等键由共享封装生成），2xx →
  onChanged()（宿主 invalidate），409（已被他人作答或 revision 已变）→ 内联「已被他人回答或版本已变，请刷新」
  + onChanged() 重取，400 → 服务端文案；posting 期间全部控件禁用（防双击）；无 clarifications 不渲染——
  answer-clarification 永不进动作条（`legalActionBarActions` 滤掉：问题全文在动作条无处展示）。
- **挂载与泛化**：`buildWorkspaceExtensions` 第二个 `work-items` 工厂条目——build 内补
  `manifest.capabilities.includes("workflows")` 合取门（单 capability 注册表表达不了合取；不满足返回
  undefined 静默不挂载），挂载后工具运行时另有角色授权身份门。M1 的 ActiveRoundInfo **泛化**
  `kind: "loop-round" | "delivery"` + `itemKey`（loop 调用方不写 kind，语义零变化；关停对 kind="delivery"
  且仍在跑的执行写 claim 中断而非 loop 中断记录——`buildShutdownPlan` 双产物）；facade `CreateSessionInput`
  增 `appendSystemPrompt` / `model` 透传（StartSessionOptions）。
- **已知边角（如实记录）**：workspace.disabled **不参与 dispatch**（dispatcher 只看 `available`——与 loop
  心跳先例一致：停用影响 UI 可见性，不停后台自动化）；delivery 的中断横幅/「重新检查并恢复」与 M1 loop
  面板同习语但**文件分离**（中断住 attempts 审计文件 ≠ `lib/loops/executions.ts`；recover 路由复用同一
  `detectSurvivingRoundProcesses` 做只读探测）；`runConfiguredCheck` 是 **spawnSync 同步执行**（分钟级长检查
  阻塞宿主事件循环——600s 上限内 SSE/UI 会冻结，Phase-4 接口裁定知悉项，future 异步化——system 检查步锁外
  顺序执行同受此限）；**rework↔重提无
  乒乓闸**（reviewer 打回与 system 检查步 rework 的 attempt 都记 submitted 不耗失败预算，
  `countRecentFailures` 遇 submitted 即断——
  同一项反复「提交坏候选→rework→再提交」不触预算暂停，Phase-4 阶段级观察，如需闸要 per-item rework 计数器）。
