/**
 * Nexus Hedge Forge — post-trade rescan guarantees.
 *
 * THE BUG THESE TESTS GUARD
 * ─────────────────────────
 *   The hedge ranker used to fire debt-sized recovery entries off the FIRST
 *   flattering snapshot after a loss: no tick epochs were tracked, no
 *   fresh-tick confirmation existed, and one loss barely dents a 30+ sample
 *   posterior, so the same losing market kept ranking #1 — users watched the
 *   bot sit on ONE market for 8–10 consecutive losses even though it
 *   "analysed" before every trade.
 *
 * THE CONTRACT
 * ────────────
 *   1. A recovery entry must persist as the best candidate across TWO distinct
 *      fresh ticks (repeated interpreter passes over one tick do not count).
 *   2. Every settled trade (win or loss) clears the confirmation, so the next
 *      recovery always waits for a genuinely fresh post-trade rescan.
 *   3. Every settled LOSS arms the rematch penalty: the exact losing tuple
 *      starts its next scans from a decaying score deficit, so an alternate
 *      market/contract with a comparable edge wins the rescan instead.
 *   4. Normal-mode entries stay single-shot — the strict normal gate already
 *      earns those on one scan.
 */
import withTicks from '../Ticks';
import withPurchase from '../Purchase';
import withTotal from '../Total';
import { NEXUS_HEDGE_LIMITS, analyseNexusHedgeCandidate } from '../nexus-hedge-analysis';
import { BEFORE_PURCHASE, DURING_PURCHASE, PURCHASE_SUCCESSFUL } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));

const HOT = 5; // a digit that wins Over 1 (d > 1)
const COLD = 0; // a digit that loses Over 1

/** A tape: `digits[i]` stamped at epoch startEpoch + i. */
const makeTape = (digits, startEpoch = 1) =>
    digits.map((digit, index) => ({ epoch: startEpoch + index, quote: 100 + digit / 100 }));

const hotDigits = (n = 60) => Array.from({ length: n }, () => HOT);
const coldDigits = (n = 60) => Array.from({ length: n }, () => COLD);

class BaseEngine {
    constructor() {
        this.symbol = 'R_50';
        this.options = { symbol: 'R_50' };
        this.tradeOptions = {
            symbol: 'R_50',
            amount: 1,
            prediction: 1,
            currency: 'USD',
            basis: 'stake',
            duration: 1,
            duration_unit: 't',
        };
        this.data = { proposals: [], contract: {} };
        this.accountInfo = { loginid: 'VRTC12345' };
        this.scope = BEFORE_PURCHASE;
        this.balance = 1000;
        this.tapes = { R_50: makeTape(hotDigits()) };
        const getState = () => ({ scope: this.scope, proposalsReady: true });
        const dispatch = action => {
            if (typeof action === 'function') return action(dispatch, getState);
            if (action.type === PURCHASE_SUCCESSFUL) this.scope = DURING_PURCHASE;
            return action;
        };
        this.store = { getState, dispatch };
        this.$scope = {
            ticksService: {
                pipSizes: { R_50: 2, R_100: 2 },
                monitor: jest.fn(async ({ symbol }) => `${symbol}-key`),
                stopMonitor: jest.fn(async () => {}),
                request: jest.fn(async ({ symbol }) => this.tapes[symbol] ?? []),
            },
        };
    }
    getBalance() {
        return this.balance;
    }
    getPipSize() {
        return 2;
    }
    updateAndReturnTotalRuns() {
        return 1;
    }
}

const Engine = withTicks(withPurchase(withTotal(BaseEngine)));
const CSV = 'DIGITOVER:1:1.23';
const LOSSER_KEY = 'R_50:DIGITOVER:1';

/** Settle a trade the way proposal_open_contract → updateTotals does. */
const settleLoss = engine => {
    engine.nt_hedge_pending_entry = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 };
    engine.updateTotals({ sell_price: 0, buy_price: 0.5, currency: 'USD', underlying: 'R_50' });
};

