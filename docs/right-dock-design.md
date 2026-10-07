# 右栏扩展坞设计（桌面）

> 状态：S1 + S2 + S3 全部已实施（2026-09-15；grill 共识十一项决策见 §0）。
> **2026-09-27 二次改版（已实施）**：模块 tab 不再常驻固定（§0 决策 #3/#7 的「钉死」语义
> 反转）——改为「按需打开的可关闭 tab」，常驻入口移到 SessionTabBar 下方的**工作区工具行**
> （工作区名 + 🏠总览 + 模块 toggle）。动机：模块导航混在右坞 tab 条里语义混杂（dock 关着时
> 入口不可见），且四个钉死 tab 常驻占用坞条；工作区工具行顺带补上桌面端「我在哪个工作区」
> 的定位。实施：useAppShellState（`dockModuleTabs` 集合 + `ensureDockModule`/`removeDockModule`
> 原语；`activeTopPanel` 不变）、DesktopShell（工作区工具行 + `DOCK_MODULE_META` +
> `toggleDockModule`/`closeDockModule`/`openDockModuleTab` + `panelEffTabId` 回落改为尊重
> 集合 + `handleDockTabClose` 拦截模块 id + 坞排空收起 + 总览 hub 回调改走 `openDockModuleTab`）、
> TabBar（`LeadingTabEntry.closable` → 模块 tab 渲染 hover-✕ 与中键关闭）、
> useAppShellState.handleCreateWorkItem（先 ensure 工作项 tab）。
> 语义详见文末「§12 二次改版」。
> 实施记录（S1）：lib/tab-types.ts（LOOPS_TAB_ID/MODULE_TAB_IDS/isModuleTabId + 测试）、
> TabBar.tsx（leadingTab→leadingTabs 钦死模块组 + .dock-module-tab 类）、globals.css
> （right-panel-container container-type:inline-size + @container≤420px 图标化）、
> hooks/useKitLoops.ts（loops 状态 hook，总览与坞共用）、components/LoopsDockPanel.tsx（新，
> loop 列表+状态/操作+内联 LoopsConfig 推导航）、WorkspaceOverview（onOpenLoopsTab 传入时
> Loops 区块瘦身为摘要行，移动端保持全量）、DesktopShell（坞接线）、useAppShellState
> （loopConfig 状态整体退役——移动端本就用自己的 overviewStack，无消费者）。
> 实施记录（S2）：KNOWLEDGE_TAB_ID 进 MODULE_TAB_IDS（knowledge capability 门控）；
> KnowledgeBrowser 直挂坞体（key=workspace.id，chips 选择状态随工作区重置）；hub 的
> knowledge 渲染分支与 setHubView("knowledge") 消费点删除（hubView 桌面只剩 overview/
> work-items）；总览知识库行 retarget → 开右坞知识库 tab；移动端照旧。
> 实施记录（S3）：WORK_ITEMS_TAB_ID 进 MODULE_TAB_IDS（work-items capability 门控）；
> WorkspaceManager `embedded + panel` 模式挂坞体（key=workspace.id；总览工作项按钮 →
> 开坞 tab；handleCreateWorkItem 重写为 开坞 tab + 创建请求；legacy work-items URL 深链 →
> 家 tab + 坞 tab）；hubView 状态 + workItemDetail/setWorkItemDetail/closeWorkItemDetailTick
> 整套退役（useAppShellState 无消费者）；WorkspaceManager 内 workItemSplit portal 机制 +
> onSelectedWorkItemChange/closeWorkItemDetailRequest 两个镜像 prop 一并删除；家 tab 中心
> 只剩总览；移动端照旧（overview 栈）。
> 动机：**d 并排协作**（模块面板常开在聊天旁，边聊边看工作项/loop 状态）+ **c 右栏利用率**（现状右栏只有文件，
> 左=会话/右=工作区资源的概念对称未兑现）+ **b hub 层级深**（进个工作项要 家tab→总览→hub 视图两层跳；
> 工作项详情/Loop 配置还会**顶替中心聊天区**）。
> 非目标：移动端零改动（其单列 push 栈本就是右坞的竖屏等价物）；模型/Skills/插件/设置等**全局配置不进坞**
> （保留中心顶替 + configPortalNode 机制）；左栏图标组不加回（维护 2026-09 W-中收敛，见 session-tabs-design.md §W）；
> 键盘快捷键不进 MVP；工作区子系统本体（capability→extension、loops 协议、工作项服务）零变化。

