# pi-loop kit — 文件即程序

一套跑在任何有 pi 的仓库/workspace 上的 loop 协议：协议文件 + agent 冷启动读文件 + cron 心跳。
设计全文见 pi-web 仓库 `docs/pi-loop-kit-design.md`。

## 声明（D5：文件即声明）

`loops/<name>/LOOP.md` 存在即 loop 存在，删除即消失。没有能力开关、manifest 字段、中央注册表。

## 文件布局

    loops/<loop-name>/LOOP.md          # 声明 + 合同指针（frontmatter 机器读，正文模型读）
    loops/<loop-name>/STATE.md         # 记忆脊柱：每轮读写，唯一运行状态
    loops/<loop-name>/PAUSED           # 暂停标记（存在即跳过起轮，D12）
    loop-constraints.md                # 绑定约束（宪法文件，agent 禁改）
    loop-budget.md                     # token/轮数预算（宪法文件，agent 禁改）
    loop-ledger.json                   # 断路器账本（agent 可追加，禁删改历史）
    .agents/skills/<pattern>/SKILL.md  # 模式合同（本轮做什么、产出什么、如何写 STATE）
    .pi/agents/*.md                    # 角色（maker/checker/brainstorm…）
    .pi/settings.json                  # 社区 pi 包依赖（仅 GitHub 场景声明 subagent 包）
    loop-pause-all                     # 全 workspace 停跳标记（根目录，存在即全停）

三份宪法文件与账本位于仓库/workspace **根**，被该根下所有 loop **共享**（D13）：`loop-budget.md`
是全 workspace 总帽；STATE.md 的 `[BUDGET]` 节只是本轮视角自报，不是权威计数。

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

## 断路器（loop-ledger.json）

`{ "attempts": [{ "at": "...", "item": "REQ-0042", "error": "...", "digest": "..." }], "consecutiveFailures": 0 }`
同一 error digest 连续 3 次、或单项尝试 >3 → 本轮停止该项并在 STATE.md 标 escalated。

## 预算（loop-budget.md）

超 80% 转 report-only；超 90% 只能在 STATE.md `[BUDGET]` 节**请求**提额，人改预算文件后才生效。

## 调参指引

选择/执行合并后，无事可做的 tick 也付开场判断成本：cron 粒度 ≥30min 起步，
`loop-budget.md` 设每日轮数帽。观察 STATE.md 复盘节再收紧。

## GitHub Actions 场景

复制 `templates/github/loop.yml`，schedule 与 LOOP.md 的 cron 保持一致；
轮进程用 `pi -p --approve "<开场合同>"`（headless，凭证走 repo secrets），
subagent 等通用能力经 `.pi/settings.json` 声明社区包（D10：仅此场景）。
