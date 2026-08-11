# 自主研发闭环 — 实施计划（P0+P1 首迭代）

> 设计终稿：`docs/autonomous-dev-loop.md`（source of truth）。
> 本文档把设计 §14 的 P0→P5 拆成可独立提交的小步，并**标注本迭代范围 = P0 + P1**。
> 后续 P2（Phase 0 验证闸门）/ P3（Exporter + 研发 Loop v1）/ P4（进化）/ P5（收敛）属下一周期，**不在本次**。

## 本迭代不做什么（明确边界）

- ❌ 不碰 **研发 Loop 引擎**（`lib/loop/runtime.ts` / `pi-execution.ts` / `store.ts`）。Importer runner 是 loop host 进程里一个**非 Loop 的系统定时任务**，与 Loop 引擎平行，不改引擎。
- ❌ 不做 **Exporter**（`lib/exporters/`、FeishuNotifier）—— P3。
- ❌ 不做 **进化**（`lib/loop/learn/aggregate.ts`）—— P4。
- ❌ 不做 **模块→仓库/敏感映射表**（cargo-knowledge 结构化文档）—— P3 的 Phase 0 产物。P1 的 Importer **不预填 repositories**（无映射源），只预填 `external` + `tags`。
- ❌ 不在 web 服务器持有任何定时器（`instrumentation.ts` 零改动）。

## 最深模块缝（小接口藏复杂度）

三处「深模块缝」，复杂度藏在接口后面，调用方零感知：

1. **Importer SPI（`lib/importers/types.ts`）** — `listAssigned/getDetail/getAttachment` 三个方法，藏住禅道的 REST+Token+图片二进制+字段差异（bug.steps vs task.desc）。换禅道 = 换一个实现，runner 零改动。
2. **`syncImporterForWorkspace(workspaceId)`（`lib/importers/runner.ts`）** — 一个入口函数，藏住「拉取→去重→建项→落图→改写 src→写 event」全流程。host 定时器与 web 手动入口都只调它。
3. **`lib/importers/images.ts`（纯函数）** — `extractChandaoFileIds` / `rewriteChandaoImageSources` / `detectImageExt`，藏住禅道 `<img src="/index.php?m=file&f=read&t=png&fileID=NNN">` 的脆弱会话 URL 解析。无副作用、易测。

> 这三处对照设计 §7.4 的 `learn/aggregate.ts` 纯函数理念：**可计算的用确定性纯函数**，I/O 用 SPI 隔离。

---

## P0 — Importer SPI + ChandaoImporter + 配置 + UI

### 步骤 P0-1 · 注册能力 `requirement-sources`

- **文件**：
  - `lib/workspaces/types.ts`：`WorkspaceCapability` 联合类型加 `"requirement-sources"`。
  - `lib/workspaces/service.ts`：`ALL_WORKSPACE_CAPABILITIES` 数组加 `"requirement-sources"`。
- **照抄模式**：`feishu-transport` / `feishu-channel` 的注册方式（type union + 校验注册表）。
- **为何**：漏注册 → `PATCH /capabilities` 直接 400 "Unknown capability"（AGENTS.md「能力注册」陷阱）。这是可持久化的前提。
- **不进 `INIT_CAPABILITY_CHECKLIST`**：与 `feishu-transport` 一致——高级模块，经设置面板 PATCH 开启，不在新建工作区勾选清单里。
- **验收**：`tsc` 过；`PATCH .../capabilities` 含 `requirement-sources` 不再 400。

### 步骤 P0-2 · Importer SPI + 配置类型（深模块缝 #1）

