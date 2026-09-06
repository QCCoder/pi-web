# pi-loop 触发器与多 loop 语义设计（host 层）

> 状态：待评审（2026-08-30）
> 前置：`docs/pi-loop-kit-design.md`（kit 协议，D1–D14 已定稿；本篇修订其中 D13 与 T5 的一部分）
> 姊妹篇：pi-web loop 产品面（工作项 loop 绑定 + Overview Loops 管理区块）—— 另立 spec，依赖本篇的多 loop 语义先定。
> 背景：kit 收口后，loop 的宿主只有 pi-web daemon（本地）与 GitHub Actions（CI）两个；没有 pi-web 的机器/仓库没有心跳宿主，这是 kit 可移植性承诺的最大缺口。同时多 loop per workspace 存在三处协议级缺陷（见 §1）。

## 1. 背景与动机

1. **宿主缺口**：loop 协议文件（LOOP.md/STATE.md/宪法/ledger）已经是纯文件，但「扫描 + cron 匹配 + 到点起轮」这层逻辑长在 pi-web 的 `lib/daemon/loop-spawner.ts` 里——standalone 仓库（无 pi-web workspace manifest）无法复用。对齐 D6「通用 agent 能力归 pi 生态」：宿主逻辑应下沉为生态包。
2. **多 loop 三缺陷**（均已在 kit rollout 顺延清单挂账）：
   - 分钟槽去重键 = `workspaceId:loopName:minute`，用 name 不用目录——同 workspace 两 loop 同名则互撞静默饿死；
   - `busyWorkspaces` 整工作区串行——A loop 轮在跑（≤45min）期间，B loop 到点的槽**直接丢失**（:30 没赶上，下次 11:00），无补跑；
   - D13 把 `loop-ledger.json` 放在根共享——并行轮（解锁 per-loop 并发后）两个 agent 用普通 write 工具读改写同一文件必然竞争，锁协议对 agent 不可靠。
3. **调研结论**（本轮对话定案）：Claude Code 的 `/loop` 是会话内常驻调度器（同会话注入、动态间隔），服务于交互轮询；其无人值守层（Actions）= 外部 cron + headless 一次性执行。kit 轮是冷启动、STATE.md 为脊柱、固定 cron——常驻形态对其零增益，**一次性幂等 beat 是正确形态**（方案一）。

## 2. 目标与非目标

**目标**：
1. `pi-loop` 生态包：纯逻辑层（发现/cron/锁/补跑判定/开场合同拼装）+ CLI（beat/watch/run/stop/pause/resume/init/status）；
2. 多 loop 语义：per-loop 锁、anacron-lite 补跑、D13 修订（ledger per-loop）；
3. pi-web daemon spawner 反向依赖纯逻辑层，消除双实现，daemon 行为升级到新语义；
4. 「终止本轮」进程监督能力（显式修订 T5 拆除期的「无 abort」决定，见 §10）。

**非目标**：
- 起轮的 HTTP/API 面（trigger/run 路由）——起轮仍属 cron/beat 与 D11 预填；「立即跑一轮」= `pi-loop run`，pi-web 按钮只是它的 UI 包装（姊妹篇）；
- 动态间隔 / agent-paced loop（Claude Code `/loop` 的同会话轮询）——交互层产品线，另行立项；
- 云宿主（Routines 对应物）；
- pi-web UI 任何改动——全部在姊妹篇；
- pi 内核改动——上游无常驻哲学，不走（B 方案已否）。

## 3. 架构定位与包落位

```
能力层   pi 内核 + 社区扩展（不变）
协议层   kit 文件（不变 + §6/§7 两处修订）
壳层/宿主 pi-web daemon（workspace 轮：域工具装配 + D9 钩子）
         pi-loop beat ← 新增：任意 cron 宿主调用的一次性触发器（standalone 根）
         GitHub Actions（可直接调 beat，也可沿用裸 pi -p 模板）
```

**落位**：pi-web 仓内 `packages/pi-loop/`（npm workspaces 成员，独立 package.json 备未来发布，含 bin 入口；2026-09 自顶级目录迁入，相对路径导入裁定不变），pi-web 内部以**相对路径导入**（同 `lib/` 待遇，不经 node_modules——`file:` 符号链接过 Next server bundle 有解析摩擦，实现期裁定改相对路径；发布时另配 exports）。npm 命名发布时再定（社区已有 `@bramburn/pi-loop`、`@hank-warren/pi-loop`，均为 scoped，无冲突但命名再议）。测试沿用仓内约定：`node --test`，`.test.mjs` 直接 import `.ts`。

