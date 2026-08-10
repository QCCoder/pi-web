# Workspace 重构 — 切片开发计划

> 配套设计稿：[`workspace-redesign.md`](./workspace-redesign.md)（唯一需求真相源）
> MVP 基线：[`workspace-product-design.md`](./workspace-product-design.md)
> 干净基线 commit：`9eba3b7`

---

## 0. 背景与原则

### 0.1 演进非推翻
本计划是对 MVP 的**演进**，不是重写。底层模型（`WorkspaceManifest` / `WorkspaceRepository` / `WorkspaceRepositoryKind = "code" | "knowledge"` / capability 体系 / pi extension 机制）基本保留。改动集中在：组织方式（图标栏）、初始化模型（删模板改勾选 capability）、知识库一等公民化（OKF + capability 升格）、检索增强（opt-in kb_search）。

### 0.2 当前代码现状摘要（已勘测，落计划依据）
- **`WorkspaceCapability`**（`lib/workspaces/types.ts`）当前为 `"sessions" | "explorer" | "work-items" | "repositories" | "overview" | "workflows" | "feishu-transport" | "loop" | "subagent" | "feishu-channel"`。**`knowledge` 当前不是 capability**——它是 `WorkspaceRepositoryKind`（仅驱动目录路径 `repositories/knowledge/<alias>` + UI 标签，无任何知识库专属行为，见设计稿 §5.1）。
- **`ALL_WORKSPACE_CAPABILITIES`**（`lib/workspaces/service.ts` L131）是 `parseCapabilities` 的白名单——**新增 capability 必须同时登记在此处**，否则 `PATCH capabilities` 会被拒（400）。历史教训见 `docs/stock-workspace-modules.md`。
- **`effectiveCapabilities(manifest)`**：优先读 `manifest.capabilities`，无则回退内置模板查找，再无则 `["sessions","explorer"]`。旧 manifest（无 capabilities）靠模板回退可见。
- **内置模板**（`lib/workspaces/templates.ts`）：`empty`（caps: sessions/explorer）、`software-development`（caps: sessions/work-items/repositories/explorer/overview + skills + git 设置 + 预创建 requirements/bugs/designs/plans/repositories 目录 + git init）。
- **AGENTS.md 自动整理已存在**：创建时 `renderSoftwareDevelopmentAgents` 生成；repo 增删时 `updateManagedRepositoryInstructions` 按 `<!-- workspace-managed:repositories:start/end -->` 标记段重写（不触碰用户内容）。决策 9 的 C 方案在数据层已具备，只需从模板解耦。
- **`CreateWorkspaceInput` = `{ name, slug, templateId }`**；`POST /api/workspaces` body 即此（或 `{path}` 走 import）。
- **`WorkspaceSidebar.tsx`**：堆叠分组侧边栏——会话 / 工作项 / Loops / 仓库(按 code/knowledge 分子组) / Changes / Explorer，逐组用 `hasCapability(...)` 渲染。gitStatus 由 `useGitStatus` 提供。
- **`ChangesPanel.tsx` + `FileExplorer.tsx`**：Changes 是独立折叠 section；Explorer 是另一 section。git 状态逻辑（`lib/git-changes.ts` / `lib/git-status.ts`）按 cwd scope 分组，本身已正确。
- **`WorkspaceManager.tsx`**：创建表单用模板 `<select>`（empty / software-development / 自定义）。
- **pi extension 机制**：`WORKSPACE_EXTENSION_FACTORIES`（`lib/workspaces/extensions.ts`）注册 `capability → InlineExtension`，`buildWorkspaceExtensions` 按 `effectiveCapabilities` 过滤挂载。已有 work-items / feishu-transport 工厂。`kb_search` 走同一机制。
- **测试**：`npm test` = `node --test lib/*.test.mjs lib/loop/*.test.mjs lib/subagent/*.test.mjs`。**注意 glob `lib/*.test.mjs` 不递归**，因此 `lib/workspaces/service.test.mjs` 与 `lib/work-items/service.test.mjs` **不在默认 `npm test` 内**——涉及这两目录的切片必须显式 `node --test lib/workspaces/*.test.mjs lib/work-items/*.test.mjs`。

