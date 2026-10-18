import {
    barrierFields,
    buyPairQuotesConcurrently,
    chooseCommonPairDuration,
    contractOutcome,
    contractProfit,
    isSettledContract,
    medianTickSeconds,
    parseContractDuration,
    quotePairLeg,
} from '../HedgePair';
import HedgePairMixin from '../HedgePair';
import ApiHelpers from '../../../api/api-helpers';
import { BEFORE_PURCHASE, DURING_PURCHASE, STOP, PURCHASE_SUCCESSFUL, OPEN_CONTRACT, SELL } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: { send: jest.fn() },
        account_info: { currency: 'USD' },
        pip_sizes: { R_50: 2 },
        is_stopping: false,
        pushSubscription: jest.fn(),
    },
}));
jest.mock('../../utils/broadcast', () => ({ contract: jest.fn(), contractStatus: jest.fn() }));

const contract = (type, min, max, barriers) => ({ contract_type: type, barriers, min_contract_duration: min, max_contract_duration: max });

beforeEach(() => {
    api_base.api.send.mockReset();
});

describe('Hedge Pair Forge live metadata and duration resolution', () => {
    it('parses Deriv duration values without assuming missing metadata', () => {
        expect(parseContractDuration('1t')).toEqual({ amount: 1, unit: 't' });
        expect(parseContractDuration('2m')).toEqual({ amount: 2, unit: 'm' });
        expect(parseContractDuration('not-a-duration')).toBeNull();
        expect(parseContractDuration('0t')).toBeNull();
    });

    it('targets one tick when both live contract ranges support it', () => {
        const result = chooseCommonPairDuration(
            [contract('DIGITOVER', '1t', '10t', 1)], 'DIGITOVER',
            [contract('DIGITUNDER', '1t', '10t', 1)], 'DIGITUNDER',
            1, 1, 1, 1,
        );
        expect(result).toMatchObject({ amount: 1, unit: 't', durationTicks: 1 });
    });

    it('chooses a one-tick range when any exact live contract variant allows it', () => {
        const result = chooseCommonPairDuration(
            [contract('CALL', '5t', '10t', 1), contract('CALL', '1t', '10t', 1)], 'CALL',
            [contract('PUT', '1t', '10t', 1)], 'PUT',
            1, 1, 1, 1,
        );
        expect(result).toMatchObject({ amount: 1, unit: 't', durationTicks: 1 });
        expect(result.sourceA.min_contract_duration).toBe('1t');
    });

    it('treats an omitted contracts_for barrier count as zero only for barrier-free contracts', () => {
        const result = chooseCommonPairDuration(
            [contract('RUNHIGH', '1t', '10t', undefined)], 'RUNHIGH',
            [contract('RUNLOW', '1t', '10t', 0)], 'RUNLOW',
            1, 1, 0, 0,
        );
        expect(result).toMatchObject({ amount: 1, unit: 't', durationTicks: 1 });
        expect(chooseCommonPairDuration(
            [contract('CALL', '1t', '10t', undefined)], 'CALL',
            [contract('PUT', '1t', '10t', 1)], 'PUT',
            1, 1, 1, 1,
        )).toBeNull();
    });

    it('selects only the contracts_for rows with matching barrier counts', () => {
        const result = chooseCommonPairDuration(
            [contract('CALL', '1t', '10t', 0), contract('CALL', '3t', '10t', 1)], 'CALL',
            [contract('PUT', '2t', '10t', 1)], 'PUT',
            1, 1, 1, 1,
        );
        expect(result).toMatchObject({ amount: 3, unit: 't', durationTicks: 3 });
        expect(result.sourceA.barriers).toBe(1);
    });

    it('uses the actual shared minimum when a pair is not available at one tick', () => {
        const result = chooseCommonPairDuration(
            [contract('RUNHIGH', '1t', '10t', 0)], 'RUNHIGH',
            [contract('RUNLOW', '5t', '10t', 0)], 'RUNLOW',
            1, 1, 0, 0,
        );
        expect(result).toMatchObject({ amount: 5, unit: 't', durationTicks: 5 });
    });

    it('finds a common minute minimum and estimates its tick path from observed cadence', () => {
        const result = chooseCommonPairDuration(
            [contract('ONETOUCH', '1m', '60m', 1)], 'ONETOUCH',
            [contract('NOTOUCH', '2m', '60m', 1)], 'NOTOUCH',
            1, 2, 1, 1,
        );
        expect(result).toMatchObject({ amount: 2, unit: 'm', durationTicks: 60 });
        expect(chooseCommonPairDuration(
            [contract('ONETOUCH', '1t', '10m', 1)], 'ONETOUCH',
            [contract('NOTOUCH', '1m', '10m', 1)], 'NOTOUCH',
            1, 2, 1, 1,
        )).toMatchObject({ amount: 1, unit: 'm', durationTicks: 30 });
    });

    it('fails closed if either leg has no usable contracts_for duration metadata', () => {
        expect(chooseCommonPairDuration(
            [contract('CALL', undefined, undefined, 1)], 'CALL',
            [contract('PUT', '1t', '10t', 1)], 'PUT',
            1, 1, 1, 1,
        )).toBeNull();
    });

    it('builds Deriv proposal barriers from the family’s exact leg', () => {
        expect(barrierFields('DIGIT_OVERUNDER', 0, 0, 0)).toEqual({ barrier: '5' });
        expect(barrierFields('DIGIT_OVERUNDER', 1, 0, 0)).toEqual({ barrier: '4' });
        expect(barrierFields('HIGHER_LOWER', 0, 1.25, 0.75)).toEqual({ barrier: '+1.25' });
        expect(barrierFields('HIGHER_LOWER', 1, 1.25, 0.75)).toEqual({ barrier: '-0.75' });
        expect(barrierFields('TOUCH_UPPER_LOWER', 0, 1.25, 0.75)).toEqual({ barrier: '+1.25' });
        expect(barrierFields('TOUCH_UPPER_LOWER', 1, 1.25, 0.75)).toEqual({ barrier: '-0.75' });
        expect(barrierFields('ENDS_BETWEEN_OUTSIDE', 0, 1.25, 0.75)).toEqual({ barrier: '+1.25', barrier2: '-0.75' });
    });

    it('derives tick cadence from observed epochs instead of a universal symbol assumption', () => {
        expect(medianTickSeconds(Array.from({ length: 5 }, (_, epoch) => ({ epoch: epoch * 2, quote: 100 + epoch })))).toBe(2);
        expect(medianTickSeconds([{ epoch: 1, quote: 10 }, { epoch: 3, quote: 11 }])).toBeNull();
    });
});

