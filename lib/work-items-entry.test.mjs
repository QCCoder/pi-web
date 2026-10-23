import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * M2 T10 source assertions（spec §6.1/§6.3）：工作项完整管理页的四个入口
 * 接线 —— 右坞快捷面板「打开完整管理」、总览入口、中央页「查看会话」的
 * 右坞定位、移动端目的地页宿主 WorkItemsPage。无 React 测试基建，按仓库
 * 惯例做源断言（同 ChatInput.test.mjs 的 readFileSync 模式）。
 */

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

const workspaceManager = read("../components/WorkspaceManager.tsx");
const workspaceOverview = read("../components/WorkspaceOverview.tsx");
const desktopShell = read("../components/shell/DesktopShell.tsx");
const mobileShell = read("../components/shell/MobileShell.tsx");
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
});

test("WorkspaceOverview has the full-management entry next to the work-items section", () => {
  assert.match(workspaceOverview, /onOpenWorkItemsPage\?: \(\) => void/, "WorkspaceOverview 声明可选 onOpenWorkItemsPage prop");
  // 入口按钮：onClick 走 onOpenWorkItemsPage，文案「打开完整管理」（同上，
  // 不锚 indexOf——prop 注释里也出现该词）。
  assert.match(
    workspaceOverview,
    /onClick=\{onOpenWorkItemsPage\}[\s\S]{0,500}?打开完整管理/,
    "「打开完整管理」入口按钮点击走 onOpenWorkItemsPage",
  );
  // 既有行为保留：行点击仍走 onOpenWorkItems（打开右坞快捷面板）。
  assert.match(workspaceOverview, /onClick=\{onOpenWorkItems\}/, "工作项行点击仍走 onOpenWorkItems（右坞）");
});

test("DesktopShell wires overview entry + center-page conversation close loop with dock locate", () => {
  // 总览入口 → openWorkItemsPage。
  assert.match(desktopShell, /onOpenWorkItemsPage=\{\(\) => openWorkItemsPage\(activeTab\.workspace\.id\)\}/, "总览「打开完整管理」→ openWorkItemsPage");
  // 中央页 WorkItemsPage.onOpenConversation：开聊天 tab + openDockModule 定位右坞工作项模块。
  const pageBranch = desktopShell.slice(desktopShell.indexOf("<WorkItemsPage"), desktopShell.indexOf("onOpenWorkItemsPage={openWorkItemsPage}"));
  assert.ok(pageBranch.length > 0, "DesktopShell 渲染 WorkItemsPage");
  assert.match(pageBranch, /handleOpenConversation\(sessionId\)/, "onOpenConversation 复用 locate 打开会话 handler");
  assert.match(pageBranch, /openDockModule\(page\.workspaceId, WORK_ITEMS_TAB_ID\)/, "onOpenConversation 同时 openDockModule 定位右侧快捷面板");
  // 右坞快捷面板（WorkspaceManager panel 模式）拿到 openWorkItemsPage。
  assert.match(desktopShell, /onOpenWorkItemsPage=\{openWorkItemsPage\}/, "右坞快捷面板 WorkspaceManager 传入 openWorkItemsPage");
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
  // capability 门控保留：模块入口仍按 work-items capability 过滤。
  assert.match(mobileShell, /capabilities\.includes\("work-items"\)/, "模块入口保留 capability 门控");
});

test("useAppShellState exposes openWorkItemsPage through the shell context surface (T8 verified)", () => {
  // openWorkItemsPage 已在 hook 返回值里（context 类型 = ReturnType<typeof
  // useAppShellState>，返回值即 context 面）—— T8 落地、T10 验证。
  const returnIndex = shellState.indexOf("openWorkItemsPage,", shellState.indexOf("return {"));
  assert.ok(returnIndex > 0, "openWorkItemsPage 必须出现在 useAppShellState 的返回对象里");
  assert.match(shellState, /const openWorkItemsPage = useCallback/, "openWorkItemsPage 是稳定 callback");
});
