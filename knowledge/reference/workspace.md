# Workspace 子系统（manifest / capability / repository / index）

> 深细节基线，2026-10 自 AGENTS.md 迁出（AGENTS.md 现为总览与用法说明，细节住此）。

> 内容与迁移时点一致；后续变更直接更新本文档。



---



## Workspace Subsystem

The largest subsystem and the one most often misunderstood. **Read this before touching anything workspace-related.**

### Model: manifest, capability, repository

A **Workspace** is a directory `~/.pi/workspaces/workspace-<slug>/` (root = `$PI_WORKSPACES_DIR` or `~/.pi/workspaces`)
with a manifest at `.pi/workspace.yaml` (`WorkspaceManifest`, schemaVersion 1, `lib/workspaces/types.ts`):

```yaml
schema_version: 1
id: <ULID>
slug: my-proj
name: My Project
template: { id: software-development, version: 1 }   # OPTIONAL/legacy — new workspaces omit this
template?: { id, version }                          # (see "Template selection removed" below)
capabilities: [sessions, explorer, work-items, repositories, knowledge, ...]  # always written explicitly
repositories: [{ id, alias, name, kind: code|knowledge, path: <相对工作区根的 POSIX 路径>, status: active|removed, removed_at? }]
agent: { default_model?, thinking_level? }
disabled?: true                                   # 用户暂时停用（2026-09）：首页/选择器不可见，
                                                   # 不影响已开 tab/loop 心跳/会话装配；false 时键整个剥掉。
                                                   # 重启用面 = 设置›工作区（桌面项目树树底 ⚙ / 移动端首页
                                                   # ⊞ 暗淡行与 ⚙ 入口均深链预选直达——2026-09 修复：停用后
                                                   # 不能从所有面上消失到找不回）
git: { branch_rules: { requirement, bug }, create_after: plan_approved }      # only when work-items is on
work_items: { next_requirement_number, next_bug_number }
created_at / updated_at
```

- **Workspace index v2**: `~/.pi/workspace.yaml` is schemaVersion 2 —— strict，无迁移路径（2026-09 一次性迁移已收敛删除：读到非 v2 索引直接报错；索引文件缺失时才走 `rebuildWorkspaceIndexFromScan` 扫描重建）。条目可携带可选 `sort_order`（手动排序，2026-09：设置列表拖拽 → `PATCH /api/workspaces { order }` 重编 1..N，一次写；`registerWorkspacePath` 重建条目时透传保留；**项目树工作区节点同样可拖拽（2026-09）：drop 到节点上半/下半 = 插到它前面/后面（列表尾空区 = 移到末位；插入指示线 = globals.css 的 `workspace-drop-line` 入场动画，树与设置›工作区 rail 同构），同一 PATCH 全量期望序（未入树的停用/不可用项保持现序垫底——`updateWorkspaceOrder` 会删未提及条目的 sortOrder，不能传部分列表）**）。`discoverWorkspaces` 终排序 = 可用优先 → 手动序升序在前 → 未设置条目按 lastOpenedAt 降序（MRU 兜底；一旦拖过一次全部条目都有 sortOrder，列表即固定不再随活跃度跳动）。 `WorkspaceManifest.capabilities` is REQUIRED —— `parseWorkspaceManifest` throws "capabilities is required" without it; read `manifest.capabilities` directly.
- **WorkspaceRepository**: `{ id, alias, name, kind: "code"|"knowledge", path, status }`. **path** 是相对工作区根的
  POSIX 路径（校验：禁绝对路径/`..`/`.pi` 内）。**自动登记（2026-09「扫描为事实，manifest 只存记忆」）**：
  `listWorkspaceRepositories` 打开即跑 `syncRepositoriesFromScan`（**2026-10 读缓存**：进程内 per-workspace TTL `PI_REPO_LIST_TTL_MS` 缺省 30s——窗口内直读上次结果，扫描对账 + 每仓 4 个 git 子进程的富集至多每 TTL 一次【用户反馈「总览仓库不秒出」，15 仓全量重算实测 ~0.7s】；app 内增/删/恢复走写路径显式失效、即时可见，外部 clone 的新目录至多 TTL 后登记；路由 `?refresh=1` 绕过；测试进程置 0 关闭）——`lib/workspaces/scan.ts` 从根扫 git 仓
  （`.git` 为目录；worktree 的 `.git` 文件不算）与 OKF 知识库（`index.md`+`log.md`，优先于 git 判定；点目录/
  node_modules/.worktrees 剪枝、发现即停、深度 4），新目录自动登记（alias=目录名规整、冲突加后缀）、消失自动
  停用、重现自动恢复；manifest 已有条目的 alias/kind 是钉住覆盖，扫描不改写。新仓顺带写入根 .gitignore。
  clone/init 仍是显式操作；`kind` 只驱动 UI 标签与（knowledge 时）**OKF seed**。Note: `knowledge` is *also* a
  top-level `WorkspaceCapability` (the UI "知识库" toggle); the repository `kind` and the capability are separate
  concerns — the capability gates the module/UI. (`knowledge/designs/workspace-redesign.md` §5.1)
