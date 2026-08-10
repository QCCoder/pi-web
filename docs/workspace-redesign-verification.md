# Workspace 重构验收报告

- **Date**: 2026-08-10（验收日）
- **验收范围**: 基线 `9eba3b7` 之上的 7 个 commit（HEAD = `4915baa`）
- **设计稿**: [`workspace-redesign.md`](./workspace-redesign.md) §3（14 条决策）+ §4（知识库 OKF）+ §6（默认决策）
- **执行计划**: [`workspace-redesign-plan.md`](./workspace-redesign-plan.md)
- **验收方式**: 只读核对 + 真实跑验证三件套；**未改动任何业务代码**。

验收 commit 列表（`git log 9eba3b7..HEAD --oneline`）：

```
4915baa feat(kb): add opt-in kb_search extension with self-healing FTS index      (Slice-6)
be4322d feat(knowledge): adopt OKF structure for knowledge repos + AGENTS.md ...  (Slice-5)
673f0b0 feat(ui): introduce Activity Bar with single-focus capability navigation  (Slice-4)
e9a42b3 feat(explorer): merge Changes into Explorer with file/changes seg tabs    (Slice-3)
95b4253 feat(workspaces): replace template selection with capability checklist... (Slice-2)
78f3aba docs(workspace): add incremental slice development plan ...               (Slice-0)
cf63d88 docs(agents): rewrite AGENTS.md to document workspaces/...                (Slice-1)
```

---

## 第一部分：验证三件套（真实输出）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `node_modules/.bin/tsc --noEmit` | ✅ **0 错误**（exit 0，无输出） |
| Lint | `npm run lint` | ✅ **0 错误**，2 warning（见下，均不阻断） |
| 新目录专项测试 | `node --test lib/workspaces/service.test.mjs lib/work-items/service.test.mjs lib/workspaces/kb-search/index.test.mjs` | ✅ **35 / 35 pass, 0 fail** |
| 全量测试 | `npm test` | ✅ **169 / 169 pass, 0 fail** |
| 构建 | `next build` | ⛔ **未执行**（开发期铁律） |

### Lint warning 明细（2 条，均非阻断）

1. `components/ChatWindow.tsx:350:48` — `react-hooks/exhaustive-deps` useMemo 多余依赖。**预存在**，与本次重构无关。
2. `lib/workspaces/service.ts:600:9` — `'manifest' is assigned a value but never used`。位置在 `commitWorkspaceChanges()`：`const manifest = manifestValue ?? await readWorkspaceManifest(workspacePath);` 赋值后函数体未使用该变量。**属预存在的死变量**（非本次重构引入，重构只调用该函数未改其签名），非逻辑 bug。建议顺手删除该行（最小清理），但不阻断验收。

### ⚠️ 测试覆盖坑（已确认，需修复）

`package.json` 的 test glob 为：
```json
"test": "node --test lib/*.test.mjs lib/loop/*.test.mjs lib/subagent/*.test.mjs"
```

`lib/*.test.mjs` **不递归**，因此以下测试文件**不在 `npm test` 内**：

- `lib/workspaces/service.test.mjs`（22 个测试，覆盖 capability 初始化、OKF seed、AGENTS.md managed 段、knowledge clone/init —— **本次重构的全部核心逻辑**）
- `lib/workspaces/kb-search/index.test.mjs`（8 个测试，覆盖 BM25/自愈索引/跨 bundle 合并）
- `lib/work-items/service.test.mjs`（5 个测试）
- 以及预存在的 `lib/stores/create-map-store.test.mjs`、`lib/i18n/*.test.mjs`

> 本报告用专项命令补跑了前三个文件（35/35 绿）。但标准 `npm test`（169 pass）**不包含**这 35 个测试 —— 这意味着 CI / 开发者日常 `npm test` 不会捕获 workspace / kb-search 的回归。**这是流程性高风险**（见第三部分 R-3）。

---

## 第二部分：14 条决策逐条核对

图例：✅ 已落地 · ⚠️ 部分落地 · ❌ 未落地

