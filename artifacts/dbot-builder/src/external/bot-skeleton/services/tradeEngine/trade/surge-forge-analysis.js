/**
 * Pure multi-lens Rise/Fall analysis for the generated Vector Surge DBot.
 *
 * ── PULSE v2 ─────────────────────────────────────────────────────────────────
 * Rebuilt around three questions, in order:
 *
 *  Q1 "IS THIS TAPE EXPLOITABLE AT ALL?" — the regime gate.
 *     A marginal-adjusted persistence z-score compares the observed stay-rate
 *     against the stay-rate an iid tape with the SAME up/down mix would have
 *     (p_exp = p_up² + p_down²), so skew alone never masquerades as structure.
 *     The Wald–Wolfowitz runs z is reported alongside. Verdicts:
 *       · TRENDING  (z ≥ +1.28)  — continuation structure, ride runs
 *       · REVERSAL  (z ≤ −1.28)  — alternation structure, fade the last move
 *       · RANDOM    (otherwise)  — BOTH SIDES REFUSED. A 1-tick Rise/Fall
 *         contract at 1.92× needs 52.08% to break even; on a coin-flip tape
 *         every fired trade is −EV minus latency, so standing aside is the
 *         edge. This gate is what stops the old model bleeding on noise.
 *
 *  Q2 "WHICH SIDE, WITH WHAT PROBABILITY?" — four lenses, fused in logit
 *     space with the user's weights blended (geometric mean) with regime
 *     weights, one temperature τ:
 *       1. ADAPTIVE-MEMORY BAYES — recency-decayed Beta posterior with TWO
 *          half-lives (fast 20 / slow 60); a prequential log-score over the
 *          last 25 ticks picks whichever memory has been predicting better.
 *       2. ORDER-1 MARKOV CONDITIONAL — P(next | last direction) with
 *          Dirichlet(4,4) smoothing; this is the exploitable quantity the
 *          trade actually bets on.
 *       3. RECENCY-DECAYED RUN HAZARD — discrete hazard of the open run
 *          ending now, with completed runs exponentially decayed by age
 *          (half-life 60 ticks) so fresh micro-structure outweighs history.
 *       4. ROBUST DRIFT + MULTI-HORIZON — MAD-normalised EMA drift blended
 *          with short/medium/long direction rates (drift is discounted in
 *          REVERSAL regimes where it misleads).
 *
 *  Q3 "DO WE HAVE ENOUGH EVIDENCE TO FIRE NOW?" — speed without noise.
 *       · CONDITIONAL G-TEST (GLR): evidence = n_ctx · KL(p_fused ∥ p₀) over
 *         the transitions from the current last-direction state — a
 *         likelihood-ratio test of "the conditional edge is real" vs break-
 *         even p₀ = 1/payout. Fires the moment evidence crosses ln 9 (the
 *         sequential-testing boundary for 90%/90% errors), so a clean tape
 *         trades within ~50 ticks instead of waiting for every gate to line
 *         up by accident.
 *       · POSTERIOR TAIL: P(p > break-even) via the regularized incomplete
 *         beta function (≥ 0.80 normal / 0.70 recovery).
 *       · BETA QUANTILE LOWER BOUND: 10% quantile must clear break-even
 *         (strict in normal, −0.012 slack in recovery) — the old model
 *         happily fired with a bound 2.5pt UNDER break-even.
 *
 * Kept from v1 because they are good: logit opinion pool + temperature, the
 * loss-pair continuation veto (q_LL) in recovery, instability / disagreement
 * gates, flat-tape guard. Everything is pure and synchronous: one O(n) pass
 * builds a shared tape summary, both sides reuse it.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sigmoid = x => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));
const logit = p => Math.log(clamp(p, 1e-6, 1 - 1e-6) / (1 - clamp(p, 1e-6, 1 - 1e-6)));
const pct = p => `${(p * 100).toFixed(1)}%`;

// ── Tunables ─────────────────────────────────────────────────────────────────
const Z_REGIME = 1.282;             // one-sided 90% for regime classification
const PRIOR = 24;                   // Beta prior mass for recency posterior
const FAST_HALF_LIFE = 20;
const SLOW_HALF_LIFE = 60;
const SCORE_TAIL = 25;              // prequential scoring horizon (ticks)
const HAZARD_HALF_LIFE = 60;        // recency decay for completed runs (ticks)
const MARKOV_KAPPA = 8;             // Dirichlet smoothing mass (4 per cell)
const CONTEXT_MIN = 12;             // min transitions from the current state
const EVIDENCE_BOUND = Math.log(9); // GLR boundary ≈ 90%/90% sequential test
const RECOVERY_EVIDENCE_FACTOR = 0.8;
const EDGE_PROB_MIN = { NORMAL: 0.8, RECOVERY: 0.7 };
const LOWER_BOUND_SLACK = { NORMAL: 0, RECOVERY: 0.012 };
const MAX_INSTABILITY = { NORMAL: 0.16, RECOVERY: 0.12 };
const MAX_DISAGREEMENT = { NORMAL: 0.25, RECOVERY: 0.2 };
const REGIME_WEIGHTS = {
    TRENDING: [0.2, 0.35, 0.2, 0.25],
    REVERSAL: [0.25, 0.35, 0.25, 0.15],
    RANDOM: [0.25, 0.25, 0.25, 0.25],
};

// ── Special functions (regularized incomplete beta) ──────────────────────────
const lnGamma = z => {
    const g = [
        676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012,
        9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    z -= 1;
    let x = 0.99999999999980993;
    for (let i = 0; i < 8; i++) x += g[i] / (z + i + 1);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};

const betacf = (a, b, x) => {
    const MAXIT = 100;
    const EPS = 3e-12;
    const FPMIN = 1e-300;
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x) / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        c = 1 + aa / c;
        if (Math.abs(c) < FPMIN) c = FPMIN;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < EPS) break;
    }
    return h;
};

/** I_x(a,b) — regularized incomplete beta (CDF of Beta(a,b)). */
const betaCdf = (x, a, b) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lnPre = lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) return (Math.exp(lnPre) * betacf(a, b, x)) / a;
    return 1 - (Math.exp(lnPre) * betacf(b, a, 1 - x)) / b;
};

