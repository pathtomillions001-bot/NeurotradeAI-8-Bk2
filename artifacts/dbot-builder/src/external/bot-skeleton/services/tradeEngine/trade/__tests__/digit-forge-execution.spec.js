import withDigitForge from '../DigitForge';
import withPurchase from '../Purchase';
import withTicks from '../Ticks';
import { analyseDigitForgeCandidate } from '../digit-forge-analysis';
import { DIGIT_FORGE_CONTRACTS } from '../digit-forge-contracts';
import { BEFORE_PURCHASE, DURING_PURCHASE, PURCHASE_SUCCESSFUL, STOP } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({ api_base: { api: { send: jest.fn() } } }));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), info: jest.fn(), log: jest.fn() }));

const tape = (contract = 'DIGITOVER', recovery = false) =>
    Array.from({ length: 180 }, (_, i) => {
        const win = recovery ? i % 3 !== 2 : i % 20 !== 0;
        return (contract === 'DIGITOVER' ? win : !win) ? 9 : 0;
    });
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
        const getState = () => ({ scope: this.scope, proposalsReady: true });
        const dispatch = action => {
            if (typeof action === 'function') return action(dispatch, getState);
            if (action.type === PURCHASE_SUCCESSFUL) this.scope = DURING_PURCHASE;
            return action;
        };
        this.store = { getState, dispatch };
        this.$scope = {
            ticksService: {
                pipSizes: { R_50: 2, R_75: 2 },
                monitor: jest.fn(async ({ symbol }) => `${symbol}-key`),
                stopMonitor: jest.fn(async () => {}),
                request: jest.fn(),
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
const Engine = withDigitForge(withPurchase(withTicks(BaseEngine)));

function select(engine, mode = 'NORMAL', contract = 'DIGITUNDER', barrier = 7, symbol = engine.symbol) {
    const digits = tape(contract, mode === 'RECOVERY');
    engine.nt_digit_decision = {
        ...analyseDigitForgeCandidate({ digits, contract, barrier, payout: payoutFor(contract, barrier), mode }),
        mode,
        symbol,
        digits,
        confirmations: mode === 'RECOVERY' ? 2 : 0,
    };
    return engine.nt_digit_decision;
}
const buys = () => api_base.api.send.mock.calls.map(([request]) => request).filter(request => request.buy);

describe('Digit Forge decision → live quote → purchase handoff', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        api_base.api.send.mockImplementation(async request =>
            request.proposal
                ? quoteResponse(request)
                : { buy: { transaction_id: 111, contract_id: 222, buy_price: request.price } }
        );
    });
    afterEach(() => jest.useRealTimers());

    it.each(
        Object.entries(DIGIT_FORGE_CONTRACTS).flatMap(([mode, contracts]) =>
            contracts.map(c => [mode, c.contract, c.barrier, c.payout])
        )
    )('buys only the selected %s %s %s with the current stake', async (mode, contract, barrier, payout) => {
        const engine = new Engine();
        select(engine, mode, contract, barrier);
        const inRecovery = mode === 'RECOVERY';
        expect(await engine.ntPrepareDigitTrade(inRecovery, 'R_50', contract, barrier)).toBe(payout);
        expect(await engine.ntPurchaseDigitTrade(inRecovery, 'R_50', contract, barrier, 0.77, 500)).toBe(true);
        expect(buys()).toEqual([{ buy: `R_50:${contract}:${barrier}:0.77`, price: 0.77 }]);
        expect(engine.tradeOptions).toMatchObject({ symbol: 'R_50', prediction: barrier, amount: 0.77 });
    });

    it('rejects ALL other side/barrier pairs in each mode, even with patience forced', async () => {
        for (const mode of ['NORMAL', 'RECOVERY']) {
            for (const contract of ['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'UNKNOWN']) {
                for (const barrier of [-1, ...Array.from({ length: 10 }, (_, i) => i), 2.5, NaN, '2']) {
                    if (DIGIT_FORGE_CONTRACTS[mode].some(c => c.contract === contract && c.barrier === barrier))
                        continue;
                    const engine = new Engine();
                    select(engine, mode, contract, barrier);
                    expect(await engine.ntPrepareDigitTrade(mode === 'RECOVERY', 'R_50', contract, barrier, true)).toBe(
                        0
                    );
                    expect(
                        await engine.ntPurchaseDigitTrade(mode === 'RECOVERY', 'R_50', contract, barrier, 1, 500)
                    ).toBe(false);
                }
            }
        }
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it('never selects a stale proposal, including when payout/proposal blocks are present', async () => {
        const engine = new Engine();
        select(engine);
        engine.is_proposal_subscription_required = true;
        engine.data.proposals = [{ id: 'OLD-UNDER-2', contract_type: 'DIGITUNDER', barrier: 2 }];
        engine.selectProposal = jest.fn(() => ({ id: 'OLD-UNDER-2', askPrice: 10 }));
        engine.renewProposalsOnPurchase = jest.fn();
        await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 0.5, 500);
        expect(buys()).toEqual([{ buy: 'R_50:DIGITUNDER:7:0.5', price: 0.5 }]);
        expect(engine.selectProposal).not.toHaveBeenCalled();
        expect(engine.renewProposalsOnPurchase).not.toHaveBeenCalled();
        expect(engine.data.proposals).toEqual([]);
    });

    it('quotes the selected recovery pair at its live payout, not its static or previous payout', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITUNDER', 4);
        api_base.api.send.mockImplementation(async request => quoteResponse(request, 2));
        expect(await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITUNDER', 4)).toBe(2);
        expect(api_base.api.send).toHaveBeenCalledWith(
            expect.objectContaining({
                proposal: 1,
                underlying_symbol: 'R_50',
                contract_type: 'DIGITUNDER',
                barrier: 4,
                amount: 1,
            })
        );
    });

    it('holds when a candidate no longer qualifies at its live payout', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITOVER', 5);
        api_base.api.send.mockImplementation(async request => quoteResponse(request, 1.1));
        expect(await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5)).toBe(0);
        expect(engine.nt_digit_prepared).toBeNull();
        expect(buys()).toEqual([]);
    });

    it('never overrides an unconfirmed recovery entry with the normal patience flag', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITOVER', 5).eligible = false;
        expect(await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5, true)).toBe(0);
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it('requires two recovery confirmations even if an imported decision claims eligibility', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITOVER', 5).confirmations = 1;
        expect(await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5)).toBe(0);
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it('resets recovery confirmation after a successful buy so the next attempt must qualify afresh', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITOVER', 5);
        engine.nt_digit_recovery_confirmation = { key: 'R_50:DIGITOVER:5', epoch: 100, count: 5 };
        await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5);
        expect(await engine.ntPurchaseDigitTrade(true, 'R_50', 'DIGITOVER', 5, 0.77, 500)).toBe(true);
        expect(engine.nt_digit_recovery_confirmation).toBeUndefined();
    });

    it('will not use normal patience to trade a missing or malformed tape', async () => {
        for (const samples of [0, 19, undefined, NaN]) {
            const engine = new Engine();
            select(engine).samples = samples;
            expect(await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7, true)).toBe(0);
        }
        expect(api_base.api.send).not.toHaveBeenCalled();
    });

    it.each(['changed decision', 'changed mode', 'changed market', 'new trade cycle', 'expired quote', 'stopped'])(
        'invalidates a prepared trade after %s',
        async reason => {
            const engine = new Engine();
            select(engine);
            await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
            if (reason === 'changed decision') select(engine, 'NORMAL', 'DIGITOVER', 2);
            if (reason === 'changed mode') select(engine, 'RECOVERY', 'DIGITUNDER', 4);
            if (reason === 'changed market') await engine.ntSwitchMarket('R_75');
            if (reason === 'new trade cycle') engine.tradeOptions = { ...engine.tradeOptions };
            if (reason === 'expired quote') engine.nt_digit_prepared.at -= 10001;
            if (reason === 'stopped') engine.scope = STOP;
            expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 1, 500)).toBe(false);
            expect(buys()).toEqual([]);
        }
    );

    it.each([0, 0.34, NaN, -1])('will not buy with an unavailable or insufficient balance of %s', async balance => {
        const engine = new Engine();
        select(engine);
        await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        engine.balance = balance;
        expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 0.35, 500)).toBe(false);
        expect(buys()).toEqual([]);
    });

    it.each([
        [0.61, 0.609],
        [0.34, 500],
        [0.555, 500],
        [NaN, 500],
        [1, NaN],
    ])('rejects invalid stake %s / max stake %s instead of flooring past a hard limit', async (amount, maxStake) => {
        const engine = new Engine();
        select(engine);
        await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, amount, maxStake)).toBe(false);
        expect(buys()).toEqual([]);
    });

    it.each(['error', 'wrong barrier', 'wrong amount', 'invalid payout', 'missing id'])(
        'holds on a %s quote, without reverting to the startup contract',
        async fault => {
            const engine = new Engine();
            select(engine);
            api_base.api.send.mockImplementation(async request => {
                if (fault === 'error') throw new Error('quote unavailable');
                const response = quoteResponse(request);
                if (fault === 'wrong barrier') response.echo_req = { ...request, barrier: 2 };
                if (fault === 'wrong amount') response.proposal.ask_price = 10;
                if (fault === 'invalid payout') response.proposal.payout = NaN;
                if (fault === 'missing id') delete response.proposal.id;
                return response;
            });
            expect(await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7)).toBe(0);
            expect(buys()).toEqual([]);
        }
    );

    it('times out a hung quote and ignores its late response', async () => {
        jest.useFakeTimers();
        const engine = new Engine();
        select(engine);
        let resolve;
        api_base.api.send.mockImplementation(
            request =>
                new Promise(r => {
                    resolve = () => r(quoteResponse(request));
                })
        );
        const preparation = engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        await jest.advanceTimersByTimeAsync(5001);
        expect(await preparation).toBe(0);
        resolve();
        await Promise.resolve();
        expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 1, 500)).toBe(false);
        expect(buys()).toEqual([]);
    });

    it('blocks other purchases and market switches while the unit payout quote is in flight', async () => {
        const engine = new Engine();
        select(engine);
        let resolve;
        api_base.api.send.mockImplementation(
            request =>
                new Promise(r => {
                    resolve = () => r(quoteResponse(request));
                })
        );
        const pending = engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        expect(await engine.purchase('DIGITUNDER')).toBe(false);
        expect(await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7)).toBe(0);
        expect(await engine.ntSwitchMarket('R_75')).toBe(false);
        resolve();
        expect(await pending).toBe(1.4);
        expect(engine.nt_digit_preparing).toBe(false);
        expect(buys()).toEqual([]);
    });

    it('locks concurrent buys/market switches and rechecks stop/balance after the stake quote', async () => {
        const engine = new Engine();
        select(engine);
        await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        let resolve;
        api_base.api.send.mockImplementation(
            request =>
                new Promise(r => {
                    resolve = () => r(quoteResponse(request));
                })
        );
        const pending = engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 0.5, 500);
        expect(engine.nt_digit_purchase_pending).toBe(true);
        expect(await engine.purchase('DIGITUNDER')).toBe(false);
        expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 0.5, 500)).toBe(false);
        expect(await engine.ntSwitchMarket('R_75')).toBe(false);
        engine.balance = 0;
        engine.scope = STOP;
        resolve();
        expect(await pending).toBe(false);
        expect(engine.nt_digit_purchase_pending).toBe(false);
        expect(buys()).toEqual([]);
    });

    it('releases the lock after a failed stake quote without buying or losing the ledger', async () => {
        const engine = new Engine();
        select(engine, 'RECOVERY', 'DIGITOVER', 5);
        await engine.ntPrepareDigitTrade(true, 'R_50', 'DIGITOVER', 5);
        api_base.api.send.mockRejectedValueOnce(new Error('disconnected'));
        expect(await engine.ntPurchaseDigitTrade(true, 'R_50', 'DIGITOVER', 5, 0.77, 500)).toBe(false);
        expect(engine.nt_digit_purchase_pending).toBe(false);
        expect(engine.nt_digit_decision.mode).toBe('RECOVERY');
        expect(buys()).toEqual([]);
    });

    it('does not silently retry an ambiguous buy; releases both locks and consumes the preparation', async () => {
        const engine = new Engine();
        select(engine);
        await engine.ntPrepareDigitTrade(false, 'R_50', 'DIGITUNDER', 7);
        api_base.api.send.mockRejectedValueOnce(new Error('buy response lost'));
        await expect(engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 1, 500)).rejects.toThrow(
            'buy response lost'
        );
        expect(engine.is_purchasing).toBe(false);
        expect(engine.nt_digit_purchase_pending).toBe(false);
        expect(await engine.ntPurchaseDigitTrade(false, 'R_50', 'DIGITUNDER', 7, 1, 500)).toBe(false);
        expect(buys()).toHaveLength(1);
    });
});