## 0. 决策记录（grill 共识）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 痛点 | d 并排协作 · c 右栏利用率 · b hub 层级深 |
| 2 | 模块清单 | 右坞 = **文件/工作项/Loops/知识库**（工作区作用域模块全集）；总览留家 tab 中心；全局配置不进坞 |
| 3 | 坞形态 | **顶部横向 tab 条**（选项 A）：四个模块 tab 与文件/内嵌会话 tab **混排同一条**；否掉右缘竖条（IDEA 式——它是为几十个工具窗调优的形态，我们只有 4 个模块，且文件 tab 必须有条，竖条会造成两级导航 + 面板收起态残留 44px 常宽负债） |
| 4 | 窄屏退化 | 模块 tab **钉死永不滚走**（flexShrink:0）；面板 <~400px 触发 container query **图标化**（纯图标 ~36px/个 + tooltip 补全名）；文件 tab 区沿用现有 `overflowX:auto` 横滚 + 省略号（TabBar 现状，零改动）。事实依据：面板拖拽钳制最小 300px、CSS `max-width: calc(100vw - 620px)` 保证聊天 ≥620px、≤640px 视口归移动端 shell |
| 5 | 中心区收编 | 家 tab 只剩总览；`workItemDetail`/`loopConfig` 的中心顶替分支**消亡**；工作项 tab 内部 = WorkspaceManager **panel 模式推进航**（列表→详情→‹返回，复用移动端已验证形态）；Loops tab 内部 = loop 列表（状态/暂停/停止/运行）+ 点开 LoopsConfig。中心区只剩：聊天 / 家 tab 总览 / 全局配置（模型/Skills/插件/设置子页/偏好） |
| 6 | 状态作用域 | **双层**：激活 tab + 面板开合**跟会话 tab**（现有 F1 机制不变，模块 tab 只是 `activeFileTabId` 值域里 4 个钉死 id）；模块**内容**状态（工作项开到哪个详情、loop 配置到哪、树展开）**跟工作区**——同工作区切会话 tab 时模块 tab 内容不卸载（display:none，与文件树存活同技巧），换工作区才重置。理由：「我在看哪个工作项」是工作区的事，不是会话的事 |
| 7 | 入口 | 右上角面板开关 + 坞内 tab 条 + 总览快捷动作（按钮 retarget 为开右坞 tab）；**不加左栏图标**；快捷键（如 Cmd+1..4）留作后续 |
| 8 | 移动端 | **一行不改**；`hubView` 降级为仅移动端消费的状态（桌面渲染分支删除，状态本身存活） |
| 9 | tab 门控 | 文件 = 有工作区上下文（现状）；工作项 = `work-items` capability；知识库 = `knowledge` capability；Loops = **常驻**（无 capability 概念，空态 + 新建入口，平移总览区块的常驻语义）。最小工作区右坞 = `[文件][Loops]`，全功能 = 四个；图标化按实际数量自适应 |
| 10 | 总览 Loops 区块 | **瘦身成摘要行**（`Loops · N 个 · M 个运行中 →`，点击开右坞 Loops tab）；loop 操作只住 Loops tab（避免两处交互面共享 loopsRefreshKey 的双刷新链路）。边界：总览**工作项行上**的「立即跑一轮」B 按钮和 Loop 绑定下拉**保留**（工作项作用域动作，非 loop 管理面） |
| 11 | 切片 | **S1** 坞机制 + Loops tab（删 `loopConfig` 中心顶替 + 总览区块瘦身）→ **S2** 知识库 tab（删 hubView=knowledge 桌面分支）→ **S3** 工作项 tab（删 hubView=work-items 桌面分支 + `workItemSplit`/`workItemDetail` 中心顶替整套退役）。每片自带旧路删除，**无新旧入口并存的中间态**；坞机制用耦合最少的 Loops 先试跑，最重的工作项放最后 |

## 1. 布局终态

