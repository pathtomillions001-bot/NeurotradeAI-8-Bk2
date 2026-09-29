/**
 * Combo Forge — pure, import-free analysis core.
 *
 * The generated DBot runs this INSIDE the workspace (`ntAnalyseCombo`). It has
 * no imports on purpose: the API keeps a typed port (`combo-forge-analysis.ts`)
 * that is proven equal to this file by a parity test, and this file can be
 * exercised without a websocket, Blockly or a browser.
 *
 * WHAT IT DECIDES
 * ───────────────
 * Every candidate is a (market, contract) pair: Over/Under, Even/Odd,
 * Matches/Differs or Rise/Fall (1-tick). Each has a win/lose series over the
 * market's tape. The engine answers two different questions:
 *
 *  NORMAL entry — "is there evidence that this contract's win probability is
 *  ABOVE its break-even (1/payout), and is the CURRENT state favourable?"
 *    · A prequential mixture e-process (a test martingale): six experts —
 *      fair rate, shrunk marginal, fast-decay marginal, lag-aware order-1
 *      context, order-2 context, and a state context (last digit, or the
 *      last move's direction and size for Rise/Fall) — are blended by their
 *      own PAST log-loss only. The product of (mixture prediction ÷ break-even)
 *      over the tape is the evidence. The mixture is clipped at break-even
 *      from below (the one-sided trick), which makes the product a genuine
 *      supermartingale for every win rate ≤ break-even: Ville's inequality
 *      then bounds the false-alarm rate by 1/threshold.
 *    · The threshold is Bonferroni'd over EVERY candidate scanned this cycle
 *      (markets × contracts, with auto Matches/Differs expanded to ten digits),
 *      so scanning more markets never makes noise look like an edge.
 *    · Lag correction: a 1-tick contract enters on the first tick AFTER the
 *      buy, so if a tick lands during decision + round trip the state the bot
 *      saw is two ticks old. The order-1 expert blends the lag-1 and lag-2
 *      rows by rho = P(a tick lands in between).
 *    · Edge expiry: if the most recent quarter of the tape is significantly
 *      worse than the whole tape, the evidence is treated as expired.
 *    · Loss clustering veto (only when enough losses exist to measure it).
 *
 *  RECOVERY entry — the debt must be repaid, so there is no edge to demand.
 *  The contract/market are chosen by the expected log-growth of the exact
 *  attempt the shared recovery ladder will place:
 *      stake = clamp(debt · (1 + markup) / (payout − 1), 0.35, maxStake)
 *      U     = p·ln(1 + stake·(payout−1)/W) + (1−p)·ln(1 − stake/W)
 *  with p the mixture's CURRENT-state win probability and W the live balance.
 *  That single number trades win chance against the stake a low-payout leg
 *  forces, and refuses an attempt that would consume the balance.
 *
 * HONESTY
 * ───────
 * Digit and Rise/Fall contracts are priced below fair odds, so on a fair random
 * tape NO rule is profitable. Strict mode therefore stays silent on fair tapes
 * (that is the point); Always mode trades the cheapest, best-timed candidate
 * without demanding evidence. Neither mode promises a win rate.
 */

export const COMBO_CONTRACT_TYPES = Object.freeze([
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITEVEN',
    'DIGITODD',
    'DIGITMATCH',
    'DIGITDIFF',
    'CALL',
    'PUT',
]);

export const COMBO_FALLBACK_PAYOUT = Object.freeze({
    DIGITOVER: 1.95,
    DIGITUNDER: 1.95,
    DIGITEVEN: 1.95,
    DIGITODD: 1.95,
    DIGITMATCH: 8.93,
    DIGITDIFF: 1.09,
    CALL: 1.92,
    PUT: 1.92,
});

export const COMBO_FORGE_LIMITS = Object.freeze({
    priorStrength: 20,
    fastDecay: 0.94,
    fastStrength: 8,
    ctx1Strength: 12,
    ctx2Strength: 12,
    stateStrength: 10,
    clampLow: 0.001,
    clampHigh: 0.999,
    confidenceZ: 1.282,
    expiryZ: 1.645,
    minClusterLosses: 10,
    minStake: 0.35,
    minSamples: Object.freeze({ normal: 60, recovery: 40 }),
    maxClustering: Object.freeze({ normal: 1.45, recovery: 1.6 }),
    /** Family-wise false-alarm budget per scan cycle. `always` demands no evidence. */
    alpha: Object.freeze({ strict: 0.05, balanced: 0.25, always: 1 }),
});

