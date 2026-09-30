/**
 * Pure Digit Forge candidate analysis.
 *
 * Recovery is deliberately stricter than the old "best score wins" gate. A
 * debt-sized trade is admitted only when the full tape, two recent horizons,
 * and the loss-conditioned transition row agree, while clustered/adverse runs
 * veto the entry. Keeping this function pure makes the exact DBot runtime maths
 * deterministic and testable without a websocket or Blockly.
 */

const PRIOR_STRENGTH = 24;
const CONTEXT_PRIOR_STRENGTH = 14;
const HALF_LIFE = 60;
const CONFIDENCE_Z = 1.282; // one-sided 90%

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pct = value => `${(value * 100).toFixed(1)}%`;

const posterior = (wins, priorMean, priorStrength = PRIOR_STRENGTH) => {
    let alpha = priorStrength * priorMean;
    let beta = priorStrength * (1 - priorMean);
    const newest = wins.length - 1;
    wins.forEach((won, index) => {
        const weight = Math.pow(0.5, (newest - index) / HALF_LIFE);
        if (won) alpha += weight;
        else beta += weight;
    });
    const total = alpha + beta;
    const mean = total > 0 ? alpha / total : priorMean;
    const variance = total > 0 ? (alpha * beta) / (total * total * (total + 1)) : 0.25;
    return {
        mean,
        lowerBound: clamp(mean - CONFIDENCE_Z * Math.sqrt(Math.max(0, variance)), 0, 1),
    };
};

const smoothedRate = (wins, priorMean) =>
    (wins.filter(Boolean).length + 6 * priorMean) / (wins.length + 6);

/** Analyse one legal Over/Under candidate against one market tape. */
export const analyseDigitForgeCandidate = ({ digits, contract, barrier, payout, mode = 'NORMAL' }) => {
    const clean = (Array.isArray(digits) ? digits : [])
        .filter(digit => typeof digit === 'number' || (typeof digit === 'string' && /^[0-9]$/.test(digit)))
        .map(Number)
        .filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const side = contract === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER';
    const prediction = clamp(Math.trunc(Number(barrier) || 0), 0, 9);
    const totalReturn = Number(payout);
    const hasPayout = Number.isFinite(totalReturn) && totalReturn > 1;
    const breakEven = hasPayout ? 1 / totalReturn : 1;
    const p0 = side === 'DIGITOVER' ? (9 - prediction) / 10 : prediction / 10;
    const wins = clean.map(digit => (side === 'DIGITOVER' ? digit > prediction : digit < prediction));
    const marginal = posterior(wins, p0);

    // Hierarchical P(win | previous loss). Sparse transition rows shrink to the
    // marginal posterior rather than manufacturing an edge from two lucky pairs.
    let afterLossWins = 0;
    let afterLossLosses = 0;
    for (let index = 0; index < wins.length - 1; index++) {
        if (wins[index]) continue;
        if (wins[index + 1]) afterLossWins += 1;
        else afterLossLosses += 1;
    }
    const contextSamples = afterLossWins + afterLossLosses;
    const contextAlpha = CONTEXT_PRIOR_STRENGTH * marginal.mean + afterLossWins;
    const contextBeta = CONTEXT_PRIOR_STRENGTH * (1 - marginal.mean) + afterLossLosses;
    const contextTotal = contextAlpha + contextBeta;
    const afterLoss = contextAlpha / contextTotal;
    const contextVariance = (contextAlpha * contextBeta) / (contextTotal * contextTotal * (contextTotal + 1));
    const afterLossLowerBound = clamp(afterLoss - CONFIDENCE_Z * Math.sqrt(Math.max(0, contextVariance)), 0, 1);

    const shortSize = Math.min(24, wins.length);
    const mediumSize = Math.min(60, wins.length);
    const shortRate = smoothedRate(wins.slice(-shortSize), p0);
    const mediumRate = smoothedRate(wins.slice(-mediumSize), p0);
    const oldRate = smoothedRate(wins.slice(0, mediumSize), p0);
    const instability = Math.max(Math.abs(shortRate - mediumRate), Math.abs(mediumRate - oldRate));

    const lossAfterLoss = (afterLossLosses + 1) / (contextSamples + 2);
    const clusterRatio = lossAfterLoss / Math.max(0.01, 1 - marginal.mean);
    let adverseRun = 0;
    for (let index = wins.length - 1; index >= 0 && !wins[index]; index--) adverseRun += 1;

    const expectedValue = hasPayout ? marginal.mean * totalReturn - 1 : -1;
    const recovery = String(mode).toUpperCase() === 'RECOVERY';
    const blockers = [];
    if (!hasPayout) blockers.push('payout unavailable');
    if (clean.length < (recovery ? 50 : 40)) blockers.push(`samples ${clean.length}/${recovery ? 50 : 40}`);
    if (marginal.lowerBound <= breakEven - (recovery ? 0.015 : 0.02)) {
        blockers.push(`90% lower bound ${pct(marginal.lowerBound)} vs BE ${pct(breakEven)}`);
    }
    if (expectedValue <= 0) blockers.push(`EV ${(expectedValue * 100).toFixed(2)}%`);
    if (recovery) {
        if (contextSamples < 12) blockers.push(`loss context ${contextSamples}/12`);
        if (afterLossLowerBound <= breakEven - 0.02) {
            blockers.push(`post-loss bound ${pct(afterLossLowerBound)} vs BE ${pct(breakEven)}`);
        }
        if (shortRate <= breakEven || mediumRate <= breakEven) blockers.push('recent horizons disagree');
        if (clusterRatio >= 1.2) blockers.push(`loss clustering ${clusterRatio.toFixed(2)}x`);
        if (instability >= 0.12) blockers.push(`unstable ${(instability * 100).toFixed(1)}pt`);
        if (adverseRun > 2) blockers.push(`adverse run ${adverseRun}`);
    } else {
        if (clusterRatio >= 1.35) blockers.push(`loss clustering ${clusterRatio.toFixed(2)}x`);
        if (instability >= 0.16) blockers.push(`unstable ${(instability * 100).toFixed(1)}pt`);
        if (adverseRun > 4) blockers.push(`adverse run ${adverseRun}`);
    }

    const eligible = blockers.length === 0;
    const score = 100 * (
        (marginal.lowerBound - breakEven) * 0.35 +
        (afterLossLowerBound - breakEven) * (recovery ? 0.35 : 0.15) +
        expectedValue * 0.2 +
        (shortRate - breakEven) * 0.15 -
        Math.max(0, clusterRatio - 1) * 0.15 -
        instability * 0.2 -
        adverseRun * 0.015
    );

    return {
        eligible,
        contract: side,
        barrier: prediction,
        samples: clean.length,
        probability: marginal.mean,
        lowerBound: marginal.lowerBound,
        breakEven,
        ev: expectedValue,
        afterLoss,
        afterLossLowerBound,
        contextSamples,
        shortRate,
        mediumRate,
        clustering: clusterRatio,
        instability,
        adverseRun,
        score,
        blockers,
        reason: eligible
            ? `READY · LCB ${pct(marginal.lowerBound)} · post-loss ${pct(afterLossLowerBound)} · clustering ${clusterRatio.toFixed(2)}x`
            : `HOLD · ${blockers.join(' · ')}`,
    };
};

