# 总览整页化：工作区家 tab 除名（2026-10）

> 状态：已实施（2026-10-26）。本文是 `knowledge/designs/session-tabs-design.md` 的后续修订——那份文档里的 `workspace-home` kind、`ensureHomeTab`、morph 分派、P1「⊞ → 家 tab」自此退役；其余决策（1a 纯会话 tab / C1 / X1 / R2 / U1）不变。
> 动机（用户反馈链，同一天三轮）：工具行独立「总览」按钮奇怪 → 家 tab 与它语义重复 → 「这一层 tab 是不是多余了」。根因：总览是工作区级概念，却被实现成会话 tab 条里唯一的非会话 tab——可被 ✕ 关掉、新建会话时原地变身消失，于是又需要「回头路」按钮补洞。
> 非目标：两层 tab（工作区 tab + 会话 tab）——用户跨工作区切换频繁，两层方案把一次点击变两次，正好落在高频路径上，否决。

## 0. 决策记录

| # | 主题 | 决策 |
|---|---|---|
| D1 | 载体 | **总览 = `CenterPage` 新 kind `{ kind: "overview"; workspaceId }`**，身份显式绑定 workspaceId（与 work-items 页同款），不跟随 activeWorkspace。`SessionTabKind` 收敛为 `"session" \| "new-session"`，tab 条回归纯「打开的会话」 |
| D2 | chrome / 单栏 | **工作区上下文下只有一条横栏**：原 32px 独立工具行「🏠 工作区名 ⌄」整行删除，其内容以 `SessionTabBar` 的 `leading` 槽嵌到 tab 条最左（固定、不随 tab 横滚）；chip 旁的 ⌄ 切换面板随后也删（D14）。总览**不遮 chrome**：tab 条与右坞保持可见——总览态 = chip 按活动 tab 样式高亮（accent 顶线 + `aria-current="page"`）、会话 tab 全不高亮；会话态 = 某个 tab 高亮、chip 常态。理由：总览 = 事实首页（桌面首页已退役，空态自动落总览）+ 模块枢纽（四张卡片是右坞模块入口，遮掉右坞卡片就没有落点）。实现：tab 条门控 `!chromeHidden && (activeWorkspace !== null \|\| tabs.length > 0)`（纯首页不渲染空条）；右坞门控 `!chromeHidden`（`chromeHidden = centerPage != null && centerPage.kind !== "overview"`）；＋ 按钮由宿主按「有工作区上下文」传入。**演进**：初版让总览保留 tab 条但保留独立工具行 → 用户反馈「tab 还都存在」→ 二版总览隐藏 tab 条 → 用户反馈「打开会话就出现两个栏」→ 终版合并为单栏。真正的病根是两条栏叠着，不是 tab 在总览态可见 |
| D3 | 选中态 | **打开总览 = 「无会话 tab 选中」态**：`activeTabId = null` + `centerPage = overview` + MRU 推工作区 + URL `workspace=<id>&view=overview`。tab 条最左的工作区 chip「🏠 工作区名」高亮 = 你在这里（D2）。与配置页「盖在聊天之上、保留 activeTabId、返回即回原会话」不同——总览是导航目的地，不是覆盖层 |
| D4 | 上下文 | **`activeWorkspace = overviewWorkspace ?? activeTab?.workspace`**。家 tab 原本隐含的第二职责「当前工作区上下文载体」由此接管；`activeCwd` 同步跟随。新组合「activeTab = null 且 activeWorkspace ≠ null」首次出现——消费方已逐一核过：`openSessionTab` owner 回退、`handleWorkspaceNewSession`、右坞 `panelWorkspace`、`settingsCwd`、`windowTitle` 均只读 activeWorkspace，行为正确；`showPlaceholder` 被 `centerPage` 渲染分支优先遮蔽 |
| D5 | URL | 语法不变。`workspace=<id>` / `…&view=overview` → centerPage overview（`applyUrlToTabs` 在 work-items 分支之后、tab 投影之前识别，并 `setActiveTabId(null)`）。popstate 离开总览 URL → 既有 `setCenterPage(null)` 分支接管。移动端深链同款 URL 由 MobileShell 映射（D11） |
| D6 | R2 恢复 | `parseStoredTabs` 不再接受 `workspace-home` 条目（静默剔除、计入 skipped）；旧存储的 `activeTabId = "ws:*"` 查不到 → null → 空态效果接管（D7）。**无需 v2 迁移** |
| D7 | 事实首页 | 桌面空态自动落回 effect 不变——`handleOpenWorkspace(target, { replace: true })` 现在打开总览整页。`desktopCloseTab` 关最后一个 tab → 同样落总览。**总览无 ✕**：它是首页，退出 = 点任何会话 / 新建会话（activateTab 清 centerPage） |
| D8 | morph 退役 | `resolveNewSessionTarget` 删除；`handleWorkspaceNewSession` 永远走 `openNewSessionTab`（空占位去重复用照旧）。「详情页新建会话不膨胀 tab 条」的原诉求由 **总览不再占 tab 位** 直接满足——净 tab 数与今天 morph 后一致（今天 家 tab→占位；现在 无→占位） |
| D9 | C1 分派 | `resolveOpenSessionTarget` 删去 home 分支 → `"morph" \| "from-home"`。总览打开时 activeTab 为 null，`handleSelectSession` 的既有 `!activeTabId → handleOpenSessionFromHome → openSessionTab` 路径即「开新 tab」——与今天家 tab 的 new-tab 语义汇合，**无需改分派代码** |
| D10 | 删工作区 | `handleWorkspaceDeleted`：若 centerPage 是该工作区的 overview → `setCenterPage(null)`（随后空态 effect 落 MRU 工作区总览） |
| D11 | 移动端 | presence→destination 映射，与 work-items 深链同构：`centerPage.kind === "overview"` ⇒ `ensureWorkspaceContext(ws)` + `setMobilePage("overview")`（ensureWorkspaceContext 的 activateTab 自动清 centerPage，不会卡住空态 effect）。MobileShell 本就不引用家 tab 概念，其它零改动 |
| D12 | tab 条 | `SessionTabBar` 删 workspace-home 标签/title/工作区级活动徽章分支；`workspaceActivity` prop 随之删除（唯一消费者是家 tab 徽章；工具行与切换面板各自仍显示该徽章） |
| D13 | 宿主 | `renderCenterPage` 新增 overview 分支直挂 `WorkspaceOverview`（props 与原 tab 分支一致，`key = workspaceId`）；workspaceId 解析不到可用工作区 → `setCenterPage(null)` 兜底 → 空态 effect 接管 |
| D14 | ⌄ 下拉 | **桌面工作区切换面板入口删除**（用户追问「为什么要一个下拉」）。它是 2026-09-27 侧栏砍掉工作区树时的权宜入口；此后侧栏「项目」分区长回了 头像→总览（= 切换）/ 长按拖拽排序 / ＋新建·导入，面板内容在桌面上全部重复。独有的两件事都有替代：停用/不可用工作区的暗淡行 → 设置›工作区（侧栏底部常驻，全量列表可重启用）；侧栏收起时的切换 → 展开侧栏或 ⌘K。chip 退化为「🏠 工作区名」单按钮单动作（回总览），`DesktopShell` 删 `switcherOpen` 与弹出面板。`WorkspaceSwitcherPanel` 组件自此**无宿主**（移动端切换器 2026-09-27 已撤），仅 `SwitcherModuleEntry` 类型被 MobileShell 引用——待手机壳改版（MobileTabShell）落地后整体清理 |