## 4. 命令面

| 命令 | 行为 |
|---|---|
| `pi-loop beat [--root <path>]` | **核心**。一次性：发现 → 补跑判定 → 锁 → 起轮（所有到期 loop 顺序处理）→ 退出。幂等，任何外部 cron 可每分钟调用（crontab/systemd timer/Actions）。exit 0 = 无到期或全部成功；1 = 有轮失败；2 = 用法错误 |
| `pi-loop watch [--root]` | 常驻糖：内部 30s tick 循环调同一 beat 核心。给不想配 crontab 的人（独立用户进程，不进 pi 内核） |
| `pi-loop run <name> [--item <KEY>]` | 立即起一轮（无视 cron 判定；仍走锁——已在跑则拒绝；**同样更新 `.lastrun`**，避免下个 beat 立即重跑）。`--item` 在开场合同追加「本轮优先处理 <KEY>」。姊妹篇 B 按钮的底层 |
| `pi-loop stop <name>` | 终止在跑轮：读 `.round.lock` → beat 持有则 SIGTERM→(3s)→SIGKILL 进程组 + 孤儿收割；daemon 持有则提示走 pi-web（见 §10） |
| `pi-loop pause <name>` / `resume <name>` | 写/删 `loops/<name>/PAUSED` 标记（协议已有语义，加 CLI 入口） |
| `pi-loop init --name --cron [--pattern] [--level] [--max-minutes] [--timezone] [--root]` | 从 `kit/templates/basic` 脚手架五件套 + SKILL.md 骨架；非交互（flags 全显式，交互式后续加）；写 `.lastrun = now`（首轮等自然槽，见 §6） |
| `pi-loop status [--root]` | 列出 loops：frontmatter 摘要（cron/level/max_minutes/timezone）/ `.lastrun` / next-due / running（锁存在且活）/ paused |

## 5. 纯逻辑层（包内模块，daemon 反向依赖）

**从 `lib/daemon/` 迁入**（原样，纯函数）：
- `loop-kit.ts` → `pi-loop/protocol.ts`：`LoopDeclaration` / `parseLoopDeclaration` / `discoverKitLoops` / `isWorkspaceHalted`。`lib/daemon/loop-kit.ts` 改为 re-export 壳（web 路由 `app/api/workspaces/[id]/loops` 也 import 它，改一处壳即可）；
- `cron.ts` → `pi-loop/cron.ts`：`cronMatches` 原样；新增 `nextDue(cron, timezone, after)` = after 之后第一个 cron 命中时刻（分钟粒度）；
- `loop-process-cleanup.ts` 的纯解析函数 + 收割入口 → `pi-loop/reap.ts`：泛化去 daemon 依赖（原扫「daemon 直接子进程 + ppid=1」改为「cwd 在 root 下的 build/shell 进程」，语义不变、宿主无关）；
- `buildRoundPrompt`（spawner 内）→ `pi-loop/contract.ts`：参数化 `{sessionId?: string}`——daemon 版传 realSessionId（D9 挂 conversations 用），beat 版省略该行。

**新增**：
- `pi-loop/round-lock.ts`：`acquireRoundLock(dir)` / `releaseRoundLock(dir)` / `readRoundLock(dir)`。锁文件 `loops/<name>/.round.lock`，内容 JSON `{pid, host, kind: "beat"|"daemon", sessionId?, startedAt}`。O_EXCL 原子创建；已存在则判 stale（pid 不活，或 `startedAt` 超 `maxMinutes + 15min`）→ 抢占并写日志；
- `pi-loop/due.ts`：`shouldFire(declaration, now)` = `now >= nextDue(cron, timezone, readLastrun(dir) ?? 0)`。

**fire 时序**（跨宿主 TOCTOU 安全）：acquire lock → 锁内复查 `shouldFire` → 写 `.lastrun = now` → 起轮 → finally release lock。

## 6. 补跑语义（协议级修订，替代分钟槽）