```
┌────┬──────────────┬───────────────────────────────────┬────────────────────────────────┐
│    │              │ [首页|会话A|会话B|…]      ← 会话tab条 │[文件|工作项|Loops|知识库|README×|…]│
│ 图 │  会话列表     ├───────────────────────────────────┼────────────────────────────────┤
│ 标 │  (工作台)     │                                   │                                │
│ 栏 │              │   中心区只剩三件事：                 │   四个钉死模块 tab + 文件 tab     │
│    │  工作区切换器 │   ① 聊天（永不被顶替）              │   面板窄时模块图标化降级           │
│ 模 │  ＋新建会话   │   ② 家 tab 总览（纯导航台）         │                                │
│ 型 │              │   ③ 模型/Skills/插件/设置           │                                │
│ …  │              │                                   │                                │
└────┴──────────────┴───────────────────────────────────┴────────────────────────────────┘
 44px    260px可拖              剩余全部                        42%可拖（min 300px）
```

「文件」tab 本来就是四个模块之一——它是现有 TabBar 钉死的 leading tab（`FILES_TAB_ID`），其余三个模块 tab
紧随其后，再后面才是打开的文件/内嵌会话 tab。**一条 bar、一套导航语法**是本次形态决策的核心。

## 2. 坞 tab 模型

- 模块 tab id 建议加入 `lib/tab-types.ts`（与 `FILES_TAB_ID` 同源）：`MODULE_TAB_IDS = [FILES_TAB_ID, WORK_ITEMS_TAB_ID, LOOPS_TAB_ID, KNOWLEDGE_TAB_ID]`，全部钉死不可关。
- TabBar（`components/TabBar.tsx`）从单一 `leadingTab` 泛化为 `leadingTabs`（有序钉死组）；现状 `leadingTab` 调用点仅 DesktopShell 右面板与移动端 workbench 文件段（后者不变）。
- **图标化降级**：容器级 container query（面板宽度 <~400px）下模块 tab 只渲染图标（title=全名）；文件 tab 的 min80/max180+省略号+横滚不变。VS Code 范式：主导航钉死，内容 tab 滚动。

## 3. 中心区收编

- DesktopShell 中心区分支（现 `configView || workItemDetail || loopConfig || settings子页` 四合一）收窄为 `configView || settings子页`；`workItemDetail`/`loopConfig` 分支随 S3/S1 删除。
- `configPortalNode` 机制存活范围：模型/Skills/插件详情、设置›工作区、偏好（全局配置面）。
- 家 tab hub：`hubView` 桌面只剩 `overview` 渲染分支；总览按钮 retarget——工作项按钮/知识库行 → `updateActiveTab({ activeFileTabId: <对应模块tab>, rightPanelOpen: true })`；仓库行继续指向「文件」tab（现状语义）。
- 总览 Loops 区块 → 摘要行（决策 #10）。

## 4. 状态作用域（双层）

| 层 | 跟谁 | 机制 |
|---|---|---|
| 激活 tab + 面板开合 | 会话 tab | 现有 F1（`SessionTabState.activeFileTabId` / `rightPanelOpen`），零新概念 |
| 模块内容 | 工作区 | 同工作区切会话 tab 时模块 tab 内容**不卸载**（display:none，文件树同技巧）；换工作区重置 |

桌面首页沿用 `homeActiveFileTabId`/`homeRightPanelOpen`，模块 tab 行为与家 tab 一致。

## 5. 入口与门控

- 入口：右上角开关（面板收起态唯一入口，2 击到模块）、坞内 tab 条（面板开=1 击）、总览快捷动作。**不加左栏图标。**
- 门控（决策 #9）：见决策表；门控值读 `manifest.capabilities`（现 `panelWorkspace` 上下文已有）。

## 6. 移动端

零改动。`hubView` 的 work-items/knowledge/loop-config 栈页照旧（MobileShell overview 栈）；`loopFilesReveal` → 「文件」tab 管道不变。

## 7. 切片

| 切片 | 内容 | 同时删除的旧路径 |
|---|---|---|
| **S1 坞机制 + Loops tab** | tab 条/钉死/图标化/挂载存活 + Loops tab（loop 列表+状态+操作 → LoopsConfig） | `loopConfig` 中心顶替分支；总览 Loops 区块瘦身为摘要行 |
| **S2 知识库 tab** | KnowledgeBrowser 挂进坞 | hubView=knowledge 桌面渲染分支 |
| **S3 工作项 tab** | WorkspaceManager panel 模式挂进坞（列表→详情推进航，工作项工具条/创建/对话链接/绑定随组件整体迁移） | hubView=work-items 桌面渲染分支 + `workItemSplit`/`workItemDetail` 中心顶替 + 总览 workItemSplit portal 整套 |

每片独立 PR、独立可回归；坏了只回滚一片。

