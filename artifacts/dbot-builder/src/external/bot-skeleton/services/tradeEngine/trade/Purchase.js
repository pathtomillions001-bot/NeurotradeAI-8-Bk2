import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        /**
         * Buy two one-tick digit contracts as one basket. Both requests are
         * issued in the same microtask and the store advances only after both
         * contract ids are acknowledged. OpenContract then waits for BOTH ids.
         */
        purchasePair(over_type, over_barrier, under_type, under_barrier, stake) {
            if (this.store.getState().scope !== BEFORE_PURCHASE || this.pairContractIds?.length) {
                return Promise.resolve();
            }
            const amount = Number(stake);
            if (!Number.isFinite(amount) || amount <= 0) return Promise.reject(new Error('Invalid paired stake'));

            const make = (contract_type, barrier) => {
                // Direct buys are intentional: the stock proposal pool has one
                // shared prediction, while paired rails require two barriers.
                const options = { ...this.tradeOptions, amount, prediction: Number(barrier) };
                return tradeOptionToBuy(contract_type, options);
            };
            const legs = [
                { contract_type: over_type, barrier: Number(over_barrier) },
                { contract_type: under_type, barrier: Number(under_barrier) },
            ];
            this.isSold = false;
            this.pairContracts = new Map();
            this.pairContractIds = [];
            return Promise.allSettled(legs.map(leg => api_base.api.send(make(leg.contract_type, leg.barrier))))
                .then(results => {
                    const failures = results.filter(result => result.status === 'rejected');
                    results.forEach((result, index) => {
                        if (result.status !== 'fulfilled') return;
                        const buy = result.value.buy;
                        const leg = legs[index];
                        this.pairContractIds.push(buy.contract_id);
                        contractStatus({ id: 'contract.purchase_received', data: buy.transaction_id, buy });
                        log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                        info({
                            accountID: this.accountInfo.loginid,
                            totalRuns: index === 0 ? this.updateAndReturnTotalRuns() : this.getTotalRuns(),
                            transaction_ids: { buy: buy.transaction_id },
                            contract_type: leg.contract_type,
                            buy_price: buy.buy_price,
                            paired: true,
                        });
                    });
                    this.contractId = this.pairContractIds[0] || '';
                    if (failures.length) {
                        // A one-leg fill is not a hedge. Preserve its id for the
                        // monitor, halt the run, and never submit another pair.
                        this.pairPurchaseError = failures[0].reason;
                        contractStatus({ id: 'contract.pair_purchase_failed', data: String(failures[0].reason) });
                        globalObserver.emit('bot.stop_button_click');
                        throw failures[0].reason;
                    }
                    this.store.dispatch(purchaseSuccessful());
                });
        }

        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
