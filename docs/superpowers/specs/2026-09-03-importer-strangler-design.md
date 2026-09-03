# 禅道 Importer 拆出 pi-web（strangler：外部源适配下放工作区）设计

日期：2026-09-03
状态：已与用户逐节确认（方案一）
关联：`docs/autonomous-dev-loop.md`（原 importer 设计，本次部分退役）、`docs/pi-loop-kit-design.md`（同构先例：loop v3 引擎拆出 pi-web）

## 1. 背景与动机

Chandao importer 现全部住在 pi-web：SPI + 适配器 + 凭据存储 + daemon 调度器 + 配置 UI + 手动同步路由 + capability 门（`requirement-sources`），共 ~740 行 lib + 3 组路由 + 1 组件 + 1 daemon job。全机**仅 workspace-c 一个消费者**（dev-loop 轮）。

用户方向：pi-web 保持纯通用底座，业务系统耦合下放到工作区，用「脚本承担确定性 I/O + AI 承担触发与分诊」解决。与 loop v3→kit 迁移同一架构判断：**pi-web 不携带业务引擎，业务定义住在 workspace**。

关键事实（已核实）：
- `CreateWorkItemInput.external` **已存在**且 POST 路由原样透传——脚本建项盖章**零 API 改动**。
- 脚本依赖面全部是通用端点：`GET /api/workspaces/:id/work-items`（返回 `{items, archivedItems, invalid}`）、`POST …/work-items`、`POST …/work-items/[key]/attachments`（multipart `files`，返回工作项 detail 含落盘附件）、`PUT …/work-items/[key]/content`、`POST …/work-items/[key]/events`。
- `source-labels.ts` 零 import（特意隔离过）——纯文件迁移。
- 设计原则 "Deterministic I/O — never delegated to an LLM" 维持：同步机制仍在脚本，AI 只触发与分诊。

## 2. 目标 / 非目标

**目标**
1. pi-web 删除全部 Chandao 专属代码（importers 目录、路由、UI、daemon job、capability）。
2. workspace-c 获得自含同步：`scripts/chandao-sync.py`（纯 stdlib）+ 本地 0600 凭据 + chandao.md/LOOP.md 更新。
3. 数据语义完全对齐旧管线（dedup 键、原文逐字、图片本地化、bug/task 映射、单条容错）。
4. manifest 一次性去掉 `requirement-sources`；capability 进退役名单。

**非目标**
- 不做多源 SPI/adapter registry 的替代抽象（删干净，未来 Jira = 新工作区脚本 + `SOURCE_LABELS` 加一行）。
- 不做 pi-web 内保留任何 importer 兼容路径/迁移开关。
- 不改变 `external` 字段数据模型与来源展示 UI。
- 同步新鲜度不追求独立于轮的 30min（唯一消费者是轮；可选 crontab 挂同一脚本）。
- LLM 工具不新增 external 透传（HTTP API 已够；LLM 建项仍不带 external）。

## 3. 决策摘要

| 决策点 | 结论 |
|---|---|
| 架构 | strangler 全拆：确定性同步=工作区脚本；判断=轮 AI；pi-web=通用底座 |
| 建项通道 | 脚本走 pi-web 通用 HTTP API（域逻辑单一实现，Python 零复刻）|
| 凭据 | workspace 根 `.chandao.json`（0600、gitignored；不进 git/上下文/会话记录）|
| 图片本地化 | 建项 → attachments 上传（魔数嗅探 ext）→ content PUT 重写 img src |
| 里程碑 | `imported` 心跳照旧走 events 通用路由 |
| capability | `requirement-sources` 照 `overview`/`loop` 先例退役：注册表移除 + `LEGACY_READ_CAPABILITIES` 读时剥离 |
| source-labels | 迁至 `lib/work-items/source-labels.ts` 保留（通用溯源 UI；映射表留扩展位）|
| AI 角色 | 轮开场 bash 触发脚本 → 读摘要 JSON → `failed` 项泊车报人；脚本整体崩溃才泊车整轮 |

## 4. pi-web 删除清单

1. `lib/work-items/importers/` 整目录（types/adapters/config/images/chandao-importer/mapping/runner/scheduler/http + 全部 .test.mjs）。**迁移前置**：`source-labels.ts` → `lib/work-items/source-labels.ts`（import 路径更新：WorkspaceManager 等消费方）。
2. `app/api/workspaces/[id]/importers/`（route、test、sync 三路由）。
3. `components/ImporterConfig.tsx` 删除；WorkspaceManager 去挂载点与 requirement-sources 开关行。
4. `lib/daemon/host.ts`：删 `ImporterScheduler` import/注册（`importer-sync` job）与 `createImporterRoutes` 路由段；`lib/daemon/client.ts` 删 importer sync 方法。
5. capability（`lib/workspaces/service.ts`）：
   - `ALL_WORKSPACE_CAPABILITIES`（L140 附近）移除 `requirement-sources`；
   - `normalizeUpdateCapabilities` 的 force-include 映射（L183 `"requirement-sources": "work-items"`）删除；
   - `LEGACY_READ_CAPABILITIES`（L152）加入 `"requirement-sources"`（残留 manifest 读时剥离、写时 normalize）；
   - `WorkspaceCapability` 类型联合同步移除。
