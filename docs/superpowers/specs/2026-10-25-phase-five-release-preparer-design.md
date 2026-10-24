# 第五阶段：release-preparer 角色与发布材料自动起草

日期：2026-10-24

状态：用户站立授权（「继续直到全部做完」，2026-10-24）——流水线收尾角色，方向由前四阶段 spec 的排除清单与 2026-10-22 草案既定（release-preparer 只准备材料，实际发布由人执行并登记）；未实施。

前置：第四阶段已合入（三角色全链：designer→developer→verifier→release_ready）。M2 的 `prepare-release` 动作语义（更新 `delivery.releasePlan {notes?, rollback?}`，不改阶段）与 `record-release`（人登记、冻结基线）已就绪。

范围：加入 **release-preparer 角色**——验证通过后（phase=release_ready）自动领取，基于需求/设计/候选/验证证据起草发布说明与回滚办法，提交写入 `delivery.releasePlan`（M2 prepare-release 语义，actor=agent），项停 release_ready 等**人** record-release。多槽位、依赖图、发布执行自动化不在范围（发布自动化永远排除——实际发布是人的手）。

## 1. 意图与已确认决定

1. release-preparer 扩入既有协议（同池/同锁/同 Dispatcher/同工具族/同恢复机制，第四角色）。
2. **record-release 永远 actor=user**——release-preparer 不登记发布、不触发布执行、不合并推送；其产出只是材料。
3. 提交走 M2 `prepare-release` 语义（actor=agent 变体）：写 `delivery.releasePlan`、phase 保持 release_ready、status→open；人工 prepare-release 路由不动（可覆盖自动材料）。
4. **纯文档角色**：无 worktree/checkout、无新工具（复用 `delivery_submit_result` 第四形状）、无配置键（会话用默认模型；roles 键不扩——designer/developer 双键维持，未来有需要再加）。
5. 单槽位四角色共享；失败预算跨角色共享（同 digest）。

## 2. 池谓词与事务

```
readyFor(role="release-preparer") ⇔ 共享条件 ∧ phase === "release_ready"
  ∧ delivery.verification 存在
  ∧ verification.candidateDigest === candidatesDigest(delivery.candidates ?? [])   // 候选未被换——旧验证下的材料不许准备
```

- `claimReleasePreparerTask`：锁内复验 → 无环境预建（跳过 prepareXxx）→ phase 不变、status in_progress、generation+1、claim.json（role=release-preparer，candidateDigest 快照同 verifier）→ `delivery.claimed` → commit。幂等/互斥同既有。
- `submitReleasePreparerResult(input: {workspacePath, key, attemptId, generation, ownerToken, releaseNotes: string, rollbackNotes?: string, conversationId?})`：三凭据 + candidateDigest 复验（候选被换→409）+ cancel 守卫 → `delivery.releasePlan = {notes: releaseNotes, ...(rollbackNotes ? {rollback: rollbackNotes} : {})}`、phase 保持 release_ready、status→open、revision+1 → `delivery.submitted`（data.outcome="release-plan", data.notes 摘要）→ attempt submitted（携带 releasePlan）→ conversationId 自链接 → commit。
- `failReleasePreparerTask`：标准（blocked 可选；phase 回退守卫：release_ready→release_ready 零变化——中断 give-back 同理）。

## 3. 工具/合同/调度/UI（最小增量）

- `delivery_submit_result` 增第四形状（{key, release_notes, rollback_notes?}——扁平可选字段组，服务端按 grant.role=release-preparer 校验 notes 必填）；工具面**仍恰五件**。
- 合同 `buildRoleContract("release-preparer")`：职责（基于已确认设计、候选提交与验证证据起草发布说明：变更摘要/影响面/验证结论引用/回滚步骤建议）；硬规则（**只读**——不发布、不登记发布、不合并推送（record-release 与实际发布是人做的）；不改代码与 release 块；材料被验证证据支撑，不虚构验证结论；阻塞 fail(blocked)）；结束条件（submit 或 fail）。会话命名 `release-preparer · <KEY>`。
- dispatcher：role 分派已泛化零机制；`DeliveryRole` 增 `"release-preparer"`。
- UI：RoleBadge 泛化显示 role 原文（若现有实现按 key 渲染则零改动——验证即可）；执行卡 attempt 的 releasePlan 展示（notes/rollback 摘要）；详情 releasePlan 块 M2 已渲染（增量：标注来源 actor=agent 与自动时间）。

## 4. 验证与交付顺序

1. 谓词 + 事务（候选被换 409/verification 缺失不可领/幂等/回退零变化/自链接）。
2. submit 第四形状分派 + 合同 + RoleBadge + attempt releasePlan 展示。
3. AGENTS.md（四角色基线）+ 回归。
4. 端到端冒烟（controller）：全流水线 designer→confirm→developer→verifier→**release-preparer 自动起草**→**人 record-release → released**——五角色/双人工门的完整闭环。

## 5. 默认选择

1. 纯文档角色（无执行环境、无配置键、无新工具）——最小阶段。
2. 材料只写 releasePlan；人工 prepare-release 可覆盖。
3. candidateDigest 双重绑定（谓词 + claim 快照 + 提交复验）。
4. notes 必填、rollback 可选（M2 形状）。

实施者自由度：合同文案细节、UI 摘要形态；不可改变：发布是人手、纯只读、四角色单槽位、与既有机制复用。
