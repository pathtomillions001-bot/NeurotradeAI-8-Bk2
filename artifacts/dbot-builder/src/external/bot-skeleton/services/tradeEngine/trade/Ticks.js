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
import { analyseDigitForgeCandidate, DIGIT_FORGE_ANALYSIS_LIMITS } from './digit-forge-analysis';
import { DIGIT_FORGE_CONTRACTS } from './digit-forge-contracts';
import { analyseSurgeMarket, SURGE_FORGE_LIMITS } from './surge-forge-analysis';
import { analyseOmniForgeCandidate, OMNI_FORGE_LIMITS } from './omni-forge-analysis';

let tickListenerKey;
// The symbol `tickListenerKey` belongs to. Without it, `watchTicks` asked the
// ticks service to stop the NEW symbol's monitor using the OLD symbol's key —
// a no-op that silently left the previous monitor registered.
let tickListenerSymbol;

// Proposal ids expire server-side within seconds. Once proposals are ready we
// no longer re-select them on EVERY tick (stock deriv-bot does, burning CPU on
// redux dispatches and template scans), but we refresh on this cadence so a
// bot that idles between entries never tries to buy a long-dead proposal id.
const PROPOSAL_REFRESH_INTERVAL_MS = 4000;
const isValidTick = tick => tick && Number.isFinite(Number(tick.epoch)) && Number.isFinite(Number(tick.quote));

