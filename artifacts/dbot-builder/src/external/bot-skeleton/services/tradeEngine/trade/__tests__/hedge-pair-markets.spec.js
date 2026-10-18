import HedgePairMixin, { extractHistoryTicks, mergeTapes } from '../HedgePair';
import ApiHelpers from '../../../api/api-helpers';
import { api_base } from '../../../api/api-base';
import { observer as globalObserver } from '../../../../utils/observer';
import { BEFORE_PURCHASE, DURING_PURCHASE, PURCHASE_SUCCESSFUL, OPEN_CONTRACT, SELL, STOP } from '../state/constants';
import { HEDGE_PAIR_ANALYSIS_LIMITS } from '../hedge-pair-analysis';

jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: { send: jest.fn() },
        account_info: { currency: 'USD' },
        pip_sizes: { R_50: 4, R_100: 4, R_25: 4 },
        is_stopping: false,
        pushSubscription: jest.fn(),
    },
}));
jest.mock('../../utils/broadcast', () => ({ contract: jest.fn(), contractStatus: jest.fn() }));

const runContract = (type, min, max, barriers) => ({ contract_type: type, barriers, min_contract_duration: min, max_contract_duration: max });

/** One tick per second, so tick-denominated and second-denominated durations agree. */
const tape = (quotes, firstEpoch = 1000) => quotes.map((quote, index) => ({ quote, epoch: firstEpoch + index }));
/** Strictly alternating: every one-tick run pair repays (onlyA or onlyB), never both legs. */
const alternating = (count, start = 100, step = 0.01) =>
    Array.from({ length: count }, (_, index) => Number((start + (index % 2 ? step : 0)).toFixed(4)));
/** Flat: no run ever completes, so every replayed pair loses BOTH legs. */
const flat = (count, level = 100) => Array.from({ length: count }, () => level);

function logMessages() {
    return globalObserver.emit.mock.calls
        .filter(([channel]) => String(channel).startsWith('ui.log.'))
        .map(([channel, message]) => ({ channel, message: String(message) }));
}

/**
 * Wire the socket mock.
 * `historyFor` maps a symbol to the tick array Deriv's deep history returns, or to
 * an `{ error }` object to exercise the degraded path.
 */
function mockSocket({ historyFor, payoutMultiplier = 5, contractsFor, liveTicks } = {}) {
    let nextContractId = 1;
    let nextProposalId = 1;
    ApiHelpers.singleton = {
        contracts_for: {
            getContractsFor: jest.fn(async () => contractsFor ?? [
                runContract('RUNHIGH', '1t', '10t', 0),
                runContract('RUNLOW', '1t', '10t', 0),
            ]),
        },
    };
    api_base.is_stopping = false;
    api_base.pushSubscription = jest.fn();
    api_base.api.onMessage = jest.fn(() => ({ subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) }));
    api_base.api.send.mockImplementation(async request => {
        if (request.ticks_history) {
            const history = historyFor?.[request.ticks_history];
            if (!history) return { error: { message: `no history configured for ${request.ticks_history}` } };
            if (history.error) return history;
            return { echo_req: request, history: { prices: history.map(tick => tick.quote), times: history.map(tick => tick.epoch) } };
        }
        if (request.proposal) {
            const id = `pair-proposal-${nextProposalId++}`;
            const amount = Number(request.amount);
            return { echo_req: request, proposal: { id, ask_price: amount, payout: amount * payoutMultiplier } };
        }
        if (request.buy) {
            const id = nextContractId++;
            return { buy: { contract_id: id, transaction_id: id + 100, buy_price: request.price } };
        }
        if (request.proposal_open_contract) {
            return {
                subscription: { id: `pair-sub-${request.contract_id}` },
                proposal_open_contract: {
                    contract_id: request.contract_id, status: 'open', is_sold: false, buy_price: 1, sell_price: 1, profit: 0,
                },
            };
        }
        return {};
    });
    return liveTicks;
}

/**
 * A Builder engine carrying the pieces the pair cycle touches, plus a switchable
 * market. `ntSwitchMarket` normally comes from the Ticks mixin (the real trade
 * engine composes both — see trade/index.js); here it is a spy that performs the
 * same retarget, so the test asserts the handshake without a live tick stream.
 */