### 0.3 全局铁律
- 开发期**绝不跑 `next build`**（污染 `.next/`、破坏 `npm run dev`）。
- 每切片结束：`node_modules/.bin/tsc --noEmit` + `npm run lint` + 相关测试全绿。
- 一切片一提交；每切片可独立 revert。

---

## 1. §6 默认决策（执行依据，已定）

1. **multiplicity**：代码库/知识库都可多个；`kb_search` 跨所有激活 bundle 搜。
2. **现有 capability**（`overview` / `feishu-transport` / `feishu-channel` / `subagent` / `workflows`）：**保留不删**，只是不放进"初始化勾选清单"。
3. **必带语义**：`sessions` + `explorer` 是**硬编码常开**（不可关）。
4. **检索索引新鲜度**：**按需自愈**（每次 search 前按 mtime 增量补索引）。
5. **迁移**：**第一刀重写 AGENTS.md**；现有 software-development 工作区**不破坏**（向后兼容），新模型主要作用于新建工作区。
6. **图标栏顺序**：**会话 → Explorer → 仓库 → 知识库 → Loop → 工作项**。

---

## 2. 切片总览表

| 编号 | 标题 | 对应决策# | 依赖 | 主要文件 |
|---|---|---|---|---|
| Slice-1 | 重写 repo 根 `AGENTS.md`（项目规约） | §7 / §8①（元决策） | 无（可全并行） | `AGENTS.md` |
| Slice-2 | 删命名模板选择；初始化改勾选 capability；`knowledge` 升格为 capability（类型层） | 5, 7, 4(类型), 9(解耦), 6 | 无代码前置 | `lib/workspaces/{types,templates,service}.ts`、`app/api/workspaces/route.ts`、`components/WorkspaceManager.tsx` |
| Slice-3 | Changes 并入 Explorer（`[ 文件 \| 改动(N) ]` 分段 + 角标） | 8 | 无（可与 Slice-2 并行） | `components/WorkspaceSidebar.tsx`、`components/FileExplorer.tsx` |
| Slice-4 | 图标栏（Activity Bar）重构——单焦点切换 | 2, 6, 3 | Slice-2（knowledge 类型）；建议在 Slice-3 后 | `components/WorkspaceSidebar.tsx`、`components/AppShell.tsx`、新建 `components/ActivityBar.tsx` |
| Slice-5 | 知识库 OKF 适配（L0）+ AGENTS.md 知识库知情段 | 4(语义), 9(kb 段), 10, 11(L0), 12, 13 | Slice-2 | `lib/workspaces/{service,templates}.ts`、新建 `lib/workspaces/okf.ts`、`components/WorkspaceSidebar.tsx` |
| Slice-6 | `kb_search` extension（opt-in 检索，按需自愈索引） | 11(L1 opt-in), 14, §6.1 | Slice-5 | 新建 `lib/workspaces/kb-search/{extension,index}.ts`、`lib/workspaces/extensions.ts` |

### 关键依赖链
```
Slice-1 (AGENTS.md) ──────────────────────────────────────► (文档，不阻塞代码)
Slice-2 (capability 初始化 + knowledge 类型) ──┬─► Slice-4 (图标栏，需 knowledge 类型)
                                                ├─► Slice-5 (OKF，需 knowledge capability)
                                                │        └─► Slice-6 (kb_search，需 OKF)
Slice-3 (Changes 并入 Explorer) ────────────────► Slice-4 (Explorer 视图已含 Changes)
```

### 对设计稿 §8 顺序的调整（及原因）
- **拆分 §8③**：原"图标栏重构（含 Changes 并入 Explorer）"拆为 **Slice-3（Changes 并入）** + **Slice-4（图标栏）**。原因：Changes 并入触及 `FileExplorer/ChangesPanel`，独立可验、可单独 revert；且图标栏的 Explorer 是单焦点视图，应已内置 Changes，先做并入可缩小 Slice-4 范围。
- **把 §8④ 的"capability 升格(类型层)"提前并入 Slice-2**：原因——初始化勾选清单（决策 7）本就含"知识库"，类型层必须先有 `knowledge` capability；否则 Slice-2（初始化）与 Slice-4（图标栏）都要为 knowledge 特判。OKF 语义行为留在 Slice-5。
- **Slice-3 提前到 Slice-4 之前**：图标栏的 Explorer 单焦点视图应已合并 Changes。

