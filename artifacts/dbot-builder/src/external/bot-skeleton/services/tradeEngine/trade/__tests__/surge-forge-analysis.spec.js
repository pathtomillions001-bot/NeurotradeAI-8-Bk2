import { analyseSurgeMarket, SURGE_FORGE_LIMITS } from '../surge-forge-analysis';

const pricesFromSteps = steps => {
    const prices = [100];
    for (const step of steps) prices.push(prices[prices.length - 1] + step);
    return prices;
};

// Deterministic PRNG so regime gates are tested against reproducible noise.
const mulberry32 = seed => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

describe('Vector Surge DBot PULSE v2 — regime gate, evidence and speed', () => {
    it('refuses BOTH sides on a statistically random tape (the loss-stopper)', () => {
        const rnd = mulberry32(42);
        const steps = Array.from({ length: 300 }, () => (rnd() < 0.5 ? 1 : -1));
        const result = analyseSurgeMarket({ prices: pricesFromSteps(steps), payout: 1.92, mode: 'NORMAL' });
        expect(result.regime).toBe('RANDOM');
        expect(result.eligible).toBe(false);
        expect(result.alternatives.every(side => !side.eligible)).toBe(true);
        expect(result.reason).toMatch(/random tape/);
    });

    it('classifies persistent runs as TRENDING and fires with measured evidence', () => {
        const trending = pricesFromSteps(Array.from({ length: 30 }, () => [1, 1, 1, 1, -1, -1]).flat());
        const result = analyseSurgeMarket({ prices: trending, payout: 1.92, mode: 'NORMAL' });
        expect(result.regime).toBe('TRENDING');
        expect(result.contract).toBe('CALL');
        expect(result.eligible).toBe(true);
        expect(result.evidence).toBeGreaterThanOrEqual(SURGE_FORGE_LIMITS.evidenceBoundary);
        expect(result.edgeProb).toBeGreaterThanOrEqual(0.8);
        expect(result.lowerBound).toBeGreaterThan(result.breakEven);
        expect(result.zPersist).toBeGreaterThanOrEqual(1.282);
    });

    it('reads a perfectly alternating tape as REVERSAL and takes the fade side', () => {
        // [up, down]×60 ends on a down tick; the next tick rose on every one
        // of the 59 previous down ticks, so Rise is the fade trade.
        const alternating = pricesFromSteps(Array.from({ length: 60 }, () => [1, -1]).flat());
        const result = analyseSurgeMarket({ prices: alternating, payout: 1.92, mode: 'NORMAL' });
        expect(result.regime).toBe('REVERSAL');
        expect(result.contract).toBe('CALL');
        expect(result.eligible).toBe(true);
        expect(result.probability).toBeGreaterThan(0.7);
        expect(result.zPersist).toBeLessThanOrEqual(-1.282);
    });

    it('never trusts a one-sided tape that offers no counter-evidence', () => {
        const oneSided = pricesFromSteps(Array.from({ length: 80 }, () => [1]).flat());
        const result = analyseSurgeMarket({ prices: oneSided, payout: 1.92, mode: 'NORMAL' });
        expect(result.eligible).toBe(false);
        expect(result.reason).toMatch(/one-sided tape/);
    });

    it('recovery fires at the relaxed evidence bar on a clean structured tape', () => {
        const trending = pricesFromSteps(Array.from({ length: 30 }, () => [1, 1, 1, 1, -1, -1]).flat());
        const normal = analyseSurgeMarket({ prices: trending, payout: 1.92, mode: 'NORMAL' });
        const recovery = analyseSurgeMarket({ prices: trending, payout: 1.92, mode: 'RECOVERY' });
        expect(normal.eligible).toBe(true);
        expect(recovery.eligible).toBe(true);
        expect(recovery.reason).toMatch(/^READY/);
    });

    it('keeps evidence below the boundary while the structure is still thin', () => {
        // 15 cycles (90 ticks) of the same run pattern carry LESS conditional
        // evidence than 30 cycles — the sequential test must hold its fire.
        const thin = pricesFromSteps(Array.from({ length: 15 }, () => [1, 1, 1, 1, -1, -1]).flat());
        const result = analyseSurgeMarket({ prices: thin, payout: 1.92, mode: 'NORMAL' });
        expect(result.regime).toBe('TRENDING');
        expect(result.eligible).toBe(false);
        expect(result.evidence).toBeLessThan(SURGE_FORGE_LIMITS.evidenceBoundary);
        expect(result.reason).toMatch(/evidence/);
    });

    it('analyses a full 500-tick multi-market workload fast enough for every tick', () => {
        const rnd = mulberry32(7);
        const tapes = Array.from({ length: 8 }, () =>
            pricesFromSteps(Array.from({ length: 500 }, () => (rnd() < 0.55 ? 1 : -1) * (1 + rnd())))
        );
        const started = Date.now();
        for (let pass = 0; pass < 20; pass++) {
            for (const prices of tapes) {
                analyseSurgeMarket({ prices, payout: 1.92, mode: 'NORMAL' });
            }
        }
        // 160 full analyses of 500-tick tapes — one per market per tick for a
        // 20-tick burst. Must stay far under a tick interval on CI hardware.
        expect(Date.now() - started).toBeLessThan(2000);
    });
});
