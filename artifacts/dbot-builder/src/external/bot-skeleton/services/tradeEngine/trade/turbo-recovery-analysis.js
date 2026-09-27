/**
 * In-bot recovery timing for generated Over/Under Turbo strategies.
 *
 * The model deliberately predicts the FIXED recovery contract selected by the
 * pre-deploy scan; it never changes the user's market, side or barrier. A
 * recency-weighted Beta posterior estimates the marginal hit rate, then a
 * hierarchical two-state Markov row estimates the next hit conditional on the
 * latest recovery win/loss state. The lower posterior bound, loss clustering,
 * stationarity and balance-aware log utility must all agree before entry.
 */

const MIN_SAMPLES = 40;
const MIN_CONTEXT_SAMPLES = 12;
const PRIOR_STRENGTH = 20;
const CONTEXT_PRIOR_STRENGTH = 12;
const HALF_LIFE = 50;
const CONFIDENCE_Z = 1.282; // one-sided 90%
const MAX_CLUSTER_RATIO = 1.08;
const MAX_INSTABILITY = 0.14;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const pct = value => `${(value * 100).toFixed(1)}%`;

const isRecoveryWin = (digit, contract, barrier) => (contract === 'DIGITOVER' ? digit > barrier : digit < barrier);

const weightedRate = (values, priorMean, priorStrength) => {
    let wins = priorStrength * priorMean;
    let total = priorStrength;
    let sumWeights = 0;
    let sumSquaredWeights = 0;
    const newest = values.length - 1;
    values.forEach((won, index) => {
        const age = newest - index;
        const weight = Math.pow(0.5, age / HALF_LIFE);
        wins += weight * Number(won);
        total += weight;
        sumWeights += weight;
        sumSquaredWeights += weight * weight;
    });
    return {
        mean: wins / total,
        effectiveSamples: sumSquaredWeights > 0 ? (sumWeights * sumWeights) / sumSquaredWeights : 0,
    };
};

/**
 * Analyse whether the next tick is a statistically defensible recovery entry.
 * This function is pure so the production runtime and deterministic tests use
 * exactly the same maths.
 */
