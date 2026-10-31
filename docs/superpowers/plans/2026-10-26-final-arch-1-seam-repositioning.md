# 终局第一步：接缝归位（剧本入工作区、不变式入引擎）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把角色会话的 system prompt 从「lib 内四段硬编码合同」改为「引擎不变式合同 + 工作区剧本正文」；`profile` 从只读 `model:` 的假接缝变成整段注入的真接缝；`delivery.yaml` 升 v2、roles 四键同形；开启自动化时把四份剧本模板播种进 `.pi/agents/`（缺文件才写、永不改写）。四段合同与 opening 模板删除。

**Architecture:** 纯装配层改动——`role-session.ts` 重构 + `config.ts` 扩键 + 新增 `roles.ts`（角色词表）、`role-templates.ts`（模板 + 播种）、`role-preview.ts`（角色摘要与组合预览的只读投影）+ 路由（PUT 播种接入、两条只读 GET）+ 设置面板角色表。**池 / 领取事务 / 工具 / dispatcher / role-grants 零改动**（`pool.ts` 仅把 `DeliveryRole` 改为 re-export）。模型可见接口仍是恰五件工具；行为不变项：两步创建序、grant、命名、心跳、结束钩子、模型解析优先级。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent（原样）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §4.2（剧本接缝）/ §4.3.1（不变式全文，含 2026-10-26 修订记录）/ §6（装配序与播种）/ §7（v2 roles 四键）/ §10 差距 1-3、7 / §11 第 1 步。用户已批准（2026-10-25、2026-10-26 会话「同意」）。

## Global Constraints

- 不修改 `@earendil-works/pi-*` 任何源码或依赖版本；**绝不运行 `next build`**；验证只跑 `node --test`、`node_modules/.bin/tsc --noEmit`、`npm run lint` 与必要手测。
- **范围守恒**：`pool.ts`（除类型 re-export）、`claim.ts`、`tools.ts`、`dispatcher.ts`、`role-grants.ts`、`attempts.ts`、`checks.ts`、`worktrees.ts` 不改一行；工具面仍恰五件（`delivery_ask_human` 属第二步）。
- **不变式合同文字 = spec §4.3.1 逐字**（仅插入 role 与 key；第一步规则 3 为「submit / fail 二者之一」——spec 修订记录已注），由测试钉死全文；改文先改 spec。
- lib 内**禁止**再出现任何干活指令（design.md 骨架、TDD、检查清单处理、材料要素）与任何工作区专属事实（JDK/npm/分支名/宪法文件）——grep 守卫进测试。
- 播种每次保存都跑，但**每角色只播一次**（记录 `.pi/delivery-seeded.json`，final-fix A）：从未播过且缺文件才写（`writeFile` flag `wx`，EEXIST = 收养 existing）、**永不改写**；已记录角色删了剧本不重建（删除即终局）。
- v1 `delivery.yaml` 照常解析、语义等价（roles 只认已写键）、读出即归一为 v2；写回恒 v2。
- **页面是文件的编辑器**（spec §13.5）：Task 4 新增的两条路由都是只读投影，写路径仍只有既有 PUT；角色表不另建任何状态存储。
- 每任务以可运行测试结尾并提交；conventional 前缀。

### 本计划引入的默认选择（请用户复核，见 spec §12）

1. **profile 缺省 = 角色同名**：`roles.<role>.profile` 未配置时读 `.pi/agents/<role>.md`；配置显式名可指向别名（如 cargoware 的 `analyst`）。
2. 剧本文件缺失 → 会话只带不变式合同继续跑，`console.warn` 一次（不是错误：工作区可能尚未播种或刻意删除）。
3. `roles` 下**词表外键 → Validation 400**（防 `desginer` 之类拼错被静默丢弃；v1 文件只有双键不受影响）。
4. PUT 每次保存都跑播种，但每角色只播一次（记录 `.pi/delivery-seeded.json`）；删了不重建（final-fix A）；返回 `seeded.written/skipped` 供 UI 提示，播种失败降级 `seeded: null` + `seedingError` 不打死保存（final-fix B）。
5. 模型解析优先级不变：`roles.<role>.model` → 剧本 frontmatter `model:` → 默认；因 1 的缘故，同名剧本的 `model:` 在无配置时也会生效。

---

### Task 1: 角色词表 + 配置 v2 四键 + v1 兼容

