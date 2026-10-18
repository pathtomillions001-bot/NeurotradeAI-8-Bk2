/**
 * Pure, Deriv-specific hedge-pair outcome and evidence math.
 *
 * Every historical sample is classified from the complete price path over the
 * *actual* pair duration. The two legs are never treated as independent:
 * their joint win/loss state is priced together using both live quote returns.
 * This module does not place trades and intentionally has no fallback payout.
 */

export const HEDGE_PAIR_FAMILIES = Object.freeze([
    'DIGIT_OVERUNDER',
    'ONLY_UPS_DOWNS',
    'HIGHER_LOWER',
    'TOUCH_UPPER_LOWER',
    'NO_TOUCH_UPPER_LOWER',
    'ENDS_BETWEEN_OUTSIDE',
    'STAYS_BETWEEN_OUTSIDE',
]);

export const HEDGE_PAIR_DEFINITIONS = Object.freeze({
    DIGIT_OVERUNDER: Object.freeze({
        label: 'Over 5 / Under 4',
        legs: Object.freeze([{ type: 'DIGITOVER', barrier: 5, barriers: 1 }, { type: 'DIGITUNDER', barrier: 4, barriers: 1 }]),
        tradeCategory: 'digits',
        tradeType: 'overunder',
        needsDigitStream: true,
        needsPriceBarriers: false,
        timing: Object.freeze({ confirmations: 2, recoveryConfirmations: 3 }),
    }),
    ONLY_UPS_DOWNS: Object.freeze({
        label: 'Only Ups / Only Downs',
        legs: Object.freeze([{ type: 'RUNHIGH', barriers: 0 }, { type: 'RUNLOW', barriers: 0 }]),
        tradeCategory: 'runs',
        tradeType: 'runs',
        needsDigitStream: false,
        needsPriceBarriers: false,
        timing: Object.freeze({ confirmations: 3, recoveryConfirmations: 4 }),
    }),
    HIGHER_LOWER: Object.freeze({
        label: 'Higher / Lower',
        legs: Object.freeze([{ type: 'CALL', barrier: 'upper', barriers: 1 }, { type: 'PUT', barrier: 'lower', barriers: 1 }]),
        tradeCategory: 'callput',
        tradeType: 'higherlower',
        needsDigitStream: false,
        needsPriceBarriers: true,
        timing: Object.freeze({ confirmations: 2, recoveryConfirmations: 3 }),
    }),
    TOUCH_UPPER_LOWER: Object.freeze({
        label: 'Touch upper / Touch lower',
        legs: Object.freeze([{ type: 'ONETOUCH', barrier: 'upper', barriers: 1 }, { type: 'ONETOUCH', barrier: 'lower', barriers: 1 }]),
        tradeCategory: 'touchnotouch',
        tradeType: 'touchnotouch',
        needsDigitStream: false,
        needsPriceBarriers: true,
        timing: Object.freeze({ confirmations: 2, recoveryConfirmations: 3 }),
    }),
    NO_TOUCH_UPPER_LOWER: Object.freeze({
        label: 'No Touch upper / No Touch lower',
        legs: Object.freeze([{ type: 'NOTOUCH', barrier: 'upper', barriers: 1 }, { type: 'NOTOUCH', barrier: 'lower', barriers: 1 }]),
        tradeCategory: 'touchnotouch',
        tradeType: 'touchnotouch',
        needsDigitStream: false,
        needsPriceBarriers: true,
        timing: Object.freeze({ confirmations: 3, recoveryConfirmations: 4 }),
    }),
    ENDS_BETWEEN_OUTSIDE: Object.freeze({
        label: 'Ends Between / Ends Outside',
        legs: Object.freeze([
            { type: 'EXPIRYRANGE', barrier: 'upper', barrier2: 'lower', barriers: 2 },
            { type: 'EXPIRYMISS', barrier: 'upper', barrier2: 'lower', barriers: 2 },
        ]),
        tradeCategory: 'inout',
        tradeType: 'endsinout',
        needsDigitStream: false,
        needsPriceBarriers: true,
        timing: Object.freeze({ confirmations: 2, recoveryConfirmations: 3 }),
    }),
    STAYS_BETWEEN_OUTSIDE: Object.freeze({
        label: 'Stays Between / Goes Outside',
        legs: Object.freeze([
            { type: 'RANGE', barrier: 'upper', barrier2: 'lower', barriers: 2 },
            { type: 'UPORDOWN', barrier: 'upper', barrier2: 'lower', barriers: 2 },
        ]),
        tradeCategory: 'inout',
        tradeType: 'staysinout',
        needsDigitStream: false,
        needsPriceBarriers: true,
        timing: Object.freeze({ confirmations: 3, recoveryConfirmations: 4 }),
    }),
});

export const HEDGE_PAIR_ANALYSIS_LIMITS = Object.freeze({
    /**
     * Deep tape, not the Builder's 1 000-tick sliding window.
     *
     * `ticks_service.js` asks Deriv for `count: 1000` and keeps a 1 000-tick
     * ring, so a family whose shortest common duration is a minute (Ends /
     * Stays Between — expiry contracts are never tick-denominated) replayed
     * ~16 non-overlapping pairs and could never reach its own sample floor.
     * That is the same arithmetic that starved Kill-Shot (see replit.md,
     * "DATA STARVATION"). The cycle therefore pulls Deriv's deep history
     * directly (4 999 is the hard maximum; 5 000 is rejected outright) and
     * caches it per symbol.
     */
    maxTicks: 5000,
    deepHistoryCount: 4999,
    /** Cache lifetime for one symbol's deep tape. Analysis only; buys re-quote live. */
    deepTapeTtlMs: 60000,
    minSamples: 80,
    minContextSamples: 20,
    /**
     * A tape that cannot produce this many non-overlapping pairs cannot say
     * anything about the family at all, so the cycle holds and NAMES the
     * arithmetic instead of silently lowering the bar.
     */
    hardSampleFloor: 20,
    priorStrength: 20,
    priorStandardDeviation: 0.5,
    oneSidedZ95: 1.645,
    maxInstability: 0.35,
    confirmationTicks: 2,
    recoveryConfirmationTicks: 3,
    /**
     * Hedge Pair Forge's OWN recovery markup.
     *
     * Deliberately NOT the server-owned `botRecoveryMarkup` (10 %) the five
     * specialist bots share: a pair risks two premiums at once, so a $2 debt
     * sized at 10 % repays $0.66 per split win and takes nine pairs to clear,
     * while 40 % sizes $1.96/leg and clears the same debt in six. Scoped to
     * this bot only and printed in the console and in every recovery journal
     * line so it can never be mistaken for the global setting.
     */
    recoveryMarkupPercent: 40,
    /**
     * Ceiling on the per-leg recovery ladder — NOT the size.
     *
     * Raised from the old 1.62 default because 1.62 caps step 1 at $1.62 and
     * would clamp the debt-driven $1.96 stake the pair formula asks for.
     */
    recoveryMultiplierDefault: 2.43,
    /** Markets one generated bot may watch. Deriv's socket/request budget caps this (doc §2.3 N7). */
    maxWatchMarkets: 8,
    /**
     * How often the multi-market table is rebuilt, in cycle evaluations.
     *
     * Ranking replays up to 4 999 ticks per watched market, so doing it on every
     * tick would spend the whole tick budget on analysis. Every 15th evaluation
     * is roughly one ranking pass per 15 s on a 1 Hz index — enough to catch a
     * market that has turned over, cheap enough to leave the cycle responsive.
     * The incumbent's own analysis (the one that gates a buy) is NEVER cached.
     */
    rankIntervalEvaluations: 15,
    /** Anti-thrash switch policy (docs/digit-forge-market-switching.md §4.3(f)). */
    switchEdgeDelta: 0.01,
    switchDwellEvaluations: 60,
    switchCooldownEvaluations: 120,
});

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;

