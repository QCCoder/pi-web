# 上游 v0.8.2 → v0.9.1 变更梳理与移植计划

> 生成于 2026-09-20。基于 `upstream/main@1eb5e66`（= v0.9.1 + 45 提交）的 git 历史与官方 release notes 交叉验证。
> 所有 commit 哈希均指 upstream 仓库 `agegr/pi-web`。
>
> **结论先行**：不整体合并 v0.9.1（shell IA、会话运行时、subagent 三处架构级分歧，整体 merge 工作量以周计）。
> 采用 **A 档直接摘取 + B 档对照审计** 的组合策略，本文件同时是 cherry-pick 工单与审计清单。

## 1. 版本事实

| 项目 | 事实 |
|---|---|
| 上游最新发布版 | **v0.9.1**（`8366762`，2026-09-11），v0.9.0（`0d1df12`）的直接后代 |
| upstream/main | `1eb5e66`（2026-09-19），领先 v0.9.1 **45 个提交**，下一版在路上 |
| v0.10.5 tag | **不是上游主线**。是第三方 fork（axello，`@axello/pi-web`）从 v0.8.7（`07f873c`）分出的线，落后主线 252 提交 |
| v0.9.0-fork tag | 本地侧（作者 kun）的 fork 发布 tag，从主线 `d251bb3`（约 v0.8.9 时点）分出，多 3 个提交：会话分类文件夹 |
| 本地分叉点 | develop 自 v0.8.2（`b6116d1`）分出，但早期合并过一次 upstream（合到 `6885309` PWA，约 v0.8.3 时点） |
| 本地规模 | v0.8.2..develop 共 290 提交，321 文件 +51550/-3811，新增文件 255 个 |
| 双方交集 | **70 个文件双方都改过**（冲突候选）；上游区间 454 文件 +51006/-15245，293 提交（fix 135 / feat 81） |
| pi SDK | 本地 0.84.4，上游 v0.9.1 为 0.85.1（仅差一个 minor，SDK 层合并代价小） |
| 上游区间提交类型 | fix 135、feat 81、release 10、docs 10、chore 9、perf 8、refactor 7、test 5、style 4、ci 2 |

## 2. 上游修复清单（B 档对照审计的原始素材）

### 2.1 流式与 SSE 稳定性（数量最多；本地运行时已 daemon 化，补丁不可直接用，须对照检查）

| 上游 bug | 哈希 | 本地对应检查点（对照审计用） |
|---|---|---|
| SSE 重连后丢失 shell 输出 | `def1478` | `lib/daemon/rpc-manager.ts`、全局 SSE 事件管理器 |
| agent SSE 断线韧性/跨窗口恢复 | `e4fded0`、`05db5b2` | 同上 |
| 打开活动会话时流式输出丢失 | `4787a14` | `SessionRuntimeStore`、tab 状态化逻辑 |
| Pi 0.84 流式 delta 协议适配 | `6a76151` | 本地 SDK 已 0.84.4，确认增量协议已适配 |
| 重复提交内置命令 | `d10988d` | `ChatInput.tsx` 提交路径 |
| 首条消息无法 fork | `585d56c` | 会话分支逻辑（本地 `lib/session-tabs.ts` 附近） |
| prompt anchor 更新死循环 | `d251bb3` | `ChatWindow.tsx` 滚动锚点 |
| 被拒绝的 prompt 提交丢失 | `6ac87ec` | 提交失败回退路径 |
| 每条 dispose 路径都发 session_shutdown | `d728526` | `lib/daemon/rpc-manager.ts` 生命周期 |
| Next 子进程停止原因报告/信号转发 | `36f01a3`、`7152653` | `bin/pi-daemon.js`、包装进程信号处理 |
| 关机僵尸 node 进程 | `1f79174`（v0.9.1 后） | 同上 |

### 2.2 会话管理