- **Template selection removed (redesign decision 5/7)**: creating a Workspace is **capability-driven** —
  `CreateWorkspaceInput = { name, slug, capabilities[] }`, no `templateId`. `createWorkspace()` validates the selection
  via `parseCapabilities`, force-includes the mandatory `sessions`+`explorer` (`normalizeInitCapabilities`), writes
  `manifest.capabilities` explicitly, and **omits `template`**. Per decision 6 (lazy directories) it does **not**
  pre-create `requirements/ bugs/ designs/ plans/ repositories/` — those are `mkdir -p`'d on first use (work-item
  creation, repo clone/init). It writes `.pi/workspace.yaml` + a capability-driven `AGENTS.md` always, and `git init`s
  the workspace repo only when a git-using capability (`repositories` **or** `work-items`) is selected (git branch
  rules are set only when `work-items` is on). Built-in templates are gone — manifests are capability-driven only.

**默认工作区（2026-09，初始化补建）**：web 进程启动时（`instrumentation.ts`，fire-and-forget）
`ensureDefaultWorkspace()`（`lib/workspaces/service.ts`）补一个轻量「默认」工作区（name `默认`、slug
`default`，capabilities 仅强制核心 `sessions+explorer`，不 git init、不建内容目录），供随手问答/搜索——
避免「不选工作区裸聊」：无归属会话会被 `groupSessionsByWorkspace` 丢弃、在首页/树里不可见，真工作区
是唯一安全落点。幂等规则：slug `default` 已登记（含外部路径导入的同 slug）→ 不动；墓碑
`<工作区根>/.pi-default-deleted`（`removeWorkspace` 删默认时写；删除是注销制、目录保留）在场 →
永不复活；目录在磁盘但未注册 → `importWorkspace` 自愈重注册。ensure 永不抛（初始化路径降级为日志）。
存量用户升级后也会补建一次；删掉后想要回 = 手动新建普通工作区。

### Capability system & extension mounting

`WorkspaceCapability` (`types.ts`) is the per-workspace module switch (includes `knowledge`, promoted from a mere
repository `kind` to a first-class capability — redesign decision 4, type layer). **`ALL_WORKSPACE_CAPABILITIES`** in
`lib/workspaces/service.ts` is the validation registry (the source of truth for which capabilities can be persisted):

```
sessions, explorer, work-items, repositories, knowledge, workflows
```

(PATCH capabilities are normalized by `normalizeUpdateCapabilities`: the mandatory `sessions`+`explorer` core can never be dropped. `parseCapabilities` rejects anything outside `ALL_WORKSPACE_CAPABILITIES` with "Unknown capability" —— retired values (`feishu-transport`/`feishu-channel`/`wecom-channel`/`overview`/`loop`/`requirement-sources`) are simply unknown now, no read-path strip, no migration: a manifest still carrying one is config-invalid.)

- `manifest.capabilities` is required and always present (see "Workspace index v2" above). Read it directly; there is no derivation helper.
- **`parseCapabilities()`** rejects anything not in `ALL_WORKSPACE_CAPABILITIES` (`WorkspaceValidationError` → **HTTP 400**). To add a toggleable module you must (1) add the value to `ALL_WORKSPACE_CAPABILITIES` *and* the `WorkspaceCapability` type, (2) add an extension factory, (3) add a config UI panel.
- **Extension factories** (`lib/workspaces/extensions.ts`, `WORKSPACE_EXTENSION_FACTORIES`) turn a capability into an LLM-callable tool extension: `work-items` → work-item tools, `work-items` ∧ `workflows`（合取——第二个 work-items 工厂条目在 build 内补 workflows 检查，Phase-2 交付自动化）→ `delivery_*` designer/developer tools, `knowledge` → `kb_search` (opt-in ranked retrieval; coexists with always-on L0). **`subagent` is deliberately NOT registered here** (see Subagent below).
- **Attachment point**: `buildWorkspaceExtensions(manifest, path)` filters factories by `manifest.capabilities`. `lib/session-host/registry.ts` (`startRpcSession`) always attaches the built-in subagent extension globally (`createSubagentExtension` — see Subagent below), then — when the session's cwd is inside a workspace — appends `buildWorkspaceExtensions(...)`. (Skills are NOT workspace-scoped: 2026-10 removed the `manifest.skills` whitelist + `skillsOverride` session filter; the effective surface is only the global `disable-model-invocation` frontmatter toggle + install location global/project.)
### AGENTS.md auto-management (managed segments)