/** Debt below this is cleared: floating-point residue must not keep recovery armed. */
export const DEBT_EPSILON = 0.005;

/**
 * Smallest barrier offset a Blockly number field can actually hold.
 *
 * The block declares `FieldNumber(…, precision)` and Blockly's own
 * `doClassValidation_` rounds every value — including one read from XML — to
 * `Math.round(v / precision) * precision` then `toFixed(decimalPlaces)`. With
 * the old 0.01 precision a one-pip offset on R_50 (pipSize 4 → 0.0001) was
 * rounded to **0**, `normalizePairConfig` threw "offsets must both be
 * positive", and all five price-barrier families held forever having analysed
 * nothing. The field now carries 8 decimals (matching `formatOffset`); this
 * constant is the generator's and the runtime's shared floor.
 */
export const MIN_REPRESENTABLE_OFFSET = 1e-8;

/** Normalize a watch list: dedup, keep order, seed first, cap at the socket budget. */
export function normalizeWatchMarkets(input, seedSymbol = '') {
    const raw = Array.isArray(input)
        ? input
        : String(input ?? '').split(',');
    const cleaned = [];
    const seed = String(seedSymbol ?? '').trim().toUpperCase();
    if (seed) cleaned.push(seed);
    for (const item of raw) {
        const symbol = String(item ?? '').trim().toUpperCase();
        if (!symbol || !/^[A-Z0-9_]{2,30}$/.test(symbol)) continue;
        if (!cleaned.includes(symbol)) cleaned.push(symbol);
    }
    return cleaned.slice(0, HEDGE_PAIR_ANALYSIS_LIMITS.maxWatchMarkets);
}

export function normalizePairConfig(input = {}) {
    const family = String(input.family || '').toUpperCase();
    if (!HEDGE_PAIR_FAMILIES.includes(family)) throw new Error('Unknown hedge-pair family');
    const definition = HEDGE_PAIR_DEFINITIONS[family];
    // Policy: request one tick whenever the live family/barrier contract
    // supports it; chooseCommonPairDuration may raise this only to the true
    // common minimum advertised by contracts_for.
    const requestedDuration = 1;
    const upperOffset = Number(input.upperOffset);
    const lowerOffset = Number(input.lowerOffset);
    if (definition.needsPriceBarriers && (!finitePositive(upperOffset) || !finitePositive(lowerOffset))) {
        throw new Error('Upper and lower barrier offsets must both be positive');
    }
    if (
        definition.needsPriceBarriers &&
        (upperOffset < MIN_REPRESENTABLE_OFFSET || lowerOffset < MIN_REPRESENTABLE_OFFSET)
    ) {
        // Not reachable through the block any more, but a hand-edited workspace
        // or a stale XML can still carry a sub-representable offset. Say why it
        // was refused instead of holding on a mystery zero.
        throw new Error(`Barrier offsets must be at least ${MIN_REPRESENTABLE_OFFSET}`);
    }
    const watchMarkets = normalizeWatchMarkets(input.watchMarkets, input.symbol);
    return {
        family,
        requestedDuration,
        upperOffset: definition.needsPriceBarriers ? upperOffset : 0,
        lowerOffset: definition.needsPriceBarriers ? lowerOffset : 0,
        /**
         * Default to the whole deep tape, not the 500-tick window the block used
         * to offer. At 500 ticks a one-minute pair yields eight non-overlapping
         * samples and can never clear the 20-sample hard floor, so Ends / Stays
         * Between were unanalysable at their own defaults.
         */
        analysisWindow: Math.max(100, Math.min(HEDGE_PAIR_ANALYSIS_LIMITS.maxTicks, Math.trunc(Number(input.analysisWindow) || HEDGE_PAIR_ANALYSIS_LIMITS.deepHistoryCount))),
        minSamples: Math.max(HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor, Math.min(HEDGE_PAIR_ANALYSIS_LIMITS.maxTicks, Math.trunc(Number(input.minSamples) || HEDGE_PAIR_ANALYSIS_LIMITS.minSamples))),
        requiredEdge: Math.max(-0.5, Math.min(0.5, Number.isFinite(Number(input.requiredEdge)) ? Number(input.requiredEdge) : 0)),
        recoveryMultiplier: Math.max(1.01, Math.min(5, Number(input.recoveryMultiplier) || HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMultiplierDefault)),
        maxRecoverySteps: Math.max(1, Math.min(10, Math.trunc(Number(input.maxRecoverySteps) || 3))),
        markupPercent: Math.max(0, Math.min(100, Number.isFinite(Number(input.markupPercent)) ? Number(input.markupPercent) : HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent)),
        maxStake: Math.max(0.35, Math.min(50000, Number(input.maxStake) || 500)),
        takeProfit: Math.max(0.01, Number(input.takeProfit) || 10),
        stopLoss: Math.max(0.01, Number(input.stopLoss) || 5),
        maxConsecutiveDoubleLosses: Math.max(1, Math.min(20, Math.trunc(Number(input.maxConsecutiveDoubleLosses) || 6))),
        entryConfirmations: Math.max(
            definition.timing.confirmations,
            Math.min(12, Math.trunc(Number(input.entryConfirmations) || definition.timing.confirmations)),
        ),
        recoveryConfirmations: Math.max(
            definition.timing.recoveryConfirmations,
            Math.min(12, Math.trunc(Number(input.recoveryConfirmations) || definition.timing.recoveryConfirmations)),
        ),
        watchMarkets,
        /**
         * Patience valve (normal mode ONLY, 0 = off): after this many
         * evaluations without a qualified pair, enter on the best measured
         * setup anyway and say so in the journal. A debt-sized recovery never
         * uses it — the same rule Nexus Hedge enforces, because letting a timer
         * fire a recovery bypasses exactly the fresh-rescan proof that keeps
         * recovery stakes honest.
         */
        forceEntryAfter: Math.max(0, Math.min(3600, Math.trunc(Number(input.forceEntryAfter) || 0))),
    };
}

/** Return the last quoted digit using the symbol's actual pip precision. */
export function lastDigitFromQuote(quote, pipSize = 2) {
    if (!Number.isFinite(Number(quote))) return NaN;
    const decimals = Math.max(0, Math.min(10, Math.trunc(Number(pipSize) || 0)));
    const formatted = Number(quote).toFixed(decimals);
    return Number(formatted.slice(-1));
}

/**
 * Exact pair outcome for the requested Deriv product semantics.
 * Entry spot is prices[startIndex]. Tick durations observe the next N quotes;
 * time durations observe quotes through the first tick at/after their expiry.
 * Equality rules deliberately differ by family.
 */
