# Subagent 切换清单（社区包 → 内置体系）

> 生成于 2026-09-21。分支 `subagent/builtin-port`（worktree `../pi-web-subagent-b`）已完成全部验证；
> **本清单是上线切换的操作步骤——合并即切换，请在一个 cxin loop 空窗内执行**（Q3 拍板：pause-all 窗口）。

## 状态

| 仓库 | 分支 | 状态 |
|---|---|---|
| pi-web | `subagent/builtin-port`（worktree ../pi-web-subagent-b） | 8 commits，eslint 11/3/8（=基线零新增）、tsc 0 错、npm test 835/835（基线 755）、docker compose build 通过 |
| pi-web | `subagent/vendor-pin`（Phase A） | 已合入 develop（a755fc5）；B 合入后 vendor 部分被 B5 revert，无需手工处理 |
| cxin | `subagent/builtin-migration` | 2 commits（4c16277 role 迁移 + 209bf76 合同改写），基于 main@6d8ed53 |
| cxin | `main` @ 6d8ed53 | 运行中状态：旧合同在盘、旧角色文件在位，与现役旧 daemon 完全兼容 |

## 切换步骤（顺序硬约束）

1. **停 loop**：`touch /Users/qiancheng/Documents/Workspace/cxin/.pi/loop/pause-all`，
   确认无在跑轮（`ls /Users/qiancheng/Documents/Workspace/cxin/.pi/loops/dev-loop/.round.lock` 不存在，
   或 daemon running set 无 `<loop> · <slot>` 会话）。轮锁在 stale 窗内是假运行态，等它自然回收即可。
2. **pi-web 合并**：主树 `git merge --no-ff subagent/builtin-port`（develop）。
   合并瞬间 dev server 会热载新 web 层——旧 daemon 还在跑，过渡态下 Agents 面板的运行控制会 404，
   属预期，下一步立刻重启即消。
3. **重启 daemon + web**：杀掉 daemon 进程（`lsof -tiTCP:30142` 的 PID）与 `next dev` 进程；
   launchd（com.qyinf.pi-web.plist）或手动重启 web。等 `/health`（30142）回 ok。
4. **冒烟（新代码）**：开一个新会话发一句「列出你可用的工具」——应看到 `Agent` /
   `get_subagent_result` / `steer_subagent`，不再有 `delegate_task`。设置面板出现 `Agents` 节，
   开关默认开、并发默认 10。
5. **cxin 合并**：cxin 主树 `git merge --no-ff subagent/builtin-migration`（main）。
   合并后 `.pi/agents/` 平铺四个 profile、LOOP.md 合同为 Agent 工具版。
6. **恢复 loop**：删 pause-all。下一轮人工盯输出：模型应直接 `subagent_type: analyst/implementer/...`
   派发（角色文件这次真的会加载——旧的「只有 implementer/reviewer」勘误已失效）；
   子会话 id 仍是 `pi-subagent-*` 前缀，会话抽屉/结果面板照常工作。

## 回滚（任一步出问题）

- pi-web：`git revert -m 1 <merge>` + 重启 daemon/web → delegate_task 与社区包 vendored 版回归
  （Phase A 的 vendor 提交仍在历史里，revert B 后依赖自动回到 vendor 版）。
- cxin：`git revert -m 1 <merge>` → 旧角色目录与旧 LOOP.md 合同回归。
- 两边独立可回滚，但一起回滚才语义一致。

## 切换后清理（非阻塞，择期）

- `~/.pi/agent/config/pi-task-models.json` 的 `pi-subagent/delegateTask` 键已失效（文件可留可删）。
- cxin `<仓库>/.worktrees/` 下的旧包 worktree 遗留可清（机器管理，人不手工用）。
- 旧 delegate_task 历史会话的渲染（MessageView 面板 + 抽屉）已双向兼容，无需迁移。
- pi-subagent 子代理子会话历史（`pi-subagent-*.jsonl`）与新体系共用同一前缀，locate/打开照常。

## 已知行为差异（相对社区包，均已在 docs/subagent.md 记录）

- 子代理从独立 pi 进程变为 daemon 进程内会话：可实时 SSE 观看、可 steer/abort；daemon 崩则子代理同灭
  （旧体系子进程可能存活但失联）。
- 无 idle/runtime kill（上游语义）：静默构建跑到完；daemon 心跳监控豁免子会话。
- 模型路由：fast/balanced 类路由退役，profile 未钉 `model:` 即继承父会话模型——若要分档，
  在 profile frontmatter 钉 `model: provider/modelId`（cxin 四个 profile 目前都没钉）。
- 后台完成的唤醒机制更强（notifyParent 触发父会话 followUp 轮）。
