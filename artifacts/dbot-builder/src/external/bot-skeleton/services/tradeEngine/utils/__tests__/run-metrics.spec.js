/**
 * Run-cadence telemetry (tradeEngine/utils/run-metrics.js): proves the
 * counters accumulate per tick state, that a journal payload is emitted every
 * REPORT_EVERY successful purchases with windowed (not cumulative) values,
 * and that reset() returns everything to zero between user-initiated runs.
 */

jest.mock('../broadcast', () => ({ log: jest.fn() }));
jest.mock('../../../../constants/messages', () => ({ LogTypes: { RUN_METRICS: 'run_metrics' } }));

import { log } from '../broadcast';
import RunMetrics from '../run-metrics';

describe('RunMetrics', () => {
    it('counts ticks by engine state and reports windowed cadence every 5 trades', () => {
        const metrics = new RunMetrics();

        for (let i = 0; i < 5; i += 1) {
            metrics.recordTick('armed');
            metrics.recordTick('busy');
            metrics.recordBuyRequest();
            metrics.recordPurchase(150 + i);
        }

        expect(metrics.armed_ticks).toBe(5);
        expect(metrics.busy_ticks).toBe(5);
        expect(metrics.trades).toBe(5);
        expect(log).toHaveBeenCalledTimes(1);

        const [log_type, payload] = log.mock.calls[0];
        expect(log_type).toBe('run_metrics');
        expect(payload.trades).toBe(5);
        expect(payload.ticks).toBe(10); // 5 armed + 5 busy in this window
        expect(payload.busy).toBe(5);
        expect(payload.buy_ms).toBe(152); // mean of 150..154
        expect(payload.decision_ms).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(payload.cycle_ms)).toBe(true);
    });

    it('emits nothing before five trades and windows the second report', () => {
        const metrics = new RunMetrics();
        for (let i = 0; i < 4; i += 1) metrics.recordPurchase(100);
        expect(log).not.toHaveBeenCalled();

        // Trades 5 and 10 each close a five-trade window.
        for (let i = 0; i < 6; i += 1) metrics.recordPurchase(200);
        expect(log).toHaveBeenCalledTimes(2);
        const [, second_payload] = log.mock.calls[1];
        // second window covers trades 6..10 only
        expect(second_payload.trades).toBe(5);
        expect(second_payload.buy_ms).toBe(200);
    });

    it('ignores invalid buy latency without polluting the averages', () => {
        const metrics = new RunMetrics();
        for (let i = 0; i < 5; i += 1) metrics.recordPurchase(i === 0 ? -1 : 100);
        const [, payload] = log.mock.calls[log.mock.calls.length - 1];
        expect(payload.buy_ms).toBe(100);
    });

    it('reset() wipes all counters and reports start from a clean window', () => {
        const metrics = new RunMetrics();
        for (let i = 0; i < 4; i += 1) {
            metrics.recordTick('armed');
            metrics.recordPurchase(100);
        }
        metrics.reset();
        expect(metrics.armed_ticks).toBe(0);
        expect(metrics.trades).toBe(0);
        for (let i = 0; i < 5; i += 1) metrics.recordPurchase(123);
        expect(log).toHaveBeenCalledTimes(1);
        expect(log.mock.calls[0][1].buy_ms).toBe(123);
    });

    it('snapshot() exposes averages for the console escape hatch', () => {
        const metrics = new RunMetrics();
        metrics.recordTick('armed');
        metrics.recordTick('busy');
        metrics.recordTick('idle');
        metrics.recordBuyRequest();
        metrics.recordPurchase(90);
        const snap = metrics.snapshot();
        expect(snap).toMatchObject({ armed_ticks: 1, busy_ticks: 1, idle_ticks: 1, trades: 1, avg_buy_ms: 90 });
        expect(snap.avg_decision_ms).toBeGreaterThanOrEqual(0);
    });
});