最终落地顺序：**Slice-1 → Slice-2 → Slice-3 → Slice-4 → Slice-5 → Slice-6**（Slice-1/3 与主链可并行）。

---

## 3. 各切片详述

### Slice-1 · 重写 repo 根 `AGENTS.md`（项目规约）

- **目标**：设计稿 §1 教训与 §8①——消除过时文档（当前 `AGENTS.md` 只描述 `SessionSidebar`，对 workspaces/repositories/loop/git/changes 只字未提，是"重新发明轮子"的根因）。对应元决策。
- **动哪些文件**：
  - `AGENTS.md`（repo 根，pi-web 自身的项目规约）——**完全重写**。
- **新建文件**：无。
- **实现要点**：
  - 对照真实代码重写：补齐 Workspace 模型（`WorkspaceManifest` / capability / `WorkspaceRepository` / `WorkspaceRepositoryKind`）、目录布局（`~/.pi/workspaces/...`）、capability 体系（`effectiveCapabilities` / `ALL_WORKSPACE_CAPABILITIES` / extension 工厂）、AGENTS.md 自动整理（`<!-- workspace-managed:... -->` 标记段）、Loop、git/Changes（`lib/git-changes.ts`）、pi extension 工具挂载（`buildWorkspaceExtensions`）。
  - 保留仍准确的 pi-web 原有段落（会话/SSE/rpc-manager/AgentSession 生命周期/文件访问 allow-list/认证与模型配置），并更新文件映射表。
  - **以代码为准，不臆造**；写错比写少更危险。
- **TDD**：纯文档，无单测。验证靠人工对照代码 review。
- **怎么验证**：`npm run lint`（确保未破坏）；人工通读对照 `service.ts`/`templates.ts`/`WorkspaceSidebar.tsx`。
- **依赖关系**：无代码依赖；纯文档，可与所有其它切片并行。
- **风险**：凭印象写会再次过时——必须逐条对照当前代码。

---

### Slice-2 · 删命名模板选择；初始化改勾选 capability；`knowledge` 升格为 capability（类型层）

