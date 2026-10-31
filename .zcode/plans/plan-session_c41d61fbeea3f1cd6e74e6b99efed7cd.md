# 移动端底部 Tab 改版实现计划

UI 规格 = 已确认的可视化稿 v3(`~/.zcode/v2/visualizations/750bbb…/pi-mobile-tabs.html`):底部 3 tab(会话/Skill/设置),首页按工作区分组×3 条预览,组头→工作区页,会话行→聊天页,顶栏 ⋯ 作用于最近活跃工作区,推入页一律隐藏 tab 栏,≥768px 平板不动。

## 架构决策

**关键事实**:抽屉本来就只在 <768px 存在(`drawerOpen = mobileNavOpen && !showPermanentTree`,MobileShell.tsx:178),≥768px 从未渲染。删抽屉对平板零影响。因此:

- **新增 `components/shell/MobileTabShell.tsx`**(~800 行):承载 <768px 全部形态(tab 栏、会话首页、工作区页、聊天层、推入页、⋯ 菜单、零工作区分支)。经 `useShell()` 取共享状态,复用现有页面体组件(ChatWindow/FilesExplorerPanel/WorkItemsPage/KnowledgeBrowser/LoopsDockPanel/ArchiveModal/SettingsPanel/SkillsConfig/WorkspaceSessionList/SessionRow/HomeLanding/SearchPalette)。
- **`MobileShell.tsx` 变为平板壳**(≥768px 树常驻,行为不变):删除抽屉 JSX(:868-893)、Android 返回陷阱(:199-210)、边缘右滑(:217-249)、窄屏分支;在全部 hooks 之后 `if (!wide) return <MobileTabShell/>`(narrow 下无害的 wide 效果照跑,加注释)。`mobilePage` 目的地机、`mobileSwitcherSlot`、`renderPageContent`、renderChat、文件 overlay 全部保留(平板仍在用,相关测试断言保持为真)。
- **状态机(MobileTabShell 局部)**:`pushStack: {kind, workspace?}[]`,kind ∈ `chat|workspace|files|work-items|knowledge|loops|archive|ws-settings`;最多两层(home→workspace→chat);tab 切换清空;‹ 弹栈。tab 栏可见条件 = 栈空 且 `settingsPage==="index"`。
- **`mobileTab`("sessions"|"skills"|"settings")提升到 `useAppShellState`**(仿原 mobileNavOpen 的位置,桌面闲置)——跨 768 断点往返不丢 tab;pushStack 丢失可接受(会话/tab 状态在共享层,聊天重挂载自动重连 SSE,与 640↔桌面跨断点现有行为一致)。
- **既有原语复用**:会话/新建落聊天 = `focusChat`→chatFocusKey effect 改为**推入 chat 页**(替换原「关目的地页」语义);工作区页/⋯ 模块 = `ensureWorkspaceContext`(不惊动聊天);最近活跃工作区 = `defaultHomeNewSessionWorkspaceId`;分组 = `groupSessionsByWorkspace`(默认 activity 序,`slice(0,3)`);行状态 = `sessionActivity.runningIds/completedIds` + `SessionRow activity`;FAB = `openNewSessionTab(默认工作区)`(composer 内 WorkspaceSelector 可换)。
- **Android 返回**:把抽屉陷阱模式(:199-210)移植为推入页陷阱(`piMobilePushPage` 标记,popstate 弹栈),与 useAppShellState 的 popstate 共存(同旧抽屉)。
- **深链**:`?page=work-items` 在 tab 壳内映射为推入 work-items 页(centerPage.workspaceId 定工作区),返回时 `setCenterPage(null)+navigateUrl(tabQuery)` 同构 :161-164。其余 tab/推入页**不进 URL**(与旧 mobilePage 一致)。
- 停用工作区:`groupSessionsByWorkspace` 会滤掉它们 → 首页对不可选工作区补渲灰色组头(无行,带 ⚙);空可选组保留(组头是进工作区页唯一路径)。
- 沿用现有惯例:UI 文案硬编码中文(测试即钉中文串)。

## 文件变更

**新增** `components/shell/MobileTabShell.tsx`:tab 栏(safe-area bottom padding)、首页(分组+搜索按钮唤起 SearchPalette+⋯ 菜单+FAB)、工作区页(‹+名+⚙ / 模块 chips 能力门控 / WorkspaceSessionList / 归档行)、聊天层(单 ChatWindow 持久挂载,推入时可见)、推入页宿主、零工作区分支(sessions tab 出 HomeLanding,settings tab 天然可达=逃生口)、work-items 深链、返回陷阱。

