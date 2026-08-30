# pi-loop kit — 文件即程序

一套跑在任何有 pi 的仓库/workspace 上的 loop 协议：协议文件 + agent 冷启动读文件 + cron 心跳。
设计全文见 pi-web 仓库 `docs/pi-loop-kit-design.md`；宿主层（beat/补跑/锁，D13 修订）见 `docs/pi-loop-host-design.md`。

## 声明（D5：文件即声明）

`loops/<name>/LOOP.md` 存在即 loop 存在，删除即消失。没有能力开关、manifest 字段、中央注册表。

## 文件布局

    loops/<loop-name>/LOOP.md          # 声明 + 合同指针（frontmatter 机器读，正文模型读）
    loops/<loop-name>/STATE.md         # 记忆脊柱：每轮读写，唯一运行状态
    loops/<loop-name>/loop-ledger.json # 断路器账本（per-loop；agent 可追加，禁删改历史）
    loops/<loop-name>/.lastrun         # 上次起轮时间戳（宿主写的机器真相；agent 禁改禁删）
    loops/<loop-name>/.round.lock      # 轮互斥锁（宿主写；agent 禁改禁删）
    loops/<loop-name>/PAUSED           # 暂停标记（存在即跳过起轮，D12）
    loop-constraints.md                # 绑定约束（宪法文件，agent 禁改；根共享）
    loop-budget.md                     # token/轮数预算（宪法文件，agent 禁改；根共享）
    .agents/skills/<pattern>/SKILL.md  # 模式合同（本轮做什么、产出什么、如何写 STATE）
    .pi/agents/*.md                    # 角色（maker/checker/brainstorm…）
    .pi/settings.json                  # 社区 pi 包依赖（仅 GitHub 场景声明 subagent 包）
    loop-pause-all                     # 全 workspace 停跳标记（根目录，存在即全停）

`.lastrun` / `.round.lock` 与 `PAUSED` 同级，是**宿主文件**（宿主 = pi-web daemon spawner / `pi-loop beat`），
agent 禁改禁删；STATE.md 的 `Last run:` 行仍是叙事，不机器读。宪法文件位于仓库/workspace **根**，被该根下
所有 loop **共享**；ledger 为 **per-loop**（D13 修订：并行轮下共享文件的 RMW 竞争无法约束，断路器计数也本就
不该跨 loop 混算）——`loop-budget.md` 仍是全 workspace 总帽，STATE.md 的 `[BUDGET]` 节只是本轮视角自报，不是权威计数。

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

**多 loop**：同根多个 loop 的并行轮由 per-loop 锁保证互不阻塞（A 轮在跑不挡 B 到点）；budget/constraints
根共享——总帽/宪法正是要跨 loop 生效。

CLI 命令面（宿主包 `pi-loop/`，照 host spec §4；发布前可直接 `node pi-loop/cli.ts …` 调用）：

| 命令 | 行为 |
|---|---|
| `pi-loop run <name> [--item <KEY>]` | 立即起一轮（无视 cron 判定；仍走锁——已在跑则拒绝；同样更新 `.lastrun`，避免下个 beat 立即重跑）。`--item` 在开场合同追加「本轮优先处理 <KEY>」 |
| `pi-loop stop <name>` | 终止在跑轮：读 `.round.lock` → beat 持有则 SIGTERM→(3s)→SIGKILL 进程组 + 孤儿收割；daemon 持有则提示走 pi-web |
| `pi-loop pause <name>` / `resume <name>` | 写/删 `loops/<name>/PAUSED` 标记（协议已有语义，加 CLI 入口） |
| `pi-loop status [--root]` | 列出 loops：frontmatter 摘要（cron/level/max_minutes/timezone）/ `.lastrun` / next-due / running（锁存在且活）/ paused |
| `pi-loop init --name --cron [--pattern] [--level] [--max-minutes] [--timezone] [--root]` | 从 `kit/templates/basic` 脚手架五件套 + SKILL.md 骨架；非交互；写 `.lastrun = now`（首轮等自然槽） |

（`pi-loop watch [--root]` 是不想配 crontab 时的常驻糖：内部 30s tick 循环调同一 beat 核心。）

## LOOP.md frontmatter

    ---
    name: dev-loop          # 可选，缺省取目录名
    pattern: dev-loop       # 可选，对应 .agents/skills/<pattern>/，缺省取 name
    cron: "0 8 * * 1-5"     # 必填，5 字段 Vixie cron；daemon spawner / Actions 镜像解析
    timezone: Asia/Shanghai # 可选，缺省取系统本地时区
    level: L1               # L1 report-only / L2 assisted / L3 unattended，缺省 L1
    max_minutes: 30         # 单轮进程超时，缺省 30
    ---

## 权限分级（L1/L2/L3）

- **L1 report-only**：只读 + 写 STATE.md/ledger，不动代码不 git。新 loop 强制起步级。
- **L2 assisted**：可改代码；硬规则：worktree 隔离 → maker/checker 分离 → 只开 draft 分支/PR，人类合并。
- **L3 unattended**：L2 连续 7 天 verifier 通过且零 escalated 误判后，人手动改 LOOP.md 晋级；
  即使 L3 也只允许自动合并白名单路径（docs/测试）。
- 晋级与"agent 禁自改宪法"写进每份 SKILL.md 硬条款。

## 断路器（loop-ledger.json，per-loop）

`{ "attempts": [{ "at": "...", "item": "REQ-0042", "error": "...", "digest": "..." }], "consecutiveFailures": 0 }`
同一 error digest 连续 3 次、或单项尝试 >3 → 本轮停止该项并在 STATE.md 标 escalated。账本 per-loop
（`loops/<name>/loop-ledger.json`）；budget 总帽仍由根共享的 `loop-budget.md` 承担。

## 预算（loop-budget.md）

超 80% 转 report-only；超 90% 只能在 STATE.md `[BUDGET]` 节**请求**提额，人改预算文件后才生效。

## 调参指引

选择/执行合并后，无事可做的 tick 也付开场判断成本：cron 粒度 ≥30min 起步，
`loop-budget.md` 设每日轮数帽。观察 STATE.md 复盘节再收紧。

## GitHub Actions 场景

复制 `templates/github/loop.yml`，schedule 与 LOOP.md 的 cron 保持一致；
轮进程用 `pi -p --approve "<开场合同>"`（headless，凭证走 repo secrets），
subagent 等通用能力经 `.pi/settings.json` 声明社区包（D10：仅此场景）。
