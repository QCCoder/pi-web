# Separate Round status from Monitor Verdict

> **已退役（2026-10 标注）**：Watchlist Monitor / Baseline / Feishu 报告这一域已随 v3 loop 引擎拆除。现行轮结果记录 = STATE.md + loop-ledger.json（`knowledge/reference/loops.md`）。

Every completed Watchlist Monitor Round records sourced Observations, its comparison Baseline, a Monitor Verdict, and the next Baseline; a Feishu report exists only when the Verdict identifies a reportable change. Treating "no notification" as the only outcome would make successful no-change Rounds indistinguishable from collection or verification failures and would leave later improvement without evidence.