export const analyseTurboRecovery = ({ digits, contract, barrier, payout, stake, balance }) => {
    const clean = (Array.isArray(digits) ? digits : [])
        .map(Number)
        .filter(digit => Number.isInteger(digit) && digit >= 0 && digit <= 9);
    const side = contract === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER';
    const prediction = clamp(Math.round(Number(barrier) || 0), 0, 9);
    const totalReturn = Number(payout);
    const hasValidPayout = Number.isFinite(totalReturn) && totalReturn > 1;
    const breakEven = hasValidPayout ? 1 / totalReturn : 1;
    const p0 = side === 'DIGITOVER' ? (9 - prediction) / 10 : prediction / 10;
    const wins = clean.map(digit => isRecoveryWin(digit, side, prediction));
    const marginal = weightedRate(wins, p0, PRIOR_STRENGTH);

    let contextWins = 0;
    let contextLosses = 0;
    let contextWeight = 0;
    let contextWeightSquared = 0;
    let contextSamples = 0;
    const currentState = wins.length > 0 ? wins[wins.length - 1] : false;
    const newestPair = wins.length - 2;
    for (let index = 0; index < wins.length - 1; index++) {
        if (wins[index] !== currentState) continue;
        const age = newestPair - index;
        const weight = Math.pow(0.5, age / HALF_LIFE);
        if (wins[index + 1]) contextWins += weight;
        else contextLosses += weight;
        contextWeight += weight;
        contextWeightSquared += weight * weight;
        contextSamples += 1;
    }

    // Hierarchical shrinkage: a sparse transition row falls back to the
    // well-supported marginal posterior instead of inventing a strong edge.
    const alpha = CONTEXT_PRIOR_STRENGTH * marginal.mean + contextWins;
    const beta = CONTEXT_PRIOR_STRENGTH * (1 - marginal.mean) + contextLosses;
    const posteriorTotal = alpha + beta;
    const probability = posteriorTotal > 0 ? alpha / posteriorTotal : p0;
    const variance =
        posteriorTotal > 0 ? (alpha * beta) / (posteriorTotal * posteriorTotal * (posteriorTotal + 1)) : 0.25;
    const lowerBound = clamp(probability - CONFIDENCE_Z * Math.sqrt(Math.max(0, variance)), 0, 1);
    const contextEffectiveSamples =
        contextWeightSquared > 0 ? (contextWeight * contextWeight) / contextWeightSquared : 0;

    let lossLoss = 0;
    let lossWin = 0;
    for (let index = 0; index < wins.length - 1; index++) {
        if (wins[index]) continue;
        if (wins[index + 1]) lossWin += 1;
        else lossLoss += 1;
    }
    const lossAfterLoss = (lossLoss + 1) / (lossLoss + lossWin + 2);
    const marginalLoss = Math.max(0.01, 1 - marginal.mean);
    const clusterRatio = lossAfterLoss / marginalLoss;

    const half = Math.max(1, Math.floor(wins.length / 2));
    const old = wins.slice(0, half);
    const recent = wins.slice(-half);
    const smoothedHalfRate = values => (values.filter(Boolean).length + 4 * p0) / (values.length + 4);
    const instability = Math.abs(smoothedHalfRate(recent) - smoothedHalfRate(old));

    const accountBalance = Number(balance);
    const proposedStake = Number(stake);
    const hasSafeBalance =
        Number.isFinite(accountBalance) &&
        Number.isFinite(proposedStake) &&
        accountBalance > 0 &&
        proposedStake >= 0.35 &&
        proposedStake < accountBalance &&
        hasValidPayout;
    const winFraction = hasSafeBalance ? (proposedStake * (totalReturn - 1)) / accountBalance : 0;
    const lossFraction = hasSafeBalance ? proposedStake / accountBalance : 1;
    const expectedUtility = hasSafeBalance
        ? probability * Math.log1p(winFraction) + (1 - probability) * Math.log1p(-lossFraction)
        : -999;

    const blockers = [];
    if (!hasValidPayout) blockers.push('live payout unavailable');
    if (clean.length < MIN_SAMPLES) blockers.push(`samples ${clean.length}/${MIN_SAMPLES}`);
    if (contextSamples < MIN_CONTEXT_SAMPLES || contextEffectiveSamples < MIN_CONTEXT_SAMPLES / 2) {
        blockers.push(`context ${contextSamples}/${MIN_CONTEXT_SAMPLES}`);
    }
    if (lowerBound <= breakEven) blockers.push(`90% lower bound ${pct(lowerBound)} ≤ BE ${pct(breakEven)}`);
    if (clusterRatio > MAX_CLUSTER_RATIO) blockers.push(`loss clustering ${clusterRatio.toFixed(2)}x`);
    if (instability >= MAX_INSTABILITY) blockers.push(`unstable ${(instability * 100).toFixed(1)}pt`);
    if (!hasSafeBalance) blockers.push('stake/balance unavailable or unsafe');
    else if (expectedUtility <= 0) blockers.push(`log utility ${expectedUtility.toFixed(4)} ≤ 0`);

    const eligible = blockers.length === 0;
    return {
        eligible,
        contract: side,
        barrier: prediction,
        samples: clean.length,
        effectiveSamples: marginal.effectiveSamples,
        contextSamples,
        contextEffectiveSamples,
        currentState: currentState ? 'WIN' : 'LOSS',
        probability,
        lowerBound,
        breakEven,
        payout: totalReturn,
        clusterRatio,
        instability,
        expectedUtility,
        reason: eligible
            ? `READY · ${pct(lowerBound)} lower bound > ${pct(breakEven)} BE · utility ${expectedUtility.toFixed(4)} · clustering ${clusterRatio.toFixed(2)}x`
            : `HOLD · ${blockers.join(' · ')}`,
    };
};

export const TURBO_RECOVERY_ANALYSIS_LIMITS = Object.freeze({
    minSamples: MIN_SAMPLES,
    minContextSamples: MIN_CONTEXT_SAMPLES,
    confidenceZ: CONFIDENCE_Z,
    maxClusterRatio: MAX_CLUSTER_RATIO,
    maxInstability: MAX_INSTABILITY,
});
