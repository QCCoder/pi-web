# Agents 管理重做（PC + 手机）

## 先回答问题 1：builtin / global 的区别（以及为什么你看到的是 key）

你看到 `agents.scope.builtin` 这种原始字符串，是因为这 4 个 i18n key **根本没定义**——`translateMessage` 找不到翻译就把 key 原样返回。已修（`lib/i18n/messages/{en,zh-CN}.ts` 加了 builtin/global/workspace/project 四个 key，i18n 测试通过）。

四个作用域（`lib/subagents.ts`）：

| 作用域 | 来源 | 可编辑 | 优先级 |
|---|---|---|---|
| 内置 builtin | 硬编码在 `lib/subagents.ts`（general-purpose / explore / plan） | 否 | 最低 |
| 全局 global | `~/.pi/agent/agents/*.md`，所有项目共享 | 是 | ↑ |
| 工作区 workspace | `<cwd>/.agents/agents/*.md`（社区 pi-subagents 约定，Web 只读） | 否 | ↑ |
| 项目 project | `<cwd>/.pi/agents/*.md` | 是 | 最高 |

同名（不分大小写）高优先级覆盖低优先级（`lib/subagent-profile-precedence.ts`）——这就是「被覆盖」徽章的含义。**现在侧栏的分组顺序是 project / global / workspace / builtin，和真实优先级 project > workspace > global > builtin 不一致**，用户看不出谁赢。

## 问题 2 的诊断（为什么「乱、low」）

**PC**：顶部横条把总开关+并发数+重载钮塞在最显眼处（却最少用）；详情页 11 个字段平铺无分组；工具/资源是裸 checkbox；只读（内置/工作区）配置显示成「全部灰掉的表单」像坏了一样，没说明为什么、也没出路；「被覆盖」不说被谁覆盖；保存钮远在页脚。
**手机**：直接内嵌桌面分栏——190px 高的滚动列表压在整张表单上，三层滚动区——正是你在 ui-shell.md 里否决过的「硬塞」（Skill / 工作项 / 工作区设置都已重做成手机原生页，Agents 是最后一个没改的）。

## 设计方案

**原则**：① 优先级即信息架构——作用域永远按「谁赢」排序，每组旁边标出目录；② 只读是一种状态不是坏表单——内置/工作区配置按「可读内容」呈现，唯一出路是「创建副本」；③ 手机一页一事——列表 / 详情 / 编辑三页，不硬塞；④ 全局设置（总开关、并发）与单个配置的编辑分开放。

**视觉**：全部沿用主题变量，不引入新配色、不加卡片堆、不加大写眉标。PC 上唯一「花力气」的地方 = 侧栏的**优先级阶梯**：分组自上而下 = 项目 → 工作区 → 全局 → 内置，被覆盖项淡显并标「被 项目 覆盖」；这个结构本身就回答了「作用域有什么区别」。手机端使用已标准化的 `mobile-ui` 原语（与 Skill tab 同一视觉语言）。

### PC（`components/AgentsConfig.tsx` 重构，保留 ConfigSplitView）

```
┌ 侧栏 (260px) ──────────┬ 详情 ─────────────────────────────────────┐
│ 项目  ./.pi/agents      │ Explore                      ● 已启用  [创建副本] [删除] │
│   ● reviewer            │ explore · 快速检查代码库，不修改文件                      │
│ 工作区  ./.agents/agents │ ┌ 内置配置，只读。创建副本后可自定义。 ───────────────┐ │
│   ○ explore  被项目覆盖  │ 指令                                                     │
│ 全局  ~/.pi/agent/agents │ ┌──────────────────────────────────────────────────┐   │
│   ● general-purpose     │ │ (只读 = 可读文本块；可写 = 高 textarea)             │   │
│ 内置                    │ └──────────────────────────────────────────────────┘   │
│   ● explore  ● plan     │ 工具   [read][bash][edit][write][grep][find][ls]  切换芯片 │
│                         │ 资源   [加载技能][加载扩展]                               │
│ ＋ 新建子代理            │ 运行   模型 ▾   思考 ▾   最大轮次 [ ]   ☐继承上下文 ☐后台 │
├─────────────────────────┤ 来源   ~/.pi/agent/agents/explore.md                     │
│ 内置子代理 ●   并发 [10] │                                                          │
└─────────────────────────┴──────────────────────────────────────────────────────────┘
```
- 侧栏：按优先级分组，组标题带目录 hint（dim mono 小字）；总开关+并发数移到侧栏页脚（`agents-sidebar-footer`），顶部横条删除；需要重载时在页脚出一行提示+按钮。
- 详情头：显示名做真标题（14/600）+ ID mono + 描述；状态胶囊；动作钮紧凑一排。只读配置一行安静提示 + 「创建副本」，输入框不再灰掉而是渲染成文本/胶囊。
- 正文分 4 段（`ConfigSectionTitle`：指令 / 工具与资源 / 运行 / 来源）；工具与资源用切换芯片（`agents-chip`，pressed 态）替代裸 checkbox。
- 新建：作用域分段控件挪到详情头下方第一行，并实时显示将写入的路径。
- 保存钮保留页脚（与 Models/Skills 一致），但表单有脏标记时页脚状态栏显示「未保存」。

### 手机（<768px，新建三页，接入 MobileTabShell 推入栈）