- 每个 loop 目录新增宿主写的 `loops/<name>/.lastrun`（ISO 时间戳，**机器真相**；STATE.md 的 `Last run:` 行仍是叙事，不机器读）；
- fire 判定 = `now >= nextDue(cron, tz, .lastrun)`；fire 时锁内更新 `.lastrun = now`；
- 效果：错过 N 个槽只补**一轮**（anacron-lite）；A 轮在跑不再影响 B（`.lastrun` per-loop）；
- 无 `.lastrun`（手工创建、未经 init）→ 视为 0 → 下个 beat 立即起轮（文档化行为：loop 想跑）；`pi-loop init` 写 `.lastrun = now`，首轮等自然槽；
- daemon 侧删除 in-memory `emittedSlots`，改用同一判定——**行为变化**：daemon 宿主睡眠/停机错过的槽恢复后也补一轮（当前是静默丢失）；
- agent 侧约束：`.lastrun` / `.round.lock` 与 `PAUSED` 同级，列入「宿主文件，agent 禁改/禁删」，写进 kit/README 协议条款与开场合同注入规则。

## 7. D13 修订：ledger 改 per-loop

- 原决定（D13）：`loop-ledger.json` 在 workspace 根，全部 loop 共享；
- **修订**：`loops/<name>/loop-ledger.json`，per-loop。`loop-budget.md` / `loop-constraints.md` 维持根共享不变（总帽/宪法正是要跨 loop 生效）；
- 理由：① per-loop 锁解锁并行轮后，agent 对共享文件的 RMW 竞争无法用锁协议可靠约束（agent 用普通 write 工具）；② 断路器语义本就 per-loop——「同一 error digest 连续 3 次」的计数跨 loop 混算无意义；③ budget 总帽由共享 budget 文件继续承担，不受影响；
- workspace-c 迁移：一次性 `git mv loop-ledger.json loops/dev-loop/`（断路器历史在 git log 留痕）。

## 8. beat 一轮的生命周期

```
beat（一次性进程）
  ├─ discoverKitLoops(root)（PAUSED / loop-pause-all 自然跳过）
  ├─ 对每个 declaration：shouldFire？→ acquire lock → 复查 → 写 .lastrun
  │    └─ spawn: pi --name "<loop> · <slot>" -p --approve "<开场合同>"
  │        cwd = root，detached + 独立进程组（--name/-p/--approve 组合实现期核对一次）
  │        开场合同 = buildRoundPrompt(declaration, {})（无 sessionId 行）
  ├─ max_minutes 超时 → SIGTERM → 3s → SIGKILL 整进程组 → reap(root)
  └─ finally: release lock
```

- 无 D9 事后钩子（standalone 根没有 work-items 域工具）；轮会话自然沉淀为普通 pi 会话（列表可见；归档策略见 §14 开放问题）；
- 同一 beat 进程内顺序处理到期 loop（单线程天然串行）；跨宿主并行由锁保证不双发。

## 9. daemon spawner 重构

- `LoopKitSpawner` **保留**：DaemonJob 注册（`loop-kit-heartbeats`）、`startRpcSession` 托管（workspace 域工具装配）、D9 `settleRoundBookkeeping`；
- **改为** import 包内纯逻辑（protocol/cron/due/round-lock/contract/reap）；
- **删除** `emittedSlots`（分钟槽）与 `busyWorkspaces`（整工作区串行）——统一走 `.lastrun` + per-loop 锁；
- daemon 轮也写 `.round.lock`（`kind: "daemon"`, `sessionId`）——beat 看到即跳过，**双宿主并存安全**（pi-web 在跑的 workspace 上手动跑 beat 不双发）；
- `buildRoundPrompt` 复用，传 `realSessionId`（D9 语义不变）。

## 10. 「终止本轮」决议（显式修订 T5）

- 拆除期 T5 删除了 v3 的 run/trigger/abort 路由，kit 设计书写「没有 run/trigger/abort API」；
- 本篇**部分修订**：`stop` = 进程监督（杀卡死的轮，否则只能干等 max_minutes），不是引擎控制。v3 abort 被否的真正原因是引擎状态耦合，不是「杀进程」本身；
- run/trigger 的 HTTP/API 面**仍然不做**：起轮属 cron/beat；「立即跑一轮」是 `pi-loop run` / 姊妹篇按钮（daemon 侧走既有会话命令面，不新增路由）；
- daemon 持有轮的终止：pi-web 经既有 daemon 会话 teardown 面（`http-sessions.ts` 已有），`pi-loop stop` 只处理 beat 持有的轮。

## 11. 错误处理

