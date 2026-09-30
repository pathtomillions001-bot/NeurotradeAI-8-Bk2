/**
 * Omni Forge runtime gate — the engine half of "Over 0 / Under 9 took no trades".
 *
 * A normal-mode entry has to clear EV > 0 AND the Wilson lower bound within
 * 2.5pt of break-even. Over 0, Under 9 and Differs all price at ~1.09×
 * (break-even 91.7% against a 90% natural rate), so those bounds only ever
 * admit tapes with ≤ 8% losses. The loss-clustering penalty then divided the
 * add-one-smoothed P(loss|loss) — pure smoothing noise on a handful of
 * losses — by that tiny loss rate, so NO tape could ever qualify: the normal
 * gate was mathematically unsatisfiable for exactly the contracts a retail
 * user reaches for first ("Over 0 wins 90% of the time!").
 *
 * The guard in omni-forge-analysis.js treats clustering as unmeasurable
 * below 10 observed losses (neutral 1.0). These tests drive the REAL
 * `ntAnalyseContracts` against scripted digit tapes to pin both directions:
 * hot tapes now qualify, ordinary/dead tapes still hold, and a leg whose
 * losses CAN be measured still gets its clustering veto.
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
}

const TickEngine = withTicks(BaseEngine);

/** Ticks with a controlled last digit at pip 2: quote 1.0d → "1.0d". */
const tick = (digit, epoch) => ({ quote: 1 + digit / 100, epoch });

function fakeTicksService(digits) {
    return {
        pipSizes: { R_50: 2, R_75: 2 },
        request: jest.fn(() => Promise.resolve(digits.map((d, i) => tick(d, i + 1)))),
        monitor: jest.fn(() => Promise.resolve('key')),
        stopMonitor: jest.fn(() => Promise.resolve()),
    };
}

const newEngine = service => {
    const engine = new TickEngine({ ticksService: service });
    engine.store = { dispatch: jest.fn() };
    return engine;
};

/**
 * A tape of `n` digits = `win` except at explicit loss positions (which carry
 * `lose`). No positions given → `losses` slots spread as evenly as possible.
 */
function tape({ n = 120, losses = 0, win = 9, lose = 0, positions = null }) {
    const digits = Array.from({ length: n }, () => win);
    if (positions) {
        positions.forEach(p => {
            digits[p] = lose;
        });
        return digits;
    }
    for (let k = 0; k < losses; k++) digits[Math.floor(((k + 0.5) * n) / losses)] = lose;
    return digits;
}

const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