describe('Hedge Pair Forge full Builder cycle', () => {
    it('waits for family-specific fresh-tick confirmations, then sends both orders and arms debt only on a double loss', async () => {
        const originalApiHelpers = ApiHelpers.singleton;
        let latestEpoch = Math.floor(Date.now() / 1000);
        let nextContractId = 1;
        let nextProposalId = 1;
        ApiHelpers.singleton = {
            contracts_for: {
                getContractsFor: jest.fn().mockResolvedValue([
                    contract('RUNHIGH', '1t', '10t', 0),
                    contract('RUNLOW', '1t', '10t', 0),
                ]),
            },
        };
        api_base.is_stopping = false;
        api_base.pushSubscription = jest.fn();
        api_base.api.onMessage = jest.fn(() => ({ subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) }));
        api_base.api.send.mockImplementation(async request => {
            if (request.proposal) {
                const id = `pair-proposal-${nextProposalId++}`;
                return {
                    echo_req: request,
                    proposal: {
                        id,
                        ask_price: request.amount,
                        payout: request.amount * (Number(request.amount) === 1 ? 3 : 2.2),
                    },
                };
            }
            if (request.buy) {
                const id = nextContractId++;
                return { buy: { contract_id: id, transaction_id: id + 100, buy_price: request.price } };
            }
            if (request.proposal_open_contract) {
                return {
                    subscription: { id: `pair-sub-${request.contract_id}` },
                    proposal_open_contract: {
                        contract_id: request.contract_id,
                        status: 'open',
                        is_sold: false,
                        buy_price: 1,
                        sell_price: 1,
                        profit: 0,
                    },
                };
            }
            return {};
        });

        class PairBaseEngine {
            constructor() {
                this.symbol = 'R_50';
                this.options = { symbol: 'R_50' };
                this.tradeOptions = { symbol: 'R_50', amount: 1, currency: 'USD' };
                this.sessionProfit = 0;
                this.is_purchasing = false;
                this.getBalance = () => 1000;
                this.updateAndReturnTotalRuns = () => 0;
                this.updateTotals = contractUpdate => {
                    this.sessionProfit += Number(contractUpdate.profit || 0);
                };
                this.$scope = {
                    stopped: false,
                    ticksService: {
                        pipSizes: { R_50: 4 },
                        request: jest.fn(async () => Array.from({ length: 500 }, (_, index) => ({
                            quote: 100 + index * 0.01,
                            epoch: latestEpoch - (499 - index),
                        }))),
                    },
                };
                let state = { scope: BEFORE_PURCHASE, proposalsReady: true };
                this.store = {
                    getState: () => state,
                    setScope: scope => { state = { ...state, scope }; },
                    dispatch: action => {
                        if (typeof action === 'function') return action(this.store.dispatch, this.store.getState);
                        if (action.type === PURCHASE_SUCCESSFUL) state = { ...state, scope: DURING_PURCHASE, openContract: false };
                        else if (action.type === OPEN_CONTRACT) state = { ...state, scope: DURING_PURCHASE, openContract: true };
                        else if (action.type === SELL) state = { ...state, scope: STOP };
                        return action;
                    },
                };
            }
            init() {}
        }

        try {
            const Engine = HedgePairMixin(PairBaseEngine);
            const engine = new Engine();
            engine.init();
            const callCycle = () => engine.ntHedgePairCycle(
                'ONLY_UPS_DOWNS', 1, 0, 0, 500, 80, 0.01,
                1.62, 3, 10, 500, 100, 100, 6,
            );

            expect(await callCycle()).toBe(false);
            latestEpoch += 1;
            expect(await callCycle()).toBe(false);
            latestEpoch += 1;
            expect(await callCycle()).toBe(true);

            const buyCalls = api_base.api.send.mock.calls.map(([request]) => request).filter(request => request.buy);
            expect(buyCalls).toHaveLength(2);
            expect(buyCalls.map(request => request.price)).toEqual([1, 1]);
            expect(engine.nt_pair_active.legs).toHaveLength(2);
            expect(engine.nt_pair_active.mode).toBe('normal');

            const pair = engine.nt_pair_active;
            engine.ntPairHandleContract(pair, {
                contract_id: pair.legs[0].contractId,
                status: 'lost', is_sold: true, buy_price: 1, sell_price: 0, profit: -1, currency: 'USD',
            });
            engine.ntPairHandleContract(pair, {
                contract_id: pair.legs[1].contractId,
                status: 'lost', is_sold: true, buy_price: 1, sell_price: 0, profit: -1, currency: 'USD',
            });
            expect(engine.nt_pair_state.debt).toBe(2);
            expect(engine.nt_pair_state.recoveryArmed).toBe(true);
            expect(engine.nt_pair_state.sessionProfit).toBe(-2);
            expect(engine.nt_pair_active).toBeNull();

            // Simulate a remaining debt, then return a weaker final-stake payout
            // than the cached analysis quote. The live cycle must size the debt
            // from the FINAL quotes — 0.40 × 1.10 = 0.44 target ÷ (2.20 − 1) =
            // 0.3666… → 0.37 a leg — and must NOT spend the 1.62 ladder ceiling,
            // which is a cap on the ladder, never the size.
            engine.store.setScope(BEFORE_PURCHASE);
            engine.nt_pair_state.halted = false;
            engine.nt_pair_state.debt = 0.4;
            engine.nt_pair_state.recoveryTarget = 0.44;
            engine.nt_pair_state.recoveryStep = 1;
            engine.nt_pair_state.doubleLossRun = 1;
            engine.nt_pair_state.recoveryArmed = true;
            const recoveryStartBuyCount = api_base.api.send.mock.calls
                .map(([request]) => request).filter(request => request.buy).length;
            for (let confirmation = 1; confirmation <= 4; confirmation += 1) {
                latestEpoch += 1;
                expect(await callCycle()).toBe(confirmation === 4);
            }
            const allRequests = api_base.api.send.mock.calls.map(([request]) => request);
            const recoveryBuys = allRequests.filter(request => request.buy).slice(recoveryStartBuyCount);
            expect(recoveryBuys).toHaveLength(2);
            expect(recoveryBuys.map(request => request.price)).toEqual([0.37, 0.37]);
            const recoveryProposalAmounts = allRequests.filter(request => request.proposal).map(request => request.amount);
            // The first pass sized off the cached 3.00× quote (0.44 ÷ 2 = 0.22,
            // below the broker minimum, so 0.35), then re-quoted at that stake,
            // saw 2.20× and re-sized upward before buying.
            expect(recoveryProposalAmounts).toContain(0.35);
            expect(recoveryProposalAmounts.slice(-2)).toEqual([0.37, 0.37]);
            expect(engine.nt_pair_active.mode).toBe('recovery');
            const plan = engine.nt_pair_active.recovery;
            expect(plan.stakePerLeg).toBe(0.37);
            expect(plan.pairStake).toBe(0.74);
            expect(plan.winMultiplier).toBeCloseTo(2.2, 10);
            expect(plan.targetDebt).toBeCloseTo(0.44, 10);
            expect(plan.capBinding).toBe('none');
            expect(plan.repayableByPairWin).toBe(true);
            expect(plan.projectedNetOnPairWin).toBeCloseTo(0.37 * 0.2, 10);
            expect(plan.residualDebtAfterWin).toBeCloseTo(0.4 - 0.37 * 0.2, 10);
            expect(engine.nt_pair_active.forcedEntry).toBe(false);
            expect(engine.nt_pair_active.rank).toBeNull();
            expect(engine.nt_pair_state.recoveryReferenceMultiplier).toBeCloseTo(2.2, 10);

            const recoveryPair = engine.nt_pair_active;
            engine.ntPairHandleContract(recoveryPair, {
                contract_id: recoveryPair.legs[0].contractId,
                status: 'won', is_sold: true, buy_price: 1.62, sell_price: 1.82, profit: 0.2, currency: 'USD',
            });
            engine.ntPairHandleContract(recoveryPair, {
                contract_id: recoveryPair.legs[1].contractId,
                status: 'won', is_sold: true, buy_price: 1.62, sell_price: 1.82, profit: 0.2, currency: 'USD',
            });
            expect(engine.nt_pair_state.debt).toBe(0);
            expect(engine.nt_pair_active).toBeNull();
        } finally {
            ApiHelpers.singleton = originalApiHelpers;
            api_base.is_stopping = false;
            api_base.api.onMessage = undefined;
            api_base.pushSubscription = jest.fn();
        }
    });
});

