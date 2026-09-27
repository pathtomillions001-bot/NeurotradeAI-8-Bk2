/* eslint-disable no-promise-executor-return */
import debounce from 'lodash.debounce';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { localize } from '@deriv-com/translations';
import { getLast } from '../../../utils/binary-utils';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { getDirection, getLastDigit } from '../utils/helpers';
import { expectPositiveInteger } from '../utils/sanitize';
import * as constants from './state/constants';
import { analyseDualLockEntry, DUAL_LOCK_ENTRY_DEFAULTS } from './dual-lock-entry';
import { analyseTurboRecovery } from './turbo-recovery-analysis';

let tickListenerKey;

export default Engine =>
    class Ticks extends Engine {
        async watchTicks(symbol) {
            if (symbol && this.symbol !== symbol) {
                this.symbol = symbol;
                const { ticksService } = this.$scope;

                await ticksService.stopMonitor({
                    symbol,
                    key: tickListenerKey,
                });
                const callback = ticks => {
                    if (this.is_proposal_subscription_required) {
                        this.checkProposalReady();
                    }
                    const lastTick = ticks.slice(-1)[0];
                    const { epoch } = lastTick;
                    this.store.dispatch({ type: constants.NEW_TICK, payload: epoch });
                };

                const key = await ticksService.monitor({ symbol, callback });
                tickListenerKey = key;
            }
        }

        checkTicksPromiseExists() {
            return this.$scope.ticksService.ticks_history_promise;
        }

        getTicks(toString = false) {
            return new Promise(resolve => {
                this.$scope.ticksService.request({ symbol: this.symbol }).then(ticks => {
                    const ticks_list = ticks.map(tick => {
                        if (toString) {
                            return tick.quote.toFixed(this.getPipSize());
                        }
                        return tick.quote;
                    });

                    resolve(ticks_list);
                });
            });
        }

        getLastTick(raw, toString = false) {
            return new Promise((resolve, reject) =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => {
                        try {
                            let last_tick = raw ? getLast(ticks) : getLast(ticks).quote;
                            if (!raw && toString) {
                                last_tick = last_tick.toFixed(this.getPipSize());
                            }
                            resolve(last_tick);
                        } catch (error) {
                            reject(error);
                        }
                    })
                    .catch(e => {
                        if (e.code === 'MarketIsClosed') {
                            const localizedError = {
                                ...e,
                                message: getLocalizedErrorMessage(e.code, e.details),
                            };
                            globalObserver.emit('Error', localizedError);
                            resolve(e.code);
                        }
                    })
            );
        }

        getLastDigit() {
            return new Promise(resolve => this.getLastTick(false, true).then(tick => resolve(getLastDigit(tick))));
        }

        getLastDigitList() {
            return new Promise(resolve => this.getTicks().then(ticks => resolve(this.getLastDigitsFromList(ticks))));
        }

        /**
         * Rank all legal Digit Forge choices on all watched markets.  This is a
         * runtime primitive intentionally exposed through Blockly: no server or
         * hidden AI decides a trade after the strategy has been forged.
         *
         * Score = conservative EV + conditional Markov edge - instability -
         * loss-clustering risk.  A Beta(20*p0,20*(1-p0)) prior shrinks short
         * tapes toward the uniform-digit model; Wilson's one-sided 90% bound is
         * the hard edge test.  Recovery uses the same evidence but gives extra
         * weight to P(win|previous loss), because that is its actual entry state.
         */
        async ntAnalyseDigitMarkets(mode = 'NORMAL', csv = '', requestedWindow = 120) {
            const normal = [
                { contract: 'DIGITOVER', barrier: 1, payout: 1.23 },
                { contract: 'DIGITOVER', barrier: 2, payout: 1.4 },
                { contract: 'DIGITUNDER', barrier: 7, payout: 1.4 },
                { contract: 'DIGITUNDER', barrier: 8, payout: 1.23 },
            ];
            const recovery = [
                { contract: 'DIGITOVER', barrier: 4, payout: 1.95 },
                { contract: 'DIGITOVER', barrier: 5, payout: 2.43 },
                { contract: 'DIGITUNDER', barrier: 5, payout: 1.95 },
                { contract: 'DIGITUNDER', barrier: 4, payout: 2.43 },
            ];
            const candidates = mode === 'RECOVERY' ? recovery : normal;
            const markets = [...new Set(String(csv).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(20, Math.min(300, Number(requestedWindow) || 120));
            const z = 1.282; // one-sided 90%; strict enough to reject noise without 30-minute silence
            const rows = [];
            // Scan in small batches instead of one 9-symbol burst. The first
            // cycle is the only one that actually hits the wire (afterwards
            // every tape is served from TicksService's live cache), but that
            // first burst of parallel ticks_history+subscribe calls was enough
            // to trip rate limiting and fill the journal with
            // "Request failed … retrying" lines. Batching keeps the socket
            // polite; retry_limit stops a closed/unavailable market from
            // retrying forever — the scan just skips it this cycle (the catch
            // below) and tries again next cycle.
            const SCAN_BATCH = 3;
            const SCAN_RETRY_LIMIT = 3;
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: SCAN_RETRY_LIMIT });
                    const pip = this.$scope.ticksService.pipSizes?.[symbol] ?? this.getPipSize();
                    const digits = ticks.slice(-windowSize).map(t => getLastDigit(Number(t.quote).toFixed(pip)));
                    if (digits.length < 20) return;
                    for (const c of candidates) {
                        const wins = digits.map(d => c.contract === 'DIGITOVER' ? d > c.barrier : d < c.barrier);
                        const n = wins.length;
                        const p0 = c.contract === 'DIGITOVER' ? (9 - c.barrier) / 10 : c.barrier / 10;
                        const hits = wins.filter(Boolean).length;
                        const probability = (hits + 20 * p0) / (n + 20);
                        const denom = 1 + z * z / n;
                        const centre = probability + z * z / (2 * n);
                        const spread = z * Math.sqrt((probability * (1 - probability) + z * z / (4 * n)) / n);
                        const lowerBound = (centre - spread) / denom;
                        const breakEven = 1 / c.payout;
                        const ev = probability * c.payout - 1;
                        let ll = 0, lw = 0, wl = 0, ww = 0;
                        for (let i = 1; i < n; i++) {
                            if (!wins[i - 1] && !wins[i]) ll++; else if (!wins[i - 1]) lw++;
                            else if (!wins[i]) wl++; else ww++;
                        }
                        const afterLoss = (lw + 1) / (ll + lw + 2);
                        const afterWin = (ww + 1) / (wl + ww + 2);
                        const markov = wins[n - 1] ? afterWin : afterLoss;
                        const lossRate = 1 - probability;
                        const clustering = ((ll + 1) / (ll + lw + 2)) / Math.max(0.01, lossRate);
                        const half = Math.max(10, Math.floor(n / 2));
                        const recent = wins.slice(-half).filter(Boolean).length / half;
                        const prior = wins.slice(0, half).filter(Boolean).length / half;
                        const instability = Math.abs(recent - prior);
                        const conditionalEdge = (mode === 'RECOVERY' ? afterLoss : markov) - breakEven;
                        const score = 100 * ((lowerBound - breakEven) * 0.55 + conditionalEdge * 0.25 + ev * 0.2 - instability * 0.2 - Math.max(0, clustering - 1) * 0.08);
                        const eligible = n >= 30 && ev > 0 && lowerBound > breakEven - 0.025 && instability < 0.16 && clustering < 1.45;
                        rows.push({ symbol, ...c, samples: n, probability, lowerBound, breakEven, ev, markov, clustering, instability, score, eligible });
                    }
                } catch (_) { /* one unavailable market must not stop the bot */ }
            };
            for (let i = 0; i < markets.length; i += SCAN_BATCH) {
                await Promise.all(markets.slice(i, i + SCAN_BATCH).map(scanOne));
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_digit_decision = { symbol: this.symbol, contract: 'DIGITOVER', barrier: mode === 'RECOVERY' ? 4 : 2, eligible: false, score: -999, samples: 0, reason: 'feed unavailable; retrying', changedMarket: false };
                return false;
            }
            const blockers = [];
            if (best.samples < 30) blockers.push(`samples ${best.samples}/30`);
            if (best.ev <= 0) blockers.push(`EV ${(best.ev * 100).toFixed(2)}%`);
            if (best.lowerBound <= best.breakEven - 0.025) blockers.push(`lower bound ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`);
            if (best.instability >= 0.16) blockers.push(`unstable ${(best.instability * 100).toFixed(1)}pt`);
            if (best.clustering >= 1.45) blockers.push(`loss clustering ${best.clustering.toFixed(2)}x`);
            this.nt_digit_decision = {
                ...best,
                changedMarket: best.symbol !== this.symbol,
                reason: best.eligible ? `READY score ${best.score.toFixed(2)} EV ${(best.ev * 100).toFixed(2)}% LCB ${(best.lowerBound * 100).toFixed(1)}%` : `HOLD: ${blockers.join(', ') || 'no qualified edge'}`,
            };
            return best.eligible;
        }

        async ntDigitDecision(field) {
            const value = this.nt_digit_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'analysis warming up' : 0) : value;
        }

        /**
         * Omni Forge: rank a USER-DEFINED candidate set — any mix of
         * Over/Under barriers, Even/Odd, Matches/Differs — across all watched
         * markets. Same runtime philosophy as ntAnalyseDigitMarkets (no server
         * or hidden AI in the loop after Run), but the candidate list is not
         * hardcoded: the generated XML carries it as `TYPE:DIGIT:PAYOUT` CSV
         * entries (DIGIT −1 = none for parity contracts / auto-pick for
         * Matches & Differs).
         *
         * Mathematics per candidate per market, over the last W digits:
         *   · Beta(20·p0, 20·(1−p0)) prior shrinks short tapes to fair odds
         *   · Wilson one-sided 90% lower bound vs the payout's break-even
         *   · 2-state Markov chain (add-one smoothed); RECOVERY mode weighs
         *     P(win | previous loss) because that is its true entry state —
         *     this is what times the recovery shot instead of firing blind
         *   · loss-clustering ratio and split-half instability as penalties
         * NORMAL mode demands a proven edge; RECOVERY mode is deliberately
         * looser (repayment speed beats selectivity) but still refuses tapes
         * where losses cluster or the candidate is under water.
         */
        async ntAnalyseContracts(mode = 'NORMAL', marketsCsv = '', contractsCsv = '', requestedWindow = 120) {
            const isRecovery = mode === 'RECOVERY';
            const KNOWN = ['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF'];
            const FALLBACK_PAYOUT = { DIGITOVER: 1.95, DIGITUNDER: 1.95, DIGITEVEN: 1.95, DIGITODD: 1.95, DIGITMATCH: 8.93, DIGITDIFF: 1.09 };
            const specs = String(contractsCsv)
                .split(',').map(s => s.trim()).filter(Boolean).slice(0, 12)
                .map(raw => {
                    const [type = '', digitRaw = '-1', payoutRaw = ''] = raw.split(':');
                    const t = type.toUpperCase();
                    const digit = Math.trunc(Number(digitRaw));
                    const payout = Number(payoutRaw);
                    return {
                        type: t,
                        digit: Number.isFinite(digit) ? digit : -1,
                        payout: Number.isFinite(payout) && payout > 1 ? payout : (FALLBACK_PAYOUT[t] ?? 1.95),
                    };
                })
                .filter(c => KNOWN.includes(c.type));
            const markets = [...new Set(String(marketsCsv).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(20, Math.min(300, Number(requestedWindow) || 120));
            const z = 1.282; // one-sided 90% — rejects noise without endless silence
            const rows = [];
            const fallbackSpec = specs[0] ?? { type: 'DIGITOVER', digit: isRecovery ? 4 : 2, payout: FALLBACK_PAYOUT.DIGITOVER };
            const SCAN_BATCH = 3;
            const SCAN_RETRY_LIMIT = 3;
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: SCAN_RETRY_LIMIT });
                    const pip = this.$scope.ticksService.pipSizes?.[symbol] ?? this.getPipSize();
                    const digits = ticks.slice(-windowSize).map(t => getLastDigit(Number(t.quote).toFixed(pip)));
                    if (digits.length < 20) return;
                    const counts = Array.from({ length: 10 }, () => 0);
                    for (const d of digits) counts[d] += 1;
                    for (const spec of specs) {
                        // Resolve the candidate to a concrete (winFn, p0, digit).
                        let digit = spec.digit;
                        let winOf;
                        let p0;
                        if (spec.type === 'DIGITOVER') {
                            if (digit < 0 || digit > 8) continue;
                            winOf = d => d > digit; p0 = (9 - digit) / 10;
                        } else if (spec.type === 'DIGITUNDER') {
                            if (digit < 1 || digit > 9) continue;
                            winOf = d => d < digit; p0 = digit / 10;
                        } else if (spec.type === 'DIGITEVEN') {
                            digit = -1; winOf = d => d % 2 === 0; p0 = 0.5;
                        } else if (spec.type === 'DIGITODD') {
                            digit = -1; winOf = d => d % 2 === 1; p0 = 0.5;
                        } else if (spec.type === 'DIGITMATCH') {
                            // Auto (−1): the hottest digit of this tape.
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.max(...counts));
                            winOf = d => d === digit; p0 = 0.1;
                        } else {
                            // DIGITDIFF — auto (−1): the coldest digit of this tape.
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.min(...counts));
                            winOf = d => d !== digit; p0 = 0.9;
                        }
                        const wins = digits.map(winOf);
                        const n = wins.length;
                        const hits = wins.filter(Boolean).length;
                        const probability = (hits + 20 * p0) / (n + 20);
                        const denom = 1 + z * z / n;
                        const centre = probability + z * z / (2 * n);
                        const spread = z * Math.sqrt((probability * (1 - probability) + z * z / (4 * n)) / n);
                        const lowerBound = (centre - spread) / denom;
                        const breakEven = 1 / spec.payout;
                        const ev = probability * spec.payout - 1;
                        let ll = 0, lw = 0, wl = 0, ww = 0;
                        for (let i = 1; i < n; i++) {
                            if (!wins[i - 1] && !wins[i]) ll++; else if (!wins[i - 1]) lw++;
                            else if (!wins[i]) wl++; else ww++;
                        }
                        const afterLoss = (lw + 1) / (ll + lw + 2);
                        const afterWin = (ww + 1) / (wl + ww + 2);
                        const markov = wins[n - 1] ? afterWin : afterLoss;
                        const lossRate = 1 - probability;
                        const clustering = ((ll + 1) / (ll + lw + 2)) / Math.max(0.01, lossRate);
                        const half = Math.max(10, Math.floor(n / 2));
                        const recent = wins.slice(-half).filter(Boolean).length / half;
                        const prior = wins.slice(0, half).filter(Boolean).length / half;
                        const instability = Math.abs(recent - prior);
                        // RECOVERY conditions on the loss state it actually enters from.
                        const conditionalEdge = (isRecovery ? afterLoss : markov) - breakEven;
                        const score = 100 * ((lowerBound - breakEven) * 0.55 + conditionalEdge * 0.25 + ev * 0.2 - instability * 0.2 - Math.max(0, clustering - 1) * 0.08);
                        const eligible = isRecovery
                            ? n >= 20 && ev > -0.01 && lowerBound > breakEven - 0.05 && clustering < 1.6
                            : n >= 30 && ev > 0 && lowerBound > breakEven - 0.025 && instability < 0.16 && clustering < 1.45;
                        rows.push({ symbol, contract: spec.type, barrier: digit, payout: spec.payout, samples: n, probability, lowerBound, breakEven, ev, markov, clustering, instability, score, eligible });
                    }
                } catch (_) { /* one unavailable market must not stop the bot */ }
            };
            for (let i = 0; i < markets.length; i += SCAN_BATCH) {
                await Promise.all(markets.slice(i, i + SCAN_BATCH).map(scanOne));
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_contract_decision = { symbol: this.symbol, contract: fallbackSpec.type, barrier: fallbackSpec.digit, payout: fallbackSpec.payout, eligible: false, score: -999, samples: 0, reason: 'feed unavailable; retrying', changedMarket: false };
                return false;
            }
            const blockers = [];
            if (best.samples < (isRecovery ? 20 : 30)) blockers.push(`samples ${best.samples}/${isRecovery ? 20 : 30}`);
            if (best.ev <= (isRecovery ? -0.01 : 0)) blockers.push(`EV ${(best.ev * 100).toFixed(2)}%`);
            if (best.lowerBound <= best.breakEven - (isRecovery ? 0.05 : 0.025)) blockers.push(`lower bound ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`);
            if (!isRecovery && best.instability >= 0.16) blockers.push(`unstable ${(best.instability * 100).toFixed(1)}pt`);
            if (best.clustering >= (isRecovery ? 1.6 : 1.45)) blockers.push(`loss clustering ${best.clustering.toFixed(2)}x`);
            this.nt_contract_decision = {
                ...best,
                changedMarket: best.symbol !== this.symbol,
                reason: best.eligible
                    ? `READY ${best.contract}${best.barrier >= 0 ? ` ${best.barrier}` : ''} score ${best.score.toFixed(2)} EV ${(best.ev * 100).toFixed(2)}% LCB ${(best.lowerBound * 100).toFixed(1)}%`
                    : `HOLD: ${blockers.join(', ') || 'no qualified edge'}`,
            };
            return best.eligible;
        }

        async ntContractDecision(field) {
            const value = this.nt_contract_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'analysis warming up' : 0) : value;
        }

        /**
         * Time a generated Turbo DBot's FIXED recovery contract. The pre-deploy
         * scan still owns market/barrier selection; this read only answers
         * whether the next tick is a defensible moment to place that recovery.
         */
        async ntAnalyseTurboRecovery(
            contract = 'DIGITOVER',
            barrier = 4,
            fallbackPayout = 1.95,
            requestedWindow = 120,
            requestedStake = 0
        ) {
            try {
                const windowSize = Math.max(40, Math.min(300, Number(requestedWindow) || 120));
                const ticks = await this.$scope.ticksService.request({ symbol: this.symbol });
                const pip = this.$scope.ticksService.pipSizes?.[this.symbol] ?? this.getPipSize() ?? 2;
                const digits = ticks
                    .slice(-windowSize)
                    .map(tick => getLastDigit(Number(tick.quote).toFixed(pip)));

                // Prefer the proposal currently prepared by Trade Definition.
                // Its payout/ask ratio is the true live total-return multiplier;
                // the API-quoted seed remains a conservative availability fallback.
                const proposal = [...(this.data?.proposals ?? [])]
                    .reverse()
                    .find(row => {
                        const sameContract = row?.contract_type === contract;
                        const sameBarrier = row?.barrier === undefined || Number(row.barrier) === Number(barrier);
                        return sameContract && sameBarrier;
                    });
                const ask = Number(proposal?.ask_price);
                const totalReturn = Number(proposal?.payout);
                const livePayout = ask > 0 && totalReturn > ask ? totalReturn / ask : Number.NaN;
                const payout = Number.isFinite(livePayout) ? livePayout : Number(fallbackPayout);
                const stake = Number(requestedStake) || Number(this.tradeOptions?.amount) || 0;
                const balance = Number(this.getBalance?.('NUM')) || 0;

                this.nt_turbo_recovery_decision = analyseTurboRecovery({
                    digits,
                    contract,
                    barrier,
                    payout,
                    stake,
                    balance,
                });
                return this.nt_turbo_recovery_decision.eligible;
            } catch (_) {
                this.nt_turbo_recovery_decision = {
                    eligible: false,
                    probability: 0,
                    lowerBound: 0,
                    breakEven: 1,
                    clusterRatio: 99,
                    instability: 1,
                    expectedUtility: -999,
                    samples: 0,
                    contextSamples: 0,
                    reason: 'HOLD · recovery feed unavailable; retrying safely',
                };
                return false;
            }
        }

        async ntTurboRecoveryDecision(field) {
            const value = this.nt_turbo_recovery_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'HOLD · recovery analysis warming up' : 0) : value;
        }

        /**
         * Time the FIRST entry of a generated Dual-Lock Range Sentinel bot.
         *
         * The scan owns the market, side and barrier; this read only answers
         * whether the next tick is a defensible moment to START. The generated
         * strategy calls it once per tick until it returns true, then never
         * again for the rest of the run — every later trade (normal and
         * recovery) fires with no analysis at all, exactly as before.
         *
         * The wait is bounded by `patience` evaluations: at the deadline the
         * gate opens unconditionally, including when the tick feed is
         * unavailable, so a generated bot can never sit idle.
         */
        async ntAnalyseDualLockEntry(
            contract = 'DIGITOVER',
            barrier = 1,
            requestedWindow = DUAL_LOCK_ENTRY_DEFAULTS.window,
            patience = DUAL_LOCK_ENTRY_DEFAULTS.patience,
            waited = 0
        ) {
            const patienceTicks = Math.max(
                3,
                Math.min(40, Math.trunc(Number(patience)) || DUAL_LOCK_ENTRY_DEFAULTS.patience)
            );
            const waitedTicks = Math.max(0, Math.trunc(Number(waited)) || 0);
            try {
                const windowSize = Math.max(
                    40,
                    Math.min(300, Number(requestedWindow) || DUAL_LOCK_ENTRY_DEFAULTS.window)
                );
                const ticks = await this.$scope.ticksService.request({ symbol: this.symbol });
                const pip = this.$scope.ticksService.pipSizes?.[this.symbol] ?? this.getPipSize() ?? 2;
                const digits = ticks.slice(-windowSize).map(tick => getLastDigit(Number(tick.quote).toFixed(pip)));

                this.nt_dual_lock_entry_decision = analyseDualLockEntry({
                    digits,
                    contract,
                    barrier,
                    waited: waitedTicks,
                    patience: patienceTicks,
                });
            } catch (_) {
                // A missing tape must never strand the bot: honour the deadline.
                const forced = waitedTicks >= patienceTicks;
                this.nt_dual_lock_entry_decision = {
                    ready: forced,
                    forced,
                    contract: contract === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER',
                    barrier: Number(barrier) || 0,
                    samples: 0,
                    baseline: 0,
                    confidence: 0,
                    threshold: 0,
                    quietTicks: 0,
                    burst: 0,
                    waited: waitedTicks,
                    patience: patienceTicks,
                    state: 'UNKNOWN',
                    reason: forced
                        ? `TIMED ENTRY · ${patienceTicks}-tick patience budget reached — starting the scanned lock`
                        : `TIMING ${waitedTicks}/${patienceTicks} · tick feed unavailable; retrying`,
                };
            }
            return this.nt_dual_lock_entry_decision.ready;
        }

        async ntDualLockEntryDecision(field) {
            const value = this.nt_dual_lock_entry_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'entry timing warming up' : 0) : value;
        }

        /** Safe between-contract retarget: remove the old listener, clear stale
         * proposals and make the next Trade Definition cycle quote the new symbol. */
        async ntSwitchMarket(nextSymbol) {
            const next = String(nextSymbol || '');
            if (!next || next === this.symbol) return false;
            if (this.data?.contract?.status === 'open') {
                globalObserver.emit('ui.log.warn', `Market switch refused while a contract is open (${this.symbol} → ${next})`);
                return false;
            }
            const old = this.symbol;
            if (tickListenerKey) await this.$scope.ticksService.stopMonitor({ symbol: old, key: tickListenerKey });
            this.symbol = undefined;
            await this.watchTicks(next);
            this.options.symbol = next;
            if (this.tradeOptions) this.tradeOptions.symbol = next;
            this.data.proposals = [];
            // Force makeProposals() to regenerate its purchase reference and
            // templates on the next Trade Definition cycle. Keeping the old
            // cache here can purchase a stale quote from the previous market.
            this.trade_option = null;
            this.proposal_templates = [];
            globalObserver.emit('ui.log.info', `Digit Forge switched ${old} → ${next}; stale proposals cleared`);
            return true;
        }

        getLastDigitsFromList(ticks) {
            const digits = ticks.map(tick => {
                return getLastDigit(tick.toFixed(this.getPipSize()));
            });
            return digits;
        }

        checkDirection(dir) {
            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => resolve(getDirection(ticks) === dir))
            );
        }

        getOhlc(args) {
            const { granularity = this.options.candleInterval || 60, field } = args || {};

            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol, granularity })
                    .then(ohlc => resolve(field ? ohlc.map(o => o[field]) : ohlc))
            );
        }

        getOhlcFromEnd(args) {
            const { index: i = 1 } = args || {};

            const index = expectPositiveInteger(Number(i), localize('Index must be a positive integer'));

            return new Promise(resolve => this.getOhlc(args).then(ohlc => resolve(ohlc.slice(-index)[0])));
        }

        getPipSize() {
            return this.$scope.ticksService.pipSizes[this.symbol];
        }

        async requestAccumulatorStats() {
            const subscription_id = this.subscription_id_for_accumulators;
            const is_proposal_requested = this.is_proposal_requested_for_accumulators;
            const proposal_request = {
                ...window.Blockly.accumulators_request,
                amount: this?.tradeOptions?.amount,
                basis: this?.tradeOptions?.basis,
                contract_type: 'ACCU',
                currency: this?.tradeOptions?.currency,
                growth_rate: this?.tradeOptions?.growth_rate,
                proposal: 1,
                subscribe: 1,
                underlying_symbol: this?.tradeOptions?.symbol,
            };
            if (!subscription_id && !is_proposal_requested) {
                this.is_proposal_requested_for_accumulators = true;
                if (proposal_request) {
                    await api_base?.api?.send(proposal_request);
                }
            }
        }

        async handleOnMessageForAccumulators() {
            let ticks_stayed_in_list = [];
            return new Promise(resolve => {
                const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                    if (data.msg_type === 'proposal') {
                        try {
                            this.subscription_id_for_accumulators = data.subscription.id;
                            // this was done because we can multile arrays in the respone and the list comes in reverse order
                            const stat_list = (data.proposal.contract_details.ticks_stayed_in || []).flat().reverse();
                            ticks_stayed_in_list = [...stat_list, ...ticks_stayed_in_list];
                            if (ticks_stayed_in_list.length > 0) resolve(ticks_stayed_in_list);
                        } catch (error) {
                            globalObserver.emit('Unexpected message type or no proposal found:', error);
                        }
                    }
                });
                api_base.pushSubscription(subscription);
            });
        }

        async fetchStatsForAccumulators() {
            try {
                // request stats for accumulators
                const debouncedAccumulatorsRequest = debounce(() => this.requestAccumulatorStats(), 300);
                debouncedAccumulatorsRequest();
                // wait for proposal response
                const ticks_stayed_in_list = await this.handleOnMessageForAccumulators();
                return ticks_stayed_in_list;
            } catch (error) {
                globalObserver.emit('Error in subscription promise:', error);
                throw error;
            } finally {
                // forget all proposal subscriptions so we can fetch new stats data on new call
                await api_base?.api?.send({ forget_all: 'proposal' });
                this.is_proposal_requested_for_accumulators = false;
                this.subscription_id_for_accumulators = null;
            }
        }

        async getCurrentStat() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                return ticks_stayed_in?.[0];
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getStatList() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                // we need to send only lastest 100 ticks
                return ticks_stayed_in?.slice(0, 100);
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getDelayTickValue(tick_value) {
            return new Promise((resolve, reject) => {
                try {
                    const ticks = [];
                    const symbol = this.symbol;

                    const resolveAndExit = () => {
                        this.$scope.ticksService.stopMonitor({
                            symbol,
                            key: '',
                        });
                        resolve(ticks);
                        ticks.length = 0;
                    };

                    const watchTicks = tick_list => {
                        ticks.push(tick_list);
                        const current_tick = ticks.length;
                        if (current_tick === tick_value) {
                            resolveAndExit();
                        }
                    };

                    const delayExecution = tick_list => watchTicks(tick_list);

                    if (Number(tick_value) <= 0) resolveAndExit();
                    this.$scope.ticksService.monitor({ symbol, callback: delayExecution });
                } catch (error) {
                    reject(new Error(`Failed to start tick monitoring: ${error.message}`));
                }
            });
        }
    };
