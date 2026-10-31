# 目录与文件地图（工作区数据布局 + 全仓带注释 File Map）

> 深细节基线，2026-10 自 AGENTS.md 迁出（AGENTS.md 现为总览与用法说明，细节住此）。

> 内容与迁移时点一致；后续变更直接更新本文档。



---



### Workspace directory layout (reference)

**2026-09 一套约定：pi 机制与数据统一收在工作区根的 `.pi/` 下（`packages/pi-loop/paths.ts` 是路径唯一源）；
工作区根留人的内容** —— 代码仓/知识库是根下的普通目录，由 manifest 按相对路径登记
（`repositories[].path`，`repositories/<kind>/<alias>` 固定布局已废除；`AddWorkspaceRepositoryInput.mode`
含 `register` 用于登记已有目录）。工作区可以是任意外部路径（index 条目直接指过去，如
`/Users/qiancheng/Documents/Workspace/cxin-workspace`），不必住在 workspaces 目录下。

Default locations are under `~/.pi` — but local dev can relocate the whole data home INTO the repo via
`scripts/adopt-pi-home.mjs` + `.env.local` (see "Local pi data home" under Key Design Decisions): `agent/` and
`workspaces/` then live at `<repo>/.pi/`, the global index becomes `<repo>/.pi/workspace-index.yaml` (renamed —
`.pi/workspace.yaml` in this repo is the pi-web workspace MANIFEST), and `.pi/agent` + `.pi/workspaces` are
strictly gitignored / tsc+eslint excluded / pruned by git-discovery.

```
~/.pi/
  workspace.yaml                         global workspace index
  workspaces/                            ($PI_WORKSPACES_DIR; 2026-09 起工作区也可以是任意外部路径)
    workspace-<slug>/                    （或任意外部路径的工作区根）
      AGENTS.md                          （永远在根：pi 从 cwd 根注入）
      .pi/workspace.yaml                 manifest（repositories[].path = 仓库相对路径）
      .pi/work-items/{requirements,bugs}/
                                         work items: <KEY>-<slug>/{item.yaml, README.md, events.jsonl, attachments/
                                         [, delivery/artifacts/design.md][, delivery/attempts/*.json][, delivery/runtime/]}
                                         （attempts = 追加审计；runtime/ = claim/paused/failure-window 运行态，
                                         gitignored、advisory——Phase-2 交付自动化）
      .pi/trash/work-items/<KEY>-<ts>/   回收站（DELETE 移入；item.yaml 兼任外部源去重墓碑；restore-from-trash 恢复）
      .pi/skills/<pattern>/SKILL.md      项目技能合同（pi 原生发现 <cwd>/.pi/skills/；旧 .agents/skills/ 已迁移）
      .pi/loops/<name>/{LOOP.md, STATE.md, loop-ledger.json, .lastrun, .round.lock, [PAUSED], LEARN/}
                                         kit loop declaration + memory spine (D5 文件即声明)
      .pi/loop/{constraints.md, budget.md, pause-all}
                                         根级共享宪法 + 全局停机旗（原根级 loop-constraints/loop-budget/loop-pause-all）
      .pi/delivery.yaml                   交付自动化配置 v2（2026-10 Phase-2/3/5 + final-arch step-3：enabled 缺省 false /
                                         roles 四键同形 designer/developer/reviewer/release-preparer 各自 profile+model（legacy 键
                                         verifier 接受并忽略） / stages.review.enabled 先审后跑缺省 false / budget /
                                         verification.checks 人维护验证命令——见 Work Items 章
                                         「Delivery 自动执行」）；.pi/delivery-seeded.json 剧本播种记录（产品维护：
                                         每角色只播一次、已记录永不重播、删了不重建）
      .pi/agents/*.md                    subagent 项目 profile（平铺）；交付角色剧本同名住此（<role>.md，缺省剧本名 = 角色名，
                                         保存交付配置时按 delivery-seeded.json 一次性播种模板——从未播过且缺文件才写、
                                         预置用户文件收养为 existing、永不改写）；<role>.template.md = 模板另存副本
                                         （POST …/roles/[role]/template 写即全新 wx、已存在 409，永不覆盖 <role>.md——
                                         final-arch step-6）；.pi/cache/ 可重建缓存
      <alias>/                           代码仓 / 知识库（根级目录，路径登记；各自独立 git）
      docs/ scripts/ …                   人的内容
    .pi/workspace-templates/<id>/        custom templates (template.yaml + seed/)
  agent/                                 (~/.pi/agent)
    sessions/<encoded-cwd>/*.jsonl
    agents/*.md                          legacy built-in subagent agents (retired; see lib/subagent-child.ts)
    config/pi-subagent/*.md               community subagent user-level roles (frontmatter: name/description/tools/extensions/skills)
    config/pi-task-models.json           task-model profiles required by delegate_task
```

---

## File Map

