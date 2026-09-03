# Loop 配置面（pi-web UI）设计

日期：2026-09-03
状态：已与用户逐节确认（范围 C / 落位 B / 方案一）
关联：`docs/pi-loop-kit-design.md`、`docs/pi-loop-host-design.md`、`kit/README.md`

## 1. 背景与动机

pi-loop kit 落地后，loop 是纯文件协议：`loops/<name>/LOOP.md` 存在即 loop。业务定义（合同指针正文、
知识文档如 chandao.md/selection.md、宪法文件、SKILL.md）全部是**人写**内容物；kit 与 daemon 只管机器面
（声明、心跳、锁、补跑）。

workspace-c 的重组（chandao.md/selection.md 移入 `loops/dev-loop/`，LOOP.md 变纯指针，SKILL.md 只引用）
进一步明确了「改知识/规则改这里，不碰 SKILL」的分工——但 pi-web 目前**没有任何 loop 创作面**：
Overview 的 Loops 区块只在已存在 loop 时渲染，且只有 状态/暂停恢复/frontmatter 四字段/停止本轮；
新建、删除、知识文档与宪法编辑全靠手工编辑文件。

本设计补上「人的手」：每个工作区一套 loop 配置 UI。

## 2. 目标 / 非目标

**目标（范围 C）**

1. 管理现有 loop：frontmatter 编辑（从 Overview 区块迁入）、暂停/恢复/停止/立即跑保留在区块。
2. 创建/删除 loop：向导式新建（复用 `pi-loop init` 脚手架）；删除带安全守卫。
3. 人写文件编辑器：loop 知识文档（任意命名 `*.md`）、LOOP.md 指针正文、根级宪法两文件；
   STATE.md 只读展示。

**非目标**

- 不做 SKILL.md 编辑（专家向、合同本体，明确排除；创建时脚手架骨架 + 提示用户手改）。
- 不做通用文件写 API（不扩 `/api/files`——allow-list 保持只读姿态；写面按域收窄）。
- 不给 daemon 加任何 loop 路由（web 是「人的手」的面；现状设计约束）。
- 不做 loop-pause-all（全停开关）UI。
- 不引入 Monaco/CodeMirror 等编辑器组件（textarea 足够）。

## 3. 决策摘要

| 决策点 | 结论 |
|---|---|
| 范围 | C：管理 + 创建/删除 + 人写文件编辑器 |
| 落位 | B：Overview Loops 区块保留仪表盘职责；配置详情进右栏 config 区 |
| 右栏机制 | **shell 直接挂载**（`PreferencesPage` 先例），不走 portal——入口在主区域 Overview，且需在 Overview→chat 切换后存活 |
| 写面 | 方案一：loop 域专用窄写面，路径服务端拼接 + 文件名白名单，唯一 PUT 入口 |
| 业务无关 | UI 不硬编码 chandao.md/selection.md 等文件名；动态列 loop 目录人写文档 |
| 并发 | 知识/正文/宪法编辑不加锁（轮开场读取、下一轮生效）；STATE.md 永不可写；删除在锁活时拒绝 |

## 4. UI 设计

### 4.1 桌面：右栏配置视图

- `useAppShellState` 新增状态：

  ```ts
  type LoopConfigTarget = { kind: "loop"; name: string } | { kind: "new" };
  const [loopConfig, setLoopConfig] = useState<LoopConfigTarget | null>(null);
  ```

- 生命周期镜像 `workItemDetail`：panel 切换、会话选择、工作区切换、`configView` 打开时一并清空
  （实现方式：跟随现有清空点位逐一加入，不发明新机制）。
- `DesktopShell` 右栏分支条件加入 `loopConfig`，链序 `configView → workItemDetail → loopConfig →
  settings 子页`；渲染 `PanelHeader`（title=loop 名 或「新建 Loop」，× 关闭）+ `<LoopsConfig />`
  直接挂载（无 portal target）。
- 轮询/刷新：LoopsConfig 自持数据（按 loop 名 fetch），不依赖 Overview 状态；保存后局部刷新。

### 4.2 Overview Loops 区块常驻化

- 无 loop 时也渲染：空态文案 + 「新建 Loop」按钮（`onOpenLoopConfig({ kind: "new" })`）。
- 有 loop 时每行加「配置」按钮（`onOpenLoopConfig({ kind: "loop", name })`）。
- 现有内联 frontmatter 编辑表单（`loopForm` state）**迁移**进 LoopsConfig，区块只留
  状态/cron 摘要/level/paused/running/next-due + 暂停/恢复/停止本轮 + 立即跑（B 按钮既有）。
