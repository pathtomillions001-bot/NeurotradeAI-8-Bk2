jest.mock('../../external/bot-skeleton/services/api/api-base', () => ({
    api_base: { has_active_symbols: true, active_symbols: [{ symbol: 'R_100' }] },
}));

import ActiveSymbols from '../../external/bot-skeleton/services/api/active-symbols';
import { api_base } from '../../external/bot-skeleton/services/api/api-base';

it('coalesces concurrent market metadata requests rather than repeating trading_times and symbols loads', async () => {
    let resolveTime;
    const times = { initialise: jest.fn(() => new Promise(resolve => { resolveTime = resolve; })) };
    const active = new ActiveSymbols(times);
    active.processActiveSymbols = jest.fn(() => ({}));
    const first = active.retrieveActiveSymbols(true);
    const second = active.retrieveActiveSymbols(true);
    expect(first).toBe(second);
    expect(times.initialise).toHaveBeenCalledTimes(1);
    resolveTime();
    await expect(first).resolves.toEqual([{ symbol: 'R_100' }]);
    expect(active.is_initialised).toBe(true);
    expect(active.pending_refresh).toBe(null);
});

it('clears a failed cached broker promise so a later connection can retry', async () => {
    api_base.has_active_symbols = false;
    api_base.active_symbols_promise = Promise.reject(new Error('market socket dropped'));
    const active = new ActiveSymbols({ initialise: jest.fn().mockResolvedValue() });
    await expect(active.retrieveActiveSymbols(true)).rejects.toThrow('market socket dropped');
    expect(api_base.active_symbols_promise).toBe(null);
    api_base.has_active_symbols = true;
    active.processActiveSymbols = jest.fn(() => ({}));
    await expect(active.retrieveActiveSymbols(true)).resolves.toEqual([{ symbol: 'R_100' }]);
});

it('allows a later refresh after a transient market-data error', async () => {
    const times = { initialise: jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue() };
    const active = new ActiveSymbols(times);
    active.processActiveSymbols = jest.fn(() => ({}));
    await expect(active.retrieveActiveSymbols(true)).rejects.toThrow('offline');
    expect(active.pending_refresh).toBe(null);
    await expect(active.retrieveActiveSymbols(true)).resolves.toEqual([{ symbol: 'R_100' }]);
    expect(times.initialise).toHaveBeenCalledTimes(2);
});