describe('Nexus Hedge recovery rescan', () => {
    it('never fires a recovery on the first post-settlement scan, only after TWO distinct fresh ticks', async () => {
        const engine = new Engine();
        // Scan 1 — recovery gate qualifies, but no fresh confirmation yet.
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_hedge_decision.confirmations).toBe(1);
        expect(engine.nt_hedge_decision.eligible).toBe(false);
        expect(engine.nt_hedge_decision.reason).toContain('confirming recovery setup 1/2');

        // Scan 2 on the SAME snapshot (repeated interpreter pass) must NOT arm.
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_hedge_decision.confirmations).toBe(1);

        // A genuinely fresh tick completes the confirmation.
        engine.tapes.R_50 = [...engine.tapes.R_50, { epoch: 61, quote: 100.05 }];
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_50', CSV, 120)).toBe(true);
        expect(engine.nt_hedge_decision.confirmations).toBe(NEXUS_HEDGE_LIMITS.recoveryConfirmations);
        expect(engine.nt_hedge_decision.reason).toContain('READY');
    });

    it('settlement clears the confirmation, so a recovery NEVER fires without a fresh post-trade rescan', async () => {
        const engine = new Engine();
        await engine.ntAnalyseHedge('RECOVERY', 'R_50', CSV, 120);
        expect(engine.nt_hedge_confirmation).toBeDefined();

        settleLoss(engine);
        expect(engine.nt_hedge_confirmation).toBeUndefined();

        // First scan after the loss cannot fire — even though the tape is unchanged.
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_hedge_decision.confirmations).toBe(1);
    });

    it('a settled loss arms the rematch penalty against the exact losing tuple; a win clears it', () => {
        const engine = new Engine();
        settleLoss(engine);
        expect(engine.nt_hedge_rematch).toEqual({
            key: LOSSER_KEY,
            penalty: NEXUS_HEDGE_LIMITS.rematchPenalty,
            epoch: 0,
        });
        expect(engine.nt_hedge_pending_entry).toBeUndefined();

        const winner = new Engine();
        winner.nt_hedge_rematch = { key: LOSSER_KEY, penalty: NEXUS_HEDGE_LIMITS.rematchPenalty };
        winner.nt_hedge_pending_entry = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 };
        winner.updateTotals({ sell_price: 2, buy_price: 1, currency: 'USD', underlying: 'R_50' });
        expect(winner.nt_hedge_rematch).toBeUndefined();
        expect(winner.nt_hedge_pending_entry).toBeUndefined();
    });

    it('the rematch penalty demotes the loser — the rescan picks an alternate market with a comparable edge', async () => {
        const tied = () => makeTape(hotDigits());
        // Clean engine: identical tapes tie, stable order keeps the current market first.
        const clean = new Engine();
        clean.tapes = { R_50: tied(), R_100: tied() };
        await clean.ntAnalyseHedge('RECOVERY', 'R_100', CSV, 120);
        expect(clean.nt_hedge_decision.symbol).toBe('R_50');

        // After a loss ON R_50:DIGITOVER:1 the same rescan must prefer R_100.
        const engine = new Engine();
        engine.tapes = { R_50: tied(), R_100: tied() };
        settleLoss(engine);
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_100', CSV, 120)).toBe(false); // still confirming, never instant
        expect(engine.nt_hedge_decision.symbol).toBe('R_100');
        expect(engine.nt_hedge_decision.reason).toContain('post-loss rescan');
        // And the penalty decays toward the end of the confirmation window.
        expect(engine.nt_hedge_rematch.penalty).toBeCloseTo(
            NEXUS_HEDGE_LIMITS.rematchPenalty - NEXUS_HEDGE_LIMITS.rematchDecay
        );
    });

    it('the loser may re-enter only by topping every penalised fresh scan', async () => {
        const engine = new Engine();
        engine.tapes = { R_50: makeTape(hotDigits()), R_100: makeTape(coldDigits()) };
        settleLoss(engine);

        // R_50 is the ONLY eligible candidate, but scan 1 still cannot fire.
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_100', CSV, 120)).toBe(false);
        expect(engine.nt_hedge_decision.confirmations).toBe(1);

        // Fresh tick: penalty decayed, same best persists → confirmation 2.
        engine.tapes.R_50 = [...engine.tapes.R_50, { epoch: 61, quote: 100.05 }];
        engine.tapes.R_100 = [...engine.tapes.R_100, { epoch: 61, quote: 100 }];
        expect(await engine.ntAnalyseHedge('RECOVERY', 'R_100', CSV, 120)).toBe(true);

        // The rematch window is spent by the end of the confirmation window.
        await engine.ntAnalyseHedge('RECOVERY', 'R_100', CSV, 120);
        expect(engine.nt_hedge_rematch).toBeUndefined();
    });

    it('normal-mode entries stay single-shot — the strict normal gate earns them on one scan', async () => {
        const engine = new Engine();
        expect(await engine.ntAnalyseHedge('NORMAL', 'R_50', CSV, 120)).toBe(true);
        expect(engine.nt_hedge_decision.eligible).toBe(true);
    });

    it('records a pending entry at purchase so settlement can pair outcome → loser', () => {
        const engine = new Engine();
        api_base.api.send.mockResolvedValueOnce({ buy: { transaction_id: 1, contract_id: 2, buy_price: 1 } });
        engine.ntPurchaseHedge('DIGITOVER', 1);
        expect(engine.nt_hedge_pending_entry).toEqual({ symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 });
    });

    it('analyseNexusHedgeCandidate stays pure — no confirmation/rematch fields leak into the maths module', () => {
        const analysis = analyseNexusHedgeCandidate({
            wins: hotDigits(60).map(d => d > 1),
            p0: 0.8,
            payout: 1.23,
            mode: 'RECOVERY',
        });
        expect(analysis).not.toHaveProperty('confirmations');
        expect(analysis).not.toHaveProperty('tickEpoch');
    });
});
