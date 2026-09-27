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
            await Promise.all(markets.map(async symbol => {
                try {
                    const ticks = await this.$scope.ticksService.request({ symbol });
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
            }));
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