- **目标**：决策 5（删命名模板、初始化=勾选 capability）、决策 7（必带 sessions/explorer，可选 仓库/知识库/Loop/工作项）、决策 4 类型层（`knowledge` 升格为 capability）、决策 9（AGENTS.md 与模板解耦）、决策 6（目录延迟到首次使用）。
- **动哪些文件**：
  - `lib/workspaces/types.ts`
    - `WorkspaceCapability` 联合类型**新增 `"knowledge"`**。
    - `CreateWorkspaceInput` 改为 `{ name: string; slug: string; capabilities: WorkspaceCapability[] }`（移除 `templateId`）。
    - `WorkspaceManifest.template` 改为**可选**（`template?: {...}`），向后兼容旧 manifest。
    - 标记 `BuiltinWorkspaceTemplateId` / `WorkspaceTemplateId` / `WorkspaceTemplateInfo` / `WorkspaceCustomTemplate` 为 `@deprecated`（保留供旧 manifest 回退查询，不再用于创建）。
  - `lib/workspaces/templates.ts`
    - **保留** `BUILT_IN_WORKSPACE_TEMPLATES` / `getWorkspaceTemplate` / `effectiveCapabilities` 的模板回退（旧工作区兼容）。
    - 新增 `MANDATORY_CAPABILITIES = ["sessions","explorer"] as const`（硬编码常开，§6.3）。
    - 新增 `INIT_CAPABILITY_CHECKLIST: readonly WorkspaceCapability[] = ["repositories","knowledge","loop","work-items"]`（可选勾选项；§6.2 不含 overview/feishu/subagent/workflows）。
    - 新增 `normalizeInitCapabilities(selected): WorkspaceCapability[]` → 去重 + 强制并入必带项。
    - 新增 `renderWorkspaceAgents(manifest, capabilities): string`：从 capability 驱动生成 AGENTS.md（替代对 `software-development` 的硬依赖）。结构：标题 + 协作流（若含 work-items）+ `<!-- workspace-managed:git:start/end -->`（若有 git 设置）+ `renderWorkspaceRepositories`（repositories 段）。保留 `renderSoftwareDevelopmentAgents` 供兼容。
  - `lib/workspaces/service.ts`
    - `ALL_WORKSPACE_CAPABILITIES` **新增 `"knowledge"`**（否则 `parseCapabilities` 拒收，PATCH 报 400）。
    - `createWorkspace(input, root)`：签名改接受 `capabilities`；用 `normalizeInitCapabilities`；不再走模板分支；调用 `renderWorkspaceAgents` 生成 `AGENTS.md`（当 capabilities 含 work-items 或有 git 设置时含相应段）；写入 `manifest.capabilities`。
    - **不再调用 `initializeSoftwareDevelopmentWorkspace`**（决策 6：目录延迟创建）——新工作区只写 `.pi/workspace.yaml` + `AGENTS.md`（+ `.gitignore`/git init 仅当选了需 git 的 capability；MVP：选 repositories/work-items 时才 git init 管理仓库）。
    - `parseWorkspaceManifest`：放宽 `template` 为可选（缺失不报错）；其余校验不变。
    - 新工作区 manifest：可省略 `template`（彻底解耦）；`capabilities` 总显式写入，不依赖模板回退。
  - `app/api/workspaces/route.ts`（POST）：body schema 改为接受 `capabilities[]` 而非 `templateId`（`CreateWorkspaceInput` 已变）。
  - `components/WorkspaceManager.tsx`：创建表单删除模板 `<select>`，改为 capability 复选框（来自 `INIT_CAPABILITY_CHECKLIST`），sessions/explorer 固定勾选且不可取消（提示"必带"）。
- **新建文件**：无。
- **实现要点 / 向后兼容**：
  - 旧 `software-development` manifest 仍带 `template` + 缓存 `capabilities` → `effectiveCapabilities` 优先读 capabilities、无则模板回退 → **不破坏**。
  - 旧 manifest 即便无 `template`（slice 后允许），`effectiveCapabilities` 仍可从 capabilities 读出；最差回退 `["sessions","explorer"]`。
  - **knowledge 此刻只是"开关合法存在"**，真正的 OKF 行为在 Slice-5；勾选 knowledge 的新工作区此时无特殊目录（延迟到 Slice-5/首次 clone 知识库）。
  - **三处同步**：`createWorkspace` 签名变 → API route + WorkspaceManager UI + 所有测试调用点必须同步改。
- **TDD**：
  - 改 `lib/workspaces/service.test.mjs`：
    - 现有 `createWorkspace({name,slug,templateId},root)` 调用全部改为 `createWorkspace({name,slug,capabilities:[...]},root)`（保留"software-development 等价"语义：传 `["sessions","work-items","repositories","explorer"]` + skills + git 设置的等价断言，或单独留一条 legacy-template 显式路径）。
    - 新增 test：`createWorkspace` 接受 capabilities，生成 manifest.capabilities 含必带+所选；**不**预创建 requirements/bugs 目录（决策 6 断言 `readdir` 不含这些）。
    - 新增 test：`parseWorkspaceManifest` 接受**无 template** 的 manifest 不报错。
    - 新增 test：`createWorkspace` 生成的 `AGENTS.md` 由 capabilities 驱动（含/不含 work-items 段）。
    - 新增 test：`PATCH capabilities` 含 `"knowledge"` 不再 400（验证 `ALL_WORKSPACE_CAPABILITIES` 登记）。
