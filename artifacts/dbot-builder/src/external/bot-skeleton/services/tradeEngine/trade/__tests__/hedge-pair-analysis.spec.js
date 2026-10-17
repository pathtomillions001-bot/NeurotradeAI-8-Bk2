import {
    HEDGE_PAIR_DEFINITIONS,
    HEDGE_PAIR_FAMILIES,
    analyseHedgePairTape,
    applyPairSettlement,
    classifyPairOutcome,
    estimatePairReturn,
    lastDigitFromQuote,
    normalizePairConfig,
    pairContextKey,
    sizePairRecovery,
} from '../hedge-pair-analysis';

describe('Hedge Pair Forge contract-family path semantics', () => {
    it('declares exactly the seven requested pairs and Deriv contract identifiers', () => {
        expect(HEDGE_PAIR_FAMILIES).toEqual([
            'DIGIT_OVERUNDER',
            'ONLY_UPS_DOWNS',
            'HIGHER_LOWER',
            'TOUCH_UPPER_LOWER',
            'NO_TOUCH_UPPER_LOWER',
            'ENDS_BETWEEN_OUTSIDE',
            'STAYS_BETWEEN_OUTSIDE',
        ]);
        expect(HEDGE_PAIR_DEFINITIONS.DIGIT_OVERUNDER.legs).toEqual([
            { type: 'DIGITOVER', barrier: 5, barriers: 1 }, { type: 'DIGITUNDER', barrier: 4, barriers: 1 },
        ]);
        expect(HEDGE_PAIR_DEFINITIONS.ONLY_UPS_DOWNS.legs.map(leg => leg.type)).toEqual(['RUNHIGH', 'RUNLOW']);
        expect(HEDGE_PAIR_DEFINITIONS.HIGHER_LOWER.legs.map(leg => leg.type)).toEqual(['CALL', 'PUT']);
        expect(HEDGE_PAIR_DEFINITIONS.HIGHER_LOWER.legs.map(leg => leg.barrier)).toEqual(['upper', 'lower']);
        expect(HEDGE_PAIR_DEFINITIONS.HIGHER_LOWER.timing).toEqual({ confirmations: 2, recoveryConfirmations: 3 });
        expect(HEDGE_PAIR_DEFINITIONS.ONLY_UPS_DOWNS.timing).toEqual({ confirmations: 3, recoveryConfirmations: 4 });
        expect(HEDGE_PAIR_DEFINITIONS.TOUCH_UPPER_LOWER.legs.map(leg => leg.type)).toEqual(['ONETOUCH', 'ONETOUCH']);
        expect(HEDGE_PAIR_DEFINITIONS.NO_TOUCH_UPPER_LOWER.legs.map(leg => leg.type)).toEqual(['NOTOUCH', 'NOTOUCH']);
        expect(HEDGE_PAIR_DEFINITIONS.ENDS_BETWEEN_OUTSIDE.legs.map(leg => leg.type)).toEqual(['EXPIRYRANGE', 'EXPIRYMISS']);
        expect(HEDGE_PAIR_DEFINITIONS.STAYS_BETWEEN_OUTSIDE.legs.map(leg => leg.type)).toEqual(['RANGE', 'UPORDOWN']);
    });

    it('extracts the final quoted digit using the symbol precision', () => {
        expect(lastDigitFromQuote(123.456, 3)).toBe(6);
        expect(lastDigitFromQuote(123.4, 2)).toBe(0);
        expect(lastDigitFromQuote('not a price', 2)).toBeNaN();
    });

    it('classifies Over 5 / Under 4 from the terminal digit, leaving 4 and 5 as joint losses', () => {
        const quoteForDigit = digit => 100 + digit / 100;
        const make = digit => classifyPairOutcome({
            family: 'DIGIT_OVERUNDER', prices: [100, quoteForDigit(digit)], startIndex: 0, duration: 1, pipSize: 2,
        });
        expect(make(8)).toMatchObject({ winA: true, winB: false, digit: 8 });
        expect(make(2)).toMatchObject({ winA: false, winB: true, digit: 2 });
        expect(make(4)).toMatchObject({ winA: false, winB: false, digit: 4 });
        expect(make(5)).toMatchObject({ winA: false, winB: false, digit: 5 });
    });

    it('Only Ups/Downs require every successive tick to be strictly monotone', () => {
        expect(classifyPairOutcome({ family: 'ONLY_UPS_DOWNS', prices: [100, 101, 102], startIndex: 0, duration: 2 }))
            .toMatchObject({ winA: true, winB: false });
        expect(classifyPairOutcome({ family: 'ONLY_UPS_DOWNS', prices: [100, 99, 98], startIndex: 0, duration: 2 }))
            .toMatchObject({ winA: false, winB: true });
        expect(classifyPairOutcome({ family: 'ONLY_UPS_DOWNS', prices: [100, 101, 101], startIndex: 0, duration: 2 }))
            .toMatchObject({ winA: false, winB: false });
        expect(classifyPairOutcome({ family: 'ONLY_UPS_DOWNS', prices: [100, 101, 100], startIndex: 0, duration: 2 }))
            .toMatchObject({ winA: false, winB: false });
    });

    it('Higher/Lower uses CALL/PUT barriers, with a losing middle band and strict boundaries', () => {
        const classify = end => classifyPairOutcome({
            family: 'HIGHER_LOWER', prices: [10, end], startIndex: 0, duration: 1,
            upperOffset: 0.1, lowerOffset: 0.1,
        });
        expect(classify(10.2)).toMatchObject({ winA: true, winB: false, high: 10.1, low: 9.9 });
        expect(classify(9.8)).toMatchObject({ winA: false, winB: true, high: 10.1, low: 9.9 });
        expect(classify(10)).toMatchObject({ winA: false, winB: false });
        expect(classify(10.1)).toMatchObject({ winA: false, winB: false });
        expect(classify(9.9)).toMatchObject({ winA: false, winB: false });
    });

    it('Touch/No Touch use the complete path and include a barrier touch', () => {
        const path = [100, 100.4, 101, 100.1];
        expect(classifyPairOutcome({ family: 'TOUCH_UPPER_LOWER', prices: path, startIndex: 0, duration: 3, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: true, winB: false });
        expect(classifyPairOutcome({ family: 'NO_TOUCH_UPPER_LOWER', prices: path, startIndex: 0, duration: 3, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: false, winB: true });
        const equality = classifyPairOutcome({ family: 'TOUCH_UPPER_LOWER', prices: [100, 101], startIndex: 0, duration: 1, upperOffset: 1, lowerOffset: 1 });
        expect(equality).toMatchObject({ winA: true, winB: false });
    });

    it('time-based outcomes end at the first observed quote on or after the Deriv expiry epoch', () => {
        const result = classifyPairOutcome({
            family: 'TOUCH_UPPER_LOWER',
            prices: [100, 100.5, 101, 99, 101],
            epochs: [1000, 1001, 1003, 1004, 1006],
            startIndex: 0,
            duration: 1,
            durationSeconds: 3,
            upperOffset: 1,
            lowerOffset: 1,
        });
        expect(result).toMatchObject({ endIndex: 2, end: 101, winA: true, winB: false });
    });

    it('Ends Between/Outside are mutually exclusive except strict endpoint equality', () => {
        expect(classifyPairOutcome({ family: 'ENDS_BETWEEN_OUTSIDE', prices: [100, 100.5], startIndex: 0, duration: 1, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: true, winB: false });
        expect(classifyPairOutcome({ family: 'ENDS_BETWEEN_OUTSIDE', prices: [100, 101.5], startIndex: 0, duration: 1, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: false, winB: true });
        expect(classifyPairOutcome({ family: 'ENDS_BETWEEN_OUTSIDE', prices: [100, 101], startIndex: 0, duration: 1, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: false, winB: false });
    });

    it('Stays Between requires the full path strictly inside; Goes Outside needs a barrier crossing', () => {
        expect(classifyPairOutcome({ family: 'STAYS_BETWEEN_OUTSIDE', prices: [100, 100.4, 100.8], startIndex: 0, duration: 2, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: true, winB: false });
        expect(classifyPairOutcome({ family: 'STAYS_BETWEEN_OUTSIDE', prices: [100, 100.4, 101], startIndex: 0, duration: 2, upperOffset: 1, lowerOffset: 1 }))
            .toMatchObject({ winA: false, winB: true });
    });

    it('fails closed when a historical contract path is incomplete', () => {
        expect(classifyPairOutcome({ family: 'HIGHER_LOWER', prices: [100], startIndex: 0, duration: 1 })).toBeNull();
    });

    it('uses family-specific, causal entry contexts', () => {
        expect(pairContextKey({ family: 'DIGIT_OVERUNDER', prices: [100.08], index: 0, pipSize: 2 })).toBe('digit:high');
        expect(pairContextKey({ family: 'ONLY_UPS_DOWNS', prices: [100, 101, 102], index: 2 })).toBe('run:1');
        expect(pairContextKey({ family: 'TOUCH_UPPER_LOWER', prices: [100, 100.1, 100.2], index: 2 })).toMatch(/^touch-vol:/);
        expect(pairContextKey({ family: 'NO_TOUCH_UPPER_LOWER', prices: [100, 100.1, 100.2], index: 2 })).toMatch(/^no-touch-vol:/);
        expect(pairContextKey({ family: 'HIGHER_LOWER', prices: [100, 101], index: 1 })).toBe('direction:1');
    });
});

describe('Hedge Pair Forge joint payout inference', () => {
    it('shrinks short samples toward a zero edge and gives a one-sided conservative lower bound', () => {
        const short = estimatePairReturn([0.5, 0.5, 0.5]);
        const longer = estimatePairReturn(Array(100).fill(0.5));
        expect(short.mean).toBeLessThan(0.5);
        expect(longer.lowerBound).toBeGreaterThan(short.lowerBound);
        expect(short.lowerBound).toBeLessThan(short.mean);
    });

    it('fails closed without live proposal multipliers and with too few complete pairs', () => {
        const prices = Array.from({ length: 200 }, (_, i) => 100 + (i % 2) * 0.01);
        expect(analyseHedgePairTape({ family: 'HIGHER_LOWER', prices, duration: 1 }).eligible).toBe(false);
        const analysis = analyseHedgePairTape({
            family: 'HIGHER_LOWER', prices: [100, 101, 100], duration: 1,
            multiplierA: 1.9, multiplierB: 1.9, minSamples: 80,
        });
        expect(analysis.eligible).toBe(false);
        expect(analysis.reason).toMatch(/complete paired samples/);
    });

    it('does not mislabel a constant realized pair return as unstable because its shrinkage changes by window size', () => {
        const prices = Array.from({ length: 500 }, (_, index) => 100 + index * 0.01);
        const result = analyseHedgePairTape({
            family: 'ONLY_UPS_DOWNS',
            prices,
            duration: 1,
            multiplierA: 2.2,
            multiplierB: 2.2,
            minSamples: 80,
            minContextSamples: 20,
            requiredEdge: 0.01,
        });
        expect(result.samples).toBeGreaterThan(80);
        expect(result.stateCounts).toMatchObject({ onlyA: expect.any(Number), onlyB: 0, bothLose: 0 });
        expect(result.instability).toBeLessThan(1e-12);
        expect(result.eligible).toBe(true);
    });

    it('replays second/minute durations against epochs rather than assuming a fixed ticks-per-minute rate', () => {
        const prices = Array.from({ length: 101 }, () => 100);
        const epochs = Array.from({ length: 101 }, (_, index) => 1000 + index);
        const result = analyseHedgePairTape({
            family: 'ONLY_UPS_DOWNS',
            prices,
            epochs,
            duration: 1,
            durationSeconds: 5,
            multiplierA: 1.9,
            multiplierB: 1.9,
            minSamples: 20,
            minContextSamples: 20,
        });
        expect(result.samples).toBe(20);
        expect(result.contextSamples).toBe(20);
    });

    it('sizes a pair using conservative edge per combined stake, then applies the per-leg ladder cap', () => {
        const recovery = sizePairRecovery({
            debt: 2,
            lowerBoundPerCombinedStake: 0.8,
            baseStake: 1,
            multiplier: 2,
            step: 1,
            markupPercent: 10,
            maxStake: 10,
            availableBalance: 100,
        });
        expect(recovery.stakePerLeg).toBe(1.38);
        expect(recovery.pairStake).toBe(2.76);
        expect(sizePairRecovery({ debt: 2, lowerBoundPerCombinedStake: 0, baseStake: 1 })).toBeNull();
    });

    it('uses exact pair-state arithmetic: double losses add both stakes; splits never arm recovery', () => {
        const split = applyPairSettlement(
            { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0, recoveryArmed: false },
            [{ outcome: 'won', stake: 0.5, profit: 0.46 }, { outcome: 'lost', stake: 0.5, profit: -0.5 }],
            { markupPercent: 10 },
        );
        expect(split.netProfit).toBe(-0.04);
        expect(split.split).toBe(true);
        expect(split.state.sessionProfit).toBe(-0.04);
        expect(split.state.debt).toBe(0);
        expect(split.state.recoveryArmed).toBe(false);
        expect(split.state.recoveryStep).toBe(0);

        const doubleLoss = applyPairSettlement(
            { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0, recoveryArmed: false },
            [{ outcome: 'lost', stake: 0.75, profit: -0.75 }, { outcome: 'lost', stake: 0.65, profit: -0.65 }],
            { markupPercent: 10 },
        );
        expect(doubleLoss.totalStake).toBe(1.4);
        expect(doubleLoss.state.debt).toBe(1.4);
        expect(doubleLoss.state.recoveryTarget).toBe(1.54);
        expect(doubleLoss.state.recoveryArmed).toBe(true);
        expect(doubleLoss.state.recoveryStep).toBe(1);
    });

    it('sets an explicit halt reason when the consecutive double-loss breaker trips', () => {
        const result = applyPairSettlement(
            { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 1, recoveryArmed: false },
            [{ outcome: 'lost', stake: 0.5, profit: -0.5 }, { outcome: 'lost', stake: 0.5, profit: -0.5 }],
            { markupPercent: 10, maxConsecutiveDoubleLosses: 2 },
        );
        expect(result.state.halted).toBe(true);
        expect(result.state.haltReason).toMatch(/double-loss breaker 2/);
    });

    it('does not trigger recovery for a negative split while preserving existing debt and aggregate P&L', () => {
        const result = applyPairSettlement(
            { sessionProfit: 0, debt: 1.2, recoveryStep: 2, doubleLossRun: 1, recoveryArmed: true },
            [{ outcome: 'won', stake: 0.5, profit: 0.2 }, { outcome: 'lost', stake: 0.5, profit: -0.4 }],
            { markupPercent: 10 },
        );
        expect(result.netProfit).toBe(-0.2);
        expect(result.split).toBe(true);
        expect(result.state.debt).toBe(1.2);
        expect(result.state.recoveryArmed).toBe(false);
        expect(result.state.recoveryStep).toBe(2);
        expect(result.state.sessionProfit).toBe(-0.2);
    });

    it('never infers a double loss from negative P&L when both broker outcomes are not losses', () => {
        const result = applyPairSettlement(
            { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0, recoveryArmed: false },
            [{ outcome: 'won', stake: 0.5, profit: -0.1 }, { outcome: 'won', stake: 0.5, profit: -0.2 }],
            { markupPercent: 10 },
        );
        expect(result.bothLost).toBe(false);
        expect(result.split).toBe(false);
        expect(result.state.debt).toBe(0);
        expect(result.state.recoveryArmed).toBe(false);
        expect(result.state.sessionProfit).toBe(-0.3);
    });

    it('only applies positive realized aggregate P&L to existing debt', () => {
        const result = applyPairSettlement(
            { sessionProfit: -1, debt: 2, recoveryStep: 1, doubleLossRun: 0, recoveryArmed: true },
            [{ outcome: 'won', stake: 0.5, profit: 0.8 }, { outcome: 'won', stake: 0.5, profit: 0.7 }],
            { markupPercent: 10 },
        );
        expect(result.bothWon).toBe(true);
        expect(result.netProfit).toBe(1.5);
        expect(result.state.debt).toBe(0.5);
        expect(result.state.recoveryArmed).toBe(false);
    });

    it('normalizes pair settings with strict family validation, market-barrier checks and configurable timing floors', () => {
        expect(normalizePairConfig({ family: 'higher_lower', upperOffset: 0.5, lowerOffset: 0.5, requestedDuration: 50 }).family).toBe('HIGHER_LOWER');
        expect(normalizePairConfig({ family: 'HIGHER_LOWER', upperOffset: 0.5, lowerOffset: 0.5, requestedDuration: 50 }).requestedDuration).toBe(1);
        expect(normalizePairConfig({ family: 'ONLY_UPS_DOWNS', entryConfirmations: 5, recoveryConfirmations: 7 }))
            .toMatchObject({ entryConfirmations: 5, recoveryConfirmations: 7 });
        expect(normalizePairConfig({ family: 'ONLY_UPS_DOWNS', entryConfirmations: 1, recoveryConfirmations: 2 }))
            .toMatchObject({ entryConfirmations: 3, recoveryConfirmations: 4 });
        expect(() => normalizePairConfig({ family: 'BAD_PAIR' })).toThrow(/Unknown/);
        expect(() => normalizePairConfig({ family: 'TOUCH_UPPER_LOWER', upperOffset: 0, lowerOffset: 0 })).toThrow(/offsets/);
    });
});