export function classifyPairOutcome({
    family,
    prices,
    epochs,
    startIndex,
    duration,
    durationSeconds = 0,
    pipSize = 2,
    upperOffset = 1,
    lowerOffset = 1,
}) {
    const normalizedFamily = String(family || '').toUpperCase();
    if (!HEDGE_PAIR_FAMILIES.includes(normalizedFamily)) throw new Error('Unknown hedge-pair family');
    const timeBased = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0;
    const d = Math.trunc(Number(duration));
    const start = Number(prices?.[startIndex]);
    if (!Array.isArray(prices) || !Number.isInteger(startIndex) || startIndex < 0 || startIndex >= prices.length || !Number.isFinite(start)) return null;

    let endIndex;
    if (timeBased) {
        const startEpoch = Number(epochs?.[startIndex]);
        if (!Number.isFinite(startEpoch) || !Array.isArray(epochs)) return null;
        const expiryEpoch = startEpoch + Number(durationSeconds);
        for (let index = startIndex + 1; index < Math.min(prices.length, epochs.length); index += 1) {
            if (Number(epochs[index]) >= expiryEpoch) {
                endIndex = index;
                break;
            }
        }
    } else {
        if (!Number.isInteger(d) || d < 1) return null;
        endIndex = startIndex + d;
    }
    if (!Number.isInteger(endIndex) || endIndex >= prices.length) return null;
    const path = prices.slice(startIndex + 1, endIndex + 1).map(Number);
    if (path.length < 1 || path.some(value => !Number.isFinite(value))) return null;
    const end = path[path.length - 1];

    if (normalizedFamily === 'DIGIT_OVERUNDER') {
        const digit = lastDigitFromQuote(end, pipSize);
        return { winA: digit > 5, winB: digit < 4, end, digit, endIndex };
    }

    if (normalizedFamily === 'ONLY_UPS_DOWNS') {
        let onlyUp = true;
        let onlyDown = true;
        let previous = start;
        for (const quote of path) {
            const delta = quote - previous;
            if (!(delta > 0)) onlyUp = false;
            if (!(delta < 0)) onlyDown = false;
            previous = quote;
        }
        return { winA: onlyUp, winB: onlyDown, end, endIndex };
    }

    const high = start + Number(upperOffset);
    const low = start - Number(lowerOffset);
    if (!(Number(upperOffset) > 0) || !(Number(lowerOffset) > 0)) return null;

    if (normalizedFamily === 'HIGHER_LOWER') {
        // Deriv's Higher/Lower products are CALL/PUT with relative barriers,
        // not barrier-free HIGHER/LOWER proposals. Both strictly compare the
        // expiry spot to their separate upper/lower target.
        return { winA: end > high, winB: end < low, end, high, low, endIndex };
    }

    const touchedUpper = path.some(quote => quote >= high);
    const touchedLower = path.some(quote => quote <= low);

    if (normalizedFamily === 'TOUCH_UPPER_LOWER') {
        return { winA: touchedUpper, winB: touchedLower, end, high, low, endIndex };
    }
    if (normalizedFamily === 'NO_TOUCH_UPPER_LOWER') {
        return { winA: !touchedUpper, winB: !touchedLower, end, high, low, endIndex };
    }
    if (normalizedFamily === 'ENDS_BETWEEN_OUTSIDE') {
        const strictlyBetween = end > low && end < high;
        const strictlyOutside = end < low || end > high;
        // At either exact endpoint both contracts lose under the strict rule.
        return { winA: strictlyBetween, winB: strictlyOutside, end, high, low, endIndex };
    }
    if (normalizedFamily === 'STAYS_BETWEEN_OUTSIDE') {
        const stayedStrictlyInside = path.every(quote => quote > low && quote < high);
        const touchedOrCrossed = path.some(quote => quote <= low || quote >= high);
        return { winA: stayedStrictlyInside, winB: touchedOrCrossed, end, high, low, endIndex };
    }
    return null;
}

function sign(value) {
    return value > 0 ? 1 : value < 0 ? -1 : 0;
}

function realizedVolatility(prices, index, lookback) {
    const returns = [];
    const first = Math.max(1, index - lookback + 1);
    for (let i = first; i <= index; i += 1) returns.push(Number(prices[i]) - Number(prices[i - 1]));
    if (returns.length === 0) return { short: 0, long: 0 };
    const rms = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length));
    return { short: rms(returns.slice(-5)), long: rms(returns.slice(-25)) };
}

function volatilityBucket(prices, index) {
    const { short, long } = realizedVolatility(prices, index, 25);
    const ratio = long > 0 ? short / long : 0;
    return ratio < 0.75 ? 0 : ratio < 1.25 ? 1 : ratio < 1.75 ? 2 : 3;
}

function priorRun(prices, index) {
    if (index < 1) return { direction: 0, length: 0 };
    const direction = sign(Number(prices[index]) - Number(prices[index - 1]));
    if (direction === 0) return { direction: 0, length: 0 };
    let length = 0;
    for (let i = index; i > 0 && length < 3; i -= 1) {
        if (sign(Number(prices[i]) - Number(prices[i - 1])) !== direction) break;
        length += 1;
    }
    return { direction, length };
}

/**
 * Causal, family-specific timing context. It is computed using only quotes at
 * or before the sample's entry tick; outcomes use only later ticks.
 */
export function pairContextKey({ family, prices, index, pipSize = 2 }) {
    const normalizedFamily = String(family || '').toUpperCase();
    if (!Array.isArray(prices) || index < 0 || index >= prices.length) return 'unknown';
    const vol = volatilityBucket(prices, index);
    const { direction } = priorRun(prices, index);
    const lookback = Math.max(0, index - 3);
    const trend = sign(Number(prices[index]) - Number(prices[lookback]));

    // Contexts are intentionally coarse enough to retain a usable sample under
    // the 1,000-tick Builder tape, while preserving the family-relevant state.
    if (normalizedFamily === 'DIGIT_OVERUNDER') {
        const digit = lastDigitFromQuote(prices[index], pipSize);
        return digit <= 3 ? 'digit:low' : digit <= 5 ? 'digit:boundary' : 'digit:high';
    }
    if (normalizedFamily === 'ONLY_UPS_DOWNS') return `run:${direction}`;
    if (normalizedFamily === 'HIGHER_LOWER') return `direction:${trend}`;
    if (normalizedFamily === 'TOUCH_UPPER_LOWER') return `touch-vol:${vol}`;
    if (normalizedFamily === 'NO_TOUCH_UPPER_LOWER') return `no-touch-vol:${vol}`;
    if (normalizedFamily === 'ENDS_BETWEEN_OUTSIDE') return `expiry-range-vol:${vol}`;
    if (normalizedFamily === 'STAYS_BETWEEN_OUTSIDE') return `path-survival-vol:${vol}`;
    return 'unknown';
}

/**
 * Newey–West HAC estimate with a zero-edge shrinkage prior.
 * Values are already normalized by *combined* stake, not by one leg.
 */