- **怎么验证**：`node_modules/.bin/tsc --noEmit`；`npm run lint`；`node --test lib/workspaces/service.test.mjs lib/work-items/service.test.mjs`；`npm test`。
- **依赖关系**：无代码前置（Slice-1 是文档可并行）。**是 Slice-4 / Slice-5 / Slice-6 的前置**（knowledge capability 类型 + capability 化初始化）。
- **风险**：
  - `createWorkspace` 签名变化波及 API + UI + 测试三处，漏改一处即崩。
  - `knowledge` 必须同 slice 加进 `ALL_WORKSPACE_CAPABILITIES`，否则 capability 切换 400（历史教训）。
  - 删 `initializeSoftwareDevelopmentWorkspace` 的预创建目录后，需确认 work-items 创建路径自身会 `mkdir -p`（reserveWorkItemKey 写 manifest，work-item 创建写文件应自建目录）——验证旧"创建 requirement"流程仍可用。

---

### Slice-3 · Changes 并入 Explorer（`[ 文件 | 改动(N) ]` 分段 + 角标）

- **目标**：决策 8——Explorer 顶部 `[ 文件 | 改动(N) ]` 分段切换 + 角标，改动列表按 Explorer 当前 scope 显示。
- **动哪些文件**：
  - `components/WorkspaceSidebar.tsx`：删除独立的 "Changes" `SectionHeader` + `ChangesPanel` 块；在 Explorer section 内顶部加分段控件（`文件` / `改动(N)`），N=`changesCount` 角标。`explorerOpen` 时根据分段渲染 `FileExplorer` 或 `ChangesPanel`。
  - `components/FileExplorer.tsx`：**可选/最小侵入**——分段控件由父组件（WorkspaceSidebar）在 FileExplorer 外层渲染，FileExplorer 本身不改（或仅接受一个可选 `toolbar` slot）。推荐父组件渲染以降侵入。
  - `components/ChangesPanel.tsx`：基本不变（仍作为分段内容渲染；它已按 cwd scope 分组）。
- **新建文件**：无。
- **实现要点**：
  - 分段状态 `explorerTab: "files" | "changes"`，`localStorage` 持久化（key `pi-explorer-tab:<wsId>`）。
  - 角标 N 仅在有改动时显示（`changesCount > 0`）。
  - 切到"改动"时若 Explorer section 折叠，自动展开。
  - gitStatus hook 仍由 WorkspaceSidebar 持有；分段切换不重新请求。
  - 移动端折叠逻辑（`isMobile` default-collapse secondary sections）同步调整：Explorer 默认展开。
- **TDD**：纯 UI（`components/` 下无对应 `.test.mjs`），无单测。验证靠 tsc + lint + 手动。
- **怎么验证**：`node_modules/.bin/tsc --noEmit`；`npm run lint`；`npm test`（确保无回归）。
- **依赖关系**：无代码依赖；**可与 Slice-2 并行**（触及文件不重叠：Sidebar/Explorer vs workspaces/lib）。
- **风险**：移动端布局；gitStatus 在非 git 目录时隐藏"改动"分段（沿用现有 `gitStatus?.isGitRepository` 判断）。

---

### Slice-4 · 图标栏（Activity Bar）重构——单焦点切换

- **目标**：决策 2（左侧图标栏单焦点）、决策 6（顺序 会话→Explorer→仓库→知识库→Loop→工作项）、决策 3（仓库只放代码、知识库平级）。
- **动哪些文件**：
  - `components/WorkspaceSidebar.tsx`：大改。引入 `activeView` 单焦点状态；左侧窄图标栏（Activity Bar）按决策 6 顺序渲染该 workspace **已开启**的 capability（sessions/explorer 永显示）。右侧主区只渲染当前焦点视图：
    - **会话**：现有 session 列表 + 新建会话。
    - **Explorer**：Slice-3 的 Explorer（含 Changes 分段）。
    - **仓库**：仅 `kind === "code"` 的 repositories（决策 3）。
    - **知识库**：仅 `kind === "knowledge"` 的 repositories（依赖 Slice-2 的 knowledge capability 才显示该图标）。
    - **Loop**：现有 loop 入口。
    - **工作项**：现有 work-items 分组。
    - workspace 切换器/新建会话/设置/归档/SettingsBar 保留在顶部/底部。
  - `components/AppShell.tsx`：确认布局纳入图标栏宽度（图标栏 ~40-48px + 内容区）；WorkspaceSidebar props 如需调整同步；切换 workspace 时重置 `activeView` 到默认（会话）。
  - 顶部"新建会话"按钮、workspace 名下拉、设置按钮：移到图标栏顶端或保留 header 区。
