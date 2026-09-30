import { getRoundedNumber } from '@/components/shared';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { info, log } from '../utils/broadcast';
import { NEXUS_HEDGE_LIMITS } from './nexus-hedge-analysis';
import { OMNI_FORGE_LIMITS } from './omni-forge-analysis';
import { DIGIT_FORGE_ANALYSIS_LIMITS } from './digit-forge-analysis';

const skeleton = {
    totalProfit: 0,
    totalWins: 0,
    totalLosses: 0,
    totalStake: 0,
    totalPayout: 0,
    totalRuns: 0,
};

const globalStat = {};

export default Engine =>
    class Total extends Engine {
        constructor() {
            super();
            this.sessionRuns = 0;
            this.sessionProfit = 0;

            globalObserver.register('statistics.clear', this.clearStatistics.bind(this));
        }

        clearStatistics() {
            this.sessionRuns = 0;
            this.sessionProfit = 0;
            if (!this.accountInfo) return;
            const { loginid: accountID } = this.accountInfo;
            globalStat[accountID] = { ...skeleton };
        }

        updateTotals(contract) {
            const { sell_price: sellPrice, buy_price: buyPrice, currency } = contract;

            const profit = getRoundedNumber(Number(sellPrice) - Number(buyPrice), currency);

            const win = profit > 0;

            // Recovery rescan mandate (Nexus Hedge, Omni Forge, Digit Forge,
            // Over/Under Turbo): EVERY settled trade — win or loss — must be
            // followed by a genuinely fresh rescan before any recovery entry
            // may fire, so every forge family's fresh-tick confirmation is
            // invalidated here. On a LOSS, each family that actually traded
            // also arms a rematch penalty against the exact losing tuple, so
            // the rescan is a real contest across the watch-list instead of a
            // re-fire on the tape that just lost. (Turbo's recovery contract
            // is fixed, so there is nothing to demote — fresh-data
            // confirmation is its whole mandate.) All fields are forge-only:
            // stock strategies are unaffected.
            this.nt_hedge_confirmation = undefined;
            this.nt_omni_confirmation = undefined;
            this.nt_digit_recovery_confirmation = undefined;
            this.nt_turbo_recovery_confirmation = undefined;
            if (win) {
                this.nt_hedge_rematch = undefined;
                this.nt_omni_rematch = undefined;
                this.nt_digit_rematch = undefined;
            }
            if (!win) {
                // The armed epoch anchors the penalty to the tape the losing
                // trade was placed on, so rankers age the handicap only when
                // FRESH ticks arrive — repeated passes over one snapshot
                // re-rank deterministically rather than eroding it.
                const families = [
                    ['nt_hedge_pending_entry', 'nt_hedge_rematch', NEXUS_HEDGE_LIMITS.rematchPenalty, this.nt_hedge_decision],
                    ['nt_omni_pending_entry', 'nt_omni_rematch', OMNI_FORGE_LIMITS.rematchPenalty, this.nt_contract_decision],
                    ['nt_digit_pending_entry', 'nt_digit_rematch', DIGIT_FORGE_ANALYSIS_LIMITS.rematchPenalty, this.nt_digit_decision],
                ];
                for (const [pendingField, rematchField, penalty, decision] of families) {
                    const entry = this[pendingField];
                    if (entry) {
                        this[rematchField] = {
                            key: `${entry.symbol}:${entry.contract}:${String(entry.barrier)}`,
                            penalty,
                            epoch: Number(decision?.tickEpoch) || 0,
                        };
                    }
                }
            }
            this.nt_hedge_pending_entry = undefined;
            this.nt_omni_pending_entry = undefined;
            this.nt_digit_pending_entry = undefined;

            const accountStat = this.getAccountStat();

            accountStat.totalWins += win ? 1 : 0;

            accountStat.totalLosses += !win ? 1 : 0;

            this.sessionProfit = getRoundedNumber(Number(this.sessionProfit) + Number(profit), currency);

            accountStat.totalProfit = getRoundedNumber(Number(accountStat.totalProfit) + Number(profit), currency);

            accountStat.totalStake = getRoundedNumber(Number(accountStat.totalStake) + Number(buyPrice), currency);

            accountStat.totalPayout = getRoundedNumber(Number(accountStat.totalPayout) + Number(sellPrice), currency);

            info({
                profit,
                contract,
                accountID: this.accountInfo.loginid,
                totalProfit: accountStat.totalProfit,
                totalWins: accountStat.totalWins,
                totalLosses: accountStat.totalLosses,
                totalStake: accountStat.totalStake,
                totalPayout: accountStat.totalPayout,
            });

            log(win ? LogTypes.PROFIT : LogTypes.LOST, { currency, profit });
        }

        updateAndReturnTotalRuns() {
            this.sessionRuns++;
            const accountStat = this.getAccountStat();

            return ++accountStat.totalRuns;
        }

        /* eslint-disable class-methods-use-this */
        getTotalRuns() {
            const accountStat = this.getAccountStat();
            return accountStat.totalRuns;
        }

        getTotalProfit(toString, currency) {
            const accountStat = this.getAccountStat();

            return toString && accountStat.totalProfit !== 0
                ? getRoundedNumber(+accountStat.totalProfit, currency)
                : +accountStat.totalProfit;
        }

        /* eslint-enable */
        checkLimits(tradeOption) {
            if (!tradeOption.limitations) {
                return;
            }

            const {
                limitations: { maxLoss, maxTrades },
            } = tradeOption;

            if (maxLoss && maxTrades) {
                if (this.sessionRuns >= maxTrades) {
                    throw createError('CustomLimitsReached', getLocalizedErrorMessage('MaxTradesReached'));
                }
                if (this.sessionProfit <= -maxLoss) {
                    throw createError('CustomLimitsReached', getLocalizedErrorMessage('MaxLossReached'));
                }
            }
        }

        /* eslint-disable class-methods-use-this */
        validateTradeOptions(tradeOptions) {
            const take_profit = tradeOptions.take_profit;
            const stop_loss = tradeOptions.stop_loss;

            if (take_profit) {
                tradeOptions.limit_order.take_profit = take_profit;
            }
            if (stop_loss) {
                tradeOptions.limit_order.stop_loss = stop_loss;
            }

            return tradeOptions;
        }

        getAccountStat() {
            const { loginid: accountID } = this.accountInfo;

            if (!(accountID in globalStat)) {
                globalStat[accountID] = { ...skeleton };
            }

            return globalStat[accountID];
        }
    };
