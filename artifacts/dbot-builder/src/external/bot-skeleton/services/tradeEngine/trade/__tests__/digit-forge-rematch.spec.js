/**
 * Digit Forge — post-loss rematch penalty (Nexus Hedge rescan mandate parity).
 *
 * Digit Forge already required its recovery candidate to persist across two
 * distinct fresh ticks and reset that count on every purchase. What it did
 * NOT have was any post-loss consequence inside the ranker: one loss barely
 * dents a 50+ sample posterior, so the exact losing side/barrier/market kept
 * ranking #1 through both confirmation ticks and the bot re-fired on the
 * same tape — the "locked into one market" loop.
 *
 * THE CONTRACT
 * ────────────
 *   1. A successful `ntPurchaseDigitTrade` records the exact tuple bought, so
 *      settlement can pair outcome → loser.
 *   2. A settled LOSS arms a decaying rematch penalty against that tuple; a
 *      settled WIN clears it.
 *   3. The next recovery scans demote the loser, so an alternate market with a
 *      comparable edge wins the post-loss rescan (fresh-tick confirmation
 *      still applies unchanged — it is unchanged behaviour on purpose).
 */
import withDigitForge from '../DigitForge';
import withPurchase from '../Purchase';
import withTicks from '../Ticks';
import withTotal from '../Total';
import { analyseDigitForgeCandidate, DIGIT_FORGE_ANALYSIS_LIMITS } from '../digit-forge-analysis';
import { DIGIT_FORGE_CONTRACTS } from '../digit-forge-contracts';
import { BEFORE_PURCHASE, DURING_PURCHASE, PURCHASE_SUCCESSFUL } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), info: jest.fn(), log: jest.fn() }));

// 100 digits, 75% winners for DIGITOVER 5 (digit > 5), losses always isolated.
const RECOVERY_DIGITS = Array.from({ length: 25 }, () => [8, 8, 8, 2]).flat();
const makeTape = (digits, startEpoch = 1) =>
    digits.map((digit, index) => ({ epoch: startEpoch + index, quote: 100 + digit / 100 }));

const payoutFor = (contract, barrier) =>
    Object.values(DIGIT_FORGE_CONTRACTS)
        .flat()
        .find(c => c.contract === contract && c.barrier === barrier)?.payout ?? 2.43;

function quoteResponse(request, multiplier = payoutFor(request.contract_type, request.barrier)) {
    return {
        echo_req: request,
        proposal: {
            id: `${request.underlying_symbol}:${request.contract_type}:${request.barrier}:${request.amount}`,
            ask_price: request.amount,
            payout: Math.round(request.amount * multiplier * 100) / 100,
        },
    };
}

class BaseEngine {
    constructor() {
        this.symbol = 'R_50';
        this.options = { symbol: 'R_50' };
        this.tradeOptions = {
            symbol: 'R_50',
            amount: 1,
            prediction: 2,
            currency: 'USD',
            basis: 'stake',
            duration: 1,
            duration_unit: 't',
        };
        this.data = { proposals: [], contract: {} };
        this.accountInfo = { loginid: 'VRTC12345' };
        this.scope = BEFORE_PURCHASE;
        this.balance = 1000;
        this.tapes = { R_50: makeTape(RECOVERY_DIGITS), R_100: makeTape(RECOVERY_DIGITS) };
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
const Engine = withDigitForge(withPurchase(withTicks(withTotal(BaseEngine))));

const settleLossOn = (engine, entry) => {
    engine.nt_digit_pending_entry = entry;
    engine.updateTotals({ sell_price: 0, buy_price: 0.5, currency: 'USD', underlying: entry.symbol });
};

describe('Digit Forge post-loss rematch', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        api_base.api.send.mockImplementation(async request =>
            request.proposal
                ? quoteResponse(request)
                : { buy: { transaction_id: 111, contract_id: 222, buy_price: request.price } }
        );
    });