export function estimatePairReturn(values, options = {}) {
    const samples = values.map(Number).filter(Number.isFinite);
    const n = samples.length;
    if (n === 0) {
        return { n: 0, rawMean: 0, mean: 0, standardError: Infinity, lowerBound: -Infinity };
    }
    const rawMean = samples.reduce((sum, value) => sum + value, 0) / n;
    const lagCount = Math.min(Math.max(0, Math.trunc(options.maxLag ?? 3)), Math.floor(Math.sqrt(n)), n - 1);
    const gamma0 = samples.reduce((sum, value) => sum + (value - rawMean) ** 2, 0) / n;
    let longRunVariance = gamma0;
    for (let lag = 1; lag <= lagCount; lag += 1) {
        let covariance = 0;
        for (let i = lag; i < n; i += 1) covariance += (samples[i] - rawMean) * (samples[i - lag] - rawMean);
        covariance /= n;
        const bartlettWeight = 1 - lag / (lagCount + 1);
        longRunVariance += 2 * bartlettWeight * covariance;
    }
    const priorStrength = Math.max(0, Number(options.priorStrength ?? HEDGE_PAIR_ANALYSIS_LIMITS.priorStrength));
    const priorStandardDeviation = Math.max(0, Number(options.priorStandardDeviation ?? HEDGE_PAIR_ANALYSIS_LIMITS.priorStandardDeviation));
    const mean = rawMean * n / (n + priorStrength);
    const hacVarianceOfMean = Math.max(0, longRunVariance) / n;
    const priorVarianceOfMean = (priorStandardDeviation ** 2) / (n + priorStrength);
    const standardError = Math.sqrt(hacVarianceOfMean + priorVarianceOfMean);
    const z = Number(options.z ?? HEDGE_PAIR_ANALYSIS_LIMITS.oneSidedZ95);
    return {
        n,
        rawMean,
        mean,
        standardError,
        lowerBound: mean - z * standardError,
        longRunVariance: Math.max(0, longRunVariance),
    };
}

function pairNormalizedReturn(outcome, multiplierA, multiplierB) {
    const grossPerUnitStake = (outcome.winA ? multiplierA : 0) + (outcome.winB ? multiplierB : 0);
    return (grossPerUnitStake - 2) / 2;
}

/**
 * Lightweight, contract-specific timing evaluation.
 * Evaluates market conditions based on the user's selected hedge pair family
 * without imposing blocking hard gates, timing entries for optimal execution.
 */
export function evaluatePairTiming({ family, prices, pipSize = 2, upperOffset = 1, lowerOffset = 1 }) {
    const normalizedFamily = String(family || '').toUpperCase();
    if (!Array.isArray(prices) || prices.length < 2) {
        return { timingReady: false, timingScore: 0, timingContext: 'warming-up', timingReason: 'collecting price history' };
    }

    const n = prices.length;
    const currentPrice = Number(prices[n - 1]);
    const prevPrice = Number(prices[n - 2]);
    const lastDelta = currentPrice - prevPrice;

    // DIGIT_OVERUNDER: Leg A (Over 5), Leg B (Under 4)
    // Dead zone: digits 4 and 5 (both lose). Winning zones: 0..3 (Under) and 6..9 (Over).
    if (normalizedFamily === 'DIGIT_OVERUNDER') {
        const lastDigit = lastDigitFromQuote(currentPrice, pipSize);
        const recentTicks = prices.slice(-Math.min(30, n));
        const digits = recentTicks.map(p => lastDigitFromQuote(p, pipSize)).filter(d => !Number.isNaN(d));
        const deadDigits = digits.filter(d => d === 4 || d === 5).length;
        const deadRate = digits.length > 0 ? deadDigits / digits.length : 0.2;
        const isDeadDigit = lastDigit === 4 || lastDigit === 5;

        if (isDeadDigit) {
            return {
                timingReady: false,
                timingScore: Math.max(25, Math.round(50 - deadRate * 40)),
                timingContext: 'digit:dead-zone',
                timingReason: `dead digit ${lastDigit} (zone 4/5) on current tick; timing next tick`,
            };
        }
        const activeSide = lastDigit > 5 ? 'over' : 'under';
        const timingScore = Math.max(50, Math.min(100, Math.round(75 - deadRate * 30 + (lastDigit >= 7 || lastDigit <= 2 ? 15 : 5))));
        return {
            timingReady: true,
            timingScore,
            timingContext: `digit:${activeSide}`,
            timingReason: `digit ${lastDigit} in active ${activeSide} zone`,
        };
    }

    // ONLY_UPS_DOWNS: Leg A (RUNHIGH), Leg B (RUNLOW)
    // Consecutive ticks must move strictly one way. Times active non-flat movements.
    if (normalizedFamily === 'ONLY_UPS_DOWNS') {
        const windowTicks = prices.slice(-Math.min(15, n));
        let flatCount = 0;
        for (let i = 1; i < windowTicks.length; i++) {
            if (Number(windowTicks[i]) === Number(windowTicks[i - 1])) flatCount++;
        }
        const flatRatio = flatCount / Math.max(1, windowTicks.length - 1);
        if (lastDelta === 0) {
            return {
                timingReady: false,
                timingScore: 35,
                timingContext: 'run:flat',
                timingReason: 'flat tick on current quote; timing active movement',
            };
        }
        const runDirection = lastDelta > 0 ? 'up' : 'down';
        const timingScore = Math.max(50, Math.min(100, Math.round(80 - flatRatio * 50)));
        return {
            timingReady: true,
            timingScore,
            timingContext: `run:${runDirection}`,
            timingReason: `active ${runDirection}ward movement (momentum ${Math.round((1 - flatRatio) * 100)}%)`,
        };
    }

    // HIGHER_LOWER: CALL (upper) / PUT (lower) relative barrier corridor
    if (normalizedFamily === 'HIGHER_LOWER') {
        const windowTicks = prices.slice(-Math.min(25, n));
        const maxP = Math.max(...windowTicks);
        const minP = Math.min(...windowTicks);
        const range = maxP - minP;
        const avgOffset = (Number(upperOffset) + Number(lowerOffset)) / 2;
        const volRatio = avgOffset > 0 ? range / avgOffset : 1;

        if (range <= 0) {
            return {
                timingReady: false,
                timingScore: 35,
                timingContext: 'hl:flat',
                timingReason: 'flat prices; timing price activity',
            };
        }
        const timingScore = Math.max(50, Math.min(100, Math.round(60 + Math.min(35, volRatio * 20))));
        return {
            timingReady: true,
            timingScore,
            timingContext: 'hl:active',
            timingReason: `range ${range.toFixed(4)} active relative to barrier corridor`,
        };
    }

    // TOUCH_UPPER_LOWER: First-passage touch on either barrier
    if (normalizedFamily === 'TOUCH_UPPER_LOWER') {
        const { short, long } = realizedVolatility(prices, n - 1, 25);
        const expanding = long > 0 ? short / long : 1;
        const timingScore = Math.max(50, Math.min(100, Math.round(65 + (expanding >= 0.85 ? 25 : 10))));
        return {
            timingReady: true,
            timingScore,
            timingContext: 'touch:active',
            timingReason: expanding >= 0.85 ? 'expanding tick movement favorable for barrier touch' : 'market moving',
        };
    }

    // NO_TOUCH_UPPER_LOWER: Price stays inside barrier boundaries
    if (normalizedFamily === 'NO_TOUCH_UPPER_LOWER') {
        const { short, long } = realizedVolatility(prices, n - 1, 25);
        const volRatio = long > 0 ? short / long : 1;
        const timingScore = Math.max(50, Math.min(100, Math.round(65 + (volRatio <= 1.2 ? 25 : 10))));
        return {
            timingReady: true,
            timingScore,
            timingContext: 'notouch:calm',
            timingReason: 'price corridor stable between barriers',
        };
    }

    // ENDS_BETWEEN_OUTSIDE & STAYS_BETWEEN_OUTSIDE: Complementary pair
    return {
        timingReady: true,
        timingScore: 75,
        timingContext: `${normalizedFamily.toLowerCase().slice(0, 5)}:ready`,
        timingReason: 'complementary hedge pair active',
    };
}