- **文件**：`lib/importers/types.ts`（新建）
- **接口/数据形状**：
  ```ts
  export type SourceItemKind = "bug" | "task";
  export interface AssigneeFilter { assignee?: string }
  export interface SourceItem { sourceId: string; kind: SourceItemKind; title: string; url?: string }
  export interface SourceItemDetail { sourceId: string; kind: SourceItemKind; title: string; body: string; url?: string }
  export interface Attachment { bytes: Buffer; ext: string }
  export interface Importer {
    readonly kind: string;                                   // "chandao"
    listAssigned(filter: AssigneeFilter): Promise<SourceItem[]>;
    getDetail(sourceId: string): Promise<SourceItemDetail>;  // body 含 <img> 原始引用
    getAttachment(fileId: string): Promise<Attachment>;
  }
  // 凭据形状（对标 lib/feishu/types.ts）
  export interface ChandaoConfig { base; account; password; token?; assignee; productId; executionId }
  export interface ChandaoConfigPublic { base; account; hasPassword; hasToken; assignee; productId; executionId }
  export interface ImporterConfig { chandao?: ChandaoConfig }
  export interface ImporterConfigPublic { chandao?: ChandaoConfigPublic }
  ```
- **照抄模式**：SPI 形状直接来自设计 §5；凭据形状对标 `FeishuConfig`/`FeishuConfigPublic`。
- **验收**：`tsc` 过；SPI 三方法签名稳定（后续实现/测试都依赖它）。

### 步骤 P0-3 · 凭据读写 `lib/importers/config.ts`（0600）

- **文件**：`lib/importers/config.ts`（新建）
- **接口**：
  ```ts
  readImporterConfig(workspaceId): Promise<ImporterConfig | null>
  writeImporterConfig(workspaceId, config): Promise<void>   // mode 0600
  toPublicConfig(config): ImporterConfigPublic              // password/token 不出服务端
  ```
- **路径**：`~/.pi/agent/importers/<workspaceId>.json`（`getAgentDir()` + `importers/`）。
- **照抄模式**：逐行对标 `lib/feishu/config.ts`（`configFilePath` / `readX` / `writeX` / `toPublicConfig`）。凭据在工作区目录**外**（工作区常是 git 仓库）。
- **验收**：写后读回一致；文件 mode 0600；`toPublicConfig` 不含 password/token 明文。
- **测试**：`lib/importers/config.test.mjs`（临时 `getAgentDir`？—— 用真实 agent dir 写一个临时 wsId 文件再清理，或像 feishu 一样不单测 config 而靠 runner 覆盖。**决定**：config 与 feishu 同构，feishu/config.ts 也无独立单测，沿用——不单测 config，靠 `chandao-importer.test.mjs` + 真机覆盖）。

### 步骤 P0-4 · 图片纯函数 `lib/importers/images.ts`（深模块缝 #3）

- **文件**：`lib/importers/images.ts`（新建）
- **接口**（全纯，无 I/O）：
  ```ts
  extractChandaoFileIds(html: string): string[]                              // 唯一 fileID
  rewriteChandaoImageSources(html: string, extOf: (id: string) => string): string
  detectImageExt(bytes: Buffer): string                                      // png/jpg/gif/webp，magic bytes 优先
  ```
- **实现要点**：
  - 抓 `fileID=(\d+)`（正则全局，去重保序）。
  - 改写 `src=(["'])…fileID=NNN…\1` → `src=\1attachments/chandao-NNN.<ext>\1`。
  - `detectImageExt`：`\x89PNG`→png、`\xFF\xD8\xFF`→jpg、`GIF8`→gif、`RIFF…WEBP`→webp；回落 `image/<x>` content-type；再回落 `bin`。
- **照抄模式**：纯函数风格同 `lib/git-status.ts`（解析归解析、I/O 归别处）。
- **验收/测试**：`lib/importers/images.test.mjs` —— fileID 抽取（含重复去重）、src 改写（单/双引号、多图）、ext 探测（各 magic bytes）。

### 步骤 P0-5 · ChandaoImporter `lib/importers/chandao-importer.ts`（深模块缝 #1 的实现）

