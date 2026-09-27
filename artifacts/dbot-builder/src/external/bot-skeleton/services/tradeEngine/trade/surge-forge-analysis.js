/**
 * Pure multi-lens Rise/Fall analysis for the generated Vector Surge DBot.
 *
 * The model intentionally combines structures that fail differently:
 * recency-weighted Bayes, order-1/2 Markov transitions, empirical run hazard,
 * robust drift and multi-horizon direction rates. A candidate must have
 * positive payout utility, stable horizons, acceptable loss-pair risk and
 * sufficient cross-lens agreement. The runtime adds fresh-tick confirmation
 * and cross-market ranking around this pure function.
 */

const Z = 1.282; // one-sided 90%
const PRIOR = 24;
const HALF_LIFE = 80;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = x => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
const logit = p => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
const pct = p => `${(p * 100).toFixed(1)}%`;

const weightedPosterior = wins => {
    let alpha = PRIOR * 0.5;
    let beta = PRIOR * 0.5;
    let sumW = 0;
    let sumW2 = 0;
    const newest = wins.length - 1;
    wins.forEach((won, index) => {
        const w = Math.pow(0.5, (newest - index) / HALF_LIFE);
        if (won) alpha += w;
        else beta += w;
        sumW += w;
        sumW2 += w * w;
    });
    const total = alpha + beta;
    return {
        mean: alpha / total,
        variance: (alpha * beta) / (total * total * (total + 1)),
        effectiveSamples: sumW2 > 0 ? (sumW * sumW) / sumW2 : 0,
    };
};

const betaRate = (wins, prior = 8) => (wins.filter(Boolean).length + prior * 0.5) / (wins.length + prior);

const markovProbability = wins => {
    if (wins.length < 3) return 0.5;
    const last = Number(wins[wins.length - 1]);
    const previous = Number(wins[wins.length - 2]);
    let oneWins = 0, oneN = 0, twoWins = 0, twoN = 0;
    for (let i = 1; i < wins.length; i++) {
        if (Number(wins[i - 1]) === last) {
            oneN += 1;
            oneWins += Number(wins[i]);
        }
        if (i >= 2 && Number(wins[i - 2]) === previous && Number(wins[i - 1]) === last) {
            twoN += 1;
            twoWins += Number(wins[i]);
        }
    }
    const p1 = (oneWins + 0.5) / (oneN + 1);
    const p2 = (twoWins + 0.5) / (twoN + 1);
    const w1 = oneN / (oneN + 14);
    const w2 = twoN / (twoN + 10);
    const shrunk1 = 0.5 * (1 - w1) + p1 * w1;
    return shrunk1 * (1 - w2) + p2 * w2;
};

const runHazardProbability = wins => {
    if (wins.length < 10) return 0.5;
    const current = wins[wins.length - 1];
    let age = 1;
    for (let i = wins.length - 2; i >= 0 && wins[i] === current; i--) age += 1;
    const completed = [];
    let state = wins[0];
    let length = 1;
    for (let i = 1; i < wins.length; i++) {
        if (wins[i] === state) length += 1;
        else {
            completed.push({ state, length });
            state = wins[i];
            length = 1;
        }
    }
    const comparable = completed.filter(run => run.state === current && run.length >= age);
    const ended = comparable.filter(run => run.length === age).length;
    const hazard = (ended + 1) / (comparable.length + 2);
    return current ? 1 - hazard : hazard;
};

const robustDriftProbability = (returns, side) => {
    const recent = returns.slice(-80);
    if (recent.length < 20) return 0.5;
    const sorted = [...recent].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const deviations = recent.map(v => Math.abs(v - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)] || 1e-9;
    const alpha = 0.12;
    let ema = 0;
    for (const value of recent) ema = alpha * value + (1 - alpha) * ema;
    const z = clamp(ema / (1.4826 * mad * Math.sqrt(alpha / (2 - alpha))), -4, 4);
    const rise = sigmoid(z * 0.85);
    return side === 'CALL' ? rise : 1 - rise;
};

