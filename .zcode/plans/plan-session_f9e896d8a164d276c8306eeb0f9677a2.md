# 工作项 Git 分支跟踪

目标：工作项能体现「当前开发在什么分支、是否已合入 develop / master」。方案按未答复时的推荐项执行：**工作项持久化分支字段**（每关联仓库一个）+ **合并状态实时计算不落盘** + **目标分支 develop/master（都不存在时兜底 main）** + **详情页区块 + 列表行徽标**。

## 1. 数据模型（lib/work-items/types.ts + service.ts）

- 新类型 `WorkItemBranchRef { repositoryId: string; branch: string }`；`WorkItemRecord` 加可选 `branches?: WorkItemBranchRef[]`（每仓库至多一条）。
- `CreateWorkItemInput` / `UpdateWorkItemInput` 加 `branches?`（空数组 = 清空，与 repositories 等数组字段语义一致；保持纯数组 schema，无 union）。
- `serializeWorkItem`/`parseWorkItem`：YAML 键 `branches`，条目 `repository_id` / `branch`，缺省省略（旧 item.yaml 无此键照常解析）。
- `changedFields` 加 `"branches"` → 自动进 `work_item.updated` 事件 diff，审计免费。
- 校验：`repositoryId` 必须属于该项 `repositories`（PATCH 同时改 repositories 时按合并后的列表校验）、branch 非空 trim。
- 门禁：`released` 冻结条件加 `input.branches !== undefined`（与 repositories/loop 同列）；managed 项 phase/status 门不受影响。

## 2. Git 探测模块（新文件 lib/work-items/branch-status.ts）

- 私有 `git()` helper 照 lib/worktree.ts 模式（`-C` + timeout 10s + LC_ALL=C）。
- 原语：`branchExists`（`rev-parse --verify --quiet refs/heads/<b>`）、`isAncestor`（`merge-base --is-ancestor <from> <target>`，exit 0/1）、`resolveTargets`（develop/master 存在性检查，全缺 → main）、`listDeliveryBranches`（`for-each-ref refs/heads/pi-delivery/<KEY>/`，按 gen 排序）。
- 模块级 TTL 缓存（30s，key = repoPath+分支/提交），端点 `?refresh=1` 可绕过。
- 导出共享类型（前端直接 import type，沿现有前后端共享模式）：

```ts
interface WorkItemRepoBranchStatus {
  repositoryId: string; alias: string; repoPathExists: boolean;
  itemBranch: string | null;        // 工作项登记的分支
  repoBranch: string | null;        // 仓库当前 checkout（复用 repo state）
  itemBranchExists: boolean;
  branchTargets: MergeCheck[];      // 对 itemBranch 的 [{target, merged}]
  deliveryBranches: string[];       // pi-delivery/<KEY>/* 自动识别
  latestDelivery?: { branch: string; targets: MergeCheck[] };  // 最新 gen 的合并状态
  candidate?: { commit: string; targets: MergeCheck[] };       // managed 项 delivery.candidates 该仓提交
  error?: string;
}
```

## 3. API（新路由 app/api/workspaces/[id]/work-items/[key]/git/route.ts）

- `GET`（支持 `?refresh=1`）：读 item → `listWorkspaceRepositories` 拿各仓 branch/exists（自带 30s 缓存）→ 对 `item.repositories` 逐仓并行计算上述状态；已移除/缺失仓库返回 error 条目。响应 `{ repositories: WorkItemRepoBranchStatus[] }`。

## 4. LLM 工具（lib/work-items/extension.ts）

- `workspace_update_work_item` 的 schema 加可选 `branches` 数组并透传，描述里提示代理：建好开发分支后登记，便于跟踪合并状态。

## 5. 前端（components/work-items/）

- `WorkItemDetailView.tsx`：概况之后、代码与验证之前新增 `<Section title="Git 分支">`（刷新按钮放 Section actions）。每仓一块：分支 chip（mono）+ 每目标「已合入/未合入」徽标（accent/灰）；分支不存在灰字；未设置时 inline 输入 + 保存（PATCH `branches`，带 `item.revision`）+「取仓库当前分支」+ 自动识别的 pi-delivery 分支一键登记；managed 项附候选提交行。released 项只读。PATCH 成功后 `onChanged()` + 重拉 git 状态。
- `WorkItemRow.tsx`：phase chip 后加小分支徽标（`item.branches?.[0]?.branch`，截断 + title 全名，仅已设置时显示）。列表行只展示登记的分支名——**合并状态只在详情实时算**（列表 5s 轮询不为每项跑 git）。看板卡片不动。

## 6. 模板与文档

- `lib/workspaces/templates.ts` Git collaboration 段加一行（模板豁免允许干活指令）：分支建好后用 `workspace_update_work_item` 的 `branches` 登记到工作项。
- 文档三层同步：`knowledge/reference/work-items.md`（字段、PATCH 语义、/git 端点、合并状态实时计算不落盘、pi-delivery 自动识别）、`knowledge/reference/file-map.md`（新文件）、AGENTS.md 工作项小节加一条（branches 只存分支名，合并状态永不落盘/不进 events）。

## 7. 测试（npm test，node:test）

- serialize/parse branches round-trip（snake_case、缺省省略、旧数据兼容）。
- updateWorkItem：repositoryId 越界 400、released 冻结 400、changedFields 记录 branches。
- branch-status 纯逻辑单测：for-each-ref 输出解析与 gen 排序、目标分支兜底选择（git 执行函数设计为可注入/解析函数独立导出）。

## 明确不做

- 不自动建分支、不碰远端（branchRules 仍是建议性政策）。
- 列表/看板不显示合并状态。
- 已删分支不按提交回溯（managed 项的 candidate commit 已覆盖该场景）。