/**
 * How many ticks one non-overlapping pair observation consumes.
 *
 * Tick-denominated pairs consume exactly `duration` ticks. Time-denominated
 * pairs (every expiry family — Deriv never quotes those in ticks) consume
 * however many quotes the tape actually produces inside the expiry, so the
 * span is measured from the tape's own epoch cadence rather than assumed.
 */
export function estimateEventSpan(prices, epochs, duration, durationSeconds = 0) {
    const timeBased = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0;
    if (!timeBased) return Math.max(1, Math.trunc(Number(duration)) || 1);
    if (!Array.isArray(epochs) || epochs.length < 2) return Math.max(1, Math.trunc(Number(duration)) || 1);
    const deltas = [];
    for (let index = 1; index < epochs.length; index += 1) {
        const delta = Number(epochs[index]) - Number(epochs[index - 1]);
        if (Number.isFinite(delta) && delta > 0 && delta <= 3600) deltas.push(delta);
    }
    if (deltas.length === 0) return Math.max(1, Math.trunc(Number(duration)) || 1);
    deltas.sort((a, b) => a - b);
    const medianDelta = deltas[Math.floor(deltas.length / 2)] || 1;
    return Math.max(1, Math.ceil(Number(durationSeconds) / medianDelta));
}

/**
 * Replay the selected pair over historical windows with lightweight,
 * contract-specific timing analysis, and gate the result on evidence the tape
 * can actually supply.
 *
 * THREE GATES, deliberately separated:
 *  · HARD  — the tape cannot answer the question at all (too few non-overlapping
 *            pairs, a path that never repays, an estimate that flips between
 *            windows). Nothing may override these.
 *  · SOFT  — the measured joint expectation is below the configured hurdle. The
 *            cycle's patience valve (normal mode only, never recovery) may
 *            override this one, and says so in the journal when it does.
 *  · TIMING — the family-specific entry context (unchanged).
 *
 * The edge hurdle is compared against break-even, which for a PAIR is exactly
 * zero: `pairNormalizedReturn` already subtracts both legs' stakes, so a
 * positive value IS profit per combined stake. That is the repo's
 * break-even-first doctrine (replit.md) rather than a bar no fair tape can
 * clear — the old code accepted a `requiredEdge` and then never read it, so the
 * only pair that ever traded did so at a measured −2.7 % EV.
 */
export function analyseHedgePairTape({
    family,
    prices,
    epochs,
    duration,
    durationSeconds = 0,
    pipSize = 2,
    upperOffset = 1,
    lowerOffset = 1,
    multiplierA,
    multiplierB,
    minSamples = HEDGE_PAIR_ANALYSIS_LIMITS.minSamples,
    minContextSamples = HEDGE_PAIR_ANALYSIS_LIMITS.minContextSamples,
    requiredEdge = 0,
    mode = 'NORMAL',
    /**
     * Whether an unready entry context is a HARD blocker.
     *
     * True for the market the bot is actually about to buy. False for a ranking
     * candidate: "the entry context is not live on this tick" says nothing about
     * which market is structurally better for this pair, and gating candidates on
     * it would make almost every candidate unmeasurable — then any timing luck on
     * the incumbent would look like a reason to move (thrash). The timing score
     * still contributes 15% of the evidence score, so a market whose entry
     * context is genuinely more frequent still ranks higher.
     */
    requireTiming = true,
}) {
    const normalizedFamily = String(family || '').toUpperCase();
    if (!HEDGE_PAIR_FAMILIES.includes(normalizedFamily)) throw new Error('Unknown hedge-pair family');
    if (!finitePositive(multiplierA) || !finitePositive(multiplierB)) {
        return { eligible: false, reason: 'live pair payout quotes unavailable', samples: 0, hardBlockers: ['live pair payout quotes unavailable'], softBlockers: [] };
    }
    const timeBased = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0;
    const d = Math.trunc(Number(duration));
    if (
        !Array.isArray(prices) || prices.length < 2 ||
        (!timeBased && (!Number.isInteger(d) || d < 1)) ||
        (timeBased && (!Array.isArray(epochs) || epochs.length !== prices.length))
    ) {
        return { eligible: false, reason: 'not enough price history for the effective duration', samples: 0, hardBlockers: ['not enough price history for the effective duration'], softBlockers: [] };
    }

    const events = [];
    let index = 0;
    while (index < prices.length - 1) {
        const outcome = classifyPairOutcome({
            family: normalizedFamily,
            prices,
            epochs,
            startIndex: index,
            duration: d,
            durationSeconds,
            pipSize,
            upperOffset,
            lowerOffset,
        });
        if (!outcome) break;
        events.push({
            index,
            context: pairContextKey({ family: normalizedFamily, prices, index, pipSize }),
            winA: outcome.winA,
            winB: outcome.winB,
            ret: pairNormalizedReturn(outcome, Number(multiplierA), Number(multiplierB)),
        });
        index = outcome.endIndex;
    }

    const returns = events.map(event => event.ret);
    const all = estimatePairReturn(returns);
    const midEvents = events.slice(Math.floor(events.length / 2));
    const mid = estimatePairReturn(midEvents.map(event => event.ret));
    const shortCount = Math.max(10, Math.ceil(events.length * 0.25));
    const shortEvents = events.slice(-Math.min(events.length, shortCount));
    const recent = estimatePairReturn(shortEvents.map(event => event.ret));
    const currentContext = pairContextKey({ family: normalizedFamily, prices, index: prices.length - 1, pipSize });
    const conditionalEvents = events.filter(event => event.context === currentContext);
    const conditional = estimatePairReturn(conditionalEvents.map(event => event.ret));

    const scaleMeans = [all.rawMean, mid.rawMean, recent.rawMean];
    const instability = Math.max(...scaleMeans) - Math.min(...scaleMeans);
    const conservativeLowerBound = all.lowerBound;
    const expectedEdge = 0.45 * all.mean + 0.30 * mid.mean + 0.25 * recent.mean;

    const stateCounts = { bothWin: 0, onlyA: 0, onlyB: 0, bothLose: 0 };
    for (const event of events) {
        if (event.winA && event.winB) stateCounts.bothWin += 1;
        else if (event.winA) stateCounts.onlyA += 1;
        else if (event.winB) stateCounts.onlyB += 1;
        else stateCounts.bothLose += 1;
    }

    const timing = evaluatePairTiming({ family: normalizedFamily, prices, pipSize, upperOffset, lowerOffset });
    const isRecovery = String(mode).toUpperCase() === 'RECOVERY';

    // ── Sample arithmetic, stated instead of silently relaxed ────────────────
    // Non-overlapping replay consumes `spanTicks` per observation, so a tape of
    // N ticks can produce at most floor(N / span) pairs — whatever `minSamples`
    // says. The configured floor is honoured when the tape can supply it; when
    // it cannot, the cycle accepts what IS reachable down to the hard floor and
    // reports `lowConfidence`, and when even the hard floor is out of reach the
    // reason names the arithmetic (this is what made Ends/Stays Between look
    // like a bot that "never analyses": 16 reachable pairs against an 80 floor,
    // held with no explanation).
    const spanTicks = estimateEventSpan(prices, epochs, d, durationSeconds);
    const samplesReachable = Math.max(0, Math.floor(prices.length / spanTicks));
    const configuredMinSamples = Math.max(
        HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor,
        Math.trunc(Number(minSamples) || HEDGE_PAIR_ANALYSIS_LIMITS.minSamples),
    );
    const samplesRequired = Math.max(
        HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor,
        Math.min(configuredMinSamples, samplesReachable),
    );
    const lowConfidence = samplesRequired < configuredMinSamples;

    const repaymentSamples = stateCounts.bothWin + stateCounts.onlyA + stateCounts.onlyB;

    const hardBlockers = [];
    const softBlockers = [];
    if (events.length < samplesRequired) {
        hardBlockers.push(
            `complete paired samples ${events.length}/${samplesRequired} ` +
            `(a ${spanTicks}-tick pair over a ${prices.length}-tick tape yields at most ${samplesReachable}; ` +
            `configured floor ${configuredMinSamples})`,
        );
    }
    if (events.length > 0 && repaymentSamples === 0) {
        hardBlockers.push(`every one of ${events.length} replayed pairs lost BOTH legs — no measurable repayment path`);
    }
    if (instability > HEDGE_PAIR_ANALYSIS_LIMITS.maxInstability) {
        hardBlockers.push(
            `joint estimate unstable across windows (${(instability * 100).toFixed(1)}pt > ` +
            `${(HEDGE_PAIR_ANALYSIS_LIMITS.maxInstability * 100).toFixed(0)}pt)`,
        );
    }
    if (expectedEdge < Number(requiredEdge)) {
        softBlockers.push(
            `joint EV ${(expectedEdge * 100).toFixed(2)}% below the ${(Number(requiredEdge) * 100).toFixed(2)}% hurdle ` +
            `(break-even is 0.00% per combined stake; 95% LCB ${(conservativeLowerBound * 100).toFixed(2)}%)`,
        );
    }
    if (requireTiming && !isRecovery && !timing.timingReady) {
        hardBlockers.push(timing.timingReason);
    }

    const blockers = [...hardBlockers, ...softBlockers];
    const eligible = blockers.length === 0;
    const reason = eligible
        ? `ready: ${timing.timingReason} (score ${timing.timingScore}) · EV ${(expectedEdge * 100).toFixed(2)}% · LCB ${(conservativeLowerBound * 100).toFixed(2)}% · ${events.length} pairs${lowConfidence ? ' (low-confidence sample floor)' : ''}`
        : `hold: ${blockers.join('; ')}`;

    return {
        eligible,
        reason,
        family: normalizedFamily,
        duration: d,
        spanTicks,
        samples: events.length,
        samplesRequired,
        samplesReachable,
        configuredMinSamples,
        lowConfidence,
        contextSamples: conditionalEvents.length,
        context: timing.timingContext || currentContext,
        multiplierA: Number(multiplierA),
        multiplierB: Number(multiplierB),
        all,
        mid,
        recent,
        conditional,
        expectedEdge,
        lowerBound: conservativeLowerBound,
        breakEven: 0,
        edgeHurdle: Number(requiredEdge),
        instability,
        stateCounts,
        timingScore: timing.timingScore,
        timingReady: Boolean(timing.timingReady),
        timingGated: Boolean(requireTiming && !isRecovery),
        timingReason: timing.timingReason,
        timingContext: timing.timingContext,
        hardBlockers,
        softBlockers,
        latestEpochIndex: prices.length - 1,
    };
}