export const DIGIT_FORGE_ANALYSIS_LIMITS = Object.freeze({
    priorStrength: PRIOR_STRENGTH,
    contextPriorStrength: CONTEXT_PRIOR_STRENGTH,
    confidenceZ: CONFIDENCE_Z,
    recoveryConfirmations: 2,
    maxRecoveryClusterRatio: 1.2,
    maxRecoveryInstability: 0.12,
    maxRecoveryAdverseRun: 2,
    // ── Intelligent recovery rescan (2026-09-30 fix) ──────────────────────────
    // After a settled LOSS the exact losing tuple (symbol:contract:barrier)
    // starts its next recovery scans from a STRONG score deficit that decays
    // SLOWLY and SCALES with the loss streak. The old 3pt/1.5-decay lasted
    // only 2 fresh ticks — one loss barely dents a 50+ sample posterior, so
    // the same tape kept ranking #1 and the bot re-fired on the tape it just
    // lost on for up to 10 losses. Now:
    //   • base penalty 8 (≈ 800 score points) guarantees an alternate market
    //     with a comparable edge wins the post-loss rescan;
    //   • decay 0.8 lasts ~10 fresh ticks, so the loser cannot re-enter until
    //     it genuinely tops every penalised scan;
    //   • Total.js scales the penalty as base + 2·(lossRun-1), so a 3-loss
    //     streak penalises 12pts and a 5-loss streak 16pts — the longer the
    //     lock, the harder the rescan forces a market switch.
    // Confirmation (2 distinct fresh ticks) still applies on top: no recovery
    // may fire without a genuinely fresh post-trade rescan of every watched
    // market, and repeated passes over one snapshot never count.
    rematchPenalty: 8,
    rematchDecay: 0.8,
    // Loss-run adaptive: Total.js computes `penalty = base + 2·(lossRun-1)`.
    rematchPenaltyPerLoss: 2,
});