/** 10% quantile of Beta(a,b) by bisection on the CDF. */
const betaQuantile10 = (a, b) => {
    let lo = 1e-4;
    let hi = 1 - 1e-4;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (betaCdf(mid, a, b) < 0.1) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
};

// ── Tape summary (single pass, shared by both sides) ─────────────────────────
const summarizeTape = clean => {
    const returns = [];
    const directions = [];
    for (let i = 1; i < clean.length; i++) {
        const change = clean[i] - clean[i - 1];
        returns.push(change);
        if (change !== 0) directions.push(change > 0 ? 1 : -1);
    }
    const n = directions.length;
    let nU = 0;
    let nD = 0;
    let stays = 0;
    let nUU = 0;
    let nUD = 0;
    let nDU = 0;
    let nDD = 0;
    for (let i = 0; i < n; i++) {
        if (directions[i] > 0) nU += 1;
        else nD += 1;
        if (i > 0) {
            const prev = directions[i - 1];
            const cur = directions[i];
            if (prev === cur) stays += 1;
            if (prev > 0 && cur > 0) nUU += 1;
            else if (prev > 0 && cur < 0) nUD += 1;
            else if (prev < 0 && cur > 0) nDU += 1;
            else nDD += 1;
        }
    }
    // Completed runs with recency weights (for the decayed hazard lens).
    const runs = [];
    let state = directions[0];
    let length = 1;
    let start = 0;
    for (let i = 1; i <= n; i++) {
        if (i < n && directions[i] === state) {
            length += 1;
        } else {
            if (i < n) runs.push({ state, length, end: i - 1 });
            state = directions[i];
            length = 1;
            start = i;
        }
    }
    void start;
    const openState = n > 0 ? directions[n - 1] : 0;
    let openAge = 0;
    for (let i = n - 1; i >= 0 && directions[i] === openState; i--) openAge += 1;
    const flatRate = returns.length > 0 ? 1 - n / returns.length : 1;
    return { returns, directions, n, nU, nD, stays, nUU, nUD, nDU, nDD, runs, openState, openAge, flatRate };
};