| # | 主题 | 判定 | 代码证据 |
|---|---|---|---|
| 1 | 范围：演进非推翻（底层 manifest/repository/capability 保留） | ✅ | `lib/workspaces/types.ts:40` `WorkspaceRepositoryKind = "code" \| "knowledge"` 原样保留；`WorkspaceManifest`（types.ts）结构保留；`WorkspaceRepository` 接口保留。所有变更均为**加法**（新增 `knowledge` capability、`capabilities` 缓存字段、OKF 模块），数据层零破坏。`workspace-redesign-plan.md §0.1` 演进原则贯穿。 |
| 2 | 导航：图标栏单焦点 | ✅ | `components/ActivityBar.tsx`（新建）——`ACTIVITY_VIEW_ORDER` 定义 + `visibleActivityViews()` 按 capability 过滤 + `ActivityBar` 组件（`variant: vertical\|horizontal`）。`components/WorkspaceSidebar.tsx`：`activeView` 状态 + `renderActiveView()` 单焦点渲染（同一时刻只渲染一个 view）；移动端 `horizontal` 底部 tab，桌面端 `vertical` 左侧图标栏。无堆叠分组。 |
| 3 | 仓库只放代码、知识库平级 | ✅ | `ActivityBar.tsx:68` `view: "repositories"` (capability `repositories`) 与 `:82` `view: "knowledge"` (capability `knowledge`) 两个**独立平级视图**。`WorkspaceSidebar.tsx:393` `codeRepositories = repositories.filter(r => r.kind === "code" && active)`、`:397` `knowledgeRepositories = ... kind === "knowledge"`。仓库视图仅渲染 `codeRepositories`，知识库视图仅渲染 `knowledgeRepositories`。 |
| 4 | 知识库升格为 capability | ✅ | `types.ts:27` `WorkspaceCapability` 含 `"knowledge"`；`service.ts:132` `ALL_WORKSPACE_CAPABILITIES` 登记了 `"knowledge"`（`parseCapabilities` 白名单 —— 否则 PATCH 报 400）。测试 `PATCH capabilities accepts knowledge` 通过。数据层 `kind` 仍保留（只驱动路径），capability 是 UI/开关层变更，与设计稿 §5.1 一致。 |
| 5 | 删除命名模板、初始化=勾选 capability | ✅ | `types.ts` `CreateWorkspaceInput = { name, slug, capabilities[] }`（**无 templateId**）。`service.ts createWorkspace()` 调 `normalizeInitCapabilities(parseCapabilities(input.capabilities))`，不查模板。`components/WorkspaceManager.tsx:1109` 必带项 `MANDATORY_CAPABILITIES.map`（disabled+checked）、`:1115` 可选项 `INIT_CAPABILITY_CHECKLIST.map`（toggleable checkbox）——**无模板 `<select>`**。`BUILT_IN_WORKSPACE_TEMPLATES`（templates.ts）保留并标 `@deprecated`，仅供 `effectiveCapabilities` 回退。 |
| 6 | 目录延迟到首次使用 | ✅ | `service.ts createWorkspace()` 仅创建 `.pi/workspace.yaml` + `AGENTS.md`（+ `repositories/work-items` 任一开启时才 `.gitignore` + `git init`）。**绝不预创建** `requirements/ bugs/ designs/ plans/ repositories/`。测试 `createWorkspace does not pre-create work-item or repository directories (decision 6)` 显式断言目录不存在并通过。repo 目录在 `addWorkspaceRepository` 内按需 `mkdir -p`。 |
| 7 | 初始化勾选（sessions/explorer 必带；仓库/知识库/Loop/工作项可选） | ✅ | `templates.ts:45` `MANDATORY_CAPABILITIES = ["sessions", "explorer"]`；`templates.ts:52` `INIT_CAPABILITY_CHECKLIST = ["repositories", "knowledge", "loop", "work-items"]`；`normalizeInitCapabilities` 强制并入必带项。`WorkspaceManager.tsx:1109/1115` 表单恰好渲染这两组。 |
| 8 | Changes 并入 Explorer（`[ 文件 \| 改动(N) ]` 分段 + 角标） | ✅ | `WorkspaceSidebar.tsx:115` `ExplorerSegmentedTabs`（`文件` / `改动` + N 角标），`:506` 在 explorer 视图内渲染 `ChangesPanel`（按 `activeWorkspace.path` scope）。`explorerTab` 持久化于 `pi-explorer-tab:<wsId>`。**WorkspaceSidebar 内无独立 Changes section**（独立 Changes 仅保留在 `SessionSidebar`，符合 AGENTS.md 说明）。非 git 目录隐藏「改动」分段（`:269` `isGitRepo` 门控）。 |
| 9 | AGENTS.md 自动生成 + managed 段 + 与模板解耦 | ✅ | `templates.ts renderWorkspaceAgents(manifest, capabilities)` —— **capability 驱动、不依赖 template id**（新旧工作区都适用）。`renderWorkspaceRepositories` 产出 `<!-- workspace-managed:repositories:start/end -->`；`renderKnowledgeSection` 产出 `<!-- workspace-managed:knowledge:start/end -->`。`service.ts updateManagedRepositoryInstructions()`（:619）维护**两段**，仅在对应 capability 生效时触碰；**标记缺失则 no-op**（不创建、不模糊匹配），严格锚点替换不吞用户内容。测试 `AGENTS.md knowledge managed segment tracks add/remove ... and preserves user content` 通过。遗留 `renderSoftwareDevelopmentAgents` 保留但 `createWorkspace` 不再调用。 |
| 10 | AGENTS.md 大内容引用、agent 按需 read | ✅ | `templates.ts:135 renderKnowledgeSection()` 每条引用 `` `repositories/knowledge/<alias>/index.md` ``（**引用、不内联**），并说明 L0 用 `read`/`ls`/`grep`。文件头注释明确解释 pi 逐字注入 AGENTS.md、无 `@` 展开 —— 故大内容必须引用出去让模型按需 `read`。 |
| 11 | 知识库检索默认 L0；kb_search opt-in | ✅ | L0 永远内置：`kb-search/extension.ts` 工具描述 + OKF `index.md` 均说明 `read`/`ls`/`grep` 无需工具。`kb_search` 仅在 `knowledge` capability 开启时由 `extensions.ts` 工厂（`WORKSPACE_EXTENSION_FACTORIES` → `buildWorkspaceExtensions` → `rpc-manager.ts:1196`）挂载，属 opt-in 增强。两者共存（L0 不依赖 kb_search，kb_search 失败降级提示走 L0）。 |
| 12 | 知识库一等公民靠"指定+约定+知情"三支柱 | ✅ | 指定 = `knowledge` capability（决策 4）；约定 = OKF 结构（`okf.ts`，type/tags/index.md 渐进披露）；知情 = AGENTS.md `renderKnowledgeSection` 段告知 agent 如何 L0 遍历。一等公民身份不依赖搜索工具（L0 即可），kb_search 仅增强。 |
| 13 | 采用 OKF 格式（v0.2） | ✅ | `lib/workspaces/okf.ts`：`OKF_VERSION = "0.2"`、`OKF_TYPE_INDEX/LOG/CONCEPT`、`OKF_INDEX_FILE="index.md"`（渐进披露入口）、`renderOkfSeed(alias)` 生成 `index.md`（frontmatter `type: index`）+ `log.md`（`type: log`）+ `concepts/welcome.md`（`type: concept` + `tags`）。测试 `renderOkfSeed produces YAML-parseable frontmatter with a type field` + `initializing a knowledge repo seeds an OKF v0.2 structure` 通过。clone 模式不覆盖（测试 `cloning a knowledge repo does not overwrite its remote OKF structure`）。 |
| 14 | 检索索引按需自愈 | ✅ | `kb-search/index.ts ensureIndex()` 每次 search 前调用：walk `.md` 文件，**按 mtime 比对**，仅重解析新/改文件（`:ensureIndex` 注释 "unchanged — reuse cache entry, skip re-parse"）；删除文件下次 pass 剔除；缓存缺失/损坏 → 全量重建（`loadCache` 返回 null 触发）。缓存位于 `<workspace>/.pi/cache/kb-index/<alias>.json`（rebuildable，git-ignored），原子写（tmp+rename）+ workspace 写锁。`extension.ts` 每次 `kb_search` 前对每个 active bundle 跑 `ensureIndex`。测试：`ensureIndex skips re-parsing files whose mtime is unchanged`、`drops deleted files`、`missing or corrupt cache self-heals into a full rebuild` 全通过。 |