function makeEngine({
    symbol = 'R_50',
    pipSizes = { R_50: 4, R_100: 4, R_25: 4 },
    balance = 1000,
    stake = 1,
    liveTicks = {},
    switchable = true,
    advance = false,
} = {}) {
    // A real stream produces a NEW latest tick every second, and the engine's
    // entry confirmation streak counts fresh ticks. `advance` reproduces that.
    let liveCalls = 0;
    class PairBaseEngine {
        constructor() {
            this.symbol = symbol;
            this.options = { symbol };
            this.tradeOptions = { symbol, amount: stake, currency: 'USD' };
            this.sessionProfit = 0;
            this.is_purchasing = false;
            this.data = { contract: { status: 'sold' }, proposals: [] };
            this.getBalance = () => balance;
            this.updateAndReturnTotalRuns = () => 0;
            this.updateTotals = () => {};
            if (switchable) {
                this.ntSwitchMarket = jest.fn(async next => {
                    this.symbol = next;
                    this.options.symbol = next;
                    this.tradeOptions.symbol = next;
                    return true;
                });
            }
            this.$scope = {
                stopped: false,
                ticksService: {
                    pipSizes,
                    request: jest.fn(async ({ symbol: requested }) => {
                        const ticks = liveTicks[requested] ?? [];
                        if (!advance) return ticks;
                        liveCalls += 1;
                        return ticks.map(tick => ({ ...tick, epoch: tick.epoch + liveCalls }));
                    }),
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

    const Engine = HedgePairMixin(PairBaseEngine);
    const engine = new Engine();
    engine.init();
    return engine;
}

/** Run the cycle until a fresh-tick confirmation streak produces a buy. */
async function runToEntry(engine, args, attempts = 4) {
    let bought = false;
    for (let call = 0; call < attempts; call += 1) {
        bought = await engine.ntHedgePairCycle(...args);
        if (bought) return { bought, calls: call + 1 };
    }
    return { bought, calls: attempts };
}

const sendCalls = () => api_base.api.send.mock.calls.map(([request]) => request);
const historyCalls = () => sendCalls().filter(request => request.ticks_history);
const settledDwell = engine => {
    engine.nt_pair_market.evaluationsOnCurrent = HEDGE_PAIR_ANALYSIS_LIMITS.switchDwellEvaluations;
    engine.nt_pair_market.evaluationsSinceSwitch = HEDGE_PAIR_ANALYSIS_LIMITS.switchCooldownEvaluations;
};

let originalApiHelpers;
let emitSpy;

beforeEach(() => {
    api_base.api.send.mockReset();
    emitSpy = jest.spyOn(globalObserver, 'emit').mockImplementation(() => {});
    originalApiHelpers = ApiHelpers.singleton;
});

afterEach(() => {
    emitSpy.mockRestore();
    ApiHelpers.singleton = originalApiHelpers;
    api_base.is_stopping = false;
    api_base.api.onMessage = undefined;
    api_base.pushSubscription = jest.fn();
});

describe('Hedge Pair Forge deep-history plumbing', () => {
    it('converts a Deriv ticks_history response into the Builder tick shape', () => {
        expect(extractHistoryTicks({ history: { prices: [100.5, 101], times: [1000, 1001] } }))
            .toEqual([{ quote: 100.5, epoch: 1000 }, { quote: 101, epoch: 1001 }]);
        expect(extractHistoryTicks({ history: { prices: [100.5, 'bad', 101], times: [1000, 1001] } }))
            .toEqual([{ quote: 100.5, epoch: 1000 }]);
        expect(extractHistoryTicks({ history: { prices: [100.5], times: [1000, 1001] } })).toHaveLength(1);
        expect(extractHistoryTicks({})).toEqual([]);
        expect(extractHistoryTicks(null)).toEqual([]);
    });

    it('joins the cached deep tape with the newer live ticks and keeps the window', () => {
        const deep = tape([100, 101, 102], 1000);
        const live = tape([102, 103, 104], 1002);
        expect(mergeTapes(deep, live, 500).map(tick => tick.epoch)).toEqual([1000, 1001, 1002, 1003, 1004]);
        expect(mergeTapes(deep, live, 3).map(tick => tick.epoch)).toEqual([1002, 1003, 1004]);
        expect(mergeTapes([], live, 500)).toEqual(live);
        expect(mergeTapes(deep, [], 500)).toEqual(deep);
        // A live ring that is entirely older than the snapshot adds nothing.
        expect(mergeTapes(deep, tape([99], 900), 500)).toEqual(deep);
    });

    it('asks Deriv for the maximum deep history and caches it per symbol', async () => {
        mockSocket({ historyFor: { R_50: tape(alternating(4999)) } });
        const engine = makeEngine({ liveTicks: { R_50: tape(alternating(600), 5000) } });

        const first = await engine.ntPairDeepTape('R_50', 4999);
        expect(first.source).toBe('ticks_history');
        expect(first.ticks).toHaveLength(4999);
        expect(historyCalls()).toEqual([{
            ticks_history: 'R_50',
            adjust_start_time: 1,
            count: HEDGE_PAIR_ANALYSIS_LIMITS.deepHistoryCount,
            end: 'latest',
            style: 'ticks',
        }]);

        const second = await engine.ntPairDeepTape('R_50', 4999);
        expect(second.ticks).toHaveLength(4999);
        expect(second.source).toBe('ticks_history');
        expect(historyCalls()).toHaveLength(1);
    });

    it('caps the request at 4 999 (Deriv rejects 5 000) and negative-caches a failure', async () => {
        mockSocket({ historyFor: { R_50: { error: { message: 'Input validation failed: count' } } } });
        const engine = makeEngine();

        const oversized = await engine.ntPairDeepTape('R_50', 5000);
        expect(oversized.source).toBe('failed');
        expect(oversized.error).toMatch(/Input validation failed/);
        expect(historyCalls()[0].count).toBe(4999);

        // The failure is cached for the same TTL: one request per minute, not one
        // per tick, so a rejected call cannot burn the request budget.
        await engine.ntPairDeepTape('R_50', 4999);
        await engine.ntPairDeepTape('R_50', 4999);
        expect(historyCalls()).toHaveLength(1);
    });
});

describe('Hedge Pair Forge market-to-market switching', () => {
    const cycleArgs = (watchMarkets, analysisWindow = 500) => [
        'ONLY_UPS_DOWNS', 1, 0, 0, analysisWindow, 80, 0,
        2.43, 3, 40, 500, 100, 100, 6, 1, 2, watchMarkets, 0,
    ];
    // R_50 is flat: every replayed run pair loses BOTH legs, so it cannot be
    // measured at all. R_100 alternates: every pair repays.
    const twoMarketWorld = {
        liveTicks: { R_50: tape(flat(600), 5000), R_100: tape(alternating(600), 5000) },
        historyFor: { R_50: tape(flat(900), 1000), R_100: tape(alternating(900), 1000) },
    };

    it('stays put when only one market is watched, so existing XML behaves exactly as before', async () => {
        mockSocket({ historyFor: { R_50: tape(alternating(900), 1000) } });
        const engine = makeEngine({ liveTicks: { R_50: tape(alternating(600), 1900) }, advance: true });

        const entry = await runToEntry(engine, cycleArgs(''));
        expect(entry.bought).toBe(true);
        // ONLY_UPS_DOWNS refuses to enter on fewer than three fresh ticks.
        expect(entry.calls).toBe(3);
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();
        expect(engine.nt_pair_rank_cache).toBeNull();
        // The dwell counter runs even with one market, so a list widened later
        // still has to be earned before the bot moves.
        expect(engine.nt_pair_market.evaluationsOnCurrent).toBe(entry.calls);
        expect(engine.nt_pair_market.symbol).toBe('R_50');
        expect(historyCalls()).toHaveLength(1);
        expect(engine.nt_pair_last_analysis.eligible).toBe(true);
    });

    it('moves to the market that measurably repays, once the dwell has been served', async () => {
        mockSocket(twoMarketWorld);
        const engine = makeEngine({ liveTicks: twoMarketWorld.liveTicks });

        // Before the dwell is served the ranker names the better market but holds.
        expect(await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'))).toBe(false);
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();
        expect(engine.nt_pair_rank_cache.best.symbol).toBe('R_100');
        expect(engine.nt_pair_rank_cache.decision.reason).toMatch(/evaluations/);
        expect(engine.nt_pair_state.halted).toBe(false);
        // An unmeasurable incumbent is reported, never silently traded.
        expect(engine.nt_pair_rank_cache.rows.find(row => row.symbol === 'R_50').analysable).toBe(false);

        engine.nt_pair_rank_cache = null;
        settledDwell(engine);
        expect(await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'))).toBe(false);
        expect(engine.ntSwitchMarket).toHaveBeenCalledWith('R_100', 'Hedge Pair Forge');
        expect(engine.symbol).toBe('R_100');
        expect(engine.nt_pair_market.switches).toBe(1);
        expect(engine.nt_pair_market.lastSwitchFrom).toBe('R_50');
        expect(engine.nt_pair_market.evaluationsOnCurrent).toBe(0);
        expect(engine.nt_pair_market.evaluationsSinceSwitch).toBe(0);

        // Every per-market cache belongs to the market we left.
        expect(engine.nt_pair_confirmation).toBeNull();
        expect(engine.nt_pair_quote_cache.size).toBe(0);
        expect(engine.nt_pair_rank_cache).toBeNull();
        expect(engine.nt_pair_last_analysis).toBeNull();

        const lines = logMessages().map(entry => entry.message);
        expect(lines.some(message => /Hedge Pair Forge RANK · ONLY_UPS_DOWNS · 2 markets/.test(message))).toBe(true);
        expect(lines.some(message => /Hedge Pair Forge SWITCH · R_50 → R_100/.test(message))).toBe(true);
        expect(lines.some(message => /Hedge Pair Forge TAPE · R_50/.test(message))).toBe(true);
        expect(lines.some(message => /Hedge Pair Forge ANALYSING · Only Ups \/ Only Downs · R_50/.test(message))).toBe(true);

        // The next cycle analyses the new market and restarts its dwell.
        expect(await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'))).toBe(false);
        expect(engine.nt_pair_market.evaluationsOnCurrent).toBe(1);
        expect(engine.ntSwitchMarket).toHaveBeenCalledTimes(1);
        expect(logMessages().some(entry => /Hedge Pair Forge TAPE · R_100/.test(entry.message))).toBe(true);
    });

    it('never switches into a market it cannot measure, and says why', async () => {
        mockSocket({
            liveTicks: { R_50: tape(alternating(600), 5000), R_25: tape(flat(600), 5000) },
            historyFor: { R_50: tape(alternating(900), 1000), R_25: tape(flat(900), 1000) },
        });
        const engine = makeEngine({ liveTicks: { R_50: tape(alternating(600), 5000), R_25: tape(flat(600), 5000) } });
        settledDwell(engine);

        await engine.ntHedgePairCycle(...cycleArgs('R_50,R_25'));
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();
        expect(engine.nt_pair_rank_cache.decision.reason).toMatch(/holding R_50/);
        expect(engine.nt_pair_rank_cache.rows.find(row => row.symbol === 'R_25').analysable).toBe(false);
    });

    it('ranks a market with no contracts_for metadata as unmeasurable instead of guessing a duration', async () => {
        mockSocket({
            liveTicks: { R_50: tape(flat(600), 5000), R_100: tape(alternating(600), 5000) },
            historyFor: { R_50: tape(flat(900), 1000), R_100: tape(alternating(900), 1000) },
        });
        const engine = makeEngine({ liveTicks: { R_50: tape(flat(600), 5000), R_100: tape(alternating(600), 5000) } });
        ApiHelpers.singleton.contracts_for.getContractsFor = jest.fn(async requested =>
            (String(requested) === 'R_100' ? [] : [runContract('RUNHIGH', '1t', '10t', 0), runContract('RUNLOW', '1t', '10t', 0)]));
        settledDwell(engine);

        await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'));
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();
        const candidate = engine.nt_pair_rank_cache.rows.find(row => row.symbol === 'R_100');
        expect(candidate.analysable).toBe(false);
        expect(candidate.hardBlockers.join(' ')).toMatch(/no live contract metadata/);
    });

    it('refuses to switch while a pair is live, being bought, or open', async () => {
        mockSocket(twoMarketWorld);
        const engine = makeEngine({ liveTicks: twoMarketWorld.liveTicks });

        engine.nt_pair_active = { id: 'hp-live', legs: [] };
        expect(await engine.ntPairSwitchMarket('R_100', { reason: 'test' })).toBe(false);
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();
        expect(logMessages().some(entry => /SWITCH REFUSED/.test(entry.message))).toBe(true);

        engine.nt_pair_active = null;
        engine.is_purchasing = true;
        expect(await engine.ntPairSwitchMarket('R_100', { reason: 'test' })).toBe(false);
        engine.is_purchasing = false;
        engine.data.contract.status = 'open';
        expect(await engine.ntPairSwitchMarket('R_100', { reason: 'test' })).toBe(false);
        expect(engine.ntSwitchMarket).not.toHaveBeenCalled();

        // A failed handshake keeps the bot on the market it can still measure.
        engine.data.contract.status = 'sold';
        engine.ntSwitchMarket.mockResolvedValueOnce(false);
        expect(await engine.ntPairSwitchMarket('R_100', { reason: 'test' })).toBe(false);
        expect(engine.symbol).toBe('R_50');
        expect(engine.nt_pair_market.switches).toBe(0);
        expect(logMessages().some(entry => /SWITCH FAILED/.test(entry.message))).toBe(true);
    });

    it('stays on the incumbent and reports it when the engine cannot switch markets', async () => {
        mockSocket(twoMarketWorld);
        const engine = makeEngine({ liveTicks: twoMarketWorld.liveTicks, switchable: false });
        settledDwell(engine);

        await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'));
        expect(engine.symbol).toBe('R_50');
        expect(engine.nt_pair_market.switches).toBe(0);
        expect(logMessages().some(entry => /SWITCH UNAVAILABLE/.test(entry.message))).toBe(true);
    });

    it('keeps switching available while a recovery debt is outstanding, and the debt travels with it', async () => {
        mockSocket(twoMarketWorld);
        const engine = makeEngine({ liveTicks: twoMarketWorld.liveTicks });
        engine.nt_pair_state.debt = 2;
        engine.nt_pair_state.recoveryArmed = true;
        engine.nt_pair_state.recoveryStep = 1;
        settledDwell(engine);

        expect(await engine.ntHedgePairCycle(...cycleArgs('R_50,R_100'))).toBe(false);
        expect(engine.ntSwitchMarket).toHaveBeenCalledWith('R_100', 'Hedge Pair Forge');
        expect(engine.nt_pair_state.debt).toBe(2);
        expect(engine.nt_pair_state.recoveryArmed).toBe(true);
        expect(engine.nt_pair_state.recoveryStep).toBe(1);
    });

    it('caps the watch list at the socket budget and keeps the seed market first', async () => {
        mockSocket(twoMarketWorld);
        const engine = makeEngine({ liveTicks: twoMarketWorld.liveTicks });
        await engine.ntHedgePairCycle(...cycleArgs('R_100,R_25,R_50,R_75,R_10,R_50,1HZ15V,1HZ30V,1HZ90V,RDBULL'));
        expect(engine.nt_pair_config.watchMarkets).toHaveLength(HEDGE_PAIR_ANALYSIS_LIMITS.maxWatchMarkets);
        expect(engine.nt_pair_config.watchMarkets[0]).toBe('R_50');
    });
});

describe('Hedge Pair Forge degraded deep history', () => {
    it('falls back to the Builder tick ring and says so in the journal', async () => {
        mockSocket({ historyFor: { R_50: { error: { message: 'Rate limit reached' } } } });
        const engine = makeEngine({ liveTicks: { R_50: tape(alternating(600), 5000) }, advance: true });

        const entry = await runToEntry(engine, ['ONLY_UPS_DOWNS', 1, 0, 0, 500, 80, 0, 2.43, 3, 40, 500, 100, 100, 6, 1, 2, '', 0]);
        expect(entry.bought).toBe(true);
        const tapeLine = logMessages().map(entry => entry.message).find(message => /Hedge Pair Forge TAPE/.test(message));
        expect(tapeLine).toMatch(/deep history unavailable · Rate limit reached/);
        expect(tapeLine).toMatch(/live ring 600/);
        expect(engine.nt_pair_last_analysis.tapeSource).toBe('failed');
        expect(engine.nt_pair_last_analysis.samples).toBeGreaterThan(80);
    });
});

describe('Hedge Pair Forge journal heartbeat', () => {
    const args = ['ONLY_UPS_DOWNS', 1, 0, 0, 500, 80, 0, 2.43, 3, 40, 500, 100, 100, 6];

    it('repeats a pre-tape hold instead of logging it once and going silent', async () => {
        mockSocket({ historyFor: {} });
        const engine = makeEngine();
        // No tick source at all: this hold is raised with epoch 0, which the old
        // epoch-gated heartbeat could never repeat.
        engine.$scope.ticksService = undefined;

        expect(await engine.ntHedgePairCycle(...args)).toBe(false);
        const holds = () => logMessages().filter(entry => /HOLD/.test(entry.message)).map(entry => entry.message);
        expect(holds().filter(message => /Builder Deriv connection unavailable/.test(message))).toHaveLength(1);

        for (let call = 0; call < 5; call += 1) await engine.ntHedgePairCycle(...args);
        expect(holds().filter(message => /Builder Deriv connection unavailable/.test(message))).toHaveLength(1);

        // Past the heartbeat window the same message repeats, so an owner watching
        // the journal can see the bot is still alive and still stuck.
        engine.nt_pair_log_at = Date.now() - 31000;
        await engine.ntHedgePairCycle(...args);
        expect(holds().filter(message => /Builder Deriv connection unavailable/.test(message))).toHaveLength(2);

        // A changed reason prints immediately, without waiting for the heartbeat.
        engine.$scope = {
            stopped: false,
            ticksService: { pipSizes: { R_50: 4 }, request: jest.fn(async () => []) },
        };
        await engine.ntHedgePairCycle(...args);
        expect(holds().at(-1)).toMatch(/collecting market ticks history/);
        expect(holds().at(-1)).toMatch(/deep history: no history configured for R_50/);
    });

    it('rate-limits analysis-flow lines per label', () => {
        const engine = makeEngine();
        expect(engine.ntPairLogFlow('analysing', 'first')).toBe(true);
        expect(engine.ntPairLogFlow('analysing', 'second')).toBe(false);
        expect(engine.ntPairLogFlow('analysing', 'third', { force: true })).toBe(true);
        expect(engine.ntPairLogFlow('rank', 'other label')).toBe(true);
        const flow = logMessages().map(entry => entry.message);
        expect(flow).toContain('first');
        expect(flow).not.toContain('second');
        expect(flow).toContain('third');
        expect(flow).toContain('other label');
    });

    it('exposes the analysis through the status block a Blockly bot can notify on', async () => {
        mockSocket({ historyFor: { R_50: tape(alternating(900), 1000) } });
        const engine = makeEngine({ liveTicks: { R_50: tape(alternating(600), 1900) }, advance: true });
        await runToEntry(engine, ['ONLY_UPS_DOWNS', 1, 0, 0, 500, 80, 0, 2.43, 3, 40, 500, 100, 100, 6, 1, 2, '', 0]);
        expect(engine.ntHedgePairStatus('market')).toBe('R_50');
        expect(engine.ntHedgePairStatus('mode')).toBe('normal');
        expect(engine.ntHedgePairStatus('samples')).toBeGreaterThan(80);
        expect(engine.ntHedgePairStatus('repayment')).toBe(1);
        expect(engine.ntHedgePairStatus('both lost')).toBe(0);
        expect(engine.ntHedgePairStatus('edge')).toBeGreaterThan(0);
        expect(engine.ntHedgePairStatus('win multiplier')).toBe(5);
        expect(engine.ntHedgePairStatus('markets watched')).toBe(1);
        expect(engine.ntHedgePairStatus('analysis')).toMatch(/ready:/);
        expect(engine.ntHedgePairStatus('debt')).toBe(0);
        expect(engine.ntHedgePairStatus('recovery armed')).toBe(false);
        expect(engine.ntHedgePairStatus('continue')).toBe(true);
    });
});
