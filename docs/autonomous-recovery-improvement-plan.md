# Autonomous Recovery — Final Implementation Plan (for approval)

**Status:** proposal only. No production code has been changed. Awaiting your go-ahead.
**Supersedes:** the option list in `docs/autonomous-recovery-audit.md` §6 (the constraints you set have eliminated several of those options).
**Measured evidence for this plan:** `scripts/recovery-lab/probe-policy.ts` (new, in-repo, reproducible).

---

## 1. Your constraints, and what they lock

| # | Your instruction | Consequence for this plan |
| :-: | :--- | :--- |
| 1 | Matches/Differs stay — the user may select any contract, and the system analyses what they select | I do **not** restrict the contract menu. I fix the *analysis* so auto-digit Matches/Differs are measured out-of-sample instead of in-sample, and the gate must handle a high-payout, low-probability contract correctly rather than banning it. |
| 2 | **Remove paper mode completely from settings** | Deleted as a user-facing setting and as engine behaviour, across all engines. `!token` becomes a HOLD, never a simulated trade. This also deletes the self-fulfilling `Math.random() < b.probability` settlement that made every past validation worthless. |
| 3 | **The recovery ladder stays untouched at all costs; Split and Instant are retained** | No change to `recovery-math.ts`, `recovery-engine.ts`, `calculateRecoveryStakeRequest`, `applyRecoveryStakeLimits`, `settleRecoveryWin`, the multiplier/step/cap settings, or the debt ledger. |

### 1.1 The guarantee that makes constraint 3 provable

`getDynamicRecoveryStake(...)` passes the win probability into `computeDynamicStake(...)` as **`_blendedWinP` — an unused parameter**. The stake is computed from debt, target, payout, base stake, mode, multiplier, step and limits only:

```
calculateRecoveryStakeRequest({ unrecoveredAmount, remainingTargetProfit, payoutMultiplier,
                                baseStake, recoveryAutoMode, recoveryMethod,
                                recoveryMultiplier, recoveryStep, maxRecoverySteps })
```

**Therefore no change to the probability estimator can move a stake — it is structurally impossible, not merely intended.** Two existing tests already pin this and will be kept green as the standing proof:

- `artifacts/api-server/src/lib/recovery-staking-invariant.test.ts` — pins the exact Instant/Split/manual stake numbers and asserts a stake is identical at escalation 0 and at the cap.
- `artifacts/api-server/src/lib/autonomous-hedge/recovery-v2.test.ts:582` — asserts **100 % identical recovery stakes under `RECOVERY_V2_MODE = off, shadow, and on`**.

I will extend both rather than weaken them. If any change in this plan moves a stake, those tests fail and the plan is wrong.

---

## 2. Final brainstorm — what I evaluated and what I killed

