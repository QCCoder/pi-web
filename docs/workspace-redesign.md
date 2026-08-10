# Workspace 重构设计稿（v2）

- **Status**: Draft — 已与产品负责人达成共识，待落地
- **Date**: 2026-08-10
- **Baseline**: [workspace-product-design.md](./workspace-product-design.md)（MVP 现状）
- **关联**: 本稿是对 MVP 的**演进**，不是推翻。底层模型（`WorkspaceManifest` / `WorkspaceRepository` / capability）基本保留。

---

## 1. 背景：为什么要重构

在一次设计拷问中，产品负责人认为"工作区的组织方式不对"，并从零重新推导出了**大量已经存在**的特性——typed repositories（`code` / `knowledge`）、capability 开关体系、Loop、Changes、git status/diff、work items。这暴露出两个真问题：

1. **`AGENTS.md` 严重过时**：它只把 `SessionSidebar` 描述成"session tree + FileExplorer"，对 workspaces / repositories / loop / git / changes **只字未提**。后果是连作者本人都在重新发明已有的轮子（本次拷问的开端即是如此）。
2. **组织方式本身需要演进**：
   - 单侧边栏**堆叠分组**（sessions + work-items + repositories[代码|知识库] + explorer + archive 全摞一起）在 capability 数量增长后越来越挤；
   - **知识库被埋在 Repositories 子组下**，没有一等公民身份；
   - **模板与 capability 耦合过紧**（模板既是 capability 包，又是脚手架）。

> 教训：**`AGENTS.md` 必须与代码同步**。本次重构的第一步交付就是重写 `AGENTS.md`，补齐 workspaces / repositories / loop / git / changes 的真实结构。

---

## 2. 目标模型（合成）

### 2.1 创建一个工作区
命名 + 勾选 capability。**没有命名模板**。目录延迟到首次使用，由 capability 自建存储。

### 2.2 导航
左侧**图标栏（Activity Bar）**，单焦点切换（同一时间聚焦一个 capability 视图）。

### 2.3 capability 清单

| capability | 必/可选 | 形态 |
|---|---|---|
| **会话（sessions）** | 必带 | 与 Pi Agent 的聊天会话（不变） |
| **Explorer** | 必带 | 文件树；**Changes 并入**，顶部 `[ 文件 \| 改动(N) ]` 分段切换 + 角标，按 Explorer 当前 scope 显示改动 |
| **仓库（repositories / code）** | 可选 | git 仓库（init / clone / remote），可多个 |
| **知识库（knowledge）** | 可选 | 一个 **OKF bundle**；默认 L0（agent 直读/遍历 OKF + AGENTS.md 知情），L1 `kb_search` / L2 向量 RAG 均 opt-in |
| **Loop** | 可选 | 自动化运行 |
| **工作项（work items）** | 可选 | requirements / bugs |

### 2.4 AGENTS.md
创建时自动生成；`repositories` 段用 `<!-- workspace-managed:... -->` 标记自动维护；其余用户可写；**与模板解耦**。知识库 / 大内容**引用出去、agent 按需 read**（pi 逐字注入 AGENTS.md 内容、不展开任何引用；靠模型跟随引用去 `read`）。

