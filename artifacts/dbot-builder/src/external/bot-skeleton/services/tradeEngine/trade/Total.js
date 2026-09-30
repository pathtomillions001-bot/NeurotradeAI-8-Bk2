import { getRoundedNumber } from '@/components/shared';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { LogTypes } from '../../../constants/messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { info, log } from '../utils/broadcast';
import { NEXUS_HEDGE_LIMITS } from './nexus-hedge-analysis';

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

            // Nexus Hedge Forge bookkeeping: EVERY settled trade — win or loss —
            // must be followed by a genuinely fresh rescan of every watched
            // market before any recovery entry may fire, so the fresh-tick
            // confirmation is always invalidated here. On a LOSS, the rematch
            // penalty additionally demotes the exact losing tuple for the next
            // scans, so the rescan is a real contest across the watch-list
            // instead of a re-fire on the tape that just lost. Both fields are
            // Nexus-only: untouched strategies are unaffected.
            this.nt_hedge_confirmation = undefined;
            if (win) {
                this.nt_hedge_rematch = undefined;
            }
            if (!win && this.nt_hedge_pending_entry) {
                this.nt_hedge_rematch = {
                    key: `${this.nt_hedge_pending_entry.symbol}:${this.nt_hedge_pending_entry.contract}:${String(this.nt_hedge_pending_entry.barrier)}`,
                    penalty: NEXUS_HEDGE_LIMITS.rematchPenalty,
                };
            }
            this.nt_hedge_pending_entry = undefined;

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
