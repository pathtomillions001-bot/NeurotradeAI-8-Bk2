/**
 * Regression tests for the stop-path crash: "global_timeouts.forEach is not a
 * function".
 *
 * `recoverFromError` writes pending retry timers as an OBJECT MAP
 * `{[timerId]: {is_cancellable, msg_type}}`, but interpreter.stop() and
 * api-base.clearSubscriptions() treated the registry as an ARRAY. The moment a
 * backoff timer existed (RateLimit / WrongResponse / MarketIsClosed … — i.e.
 * routinely, mid-run), teardown crashed; dbot.stopBot() swallowed the
 * rejection, so the bot stopped with zero journal text.
 */
import Observer from '../../../../utils/observer';
import { clearGlobalTimeouts, getGlobalTimeouts } from '../global-timeouts';

const makeEntry = (is_cancellable = true) => ({ is_cancellable, msg_type: 'buy' });

describe('global-timeouts registry helpers', () => {
    it('returns an empty map when nothing is registered', () => {
        const observer = new Observer();
        expect(getGlobalTimeouts(observer)).toEqual({});
        expect(() => clearGlobalTimeouts(observer)).not.toThrow();
    });

    it('clears every timer in the object-map registry WITHOUT throwing (the stop-path bug)', () => {
        const observer = new Observer();
        jest.useFakeTimers();
        try {
            const first = setTimeout(() => {}, 60000);
            const second = setTimeout(() => {}, 60000);
            const registry = {};
            registry[Number(first)] = makeEntry(true);
            registry[Number(second)] = makeEntry(false);
            observer.setState({ global_timeouts: registry });

            // The old code did `registry.forEach(...)` → TypeError. This must not throw.
            expect(() => clearGlobalTimeouts(observer)).not.toThrow();
            expect(getGlobalTimeouts(observer)).toEqual({});
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('tolerates the legacy array shape produced by `?? []` fallbacks', () => {
        const observer = new Observer();
        jest.useFakeTimers();
        try {
            const timer = setTimeout(() => {}, 60000);
            const registry = [];
            registry[Number(timer)] = makeEntry();
            observer.setState({ global_timeouts: registry });

            expect(() => clearGlobalTimeouts(observer)).not.toThrow();
            expect(getGlobalTimeouts(observer)).toEqual({});
        } finally {
            jest.useRealTimers();
        }
    });

    it('exposes cancellability via map values the way stop() reads it', () => {
        const observer = new Observer();
        observer.setState({
            global_timeouts: { 1: makeEntry(true), 2: makeEntry(true) },
        });
        const values = Object.values(getGlobalTimeouts(observer));
        expect(values.every(entry => entry?.is_cancellable)).toBe(true);

        observer.setState({
            global_timeouts: { 1: makeEntry(true), 2: makeEntry(false) },
        });
        expect(Object.values(getGlobalTimeouts(observer)).every(entry => entry?.is_cancellable)).toBe(false);
    });
});