- `WorkspaceOverview` 新增 prop `onOpenLoopConfig: (target: LoopConfigTarget) => void`。

### 4.3 LoopsConfig 视图（右栏单列滚动）

自上而下：

1. **frontmatter 表单**：cron/timezone/level/max_minutes 四字段（沿用现有 PATCH 路由与校验文案）；
   cron 旁展示 `summarizeCron` 人话；保存后展示新 next-due。
2. **指针正文**（折叠，默认收起）：LOOP.md 正文 textarea；保存时 frontmatter 字节保留
   （复用 `pi-loop/frontmatter.ts` round-trip 的反向：改正文、保 frontmatter）。
3. **知识文档**：文件 chip 列表（来自 GET docs）+ 「＋新建文档」（输入文件名，客户端+服务端双重校验）；
   选中文档 → textarea 编辑 + 保存；「预览」toggle 用现成 `MarkdownBody` 只读渲染。
4. **STATE.md**（折叠，默认收起）：只读展示最新内容；**无任何写路径**。
5. **宪法文件**：loop-constraints.md / loop-budget.md 两入口，标注「所有 loop 共享」；
   缺失时「从模板创建」按钮预填 `kit/templates/basic/root/` 对应内容，再保存落盘。
6. **危险区**：删除 loop——先 GET 绑定工作项预览（`item.yaml.loop === name`），列表展示；
   有绑定项时需勾选确认再发 `{confirmBound: true}`；锁活时按钮禁用 + 提示。

保存语义：各节独立「保存」按钮，内容 clean 时禁用；带 `baseMtime` 乐观并发，不匹配返回 409 +
当前内容，UI 提供「覆盖」/「刷新重编」。

### 4.4 创建向导（`kind: "new"`）

字段：名称（slug）/ cron / 时区（默认系统本地）/ level（默认 **L1**，附「新 loop 强制 L1 起步」纪律提示）/
max_minutes（默认 30）/ pattern（高级折叠，默认=名称）。

- 成功 → 刷新 loop 列表 → 直接打开新 loop 的配置视图（`setLoopConfig({kind:"loop", name})`）。
- 结果提示：「SKILL.md 骨架已生成于 `.agents/skills/<pattern>/`，请按本 loop 职责改写（本 UI 不编辑 SKILL）」。
- pattern 对应 SKILL 已存在时 `initLoop` 跳过生成（幂等语义）——UI 如实提示「复用既有 SKILL」。

### 4.5 移动端

- `MobileShell` 工作台 tab 的 overview 本地栈新增 "loop-config" 页：`onOpenLoopConfig` 走 push，
  ‹返回 PanelHeader 栈模式；LoopsConfig 满屏 embedded 渲染。
- 无右栏、无其它移动端改动。

## 5. API 设计

新模块 **`lib/loops/manage.ts`**（服务器端；import pi-loop 纯逻辑；镜像 `lib/loops/rounds.ts` 模式）：
全部校验、路径解析、读写、原子写、守卫逻辑集中于此；路由保持薄壳。类型与错误映射参照
`lib/work-items/web.ts` 的既有做法。

### 5.1 路由

| 路由 | 方法 | 行为 |
|---|---|---|
| `/api/workspaces/[id]/loops` | POST | 创建：校验 name/cron/level/maxMinutes/timezone/pattern → `initLoop`；返回 declaration + status |
| `/api/workspaces/[id]/loops/[name]/docs` | GET | 配置面板数据包：`{frontmatter:{cron,timezone,level,maxMinutes,pattern}, docs:[{name,content,mtime}], loopBody, loopBodyMtime, stateMd, constitution:{constraints?{content,mtime}, budget?{content,mtime}}, boundItems:string[]}`（boundItems=绑定该 loop 的工作项 KEY，active+archived，危险区预览用；DELETE 时服务端权威复查） |
| `/api/workspaces/[id]/loops/[name]/docs` | PUT | **唯一写入口**：`{target, content, baseMtime?}`（target 见 5.2）；原子写；mtime 冲突 409 |
| `/api/workspaces/[id]/loops/[name]` | DELETE | 删除（加在现有 PATCH 路由文件）：守卫见 5.3 |

既有 PATCH（frontmatter 四字段）不动。

### 5.2 PUT target 判别联合