/**
 * Pair recovery sizing — the DEBT-DRIVEN single-leg canonical formula.
 *
 *   target      = debt × (1 + markup/100)            (markup is this bot's own 40 %)
 *   stakePerLeg = target / (winMultiplier − 1)       (calculateBotRecoveryStake's shape)
 *   capped by   = base × multiplier^step, maxStake, balance/2, then floored at 0.35
 *
 * WHY THIS SHAPE, AND WHAT IT DOES NOT DO
 * A pair risks two premiums, so `applyPairSettlement` books BOTH lost stakes as
 * debt ($1/leg → $2.00). The stake above is the repo's canonical single-contract
 * formula (`recovery-math.ts:calculateBotRecoveryStake`) applied per leg, which
 * is what the owner asked for: a $2.00 debt at a 2.43× winning leg sizes
 * **$1.96 per leg**. It is deliberately NOT the pair-exact size
 * (`target / (winMultiplier − 2)` = $5.12/leg), because a split win then nets
 * only `stake × (winMultiplier − 2)` = +$0.84 — so ONE pair win does not clear
 * the debt. What makes that safe is the ledger, not the size: recovery stays
 * ARMED until the debt is actually zero, so the residual $1.16 sizes the next
 * pair ($1.14/leg), then $0.66, $0.38 and the 0.35 floor — the same $2.00 debt
 * is cleared in six consecutive split wins instead of one, at a fraction of the
 * pair exposure. `projectedNetOnPairWin` and `residualDebtAfterWin` are returned
 * so the journal prints that plan instead of implying a one-shot recovery.
 *
 * `winMultiplier` is the poorer of the two LIVE proposal multipliers, so sizing
 * never assumes the better leg pays. When it is ≤ 1 the debt cannot be repaid at
 * any stake and this returns null (the cycle holds and says why); when it is
 * ≤ 2 a split win cannot repay it either, which is reported rather than hidden —
 * the ladder ceiling still sizes a stake, but `repayableByPairWin` is false.
 */
