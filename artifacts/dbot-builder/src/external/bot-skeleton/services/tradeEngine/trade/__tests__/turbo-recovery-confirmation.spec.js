/**
 * Over/Under Turbo — recovery fires only after a fresh post-trade rescan
 * (Nexus Hedge rescan mandate parity).
 *
 * THE BUG THIS GUARDS
 * ───────────────────
 *   `ntAnalyseTurboRecovery` used to flip to READY on the FIRST snapshot it
 *   saw after a loss — essentially the same tape the loss was recorded on.
 *   Debt-sized recovery stakes therefore fired without any genuinely fresh
 *   re-evaluation, chaining losses on the same tape.
 *
 * THE CONTRACT
 * ────────────
 *   Turbo's recovery contract is fixed (market, side, barrier chosen by the
 *   pre-deploy scan), so a rematch penalty has no meaning here — there is
 *   nothing to demote it against. Turbo's share of the mandate is pure:
 *   the timing gate must hold across TWO distinct fresh ticks, and settlement
 *   clears the state after EVERY trade, so a recovery never fires off the
 *   first post-loss snapshot.
 */
import withTicks from '../Ticks';
import withTotal from '../Total';
import { TURBO_RECOVERY_ANALYSIS_LIMITS } from '../turbo-recovery-analysis';
import { BEFORE_PURCHASE } from '../state/constants';

jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), info: jest.fn(), log: jest.fn() }));

// 100 digits, 80% winners for DIGITOVER 4 (digit > 4), losses always isolated.
const RECOVERY_DIGITS = Array.from({ length: 20 }, () => [7, 7, 7, 7, 3]).flat();
const makeTape = digits => digits.map((digit, index) => ({ epoch: index + 1, quote: 100 + digit / 100 }));

class BaseEngine {
    constructor() {
        this.symbol = 'R_50';
        this.options = { symbol: 'R_50' };
        this.tradeOptions = {
            symbol: 'R_50',
            amount: 1,
            prediction: 4,
            currency: 'USD',
            basis: 'stake',
            duration: 1,
            duration_unit: 't',
        };
        this.data = { proposals: [], contract: {} };
        this.accountInfo = { loginid: 'VRTC12345' };
        this.scope = BEFORE_PURCHASE;
        this.balance = 1000;
        this.tapes = { R_50: makeTape(RECOVERY_DIGITS) };
        const getState = () => ({ scope: this.scope, proposalsReady: true });
        this.store = { getState, dispatch: action => (typeof action === 'function' ? action(() => {}, getState) : action) };
        this.$scope = {
            ticksService: {
                pipSizes: { R_50: 2 },
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
}

const Engine = withTicks(withTotal(BaseEngine));
const scan = engine => engine.ntAnalyseTurboRecovery('DIGITOVER', 4, 1.7, 120, 1);
const settleLoss = engine => engine.updateTotals({ sell_price: 0, buy_price: 0.5, currency: 'USD', underlying: 'R_50' });

describe('Turbo recovery fresh-tick confirmation', () => {
    it('never flips READY on the first post-settlement snapshot — TWO distinct fresh ticks are required', async () => {
        const engine = new Engine();
        expect(await scan(engine)).toBe(false);
        expect(engine.nt_turbo_recovery_decision.confirmations).toBe(1);
        expect(engine.nt_turbo_recovery_decision.eligible).toBe(false);
        expect(engine.nt_turbo_recovery_decision.reason).toContain('confirming recovery setup 1/2');

        // Same snapshot — a repeated interpreter pass must NOT arm it.
        expect(await scan(engine)).toBe(false);
        expect(engine.nt_turbo_recovery_decision.confirmations).toBe(1);

        // A genuinely fresh tick completes the confirmation.
        engine.tapes.R_50 = [...engine.tapes.R_50, { epoch: RECOVERY_DIGITS.length + 1, quote: 100.07 }];
        expect(await scan(engine)).toBe(true);
        expect(engine.nt_turbo_recovery_decision.eligible).toBe(true);
        expect(engine.nt_turbo_recovery_decision.confirmations).toBe(
            TURBO_RECOVERY_ANALYSIS_LIMITS.recoveryConfirmations
        );
        expect(engine.nt_turbo_recovery_decision.reason).toContain('READY');
    });

    it('settlement clears the confirmation, so the next recovery re-earns its entry on fresh data', async () => {
        const engine = new Engine();
        await scan(engine);
        expect(engine.nt_turbo_recovery_confirmation).toBeDefined();

        settleLoss(engine);
        expect(engine.nt_turbo_recovery_confirmation).toBeUndefined();

        // The very next read — same tape as the loss — cannot fire.
        expect(await scan(engine)).toBe(false);
        expect(engine.nt_turbo_recovery_decision.confirmations).toBe(1);
    });

    it('a settled WIN also clears the confirmation (partial debt wins re-earn the next entry too)', async () => {
        const engine = new Engine();
        await scan(engine);
        expect(engine.nt_turbo_recovery_confirmation).toBeDefined();

        engine.updateTotals({ sell_price: 1.4, buy_price: 1, currency: 'USD', underlying: 'R_50' });
        expect(engine.nt_turbo_recovery_confirmation).toBeUndefined();
    });

    it('a tape that fails the timing gate clears any armed confirmation immediately', async () => {
        const engine = new Engine();
        await scan(engine);
        expect(engine.nt_turbo_recovery_confirmation).toBeDefined();

        // Flip the tape cold for Over 4 — the gate must reject and disarm.
        engine.tapes.R_50 = makeTape(Array.from({ length: 100 }, () => 1));
        expect(await scan(engine)).toBe(false);
        expect(engine.nt_turbo_recovery_confirmation).toBeUndefined();
        expect(engine.nt_turbo_recovery_decision.reason).toContain('HOLD');
    });
});