```
scripts/
  adopt-pi-home.mjs               one-time migration of ~/.pi into <repo>/.pi (moves data, rewrites absolute-path
                                   references — index entries / encoded session dir names / .jsonl cwd+parentSession —
                                   writes .env.local, patches shell rc; idempotent repair mode)

bin/
  pi-web.js                       npm bin wrapper — node 版本检查 + 直接 spawn next CLI（单进程：没有别的进程要拉起）

app/api/
  sessions/route.ts                      GET  list all sessions (grouped by project/worktree root)
  sessions/[id]/route.ts                 GET/PATCH/DELETE session
  sessions/[id]/context/route.ts         GET ?leafId= — context for a specific leaf (tail-windowed via ?tail=)
  sessions/[id]/earlier/route.ts         GET ?before=&limit=&leafId= — older-messages page for tail-first loading
  sessions/[id]/export/route.ts          GET exported HTML for a session
  sessions/[id]/state|archive|restore|locate|auto-name/route.ts   session lifecycle helpers
  sessions/[id]/entries/[entryId]/thinking/route.ts               GET a thinking block
  agent/new/route.ts                     POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts                    GET state | POST any command（全部直连 lib/session-host/facade，下同）
  agent/[id]/events/route.ts             GET SSE stream（进程内 Web-stream，lib/session-host/sse.ts）
  agent/[id]/bash-output/route.ts        GET bash output for a tool call
  agent/running/events/route.ts          GET SSE stream of currently-running session ids
  subagents/[id]/route.ts                GET subagent run status | POST steer/abort（facade getSubagentRunStatus/controlSubagent）
  subagents/profiles|settings/route.ts   subagent profiles / builtInEnabled+maxConcurrent settings（profiles PUT 支持可选 expectedContentHash——frontmatter content_hash 乐观并发，文件被外部改过 → 409；不带 = 不设防；哈希读时现算不信任存储值，测试 lib/subagents.profile-hash.test.mjs）
  workspaces/route.ts                    GET list+templates | POST create/import a workspace | PATCH { order: [ids] } 手动排序（索引 sortOrder 重编，一次写；不碰 manifest/git）
  workspaces/[id]/route.ts               GET | PATCH (capabilities/name/disabled) | DELETE
  workspaces/[id]/repositories/route.ts  GET | POST add(clone/init) | DELETE soft-remove | PATCH restore
  workspaces/[id]/work-items/route.ts            GET list | POST create
  workspaces/[id]/work-items/[key]/route.ts      GET | PATCH (revision-safe) | DELETE trash
  workspaces/[id]/work-items/[key]/events/route.ts   POST record milestone
  workspaces/[id]/work-items/[key]/attachments/route.ts  POST multipart attachments upload（service.addWorkItemAttachments：attachments/ 落盘 + README「## 附件」小节 + attachment_added 事件）
  workspaces/[id]/work-items/[key]/content/route.ts  PUT update README body
  workspaces/[id]/work-items/[key]/git/route.ts  GET 分支状态实时计算（lib/work-items/branch-status.ts：每关联仓库 {itemBranch, repoBranch, branchTargets[develop·master 兜底 main 的已合入/未合入], deliveryBranches(pi-delivery/<KEY>/* 自动识别), latestDelivery, candidate}；分支列表+merge-base 各 30s TTL，?refresh=1 穿透；合并状态永不落盘）
  workspaces/[id]/work-items/[key]/delivery/[action]/route.ts  POST 标准交付流动作（body {expectedRevision, requestId, payload}；slug 门 = DELIVERY_ACTIONS 权威表；applyDeliveryAction 锁内 + requestId 幂等，replay 返回 replayed:true；400 Validation/404 NotFound|未播种 design.md/409 revision|锁忙）
  workspaces/[id]/work-items/[key]/design/route.ts   GET 设计文档（readDesign：未播种 404）| POST 编辑（updateDesignContent：失效回退 + revision bump）
  workspaces/[id]/work-items/[key]/restore-from-trash/route.ts  POST 从回收站恢复（restoreWorkItemFromTrashInRoot：key 被占 409 / 墓碑损坏 400 / 无命中 404）
  workspaces/[id]/delivery/route.ts               GET|PUT 交付自动化配置 .pi/delivery.yaml（Phase-2；PUT 前 assertAutomationCapable 门 work-items+workflows；文件缺失 GET = {config:null} = disabled；坏 YAML/结构 → 400；seam-repositioning T3：PUT 写入成功后 seedRoleProfileTemplates 播种剧本模板（一次性，记录 .pi/delivery-seeded.json），响应 {config, seeded}；final-fix B：播种失败不打死保存——降级 200 {config, seeded: null, seedingError}）
  workspaces/[id]/delivery/resume/route.ts        POST 恢复自动领取（body {key}：清 automation-paused + 重置失败窗口 + delivery.resumed，actor=user；未暂停 → 400）
  workspaces/[id]/delivery/roles/route.ts         GET 四角色摘要（seam-repositioning T4：summarizeRoles 只读投影——剧本名/路径/在场/显式/seeded_from + 有效模型与来源；config null = 全缺省；只读无 capability 门，坏 YAML → 400）
  workspaces/[id]/delivery/roles/[role]/preview/route.ts  GET 组合预览（seam-repositioning T4：previewRolePrompt——AGENTS.md 全文〔仅展示〕+ AGENT_INVARIANT_CONTRACT + 剧本正文 + composed，与 launch 的 appendSystemPrompt 同一函数，key 占位 <KEY>；role ∉ DELIVERY_ROLES → 404；只读无门）
  workspaces/[id]/delivery/init/route.ts          POST 交付初始化（final-arch step-6 T1：initializeDelivery 只补缺只建议——delivery.yaml 缺失才写默认〔enabled 恒 false〕、缺剧本才播种、from 目录缺文件才复制；探测/from 检查只作草稿进响应 suggestedChecks，不执行不落盘；assertAutomationCapable 门先于写入；成功后同步 AGENTS.md delivery managed 块，失败记日志不挡 init；形状不对 → 400）
  workspaces/[id]/delivery/readiness/route.ts     GET 就绪清单（final-arch step-6 T1：deliveryReadiness 只读投影——五类缺项 no-checks / missing-profile:<role> / capabilities-missing / check-repo-unregistered / integrate-no-command + currentTemplateVersion；非门禁；宽容坏配置；只读无门）
  workspaces/[id]/delivery/roles/[role]/template/route.ts  POST 模板另存（final-arch step-6 T3：writeRoleTemplateCopy 把当前内置模板写 <ws>/.pi/agents/<role>.template.md——flag wx 写即全新，副本已存在 → WorkItemConflictError → 409，永不覆盖 <role>.md 与播种记录；capability 门先于写入；role ∉ 词表 → 404）
  workspaces/[id]/work-items/[key]/delivery-execution/route.ts       GET 执行状态四读（claim[剥 ownerTokenHash] / attempts 末 5 新→旧 / paused / pendingInterruption；item 不存在 404）
  workspaces/[id]/work-items/[key]/delivery-execution/stop|recover/route.ts  POST 停止执行（probeSession 活→定向 destroy→recordInterruption "stopped by user"，无 claim 404）| 重新检查并恢复（探测作用域=工作区根；残留进程 → 409 带 pids——manual 也不放行；干净 → resolveInterruptions + delivery.exec_recovered）
  workspaces/[id]/attention/route.ts             GET attention 队列（final-arch step-2 T5：collectAttention 只读装配 {entries: AttentionEntry[]}——唯一人工待办投影，与 dispatcher attend 共用同一装配器；只读无 capability 门）
  workspaces/[id]/loops/route.ts                  GET kit loops 全量状态（collectStatus：frontmatter 摘要 + .lastrun/next-due/锁活性/paused + 附 additive interruptions[执行中断记录]，管理面全量；web spec §5.1；D5 文件即声明 — no capability）| POST 创建（initLoop 脚手架）
  workspaces/[id]/loops/[name]/route.ts           PATCH frontmatter 四字段（cron/timezone/level/max_minutes）round-trip — 正文 byte 保留（「人的手」，S5；纯逻辑 pi-loop/frontmatter.ts，tmp+rename 原子写）| DELETE 删除（锁活/绑定守卫）
  workspaces/[id]/loops/[name]/run/route.ts       POST 立即跑一轮（launchManualRound，可选 itemKey → 合同追加优先项；返回 sessionId 供 UI 打开轮会话 tab；facade 两步建会话）
  workspaces/[id]/loops/[name]/pause/route.ts     POST 写 PAUSED 标记（幂等；在跑轮靠开场合同规则 6 合作收尾）
  workspaces/[id]/loops/[name]/resume/route.ts    POST 删 PAUSED 标记（幂等）
  workspaces/[id]/loops/[name]/stop/route.ts      POST 终止本轮（宿主持有 → facade destroy+释放锁[定向杀，不 cwd 收割]；beat 持有 → 409 提示走 pi-loop stop）
  workspaces/[id]/loops/[name]/recover/route.ts   POST 重新检查并恢复（spec §5.4）：detectSurvivingRoundProcesses 只读探测——残留命令进程 → 409 报 pid；干净 → resolveExecutionRecords（manual=true 记 recovered-manual/actor=user，否则 recovered-auto）解除恢复门禁
  workspaces/[id]/loops/[name]/docs/route.ts      GET 配置面板数据包 | PUT 唯一写入口（doc|body|constitution，mtime 乐观并发）
  git/status/route.ts                    GET ?cwd= — per-repo changed files + totals
  git/diff/route.ts                      GET ?cwd=&path= — unified patch for one file
  auth/all-providers|providers/route.ts  GET provider lists (OAuth)
  auth/api-key/[provider]/route.ts       GET/POST/DELETE API-key status/storage
  auth/login/[provider]/route.ts         GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts        POST OAuth logout
  cwd/validate|browse/route.ts           POST validate/select | browse a cwd
  default-cwd/route.ts                   POST create ~/pi-cwd-YYYYMMDD
  files/[...path]/route.ts               GET file contents for viewer
  uploads/route.ts                       POST 聊天文件附件上传（multipart files；落盘位置服务端定：lib/uploads-root.ts 的 <agentDir>/uploads/<yyyymmdd>/，同名不覆盖；25MB/个、100MB/次）
  file-index/route.ts                    GET per-repo ls-files + scattered files for fuzzy open
  health/route.ts                        GET server health
  home/route.ts                          GET { home, agentDir }：home = 真主目录（仅侧栏 displayCwd 的 ~ 缩短锚）；agentDir = 设置页无工作区/会话时的 settingsCwd 兜底锚（常驻白名单；homedir 不可当 cwd——它是所有白名单根的父目录，必 403）
  models/route.ts                        GET { models, modelList, defaultModel }
  models-config/route.ts                 GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog|discover|test/route.ts  pricing presets / upstream discovery / test
  plugins/route.ts                       GET/POST package plugin management
  project-trust/route.ts                 GET/POST untrusted-project extension gating
  skills/route.ts                        GET/PATCH loaded skills and disable-model-invocation
  skills/install|update|search|check/route.ts  install / update / search.sh / lockfile check
  worktrees/route.ts                     GET/POST/DELETE git worktrees

lib/
  abort-race.ts             raceAbort (promise vs AbortSignal, with onLateSettle cleanup) + creationTimeoutSignal — bounds session CREATION everywhere a startRpcSession hang would pin a turn/run (interactive create, kit round)
  session-host/                       THE in-process session host (2026-10 M1 single-process): the Next.js Node.js server owns every AgentSession
    registry.ts            session registry (globalThis) + AgentSessionWrapper + startRpcSession + subagent controller（自 lib/daemon/rpc-manager.ts 迁入；attaches the global built-in subagent extension + wires SUBAGENT_CONTROLLER；routes 一律经 facade 消费，不直接 import 本模块）
    facade.ts              typed in-process facade — createSession/sendCommand/probeSession/destroySession/autoNameSession/busyForCwd/reloadCwdSessions/liveSessions/runningStatus/getSubagentRunStatus/controlSubagent；SessionHostError(.status) owns error→HTTP mapping；live-first + cold-start-from-.jsonl revive（旧 daemon /v1/sessions 面的进程内移植）；CreateSessionInput 增 appendSystemPrompt/model 透传 StartSessionOptions（delivery 角色会话用——designer/developer，Phase-2/3）
    sse.ts                 Web-stream SSE（serveSessionEventStream/serveRunningEventStream/openSessionEventStream）——ByteLengthQueuingStrategy + desiredSize<=0 的 drain-aware stall cap（SSE_STALL_BYTES_DEFAULT 1MB：慢客户端只看未排水字节，健康观看者总量再大也不切断）；connected 帧先行、30s 心跳注释、destroy 即断流、req.signal 只取消订阅不碰会话
    heartbeat.ts           stall classify/warn/kill 纯逻辑（warn 5min / kill 20min，env PI_SESSION_STALL_*_MS）
    jobs.ts                HostJob {id,start,stop} + HostJobRegistry —— 宿主后台 job 注册表（静态装配，无运行时发现）
    loop-spawner.ts        LoopKitSpawner（HostJob loop-kit-heartbeats, 30s tick）+ runKitRound/waitForRoundSettle/settleRoundBookkeeping（D9）；deps 全注入；恢复门禁（pendingInterruption——未确认中断记录在场不起轮）；轮登记（markActive/clearActive，关停据此写中断记录）；reaper 默认 NO-OP（共享宿主禁 cwd 收割——destroy 定向杀，残余孤儿交恢复期只读探测）
    background.ts          ensureHostBooted（globalThis 单次装配：老 daemon 迁移守卫 → LoopKitSpawner + DeliveryDispatcher 并行懒加载链（Phase-2 T7 第二 HostJob，见 work-items/delivery-runner/dispatcher.ts）→ shutdown handlers；PI_TEST_NO_BACKGROUND=1 测试缝同豁免两个 job）+ markRoundActive/clearRoundMark/listActiveRounds（ActiveRoundInfo 泛化 kind: loop-round|delivery + itemKey——Phase-2；另 markDeliveryExecutionActive/clearDeliveryExecutionMark 对称原语）+ registerShutdownHandlers/buildShutdownPlan（关停序列：停新轮（stopBackgroundSafely 双 job）→ 快照 running → destroy 全部 → 写中断记录（loop 轮写 ExecutionRecord，kind=delivery 写 claim 中断——双产物）→ exit 0）
  workspaces/
    types.ts                WorkspaceManifest / WorkspaceCapability / WorkspaceRepository / templates
    service.ts              manifest CRUD, capability validation (ALL_WORKSPACE_CAPABILITIES), repos, index, managed AGENTS.md (repositories + knowledge segments); **ensureDefaultWorkspace** — 初始化时补建默认「默认」工作区（name 默认 / slug default，最小能力集，见 Workspace Subsystem 章；幂等 + 墓碑 `.pi-default-deleted`，removeWorkspace 删默认时写，删后永不复活；目录在磁盘未注册 → importWorkspace 自愈重注册）; **withWorkspaceWriteLock** = 双层写锁（进程内 Promise 队列 × file-lock.ts 文件层，见 Work Items 章锁条目）
    file-lock.ts            跨进程短写锁（2026-10 M2）：withWorkspaceFileLock（O_EXCL + owner token + stale 30s 抢占 + token 校验释放）+ resolveLockPath（目录 `.pi/.write-lock` / 文件 sibling `<file>.write-lock`）；busy → WorkItemConflictError(409)
    templates.ts            capability init constants (MANDATORY/INIT checklist, normalizeInitCapabilities) + renderWorkspaceAgents (capability-driven) + renderWorkspaceRepositories + renderKnowledgeSection + legacy built-in templates
    okf.ts                  OKF v0.2 structure constants + renderOkfSeed (index.md/log.md/example concept for newly init'd knowledge repos)
    kb-search/              opt-in L1 `kb_search` tool + pure-JS BM25 index (self-healing, cross-bundle)
      index.ts              ensureIndex() (mtime-incremental, .pi/cache rebuildable) + searchIndex() (Okapi BM25, CJK-aware tokenize)
      extension.ts          createKbSearchExtension() — `kb_search` InlineExtension (query/limit/filters), re-resolves active bundles per call
    extensions.ts           WORKSPACE_EXTENSION_FACTORIES + buildWorkspaceExtensions (tool modules；第二个 work-items 条目 = delivery-runner 工厂——build 内补 workflows 合取门，Phase-2)
    delivery-init.ts        交付初始化 + 就绪清单（final-arch step-6 T1，+测试）：initializeDelivery 六步只补缺只建议〔from 给定时第 0 步 assertFromPiLayout 布局前置校验（step-7 T2——任何写副作用之前，坏 from 纯 400 零落盘，copyFromSource 复用同检查作 TOCTOU 深防）→ 扫描对账 → delivery.yaml 缺失才写默认 → 剧本播种 → from 复制（seeded_from 换 copied_from，checks 剥 repositoryId 只进草稿）→ 工具链探测草稿 → 写后投影〕+ parseInitInput（形状 → Validation）+ deliveryReadiness（五类缺项只读投影 + currentTemplateVersion，宽容坏配置）——探测与 from 草稿永不落盘不执行、永不翻 enabled
    delivery-managed.ts     AGENTS.md delivery managed 块同步（final-arch step-6 T2，+测试）：DELIVERY_MANAGED_START/END 标记 + renderDeliveryManagedBlock + updateManagedDeliveryInstructions——有 workspace-managed:delivery 标记才改写（无标记 no-op、永不重建，机制同 repositories/knowledge 块）；PUT /delivery 与 POST init 成功后由路由层调用，失败 console.error 不挡操作（step-7 T2：读 AGENTS.md 的 catch 收窄——仅 ENOENT 静默 no-op，其他读错误 console.error 后照样放行）
    id.ts                   ULID generator
  work-items/
    types.ts                WorkItemRecord / phases（七阶段 delivery 扩展 + 老子阶段）/ events (incl. optional `external` source ref) / WorkItemImportOutcome / CreateWorkItemInput.enableDelivery / WorkItemBranchRef（branches 开发分支登记——只存分支名，合并状态实时派生）
    branch-status.ts        工作项 Git 分支状态探测（2026-10，只读永不落盘）：computeWorkItemRepoBranchStatus——单次 for-each-ref 取分支事实 + merge-base --is-ancestor 判已合入（目标 develop+master，全缺兜底 main）+ pi-delivery/<KEY>/* 交付分支识别（gen 升序）+ 候选提交核验；两层 30s TTL 缓存挂 globalThis（invalidateWorkItemBranchCache）；parseLocalBranches/resolveMergeTargets/deliveryBranchesForKey 纯函数有 node:test
    delivery-types.ts       DeliveryAction 12 个（含 answer-clarification）+ DeliveryMetadata（protocolVersion 1 / mode manual；designConfirmed/candidates/verification/release〔actor user|agent|system——system=引擎检查步，唯一机器证据〕/review〔final-arch step-3：DeliveryReviewRecord pass|rework+source code|spec〕/releasePlan/release/clarifications/lastRequest）+ contentDigest/candidatesDigest（sha256）+ parseDelivery（未知 protocolVersion/非 manual 硬错误；review parse 钉 pass 无 source、rework 必带 source 与非空 notes）+ DELIVERY_ACTIONS 权威表
    delivery.ts             标准交付流（2026-10 M2）：planDeliveryTransition（纯，digest 注入）+ applyDeliveryAction（锁内 + requestId 幂等 + design.md 播种）+ readDesign/updateDesignContent（design.md 编辑 + 失效回退）；re-export legalDeliveryActions
    delivery-runner/        交付自动执行（2026-10 Phase-2 designer 首角色 + Phase-3 developer 第二角色 + Phase-5 release-preparer 第三角色（纯文档，零配置变更）+ final-arch step-3 reviewer 第四角色 + 引擎 system 检查步（Phase-4 verifier 退役，checks 由 checks-step.ts 以 system claim 执行）——详见 Work Items 章「Delivery 自动执行」节；多槽位/依赖图/并行检查/验证环境预装/worktree 自动清理未实现，各角色跨角色共享单槽位/工作区与失败预算）
      roles.ts             交付角色词表单一事实源（seam-repositioning T1；final-arch step-3 T1 增 reviewer / T4 退役 verifier）：DELIVERY_ROLES 四活值（designer/developer/reviewer/release-preparer）+ DeliveryRole + isDeliveryRole（新写入面守卫）+ LEGACY_DELIVERY_ROLES（verifier）+ AnyDeliveryRole（活值 ∪ legacy——历史数据面读守卫）——刻意零依赖叶子模块（config 与 pool 共用，词表放任一侧即 config↔pool 循环）；pool re-export 保旧导入面
      config.ts             .pi/delivery.yaml 读写 + parseDeliveryRunnerConfig（seam-repositioning T1 v2：schemaVersion 输入 1|2 兼容、输出恒 2；roles 四键同形——键 ∉ DELIVERY_ROLES → Validation，legacy 键 verifier 接受并忽略 + 每进程一次 warn；enabled 缺省 false、budget 缺省 3/30、字段级 Validation；verification.checks[]——{name, repositoryId?, command, timeout_seconds? 1–3600} 人维护验证命令，name/command 非空，空数组/缺键=无配置=检查步 checks-empty；final-arch step-3 增 stages.review.enabled——缺块回填 {review:{enabled:false}}，解析后必有，未知 stage 键 → Validation）+ assertAutomationCapable（manifest 须含 work-items+workflows）
      pool.ts               多角色池子（Phase-3 合并双角色 / Phase-5 增 release-preparer；final-arch step-3 起 verification 按 reviewPending 分流）：projectDeliveryPool 纯投影（角色由阶段决定：rfi→developer、verification→reviewPending 分流〔欠审→reviewer、过审或 review 关→交给引擎 system 检查步，P2 语义落 designer wrong-phase 桶〕、release_ready→release-preparer、其余→designer；designer 谓词 managed∧enabled∧intake；developer 另加 designConfirmed 真值∧仓库范围非空∧每仓登记且 active（reason no-repo-scope/design-unconfirmed/repo-not-registered）；reviewer（step-3 T2，先审后跑）另加 stages.review.enabled 开启∧候选非空（no-repo-scope）——读代码与方案，非检查执行者；release-preparer（Phase-5）另加 verification 存在（verification-missing）∧candidateDigest 匹配现行候选（stale-verification——候选被换或被清）∧releasePlan 未存在（release-plan-exists 循环闸，已准备不再自动重派）；共用 无claim∧无中断∧未暂停∧失败未达上限∧status∈{open,blocked} 白名单∧未归档；多角色合并队列 P0→P3→key）+ listDeliveryPool 读取端装配（运行时信号 + contentDigest + manifest 登记仓表）+ reviewPending（review 开启∧候选集尚未 pass 审查——与 checks-step.checksDue / reviewer claim 复验共用的判定）+ readRegisteredRepos（checks-step due 扫描共用的登记仓表）
      worktrees.ts          developer 领取的 worktree 预建与候选核验（Phase-3 T2）：prepareWorktrees（分支 pi-delivery/<KEY>/gen<N>、仓旁 <repoRoot>-worktrees/ 目录、同代幂等复用、先整表登记复验、失败零状态已建不回滚）+ verifyCandidateCommits（rev-parse ^{commit} 核验，ref 非 40-hex 也接受）；Phase-4 T2 增 prepareVerifyCheckouts——候选 detached checkout（pi-verify/<KEY>/gen<N> 仓旁目录，两步法 addWorktree+checkout --detach 候选 commit；同代幂等=目录在场仍 checkout 目标 commit（半建修复）；失败零状态不回滚、不自动清理；final-arch step-3 起消费方 = reviewer claim 与 system 检查步）
      checks.ts             服务端验证命令执行器（Phase-4 T2）：runConfiguredCheck——spawnSync 经 /bin/sh 在候选 checkout 内执行配置命令（timeout 缺省 600s；exit 0=passed / 非 0=failed（shell 127 缺命令同）/ spawn error（超时/ENOENT/ENOBUFS）=unverified+exitCode null）；日志 stdout/stderr 各尾部 32KiB 分节原子写 <logDir>/<safeCheckName(name)>.log，logRef=相对工作项根 POSIX 路径；CheckEvidence {name, exitCode, durationMs, logRef, outcome}——LLM 自述不构成证据的唯一正源
      checks-step.ts        引擎 system 检查步（final-arch step-3 T3，verifier 退役后检查执行的家）：checksDue 纯谓词（due ⇔ managed∧enabled∧phase=verification∧候选非空∧checks 非空（checks-empty）∧仓解析门（repo-not-registered）∧reviewPending 过审门（awaiting-review）∧checks-done（同 digest 验证记录在场不重跑）∧状态门（blocked-awaiting-unblock——unverified 落 blocked 后人 unblock 才再 due；in_progress=unblock 落点；open 直跑；其余 terminal）∧共用门〔无claim/无中断/未paused/未归档——失败预算刻意不是本步的门〕，原因累积不短路）+ checksCandidatesFor（due 扫描装配，P0→P3→key）+ runChecksStep 三段事务（锁1 复验 due→prepareVerifyCheckouts 候选 checkout 预建〔失败=零状态〕→写 system claim〔role "system"、sessionId "system:<ulid>"、无 ownerToken——sessionId 归属校验替代〕→in_progress+delivery.checks_started→commit；锁外 逐条 runConfiguredCheck+recordCheckResult；锁2 归属/阶段/候选 digest 三守卫后 finalizeChecks(actor "system")：全过→delivery.verification+release_ready+checks_passed / 有失败→reworkTransition 清下游证据+rfi+checks_failed / unverified→blocked+checks_unverified〔阶段不动下游不清〕；三者清 claim+attempt〔role system、outcome submitted——全步零失败预算〕+commit；integrate 集成段〔final-arch step-4：checks 全过∧stages.integrate.enabled → 结算前锁外按 claim.worktrees 冻结序逐仓 bash -c 执行集成命令〔cwd=该仓 checkout、{repositoryId}/{branch} 占位符、单仓 INTEGRATE_TIMEOUT_MS=600s、首败短路〕，任一失败→专属终局 "integrate-failed"：blocked+delivery.integrate_failed+attempt outcome integrate-failed——不写 verification、不进失败预算，人 unblock 后整回合重跑〕；异常 recordInterruption 后重抛；启动失败表面化〔step-7 T1：claim 写入前失败（如候选 sha 解析不开）→ recordChecksStartFailure 锁外追加 delivery.checks_start_failed（actor system，data reason 首 300 字符 + candidateDigest?；去重 = events 末条同类型同 digest 跳过——连续失败串一条、digest 变化再武装；events 读不出跳过、永不抛——不改重试语义零状态）〕）
      attempts.ts           claim.json/automation-paused/failure-window（runtime/ advisory 运行态，claim 首写时幂等接进 .gitignore；宽松读；claim role 词表 = AnyDeliveryRole | "system"〔活值 ∪ legacy verifier 原样可读 ∪ 引擎 system 步〕；reviewer/system claim 另附 candidateDigest/checkContexts/checkResults 证据仓；Phase-5 release-preparer claim 只附 candidateDigest 快照）+ attempts/ 追加审计（reviewer submit 附 review 判定全量 + verificationOutcome（verified|rework|unverified）随 system 步落全量 checkResults；release-preparer submit 附 releasePlan 审计拷贝）+ resolveInterruptions + countRecentFailures（自最近 resume 起的尾部连续失败，遇 submitted 断）+ ownerToken 只存 sha256（hashOwnerToken）
      claim.ts              领取事务（designer + developer + reviewer + release-preparer 十二函数共用骨架；final-arch step-3 T2 reviewer 三函数接替退役的 verifier 三函数，另抽共享 reworkTransition 与 finalizeChecks）：claimDesignerTask（intake→design + design.md 播种）/ claimDeveloperTask（worktree 预建先于状态落盘 + designDigest 快照，rfi→implementation）/ claimReviewerTask（step-3 T2：候选 detached checkout 预建 + candidateDigest/checkContexts/checkResults 冻结，phase 不变；谓词 = reviewer 投影——review 开启且候选集欠审）/ claimReleasePreparerTask（Phase-5：无环境预建零 git + candidateDigest 快照 + phase 不变）/ submitDesignerResult（等人 confirm）/ submitDeveloperResult（双 digest+designConfirmed+phase 门复验 + 候选核验 → M2 submit-verification 语义内联进 verification）/ submitReviewerResult（step-3 T2：candidateDigest 复验+阶段守卫+designConfirmed 在场守卫 → 写 delivery.review〔pass 无 source / rework 必带 code|spec + notes〕；pass=phase 不变 status open、rework=reworkTransition 打回且 review 保留 + delivery.reviewed + attempt submitted 携 review——判定无失败预算）/ submitReleasePreparerResult（Phase-5：candidateDigest 复验+released 冻结守卫+verification 在场守卫 → 写 delivery.releasePlan[M2 prepare-release 语义 actor=agent]、phase 停 release_ready、永不写 delivery.release——record-release 是人）/ failDesignerTask|failDeveloperTask（回退守卫 design→intake / implementation→rfi）/ failReviewerTask|failReleasePreparerTask（phase 不动；reviewer fail 照常计预算）+ reworkTransition（step-3 T2 唯一「回退+清全部下游证据」实现：designConfirmed/candidates/verification/acceptance/releasePlan 清空〔acceptance 为 final-arch step-4 增补——验收随候选集失效〕、review 保留——禁第二份清单）+ finalizeChecks（step-3 T3：system 检查步与结算共用——verified→verification+release_ready / rework→reworkTransition / unverified→blocked）+ askHumanQuestion（step-2 四角色问人事务）+ recordCheckResult（heartbeat 习语证据累积）+ freezeCheckContexts（reviewer/system claim 共用快照冻结）+ heartbeatActiveClaim（20s 续约）+ recordInterruption + resumeAutomation
      role-grants.ts        globalThis 单例角色授权表（grantRole/revokeRole/roleGrantOf/setGrantToken——token 只进进程内 grant；hasAnyActiveExecution 裸授权即占槽）
      tools.ts              delivery_list_ready_tasks/claim/submit/fail/run_check/ask_human 六工具（pi-delivery-runner extension；claim/submit/fail 按 grant.role 分派 designer/developer/reviewer/release-preparer 四路服务〔step-3 T4 增 reviewer 三入口、退役的 verifier 分派已删——system 检查步不经工具〕，submit 扁平可选字段组（union/any-of schema 被 SDK 调用侧解析毁掉，禁用）服务端按角色校验（reviewer outcome/source/notes 三元组；release-preparer release_notes 必填/rollback_notes 可选），claim 结果 developer/reviewer 附 worktrees 清单 + reviewer 附 checks 冻结清单（designer/release-preparer 无此二键）；run_check（Phase-4 起，final-arch step-3 T4 身份门 = reviewer——原 verifier 专属随角色退役换门）：按冻结快照找配置 → 候选 checkout 服务端 runConfiguredCheck → recordCheckResult 累积（同名覆盖）——产物只是评审佐证，机器证据唯一来源是 system 检查步的 delivery.verification；身份=ctx.sessionManager.getSessionId()+grant 核对，无 grant → denied 文本；凭证不进参数 schema；人工动作面（confirm-design/record-verification/record-acceptance/prepare-release/record-release 等）刻意不做工具）
      role-session.ts       launchRoleSession 终形（seam-repositioning T2）：AGENT_INVARIANT_CONTRACT（四角色一致回合不变式，六条全文钉于终局 spec §4.3.1——lib 常量不可覆写，改文先改 spec）+ composeRoleSystemPrompt（不变式 + 剧本正文，空白正文按缺席）+ resolveRoleProfileName（roles.<role>.profile ?? 角色名，缺省同名）+ readRoleProfile（<ws>/.pi/agents/<profile>.md → {model?, body, seededFrom?}，只读工作区目录、缺文件/非法名 → undefined）+ openingPromptFor（四角色通用四步，仅 role 字样不同）；模型优先级 roles.<role>.model → 剧本 frontmatter model → 默认，剧本缺场 warn 后仅不变式开场、读盘异常当缺场；四段角色专属合同与 readDesignerProfileModel 已删（角色差异全归剧本）；两步创建（sessionId→grantRole 先于 prompt→登记→命名 `${role} · KEY`→开场 prompt）+ 20s 心跳 + 结束钩子（onDestroy：launch key 快路径 ∪ 全活动项 claim 扫描兜底 → recordInterruption → revoke/clear）
      role-templates.ts     四角色默认剧本模板与一次性播种（seam-repositioning T3 + final-fix A；final-arch step-3 T4 起 ROLE_TEMPLATE_VERSION 2——全角色模板随 reviewer 上岗重写，seeded_from "<role>@2"，@1 的工作区不再被覆盖）：ROLE_PROFILE_TEMPLATES（frontmatter name/description/seeded_from "<role>@<version>"，正文 = 干活内容——不变式归引擎、工作区专属事实不进通用模板）+ seedRoleProfileTemplates——每角色只播一次，记录在产品持有的 <ws>/.pi/delivery-seeded.json（{schemaVersion:1, roles}）：已记录 → skipped（删了不重建，删除即终局）；未记录且文件在场（wx EEXIST 同）→ 收养记 "existing"、永不写；未记录且缺文件 → writeFile flag "wx" 写模板（其它错误照抛）、记 "<role>@<version>"；记录不可读/畸形 → fail-safe 一字不写、全 skipped + console.error 一次；记录变更经 writeAtomic 回写。PUT /delivery 写入成功后由路由层调用（播种自身 try/catch，失败降级 seeded:null+seedingError），返回 {written, skipped}；模板可被 lib/subagents 的 parseProfileFile 解析（.pi/agents 双用途目录）；final-arch step-6 T3 增 writeRoleTemplateCopy——模板另存副本 <role>.template.md（wx 写即全新、已存在 WorkItemConflictError→409，永不碰 <role>.md 与播种记录），POST …/roles/[role]/template 路由消费
      role-preview.ts       角色摘要与组合预览只读投影（seam-repositioning T4 + final-fix C/D）：summarizeRoles（DELIVERY_ROLES 序四行——剧本名/路径/在场/显式/seededFrom + 有效模型与来源 override|profile|default，优先级与 launch 同序；config null 按全缺省）+ previewRolePrompt（摘要 + AGENTS.md 全文〔仅展示〕+ 不变式 + 剧本正文 + composed——与 launch 的 appendSystemPrompt 同一函数，key 占位 <KEY>）；复用 role-session 的读取器，每投影恰一次读盘（摘要与预览共用同一次读取）；读盘异常 → console.error 一条后按缺场（与 launch 同口径），ProjectionDeps.readProfile 为注入缝；客户端镜像类型在 lib/api-types.ts
      dispatcher.ts         DeliveryDispatcher（HostJob delivery-dispatcher，30s tick，顺序固定 = 超时清道夫[claim.claimedAt 起算超 maxExecutionMinutes → probe 活则定向 destroy + recordInterruption；死会话仍记录；system claim 无会话只记中断] → system 检查步[final-arch step-3：checksCandidatesFor due 扫描 → 首个 due 项 runChecksStep fire-and-forget，开跑本拍 return 占槽] → 单槽位派发[activeExecution = 内存 grant ∪ claim 扫描，跨角色共享；合并队列取首、按 entry.role 起 launchRoleSession] → attention 催办/泊车）
    attention.ts           attention 队列投影（final-arch step-2 T5；final-arch step-4 增 acceptance 类；step-7 T1 增检查步启动失败锚 + 泊车抑制）：projectAttention 纯投影（零 fs——五类锚点 question=最早未答 clarifications 的 askedAt+clarificationId / confirm=design 未确认 / release=release_ready 未发布 / acceptance=stages.acceptance.enabled∧release_ready∧候选非空∧〔无 delivery.acceptance ∨ 摘要≠现行候选〕〔「待人工验收」——验收记录落地即消失、候选换过重现，enabled 标志由 collectAttention 注入纯投影〕 / blocked=六信号最新事件〔delivery.block·checks_unverified·integrate_failed·checks_start_failed·automation_paused·exec_interrupted；checks_start_failed 锚不拘 status（step-7 fix round 1——启动失败零状态不改 status，open 的 verification 项也出条目；新鲜 = 事件无 digest 或 digest 合当前候选 ∧ 该候选集未验证通过〔checks-done 同源门〕，currentStartFailure 判定）〕；nudged/parked = 晚于 since 的同 kind delivery.nudged/parked 事件判定〔blocked 的 parked 例外 = hasAnyParkedSince 任意 kind 晚于 since 即真——attend 两分支以 !parked 为门，跨 kind 抑制重复催办/泊车〕；P0→P3→key 序）+ collectAttention 读取端（managed 项才付详情读，读失败跳过宁缺勿错）——GET …/attention 路由与 dispatcher attend 共用；类型单一定义处 = api-types（此处 type-only 引用再 re-export）
    legal-actions.ts        legalDeliveryActions / legalActionBarActions 的 client-safe 家（纯类型导入，详情页动作条不拖 node:fs 进浏览器 bundle；delivery.ts re-export 保服务端消费面）
    errors.ts               错误类叶子模块（Validation/Conflict/NotFound）—— service/delivery-types/file-lock 共用，web.ts 的 instanceof→HTTP 映射要求同一 class 身份（service.ts re-export）
    service.ts              item.yaml + README.md + events.jsonl CRUD, revision locking, key reservation, import dedup (findExistingByExternal: active ∪ archived ∪ trash; createWorkItem 锁内查+建, returns { detail, importOutcome }), managed 门禁（PATCH phase/status 400）+ released 冻结 + 失效回退（updateWorkItemContent）, trash/restoreWorkItemFromTrashInRoot
    extension.ts            pi extension: list/get/create/update/record-milestone tools（managed 门控：list 默认排除标准流程项 include_managed opt-in + managed 标记；get 附标记；update 不绕 service）
    store.ts                per-workspace 共享 snapshot 缓存（module 级 Map + listener + shouldRefetch 5s 年龄门）—— 中央页与右坞快捷面板同缓存，纯数据层（fetch/轮询在 hooks/useWorkItems）
    web.ts                  error → HTTP mapping
    source-labels.ts        UI-safe source→中文标签 map (禅道) — 外部源脚本盖章的来源展示
  loops/                             web-side loop control + prefill resolution (loop-surface spec §3–§5; imports pi-loop pure logic, no host-side deps of its own)
    lookup.ts              findKitLoopByName — loop 名→declaration（name 字段优先，回落目录名；绑定存名，文件操作以 dir 为准）
    rounds.ts              stopRound / launchManualRound（依赖全注入：facade createSession/sendCommand/destroySession + 可选 reap + runningSessionIds）+ RoundBusyError —— 全走进程内宿主 facade（launch 两步建会话，stop 定向 destroy+释放锁；无 HTTP 往返）；手动轮锁保持持有靠 stale 窗（maxMinutes+15min）回收，无 D9 钩子；幽灵锁活性接管（isPhantomRoundLock + PHANTOM_LOCK_GRACE_MS 2min 宽限，见 Loop 章）：带 sessionId 的宿主锁不在 running set 即清锁重取（launch）/直接清锁返回 stopped（stop）
    executions.ts          执行中断记录（spec §5.4）：ExecutionRecord（kind loop-round / runId / loopName / sessionId / workspacePath / host{pid,hostname} / startedAt/stoppedAt / stopResult interrupted-on-shutdown|recovered-auto|recovered-manual|confirmed-dead / needsAttention / diagnostic）+ writeExecutionRecord（tmp+rename 原子写）+ listPendingExecutionRecords（恢复门禁数据源）+ resolveExecutionRecords + detectSurvivingRoundProcesses（只读探测残留进程：ppid=1 + build/shell 命令 + cwd ∈ workspace）
    contract-prefill.ts    resolveContractPattern（纯函数）：工作项绑定 loop 名 → pattern（paused = 不存在；未命中/未绑定且恰 1 个 active → 该 loop；≥2 个 active → undefined 不猜，防误路由到不消费工作项的 loop）
    cron-summary.ts        summarizeCron（纯函数）：cron 人话摘要（常见形态；其它 → null，UI 回落原始 cron）
    manage.ts               loop 配置面服务端逻辑：getLoopDocs/writeLoopFile/createLoop/deleteLoop + 守卫（白名单/原子写/mtime 并发/锁活/绑定扫描）
  subagent-child.ts          subagentChild tagging by `pi-subagent-` id/name prefix (both eras: builtin children keep the prefix)
                             (id/name prefix `pi-subagent` — the only child-detection mechanism)
  (dev-loop/ retired — loops are per-workspace custom definitions; the R&D loop pattern lives in cxin-workspace, see Dev Loop section above)  git-changes.ts            getGitStatus (multi-repo groups) + getGitFileDiff (patch)
  git-status.ts             porcelain-v1 parse, status classify, buildRepoGroups (pure)
  git-discover.ts           walk tree to find nested repo roots (+ scattered files for file-index); IGNORED_NAMES prunes
                            node_modules/dist/… and `.pi` — the latter can hold the relocated pi data home (dozens of
                            nested git repos, GBs) inside a project tree; a workspace's own `.pi/` never contains `.git`, so
                            pruning costs nothing on the normal path
  git-types.ts              GitFileStatus / RepoGroup / response shapes
  chat-scroll-follow.ts     聊天流式跟随的滚动决策状态机（纯逻辑 + 测试，`useAgentSession` 挂监听共用）：上滑判定先于近底恢复 / 0.5px 阈值 / touchmove 刷新意图窗 / 近底恢复需佐证（跟随中 ∣ 意图新鲜 ∣ scrollTop 增大）
  shell-is-mobile.ts        mobile-shell 路由决策（纯函数 + 测试，`useViewportIsMobile` 消费）：①视口≤640 ②UA 手机种子不降级（宽视口手机：横屏/折叠/记住的缩小） ③纯触屏设备（pointer:coarse 且无 any-pointer:fine，兑住「电脑版网站」改写 UA+撑宽视口）→ mobile，否则 desktop
  session-tabs.ts           会话 tab 模型纯逻辑层（+测试）：SessionTabState（session/new-session/workspace-home 三种 kind，id 前缀 s:/new:/ws:）、createX 工厂、resolveOpenSessionTarget（C1 分派）、findReusableNewSessionTab（占位去重：同工作区 + 空草稿谓词注入）、nextActiveTabId（X1 邻居回落）、contextCloseTargetIds/nextActiveAfterBatchClose（右键批量关闭：其他/左侧/右侧目标集合 + 批量版 X1 激活回落）、tabQuery（URL 投影）、serializeTabs/parseStoredTabs/restoreTabs（R2 持久化，失效 id 静默跳过）
  tab-types.ts              Tab 类型（file/session 文件 tab）+ 右坞 rail 模块 id（FILES/LOOPS/KNOWLEDGE/WORK_ITEMS/TERMINALS_TAB_ID + MODULE_TAB_IDS/isModuleTabId，+测试；2026-10 rail 改版：模块激活走 dockRailMap，activeFileTabId 回归纯文件语义）——从 TabBar.tsx 下沉到此供 lib 层引用
  work-items-page-url.ts    中央工作项管理页深链（+测试）：`?workspace=<id>&page=work-items[&item=<key>]` 的 build/parse 同居模块；builder 返回裸 query（navigateUrl 契约，带 ? 会拼出 `??` 杀死深链）；解析先于 applyUrlToTabs 的 tab 投影（页面是 CenterPage 不是会话 tab）
  dropdown-layout.ts        body-portal 弹层定位（纯函数 computeMenuLayout + 测试，SessionTabBar 右键菜单与 WorkspaceSwitcher 共用）：top/right/maxHeight 一律钳进可视窗口（visualViewport 换算，scale=1 时即普通视口）——锚点被横向滚动裁剪出屏（rect.right > innerWidth 曾使 right 为负、菜单整体滑出屏幕右缘，2026-09 手机端报告）或贴左锚点向左生长被中栏 overflow:hidden 裁剪（2026-09 PC 端工作台切换器报告）都不再把菜单推出可视区
  session-reader.ts         index-backed SessionInfo mapping + buildSessionContext (tail window) + buildEarlierContext + path caches
  session-payload.ts        buildSessionsPayload — the /api/sessions payload builder shared by the route and the SSR prefetch in app/page.tsx（方案二首帧真数据；live 合并 best-effort = 同进程 facade liveSessions/runningStatus，无传输可失败；daemonDown 恒 false，字段保留仅为客户端兼容）
  session-index.ts          persistent mtime-incremental session index (~/.pi/agent/sessions/.index.json, active + .archived; rebuildable cache)
  session-changed-files.ts  PURE deriveSessionChangedFiles — files written/edited in a session from the message stream (write/edit toolCalls; relative `file_path` args resolved against session cwd so openFile passes the /api/files allow-list; NOT git state; survives commits); isEditToolName consolidated here
  session-archive.ts        move .jsonl to/from .archived/ to hide/restore sessions
  archive-cascade.ts        work-item archive ↔ session archive bridge
  worktree.ts               project/worktree resolution (worktree→main repo) + git worktree ops
  file-access.ts            allowed file roots for /api/files, /api/git, worktrees；根 = 会话 cwd/projectRoot + ~/pi-cwd-* + 内存附加根 + 常驻 uploads 家 + 常驻 agent 目录（全局设置页 cwd 锚）+ workspace 索引路径
  agent-client.ts           typed fetch helper for /api/agent commands
  agent/                    agent event reducer + helpers + types
  stores/                   models-store, session-messages-cache, session-runtime-store, file-resource-cache, map-store
  sse/global-agent-events.ts  global running-session event fan-out
  types.ts, normalize.ts, tool-presets.ts, api-types.ts  shared types + toolCall normalization + presets
  model-catalog.ts, model-discovery.ts, models-cache.ts   model list/discovery/caching
  markdown.ts, ansi.ts, compaction-summary.ts, message-display.ts   rendering helpers
  file-paths.ts, file-types.ts, file-fuzzy.ts, file-index.ts, file-links.ts   file viewer/open helpers
  chat-attachments.ts       聊天文件附件纯逻辑（+测试）：AttachedFile / MAX_ATTACHED_FILES(10)、25MB 限制、appendAttachmentReferences（发送时把 `[附件 name](abs path)` Markdown 链接追加进消息文本——渲染端可点击、模型读原始路径）
  uploads-root.ts           附件上传家（server-only）：chatUploadsRoot（<agentDir>/uploads，git 外不污染仓库）/ sanitizeUploadFileName / buildUploadDestination（<yyyymmdd>/<HHmmss>-<rand6>-<name>）/ writeUploadFile（mkdir -p + wx 不覆盖）；getAllowedFileRoots 常驻含此根（lib/file-access.ts）→ 附件链接可经 /api/files 预览
  home-quick-switch.ts       首页快速切换纯逻辑（groupSessionsByWorkspace 的 orderBy:"workspaces" = 保持输入序，桌面项目树手动排序用；默认 activity 序服务移动端首页）：workspaceForSession（最长前缀归属）/ groupSessionsByWorkspace（按工作区分组+活跃度排序，排除 subagentChild 与无归属）/ defaultHomeNewSessionWorkspaceId（最近会话所属 → MRU tab → 第一个可用），有 node:test 覆盖；选择谓词统一 isWorkspaceSelectable（lib/workspaces/types.ts，available && !disabled——停用工作区首页不可见）
  format-time.ts             formatRelativeTime — 会话列表相对时间（首页分组列表共用）
  patch.ts, project-trust.ts, request-security.ts, path-security.ts, http-dispatcher.ts   security + routing
  npx.ts, skill-lock.ts, skill-message.ts, skills-service.ts, skill-updates.ts   skills/plugins plumbing (skill-message.ts also powers session titles: `skillMessageTitle` reduces pi's `/skill:` expansion wrapper — `header + SKILL.md body + </skill> + args` — back to the args or `/skill:name`, incl. a truncated-wrapper fallback for pre-v2 index clips; used by the session index, session-reader, locate route, auto-name, MessageView)

packages/pi-loop/                      THE loop-host package: pure protocol logic + beat CLI (design: knowledge/designs/pi-loop-host-design.md; npm workspace, independent package.json for future publish, imported by relative path — see Loop section)
  protocol.ts             LoopDeclaration / parseLoopDeclaration / discoverKitLoops (.pi/loops/*/LOOP.md frontmatter; PAUSED skipped) / isWorkspaceHalted (loop-pause-all) — pure fs+yaml, standalone (no pi-web/host deps); the web loops route imports it too
  cron.ts                 cronMatches (Vixie-cron matcher with timezone, never throws on bad input) + nextDue (first cron hit after a moment, minute granularity) — the fire judgment's clock
  round-lock.ts           .round.lock cross-host round mutex — acquire/read/update/releaseRoundLock + isRoundLockStale（唯一权威公式）; O_EXCL atomic create, stale = 无 sessionId 且 pid 死（启动窗口/beat 轮）或超 maxMinutes+15min 窗（带 sessionId 的锁一律窗口治理——web 手动轮锁 pid=web 进程，web 重启不得触发心跳双发）
  due.ts                  .lastrun machine truth (host-written ISO timestamp; STATE.md Last run stays narrative) + shouldFire = now >= nextDue(cron, tz, .lastrun) — anacron-lite catch-up (at most one round after downtime)
  contract.ts             buildRoundPrompt — opening-contract assembly shared by the in-process host spawner (with sessionId, D9) and beat (without); D13 ledger path is per-loop
  fire.ts                 runDueRound/runNow — the unified fire sequence (acquire lock → re-check shouldFire in-lock → write .lastrun → run → finally release); host tick and beat share it, cross-host TOCTOU-safe
  beat.ts                 beat round runner — spawns `pi --name "<loop> · <slot>" -p --approve "<contract>"` (cwd=root, detached own process group); max_minutes timeout → group SIGTERM→3s→SIGKILL
  cli.ts                  pi-loop CLI entry (bin) — beat/run/stop/pause/resume/status/init/watch commands (host spec §4)
  status.ts               collectStatus — per-loop frontmatter summary + .lastrun + next-due + running (lock alive) / paused for `pi-loop status`
  init.ts                 initLoop — scaffold the kit/templates/basic five-piece set (D13 layout: loop/ + root/ + skill/) + SKILL.md skeleton; writes .lastrun = now (first round waits for a natural slot)

kit/                                  pi-loop kit template library + protocol README (consumed by copy, not imported — see Loop section)
  README.md                       the protocol contract: file layout (incl. host files .lastrun/.round.lock, agent-forbidden), host section (宿主自动心跳 / pi-loop beat + crontab, dual-host lock safety, catch-up semantics), L1/L2/L3 levels, breaker + budget rules, GitHub Actions scenario
  templates/basic/               D13 two-level layout — loop/ {LOOP.md, STATE.md, loop-ledger.json} + root/ {loop-constraints.md, loop-budget.md} + skill/ {SKILL.md skeleton, spec §4}; pi-loop init scaffolds from here
  templates/github/loop.yml      GitHub Actions cron heartbeat template (pi -p + community subagent package)

components/
  AppShell.tsx              thin dispatcher: useAppShellState → AppShellProvider → DesktopShell|MobileShell by viewport（MobileShell 再按 768px 把 <768px 委托 MobileTabShell）+ shell-agnostic overlays (create-workspace wizard, DirectoryPicker, ProjectTrustDialog)
  shell/
    useAppShellState.ts     the shared shell-state hook — SESSION-keyed tabs（lib/session-tabs 模型：openSessionTab/openNewSessionTab/ensureHomeTab/closeTab + C1/X1/U1/R2 语义）, URL restore, sessions, SSE wiring, panel selection/persistence, run-contract composer prefill (D11), dockRailMap（右坞 rail 激活模块+展开态 per-workspace 持久化，pi-dock-rail）; NO isMobile branches (mobile intents = chatFocusKey/panelFocus signals)
    context.tsx             AppShellProvider/useShell — the shells consume the shared state
    DesktopShell.tsx        the desktop render（2026-09 树形侧栏改版；同月首页退役：空态自动落回当前项目家 tab（desktopCloseTab + 空态 effect，同移动端），HomeNewSession 首页页只在零可用工作区时接手引导）：ProjectSidebar（可拖宽/折叠，复用 sidebar-container 类）+ center（ChatToolbar + SessionTabBar + CenterPage/总览/聊天）+ right dock（2026-10 rail + 同月用户反馈微调：36px 常驻纯 icon 图标列 文件/Loops/工作项/知识库/终端 + 展开面板，缺省收起、展开默认最小宽 336，dockRailMap 驱动；终端 tab 状态与 activeTerminalId 也归本组件）；中央区整页渲染分派在本组件（renderCenterPage）
    MobileShell.tsx         the tablet shell（≥768px；2026-10 底部 tab 改版后 <768px 整体委托 MobileTabShell，`if (!wide) return <MobileTabShell />` 放全部 hooks 之后；knowledge/designs/mobile-drawer-design.md 文末补充记录）：ProjectSidebar 常驻贴左（showPermanentTree，headerSlot 头部模块条 总览/文件/工作项/知识库/Loops）+ ChatToolbar（navToggle="hidden"）+ 全屏主区（聊天持久挂载；mobilePage 目的地页 overview/files/work-items/knowledge/loops/settings/archive，‹返回=回聊天，backLabel="聊天"）；旧抽屉 JSX / Android 抽屉陷阱 / 边缘右滑三段已删（抽屉只在 <768px 存在，平板零改动）；空态自动落回 = openNewSessionTab(target,{replace:true}) 占位 composer（wide 门控）；HomeLanding 只剩零可用工作区引导宿主；搜索深跳转 searchTarget 壳自有（同 DesktopShell）
    MobileTabShell.tsx      the phone shell（<768px，2026-10 底部 tab 改版）：底部 3 tab 会话/Skill/设置（.mobile-tabbar，唯一定期导航，任何推入页都隐藏它）；会话 tab 首页 = <ProjectSidebar phoneHome>（复用桌面「项目」分组体：折叠 pi-tree-collapsed / 彩色头像 / 每组 5 条+显示更多 / # 分组 / 长按排序全部继承；头像 → 工作区页）+ 页脚停用/不可用工作区入口（→ 工作区设置）+ 顶栏 会话/搜索(SearchPalette)——无 ⋯（模块入口下沉到二级工作区页 ⋯ 与三级聊天页 ⋯ 工作区组）+ FAB 新建；推入栈 pushStack（kind chat|workspace|files|work-items|knowledge|loops|archive|ws-settings + workspaceId；组头头像→工作区页〔MobileWorkspacePage：‹+名+⋯〕，会话行→聊天页〔ChatToolbar onBack〕；tab 切换清栈，‹ 弹一层，replaceTop 供工作项→Loops 恢复，Android 返回键 piMobilePushPage 陷阱态）；聊天层持久挂载最底，chatFocusKey=推入聊天；work-items 深链 presence→push + deeplink 标记 + closeWorkItemsDeeplink URL 回写（与 MobileShell 同契约）；Skill tab = MobileSkillsList 根页 + 推入 skill-detail / skill-install（useMobileSkills 挂壳层，三页共享状态）；设置 tab = SettingsPanel phoneTab（PhoneSettingsIndex）；工作区设置推入页用局部 selectWorkspaceRequest 驱动 WorkspaceManager；零工作区 = HomeLanding 住会话 tab、设置 tab 天然可达；文件/会话查看 overlay 同款
    MobileWorkspaceSettings.tsx 手机推入页：单个工作区的设置（2026-10-26 用户反馈重做，替代内嵌桌面 WorkspaceManager 双栏）：hero-lite（头像+名+状态 pill）+ 基本信息（名称行内编辑保存 / 路径 / 启用 MobileSwitch——停用=首页与选择器不出现、已开会话不受影响，重启用路径）+ 能力只读 pills（创建时选定，与桌面一致）+ Skill 入口（切 Skill tab）+ 仓库卡片（GET ?refresh=1，行=名/路径/git 状态，停用〔window.confirm〕/恢复）+ 交付自动化只读摘要（GET /delivery enabled + GET /delivery/roles 四角色 剧本名·模型）+ 从列表移除两步确认（DELETE 仅注销）。PATCH 全带 expectedUpdatedAt、409→重拉；响应 workspace 由壳合并进列表
    MobileWorkspacePage.tsx 手机二级工作区页（2026-10，用户反馈重做）：顶栏 ‹ + 名 + ⋯（文件/工作项〔门控〕/知识库〔门控〕/Loops/工作区设置——原首页 ⋯ 下沉至此）；正文 hero（workspaceAvatarStyle 彩色首字头像 56px + 路径 + 会话数 accent pill + 能力 pills）→ 新建会话主按钮（openNewSessionTab）→ 「会话」卡片（WorkspaceSessionList showHeader=false，空态文案）→ 「更多」卡片 已归档会话 ›；会话数按 workspaceForSession 归属且排除 subagentChild
    useMobileSkills.ts      手机 Skill tab 数据层（2026-10；同月收敛：工作区 skills 白名单拆除，启停只有全局 frontmatter 一档）：与 SkillsConfig 同一套后端契约——GET /api/skills?cwd（全量：全局 + 当前 cwd 项目层）、启停 PATCH /api/skills {filePath,disableModelInvocation}（写 SKILL.md frontmatter，全局生效）、POST /api/skills/{check,update,search,install}；导出 skillSourceLabel / groupSkills（与桌面逐字同构的分组序，组内启用优先）/ skillUpdateKey / displaySkillPath；无卸载端点
    MobileSkillsPages.tsx   手机 Skill 三页：MobileSkillsList（标题行 作用域 + 检查更新角标 + 安装 / 本地筛选 / 分组卡片行 = 名+描述+有更新徽章+开关，点文字区进详情）/ MobileSkillDetail（描述 / 启用开关 / 位置·包·skills.sh·版本〔检查·更新〕/ 项目 skill 查看 SKILL.md 走文件查看器）/ MobileSkillInstall（全局·项目作用域 segmented + 目标目录 + skills.sh 搜索 + 结果安装〔已安装标记〕）
    MobileWorkItemsPages.tsx 手机工作项三页（2026-10，knowledge/designs/mobile-work-items-design.md）：MobileWorkItemsPage 列表根页（MobileNavBar ‹+工作项+＋ → MobileSearchField → 活动|归档|回收站 分段 → 筹片形态原生 select 筛选〔持久化 pi-work-items-filters:<wsId> 与桌面互认〕→「需要你处理」琥珀带〔attention 队列，refreshToken=快照 fetchedAt〕→ 进行中/待处理/已阻塞/已结束〔折叠〕分组；标准流程项带七段阶段轨迹 PhaseTrack，老流程项只显 phase 文案；没拿到快照=骨架屏〔loading 初值 false，按它判断会闪假空态〕）/ MobileWorkItemDetailPage（‹ 工作项+KEY；WorkItemDetailView hideClose；useDeliveryExecution；草稿 ‹ 前 confirm）/ MobileWorkItemCreatePage（WorkItemCreateForm + POST 流，onCreated(key) → 壳 replaceTop 成详情）；深链 &item= 一次性消费推详情，推详情/‹/返回键同步 URL
    mobile-ui.tsx           手机壳 iOS 风格列表原语（Skill 三页与设置索引共用）：MobilePageTitle / MobileIconButton（角标）/ MobileSection / MobileCard / MobileRow（可选图标瓷片 + 主副文案 + hint + › / trailing 独立触控）/ MobileSwitch（role=switch）/ MobileSearchField / MobilePill / MobileNote / MobileEmpty / Primary·Secondary 按钮 / MobileErrorBanner；全部主题变量
    ChatToolbar.tsx         the shared 36px tool strip (theme/language/chat-scoped buttons/token stats + dropdowns); 首位由 navToggle / onBack 驱动："sidebar"桌面切侧栏（默认）/ "hidden"平板常驻树；手机聊天页传 onBack（‹ 回上一页，占原 ☰ 位）+ moreMenuExtras（⋯ 菜单第三组「工作区」：文件/工作项/知识库/Loops/工作区设置，MobileTabShell 注入）；旧 "drawer" 变体与后台状态圆点随抽屉退役删除（2026-10）；手机另显示居中会话标题（纯标签）+ ⋯ 溢出菜单（会话组首项 = 会话信息，行尾带上下文用量 hint；2026-10 「点标题弹面板」与顶栏统计按钮都移入 ⋯，统计按钮只留桌面/平板）
  HomeLanding.tsx           首页内容（宿主剩二：① 桌面 ＋ 占位 tab（居中窄栏 720px，⊞ 面板改居中浮卡）；② 零可用工作区时的移动端整页引导（创建/重启用 + ⚙ 设置逃生口）——移动端 ＋新建任务已直落 composer，两段式仅桌面保留。onSelectSession 走 handleSelectSession 的 C1 分派；onSelectWorkspace 桌面=开家 tab / 移动端=openNewSessionTab；**会话列表由 shell 注入（sessions prop，SSR 预取 + 5s 版本轮询常驻内存——不自取 /api/sessions，修「每次打开 ＋ 最近加载慢」）**。内容：问候语（按时段）+ 大输入卡 + 右上角 ⚙ 设置 + ⊞ 工作区底部面板（完整列表点选=进入；**已停用工作区暗淡行 + 已停用徽章，点击深链设置›工作区预选重启用**；+ 新建/导入，管理入口）+ 最近会话按工作区分组（HomeSessionGroups）；「是否有工作区」看全量列表（全部停用时不得掉进「创建第一个工作区」引导，2026-09 修复）；**⚙ 是零工作区态唯一全局配置入口——没有它，把唯一工作区停用后手机端找不到设置›工作区就无法自救（2026-09 修复）**
  HomeSessionGroups.tsx    全局会话分组列表（按工作区分组：组头点击=打开工作区，chevron 折叠默认全展开不持久化；会话行=共享 SessionRow）。宿主（树形侧栏改版后）：仅移动端 HomeLanding 最近区（过滤空组，不传管理 props）；桌面的会话树在 ProjectSidebar 内直构（复用 groupSessionsByWorkspace + SessionRow，不用本组件）；排序由 lib/home-quick-switch.ts 的 groupSessionsByWorkspace 负责（活跃度降序、空组沉底）
  SessionRow.tsx            会话行共享组件（运行/完成徽章 + Cmd/中键新 tab C1 手势 + 行内归档 + 可选相对时间；hover 只留归档按钮）——HomeSessionGroups 与移动端首页最近区共用
  HomeNewSession.tsx       首页无主新会话页（B1 原地切换，反馈修订后无定制外壳）：直接渲染普通工作区同构的 ChatWindow 新会话视图（只有 composer，可直接发起对话；返回 = tab 栏首页按钮，activateTab 重置无主页模式）；工作区选择器经 ChatWindow inputLeadingControl → ChatInput leadingControl 槽渲染在 composer 控制行、上传图片按钮左侧（下拉向上展开；旧版挂在 PanelHeader meta 槽会被头部容器裁剪——即「点击无选项」bug 的成因），默认最近活跃（共识 Q11=a），草稿 draftKeyOverride="new:__home__"；首次发送走现有 /api/agent/new（cwd=所选工作区根，宿主 registry 解析装配），onSessionCreated → useAppShellState.handleHomeSessionCreated **原地**落为首页会话聊天（反馈修订：不跳工作区 tab）。首页打开的会话由 useAppShellState.homeSession 承载：两 shell 首页分支渲染 ChatWindow(session=homeSession)，左侧中栏保持首页菜单并在列表里高亮；activateTab（含点首页按钮）重置。无可用工作区时显示创建引导
  ProjectSidebar.tsx         项目树侧栏（桌面左侧单一侧栏 + 平板壳 MobileShell ≥768px 常驻树 + 手机壳 MobileTabShell 会话首页〔`phoneHome`：只渲染项目头 + 分组/平铺体，导航三行/内置 SearchPalette/归档行/底部三入口不渲染，滚动区底部留 88px 给 FAB〕的宿主，2026-09 改版）：顶部导航三行（新建任务⌘N/搜索⌘K/插件&技能）+ 工作区分区（工作区节点整行=展开/折叠（桌面 hover 出 工作区首页/归档 钮；**移动变体 mobileActions = 常显 ＋ 新建会话/🗑 归档**——触屏无 hover）→会话行直挂（默认 5 条 + 显示更多，SessionRow rounded）+ 组尾归档行；折叠持久化 pi-tree-collapsed）+ 树底暗淡行（**已停用工作区：整行可点 + hover ⚙ → 设置›工作区预选重启用（停用后不能从所有面上消失）/ 目录不可用工作区：纯展示**）+ 分区 ＋（新建/导入工作区）+ 底部三入口 strip（设置/模型/Agents → 各自独立配置整页，高亮 = 页粒度 activeConfigPage）；**移动端变体（showModuleRows）：展开的工作区节点下渲染模块行（文件/工作项[capability]/知识库[capability]/Loops 常驻，ModuleRow 两列网格，onOpenModule）**；会话分组复用 lib/home-quick-switch；骨架门控
  PanelHeader.tsx           unified ~36px middle-column panel header (title + back + context actions + mobile ×) + PanelHeaderButton
  SettingsPanel.tsx         the 设置 panel — 移动端专用（2026-09 配置页拆分后 desktop 两栏模式删除）：全行索引 + 内嵌子页（‹设置 返回）；平板壳目的地页 = 全量索引（工作区/模型/Skills/插件/Agents/偏好/归档）；手机壳设置 tab 传 `phoneTab` → `PhoneSettingsIndex`（iOS 分组卡片 + 彩色图标瓷片 + 当前主题·语言 hint；只放 偏好/模型/Agents/插件——2026-10：工作区设置经 ⋯/工作区页 ⚙ 推入，Skills 升一级 tab，归档住工作区页）；PreferencesPage 也供桌面偏好分区复用
  ConfigCenterPage.tsx      桌面配置整页族（2026-09 拆分）：设置/模型/插件&技能/Agents 四个独立中央区整页——hero 页头（accent 图标章+大标题+描述+meta+✕）+ 分区 pills（仅多分区页：设置=工作区/偏好，插件&技能=插件/技能），插件&技能页两个分区 = PluginsConfig/SkillsConfig `market` 布局（搜索+已安装卡片网格+添加区+详情弹窗）；整页打开时会话 tab 条隐藏（DesktopShell 条件渲染）

  FilesExplorerPanel.tsx   the「文件」面板体（桌面右栏钉死 tab + 平板 files 目的地页 + 手机 files 推入页同体）— [ 文件 | 改动(N) ] toolbar + ⟳ + FileExplorer/ChangesPanel (cwd = workspace root); exports ExplorerSegmentedTabs; reveal switches its segmented back to 文件
  WorkspaceManager.tsx      workspace create/import + settings (`embedded` in-panel, `panel` narrow single-column variant — 宿主：桌面右坞工作项 tab + 移动抽屉目的地页 work-items / 设置›工作区 workspaceSlot（右坞 S3；workItemSplit portal 机制已退役）; `split={{ inline: true }}` = 列表+详情并排单容器（设置›工作区的中央区页面，2026-09 搬家）; the settings detail carries the 基本信息 card — rename (PATCH name) + 暂时停用 toggle (PATCH disabled; disabled workspaces keep a settings-only「已停用」badge, the sole re-enable surface — 到达路径：桌面项目树树底暗淡行 ⚙ / 移动抽屉树底暗淡行 ⚙ / 零工作区态 HomeLanding ⊞ 暗淡行与 ⚙，均经 `requestWorkspaceSettings` → `selectWorkspaceRequest` 深链预选，2026-09 修复；**预选同时触发详情优先（detailFocus）：rail（全部工作区列表）收起、目标工作区详情独占 +「‹ 全部工作区」返回**（带工作区上下文的入口只看该工作区，不带上下文的底部设置入口仍落全局列表）；两 shell 在设置面关闭/离开时 `clearWorkspaceSettingsRequest` 防闪回)；the rail is drag-sortable (HTML5 DnD，同 SessionTabBar 模式：drop 到目标上=插到它前面，列表尾空区=移到末尾；一次拖放 = PATCH /api/workspaces 全量期望序)；设置详情含「交付自动化」配置区（Phase-2 T9 + Phase-4 T5 checks 编辑器 + seam-repositioning T4 角色表 + final-arch step-3 评审阶段开关 + final-arch step-4 集成命令与验收门：work-items+workflows 双开时显示 enabled 开关 + 评审阶段开关〔stages.review.enabled——先审后跑〕 + 集成命令〔stages.integrate.{enabled,command}——开关 + 命令输入；开启而命令空白保存前客户端拦截，文案与服务端 parseStages 一致；关闭时命令保留回开免重写〕 + 验收门开关〔stages.acceptance.enabled——发布前须人工登记验收〕 + 三开关 PUT 原样回传不丢手设 + 四行角色表〔DELIVERY_ROLES 序：剧本下拉（project 作用域剧本，首项「同名」）/ ModelSelector 模型覆写 / 状态列（GET /delivery/roles 投影）/ 编辑剧本（onOpenAgentsSettings → 设置›Agents）· 预览 prompt 抽屉〕+ 预算只读 + verification.checks 四列行编辑器（name/仓库/命令/超时（秒）+ 行删除，空清单有引导文案——系统检查步按此清单执行，agent 只能触发不能自造），GET|PUT /delivery（PUT 响应带 seeded，保存后重取角色摘要），config:null 播种默认镜像——见 Work Items 章「Delivery 自动执行」）; remaining modal = home create-workspace wizard
  work-items/               中央工作项管理整页组件族（2026-10 M2；宿主 = DesktopShell CenterPage kind"work-items" + MobileShell work-items 目的地页，同一本体）：WorkItemsPage（页骨架 + 深链消费 + 交付执行状态/三动作——Phase-2 T9）/ WorkItemsToolbar（活动|归档|回收站筛选 + 看板阶段筛选）/ WorkItemsList / WorkItemsBoard（七列，无拖拽）/ WorkItemRow / WorkItemDetailView（概况/设计/证据/Git 分支/动作/审计 + 自动执行区挂载；Git 分支区块 = WorkItemGitSection.tsx——登记/更改分支（PATCH branches）+ 实时合并徽标「已合入/未合入 <target>」+ 取仓库当前分支/交付分支一键 + released 只读；列表行 WorkItemRow 有分支小徽标但合并状态只在详情算）/ WorkItemActionbar（legalActionBarActions 投影，released 不渲染 cancel）/ WorkItemExecution（交付自动执行四态区，Phase-2 T9；Phase-5 T2 增 release-preparer 徽标与 attempt releasePlan 摘要）/ WorkItemCreateForm（enableDelivery 缺省不勾）/ AttentionBar（final-arch step-2 T6：中央页顶部 attention 待处理条——GET …/attention 按 kind 计数 chips + 展开行 KEY·标题·已 N 天·催办/泊车徽标定位详情，refreshToken 接快照 fetchedAt 复用页面 5s 节拍，空队列不渲染）/ ClarificationPanel（详情人工答复面板——clarifications 新→旧，已答只读 Q/A，未答 options 单选/自由文本 + recommended 预选/预填，POST answer-clarification 409 提示刷新；无 clarifications 不渲染，永不进动作条）/ WorkItemEvents / WorkItemMeta / useDeliveryExecution.ts（2026-10 手机详情页用：交付执行状态 hook——GET delivery-execution 拉取〔仅 managed 非回收站项，revision 感知 + 切项取消守卫〕+ 停止/重新检查并恢复〔409 pid 文案原样〕/恢复自动领取 三动作，从 WorkItemsPage 内联逻辑抽出，桌面页暂仍持自己一份）；纯逻辑 = work-item-phases.ts（看板投影 + 标签，老 complete ≠ 已发布）+ work-item-queries.ts（筛选/排序）+ work-item-api.ts（HTTP 封装）+ mobile-groups.ts（手机列表分组投影：groupActiveWorkItems 五组〔attention 优先、一项一组、空组不出、已结束缺省折叠〕/ primaryAttentionByKey〔同项多 kind 按 question>confirm>release>acceptance>blocked 取主条目 + extra〕/ phaseTrackIndex〔七列索引〕），均有 node:test
  WorkspaceOverview.tsx     workspace dashboard — the DESKTOP 家 tab landing (移动端不渲染——抽屉目的地页取代；更早的 WorkspaceHomeMenu 已随树抽屉重构退役)：quick actions, 活跃工作项 with 「立即跑一轮」B-button + Loop 绑定下拉, 仓库/知识库 rows, 「会话」区块（WorkspaceSessionList），Loops 摘要行（onOpenLoopsTab → 右坞 Loops rail 模块，必传）
  WorkspaceSessionList.tsx  本工作区会话列表（拉 /api/sessions 后前缀过滤、排除 subagent 子会话）：默认前 20 条 + 显示全部，行内删除（RecentSessionRow）；宿主 = 移动端工作区 tab「会话」子页（showHeader=false）+ WorkspaceOverview「会话」区块（桌面家 tab）
  SessionTabBar.tsx          the SESSION tab strip（桌面 only；移动端不渲染——平板切会话走常驻树，手机走底部 tab 会话首页/工作区页，组件保留给桌面）：会话/占位/家 tab chips（运行呼吸点/未看完成点 + 拖拽排序）+ ＋新会话（无活动 tab 时隐藏；**sticky right——tab 多到溢出时吸附在条的最右不被滚走**，scrollPaddingRight 让活跃 chip 不被＋盖住）；**「首页」 chip 已删除（桌面 `showHomeTab={false}`，prop 默认 true 仅为兼容）**；⊞工作区选择器已删除（桌面走项目树；picker/WorkspaceIcon/色点板已从组件移除）+ tab 右键菜单（关闭/关闭其他/关闭左侧/关闭右侧——目标集合 contextCloseTargetIds，批量关闭走 useAppShellState.closeTabs：合并草稿确认只弹一次、运行中 tab 照常摘除不终止会话；菜单定位复用 computeMenuLayout + portal 遮罩，Escape/滚轮/拖拽关闭）；无 isMobile 分支
  SessionSidebar.tsx        in-workspace session tree + FileExplorer + Changes section
  ChangesPanel.tsx          git changes list (flat or per-repo grouped)
  FileExplorer.tsx          file tree inside sidebar
  FileViewer.tsx            file content in a tab
  CapabilityToggle.tsx      the capability on/off switch used in settings panels
  LoopsConfig.tsx           loop 配置视图（创建向导 + frontmatter/指针正文/知识文档/宪法编辑 + STATE 只读 + 删除）——桌面右坞 / 移动抽屉 loops 目的地页共用
  LoopRow.tsx               loop 单行（name/cron 摘要/级别/状态 + 配置/暂停/停止/可选运行）——右坞 Loops tab 与总览（移动端）共用
  LoopsDockPanel.tsx        右坞 Loops 模块本体（右坞 S1→2026-10 rail）+ 移动端 Loops 全屏页（平板目的地页 / 手机推入页，listHeader 接 ‹返回头）：loop 列表+状态/操作 + 内联 LoopsConfig 推导航；key=workspace.id 挂载（同工作区切 tab 状态存活）
  KnowledgeBrowser.tsx      知识库浏览（chips 选 bundle + FileExplorer + open index.md 提示；宿主：桌面右坞知识库模块（S2→2026-10 rail，knowledge capability 门控） / 平板 knowledge 目的地页 / 手机 knowledge 推入页）
  ChatWindow.tsx            chat composition + completion sound wrapper
  SessionChangedFiles.tsx   "本会话改动 N 个文件" toolbar button (right of the sound toggle in ChatInput) + slide-in drawer (desktop) / full-screen list (mobile); entries open the file via the openFile/file-tab pipeline
  ChatInput.tsx             input bar + model/thinking/tools/compact controls; optional leadingControl ReactNode slot at the very LEFT of the controls row (before the attach button — hosts the home new-session workspace selector); 附件（2026-09）：图片内联 base64 不变，任意文件走 POST /api/uploads 上传 + 路径引用（发送时 appendAttachmentReferences 追加 `[附件 name](path)` 进文本，useAgentSession/传输协议零改动；上传中 chip 阻塞发送），选择器/粘贴/拖拽均放开为任意文件（useDragDrop.hasFiles=kind==="file"）
  MessageView.tsx           renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx       in-session branch switcher
  ChatMinimap.tsx           scroll minimap alongside the message list
  MarkdownBody.tsx / MermaidBlock.tsx   markdown + mermaid renderers
  ModelsConfig.tsx          models.json editor (`split` mode = list in middle column + detail/footer portaled into the right column; `embedded` mode = settings-subpage body; `onSaved` refresh hook)
  PluginsConfig.tsx         installed package plugins panel body (`split`/`embedded` modes as above)
  SkillsConfig.tsx          loaded/search/installable skills panel body (`split`/`embedded` modes as above)
  ArchiveModal.tsx          archived sessions/items (embedded = the 归档 panel body)
  TabBar.tsx                chat + open-file tabs; exports FILES_TAB_ID; `leadingTabs` renders the right dock's pinned module tabs（文件/Loops/…，窄面板容器查询图标化）非可关
  FileIcons.tsx / git-ui.tsx   file icon + git-status UI helpers

hooks/
  useAgentSession.ts        messages + streaming + SSE + fork/navigate/reconciliation logic
  useWorkItems.ts           per-workspace 工作项共享层（2026-10 M2，+store 测试）：单轮询器引用计数（同 workspaceId 多宿主一个 interval，默认 5s 可见轮询 + visibilitychange/focus 校验 + 单飞合并）；snapshot 订阅自 lib/work-items/store；invalidate = 清快照强取；workspaceId 热切换复位 loading/error
  useGitStatus.ts           polls /api/git/status for the Changes panel
  useKitLoops.ts            loops 状态 hook（GET /api/workspaces/:id/loops + pause/resume/stop，refreshKey 驱动）——右坞 Loops tab 与 WorkspaceOverview 共用
  useSessionActivity.ts     running-session activity signals
  useGlobalAgentEvents.ts   global running-session SSE subscription
  useAudio.ts               completion sound + AudioContext unlock
  useDragDrop.ts            shared drag/drop state
  useKeyboardShortcuts.ts   global keyboard shortcuts
  useI18n.tsx / useTheme.ts / useIsMobile.ts   i18n / theme / responsive hooks (useIsMobile reads IsMobileContext — server-seeded UA guess, see Shell split)
```
