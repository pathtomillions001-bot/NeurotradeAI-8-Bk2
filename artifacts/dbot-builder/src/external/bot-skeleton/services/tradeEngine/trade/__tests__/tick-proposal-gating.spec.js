/**
 * Per-tick proposal hygiene + cadence telemetry in the watchTicks callback.
 *
 * Stock deriv-bot re-checked proposal readiness on EVERY tick, which — once
 * proposals are ready — only re-ran selection and re-dispatched an already-true
 * PROPOSALS_READY on a hot 1s-tick market. The gate keeps the work where it is
 * needed (proposals pending) plus a 4s keepalive so ids never expire between
 * quiet entries. These tests pin that gate and the run-metrics tick hook.
 */

import withTicks from '../Ticks';
import { BEFORE_PURCHASE, DURING_PURCHASE, NEW_TICK } from '../state/constants';

class BaseEngine {
    constructor(scope) {
        this.$scope = scope;
        this.symbol = undefined;
    }
}

const TickEngine = withTicks(BaseEngine);

const newEngine = (state, scope) => {
    const engine = new TickEngine(scope);
    engine.store = { getState: () => state, dispatch: jest.fn() };
    return engine;
};

describe('shouldCheckProposalReadiness', () => {
    it('never runs when the strategy needs no proposal subscription', () => {
        const engine = newEngine({ proposalsReady: false });
        engine.is_proposal_subscription_required = false;
        expect(engine.shouldCheckProposalReadiness()).toBe(false);
    });

    it('runs on every tick while proposals are still pending', () => {
        const engine = newEngine({ proposalsReady: false });
        engine.is_proposal_subscription_required = true;
        engine.nt_last_proposal_check = Date.now();
        expect(engine.shouldCheckProposalReadiness()).toBe(true);
    });

    it('is skipped immediately after proposals became ready', () => {
        const engine = newEngine({ proposalsReady: true });
        engine.is_proposal_subscription_required = true;
        engine.nt_last_proposal_check = Date.now();
        expect(engine.shouldCheckProposalReadiness()).toBe(false);
    });

    it('refreshes once the keepalive interval has passed (ids expire server-side)', () => {
        const engine = newEngine({ proposalsReady: true });
        engine.is_proposal_subscription_required = true;
        engine.nt_last_proposal_check = Date.now() - 4100;
        expect(engine.shouldCheckProposalReadiness()).toBe(true);
    });
});

describe('watchTicks per-tick callback', () => {
    const monitoredService = () => {
        const service = {
            callbacks: new Map(),
            monitor: jest.fn(({ symbol, callback }) => {
                service.callbacks.set(symbol, callback);
                return Promise.resolve(`${symbol}-key`);
            }),
            stopMonitor: jest.fn(() => Promise.resolve()),
        };
        return service;
    };

    it('dispatches NEW_TICK, records cadence state, and skips a redundant proposal check', async () => {
        const service = monitoredService();
        const engine = newEngine({ proposalsReady: true, scope: BEFORE_PURCHASE }, { ticksService: service });
        engine.run_metrics = { recordTick: jest.fn() };
        engine.checkProposalReady = jest.fn();
        engine.is_proposal_subscription_required = true;
        engine.nt_last_proposal_check = Date.now(); // fresh — keepalive not due

        await engine.watchTicks('R_75');
        service.callbacks.get('R_75')([{ quote: 101.12, epoch: 1234 }]);

        expect(engine.checkProposalReady).not.toHaveBeenCalled();
        expect(engine.run_metrics.recordTick).toHaveBeenCalledWith('armed');
        expect(engine.store.dispatch).toHaveBeenCalledWith({ type: NEW_TICK, payload: 1234 });
    });

    it('marks ticks seen while a contract is open as busy (not skipped)', async () => {
        const service = monitoredService();
        const engine = newEngine({ proposalsReady: false, scope: DURING_PURCHASE }, { ticksService: service });
        engine.run_metrics = { recordTick: jest.fn() };
        engine.checkProposalReady = jest.fn();
        engine.is_proposal_subscription_required = true;

        await engine.watchTicks('R_75');
        service.callbacks.get('R_75')([{ quote: 101.13, epoch: 1235 }]);

        expect(engine.run_metrics.recordTick).toHaveBeenCalledWith('busy');
    });

    it('ignores a momentarily empty tape without killing the listener', async () => {
        const service = monitoredService();
        const engine = newEngine({ proposalsReady: false, scope: BEFORE_PURCHASE }, { ticksService: service });
        engine.run_metrics = { recordTick: jest.fn() };
        engine.options = {};
        engine.is_proposal_subscription_required = false;

        await engine.watchTicks('R_75');
        service.callbacks.get('R_75')([]);

        expect(engine.run_metrics.recordTick).not.toHaveBeenCalled();
        expect(engine.store.dispatch).not.toHaveBeenCalled();
    });
});

describe('getLastTick feed gaps', () => {
    const engineWithTape = tape => {
        const service = {
            request: jest.fn(() => Promise.resolve(tape)),
            pipSizes: { R_75: 2 },
        };
        const engine = newEngine({ proposalsReady: false }, { ticksService: service });
        engine.symbol = 'R_75';
        return engine;
    };

    it('resolves undefined instead of throwing when the tick tape is empty', async () => {
        const engine = engineWithTape([]);
        await expect(engine.getLastTick(true)).resolves.toBeUndefined();
        await expect(engine.getLastTick(false)).resolves.toBeUndefined();
    });

    it('skips malformed rows and returns the newest valid tick', async () => {
        const engine = engineWithTape([undefined, { quote: 'bad', epoch: 10 }, { quote: '101.23', epoch: '20' }]);
        await expect(engine.getLastTick(true)).resolves.toEqual({ quote: '101.23', epoch: '20' });
        await expect(engine.getLastTick(false, true)).resolves.toBe('101.23');
    });

    it('resolves undefined instead of hanging or rejecting during a transient request failure', async () => {
        const service = {
            request: jest.fn(() => Promise.reject(new Error('socket reconnecting'))),
            pipSizes: { R_75: 2 },
        };
        const engine = newEngine({ proposalsReady: false }, { ticksService: service });
        engine.symbol = 'R_75';

        await expect(engine.getLastTick(true)).resolves.toBeUndefined();
    });
});
