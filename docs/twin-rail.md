# Twin-Rail Sentinel — two frozen straddles, fired as one burst

*Scope: `artifacts/api-server/src/lib/twin-rail-analysis.ts` (the maths),
`twin-rail-engine.ts` (the session loop), the `/api/bots/twinrail/*` routes, and
`artifacts/trading-platform/src/components/twin-rail-console.tsx` (the console).
It adds one bot — **Twin-Rail Sentinel** — and changes no other bot's behaviour.*

---

## 1. The specification, taken literally

The bot was specified as:

| | Over | Under |
| --- | --- | --- |
| **Normal rail** | Over 4 | Under 5 |
| **Recovery rail** | Over 5 | Under 4 |

- Both legs of a round fire **at the same instant**, with the **same stake**, and
  settle **together**.
- Recovery is entered when the normal pair loses, and its target is **the amount
  that was actually lost**.
- The user chooses **no contract** — both rails are constants.
- Digits 4 and 5 must be avoided "at all cost" in both rails.
- Locked vs switching market is chosen **after** the scan.
- Minimal gates: a 50/50 structure must not be filtered down to zero trades.

The rest of this document is how each of those clauses was made *true and
verifiable* rather than aspirational.

---

## 2. The payoff algebra (this is the part that cannot be negotiated)

A digit contract pays `p` (a total, stake included) when it wins and `0` when it
loses. Per leg of stake `S`, a round of the pair (`over`, `under`) therefore pays

```
net(d) = [d > over] · S(p_o − 1) − S  +  [d < under] · S(p_u − 1) − S
```

### The normal rail is a partition — and a deterministic cost

`Over 4` wins on 5–9 and `Under 5` wins on 0–4. **Exactly one leg wins on every
digit**, so `net` does not depend on the digit at all:

```
net_normal = S(p_1.95 − 2) = −0.05 · S      at the canonical 1.95× / 1.95× quote
```

$1 per leg on Over 4 + Under 5 loses **5 cents every single round**, whatever the
market prints. That is the house margin expressed as a constant. It is not a
coin flip, it cannot be gated away, and a bot that hides it is lying to its user —
so the console prints it per round, per cycle and per hour, and the engine prints
it in every trade's journal reason.

### The recovery rail has a dead rail — and that is the whole game

`Over 5` wins on 6–9 and `Under 4` wins on 0–3, so:

| digits | result | net per leg stake |
| --- | --- | --- |
| 0–3 | Under 4 wins, Over 5 loses | `p_u − 2` = +0.43 |
| 6–9 | Over 5 wins, Under 4 loses | `p_o − 2` = +0.43 |
| **4, 5** | **both legs lose** | **−2.00** |

The dead rail `{4, 5}` is the ONLY digit set where this bot can lose both legs,
and it is precisely "Over 4 / Under 5" that the user asked to avoid. With
`q = P(digit ∈ {4,5})` the expected value of one recovery round is

```
E[recovery] = (1 − q)(p − 2) − 2q        (per unit of leg stake)
```

which is positive **exactly when**

```
q  <  q* = (p − 2) / p        →  q* = 0.43 / 2.43 = 17.70 %   at 2.43×
```

A fair ten-digit stream prints `q = 20 %`, so the bare structure loses 5.6 % of
stake per round. The bot therefore does not assume anything: it **measures `q`
on 4,999 digits of deep history, prices the quota `q*` from the exchange's own
live proposals, and fires the recovery rail only when the lower confidence bound
of the measured edge clears zero.** That is the single gate, and it is the gate
the user asked for.

### Why the dead rail is the target and not a bug

Digit distributions on real feeds are not always uniform — price lattices, tick
sizes and rounding make some digits structurally rarer. When the tape genuinely
prints 4s and 5s less often than 17.7 %, `Over 5 + Under 4` is a positive-edge,
same-tick structure covering 8 of the 10 digits. When it does not, there is no
edge, and the bot says so instead of trading anyway. The override exists (a
labelled `FORCED` deploy) but the console then states, in the same breath, that
every round is paying the spread.

---

## 3. The estimator (`twin-rail-analysis.ts`)

Everything statistical lives in one pure, dependency-free module so it can be
tested exactly.

- **Tape**: `estimateFrequencies(digits)` — a Jeffreys-smoothed
  (`α = 0.5`) Dirichlet posterior over the ten digits, returning the posterior
  mean, sd, the dead-rail rate with its sd, and a 9-df χ² uniformity statistic
  with its p-value.
- **Edge**: `measurePairEdge(spec, quote, stake, estimate, z)` — because a
  round's net is **linear in the digit frequencies**, the posterior mean and
  variance of the edge are exact and closed-form:
  `E[net] = Σ_d net_d m_d`, `Var(net) = [Σ_d net_d² m_d − E[net]²] / (Σα + 1)`.
  No bootstrap, no Monte Carlo: the same tape always produces the same verdict,
  which is what makes a hold explainable and the gate testable. The verdict
  ladder is `certified` (edge > 2 sd), `qualified` (LCB > 0), `watch` (mean > 0),
  `refused`.
- **Quota**: `deadRailBreakEven` solves `q* = A / (A + 2)` with
  `A = r(p_o − 2) + (1 − r)(p_u − 2)`, where `r` is the measured split between
  the two winning regions — so an asymmetric quote pair is priced correctly
  rather than assuming symmetry.
- **Memory**: `detectDigitMemory(digits)` runs a 10×10 transition χ² (81 df).
  Below 500 transitions, or when `p ≥ 0.01`, the tape is treated as memoryless
  (order 0) — the bot does not invent patterns. When memory is real,
  `buildContextualFrequencies` conditions the next tick on the digit that just
  printed and mixes the conditional row with the marginal by
  `λ = n / (n + 60)` (Jelinek–Mercer), so a thin context is shrunk back toward
  the unconditional tape instead of being trusted.
