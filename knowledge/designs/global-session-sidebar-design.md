# 左栏全局会话列表设计（桌面）

> 状态：已实施（2026-09-15，与用户逐题确认的五项决策）；本文档是实施契约。
> 动机：**a 跨工作区跳转绕**（顶栏 tab 早已跨工作区混排，左栏却在"当前工作区"里打转，视野不一致）
> + **b 左栏随 tab 换血**（切到另一工作区的会话 tab，整个列表跟着变，漂移感）+ **c 两范式并存**
> （首页一个样、工作区内另一个样）+ **轻量约束**。
> 非目标：移动端零改动（工作台会话段保持工作区作用域，首页用自己的 HomeLanding）；排序/置顶规则
> 不动（`groupSessionsByWorkspace` 的活跃度排序天然把最活跃≈当前工作区排最前）。

## 0. 决策记录（grill 共识）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 痛点 | a 跨工作区跳转绕 · b 左栏随 tab 换血 · c 两范式并存 · +轻量约束 |
| 2 | 形态 | **纯全局**：工作台分支的会话区替换为 `HomeSessionGroups`（管道 `groupSessionsByWorkspace` 现成）；首页 tab 与工作台的左栏**合流成同一 body** |
| 3 | 行能力 | **SessionRow 换芯**：抽共享组件（`components/SessionRow.tsx`），HomeSessionGroups 行换成它——全局列表满血（Cmd/中键/hover 新 tab、行内归档、完成未读徽章 + 相对时间）；原首页 grill 的「切换器无管理操作」契约作废 |
| 4 | 上下文 | 首页 tab **保留**（中央无主作曲页职责不变）；头部**零改动**（WorkspaceSwitcher/总览/＋新建会话）；点击统一 **C1**（普通=当前 tab 原地变身；家/首页 tab 上=开新 tab；Cmd/中键=新 tab）——跨工作区无特例 |
| 5 | 范围 | 移动端**零改动**（`showFilesSection` 区分：false=桌面→全局 body；true=移动→现状）；桌面工作台 body 与首页分支**同体**（全局组 + 不可用工作区行 + 导入目录按钮）；随右坞 S1 后立即实施，S2 随后 |

## 1. 实现

- **`components/SessionRow.tsx`**（新）：从 WorkspaceSidebar 抽出的会话行——运行/完成徽章、Cmd/中键/hover「新 tab」、行内归档、可选相对时间（`showTime`，默认关——移动端工作台段不开）。宿主：HomeSessionGroups（全局左栏/首页/移动首页）+ 移动端工作台会话段。
- **`HomeSessionGroups`**：行换 SessionRow（`showTime` 开）；新可选 props `completedSessionIds` / `onOpenSessionInNewTab` / `onSessionRemoved`（桌面传入；移动端 HomeLanding 不传——行为除徽章外不变，触屏无 hover 行内按钮不显现）。
- **`WorkspaceSidebar`**：
  - `renderGlobalSessionsBody()`——全局组 + 不可用工作区 + 导入目录，**工作台（桌面）与首页两个分支同体**；
  - 桌面工作台（`showFilesSection=false`）：会话区 = 全局 body，**不再有「会话」分段头**（组头即结构）；头部照旧（WorkspaceSwitcher + 总览 + ＋新建会话）；
  - 移动端（true）：会话+文件分段照旧，会话段保持**工作区作用域**。
- 左栏内容不再依赖 `activeWorkspace`——tab 随便切、左栏不动（痛点 b 的锚）。

## 2. 边界与已知取舍

- 无归属会话（不在任何工作区下）在左栏不可见——与首页行为一致（现状两个列表本就不显示它们，无回归）。
- 组折叠状态内存态、不持久化（沿用 HomeSessionGroups 现状）；中栏组件常驻挂载，会话内跨 tab 切换折叠自然存活。
- 移动端首页行会多出完成徽章（SessionRow 换芯的副作用）；hover 操作触屏不显现。
