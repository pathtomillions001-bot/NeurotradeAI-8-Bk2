/** Simulated broker protocol, not live broker execution. These assertions pin
 * proposals, concurrent buys, independent contract IDs and fail-closed paths. */
import Digit45Pair from '../../external/bot-skeleton/services/tradeEngine/trade/Digit45Pair';
import { api_base } from '../../external/bot-skeleton/services/api/api-base';
import { BEFORE_PURCHASE } from '../../external/bot-skeleton/services/tradeEngine/trade/state/constants';
import { contract as broadcastContract, contractStatus } from '../../external/bot-skeleton/services/tradeEngine/utils/broadcast';

jest.mock('../../external/bot-skeleton/services/api/api-base', () => ({
    api_base: { api: null, is_stopping: false, digit45Unresolved: false },
}));
jest.mock('../../external/bot-skeleton/services/tradeEngine/utils/broadcast', () => ({
    contract: jest.fn(), contractStatus: jest.fn(), info: jest.fn(),
}));

const risk = { mode: 'normal', expectedCurrency: 'USD', baseStake: 1, debt: 0, markupPercent: 10,
    maxStake: 20, stopLoss: 30, sessionProfit: 0 };

function makeEngine({ send } = {}) {
    const calls = [];
    const quoteIds = new Map();
    let nextId = 0;
    api_base.api = { send: jest.fn(request => {
        calls.push(request);
        if (send) {
            const result = send(request, calls);
            if (result !== undefined) return result;
        }
        if (request.proposal) {
            const id = `proposal${++nextId}`;
            quoteIds.set(id, request);
            const payout = Math.round(request.amount * (request.barrier === '4' && request.contract_type === 'DIGITOVER' ? 1.95 :
                request.barrier === '5' && request.contract_type === 'DIGITUNDER' ? 1.95 : 2.43) * 100) / 100;
            return Promise.resolve({ proposal: { id, ask_price: request.amount, payout } });
        }
        if (request.buy) return Promise.resolve({ buy: { contract_id: `contract${request.buy}`,
            buy_price: quoteIds.get(request.buy)?.amount ?? request.price, transaction_id: `txn${request.buy}` } });
        if (request.proposal_open_contract) return Promise.resolve({ proposal_open_contract: null });
        throw new Error(`Unknown broker request ${JSON.stringify(request)}`);
    }) };
    const Engine = Digit45Pair(class {});
    const engine = new Engine();
    engine.accountInfo = { loginid: 'VRTC0001', currency: 'USD' };
    engine.startPromise = Promise.resolve();
    engine.options = { symbol: 'R_100', contractTypes: ['DIGITOVER', 'DIGITUNDER'] };
    engine.tradeOptions = { symbol: 'R_100', currency: 'USD', duration: 1,
        duration_unit: 't', basis: 'stake' };
    engine.data = {};
    engine.store = { getState: () => ({ scope: BEFORE_PURCHASE }), dispatch: jest.fn() };
    engine.$scope = { observer: { emit: jest.fn() } };
    engine.getBalance = jest.fn(() => 100);
    engine.updateTotals = jest.fn();
    engine.updateAndReturnTotalRuns = jest.fn(() => 1);
    return { engine, calls, quoteIds };
}

