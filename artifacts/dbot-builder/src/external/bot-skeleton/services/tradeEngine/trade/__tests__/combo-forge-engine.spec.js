/**
 * Combo Forge runtime — the engine half. Drives the REAL `ntAnalyseCombo` /
 * `ntComboDecision` natives against a scripted ticks service and injects every
 * feed failure a live websocket can produce. The contract under test is the
 * one the user cares about when they press Run: the native NEVER throws, never
 * forces an entry on missing data, and in recovery sizes the stake with the
 * shared ladder formula for the payout of the contract it actually picked.
 */

import withTicks from '../Ticks';

class BaseEngine {
    constructor(scope) {
        this.$scope = scope;
        this.symbol = 'R_50';
        this.options = {};
        this.tradeOptions = { amount: 1, symbol: 'R_50' };
        this.data = { proposals: [] };
    }
    getPipSize() {
        return 2;
    }
    getBalance() {
        return 1000;
    }
}
const Engine = withTicks(BaseEngine);

/** Ticks whose last digit at pip 2 is controlled: quote = 1000 + index·0.01·dir, digit overwritten. */
function makeTicks({ n = 500, digitAt = () => 0, dir = 0.5, seed = 1 }) {
    let a = seed >>> 0;
    const rand = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ticks = [];
    let level = 1000;
    for (let i = 0; i < n; i++) {
        level += rand() < dir ? 0.1 : -0.1;
        const base = Math.floor(level * 10) / 10; // one decimal; last digit comes from digitAt
        ticks.push({ quote: Number((base + digitAt(i, rand) / 100).toFixed(2)), epoch: 1_700_000_000 + i });
    }
    return ticks;
}

const uniform = (i, rand) => Math.floor(rand() * 10);
const hotNines = (i, rand) => (rand() < 0.93 ? 9 : 0);

const service = (handlers) => ({
    pipSizes: { R_10: 2, R_25: 2, R_50: 2, R_75: 2 },
    request: jest.fn(({ symbol }) => {
        const h = handlers[symbol] ?? handlers.default;
        return typeof h === 'function' ? h(symbol) : Promise.resolve(h);
    }),
});

const engineFor = svc => new Engine({ ticksService: svc });
const CSV_NORMAL = 'DIGITOVER:1:1.23,DIGITUNDER:8:1.23,CALL:-1:1.92,PUT:-1:1.92';
const MARKETS = 'R_50,R_10,R_25,R_75';