describe('Hedge Pair Forge proposal and paired-buy safeguards', () => {
    it('validates a live proposal against the exact family, duration and stake tuple', async () => {
        const request = {
            proposal: 1, amount: 0.5, basis: 'stake', contract_type: 'DIGITOVER', currency: 'USD',
            duration: 1, duration_unit: 't', underlying_symbol: 'R_50', barrier: '5',
        };
        api_base.api.send.mockResolvedValue({
            echo_req: request,
            proposal: { id: 'proposal-A', ask_price: 0.5, payout: 1.2 },
        });
        await expect(quotePairLeg({
            symbol: 'R_50', currency: 'USD', contractType: 'DIGITOVER',
            duration: { amount: 1, unit: 't' }, amount: 0.5, barriers: { barrier: '5' },
        })).resolves.toMatchObject({ proposalId: 'proposal-A', askPrice: 0.5, payout: 1.2, multiplier: 2.4 });
        expect(api_base.api.send).toHaveBeenCalledWith(request);
    });

    it('rejects a malformed, mismatched or zero-edge live proposal rather than falling back', async () => {
        api_base.api.send.mockResolvedValue({
            echo_req: { underlying_symbol: 'R_75' },
            proposal: { id: 'proposal-A', ask_price: 0.5, payout: 0.5 },
        });
        await expect(quotePairLeg({
            symbol: 'R_50', currency: 'USD', contractType: 'CALL',
            duration: { amount: 1, unit: 't' }, amount: 0.5, barriers: { barrier: '+0.5' },
        })).resolves.toBeNull();
    });

    it('fires both buy sends before awaiting either response', async () => {
        const calls = [];
        const resolvers = [];
        api_base.api.send.mockImplementation(request => {
            calls.push(request);
            return new Promise(resolve => resolvers.push(resolve));
        });
        const pending = buyPairQuotesConcurrently([
            { proposalId: 'proposal-A', askPrice: 0.5 },
            { proposalId: 'proposal-B', askPrice: 0.5 },
        ]);
        expect(calls).toEqual([
            { buy: 'proposal-A', price: 0.5 },
            { buy: 'proposal-B', price: 0.5 },
        ]);
        resolvers[0]({ buy: { contract_id: 1 } });
        resolvers[1]({ buy: { contract_id: 2 } });
        await expect(pending).resolves.toHaveLength(2);
    });

    it('records a partial buy result without retrying either purchase', async () => {
        api_base.api.send
            .mockResolvedValueOnce({ buy: { contract_id: 'first', buy_price: 0.5 } })
            .mockRejectedValueOnce(new Error('second buy was rejected'));
        const results = await buyPairQuotesConcurrently([
            { proposalId: 'proposal-A', askPrice: 0.5 },
            { proposalId: 'proposal-B', askPrice: 0.5 },
        ]);
        expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
        expect(api_base.api.send).toHaveBeenCalledTimes(2);
    });

    it('uses realized P&L and terminal status from each independent open contract', () => {
        expect(contractProfit({ buy_price: 0.5, sell_price: 0, profit: -0.5 })).toBe(-0.5);
        expect(contractProfit({ buy_price: 0.5, sell_price: 0.9 })).toBe(0.4);
        expect(contractOutcome({ status: 'lost' }, 0)).toBe('lost');
        expect(contractOutcome({ status: 'won' }, 0)).toBe('won');
        expect(contractOutcome({ status: 'won' }, -0.2)).toBe('won');
        expect(contractOutcome({ status: 'lost' }, 0.2)).toBe('lost');
        expect(isSettledContract({ is_sold: true })).toBe(true);
        expect(isSettledContract({ status: 'open', is_sold: false })).toBe(false);
    });
});