export default Engine =>
    class Ticks extends Engine {
        /**
         * Proposal hygiene gate for the per-tick callback: real work only while
         * proposals are pending, plus a low-frequency keepalive after that.
         */
        shouldCheckProposalReadiness() {
            if (!this.is_proposal_subscription_required) return false;
            if (!this.store.getState().proposalsReady) return true;
            return Date.now() - (this.nt_last_proposal_check || 0) >= PROPOSAL_REFRESH_INTERVAL_MS;
        }

        async watchTicks(symbol) {
            if (symbol && this.symbol !== symbol) {
                const previous = tickListenerSymbol ?? this.symbol;
                this.symbol = symbol;
                const { ticksService } = this.$scope;

                if (tickListenerKey && previous) {
                    await ticksService.stopMonitor({
                        symbol: previous,
                        key: tickListenerKey,
                    });
                }
                const callback = ticks => {
                    if (this.shouldCheckProposalReadiness()) {
                        this.nt_last_proposal_check = Date.now();
                        this.checkProposalReady();
                    }
                    const lastTick = Array.isArray(ticks) ? ticks[ticks.length - 1] : undefined;
                    // A tape can be momentarily empty (a stream that was just
                    // re-subscribed). Destructuring `undefined` here threw
                    // inside the tick callback, which killed the listener and
                    // left the bot waiting for a tick that never came.
                    if (!isValidTick(lastTick)) return;
                    const { scope } = this.store.getState();
                    this.run_metrics?.recordTick(
                        scope === constants.BEFORE_PURCHASE
                            ? 'armed'
                            : scope === constants.DURING_PURCHASE
                              ? 'busy'
                              : 'idle'
                    );
                    this.store.dispatch({ type: constants.NEW_TICK, payload: lastTick.epoch });
                };

                const key = await ticksService.monitor({ symbol, callback });
                tickListenerKey = key;
                tickListenerSymbol = symbol;
            }
        }

        checkTicksPromiseExists() {
            return this.$scope.ticksService.ticks_history_promise;
        }

        getTicks(toString = false) {
            return new Promise(resolve => {
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => {
                        const ticks_list = (Array.isArray(ticks) ? ticks : []).filter(isValidTick).map(tick => {
                            if (toString) {
                                return Number(tick.quote).toFixed(this.getPipSize());
                            }
                            return Number(tick.quote);
                        });

                        resolve(ticks_list);
                    })
                    .catch(() => resolve([]));
            });
        }

        getLastTick(raw, toString = false) {
            return new Promise((resolve, reject) =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => {
                        try {
                            const validTicks = (Array.isArray(ticks) ? ticks : []).filter(isValidTick);
                            const last = getLast(validTicks);
                            if (!last) {
                                resolve(undefined);
                                return;
                            }
                            let last_tick = raw ? last : Number(last.quote);
                            if (!raw && toString) {
                                last_tick = last_tick.toFixed(this.getPipSize());
                            }
                            resolve(last_tick);
                        } catch (error) {
                            reject(error);
                        }
                    })
                    .catch(e => {
                        if (e?.code === 'MarketIsClosed') {
                            const localizedError = {
                                ...e,
                                message: getLocalizedErrorMessage(e.code, e.details),
                            };
                            globalObserver.emit('Error', localizedError);
                            resolve(e.code);
                            return;
                        }
                        resolve(undefined);
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
         * Score = recency-weighted posterior edge + loss-conditioned edge -
         * instability - clustering - adverse-run risk. A Beta prior shrinks
         * short tapes toward uniform digit odds. Recovery additionally requires
         * short/medium-window agreement and the same candidate to qualify on two
         * distinct ticks, so a debt-sized buy cannot fire on one noisy snapshot.
         */
        async ntAnalyseDigitMarkets(mode = 'NORMAL', csv = '', requestedWindow = 120) {
            const recoveryMode = String(mode).toUpperCase() === 'RECOVERY';
            const normalizedMode = recoveryMode ? 'RECOVERY' : 'NORMAL';
            const candidates = DIGIT_FORGE_CONTRACTS[normalizedMode];
            this.nt_digit_prepared = null;
            const markets = [
                ...new Set(
                    String(csv)
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                ),
            ].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(50, Math.min(300, Number(requestedWindow) || 120));
            const rows = [];
            const SCAN_BATCH = 3;
            const SCAN_RETRY_LIMIT = 3;
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: SCAN_RETRY_LIMIT });
                    const pip = this.$scope.ticksService.pipSizes?.[symbol] ?? this.getPipSize();
                    const tail = ticks.slice(-windowSize);
                    const digits = tail.map(t => getLastDigit(Number(t.quote).toFixed(pip)));
                    if (digits.length < 20) return;
                    const tickEpoch = Number(tail[tail.length - 1]?.epoch) || 0;
                    for (const candidate of candidates) {
                        const live = this.nt_digit_live_payouts?.get(
                            `${symbol}:${candidate.contract}:${candidate.barrier}`
                        );
                        const payout = live && Date.now() - live.at < 60000 ? live.payout : candidate.payout;
                        const analysis = analyseDigitForgeCandidate({
                            digits,
                            ...candidate,
                            payout,
                            mode: normalizedMode,
                        });
                        rows.push({ symbol, ...candidate, payout, ...analysis, tickEpoch, digits });
                    }
                } catch (_) {
                    /* one unavailable market must not stop the bot */
                }
            };
            for (let i = 0; i < markets.length; i += SCAN_BATCH) {
                await Promise.all(markets.slice(i, i + SCAN_BATCH).map(scanOne));
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_digit_recovery_confirmation = undefined;
                this.nt_digit_decision = {
                    mode: normalizedMode,
                    symbol: this.symbol,
                    contract: 'DIGITOVER',
                    barrier: recoveryMode ? 5 : 2,
                    payout: recoveryMode ? 2.43 : 1.4,
                    eligible: false,
                    score: -999,
                    samples: 0,
                    reason: 'feed unavailable; retrying',
                    changedMarket: false,
                };
                return false;
            }

            // Debt-sized entries need persistence, not one flattering snapshot.
            // Count confirmations only on DISTINCT ticks and only while the same
            // market/contract/barrier remains best. Repeated interpreter passes
            // over one tick therefore cannot accidentally arm a recovery buy.
            let eligible = best.eligible;
            let confirmations = 0;
            if (recoveryMode && best.eligible) {
                const key = `${best.symbol}:${best.contract}:${best.barrier}`;
                const previous = this.nt_digit_recovery_confirmation;
                if (previous?.key === key && previous.epoch !== best.tickEpoch) {
                    confirmations = previous.count + 1;
                } else if (previous?.key === key && previous.epoch === best.tickEpoch) {
                    confirmations = previous.count;
                } else {
                    confirmations = 1;
                }
                this.nt_digit_recovery_confirmation = { key, epoch: best.tickEpoch, count: confirmations };
                eligible = confirmations >= DIGIT_FORGE_ANALYSIS_LIMITS.recoveryConfirmations;
            } else {
                this.nt_digit_recovery_confirmation = undefined;
            }

            this.nt_digit_decision = {
                ...best,
                mode: normalizedMode,
                eligible,
                confirmations,
                changedMarket: best.symbol !== this.symbol,
                reason: !best.eligible
                    ? best.reason
                    : recoveryMode && !eligible
                      ? `HOLD · confirming recovery setup ${confirmations}/${DIGIT_FORGE_ANALYSIS_LIMITS.recoveryConfirmations} on a fresh tick`
                      : best.reason,
            };
            return eligible;
        }

        async ntDigitDecision(field) {
            const value = this.nt_digit_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'analysis warming up' : 0) : value;
        }

        /**
         * Vector Surge DBot: rank Rise and Fall on every watched market using
         * recency-Bayes, order-1/2 Markov, empirical run hazard, robust drift,
         * multi-horizon agreement and explicit loss-pair risk. Both normal and
         * recovery require the same candidate on two distinct ticks; this
         * prevents one transient quote or repeated interpreter pass from firing.
         */
        async ntAnalyseSurgeMarkets(
            mode = 'NORMAL',
            csv = '',
            requestedWindow = 240,
            weightsCsv = '',
            tau = 1,
            payout = 1.92
        ) {
            const markets = [
                ...new Set(
                    String(csv)
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                ),
            ].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(100, Math.min(500, Number(requestedWindow) || 240));
            const weights = String(weightsCsv).split(':').map(Number);
            const normalizedMode = String(mode).toUpperCase() === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
            const rows = [];
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: 3 });
                    const tail = ticks.slice(-windowSize);
                    const prices = tail.map(tick => Number(tick.quote));
                    const analysis = analyseSurgeMarket({ prices, payout, mode: normalizedMode, weights, tau });
                    rows.push({
                        symbol,
                        ...analysis,
                        tickEpoch: Number(tail[tail.length - 1]?.epoch) || 0,
                    });
                } catch (_) {
                    /* one unavailable market never stops the DBot */
                }
            };
            for (let index = 0; index < markets.length; index += 3) {
                await Promise.all(markets.slice(index, index + 3).map(scanOne));
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_surge_confirmation = undefined;
                this.nt_surge_decision = {
                    symbol: this.symbol,
                    contract: 'CALL',
                    payout: Number(payout) > 1 ? Number(payout) : 1.92,
                    eligible: false,
                    confirmations: 0,
                    score: -999,
                    reason: 'HOLD · price feeds unavailable; retrying safely',
                    changedMarket: false,
                };
                return false;
            }

            let confirmations = 0;
            let eligible = false;
            if (best.eligible) {
                const key = `${normalizedMode}:${best.symbol}:${best.contract}`;
                const previous = this.nt_surge_confirmation;
                if (previous?.key === key && previous.epoch !== best.tickEpoch) confirmations = previous.count + 1;
                else if (previous?.key === key && previous.epoch === best.tickEpoch) confirmations = previous.count;
                else confirmations = 1;
                this.nt_surge_confirmation = { key, epoch: best.tickEpoch, count: confirmations };
                eligible = confirmations >= SURGE_FORGE_LIMITS.confirmations;
            } else {
                this.nt_surge_confirmation = undefined;
            }
            this.nt_surge_decision = {
                ...best,
                eligible,
                confirmations,
                // Never churn markets for an ineligible score. Switch only
                // when the destination already clears every raw risk gate;
                // fresh-tick confirmation completes after the safe retarget.
                changedMarket: best.eligible && best.symbol !== this.symbol,
                reason:
                    best.eligible && !eligible
                        ? `HOLD · confirming ${best.contract === 'CALL' ? 'Rise' : 'Fall'} on fresh tick ${confirmations}/${SURGE_FORGE_LIMITS.confirmations}`
                        : best.reason,
            };
            return eligible;
        }

        async ntSurgeDecision(field) {
            const value = this.nt_surge_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'surge analysis warming up' : 0) : value;
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
         *
         * CLUSTERING GUARD (see analyseOmniForgeCandidate): the ratio divides
         * by the tape's own loss rate, which collapses exactly when a leg is
         * about to qualify — Over 0 / Under 9 / Differs price at ~1.09× so
         * their break-even (91.7%) only admits tapes with ≤ 8% losses. Below
         * ~OMNI_FORGE_MIN_CLUSTER_LOSSES observed losses the add-one-smoothed
         * P(loss|loss) is pure smoothing noise ((ll+1)/(ll+lw+2) reads
         * ≈ 1/(losses+2) no matter how losses are arranged) divided by a
         * near-zero reference, so the penalty could NEVER pass and those legs
         * were mathematically barred from normal mode. With too few losses to
         * measure clustering the statistic is treated as neutral (1); the EV
         * and Wilson bounds still refuse weak tapes on their own.
         */
        async ntAnalyseContracts(mode = 'NORMAL', marketsCsv = '', contractsCsv = '', requestedWindow = 120) {
            const isRecovery = mode === 'RECOVERY';
            const limits = isRecovery ? OMNI_FORGE_LIMITS.recovery : OMNI_FORGE_LIMITS.normal;
            const KNOWN = ['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF'];
            const FALLBACK_PAYOUT = {
                DIGITOVER: 1.95,
                DIGITUNDER: 1.95,
                DIGITEVEN: 1.95,
                DIGITODD: 1.95,
                DIGITMATCH: 8.93,
                DIGITDIFF: 1.09,
            };
            const specs = String(contractsCsv)
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .slice(0, 12)
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
            const markets = [
                ...new Set(
                    String(marketsCsv)
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean)
                ),
            ].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(20, Math.min(300, Number(requestedWindow) || 120));
            const rows = [];
            const fallbackSpec = specs[0] ?? {
                type: 'DIGITOVER',
                digit: isRecovery ? 4 : 2,
                payout: FALLBACK_PAYOUT.DIGITOVER,
            };
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
                            winOf = d => d > digit;
                            p0 = (9 - digit) / 10;
                        } else if (spec.type === 'DIGITUNDER') {
                            if (digit < 1 || digit > 9) continue;
                            winOf = d => d < digit;
                            p0 = digit / 10;
                        } else if (spec.type === 'DIGITEVEN') {
                            digit = -1;
                            winOf = d => d % 2 === 0;
                            p0 = 0.5;
                        } else if (spec.type === 'DIGITODD') {
                            digit = -1;
                            winOf = d => d % 2 === 1;
                            p0 = 0.5;
                        } else if (spec.type === 'DIGITMATCH') {
                            // Auto (−1): the hottest digit of this tape.
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.max(...counts));
                            winOf = d => d === digit;
                            p0 = 0.1;
                        } else {
                            // DIGITDIFF — auto (−1): the coldest digit of this tape.
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.min(...counts));
                            winOf = d => d !== digit;
                            p0 = 0.9;
                        }
                        const wins = digits.map(winOf);
                        // All per-candidate maths lives in the pure module so
                        // the exact runtime gate is jest-testable and can be
                        // mirrored by the API's forge-time diagnostics.
                        const analysis = analyseOmniForgeCandidate({ wins, p0, payout: spec.payout, mode });
                        rows.push({
                            symbol,
                            contract: spec.type,
                            barrier: digit,
                            payout: spec.payout,
                            ...analysis,
                        });
                    }
                } catch (_) {
                    /* one unavailable market must not stop the bot */
                }
            };
            for (let i = 0; i < markets.length; i += SCAN_BATCH) {
                await Promise.all(markets.slice(i, i + SCAN_BATCH).map(scanOne));
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_contract_decision = {
                    symbol: this.symbol,
                    contract: fallbackSpec.type,
                    barrier: fallbackSpec.digit,
                    payout: fallbackSpec.payout,
                    eligible: false,
                    score: -999,
                    samples: 0,
                    reason: 'feed unavailable; retrying',
                    changedMarket: false,
                };
                return false;
            }
            const blockers = [];
            if (best.samples < limits.minSamples) blockers.push(`samples ${best.samples}/${limits.minSamples}`);
            if (best.ev <= limits.minEv) blockers.push(`EV ${(best.ev * 100).toFixed(2)}%`);
            if (best.lowerBound <= best.breakEven - limits.lowerBoundMargin)
                blockers.push(
                    `lower bound ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`
                );
            if (best.instability >= limits.maxInstability)
                blockers.push(`unstable ${(best.instability * 100).toFixed(1)}pt`);
            if (best.clustering >= limits.maxClustering)
                blockers.push(`loss clustering ${best.clustering.toFixed(2)}x`);
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
                const digits = ticks.slice(-windowSize).map(tick => getLastDigit(Number(tick.quote).toFixed(pip)));

                // Prefer the proposal currently prepared by Trade Definition.
                // Its payout/ask ratio is the true live total-return multiplier;
                // the API-quoted seed remains a conservative availability fallback.
                const proposal = [...(this.data?.proposals ?? [])].reverse().find(row => {
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

        async ntAnalyseBastionEntry(...args) {
            const ready = await this.ntAnalyseDualLockEntry(...args);
            this.nt_bastion_entry_decision = this.nt_dual_lock_entry_decision;
            return ready;
        }

        async ntBastionEntryDecision(field) {
            const value = this.nt_bastion_entry_decision?.[field] ?? this.nt_dual_lock_entry_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'Bastion entry timing warming up' : 0) : value;
        }

        /** Safe between-contract retarget: remove the old listener, clear stale
         * proposals and make the next Trade Definition cycle quote the new symbol. */
        async ntSwitchMarket(nextSymbol) {
            const next = String(nextSymbol || '');
            if (!next || next === this.symbol) return false;
            if (
                this.is_purchasing ||
                this.nt_digit_preparing ||
                this.nt_digit_purchase_pending ||
                this.data?.contract?.status === 'open'
            ) {
                globalObserver.emit(
                    'ui.log.warn',
                    `Market switch refused while a trade is being prepared or is open (${this.symbol} → ${next})`
                );
                return false;
            }
            const old = this.symbol;
            try {
                if (tickListenerKey && tickListenerSymbol) {
                    await this.$scope.ticksService.stopMonitor({ symbol: tickListenerSymbol, key: tickListenerKey });
                }
                this.symbol = undefined;
                await this.watchTicks(next);
            } catch (error) {
                // Roll back. Leaving `this.symbol` undefined (the old failure
                // mode) broke every later tape read, and the bot stopped
                // trading with no explanation. Staying on the previous market
                // costs nothing: the ranker simply proposes the switch again.
                this.symbol = undefined;
                try {
                    await this.watchTicks(old);
                } catch (_) {
                    this.symbol = old;
                }
                globalObserver.emit('ui.log.warn', `Market switch to ${next} failed — staying on ${old}`);
                return false;
            }
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
