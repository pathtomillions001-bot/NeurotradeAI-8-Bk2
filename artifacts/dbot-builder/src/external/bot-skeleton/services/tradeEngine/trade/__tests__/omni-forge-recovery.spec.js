/**
 * Omni Forge — post-trade rescan guarantees (Nexus Hedge rescan mandate parity).
 *
 * THE BUG THESE TESTS GUARD
 * ─────────────────────────
 *   Omni's recovery ranker used to fire debt-sized entries off the FIRST
 *   flattering snapshot after a loss: no tick epochs were tracked, no
 *   fresh-tick confirmation existed, and one loss barely dents a 30+ sample
 *   posterior, so the same losing market kept ranking #1 — the "locked into
 *   one market, 10 losses in a row" loop. Force-entry could even bypass the
 *   gate entirely.
 *
 * THE CONTRACT (identical to Nexus Hedge)
 * ───────────────────────────────────────
 *   1. A recovery entry must persist as the best candidate across TWO distinct
 *      fresh ticks (repeated interpreter passes over one tick do not count).
 *   2. Every settled trade (win or loss) clears the confirmation, so the next
 *      recovery always waits for a genuinely fresh post-trade rescan.
 *   3. Every settled LOSS arms the rematch penalty: the exact losing tuple
 *      starts its next scans from a decaying score deficit, so an alternate
 *      market/contract with a comparable edge wins the rescan.
 *   4. Normal-mode entries stay single-shot.
 */
import withTicks from '../Ticks';
import withPurchase from '../Purchase';
import withTotal from '../Total';
import { OMNI_FORGE_LIMITS } from '../omni-forge-analysis';
import { BEFORE_PURCHASE, DURING_PURCHASE, PURCHASE_SUCCESSFUL } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), info: jest.fn(), log: jest.fn() }));

const HOT = 5;
const COLD = 0;
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
const LOSER_KEY = 'R_50:DIGITOVER:1';

const settleLoss = engine => {
    engine.nt_omni_pending_entry = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 };
    engine.updateTotals({ sell_price: 0, buy_price: 0.5, currency: 'USD', underlying: 'R_50' });
};

describe('Omni Forge recovery rescan', () => {
    it('never fires a recovery on the first post-settlement scan, only after TWO distinct fresh ticks', async () => {
        const engine = new Engine();
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_contract_decision.confirmations).toBe(1);
        expect(engine.nt_contract_decision.eligible).toBe(false);
        expect(engine.nt_contract_decision.reason).toContain('confirming recovery setup 1/2');

        // Same snapshot (repeated interpreter pass) must NOT arm.
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_contract_decision.confirmations).toBe(1);

        // A genuinely fresh tick completes the confirmation.
        engine.tapes.R_50 = [...engine.tapes.R_50, { epoch: 61, quote: 100.05 }];
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_50', CSV, 120)).toBe(true);
        expect(engine.nt_contract_decision.confirmations).toBe(OMNI_FORGE_LIMITS.recoveryConfirmations);
    });

    it('settlement clears the confirmation, so a recovery NEVER fires without a fresh post-trade rescan', async () => {
        const engine = new Engine();
        await engine.ntAnalyseContracts('RECOVERY', 'R_50', CSV, 120);
        expect(engine.nt_omni_confirmation).toBeDefined();

        settleLoss(engine);
        expect(engine.nt_omni_confirmation).toBeUndefined();

        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_50', CSV, 120)).toBe(false);
        expect(engine.nt_contract_decision.confirmations).toBe(1);
    });

    it('a settled loss arms the rematch penalty against the exact losing tuple; a win clears it', () => {
        const engine = new Engine();
        settleLoss(engine);
        expect(engine.nt_omni_rematch).toEqual({ key: LOSER_KEY, penalty: OMNI_FORGE_LIMITS.rematchPenalty, epoch: 0 });
        expect(engine.nt_omni_pending_entry).toBeUndefined();

        const winner = new Engine();
        winner.nt_omni_rematch = { key: LOSER_KEY, penalty: OMNI_FORGE_LIMITS.rematchPenalty };
        winner.nt_omni_pending_entry = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 };
        winner.updateTotals({ sell_price: 2, buy_price: 1, currency: 'USD', underlying: 'R_50' });
        expect(winner.nt_omni_rematch).toBeUndefined();
    });

    it('the rematch penalty demotes the loser — the rescan picks an alternate market with a comparable edge', async () => {
        const tied = () => makeTape(hotDigits());
        const clean = new Engine();
        clean.tapes = { R_50: tied(), R_100: tied() };
        await clean.ntAnalyseContracts('RECOVERY', 'R_100', CSV, 120);
        expect(clean.nt_contract_decision.symbol).toBe('R_50');

        const engine = new Engine();
        engine.tapes = { R_50: tied(), R_100: tied() };
        settleLoss(engine);
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_100', CSV, 120)).toBe(false);
        expect(engine.nt_contract_decision.symbol).toBe('R_100');
        expect(engine.nt_contract_decision.reason).toContain('post-loss rescan');
        expect(engine.nt_omni_rematch.penalty).toBeCloseTo(
            OMNI_FORGE_LIMITS.rematchPenalty - OMNI_FORGE_LIMITS.rematchDecay
        );
    });

    it('the loser may re-enter only by topping every penalised fresh scan', async () => {
        const engine = new Engine();
        engine.tapes = { R_50: makeTape(hotDigits()), R_100: makeTape(coldDigits()) };
        settleLoss(engine);

        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_100', CSV, 120)).toBe(false);
        expect(engine.nt_contract_decision.confirmations).toBe(1);

        engine.tapes.R_50 = [...engine.tapes.R_50, { epoch: 61, quote: 100.05 }];
        engine.tapes.R_100 = [...engine.tapes.R_100, { epoch: 61, quote: 100 }];
        expect(await engine.ntAnalyseContracts('RECOVERY', 'R_100', CSV, 120)).toBe(true);

        await engine.ntAnalyseContracts('RECOVERY', 'R_100', CSV, 120);
        expect(engine.nt_omni_rematch).toBeUndefined();
    });

    it('normal-mode entries stay single-shot', async () => {
        const engine = new Engine();
        expect(await engine.ntAnalyseContracts('NORMAL', 'R_50', CSV, 120)).toBe(true);
        expect(engine.nt_contract_decision.eligible).toBe(true);
    });

    it('ntPurchaseContract records a pending entry so settlement can pair outcome → loser', () => {
        const engine = new Engine();
        api_base.api.send.mockResolvedValueOnce({ buy: { transaction_id: 1, contract_id: 2, buy_price: 1 } });
        engine.ntPurchaseContract('DIGITOVER', 1);
        expect(engine.nt_omni_pending_entry).toEqual({ symbol: 'R_50', contract: 'DIGITOVER', barrier: 1 });
    });
});