describe('Digit Forge multi-market ranking', () => {
    function scanner(recovery) {
        const engine = new Engine();
        let epoch = 200;
        engine.$scope.ticksService.request.mockImplementation(async ({ symbol }) => {
            const digits =
                symbol === 'R_75' ? tape('DIGITUNDER', recovery) : Array.from({ length: 180 }, (_, i) => i % 10);
            return digits.map((digit, i) => ({ quote: 100 + digit / 100, epoch: epoch - digits.length + i }));
        });
        return {
            engine,
            advance: () => {
                epoch += 1;
            },
        };
    }

    it('chooses the best qualified normal market AND barrier, not the startup market/pair', async () => {
        const { engine } = scanner(false);
        await engine.ntAnalyseDigitMarkets('NORMAL', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision).toMatchObject({
            mode: 'NORMAL',
            symbol: 'R_75',
            contract: 'DIGITUNDER',
            barrier: 7,
            eligible: true,
            changedMarket: true,
        });
        expect(await engine.ntPrepareDigitTrade(false, 'R_75', 'DIGITUNDER', 7)).toBe(0); // not switched yet
        await engine.ntSwitchMarket('R_75');
        expect(engine.symbol).toBe('R_75');
    });

    it('uses fresh live payouts when re-ranking, then expires them rather than pinning a stale price', async () => {
        const { engine } = scanner(false);
        engine.nt_digit_live_payouts = new Map([['R_75:DIGITUNDER:7', { payout: 1.01, at: Date.now() }]]);
        await engine.ntAnalyseDigitMarkets('NORMAL', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision).toMatchObject({
            symbol: 'R_75',
            contract: 'DIGITUNDER',
            barrier: 8,
            eligible: true,
        });
        engine.nt_digit_live_payouts.get('R_75:DIGITUNDER:7').at -= 60001;
        await engine.ntAnalyseDigitMarkets('NORMAL', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision).toMatchObject({
            symbol: 'R_75',
            contract: 'DIGITUNDER',
            barrier: 7,
            eligible: true,
        });
    });

    it('ranks ONLY Over 5 / Under 4 in recovery and requires distinct ticks', async () => {
        const { engine, advance } = scanner(true);
        await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision).toMatchObject({
            mode: 'RECOVERY',
            symbol: 'R_75',
            contract: 'DIGITUNDER',
            barrier: 4,
            eligible: false,
            confirmations: 1,
        });
        await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision.eligible).toBe(false);
        expect(engine.nt_digit_decision.confirmations).toBe(1);
        advance();
        await engine.ntAnalyseDigitMarkets('RECOVERY', 'R_50,R_75', 180);
        expect(engine.nt_digit_decision.eligible).toBe(true);
        expect(engine.nt_digit_decision.confirmations).toBe(2);
    });
});