- **锁 stale 抢占**：被杀宿主遗留的锁在 stale 窗口（pid 死亡即刻 / 时效超窗）后由下一个宿主抢占接管，写日志；
- **`.lastrun` 写失败**：不起轮（宁可不跑，不可重复跑），exit 1；
- **beat 硬崩**：锁靠 stale 判定兜底回收；
- **同名 loop**（不同目录、name 字段撞名）：一切键（锁/.lastrun/ledger/slot）以**目录**为准，name 仅展示——顺延清单「同名槽位碰撞」就此消解；
- 收割失败不掩盖轮错误（沿用 spawner 现有口径）。

## 12. 测试面

- **纯函数单测**：`nextDue`（时区/跨日/DST 边界）；`shouldFire`（无 .lastrun 立即跑 / 补跑恰一轮 / 不追多轮）；锁 stale 判定（死 pid / 超窗 / 活锁不抢）；`buildRoundPrompt` 两形态（含/不含 sessionId 行）；
- **beat 集成冒烟**：scratch workspace 双 loop（不同 cron）各自起轮、STATE.md 各自更新；拔掉宿主 90 分钟（`*/30` cron）恢复后每 loop 恰补一轮；
- **双宿主互斥**：daemon 与 beat 同指一个 workspace → 零双发；
- **stop 清场**：sleep 型合同在跑 → stop → 进程组消失 + 孤儿收割无残留；
- **daemon 回归**：现有 `loop-spawner.test.mjs` 的 slot 用例语义迁移为 next-due 用例；`npm test` / typecheck 全绿。

## 13. 交付顺序

1. `pi-loop/` 包骨架 + 纯逻辑迁入（protocol/cron/round-lock/due/contract/reap）+ 单测；
2. CLI：beat / run / stop / pause / resume / status / init + 集成冒烟；
3. daemon spawner 重构（import 包、删 slot/busy、写锁）+ 回归；
4. workspace-c ledger 迁移（git mv）+ `kit/templates/basic` 模板同步（ledger 移入 loop 目录）+ 协议文档更新（kit/README：.lastrun/.round.lock/ledger 位置；本篇修订同步回 kit 设计文档 §5/§9/D13 表）；
5. watch（可选，按需）。

## 14. 开放问题

- npm 发布名与时机（本地 `file:` 先行，发布时再定名）；
- beat 轮会话的归档：daemon 有 D9 自动归档，beat 没有——standalone 场景会话列表会累积轮会话，后续可加 `pi-loop clean`（归档 N 天前的轮会话）或留人管；
- 轮级并发帽：当前同宿主天然串行、跨宿主并行靠锁；若多宿主并行出现资源压力再议。

## 15. 验收标准

1. 双 loop scratch workspace：独立 cron 各自起轮，互不干扰；
2. 补跑语义：宿主停 90 分钟恢复后，每 loop **恰好一轮**补跑（非 3 轮）；daemon 侧同样成立；
3. 双宿主并存零双发（daemon + beat 同 workspace）；
4. `pi-loop stop` 清场（进程组 + 孤儿收割）；
5. daemon 重构后 `npm test` / typecheck 全绿，workspace-c 单 loop 行为不变（同节奏、D9 照常）；
6. kit 协议文档（kit/README.md）反映新语义：`.lastrun`、`.round.lock`、ledger per-loop。

## 已确认决策（对话记录）

| # | 决策 |
|---|---|
| H1 | 宿主形态走方案一：beat 一次性幂等为核心，watch 为后补糖；否掉常驻 daemon（方案三）与纯 extension（方案二，LLM/空转成本） |
| H2 | 补跑语义 anacron-lite：`.lastrun` + `nextDue`，错过补一轮；替代分钟槽；daemon 同步升级 |
| H3 | D13 修订：ledger per-loop（`loops/<name>/loop-ledger.json`）；budget/constraints 维持根共享 |
| H4 | `stop` = 进程监督，显式修订 T5「无 abort」；run/trigger 的 HTTP/API 面仍不做 |
| H5 | 包落位 pi-web 仓内 `pi-loop/`（相对路径导入，独立 package.json 备发布），开源抽仓与 npm 命名顺延 |
| H6 | daemon spawner 反向依赖包内纯逻辑，`emittedSlots`/`busyWorkspaces` 删除，双宿主靠 `.round.lock` 互斥 |
| H7 | 同名 loop 以目录为键消解；name 仅展示 |