/** Marginal-adjusted persistence z and Wald–Wolfowitz runs z. */
const regimeStats = t => {
    const { n, nU, nD, stays } = t;
    if (n < 8) return { zPersist: 0, runsZ: 0, regime: 'RANDOM' };
    const pUp = (nU + 4) / (n + 8);
    const pExp = pUp * pUp + (1 - pUp) * (1 - pUp);
    const pStay = stays / (n - 1);
    const se = Math.sqrt(Math.max(1e-9, (pExp * (1 - pExp)) / (n - 1)));
    const zPersist = (pStay - pExp) / se;
    let runsZ = 0;
    if (nU >= 5 && nD >= 5) {
        let runs = 1;
        for (let i = 1; i < n; i++) if (t.directions[i] !== t.directions[i - 1]) runs += 1;
        const twoNuNd = 2 * nU * nD;
        const E = twoNuNd / n + 1;
        const V = (twoNuNd * (twoNuNd - n)) / (n * n * (n - 1));
        runsZ = V > 0 ? (runs - E) / Math.sqrt(V) : 0;
    }
    let regime = 'RANDOM';
    if (zPersist >= Z_REGIME) regime = 'TRENDING';
    else if (zPersist <= -Z_REGIME) regime = 'REVERSAL';
    return { zPersist, runsZ, regime };
};

/** Recency-decayed Beta posterior for one half-life, with an optional
 *  prequential log-score over the final SCORE_TAIL observations. */
const recencyPosterior = (wins, halfLife) => {
    const decay = Math.pow(0.5, 1 / halfLife);
    let alpha = PRIOR / 2;
    let beta = PRIOR / 2;
    let logScore = 0;
    const scoreStart = wins.length - SCORE_TAIL;
    for (let i = 0; i < wins.length; i++) {
        alpha = PRIOR / 2 + (alpha - PRIOR / 2) * decay;
        beta = PRIOR / 2 + (beta - PRIOR / 2) * decay;
        if (i >= scoreStart) {
            const p = clamp(alpha / (alpha + beta), 1e-6, 1 - 1e-6);
            logScore += Math.log(wins[i] ? p : 1 - p);
        }
        if (wins[i]) alpha += 1;
        else beta += 1;
    }
    return { alpha, beta, mean: alpha / (alpha + beta), logScore };
};

/** Pick the memory that has actually been predicting better. */
const adaptivePosterior = wins => {
    if (wins.length < SCORE_TAIL + 10) {
        const slow = recencyPosterior(wins, SLOW_HALF_LIFE);
        return { ...slow, memory: SLOW_HALF_LIFE };
    }
    const fast = recencyPosterior(wins, FAST_HALF_LIFE);
    const slow = recencyPosterior(wins, SLOW_HALF_LIFE);
    if (fast.logScore >= slow.logScore) return { ...fast, memory: FAST_HALF_LIFE };
    return { ...slow, memory: SLOW_HALF_LIFE };
};

/** Discrete hazard of the open run ending now, completed runs decayed by age. */
const runHazardUpProbability = t => {
    const { runs, openState, openAge, n } = t;
    if (openAge < 1) return 0.5;
    let comparable = 0;
    let ended = 0;
    for (const run of runs) {
        if (run.state !== openState || run.length < openAge) continue;
        const w = Math.pow(0.5, (n - 1 - run.end) / HAZARD_HALF_LIFE);
        comparable += w;
        if (run.length === openAge) ended += w;
    }
    const hazard = (ended + 1) / (comparable + 2);
    // P(next direction flips) = hazard; convert to P(next is up).
    return openState > 0 ? 1 - hazard : hazard;
};

const robustDriftUpProbability = returns => {
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
    return sigmoid(z * 0.85);
};

const betaRate = (wins, prior = 8) => (wins.filter(Boolean).length + prior * 0.5) / (wins.length + prior);