describe('Combo Forge native: ntAnalyseCombo', () => {
    it('qualifies a proven edge on the right market and exposes every decision field the workspace reads', async () => {
        const svc = service({
            R_75: makeTicks({ digitAt: hotNines, seed: 3 }),
            default: makeTicks({ digitAt: uniform, seed: 9 }),
        });
        const engine = engineFor(svc);
        const eligible = await engine.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500);
        expect(eligible).toBe(true);
        expect(await engine.ntComboDecision('symbol')).toBe('R_75');
        expect(await engine.ntComboDecision('contract')).toBe('DIGITOVER');
        expect(await engine.ntComboDecision('barrier')).toBe(1);
        expect(await engine.ntComboDecision('eligible')).toBe(true);
        expect(await engine.ntComboDecision('changedMarket')).toBe(true);
        expect(await engine.ntComboDecision('forceable')).toBe(true);
        expect(await engine.ntComboDecision('payout')).toBe(1.23);
        expect(String(await engine.ntComboDecision('reason'))).toMatch(/^READY/);
        // Normal mode must never touch the stake.
        expect(engine.tradeOptions.amount).toBe(1);
    });

    it('HOLDs on a fair tape — a fair feed is never "eligible"', async () => {
        const engine = engineFor(service({ default: makeTicks({ digitAt: uniform, seed: 5 }) }));
        expect(await engine.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500)).toBe(false);
        expect(String(await engine.ntComboDecision('reason'))).toMatch(/^HOLD/);
    });

    it('survives ONE market whose feed rejects — the others still decide', async () => {
        const svc = service({
            R_10: () => Promise.reject(new Error('market closed')),
            R_25: () => Promise.reject(new Error('rate limit')),
            R_75: makeTicks({ digitAt: hotNines, seed: 3 }),
            default: makeTicks({ digitAt: uniform, seed: 9 }),
        });
        const engine = engineFor(svc);
        await expect(engine.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500)).resolves.toBe(true);
        expect(await engine.ntComboDecision('symbol')).toBe('R_75');
    });

    it('holds safely (forceable = false) when EVERY feed fails — no blind forced entry on missing data', async () => {
        const engine = engineFor(service({ default: () => Promise.reject(new Error('socket closed')) }));
        await expect(engine.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500)).resolves.toBe(false);
        expect(await engine.ntComboDecision('eligible')).toBe(false);
        expect(await engine.ntComboDecision('forceable')).toBe(false);
        expect(String(await engine.ntComboDecision('reason'))).toMatch(/feed unavailable/);
        // The same guarantee for recovery: a forced recovery entry needs a real ranked candidate.
        await expect(engine.ntAnalyseCombo('RECOVERY', MARKETS, 'DIGITEVEN:-1:1.95', 500, 'strict', 2, 10, 500)).resolves.toBe(false);
        expect(await engine.ntComboDecision('forceable')).toBe(false);
    });

    it('never throws on garbage: short history, NaN/undefined quotes, empty lists, missing ticks service', async () => {
        const junk = [
            { quote: NaN, epoch: 1 }, { quote: undefined, epoch: 2 }, { quote: 'abc', epoch: 3 }, null,
        ].concat(makeTicks({ n: 50 }));
        for (const feed of [[], makeTicks({ n: 5 }), junk, null, undefined]) {
            const engine = engineFor(service({ default: feed }));
            await expect(engine.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500)).resolves.toBe(false);
        }
        const noService = new Engine({});
        await expect(noService.ntAnalyseCombo('NORMAL', MARKETS, CSV_NORMAL, 500, 'strict', 0, 10, 500)).resolves.toBe(false);
        const engine = engineFor(service({ default: makeTicks({}) }));
        await expect(engine.ntAnalyseCombo('NORMAL', '', '', 500, 'nonsense', 'x', 'y', 'z')).resolves.toBe(false);
        await expect(engine.ntAnalyseCombo(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined)).resolves.toBe(false);
    });

    it('ignores a hostile or oversized configuration: caps markets at 8 and contracts at 12, clamps the window', async () => {
        const svc = service({ default: makeTicks({ digitAt: uniform, seed: 2 }) });
        const engine = engineFor(svc);
        const markets = Array.from({ length: 30 }, (_, i) => `M${i}`).join(',');
        const contracts = Array.from({ length: 40 }, (_, i) => `DIGITOVER:${i % 9}:1.5`).join(',');
        await engine.ntAnalyseCombo('NORMAL', markets, contracts, 1e9, 'strict', 0, 10, 500);
        expect(svc.request.mock.calls.length).toBeLessThanOrEqual(9); // 8 markets (+ the engine's own symbol)
    });

    it('RECOVERY sizes the stake with the shared ladder for the payout of the contract it PICKED', async () => {
        // Every leg hostile except Over 4 (92% nines): the ranker must pick Over 4 (payout 1.95).
        const svc = service({ default: makeTicks({ digitAt: hotNines, seed: 4 }) });
        const engine = engineFor(svc);
        const csv = 'DIGITEVEN:-1:1.95,DIGITOVER:4:1.95,DIGITUNDER:2:4.9';
        await engine.ntAnalyseCombo('RECOVERY', 'R_50', csv, 500, 'strict', 2, 10, 500);
        expect(await engine.ntComboDecision('contract')).toBe('DIGITOVER');
        // ceil₂(2 × 1.1 / 0.95) = 2.32
        expect(engine.tradeOptions.amount).toBe(2.32);
    });

    it('RECOVERY stake honours the floor, the max-stake cap and the live balance', async () => {
        const feed = makeTicks({ digitAt: hotNines, seed: 4 });
        let engine = engineFor(service({ default: feed }));
        await engine.ntAnalyseCombo('RECOVERY', 'R_50', 'DIGITOVER:4:1.95', 500, 'strict', 0.01, 10, 500);
        expect(engine.tradeOptions.amount).toBe(0.35);

        engine = engineFor(service({ default: feed }));
        await engine.ntAnalyseCombo('RECOVERY', 'R_50', 'DIGITOVER:4:1.95', 500, 'strict', 5000, 10, 25);
        expect(engine.tradeOptions.amount).toBe(25);

        engine = engineFor(service({ default: feed }));
        engine.getBalance = () => 10;
        await engine.ntAnalyseCombo('RECOVERY', 'R_50', 'DIGITOVER:4:1.95', 500, 'strict', 100, 10, 500);
        expect(engine.tradeOptions.amount).toBeLessThanOrEqual(10);
        expect(engine.tradeOptions.amount).toBeGreaterThanOrEqual(0.35);
    });

    it('a failed RECOVERY analysis leaves the previous stake untouched', async () => {
        const engine = engineFor(service({ default: () => Promise.reject(new Error('down')) }));
        engine.tradeOptions.amount = 3.21;
        await engine.ntAnalyseCombo('RECOVERY', MARKETS, 'DIGITEVEN:-1:1.95', 500, 'strict', 2, 10, 500);
        expect(engine.tradeOptions.amount).toBe(3.21);
    });

    it('answers Rise/Fall decisions with barrier −1 (never a digit) and never NaN', async () => {
        const up = makeTicks({ digitAt: uniform, dir: 0.85, seed: 8 });
        const engine = engineFor(service({ default: up }));
        const eligible = await engine.ntAnalyseCombo('NORMAL', 'R_50', 'CALL:-1:1.92,PUT:-1:1.92', 500, 'strict', 0, 10, 500);
        expect(eligible).toBe(true);
        expect(await engine.ntComboDecision('contract')).toBe('CALL');
        expect(await engine.ntComboDecision('barrier')).toBe(-1);
        for (const field of ['score', 'evidence', 'threshold', 'margin', 'probability', 'payout', 'samples']) {
            expect(Number.isFinite(await engine.ntComboDecision(field))).toBe(true);
        }
    });

    it('ntComboDecision before any analysis is a safe default, not undefined', async () => {
        const engine = engineFor(service({}));
        expect(await engine.ntComboDecision('eligible')).toBe(0);
        expect(await engine.ntComboDecision('reason')).toMatch(/warming up/);
    });
});