**Files:**
- Create: `lib/work-items/delivery-runner/roles.ts`
- Modify: `lib/work-items/delivery-runner/pool.ts`（`:44` 的 `export type DeliveryRole` 改为 `export type { DeliveryRole } from "./roles.ts"`；其余零改动）
- Modify: `lib/work-items/delivery-runner/config.ts`
- Modify: `lib/work-items/delivery-runner/config.test.mjs`

**Interfaces:**

```ts
// roles.ts（零依赖，防 config ↔ pool 循环导入）
export const DELIVERY_ROLES = ["designer", "developer", "verifier", "release-preparer"] as const;
export type DeliveryRole = (typeof DELIVERY_ROLES)[number];
export function isDeliveryRole(value: unknown): value is DeliveryRole;

// config.ts
export interface DeliveryRunnerConfig {
  schemaVersion: 2;                                            // 输出恒 2
  enabled: boolean;
  roles: Partial<Record<DeliveryRole, DeliveryRoleConfig>>;    // 四键同形、各自可选（替代 {designer?, developer?}）
  budget: { maxAttemptsPerInput: number; maxExecutionMinutes: number };
  verification?: { checks: DeliveryCheckConfig[] };
}
export const DEFAULT_DELIVERY_RUNNER_CONFIG: DeliveryRunnerConfig;   // schemaVersion 2 / disabled / roles {} / 3-30
export function parseDeliveryRunnerConfig(value: unknown): DeliveryRunnerConfig;
// schemaVersion 接受 1 | 2（其余 Validation）→ 输出 2；roles：遍历传入键，键 ∉ DELIVERY_ROLES → Validation
//   `roles.<key> is not a delivery role`；每键 parseRole 同今；DeliveryRoleConfig / parseRoleModel / budget / verification 不变。
```

- [ ] **Step 1: 失败测试**——默认配置 schemaVersion 2；v1 文件（含旧单键 designer、双键）解析成功且 roles 等价、输出 schemaVersion 2；四键各自 shape 校验（复用现 designer/developer 用例扩到 verifier/release-preparer）；`roles.desginer` → Validation；schemaVersion 3 → Validation；round-trip 四键保留且落盘 `schemaVersion: 2`；既有 verification/budget/route 用例全部保持（`:222` 旧单键用例续绿）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（roles.ts；config.ts 类型/默认/parse；pool.ts re-export）→ **Step 4: `node --test` 全量 + tsc + lint**（`role-grants.ts`/`role-session.ts` 从 pool 导入 `DeliveryRole` 经 re-export 零改动通过）→ **Step 5: Commit** `feat: delivery config v2 with four role keys and shared role registry`

---

### Task 2: 不变式合同 + 剧本正文注入 + 通用开场（删除四段合同）

**Files:**
- Modify: `lib/work-items/delivery-runner/role-session.ts`
- Modify: `lib/work-items/delivery-runner/role-session.test.mjs`

**Interfaces:**