const sideAnalysis = ({ tape, regime, side, payout, mode, weights, tau, upProbability, memoryMean, memory }) => {
    const targetUp = side === 'CALL';
    const wins = tape.directions.map(direction => (targetUp ? direction > 0 : direction < 0));
    const totalReturn = Number(payout);
    const validPayout = Number.isFinite(totalReturn) && totalReturn > 1;
    const breakEven = validPayout ? 1 / totalReturn : 1;
    const last = tape.openState;

    // Order-1 Markov conditional — the quantity the trade actually bets on.
    const pUpGivenUp = (tape.nUU + MARKOV_KAPPA / 2) / (tape.nUU + tape.nUD + MARKOV_KAPPA);
    const pUpGivenDown = (tape.nDU + MARKOV_KAPPA / 2) / (tape.nDU + tape.nDD + MARKOV_KAPPA);
    const markovUp = last > 0 ? pUpGivenUp : pUpGivenDown;

    // Robust drift + multi-horizon direction rates.
    const driftUp = robustDriftUpProbability(tape.returns);
    const short = betaRate(wins.slice(-20));
    const medium = betaRate(wins.slice(-60));
    const long = betaRate(wins);
    const horizon = 0.5 * short + 0.3 * medium + 0.2 * long;

    // Side-relative lens values: each is "probability this side wins next tick".
    const lenses = [
        targetUp ? memoryMean : 1 - memoryMean,
        targetUp ? markovUp : 1 - markovUp,
        targetUp ? upProbability : 1 - upProbability,
        targetUp ? (driftUp + horizon) / 2 : (1 - driftUp + (1 - horizon)) / 2,
    ];

    // User weights ⊙ regime weights (geometric blend), normalized.
    const userW = Array.isArray(weights) && weights.length === 4
        ? weights.map(v => Math.max(0.01, Number(v) || 0.01))
        : [0.3, 0.25, 0.2, 0.25];
    const regimeW = REGIME_WEIGHTS[regime] ?? REGIME_WEIGHTS.RANDOM;
    const blended = userW.map((w, i) => Math.sqrt(w * regimeW[i]));
    const weightTotal = blended.reduce((a, b) => a + b, 0);
    const pooledLogit = lenses.reduce((sum, value, index) => sum + blended[index] * logit(value), 0) / weightTotal;
    const temperature = clamp(Number(tau) || 1, 0.5, 2.5);
    const probability = sigmoid(pooledLogit / temperature);

    // Conditional context: transitions out of the current last-direction state.
    const ctx = last > 0
        ? { n: tape.nUU + tape.nUD, hits: targetUp ? tape.nUU : tape.nUD }
        : { n: tape.nDU + tape.nDD, hits: targetUp ? tape.nDU : tape.nDD };
    const kl = p => {
        const q = clamp(p, 1e-6, 1 - 1e-6);
        return q * Math.log(q / breakEven) + (1 - q) * Math.log((1 - q) / (1 - breakEven));
    };
    const evidence = validPayout && probability > breakEven ? ctx.n * kl(probability) : 0;

    // Confidence around the fused estimate, sized by the conditional context.
    const nEff = clamp(ctx.n, 24, 120);
    const alphaEff = probability * nEff;
    const betaEff = (1 - probability) * nEff;
    const edgeProb = validPayout ? 1 - betaCdf(breakEven, alphaEff, betaEff) : 0;
    const lowerBound = validPayout ? betaQuantile10(alphaEff, betaEff) : 0;

    // Loss-pair continuation risk on this side's win sequence.
    let ll = 0;
    let lw = 0;
    for (let i = 1; i < wins.length; i++) {
        if (!wins[i - 1] && !wins[i]) ll += 1;
        else if (!wins[i - 1] && wins[i]) lw += 1;
    }
    const qLL = (ll + 0.5) / (ll + lw + 1);
    const pairRisk = (1 - probability) * qLL;
    const instability = Math.max(Math.abs(short - medium), Math.abs(medium - long));
    const mean = lenses.reduce((sum, value, index) => sum + (blended[index] / weightTotal) * value, 0);
    const disagreement = Math.sqrt(
        lenses.reduce((sum, value, index) => sum + (blended[index] / weightTotal) * (value - mean) ** 2, 0)
    );
    const pairWeight = mode === 'RECOVERY' ? 0.45 : 0.18;
    const utility = validPayout ? probability * totalReturn - 1 - pairWeight * pairRisk : -999;

    const evidenceBar = EVIDENCE_BOUND * (mode === 'RECOVERY' ? RECOVERY_EVIDENCE_FACTOR : 1);
    const blockers = [];
    if (regime === 'RANDOM') blockers.push('random tape · no serial structure');
    if (ctx.n < CONTEXT_MIN) blockers.push(`context samples ${ctx.n}/${CONTEXT_MIN}`);
    if (!validPayout) blockers.push('payout unavailable');
    if (validPayout && probability <= breakEven) blockers.push(`probability ${pct(probability)} vs BE ${pct(breakEven)}`);
    if (evidence < evidenceBar) blockers.push(`evidence ${evidence.toFixed(2)}/${evidenceBar.toFixed(2)}`);
    if (validPayout && edgeProb < EDGE_PROB_MIN[mode]) blockers.push(`P(edge) ${pct(edgeProb)}`);
    if (validPayout && lowerBound <= breakEven - LOWER_BOUND_SLACK[mode]) blockers.push(`10% bound ${pct(lowerBound)}`);
    if (utility <= 0) blockers.push(`utility ${utility.toFixed(3)}`);
    if (instability >= MAX_INSTABILITY[mode]) blockers.push(`unstable ${(instability * 100).toFixed(1)}pt`);
    if (disagreement >= MAX_DISAGREEMENT[mode]) blockers.push(`lens disagreement ${(disagreement * 100).toFixed(1)}pt`);
    if (mode === 'RECOVERY' && qLL >= 0.58) blockers.push(`loss continuation ${pct(qLL)}`);

    return {
        contract: side,
        payout: totalReturn,
        probability,
        lowerBound,
        breakEven,
        edgeProb,
        evidence,
        utility,
        qLL,
        pairRisk,
        instability,
        disagreement,
        lenses,
        shortRate: short,
        mediumRate: medium,
        regime,
        memory,
        eligible: blockers.length === 0,
        blockers,
    };
};