| 上游 bug | 哈希 |
|---|---|
| compaction/分页后历史消息缺失、最新回复丢失、minimap 失效 | `cd6032b`、`0ddb21f` |
| 长会话深层栈溢出 → 尾部分页加载 | `68cd261`、`1906134` |
| 新会话未发送草稿（文字+图片）丢失 | `77ffe3c` |
| 每会话独立阅读位置恢复 | `430fe4d` |
| 删除未持久化运行时会话 / 父文件缺失会话可删 / 含扩展任务会话保留 | `edf0deb`、`9cf8d4d`、`f57b565` |
| token/成本计数 compaction 后回退 | `93633c8` |
| compaction 后标题生成失效 | `06bb7ac` |
| 看到其它 pi 进程写的会话 | `b44017a`（v0.9.1 后） |

### 2.3 模型与配置

| 上游 bug | 哈希 |
|---|---|
| enabledModels glob/模糊匹配/`:thinkingLevel` 规则、残留警告 | `faccb23`、`f607816`、`06522eb` |
| 会话模型恢复显示错误 | `ed840ed` |
| 模型配置非原子写入损坏 | `ac81a96` |
| 模型加载失败后选择器消失 | `18923e6` |
| 供应商异常响应打挂配置界面 | `586d72e` |
| 设置草稿跨区保留、主题/语言控件丢失 | `b25ae6f`、`2eb95b9` |

### 2.4 输入与渲染（A 档 cherry-pick 主力，见第 6 节批次 2）

| 上游 bug | 哈希 | 冲突预估 |
|---|---|---|
| @ 文件选择器越界/键盘循环 | `1b88ec7`、`dab9850` | 低（本地 ChatInput 有改动） |
| 富文本粘贴丢链接 | `5173f6a` | 低 |
| 内联代码反引号转义 | `a26cc68` | 低 |
| 100KB+ 消息渲染卡死 | `9ebe18a` | 低-中 |
| 宽 Markdown 表格不能横滚 | `07dd093` | 低 |
| CJK token/TPS 估算、波浪线误判删除线 | `a8ba47e`、`f355928` | 低 |
| 显示数学公式围栏（GFM 列表内） | `dc4c0ec` | 低 |
| 编辑历史消息时图片恢复 | `44e595f` | 中 |
| 通知重复提醒不可再触发 | `edf574a` | 低 |

### 2.5 移动端 / iOS PWA（场景②重度手机使用 → 优先级上调）

| 上游 bug | 哈希 |
|---|---|
| iOS 键盘收起后视口错乱（多处） | `5eb71d8`、`ed52b61`、`0ada6c7`、`be428cf` |
| standalone 模式弹窗被状态栏遮挡 | `a3bbdee` |
| 移动输入框 Enter 换行 / 紧凑工具栏 | `fcfac31`、`0475e14` |
| PWA 图标不透明白底 / manifest 去掉 orientation 锁 | `b315bd3`、`99d4ea1` |
| iOS 后台推送不生效 | `3e9fcfa`（并入批次 1 的 Web Push） |

### 2.6 安全

| 上游 bug | 哈希 |
|---|---|
| 内联 SVG 预览可执行脚本 | `9db0cce` |
| 同源校验收紧（scheme-rewriting proxy） | `e44639f`、`b80ed3d`、`1e20164` |
| skill frontmatter 围栏损坏 SKILL.md | `70d3896`、`ff63346` |
| 浏览器扩展导致 hydration mismatch | `b8a3c53` |

### 2.7 其他

子路径部署导航 `5de2d9a`；API key 保存卡死 `e932d97`；LAN dev server `1218381`；终端 UTF-8 `2e914db`、Linux prebuild `ce18006`；扩展请求对话框可收起+键盘导航 `7c5f4e6`、`2356904`；ANSI widget 渲染 `fe684c8`；Windows 系列修复（不适用，忽略）。

## 3. 上游新功能清单

