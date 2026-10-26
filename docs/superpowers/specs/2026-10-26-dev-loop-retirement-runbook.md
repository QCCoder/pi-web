# cargoware 退役 dev-loop 切换 Runbook

> 人工执行；本 runbook 不由任何自动化代跑。目标：dev-loop 停编排（loop = 定时巡逻），交付执行全部走 delivery 引擎（designer → developer → reviewer → system checks → release-preparer → 人工验收/发布）。
> 日期基线：2026-10-26（pi-web final-arch step 1–6 之后）。命令里的 `<workspace>` = cargoware 工作区根路径。

## 1. 前置

1. pi-web 重启到含 final-arch step 1–6 的版本（`git log --oneline -1` 确认含 `feat: attention digest rendering …` 及其后）。
2. 打开工作区交付设置页保存一次 `.pi/delivery.yaml`（`enabled` 暂仍 false），确认设置页可读写——保存 delivery 配置要求工作区具备 work-items + workflows 双能力；缺项在 readiness 显示 capabilities-missing。
3. `GET /api/workspaces/<wsId>/delivery/readiness`：记录当前缺项清单（剧本/检查/配置）——第 2、3 步逐项消掉，收尾时复跑应为「就绪」。

## 2. 剧本改挂（`.pi/agents/`，人工校订后改名/改挂）

现役四剧本改为 delivery 角色剧本（两种挂法任选：复制成 `<role>.md` 同名，或保留原名在 `.pi/delivery.yaml` 的 `roles.<role>.profile` 指向别名）：

> 顺序：剧本改名/改挂放在首次保存 delivery 配置（§1 第 2 步）之前，可让一次性播种直接收养人工剧本（record existing，避免 seeded_from 漂移提示）。

- **analyst → `designer.md`**：SPEC.md 落点改为 `delivery/artifacts/design.md` + 验收条件（写进 design.md 末节）；**删掉「不向用户提问」类条款**——现在用 `delivery_ask_human` 提问，答复走 attention 队列；产出改为「起草 design.md，完成即结束回合」。
- **implementer → `developer.md`**：TDD 纪律保留；**删除 worktree 自建/分支自管段**——引擎按仓预建 worktree 与候选分支，剧本只写「在给定 worktree 内实现 → `delivery_submit` 提交候选（带说明）」；失败超预算等引擎 pause，不自循环。
- **tester → `reviewer.md`**：三层审（代码 / 计划 / 规格）保留；原「全量 gate 亲自跑一遍」改为：`delivery_run_check` 佐证（只读核对检查输出）+ 权威运行交给引擎 system 检查步——剧本写「审查裁定 pass / rework（按 code|spec 给返工清单）」。
- **learner**：知识沉淀动作（`kb_search` 两问归并）并入巡逻 loop 或直接删除剧本——delivery 引擎无此角色。

## 3. `delivery.yaml`

```yaml
schemaVersion: 2
enabled: true            # 全部就绪并演练后再开
roles:
  designer:  { profile: designer }      # 同名挂法时省略
  developer: { profile: developer }
  reviewer:  { profile: reviewer }
attention: { nudgeAfterDays: 3, parkAfterDays: 7 }
verification:
  checks:
    - name: haichuang-tests
      repositoryId: cargoware-haichuang
      # JDK8 + 指定模块聚合：JAVA_HOME 必须显式（worktree 无共享 shell 环境）
      command: JAVA_HOME=~/.local/jdk8 mvn -q -pl <module> -am test
      timeout_seconds: 1800
    - name: h5-tests
      repositoryId: cargoware-h5
      # node-sass 二进制兼容：worktree 内复用主 checkout 的 PATH 技巧写进命令
      #（或落 `.pi/scripts/h5-test.sh`，命令引用脚本）
      command: PATH="$PWD/../<主checkout>/node_modules/.bin:$PATH" npm run test:ci
      timeout_seconds: 1800
    - name: report-server-tests
      repositoryId: cargo-report-server
      command: mvn -q test
stages:
  review: { enabled: true }        # developer 候选先进 reviewer 人工审查轮
  integrate: { enabled: true, command: "bash .pi/scripts/integrate-develop.sh" }   # 可选：git merge --no-ff 进 develop 的脚本
  acceptance: { enabled: true }    # 测试环境人工验收（record-acceptance）后才可 record-release
```

