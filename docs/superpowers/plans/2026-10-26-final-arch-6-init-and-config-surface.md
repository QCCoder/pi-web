# 终局第六步：初始化与配置面完善 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `initializeDelivery`（只补缺的初始化：扫描登记 / delivery.yaml 默认 / 剧本播种 / `--from` 复制）+ `deliveryReadiness` 就绪清单 + delivery managed 块 + profile 保存哈希冲突 + AgentsConfig 交付感知（角色徽标 / 锁定不变式 / 组合预览 / 模板另存）。**探测出的 checks 命令只是向导草稿，从不自动落盘执行；init 永不翻 enabled。**

**Architecture:** 新模块 `lib/workspaces/delivery-init.ts`（init + readiness，纯服务层）+ 两条路由 + managed 块函数（照抄 repositories 块机制）+ `saveSubagentProfile` 哈希参数 + AgentsConfig/WorkspaceManager 增量 UI。工具面恰六件不变。

**Tech Stack:** Next.js App Router、@earendil-works/pi-coding-agent（原样）、node:test + jiti。

**Spec:** `docs/superpowers/specs/2026-10-26-delivery-engine-final-architecture-design.md` §6.2 / §13.2 / §13.3 / §13.5 / §13.5.1（第六步落地决策）/ §11 第 6 步。用户站立授权「继续处理，直到全部做完」。

## Global Constraints

- 不修改 `@earendil-works/pi-*`；**绝不 `next build`**；验证只跑 `node --test`、`tsc --noEmit`、`npm run lint`。
- **init 只补缺、只建议**：不翻 `enabled`、不执行任何探测/集成命令、不覆盖既有文件；`from` 复制剥 `repositoryId`、不复制 AGENTS.md。
- 播种既有不变式延续（一次性记录、缺文件才写、永不改写）；哈希冲突只在**显式传入** `expectedContentHash` 时生效（旧客户端宽容写不断）。
- 范围守恒：引擎事务/池/工具零改动；`delivery-init.ts` 只读复用 `seedRoleProfileTemplates` / `readDeliveryRunnerConfig` / 扫描。
- 每任务以可运行测试结尾并 pathspec 提交（索引里有用户预暂存 knowledge/ 文件——**绝不裸 `git commit` / `--amend`**）。

### 默认选择（请用户复核）

1. 工具链探测映射：`pom.xml`→`mvn -q test`、`package.json`→`npm test`、`pyproject.toml`→`pytest`、`go.mod`→`go test ./...`、`Cargo.toml`→`cargo test`（草稿文案注明「按需修改」）。
2. `from` 只接受「同布局目录」（存在 `.pi/` 即可）；来源不存在的角色文件跳过。
3. 哈希冲突仅 project 作用域（`.pi/agents/`）；global profile 不设防（用户主目录自担）。
4. 模板另存文件名固定 `<role>.template.md`；已存在 → 409。

---

### Task 1: `delivery-init.ts`（initializeDelivery + deliveryReadiness）+ 路由

**Files:**
- Create: `lib/workspaces/delivery-init.ts`、`lib/workspaces/delivery-init.test.mjs`
- Create: `app/api/workspaces/[id]/delivery/init/route.ts`（POST，capability 门 = `assertAutomationCapable`）、`app/api/workspaces/[id]/delivery/readiness/route.ts`（GET 只读无门）
- Modify: `lib/workspaces/service.ts`（export `syncRepositoriesFromScan` 若未导出——只加 export）
- Modify: `lib/api-types.ts`（响应镜像类型）

**Interfaces:** 见 spec §13.5.1（`initializeDelivery` 语义、`deliveryReadiness` 五类缺项、响应=动作清单+就绪清单）。工具链探测映射见计划默认 1（按仓根 marker 文件给草稿——探测结果只进响应 `suggestedChecks`，不写盘）。

- [ ] **Step 1: 失败测试**（真临时工作区）——空工作区 init：写 delivery.yaml v2 默认（enabled false）、播种四剧本、响应动作清单；重复 init 幂等（全 skipped/unchanged）；`from`：同布局源目录 → 角色文件复制（剥 seeded_from 换 copied_from）、checks 剥 repositoryId 进 suggestedChecks 不落盘、integrate.sh 骨架复制、AGENTS.md 不复制；预置用户 designer.md → 不覆盖；readiness 五类缺项各自出现/消失（含 checks 指向未登记仓）；capabilities 缺项；init 不翻已有 enabled=true；探测草稿不落盘。路由：POST 门；GET 无门。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: delivery initialization, readiness projection and routes`

---

### Task 2: delivery managed 块 + profile 哈希冲突

**Files:**
- Modify: `lib/workspaces/service.ts`（`updateManagedDeliveryInstructions(workspacePath)`——渲染块内容 = enabled + 每活角色一行（profile/model）+ checks 一行 + integrate/acceptance；标记 regex 照抄 repositories 块；无标记 no-op。在 `PUT /delivery` 保存后调用——挂点在 delivery 配置路由）
- Modify: `app/api/workspaces/[id]/delivery/route.ts`（写成功后调 `updateManagedDeliveryInstructions`，失败记日志不挡保存）
- Modify: `lib/workspaces/service.test.mjs` 或新测试（块渲染/无标记 no-op/标记删除即停）
- Modify: `lib/subagents.ts`（`saveSubagentProfile(cwd, scope, profile, expectedContentHash?)`：project 作用域、文件已存在、`expectedContentHash` 给定且 ≠ 当前正文 sha256 → `ProfileConflictError`（新错误类，携带 `currentContentHash`）；写入时 frontmatter 附 `content_hash`（正文 sha256——正文 = frontmatter 之外部分，与 learner 习语一致）；**不传 = 宽容写**）
- Modify: `app/api/subagents/profiles/route.ts`（PUT body 增可选 `expectedContentHash`；`ProfileConflictError` → 409 `{ error, currentContentHash }`；GET 响应 profiles 附 `contentHash`）
- Modify: `lib/subagents.test.mjs`（若有）或新 `profile-hash.test.mjs`
- Modify: `components/AgentsConfig.tsx`（**用户可能 WIP——git status 核实**；保存携带列表态 contentHash、409 → 内联「文件已被外部修改，请重载」+ 重载按钮；HEAD-clean 则提交，否则编辑不提交报告）

- [ ] **Step 1: 失败测试**——managed 块三态；哈希：写入后 frontmatter 含 content_hash 且与正文一致；expected 不符 → ProfileConflictError + currentContentHash；expected 相符 → 写成功且 hash 更新；不传 → 宽容；global 作用域不设防；路由 409 形状。AgentsConfig 手测清单。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: delivery managed segment and profile save conflict detection`