1. **内置 subagent 体系**（约 1200 行）：并发队列 `b77a25f`、worktree 隔离 `2661247`、持久化恢复 `a31d5c5`、profile `bbe2f7d`、扩展工具选择器 `e3fbbf6`；`lib/subagent-*.ts`、`AgentsConfig.tsx`、`app/api/subagents/*`
2. **集成终端**：文件面板 workspace 终端 tab `9290c27`；`TerminalPanel.tsx`、`app/api/terminal/*`、`lib/terminal-{manager,client}.ts`、`bin/prepare-terminal.js`；依赖 node-pty + @xterm
3. **Web Push 通知**：`64ae8d7` + iOS 后台 `3e9fcfa`；`lib/web-push.ts`、`lib/push-client.ts`、`lib/browser-notifications.ts`、`app/api/push/*`；依赖 web-push
4. **浏览器密码登录**：Basic Auth `48e8300` → 登录页 `e685cac`；`app/login/page.tsx`、`app/api/web-auth/route.ts`、`lib/web-auth.ts`；v0.9.1 后上游又加固：全局限流 `20ad98b`、cookie SameSite `c1e544b`、randomUUID 握手 `47a0bb2`
5. **会话全文搜索**：`1cbd96f`；`SessionSearch.tsx`、`lib/session-search.ts`、`lib/search-tree.ts`、`app/api/sessions/search`
6. **会话分支**：选中文本追问/引用分支 `c0abfc2`、按首条消息命名 `c87a9a4`；`lib/session-family.ts`、`lib/session-tree.ts`、`lib/quoted-selection.ts`
7. **模型目录/价格预设/上游发现/供应商用量**：`c1f0f04`、`6d53fd5`；⚠️ `app/api/models-config/catalog|discover` 本地有同名文件（add/add 冲突）
8. **chat-only 持久会话** `a5738cf`；**插件更新检查** `50b7f79`
9. **文件面板**：快速搜索 `b24ecad`、大文本分页 `0e71201`、查看器状态跨 tab `2e9e0d6`、每轮所写文件+HTML 预览 `51e0510`（⚠️ 本地已有 `SessionChangedFiles.tsx`，先对比再决定）、视频预览 `9dceb23`、图片点击放大 `e851d30`/大图压缩 `9d7cd52`
10. **性能专项**：会话列表虚拟化 `5f8f47b`、元数据缓存 `8cbafdd`、会话 JSON 压缩 `09383ae`、语法高亮缓存 `55485b9`、跳过长源高亮 `5014aaf`
11. **PWA+更新检查** `6885309`、`2517174`；**Mermaid 完成预览** `f3925bf`
12. **其他**：可读主题/聊天外观 `448e146`、`039e843`；扩展 widget ANSI `fe684c8`；会话统计（活跃时间/缓存命中率）`360667c`、`8640559`；Alt+Enter 流式追加 `abb74bf`；thinking 默认展开 `8aec7a1`；PI_WEB_IDLE_TIMEOUT_MS `e9f954a`；i18n 体系+繁体 `fd1593c`；Project Info 区块 `353757b`；跨 workspace 活动状态 `776fcb1`、`c8692e4`、`598c3c6`；web clone 命令 `7c74e93`

## 4. 结构性 / 破坏性变更

- **依赖**：pi SDK 0.82.1→0.85.1（本地 0.84.4，差距一个 minor）；next 16.2.12→16.3.1；undici 8.5→8.10；mermaid 11.14→11.16
- **新增运行时依赖**：`node-pty 1.2.0-beta.15`、`@xterm/xterm 6.0.0`、`@xterm/addon-fit`、`web-push`、`ansi_up`、`js-yaml`+`remark-frontmatter`、`semver 7.8.0`、`proper-lockfile`
- **安装流程变化**：新增 `postinstall: node bin/prepare-terminal.js`（node-pty prebuild 准备）——**本地 Docker 构建需要适配**
- **删除**：`bun.lock`（上游转纯 npm）、`app/api/agent/running/events/route.ts`、`app/api/auth/all-providers/route.ts`
- **大重构**：`602b1b6` 前端基建精简（重命名 105+ 文件）；设置面板统一重构 `adae260`/`d2668e2`/`f748f52`
- **基建增量**：130 个 `*.test.mjs`、CI workflow（`2cae813`）、Node 钉 22.19.0（`effa464`）