**小结：14 条决策全部 ✅ 已落地。**

---

## 第二部分（续）：§6 默认决策核对

| §6 | 主题 | 判定 | 代码证据 |
|---|---|---|---|
| 6.1 | multiplicity：kb_search 跨所有激活 bundle | ✅ | `kb-search/index.ts searchIndex(query, indexes[])` 接受**多个** `KbIndex`（每 bundle 一个独立语料库，BM25 分数 per-bundle 后全局合并排序）；`extension.ts resolveActiveKnowledgeRepos()` 返回所有 active knowledge repo，逐个 `ensureIndex` 后合并。**每次调用重读 manifest**，运行期增删 bundle 即时生效。测试 `search merges results across multiple active knowledge bundles (§6.1)` 通过。 |
| 6.2 | 现有 capability（overview/feishu/subagent/workflows）保留不删、不进初始化清单 | ✅ | `types.ts WorkspaceCapability` 仍含 `overview/workflows/feishu-transport/loop/subagent/feishu-channel`；`service.ts ALL_WORKSPACE_CAPABILITIES` 登记 `overview/workflows/feishu-transport/loop/feishu-channel`（`subagent` **故意不登记** —— 它是全局工具，在 `rpc-manager.ts` 永远挂载，非 workspace capability，符合 AGENTS.md 教训）。`INIT_CAPABILITY_CHECKLIST = [repositories, knowledge, loop, work-items]` —— **不含** overview/workflows/feishu-*/subagent。 |
| 6.3 | sessions+explorer 硬编码常开 | ✅ | `templates.ts MANDATORY_CAPABILITIES = ["sessions", "explorer"]`（`normalizeInitCapabilities` 强制并入，不可关）；`ActivityBar.tsx:46/57` sessions 与 explorer 的 `capability: null`（always-on，`visibleActivityViews` 不过滤）。 |
| 6.4 | 检索索引按需自愈 | ✅ | 同决策 14（`ensureIndex` 每次 search 前 mtime 增量）。 |
| 6.5 | 迁移：AGENTS.md 重写 + software-development 不破坏 | ✅ | AGENTS.md 全量重写（commit `cf63d88`）。`service.ts effectiveCapabilities()`（:163）**模板回退路径保留**：`manifest.capabilities` 优先 → 内置模板查找（id+version）→ `["sessions","explorer"]`。`parseWorkspaceManifest` 宽松：`template` 可选、`capabilities` 可选。测试 `discovery keeps pre-repository schema v1 Workspaces visible`、`parseWorkspaceManifest accepts a manifest without template` 通过 —— 旧 software-development 工作区仍正常加载。 |
| 6.6 | 图标栏顺序 会话→Explorer→仓库→知识库→Loop→工作项 | ✅ | `ActivityBar.tsx ACTIVITY_VIEW_ORDER` 顺序严格为：`sessions(:46) → explorer(:57) → repositories(:68) → knowledge(:82) → loop(:94) → work-items(:108)`。与设计稿 §6.6 完全一致。 |