```ts
// role-session.ts —— 删除：DESIGNER_CONTRACT / buildRoleContract / developerContract /
//   verifierContract / releasePreparerContract / readDesignerProfileModel（:53-154、:255-276）
export const AGENT_INVARIANT_CONTRACT: (ctx: { role: DeliveryRole; key: string }) => string;
// 全文 = spec §4.3.1 六条逐字 + 标题行 `# 交付回合不变式（${role} · ${key}）`；规则 1 内插 ${key}；
// 规则 3 第一步文本「本轮以 submit / fail 二者之一结束；结束时不得留进行中的领取。」（spec 修订记录）
export interface RoleProfile { model?: { provider?: string; modelId: string }; body: string }
export function readRoleProfile(workspacePath: string, profile: string): RoleProfile | undefined;
// PROFILE_NAME_RE 名门 → <ws>/.pi/agents/<profile>.md → parseFrontmatter：model = data.model（现拆分规则：
//   `provider/modelId` 双非空 → {provider, modelId}，裸 → {modelId}）、body = rest.trim()；缺文件/非法名 → undefined；
//   无 frontmatter → body = 全文。只读工作区目录（不走 resolveSubagentProfile——它跨 user/project 作用域，有同名歧义）。
export function resolveRoleProfileName(role: DeliveryRole, roleConfig?: DeliveryRoleConfig): string;  // roleConfig.profile ?? role
export function composeRoleSystemPrompt(ctx: { role: DeliveryRole; key: string }, profile?: RoleProfile): string;
// = [AGENT_INVARIANT_CONTRACT(ctx), profile?.body].filter(非空).join("\n\n")
export function openingPromptFor(role: DeliveryRole, task: { key: string; title: string }): string;
// 单一通用四步（四角色仅 role 字样不同）：① delivery_list_ready_tasks 列池 ② 领取 ${key} ${title}——只领此一项，
//   不可领取说明后结束 ③ 依据领取返回的上下文（需求、上游产物、worktree 或检查清单）按你的剧本完成本阶段工作
//   ④ delivery_submit_result 提交即结束；无法推进 delivery_fail_task（环境/依赖阻塞 blocked=true）后结束。
// LaunchDeps：readProfileModel → readProfile?: (workspacePath, profile) => RoleProfile | undefined | Promise<同>
// launchRoleSession：profileName = resolveRoleProfileName(role, config.roles?.[role])；profile = readProfile(...)（抛 → 记日志当 undefined）；
//   缺 profile → console.warn(`[delivery-runner] ${role} has no profile at .pi/agents/${profileName}.md; running with invariant contract only`)；
//   model = roleConfig.model ?? profile?.model ?? 默认；appendSystemPrompt = composeRoleSystemPrompt(...)；其余逐字节不变。
```

- [ ] **Step 1: 失败测试**——删除 `:387-473`、`:575-602`、`:668-700` 合同内容用例；新增：(a) `AGENT_INVARIANT_CONTRACT` 全文与测试内嵌期望**逐字相等**（含 role/key 内插、第一步规则 3 文本）；(b) compose：有 body = 不变式 + `\n\n` + body；无 body = 仅不变式、无尾分隔；(c) `resolveRoleProfileName` 缺省同名、显式优先；(d) `readRoleProfile`：frontmatter model+body / 无 frontmatter 全文为 body / `../x` → undefined / 缺文件 → undefined；(e) `openingPromptFor` 四角色含 KEY、标题与四个工具名，去掉 role 字样后四者文本相同，且不含 `design.md` / `release_notes` / `worktree 清单`；(f) launch：`appendSystemPrompt` 以不变式标题开头、含注入的剧本正文、**不含** `constraints.md`/`budget.md`（过期宪法引用回归守卫）；缺 profile 走 warn 不抛；(g) 模型优先级三例改走 `readProfile`（`:140-230` 用例迁移）；(h) 两步序 / grant / 命名 / 心跳 / 结束钩子用例（`:106-139`、`:273-386`、`:474-574` 的非合同断言、`:603-667`、`:701-`）保持。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全量 + tsc + lint**（`grep -rn "buildRoleContract\|DESIGNER_CONTRACT\|readDesignerProfileModel" lib app components` 为空）→ **Step 5: Commit** `refactor: compose role sessions from invariant contract and workspace profiles`

---

### Task 3: 剧本模板 + 播种 + 路由接入

**Files:**
- Create: `lib/work-items/delivery-runner/role-templates.ts`
- Create: `lib/work-items/delivery-runner/role-templates.test.mjs`
- Modify: `app/api/workspaces/[id]/delivery/route.ts`（PUT：`writeDeliveryRunnerConfig` 成功后 `seedRoleProfileTemplates`，响应 `{ config, seeded }`；GET 不变）
- Modify: `lib/work-items/delivery-runner/config.test.mjs`（`:304` 路由用例：响应含 `seeded`、文件落盘、二次 PUT 全 skipped）

**Interfaces:**

```ts
// role-templates.ts
export const ROLE_TEMPLATE_VERSION = 1;                       // 模板升级时递增；spec §13.3 漂移提示的依据
export const ROLE_PROFILE_TEMPLATES: Readonly<Record<DeliveryRole, string>>;
// 每份 = frontmatter { name: <role>, description: <一句>, seeded_from: "<role>@<ROLE_TEMPLATE_VERSION>" } + 剧本正文（可被 lib/subagents.ts parseProfileFile 解析：
//   name 合法、systemPrompt = 正文）。正文只含干活内容，按角色必须覆盖：
//   designer —— 通读 README 与涉及仓库；design.md 骨架（方案 / 影响面 / 步骤拆解）；验收条件逐条可核验；需求不清 → fail 说明。
//   developer —— 读已确认 design.md 与验收条件；在领取返回的 worktree 分支内实现并自测（建议先写失败测试）；完成后 commit；
//                submit candidates（每仓一个 commit sha）+ notes（变更说明 / 自测情况）。
//   verifier —— 对领取返回的 checks 清单逐项 delivery_run_check；同名重跑覆盖；unverified = 环境问题处理后重跑；
//               发现实现问题不自行修复（走提交后的 rework 反馈）；全部跑完 submit（只需 key，可选 notes）。
//   release-preparer —— 材料四要素（变更摘要 / 影响面 / 验证结论引用 / 回滚建议）；只引用 delivery.verification 实际登记
//                       的检查与结果，证据不足不编造 → fail；submit release_notes 必填、rollback_notes 可选。
// 正文**不得**含：不变式六条任何一句（守卫串「交付回合不变式」「成功才动手」「那是人的手」）；工作区专属事实
//   （守卫 /jdk|mvn|npm|origin\/master|constraints\.md|budget\.md|cargoware/i）。
export interface SeedResult { written: DeliveryRole[]; skipped: DeliveryRole[] }
export async function seedRoleProfileTemplates(workspacePath: string): Promise<SeedResult>;
// mkdir -p <ws>/.pi/agents → 读一次性记录 <ws>/.pi/delivery-seeded.json（缺文件 → {}；不可读/畸形 → fail-safe：
//   一字不写、全角色 skipped、console.error 一次——「永不重建」压过播种）→ 逐 DELIVERY_ROLES：
//   roles.<role> 已记录 → skipped（文件删了也不重建，删除即终局）；未记录且 <role>.md 在场（wx EEXIST 同）
//   → 记 "existing"、skipped（收养永不写）；未记录且缺文件 → writeFile flag "wx" 写模板（其它错误照抛）、
//   记 "<role>@<ROLE_TEMPLATE_VERSION>"。记录有变 → writeAtomic 回写（与 delivery.yaml 同款）。
```

- [ ] **Step 1: 失败测试**——模板：四键齐、`parseFrontmatter` 的 `data.name === role`、`data.seeded_from === \`${role}@${ROLE_TEMPLATE_VERSION}\``、正文非空、两组守卫 regex 不命中；`resolveSubagentProfile(ws, "designer")` 能读出 `systemPrompt` 非空（与 subagent 列表共存不报错）。播种：空工作区 → written 4 且内容等于模板；二次 → skipped 4；预置 `designer.md` 自定义内容 → written 3 / skipped 1 且该文件字节不变；`.pi/agents` 不存在自动建目录。路由：PUT 响应 `seeded.written.length === 4`、磁盘有四文件；再 PUT → `skipped` 4；capability 门与 400 映射用例保持。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全量 + tsc + lint** → **Step 5: Commit** `feat: seed workspace role profile templates on delivery config save`

