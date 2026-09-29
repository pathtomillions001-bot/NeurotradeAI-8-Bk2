/**
 * Tick-stream resilience for market-switching bots (Digit Forge / Omni Forge).
 *
 * A generated bot only advances when a tick reaches the trade engine: the
 * interpreter blocks in `while (watch('before'))` until `NEW_TICK` is
 * dispatched. Every way the tick stream can silently die therefore presents
 * to the user as the same thing — a bot that takes a few trades, switches
 * market once or twice and then stops dead with no trades, no error and no
 * journal line. These tests pin the paths that used to do exactly that.
 */

import { api_base } from '../api-base';
import TicksService from '../ticks_service';

jest.mock('../api-base', () => ({
    api_base: {
        api: null,
        pip_sizes: { R_50: 2, R_75: 2, R_100: 2 },
        toggleRunButton: jest.fn(),
        pushSubscription: jest.fn(),
    },
}));

const history = (symbol, count = 5, base = 100) => ({
    history: {
        times: Array.from({ length: count }, (_, i) => 1000 + i),
        prices: Array.from({ length: count }, (_, i) => base + i),
    },
    echo_req: { ticks_history: symbol },
});

/** Minimal Deriv socket: records requests, lets a test push tick messages. */
function fakeApi() {
    const listeners = [];
    const api = {
        requests: [],
        connection: { readyState: 1 },
        send: jest.fn(request => {
            api.requests.push(request);
            if (request.ticks_history) return Promise.resolve(history(request.ticks_history));
            return Promise.resolve({});
        }),
        forget: jest.fn(() => Promise.resolve({})),
        forgetAll: jest.fn(() => Promise.resolve({})),
        onMessage: () => ({ subscribe: cb => listeners.push(cb) }),
    };
    api.pushTick = (symbol, epoch, quote = 123.45) =>
        listeners.forEach(cb => cb({ data: { msg_type: 'tick', tick: { symbol, epoch, quote, id: `${symbol}-sub` } } }));
    api.historyRequests = symbol => api.requests.filter(r => r.ticks_history === symbol).length;
    return api;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('TicksService — stream resilience for switching bots', () => {
    let service;
    let api;

    beforeEach(() => {
        api = fakeApi();
        api_base.api = api;
        service = new TicksService();
    });

    afterEach(() => {
        service.stopStallWatchdog();
        jest.useRealTimers();
    });

    it('keeps delivering ticks after a market is switched away from and returned to', async () => {
        // 1. The bot monitors R_50 (its starting market).
        const received = [];
        const key = await service.monitor({ symbol: 'R_50', callback: ticks => received.push(ticks.length) });
        api.pushTick('R_50', 2000);
        expect(received.length).toBeGreaterThan(0);

        // 2. It switches to R_75 — exactly what nt_switch_market does.
        await service.stopMonitor({ symbol: 'R_50', key });
        const onR75 = [];
        const key75 = await service.monitor({ symbol: 'R_75', callback: ticks => onR75.push(ticks.length) });
        api.pushTick('R_75', 2001);
        expect(onR75.length).toBeGreaterThan(0);

        // 3. It switches BACK to R_50. This is the case that used to hand the
        //    engine a corpse: a memoised promise, no subscription, no ticks.
        await service.stopMonitor({ symbol: 'R_75', key: key75 });
        const backOnR50 = [];
        await service.monitor({ symbol: 'R_50', callback: ticks => backOnR50.push(ticks.length) });

        api.pushTick('R_50', 2002);
        expect(backOnR50.length).toBeGreaterThan(0); // the bot can see the tape again
    });

    it('re-subscribes instead of serving a settled promise whose tape is gone', async () => {
        await service.request({ symbol: 'R_100' });
        expect(api.historyRequests('R_100')).toBe(1);

        // Simulate any path that drops the cached tape (stop/teardown, an
        // eviction, a forget): the next request must go back to the wire.
        service.ticks = service.ticks.delete('R_100');
        await service.request({ symbol: 'R_100' });
        expect(api.historyRequests('R_100')).toBe(2);
    });

    it('still dedupes concurrent in-flight requests for the same symbol', async () => {
        const results = await Promise.all([
            service.request({ symbol: 'R_50' }),
            service.request({ symbol: 'R_50' }),
            service.request({ symbol: 'R_50' }),
        ]);
        expect(api.historyRequests('R_50')).toBe(1); // one request, three callers
        results.forEach(ticks => expect(ticks.length).toBeGreaterThan(0));
    });

    it('revives a stream that has gone quiet, waking the blocked engine', async () => {
        jest.useFakeTimers();
        const woken = [];
        await service.monitor({ symbol: 'R_50', callback: () => woken.push(Date.now()) });
        const before = api.historyRequests('R_50');

        // No ticks for well past the stall threshold.
        service.last_tick_at.R_50 = Date.now() - 60000;
        jest.advanceTimersByTime(5000);
        jest.useRealTimers();
        await flush();
        await flush();

        expect(api.historyRequests('R_50')).toBe(before + 1); // forced re-subscribe
        expect(woken.length).toBeGreaterThan(0); // listener called → NEW_TICK dispatched
    });

    it('does not storm the socket while a market stays quiet', async () => {
        jest.useFakeTimers();
        await service.monitor({ symbol: 'R_50', callback: () => {} });
        const before = api.historyRequests('R_50');
        service.last_tick_at.R_50 = Date.now() - 60000;

        for (let tick = 0; tick < 4; tick++) jest.advanceTimersByTime(5000);
        jest.useRealTimers();
        await flush();

        // One recovery attempt per stall window, not one per watchdog tick.
        expect(api.historyRequests('R_50') - before).toBeLessThanOrEqual(1);
    });

    it('stops the watchdog and clears every cache when the run is torn down', async () => {
        await service.monitor({ symbol: 'R_50', callback: () => {} });
        expect(service.stall_watchdog).not.toBeNull();

        await service.unsubscribeFromTicksService();

        expect(service.stall_watchdog).toBeNull();
        expect(service.ticks.size).toBe(0);
        expect(service.stream_promises).toEqual({});

        // A fresh run must go back to the wire rather than serve a dead cache.
        const before = api.historyRequests('R_50');
        await service.request({ symbol: 'R_50' });
        expect(api.historyRequests('R_50')).toBe(before + 1);
    });

    it('never lets one symbol losing its listeners forget another symbol’s ids', async () => {
        const key50 = await service.monitor({ symbol: 'R_50', callback: () => {} });
        await service.monitor({ symbol: 'R_75', callback: () => {} });
        api.pushTick('R_50', 3000);
        api.pushTick('R_75', 3000);
        expect(service.subscriptions.getIn(['tick', 'R_75'])).toBe('R_75-sub');

        await service.stopMonitor({ symbol: 'R_50', key: key50 });

        // R_75 is still monitored: its subscription id must survive.
        expect(service.subscriptions.getIn(['tick', 'R_75'])).toBe('R_75-sub');
    });

    it('survives a tick arriving for an empty tape instead of throwing in the socket handler', async () => {
        await service.request({ symbol: 'R_50' });
        service.ticks = service.ticks.set('R_50', []);
        expect(() => api.pushTick('R_50', 4000)).not.toThrow();
        expect(service.ticks.get('R_50')).toHaveLength(1);
    });

    it('attaches to an existing subscription without retrying or journalling a false failure', async () => {
        api.send.mockRejectedValue({
            error: { code: 'AlreadySubscribed', msg_type: 'ticks_history' },
            msg_type: 'ticks_history',
        });

        await expect(service.request({ symbol: 'R_50' })).resolves.toEqual([]);

        // AlreadySubscribed is success-equivalent here: retrying the same
        // subscribe request cannot succeed and used to produce the recurring
        // "Request failed for: ticks_history, retrying in 2.5s" journal line.
        expect(api.send).toHaveBeenCalledTimes(1);

        // The symbol is now visible to observe(), so ticks from Deriv's
        // original live subscription land without another history request.
        api.pushTick('R_50', 5000);
        expect(service.ticks.get('R_50')).toHaveLength(1);
        expect(api.send).toHaveBeenCalledTimes(1);
    });

    it('swallows a failed refresh (closed market) instead of breaking the run', async () => {
        await service.monitor({ symbol: 'R_50', callback: () => {} });
        api.send.mockImplementationOnce(() => Promise.reject({ error: { code: 'MarketIsClosed' } }));
        await expect(service.refreshTickStream('R_50')).resolves.toEqual([]);
    });
});
