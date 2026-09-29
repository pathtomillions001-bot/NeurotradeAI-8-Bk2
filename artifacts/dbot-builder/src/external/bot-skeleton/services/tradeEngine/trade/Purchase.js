import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

const nowMs = () => (typeof performance !== 'undefined' ? performance : Date).now();

export default Engine =>
    class Purchase extends Engine {
        /**
         * Omni Forge: buy ANY digit contract type with a just-in-time
         * prediction. Stock XML bakes one trade type (e.g. overunder) into the
         * workspace, so its static `prediction` is right for barrier contracts
         * only. This native adjusts `tradeOptions.prediction` for the contract
         * actually being bought — set for Over/Under/Matches/Differs, removed
         * for Even/Odd (a parity buy must not carry a barrier) — then defers
         * to the standard purchase path (scope guard, retries, logging).
         */
        ntPurchaseContract(contract_type, barrier) {
            const type = String(contract_type || '').toUpperCase();
            const digit = Math.trunc(Number(barrier));
            const isParity = type === 'DIGITEVEN' || type === 'DIGITODD';
            const needsDigit = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
            if (this.tradeOptions) {
                if (isParity) {
                    delete this.tradeOptions.prediction;
                } else if (needsDigit) {
                    // Matches/Differs "auto" is encoded as -1 in the analyser
                    // CSV, but the ranker must resolve it before purchase. Never
                    // send -1 (or no prediction) to Deriv: retain a valid seeded
                    // prediction as a safe fallback, otherwise use digit 0.
                    const seeded = Math.trunc(Number(this.tradeOptions.prediction));
                    this.tradeOptions.prediction = Number.isFinite(digit) && digit >= 0 && digit <= 9
                        ? digit
                        : Number.isFinite(seeded) && seeded >= 0 && seeded <= 9
                          ? seeded
                          : 0;
                } else {
                    delete this.tradeOptions.prediction;
                }
            }
            return this.purchase(type);
        }

        purchase(contract_type, quotedPurchase) {
            // Prevent calling purchase twice or while an existing purchase request is in-flight
            if (this.is_purchasing || ((this.nt_digit_preparing || this.nt_digit_purchase_pending) && !quotedPurchase) ||
                this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve(false);
            }
            this.is_purchasing = true;
            // Run-cadence telemetry: decision latency ends here (tick → this
            // call) and entry latency begins (this call → buy response).
            this.run_metrics?.recordBuyRequest();
            const request_started_at = nowMs();

            const resetPurchasing = () => {
                this.is_purchasing = false;
            };

            const onSuccess = response => {
                resetPurchasing();
                this.run_metrics?.recordPurchase(nowMs() - request_started_at);
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required && !quotedPurchase) {
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
                return true;
            };

            if (quotedPurchase || this.is_proposal_subscription_required) {
                const { id, askPrice } = quotedPurchase ?? this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (quotedPurchase || !this.options.timeMachineEnabled) {
                    // A Digit Forge quote is single-use. On failure let the
                    // interpreter re-scan/re-quote; never retry a stale buy id.
                    return (quotedPurchase ? action() : doUntilDone(action)).then(onSuccess).catch(err => {
                        resetPurchasing();
                        throw err;
                    });
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
                ).then(onSuccess).catch(err => {
                    resetPurchasing();
                    throw err;
                });
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess).catch(err => {
                    resetPurchasing();
                    throw err;
                });
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
            ).then(onSuccess).catch(err => {
                resetPurchasing();
                throw err;
            });
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