**小结：§6 全部 6 条默认决策 ✅。**

---

## 第三部分：偏差、风险与修复建议

### D-1（偏差，可接受）· `renderKnowledgeSection` 落在 `templates.ts` 而非 `service.ts`

- **计划原话**（Slice-5）："`service.ts`：新增 `renderKnowledgeSection(manifest)`"。
- **实际**：`renderKnowledgeSection` 与 `renderWorkspaceRepositories` 一起放在 `lib/workspaces/templates.ts:135`；`service.ts:23` 从 templates.ts 导入。
- **原因**：避免 `service.ts → templates.ts` 的循环依赖（`templates.ts` 渲染纯函数、不依赖 service；service.ts 已依赖 templates.ts）。
- **判定**：**可接受**。这是更合理的分层（渲染纯函数聚集），且文件头注释 + 函数注释明确解释了该决定。与 `renderWorkspaceRepositories` 的既有位置保持一致。

### D-2（偏差，可接受）· `buildWorkspaceExtensions` 挂载 kb_search 的集成测试**未加**

- **计划原话**（Slice-6 TDD）："`lib/workspaces/service.test.mjs` 或新 test：`buildWorkspaceExtensions` 在 knowledge capability 开启时含 `kb_search`（可断言扩展名）"。
- **实际**：该测试**被有意省略**，`service.test.mjs:480` 留有 NOTE 说明原因 —— **预存在的限制**：`lib/feishu/client.ts` 使用了 TS 参数属性（`constructor(private readonly config)`），node strip-only 模式无法转换，导致整个 `extensions.ts` 导入图在 `node --test` 下失败（与 kb_search 无关）。
- **缓解**：kb_search 索引逻辑由 `kb-search/index.test.mjs`（8 测试）完整覆盖；工厂接线由 `tsc --noEmit` + lint 保证，生产路径经 `rpc-manager.ts` 实际执行。
- **残留风险**：**低-中**。挂载路径（extensions.ts 工厂 → `buildWorkspaceExtensions` → rpc-manager）只被类型检查覆盖，无运行时断言。若工厂 `build` 函数返回 undefined 或名字拼错，测试不会捕获。逻辑本身简单且 tsc 兜底，**可接受**。
- **建议**：待 `feishu/client.ts` 参数属性问题解决（或对 extensions.ts 导入做 mock）后，补一个 `buildWorkspaceExtensions(manifest_with_knowledge).some(e => e.name === "pi-kb-search")` 断言。

