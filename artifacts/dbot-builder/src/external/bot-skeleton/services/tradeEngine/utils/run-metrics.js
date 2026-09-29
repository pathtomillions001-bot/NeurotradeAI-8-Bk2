import { LogTypes } from '../../../constants/messages';
import { log } from './broadcast';

/**
 * Run-cadence telemetry.
 *
 * Costs nothing while a bot is idle: every recorder is a couple of integer
 * increments on the engine instance. While a bot runs it answers the one
 * question that decides "fast enough": of the market ticks the strategy COULD
 * have entered on, what did each cycle cost (decision time, buy round trip,
 * end-to-end pace)? A short journal line is emitted every REPORT_EVERY trades
 * and the full snapshot is mirrored to `window.__NT_RUN_METRICS__()` for
 * console inspection. No trading state is ever mutated from here.
 */

const REPORT_EVERY = 5;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const round = value => Math.round(value);

export default class RunMetrics {
    constructor() {
        this.reset();
    }

    reset() {
        this.armed_ticks = 0; // ticks seen while the engine could enter (BEFORE_PURCHASE)
        this.busy_ticks = 0; // ticks seen while a contract was open (DURING_PURCHASE)
        this.idle_ticks = 0; // ticks seen in any other scope
        this.trades = 0;
        this.decision_ms_total = 0;
        this.decision_count = 0;
        this.buy_ms_total = 0;
        this.buy_count = 0;
        this.arm_at = 0;
        this.first_trade_at = 0;
        this.last_trade_at = 0;
        this.last_report = {
            trades: 0,
            armed_ticks: 0,
            busy_ticks: 0,
            idle_ticks: 0,
            decision_ms_total: 0,
            decision_count: 0,
            buy_ms_total: 0,
            buy_count: 0,
            last_trade_at: 0,
        };
    }

    /**
     * Called once per incoming tick of the watched symbol.
     * @param {'armed'|'busy'|'idle'} state armed = engine ready to enter this
     *   tick (scope BEFORE_PURCHASE); busy = a contract is open (DURING_PURCHASE).
     */
    recordTick(state) {
        if (state === 'armed') {
            this.armed_ticks += 1;
            this.arm_at = now();
        } else if (state === 'busy') {
            this.busy_ticks += 1;
        } else {
            this.idle_ticks += 1;
        }
    }

    /** The strategy committed to a purchase call (scope already validated). */
    recordBuyRequest() {
        if (!this.arm_at) return;
        this.decision_ms_total += now() - this.arm_at;
        this.decision_count += 1;
        this.arm_at = 0;
    }

    /**
     * A purchase request resolved successfully.
     * @param {number} buy_ms wall time from the buy request to the buy response
     *   (includes recoverable-error retries — that is honest entry latency).
     */
    recordPurchase(buy_ms) {
        this.trades += 1;
        if (Number.isFinite(buy_ms) && buy_ms >= 0) {
            this.buy_ms_total += buy_ms;
            this.buy_count += 1;
        }
        const at = now();
        if (!this.first_trade_at) this.first_trade_at = at;
        this.last_trade_at = at;
        this.maybeReport();
    }

    maybeReport() {
        if (this.trades % REPORT_EVERY !== 0) return;
        const window_trades = this.trades - this.last_report.trades;
        if (window_trades <= 0) return;

        const decision_delta = this.decision_ms_total - this.last_report.decision_ms_total;
        const decision_n = this.decision_count - this.last_report.decision_count;
        const buy_delta = this.buy_ms_total - this.last_report.buy_ms_total;
        const buy_n = this.buy_count - this.last_report.buy_count;
        const cycle_span = this.last_trade_at - (this.last_report.last_trade_at || this.first_trade_at);

        const payload = {
            trades: window_trades,
            ticks: this.armed_ticks + this.busy_ticks + this.idle_ticks
                - (this.last_report.armed_ticks + this.last_report.busy_ticks + this.last_report.idle_ticks),
            busy: this.busy_ticks - this.last_report.busy_ticks,
            decision_ms: decision_n > 0 ? round(decision_delta / decision_n) : 0,
            buy_ms: buy_n > 0 ? round(buy_delta / buy_n) : 0,
            cycle_ms: round(cycle_span / window_trades),
        };

        this.last_report = {
            trades: this.trades,
            armed_ticks: this.armed_ticks,
            busy_ticks: this.busy_ticks,
            idle_ticks: this.idle_ticks,
            decision_ms_total: this.decision_ms_total,
            decision_count: this.decision_count,
            buy_ms_total: this.buy_ms_total,
            buy_count: this.buy_count,
            last_trade_at: this.last_trade_at,
        };

        log(LogTypes.RUN_METRICS, payload);
    }

    snapshot() {
        return {
            armed_ticks: this.armed_ticks,
            busy_ticks: this.busy_ticks,
            idle_ticks: this.idle_ticks,
            trades: this.trades,
            avg_decision_ms: this.decision_count ? round(this.decision_ms_total / this.decision_count) : 0,
            avg_buy_ms: this.buy_count ? round(this.buy_ms_total / this.buy_count) : 0,
            avg_cycle_ms:
                this.trades > 1 ? round((this.last_trade_at - this.first_trade_at) / (this.trades - 1)) : 0,
        };
    }
}
