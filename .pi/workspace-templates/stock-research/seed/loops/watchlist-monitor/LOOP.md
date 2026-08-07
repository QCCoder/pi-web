# 自选股变化监控

## 目标

读取 `watchlists/default.md` 中的标的，与 `STATE.md` 的已验证基线比较。每轮都要留下证据；只有发生可报告变化时才生成简报。本 Loop 是 L1，只报告，不交易，不修改仓位。

## Round 契约

1. `collect-observations`
   - Maker：逐个标的取得最新行情、公告与关键事件，记录数据时点和来源。
   - Checker：独立检查每条 Observation 是否有来源、时间是否一致、数字是否可复现；无法验证的条目标成 unknown。
2. `compare-baseline`
   - Maker：把通过检查的 Observation 与 `STATE.md` 基线比较，列出候选变化。
   - Checker：逐条确认差异不是缺数、时间窗口错位或重复事件造成的假阳性。
3. `decide-and-report`
   - Maker：给出 `changed`、`unchanged` 或 `unknown` verdict；仅 changed 生成简报草稿。
   - Checker：确认 verdict 与证据一致，简报不包含未经验证的断言。
   - Gate：如简报含买卖倾向、重大风险判断或需要外发，必须由人确认。
4. `improve`
   - 汇总本轮缺数、误报、耗时和人工纠正，写入 `audit/`。
   - 只提出 LOOP.md、Checker 或 Autonomy Level 的改进建议；L1 不自动改写规则。

## 完成条件

- 每个 Maker 产出都有独立 Checker 结论。
- `STATE.md` 只吸收通过 Checker 的新基线。
- 最终回复以 `LOOP_VERDICT: changed|unchanged|unknown` 结束。