    it('a successful recovery purchase records the exact tuple bought, so settlement can pair outcome → loser', async () => {
        const engine = new Engine();
        const analysis = analyseDigitForgeCandidate({
            digits: RECOVERY_DIGITS,
            contract: 'DIGITOVER',
            barrier: 5,
            payout: payoutFor('DIGITOVER', 5),
            mode: 'RECOVERY',
        });
        engine.nt_digit_decision = {
            ...analysis,
            mode: 'RECOVERY',
            symbol: 'R_50',
            digits: RECOVERY_DIGITS,
            confirmations: 2,
        };
        await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5);
        expect(await engine.ntPurchaseDigitTrade(true, 'R_50', 'DIGITOVER', 5, 0.77, 500)).toBe(true);
        expect(engine.nt_digit_pending_entry).toEqual({ symbol: 'R_50', contract: 'DIGITOVER', barrier: 5 });
    });

    it('a settled loss arms the rematch penalty against the exact losing tuple; a win clears it', () => {
        const engine = new Engine();
        settleLossOn(engine, { symbol: 'R_50', contract: 'DIGITOVER', barrier: 5 });
        expect(engine.nt_digit_rematch).toEqual({
            key: 'R_50:DIGITOVER:5',
            penalty: DIGIT_FORGE_ANALYSIS_LIMITS.rematchPenalty,
            epoch: 0,
        });
        expect(engine.nt_digit_pending_entry).toBeUndefined();

        const winner = new Engine();
        winner.nt_digit_rematch = { key: 'R_50:DIGITOVER:5', penalty: DIGIT_FORGE_ANALYSIS_LIMITS.rematchPenalty };
        winner.nt_digit_pending_entry = { symbol: 'R_50', contract: 'DIGITOVER', barrier: 5 };
        winner.updateTotals({ sell_price: 2, buy_price: 1, currency: 'USD', underlying: 'R_50' });
        expect(winner.nt_digit_rematch).toBeUndefined();
    });

    it('the rematch penalty demotes the loser — the post-loss rescan prefers the alternate market', async () => {
        // Identical hot tapes: clean scan ties and stable order keeps R_50 first.
        const clean = new Engine();
        await clean.ntAnalyseDigitMarkets('RECOVERY', 'R_100', 120);
        expect(clean.nt_digit_decision.symbol).toBe('R_50');
        expect(clean.nt_digit_decision.contract).toBe('DIGITOVER');
        expect(clean.nt_digit_decision.barrier).toBe(5);

        // After losing ON that tuple, the same scan must prefer R_100 — and
        // the fresh-tick confirmation still applies (never an instant fire).
        const engine = new Engine();
        settleLossOn(engine, { symbol: 'R_50', contract: 'DIGITOVER', barrier: 5 });
        expect(await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_100', 120)).toBe(false);
        expect(engine.nt_digit_decision.symbol).toBe('R_100');
        expect(engine.nt_digit_decision.reason).toContain('post-loss rescan');
        expect(engine.nt_digit_decision.confirmations).toBe(1);
        expect(engine.nt_digit_rematch.penalty).toBeCloseTo(
            DIGIT_FORGE_ANALYSIS_LIMITS.rematchPenalty - DIGIT_FORGE_ANALYSIS_LIMITS.rematchDecay
        );

        // The loser re-enters only by topping every penalised FRESH scan, so
        // repeat passes over the same tick still cannot arm the recovery…
        expect(await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_100', 120)).toBe(false);
        expect(engine.nt_digit_decision.confirmations).toBe(1);

        // …and a genuinely fresh tick completes the confirmation.
        const freshTick = symbol => [
            ...engine.tapes[symbol],
            { epoch: engine.tapes[symbol].length + 1, quote: 100.08 },
        ];
        engine.tapes = { R_50: freshTick('R_50'), R_100: freshTick('R_100') };
        expect(await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_100', 120)).toBe(true);
        expect(engine.nt_digit_decision.symbol).toBe('R_100');
        expect(engine.nt_digit_decision.confirmations).toBe(2);
        await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_100', 120);
        expect(engine.nt_digit_rematch).toBeUndefined();
    });
});
