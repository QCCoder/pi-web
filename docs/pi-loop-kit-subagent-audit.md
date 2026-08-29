# §6 Community-package audit: `@henryqw/pi-subagent` (pi-loop kit)

**Date:** 2026-08-29 · **Auditor:** subagent (teardown task 2) · **Design ref:** docs/pi-loop-kit-design.md §6
**Artifacts:** tarballs extracted under `/tmp/pi-subagent-audit/` — paths below are relative to that root
(`v7/package/…` = `@henryqw/pi-subagent@7.0.1`, `v6/package/…` = `6.1.0` (design-cited), `deps/…` = the three
`@henryqw/*` dependencies, `backup/…` = the two backup candidates). npm metadata cross-checked via `npm view`.

---

## 0. Version situation (read this first)

- Design cites **6.1.0**; npm `latest` is now **7.0.1** (39 versions, extremely fast release cadence — 4 versions in
  the last 36h, published by GitHub Actions OIDC from `HenryQW/pi-packages` monorepo).
- I audited **7.0.1** in full. `diff -r v6 v7`: the entire dangerous surface (`dist/ephemeral.js`,
  `dist/worktree.js`, `dist/review-evidence.js`) is **byte-identical**; changes are in
  `extensions/subagent.ts` (widget render + `registerModelTask`/`DELEGATE_TASK` model-task declaration),
  `extensions/delegate-flow.ts`, `dist/index.js` (small API reshuffle: `resolveRoleLaunch` takes a task name instead
  of taskId), docs, and the `pi-task-models` peer bump `^2.0.0 → ^3.0.0`. **Security verdict transfers 1:1 to 6.1.0.**
