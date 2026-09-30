/**
 * Pure Omni Forge candidate analysis — the per-candidate mathematics the
 * generated DBot runs inside `ntAnalyseContracts`. Extracted (in the spirit
 * of digit-forge-analysis.js) so the exact runtime maths is deterministic
 * and testable without a websocket or Blockly.
 *
 * Per candidate per market, over the last W digits:
 *   · Beta(20·p0, 20·(1−p0)) prior shrinks short tapes to fair odds
 *   · Wilson one-sided 90% lower bound vs the payout's break-even
 *   · 2-state Markov chain (add-one smoothed); RECOVERY conditions on the
 *     loss state it actually enters from
 *   · loss-clustering ratio and split-half instability as penalties
 *
 * THE CLUSTERING GUARD
 * ────────────────────
 *   The clustering ratio divides P(loss|loss) by the tape's own loss rate.
 *   That reference collapses exactly when a high-probability leg is about to
 *   qualify: Over 0 / Under 9 / Differs price at ~1.09×, so their break-even
 *   (91.7%) only ever admits tapes with ≤ 8% losses — where the
 *   add-one-smoothed estimate (ll+1)/(ll+lw+2) reads ≈ 1/(losses+2) no
 *   matter how the handful of losses is arranged. The ratio therefore read
 *   4×…35× against any ≤ 8-loss tape and the normal-mode gate was
 *   mathematically UNSATISFIABLE for those legs: the EV/Wilson bounds
 *   demanded ≥ 113/120 wins while the clustering penalty demanded ≥ 24/300
 *   observed losses — the feasible region was empty at the default window.
 *   (Recovery mode's looser EV (−1%) and LCB (−5pt) bounds leave ≥ 10
 *   observable losses, which is why recovery legs always could fire.)
 *   With fewer than OMNI_FORGE_LIMITS.minClusterLosses losses there is no
 *   signal to punish, so clustering is reported as neutral (1.0). The EV and
 *   Wilson constraints still refuse weak tapes; legs whose loss count IS
 *   measurable keep the full penalty.
 *
 * Kept in parity with the API's forge-time replica in
 * artifacts/api-server/src/lib/omni-forge-dbot.ts (`analyseForgeGate`),
 * which quotes each chosen contract's qualification odds before forge time.
 */

export const OMNI_FORGE_LIMITS = Object.freeze({
    priorStrength: 20,
    confidenceZ: 1.282, // one-sided 90% — rejects noise without endless silence
    /** Losses needed before P(loss|loss) is more signal than add-one noise. */
    minClusterLosses: 10,
    /**
     * A debt-sized recovery must persist as the best candidate on this many
     * DISTINCT fresh ticks before it may fire. Settlement clears the
     * confirmation state after every trade, so no recovery executes without a
     * genuinely fresh post-trade rescan of every watched market — exactly the
     * Nexus Hedge rescan mandate.
     */
    recoveryConfirmations: 2,
    /**
     * After a settled LOSS the exact losing tuple (symbol:contract:barrier)
     * starts its next scans from a score deficit (decaying per scan, spanning
     * exactly the confirmation window), so an alternate market/contract with
     * a comparable edge wins the rescan instead of the bot re-firing on the
     * tape it just lost on.
     */
    rematchPenalty: 3,
    rematchDecay: 1.5,
    normal: Object.freeze({
        minSamples: 30,
        minEv: 0,
        lowerBoundMargin: 0.025,
        maxInstability: 0.16,
        maxClustering: 1.45,
    }),
    recovery: Object.freeze({
        minSamples: 20,
        minEv: -0.01,
        lowerBoundMargin: 0.05,
        maxInstability: Infinity,
        maxClustering: 1.6,
    }),
});

/**
 * Score one resolved candidate against one tape.
 * `wins` is the tape already mapped through the candidate's win predicate;
 * `p0` the uniform-tape fair rate used by the Beta prior.
 */
export const analyseOmniForgeCandidate = ({ wins, p0, payout, mode = 'NORMAL' }) => {
    const isRecovery = mode === 'RECOVERY';
    const limits = isRecovery ? OMNI_FORGE_LIMITS.recovery : OMNI_FORGE_LIMITS.normal;
    const z = OMNI_FORGE_LIMITS.confidenceZ;
    const n = wins.length;
    const hits = wins.filter(Boolean).length;
    const losses = n - hits;
    const probability = (hits + OMNI_FORGE_LIMITS.priorStrength * p0) / (n + OMNI_FORGE_LIMITS.priorStrength);
    const denom = 1 + (z * z) / n;
    const centre = probability + (z * z) / (2 * n);
    const spread = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * n)) / n);
    const lowerBound = (centre - spread) / denom;
    const breakEven = 1 / payout;
    const ev = probability * payout - 1;
    let ll = 0,
        lw = 0,
        wl = 0,
        ww = 0;
    for (let i = 1; i < n; i++) {
        if (!wins[i - 1] && !wins[i]) ll++;
        else if (!wins[i - 1]) lw++;
        else if (!wins[i]) wl++;
        else ww++;
    }
    const afterLoss = (lw + 1) / (ll + lw + 2);
    const afterWin = (ww + 1) / (wl + ww + 2);
    const markov = wins[n - 1] ? afterWin : afterLoss;
    const lossRate = 1 - probability;
    // Too few losses to MEASURE clustering → neutral, never penalised (see
    // the header note). Just above the guard the full penalty applies.
    const clustering =
        losses >= OMNI_FORGE_LIMITS.minClusterLosses
            ? (ll + 1) / (ll + lw + 2) / Math.max(0.01, lossRate)
            : 1;
    const half = Math.max(10, Math.floor(n / 2));
    const recent = wins.slice(-half).filter(Boolean).length / half;
    const prior = wins.slice(0, half).filter(Boolean).length / half;
    const instability = Math.abs(recent - prior);
    // RECOVERY conditions on the loss state it actually enters from.
    const conditionalEdge = (isRecovery ? afterLoss : markov) - breakEven;
    const score =
        100 *
        ((lowerBound - breakEven) * 0.55 +
            conditionalEdge * 0.25 +
            ev * 0.2 -
            instability * 0.2 -
            Math.max(0, clustering - 1) * 0.08);
    const eligible =
        n >= limits.minSamples &&
        ev > limits.minEv &&
        lowerBound > breakEven - limits.lowerBoundMargin &&
        instability < limits.maxInstability &&
        clustering < limits.maxClustering;
    return {
        samples: n,
        probability,
        lowerBound,
        breakEven,
        ev,
        markov,
        clustering,
        instability,
        losses,
        score,
        eligible,
    };
};