const sold = (id, buy = 1, sell = 0) => ({
    contract_id: id, is_sold: 1, buy_price: buy, sell_price: sell,
    currency: 'USD', transaction_ids: { sell: `sale${id}` },
});
const purchases = calls => calls.filter(c => c.buy);
const quotes = calls => calls.filter(c => c.proposal);
const deferred = () => {
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

describe('real paired engine against a protocol stub (NO live orders)', () => {
    afterEach(() => {
        jest.clearAllMocks();
        api_base.is_stopping = false;
        api_base.digit45Unresolved = false;
        jest.useRealTimers();
    });

    it('quotes and buys normal Over 4 + Under 5 on the same socket; waits for both IDs', async () => {
        const { engine, calls } = makeEngine();
        await engine.purchaseDigit45Pair(risk);
        expect(quotes(calls).map(q => [q.contract_type, q.barrier, q.amount, q.duration, q.duration_unit])).toEqual([
            ['DIGITOVER', '4', 1, 1, 't'], ['DIGITUNDER', '5', 1, 1, 't'],
        ]);
        expect(purchases(calls).map(b => b.price)).toEqual([1, 1]);
        expect(engine.digit45Pair.legs.map(l => l.id)).toEqual(['contractproposal1', 'contractproposal2']);
        expect(engine.handleDigit45OpenContract(sold('unrelated'))).toBe(false);
        expect(engine.handleDigit45OpenContract(sold('contractproposal1'))).toBe(true);
        expect(broadcastContract).toHaveBeenLastCalledWith(expect.objectContaining({ pairPending: true }));
        expect(contractStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'contract.sold', pairPending: true }));
        expect(engine.updateTotals).toHaveBeenCalledTimes(1);
        expect(() => engine.getDigit45PairResult('profit')).toThrow(/not fully settled/);
        expect(engine.hasActiveDigit45Pair()).toBe(true);
        // The second settlement may arrive on a LATER tick. Never make a new
        // purchase, or mark the pair complete, on the first sale alone.
        expect(engine.handleDigit45OpenContract(sold('contractproposal2'))).toBe(true);
        expect(broadcastContract).toHaveBeenLastCalledWith(expect.objectContaining({ pairPending: false }));
        expect(contractStatus).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'contract.sold', pairPending: false }));
        expect(engine.getDigit45PairResult('profit')).toBe(-2);
        expect(engine.getDigit45PairResult('bothLost')).toBe(true);
        expect(engine.getDigit45PairResult('stake')).toBe(2);
        engine.handleDigit45OpenContract(sold('contractproposal2')); // duplicate broker message
        expect(engine.updateTotals).toHaveBeenCalledTimes(2);
        expect(engine.hasActiveDigit45Pair()).toBe(false);
    });

    it('re-quotes sized recovery at $5.12 per leg (not $2.32), with Over 5 + Under 4 barriers', async () => {
        const { engine, calls } = makeEngine();
        await engine.purchaseDigit45Pair({ ...risk, mode: 'recovery', debt: 2 });
        expect(quotes(calls).map(q => [q.contract_type, q.barrier, q.amount])).toEqual([
            ['DIGITOVER', '5', 1], ['DIGITUNDER', '4', 1],
            ['DIGITOVER', '5', 5.12], ['DIGITUNDER', '4', 5.12],
        ]);
        expect(purchases(calls).map(b => b.price)).toEqual([5.12, 5.12]);
        engine.handleDigit45OpenContract(sold('contractproposal3', 5.12, 12.44));
        expect(() => engine.getDigit45PairResult('profit')).toThrow(/not fully settled/);
        engine.handleDigit45OpenContract(sold('contractproposal4', 5.12, 0));
        expect(engine.getDigit45PairResult('profit')).toBe(2.2);
        expect(engine.getDigit45PairResult('bothLost')).toBe(false);
    });

    it('sends both buys without waiting for either response; NEVER retries a rejected sibling', async () => {
        const first = deferred();
        const { engine, calls } = makeEngine({ send: req => {
            if (req.buy === 'proposal1') return first.promise;
            if (req.buy === 'proposal2') return Promise.reject(new Error('Broker refused second leg'));
        } });
        const placing = engine.purchaseDigit45Pair(risk);
        await new Promise(resolve => setTimeout(resolve, 0)); // broker replies queued in microtasks
        expect(purchases(calls)).toHaveLength(2);
        first.resolve({ buy: { contract_id: 501, buy_price: 1, transaction_id: 51 } });
        await placing;
        expect(engine.digit45Pair.partial).toBe(true);
        expect(engine.digit45Pair.legs.map(l => l.id)).toEqual(['501']);
        expect(purchases(calls)).toHaveLength(2);
        engine.handleDigit45OpenContract(sold('501'));
        expect(engine.getDigit45PairResult('profit')).toBe(-1);
        expect(engine.getDigit45PairResult('partial')).toBe(true);
        expect(engine.getDigit45PairResult('bothLost')).toBe(false);
        expect(api_base.digit45Unresolved).toBe(true);
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/previous paired order is unresolved/);
        expect(purchases(calls)).toHaveLength(2);
        expect(engine.$scope.observer.emit).toHaveBeenCalledWith('ui.log.error', expect.stringMatching(/check your broker account/));
    });

    it('refuses malformed/low-payout recovery quotes, unaffordable pairs and invalid options BEFORE either buy', async () => {
        const invalid = makeEngine({ send: req => req.proposal ?
            Promise.resolve({ proposal: { id: 'low', ask_price: req.amount, payout: req.amount * 1.9 } }) : undefined });
        await expect(invalid.engine.purchaseDigit45Pair({ ...risk, mode: 'recovery', debt: 2 })).rejects.toThrow(/more than TWO stakes/);
        expect(purchases(invalid.calls)).toHaveLength(0);

        const lowBalance = makeEngine();
        lowBalance.engine.getBalance = jest.fn(() => 1.5);
        await expect(lowBalance.engine.purchaseDigit45Pair(risk)).rejects.toThrow(/Balance cannot cover both normal legs/);
        expect(purchases(lowBalance.calls)).toHaveLength(0);

        const wrongDuration = makeEngine();
        wrongDuration.engine.tradeOptions.duration = 5;
        await expect(wrongDuration.engine.purchaseDigit45Pair(risk)).rejects.toThrow(/1-tick Over\/Under/);
        expect(quotes(wrongDuration.calls)).toHaveLength(0);

        const changedAccount = makeEngine();
        changedAccount.engine.tradeOptions.currency = 'EUR';
        changedAccount.engine.accountInfo.currency = 'EUR';
        await expect(changedAccount.engine.purchaseDigit45Pair(risk)).rejects.toThrow(/Account currency differs/);
        expect(quotes(changedAccount.calls)).toHaveLength(0);
    });

    it('handles a SYNCHRONOUS error on one buy without losing the sibling contract ID', async () => {
        const { engine, calls } = makeEngine({ send: req => {
            if (req.buy === 'proposal1') throw new Error('socket closed after send');
        } });
        await engine.purchaseDigit45Pair(risk);
        expect(purchases(calls)).toHaveLength(2);
        expect(engine.digit45Pair.legs.map(l => l.id)).toEqual(['contractproposal2']);
        expect(api_base.digit45Unresolved).toBe(true);
        engine.handleDigit45OpenContract(sold('contractproposal2'));
        expect(engine.getDigit45PairResult('partial')).toBe(true);
    });

    it('locks Run when BOTH buy responses fail: unknown fills cannot be replayed safely', async () => {
        const { engine, calls } = makeEngine({ send: req => req.buy ?
            Promise.reject(new Error('connection dropped')) : undefined });
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/rejected\/uncertain/);
        expect(purchases(calls)).toHaveLength(2);
        expect(api_base.digit45Unresolved).toBe(true);
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/previous paired order is unresolved/);
        expect(purchases(calls)).toHaveLength(2);
    });

    it('rejects final quotes whose ASK grows above the sized per-leg stake', async () => {
        const { engine, calls } = makeEngine({ send: req => req.proposal ?
            Promise.resolve({ proposal: { id: `quote${req.amount}`, ask_price: req.amount > 1 ? req.amount + 0.01 : req.amount,
                payout: (req.amount > 1 ? req.amount + 0.01 : req.amount) * 2.43 } }) : undefined });
        await expect(engine.purchaseDigit45Pair({ ...risk, mode: 'recovery', debt: 2 })).rejects.toThrow(/Final live pair quotes exceed/);
        expect(purchases(calls)).toHaveLength(0);
        expect(api_base.digit45Unresolved).toBe(false); // no order was ever sent
    });

    it('gates a second order during quote/buy/settlement AND when Stop is pressed', async () => {
        const first = deferred();
        const { engine, calls } = makeEngine({ send: req => req.proposal ? first.promise.then(() => ({
            proposal: { id: req.contract_type, ask_price: 1, payout: 2.43 },
        })) : undefined });
        const pending = engine.purchaseDigit45Pair(risk);
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/already pending/);
        first.resolve();
        await pending;
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/already pending/);
        const wait = engine.waitForDigit45PairSettled();
        let done = false;
        wait.then(() => { done = true; });
        api_base.is_stopping = true;
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/stopping/);
        await Promise.resolve();
        expect(done).toBe(false);
        engine.handleDigit45OpenContract(sold('contractDIGITOVER'));
        engine.handleDigit45OpenContract(sold('contractDIGITUNDER'));
        await wait;
        expect(done).toBe(true);
        expect(purchases(calls)).toHaveLength(2);
    });

    it('times out even if the broker poll promise NEVER settles', async () => {
        jest.useFakeTimers();
        const hung = deferred();
        const { engine } = makeEngine({ send: req => req.proposal_open_contract ? hung.promise : undefined });
        await engine.purchaseDigit45Pair(risk);
        await jest.advanceTimersByTimeAsync(1500);
        expect(engine.digit45Pair.polling).toBe(true);
        await jest.advanceTimersByTimeAsync(31000);
        expect(api_base.digit45Unresolved).toBe(true);
        expect(engine.$scope.observer.emit).toHaveBeenCalledWith('Error', expect.objectContaining({
            message: expect.stringMatching(/settlement was not confirmed/),
        }));
    });

    it('does not classify incomplete sell messages as losses; timeout reports unresolved exposure', async () => {
        jest.useFakeTimers();
        const { engine } = makeEngine();
        await engine.purchaseDigit45Pair(risk);
        engine.handleDigit45OpenContract({ contract_id: 'contractproposal1', is_sold: 1, buy_price: 1 });
        engine.handleDigit45OpenContract({ contract_id: 'contractproposal1', is_sold: 1, buy_price: 1, sell_price: null });
        expect(engine.digit45Pair.legs[0].settled).toBe(false);
        await jest.advanceTimersByTimeAsync(32_000);
        expect(engine.$scope.observer.emit).toHaveBeenCalledWith('Error', expect.objectContaining({
            message: expect.stringMatching(/settlement was not confirmed/),
        }));
        expect(engine.hasActiveDigit45Pair()).toBe(true);
        expect(api_base.digit45Unresolved).toBe(true);
        await expect(engine.purchaseDigit45Pair(risk)).rejects.toThrow(/previous paired order is unresolved/);
    });
});