## 5. 分档评估

| 档 | 内容 | 处理方式 |
|---|---|---|
| **A** | 新文件为主的功能（push/登录/终端/搜索…）+ 纯组件级修复 | 直接 cherry-pick / 小规模移植 |
| **B** | 流式/SSE/会话管理修复、性能专项 | **不抄补丁**，按 §2 清单逐条对照本地 daemon 化运行时，缺的自己补 |
| **C** | 内置 subagent（1200 行）、Windows 全家桶、设置面板大重构、`602b1b6` 重命名波 | 不合。subagent 另开专门会话决策（现状 `@henryqw/pi-subagent@7.1.0` 为 `file:` tgz 依赖，不可持续，是那次会话的核心议题） |
| **D** | 上游主线没有、fork 线上有的好东西 | 记入 backlog 借鉴：会话分类文件夹（v0.9.0-fork `f530eac`）；axello 线的查看器 git revert `015b8ec`、手动文件编辑 `0815194`、后台服务 CLI `abf960b`、socket.io 反代终端 `9c14956`（远程部署备选方案） |

## 6. 移植计划（待审，未执行）

执行分支：`upstream-sync/0.9.1`（自 develop 切出），逐工单移植，每批次跑全量验证后再合回。

### 批次 1 —— P0，场景驱动（非本机访问 / 手机重度 / 页面内终端）

| 工单 | 内容 | 来源 commits | 上游涉及 | 本地落点 | 预估冲突 |
|---|---|---|---|---|---|
| T1 | **Web Push 通知** | `64ae8d7`、`3e9fcfa`、`044af0e` | `lib/web-push.ts`、`lib/push-client.ts`、`lib/browser-notifications.ts`、`app/api/push/{config,subscribe}`、sw.js 接线 | 新文件为主；接线到本地会话完成通知点与 `SettingsPanel` | **低**（无交集文件，纯接线） |
| T2 | **密码登录**（含 v0.9.1 后三个加固一起拿） | `48e8300`、`e685cac`、`20ad98b`、`c1e544b`、`47a0bb2` | `app/login/page.tsx`、`app/api/web-auth/`、`lib/web-auth.ts`、中间件接线 | 新文件为主；接入本地 proxy/部署入口（`proxy.ts`、`next.config.ts`） | **低-中**（认证接线点双方都动过 proxy） |
| T3 | **集成终端** | `9290c27` + `2e914db` + `ce18006`（Docker/Linux 部署需要） | `TerminalPanel.tsx`、`app/api/terminal/*`、`lib/terminal-{manager,client}.ts`、`bin/prepare-terminal.js`、package.json 依赖+postinstall | `FilesExplorerPanel.tsx` 加终端 tab；Dockerfile 需加 prebuild 步骤 | **中**（Explorer 集成点本地重组过；注意与 `lib/custom-ui-terminal.ts` 无关，后者是 daemon 无头垫片，勿混淆）；远程部署备选：axello `9c14956` 反代方案 |

验收标准：

- **T1**：手机 PWA 加入主屏后，后台会话完成/需要人工处理时能收到系统推送（含 iOS 锁屏）；拒绝通知权限时不影响正常使用；本地 `SettingsPanel` 有推送开关
- **T2**：从非本机地址（LAN/公网）访问任何页面与 API 均跳转登录页；`PI_WEB_PASSWORD` 未设置时行为与现状一致（本机 loopback 免登录）；连续密码错误触发限流；cookie 带 SameSite
- **T3**：`FilesExplorerPanel` 内可开终端 tab，断线（切 tab/合盖）重连后回话不丢；重启按钮可用；会话结束进程被清理（无残留 pty）；`docker compose build` 在无预编译缓存时也能过（postinstall prebuild 生效）；桌面 dev 与容器内行为一致

