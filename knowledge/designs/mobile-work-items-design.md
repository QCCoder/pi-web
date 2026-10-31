# 手机端工作项页设计（2026-10）

> 手机壳（`MobileTabShell`，<768px）的工作项页从「复用桌面 `WorkItemsPage` 的窄屏自适应」改为**手机原生三页**（`components/shell/MobileWorkItemsPages.tsx`）。本文记设计决策与取舍；实现细节见 `knowledge/reference/ui-shell.md`「移动端导航」与 `knowledge/reference/work-items.md`「前端」。

## 1. 为什么重做

此前手机壳把桌面中央页 `WorkItemsPage` 原样推入，靠 `narrow`（≤640px）做三处让步：页头瘦身、看板回落列表、详情以绝对定位覆盖层盖住列表。在 390px 宽的真机上：

- **工具栏**是桌面密度：搜索框 + 四个原生 `<select>` + 阻塞按钮 + 范围分段，26px 高控件折成三四行；
- **列表行**是单行八段 flex（KEY / 来源 / 标题 / 类型 / 阶段 / 优先级 / 标记 / 状态 / 时间），标题被挤到 80px，行高 30px，触不准也读不出；
- **详情**覆盖层上方仍是页头的 ‹（回工作区页）与 ＋，正文里还有一个 ✕（回列表）——两个返回、两个语义；
- 用户此前对 Skill / 设置 / 工作区设置页的反馈一致：「要符合手机端交互和审美」「一页放不下就开详情页，不要硬塞」。

## 2. 手机上这页的真正工作

工作项是**被四角色 agent（designer / developer / verifier / release-preparer）推着走的交付单元**，人只在几个门上出手：答澄清问题、确认设计、解阻塞、登记发布——spec 把这些收成唯一的人工待办队列（`GET /api/workspaces/[id]/attention`，kind = question / confirm / release / blocked）。

离开桌面的人在手机上要做的不是写设计文档，而是：**看哪些在等我 → 处理 → 看一眼什么在跑 → 顺手记一个 bug**。手机页按这个优先级设计，而不是把桌面的全部能力缩小塞进来。

## 3. 设计方案

### 色彩（全部走主题变量，明暗自适应）

| 用途 | 值 | 说明 |
|---|---|---|
| 基底 | `--bg --bg-panel --border --text --text-muted --text-dim` | 与手机壳其他页一致 |
| 需求 KEY / 待答问题 / 活动控件 | `--accent` | |
| 缺陷 KEY / 阻塞 / P0 | `#dc2626` | 与桌面 `STATUS_DOT_COLORS` 同值 |
| P1 | `#ea580c` | |
| **等你的手**（待确认设计 / 已催办 / 琥珀带） | `#b45309` | 刻意区分于红：红 = 坏了，琥珀 = 等你。桌面的执行中断按钮与 AttentionBar confirm kind 已在用这个色 |
| 进行中 / 已完成·发布 | `#2563eb` / `#16a34a` | |

### 字体与字号

继承系统字体；KEY 与 commit 用 `--font-mono`。页头 17/600（MobileNavBar）；行标题 15 两行截断；KEY 12.5 mono；元信息 12；分组标题 12 muted；行尾事实 11.5–12。无全大写、无眉标。

### 布局

