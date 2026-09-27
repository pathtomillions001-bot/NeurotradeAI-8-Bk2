/**
 * FIRST-ENTRY timing for generated Dual-Lock Range Sentinel strategies.
 *
 * WHY THIS EXISTS
 * ───────────────
 *   The Dual-Lock scan already owns the decision of WHAT to trade: the market,
 *   the normal Over/Under barrier and the recovery barrier are fixed by the
 *   scan and are never touched here. What the scan cannot know is WHEN the
 *   user will press Run. Pressing Run in the middle of an adverse excursion
 *   (a burst of digits that violate the locked range) starts the session one
 *   tick before a loss and drags the very first trade into the recovery
 *   ladder — the most expensive way to begin.
 *
 *   This module answers exactly one question, exactly once per run:
 *   "is the next tick a defensible moment to start?" After the first purchase
 *   the generated bot never calls it again — it executes the lock non-stop,
 *   precisely as before.
 *
 * THE MODEL (bounded, self-calibrating, market-agnostic)
 * ─────────────────────────────────────────────────────
 *   1. Hit series. w[i] = 1 when digit i satisfies the locked contract.
 *   2. Recency-weighted Beta posterior of the marginal hit rate `baseline`
 *      (half-life 40 ticks, Beta(20·p0, 20·(1−p0)) prior, p0 = the fair rate
 *      of the locked barrier). Short or noisy tapes shrink back to fair odds.
 *   3. Two-state Markov row, hierarchically shrunk toward that baseline:
 *      `confidence` = P(next tick is a hit | the state the tape is in NOW).
 *      This is the number that makes a "clean" tick different from a tick
 *      sitting inside a violation cluster.
 *   4. Cluster guards: `quietTicks` (ticks since the last violation) and
 *      `burst` (violations in the last 5 ticks).
 *   5. DEADLINE-RELAXED THRESHOLD — the part that makes this reliable on any
 *      market. The bar starts at the tape's own optimistic rate and decays
 *      linearly to its pessimistic rate across the patience budget:
 *
 *          threshold(t) = pHigh − (pHigh − pLow) · t/P
 *          pHigh = max(baseline, p0)      pLow = max(0, min(baseline, p0) − 0.02)
 *
 *      Because the bar is expressed in the tape's OWN units, it is meaningful
 *      for Over 1 (p0 = 0.8) and Under 7 (p0 = 0.7) alike, on any symbol, with
 *      no per-market tuning. Because it decays, the gate cannot deadlock.
 *   6. HARD DEADLINE. At t ≥ P the gate returns ready regardless of anything
 *      else (including a dead tick feed), so the wait is provably bounded by
 *      P evaluations — one per tick — and the scanned edge cannot go stale.
 *
 *   The gate only ever DELAYS the first trade. It can never change the market,
 *   the side, the barrier, the stake or the recovery ladder.
 */

const MIN_SAMPLES = 25;
const PRIOR_STRENGTH = 20;
const CONTEXT_PRIOR_STRENGTH = 12;
const HALF_LIFE = 40;
const BURST_WINDOW = 5;