const sideAnalysis = ({ returns, directions, side, payout, mode, weights, tau }) => {
    const targetUp = side === 'CALL';
    const wins = directions.map(direction => (targetUp ? direction > 0 : direction < 0));
    const posterior = weightedPosterior(wins);
    const markov = markovProbability(wins);
    const hazard = runHazardProbability(wins);
    const drift = robustDriftProbability(returns, side);
    const short = betaRate(wins.slice(-20));
    const medium = betaRate(wins.slice(-60));
    const long = betaRate(wins);
    const horizon = 0.5 * short + 0.3 * medium + 0.2 * long;
    const lenses = [posterior.mean, markov, hazard, (drift + horizon) / 2];
    const safeWeights = Array.isArray(weights) && weights.length === 4
        ? weights.map(v => Math.max(0.01, Number(v) || 0.01))
        : [0.3, 0.25, 0.2, 0.25];
    const weightTotal = safeWeights.reduce((a, b) => a + b, 0);
    const pooledLogit = lenses.reduce((sum, value, index) => sum + safeWeights[index] * logit(value), 0) / weightTotal;
    const temperature = clamp(Number(tau) || 1, 0.5, 2.5);
    const probability = sigmoid(pooledLogit / temperature);

    let ll = 0, lw = 0;
    for (let i = 1; i < wins.length; i++) {
        if (!wins[i - 1] && !wins[i]) ll += 1;
        else if (!wins[i - 1] && wins[i]) lw += 1;
    }
    const qLL = (ll + 0.5) / (ll + lw + 1);
    const pairRisk = (1 - probability) * qLL;
    const instability = Math.max(Math.abs(short - medium), Math.abs(medium - long));
    const lensMean = lenses.reduce((a, b) => a + b, 0) / lenses.length;
    const disagreement = Math.sqrt(lenses.reduce((sum, value) => sum + (value - lensMean) ** 2, 0) / lenses.length);
    const se = Math.sqrt(Math.max(1e-9, posterior.variance));
    const lowerBound = clamp(probability - Z * se, 0, 1);
    const totalReturn = Number(payout);
    const validPayout = Number.isFinite(totalReturn) && totalReturn > 1;
    const breakEven = validPayout ? 1 / totalReturn : 1;
    const pairWeight = mode === 'RECOVERY' ? 0.45 : 0.18;
    const utility = validPayout ? probability * totalReturn - 1 - pairWeight * pairRisk : -999;
    const blockers = [];
    if (wins.length < 79) blockers.push(`samples ${wins.length}/79`);
    if (!validPayout) blockers.push('payout unavailable');
    if (probability <= breakEven + (mode === 'RECOVERY' ? 0.008 : 0.004)) blockers.push(`probability ${pct(probability)} vs BE ${pct(breakEven)}`);
    if (lowerBound <= breakEven - (mode === 'RECOVERY' ? 0.018 : 0.025)) blockers.push(`90% bound ${pct(lowerBound)}`);
    if (utility <= 0) blockers.push(`utility ${utility.toFixed(3)}`);
    if (instability >= (mode === 'RECOVERY' ? 0.12 : 0.16)) blockers.push(`unstable ${(instability * 100).toFixed(1)}pt`);
    if (disagreement >= (mode === 'RECOVERY' ? 0.16 : 0.2)) blockers.push(`lens disagreement ${(disagreement * 100).toFixed(1)}pt`);
    if (mode === 'RECOVERY' && qLL >= 0.58) blockers.push(`loss continuation ${pct(qLL)}`);
    return {
        contract: side,
        payout: totalReturn,
        probability,
        lowerBound,
        breakEven,
        utility,
        qLL,
        pairRisk,
        instability,
        disagreement,
        lenses,
        shortRate: short,
        mediumRate: medium,
        eligible: blockers.length === 0,
        blockers,
    };
};

export const analyseSurgeMarket = ({ prices, payout = 1.92, mode = 'NORMAL', weights, tau = 1 }) => {
    const clean = (Array.isArray(prices) ? prices : [])
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
    const returns = [];
    const directions = [];
    for (let i = 1; i < clean.length; i++) {
        const change = clean[i] - clean[i - 1];
        returns.push(change);
        if (change !== 0) directions.push(change > 0 ? 1 : -1);
    }
    const flatRate = returns.length > 0 ? 1 - directions.length / returns.length : 1;
    const normalizedMode = String(mode).toUpperCase() === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
    const sides = ['CALL', 'PUT'].map(side => sideAnalysis({
        returns,
        directions,
        side,
        payout,
        mode: normalizedMode,
        weights,
        tau,
    }));
    for (const side of sides) {
        if (flatRate >= 0.2) {
            side.eligible = false;
            side.blockers.push(`flat tape ${(flatRate * 100).toFixed(1)}%`);
        }
        side.score = 100 * (side.utility - side.instability * 0.25 - side.disagreement * 0.2 - Math.max(0, side.qLL - 0.5) * 0.2);
        side.reason = side.eligible
            ? `READY · ${side.contract === 'CALL' ? 'Rise' : 'Fall'} ${pct(side.probability)} · bound ${pct(side.lowerBound)} · pair-risk ${pct(side.pairRisk)}`
            : `HOLD · ${side.blockers.join(' · ')}`;
    }
    sides.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
    return { ...sides[0], alternatives: sides, samples: directions.length, flatRate };
};

export const SURGE_FORGE_LIMITS = Object.freeze({
    minSamples: 79,
    confirmations: 2,
    maxRecoveryQLL: 0.58,
    maxRecoveryInstability: 0.12,
});