6. `CreateWorkItemInput.external` 注释更新（"Importer-only" → "外部源脚本经 HTTP API 盖章；LLM 工具不透传"）。
7. AGENTS.md：Importer 章节改写为「外部源适配 = 工作区脚本」简述（cxin 为参考实例）；capability 注册表清单、目录布局（`agent/importers/` 行）、File Map 同步。

## 5. `scripts/chandao-sync.py` 契约

**运行**：`python3 scripts/chandao-sync.py [--workspace c] [--api http://127.0.0.1:30141] [--dry-run]`。零第三方依赖（urllib.request / json / re / bytes 嗅探）。幂等：重复运行只补新增。

**凭据**（workspace 根 `.chandao.json`，0600，gitignored）：

```json
{ "base": "https://…", "account": "…", "password": "…", "assignee": "…", "productId": N, "executionId": N }
```

**流程**（语义逐条对照旧 runner.ts/chandao-importer.ts 移植）：

> **执行顺序约束（strangler）**：脚本的映射决策表（type/priority 映射、空描述回退、FILE_ID_RE、
> 魔数嗅探、401 重签、心跳/跳过条件）必须先从旧实现摘录进实现计划，脚本经 §6.5 dry-run 比对
> 通过后，才允许执行 pi-web 删除（§4）——对照物先于拆除物消失是本设计的硬顺序。

1. Token 签名：`POST {base}/api.php/v1/tokens`（account+password）；401 重签一次。
2. 拉取：指派给 assignee 的 bug + task（productId/executionId 过滤）。
3. Diff：`GET {api}/api/workspaces/{ws}/work-items` 取 `items ∪ archivedItems`，按 `external.source === "chandao" && external.sourceId` 去重；未归档已存在 → 只盖 `imported` 里程碑；已归档 → 跳过；新 → 建项。
4. 建项：`POST …/work-items`，body `{type, title: detail.title, originalDescription: <原文逐字，空描述回退语义照旧>, external: {source: "chandao", sourceId, url}}`（bug/task → type/priority 映射照旧 runner；空描述回退语义照旧——均以旧实现为唯一权威）。
5. 图片本地化：`extractChandaoFileIds`（FILE_ID_RE 语义移植）→ 逐 fileId `GET {base}/api.php/v1/files/{id}`（魔数嗅探 png/jpg/gif/webp）→ `POST …/attachments`（multipart `files`）→ 从 detail 响应取落盘文件名 → `PUT …/content`：正文 `<img>` src 重写为 `attachments/<file>`。
6. 每条独立 try/except，单条失败记录不中断。
7. stdout 摘要（人可读 + 机器可解析，轮 AI 消费）：

```json
{ "created": ["REQ-0033", "BUG-0021"], "skipped": 4, "heartbeat": 2, "failed": [{ "sourceId": 123, "error": "…" }] }
```

`--dry-run`：只做 1-3 步并打印将建/将跳过清单，不写任何东西（迁移比对用）。

## 6. cxin 迁移（一次性，实测后收尾）

1. 脚本落位；`.gitignore` += `.chandao.json`；凭据从 `~/.pi/agent/importers/<wsId>.json` 搬入（chmod 600）；**老凭据文件保留至实测通过再删**。
2. manifest `.pi/workspace.yaml` capabilities 去掉 `requirement-sources`。
3. `chandao.md`：「怎么运行」改写（脚本触发：轮开场步骤 2 / 手动 / 可选 crontab；凭据位置；摘要 JSON 语义；失败泊车）；「怎么变成工作项」「对选品的意义」语义不变微调。
4. `LOOP.md` 指针第 2 步：读 chandao.md → `python3 scripts/chandao-sync.py`（bash）→ failed 项泊车报人、整体崩溃泊车整轮。
5. **实测**：`--dry-run` 与旧管线清单比对 → 真跑一轮（生产禅道）抽查 新建/心跳/图片本地化/原文逐字 → 手动触发一轮 loop 轮验证开场合同 → 删老凭据文件。

## 7. 错误处理与失败语义

- 脚本单条失败：记录进 `failed[]`，继续；轮 AI 对 failed 项盖 `loop.parked`（reason 含 sourceId）报人，**成功项照常选品**。
- API 不可达/凭据失效（结构性失败）：退出码非 0 + stderr 人话 → 轮泊车整轮报人（不选品，避免在陈旧候选池上判断）。
- pi-web 不新增任何错误面（纯删除）。

## 8. 测试计划

- pi-web：删除后 `tsc --noEmit` 0 错 + `npm test` 全绿（importer 测试随目录消失）；capability 退役加一例（manifest 含 `requirement-sources` → 读时剥离不抛错，写被拒 400）。
- 脚本：无单测框架要求（工作区内容物），以 `--dry-run` 真实比对 + 实测清单代偿； FILE_ID_RE/魔数嗅探等纯函数可留 `--self-test` 入口（可选，YAGNI 可砍）。
- 迁移验收：§6.5 三步实测 + 一轮真 loop。

## 9. 风险与代价（诚实清单）

- 失去：独立于轮的 30min 定时、web 手动同步/测试连接按钮、凭据集中管理（`~/.pi/agent/importers/`）。
- 新增依赖：脚本 ↔ pi-web server 存活（轮触发场景天然满足；crontab 场景需 server 常开）。
- workspace 凭据从全局目录移入工作区（0600 + gitignore 缓解；换来的是随 workspace 自包含）。
- Python 双实现的漂移面被压缩到「Chandao REST 细节 + 映射表」——域规则（KEY/schema/锁）零复刻。