- integrate 脚本语义：候选 checkout 内逐仓 `git merge --no-ff` 进 `develop`；任一仓失败即整体失败（引擎记 `delivery.integrate_failed` → blocked）。
- checks 的仓库名/模块名以各仓 AGENTS.md 的 gate 命令为准，逐字核对后再落盘。

## 4. 在制项处理（人工，逐项）

- Watch List 在制项（REQ-0044 等）：不再进 dev-loop。逐项人工走完尾段——已 verified 的走 `record-release`（acceptance 开启时先 `record-acceptance`）；不需要做的走 `cancel`；仍在实现中的按新流程从当前阶段继续（数据与事件全保留）。
- 未绑定 delivery 的纯需求项：保持现状，需要自动化时再勾「标准交付流程」。

## 5. dev-loop 停编排

1. `touch .pi/loops/dev-loop/PAUSED`（语义 = 暂停即不存在；不删目录，回滚零成本）。
2. `STATE.md` 归档：`git mv` 到 `.pi/loops/dev-loop/STATE-archive-2026-10.md`（或保留原地只读——巡逻形态不再消费分区）。
3. `.pi/loop/pause-all` 保留既有语义（全停旗），不创建。
4. 退役的宪法/账本文件（`.pi/loop/constraints.md`、`.pi/loop/budget.md`、`.pi/loops/dev-loop/loop-ledger.json`）：留在原地不读（协议已退役），或 `git rm`——不手改内容。

## 6. 禅道同步与 digest 改挂 patrol 模板

1. 复制 `kit/templates/patrol/{LOOP.md,SKILL.md}` 到位——LOOP.md → `.pi/loops/patrol/LOOP.md`；SKILL.md → `.pi/skills/patrol/SKILL.md`（skill 走 pi 原生发现 `.pi/skills/<pattern>/`，LOOP.md 在 `.pi/loops/<name>/`；chandao-sync 同规则，SKILL 不进 `.pi/loops/`）：
   - `chandao-sync/`（cron 改 `0 9 * * 1-5`，SKILL 换成「跑 scripts/chandao-sync.py + 摘要播报」）；
   - `patrol/`（保持 cron `0 20 * * 1-5`：拉 `GET /api/workspaces/<wsId>/attention?format=digest`，原文播报，结束）。
2. 原 dev-loop 的禅道同步职责（若有轮内步骤）随停编排一并失效——同步不再依赖编排轮。
3. `pi-loop init --name patrol --cron "0 20 * * 1-5" --root <workspace>` 可替代手工复制（骨架来自 basic 模板；LOOP.md 落 `.pi/loops/patrol/`、SKILL.md 落 `.pi/skills/patrol/`；SKILL 内容按 patrol 模板改写）。

## 7. 验证清单（全部勾完才算切换完成）

- [ ] `GET …/delivery/readiness` 无缺项（配置/四剧本/检查齐备）。
- [ ] 真需求一条全链路：建项（标准交付流程）→ designer 出 design.md → 人工 confirm-design → developer 提交候选 →（review enabled）reviewer pass → system 检查步全 passed（`delivery.verification` actor=system）→（integrate）merge 进 develop → release-preparer 起草 → record-acceptance → record-release。
- [ ] 中途故意答一次 `delivery_ask_human`，attention 队列与 `?format=digest` 均出现该问题。
- [ ] patrol 轮 20:00 拉到 digest 并播报；chandao-sync 轮 09:00 同步成功且不重复建项。
- [ ] dev-loop 无新轮产生（`.lastrun` 不再前进、无 `<loop> · <slot>` 新会话）。

## 8. 回滚

- `rm .pi/loops/dev-loop/PAUSED` → dev-loop 心跳自然恢复（`.lastrun` 在，补跑 anacron-lite 至多补一轮）。
- `.pi/delivery.yaml` 的 `enabled` 改回 false（或整体还原）→ 引擎停派发；在飞 claim 随 automation-paused 收敛。
- 所有删除/改名经 git——`git log`/`git revert` 即审计与恢复路径；宪法/账本文件若 `git rm`，回滚 = revert 该提交。
