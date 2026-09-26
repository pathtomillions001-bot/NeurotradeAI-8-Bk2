import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus, info } from '../utils/broadcast';
import { sizeDigit45Pair, settleDigit45Pair } from '@/preview/digit45-pair-math';
import { openContractReceived, purchaseSuccessful, sell } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

const LEGS = {
    normal: [{ type: 'DIGITOVER', barrier: 4 }, { type: 'DIGITUNDER', barrier: 5 }],
    recovery: [{ type: 'DIGITOVER', barrier: 5 }, { type: 'DIGITUNDER', barrier: 4 }],
};
const POLL_MS = 1500;
const SETTLEMENT_TIMEOUT_MS = 30000;

function asError(reason) {
    return reason instanceof Error ? reason.message : String(reason?.error?.message ?? reason?.message ?? reason);
}

/**
 * Only the generated Digit 4/5 strategy uses this extension. Stock Deriv Bot's
 * purchase() deliberately ignores a second buy; this mixin explicitly places
 * TWO buy requests on the SAME authorized account socket, tracks each contract
 * id independently, and advances after_purchase ONLY when both have settled.
 * A rejected/ambiguous order NEVER causes an automatic retry or a new pair.
 */
export default Engine => class Digit45Pair extends Engine {
    purchaseDigit45Pair(input) {
        if (api_base.digit45Unresolved) {
            return Promise.reject(new Error('A previous paired order is unresolved. Reconcile BOTH legs in your broker account before restarting the builder. No new buys.'));
        }
        if (this.store.getState().scope !== BEFORE_PURCHASE || this.digit45Buying || this.digit45Pair?.active ||
            api_base.is_stopping) {
            return Promise.reject(new Error('A paired trade is already pending or the bot is stopping. No new buys.'));
        }
        this.digit45Buying = true;
        const task = this.placeDigit45Pair(input);
        this.digit45BuyingPromise = task;
        return task.finally(() => {
            this.digit45Buying = false;
            this.digit45BuyingPromise = null;
        });
    }

    async quoteDigit45Leg(symbol, currency, leg, stake) {
        const response = await api_base.api.send({
            proposal: 1, underlying_symbol: symbol, contract_type: leg.type,
            barrier: String(leg.barrier), amount: stake, basis: 'stake',
            currency, duration: 1, duration_unit: 't',
        });
        const quote = response?.proposal;
        const ask = Number(quote?.ask_price);
        const payout = Number(quote?.payout);
        if (!quote?.id || !Number.isFinite(ask) || ask <= 0 ||
            !Number.isFinite(payout) || payout <= ask) {
            throw new Error(`Missing/invalid ${leg.type} ${leg.barrier} broker quote. No buys.`);
        }
        return { id: quote.id, ask, payout, multiplier: payout / ask };
    }

    async placeDigit45Pair(input) {
        await this.startPromise;
        const { mode, expectedCurrency, baseStake, debt, markupPercent, maxStake, stopLoss, sessionProfit } = input ?? {};
        const options = this.tradeOptions;
        const api = api_base.api;
        if (!api || !this.accountInfo?.loginid || !options || options.duration !== 1 ||
            options.duration_unit !== 't' || options.basis !== 'stake' ||
            !['USD', 'EUR', 'GBP', 'AUD'].includes(options.currency) ||
            !this.options?.contractTypes?.includes('DIGITOVER') ||
            !this.options?.contractTypes?.includes('DIGITUNDER')) {
            throw new Error('Pair requires a connected 2-decimal-currency account and 1-tick Over/Under trade parameters. No buys.');
        }
        if (expectedCurrency !== options.currency ||
            (this.accountInfo.currency && this.accountInfo.currency !== options.currency)) {
            throw new Error('Account currency differs from the scanned Digit 4/5 strategy. Re-create the DBot for this account. No buys.');
        }
        const legs = LEGS[mode];
        if (!legs) throw new Error('Unsupported pair mode. No buys.');
        const balance = Number(this.getBalance('NUM'));
        // Obtain BOTH live proposals before sizing. A recovery win must pay
        // both of this attempt's stakes PLUS the whole outstanding pair debt.
        let quotes = await Promise.all(legs.map(leg => this.quoteDigit45Leg(options.symbol, options.currency, leg, baseStake)));
        let sizing = sizeDigit45Pair({
            mode, baseStake, debt, markupPercent, maxStake, balance, stopLoss, sessionProfit,
            payoutOver: quotes[0].multiplier, payoutUnder: quotes[1].multiplier,
        });
        if (mode === 'recovery' || sizing.stake !== baseStake) {
            // Quotes have short lives and payout rounding changes with stake.
            // Size from the latest pair, not from a fixed canonical payout.
            for (let attempt = 0; attempt < 3; attempt++) {
                quotes = await Promise.all(legs.map(leg =>
                    this.quoteDigit45Leg(options.symbol, options.currency, leg, sizing.stake)));
                const updated = sizeDigit45Pair({
                    mode, baseStake, debt, markupPercent, maxStake, balance, stopLoss, sessionProfit,
                    payoutOver: quotes[0].multiplier, payoutUnder: quotes[1].multiplier,
                });
                if (updated.stake === sizing.stake) break;
                sizing = updated;
                if (attempt === 2) throw new Error('Pair payout moved while quoting; no buys. Restart after re-checking prices.');
            }
        }
        if (quotes.some(q => q.ask > maxStake || q.ask > sizing.stake + 0.00001) ||
            quotes[0].ask + quotes[1].ask > balance ||
            sessionProfit - quotes[0].ask - quotes[1].ask < -stopLoss) {
            throw new Error('Final live pair quotes exceed the stake, balance or full-pair stop-loss cap. No buys.');
        }
        if (mode === 'recovery') {
            // Check the ACTUAL, rounded final payouts after BOTH stake quotes.
            // A return of 2.43x on one contract is not 2.43x on the pair.
            const oneWinNet = Math.round((Math.min(quotes[0].payout, quotes[1].payout) -
                quotes[0].ask - quotes[1].ask) * 100) / 100;
            if (oneWinNet <= 0 ||
                (sizing.canClearDebtOnOneWin && oneWinNet + 0.005 < debt * (1 + markupPercent / 100))) {
                throw new Error('Final recovery quotes cannot cover BOTH stakes and the requested combined debt. No buys.');
            }
        }
        if (api_base.is_stopping) throw new Error('Bot stopped before sending either paired buy.');
        this.data.digit45PairResult = null; // never expose the previous pair's result during a new purchase

        // Both promises are created before awaiting either response. Broker
        // processing is NOT atomic; the two contracts may settle on different
        // ticks. Record each confirmed fill even if its sibling rejects.
        const purchases = legs.map((leg, index) => {
            try {
                return Promise.resolve(api.send({ buy: quotes[index].id, price: quotes[index].ask }));
            } catch (error) {
                // Even a synchronous socket error might follow a sent order.
                // Still attempt the sibling ONCE and reconcile any confirmed ID.
                return Promise.reject(error);
            }
        });
        const responses = await Promise.allSettled(purchases);
        const accepted = responses.flatMap((item, index) => {
            const buy = item.status === 'fulfilled' ? item.value?.buy : null;
            return buy?.contract_id ? [{
                id: String(buy.contract_id), type: legs[index].type, barrier: legs[index].barrier,
                buyPrice: Number(buy.buy_price ?? quotes[index].ask), settled: false, transactionId: buy.transaction_id,
            }] : [];
        });
        if (accepted.length === 0) {
            // A lost broker reply cannot prove neither order filled. Even an
            // explicit rejection of both is not safe to replay automatically.
            api_base.digit45Unresolved = true;
            throw new Error(`Both paired buys were rejected/uncertain: ${responses.map(r => r.status === 'rejected' ? asError(r.reason) : 'No contract id').join('; ')}. Reconcile the broker account before restarting the builder.`);
        }
        // No second request is retried after partial failure: the one accepted
        // leg still needs settlement and its actual P/L shown to the user.
        if (accepted.length !== 2) api_base.digit45Unresolved = true;
        this.digit45Pair = {
            active: true, mode, legs: accepted, partial: accepted.length !== 2,
            startedAt: Date.now(), polling: false,
        };
        this.store.dispatch(purchaseSuccessful());
        for (const leg of accepted) {
            contractStatus({ id: 'contract.purchase_received', data: leg.transactionId,
                buy: { contract_id: leg.id, buy_price: leg.buyPrice, transaction_id: leg.transactionId } });
            info({ accountID: this.accountInfo.loginid, totalRuns: this.updateAndReturnTotalRuns(),
                transaction_ids: { buy: leg.transactionId }, contract_type: leg.type, buy_price: leg.buyPrice });
        }
        if (this.digit45Pair.partial) {
            this.$scope.observer.emit('ui.log.error',
                'Only one paired buy was confirmed. Waiting for its result, then STOPPING — check your broker account for the other order.');
        }
        const active = this.digit45Pair;
        // Listen and poll; either path may deliver the terminal contract first.
        // handleDigit45OpenContract is idempotent per contract id.
        active.poller = setInterval(() => this.pollDigit45Pair(active), POLL_MS);
        for (const leg of accepted) {
            api.send({ proposal_open_contract: 1, contract_id: leg.id, subscribe: 1 })
                .then(reply => this.handleDigit45OpenContract(reply?.proposal_open_contract))
                .catch(() => { /* polling is the fallback */ });
        }
    }

    pollDigit45Pair(pair) {
        if (!pair.active) return;
        // Check the deadline BEFORE the in-flight-poll guard: a socket send()
        // may never resolve after a disconnect. Its pending promise must not
        // prevent this pair from timing out and locking further buys.
        if (Date.now() - pair.startedAt > SETTLEMENT_TIMEOUT_MS) {
            clearInterval(pair.poller);
            pair.poller = null;
            api_base.digit45Unresolved = true;
            this.$scope.observer.emit('Error', new Error(
                'Paired settlement was not confirmed within 30 seconds. Trading stopped; reconcile BOTH contract IDs in the broker account before restarting.'));
            return;
        }
        if (pair.polling) return;
        pair.polling = true;
        Promise.all(pair.legs.filter(l => !l.settled).map(l =>
            api_base.api.send({ proposal_open_contract: 1, contract_id: l.id })
                .then(reply => this.handleDigit45OpenContract(reply?.proposal_open_contract))
                .catch(() => { /* retry next interval; never assume loss */ })))
            .finally(() => { pair.polling = false; });
    }

    /** Called by the existing OpenContract onMessage stream and by explicit polls. */
    handleDigit45OpenContract(contract) {
        const pair = this.digit45Pair;
        if (!pair?.active || !contract) return false;
        const leg = pair.legs.find(l => l.id === String(contract.contract_id));
        if (!leg) return false;
        if (leg.settled) return true;
        this.data.contract = contract;
        if (!contract.is_sold) {
            broadcastContract({ accountID: this.accountInfo.loginid, ...contract, pairPending: true });
            this.store.dispatch(openContractReceived());
            return true;
        }
        const buyPrice = Number(contract.buy_price ?? leg.buyPrice);
        const sellPrice = Number(contract.sell_price);
        if (contract.sell_price === null || contract.sell_price === undefined || contract.sell_price === '' ||
            !Number.isFinite(buyPrice) || buyPrice <= 0 ||
            !Number.isFinite(sellPrice) || sellPrice < 0) {
            // Number(null) and Number('') are ZERO, not proof of a losing sale.
            broadcastContract({ accountID: this.accountInfo.loginid, ...contract, pairPending: true });
            return true;
        }
        leg.buyPrice = buyPrice;
        leg.sellPrice = sellPrice;
        leg.settled = true;
        const pairPending = pair.legs.some(l => !l.settled);
        broadcastContract({ accountID: this.accountInfo.loginid, ...contract, pairPending });
        this.updateTotals({ ...contract, buy_price: buyPrice, sell_price: sellPrice });
        contractStatus({ id: 'contract.sold', data: contract.transaction_ids?.sell, contract, pairPending });
        if (!pairPending) {
            clearInterval(pair.poller);
            pair.active = false;
            this.data.digit45PairResult = settleDigit45Pair(pair.legs, pair.mode);
            if (!pair.partial) api_base.digit45Unresolved = false;
            this.store.dispatch(sell());
            if (pair.resolveSettled) pair.resolveSettled();
        }
        return true;
    }

    getDigit45PairResult(field) {
        const value = this.data.digit45PairResult?.[field];
        if (!['profit', 'stake', 'bothLost', 'partial'].includes(field) || value === undefined) {
            throw new Error('Paired trade is not fully settled; recovery was not updated.');
        }
        return value;
    }

    hasActiveDigit45Pair() {
        return Boolean(this.digit45Buying || this.digit45Pair?.active);
    }

    async waitForDigit45PairSettled() {
        if (this.digit45BuyingPromise) await this.digit45BuyingPromise.catch(() => {});
        const pair = this.digit45Pair;
        if (pair?.active) await new Promise(resolve => { pair.resolveSettled = resolve; });
    }
};