---

### Task 4: 角色表（剧本下拉 + 模型覆写 + 状态）+ 组合预览 + 播种提示

**Files:**
- Create: `lib/work-items/delivery-runner/role-preview.ts`（只读投影，复用 Task 2 的 `resolveRoleProfileName` / `readRoleProfile` / `composeRoleSystemPrompt` / `AGENT_INVARIANT_CONTRACT`）
- Create: `lib/work-items/delivery-runner/role-preview.test.mjs`
- Create: `app/api/workspaces/[id]/delivery/roles/route.ts`（GET 四角色摘要）
- Create: `app/api/workspaces/[id]/delivery/roles/[role]/preview/route.ts`（GET 组合预览）
- Modify: `lib/api-types.ts`（`DeliveryRolesResponse` / `DeliveryRolePreviewResponse`）
- Modify: `lib/work-items/delivery-runner/routes.test.mjs`（两条 GET 的形状 / 404 / 400）
- Modify: `components/WorkspaceManager.tsx`（`:587-624`、`:842-894`、`:2280` 附近：designer/developer 双文本框 → 角色表；见下）
- Modify: 若现有组件测试覆盖 delivery 配置块（`grep -l "designer" components/*.test.mjs`）则同步断言；否则按手测清单验证。

**Interfaces:**

