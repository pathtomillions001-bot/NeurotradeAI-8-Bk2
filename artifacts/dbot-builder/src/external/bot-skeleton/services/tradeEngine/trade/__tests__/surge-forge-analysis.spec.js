import { analyseSurgeMarket, SURGE_FORGE_LIMITS } from '../surge-forge-analysis';

const pricesFromSteps = steps => {
    const prices = [100];
    for (const step of steps) prices.push(prices[prices.length - 1] + step);
    return prices;
};

const STABLE_RISE = pricesFromSteps(Array.from({ length: 80 }, () => [1, 1, 1, -0.35]).flat());

describe('Vector Surge DBot multi-lens analysis', () => {
    it('selects Rise on a stable positive regime with positive payout utility', () => {
        const result = analyseSurgeMarket({ prices: STABLE_RISE, payout: 1.92, mode: 'NORMAL' });
        expect(result.contract).toBe('CALL');
        expect(result.eligible).toBe(true);
        expect(result.probability).toBeGreaterThan(result.breakEven);
        expect(result.utility).toBeGreaterThan(0);
        expect(result.samples).toBeGreaterThanOrEqual(SURGE_FORGE_LIMITS.minSamples);
    });

    it('vetoes a sharp regime reversal even when stale history points upward', () => {
        const reversal = pricesFromSteps([
            ...Array.from({ length: 60 }, () => [1, 1, 1, -0.3]).flat(),
            ...Array.from({ length: 12 }, () => [-1, -1, 0.2]).flat(),
        ]);
        const result = analyseSurgeMarket({ prices: reversal, payout: 1.92, mode: 'RECOVERY' });
        expect(result.eligible).toBe(false);
        expect(result.alternatives.every(side => !side.eligible)).toBe(true);
    });

    it('fails closed on flat or malformed price tapes without throwing', () => {
        const flat = analyseSurgeMarket({ prices: Array.from({ length: 200 }, () => 100), payout: 1.92, mode: 'RECOVERY' });
        expect(flat.eligible).toBe(false);
        expect(flat.reason).toMatch(/^HOLD/);
        const malformed = analyseSurgeMarket({ prices: [null, -1, 'x'], payout: Number.NaN, mode: 'NORMAL' });
        expect(malformed.eligible).toBe(false);
        expect(Number.isFinite(malformed.score)).toBe(true);
    });

    it('recovery rejects dangerous loss continuation even if another lens is optimistic', () => {
        const clustered = pricesFromSteps(Array.from({ length: 70 }, () => [1, -1, -1, -1]).flat());
        const result = analyseSurgeMarket({ prices: clustered, payout: 2.2, mode: 'RECOVERY' });
        const rise = result.alternatives.find(side => side.contract === 'CALL');
        expect(rise.qLL).toBeGreaterThan(0.58);
        expect(rise.eligible).toBe(false);
    });
});