### 2.5 知识库
一个 **OKF bundle**（git repo + markdown + YAML frontmatter + `index.md`/`log.md`/concepts/links）。默认 L0；检索增强（FTS / 向量）opt-in。一等公民身份靠"**被指定 + OKF 约定 + agent 知情**"三根支柱，不靠搜索工具。详见 [§4](#4-知识库专题okf)。

---

## 3. 决策日志

> 贯穿全程的**元原则**：只论合理性、不论实现成本；从**产品层**（任意工作区）思考，不局限于某一个工作区。

| # | 主题 | 决定 | 理由要点 | 关键权衡 / 代价 |
|---|---|---|---|---|
| 1 | 范围 | 重构组织方式；现状已大量存在，是**演进非推翻** | 避免重写稳定底层 | — |
| 2 | 导航 | 左侧**图标栏**（Activity Bar），单焦点 | capability 数量在涨（9+），堆叠扛不住；用户的"平级清单"本质上是在描述互斥视图模式 | 单焦点→需频繁切换；靠拖拽/分屏缓解 |
| 3 | 仓库 | `Repositories` **只放代码**；知识库与其**平级** | 代码与知识是两种不同的活 | — |
| 4 | 知识库升格 | `knowledge` 从 `kind` 提升为独立 **`WorkspaceCapability`**（与 repositories/loop/explorer 平级） | 任何工作区都能开关的模块化能力；共享 `WorkspaceRepository` + git 机制，capability 只是更细的开关 | — |
| 5 | 模板 | **删除命名模板**；初始化 = 勾选 capability | 模板降级为"纯脚手架"后与 capability 解耦；只 2 个内置模板，体系收益低 | 冷启动变裸（由 AGENTS.md + Explorer 兜底） |
| 6 | 目录 | **延迟到首次使用**，capability 自建存储 | 最小魔法；work-items 写入时 `mkdir -p`、repo clone/init 时自建路径，均不依赖预建 | — |
| 7 | 初始化勾选 | 必带 `sessions` + `Explorer`；可选 `仓库` / `知识库` / `Loop` / `工作项` | — | 必带是"硬编码"还是"默认开"见 [§6 开放项](#6-尚未决定开放项) |
| 8 | Changes | **并入 Explorer**：顶部 `[ 文件 \| 改动(N) ]` 分段切换 + 角标，改动列表 = Explorer 当前 scope | "Changes 还没到一等公民"；并入后顺手解决"Changes 跟着库走"（按当前 scope） | 切走就看不到改动（角标 N 弥补） |
| 9 | AGENTS.md | **自动生成 + `repositories` 段标记自动维护 + 其余可写 + 与模板解耦**（即 C 方案） | 既自动整理、又不过时、又可自定义；A/B/D/E 各丢一样 | 标记段有轻微"魔法"，但 pi 现状即此 |
| 10 | AGENTS.md 引用 | 大内容（知识库/大文档）**引用出去、agent 按需 read**；小 foundational 事实（repos/caps/rules）inline | pi 逐字注入 AGENTS.md、不展开任何引用；大内容常驻 system prompt 会撑爆每轮上下文 | agent 是否跟随引用是模型行为（概率性），故只用于大内容、不用于必读事实 |
| 11 | 知识库检索 | 默认 **L0**（结构导航 + 知情）；`kb_search`(FTS) 与向量 RAG **均 opt-in** | 结构化库靠 L0 即可（OKF 本就为 agent 无工具遍历设计）；两个检索增强都按 KB 实际规模/结构按需开 | 无结构/大库需用户主动开检索 |
| 12 | 知识库一等公民 | 靠"**指定 + 约定 + 知情**"，**不靠搜索工具** | 若只给 grep，知识库≈一个能 grep 的文件夹，撑不起一等公民；但结构化库又不需要默认搜索工具——故用三支柱定位 | — |
| 13 | 知识库格式 | 采用 **OKF**（Open Knowledge Format v0.2） | OKF 立身之本="agent 无专用工具即可读/遍历的 git-backed 结构化知识库"，正好把 L0 标准化坐实；现成标准约定强化一等公民 | 现有库需补 frontmatter（渐进迁移） |
| 14 | 检索索引新鲜度 | （启用检索时）**按需自愈**：每次 search 前按 mtime 增量补索引 | 无需常驻 watcher；不搜不花索引成本；小库现建无所谓、大库走持久+增量 | 见 [§6](#6-尚未决定开放项)（待最终确认） |

---

## 4. 知识库专题（OKF）

### 4.1 为什么是 OKF
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)（Open Knowledge Format，GoogleCloudPlatform，v0.2）= **一个目录树状的 markdown + YAML frontmatter 知识格式**，刻意极简：无 schema 注册中心、无中心权威、**不要求任何专用工具**——"能 cat 就能读，能 git clone 就能发布"。

它的立身之本——"**agent 无需专用 SDK 即可解析/遍历的、git-backed 的结构化知识库**"——**正好就是我们 [§3 决策 11] 的 L0 结论**。采用 OKF 不是引入新东西，而是给 L0 找到一个现成、标准的格式规范。

### 4.2 OKF → 我们的设计映射
| OKF | 我们的设计 |
|---|---|
| bundle = git repo（推荐） | 决策 4：知识库 = git 仓库（L0） |
| markdown + frontmatter，agent 无专用工具可遍历 | 决策 11：默认 L0 结构导航 |
| `index.md` 渐进式披露 | 现有 `目录规则.md` → 升级为 OKF `index.md` 约定 |
| frontmatter `type` / `tags` | "结构适合搜索"——让 `grep` 都变成结构化查询 |
| concept ID = 文件路径 + link 连接 | agent 用 read/grep 顺 link 遍历 |
| provenance / trust / lifecycle / attestation（一等字段） | 我们原本未设计；agent 维护的知识库可标注来源/可信度/生命周期（投资/分析场景尤其有用） |

### 4.3 检索分层
- **L0（默认，永远内置）**：git bundle + agent 直读/grep/ls + AGENTS.md 知情（描述知识库的 OKF 结构）。
- **L1（opt-in）**：`kb_search` 工具，ranked 全文检索（FTS/BM25），索引建在 frontmatter + 正文上。由一个 **pi extension** 提供（SDK 支持自定义工具，pi-web 已用 extension 工具）。
- **L2（opt-in）**：向量/语义 RAG，仅当库大到扫不动 + 查询语义模糊时。

> 一个 `kb_search` 工具，跨该工作区**所有激活的知识库**搜（顺带定了 multiplicity：多库共享一个工具）。

### 4.4 采用代价
- 现有知识库（如 `qyinf-knowledge`）目前**无 frontmatter**，采用 OKF = 至少给每篇加 `type`（+ 可选 `tags`）。**可逐篇渐进迁移**。
- trust / attestation 是可选重 machinery，个人笔记库可从 `type + tags + 正文` 起步，将来（如投资分析需要可验证计算）再上 attestation。

---

## 5. 关键事实发现（驱动决策的勘测）

落地前值得先读这几条，避免踩同样的坑：

1. **`code` 与 `knowledge` kind 行为完全相同**——`kind` 只驱动目录路径（`repositories/${kind}/${alias}`）+ UI 标签 + 几处计数，**没有任何知识库专属行为**。所以"提级"在数据层是轻量的（决策 4）。
2. **pi 只按文件名加载 `AGENTS.md` / `CLAUDE.md`**（从 cwd 往上逐级祖先目录 + 一个全局），内容**逐字注入 system prompt**，`<project_instructions path="...">...</project_instructions>`。**没有 include / `@` 引用展开**——AGENTS.md 里写 `@x.md` 不会触发加载（决策 10 的依据）。`@` 机制仅用于把文件附到**某一条用户消息**（chat 输入 / CLI），与 context-file 加载是两套。
3. **pi SDK 通过 extension 支持自定义工具**（`RegisteredTool` / `defineTool` / `InlineExtension`），pi-web 已在用（`rpc-manager.ts` 的 `withExtensionTools`）。故 `kb_search` 可由一个 pi extension 提供（决策 4.3 的可行性）。
4. **AGENTS.md 自动整理机制已存在**：`renderSoftwareDevelopmentAgents`（创建时生成）+ `updateManagedRepositoryInstructions`（`<!-- workspace-managed:repositories:start/end -->` 标记段在 repo 增删时自动重写）。删模板后保留这套、改为从 manifest 驱动即可（决策 9）。

---

## 6. 尚未决定（开放项）

落地前建议逐个收口：

1. **multiplicity**：一个工作区能挂几个代码库 / 知识库？（倾向：都可多个；`kb_search` 跨所有激活 bundle 搜。）
2. **D7 漏掉的现有 capability**（`overview` / `feishu-transport` / `feishu-channel` / `subagent` / `workflows`）——保留还是砍掉？
3. **"必带"语义**：`sessions` + `Explorer` 是**硬编码不可关**，还是**默认开、可关**？
4. **检索索引新鲜度**：决策 14（按需自愈）最终确认。
5. **迁移**：现有 `software-development` 工作区如何过渡到"无模板 + 勾选 capability"；现有知识库如何补 OKF frontmatter。
6. **图标栏顺序**。

---

## 7. 迁移与前置注意

- **第一刀应该是重写 `AGENTS.md`**：补齐 workspaces / repositories / loop / git / changes 的真实结构，消除"重新发明轮子"的根因（§1 教训）。
- 现有 `software-development` 工作区：其 manifest 仍带 `template: software-development` 与预置 capability/目录；过渡时需决定是就地迁移还是新建。
- 知识库 OKF 化：给现有笔记补 `type` frontmatter；`目录规则.md` 概念上映射为 OKF `index.md`。
- `WorkspaceRepositoryKind = "code" | "knowledge"` 保留（数据层不变）；`knowledge` 升格为 capability 是** UI / capability 层**的变更，不影响存储。

---

## 8. 后续

- **落地切片建议**（决策 5 的"先切哪刀"）：① 重写 `AGENTS.md` → ② 删模板 + 初始化改勾选 capability → ③ 图标栏重构（含 Changes 并入 Explorer）→ ④ 知识库 OKF 适配 + capability 升格 → ⑤ `kb_search` extension（opt-in）。每步可独立验证。
- 个别决策（如"知识库 = OKF bundle capability"、"图标栏导航"）若需要更正式记录，可晋升为 `docs/adr/0010+`。