- **Timing**: `profileTicks` measures the tick period, jitter and age from the
  digit tape; `planTwinFire` fires only when
  `tickPeriod − tickAge ≥ rttP95 + 250 ms`, i.e. only when both legs can be
  submitted, quoted, bought and acknowledged **inside one inter-tick window**.
- **Family helpers**: `normalCdf`, `chiSquareUpperTail`, `regularizedGammaQ`
  and `logGamma` are implemented in-file (no dependency), so the tests are the
  only thing standing between the console and the numbers.

---

## 4. Same-tick execution, and how it is *proven* rather than hoped

1. **One burst.** Both legs are sent through `executeBulkLiveTrades` on the
   account's pooled socket: one unscheduled batch, both proposals, both buys,
   retries bounded, no stagger (`BULK_PROPOSAL_STAGGER_MS = 0`). Nothing in this
   bot submits a leg through a second socket.
2. **Fire window.** The burst starts on a fresh tick with the whole inter-tick
   window available (`planTwinFire`), never in the tail of a window where it
   would straddle a boundary.
3. **Naked-leg repair.** If exactly one leg confirms, the missing leg is
   re-fired immediately; if it cannot be, the survivor is closed rather than
   left unattended.
4. **The invariant is the proof.** For *both* rails, a synced round means
   **exactly one leg wins**: both-won is impossible (Over 5 and Under 4 cannot
   both win; Over 4 and Under 5 cannot both win) and, on the normal partition
   rail, both-lost is impossible too. So the pair's own outcome pattern
   classifies every round:

   | pattern | verdict |
   | --- | --- |
   | exactly one winner | `synced` — the legs shared one digit |
   | both lost on the recovery rail | `dead-rail` — synced, and it is the 4/5 case |
   | both lost on the normal rail | `split-tick` — a genuine desync, and the only event in which the user's "both normal legs lost" can happen |
   | both won (either rail) | `split-tick` |

   `settleIdentity` cross-checks the legs' exit spots as a second witness. The
   session reports `syncRate`, `deadRailHits`, `splitRounds`, `doubleLosses`
   and the burst p50/p95 and window headroom at fire time, so "are the legs
   really on the same tick?" is a number on the screen, not a claim.

---

## 5. Recovery — the shared ledger, with the debt nobody invents

- The stake path is `recoveryEngine.getBotRecoveryStake` (debt × (1 + markup) ÷
  (payout − 1), capped by max stake and balance) and the outcome path is
  `recoveryEngine.recordOutcome` — the same objects every other bot uses.
- **The debt recorded is what the pair actually lost** (`|net|`), never the
  nominal leg stake. A $1/leg double loss contributes `$2` of debt, which is
  exactly the user's "recover the total amount lost" — and the debt-driven
  per-leg stake (`debt × 1.1 ÷ 1.43 ≈ 1.54 × debt` per leg) is what clears it in
  one winning round.
- The trigger policy is explicit: `pair-loss` (default — any round that took
  money out of the account, which covers a real double loss at full 2×stake
  debt) or `both-legs` (the literal rule, which fires only on a true double
  loss — i.e. on a desync the console flags).
- `maxTradeStake` is treated as the **pair** cap: both legs fire together, so a
  $1 cap means $0.50 a leg.

---

## 6. The console

Scan → read → deploy, and from then on a twin-leg monitor:

- **Scan card**: live quotes for both rails, the carrier toll per round, the
  dead-rail rate versus the quota it must beat, the posterior edge with its
  lower bound and `P(edge > 0)`, the tick period, and the ranked list of every
  market measured with the reason each one fell short.
- **Deploy**: locked to the measured market, or switching with a 2-point
  margin + LCB requirement before rotating.
- **Live**: both rails side by side (the normal rail's toll, the recovery rail's
  live dead-rail rate against its quota), the gate and the exact reason it is
  open or closed, the tick window at fire time, the burst latencies, and the
  sync ledger — `synced / dead-rail / split-tick`, `syncRate`, naked-leg
  repairs, and the stake the recovery ladder is actually targeting.

---

## 7. What this bot does not claim

- It does not make the normal rail profitable. The partition straddle returns
  `p − 2` per round by construction; on a fair tape the *pair* is a guaranteed
  cost and the console says so in dollars per round.
- It does not promise that any market will clear the recovery quota. On a
  uniform feed, none does, and the honest output is a stand-down with the
  measured numbers — which is what the sandbox feed produces (19.4 % dead rail
  vs a 17.70 % quota on the best market, edge LCB −$0.07 at $1/leg).
- It does not widen its target on recovery, and it never derives a stake from a
  winning payout: the debt alone sizes the ladder.

## 8. Tests

`artifacts/api-server/src/lib/twin-rail-analysis.test.ts` (27 cases, run by
`pnpm --filter @workspace/api-server run test`) pins:

the partition invariant and the dead rail; the constant toll across stakes and
tape shapes; `partitionMargin = 2.5 %` and `legBreakEven(2.43) = 41.15 %`;
`q* = 17.70 %` and its behaviour under margin-free and worse quotes; the gate
refusing a fair tape, refusing a 19 % dead rail, and releasing a 13 % one; the
memoryless verdict on an i.i.d. tape and the conditioning of a planted
transition bias; the sync contract for all four outcome patterns; the fire
window refusing a burst it cannot finish; the two recovery-trigger policies; and
the numeric helpers against published critical values.