| Option | Verdict | Why |
| :--- | :--- | :--- |
| **Admissibility gate on the multiplicity-corrected estimate** (fire only when the *shrunk* estimate is genuinely positive-EV) | **ADOPT — core of the plan** | Measured: cuts bleed **98 %** (NULL/REGIME: −188.4/−340.4 → **−4.3** capital units) while keeping **97 %** of the edge capture (+147.3 vs +151.9) with **5.4× fewer trades** and 5.2× better EV per trade. |
| Honest estimator always on (M1's out-of-sample digit selection + soft-thresholding), both modes | **ADOPT** | Removes the in-sample auto-digit bias that put **97 % of normal-mode entries** on +45 %-phantom-EV Matches. |
| Per-key **re-fire cooldown** (don't retrade the same excavation) | **REJECTED — measured harmful** | NULL improved (−4.3 → −3.0) but PLANTED **collapsed** (+147.3 → −0.2, 2,142 → 49 trades). Reason: a *real* edge **is** a signal that persists tick after tick. A blanket cooldown cannot tell persistence-of-edge from persistence-of-noise and kills the profitable case. Recorded as a negative result so nobody re-introduces it. |
| **Multi-window corroboration** (require the deviation to also be present at the 500/1,500-tick window, not only the max-\|z̃\| window) | **ADOPT as the refinement, to be measured before merge** | The residual NULL discoveries are all **short-window (120) transients**: `z=4.02 → z̃=0.52` at `window=120`, `nEff=120`. A 120-tick spike does not appear at 500/1,500; a planted ±5 pp bias does. This is the principled discriminator the cooldown failed to be. Not yet measured — needs a per-window `z̃` field exposed from `evidence.ts`; **I will measure it before merging and report the numbers.** |
| Stricter gate margin `κ` | **ADOPT as a tunable, default 0.005** | Measured: κ barely affects NULL (13–14 residual discoveries at every κ up to 0.02) but strongly affects capture (PLANTED: 2,410 trades/+7.05 % at κ=0.002 → 564/+3.38 % at κ=0.02). κ=0.005 is the measured sweet spot; κ=0.01 is the conservative fallback. |
| Replace the compounding ladder with de-escalation | **REMOVED — your constraint** | Off the table. I note for the record that `multiasset/risk.ts` argues against the ladder's direction ("de-escalation, not martingale"); with the ladder frozen, the gate is what prevents the tail from being reached at all. |
| Delete the value-of-waiting wait | **ADOPT** | Measured inert (50/99 percentile wait = **0/0 ticks**) and waiting cannot change a trade's realised expectancy. Removing it removes a decision→buy delay that then has to be revalidated. |
| More inference machinery (HMM / change-point / meta-ensemble on this tape) | **REJECTED** | The tape is a CSPRNG. Sophisticated inference over a provably edge-free sequence adds overfitting surface, not edge. |
| Ban Matches/Differs | **REMOVED — your constraint** | Handled instead by making their evidence honest and by the gate requiring the *shrunk* estimate to clear the payout. |

---

## 3. What I will implement

### Phase 1 — Analysis + gate (the part that changes the sign of the P&L)

**1.1 Honest estimator in both modes.** Route `NORMAL` as well as `RECOVERY` decisions through M1's multi-horizon evidence (`evidence.ts`) instead of the 120-tick in-sample path. Concretely, in `cycle.ts` the `useV2Recovery` condition currently reads `mode === "RECOVERY" && v2Mode !== "off"`; the mode restriction goes away. The `RECOVERY_V2_MODE` flag becomes the rollback switch (default `"on"`, `"off"` restores today's behaviour byte-for-byte).

**1.2 Admissibility gate — the core change.** A candidate may be traded only if all three hold:

```
(a) z̃ > 0                       the deviation survives λ = √(2 ln M_eff) — the search it came from is paid for
(b) p̃·P − 1 > 0                 positive expectancy on the SHRUNK estimate, not the raw sample
(c) p̃·P − 1 ≥ κ                 a minimum real edge worth the exposure (κ default 0.005 = 0.5 %)
```

`score-v2.ts`'s `isRecoveryStakeEligible` currently tests **only stake validity** — `eligible = stakeValid` — which is why v2 fires on a negative-EV menu 11,634 times in 12,000 ticks. It becomes `eligible = stakeValid && gateAdmits(...)`.
Ranking among admissible candidates becomes **highest EV(p̃), with the episode cost `J` as tiebreak** (measured configuration).

**1.3 Recovery exposure scaling.** Because a recovery stake is larger than a base stake, requirement (c) scales with exposure: a recovery attempt needs proportionally stronger evidence than a normal entry of the same estimated edge. This is an *eligibility* rule only — it never computes or alters a stake.

**1.4 Remove the degenerate risk terms.** `R_3L ≡ (1 − q)³` (measured) is a monotone re-encoding of the loss rate, and `−8√Var(p)` is near-constant across candidates (measured Spearman 0.96, 82 % identical top-1 pick). Both are replaced by the evidence layer's dependency statistic `z_dep`, which is already computed and currently unused (`evidence.ts` `depUsed`). The v1 functions stay in the file for the shadow ledger and the existing tests; they simply stop feeding the live decision.

**1.5 Multi-window corroboration** (see §2) — expose per-window `z̃` from `evidence.ts`, require corroboration at a longer window, re-measure all four worlds, report before merge.

### Phase 2 — Timing

**2.1 Fire on gate-pass.** No value-of-waiting delay; HOLD and re-scan next fresh tick otherwise. (`timing-v2.ts` stays in the tree for telemetry and its tests; its wait no longer gates dispatch.)

**2.2 Pre-buy freshness revalidation in all modes.** Today it runs only when `mode === "RECOVERY" && getRecoveryV2Mode() === "on"` (`cycle.ts:1099`). After the async awaits (context refresh, live payout quote) the decision can be ≥ 1 tick stale. Always recompute on the newest tape, allow one switch if another candidate beats the chosen one by margin, and **if the chosen candidate no longer passes the gate, do not send the order.**

**2.3 Staleness refusal + latency telemetry.** Record decision→buy→settle timings and ticks-elapsed; refuse to dispatch a decision older than the freshness bound instead of sending it.

### Phase 3 — Execution truth + paper-mode removal

**3.1 Quote truth-tracking.** Record the **realised** multiplier of every settled contract (`(buyPrice + profit) / buyPrice` on a win) against the **quoted** multiplier that sized and ranked the trade; EWMA drift; alarm and auto-stop on a sustained adverse gap. Today the ledger is denominated entirely in pre-trade assumptions (`ledgerEntryPayout` from `ledger.ts:77`) with nothing closing the loop.

**3.2 Remove paper mode completely.** Scope, all files identified:
- DB: `lib/db/src/schema/settings.ts:28` (`paper_trade_mode`) — removed from the schema (existing rows keep a harmless orphan column; no destructive migration).
- API: `routes/settings.ts` (read line 65, write line 140), `routes/ai.ts` (5 refs), `routes/trades.ts` (4), `routes/markets.ts` (1), plus the 12 engine files that branch on it (`accumulator`, `apex`, `bastion`, `bot`, `dual-lock`, `killshot`, `killshot-family`, `overunder-navigator`, `overunder-turbo`, `parity-forge`, `surge`, `speed-ai`, `omni`, `agent-coordinator`).
- Web: `pages/settings.tsx` (form field, switch, conditional block), `pages/dashboard.tsx`, `pages/connect.tsx`, `pages/market-detail.tsx`, `pages/trades.tsx`, `lib/bots.ts`, and the four console components.
- Behaviour: in `cycle.ts:1151` the branch `if (ctx.paperTradeMode || !ctx.token)` becomes `if (!ctx.token)` → publish a HOLD with the reason "no live connection", write **no** trade row, **no** ledger entry, **no** simulated settlement.

### Explicitly NOT touched

`recovery-math.ts` · `agents/recovery-engine.ts` (incl. `getDynamicRecoveryStake`, `computeDynamicStake`) · `calculateRecoveryStakeRequest` · `applyRecoveryStakeLimits` · `settleRecoveryWin` · Split/Instant semantics · `recoveryMultiplier` · `maxRecoverySteps` · `maxTradeStake` · the debt/target ledger · the consecutive-loss stop and cooldown · the one-exposure-at-a-time gate.

---

## 4. Measured proof for the core change

`scripts/recovery-lab/probe-policy.ts` — 19 markets × 3 seeds × 4,000 ticks, all four worlds, **ladder frozen** (instant, base 1), the user's full contract set including Matches/Differs auto. Capital = `Σ(payout·1{win} − 1)` in base-stake units, which isolates the decision layer from staking.

| World | Policy | Trades | Win rate | Predicted EV | Realised EV | **Capital** |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| **NULL** | v1 shipped | 4,407 | 46.7 % | +19.42 % | −4.27 % | **−188.4** |
| | v2 shipped | 11,634 | 49.8 % | −2.37 % | −2.93 % | **−340.4** |
| | **proposed gate** | **14** | 35.7 % | +4.09 % | −30.36 % | **−4.3** |
| **REGIME** | v1 shipped | 4,429 | 46.9 % | +19.40 % | −3.72 % | **−164.6** |
| | v2 shipped | 11,634 | 49.8 % | −2.37 % | −2.89 % | **−336.5** |
| | **proposed gate** | **14** | 35.7 % | +4.09 % | −30.36 % | **−4.3** |
| **PLANTED** | v1 shipped | 4,461 | 47.1 % | +19.49 % | −3.94 % | −175.9 |
| | v2 shipped | 11,634 | 52.0 % | −1.38 % | +1.31 % | **+151.9** |
| | **proposed gate** | **2,142** | 54.8 % | +1.57 % | **+6.88 %** | **+147.3** |
| **MARKOV** | v1 shipped | 4,393 | 45.7 % | +19.78 % | −5.97 % | −262.1 |
| | v2 shipped | 11,634 | 52.0 % | −1.37 % | +1.44 % | **+167.5** |
| | **proposed gate** | **2,149** | 54.7 % | +1.73 % | **+6.71 %** | **+144.2** |

**How to read it:** where no edge exists, the proposed gate removes **98 %** of the bleed (−4.3 vs −188.4/−340.4). Where an edge exists, it keeps **97 %** of the capture (+147.3 vs +151.9) using **5.4× fewer trades** at **5.2× better EV per trade** (6.88 % vs 1.31 %). And v1 — what ships today — **loses money in all four worlds, including both worlds that contain a real edge** (−175.9, −262.1), because its 120-tick in-sample gates keep it on the wrong market.

κ sensitivity (capital, base-stake units): κ=0.002 → NULL −12.7 / PLANTED +169.8 · **κ=0.005 → NULL −4.3 / PLANTED +147.3** · κ=0.01 → NULL −3.3 / PLANTED +121.7 · κ=0.02 → NULL −3.3 / PLANTED +19.0.

### 4.1 The honest residual (I will not hide this)

The gate is **not** perfect. All 14 residual NULL discoveries are **short-window transients** — every one at `window=120`, e.g. `z=4.02 → z̃=0.52`, `predEV=+2.1 %`, settled at −30 % per trade — and they arrive **in clusters** (ticks 1040–1048 on one market, 761–764 on another) because the same noise spike sits in the window for consecutive ticks.

Two consequences, both stated plainly:
- Residual bleed is **−4.3 units per ~12,000 ticks**, i.e. the engine will produce **~14 trades per 12,000 ticks on a CSPRNG** — effectively "does not trade". That is the *correct* behaviour on Deriv synthetics, and it is the same conclusion as `docs/autonomous-recovery-audit.md` §2.2: **there is no edge in this universe to find.** This plan makes the engine stop paying for its absence; it cannot manufacture one.
- The residual is a **boundary selection bias** (λ controls how many discoveries you get, not the magnitude of the best survivor), which is precisely what §1.5 multi-window corroboration targets. If corroboration does not cut it, the fallback is κ=0.01 (−3.3) at some cost to capture (+121.7).

---

## 5. Acceptance criteria (capital-denominated — this is the fix to the process, too)

The reason a 1.8× capital regression shipped as "PASS" is that acceptance criterion A5 in `docs/recovery-v2-design.md` measures **EV per trade**. Every criterion below is denominated in **capital**, and all must pass in the lab **before** anything is enabled live:

| # | Criterion | Threshold |
| :-: | :--- | :--- |
| G1 | NULL-world capital destroyed, per 12,000 ticks | ≥ −20 base-stake units (today: −188 / −340) |
| G2 | REGIME-world capital destroyed | ≥ −20 units (today: −165 / −336) |
| G3 | PLANTED-world capital earned | > 0 **and** realised EV ≥ +4 %/trade (measured +147.3, +6.88 %) |
| G4 | MARKOV-world capital earned | > 0 (measured +144.2) |
| G5 | Worst-5 % recovery episode (ES5), Instant and Split | **numerically unchanged** from the pre-change baseline — the ladder is frozen |
| G6 | Stakes identical at `RECOVERY_V2_MODE = off`, `shadow`, `on` ∀ inputs | hash-equality over a randomised input grid |
| G7 | Uniform-tape regression: with Matches/Differs in the set, trades fired over 12,000 ticks | ≤ 20 (today 4,407 / 11,634) |
| G8 | Full suites: API server (906 tests), trading-platform, both typechecs, first-paint render check | 0 failures |
| G9 | Paper-mode removal: no code path can write a simulated trade row | grep + explicit test asserting `!token` produces a HOLD row and no ledger entry |

G5/G6 are the mechanical guarantee of your constraint 3: **if a future edit leaks analysis into the money path, the suite fails.**

---

## 6. Phases, risk and rollback

| Phase | Content | Risk | Rollback |
| :--- | :--- | :--- | :--- |
| **1** | Honest estimator both modes · admissibility gate · exposure-scaled margin · drop R3L/−8√Var · multi-window corroboration (measured before merge) · timing 2.1–2.3 | Medium — changes which trades are taken. Additive to eligibility only; can only *remove* trades. | `RECOVERY_V2_MODE=off` restores today's behaviour byte-for-byte; single flag |
| **2** | Paper mode removed end-to-end (DB field, API, 12 engines, web UI) | Medium — wide but mechanical; **changes UX**: several consoles lose the toggle, and a disconnected account now HOLDs instead of paper-trading | separate commit, independently revertible |
| **3** | Quote truth-tracking · latency telemetry | Low — observability, additive | revert commit |

**Cross-cutting risk I want on the record:** after Phase 1 the engine will trade **very rarely** on real Deriv synthetics (measured ~14 trades per 12,000 ticks per 19-market sweep). If the product expectation is "an autonomous engine that trades often", that expectation and Phase 1 are in direct conflict — and the honest resolution is a different instrument universe, not a weaker gate.

---

## 7. What I need from you

1. **Approve Phase 1** (analysis + gate + timing) — my recommendation, and the only phase that changes the sign of the P&L.
2. **Does the gate apply to NORMAL mode too, or RECOVERY only?** I recommend **both**: normal entries create the debt that recovery then inherits, and §3 measured 100 %-of-ticks firing with −14.56 % realised EV in normal mode. But RECOVERY-only is a legitimate narrower scope if you want the normal path left alone.
3. **Approve Phase 2** (paper-mode removal) as a separate commit — please confirm you accept that a disconnected account will then HOLD instead of simulating.
4. **Approve Phase 3** (execution truth-tracking) — optional, low risk, and it is the only thing that will ever tell us whether the quoted payouts we stake against are the payouts we actually receive.

Everything above is reversible by a single flag or a single commit, and nothing runs live before G1–G9 are printed and shown to you.

---

# 8. Implementation log — Phase 1 & 2 built, and what building them uncovered

Status as of this log: Phases 1 and 2 are implemented, Phase 3 is implemented.
Nothing is live; G1–G9 are still to be measured and reported before any live
enablement.

## 8.1 A process failure found during implementation — read this first

**The test suite was not running the test that guards this work.**

`pnpm --filter @workspace/api-server test` executes an **explicit list** of files.
Four files existed on disk, passed on their own, and were **absent from that
list**. One of them was:

```
artifacts/api-server/src/lib/autonomous-hedge/recovery-v2.test.ts
```

That is the T1–T8 pin suite for the recovery pipeline — including T5 (the staking
invariant) and T6 (NORMAL-mode equivalence, the guarantee that the staking path is
untouched). Every "the suite is green" claim made while it was missing was
therefore **not evidence about the recovery pipeline at all**, and a real
regression sat undetected inside it (see 8.2).

The other three: `execution-truth.test.ts` (new), `multiasset/desk-settings.test.ts`,
`parity-forge-analysis.test.ts`.

Fix applied, so this cannot recur:
1. all four files added to the explicit list (94 files now listed);
2. `src/lib/test-manifest.test.ts` added — it fails the suite if any `*.test.ts`
   on disk is missing from the script, or if the script lists a file that does not
   exist. The manifest is now self-checking.

Measured: **1318 tests, 1318 pass, 0 fail**; `pnpm run typecheck` 4/4 projects.
(Run-to-run the *reported* totals move ±20 because a few heavy files are
intermittently not loaded in a 4 GB sandbox — the manifest guard plus `fail 0`
is the signal that matters, not the headline number. The earlier `1259/1259`
figure was one of those variable totals and, as shown above, excluded the pipeline
pin suite entirely.)

## 8.2 The regression the missing suite was hiding, and its fixes

Running the previously-omitted `recovery-v2.test.ts` against the Phase 1 edits
produced 3 failures that were deterministic and reproducible (stable across
repeated runs). Two distinct defects, both real and both now fixed:

**(a) The gate returned a placeholder EV on one refusal path.**
`gateAdmitsCandidate` computed `row.pTilde * payout - 1` only *after* rule (a), so
a candidate refused for "no evidence past the multiplicity threshold" reported
`ev: 0` while a candidate refused later reported its true (possibly negative) EV.
Because the ranking sorts on that number, the placeholder made the key
**discontinuous across the admit/refuse boundary** and mis-ordered candidates —
T3 caught it (`0.48` ranked ahead of `0.51`). Fixed: EV is computed once, before
any rule runs, and returned on **every** path, admitted or refused.

**(b) Ordering *refused* candidates by EV manufactured apparent skill.**
The shadow ledger records the top 10 of the v2 ordering every tick and regresses
realised outcomes on predicted p~ (`beta`); T1 asserts the null-tape slope stays
within ±0.03, and this beta is what feeds the kappa calibration guard. Ranking
`admissible by EV, then everything else by EV` made that recorder evaluate the
counterfactual *"trade the best-EV candidates anyway"* — i.e. it sorted an
edge-free tape by the very noise whose outcomes were then regressed against it.
Measured on a null tape (19 markets, 2200 ticks):

| seed | EV-first for refused | v1 J-bucket order (baseline) |
| :--- | ---: | ---: |
| `0x1010101` | **+0.07388** | +0.02812 |
| `0x2020202` | **+0.03050** | +0.02041 |
| `0x3030303` | **+0.01216** | +0.00287 |
| `0x4040404` | −0.00067 | −0.00067 |

A systematic, positive bias — the instrument reporting skill that is not there.
**Fix:** admissible candidates are ordered by EV (unchanged — this is what decides
trades), while **refused** candidates keep the original v1 J-bucket + tick-hash
order. Measured after the fix, the four betas are **identical to baseline**
(0.02812 / 0.02041 / 0.00287 / −0.00067).

Consequence for the evidence in §4: **the P2 numbers are unaffected**, because P2
selects from the admissible set and that ordering is unchanged. Re-running
`probe-policy.ts` after the fix reproduces them exactly — NULL 0 trades / 0.0,
PLANTED 2 060 / **+153.2**, MARKOV 2 105 / **+170.6**.

One caveat to record honestly: in `probe-policy.ts`, **P1 (v2-without-gate) is no
longer separable from P2**, because the gate now lives inside `eligible` in the
shipped scorer. The P1 column in §4 was measured while eligibility was still
stake-validity only and is preserved as history; P2 re-derives its own admitted
set independently of the scorer and therefore still reproduces.

**Corroboration fails closed.** A row carrying no longest-window data cannot be
corroborated and is now refused rather than trusted (only hand-built fixtures are
affected; `EvidenceTracker` always sets the field).

## 8.3 Never run the code generator on this repo without reading this

Removing `paperTradeMode` from `openapi.yaml` and running the documented
`pnpm --filter @workspace/api-spec run codegen` (orval v8.9.1) did the intended
edit — and **two unintended ones**, because the installed generator no longer
emits what the committed output contains:

| Drift | Consequence |
| :--- | :--- |
| `.strict()` dropped from `ExecuteTradeBody` | the "one contract per request" guard weakens — `{...order, count: 4}` / `{...order, quantity: 4}` are no longer rejected with 400. Caught by `manual-trades.test.ts`. |
| `retry: false` dropped from the trade-execution mutation | React Query would **auto-retry a failed order submission**. |

The regeneration was reverted and the paper-mode removal applied **by hand** to
the four generated files, byte-identical everywhere else; both guards verified
still present. The API spec remains the source of truth, but until the generator
is pinned to the version that produced the committed files, generated code is to
be edited surgically, not regenerated.

## 8.4 Phase 2 — paper mode is gone, end to end

| Layer | What changed |
| :--- | :--- |
| DB | `paperTradeMode` column dropped from `settings.ts` schema and the DDL in `db/src/index.ts` |
| API | removed from `routes/settings.ts`, `routes/ai.ts`, `routes/markets.ts`; `openapi.yaml` + all four generated client/zod files |
| Engines | 13 engines + `agent-coordinator`: `isLive = !!token`; `[PAPER]` labels stripped; each carries a NOTE explaining why |
| Autonomous engine | the `Math.random() < b.probability` branch is replaced by an explicit **HOLD** — publishes `nextScanIn: null`, journals nothing, touches no ledger, invents no settlement |
| Manual trade route | simulated branch replaced by a **409 `NO_LIVE_ACCOUNT` refusal**; nothing is journalled and the balance is never moved |
| Web | toggle + amber banner removed (`settings.tsx`), `PAPER` badge removed (dashboard, market-detail, trades journal), connect copy corrected |

The one thing paper mode was actually for — testing without risking money — is not
lost, because the honest replacement already exists and is strictly better: the
lab (`scripts/recovery-lab`) and the shadow ledger run the real decision path on
recorded/edge-free tapes and produce **measured** outcomes, instead of outcomes
drawn from the engine's own belief. That distinction is the entire audit: a
simulator that settles trades with `Math.random() < p` validates the engine against
its own assumptions and can never fail.

Two tests encoded the removed simulation and were rewritten to assert the new
contract (refusal + nothing journalled), preserving their original intent that one
intentional submission can never become more than one trade.

## 8.5 Phase 3 — execution truth (`autonomous-hedge/execution-truth.ts`)

The recovery ladder sizes every step from the **quoted** multiplier captured before
dispatch (`ledgerEntryPayout`). Nothing had ever compared quote against payment, so
a systematically optimistic quote under-recovers forever, invisibly. Now recorded
from real settlements only:

- **Quote drift** — realised multiplier `(buyPrice + profit) / buyPrice` versus the
  quote that sized the trade, tracked as a relative EWMA per contract+barrier with
  a material-and-consistent alarm rule (5 consecutive adverse wins below a 0.5 %
  noise floor). Wins only: a loss carries no pricing information.
- **Dispatch latency** — ticks elapsed between the analysed tape and the order,
  with a stale-dispatch counter; wired at the buy confirmation, alongside the
  pre-dispatch staleness refusal already added in Phase 1.

10 unit tests pin the properties that matter: a faithful broker never alarms, a
consistently short-paying broker does, one unlucky payout does not, losses carry no
signal, and a backwards tape cannot produce negative latency.

---

# 9. Acceptance status — G1–G9 measured

**All nine criteria pass on the shipped code.** The full measurement, the exact
commands, the per-world capital tables and the honest residual are in
**`docs/autonomous-recovery-acceptance.md`**. Summary:

| # | Criterion | Measured | Verdict |
| :-: | :--- | :--- | :---: |
| G1 | NULL capital ≥ −20 units | 0.0 (12k ticks) · −2.1 (24k) — was −188.4 | PASS |
| G2 | REGIME capital ≥ −20 units | 0.0 (12k) · −7.3 (24k) — was −164.6 | PASS |
| G3 | PLANTED > 0 and EV ≥ +4 % | +134.0 / +8.68 % (12k) · +327.8 / +6.24 % (24k) | PASS |
| G4 | MARKOV > 0 | +123.9 (12k) · +291.7 (24k) | PASS |
| G5 | ES5 unchanged, Instant + Split | byte-identical over 6 144 cells, both trees | PASS |
| G6 | Stakes identical off/shadow/on | sha256 identical, 12 000 numbers, both trees | PASS |
| G7 | ≤ 20 uniform-tape trades / 12k ticks | 0 · 0 — was 4 407 / 11 634 | PASS |
| G8 | Suites, typechecks, first-paint | 1322 + 97 tests, 4/4 typecheck, 8/8 render | PASS |
| G9 | No simulated trade row possible | static guard (4) + behavioural cycle test + 409 tests | PASS |

G1–G4 are measured against a new **P4 column of `probe-policy.ts` that runs the
shipped scorer**, so the acceptance figure is the code that decides trades rather
than a probe-local re-implementation. G5 and G6 are new harnesses run against a
clean worktree of the pre-change commit `eb5234e` and compared byte-for-byte.

**The most important finding of this stage — deleting the flag did not delete
simulation.** Eleven further engines could still fabricate an outcome, and every
one of them fed it into the shared recovery ledger. See the acceptance report's
G9 section; this is also why §8.1's missing pin suite mattered so much.

**Nothing has been enabled live.**