```ts
// role-preview.ts
export interface RoleSummary {
  role: DeliveryRole;
  profile: { name: string; path: string; exists: boolean; explicit: boolean; seededFrom?: string };
  //        name = resolveRoleProfileName；explicit = 来自 roles.<role>.profile；seededFrom = frontmatter seeded_from
  model: { effective?: { provider?: string; modelId: string }; source: "override" | "profile" | "default" };
  //        优先级与 launch 完全一致：roles.<role>.model → 剧本 frontmatter model → 默认（effective 缺省）
}
export function summarizeRoles(workspacePath: string, config: DeliveryRunnerConfig | null): RoleSummary[];   // DELIVERY_ROLES 序
export interface RolePromptPreview extends RoleSummary {
  agentsMd: string | null;   // <ws>/AGENTS.md 全文（缺 → null）——仅展示：pi 从 cwd 注入，不参与 composed
  invariant: string;         // AGENT_INVARIANT_CONTRACT({ role, key: "<KEY>" })
  body: string;              // 剧本正文（缺 → ""）
  composed: string;          // composeRoleSystemPrompt(...)——与 launch 的 appendSystemPrompt 同一函数
}
export function previewRolePrompt(workspacePath: string, role: DeliveryRole, config: DeliveryRunnerConfig | null): RolePromptPreview;
// 路由：GET …/delivery/roles → { roles: RoleSummary[] }；GET …/delivery/roles/[role]/preview → { preview }；
//   role ∉ DELIVERY_ROLES → 404；配置坏 YAML → 400（workItemErrorResponse）；与 GET config 同款无 capability 门（只读）。
```

**角色表（WorkspaceManager 交付块）**：四行（DELIVERY_ROLES 序）——
- 剧本列：下拉，选项 = `/api/subagents/profiles?cwd=<workspacePath>` 中 `scope === "project"` 的 name 列表，首项「同名（`<role>.md`）」= 不写 `roles.<role>.profile` 键；选别名 = 写键。
- 模型列：`ModelSelector`（选项同 AgentsConfig 的 `/api/models?cwd=`）；选择 = 写 `roles.<role>.model` 覆写，清空 = 删键；占位文案显示摘要的有效模型与来源（覆写 / 剧本默认 / 工作区默认）。
- 状态列：来自 `GET …/delivery/roles`——存在（`seededFrom` 有则附「模板 vN」）/ 缺失（同名时提示「保存后自动播种」，别名时提示「请在 Agents 面板创建」）。
- 操作列：「编辑剧本」= `setLastSettingsSelection("agents", "project:<name>", workspacePath)` 后切到设置 › Agents 面板（既有导航入口，接法属实施者自由）；「预览 prompt」= 抽屉渲染 `preview`：AGENTS.md（默认折叠，附「打开文件」）▸ 不变式（锁定样式、灰底、链 spec §4.3.1）▸ 剧本正文，顶部一行有效模型 + 来源 + 剧本路径。
- round-trip 习语保留：PUT 整份 config，未触碰角色的既有 profile / model 原样回传；保存成功后按响应 `seeded.written` 显示「已播种 N 份剧本到 .pi/agents/」（空不显示）并重取角色摘要。

- [ ] **Step 1: 失败测试**——`summarizeRoles`：四行且序固定；explicit vs 同名缺省；`exists` 随文件；`seededFrom` 取自 frontmatter；model 来源三态与优先级（覆写压剧本、剧本压默认）。`previewRolePrompt`：`composed` 与 `composeRoleSystemPrompt` 逐字相等；`invariant` 以 `# 交付回合不变式` 开头且含 `<KEY>`；AGENTS.md 缺 → `agentsMd === null`、在 → 全文；剧本缺 → `body === ""`。路由：roles GET 形状；preview 非法 role 404；坏 YAML 400。组件/手测：四行渲染；只改 verifier 剧本时 PUT 体 roles 仅多 verifier 键；既有 designer `model` 覆写不丢；清空模型删键；播种提示首存出现、二次不出现；预览抽屉三段齐且不变式不可编辑。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 全量 + tsc + lint** → **Step 5: Commit** `feat: delivery role table with profile picker, model override and prompt preview`

---

### Task 5: 文档三层同步 + 回归守卫

**Files:**
- Modify: `AGENTS.md`（「工作项 / 交付流」硬规则增两条：① 角色剧本住工作区 `.pi/agents/<role>.md`（缺省同名），lib 只持不变式合同 `AGENT_INVARIANT_CONTRACT`（全文钉于终局 spec §4.3.1，改文先改 spec）与模板，lib 内禁写干活指令与工作区专属事实；② 播种只在保存 delivery 配置时、缺文件才写、永不改写）
- Modify: `knowledge/reference/work-items.md`（「Delivery 自动执行」节：合同描述 → 装配序（AGENTS.md / 不变式 / 剧本正文）+ profile 真接缝 + 播种 + v2 四键 + 默认同名；删除「designer 合同逐字节保留」类表述）
- Modify: `knowledge/architecture.md`（工作区一节加一行：交付角色的剧本是工作区资源 `.pi/agents/<role>.md`）
- Modify: `knowledge/reference/file-map.md`（新增 `roles.ts`、`role-templates.ts`、`role-preview.ts` 与两条 `delivery/roles` 路由条目；`role-session.ts` 注释更新）

