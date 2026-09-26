import { settleDigit45Pair, sizeDigit45Pair } from '../digit45-pair-math';

const risk = {
    mode: 'normal', baseStake: 1, debt: 0, markupPercent: 10,
    maxStake: 20, balance: 100, stopLoss: 30, sessionProfit: 0,
    payoutOver: 1.95, payoutUnder: 1.95,
};

describe('Digit 4/5 pair-level recovery (never sizes one leg in isolation)', () => {
    it('opens two $1 normal legs and records BOTH stakes when BOTH contracts lose', () => {
        expect(sizeDigit45Pair(risk)).toMatchObject({ stake: 1, pairExposure: 2 });
        expect(settleDigit45Pair([
            { buyPrice: 1, sellPrice: 0 }, { buyPrice: 1, sellPrice: 0 },
        ], 'normal')).toMatchObject({ profit: -2, stake: 2, bothLost: true, partial: false });
    });

    it('sizes recovery with payout - 2 (not payout - 1), then clears the full $2 debt', () => {
        const recovery = sizeDigit45Pair({ ...risk, mode: 'recovery', debt: 2,
            payoutOver: 2.43, payoutUnder: 2.43 });
        expect(recovery).toMatchObject({ stake: 5.12, pairExposure: 10.24, canClearDebtOnOneWin: true });
        const result = settleDigit45Pair([
            { buyPrice: 5.12, sellPrice: 12.44 }, // one winner: return includes its original stake
            { buyPrice: 5.12, sellPrice: 0 },
        ], 'recovery');
        expect(result.profit).toBe(2.2); // $2 debt plus 10% markup, AFTER paying the other leg
        expect(result.bothLost).toBe(false);
    });

    it('adds both losing recovery legs to existing debt if the settlement digit is 4 or 5', () => {
        const result = settleDigit45Pair([
            { buyPrice: 5.12, sellPrice: 0 }, { buyPrice: 5.12, sellPrice: 0 },
        ], 'recovery');
        expect(result).toMatchObject({ profit: -10.24, bothLost: true });
        expect(2 - result.profit).toBe(12.24);
    });

    it('recovers a small negative net even if one normal leg won', () => {
        const result = settleDigit45Pair([
            { buyPrice: 1, sellPrice: 1.95 }, { buyPrice: 1, sellPrice: 0 },
        ], 'normal');
        expect(result).toMatchObject({ profit: -0.05, bothLost: false });
        expect(sizeDigit45Pair({ ...risk, mode: 'recovery', debt: 0.05,
            payoutOver: 2.43, payoutUnder: 2.43 }).stake).toBe(0.35);
    });

    it('marks a single accepted leg as partial and never treats its result as a full pair', () => {
        expect(settleDigit45Pair([{ buyPrice: 1, sellPrice: 0 }], 'normal')).toMatchObject({
            profit: -1, partial: true, bothLost: false,
        });
        for (const invalid of [null, undefined, '', -1, Number.NaN]) {
            expect(() => settleDigit45Pair([{ buyPrice: 1, sellPrice: invalid }], 'normal'))
                .toThrow(/unsettled paired trade/);
        }
    });

    it('uses the worse side payout and caps BOTH recovery legs against balance, max stake and full-pair SL', () => {
        const base = { ...risk, mode: 'recovery', debt: 2, payoutOver: 2.43, payoutUnder: 2.2 };
        expect(sizeDigit45Pair(base).stake).toBe(11);
        expect(sizeDigit45Pair({ ...base, maxStake: 6 })).toMatchObject({ stake: 6, canClearDebtOnOneWin: false });
        expect(sizeDigit45Pair({ ...base, balance: 10 })).toMatchObject({ stake: 5, pairExposure: 10 });
        expect(() => sizeDigit45Pair({ ...base, stopLoss: 10, sessionProfit: -2 })).toThrow(/full two-leg exposure/);
        expect(() => sizeDigit45Pair({ ...base, balance: 0.5 })).toThrow(/TWO minimum/);
        expect(() => sizeDigit45Pair({ ...base, payoutOver: 1.99 })).toThrow(/more than TWO stakes/);
        expect(() => sizeDigit45Pair({ ...base, debt: NaN })).toThrow(/Invalid paired-trade/);
    });
});