## 附带影响（随决策自动成立）

- `configPortalNode` 消费者减少（工作项详情/Loop 配置退出）；机制本身不动。
- 移动端 `WorkspaceManager` panel 模式成为桌坞工作项 tab 的宿主形态（同一组件两个 shell 消费，可接受且是既有模式）。
- AGENTS.md 导航章节在实施时随各切片同步更新。

## 12. 二次改版（2026-09-27）：模块 tab 常驻 → 按需打开

### 12.1 决策记录（grill 共识，用户确认）

| Q | 决策 |
|---|---|
| Q1 对象 | PC 端右坞四个固定模块 tab（移动端抽屉模块行 + 全屏子页已是目标形态，零改动） |
| Q4 模块终局 | 入口上移 + **保留右坞并排能力**（否掉子页面化——「边聊边看」是编码代理刚需） |
| Q8 入口位置 | **新增 32px 工作区工具行**（SessionTabBar 下方）：左 = 工作区名 + 🏠总览，右 = 模块 toggle（capability 门控）。否掉塞进 SessionTabBar（语义混杂 + 无会话空态尴尬 + 作用域歧义）与 ChatToolbar（太挤 + 右上角被固定 dock 开关占据） |
| Q9 dock 行为 | 入口点击 = dock 关着则自动打开 + 模块面板作为**带 ✕ 的可关闭 tab** 打开；再点同一入口 = 关闭该 tab；激活模块关闭后激活项回落（剩余模块 → 最后文件 tab → 空）；**坞内 tab（模块/文件/终端）全排空 → dock 整体收起** |
| 补充默认 | 无选中工作区（首页）工具行整行隐藏；URL/deep-link 本轮不做；capability 门控沿用 |

### 12.2 状态模型变化

- `dockModuleTabs: ModuleTabId[]`（useAppShellState，默认 `[FILES_TAB_ID]`）：**已打开**的模块 tab 集合，shell 级 UI 状态（跨会话 tab 一致）；「当前激活哪个模块」仍跟会话 tab（`activeFileTabId`，决策 #6 不变）；模块**内容**仍跟工作区（display:none 存活，不变）。
- `panelEffTabId` 回落语义变化：`activeFileTabId ?? (FILES 在集合中 ? FILES : null)` ——用户关掉「文件」tab 后不再默认亮文件树；`showFilesTree` 相应加 `panelEffTabId !== null` 守卫。
- `handleCloseFileTab` 关最后一个文件 tab 时钉回 FILES 常量的旧行为，在「文件」tab 未打开时由 DesktopShell 覆盖为按剩余模块回落 + 排空收坞（避免无 tab 条却亮文件树）。

### 12.3 布局终态

```
┌────┬──────────────┬──────────────────────────────────┬────────────────────────────────┐
│    │              │ [会话A|会话B|…] ← 会话tab条        │ [文件×|Loops×|README×|…]        │
│ 树 │  (工作台)     ├──────────────────────────────────┤  已打开的模块 tab（可关）+ 文件/  │
│    │              │ ws名 🏠总览        文件 Loops …←工具行│  终端 tab；空坞不出现（自动收起） │
│    │              │                                  │                                │
│    │              │   中心区：聊天 / 总览 / 配置整页     │                                │
└────┴──────────────┴──────────────────────────────────┴────────────────────────────────┘
```

窄坞图标化（`.dock-module-tab` 的 @container 规则）不变；工作区工具行在中央区整页（配置/归档）打开时随 SessionTabBar 一起隐藏。

### 12.4 三次修订（2026-09-27 晚，侧栏瘦身联动）：入口收敛为切换面板

侧栏瘦身改版（docs/mobile-drawer-design.md 补充记录）后，工作区工具行再次演化：
行首改为「**工作区名 ▾**」切换器——点击弹出 `WorkspaceSwitcherPanel`（两端共用：工作区列表
[点击切换=开总览家 tab；运行/完成徽章；拖拽排序] + ＋新建工作区/导入目录 + 停用/不可用暗淡行
[⚙ 重启用] + 当前工作区模块入口[总览/文件/工作项/知识库/Loops，dock 开合语义]）；行右侧平铺
toggle 撤掉工作项/知识库/Loops，只留 **🏠总览 + 文件** 两个高频捷径。桌面左侧 ProjectSidebar
同步瘦身为「当前工作区会话清单」（树退役）——工作区维度的导航全部收敛到顶部一行。