- **新建文件**：
  - `components/ActivityBar.tsx`：从 WorkspaceSidebar 拆出图标栏组件（接收 capabilities + activeView + onSwitch），降低 WorkspaceSidebar 复杂度、便于单独 review。
- **实现要点**：
  - **小步迁移**：先抽 `ActivityBar` + `activeView` 状态，逐视图从堆叠分组搬到焦点渲染，每视图迁移后即时验证。
  - 移动端：图标栏可变为底部 tab bar（决策 2 的"拖拽/分屏"在 MVP 先不做，单焦点即可）。
  - 仓库/知识库视图数据仍来自现有 `loadWorkspaceData`，仅按 kind 过滤分别喂给两个视图。
  - 知识库视图 MVP：复用 FileExplorer 指向 `repositories/knowledge/<alias>`（OKF 即目录树，L0 无需专用 UI；Slice-5 再强化）。
- **TDD**：UI 无单测。验证 tsc + lint + 充分手动回归。
- **怎么验证**：`node_modules/.bin/tsc --noEmit`；`npm run lint`；`npm test`。
- **依赖关系**：**依赖 Slice-2**（knowledge capability 类型，图标栏才知道有"知识库"项）；**建议在 Slice-3 后**（Explorer 视图已含 Changes）。
- **风险**：**最大 UI 改动**，易破坏现有交互（archive/settings/skills 按钮、移动端折叠、会话选中态）。回归风险高——务必逐视图迁移、每步手动验证；revert 边界要清晰（一个 ActivityBar 组件 + 一个 activeView 状态）。

---

### Slice-5 · 知识库 OKF 适配（L0）+ AGENTS.md 知识库知情段

- **目标**：决策 4 语义层（knowledge capability 的实际 OKF 行为）、决策 9（AGENTS.md knowledge managed 段）、决策 10（大内容引用 index.md、agent 按需 read）、决策 11（默认 L0）、决策 12（一等公民靠"指定+约定+知情"三支柱）、决策 13（采用 OKF v0.2）、决策 3（知识库独立行为）。
- **动哪些文件**：
  - `lib/workspaces/service.ts`：
    - `addWorkspaceRepository`：当 `kind === "knowledge"` 且 `mode === "init"` 时，创建 **OKF 结构**（`index.md` 渐进披露入口 + 至少一个带 frontmatter 的示例 concept + `log.md`），替代当前简单 `# Index`。`mode === "clone"` 不变（拉远端 OKF repo）。
    - 新增 `renderKnowledgeSection(manifest)`：列出所有 active knowledge repos，每条引用 `repositories/knowledge/<alias>/index.md`（**引用、不内联**，决策 10）。
    - `updateManagedRepositoryInstructions` 扩展：当 capabilities 含 knowledge 时，维护 `<!-- workspace-managed:knowledge:start/end -->` 段（沿用现有标记替换模式，不吞用户内容）。
  - `lib/workspaces/templates.ts`：`renderWorkspaceAgents`（Slice-2 引入）追加 knowledge 段（调用 `renderKnowledgeSection`）。
  - `components/WorkspaceSidebar.tsx`（知识库视图，Slice-4 引入）：MVP 复用 FileExplorer 浏览 OKF 目录树；可选在视图顶部显示 index.md 入口提示。
- **新建文件**：
  - `lib/workspaces/okf.ts`：OKF 结构常量（frontmatter `type`/`tags` 字段约定）+ `renderOkfSeed(alias): { files: Record<string,string> }`（生成 index.md/log.md/示例 concept 的模板）。保持 templates.ts 不臃肿。
- **实现要点 / 向后兼容**：
  - 现有无 frontmatter 知识库（如 `qyinf-knowledge`）：**不强制迁移**（决策 13 代价：渐进）。AGENTS.md 知情段描述"理想 OKF 结构 + L0 遍历方式"，旧库仍可用 L0（agent 直读/grep/ls）。
  - multiplicity（§6.1）：多 knowledge bundle 共存；AGENTS.md knowledge 段列出所有 active knowledge repos 的 index.md 引用；agent 按需 read。
  - knowledge capability 在 Slice-2 已合法；本 slice 赋予其 OKF 实际行为。
  - L0 永远内置（结构导航 + 知情），不依赖任何检索工具（决策 11/12）。