## 1. 删除清单

- `lib/session-tabs.ts`：`"workspace-home"` kind、`homeTabId`、`createHomeTab`、`resolveNewSessionTarget`、`tabQuery`/`serializeTabs`/`parseStoredTabs`/`restoreTabs` 的 home 分支。
- `useAppShellState.ts`：`ensureHomeTab`、`handleWorkspaceNewSession` 的 morph 分支、`applyUrlToTabs` 末尾「家 tab 落地」、`hubView` 残留注释。
- `DesktopShell.tsx`：`activeTab?.kind === "workspace-home"` 渲染分支（搬入 renderCenterPage）、工具行按 `workspace-home` 判选中态（改为按 centerPage overview）。
- `SessionTabBar.tsx`：三处 `workspace-home` 分支 + `workspaceActivity` prop。

## 2. 验证

`tsc --noEmit` / `npm run lint` / `npm test`（`lib/session-tabs.test.mjs`、`components/WorkspaceNavigation.test.mjs` 更新）。手测：冷启动落总览 → 点侧栏会话开 tab（tab 条出现高亮）→ 点 tab 条最左「🏠 工作区名」回总览（chip 高亮、会话 tab 全不高亮、右坞仍在、始终只有一条横栏）→ 总览点「新建会话」开占位 tab → 关光 tab 落回总览 → 切换面板选另一工作区落其总览 → 刷新保持 → 浏览器后退回会话 → 手机 `?view=overview` 深链落总览目的地页。