### R-3（风险，**应修复**）· `npm test` 不覆盖 `lib/workspaces/`、`lib/work-items/`、`lib/stores/`、`lib/i18n/`

- **现象**：`package.json` test glob `lib/*.test.mjs lib/loop/*.test.mjs lib/subagent/*.test.mjs` 不递归。本次重构的**全部核心测试**（`lib/workspaces/service.test.mjs` 22 个 + `lib/workspaces/kb-search/index.test.mjs` 8 个 + `lib/work-items/service.test.mjs` 5 个 = 35 个）**不在 `npm test` 内**。本次报告用专项命令补跑全绿，但 CI / 日常开发 `npm test` 不会跑这些。
- **影响**：workspace / capability / OKF / kb_search 逻辑的回归无自动保护。**这是本次重构最大的流程风险**（执行计划 §4.1 风险 1 已预警）。
- **建议最小修复**（改 `package.json`，**不属于业务代码改动**，但本验收任务不擅自改）：
  ```json
  "test": "node --test \"lib/**/*.test.mjs\""
  ```
  （Node ≥ 22 支持 `**` 递归 glob；需确认 Node 版本。或显式列举新目录。）验收建议编排者执行此修复。

### R-4（风险，低）· 两处 lint warning

1. `service.ts:600` 未使用变量 `manifest`（`commitWorkspaceChanges`）—— 预存在死变量，建议顺手删除该行。
2. `ChatWindow.tsx:350` useMemo 多余依赖 —— 预存在，与重构无关。
两者均非阻断、非本次引入。

### 向后兼容性核对（§6.5）✅

- 旧 `software-development` 工作区（带 `template` + 缓存 `capabilities`）：`effectiveCapabilities` 模板回退路径保留 → 正常加载。
- 旧 manifest 无 `capabilities` 字段：`parseWorkspaceManifest` 接受（capabilities 可选）→ 回退模板或裸最小集。
- 旧 schema v1 pre-repository 工作区：测试 `discovery keeps pre-repository schema v1 Workspaces visible` 通过。
- `WorkspaceRepositoryKind`、`WorkspaceRepository`、`WorkspaceManifest` 数据结构零破坏（纯加法）。
- knowledge OKF 行为对旧工作区是**纯增量**（旧工作区无 knowledge capability 时行为不变；无 frontmatter 旧库仍可 L0 访问，不强制迁移 —— 决策 13 代价渐进）。

### 其他观察

- `WorkspaceManager.tsx:1060` 仍用 `workspace.templateId ?? "自定义"` 做展示（遗留工作区显示模板名，新工作区显示「自定义」）—— 合理的展示兼容，非缺陷。
- `kb_search` 工厂 `build` 接收初始 `knowledgeRepos` 快照仅供挂载时提示文案；真正执行时 `resolveActiveKnowledgeRepos` 重读 manifest —— 设计正确，运行期增删 bundle 即时生效。

---

## 总结

| 维度 | 结论 |
|---|---|
| 验证三件套 | ✅ **全绿**（tsc 0 错；lint 0 错/2 warning；专项 35/35 + 全量 169/169 全 pass） |
| 14 条决策 | **14 / 14 ✅ 全部落地**（0 ⚠️，0 ❌） |
| §6 默认决策 | **6 / 6 ✅ 全部采用** |
| 阻断性问题 | **无**。无需回到阶段 2 修复。 |
| 待办（非阻断） | R-3（`npm test` glob 扩展，**强烈建议**编排者修复）；D-2（待 feishu 参数属性问题解决后补 kb_search 挂载集成测试）；R-4（顺手清 2 个 lint warning） |

**判定：本次 Workspace 重构验收通过。** 14 条设计决策与 6 条 §6 默认决策全部落地，验证三件套全绿，向后兼容（旧 software-development 工作区不破坏）已测试确认。唯一的流程性隐患是 `npm test` 不覆盖新测试目录（R-3），建议尽快修正 `package.json` 的 test glob，否则 workspace/kb-search 回归将长期脱离 CI 保护。