export const analyseSurgeMarket = ({ prices, payout = 1.92, mode = 'NORMAL', weights, tau = 1 }) => {
    const clean = (Array.isArray(prices) ? prices : [])
        .map(Number)
        .filter(value => Number.isFinite(value) && value > 0);
    const normalizedMode = String(mode).toUpperCase() === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
    const tape = summarizeTape(clean);
    const hold = reason => {
        const base = {
            contract: 'CALL',
            payout: Number(payout) > 1 ? Number(payout) : 1.92,
            probability: 0.5,
            lowerBound: 0,
            breakEven: Number(payout) > 1 ? 1 / Number(payout) : 1,
            edgeProb: 0,
            evidence: 0,
            utility: -999,
            qLL: 0.5,
            pairRisk: 0,
            instability: 1,
            disagreement: 1,
            lenses: [0.5, 0.5, 0.5, 0.5],
            shortRate: 0.5,
            mediumRate: 0.5,
            regime: 'UNKNOWN',
            memory: SLOW_HALF_LIFE,
            eligible: false,
            blockers: [reason],
            score: 0,
            reason: `HOLD · ${reason}`,
        };
        return { ...base, alternatives: [{ ...base }, { ...base, contract: 'PUT' }], samples: tape.n, flatRate: tape.flatRate };
    };

    if (tape.n < SURGE_FORGE_LIMITS.minSamples) return hold(`insufficient tape ${tape.n}/${SURGE_FORGE_LIMITS.minSamples}`);
    if (tape.flatRate >= 0.2) return hold(`flat tape ${(tape.flatRate * 100).toFixed(1)}%`);
    if (tape.nU < 8 || tape.nD < 8) return hold('one-sided tape · no counter-evidence');

    const { zPersist, runsZ, regime } = regimeStats(tape);
    const wins = tape.directions.map(direction => direction > 0);
    const posterior = adaptivePosterior(wins);
    const upProbability = runHazardUpProbability(tape);
    const common = { tape, regime, payout, mode: normalizedMode, weights, tau, upProbability, memoryMean: posterior.mean, memory: posterior.memory };
    const sides = ['CALL', 'PUT'].map(side => sideAnalysis({ ...common, side }));
    for (const side of sides) {
        side.zPersist = zPersist;
        side.runsZ = runsZ;
        side.samples = tape.n;
        side.flatRate = tape.flatRate;
        side.score = 100 * (
            side.utility -
            side.instability * 0.25 -
            side.disagreement * 0.2 -
            Math.max(0, side.qLL - 0.5) * 0.2 -
            (regime === 'RANDOM' ? 1 : 0)
        );
        side.reason = side.eligible
            ? `READY · ${regime} · ${side.contract === 'CALL' ? 'Rise' : 'Fall'} ${pct(side.probability)} · P(edge) ${pct(side.edgeProb)} · LLR ${side.evidence.toFixed(2)} · bound ${pct(side.lowerBound)}`
            : `HOLD · ${side.blockers.join(' · ')}`;
    }
    sides.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
    return { ...sides[0], alternatives: sides, samples: tape.n, flatRate: tape.flatRate, regime, zPersist, runsZ, memory: posterior.memory };
};

export const SURGE_FORGE_LIMITS = Object.freeze({
    minSamples: 48,
    /** Back-compat alias — NORMAL mode now fires on one evidence-strong tick. */
    confirmations: 1,
    normalConfirmations: 1,
    recoveryConfirmations: 2,
    maxRecoveryQLL: 0.58,
    maxRecoveryInstability: 0.12,
    evidenceBoundary: EVIDENCE_BOUND,
});
