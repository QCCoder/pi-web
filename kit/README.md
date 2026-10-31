# pi-loop kit — 文件即程序

一套跑在任何有 pi 的仓库/workspace 上的 loop 协议：协议文件 + agent 冷启动读文件 + cron 心跳。
loop = cron + max_minutes + 入口（skill 或脚本）：定时巡逻，跑完即走、无状态幂等。
设计全文见 pi-web 仓库 `knowledge/designs/pi-loop-kit-design.md`；宿主层（beat/补跑/锁，D13 修订）见 `knowledge/designs/pi-loop-host-design.md`。

## 声明（D5：文件即声明）

`.pi/loops/<name>/LOOP.md` 存在即 loop 存在，删除即消失。没有能力开关、manifest 字段、中央注册表。

## 文件布局

    .pi/loops/<loop-name>/LOOP.md          # 声明 + 合同指针（frontmatter 机器读，正文模型读）
    .pi/loops/<loop-name>/STATE.md         # 每轮 `Last run:` 叙事行（唯一保留的运行态；无分区/账本）
    .pi/loops/<loop-name>/.lastrun         # 上次起轮时间戳（宿主写的机器真相；agent 禁改禁删）
    .pi/loops/<loop-name>/.round.lock      # 轮互斥锁（宿主写；agent 禁改禁删）
    .pi/loops/<loop-name>/PAUSED           # 暂停标记（存在即跳过起轮，D12）
    .pi/loops/<loop-name>/<任意名>.md       # 可选说明文件（如 chandao.md 来源说明 / selection.md 选品规则）：人写的知识文档，
                                       #   agent 只读——LOOP.md 指针点名则必读；改知识/规则改这里，不碰 SKILL
    .agents/skills/<pattern>/SKILL.md  # 模式合同（本轮入口：做什么、产出什么）
    .pi/agents/*.md                    # 角色（maker/checker/brainstorm…）
    .pi/settings.json                  # 社区 pi 包依赖（仅 GitHub 场景声明 subagent 包）
    .pi/loop/pause-all                 # 全 workspace 停跳标记（存在即全停）

`.lastrun` / `.round.lock` 与 `PAUSED` 同级，是**宿主文件**（宿主 = pi-web daemon spawner / `pi-loop beat`），
agent 禁改禁删；STATE.md 的 `Last run:` 行是叙事，不机器读。2026-10-26 终局：宪法两件
（constraints / budget）与断路器账本（loop-ledger.json）从协议退役——loop 无状态幂等，
编排（STATE 分区/账本/预算帽）不再存在；交付执行走 delivery 引擎，loop 只承担定时巡逻。

## patrol 模板（digest 巡逻）

`templates/patrol/`（SKILL.md + LOOP.md）：每夜一拍的巡逻 loop——拉取
`GET /api/workspaces/<workspaceId>/attention?format=digest`（业务语言 markdown 待处理清单），
把 digest 原文播报到轮会话，人与投递渠道从那里接走。复制进工作区即可挂进心跳
（SKILL → `.pi/skills/patrol/`，LOOP.md → `.pi/loops/patrol/`）；默认 cron `0 20 * * 1-5`。

## 宿主（心跳由谁触发）

心跳宿主有二，可并存：

- **pi-web daemon（本地，自动）**：pi-web workspace 由 daemon 的 kit spawner 每 30s 扫描，零配置。
- **`pi-loop beat`（任意 cron）**：一次性幂等进程——发现 → 补跑判定 → 锁 → 起轮（所有到期 loop 顺序处理）→ 退出。
  无 pi-web 的 standalone 仓库/机器把它挂进任意外部 cron 即获得心跳（crontab / systemd timer / Actions 皆可）：

      * * * * * pi-loop beat --root /path/to/repo-or-workspace

双宿主并存安全：起轮统一走 acquire `.round.lock` → 锁内复查 → 写 `.lastrun` → 起轮 → finally release 的
fire 序列，跨宿主互斥（daemon 轮的锁写 `kind: "daemon"`，beat 看到即跳过，反之亦然）。

**补跑语义（anacron-lite）**：fire 判定 = `now >= nextDue(cron, tz, .lastrun)`——宿主睡眠/停机错过的槽位，
恢复后至多**补一轮**（不是每槽都补；由 `.lastrun` 推导）。

**多 loop**：同根多个 loop 的并行轮由 per-loop 锁保证互不阻塞（A 轮在跑不挡 B 到点）。

CLI 命令面（宿主包 `packages/pi-loop/`，照 host spec §4；发布前可直接 `node packages/pi-loop/cli.ts …` 调用）：

| 命令 | 行为 |
|---|---|
| `pi-loop run <name> [--item <KEY>]` | 立即起一轮（无视 cron 判定；仍走锁——已在跑则拒绝；同样更新 `.lastrun`，避免下个 beat 立即重跑）。`--item` 在开场合同追加「本轮优先处理 <KEY>」 |
| `pi-loop stop <name>` | 终止在跑轮：读 `.round.lock` → beat 持有则 SIGTERM→(3s)→SIGKILL 进程组 + 孤儿收割；daemon 持有则提示走 pi-web |
| `pi-loop pause <name>` / `resume <name>` | 写/删 `.pi/loops/<name>/PAUSED` 标记（协议已有语义，加 CLI 入口） |
| `pi-loop status [--root]` | 列出 loops：frontmatter 摘要（cron/level/max_minutes/timezone）/ `.lastrun` / next-due / running（锁存在且活）/ paused |
| `pi-loop init --name --cron [--pattern] [--level] [--max-minutes] [--timezone] [--root]` | 从 `kit/templates/basic` 脚手架 LOOP.md / STATE.md / SKILL.md（存在即跳过）；非交互；写 `.lastrun = now`（首轮等自然槽） |

（`pi-loop watch [--root]` 是不想配 crontab 时的常驻糖：内部 30s tick 循环调同一 beat 核心。）

## LOOP.md frontmatter

    ---
    name: dev-loop          # 可选，缺省取目录名
    pattern: dev-loop       # 可选，对应 .agents/skills/<pattern>/，缺省取 name
    cron: "0 8 * * 1-5"     # 必填，5 字段 Vixie cron；daemon spawner / Actions 镜像解析
    timezone: Asia/Shanghai # 可选，缺省取系统本地时区
    level: L1               # L1 report-only / L2 assisted / L3 unattended，缺省 L1
    max_minutes: 30         # 单轮硬天花板（分钟），到点无论在干什么都杀——成本保险；缺省 30，编排型 loop 放大到 180–240
    stall_minutes: 15       # 停滞阈值（分钟）：轮会话整棵树（含子代理）连续静默即判死；缺省 15
    ---

## 权限分级（L1/L2/L3）

- **L1 report-only**：只读 + 写 STATE.md 的 `Last run` 行，不动代码不 git。新 loop 强制起步级。
- **L2 assisted**：可改代码；硬规则：worktree 隔离 → maker/checker 分离 → 只开 draft 分支/PR，人类合并。
- **L3 unattended**：L2 连续 7 天 verifier 通过且零 escalated 误判后，人手动改 LOOP.md 晋级；
  即使 L3 也只允许自动合并白名单路径（docs/测试）。
- 晋级是人的手：LOOP.md frontmatter 的 level / cron 字段 agent 禁改（每份模板都写明）。

## 工作项绑定（item.yaml 的 loop 字段）

工作项（pi-web 工作项域）可声明 `loop: <loop名>` 绑定（详情下拉 / `workspace_update_work_item` 工具透传）：

- **绑定 = 巡逻参考**（2026-10-26 终局收窄）：不再是流水线路由——巡逻轮可把绑定项当作「与我有关」的提示，
  交付执行一律走 delivery 引擎。
- **软校验**：字段存 loop **名**（非 pattern——名字稳定，pattern 可改）。不校验存在性：loop 可能后建/暂删，未命中的绑定按未绑定处理。
- loop 无状态：STATE.md 只留 `Last run` 叙事行；工作集/进度/gate 等执行状态归 delivery 引擎。

## 调参指引

巡逻无事可做的 tick 也付开场成本：cron 粒度 ≥30min 起步，观察轮产出再收紧。

## GitHub Actions 场景

复制 `templates/github/loop.yml`，schedule 与 LOOP.md 的 cron 保持一致；
轮进程用 `pi -p --approve "<开场合同>"`（headless，凭证走 repo secrets），
subagent 等通用能力经 `.pi/settings.json` 声明社区包（D10：仅此场景）。
