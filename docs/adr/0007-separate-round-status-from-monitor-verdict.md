# Separate Round status from Monitor Verdict

Every completed Watchlist Monitor Round records sourced Observations, its comparison Baseline, a Monitor Verdict, and the next Baseline; a Feishu report exists only when the Verdict identifies a reportable change. Treating "no notification" as the only outcome would make successful no-change Rounds indistinguishable from collection or verification failures and would leave later improvement without evidence.
