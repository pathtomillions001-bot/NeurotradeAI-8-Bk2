import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { openContractReceived, sell } from './state/actions';
import { observer as globalObserver } from '../../../utils/observer';

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'proposal_open_contract') {
                    const contract = data.proposal_open_contract;

                    if (!contract || !this.expectedContractId(contract?.contract_id)) {
                        return;
                    }

                    // A paired purchase is one accounting cycle with two broker
                    // contract ids. Do not run After Purchase until BOTH settle.
                    if (this.pairContractIds?.length) {
                        this.pairContracts.set(contract.contract_id, contract);
                        broadcastContract({ accountID: api_base.account_info.loginid, ...contract, paired: true });
                        const settled = this.pairContractIds
                            .map(id => this.pairContracts.get(id))
                            .filter(Boolean);
                        if (settled.length < 2 || settled.some(item => !item.is_sold)) {
                            this.store.dispatch(openContractReceived());
                            return;
                        }

                        const [a, b] = settled;
                        const sameExit = Number(a.exit_tick) === Number(b.exit_tick) &&
                            Number(a.exit_tick_time) === Number(b.exit_tick_time);
                        if (!sameExit) {
                            contractStatus({
                                id: 'contract.pair_tick_mismatch',
                                data: `${a.exit_tick} / ${b.exit_tick}`,
                                contracts: settled,
                            });
                            // The hedge invariant failed. Never calculate debt
                            // from unmatched ticks and never start another pair.
                            this.pairContractIds = [];
                            this.contractId = '';
                            globalObserver.emit('bot.stop_button_click');
                            return;
                        }

                        const synthetic = {
                            ...a,
                            contract_id: `pair:${a.contract_id}:${b.contract_id}`,
                            contract_type: 'PAIRED_DIGITS',
                            buy_price: Number(a.buy_price) + Number(b.buy_price),
                            sell_price: Number(a.sell_price) + Number(b.sell_price),
                            payout: Number(a.payout || a.sell_price) + Number(b.payout || b.sell_price),
                            transaction_ids: {
                                buy: `${a.transaction_ids?.buy},${b.transaction_ids?.buy}`,
                                sell: `${a.transaction_ids?.sell},${b.transaction_ids?.sell}`,
                            },
                            paired_contracts: settled,
                            status: Number(a.sell_price) + Number(b.sell_price) - Number(a.buy_price) - Number(b.buy_price) >= 0 ? 'won' : 'lost',
                        };
                        this.data.contract = synthetic;
                        this.isSold = true;
                        this.contractId = '';
                        this.pairContractIds = [];
                        this.pairContracts.clear();
                        clearTimeout(this.transaction_recovery_timeout);
                        this.updateTotals(synthetic);
                        contractStatus({ id: 'contract.sold', data: synthetic.transaction_ids.sell, contract: synthetic });
                        if (this.afterPromise) this.afterPromise();
                        this.store.dispatch(sell());
                        return;
                    }

                    this.setContractFlags(contract);
                    this.data.contract = contract;
                    broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

                    if (this.isSold) {
                        this.contractId = '';
                        clearTimeout(this.transaction_recovery_timeout);
                        this.updateTotals(contract);
                        contractStatus({
                            id: 'contract.sold',
                            data: contract.transaction_ids.sell,
                            contract,
                        });

                        if (this.afterPromise) {
                            this.afterPromise();
                        }

                        this.store.dispatch(sell());
                    } else {
                        this.store.dispatch(openContractReceived());
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            if (this.pairContractIds?.length) return this.pairContractIds.includes(contractId);
            return this.contractId && contractId === this.contractId;
        }

        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
