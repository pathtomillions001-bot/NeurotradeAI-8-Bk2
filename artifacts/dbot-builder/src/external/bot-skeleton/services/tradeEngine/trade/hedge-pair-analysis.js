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
    maxTicks: 1000,
    minSamples: 80,
    minContextSamples: 20,
    priorStrength: 20,
    priorStandardDeviation: 0.5,
    oneSidedZ95: 1.645,
    maxInstability: 0.35,
    confirmationTicks: 2,
    recoveryConfirmationTicks: 3,
});

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 1e8) / 1e8;

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
    return {
        family,
        requestedDuration,
        upperOffset: definition.needsPriceBarriers ? upperOffset : 0,
        lowerOffset: definition.needsPriceBarriers ? lowerOffset : 0,
        analysisWindow: Math.max(100, Math.min(HEDGE_PAIR_ANALYSIS_LIMITS.maxTicks, Math.trunc(Number(input.analysisWindow) || 500))),
        minSamples: Math.max(20, Math.min(1000, Math.trunc(Number(input.minSamples) || HEDGE_PAIR_ANALYSIS_LIMITS.minSamples))),
        requiredEdge: Math.max(0, Math.min(0.5, Number.isFinite(Number(input.requiredEdge)) ? Number(input.requiredEdge) : 0.01)),
        recoveryMultiplier: Math.max(1.01, Math.min(5, Number(input.recoveryMultiplier) || 1.62)),
        maxRecoverySteps: Math.max(1, Math.min(10, Math.trunc(Number(input.maxRecoverySteps) || 3))),
        markupPercent: Math.max(0, Math.min(100, Number(input.markupPercent) || 0)),
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
 * Replay the selected pair over historical windows with lightweight,
 * contract-specific timing analysis. No hard gates that freeze execution.
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
    requiredEdge = 0.01,
    mode = 'NORMAL',
}) {
    const normalizedFamily = String(family || '').toUpperCase();
    if (!HEDGE_PAIR_FAMILIES.includes(normalizedFamily)) throw new Error('Unknown hedge-pair family');
    if (!finitePositive(multiplierA) || !finitePositive(multiplierB)) {
        return { eligible: false, reason: 'live pair payout quotes unavailable', samples: 0 };
    }
    const timeBased = Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0;
    const d = Math.trunc(Number(duration));
    if (
        !Array.isArray(prices) || prices.length < 2 ||
        (!timeBased && (!Number.isInteger(d) || d < 1)) ||
        (timeBased && (!Array.isArray(epochs) || epochs.length !== prices.length))
    ) {
        return { eligible: false, reason: 'not enough price history for the effective duration', samples: 0 };
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

    const effectiveMinSamples = Math.min(events.length < 20 ? 20 : Math.trunc(Number(minSamples) || 20), Math.trunc(Number(minSamples) || 20));
    const blockers = [];
    if (events.length < effectiveMinSamples) {
        blockers.push(`complete paired samples ${events.length}/${effectiveMinSamples}`);
    }
    if (!isRecovery && !timing.timingReady) {
        blockers.push(timing.timingReason);
    }

    const eligible = blockers.length === 0;
    const reason = eligible
        ? `ready: ${timing.timingReason} (score ${timing.timingScore})`
        : `hold: ${blockers.join('; ')}`;

    return {
        eligible,
        reason,
        family: normalizedFamily,
        duration: d,
        samples: events.length,
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
        instability,
        stateCounts,
        timingScore: timing.timingScore,
        latestEpochIndex: prices.length - 1,
    };
}

/**
 * Pair recovery sizing: target debt + markup against the conservative *joint*
 * net-return lower bound, then cap it with the user's familiar multiplier
 * ladder, the per-contract max stake, and half the available balance.
 * Uses the user's configured multiplier ladder when edge is neutral/warming up.
 */
export function sizePairRecovery({
    debt,
    lowerBoundPerCombinedStake,
    baseStake,
    multiplier = 1.62,
    step = 1,
    markupPercent = 10,
    maxStake = 500,
    availableBalance = 0,
    minimumStake = 0.35,
}) {
    const unrecovered = Number(debt);
    const base = Number(baseStake);
    const balance = Number(availableBalance);
    const maxPerLeg = Math.min(Number(maxStake), balance / 2);
    if (!(unrecovered > 0) || !(base > 0) || !(balance >= minimumStake * 2) || !(maxPerLeg >= minimumStake)) return null;

    const target = unrecovered * (1 + Math.max(0, Number(markupPercent) || 0) / 100);
    const ladderCap = base * Math.pow(Math.max(1.01, Number(multiplier) || 1.62), Math.max(1, Math.trunc(Number(step) || 1)));

    const lowerBound = Number(lowerBoundPerCombinedStake);
    let exactPerLeg = ladderCap;
    if (Number.isFinite(lowerBound) && lowerBound > 0) {
        exactPerLeg = target / lowerBound / 2;
    }

    const uncapped = Math.min(exactPerLeg, ladderCap, Number(maxStake), balance / 2);
    if (!Number.isFinite(uncapped) || uncapped < minimumStake) return null;
    const roundedUp = Math.ceil((uncapped - 1e-10) * 100) / 100;
    const roundedDownCap = Math.floor((Math.min(ladderCap, Number(maxStake), balance / 2) + 1e-10) * 100) / 100;
    const stakePerLeg = Math.min(roundedUp, roundedDownCap);
    if (stakePerLeg < minimumStake) return null;
    return {
        stakePerLeg,
        pairStake: Math.round(stakePerLeg * 200) / 100,
        exactPerLeg,
        ladderCap,
        targetDebt: target,
        edgeLowerBound: lowerBound,
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
    const markup = Math.max(0, Number(options.markupPercent) || 0);

    next.sessionProfit = roundMoney(Number(next.sessionProfit || 0) + netProfit);
    next.completedPairs = Math.max(0, Number(next.completedPairs || 0)) + 1;
    next.lastPairNetProfit = roundMoney(netProfit);
    next.lastPairStake = roundMoney(totalStake);
    next.lastPairBothLost = bothLost;
    next.lastPairSplit = split;
    next.lastPairOutcome = bothLost ? 'double-loss' : split ? 'split/no-recovery-trigger' : bothWon ? 'double-win' : 'non-loss';

    if (bothLost) {
        // Debt is the actual premium lost on BOTH legs, not one representative stake.
        next.debt = roundMoney(Number(next.debt || 0) + totalStake);
        next.recoveryStep = Math.max(0, Number(next.recoveryStep || 0)) + 1;
        next.doubleLossRun = Math.max(0, Number(next.doubleLossRun || 0)) + 1;
        next.recoveryArmed = true;
    } else {
        // A split win/loss never arms or advances recovery, even if the combined
        // live P&L is slightly negative. Record that loss in session P&L, but
        // only positive realized pair P&L pays down existing double-loss debt.
        if (netProfit > 0 && Number(next.debt || 0) > 0) {
            next.debt = Math.max(0, roundMoney(Number(next.debt) - netProfit));
        }
        next.doubleLossRun = 0;
        next.recoveryArmed = false;
        if (next.debt <= 0.005) {
            next.debt = 0;
            next.recoveryStep = 0;
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