- [ ] **Step 1: 文档更新** → **Step 2: 回归守卫**（全量 `npm test`、tsc、lint；`grep -rn "constraints.md\|budget.md" lib/work-items` 为空；`grep -rn "buildRoleContract\|DESIGNER_CONTRACT" lib app components` 为空；tools.test 工具恰五件断言续绿；dispatcher.test 零改动续绿）→ **Step 3: spec §10 差距 1/2/3/7 静态勾验** → **Step 4: Commit** `docs: baseline for workspace role profiles and invariant contract`

---

## 端到端冒烟（controller，重启 dev server 后）

1. 在 smoke 工作区开启交付自动化并保存 → `.pi/agents/` 出现四文件，响应 `seeded.written` 四项。
2. 编辑 `designer.md` 正文加一句可识别标记 → 建 intake 需求 → dispatcher 起 designer 会话 → 打开该会话文件核对 system prompt：不变式标题在前、标记句在后、无 `constraints.md`。
3. 删除 `verifier.md` → 推进到 verification → 会话仍起、日志出现 warn、system prompt 仅不变式。
4. 配置 `roles.designer.profile: analyst`（预置别名文件）→ 新一轮 designer 会话注入 analyst 正文而非同名文件。
5. 旧 v1 `delivery.yaml` 工作区：GET 返回 v2 归一结果、池 / 领取行为与改前一致。
6. 角色表把 designer 剧本切到别名 `analyst` 并保存 → 预览抽屉正文为 analyst 内容、状态列「存在」；切回同名 → PUT 体不含 `roles.designer.profile`。
7. 预览抽屉的不变式段与会话文件里实际 system prompt 的不变式段逐字一致（同一函数产出）。

## 自审记录（写计划时已核对）

- Spec 覆盖：§4.2 剧本接缝 → T2/T3；§4.3.1 不变式（含修订：规则 2 并入不合并不推送、规则 3 第一步文本）→ T2 钉死；§6.1 装配序 → T2；§6.2 播种 → T3；§7 v2 四键 → T1；§10 差距 1（四合同删除）2（假 profile）3（双键）7（宪法引用）→ T2/T2/T1/T2+T5 守卫；§11 第 1 步「池/事务/工具零动」→ Global Constraints 范围守恒 + T5 grep。
- 已核事实：四段合同、`readDesignerProfileModel`、`openingPromptFor` 仅 `role-session.ts` 内部与测试引用（删除面封闭）；`parseFrontmatter` 返回 `{data, rest}`（正文可得）；`lib/subagents.ts` 的 `parseProfileFile` 对 frontmatter 宽容（name 缺省 basename、description 缺省 name、systemPrompt = rest），模板与 subagent 列表共存无解析风险；`DeliveryRole` 实际导入方为 `role-session.ts` / `role-grants.ts`（`config.ts`、`WorkspaceManager.tsx` 命中为 `DeliveryRoleConfig` 子串），re-export 零改动。
- 取舍：`DeliveryRole` 迁入零依赖 `roles.ts` 而非留 pool（config 需遍历词表，直接导 pool 会成环）；`readRoleProfile` 不复用 `resolveSubagentProfile`（跨作用域同名歧义，交付剧本只认工作区目录）；播种放 `role-templates.ts` 而非 `config.ts`（config 保持纯 yaml 层）；播种由路由触发而非 dispatcher（人保存配置 = 显式开启的时刻；dispatcher 不写工作区文件）。
- Spec 修订两处已落（§4.3 修订记录）：规则 2 文本、规则 3 第一步临时文本与切换时点（第二步 `delivery_ask_human` 上线）。
- Task 4 升级（2026-10-26 用户同意，spec §13.5）：从四个文本框改为角色表 + 两条只读路由 + 组合预览；复用 AgentsConfig / ModelSelector / `/api/subagents/profiles` / `/api/models`，不重造编辑器；预览的 `composed` 与 launch 走同一函数，杜绝「预览与实际不一致」。`seeded_from` 随 Task 3 模板落（spec §13.3 漂移提示依据）。
- 未做：reviewer 角色（第三步）、ask / attention（第二步）、stages / attention 配置块（第二～四步）、dev-loop 剧本改挂（第五步，cargoware 侧人工校订）、init 向导 / 就绪清单 / delivery managed 块 / `--from` / 模板对比另存 / AgentsConfig 交付感知 / profile 哈希冲突（第六步，spec §11）。