```
‹ 会话        工作项  smoke-s2            ＋      MobileNavBar 44px，＋ 40×40 accent
┌──────────────────────────────────────────┐
│ 🔍 搜索 KEY 或标题                         │     MobileSearchField
└──────────────────────────────────────────┘
┃ 活动 12 ┃  归档 3  │  回收站 1                 全宽分段（36px）
(类型 ⌄)(优先级 ⌄)(阶段 ⌄)(阻塞 / 待确认)(来源 ⌄)  横向滚动筹片 = 原生 select 盖在筹片上

需要你处理                                 3     琥珀标题 + 琥珀底卡
┌──────────────────────────────────────────┐
│ REQ-0013  P0                   待确认设计 │     行尾 = kind 文案（kind 色）
│ 登录页改版                                │
│ ▰▰▱▱▱▱▱ 设计              已催办  已等 2 天│     轨迹 + 阶段 ⋯ 徽标 + 已等
├──────────────────────────────────────────┤
│ BUG-0007  P1                     待答问题 │
│ 支付回调超时                              │
│ ▰▰▰▱▱▱▱ 实现                     已等 1 天│
│ 回调地址是测试还是生产？                   │     question / blocked 的 detail 另起一行
└──────────────────────────────────────────┘
进行中                                     5
┌──────────────────────────────────────────┐
│ REQ-0011  P2                       刚刚   │     行尾 = 更新时间
│ 订单导出 CSV                              │
│ ▰▰▰▰▱▱▱ 实现                             │
└──────────────────────────────────────────┘
待处理                                     4
已阻塞                                     1
已结束 ▸                                   8     缺省折叠（done + cancelled）
```

左对齐；每行只保留**一个**右侧事实位（第一行行尾、第三行行尾）。

### 原则

1. **人工门优先**：attention 队列是页面的 hero——琥珀、在最上、点行即到详情的动作条。没有统计数字做装饰。
2. **结构即信息**：七段**阶段轨迹**只给标准流程项（`delivery.protocolVersion === 1`）渲染——只有它们真的在跑七阶段；老流程项按原始 phase 文案展示，不谎报进了标准列（与看板 `isHistoricalComplete` 同一条纪律）。类型靠 KEY 前缀 + 颜色编码（REQ accent / BUG 红），行上不再放「需求/缺陷」chip；优先级是文字不是徽章。
3. **按动静分组而不是平铺**：需要你处理 → 进行中 → 待处理 → 已阻塞 → 已结束（折叠）。一项只落一组，attention 命中优先。筛选负责缩小，分组负责讲故事。
4. **一页一事**：列表页只列；详情、新建是推入栈里的独立页，‹ 回列表（修掉旧的「‹ 弹出整个模块 / ✕ 回列表」双返回）。不做左滑动作（不可发现）。
5. **本轮复用详情 / 创建表单正文**（`WorkItemDetailView` / `WorkItemCreateForm`，功能完整且有测试覆盖），只重做它们的框。正文的手机密度留到下一轮。

## 4. 对照「通用默认」的自审

「一个移动端工单列表」的默认产物：搜索框 + 筹片 + 一张张一样的卡片（标题 / 状态徽章 / 优先级徽章 / 头像 / 时间）+ 右下角 FAB。逐项对照：

| 默认 | 这里 | 为什么 |
|---|---|---|
| 平铺卡片 | 琥珀带 + 按动静分组 | 由产品自己的 attention 队列与人工门决定，不是通用模板 |
| 每张卡一个状态徽章 | 阶段轨迹；状态由所在分组隐含 | 砍掉一层徽章；轨迹是这个产品才有的七阶段 |
| 优先级徽章、类型 chip | 文字 P0/P1 着色；类型并进 KEY | 用已有的标识符承载编码，不新增元素 |
| FAB ＋ | 页头 ＋（40×40） | 手机壳首页的 FAB 是「新建会话」这个全局主动作；工作项页再放一个 FAB 会抢语义，还会盖住分组最后一行 |
| 四个原生 select 排成行 | 筹片形态的原生 select（透明 `<select>` 盖满筹片） | 保留系统选择器（iOS 滚轮 / Android 下拉）的手感，零自绘弹层；选中即点亮筹片 |
| 入场动画 / hover 动效 | 无 | 只有用户触发的变化（折叠、选择器） |

**把大胆用在一处**：阶段轨迹。其余一律安静。
**照镜子去一件饰品**：第一版「需要你处理」标题前有琥珀圆点——与琥珀标题、琥珀底卡构成三重信号，去掉圆点。

