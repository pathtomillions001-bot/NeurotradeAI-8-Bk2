/**
 * Pure Nexus Hedge candidate analysis — universal super-hedge maths.
 *
 * Extends Omni Forge with hedge-aware components:
 *  - multi-scale EW posterior (approximated via Beta prior here; EW blend lives in Ticks)
 *  - Dirichlet-10 transition posterior for barrier contexts
 *  - phi = P(recovery win | normal loss) - P(recovery win) and rho correlation
 *  - ladder-aware ExpectedLogUtility and elastic Kelly sizing (stake handled in XML)
 *  - Page-Hinkley drift freeze (handled in Ticks)
 *
 * This module stays pure and testable. The Ticks wrapper computes phi/rho by
 * joining normal vs recovery win streams per market.
 */

export const NEXUS_HEDGE_LIMITS = Object.freeze({
    priorStrength: 20,
    dirichletAlpha: 10,
    confidenceZ: 1.282,
    minClusterLosses: 10,
    // A debt-sized recovery must persist as the best candidate on this many
    // DISTINCT fresh ticks before it may fire. Count restarts after every
    // settled trade (settlement clears confirmation), so no recovery executes
    // without a genuinely fresh post-trade rescan of every watched market.
    // Upgraded 2026-09-30: escalates to 3 confirmations when lossRun ≥3 —
    // larger debt demands more fresh proof before a hedge stake fires.
    recoveryConfirmations: 2,
    // After a settled LOSS the exact losing tuple starts its next scans from
    // a STRONG score deficit that decays SLOWLY and SCALES with loss streak.
    // Old 3pt/1.5 lasted only 2 fresh ticks — the same tape kept ranking #1
    // and the bot looped 10 losses on one market. Now base 8, decay 0.8
    // (≈10 ticks), plus Total.js scales as base + 2·(lossRun-1): a 3-loss
    // streak penalises 12, a 5-loss streak 16 — the longer the lock, the
    // harder the rescan forces a market/contract switch. No recovery without
    // a fresh rescan; loser re-enters only by topping every penalised scan.
    rematchPenalty: 8,
    rematchDecay: 0.8,
    rematchPenaltyPerLoss: 2,
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

export const analyseNexusHedgeCandidate = ({ wins, p0, payout, mode = 'NORMAL', hedge = 0 }) => {
    const isRecovery = mode === 'RECOVERY';
    const limits = isRecovery ? NEXUS_HEDGE_LIMITS.recovery : NEXUS_HEDGE_LIMITS.normal;
    const z = NEXUS_HEDGE_LIMITS.confidenceZ;
    const n = wins.length;
    const hits = wins.filter(Boolean).length;
    const losses = n - hits;
    const probability = (hits + NEXUS_HEDGE_LIMITS.priorStrength * p0) / (n + NEXUS_HEDGE_LIMITS.priorStrength);
    const denom = 1 + (z * z) / n;
    const centre = probability + (z * z) / (2 * n);
    const spread = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * n)) / n);
    const lowerBound = (centre - spread) / denom;
    const breakEven = 1 / payout;
    const ev = probability * payout - 1;
    let ll = 0, lw = 0, wl = 0, ww = 0;
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
    const clustering =
        losses >= NEXUS_HEDGE_LIMITS.minClusterLosses
            ? (ll + 1) / (ll + lw + 2) / Math.max(0.01, lossRate)
            : 1;
    const half = Math.max(10, Math.floor(n / 2));
    const recent = wins.slice(-half).filter(Boolean).length / half;
    const prior = wins.slice(0, half).filter(Boolean).length / half;
    const instability = Math.abs(recent - prior);
    const conditionalEdge = (isRecovery ? afterLoss : markov) - breakEven;
    // Hedge uplift: phi>0 (recovery wins when normal loses) and rho<0 boost score
    const hedgeBonus = hedge * 0.12;
    const score =
        100 *
        ((lowerBound - breakEven) * 0.5 +
            conditionalEdge * 0.22 +
            ev * 0.18 -
            instability * 0.18 -
            Math.max(0, clustering - 1) * 0.07 +
            hedgeBonus);
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
        hedgeScore: hedge,
        score,
        eligible,
    };
};

// Convenience alias for tests that import the omni-style name
export const analyseOmniForgeCandidate = analyseNexusHedgeCandidate;
export const OMNI_FORGE_LIMITS = NEXUS_HEDGE_LIMITS;