Each workspace may carry an `AGENTS.md` at its root. **`renderWorkspaceAgents(manifest, capabilities)`** is the
**capability-driven** generator (redesign decision 9): it emits a title, a collaboration-flow block when `work-items`
is on, a `<!-- workspace-managed:git:start/end -->` block when the manifest has `git` settings, and the repositories
block — **without depending on a template id**, so template-free workspaces still get a tailored policy. The legacy software-development template renderer was deleted alongside the template system.

The **repositories** block is *auto-maintained* between managed markers:

```
<!-- workspace-managed:repositories:start -->
## Workspace repositories
- `alias` (code, id: `...`): `repositories/code/alias`
<!-- workspace-managed:repositories:end -->
```

`updateManagedRepositoryInstructions()` (called on repo add/remove/restore) replaces the block by the regex
`<!-- workspace-managed:repositories:start -->[\s\S]*?<!-- workspace-managed:repositories:end -->` with a fresh
`renderWorkspaceRepositories(manifest)`. It is a **no-op if the markers are absent** (it never creates them) and only
runs when the `repositories` capability is effective. `pi` injects `AGENTS.md` into the system prompt **verbatim** —
there is no `@`-include expansion; large content must be *referenced* and the model follows the reference to `read` it.

The **delivery** block（`lib/workspaces/delivery-managed.ts`，final-arch step-6 Task 2）works the same way:
`updateManagedDeliveryInstructions(workspacePath)` rewrites content between
`<!-- workspace-managed:delivery:start/end -->` markers only（无标记 = no-op、永不自建），runs after a successful
`.pi/delivery.yaml` save（PUT）and after `POST …/delivery/init`, and failures are logged（console.error）without
failing the save/init that triggered them.

---

## 相关硬规则（自 Key Design Decisions 迁入）

### Workspace capability registry is the source of truth
`ALL_WORKSPACE_CAPABILITIES` (`lib/workspaces/service.ts`) is **the** validation list. `parseCapabilities()` throws on any value not in it, so a capability missing from this array — e.g. `subagent`, or historically `knowledge` before it was registered — **cannot be persisted** (a `PATCH …/capabilities` with it returns **400 "Unknown capability"**). The `WorkspaceCapability` *type* union contains `subagent` anyway because the tool is global; treat the type as a superset, not the validatable set. (`workflows` is registered and — since 2026-10 Phase-2 — **meaningful**: it activates 交付自动化（delivery automation）——the `delivery_*` 四角色（designer/developer/reviewer/release-preparer——verifier 已退役（checks 由 system 步执行））tools mount is the work-items∧workflows conjunction in `extensions.ts`, `assertAutomationCapable` gates `.pi/delivery.yaml` writes and the dispatcher re-checks it per tick（see Work Items 章的「Delivery 自动执行」小节）. The former `overview` capability is RETIRED — the overview dashboard renders unconditionally; manifests still listing `overview` get it stripped on read, see the capability system section.)

### Capabilities are required — no fallback path
`WorkspaceManifest.capabilities` is non-optional. `parseWorkspaceManifest` throws on a manifest without it, and the deleted `effectiveCapabilities` helper is NOT to be reintroduced — read `manifest.capabilities` directly. (The one-shot v2 migration and its read-path strip are gone; a manifest still carrying retired values is config-invalid.)

### AGENTS.md managed-segment replacement is a no-op without markers
`updateManagedRepositoryInstructions()` only rewrites content **between** the managed markers, and now maintains **two**
segments — `<!-- workspace-managed:repositories:start/end -->` and `<!-- workspace-managed:knowledge:start/end -->`.
Each is touched only when its capability (`repositories` / `knowledge`) is effective. If a user deletes a segment's
markers it will silently stop syncing — it never recreates them. The git block (`<!-- workspace-managed:git:start/end -->`)
is emitted once by `renderWorkspaceAgents` (when `git` settings exist) and not re-managed afterwards. The delivery
block (`<!-- workspace-managed:delivery:start/end -->`, `updateManagedDeliveryInstructions`) follows the identical
no-markers-no-op rule (see above).

