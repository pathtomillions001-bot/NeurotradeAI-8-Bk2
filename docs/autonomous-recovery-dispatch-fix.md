# Autonomous recovery dispatch investigation

Date: 2026-10-15. Follow-up to PR #239.

## Findings: distinguish policy from execution defects

The authoritative session recovery ledger enters RECOVERY after a tracked loss.
Debt, remaining target, base stake and recovery step feed the existing ladder.
The tick-driven cycle scans the user's **recovery** contract set, not the normal
set. In `RECOVERY_V2_MODE=on` it evaluates 120/500/1500-tick evidence, applies
multiplicity shrinkage and the calibration guard, scores candidates, and requires:

1. positive surviving evidence;
2. positive shrunk expected value;
3. the stake-scaled minimum edge;
4. long-window corroboration;
5. a placeable ladder stake and no hard risk stop.

Admissible candidates are ordered by EV, then episode cost J. The cycle refreshes
account/risk context, resolves a sizing payout and ladder stake, refreshes evidence,
and only then reaches the connected-account and single-exposure purchase path.
Broker-confirmed settlement repays the debt through the conditional ledger writer.
No connected account means HOLD, not a simulated settlement.

**A long recovery HOLD is not by itself a defect.** PR #239 intentionally made
edge-free streams trade extremely rarely. Its acceptance report recorded zero
entries on some 12,000-tick edge-free replays. This fix does not promise frequent
entries, recovery profitability, or guaranteed repayment. We have no production
session logs establishing which blocker caused the user's particular incident.

### Confirmed dispatch defect: scanner and executor disagree

The scanner uses eligibility-first, EV-first ordering. The pre-buy refresh still
used the older J-only switch test (`dJ > 0.02`, or stale plus lower J).

Reproduced case with the unchanged scorer and ladder:

- The original EVEN candidate is admitted at scan time.
- After the quote/context awaits, EVEN has p~ = 0.514: EV = 0.23%, below its
  0.50% minimum edge. It is now refused, with J approximately 2.92.
- MATCH 7 has p~ = 0.12 and payout 8.93x: EV = 7.16%. It passes the gate,
  but its episode cost J is approximately 6.23.
- The old switch rule rejects MATCH because J is worse, keeps the refused EVEN,
  and the final gate holds. **An admissible recovery trade exists but no buy is sent.**

The full-cycle regression fails against the original `cycle.ts` with
`exactly one real buy dispatch: 0 !== 1`. Restoring the fix makes it buy exactly
one MATCH 7 contract and settle its journal row. This is not merely an assertion
about a detached ranking helper.

### Additional safety defects found during the trace

- An empty fresh tournament, or a vanished selected tuple, could leave the old
  admitted decision in place. Missing live evidence now causes an explicit HOLD.
- Switching candidates requires another payout await. The replacement must be
  checked again after that await, rather than trusting evidence from before it.
- Final eligibility was checked against prefetched pricing, not explicitly
  against the payout and stake resolved for sizing this particular order.
  The final gate now checks those resolved values and validates their limits.
  This is not a guarantee that a later broker proposal cannot change price.

## Choices challenged before implementing

| Question | Decision and rationale |
| --- | --- |
| Should recovery bypass the evidence gate to guarantee a trade? | No. Debt is not evidence of an edge. That would undo #239's measured protection. |
| Should we lower shrinkage, corroboration or kappa? | No. No new acceptance evidence justifies changing those thresholds. |
| Should a failed original veto a valid replacement with worse J? | No. That contradicts the shipped eligibility-first/EV-first selection policy. Use the same ranking at dispatch. |
| Should we preserve J-only switching when both candidates pass? | No. #239 deliberately chose EV-first selection; execution should not silently apply a different policy. |
| Should the executor keep switching while quotes arrive? | No. Permit one replacement, then validate it after its quote. If it expires, HOLD and let the next tick decide. This bounds latency and prevents an unbounded loop. |
| Is a missing fresh tape permission to use the previous signal? | No. There is no evidence to revalidate; fail closed without a journal row or buy. |
| Should analysis change the recovery stake? | No. The existing ladder remains the only sizer. The gate reads the resolved stake; it does not compute or modify it. |
| Should simulated settlement be restored to demonstrate recovery? | No. Tests stub broker transport only. Production remains connected-account-only. |

## Scope

Changed the autonomous v2 **recovery pre-buy** path and added small pure selection
and resolved-gate helpers. NORMAL, `off` and `shadow` dispatch remain on their
existing paths. No changes to:

- `recovery-math.ts`, `agents/recovery-engine.ts`, debt transitions or settlement claims;
- Split/Instant, auto/manual settings, multiplier, step limits or stake caps;
- evidence estimation, calibration logic, entry thresholds or ranking of refused candidates;
- the independent Nexus bot or any other bot engine.

The new test file is included in the explicit API test manifest.

## Verification

- `pnpm run typecheck`: all four projects pass.
- `pnpm --filter @workspace/api-server test`: **1,338 pass, 0 fail**.
- `pnpm --filter @workspace/trading-platform test`: **97 pass, 0 fail**.
- Focused cycle/dispatch run: **25 pass, 0 fail**.
- Negative control: the replacement regression fails on the original cycle with
  zero buys; it passes with the fix.

Full-cycle tests exercise:

1. seeded biased tape -> real evidence/scorer -> one purchase dispatch ->
   broker-reported settlement -> partial debt repayment;
2. staged evidence reproducing the worse-J replacement -> one MATCH 7 dispatch
   -> recorded broker contract -> debt repayment;
3. replacement losing its gate during the second quote -> no buy/row, debt unchanged;
4. fresh tape disappearing -> no buy/row, explicit HOLD, debt unchanged;
5. recovery with no connected account -> no buy/row, explicit HOLD, debt unchanged.

Broker public/account transports are mocked in tests. The staged replacement
fixture additionally controls the evidence snapshots to isolate the decision race.
No broker credentials, real-money orders, live enablement or deployment were used.

## Operational interpretation after deployment

Inspect `scan_complete.rejectReason` and the recovery mode/EV/window telemetry:
no evidence, insufficient EV, calibration shrinkage, risk limits, missing/stale
live feed, no connected account and unresolved exposure still legitimately hold.
This patch removes the demonstrated dispatch veto; it does not turn every loss
into an immediate recovery order.