**修改**:
- `MobileShell.tsx`:上述瘦身 + 文档注释重写(新导航模型)。
- `useAppShellState.ts`:+`mobileTab/setMobileTab`;删 `mobileNavOpen`(连同 :292-294)。
- `ChatToolbar.tsx`:删 `navToggle="drawer"` 变体、☰ 按钮(:142-182)与背景圆点(:115-138);新增可选 `onBack`(mobile 下以 ‹ 替换 ☰ 位)。
- `SettingsPanel.tsx`:索引删 工作区/Skills/归档 三行(子页体保留:工作区设置经 requestWorkspaceSettings 推入仍用 workspace 子页;Skills 改由 tab 宿主)。
- `app/globals.css`:删 `.mobile-nav-scrim/.mobile-nav-drawer/@keyframes`(:272-292);新增 `.mobile-tabbar`;更新 :269-270、:699-700、:1409-1410 三处过时注释(高度继续走 `--app-vh` 链,遵守 AGENTS.md 硬规则)。
- `AppShell.tsx`:修正 :20-23 过时注释。`hooks/useMediaQuery.ts` 过时注释一并修。

**删除**:抽屉三段代码、drawer CSS、`mobileNavOpen` 全链(含 ChatToolbar 引用)。

## 测试更新(node:test 源断言,无 jsdom/e2e)

- `WorkspaceNavigation.test.mjs`:头部按惯例**前置 2026-10 决策反转段**;改写 `drawer-only navigation` 块 → `bottom tab navigation`:断言 MobileShell 委托 `<MobileTabShell/>`、MobileTabShell 含三 tab/推入模型/⋯ 作用域标注、两壳与 CSS 均无 drawer 残留;保留 wide 断言(showPermanentTree/MobilePage/headerSlot 等,均仍为真);更新 settings 行删除断言(L418-421)与 disabled-workspace 逃生口断言(L452-453 → tab 壳的 settings tab)。
- `lib/work-items-entry.test.mjs`:MobileShell 侧断言保持(wide 仍在);**新增 MobileTabShell 同构断言**(深链映射、capability 门控、`ensureWorkspaceContext`)。
- `components/MobilePwaLayout.test.mjs`:仅修过时头注释。

## 文档更新(三层同步规则)

`docs/mobile-drawer-design.md` 文末追加第三条补充记录(2026-10-26,决策/实现两段,更新「最新」标记与 L4 指针);`docs/reference/ui-shell.md` 重写移动端节(L40-49/59/61/65/73-74);`docs/architecture.md:35`;`docs/reference/file-map.md` 相关条目(含新文件)。

## 实施顺序(每步树保持绿)

1. MobileTabShell 脚手架:tab 栏 + 只读首页分组列表 + MobileShell 委托(`!wide`)。
2. 聊天推入:ChatToolbar `onBack` + chatFocusKey→推 chat + FAB。
3. 工作区页 + ⋯ 菜单 + ws-settings 推入(ensureWorkspaceContext/requestWorkspaceSettings)。
4. Skills/Settings tab + SettingsPanel 行裁剪 + SkillsConfig 宿主。
5. work-items 深链 + 返回陷阱 + 文件 overlay 复用 + safe-area。
6. 删抽屉全链(MobileShell 三段/CSS/mobileNavOpen/ChatToolbar ☰)。
7. 测试更新 → 8. 文档更新。

## 验证

`node_modules/.bin/tsc --noEmit`、`npm run lint`、`npm test` 全绿;`npm run dev` 手机视口(<640)人工核对清单:三 tab 切换、组头/行/FAB 路由、聊天页无 tab 栏且 ‹ 回列表、⋯ 能力门控、设置子页隐藏 tab 栏、Android 返回键弹栈、640-767 带、≥768 平板回归(树常驻、模块条、目的地页)、键盘弹出聊天输入、深色主题、安全区(PWA standalone)。

## 明确不做(本轮)

≥768px 平板形态改动、tab/推入页 URL 化、skills 写操作之外的新能力、会话页 ⋯ 菜单内容变更、新建会话在无 FAB 页面的补充入口(记为后续 polish)。