---

### Task 3: 配置面 UI（init 向导 + 就绪清单 + AgentsConfig 交付感知 + 模板另存）

**Files:**
- Modify: `components/WorkspaceManager.tsx`（**用户 WIP——编辑不提交**）：交付块增「初始化」区（from 目录输入 + checks 草稿表(可编辑) + 执行按钮 → POST init → 显示动作清单）、就绪清单常驻（readiness GET，随 5s 节拍）、模板漂移提示（状态列已有 vN，对比 `ROLE_TEMPLATE_VERSION`——需要 roles 路由响应带当前版本：小改 `role-preview.ts` 的 RoleSummary 或单独常量路由——选最小：readiness 响应带 `currentTemplateVersion`）
- Modify: `components/AgentsConfig.tsx`（若 Task 2 未提交则同样不提交）：绑定角色徽标（GET roles 数据已有消费方模式）+ 编辑区上方锁定不变式展示（`GET …/delivery/roles/[role]/preview` 的 `invariant` 段）+ 组合预览标签（`composed` 三段）+ 「模板已更新，另存为副本」按钮（POST `…/delivery/roles/[role]/template`——**新路由**：写 `<role>.template.md`，存在 409）
- Create: `app/api/workspaces/[id]/delivery/roles/[role]/template/route.ts`（POST；409 已存在）
- Modify: `lib/work-items/delivery-runner/role-preview.ts`（如选 readiness 携带版本则不动；模板写入函数放 `role-templates.ts` 导出）
- Modify: 相关 `.test.mjs`（路由源断言 + role-templates 写模板测试）

- [ ] **Step 1: 测试/手测**——template 路由：写副本、二次 409、不改 `<role>.md`；AgentsConfig 三件套源断言；WorkspaceManager 初始化区/就绪清单源断言；手测清单。
- [ ] **Step 2–4 同前** → **Step 5: Commit** `feat: delivery init wizard surfaces, readiness list, agents delivery awareness and template save-as`

---

### Task 4: 文档 + 回归守卫

**Files:**
- Modify: `AGENTS.md`（编辑不提交：init 只补缺语义、managed delivery 块、profile content_hash 冲突、AgentsConfig 交付感知一行）
- Modify: `knowledge/reference/workspace.md` / `work-items.md` / `file-map.md`（编辑不提交）
- 守卫：全量 `npm test`、tsc、lint；`grep -rn "initializeDelivery\|deliveryReadiness" lib app` 与文档名一致。

- [ ] Step 1 文档 → Step 2 回归 → Step 3 Commit（若有无主可提交文件则 `docs: …`，否则无提交并报告）

---

## 端到端冒烟（controller；真 smoke 工作区；无 LLM）

1. 新 smoke 工作区 POST init（无 from）→ delivery.yaml 默认 + 四剧本 + 动作清单；readiness 列 no-checks 等。
2. 造 pom.xml 仓 → 扫描 → init 第二次 → suggestedChecks 出 `mvn -q test` 草稿且未落盘。
3. `from` 第一个 smoke 工作区 → 角色文件 copied_from、checks 剥 repositoryId。
4. AgentsConfig 改 designer.md 保存 → content_hash 落盘；外部改文件 → 再保存 → 409 → 重载后保存成功。
5. 模板另存 → `<role>.template.md` 出现；二次 → 409。

## 自审记录

已核事实：`syncRepositoriesFromScan` 在 listWorkspaceRepositories 内触发（init 显式调用需 export 或走 listWorkspaceRepositories 一次——实现者择优并报告）；`saveSubagentProfile` 是同步 fs 写（frontmatter 组装在 `stored` 变量处，哈希插入点清晰）；`assertAutomationCapable` 可从 config.ts 导入复用；AgentsConfig 保存走 PUT `/api/subagents/profiles`（route.ts:35）。未做：digest 渲染/巡逻（第五步）。
