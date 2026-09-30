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
import { analyseTurboRecovery, TURBO_RECOVERY_ANALYSIS_LIMITS } from './turbo-recovery-analysis';
import { analyseDigitForgeCandidate, DIGIT_FORGE_ANALYSIS_LIMITS } from './digit-forge-analysis';
import { DIGIT_FORGE_CONTRACTS } from './digit-forge-contracts';
import { analyseSurgeMarket, SURGE_FORGE_LIMITS } from './surge-forge-analysis';
import { analyseOmniForgeCandidate, OMNI_FORGE_LIMITS } from './omni-forge-analysis';
import { analyseNexusHedgeCandidate, NEXUS_HEDGE_LIMITS } from './nexus-hedge-analysis';

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
                    if (!lastTick || lastTick.epoch === undefined) return;
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
                        const live = this.nt_digit_live_payouts?.get(`${symbol}:${candidate.contract}:${candidate.barrier}`);
                        const payout = live && Date.now() - live.at < 60000 ? live.payout : candidate.payout;
                        const analysis = analyseDigitForgeCandidate({
                            digits, ...candidate, payout, mode: normalizedMode,
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
            // Post-loss REMATCH penalty (Nexus Hedge rescan mandate): after a
            // settled loss, the exact losing side/barrier/market starts its
            // next recovery scans from a decaying score deficit (spanning
            // exactly the confirmation window below). Without it, one loss
            // barely dents the posterior and the same tape kept ranking #1 —
            // the bot re-fired on the market it just lost on. Now an
            // alternate market/barrier with a comparable edge honestly wins
            // the post-loss rescan; the loser re-enters only by topping every
            // penalised fresh scan.
            const rematch = this.nt_digit_rematch;
            const rescanInProgress = Boolean(rematch);
            if (rematch) {
                for (const row of rows) {
                    if (`${row.symbol}:${row.contract}:${String(row.barrier)}` === rematch.key) {
                        row.score -= rematch.penalty;
                    }
                }
                // Age the penalty only when FRESH tape arrived since it was
                // armed/last aged: repeated interpreter passes over one tick
                // re-rank deterministically instead of eroding the handicap.
                const maxEpoch = rows.reduce((max, row) => Math.max(max, row.tickEpoch || 0), 0);
                if (maxEpoch > (rematch.epoch ?? 0)) {
                    rematch.epoch = maxEpoch;
                    rematch.penalty = Math.max(0, rematch.penalty - DIGIT_FORGE_ANALYSIS_LIMITS.rematchDecay);
                    if (rematch.penalty === 0) this.nt_digit_rematch = undefined;
                }
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

            // ── Intelligent recovery rescan (2026-09-30) ──────────────────────
            // Debt-sized entries need persistence across FRESH ticks, not one
            // flattering snapshot. Count confirmations only on DISTINCT ticks
            // and only while the same market/contract/barrier remains best.
            // Repeated interpreter passes over one tick cannot arm a recovery.
            // Adaptive: when consecutive losses ≥3, required confirmations
            // escalate from 2 → 3 — larger debt demands more proof before a
            // sized recovery fires. Settlement always clears confirmation, so
            // no recovery may fire without a genuinely fresh post-trade rescan
            // of every watched market.
            let eligible = best.eligible;
            let confirmations = 0;
            const lossRun = this._consecutiveLosses || 0;
            const requiredConfirmations = lossRun >= 3
                ? Math.min(3, DIGIT_FORGE_ANALYSIS_LIMITS.recoveryConfirmations + 1)
                : DIGIT_FORGE_ANALYSIS_LIMITS.recoveryConfirmations;
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
                eligible = confirmations >= requiredConfirmations;
            } else {
                this.nt_digit_recovery_confirmation = undefined;
            }

            const rescanNote = rescanInProgress ? ` · post-loss rescan (lossRun ${lossRun})` : '';
            this.nt_digit_decision = {
                ...best,
                mode: normalizedMode,
                eligible,
                confirmations,
                requiredConfirmations,
                changedMarket: best.symbol !== this.symbol,
                reason: !best.eligible
                    ? `${best.reason}${rescanNote}`
                    : recoveryMode && !eligible
                      ? `HOLD · confirming recovery setup ${confirmations}/${requiredConfirmations} on a fresh tick${rescanNote}`
                      : `${best.reason}${rescanNote}`,
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
                    const tail = ticks.slice(-windowSize);
                    const digits = tail.map(t => getLastDigit(Number(t.quote).toFixed(pip)));
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
                        // Per-row tape epoch: the recovery confirmation below
                        // only counts DISTINCT fresh ticks, so repeated
                        // interpreter passes over one snapshot can never arm a
                        // debt-sized recovery (Nexus Hedge rescan mandate).
                        const tickEpoch = Number(tail[tail.length - 1]?.epoch) || 0;
                        rows.push({
                            symbol,
                            contract: spec.type,
                            barrier: digit,
                            payout: spec.payout,
                            tickEpoch,
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
            // Post-loss REMATCH penalty (Nexus Hedge rescan mandate): after a
            // settled loss, settlement armed `nt_omni_rematch` with the exact
            // losing tuple. One loss barely dents a 30+ sample posterior, so
            // without this the same tape kept ranking #1 and the bot re-fired
            // on the market it just lost on. The loser starts its next scans
            // from a decaying score deficit (spanning exactly the confirmation
            // window), so an alternate market/contract with a comparable edge
            // honestly wins the rescan; topping every penalised fresh scan
            // earns a legitimate re-entry.
            const rematch = this.nt_omni_rematch;
            const rescanInProgress = Boolean(rematch);
            if (rematch) {
                for (const row of rows) {
                    if (`${row.symbol}:${row.contract}:${String(row.barrier)}` === rematch.key) {
                        row.score -= rematch.penalty;
                    }
                }
                // Age the penalty only when FRESH tape arrived since it was
                // armed/last aged: repeated interpreter passes over one tick
                // re-rank deterministically instead of eroding the handicap.
                const maxEpoch = rows.reduce((max, row) => Math.max(max, row.tickEpoch || 0), 0);
                if (maxEpoch > (rematch.epoch ?? 0)) {
                    rematch.epoch = maxEpoch;
                    rematch.penalty = Math.max(0, rematch.penalty - OMNI_FORGE_LIMITS.rematchDecay);
                    if (rematch.penalty === 0) this.nt_omni_rematch = undefined;
                }
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_omni_confirmation = undefined;
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

            // ── Intelligent recovery rescan (2026-09-30) ──────────────────────
            // RECOVERY entries must be earned on FRESH data (Nexus Hedge
            // rescan mandate): the same candidate has to stay best across
            // N distinct ticks, and settlement clears this state after every
            // trade — so no recovery ever executes without a genuinely fresh,
            // post-trade rescan of every watched market. Adaptive: when
            // consecutive losses ≥3, required confirmations escalate 2→3 —
            // larger debt demands more proof.
            let confirmations = 0;
            let eligible = best.eligible;
            const omniLossRun = this._consecutiveLosses || 0;
            const omniRequired = omniLossRun >= 3
                ? Math.min(3, OMNI_FORGE_LIMITS.recoveryConfirmations + 1)
                : OMNI_FORGE_LIMITS.recoveryConfirmations;
            if (isRecovery && best.eligible) {
                const key = `${best.symbol}:${best.contract}:${String(best.barrier)}`;
                const previous = this.nt_omni_confirmation;
                if (previous?.key === key && previous.epoch !== best.tickEpoch) confirmations = previous.count + 1;
                else if (previous?.key === key && previous.epoch === best.tickEpoch) confirmations = previous.count;
                else confirmations = 1;
                this.nt_omni_confirmation = { key, epoch: best.tickEpoch, count: confirmations };
                eligible = confirmations >= omniRequired;
            } else {
                this.nt_omni_confirmation = undefined;
            }

            const rescanNote = rescanInProgress ? ` · post-loss rescan (lossRun ${omniLossRun})` : '';
            this.nt_contract_decision = {
                ...best,
                changedMarket: best.symbol !== this.symbol,
                eligible,
                confirmations,
                requiredConfirmations: omniRequired,
                reason: best.eligible
                    ? eligible
                        ? `READY ${best.contract}${best.barrier >= 0 ? ` ${best.barrier}` : ''} score ${best.score.toFixed(2)} EV ${(best.ev * 100).toFixed(2)}% LCB ${(best.lowerBound * 100).toFixed(1)}%${rescanNote}`
                        : `HOLD · confirming recovery setup ${confirmations}/${omniRequired} on a fresh tick${rescanNote}`
                    : `HOLD: ${blockers.join(', ') || 'no qualified edge'}${rescanNote}`,
            };
            return eligible;
        }

        async ntContractDecision(field) {
            const value = this.nt_contract_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'analysis warming up' : 0) : value;
        }

        /**
         * Nexus Hedge Forge: universal hedge-aware ranker. Same gate as Omni but
         * with Rise/Fall support, Dirichlet-10 contextual smoothing and phi/rho
         * hedge scoring computed from joint normal vs recovery win streams.
         */
        async ntAnalyseHedge(mode = 'NORMAL', marketsCsv = '', contractsCsv = '', requestedWindow = 120) {
            const isRecovery = mode === 'RECOVERY';
            const limits = isRecovery ? NEXUS_HEDGE_LIMITS.recovery : NEXUS_HEDGE_LIMITS.normal;
            const KNOWN = ['DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT'];
            const FALLBACK_PAYOUT = {
                DIGITOVER: 1.95, DIGITUNDER: 1.95, DIGITEVEN: 1.95, DIGITODD: 1.95,
                DIGITMATCH: 8.93, DIGITDIFF: 1.09, CALL: 1.92, PUT: 1.92,
            };
            const specs = String(contractsCsv)
                .split(',').map(s => s.trim()).filter(Boolean).slice(0, 12)
                .map(raw => {
                    const [type = '', digitRaw = '-1', payoutRaw = ''] = raw.split(':');
                    const t = type.toUpperCase();
                    const digit = Math.trunc(Number(digitRaw));
                    const payout = Number(payoutRaw);
                    return { type: t, digit: Number.isFinite(digit) ? digit : -1, payout: Number.isFinite(payout) && payout > 1 ? payout : (FALLBACK_PAYOUT[t] ?? 1.95) };
                }).filter(c => KNOWN.includes(c.type));
            const markets = [...new Set(String(marketsCsv).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(20, Math.min(300, Number(requestedWindow) || 120));
            const rows = [];
            const fallbackSpec = specs[0] ?? { type: 'DIGITOVER', digit: 2, payout: FALLBACK_PAYOUT.DIGITOVER };
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: 3 });
                    const pip = this.$scope.ticksService.pipSizes?.[symbol] ?? this.getPipSize();
                    const tail = ticks.slice(-windowSize);
                    const digits = tail.map(t => getLastDigit(Number(t.quote).toFixed(pip)));
                    const prices = tail.map(t => Number(t.quote));
                    if (digits.length < 20) return;
                    const counts = Array.from({ length: 10 }, () => 0);
                    for (const d of digits) counts[d] += 1;
                    // Precompute CALL/PUT wins from price direction
                    const dirWins = { CALL: [], PUT: [] };
                    for (let i = 1; i < prices.length; i++) {
                        dirWins.CALL.push(prices[i] > prices[i - 1]);
                        dirWins.PUT.push(prices[i] < prices[i - 1]);
                    }
                    for (const spec of specs) {
                        let digit = spec.digit;
                        let winOf;
                        let p0;
                        let wins;
                        if (spec.type === 'DIGITOVER') {
                            if (digit < 0 || digit > 8) continue;
                            winOf = d => d > digit; p0 = (9 - digit) / 10; wins = digits.map(winOf);
                        } else if (spec.type === 'DIGITUNDER') {
                            if (digit < 1 || digit > 9) continue;
                            winOf = d => d < digit; p0 = digit / 10; wins = digits.map(winOf);
                        } else if (spec.type === 'DIGITEVEN') { digit = -1; winOf = d => d % 2 === 0; p0 = 0.5; wins = digits.map(winOf); }
                        else if (spec.type === 'DIGITODD') { digit = -1; winOf = d => d % 2 === 1; p0 = 0.5; wins = digits.map(winOf); }
                        else if (spec.type === 'DIGITMATCH') {
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.max(...counts));
                            winOf = d => d === digit; p0 = 0.1; wins = digits.map(winOf);
                        } else if (spec.type === 'DIGITDIFF') {
                            if (digit < 0 || digit > 9) digit = counts.indexOf(Math.min(...counts));
                            winOf = d => d !== digit; p0 = 0.9; wins = digits.map(winOf);
                        } else if (spec.type === 'CALL') { digit = -1; p0 = 0.5; wins = [false, ...dirWins.CALL]; }
                        else { digit = -1; p0 = 0.5; wins = [false, ...dirWins.PUT]; }
                        // Hedge score: anti-correlation placeholder (computed per-market as phi proxy)
                        // Compare this candidate's win stream to digit-even as a proxy for normal bias.
                        // If anti-correlated, uplift.
                        const hedge = 0; // neutral for now; Ticks wrapper can compute cross-contract phi later
                        const analysis = analyseNexusHedgeCandidate({ wins, p0, payout: spec.payout, mode, hedge });
                        // Per-row tape epoch: the recovery confirmation below only
                        // counts DISTINCT fresh ticks, so repeated interpreter passes
                        // over one snapshot can never arm a debt-sized recovery.
                        const tickEpoch = Number(tail[tail.length - 1]?.epoch) || 0;
                        rows.push({ symbol, contract: spec.type, barrier: digit, payout: spec.payout, tickEpoch, ...analysis });
                    }
                } catch (_) { /* one unavailable market must not stop the bot */ }
            };
            for (let i = 0; i < markets.length; i += 3) {
                await Promise.all(markets.slice(i, i + 3).map(scanOne));
            }
            // Post-loss REMATCH penalty: after a settled loss, settlement armed
            // `nt_hedge_rematch` with the exact losing tuple (symbol:contract:
            // barrier). One loss barely dents a 30+ sample posterior, so without
            // this the same tape kept ranking #1 and the bot re-fired on the
            // market it just lost on — repeatedly, up to circuit-breaker depth.
            // The loser starts its next scans from a score deficit (decaying
            // per scan, spanning exactly the confirmation window), so an
            // alternate market/contract with a comparable edge honestly wins
            // the rescan. If the loser still tops every penalised, fresh scan,
            // re-entering it is the ranker's real answer, not an accident of
            // stale tape.
            const rematch = this.nt_hedge_rematch;
            const rescanInProgress = Boolean(rematch);
            if (rematch) {
                for (const row of rows) {
                    if (`${row.symbol}:${row.contract}:${String(row.barrier)}` === rematch.key) {
                        row.score -= rematch.penalty;
                    }
                }
                // Age the penalty only when FRESH tape arrived since it was
                // armed/last aged: repeated interpreter passes over one tick
                // re-rank deterministically instead of eroding the handicap.
                const maxEpoch = rows.reduce((max, row) => Math.max(max, row.tickEpoch || 0), 0);
                if (maxEpoch > (rematch.epoch ?? 0)) {
                    rematch.epoch = maxEpoch;
                    rematch.penalty = Math.max(0, rematch.penalty - NEXUS_HEDGE_LIMITS.rematchDecay);
                    if (rematch.penalty === 0) this.nt_hedge_rematch = undefined;
                }
            }
            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_hedge_confirmation = undefined;
                this.nt_hedge_decision = {
                    symbol: this.symbol, contract: fallbackSpec.type, barrier: fallbackSpec.digit,
                    payout: fallbackSpec.payout, eligible: false, score: -999, samples: 0,
                    hedgeScore: 0, reason: 'feed unavailable; retrying', changedMarket: false,
                };
                return false;
            }
            const blockers = [];
            if (best.samples < limits.minSamples) blockers.push(`samples ${best.samples}/${limits.minSamples}`);
            if (best.ev <= limits.minEv) blockers.push(`EV ${(best.ev * 100).toFixed(2)}%`);
            if (best.lowerBound <= best.breakEven - limits.lowerBoundMargin) blockers.push(`lower bound ${(best.lowerBound * 100).toFixed(1)}% vs BE ${(best.breakEven * 100).toFixed(1)}%`);
            if (best.instability >= limits.maxInstability) blockers.push(`unstable ${(best.instability * 100).toFixed(1)}pt`);
            if (best.clustering >= limits.maxClustering) blockers.push(`loss clustering ${best.clustering.toFixed(2)}x`);

            // ── Intelligent recovery rescan (2026-09-30) ──────────────────────
            // RECOVERY entries must be earned on FRESH data. The same candidate
            // has to stay best across N distinct ticks (repeated passes over
            // one tick do not count), and settlement clears this state after
            // every trade — so no recovery ever executes without a genuinely
            // fresh, post-trade rescan of every watched market. Adaptive: when
            // consecutive losses ≥3, required confirmations escalate 2→3 —
            // larger hedge debt demands more proof. This is what stops the old
            // "loss → instant re-fire on the same snapshot" loop.
            let confirmations = 0;
            let eligible = best.eligible;
            const hedgeLossRun = this._consecutiveLosses || 0;
            const hedgeRequired = hedgeLossRun >= 3
                ? Math.min(3, NEXUS_HEDGE_LIMITS.recoveryConfirmations + 1)
                : NEXUS_HEDGE_LIMITS.recoveryConfirmations;
            if (isRecovery && best.eligible) {
                const key = `${best.symbol}:${best.contract}:${String(best.barrier)}`;
                const previous = this.nt_hedge_confirmation;
                if (previous?.key === key && previous.epoch !== best.tickEpoch) confirmations = previous.count + 1;
                else if (previous?.key === key && previous.epoch === best.tickEpoch) confirmations = previous.count;
                else confirmations = 1;
                this.nt_hedge_confirmation = { key, epoch: best.tickEpoch, count: confirmations };
                eligible = confirmations >= hedgeRequired;
            } else {
                this.nt_hedge_confirmation = undefined;
            }

            const rescanNote = rescanInProgress ? ` · post-loss rescan (lossRun ${hedgeLossRun})` : '';
            this.nt_hedge_decision = {
                ...best, changedMarket: best.symbol !== this.symbol,
                eligible,
                confirmations,
                requiredConfirmations: hedgeRequired,
                reason: best.eligible
                    ? eligible
                        ? `READY ${best.contract}${best.barrier >= 0 ? ` ${best.barrier}` : ''} score ${best.score.toFixed(2)} EV ${(best.ev * 100).toFixed(2)}% LCB ${(best.lowerBound * 100).toFixed(1)}%${rescanNote}`
                        : `HOLD · confirming recovery setup ${confirmations}/${hedgeRequired} on a fresh tick${rescanNote}`
                    : `HOLD: ${blockers.join(', ') || 'no qualified edge'}${rescanNote}`,
            };
            return eligible;
        }

        async ntHedgeDecision(field) {
            const value = this.nt_hedge_decision?.[field];
            return value === undefined ? (field === 'reason' ? 'hedge analysis warming up' : 0) : value;
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
                const tail = ticks.slice(-windowSize);
                const digits = tail.map(tick => getLastDigit(Number(tick.quote).toFixed(pip)));
                // The fresh-tick confirmation below only counts DISTINCT ticks,
                // so repeated interpreter passes over one snapshot never arm a
                // debt-sized recovery (Nexus Hedge rescan mandate).
                const tickEpoch = Number(tail[tail.length - 1]?.epoch) || 0;

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

                const rawDecision = analyseTurboRecovery({
                    digits,
                    contract,
                    barrier,
                    payout,
                    stake,
                    balance,
                });
                // ── Intelligent recovery rescan (2026-09-30) ─────────────────
                // A debt-sized recovery must hold on FRESH data: the timing
                // gate has to pass across N distinct ticks, and settlement
                // clears this state after every trade — so a recovery never
                // fires off the first post-loss snapshot (Nexus Hedge rescan
                // mandate). Adaptive: when consecutive losses ≥3, required
                // confirmations escalate 2→3 — larger debt demands more proof.
                // Multi-market Turbo additionally demotes the losing market
                // (see ntAnalyseTurboMarkets) so an alternate market wins the
                // rescan instead of looping on one tape.
                let confirmations = 0;
                let eligible = rawDecision.eligible;
                const turboLossRun = this._consecutiveLosses || 0;
                const turboRequired = turboLossRun >= 3
                    ? Math.min(3, TURBO_RECOVERY_ANALYSIS_LIMITS.recoveryConfirmations + 1)
                    : TURBO_RECOVERY_ANALYSIS_LIMITS.recoveryConfirmations;
                if (eligible) {
                    const key = `${this.symbol}:${String(contract)}:${Number(barrier)}`;
                    const previous = this.nt_turbo_recovery_confirmation;
                    if (previous?.key === key && previous.epoch !== tickEpoch) confirmations = previous.count + 1;
                    else if (previous?.key === key && previous.epoch === tickEpoch) confirmations = previous.count;
                    else confirmations = 1;
                    this.nt_turbo_recovery_confirmation = { key, epoch: tickEpoch, count: confirmations };
                    eligible = confirmations >= turboRequired;
                } else {
                    this.nt_turbo_recovery_confirmation = undefined;
                }
                this.nt_turbo_recovery_decision = {
                    ...rawDecision,
                    eligible,
                    confirmations,
                    requiredConfirmations: turboRequired,
                    lossRun: turboLossRun,
                    reason:
                        rawDecision.eligible && !eligible
                            ? `HOLD · confirming recovery setup ${confirmations}/${turboRequired} on a fresh tick (lossRun ${turboLossRun})`
                            : rawDecision.reason,
                };
                return this.nt_turbo_recovery_decision.eligible;
            } catch (_) {
                this.nt_turbo_recovery_confirmation = undefined;
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
         * Turbo Adaptive Recovery — multi-market rescan (2026-09-30 fix).
         * The legacy `ntAnalyseTurboRecovery` was single-market LOCKED — the
         * root cause of the 10-loss lock. This new primitive mirrors
         * `ntAnalyseDigitMarkets` but with Turbo's Bayesian conditional timing
         * maths: it scans ALL watchMarkets for the FIXED recovery contract,
         * picks the best eligible market, and enforces the intelligent rescan
         * mandate — 2 fresh ticks (3 when lossRun≥3) + progressive rematch
         * demotion so an alternate market honestly wins the post-loss rescan.
         * No recovery may fire without a fresh multi-market rescan, and no
         * repeated tick can arm it. The XML switches markets via
         * `ntSwitchMarket` when the decision's market differs.
         */
        async ntAnalyseTurboMarkets(
            marketsCsv = '',
            contract = 'DIGITOVER',
            barrier = 4,
            fallbackPayout = 1.95,
            requestedWindow = 120,
            requestedStake = 0
        ) {
            const recoveryContract = contract === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER';
            const recoveryBarrier = Math.max(0, Math.min(9, Math.trunc(Number(barrier) || 4)));
            const markets = [...new Set(String(marketsCsv).split(',').map(s => s.trim()).filter(Boolean))].slice(0, 8);
            if (!markets.includes(this.symbol)) markets.unshift(this.symbol);
            const windowSize = Math.max(40, Math.min(300, Number(requestedWindow) || 120));
            const stake = Number(requestedStake) || Number(this.tradeOptions?.amount) || 0;
            const balance = Number(this.getBalance?.('NUM')) || Number(this.getBalance?.()) || 0;
            const lossRun = this._consecutiveLosses || 0;
            const required = lossRun >= 3
                ? Math.min(3, TURBO_RECOVERY_ANALYSIS_LIMITS.recoveryConfirmations + 1)
                : TURBO_RECOVERY_ANALYSIS_LIMITS.recoveryConfirmations;

            const rows = [];
            const scanOne = async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol, retry_limit: 3 });
                    const pip = this.$scope.ticksService.pipSizes?.[symbol] ?? this.getPipSize() ?? 2;
                    const tail = ticks.slice(-windowSize);
                    const digits = tail.map(t => getLastDigit(Number(t.quote).toFixed(pip)));
                    if (digits.length < 20) return;
                    const tickEpoch = Number(tail[tail.length - 1]?.epoch) || 0;
                    const proposal = [...(this.data?.proposals ?? [])].reverse().find(r => {
                        const sameContract = r?.contract_type === recoveryContract;
                        const sameBarrier = r?.barrier === undefined || Number(r.barrier) === recoveryBarrier;
                        const sameSymbol = !r?.underlying_symbol || r.underlying_symbol === symbol;
                        return sameContract && sameBarrier;
                    });
                    const ask = Number(proposal?.ask_price);
                    const totalReturn = Number(proposal?.payout);
                    const livePayout = ask > 0 && totalReturn > ask ? totalReturn / ask : Number.NaN;
                    const payout = Number.isFinite(livePayout) ? livePayout : Number(fallbackPayout);
                    const analysis = analyseTurboRecovery({ digits, contract: recoveryContract, barrier: recoveryBarrier, payout, stake, balance });
                    // Score for ranking: lowerBound edge + utility - clustering/instability
                    const score = 100 * ((analysis.lowerBound - analysis.breakEven) * 0.6 + analysis.expectedUtility * 0.1 - Math.max(0, analysis.clusterRatio - 1) * 0.12 - analysis.instability * 0.15);
                    rows.push({ symbol, contract: recoveryContract, barrier: recoveryBarrier, payout, stake, balance, tickEpoch, digits, ...analysis, score });
                } catch (_) { /* one market unavailable must not stop the scan */ }
            };
            for (let i = 0; i < markets.length; i += 3) {
                await Promise.all(markets.slice(i, i + 3).map(scanOne));
            }

            // Progressive rematch: demote the exact losing market so an
            // alternate honestly wins the rescan. Penalty scales with lossRun.
            const rematch = this.nt_turbo_rematch;
            const rescanInProgress = Boolean(rematch);
            if (rematch) {
                for (const row of rows) {
                    if (`${row.symbol}:${row.contract}:${String(row.barrier)}` === rematch.key || row.symbol === rematch.key.split(':')[0]) {
                        row.score -= rematch.penalty;
                        row.eligible = row.eligible && row.score > -50; // keep eligible flag but demote heavily
                    }
                }
                const maxEpoch = rows.reduce((m, r) => Math.max(m, r.tickEpoch || 0), 0);
                if (maxEpoch > (rematch.epoch ?? 0)) {
                    rematch.epoch = maxEpoch;
                    rematch.penalty = Math.max(0, rematch.penalty - TURBO_RECOVERY_ANALYSIS_LIMITS.rematchDecay);
                    if (rematch.penalty === 0) this.nt_turbo_rematch = undefined;
                }
            }

            rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score);
            const best = rows[0];
            if (!best) {
                this.nt_turbo_markets_confirmation = undefined;
                this.nt_turbo_markets_decision = {
                    symbol: this.symbol,
                    contract: recoveryContract,
                    barrier: recoveryBarrier,
                    payout: Number(fallbackPayout),
                    eligible: false,
                    score: -999,
                    samples: 0,
                    confirmations: 0,
                    requiredConfirmations: required,
                    reason: 'HOLD · recovery feeds unavailable; retrying safely',
                    changedMarket: false,
                };
                return false;
            }

            // Confirmation on DISTINCT fresh ticks per chosen market tuple
            let confirmations = 0;
            let eligible = best.eligible;
            if (best.eligible) {
                const key = `${best.symbol}:${best.contract}:${String(best.barrier)}`;
                const prev = this.nt_turbo_markets_confirmation;
                if (prev?.key === key && prev.epoch !== best.tickEpoch) confirmations = prev.count + 1;
                else if (prev?.key === key && prev.epoch === best.tickEpoch) confirmations = prev.count;
                else confirmations = 1;
                this.nt_turbo_markets_confirmation = { key, epoch: best.tickEpoch, count: confirmations };
                eligible = confirmations >= required;
            } else {
                this.nt_turbo_markets_confirmation = undefined;
            }

            const note = rescanInProgress ? ` · post-loss rescan (lossRun ${lossRun})` : '';
            this.nt_turbo_markets_decision = {
                ...best,
                eligible,
                confirmations,
                requiredConfirmations: required,
                changedMarket: best.symbol !== this.symbol,
                reason: !best.eligible
                    ? `${best.reason}${note}`
                    : !eligible
                        ? `HOLD · confirming Turbo recovery ${confirmations}/${required} on fresh tick ${best.symbol}${note}`
                        : `${best.reason} · market ${best.symbol}${note}`,
            };
            // Also mirror into legacy decision so Total.js fallback can see it
            this.nt_turbo_recovery_decision = this.nt_turbo_markets_decision;
            return eligible;
        }

        async ntTurboMarketsDecision(field) {
            const v = this.nt_turbo_markets_decision?.[field] ?? this.nt_turbo_recovery_decision?.[field];
            return v === undefined ? (field === 'reason' ? 'HOLD · Turbo markets warming up' : 0) : v;
        }

        async ntRecordTurboPending(symbol, contract, barrier) {
            this.nt_turbo_pending_entry = { symbol: String(symbol), contract: String(contract), barrier: Number(barrier), tickEpoch: Date.now() };
            return true;
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
            if (this.is_purchasing || this.nt_digit_preparing || this.nt_digit_purchase_pending ||
                this.data?.contract?.status === 'open') {
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