- **文件**：`lib/importers/chandao-importer.ts`（新建）
- **接口**：`class ChandaoImporter implements Importer`。
- **构造**：`new ChandaoImporter(config: ChandaoConfig, deps?: { fetchImpl?: typeof fetch })`。**注入 fetch** 便于单测 mock HTTP。
- **端点**（设计附录 A，已实测）：
  - token：`POST /api.php/v1/tokens` body `{account,password}` → 201 `{token}`。
  - 我的 bug：`GET /api.php/v1/products/{productId}/bugs?assignedTo={assignee}` → `{bugs:[{id,title}]}`。
  - 我的 task：`GET /api.php/v1/executions/{executionId}/tasks?assignedTo={assignee}` → `{tasks:[{id,name}]}`（task 标题字段是 `name`）。
  - 详情：`GET /api.php/v1/bugs/{id}`（body=`steps`）/ `GET /api.php/v1/tasks/{id}`（body=`desc`）。
  - 图片：`GET /api.php/v1/files/{fileId}` + `Token` header → 二进制流。
- **token 策略**：内存缓存 token；请求带 `Token` header；**遇 401 用 account+password 重签一次**（POST /tokens）后重试。**不用网页登录 md5 那套**（设计明确 v1 不用）。
- **ext 探测**：`getAttachment` 取 `arrayBuffer` → `Buffer` → `detectImageExt`。
- **url 构造**：bug→`${base}/index.php?m=bug&f=view&bugID=${id}`，task→`…&m=task&f=view&taskID=${id}`。
- **照抄模式**：HTTP 客户端结构对标 `lib/feishu/client.ts`（token 缓存 + 请求封装），但 token 来源是 chandao 自己的 `/tokens`。
- **验收/测试**：`lib/importers/chandao-importer.test.mjs`（mock fetch）：
  - 取 token（POST /tokens）；
  - listAssigned 合并 bugs+tasks；
  - getDetail(50) 的 body 含 `<img>`；
  - getAttachment(507) 返回 PNG（校验 `\x89PNG` magic）；
  - 401 触发重签重试一次后成功。

### 步骤 P0-6 · 配置 API 路由

- **文件**：
  - `app/api/workspaces/[id]/importers/route.ts`（GET/PUT/DELETE，对标 `app/api/workspaces/[id]/feishu/route.ts`）。
  - `app/api/workspaces/[id]/importers/test/route.ts`（POST 测试连接，对标 `…/feishu/test/route.ts`）。
- **行为**：
  - GET → `toPublicConfig`（password/token 不回前端）。
  - PUT → 空 password 保旧 secret（与 feishu appSecret 一致）；写 config。
  - DELETE → 清空。
  - test → 读 config → `new ChandaoImporter` → `listAssigned` → 返回 `{ok, counts:{bugs,tasks}, sample:[…]}`。
- **验收**：`tsc` + `lint` 过；前端能 GET/PUT。

### 步骤 P0-7 · 配置 UI 面板 `components/ImporterConfig.tsx`

- **文件**：`components/ImporterConfig.tsx`（新建），`components/WorkspaceManager.tsx`（挂载）。
- **照抄模板**：`components/FeishuConfig.tsx`（CapabilityToggle + 表单 + 保存 + 测试按钮 + 状态文案）。
- **字段**：base / account / password（留空保旧）/ token（可选，留空保旧）/ assignee / productId / executionId。
- **测试按钮**：调 `…/importers/test`，回显 `{bugs, tasks}` 数量。
- **挂载**：`WorkspaceManager.tsx` 在 `<FeishuConfig/>` 附近加 `<ImporterConfig/>`。
- **验收**：UI 可切换能力、保存凭据、测试连接回显数量。

**P0 验收闸门**：能力可持久化；凭据 0600；ChandaoImporter 用 token API（非网页登录）；test 能拉到列表/详情/图片。

---

## P1 — Importer runner（cron/webhook/manual → 工作项 → 去重 → event）

### 步骤 P1-1 · 工作项加可选 `external` 段（去重键）

- **文件**：
  - `lib/work-items/types.ts`：加
    ```ts
    export interface WorkItemExternalRef { source: string; sourceId: string; url?: string; lastSyncedAt: string }
    ```
    `WorkItemRecord` 加 `external?: WorkItemExternalRef`；`CreateWorkItemInput` 加 `external?: WorkItemExternalRef`。
  - `lib/work-items/service.ts`：
    - `serializeWorkItem` 输出 `external:`（snake_case 子键 source/source_id/url/last_synced_at）。
    - `parseWorkItem` 读回（缺省 → undefined）。
    - `createWorkItem`：校验并写入 `input.external`（`actor` 默认仍 user；Importer 传 `external`）。
    - 新增纯 helper `parseExternalRef(value)` 校验形状。
