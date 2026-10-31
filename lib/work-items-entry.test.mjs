import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * M2 T10 source assertions（spec §6.1/§6.3）：工作项完整管理页的入口
 * 接线 —— 右坞快捷面板「打开完整管理」、总览入口、中央页「查看会话」的
 * 右坞定位、移动端目的地页宿主 WorkItemsPage。2026-10 弹窗改版：桌面
 * 「打开完整管理」两入口改开 DesktopShell 管理弹窗（openWorkItemsManager），
 * 中央整页保留给 URL 深链与移动端。无 React 测试基建，按仓库惯例做源断言
 * （同 ChatInput.test.mjs 的 readFileSync 模式）。
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const workspaceManager = read("../components/WorkspaceManager.tsx");
const workspaceOverview = read("../components/WorkspaceOverview.tsx");
const desktopShell = read("../components/shell/DesktopShell.tsx");
const mobileShell = read("../components/shell/MobileShell.tsx");
const mobileTabShell = read("../components/shell/MobileTabShell.tsx");
const workspaceModules = read("../components/shell/workspace-modules.tsx");
const shellState = read("../components/shell/useAppShellState.ts");

test("WorkspaceManager declares the full-page entry prop and renders it in panel mode", () => {
  // prop 面：宿主（右坞快捷面板）传入 openWorkItemsPage。
  assert.match(workspaceManager, /onOpenWorkItemsPage\?: \(workspaceId: string, itemKey\?: string\) => void/, "WorkspaceManager 必须声明可选 onOpenWorkItemsPage prop");
  // 解构进组件。
  assert.match(workspaceManager, /onOpenWorkItemsPage,/, "onOpenWorkItemsPage 必须被解构使用");
  // 面板内按钮（panel 模式）：按钮 onClick 调 onOpenWorkItemsPage(selectedWorkspace.id)，
  // 按钮文案「打开完整管理」。（不锚 indexOf——注释里也会出现该词。）
  assert.match(
    workspaceManager,
    /panel && onOpenWorkItemsPage && \(\s*<button[\s\S]{0,500}?onClick=\{\(\) => onOpenWorkItemsPage\(selectedWorkspace\.id\)\}[\s\S]{0,400}?打开完整管理/,
    "panel 形态的入口按钮须调 onOpenWorkItemsPage(selectedWorkspace.id) 且文案为「打开完整管理」",
  );
});

test("WorkspaceManager consumes the shared work-items store (spec §6.3 同一数据缓存)", () => {
  assert.match(workspaceManager, /from "@\/hooks\/useWorkItems"/, "WorkspaceManager 列表数据改走共享 useWorkItems");
  assert.match(workspaceManager, /invalidateWorkItems\(\)/, "mutation 成功后走 invalidate()（与中央页同一缓存失效路径）");
  assert.doesNotMatch(workspaceManager, /const loadWorkItems = useCallback/, "本地 loadWorkItems 拉取应被共享 store 取代");
  // fix round 1 Critical：invalidate() 先 clearSnapshot → 订阅者同步收到 null →
  // 合并池变 []。清理 effect 必须对 null 快照短路，否则刚 set 的
  // selectedWorkItem 在强制重取落地前被清空（每次 mutation 后详情都被关）。
  const cleanupIndex = workspaceManager.indexOf("快照更新时清理已消失的选中项");
  assert.ok(cleanupIndex > 0, "存在选中项清理 effect");
  const cleanupBody = workspaceManager.slice(cleanupIndex, workspaceManager.indexOf("const loadRepositories"));
  assert.match(cleanupBody, /if \(!workItemsSnapshot\) return;/, "清理 effect 必须对 null 快照短路（invalidate 的 clearSnapshot 窗口）");
});

test("createRequest nonce is one-shot (fix round 1 Important)：consume-and-clear", () => {
  const workItemsPage = read("../components/work-items/WorkItemsPage.tsx");
  // 页面消费 nonce（打开创建表单）后回调宿主清空——同 onConsumedInitialItem 模式。
  assert.match(workItemsPage, /onConsumedCreateRequest\?: \(\) => void/, "WorkItemsPage 声明 onConsumedCreateRequest prop");
  const consumeIndex = workItemsPage.indexOf("openCreateForm(createRequest.type)");
  assert.ok(consumeIndex > 0, "createRequest effect 打开创建表单");
  const consumeBody = workItemsPage.slice(Math.max(0, consumeIndex - 400), consumeIndex + 300);
  assert.match(consumeBody, /onConsumedCreateRequest\?\.\(\)/, "消费后调用 onConsumedCreateRequest（nonce 一次性）");
  // 移动端宿主传清空回调：否则 ‹聊天 卸载重挂载时残留 nonce 会自启表单。
  const mobileCase = mobileShell.slice(mobileShell.indexOf("case \"work-items\""));
  assert.match(mobileCase.slice(0, mobileCase.indexOf("case \"knowledge\"")), /onConsumedCreateRequest=\{\(\) => setCreateWorkItemRequest\(null\)\}/, "MobileShell work-items 页传 createRequest 清空回调");
});

test("WorkspaceOverview has the full-management entry next to the work-items section", () => {
  assert.match(workspaceOverview, /onOpenWorkItemsPage\?: \(\) => void/, "WorkspaceOverview 声明可选 onOpenWorkItemsPage prop");
  // 入口按钮：onClick 走 onOpenWorkItemsPage，文案「完整管理」（2026-10
  // 总览卡片化改版后的短文案；title 提示完整管理弹窗与卡片拖拽能力）。
  assert.match(
    workspaceOverview,
    /onClick=\{onOpenWorkItemsPage\}[\s\S]{0,600}?完整管理/,
    "「完整管理」入口按钮点击走 onOpenWorkItemsPage",
  );
  // 既有行为保留：行点击仍走 onOpenWorkItems（打开右坞快捷面板）。
  assert.match(workspaceOverview, /onClick=\{onOpenWorkItems\}/, "工作项行点击仍走 onOpenWorkItems（右坞）");
});

test("DesktopShell wires overview + quick-panel entries to the manager modal, keeps center-page close loop", () => {
  // 总览入口 → openWorkItemsManager（2026-10 弹窗改版：不再开中央整页）。总览
  // 本体 2026-10 整页化后宿于 renderCenterPage 的 overview 分支，workspace 来自
  // 页面自己的 workspaceId（不再是 activeTab.workspace）。
  assert.match(desktopShell, /onOpenWorkItemsPage=\{\(\) => openWorkItemsManager\(workspace\.id\)\}/, "总览「完整管理」→ openWorkItemsManager 弹窗");
  // 右坞快捷面板（WorkspaceManager panel 模式）同接弹窗入口。
  assert.match(desktopShell, /onOpenWorkItemsPage=\{openWorkItemsManager\}/, "右坞快捷面板 WorkspaceManager 传入 openWorkItemsManager");
  // 弹窗宿主：遮罩 + WorkItemsPage（不写 URL——onReplaceUrl 不传），「查看
  // 会话」= 关弹窗 + 开聊天 tab + 右坞定位该工作区快捷面板。
  assert.match(desktopShell, /const \[workItemsManager, setWorkItemsManager\] = useState/, "DesktopShell 持有 workItemsManager 弹窗态");
  const modalAnchor = desktopShell.indexOf('aria-label="工作项管理"');
  assert.ok(modalAnchor > 0, "DesktopShell 渲染工作项管理弹窗");
  // 切到弹窗内 WorkItemsPage 的自闭合（第一个 "/>"）——覆盖全部宿主 props。
  const modalHost = desktopShell.slice(modalAnchor, desktopShell.indexOf("/>", modalAnchor));
  assert.match(modalHost, /setWorkItemsManager\(null\);\s*handleOpenConversation\(sessionId\);/, "弹窗 onOpenConversation = 关弹窗 + 打开会话");
  assert.match(modalHost, /openDockModule\(workItemsManager\.workspaceId, WORK_ITEMS_TAB_ID\)/, "弹窗 onOpenConversation 同时 openDockModule 定位右坞快捷面板");
  assert.doesNotMatch(modalHost, /onReplaceUrl/, "弹窗宿主不传 onReplaceUrl（不写 URL）");
  // 中央页 WorkItemsPage.onOpenConversation：开聊天 tab + openDockModule 定位右坞工作项模块。
  const pageBranch = desktopShell.slice(desktopShell.indexOf("<WorkItemsPage"), desktopShell.indexOf("onOpenWorkItemsPage={openWorkItemsPage}"));
  assert.ok(pageBranch.length > 0, "DesktopShell 渲染 WorkItemsPage");
  assert.match(pageBranch, /handleOpenConversation\(sessionId\)/, "onOpenConversation 复用 locate 打开会话 handler");
  assert.match(pageBranch, /openDockModule\(page\.workspaceId, WORK_ITEMS_TAB_ID\)/, "onOpenConversation 同时 openDockModule 定位右侧快捷面板");
});

test("MobileShell work-items destination page hosts WorkItemsPage", () => {
  assert.match(mobileShell, /from "..\/work-items\/WorkItemsPage"/, "MobileShell 导入 WorkItemsPage");
  const caseIndex = mobileShell.indexOf('case "work-items"');
  assert.ok(caseIndex > 0, "MobileShell 有 work-items 目的地页 case");
  const caseBody = mobileShell.slice(caseIndex, mobileShell.indexOf("case ", caseIndex + 10));
  assert.match(caseBody, /<WorkItemsPage/, "work-items case 渲染 WorkItemsPage");
  assert.doesNotMatch(caseBody, /<WorkspaceManager/, "不再宿主 WorkspaceManager panel 模式");
  // 移动端语义：‹返回 回聊天、onOpenConversation 关目的地页、Loops 恢复去 loops 页。
  assert.match(caseBody, /onBack=\{\(\) => setMobilePage\(null\)\}/, "‹返回 = 回聊天");
  assert.match(caseBody, /setMobilePage\(null\);\s*handleOpenConversation\(sessionId\)/, "onOpenConversation = 关目的地页 + 打开会话");
  assert.match(caseBody, /onOpenLoopsRecovery=\{\(\) => setMobilePage\("loops"\)\}/, "onOpenLoopsRecovery → loops 目的地页");
  // capability 门控保留：模块入口出自 workspaceModuleEntries 注册表（2026-10-26
  // 导航统一——图标/门控唯一出处，手机两处 ⋯ 菜单与平板模块条同一份）。
  assert.match(mobileShell, /workspaceModuleEntries\(activeWorkspace, \{ overview: true \}\)/, "平板模块条出自注册表");
  assert.match(workspaceModules, /capabilities\.includes\("work-items"\)/, "注册表按 capability 门控");
});

test("MobileShell maps a work-items centerPage (deep link) onto the destination page (fix wave Finding 1)", () => {
  // applyUrlToTabs 对 ?page=work-items 写 centerPage {kind:"work-items"}（两壳
  // 共用）；移动端没有中央区整页——不映射的话手机深链落在聊天、URL 与界面
  // 不一致，且滞留的 centerPage 压住空态自动落 composer。
  // ① presence→destination 映射 + deeplink-auto 标记（absence 只收回自己设的页）。
  assert.match(mobileShell, /const workItemsDeeplinkActive = centerPage\?\.kind === "work-items";/, "MobileShell 派生 work-items 深链激活态");
  assert.match(mobileShell, /workItemsDeeplinkAutoRef/, "深链自动设置标记：centerPage 离开该 kind 时只收回自动设的目的地页");
  // ② 深链形态渲染：页面身份绑定 centerPage.workspaceId（spec §6.1，深链可指向
  //    非当前 tab 的工作区），item 深链经 initialItemKey 透传。
  const caseIndex = mobileShell.indexOf('case "work-items"');
  assert.ok(caseIndex > 0, "MobileShell 有 work-items 目的地页 case");
  const caseBody = mobileShell.slice(caseIndex, mobileShell.indexOf("case ", caseIndex + 10));
  assert.match(caseBody, /centerPage\?\.kind === "work-items"/, "work-items case 有深链形态分支");
  assert.match(caseBody, /workspaceId=\{centerPage\.workspaceId\}/, "深链形态绑定 centerPage.workspaceId（不用 activeWorkspace）");
  assert.match(caseBody, /initialItemKey=\{workItemsItemKeyRef\.current\}/, "深链 item 参数经 initialItemKey 透传");
  assert.match(caseBody, /onConsumedInitialItem=\{\(\) => \{ workItemsItemKeyRef\.current = null; \}\}/, "消费后清 workItemsItemKeyRef");
  // ③ ‹返回/✕ = 清 centerPage + URL 回写（与桌面 closeCenterPage 同构——URL 说
  //    page=work-items，关页必须让 URL 与状态一致，否则刷新复活）。
  assert.match(mobileShell, /const closeWorkItemsDeeplink = useCallback/, "MobileShell 有关闭深链页的 callback（清 centerPage + URL 回写）");
  assert.match(caseBody, /onBack=\{closeWorkItemsDeeplink\}/, "深链形态 ‹返回 = 关深链页");
  assert.match(mobileShell, /navigateUrl\(activeTab \? tabQuery\(activeTab\) : "tab=home"\)/, "关页 URL 回写活动 tab 投影（无活动 tab → 首页）");
  // ④ 冷启动深链可能无活动 tab（activeWorkspace 为空）——空态分支也要能渲染
  //    深链目的地页（空态自动落 composer 被 centerPage 抑制，不能再只剩占位）。
  assert.match(mobileShell, /mobilePage === "work-items" && centerPage\?\.kind === "work-items"/, "无活动工作区分支也渲染深链目的地页");
});

test("MobileTabShell (phone, 2026-10 底部 tab 改版) hosts the native work-items pages with the same deep-link contract", () => {
  // 手机壳没有 mobilePage 目的地机，工作项是推入栈里的手机原生页组（2026-10
  // MobileWorkItemsPages：列表 + 推入 详情/新建 子页，页头走 MobileNavBar——
  // 同轮导航统一原语）。深链来源记 deeplink:true，同一套 capability 门控与深链
  // 收口规则。
  assert.match(mobileTabShell, /from "\.\/MobileWorkItemsPages"/, "MobileTabShell 导入手机原生工作项页组");
  // 推入页 switch 住在 renderPushedPage 里（锚定到 renderPushedPage 之后再找，
  // 避免命中文件里其它同名 case——如 skill/detail 分支之前的 kind 判别）。
  const switchStart = mobileTabShell.indexOf("const renderPushedPage");
  assert.ok(switchStart > 0, "MobileTabShell 有 renderPushedPage");
  const caseIndex = mobileTabShell.indexOf('case "work-items"', switchStart);
  assert.ok(caseIndex > switchStart, "MobileTabShell 推入页 switch 有 work-items case");
  const caseBody = mobileTabShell.slice(caseIndex, mobileTabShell.indexOf("case ", caseIndex + 10));
  assert.match(caseBody, /<MobileWorkItemsPage/, "work-items case 渲染手机原生列表页");
  assert.doesNotMatch(caseBody, /<WorkspaceManager/, "不宿主 WorkspaceManager panel 模式");
  // 深链形态：‹返回 = 关深链页；自驱 = 弹一层；页面身份绑定 centerPage.workspaceId
  //（不用 activeWorkspace 代替）。
  assert.match(caseBody, /onBack=\{deeplink \? closeWorkItemsDeeplink : pop\}/, "深链 ‹ = 关深链页，自驱 ‹ = 弹一层");
  assert.match(caseBody, /resolveWorkspace\(centerPage\.workspaceId\)/, "深链形态绑定 centerPage.workspaceId");
  // 深链契约（与平板同构）：presence→push 映射 + deeplink-auto 标记 + URL 回写。
  assert.match(mobileTabShell, /const workItemsDeeplinkActive = centerPage\?\.kind === "work-items";/, "派生 work-items 深链激活态");
  assert.match(mobileTabShell, /workItemsDeeplinkAutoRef/, "深链自动标记：离开该 kind 只收回自己推的页");
  assert.match(mobileTabShell, /\{ kind: "work-items", workspaceId: deeplinkWorkspaceId, deeplink: true \}/, "深链推入页绑定 centerPage.workspaceId 并记来源");
  assert.match(mobileTabShell, /const closeWorkItemsDeeplink = useCallback/, "有关闭深链页的 callback");
  assert.match(mobileTabShell, /navigateUrl\(activeTab \? tabQuery\(activeTab\) : "tab=home"\)/, "关页 URL 回写活动 tab 投影");
  // 详情 / 新建子页：列表页之上再推一层（‹ 回列表）；返回键关深链详情 = URL 去 &item=
  // （刷新不复活详情）；Loops 恢复 = 栈顶换页（不多占一层返回）。
  assert.match(mobileTabShell, /case "work-item-detail":/, "有详情子页 case");
  assert.match(mobileTabShell, /case "work-item-create":/, "有新建子页 case");
  assert.match(mobileTabShell, /buildWorkItemsPageUrl\(popped\.workspaceId\), true\)/, "返回键关深链详情 = URL 去 &item=");
  // 用户自驱进入工作项页 = 深链自动态让位（ensureWorkspaceContext 会清 centerPage）。
  assert.match(mobileTabShell, /if \(kind === "work-items"\) workItemsDeeplinkAutoRef\.current = false;/, "自驱进入摘深链标记");
  // capability 门控：⋯ 菜单与工作区页 ⋯ 都出自 workspaceModuleEntries 注册表，
  // 门控（work-items / knowledge capability）在注册表里统一做（2026-10-26 导航统一）。
  assert.match(mobileTabShell, /workspaceModuleEntries\(workspace, \{ settings: true \}\)/, "聊天页 ⋯ 工作区组出自注册表");
  assert.match(workspaceModules, /capabilities\.includes\("work-items"\)/, "注册表按 capability 门控");
});

test("useAppShellState exposes openWorkItemsPage through the shell context surface (T8 verified)", () => {
  // openWorkItemsPage 已在 hook 返回值里（context 类型 = ReturnType<typeof
  // useAppShellState>，返回值即 context 面）—— T8 落地、T10 验证。
  const returnIndex = shellState.indexOf("openWorkItemsPage,", shellState.indexOf("return {"));
  assert.ok(returnIndex > 0, "openWorkItemsPage 必须出现在 useAppShellState 的返回对象里");
  assert.match(shellState, /const openWorkItemsPage = useCallback/, "openWorkItemsPage 是稳定 callback");
});