### 批次 2 —— P1，纯组件修复 cherry-pick（按冲突从小到大排序）

1. `07dd093`（宽表横滚）、`a8ba47e`、`f355928`（CJK 两项）、`dc4c0ec`（数学围栏）—— `MarkdownBody.tsx`/`MermaidBlock.tsx` 一带，低风险
2. `5173f6a`（粘贴链接）、`a26cc68`（反引号转义）—— `MessageView.tsx`
3. `edf574a`（通知重复）、`06bb7ac`（compaction 后标题）
4. `1b88ec7`、`dab9850`（@ 选择器）、`d10988d`（重复提交）—— `ChatInput.tsx`（本地有改动，冲突可控）
5. `9ebe18a`（大消息卡死）、`44e595f`（编辑恢复图片）—— `MessageView`/`ChatWindow`
6. iOS 集群（场景②）：`5eb71d8`、`ed52b61`、`be428cf`、`a3bbdee`、`b315bd3`、`99d4ea1`、`fcfac31` —— 多在 `globals.css`/`MobileShell`/manifest，与本地移动端改造有语义冲突，逐条手工合
7. `9db0cce` + `b80ed3d`（安全两项）—— `app/` 文件路由与 proxy

### 批次 3 —— P1.5，功能增量（按需逐个评估）

- 会话全文搜索 `1cbd96f`（纯增量，价值高，建议优先）
- 供应商用量配额 `6d53fd5`、插件更新检查 `50b7f79`
- Mermaid 完成预览 `f3925bf`、大文本分页 `0e71201`、文件搜索 `b24ecad`
- `51e0510`（每轮所写文件）——**先与本地 `SessionChangedFiles.tsx` 对比**，可能已覆盖
- 模型目录/价格预设 `c1f0f04` ——⚠️ `app/api/models-config/catalog|discover` 本地同名文件 add/add，需手工合
- 会话统计 `360667c`+`8640559`、Alt+Enter `abb74bf`、thinking 默认展开 `8aec7a1`（小而美，随手摘）

### 批次 4 —— P2，对照审计（不抄补丁，验自有实现）

按 §2.1–§2.2 清单逐条对照 `lib/daemon/rpc-manager.ts`、`SessionRuntimeStore`、全局 SSE 管理器、`hooks/useAgentSession.ts`，输出「本地已规避 / 本地同样存在需修 / 不适用」三栏结论。重点：

- SSE 重连丢数据、断线韧性、跨窗口恢复（§2.1 前四条）
- compaction/分页后的历史完整性（§2.2 前两条）——本地 SWR 消息缓存下同样可能出现
- 会话删除路径的资源清理（`edf0deb`/`f57b565`/`d728526`）
- 性能思路移植：会话列表虚拟化（对照 `WorkspaceSessionList`）、大 JSON 压缩 `09383ae`、元数据缓存 `8cbafdd`

### 明确不做

内置 subagent（另开会话）、Windows/PowerShell、设置面板大重构、`602b1b6` 重命名波、i18n 体系扩展（保留 backlog）。

### 执行约定

- 每工单一个 commit，message 引用上游哈希（如 `port(ui): wide table scroll (upstream 07dd093)`）
- 批次内不重排依赖；批次结束时 `npm install --package-lock-only && npm install` 重生成锁文件；`bun.lock` 去留另议（不在本次范围）
- 每批次验证：`npm run lint` + `tsc --noEmit` + `npm test` + dev server 冒烟（桌面+移动视口）
- upstream/main 领先的 45 个提交里还有：`/auto-compact` `f2d600b`、apply_patch split diff `e70c367`、scroll-to-latest `1eb5e66`、图片附件预览 `d2056b6` —— 作为批次 3 的后续候选