export function sizePairRecovery({
    debt,
    winMultiplier,
    multiplierA,
    multiplierB,
    baseStake,
    multiplier = HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMultiplierDefault,
    step = 1,
    markupPercent = HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent,
    maxStake = 500,
    availableBalance = 0,
    minimumStake = 0.35,
    lowerBoundPerCombinedStake = 0,
}) {
    const unrecovered = Number(debt);
    const base = Number(baseStake);
    const balance = Number(availableBalance);
    const maxPerLeg = Math.min(Number(maxStake), balance / 2);
    if (!(unrecovered > 0) || !(base > 0) || !(balance >= minimumStake * 2) || !(maxPerLeg >= minimumStake)) return null;

    const legs = [Number(multiplierA), Number(multiplierB)].filter(Number.isFinite).filter(value => value > 0);
    const reference = Number.isFinite(Number(winMultiplier)) && Number(winMultiplier) > 0
        ? Number(winMultiplier)
        : legs.length === 2 ? Math.min(legs[0], legs[1]) : NaN;
    // No live payout to size against → refuse. The old code silently fell back
    // to the ladder cap, which is how a debt-driven ledger ended up trading a
    // purely geometric stake.
    if (!Number.isFinite(reference)) return null;

    const netRate = reference - 1;
    if (!(netRate > 0)) return null;

    const markup = Math.max(0, Number.isFinite(Number(markupPercent)) ? Number(markupPercent) : HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent);
    const target = unrecovered * (1 + markup / 100);
    const ladderCap = base * Math.pow(Math.max(1.01, Number(multiplier) || HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMultiplierDefault), Math.max(1, Math.trunc(Number(step) || 1)));
    const exactPerLeg = target / netRate;

    const cap = Math.min(ladderCap, Number(maxStake), balance / 2);
    // Cannot even trade the broker minimum → genuinely refuse (the cycle says why).
    if (!Number.isFinite(cap) || cap < minimumStake) return null;
    const exactCapped = Math.min(exactPerLeg, cap);
    /**
     * Small-debt floor. Once the residual debt drops below what one minimum stake
     * can size (e.g. $0.22 left), refusing here would STRAND it again — the very
     * bug the re-arm fix removes. So the pair keeps trading the broker minimum
     * until the debt is zero, and `floorBinding` says so: it deliberately risks
     * more than the arithmetic asked for, which is why the journal prints it.
     */
    const floorBinding = exactCapped < minimumStake;
    const sized = floorBinding ? minimumStake : exactCapped;
    const roundedUp = Math.ceil((sized - 1e-10) * 100) / 100;
    const roundedDownCap = Math.floor((cap + 1e-10) * 100) / 100;
    const stakePerLeg = Math.min(roundedUp, roundedDownCap);
    if (!(stakePerLeg >= minimumStake)) return null;

    // The pair's REAL arithmetic on a one-win settlement: the winning leg pays
    // stake×multiplier, the losing leg pays nothing, both premiums were spent.
    const projectedNetOnPairWin = roundMoney(stakePerLeg * (reference - 2));
    const capKind = cap < ladderCap - 1e-9 ? 'max stake / balance' : 'ladder ceiling';
    const capBinding = floorBinding
        ? 'broker minimum stake'
        // Compare against the UNCAPPED arithmetic: `roundedUp` is already capped,
        // so a ladder ceiling that clamped $1.96 → $1.62 used to report "none"
        // and the journal never told the owner their ceiling was too low.
        : exactPerLeg > cap + 1e-9 ? capKind : 'none';
    return {
        stakePerLeg,
        pairStake: Math.round(stakePerLeg * 200) / 100,
        exactPerLeg,
        ladderCap,
        targetDebt: target,
        debt: roundMoney(unrecovered),
        winMultiplier: reference,
        netRate,
        markupPercent: markup,
        edgeLowerBound: Number(lowerBoundPerCombinedStake) || 0,
        capBinding,
        floorBinding,
        projectedNetOnPairWin,
        repayableByPairWin: projectedNetOnPairWin > 0,
        residualDebtAfterWin: roundMoney(Math.max(0, unrecovered - Math.max(0, projectedNetOnPairWin))),
    };
}

/** Aggregate realized pair P&L and the explicit double-loss recovery rule. */
export function applyPairSettlement(state, legs, options = {}) {
    const next = { ...state };
    const completed = Array.isArray(legs) ? legs : [];
    const netProfit = completed.reduce((sum, leg) => sum + Number(leg.profit || 0), 0);
    // Recovery follows the broker's per-contract terminal outcome, never the
    // sign of aggregate pair P&L (or a payout-amount heuristic). A split may
    // be net negative and still must not arm or advance recovery.
    const bothLost = completed.length === 2 && completed.every(leg => String(leg.outcome || '').toLowerCase() === 'lost');
    const bothWon = completed.length === 2 && completed.every(leg => String(leg.outcome || '').toLowerCase() === 'won');
    const split = completed.length === 2 && !bothLost && !bothWon;
    const totalStake = completed.reduce((sum, leg) => sum + Math.max(0, Number(leg.stake || leg.buyPrice || 0)), 0);
    const markup = Math.max(0, Number.isFinite(Number(options.markupPercent))
        ? Number(options.markupPercent)
        : HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent);

    next.sessionProfit = roundMoney(Number(next.sessionProfit || 0) + netProfit);
    next.completedPairs = Math.max(0, Number(next.completedPairs || 0)) + 1;
    next.lastPairNetProfit = roundMoney(netProfit);
    next.lastPairStake = roundMoney(totalStake);
    next.lastPairBothLost = bothLost;
    next.lastPairSplit = split;
    next.lastPairOutcome = bothLost ? 'double-loss' : split ? 'split/debt-unchanged-unless-positive' : bothWon ? 'double-win' : 'non-loss';

    if (bothLost) {
        // Debt is the actual premium lost on BOTH legs, not one representative stake.
        next.debt = roundMoney(Number(next.debt || 0) + totalStake);
        next.recoveryStep = Math.max(0, Number(next.recoveryStep || 0)) + 1;
        next.doubleLossRun = Math.max(0, Number(next.doubleLossRun || 0)) + 1;
        next.recoveryArmed = true;
    } else {
        // A split never ARMS or ADVANCES recovery on its own: it adds no debt and
        // never raises the step, even when its combined live P&L is negative.
        // Only positive realized pair P&L pays down existing double-loss debt.
        if (netProfit > 0 && Number(next.debt || 0) > 0) {
            next.debt = Math.max(0, roundMoney(Number(next.debt) - netProfit));
        }
        next.doubleLossRun = 0;
        // ── RE-ARM FIX ────────────────────────────────────────────────────────
        // Recovery is a property of the DEBT, not of the shape of the last
        // settlement. The previous rule set `recoveryArmed = false` here, so the
        // split that follows a double loss — which for Over 5 / Under 4 is the
        // outcome of ~80 % of pairs — dropped the bot back to base stake and
        // STRANDED the residual debt: `isRecovery` is `recoveryArmed && debt > 0`,
        // so the unpaid $1.16 of a $2.00 debt was never sized again and could only
        // be ground down by luck. Every other engine in this repo keeps recovery
        // active until the debt is actually zero (`recovery-math.ts` →
        // `recoveryComplete: remainingDebtCents === 0`); this now agrees.
        if (Number(next.debt || 0) <= DEBT_EPSILON) {
            next.debt = 0;
            next.recoveryStep = 0;
            next.recoveryArmed = false;
        } else {
            next.recoveryArmed = true;
        }
    }
    if (Number.isFinite(markup) && next.debt > 0) next.recoveryTarget = roundMoney(next.debt * (1 + markup / 100));
    else next.recoveryTarget = 0;
    const lossBreaker = Number(options.maxConsecutiveDoubleLosses ?? Infinity);
    if (Number.isFinite(lossBreaker) && Number(next.doubleLossRun || 0) >= lossBreaker) {
        next.halted = true;
        next.haltReason = `consecutive double-loss breaker ${lossBreaker} reached`;
    }
    return { state: next, netProfit: roundMoney(netProfit), totalStake: roundMoney(totalStake), bothLost, bothWon, split };
}