- **TDD**：
  - `lib/workspaces/service.test.mjs`：
    - 新增 test：init 一个 knowledge repo，断言生成 OKF 结构（index.md 含渐进披露、至少一个带 `type` frontmatter 笔记、log.md）。
    - 新增 test：AGENTS.md knowledge managed 段在 add/remove knowledge repo 时正确更新（标记段外用户内容保留）。
    - 新增 test：clone 模式 knowledge repo 不覆盖远端结构。
- **怎么验证**：`node_modules/.bin/tsc --noEmit`；`npm run lint`；`node --test lib/workspaces/service.test.mjs`；`npm test`。
- **依赖关系**：**依赖 Slice-2**（knowledge capability + `renderWorkspaceAgents`）。可与 Slice-3/4 之后串行。
- **风险**：
  - OKF seed 须符合 v0.2 约定（frontmatter `type`/`tags`、index.md 渐进披露）；frontmatter 解析要稳健。
  - AGENTS.md managed 段正则替换不能吞用户内容（严格沿用现有 `<!-- workspace-managed:...:start/end -->` 锚点替换，不模糊匹配）。

---

### Slice-6 · `kb_search` extension（opt-in 检索，按需自愈索引）

- **目标**：决策 11（L1 `kb_search` opt-in）、决策 14（按需自愈：每次 search 前按 mtime 增量补索引）、§6.1（跨所有激活 bundle 搜）。
- **动哪些文件**：
  - `lib/workspaces/extensions.ts`：注册新工厂 `{ capability: "knowledge", build: (manifest, workspacePath) => createKbSearchExtension(manifest.id, workspacePath, knowledgeRepos) }`。
    - **注意**：knowledge capability 同时承载 L0（Slice-5，永远在）与 kb_search（增强）。两者共存——L0 是 agent 直读/grep，kb_search 是工具增强。
- **新建文件**：
  - `lib/workspaces/kb-search/extension.ts`：`createKbSearchExtension(workspaceId, workspacePath, knowledgeRepos): InlineExtension`，注册 `kb_search` 工具（Typebox 参数 `query: string` / `limit?: number`）。
  - `lib/workspaces/kb-search/index.ts`：FTS 索引建/查。`ensureIndex(repoPath)`：扫描 mtime > 索引记录的文件，增量解析（frontmatter + 正文）入库；`search(query, repos)`：合并所有 active knowledge repos 结果、BM25 排序。索引存工作区 `.pi/cache/kb-index/`（rebuildable，符合"文件权威、cache 可删"）。
  - `lib/workspaces/kb-search/index.test.mjs`（新建）。
- **实现要点**：
  - **opt-in**：kb_search 工具仅当 capability `knowledge` 开启时由 `buildWorkspaceExtensions` 挂载（已有机制）。
  - **跨多 bundle**：search 合并该 workspace 所有 active knowledge repos 的索引结果。
  - **按需自愈**（决策 14）：每次 search 前调 `ensureIndex`；未改动文件不重建（按 mtime 跳过）；不搜不花索引成本。
  - **FTS 实现选型**：MVP 优先**纯 JS**（frontmatter+正文 token 化 + BM25），避免引入 native 依赖；若项目已用 better-sqlite3 则可走 FTS5（需确认依赖）。索引并发写用 `withWorkspaceWriteLock` 或独立锁。
  - 索引失败不阻断 search（降级提示走 L0 grep）。
- **TDD**：
  - `lib/workspaces/kb-search/index.test.mjs`（新建）：增量索引（新建/修改文件后 search 命中；未改动文件不重建）；跨多 repo 合并；索引删除后自愈重建；frontmatter `type`/`tags` 可作为过滤维度。
  - `lib/workspaces/service.test.mjs` 或新 test：`buildWorkspaceExtensions` 在 knowledge capability 开启时含 `kb_search`（可断言扩展名）。