```ts
type WriteTarget =
  | { kind: "doc"; file: string }              // loop 目录知识文档
  | { kind: "body" }                            // LOOP.md 正文（frontmatter 保留）
  | { kind: "constitution"; file: "constraints" | "budget" }; // 根级宪法
```

### 5.3 校验与守卫（集中在 manage.ts）

- **知识文档文件名白名单**：`^[A-Za-z0-9][A-Za-z0-9._-]*\.md$`；拒绝路径分隔符、隐藏文件、
  `LOOP.md`/`STATE.md`（保留名）。服务端拼路径后 resolve 并复核仍在 loop 目录内（纵深防御）。
- **创建校验**：name 为 slug（同白名单语义，无扩展名）、不与既有 loop 目录冲突；cron 合法性由
  pi-loop 纯函数 `validateCron` 判定——若 `pi-loop/cron.ts` 尚无该函数则实现时补上（带测试；
  现有 `cronMatches` 对坏输入不抛错，不能直接当校验器）。
- **删除守卫**（顺序）：
  1. declaration 存在，否则 404；
  2. 锁活（`readRoundLock` + `isRoundLockStale`，与 `collectStatus.running` 同公式）→ **409**「轮在跑」；
  3. 扫描绑定工作项（`listWorkItems`，`item.yaml.loop === name`，active+archived）→ 有且未带
     `{confirmBound:true}` → 409 返回 `{boundItems:[KEY...]}`；
  4. `fs.rm(loops/<name>/, {recursive:true})`；**SKILL.md 与根宪法不删**（git 历史即审计）。
- **原子写**：tmp+rename（与 manifest/PATCH frontmatter 同法）。宪法文件缺失时 PUT 直接创建（含「从模板创建」预填后的保存）。
- **乐观并发**：PUT 带 `baseMtime` 时，磁盘 mtime 不匹配 → 409 返回 `{currentContent, currentMtime}`；
  省略 `baseMtime` 视为强制覆盖（新建文档后首次保存）。
- 路径全部由 `getWorkspace(id)` 服务端解析，客户端只传 loop 名/文件名/内容，无任意路径输入。

### 5.4 并发语义（为何不加锁）

知识文档、指针正文、宪法均在**轮开场**被读取（LOOP.md 指针步骤）；spawner 每 tick 重读文件——
运行中编辑无害，下一轮自然生效。STATE.md 从写面排除（loop 私有运行状态）。删除在锁活时拒绝。
`.lastrun`/`.round.lock`/`PAUSED` 为宿主文件，UI 不直接读写（暂停/恢复走既有 PAUSED 路由）。

## 6. 错误处理

- 路由错误映射沿用现有模式：`WorkspaceValidationError`/manage 层错误类 → 400/404/409/500 JSON
  `{error}`；409 冲突体附 `{boundItems?}/{currentContent?, currentMtime?}` 供 UI 分支。
- UI：每个写操作失败内联展示 error 文案，不弹全局 toast（与现有 Overview 一致）。

## 7. 测试计划

`lib/loops/manage.test.mjs`（node:test，临时 workspace 夹具，模式对齐 `lib/daemon/pi-subagent-roles.test.mjs` 等）：

- 文件名白名单：合法/路径分隔符/隐藏/保留名/非 .md。
- 前缀复核（构造越界 file 不落盘）。
- 原子写 + mtime 乐观并发（409 分支与覆盖分支）。
- PUT 三种 target 判别与拒绝路径；body 保存后 frontmatter 字节不变。
- 删除守卫：404 / 锁活 409 / 绑定项 409+confirmBound 放行 / SKILL 与宪法不删。
- 创建：参数透传 initLoop、重名 409、非法 cron 400（validateCron 单测一并落
  `pi-loop/cron.test.mjs`，若新增该函数）。
- GET docs 数据包形状（含缺失宪法的可空分支）。

UI 手测清单（实现完成时在 PR 描述附）：桌面右栏打开/×/切面板清理、Overview 常驻空态、
移动端栈 push/返回、创建→自动打开配置、删除全守卫路径。

## 8. 实现注意

- 完成后按仓库惯例更新 `AGENTS.md`：Loop 章节（管理面一段）、File Map（新组件/路由/manage.ts）、
  `components/WorkspaceOverview.tsx` 行为描述。
- `LoopStatusEntry`（pi-loop/status.ts）字段：name/pattern/level/cron/timezone/maxMinutes/
  paused/running/lastRun/nextDue——LoopsConfig 头部信息直接消费。
- 不改 `pi-loop` 包既有导出语义；新增导出仅 `validateCron`（若需要）。