## 5. 实现落点

| 文件 | 职责 |
|---|---|
| `components/work-items/mobile-groups.ts`（+ `.test.mjs`） | 纯逻辑：`groupActiveWorkItems`（五组投影，attention 优先，空组不出）/ `primaryAttentionByKey`（同项多 kind 按展示定序取主条目 + extra）/ `phaseTrackIndex`（七列索引） |
| `components/work-items/useDeliveryExecution.ts` | 交付执行状态 hook（从 `WorkItemsPage` 的内联逻辑抽出：拉取 / 停止 / 重新检查并恢复 / 恢复自动领取；revision 感知 + 切项取消守卫）。桌面页仍持有自己的一份——两处语义须一致，合并是后续清理项 |
| `components/shell/MobileWorkItemsPages.tsx` | `MobileWorkItemsPage`（列表根页）/ `MobileWorkItemDetailPage`（页头 + DetailView `hideClose` + 执行 hook + 草稿守卫）/ `MobileWorkItemCreatePage`（页头 + CreateForm + POST 流，成功 → `onCreated(key)`） |
| `components/work-items/WorkItemDetailView.tsx` | 新增可选 `hideClose`——页头 ‹ 承担返回时不渲染正文 ✕；`onClose` 仍用于移入回收站后回列表 |
| `components/shell/MobileTabShell.tsx` | `PushPage` 新增 `work-item-detail`（带 `deeplink`）/ `work-item-create`；`backLabelFor` 下一层为 work-items → 「工作项」；`case "work-items"` 宿原生列表页；新建成功 `replaceTop` 成详情（‹ 直接回列表，不退回已提交表单）；深链形态推详情 / ‹ / 返回键三条路都同步 URL 的 `&item=` |

### 导航契约

- 栈：… → `work-items` → `work-item-detail` | `work-item-create`；详情 ‹ 与新建 ‹ 都回列表；Android 返回键经既有 `piMobilePushPage` 陷阱态弹一层。
- 深链 `?workspace=<id>&page=work-items[&item=<key>]`：列表页消费 `initialItemKey` 一次性推详情；推详情 / ‹ / 返回键分别 `navigateUrl(buildWorkItemsPageUrl(ws, key?), true)`——URL 与栈一致，刷新不复活已关掉的详情。
- 总览「新建工作项」的 `createRequest`（nonce）由列表页消费 → 推新建页，消费即清。
- 筛选持久化键与桌面同款 `pi-work-items-filters:<wsId>`（`parseStoredWorkItemFilters` 守门），两端互认。
- attention 取数与桌面 `AttentionBar` 同节拍：`refreshToken = snapshot.fetchedAt`，不自建 timer。
- **没拿到快照就是加载中**（骨架屏），不看 `useWorkItems.loading`——它初值为 false，首帧按它判断会闪一帧「还没有工作项」假空态（桌面页同样有这一帧）。

## 6. 本轮刻意没做 / 下一步

1. **详情正文的手机密度**：`WorkItemDetailView` 仍是 11.5px 元信息、26px 按钮。最值得做的一件事是把**交付动作条（确认设计 / 阻塞 / 登记发布 …）钉到底部**做成 44px 大按钮——它们正是「人的手」要按的门，现在埋在正文中段。涉及 `WorkItemActionbar` 的宿主形态，单独一轮。
2. **列表行的执行态**：行上不显示「正被 developer 领取中」——执行状态是逐项 GET，列表不付这个成本。若 `listWorkItems` 日后把活动 claim 投影进快照，第三行可加一个角色徽标。
3. **桌面 `WorkItemsPage` 与 `useDeliveryExecution` 合并**：目前两份同语义逻辑；桌面页在并行迭代中，等它稳定后切到 hook。
4. **平板壳（`MobileShell` ≥768px）** 仍宿桌面 `WorkItemsPage`（narrow 自适应）——它有横向空间，本轮零改动。
