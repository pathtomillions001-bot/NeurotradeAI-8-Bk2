/**
 * `nt_switch_market` safety — the engine half of the switching bots.
 *
 * Digit Forge and Omni Forge retarget the running engine between contracts.
 * Two things must hold or the bot goes silent (the interpreter blocks in
 * `while (watch('before'))` until a tick arrives):
 *   1. the PREVIOUS symbol's monitor is the one that gets stopped, and the new
 *      symbol ends up with a live monitor;
 *   2. a switch that fails leaves the engine on the market it was already
 *      trading — never without a symbol at all.
 */

import withTicks from '../Ticks';

class BaseEngine {
    constructor(scope) {
        this.$scope = scope;
        this.symbol = undefined;
        this.options = {};
        this.tradeOptions = { amount: 1, symbol: 'R_50' };
        this.data = { proposals: [] };
    }
    getPipSize() {
        return 2;
    }
}

/** Ticks service double that records monitor/stopMonitor traffic. */
function fakeTicksService({ failOn = null } = {}) {
    const service = {
        pipSizes: { R_50: 2, R_75: 2 },
        monitored: new Map(),
        stopped: [],
        request: jest.fn(() => Promise.resolve([{ quote: 100.01, epoch: 1 }])),
        monitor: jest.fn(({ symbol }) => {
            if (symbol === failOn) return Promise.reject(new Error('stream unavailable'));
            const key = `${symbol}-key`;
            service.monitored.set(symbol, key);
            return Promise.resolve(key);
        }),
        stopMonitor: jest.fn(({ symbol, key }) => {
            service.stopped.push({ symbol, key });
            if (service.monitored.get(symbol) === key) service.monitored.delete(symbol);
            return Promise.resolve();
        }),
    };
    return service;
}

const TickEngine = withTicks(BaseEngine);

const newEngine = service => {
    const engine = new TickEngine({ ticksService: service });
    engine.store = { dispatch: jest.fn() };
    return engine;
};

describe('engine market switching', () => {
    it('stops the PREVIOUS symbol’s monitor, not the new one', async () => {
        const service = fakeTicksService();
        const engine = newEngine(service);

        await engine.watchTicks('R_50');
        service.stopped.length = 0;
        await engine.watchTicks('R_75');

        // The stop must target R_50 with R_50's key — the old code passed the
        // new symbol with the old key, leaving R_50 monitored forever.
        expect(service.stopped).toEqual([{ symbol: 'R_50', key: 'R_50-key' }]);
        expect(service.monitored.has('R_75')).toBe(true);
        expect(engine.symbol).toBe('R_75');
    });

    it('switches the engine onto the new market and clears stale quotes', async () => {
        const service = fakeTicksService();
        const engine = newEngine(service);
        await engine.watchTicks('R_50');
        engine.data.proposals = [{ contract_type: 'DIGITOVER' }];
        engine.trade_option = { symbol: 'R_50' };
        engine.proposal_templates = [{ contract_type: 'DIGITOVER' }];

        await expect(engine.ntSwitchMarket('R_75')).resolves.toBe(true);

        expect(engine.symbol).toBe('R_75');
        expect(engine.options.symbol).toBe('R_75');
        expect(engine.tradeOptions.symbol).toBe('R_75');
        expect(engine.data.proposals).toEqual([]);
        expect(engine.trade_option).toBeNull();
        expect(engine.proposal_templates).toEqual([]);
        expect(service.monitored.has('R_75')).toBe(true);
    });

    it('rolls back to the current market when the new stream cannot be monitored', async () => {
        const service = fakeTicksService({ failOn: 'R_75' });
        const engine = newEngine(service);
        await engine.watchTicks('R_50');

        await expect(engine.ntSwitchMarket('R_75')).resolves.toBe(false);

        // The engine must still be trading R_50 — never left symbol-less, which
        // used to make every later tape read throw and the bot stop dead.
        expect(engine.symbol).toBe('R_50');
        expect(service.monitored.has('R_50')).toBe(true);
    });

    it('refuses to switch while a contract is open, and ignores a no-op switch', async () => {
        const service = fakeTicksService();
        const engine = newEngine(service);
        await engine.watchTicks('R_50');

        await expect(engine.ntSwitchMarket('R_50')).resolves.toBe(false);
        await expect(engine.ntSwitchMarket('')).resolves.toBe(false);

        engine.data.contract = { status: 'open' };
        await expect(engine.ntSwitchMarket('R_75')).resolves.toBe(false);
        expect(engine.symbol).toBe('R_50');
    });
});