/**
 * Payout-FREE evidence score for one market × family replay.
 *
 * Ranking cannot use live payouts: quoting both legs on eight markets every tick
 * would burn Deriv's request budget before a single pair was bought (the same
 * budget rule that caps the watch list at 8, doc §2.3 N7). So markets are ranked
 * on what a tape alone can prove — how often this pair actually repays, how
 * stable that estimate is across windows, whether the entry context is live, and
 * how much of the requested sample floor the tape could supply — and ONLY THE
 * WINNER is then quoted live and re-gated on real payouts before any buy.
 *
 * The repayment rate is the dominant term on purpose: a pair spends two premiums
 * every time it fires, so the double-loss rate is what decides whether the pair
 * can ever pay its way, and it is the statistic that varies most between tapes.
 */
export function pairEvidenceScore(row = {}) {
    const counts = row.stateCounts ?? {};
    const samples = Number(row.samples) || 0;
    // An unmeasured market scores zero, not a free 0.20 for "instability 0".
    // Stability is a property of a sample, and there is no sample here.
    if (!(samples > 0)) return { score: 0, repaymentRate: 0, stability: 0, timing: 0, sampleConfidence: 0 };
    const repaying = Number(counts.bothWin || 0) + Number(counts.onlyA || 0) + Number(counts.onlyB || 0);
    const repaymentRate = samples > 0 ? repaying / samples : 0;
    const maxInstability = HEDGE_PAIR_ANALYSIS_LIMITS.maxInstability;
    const instability = Number(row.instability) || 0;
    const stability = Math.max(0, 1 - Math.min(1, instability / maxInstability));
    const timing = Math.max(0, Math.min(1, (Number(row.timingScore) || 0) / 100));
    const configured = Number(row.configuredMinSamples) || HEDGE_PAIR_ANALYSIS_LIMITS.minSamples;
    const sampleConfidence = configured > 0 ? Math.max(0, Math.min(1, samples / configured)) : 0;
    const score = 0.55 * repaymentRate + 0.20 * stability + 0.15 * timing + 0.10 * sampleConfidence;
    return {
        score: roundMoney(score * 1e6) / 1e6,
        repaymentRate,
        stability,
        timing,
        sampleConfidence,
    };
}

/**
 * Rank every watched market for the SELECTED family and decide whether to move.
 *
 * Pure and jest-testable: the cycle passes one analysis row per market (plus the
 * evaluation counters it owns) and gets back the winner, the ranked table for the
 * journal, and an explicit switch decision with the reason — including the
 * anti-thrash conjunction from docs/digit-forge-market-switching.md §4.3(f):
 * the candidate must beat the incumbent by δ, the incumbent must have been held
 * for the dwell, and the global cooldown must have elapsed. Recovery asks for a
 * wider δ (a debt-sized pair must not chase a marginal tape) and the cycle
 * additionally refuses to BUY on a market whose live winning-leg payout is worse
 * than the one it left, so a switch can never silently lengthen the ladder.
 */
export function rankHedgePairMarkets(rows, options = {}) {
    const list = Array.isArray(rows) ? rows.filter(row => row && row.symbol) : [];
    const currentSymbol = String(options.currentSymbol ?? '');
    const isRecovery = options.isRecovery === true;
    const evaluationsOnCurrent = Math.max(0, Number(options.evaluationsOnCurrent) || 0);
    const evaluationsSinceSwitch = Math.max(0, Number(options.evaluationsSinceSwitch) || 0);
    const delta = Math.max(0, Number.isFinite(Number(options.switchEdgeDelta))
        ? Number(options.switchEdgeDelta)
        : HEDGE_PAIR_ANALYSIS_LIMITS.switchEdgeDelta) * (isRecovery ? 2 : 1);
    const dwell = Math.max(0, Number.isFinite(Number(options.switchDwellEvaluations))
        ? Number(options.switchDwellEvaluations)
        : HEDGE_PAIR_ANALYSIS_LIMITS.switchDwellEvaluations);
    const cooldown = Math.max(0, Number.isFinite(Number(options.switchCooldownEvaluations))
        ? Number(options.switchCooldownEvaluations)
        : HEDGE_PAIR_ANALYSIS_LIMITS.switchCooldownEvaluations);

    const scored = list.map(row => ({ ...row, evidence: pairEvidenceScore(row) }))
        .map(row => ({
            ...row,
            analysable: !(Array.isArray(row.hardBlockers) && row.hardBlockers.length > 0),
        }))
        // An analysable market always outranks one that cannot be measured, then
        // the evidence score decides, then the sample count breaks ties.
        .sort((a, b) => Number(b.analysable) - Number(a.analysable)
            || b.evidence.score - a.evidence.score
            || (Number(b.samples) || 0) - (Number(a.samples) || 0));

    const best = scored[0] ?? null;
    const current = scored.find(row => row.symbol === currentSymbol) ?? null;
    const decision = {
        switch: false,
        reason: 'single market in the watch list',
        bestSymbol: best?.symbol ?? '',
        bestScore: best?.evidence?.score ?? 0,
        currentSymbol,
        currentScore: current?.evidence?.score ?? 0,
        delta,
        dwell,
        cooldown,
        evaluationsOnCurrent,
        evaluationsSinceSwitch,
    };
    if (!best || scored.length < 2) return { best, ranked: scored, decision };
    // Checked BEFORE "the incumbent is already the best": when nothing on the
    // watch list can be measured, saying "holding, it is the best of N" hides the
    // actual problem from the journal.
    if (!best.analysable) {
        decision.reason = `no watched market can be measured · best candidate ${best.symbol}: ${(best.hardBlockers || []).join('; ')}`;
        return { best, ranked: scored, decision };
    }
    if (best.symbol === currentSymbol) {
        decision.reason = `holding ${currentSymbol} · it is the best of ${scored.length} watched markets · ` +
            `repayment ${(best.evidence.repaymentRate * 100).toFixed(1)}% of ${Number(best.samples) || 0} pairs`;
        return { best, ranked: scored, decision };
    }
    const gain = best.evidence.score - (current?.evidence?.score ?? -Infinity);
    if (!(gain >= delta)) {
        decision.reason = `${best.symbol} leads by ${(gain * 100).toFixed(2)}pt, below the ${(delta * 100).toFixed(2)}pt switch margin`;
        return { best, ranked: scored, decision };
    }
    if (evaluationsOnCurrent < dwell) {
        decision.reason = `${best.symbol} leads by ${(gain * 100).toFixed(2)}pt but ${currentSymbol} has only been held ${evaluationsOnCurrent}/${dwell} evaluations`;
        return { best, ranked: scored, decision };
    }
    if (evaluationsSinceSwitch < cooldown) {
        decision.reason = `${best.symbol} leads by ${(gain * 100).toFixed(2)}pt but the switch cooldown is ${evaluationsSinceSwitch}/${cooldown}`;
        return { best, ranked: scored, decision };
    }
    decision.switch = true;
    decision.gain = gain;
    decision.reason = `${currentSymbol || 'seed'} → ${best.symbol} · evidence ${(best.evidence.score * 100).toFixed(2)} vs ` +
        `${current ? (current.evidence.score * 100).toFixed(2) : 'n/a'} (+${(gain * 100).toFixed(2)}pt ≥ ${(delta * 100).toFixed(2)}pt) · ` +
        `repayment ${(best.evidence.repaymentRate * 100).toFixed(1)}% · ${Number(best.samples) || 0} pairs`;
    return { best, ranked: scored, decision };
}