### 交付初始化只补缺、只建议；模板另存永不覆盖（final-arch step-6）
`initializeDelivery`（`lib/workspaces/delivery-init.ts`，`POST …/delivery/init`）is fill-the-gaps only:
`.pi/delivery.yaml` is written **only when missing**（`enabled` 恒 false——启用是人的手）、role profiles are seeded
only when the file is absent、`from` 同布局目录的文件缺才复制；toolchain-probe 与 from 的检查命令只作为草稿进响应
`suggestedChecks`——**不执行、不自动落盘、不翻任何开关**，重跑幂等。`GET …/delivery/readiness` is a resident
read-only projection（非门禁）. Template save-as（`writeRoleTemplateCopy`，`POST …/delivery/roles/[role]/template`）
writes the current built-in template to `<ws>/.pi/agents/<role>.template.md` with flag `wx`——已存在 → 409，**永不
覆盖 `<role>.md` 与播种记录**（剧本文件之日起归工作区）。Workspace 契约面上这只是 `.pi/agents/` 下新增的一种
产品产物（见 file-map 的目录布局表 `.pi/agents/*.md` 行）。

### Knowledge repos use OKF; L0 is always built-in, clone never overwrites
A `knowledge` repo initialized with `mode: "init"` is seeded with an **OKF v0.2** structure via `renderOkfSeed`
(`lib/workspaces/okf.ts`): `index.md` (progressive-disclosure entry, frontmatter `type: index`), `log.md` (`type: log`),
and `concepts/welcome.md` (`type: concept` + tags). `mode: "clone"` is **never** overwritten — the remote brings its own
structure. **L0 access (read/ls/grep) is always built-in** and needs no tool (redesign decisions 11/12); existing
frontmatter-less bundles (e.g. legacy ones) are **not force-migrated** (decision 13, progressive) — they still work via
L0. The AGENTS.md knowledge segment **references** each bundle's `index.md` rather than inlining it (decision 10).

### kb_search is opt-in, self-healing, cross-bundle (L1)
The `knowledge` capability carries **two coexisting layers** (redesign decisions 11/14, §6.1): **L0** (always built-in
`read`/`ls`/`grep` — needs no tool) and **L1 `kb_search`** (an enhancement mounted by `buildWorkspaceExtensions` when
the capability is on). `kb_search` is implemented by `lib/workspaces/kb-search/` and is **pure-JS** (no native deps):
frontmatter (`type`/`tags`) + body are tokenized and ranked with **BM25**. It searches across **all active knowledge
bundles** of the workspace and merges results.

- **Self-healing index (decision 14)**: each `kb_search` call runs `ensureIndex()` first, which walks each bundle's
  `.md` files and compares **mtime** to the cached entry, re-parsing only new/changed files (deleted files are dropped).
  The index is a **rebuildable cache** at `<workspacePath>/.pi/cache/kb-index/<repoAlias>.json` (git-ignored). A
  missing or corrupt cache simply triggers a full rebuild — never a failure. Index writes are serialized with
  `withWorkspaceWriteLock`; a torn write (interrupted) is made harmless by tmp+rename atomic write.
- **Degrades gracefully**: if indexing fails for a bundle it is skipped; if all bundles fail, the tool returns an L0
  hint (`grep`/`ls`). L0 never depends on `kb_search`.
- The tool re-resolves the live active-knowledge-repo set on **each call**, so bundles added/removed during a session
  are picked up without a restart.
- The factory passes an initial repo snapshot at mount time; the source of truth at execution is the fresh manifest
  read (so `kb_search` and L0 always agree on which bundles exist).

### Subagent is global, not a workspace capability
The built-in subagent tools (`Agent` / `get_subagent_result` / `steer_subagent`) are attached to **every** session in `lib/session-host/registry.ts` via `createSubagentExtension` (`lib/subagent-extension.ts` + `SUBAGENT_CONTROLLER` wiring in the same file), regardless of workspace or capability. They are intentionally absent from `WORKSPACE_EXTENSION_FACTORIES` and `ALL_WORKSPACE_CAPABILITIES`. Profile discovery is cwd-based (`listSubagentProfiles(cwd)` reads `<cwd>/.pi/agents/` flat) and loop sessions run with cwd = workspace root, so workspace profiles load with zero wiring. Timeouts follow upstream semantics — no idle kill, no runtime cap; the heartbeat monitor exempts subagent children (see the Subagent section).