- **照抄模式**：序列化/解析的 camelCase↔snake_case 映射同 `relatedItems↔related_items`、`archivedAt↔archived_at`。
- **设计依据**：§4「新增可选字段 external（Importer 写，去重+溯源）」；§10「不新增 type，避免动 KEY 计数器」——只加可选段。
- **不碰**：`UpdateWorkItemInput`（P1 runner 用 milestone event 记再同步，不改 external，避免每 30min revision 抖动）。
- **验收/测试**：`lib/work-items/service.test.mjs` 增 1 例（带 external 创建 → 读回一致；list 可见 external）。
- **依赖**：必须先于 runner（runner 依赖该字段做去重）。

### 步骤 P1-2 · 映射 + 去重纯函数 `lib/importers/mapping.ts`

- **文件**：`lib/importers/mapping.ts`（新建）
- **接口**（全纯）：
  ```ts
  mapSourceKindToWorkItemType(kind: SourceItemKind): "bug" | "requirement"   // bug→bug, task→requirement
  buildExternalIndex(items: WorkItemRecord[]): Map<string, WorkItemRecord>   // key = `${source}:${sourceId}`
  externalKey(source, sourceId): string
  ```
- **设计依据**：§10 类型映射。
- **验收/测试**：`lib/importers/mapping.test.mjs`（映射；含/不含 external 的索引构建）。

### 步骤 P1-3 · Runner `lib/importers/runner.ts`（深模块缝 #2）

- **文件**：`lib/importers/runner.ts`（新建）
- **入口**：
  ```ts
  runImporterForWorkspace(workspaceId, importer: Importer, opts?): Promise<ImporterRunSummary>
  syncImporterForWorkspace(workspaceId): Promise<ImporterRunSummary>   // 读 config→new ChandaoImporter→run
  ```
- **流程**（对每条 sourceItem，确定性 I/O，**不交 LLM**）：
  1. `getWorkspace` → path/manifest；`listWorkItems` → `buildExternalIndex`（去重表）。
  2. `importer.listAssigned({assignee})` → 合并 bug+task。
  3. 每条：
     - 查 `externalKey("chandao", sourceId)`。
     - **已归档** → skip。
     - **不存在** →
       a. `getDetail` → body(含 `<img>`)；
       b. `extractChandaoFileIds(body)` → 逐个 `getAttachment` → `{fileId:{bytes,ext}}`；
       c. `rewriteChandaoImageSources(body, extOf)` → 本地化描述；
       d. `createWorkItem(wsId, { type: map(kind), title, originalDescription: 本地化body, external:{source,sourceId,url,lastSyncedAt}, tags:["chandao"], actor:"external" })`；
       e. 落盘 `<item>/attachments/chandao-<fileId>.<ext>`；
       f. `recordWorkItemMilestone(wsId, key, {type:"imported", actor:"external", data:{action:"created",…}})`；
       g. `created++`。
     - **存在且 open** → `recordWorkItemMilestone(type:"imported", data:{action:"synced", lastSyncedAt})`；`synced++`。
  4. 返回 `{workspaceId, source, created, synced, skipped, errors, details:[…]}`。
- **幂等**：第二次跑命中去重表 → 全走 synced 分支 → 不重复建项、不重复落图。**关键验收点**。
- **README verbatim 规则**：`originalDescription` 在创建时即用「本地化后」文本（图片 src 已是相对路径）。后续不再覆写 Original Description（work-items 自带不可覆写校验），符合 §9「改写 README 的 src 为相对路径」且不违反 verbatim 规则。
- **照抄模式**：调 `createWorkItem` / `recordWorkItemMilestone`（`lib/work-items/service.ts` 现成 API），不重造文件读写。
- **验收/测试**：`lib/importers/runner.test.mjs`（fixture 工作区 + mock Importer）：
  - bug→BUG-####、task→REQ-#### 正确落项；
  - 图片落盘 `attachments/chandao-NNN.png` + README src 为相对路径；
  - 第二次跑 created=0/synced=N，不重复；
  - 已归档项跳过。