export const DUAL_LOCK_ENTRY_DEFAULTS = Object.freeze({
    window: 120,
    patience: 12,
    minSamples: MIN_SAMPLES,
    burstWindow: BURST_WINDOW,
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pct = value => `${(value * 100).toFixed(1)}%`;

const isHit = (digit, side, barrier) => (side === 'DIGITUNDER' ? digit < barrier : digit > barrier);

/** Recency-weighted Beta posterior mean of a boolean series. */
const weightedRate = (values, priorMean, priorStrength) => {
    let hits = priorStrength * priorMean;
    let total = priorStrength;
    const newest = values.length - 1;
    values.forEach((won, index) => {
        const weight = Math.pow(0.5, (newest - index) / HALF_LIFE);
        hits += weight * Number(won);
        total += weight;
    });
    return total > 0 ? hits / total : priorMean;
};

/**
 * Decide whether the next tick is a well-timed FIRST entry for the locked
 * contract. Pure, so the production runtime and the deterministic tests share
 * exactly the same maths.
 *
 * @param {object}   params
 * @param {number[]} params.digits   Newest-last last-digit tape.
 * @param {string}   params.contract 'DIGITOVER' | 'DIGITUNDER' (from the scan).
 * @param {number}   params.barrier  Locked barrier (from the scan).
 * @param {number}   params.waited   Evaluations already spent on timing (1-based).
 * @param {number}   params.patience Hard deadline in evaluations/ticks.
 */
export const analyseDualLockEntry = ({ digits, contract, barrier, waited, patience }) => {
    const side = contract === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER';
    const prediction = clamp(Math.round(Number(barrier) || 0), 0, 9);
    const patienceTicks = clamp(Math.round(Number(patience) || DUAL_LOCK_ENTRY_DEFAULTS.patience), 3, 40);
    const waitedTicks = clamp(Math.round(Number(waited) || 0), 0, patienceTicks);
    const deadlineReached = waitedTicks >= patienceTicks;

    const clean = (Array.isArray(digits) ? digits : [])
        .map(Number)
        .filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const p0 = side === 'DIGITOVER' ? (9 - prediction) / 10 : prediction / 10;
    const wins = clean.map(digit => isHit(digit, side, prediction));
    const samples = wins.length;
    const baseline = weightedRate(wins, p0, PRIOR_STRENGTH);

    // Markov row for the state the tape is in right now, shrunk toward the
    // baseline so a sparse row cannot invent (or destroy) an edge.
    const state = samples > 0 ? wins[samples - 1] : true;
    let contextHits = 0;
    let contextMisses = 0;
    const newestPair = samples - 2;
    for (let index = 0; index < samples - 1; index++) {
        if (wins[index] !== state) continue;
        const weight = Math.pow(0.5, (newestPair - index) / HALF_LIFE);
        if (wins[index + 1]) contextHits += weight;
        else contextMisses += weight;
    }
    const alpha = CONTEXT_PRIOR_STRENGTH * baseline + contextHits;
    const beta = CONTEXT_PRIOR_STRENGTH * (1 - baseline) + contextMisses;
    const confidence = alpha + beta > 0 ? alpha / (alpha + beta) : p0;

    // Cluster guards.
    let quietTicks = 0;
    for (let index = samples - 1; index >= 0 && wins[index]; index--) quietTicks += 1;
    const burst = wins.slice(-BURST_WINDOW).filter(won => !won).length;

    // Deadline-relaxed threshold — the bar the tape must clear right now.
    const progress = patienceTicks > 0 ? waitedTicks / patienceTicks : 1;
    const pHigh = Math.max(baseline, p0);
    const pLow = Math.max(0, Math.min(baseline, p0) - 0.02);
    const threshold = pHigh - (pHigh - pLow) * progress;
    const requiredQuiet = progress < 0.5 ? 2 : progress < 0.8 ? 1 : 0;
    const allowedBurst = progress < 0.5 ? 1 : progress < 0.8 ? 2 : BURST_WINDOW;

    const blockers = [];
    if (samples < MIN_SAMPLES) blockers.push(`tape ${samples}/${MIN_SAMPLES}`);
    if (confidence < threshold) blockers.push(`confidence ${pct(confidence)} < ${pct(threshold)}`);
    if (quietTicks < requiredQuiet) blockers.push(`needs ${requiredQuiet} clean ticks, has ${quietTicks}`);
    if (burst > allowedBurst) blockers.push(`${burst} misses in the last ${BURST_WINDOW}`);

    const qualified = blockers.length === 0;
    const ready = qualified || deadlineReached;

    let reason;
    if (qualified) {
        reason = `TIMED ENTRY · ${quietTicks} clean tick${quietTicks === 1 ? '' : 's'} · confidence ${pct(
            confidence
        )} ≥ ${pct(threshold)}`;
    } else if (deadlineReached) {
        reason = `TIMED ENTRY · ${patienceTicks}-tick patience budget reached — starting the scanned lock`;
    } else {
        reason = `TIMING ${waitedTicks}/${patienceTicks} · ${blockers.join(' · ')}`;
    }

    return {
        ready,
        forced: !qualified && deadlineReached,
        contract: side,
        barrier: prediction,
        samples,
        baseline,
        confidence,
        threshold,
        quietTicks,
        burst,
        waited: waitedTicks,
        patience: patienceTicks,
        state: state ? 'CLEAN' : 'VIOLATION',
        reason,
    };
};
