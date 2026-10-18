import {
    HEDGE_PAIR_ANALYSIS_LIMITS,
    HEDGE_PAIR_DEFINITIONS,
    HEDGE_PAIR_FAMILIES,
    MIN_REPRESENTABLE_OFFSET,
    analyseHedgePairTape,
    applyPairSettlement,
    classifyPairOutcome,
    estimateEventSpan,
    estimatePairReturn,
    lastDigitFromQuote,
    normalizePairConfig,
    normalizeWatchMarkets,
    pairContextKey,
    pairEvidenceScore,
    rankHedgePairMarkets,
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

    it('sizes a $2.00 pair debt at $1.96 per leg from the live winning-leg payout', () => {
        const recovery = sizePairRecovery({
            debt: 2,
            multiplierA: 2.43,
            multiplierB: 2.43,
            baseStake: 1,
            multiplier: 2.43,
            step: 1,
            markupPercent: 40,
            maxStake: 500,
            availableBalance: 1000,
        });
        // 2.00 debt × 1.40 = 2.80 target ÷ (2.43 − 1) = 1.9580… → up to the cent.
        expect(recovery.exactPerLeg).toBeCloseTo(2.8 / 1.43, 10);
        expect(recovery.stakePerLeg).toBe(1.96);
        expect(recovery.pairStake).toBe(3.92);
        expect(recovery.targetDebt).toBeCloseTo(2.8, 10);
        expect(recovery.capBinding).toBe('none');
        expect(recovery.repayableByPairWin).toBe(true);
        // A pair risks TWO premiums: a split win nets 1.96 × (2.43 − 2) = +0.8428
        // and still leaves 1.1572 owed, which the ledger carries forward.
        expect(recovery.projectedNetOnPairWin).toBeCloseTo(0.8428, 4);
        expect(recovery.residualDebtAfterWin).toBeCloseTo(1.1572, 4);
    });

    it('sizes against the poorer live leg, never the better one', () => {
        const recovery = sizePairRecovery({
            debt: 2, multiplierA: 3.2, multiplierB: 2.43, baseStake: 1,
            markupPercent: 40, availableBalance: 1000,
        });
        expect(recovery.winMultiplier).toBe(2.43);
        expect(recovery.stakePerLeg).toBe(1.96);
        const explicit = sizePairRecovery({
            debt: 2, winMultiplier: 2.43, multiplierA: 9, multiplierB: 9, baseStake: 1,
            markupPercent: 40, availableBalance: 1000,
        });
        expect(explicit.winMultiplier).toBe(2.43);
        expect(explicit.stakePerLeg).toBe(1.96);
    });

    it("uses Hedge Pair Forge's own 40% markup and 2.43 ladder ceiling by default", () => {
        expect(HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent).toBe(40);
        expect(HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMultiplierDefault).toBe(2.43);
        const defaults = sizePairRecovery({ debt: 2, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1, availableBalance: 1000 });
        expect(defaults.markupPercent).toBe(40);
        expect(defaults.stakePerLeg).toBe(1.96);
        // The shared server markup (10%) would size 1.54 and need nine pair wins.
        const sharedMarkup = sizePairRecovery({
            debt: 2, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1,
            markupPercent: 10, availableBalance: 1000,
        });
        expect(sharedMarkup.stakePerLeg).toBe(1.54);
        // The old 1.62 ceiling clamps the debt-driven size, and now says so.
        const oldCeiling = sizePairRecovery({
            debt: 2, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1,
            multiplier: 1.62, availableBalance: 1000,
        });
        expect(oldCeiling.stakePerLeg).toBe(1.62);
        expect(oldCeiling.capBinding).toBe('ladder ceiling');
    });

    it('fails closed without a live payout and reports a split that cannot repay the debt', () => {
        expect(sizePairRecovery({
            debt: 2, lowerBoundPerCombinedStake: 0.8, baseStake: 1, multiplier: 2, step: 1, availableBalance: 100,
        })).toBeNull();
        expect(sizePairRecovery({ debt: 2, multiplierA: 1, multiplierB: 1, baseStake: 1, availableBalance: 100 })).toBeNull();
        expect(sizePairRecovery({ debt: 0, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1, availableBalance: 100 })).toBeNull();
        const weak = sizePairRecovery({ debt: 2, multiplierA: 1.8, multiplierB: 1.8, baseStake: 1, availableBalance: 100 });
        expect(weak.repayableByPairWin).toBe(false);
        expect(weak.projectedNetOnPairWin).toBeLessThan(0);
        const balanceCapped = sizePairRecovery({
            debt: 400, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1, multiplier: 50,
            maxStake: 500, availableBalance: 4,
        });
        expect(balanceCapped.stakePerLeg).toBe(2);
        expect(balanceCapped.capBinding).toBe('max stake / balance');
    });

    it('keeps staking the broker minimum rather than stranding a residual debt', () => {
        const dust = sizePairRecovery({ debt: 0.22, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1, availableBalance: 1000 });
        expect(dust.stakePerLeg).toBe(0.35);
        expect(dust.floorBinding).toBe(true);
        expect(dust.capBinding).toBe('broker minimum stake');
        // Two minimum stakes must still be affordable, or the refusal is real.
        expect(sizePairRecovery({ debt: 0.22, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1, availableBalance: 0.5 })).toBeNull();
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

    it('does not trigger recovery for a negative split, but never disarms an outstanding debt', () => {
        const result = applyPairSettlement(
            { sessionProfit: 0, debt: 1.2, recoveryStep: 2, doubleLossRun: 1, recoveryArmed: true },
            [{ outcome: 'won', stake: 0.5, profit: 0.2 }, { outcome: 'lost', stake: 0.5, profit: -0.4 }],
            { markupPercent: 10 },
        );
        expect(result.netProfit).toBe(-0.2);
        expect(result.split).toBe(true);
        expect(result.state.debt).toBe(1.2);
        // Re-arm fix: a split adds no debt and never raises the step, but recovery
        // is a property of the DEBT. Disarming here used to strand the residual,
        // because the cycle gates on `recoveryArmed && debt > 0`.
        expect(result.state.recoveryArmed).toBe(true);
        expect(result.state.recoveryStep).toBe(2);
        expect(result.state.doubleLossRun).toBe(0);
        expect(result.state.recoveryTarget).toBe(1.32);
        expect(result.state.sessionProfit).toBe(-0.2);
    });

    it('keeps recovery armed while a positive settlement only partly repays the debt', () => {
        const partial = applyPairSettlement(
            { sessionProfit: -1, debt: 2, recoveryStep: 1, doubleLossRun: 0, recoveryArmed: true },
            [{ outcome: 'won', stake: 1.96, profit: 2.37 }, { outcome: 'lost', stake: 1.96, profit: -1.96 }],
            { markupPercent: 40 },
        );
        expect(partial.netProfit).toBeCloseTo(0.41, 10);
        expect(partial.state.debt).toBeCloseTo(1.59, 10);
        expect(partial.state.recoveryArmed).toBe(true);
        expect(partial.state.recoveryStep).toBe(1);
        expect(partial.state.recoveryTarget).toBeCloseTo(2.226, 10);
    });

    it('clears a $2.00 debt in six consecutive pair wins and only then disarms', () => {
        const markup = HEDGE_PAIR_ANALYSIS_LIMITS.recoveryMarkupPercent;
        let state = { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0, completedPairs: 0, recoveryArmed: false };
        state = applyPairSettlement(state, [
            { outcome: 'lost', stake: 1, profit: -1 }, { outcome: 'lost', stake: 1, profit: -1 },
        ], { markupPercent: markup }).state;
        expect(state.debt).toBe(2);

        const stakes = [];
        for (let pair = 0; pair < 10 && state.debt > 0; pair += 1) {
            const sized = sizePairRecovery({
                debt: state.debt, multiplierA: 2.43, multiplierB: 2.43, baseStake: 1,
                step: state.recoveryStep, markupPercent: markup, availableBalance: 1000,
            });
            expect(sized).not.toBeNull();
            stakes.push(sized.stakePerLeg);
            state = applyPairSettlement(state, [
                { outcome: 'won', stake: sized.stakePerLeg, profit: sized.stakePerLeg * 2.43 - sized.stakePerLeg },
                { outcome: 'lost', stake: sized.stakePerLeg, profit: -sized.stakePerLeg },
            ], { markupPercent: markup }).state;
            // Armed all the way down; only a zero debt disarms.
            if (state.debt > 0) expect(state.recoveryArmed).toBe(true);
        }
        // 1.96 → 1.14 → 0.66 → 0.38 → 0.35 → 0.35, then the debt is gone.
        expect(stakes).toEqual([1.96, 1.14, 0.66, 0.38, 0.35, 0.35]);
        expect(state.debt).toBe(0);
        expect(state.recoveryArmed).toBe(false);
        expect(state.recoveryStep).toBe(0);
        expect(state.recoveryTarget).toBe(0);
        expect(state.sessionProfit).toBeCloseTo(0.0812, 4);
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

    it('only applies positive realized aggregate P&L to existing debt, and keeps working the rest', () => {
        const result = applyPairSettlement(
            { sessionProfit: -1, debt: 2, recoveryStep: 1, doubleLossRun: 0, recoveryArmed: true },
            [{ outcome: 'won', stake: 0.5, profit: 0.8 }, { outcome: 'won', stake: 0.5, profit: 0.7 }],
            { markupPercent: 10 },
        );
        expect(result.bothWon).toBe(true);
        expect(result.netProfit).toBe(1.5);
        expect(result.state.debt).toBe(0.5);
        expect(result.state.recoveryArmed).toBe(true);
        expect(result.state.recoveryStep).toBe(1);

        const cleared = applyPairSettlement(result.state,
            [{ outcome: 'won', stake: 0.5, profit: 0.4 }, { outcome: 'won', stake: 0.5, profit: 0.3 }],
            { markupPercent: 10 });
        expect(cleared.state.debt).toBe(0);
        expect(cleared.state.recoveryArmed).toBe(false);
        expect(cleared.state.recoveryStep).toBe(0);
        expect(cleared.state.recoveryTarget).toBe(0);
    });

    it("defaults the settlement markup to this bot's own recovery markup", () => {
        const result = applyPairSettlement(
            { sessionProfit: 0, debt: 0, recoveryStep: 0, doubleLossRun: 0, recoveryArmed: false },
            [{ outcome: 'lost', stake: 1, profit: -1 }, { outcome: 'lost', stake: 1, profit: -1 }],
        );
        expect(result.state.debt).toBe(2);
        expect(result.state.recoveryTarget).toBeCloseTo(2.8, 10);
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

describe('Hedge Pair Forge deep-history sample arithmetic', () => {
    const flatTape = (count, firstEpoch = 1000) => ({
        prices: Array.from({ length: count }, () => 100),
        epochs: Array.from({ length: count }, (_, index) => firstEpoch + index),
    });

    it('estimates the tick span of a time-denominated event from observed epochs', () => {
        const { prices, epochs } = flatTape(200);
        expect(estimateEventSpan(prices, epochs, 1, 0)).toBe(1);
        expect(estimateEventSpan(prices, epochs, 1, 60)).toBe(60);
        // A 2 Hz tape needs two ticks to cover one second.
        const halfSecond = Array.from({ length: 200 }, (_, index) => 1000 + index * 0.5);
        expect(estimateEventSpan(prices, halfSecond, 1, 60)).toBe(120);
        expect(estimateEventSpan(prices, epochs, 5, 0)).toBe(5);
    });

    it('names the arithmetic when a 1 000-tick ring cannot measure a minute-duration pair', () => {
        const { prices, epochs } = flatTape(1000);
        const result = analyseHedgePairTape({
            family: 'ENDS_BETWEEN_OUTSIDE', prices, epochs, duration: 1, durationSeconds: 60,
            upperOffset: 1, lowerOffset: 1, multiplierA: 1.98, multiplierB: 1.98, minSamples: 80,
        });
        expect(result.spanTicks).toBe(60);
        expect(result.samplesReachable).toBe(16);
        expect(result.samplesRequired).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor);
        expect(result.configuredMinSamples).toBe(80);
        expect(result.lowConfidence).toBe(true);
        expect(result.eligible).toBe(false);
        expect(result.hardBlockers.join(' ')).toMatch(/16\/20/);
        expect(result.hardBlockers.join(' ')).toMatch(/at most 16/);
        expect(result.hardBlockers.join(' ')).toMatch(/configured floor 80/);
    });

    it('makes the same family measurable on Deriv\'s 4 999-tick deep history', () => {
        const { prices, epochs } = flatTape(HEDGE_PAIR_ANALYSIS_LIMITS.deepHistoryCount);
        expect(HEDGE_PAIR_ANALYSIS_LIMITS.deepHistoryCount).toBe(4999);
        const result = analyseHedgePairTape({
            family: 'ENDS_BETWEEN_OUTSIDE', prices, epochs, duration: 1, durationSeconds: 60,
            upperOffset: 1, lowerOffset: 1, multiplierA: 1.98, multiplierB: 1.98, minSamples: 80,
        });
        expect(result.samplesReachable).toBe(83);
        expect(result.samplesRequired).toBe(80);
        expect(result.samples).toBe(83);
        expect(result.lowConfidence).toBe(false);
        expect(result.stateCounts.onlyA).toBe(83);
        // The sample gate is gone. What is left is the honest payout statement:
        // at 1.98× on both legs a pair that always splits still loses 1% of every
        // two premiums, so the soft EV gate holds and says exactly that.
        expect(result.hardBlockers).toHaveLength(0);
        expect(result.softBlockers.join(' ')).toMatch(/below the 0.00% hurdle/);
    });

    it('never accepts fewer than the hard sample floor, whatever minSamples says', () => {
        const { prices, epochs } = flatTape(60);
        const result = analyseHedgePairTape({
            family: 'STAYS_BETWEEN_OUTSIDE', prices, epochs, duration: 1, durationSeconds: 300,
            upperOffset: 1, lowerOffset: 1, multiplierA: 1.98, multiplierB: 1.98, minSamples: 1,
        });
        expect(result.configuredMinSamples).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor);
        expect(result.samplesRequired).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor);
        expect(result.eligible).toBe(false);
    });
});

describe('Hedge Pair Forge hard and soft entry gates', () => {
    const risingTape = count => ({
        prices: Array.from({ length: count }, (_, index) => 100 + index * 0.01),
        epochs: Array.from({ length: count }, (_, index) => 1000 + index),
    });

    it('treats a negative measured joint EV as a soft blocker against a break-even hurdle', () => {
        const { prices, epochs } = risingTape(500);
        const losing = analyseHedgePairTape({
            family: 'HIGHER_LOWER', prices, epochs, duration: 1,
            upperOffset: 0.005, lowerOffset: 0.005, multiplierA: 1.5, multiplierB: 1.5, minSamples: 80,
        });
        expect(losing.edgeHurdle).toBe(0);
        expect(losing.breakEven).toBe(0);
        expect(losing.expectedEdge).toBeLessThan(0);
        expect(losing.softBlockers).toHaveLength(1);
        expect(losing.softBlockers[0]).toMatch(/below the 0.00% hurdle/);
        expect(losing.softBlockers[0]).toMatch(/95% LCB/);
        expect(losing.hardBlockers.join(' ')).not.toMatch(/complete paired samples/);
        expect(losing.eligible).toBe(false);

        // Same tape, same pair, payouts that actually clear break-even.
        const winning = analyseHedgePairTape({
            family: 'HIGHER_LOWER', prices, epochs, duration: 1,
            upperOffset: 0.005, lowerOffset: 0.005, multiplierA: 5, multiplierB: 5, minSamples: 80,
        });
        expect(winning.expectedEdge).toBeGreaterThan(0);
        expect(winning.softBlockers).toHaveLength(0);
    });

    it('honours a configured edge hurdle above break-even', () => {
        const { prices, epochs } = risingTape(500);
        const result = analyseHedgePairTape({
            family: 'HIGHER_LOWER', prices, epochs, duration: 1,
            upperOffset: 0.005, lowerOffset: 0.005, multiplierA: 2.2, multiplierB: 2.2,
            minSamples: 80, requiredEdge: 0.5,
        });
        expect(result.edgeHurdle).toBe(0.5);
        expect(result.expectedEdge).toBeGreaterThan(0);
        expect(result.hardBlockers).toHaveLength(0);
        expect(result.softBlockers.join(' ')).toMatch(/50.00% hurdle/);
    });

    it('hard-blocks a tape in which every replayed pair lost both legs', () => {
        const prices = Array.from({ length: 400 }, () => 100);
        const result = analyseHedgePairTape({
            family: 'ONLY_UPS_DOWNS', prices, duration: 1,
            multiplierA: 9, multiplierB: 9, minSamples: 80,
        });
        expect(result.samples).toBeGreaterThan(80);
        expect(result.stateCounts.bothLose).toBe(result.samples);
        expect(result.hardBlockers.join(' ')).toMatch(/no measurable repayment path/);
        expect(result.eligible).toBe(false);
    });

    it('exposes the joint state counts the journal prints', () => {
        const { prices, epochs } = risingTape(300);
        const result = analyseHedgePairTape({
            family: 'HIGHER_LOWER', prices, epochs, duration: 1,
            upperOffset: 0.005, lowerOffset: 0.005, multiplierA: 2.2, multiplierB: 2.2, minSamples: 20,
        });
        expect(result.stateCounts.onlyA).toBe(result.samples);
        expect(result.stateCounts.bothWin).toBe(0);
        expect(result.stateCounts.onlyB).toBe(0);
        expect(result.stateCounts.bothLose).toBe(0);
        expect(typeof result.timingScore).toBe('number');
        expect(typeof result.timingReason).toBe('string');
        expect(Array.isArray(result.hardBlockers)).toBe(true);
        expect(Array.isArray(result.softBlockers)).toBe(true);
    });
});

describe('Hedge Pair Forge market watch list and configuration', () => {
    it('normalizes a watch list: seed first, deduplicated, upper-cased, capped', () => {
        expect(normalizeWatchMarkets('R_50,R_100,r_25,R_50', 'R_50')).toEqual(['R_50', 'R_100', 'R_25']);
        expect(normalizeWatchMarkets('R_100,R_25', 'R_50')).toEqual(['R_50', 'R_100', 'R_25']);
        expect(normalizeWatchMarkets('', 'R_50')).toEqual(['R_50']);
        expect(normalizeWatchMarkets(['R_10', 'R_10'], 'R_10')).toEqual(['R_10']);
        expect(normalizeWatchMarkets('bad symbol,R_50,1HZ15V', 'R_50')).toEqual(['R_50', '1HZ15V']);
        const many = Array.from({ length: 30 }, (_, index) => `R_${index + 1}`).join(',');
        const capped = normalizeWatchMarkets(many, 'R_50');
        expect(capped).toHaveLength(HEDGE_PAIR_ANALYSIS_LIMITS.maxWatchMarkets);
        expect(capped[0]).toBe('R_50');
    });

    it('defaults a single-market watch list to the bot\'s own symbol', () => {
        const pair = { family: 'HIGHER_LOWER', symbol: 'R_50', upperOffset: 0.5, lowerOffset: 0.5 };
        expect(normalizePairConfig(pair).watchMarkets).toEqual(['R_50']);
        expect(normalizePairConfig({ ...pair, watchMarkets: 'R_100,R_25' }).watchMarkets).toEqual(['R_50', 'R_100', 'R_25']);
        expect(normalizePairConfig({ ...pair, watchMarkets: 'R_100,R_25,R_50' }).watchMarkets).toEqual(['R_50', 'R_100', 'R_25']);
    });

    it("defaults this bot's recovery numbers and clamps the analysis window to the deep tape", () => {
        const config = normalizePairConfig({ family: 'DIGIT_OVERUNDER', symbol: 'R_50' });
        expect(config.recoveryMultiplier).toBe(2.43);
        expect(config.markupPercent).toBe(40);
        expect(config.requiredEdge).toBe(0);
        expect(config.forceEntryAfter).toBe(0);
        expect(config.analysisWindow).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.deepHistoryCount);
        expect(normalizePairConfig({ family: 'DIGIT_OVERUNDER', analysisWindow: 99999 }).analysisWindow).toBe(5000);
        expect(normalizePairConfig({ family: 'DIGIT_OVERUNDER', minSamples: 1 }).minSamples).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.hardSampleFloor);
        expect(normalizePairConfig({ family: 'DIGIT_OVERUNDER', requiredEdge: 5 }).requiredEdge).toBe(0.5);
        expect(normalizePairConfig({ family: 'DIGIT_OVERUNDER', forceEntryAfter: 99999 }).forceEntryAfter).toBe(3600);
        expect(normalizePairConfig({ family: 'DIGIT_OVERUNDER', forceEntryAfter: -5 }).forceEntryAfter).toBe(0);
    });

    it('rejects a barrier offset no Blockly number field could have stored', () => {
        // The console defaults a price-barrier offset to one pip: 1e-4 on a
        // pipSize-4 index. The block's field used to round that to 0, the config
        // then threw, and five of the seven families held forever.
        expect(MIN_REPRESENTABLE_OFFSET).toBe(1e-8);
        expect(normalizePairConfig({ family: 'HIGHER_LOWER', upperOffset: 0.0001, lowerOffset: 0.0001 }).upperOffset).toBe(0.0001);
        expect(() => normalizePairConfig({ family: 'HIGHER_LOWER', upperOffset: 0, lowerOffset: 0.0001 })).toThrow(/offsets/);
        expect(() => normalizePairConfig({ family: 'HIGHER_LOWER', upperOffset: 1e-12, lowerOffset: 1e-12 })).toThrow(/offsets/);
    });
});

describe('Hedge Pair Forge market ranking and switch discipline', () => {
    const row = (symbol, bothWin, onlyA, onlyB, bothLose, timingScore, instability, hardBlockers = []) => ({
        symbol,
        samples: bothWin + onlyA + onlyB + bothLose,
        stateCounts: { bothWin, onlyA, onlyB, bothLose },
        timingScore,
        instability,
        configuredMinSamples: 80,
        hardBlockers,
        softBlockers: [],
    });
    // R_100 repays 82% of pairs, R_50 65%, R_25 is unmeasurable.
    const rows = [
        row('R_50', 0, 40, 25, 35, 60, 0.10),
        row('R_100', 2, 50, 30, 18, 70, 0.05),
        row('R_25', 0, 10, 8, 82, 40, 0.30, ['joint estimate unstable across windows']),
    ];
    const settled = { evaluationsOnCurrent: 999, evaluationsSinceSwitch: 999 };

    it('scores a market on repayment, stability, timing and sample confidence', () => {
        const evidence = pairEvidenceScore(rows[1]);
        expect(evidence.repaymentRate).toBeCloseTo(0.82, 10);
        expect(evidence.stability).toBeCloseTo(1 - 0.05 / HEDGE_PAIR_ANALYSIS_LIMITS.maxInstability, 10);
        expect(evidence.timing).toBeCloseTo(0.7, 10);
        expect(evidence.sampleConfidence).toBe(1);
        expect(evidence.score).toBeGreaterThan(pairEvidenceScore(rows[0]).score);
        expect(pairEvidenceScore({}).score).toBe(0);
    });

    it('ranks analysable markets above blocked ones and reports the winner', () => {
        const { best, ranked, decision } = rankHedgePairMarkets(rows, { currentSymbol: 'R_50', ...settled });
        expect(best.symbol).toBe('R_100');
        expect(ranked.map(item => item.symbol)).toEqual(['R_100', 'R_50', 'R_25']);
        expect(ranked[2].analysable).toBe(false);
        expect(decision.switch).toBe(true);
        expect(decision.reason).toMatch(/R_50 → R_100/);
        expect(decision.reason).toMatch(/repayment 82.0%/);
    });

    it('holds the incumbent unless the candidate clears the edge margin, dwell and cooldown', () => {
        const incumbent = rankHedgePairMarkets(rows, { currentSymbol: 'R_100', ...settled });
        expect(incumbent.decision.switch).toBe(false);
        expect(incumbent.decision.reason).toMatch(/holding R_100/);

        const tooSoon = rankHedgePairMarkets(rows, { currentSymbol: 'R_50', evaluationsOnCurrent: 10, evaluationsSinceSwitch: 999 });
        expect(tooSoon.decision.switch).toBe(false);
        expect(tooSoon.decision.reason).toMatch(/10\/60 evaluations/);

        const cooling = rankHedgePairMarkets(rows, { currentSymbol: 'R_50', evaluationsOnCurrent: 60, evaluationsSinceSwitch: 5 });
        expect(cooling.decision.switch).toBe(false);
        expect(cooling.decision.reason).toMatch(/cooldown is 5\/120/);

        const marginal = rankHedgePairMarkets(
            [row('R_50', 0, 40, 25, 35, 60, 0.10), row('R_100', 0, 41, 25, 34, 60, 0.10)],
            { currentSymbol: 'R_50', ...settled },
        );
        expect(marginal.decision.switch).toBe(false);
        expect(marginal.decision.reason).toMatch(/below the 1.00pt switch margin/);
    });

    it('doubles the switch margin while a recovery debt is being worked', () => {
        const normal = rankHedgePairMarkets(rows, { currentSymbol: 'R_50', ...settled });
        const recovery = rankHedgePairMarkets(rows, { currentSymbol: 'R_50', ...settled, isRecovery: true });
        expect(normal.decision.delta).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.switchEdgeDelta);
        expect(recovery.decision.delta).toBe(HEDGE_PAIR_ANALYSIS_LIMITS.switchEdgeDelta * 2);
    });

    it('never switches on a single market, and never into a market it cannot measure', () => {
        const single = rankHedgePairMarkets([rows[0]], { currentSymbol: 'R_50', ...settled });
        expect(single.decision.switch).toBe(false);
        expect(single.decision.reason).toMatch(/single market/);

        const blocked = rankHedgePairMarkets(
            [row('R_50', 0, 0, 0, 100, 10, 0.4, ['no measurable repayment path']), row('R_10', 0, 0, 0, 100, 10, 0.4, ['no measurable repayment path'])],
            { currentSymbol: 'R_50', ...settled },
        );
        expect(blocked.decision.switch).toBe(false);
        expect(blocked.decision.reason).toMatch(/no watched market can be measured/);

        expect(rankHedgePairMarkets([], { currentSymbol: 'R_50', ...settled }).best).toBeNull();
        expect(rankHedgePairMarkets(null, {}).decision.switch).toBe(false);
    });
});