describe('Omni Forge normal-mode gate — the Over 0 / Under 9 dead zone', () => {
    it('qualifies Over 0 on a genuinely hot tape (previously impossible on ANY tape)', async () => {
        // 113/120 wins, 7 scattered zeros: EV +2.0%, LCB 90.1% > 89.2% floor.
        // Pre-guard the clustering penalty read 4–35× against every ≤ 8-loss
        // tape, so no tape in existence could fire this leg in normal mode.
        const engine = newEngine(fakeTicksService(tape({ n: 120, losses: 7, win: 9, lose: 0 })));
        const fired = await engine.ntAnalyseContracts('NORMAL', 'R_50', 'DIGITOVER:0:1.09', 120);
        expect(fired).toBe(true);
        const decision = engine.nt_contract_decision;
        expect(decision.contract).toBe('DIGITOVER');
        expect(decision.barrier).toBe(0);
        expect(decision.eligible).toBe(true);
        expect(decision.reason).toMatch(/^READY DIGITOVER 0/);
        expect(decision.clustering).toBe(1); // 7 losses — unmeasurable, neutral
        expect(decision.losses).toBe(7);
    });

    it('qualifies Under 9 on a hot tape too (the symmetric dead zone)', async () => {
        const engine = newEngine(fakeTicksService(tape({ n: 120, losses: 6, win: 0, lose: 9 })));
        const fired = await engine.ntAnalyseContracts('NORMAL', 'R_50', 'DIGITUNDER:9:1.09', 120);
        expect(fired).toBe(true);
        expect(engine.nt_contract_decision.barrier).toBe(9);
        expect(engine.nt_contract_decision.eligible).toBe(true);
    });

    it('still holds Over 0 on a fair 90% tape — EV is negative by design', async () => {
        // Natural rate exactly: 108/120 wins → EV −1.9% → nothing to trade.
        const engine = newEngine(fakeTicksService(tape({ n: 120, losses: 12, win: 9, lose: 0 })));
        const fired = await engine.ntAnalyseContracts('NORMAL', 'R_50', 'DIGITOVER:0:1.09', 120);
        expect(fired).toBe(false);
        expect(engine.nt_contract_decision.reason).toMatch(/^HOLD: EV /);
    });

    it('holds every 1.09× leg on a dead uniform tape', async () => {
        const uniform = Array.from({ length: 120 }, (_, i) => i % 10);
        const engine = newEngine(fakeTicksService(uniform));
        const fired = await engine.ntAnalyseContracts(
            'NORMAL',
            'R_50',
            'DIGITOVER:0:1.09,DIGITUNDER:9:1.09,DIGITDIFF:-1:1.09',
            120
        );
        expect(fired).toBe(false);
        expect(engine.nt_contract_decision.eligible).toBe(false);
    });

    it('fires Over 0 in RECOVERY from the looser gate once the fresh-tick confirmation completes', async () => {
        // 110/120 wins: below the normal EV floor but inside recovery's
        // EV ≥ −1% / LCB ≥ BE−5pt bounds, with exactly 10 measurable losses.
        // The post-trade rescan mandate adds ONE difference vs the old
        // behaviour: the gate-pass is confirmed on a fresh tick before fire.
        const digits = tape({ n: 120, losses: 10, win: 9, lose: 0 });
        const engine = newEngine(fakeTicksService(digits));
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_50', 'DIGITOVER:0:1.09', 120)).toBe(false);
        expect(engine.nt_contract_decision.reason).toContain('confirming recovery setup 1/2');

        digits.push(9);
        const fired = await engine.ntAnalyseContracts('RECOVERY', 'R_50', 'DIGITOVER:0:1.09', 120);
        expect(fired).toBe(true);
        expect(engine.nt_contract_decision.eligible).toBe(true);
    });

    it('keeps the clustering veto for legs whose loss count CAN be measured', async () => {
        // Over 1 (1.23×, fair 80%): 102/120 wins clears EV (+3.7%) and the
        // Wilson floor (79.6% > 78.8%), with 18 losses — plenty to measure.
        // Two packed runs of 9, one per half: instability 0, so ONLY the
        // clustering penalty can hold this tape.
        const bunched = tape({ n: 120, win: 5, lose: 1, positions: [...range(4, 9), ...range(64, 9)] });
        const heldEngine = newEngine(fakeTicksService(bunched));
        expect(await heldEngine.ntAnalyseContracts('NORMAL', 'R_50', 'DIGITOVER:1:1.23', 120)).toBe(false);
        expect(heldEngine.nt_contract_decision.reason).toMatch(/clustering/);
        expect(heldEngine.nt_contract_decision.reason).not.toMatch(/unstable/);

        // The same 18 losses evenly scattered → the tape is tradeable.
        const scattered = tape({ n: 120, losses: 18, win: 5, lose: 1 });
        const fired = await newEngine(fakeTicksService(scattered)).ntAnalyseContracts(
            'NORMAL',
            'R_50',
            'DIGITOVER:1:1.23',
            120
        );
        expect(fired).toBe(true);
    });

    it('does not invent clustering from an unmeasurable burst on a hot Over 0 tape', async () => {
        // Six zeros arrive as ONE burst — without the guard this read 11.7×
        // and vetoed a tape that is hot by every measurable bound. Guarded:
        // EV and Wilson govern; one base-stake entry carries no ladder risk.
        const centred = tape({ n: 120, win: 9, lose: 0, positions: range(57, 6) });
        const fired = await newEngine(fakeTicksService(centred)).ntAnalyseContracts(
            'NORMAL',
            'R_50',
            'DIGITOVER:0:1.09',
            120
        );
        expect(fired).toBe(true);
    });
});

describe('Omni Forge gate — sample floor', () => {
    it('never fires a normal entry below 30 samples', async () => {
        const engine = newEngine(fakeTicksService(tape({ n: 20, losses: 0, win: 9, lose: 0 })));
        const fired = await engine.ntAnalyseContracts('NORMAL', 'R_50', 'DIGITOVER:0:1.09', 20);
        expect(fired).toBe(false);
        expect(engine.nt_contract_decision.reason).toMatch(/samples 20\/30/);
    });
});