- **怎么验证**：`node_modules/.bin/tsc --noEmit`；`npm run lint`；`node --test lib/workspaces/kb-search/index.test.mjs lib/workspaces/service.test.mjs`；`npm test`。
- **依赖关系**：**依赖 Slice-5**（OKF 结构 + knowledge capability 语义）。
- **风险**：
  - FTS 选型（native sqlite vs 纯 JS）影响部署依赖。
  - 索引并发写（同 workspace 多会话 search）需正确加锁。
  - 大库首次建索引可能慢（决策 14 接受按需成本；可加异步预热提示）。

---

## 4. 全局风险与回滚策略

### 4.1 全局风险
1. **`npm test` 不覆盖 `lib/workspaces/` 与 `lib/work-items/`**：涉及这两目录的切片必须显式跑 `node --test lib/workspaces/*.test.mjs lib/work-items/*.test.mjs`，否则改动无测试保护。
2. **`createWorkspace` 签名变更（Slice-2）波及面广**：API route + WorkspaceManager + 全部测试调用点，漏改即崩。
3. **capability 登记（`ALL_WORKSPACE_CAPABILITIES`）易漏**：新增 capability 必须同 slice 登记，否则 PATCH 报 400（历史教训）。
4. **向后兼容**：旧 `software-development` manifest 带 `template` + 缓存 `capabilities`；`effectiveCapabilities` 的模板回退路径必须保留，不能为"干净"而删。
5. **图标栏重构（Slice-4）回归面大**：archive/settings/skills/移动端折叠/会话选中态，逐视图迁移 + 充分手动验证。
6. **AGENTS.md managed 段正则**：必须严格按 `<!-- workspace-managed:...:start/end -->` 锚点替换，模糊匹配会吞用户内容。
7. **绝不跑 `next build`**（开发期铁律）。

### 4.2 回滚策略
- 一切片一提交：每个 Slice 是独立 commit，`git revert <slice-commit>` 即可单点回滚。
- Slice-1（文档）与 Slice-3（Changes 并入）可独立 revert，不影响主链。
- Slice-2 是主链根基：revert 它需同时 revert 依赖它的 Slice-4/5/6。
- Slice-5/6 引入的 knowledge 行为对旧工作区是**纯增量**（旧工作区无 knowledge capability，行为不变），可安全单独 revert。
- 所有新 capability（`knowledge`）与类型变更保持**加法**（不删既有 capability、不删 `WorkspaceRepositoryKind`），revert 后旧 manifest 仍可解析。

---

## 5. 14 条决策 → 切片 覆盖矩阵

| 决策# | 主题 | 承接切片 |
|---|---|---|
| 1 | 范围：演进非推翻 | 全局原则（§0.1）；所有切片遵循 |
| 2 | 导航：图标栏单焦点 | Slice-4 |
| 3 | 仓库只放代码；知识库平级 | Slice-4（图标栏分离视图）+ Slice-5（知识库独立行为） |
| 4 | 知识库升格为 capability | Slice-2（类型层）+ Slice-5（语义层） |
| 5 | 删除命名模板；初始化=勾选 capability | Slice-2 |
| 6 | 目录延迟到首次使用 | Slice-2（init 不预创建）+ Slice-5（kb clone/init 自建） |
| 7 | 初始化勾选：sessions/explorer 必带；仓库/知识库/Loop/工作项可选 | Slice-2 |
| 8 | Changes 并入 Explorer | Slice-3 |
| 9 | AGENTS.md 自动生成 + managed 段 + 与模板解耦 | Slice-2（解耦）+ Slice-5（knowledge 段） |
| 10 | AGENTS.md 大内容引用、agent 按需 read | Slice-5（index.md 引用） |
| 11 | 知识库检索默认 L0；kb_search/向量 opt-in | Slice-5（L0）+ Slice-6（L1 kb_search） |
| 12 | 知识库一等公民靠"指定+约定+知情" | Slice-5 |
| 13 | 采用 OKF 格式 | Slice-5 |
| 14 | 检索索引按需自愈 | Slice-6 |

> 14 条决策全部有切片承接，无遗漏。