### 步骤 P1-4 · Importer 系统定时任务（loop host，非 Loop）

- **文件**：
  - `lib/importers/scheduler.ts`（新建）：`class ImporterScheduler` —— `setInterval` 30min；遍历 `discoverWorkspaces().filter(capabilities.includes("requirement-sources"))` 且有 importer config 的工作区，逐个 `syncImporterForWorkspace`，错误吞掉只 log。**定时器归属 host 进程**。
  - `lib/loop/host.ts`：`createLoopHost()` 返回里加 `importerScheduler`；`startLoopHost` 里 `app.importerScheduler.start()` 与 `SIGINT/SIGTERM` 的 `stop()`；新增路由 `POST /v1/workspaces/:id/importers/sync` → `syncImporterForWorkspace` → 回 summary。
- **照抄模式**：`LoopHostScheduler`（`lib/loop/scheduler.ts`）的 start/stop/tick 结构；host 路由风格同现有 `host.ts`。**与 LoopHostScheduler 平行、互不依赖**（Importer 不是 Loop）。
- **设计依据**：§5「runner 跑在哪：loop host 进程里的一个非 Loop 系统定时任务；web 服务器不持定时器」。**`instrumentation.ts` 零改动**。
- **验收**：host 启动日志含 importer scheduler tick；路由可调。

### 步骤 P1-5 · Web 端点转发 + 优雅回退

- **文件**：
  - `lib/loop/client.ts`：加 `syncImporters(workspaceId)` → `POST /v1/workspaces/:id/importers/sync`。
  - `app/api/workspaces/[id]/importers/sync/route.ts`（新建）：POST → 先转发 host；**host 不可达则 web 进程内同步执行一次**（调 `syncImporterForWorkspace`）。一次性同步请求不是「定时器」，不违反「web 不持定时器」。
- **照抄模式**：`loopHostClient` 现有转发风格 + `probeSession` 的「不可达回落」思路。
- **验收**：host 在线时走 host；host 离线时 web 内执行（真机验证用此路径）。

**P1 验收闸门**：cron/webhook/manual 拉取 → 工作项（含图片）→ external 去重 → event；3 bug + N task 正确落项，重跑不重复。

---

## 依赖顺序（提交序列）

```
P0-1 能力注册
  └─► P0-2 SPI+配置类型
        ├─► P0-3 config(0600)
        ├─► P0-4 images 纯函数 + 测试   (可并行)
        └─► P0-5 ChandaoImporter + 测试 (依赖 P0-2/P0-4)
              └─► P0-6 API 路由 (依赖 P0-3/P0-5)
                    └─► P0-7 UI 面板 (依赖 P0-6)
P1-1 工作项 external 段 + 测试
  └─► P1-2 mapping 纯函数 + 测试
        └─► P1-3 runner + 测试 (依赖 P0-5/P1-1/P1-2)
              └─► P1-4 host scheduler + 路由
                    └─► P1-5 web 转发端点
```

每步：`tsc --noEmit` + `npm run lint` 绿；涉及纯函数/Importer/runner 的步加 `lib/**/*.test.mjs` 并跑 `npm test` 绿；每步独立 `git commit`（仅 add 本步文件，**绝不带入** `ChatWindow.tsx` / `worker.ts` 的既有改动）。

## 后续阶段（不在本次，仅存档）

- **P2** Phase 0 验证闸门：定 cargoware/h5 各仓库 checker 命令 + 敏感模块清单 v1（cargo-knowledge 文档）。
- **P3** Exporter SPI + FeishuNotifier + 研发 Loop v1（选品→三重判定→TDD maker/checker→分支/PR→gate→通知；learn 先只追加 RUNS）。
- **P4** 进化：接通 `lib/loop/learn/aggregate.ts` 确定性核 + LLM 笔记。
- **P5** 收敛：风险清单调优、可信模式放宽 gate1（仍需人确认）。