```
[‹ 设置   Agents   ＋]        [‹ Agents   Explore   编辑]      [‹ Explore   编辑子代理   保存]
┌ 内置子代理 ──────────┐      Explore                         ┌ 保存到 ──────────────┐
│ 启用 Pi Web 内置子代理 ●│   快速检查代码库，不修改文件        │ [全局] [项目]  (仅新建)│
│ 并发子代理数     [10]│      [内置] [只读]                   │ 目标 ~/.pi/…/x.md     │
└──────────────────────┘      ┌ 状态 ─────────────┐           └───────────────────────┘
项目  ./.pi/agents            │ 已启用          ● │           ┌ 基本 ─────────────────┐
┌──────────────────────┐      └───────────────────┘           │ ID    [reviewer    ]  │
│ reviewer         ● › │      ┌ 指令 ─────────────┐           │ 名称  [Reviewer    ]  │
│ 审查改动…            │      │ Work autonomously…│           │ 描述  [            ]  │
└──────────────────────┘      │ …（3 行截断，点展开）│          └───────────────────────┘
工作区  ./.agents/agents      └───────────────────┘           ┌ 指令 ─────────────────┐
┌──────────────────────┐      ┌ 工具 ─────────────┐           │ (textarea 自增高)      │
│ explore  被项目覆盖 ○ ›│    │ read bash grep …  │           └───────────────────────┘
└──────────────────────┘      └───────────────────┘           ┌ 工具与资源 ───────────┐
全局  ~/.pi/agent/agents      ┌ 运行 ─────────────┐           │ [read][bash][edit]…   │
…                             │ 模型   跟随父会话 │           │ 加载技能  ○ 加载扩展 ○│
内置                          │ 思考   跟随父会话 │           └───────────────────────┘
┌──────────────────────┐      │ 最大轮次      —   │           ┌ 运行 ─────────────────┐
│ General purpose   ● ›│      │ 继承上下文    ○   │           │ 模型 ▾  思考 ▾ 轮次[ ]│
│ Explore           ● ›│      │ 后台运行      ○   │           │ 继承上下文 ● 后台 ○   │
│ Plan              ● ›│      └───────────────────┘           └───────────────────────┘
└──────────────────────┘      ┌ 来源 ─────────────┐           [删除]（仅编辑已有）
                              │ 内置配置          │
                              └───────────────────┘
                              [创建副本]  [删除]
```
- **列表页**（settings-sub "agents" 的正文，MobileNavBar 由壳出）：顶部总开关卡；按优先级分组卡，组标题 = 作用域 + 目录 hint；行 = 显示名/描述 + 被覆盖胶囊 + 开关（只读作用域只显示状态点）；点行进详情。
- **详情页**：hero（名/描述/胶囊：作用域·只读·被覆盖·模型）→ 状态卡 → 指令卡（3 行截断、点展开）→ 工具卡 → 运行卡 → 来源卡 → 底部「创建副本 / 删除」；只读配置无「编辑」钮，提示「创建副本后可自定义」。
- **编辑页**（新建 / 编辑 / 复制共用）：分组卡表单；导航栏右侧「保存」；新建时才出作用域分段；保存成功 `replaceTop` 成详情（‹ 直接回列表，不退回表单）。

## 文件改动

1. `lib/subagent-profile-precedence.ts` — 导出 `SUBAGENT_SCOPE_ORDER`（高→低）+ 新增 `overridingSubagentScope(profile, profiles)`（返回覆盖它的最高作用域，供「被 X 覆盖」文案）；`lib/subagents.test.mjs` 补测试。
2. `lib/i18n/messages/{en,zh-CN}.ts` — 新 key：各作用域路径 hint、只读提示、段标题、「被 {scope} 覆盖」、未保存、手机页文案（编辑子代理 / 创建副本后可自定义 …）。
3. `components/AgentsConfig.tsx` — 按上图重构（数据层/请求逻辑不动；只改结构与呈现）。
4. `app/settings.css` — 新增 `agents-sidebar-footer / agents-group-path / agents-readonly-notice / agents-chip / agents-prompt-readonly / agents-detail-title` 等；删除 `agents-feature-*` 横条样式。
5. **新建** `components/shell/useMobileAgents.ts` — 对照 `useMobileSkills`：profiles / settings(builtInEnabled, maxConcurrent) / models 三路加载，save / delete / toggleEnabled / toggleBuiltIn / setMaxConcurrent，按优先级分组。
6. **新建** `components/shell/MobileAgentsPages.tsx` — `MobileAgentsList` / `MobileAgentDetail` / `MobileAgentEdit`，全部用 `mobile-ui` 原语。
7. `components/shell/MobileTabShell.tsx` — 新增 PushPage kind `agent-detail {key}` / `agent-edit {key}` / `agent-create {fromKey?}`；`settings-sub` 且 page==="agents" 时渲染 `MobileAgentsList`（而非 headerless SettingsPanel→AgentsConfig）；`backLabelFor` 下层为 agents 页 → 「Agents」；hook 挂壳层共享状态。
8. `components/SettingsPanel.tsx` — 手机壳不再走该路径的 agents 分支（平板壳 ≥768px 仍用桌面 AgentsConfig，零改动）。
9. 文档同步（AGENTS.md 维护规则）：`knowledge/reference/ui-shell.md` 移动端导航节把 Agents 加入手机原生页清单；`knowledge/designs/subagent.md` 更新 Web UI 段落。

## 验证

`node_modules/.bin/tsc --noEmit` → `npm run lint` → `npm test`；起 `npm run dev` 用浏览器在桌面宽度与 390px 视口各截图核对（侧栏优先级顺序、只读态、手机三页推入/返回/保存后 replaceTop）。不跑 `next build`。