export const COMBO_STRICTNESS = Object.freeze(['strict', 'balanced', 'always']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finiteOr = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const clampP = p => clamp(finiteOr(p, 0.5), COMBO_FORGE_LIMITS.clampLow, COMBO_FORGE_LIMITS.clampHigh);

export const normaliseStrictness = value => {
    const s = String(value || '').toLowerCase();
    return COMBO_STRICTNESS.includes(s) ? s : 'strict';
};

// ── Wire format ──────────────────────────────────────────────────────────────

/**
 * Parse the `TYPE:DIGIT:PAYOUT` CSV the generator embeds in the workspace.
 * Unknown types are dropped, bad payouts fall back to the canonical one.
 */
export const parseComboContracts = csv =>
    String(csv || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 12)
        .map(raw => {
            const [type = '', digitRaw = '-1', payoutRaw = ''] = raw.split(':');
            const t = type.toUpperCase();
            const digit = Math.trunc(Number(digitRaw));
            const payout = Number(payoutRaw);
            return {
                type: t,
                digit: Number.isFinite(digit) ? digit : -1,
                payout: Number.isFinite(payout) && payout > 1 ? payout : (COMBO_FALLBACK_PAYOUT[t] ?? 1.95),
            };
        })
        .filter(c => COMBO_CONTRACT_TYPES.includes(c.type));

/**
 * Expand a parsed contract list into concrete candidates. Matches/Differs with
 * digit −1 ("auto") become ten candidates, one per digit, so the digit is
 * chosen INSIDE the multiple-testing correction instead of by peeking at the
 * very tape it is then tested on.
 */
export const expandComboContracts = specs => {
    const out = [];
    for (const spec of specs) {
        if ((spec.type === 'DIGITMATCH' || spec.type === 'DIGITDIFF') && !(spec.digit >= 0 && spec.digit <= 9)) {
            for (let d = 0; d <= 9; d++) out.push({ ...spec, digit: d, auto: true });
        } else {
            out.push({ ...spec, auto: false });
        }
    }
    return out;
};

const isDirection = type => type === 'CALL' || type === 'PUT';

/** Nominal fair win rate of a concrete contract (before the house margin). */
export const comboFairRate = spec => {
    switch (spec.type) {
        case 'DIGITOVER':
            return (9 - spec.digit) / 10;
        case 'DIGITUNDER':
            return spec.digit / 10;
        case 'DIGITEVEN':
        case 'DIGITODD':
            return 0.5;
        case 'DIGITMATCH':
            return 0.1;
        case 'DIGITDIFF':
            return 0.9;
        default:
            return 0.5; // CALL / PUT
    }
};

const digitWinFn = spec => {
    switch (spec.type) {
        case 'DIGITOVER':
            return spec.digit >= 0 && spec.digit <= 8 ? d => d > spec.digit : null;
        case 'DIGITUNDER':
            return spec.digit >= 1 && spec.digit <= 9 ? d => d < spec.digit : null;
        case 'DIGITEVEN':
            return d => d % 2 === 0;
        case 'DIGITODD':
            return d => d % 2 === 1;
        case 'DIGITMATCH':
            return spec.digit >= 0 && spec.digit <= 9 ? d => d === spec.digit : null;
        case 'DIGITDIFF':
            return spec.digit >= 0 && spec.digit <= 9 ? d => d !== spec.digit : null;
        default:
            return null;
    }
};

/**
 * Map a market's tape to a candidate's outcome series.
 *   digits — last digit of each tick (same length as quotes)
 *   quotes — raw tick prices (only needed for CALL / PUT)
 * Returns `{ wins, states, stateCount, p0 }` or null when it cannot be scored.
 * For Rise/Fall a flat tick is a LOSS for both sides, never a silent win.
 */
export const buildComboSeries = (spec, digits, quotes) => {
    if (isDirection(spec.type)) {
        const q = (quotes || []).map(Number);
        if (q.length < 4 || q.some(v => !Number.isFinite(v))) return null;
        const deltas = [];
        for (let i = 1; i < q.length; i++) deltas.push(q[i] - q[i - 1]);
        const mags = deltas.map(Math.abs).sort((a, b) => a - b);
        const median = mags[Math.floor(mags.length / 2)];
        const wins = deltas.map(d => (spec.type === 'CALL' ? d > 0 : d < 0));
        const states = deltas.map(d => (d > 0 ? 1 : 0) + (Math.abs(d) > median ? 2 : 0));
        return { wins, states, stateCount: 4, p0: 0.5 };
    }
    const winOf = digitWinFn(spec);
    if (!winOf || !Array.isArray(digits) || digits.length < 4) return null;
    const clean = digits.map(d => clamp(Math.trunc(Number(d)) || 0, 0, 9));
    return { wins: clean.map(winOf), states: clean, stateCount: 10, p0: comboFairRate(spec) };
};

// ── The evidence engine ──────────────────────────────────────────────────────

const EXPERTS = 6; // fair, marginal, fast, lag order-1, order-2, state

/**
 * Prequential mixture e-process over one outcome series.
 *
 *   logE   — ln of the test-martingale value against H0: P(win) ≤ 1/payout
 *   pNext  — the mixture's probability that the NEXT outcome is a win, given
 *            the tape's current state
 *   plus the shrunk marginal, loss-clustering ratio and an edge-expiry z.
 */
export const scanEvidence = ({ wins, states, stateCount, p0, payout, rho = 0 }) => {
    const L = COMBO_FORGE_LIMITS;
    const n = wins.length;
    const pb = clamp(1 / payout, 0.001, 0.999);
    const S = Math.max(1, Math.trunc(stateCount) || 1);
    const r = clamp(finiteOr(Number(rho), 0), 0, 1);
    const stateOf = i => clamp(Math.trunc(Number(states[i])) || 0, 0, S - 1);
    const bit = i => (wins[i] ? 1 : 0);

    let h = 0;
    let m = 0;
    let fh = 0;
    let fn = 0;
    const c1 = [
        [0, 0],
        [0, 0],
    ];
    const cl = [
        [0, 0],
        [0, 0],
    ];
    const c2 = [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
    ];
    const cs = Array.from({ length: S }, () => [0, 0]);
    const logW = new Array(EXPERTS).fill(0);
    let logE = 0;

    const predict = (x1, x2, s1) => {
        const pm = (h + L.priorStrength * p0) / (m + L.priorStrength);
        const pf = (fh + L.fastStrength * pm) / (fn + L.fastStrength);
        const row1 = c1[x1];
        const rowL = cl[x2];
        const p1 = (row1[1] + L.ctx1Strength * pm) / (row1[0] + row1[1] + L.ctx1Strength);
        const pL = (rowL[1] + L.ctx1Strength * pm) / (rowL[0] + rowL[1] + L.ctx1Strength);
        const pLag = (1 - r) * p1 + r * pL;
        const row2 = c2[2 * x2 + x1];
        const p2 = (row2[1] + L.ctx2Strength * pLag) / (row2[0] + row2[1] + L.ctx2Strength);
        const rowS = cs[s1];
        const pS = (rowS[1] + L.stateStrength * pLag) / (rowS[0] + rowS[1] + L.stateStrength);
        return [p0, pm, pf, pLag, p2, pS].map(clampP);
    };

    const mix = qs => {
        let max = -Infinity;
        for (const v of logW) max = Math.max(max, v);
        let z = 0;
        const w = logW.map(v => {
            const e = Math.exp(v - max);
            z += e;
            return e;
        });
        let q = 0;
        for (let i = 0; i < EXPERTS; i++) q += (w[i] / z) * qs[i];
        return q;
    };

    for (let t = 0; t < n; t++) {
        const x = bit(t);
        if (t >= 2) {
            const qs = predict(bit(t - 1), bit(t - 2), stateOf(t - 1));
            const q = clampP(mix(qs));
            // One-sided bet: never bet below break-even, so the product is a
            // supermartingale for every true win rate ≤ break-even.
            const qe = clamp(Math.max(q, pb), pb, L.clampHigh);
            logE += x ? Math.log(qe / pb) : Math.log((1 - qe) / (1 - pb));
            for (let i = 0; i < EXPERTS; i++) logW[i] += Math.log(x ? qs[i] : 1 - qs[i]);
        }
        h += x;
        m += 1;
        fh = L.fastDecay * fh + x;
        fn = L.fastDecay * fn + 1;
        if (t >= 1) c1[bit(t - 1)][x] += 1;
        if (t >= 2) {
            cl[bit(t - 2)][x] += 1;
            c2[2 * bit(t - 2) + bit(t - 1)][x] += 1;
            cs[stateOf(t - 1)][x] += 1;
        }
    }

    let pNext = clampP(p0);
    let contextSamples = 0;
    if (n >= 3) {
        const x1 = bit(n - 1);
        const x2 = bit(n - 2);
        pNext = clampP(mix(predict(x1, x2, stateOf(n - 1))));
        contextSamples = c1[x1][0] + c1[x1][1];
    }

    const hits = h;
    const losses = n - hits;
    let ll = 0;
    let lw = 0;
    for (let i = 1; i < n; i++) {
        if (!wins[i - 1]) {
            if (!wins[i]) ll++;
            else lw++;
        }
    }
    const rawLossRate = n > 0 ? losses / n : 1;
    // Loss clustering: P(loss | previous loss) over P(loss), using the one-sided 90% LOWER confidence
    // bound of the numerator. A raw ratio over a few dozen losses is mostly noise (it vetoed a
    // genuine 93% edge on an i.i.d. tape); this only vetoes clustering that is statistically present.
    let clustering = 1;
    if (losses >= L.minClusterLosses) {
        const m = ll + lw;
        const pLL = (ll + 1) / (m + 2);
        const lo = Math.max(0, pLL - 1.2816 * Math.sqrt((pLL * (1 - pLL)) / (m + 2)));
        clustering = lo / Math.max(0.01, rawLossRate);
    }

    // Edge expiry: is the newest quarter significantly worse than the tape?
    const recentLen = Math.max(20, Math.floor(n / 4));
    let expiryZ = 0;
    if (n >= recentLen * 2) {
        let recentHits = 0;
        for (let i = n - recentLen; i < n; i++) recentHits += bit(i);
        const whole = clamp(hits / n, 0.02, 0.98);
        const se = Math.sqrt((whole * (1 - whole)) / recentLen);
        expiryZ = (recentHits / recentLen - whole) / se;
    }

    const marginal = (hits + L.priorStrength * p0) / (n + L.priorStrength);
    const nEff = Math.max(20, Math.min(n, contextSamples + L.priorStrength));
    const se = Math.sqrt((pNext * (1 - pNext)) / nEff);
    const pNextLower = clamp(pNext - L.confidenceZ * se, 0, 1);
    const pNextUpper = clamp(pNext + L.confidenceZ * se, 0, 1);

    return {
        samples: n,
        hits,
        losses,
        logE: finiteOr(logE, 0),
        pNext,
        pNextLower,
        pNextUpper,
        marginal,
        breakEven: pb,
        clustering,
        expiryZ,
        expired: expiryZ < -L.expiryZ,
        contextSamples,
    };
};

// ── Recovery utility ─────────────────────────────────────────────────────────

/**
 * The shared recovery ladder's stake for one attempt, and the expected
 * log-growth of placing it. Infeasible (stake ≥ balance) attempts return
 * −Infinity so they can never out-rank a feasible one.
 */
export const recoveryAttempt = ({ debt, payout, markupPercent, maxStake, balance, pWin }) => {
    const L = COMBO_FORGE_LIMITS;
    const b = Math.max(1e-9, payout - 1);
    const target = Math.max(0, finiteOr(Number(debt), 0)) * (1 + Math.max(0, finiteOr(Number(markupPercent), 0)) / 100);
    const cap = maxStake > 0 ? maxStake : 500;
    // The app's shared recovery stake, verbatim: debt×(1+markup)/(payout−1),
    // clamped to [0.35, max stake], rounded UP to the cent, never above balance.
    let stake = clamp(target / b, L.minStake, cap);
    stake = Math.ceil((stake - 1e-9) * 100) / 100;
    if (balance > 0 && stake > balance) stake = Math.floor(balance * 100) / 100;
    if (stake < L.minStake) stake = L.minStake;
    const wealth = balance > 0 ? balance : stake * 20;
    if (stake >= wealth * 0.98) return { stake, utility: -Infinity, feasible: false };
    const utility = pWin * Math.log(1 + (stake * b) / wealth) + (1 - pWin) * Math.log(1 - stake / wealth);
    return { stake, utility: finiteOr(utility, -Infinity), feasible: true };
};

// ── Ranking and the decision ─────────────────────────────────────────────────

/** Fair-rate margin the house keeps per $1 staked on this contract. */
export const comboMargin = (p0, payout) => 1 - p0 * payout;

/**
 * Score one scanned candidate and decide eligibility.
 * `ctx` = { mode, strictness, threshold, debt, markupPercent, maxStake, balance }.
 */
export const evaluateComboRow = (row, ctx) => {
    const L = COMBO_FORGE_LIMITS;
    const recovery = ctx.mode === 'RECOVERY';
    const strictness = ctx.strictness;
    const minSamples = recovery ? L.minSamples.recovery : L.minSamples.normal;
    const maxCluster = recovery ? L.maxClustering.recovery : L.maxClustering.normal;
    const ev = row.pNext * row.payout - 1;
    const evLower = row.pNextLower * row.payout - 1;
    const blockers = [];
    let score;
    let eligible;

    if (row.samples < minSamples) blockers.push(`samples ${row.samples}/${minSamples}`);
    if (row.expired) blockers.push(`edge expiring (z ${row.expiryZ.toFixed(1)})`);
    if (row.clustering >= maxCluster) blockers.push(`loss clustering ${row.clustering.toFixed(2)}x`);

    if (recovery) {
        const attempt = recoveryAttempt({
            debt: ctx.debt,
            payout: row.payout,
            markupPercent: ctx.markupPercent,
            maxStake: ctx.maxStake,
            balance: ctx.balance,
            pWin: row.pNext,
        });
        score = attempt.utility;
        if (!attempt.feasible) blockers.push('stake would exceed the balance');
        if (strictness === 'strict' && row.pNext < row.fairRate) {
            blockers.push(`state below fair (${(row.pNext * 100).toFixed(1)}% vs ${(row.fairRate * 100).toFixed(1)}%)`);
        } else if (strictness === 'balanced' && row.pNextUpper < row.fairRate) {
            blockers.push('conditional win rate significantly below fair');
        }
        eligible = blockers.length === 0;
        return { ...row, ev, evLower, score, eligible, blockers, stake: attempt.stake };
    }

    score = evLower;
    if (strictness !== 'always') {
        if (row.logE < ctx.threshold) {
            blockers.push(`evidence ${row.logE.toFixed(1)}/${ctx.threshold.toFixed(1)} nats`);
        }
        if (ev <= 0) blockers.push(`state EV ${(ev * 100).toFixed(2)}%`);
    }
    eligible = blockers.length === 0;
    return { ...row, ev, evLower, score, eligible, blockers, stake: 0 };
};

/**
 * Rank every scanned row. The multiple-testing threshold is Bonferroni'd over
 * the number of rows actually scanned this cycle.
 */
export const rankComboRows = (rows, { mode, strictness, debt = 0, markupPercent = 10, maxStake = 500, balance = 0 }) => {
    const L = COMBO_FORGE_LIMITS;
    const s = normaliseStrictness(strictness);
    const k = Math.max(1, rows.length);
    const alpha = L.alpha[s];
    const threshold = s === 'always' ? 0 : Math.log(k / alpha);
    const evaluated = rows.map(row =>
        evaluateComboRow(row, { mode, strictness: s, threshold, debt, markupPercent, maxStake, balance })
    );
    evaluated.sort((a, b) => {
        if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
        const sa = Number.isFinite(a.score) ? a.score : -1e9;
        const sb = Number.isFinite(b.score) ? b.score : -1e9;
        return sb - sa || b.logE - a.logE;
    });
    return { rows: evaluated, threshold, candidates: k, strictness: s };
};

/** Turn the top row into the decision object the workspace reads. */
export const describeComboDecision = (best, meta, currentSymbol) => {
    const label = `${best.contract}${best.barrier >= 0 && best.contract !== 'CALL' && best.contract !== 'PUT' ? ` ${best.barrier}` : ''}`;
    return {
        symbol: best.symbol,
        contract: best.contract,
        barrier: best.barrier,
        payout: best.payout,
        eligible: best.eligible,
        // A real ranked row exists, so a patience-forced entry has data behind it.
        forceable: true,
        score: Number.isFinite(best.score) ? best.score : -999,
        probability: best.pNext,
        lowerBound: best.pNextLower,
        breakEven: best.breakEven,
        ev: best.ev,
        evidence: best.logE,
        threshold: meta.threshold,
        margin: comboMargin(best.fairRate, best.payout),
        clustering: best.clustering,
        samples: best.samples,
        candidates: meta.candidates,
        stake: best.stake || 0,
        changedMarket: best.symbol !== currentSymbol,
        reason: best.eligible
            ? `READY ${label} ${meta.strictness} · evidence ${best.logE.toFixed(1)} nats (need ${meta.threshold.toFixed(1)}) · win ${(best.pNext * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`
            : `HOLD: ${best.blockers.join(', ') || 'no qualified setup'}`,
    };
};

// ── Whole-cycle analysis ─────────────────────────────────────────────────────

/**
 * Market-switch hysteresis. A candidate on ANOTHER market only displaces the
 * best candidate on the CURRENT market when it is materially better — each
 * switch costs a tick and a fresh quote, so two near-equal tapes must not make
 * the bot flip-flop.
 */
export const SWITCH_HYSTERESIS = Object.freeze({ normal: 0.01, recovery: 0.0001, relative: 0.25 });

export const pickDecisionRow = (rankedRows, currentSymbol, mode) => {
    const best = rankedRows[0];
    if (!best || best.symbol === currentSymbol) return best;
    const here = rankedRows.find(r => r.symbol === currentSymbol);
    if (!here || here.eligible !== best.eligible || !Number.isFinite(here.score)) return best;
    const floor = mode === 'RECOVERY' ? SWITCH_HYSTERESIS.recovery : SWITCH_HYSTERESIS.normal;
    const gain = (Number.isFinite(best.score) ? best.score : -1e9) - here.score;
    return gain > Math.max(floor, SWITCH_HYSTERESIS.relative * Math.abs(here.score)) ? best : here;
};

/** Score every expanded candidate on one market's tape. */
export const scanComboMarket = ({ symbol, digits, quotes, candidates, window, rho }) => {
    const w = Math.max(20, Math.min(1000, Math.trunc(Number(window)) || 500));
    const d = (digits || []).slice(-w);
    const q = (quotes || []).slice(-w);
    const rows = [];
    for (const spec of candidates) {
        const series = buildComboSeries(spec, d, q);
        if (!series) continue;
        const evidence = scanEvidence({ ...series, payout: spec.payout, rho });
        rows.push({
            symbol,
            contract: spec.type,
            barrier: isDirection(spec.type) ? -1 : spec.digit,
            payout: spec.payout,
            fairRate: series.p0,
            ...evidence,
        });
    }
    return rows;
};

/**
 * One full scan → decision, from already-collected tapes. The runtime gathers
 * the tapes (async, per market); everything else is here so it is testable.
 *   tapes: [{ symbol, digits, quotes }]
 * Returns `{ decision, rows, threshold, candidates }`; `decision` is null only
 * when no tape produced a single scoreable candidate.
 */
export const analyseCombo = ({
    mode = 'NORMAL',
    strictness = 'strict',
    tapes,
    contracts,
    currentSymbol,
    window = 500,
    rho = 0,
    debt = 0,
    markupPercent = 10,
    maxStake = 500,
    balance = 0,
}) => {
    const candidates = expandComboContracts(contracts);
    const rows = [];
    for (const tape of tapes) {
        rows.push(...scanComboMarket({ ...tape, candidates, window, rho }));
    }
    if (rows.length === 0) return { decision: null, rows: [], threshold: 0, candidates: 0 };
    const ranked = rankComboRows(rows, { mode, strictness, debt, markupPercent, maxStake, balance });
    const decision = describeComboDecision(pickDecisionRow(ranked.rows, currentSymbol, mode), ranked, currentSymbol);
    return { decision, rows: ranked.rows, threshold: ranked.threshold, candidates: ranked.candidates };
};