- Peer deps: `@earendil-works/pi-{ai,coding-agent,tui} ^0.84.4` + `typebox ^1.3.15`. npm `latest` pi-coding-agent is
  **0.84.4** — exact match for a standalone-kit install. ⚠️ pi-web currently bundles **0.82.1**, which lacks
  `--exclude-tools`, `--append-system-prompt`, `--approve` CLI flags the child launcher uses (verified by grep
  against pi-web's node_modules) — phase-2 embedding needs a pi upgrade to ≥0.84.x first.

---

## 1. SOURCE READ — every extension entry, tool registration, permission-relevant path

Package manifest (`v7/package/package.json` `"pi"` key): loads **one** extension entry
`./extensions/subagent.ts` + the `skills/pi-subagent-delegated-development` skill. No hidden conventional
directories.

### 1.1 What the extension registers

`extensions/subagent.ts:792` (`pi.registerTool`): **`delegate_task`** — single `{role,task}` / parallel `{tasks[1..8]}` /
chain `{chain[1..8]}` (+ `background`), schema `extensions/workflow.ts:28-46` (`additionalProperties:false`,
typebox-validated, NUL-byte rejected everywhere).
`extensions/delegate-flow.ts:563/875`: **`delegate_flow`** + **`delegate_flow_continue`** (worktree-isolated
implement→validate→review→ff-merge flow; 1–8 units).
Plus TUI-only surface: status widget, render callbacks, config-file reads. No other tools, no commands, no hooks
beyond `session_start/session_shutdown/input/model_select/agent_settled/tool_result` (all bookkeeping).

### 1.2 Process execution inventory (the full list — nothing else spawns/execs)

| Site | What runs | Shell? | Notes |
|---|---|---|---|
| `dist/ephemeral.js:372` | `spawn(pi re-invocation, ["--mode","json","-p", …launch.args, "Task: …"])` | `shell:false`, `detached:true` (own pgroup) | Command = **the active pi process itself** (`piInvocation()`, `dist/ephemeral.js:213` — reuses `process.execPath + process.argv[1]`); refuses to run outside pi (`dist/ephemeral.js:149` checks `PI_CODING_AGENT=true` + process title `pi`/`pi-rpc`) |
| `dist/ephemeral.js:651` | Windows `taskkill /T /PID` | — | tree-kill on win32 only |
| `dist/worktree.js:19` | `execFile("git", args)` 30s timeout | never shell | worktree create/inspect/prune |
| `dist/review-evidence.js:11,141` | `execFile/spawn("git", …)` 30s timeout | never shell | reviewer patch extraction |
| `extensions/delegate-flow.ts:366-374` | `pi.exec("git", …)` and `pi.exec(validation.command, args)` | via pi's own exec API | validation commands are **model-declared by the parent** and run in the parent — same trust level as the model calling pi's bash tool itself; not an escalation |

Child argv construction (`dist/index.js:175-186`): `--no-session --no-extensions --no-skills
--exclude-tools delegate_task,delegate_flow,delegate_flow_continue,ask_question` → recursion structurally
excluded; `--extension` only for role-declared validated paths (validator `dist/index.js:33-42` requires absolute /
`~/` / `file://` / `npm:`-style package sources), `--skill` only names resolved from the parent's live skill
registry, `--model`/`--thinking` from validated routes, `--approve` iff `ctx.isProjectTrusted()`
(`dist/index.js:184`), `--append-system-prompt` = fixed child-identity policy + role body. Launch env names/values
regex- and NUL-validated (`dist/index.js:167-174`).

### 1.3 Network / filesystem / obfuscation

- **Zero network calls** in the package (grep for `fetch|http|WebSocket|dns|axios|undici` → one hit, a *regex*
  classifying extension source strings, `dist/index.js:40`). No telemetry, no phone-home, no download-and-exec.
- **No eval / no `new Function` / no dynamic import of remote content / no native bindings.** All code is plain
  readable ESM (longest line 238 chars — not minified). 4,445 LOC total, all read.
- Filesystem writes: role/config **reads** only (`readFileSync`, never rewrites user files —
  `extensions/config.ts:47-49` "the file is never rewritten"); writes limited to git worktrees under
  `<repoRoot>/.worktrees/subagent-<sha>` + a line in `.git/info/exclude` (`dist/worktree.js:7-8,57-79`), and
  review patches in a `0700` mkdtemp with `0600` files (`dist/review-evidence.js:136-138,196`).
- Child stdout is parsed as **untrusted JSON lines** with per-line 1 MiB cap, event-type allowlist, oversized-line
  skip, control-char scrubbing, and 50 KiB output caps (`dist/ephemeral.js:5-9,22-31,409-529`). Defensive quality
  is unusually high (buffer over-reads, callback-drain deadlines, post-exit stdio reaping all handled).
- Full `process.env` inherited by children (`dist/ephemeral.js:374`) — normal for a same-user agent but note
  smoose does an allow-list instead (§5).

**Flag list (suspicious-for-full-access): none.** No obfuscation, no exfiltration vector, no remote code exec.

---

## 2. DEPENDENCY CHAIN

`package.json` deps: `@henryqw/pi-herdr ^0.4.0`, `@henryqw/pi-multi-codex ^0.3.8`, `@henryqw/pi-task-models ^3.0.0`.

| Dep | Version | Size | Runtime role for us |
|---|---|---|---|
| `pi-task-models` | 0.4.1→ **3.0.1** (peer-bumped by v7) | 31.6 kB | **Load-bearing.** Model-class routing (`fast/balanced/frontier/fav`) + `~/.pi/agent/config/pi-task-models.json`; `registerModelTask`/`resolveConfiguredTaskRoute` are called on every delegation. Pure config plumbing; no network, no spawn. Ships its own `/task-models` extension — install it as a pi package to get the config command. |
| `pi-herdr` | 0.4.1 | 9.6 kB | **Dead code for us.** Client for the `herdr` terminal-multiplexer CLI (tab/pane/agent management). Imported at `dist/index.js:3` but the managed-subagent functions are *exported only* — the extension entry never calls them (grep: zero Herdr references under `extensions/`). Only dep: `proper-lockfile ^4.1.2` (established lib). |
| `pi-multi-codex` | 0.3.16 | 40 kB | **Load-bearing for install, inert for execution.** `dist/index.js:12` does `import.meta.resolve("@henryqw/pi-multi-codex/extensions/multi-codex.ts")` at module load → the package must be *resolvable* or the extension fails to load. But the path is only ever **passed as `--extension` to children when the route provider matches `/^openai-codex-[2-9]\d*$/`** (`dist/index.js:11,165`). Our zai-coding-cn/GLM stack never matches → the multi-codex extension never loads, and its single network call (`fetch("https://chatgpt.com/backend-api/wham/usage")` with the local Codex OAuth bearer, `deps/…/multi-codex.ts:76,613`) never fires. It reads `~/.pi/agent/auth.json` Codex entries and caches to a `0600` file — all local, endpoint is OpenAI itself. |

Transitive closure = `proper-lockfile` (+ its `graceful-fs`), nothing else. **Can it be avoided/pinned?** Not removable
(hard dependency; `import.meta.resolve` needs it present). Not a concern: pi installs package deps via `npm install`
into the package's own module root — per pi's packages.md, *transitive pi packages are NOT auto-loaded as pi
packages*; only `pi-subagent`'s own manifest entry loads. Pinning the top-level version
(`npm:@henryqw/pi-subagent@7.0.1`) pins the resolved dep tree (npm resolves deps from the pinned tarball's ranges;
`pi update` skips versioned specs). For belt-and-braces, also pin task-models explicitly (it's the one other dep we
*want active* as a pi package for `/task-models`).

---

## 3. INTEGRATION POINTS (vs pi-web's lib/subagent/ bar)

| Concern | pi-web built-in | `@henryqw/pi-subagent` v7 | Gap? |
|---|---|---|---|
| Role discovery | `~/.pi/agent/agents/*.md` (user) + `<projectRoot>/.pi/agents/*.md` (project, approval-gated) + injected loop dirs (gate-exempt) | **`<agentDir>/config/pi-subagent/*.md`** (user-level only) + package built-ins `implementer`/`reviewer` (`dist/index.js:52,98-122`). Does **not** read `.pi/agents/` or `~/.pi/agent/agents/`. | **Yes.** Loop roles must be **ported** to the role format: frontmatter requires `name`, `description`, `tools[]`, `extensions[]`, `skills[]` (all mandatory arrays), optional `isolation: worktree`; body = system prompt. No `model` key in roles — model comes from task-model profiles. No project-level roles, hence no project approval gate needed. |
| Parallel cap | max 8 tasks, concurrency 4 | Schema cap **8 per call** (`extensions/workflow.ts:6,30`); concurrent children = **5 default**, `PI_SUBAGENT_MAX_SUBAGENTS` env > `config maxSubagents` (`extensions/subagent.ts:316-331`); FIFO queue; queued entries don't burn timeout | No (numbers differ; config closes it) |
| Per-child model | role frontmatter `model` optional | Per-delegation `model: "provider/modelId"` (explicit override) or `modelClass` fast/balanced/frontier/fav → `~/.pi/agent/config/pi-task-models.json` profiles (primary+fallback). **No profile configured ⇒ delegation throws "Run /task-models"** (`dist/index.js:120-129`). | Kit must ship a `pi-task-models.json` mapping fast/balanced → zai-coding GLM models. |
| Timeout semantics | Inactivity budget, re-armed on child events; timeout does **not** abort the child (quiet builds are legit) | Dual deadline `min(lastEvent + idle, start + max)` (`dist/ephemeral.js:566-570`); **idle timeout SIGTERMs the child** (SIGKILL ≤5s later), max runtime SIGKILLs immediately (`dist/ephemeral.js:646,764-789`). Defaults **idle 10 min / max 30 min** (`extensions/config.ts:57`). Recognized events include `bash_execution_update` — output-producing builds keep renewing; a **totally silent >10 min build dies**. | **Behavior difference.** Mitigate via `~/.pi/agent/config/pi-subagent/pi-subagent.json` `{"timeout":{"idleMinutes":60,"maxMinutes":240}}` in the kit profile. |
| Child process model | Real child `AgentSession`s in-process (daemon) | Real child **OS processes** re-invoking the pi CLI (`--mode json -p --no-session`) | Architectural difference; fine for standalone kit |
| Child tool scoping | Tools via `StartSessionOptions` | `--exclude-tools` recursion block + role tool allow-list enforced in-child by `extensions/role-tools.ts:23-38` (`setActiveTools`, unavailable names fail fast) | No |
| Worktree isolation | Not built-in (dev-loop does its own) | Per-role `isolation: worktree` + whole `delegate_flow` machinery | Bonus |
| `--approve` semantics | loop roles gate-exempt via injected dirs | children get `--approve` iff project trusted (`dist/index.js:184`) | Equivalent posture |

---

## 4. OBSERVABILITY

**Children are deliberately ephemeral: `--no-session` (`dist/index.js:175`) — no child `.jsonl` exists, no session
ids, nothing for `~/.pi/agent/subagent-children.txt` or pi-web's session index to tag.** Parent-side observability
instead: streamed per-child `onTokens`/`onUpdate`/`onActivity` (from child JSON events), a live TUI widget, 50 KiB
capped per-workflow evidence transport with per-entry status/summary/model/usage/worktree-recovery
(`extensions/result-transport.ts`), and retained-worktree paths surfaced on failure. `background:true` workflows
deliver an aggregate message back into the parent session.

→ For the **GitHub Actions kit scenario this is fine** (logs + final aggregate suffice). For **phase 2 (pi-web
sidebar open-child-by-click)**: *needs a thin adapter or upstream PR* — either drop `--no-session` + append child
ids to `subagent-children.txt` (PR), or keep pi-web's in-process extension for daemon-hosted sessions. Flagged as a
known phase-2 problem per the task brief.

---

## 5. BACKUPS (ranked)

### `@smoose/pi-subagent@0.1.0` (backup #1 — note: `@smouse/…` in the design is a typo; that name 404s)
Single version, 2 months old, gmail maintainer, 0 deps, 1,296 LOC — **all read, clean** (no network, no eval,
`shell:false` spawns, 0600 temp files for long prompts). Tool: `subagent` single/parallel `tasks[]` **max 6**
(`src/limits.ts:1`), concurrency 5 (`PI_SUBAGENT_MAX_CONCURRENCY`, `src/config.ts`), chain absent. Roles: **built-in
`explorer` + `general` only, no user/project role discovery at all** (`src/agents.ts`). Model defaults to parent's
current model (nice for GLM), role frontmatter `model`/`thinking` reserved. Children `--no-session
--no-extensions --tools <allowlist>` with an **env allow-list** including `ZAI_API_KEY` (`src/runner.ts:15-106`) —
tighter env hygiene than the primary. **No timeout of any kind** (abort-only) — quiet builds safe, but no runaway
protection. No `--exclude-tools` recursion guard (children run `--no-extensions` so recursion is structurally
absent anyway). Verdict: usable minimal fallback; role port + concurrency tuning needed; weakest on flow features.

### `@eggmasonvalue/pi-subagent@2.0.0` (backup #2 — "thin primitive")
5 versions (3 days old), gmail maintainer, 0 deps, ~1,300 LOC — **all read, clean**. Tool: `subagent` —
**single task only** (no parallel primitive; caller issues concurrent calls, **no concurrency cap**), plus
`subagent_models` (allowlist catalog). Standout feature: **resumable children** — sessions written to
`<agentDir>/sessions/subagent/<runId>/*.jsonl` + `0600` `.subagent.json` sidecar metadata, `--session` resume path
returned to the model (`index.ts:493-509,171-203`). That's the **best observability story of the three** for phase 2
(real session files, though in a nonstandard dir pi-web's index would need to learn). Timeout = caller-set
`timeoutMs` **wall-clock kill** (SIGTERM→SIGKILL 5s, `index.ts:648-654,278-290`) returning partial + resume path —
quiet builds die at the checkpoint. Child tools default = **inherit parent's active tools** (minus subagent tools) —
broader blast radius than role allow-lists. Model allowlist config at `~/.pi/agent/pi-subagent/models-allowlist.json`.
Ships two dev-only benchmark scraper scripts (`refresh-aa-benchmarks.ts` → artificialanalysis.ai,
`refresh-deepswe-benchmarks.ts` → deepswe.datacurve.ai) — **not loaded by the pi manifest** (only
`extensions/subagent/index.ts` registers), purely manual-run utilities; benign but dead weight in a tarball.
Verdict: credible thin primitive; youngest maintainer history of the three — higher supply-chain drift risk.

**Ranking: henryqw ≫ smoose > eggmasonvalue.** The primary passes; backups stay backups.

---

## 6. VERDICT & PIN BLOCK

### Verdict: **PASS-with-notes** for `@henryqw/pi-subagent` (pin **7.0.1**; 6.1.0 identical on the security surface)

Notes (= the "with"):
1. **Timeout semantics differ from pi-web's bar** — idle 10 min kills silent builds; ship kit config with raised
   `idleMinutes`/`maxMinutes` (see below).
2. **Role port required** — loop roles must be rewritten into `~/.pi/agent/config/pi-subagent/*.md` format
   (mandatory `tools/extensions/skills` arrays); no `.pi/agents/` discovery.
3. **Task-model profiles required** — delegation throws until `~/.pi/agent/config/pi-task-models.json` maps
   fast/balanced to the zai GLM models.
4. **No child sessions** (`--no-session`) — phase-2 sidebar integration needs an adapter/PR (kit-tolerable).
5. **pi version coupling** — peers `^0.84.4`; pi-web's bundled 0.82.1 is too old for phase 2 (missing
   `--exclude-tools`/`--append-system-prompt`/`--approve`).
6. **Trust gate in CI** — `.pi/settings.json` packages load only after project trust; non-interactive `-p` runs
   need `--approve`/`-a` per run, a seeded `~/.pi/agent/trust.json`, or global `defaultProjectTrust:"always"`
   (pi docs/security.md:29).
7. Fast upstream release cadence (4 publishes/36h) — pin exact versions and re-audit on major bumps.

### Pin block — `.pi/settings.json` for the GitHub demo repo

```jsonc
{
  "packages": [
    // pinned specs are skipped by `pi update` — audit-gated upgrades only
    "npm:@henryqw/pi-task-models@3.0.1",
    "npm:@henryqw/pi-subagent@7.0.1"
    // NOT installed as an active pi package: @henryqw/pi-multi-codex — present transitively
    // (required for module-load resolution) but never loaded with a zai/GLM provider stack.
  ]
}
```

Plus the runner invocation: `pi --approve -p "<prompt>"` (or seed trust / set `defaultProjectTrust`), and the
machine-level config the kit must provision:

```jsonc
// ~/.pi/agent/config/pi-task-models.json  (map profiles → zai-coding-cn/GLM; adjust ids per kit model matrix)
{
  "profiles": {
    "fast":     { "primary": { "model": "zai-coding-cn/glm-4.6-air", "thinkingLevel": "low" } },
    "balanced": { "primary": { "model": "zai-coding-cn/glm-4.6",      "thinkingLevel": "medium" } }
  },
  "tasks": {
    "pi-subagent/delegateTask": { "profile": "fast" }
  }
}
```
```jsonc
// ~/.pi/agent/config/pi-subagent/pi-subagent.json  (quiet-build safety: idle raised 10→60, max 30→240)
{ "maxSubagents": 4, "timeout": { "idleMinutes": 60, "maxMinutes": 240 } }
```

Optional hardening for the demo: use the settings object-form filter to drop the bundled Main-side skill
(`{"source": "npm:@henryqw/pi-subagent@7.0.1", "skills": []}`) if the kit ships its own loop skill.

---

## Appendix A — files read (complete inventory)

Primary `@henryqw/pi-subagent@7.0.1` (+ 6.1.0 diff): `extensions/{subagent,delegate-flow,delegation,workflow,
role-tools,config,result-transport,tool-render}.ts`, `dist/{index,ephemeral,worktree,review-evidence}.js`,
`examples/roles/{implementer,reviewer,scout,synthesizer}.md`, `skills/pi-subagent-delegated-development/SKILL.md`,
`README.md`, `CONTEXT.md`, `package.json`.
Deps: `pi-herdr@0.4.1 dist/index.js`, `pi-multi-codex@0.3.16 extensions/multi-codex.ts` (full) +
`package.json`, `pi-task-models@3.0.1 dist/index.js` (full) + `extensions/task-models.ts` + `package.json`.
Backups: `@smoose/pi-subagent@0.1.0 src/*` (all), `@eggmasonvalue/pi-subagent@2.0.0 extensions/subagent/*` (all)
+ benchmark scripts (grep-audited).
Cross-referenced pi docs (pi-web's bundled 0.82.1): `packages.md`, `security.md`, `settings.md`; CLI flag
existence verified against `@earendil-works/pi-coding-agent@0.82.1` dist and npm `latest` (0.84.4).
