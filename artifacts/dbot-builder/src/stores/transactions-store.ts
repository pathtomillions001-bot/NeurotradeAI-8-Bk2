// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { action, computed, makeObservable, observable, reaction } from 'mobx';
import { formatDate, isEnded } from '@/components/shared';
import { LogTypes } from '@/external/bot-skeleton';
import { ProposalOpenContract } from '@deriv/api-types';
import { TPortfolioPosition, TStores } from '@deriv/stores/types';
import { TContractInfo } from '../components/summary/summary-card.types';
import { transaction_elements } from '../constants/transactions';
import { getStoredItemsByKey, setStoredItemsByKey } from '../utils/session-storage';
import { getSetting, storeSetting } from '../utils/settings';
import RootStore from './root-store';

type TTransaction = {
    type: string;
    data?: string | TContractInfo;
};

type TElement = {
    [key: string]: TTransaction[];
};

export default class TransactionsStore {
    root_store: RootStore;
    core: TStores;
    disposeReactionsFn: () => void;

    constructor(root_store: RootStore, core: TStores) {
        this.root_store = root_store;
        this.core = core;
        this.is_transaction_details_modal_open = false;
        // The store is built before the Deriv socket authorizes, so the live
        // loginid is usually empty here — seed from the persisted key instead
        // (and adopt the live one as soon as it arrives).
        if (this.core?.client?.loginid) this.setAccountKey(this.core.client.loginid as string);

        // `makeObservable` must run BEFORE the reactions below are registered:
        // a reaction evaluates its tracked expression immediately, and if the
        // observables (`elements`, `account_key`) are still plain fields at that
        // moment no dependencies are recorded — the cache-write reaction then
        // never fires and the history is silently lost on reload.
        makeObservable(this, {
            elements: observable,
            account_key: observable,
            active_transaction_id: observable,
            recovered_completed_transactions: observable,
            recovered_transactions: observable,
            is_called_proposal_open_contract: observable,
            is_transaction_details_modal_open: observable,
            transactions: computed,
            setAccountKey: action.bound,
            onBotContractEvent: action.bound,
            pushTransaction: action.bound,
            clear: action.bound,
            registerReactions: action.bound,
            recoverPendingContracts: action.bound,
            updateResultsCompletedContract: action.bound,
            sortOutPositionsBeforeAction: action.bound,
            recoverPendingContractsById: action.bound,
        });

        this.disposeReactionsFn = this.registerReactions();
    }
    TRANSACTION_CACHE = 'transaction_cache';
    // Which account the transaction history currently on screen belongs to.
    //
    // The history used to be looked up live against `client.loginid`, so the
    // moment that value went blank — socket blip, OTP re-authorize, demo/real
    // switch, Stop while the app re-syncs the session — the Transactions tab
    // rendered "no transactions" while the Journal (an in-memory list) kept
    // everything. The last account that actually traded is remembered here and
    // persisted, so Stop (or any auth hiccup) never hides the trading data: it
    // only goes away on Reset, which calls clear().
    ACCOUNT_SETTING = 'transaction_cache_account';

    elements: TElement = this.restoreCachedElements();
    account_key: string = this.resolveInitialAccountKey();
    active_transaction_id: null | number = null;
    recovered_completed_transactions: number[] = [];
    recovered_transactions: number[] = [];
    is_called_proposal_open_contract = false;
    is_transaction_details_modal_open = false;

    /**
     * Restores the whole per-account history map from the session cache.
     *
     * NB: the cached value must be read as a MAP keyed by loginid. An earlier
     * build wrote `getStoredItemsByUser(...)` here, which returns a single
     * account's LIST — so `elements` came back as an array, every
     * `elements[loginid]` lookup missed, and the history vanished on each
     * reload even though it was still on disk. Legacy array caches written by
     * that build are migrated under the remembered account key.
     */
    private restoreCachedElements(): TElement {
        const stored = getStoredItemsByKey(this.TRANSACTION_CACHE, {}) as unknown;
        if (Array.isArray(stored)) {
            const account = this.resolveInitialAccountKey();
            return account ? { [account]: stored as TTransaction[] } : {};
        }
        return (stored as TElement) || {};
    }

    /** Last account that traded — survives a blank loginid and a reload. */
    private resolveInitialAccountKey(): string {
        try {
            const remembered = getSetting(this.ACCOUNT_SETTING);
            if (typeof remembered === 'string' && remembered) return remembered;
            return localStorage.getItem('active_loginid') || '';
        } catch {
            return '';
        }
    }

    setAccountKey = (key: string) => {
        if (!key || key === this.account_key) return;
        this.account_key = key;
        storeSetting(this.ACCOUNT_SETTING, key);
    };

    get transactions(): TTransaction[] {
        const key = this.account_key || ((this.core?.client?.loginid as string) ?? '');
        if (!key) return [];
        return this.elements[key] ?? [];
    }

    get statistics() {
        let total_runs = 0;
        // Filter out only contract transactions and remove dividers
        const trxs = this.transactions.filter(
            trx => trx.type === transaction_elements.CONTRACT && typeof trx.data === 'object'
        );
        const statistics = trxs.reduce(
            (stats, { data }) => {
                const contract = data as TContractInfo;
                const profit = Number(contract.profit) || 0;
                const is_completed = contract.is_completed || false;
                const buy_price = Number(contract.buy_price) || 0;
                const payout = Number(contract.payout) || Number(contract.bid_price) || 0;
                const bid_price = Number(contract.bid_price) || 0;

                if (is_completed) {
                    if (profit > 0) {
                        stats.won_contracts += 1;
                        stats.total_payout += payout ?? bid_price ?? 0;
                    } else {
                        stats.lost_contracts += 1;
                    }
                    stats.total_profit += profit;
                    stats.total_stake += buy_price;
                    total_runs += 1;
                }
                return stats;
            },
            {
                lost_contracts: 0,
                number_of_runs: 0,
                total_profit: 0,
                total_payout: 0,
                total_stake: 0,
                won_contracts: 0,
            }
        );
        statistics.number_of_runs = total_runs;
        return statistics;
    }

    toggleTransactionDetailsModal = (is_open: boolean) => {
        this.is_transaction_details_modal_open = is_open;
    };

    onBotContractEvent(data: TContractInfo) {
        this.pushTransaction(data);
    }

    pushTransaction(data: TContractInfo) {
        const is_completed = isEnded(data as ProposalOpenContract);
        const { run_id } = this.root_store.run_panel;
        // The live loginid wins while it is present (a real account switch must
        // land on the new account); when it is blank the remembered account is
        // used, so a stop/disconnect never re-keys — or hides — the history.
        const live_loginid = (this.core?.client?.loginid as string) || '';
        const current_account = live_loginid || this.account_key;

        if (!current_account) return;
        if (current_account !== this.account_key) this.setAccountKey(current_account);

        const contract: TContractInfo = {
            ...data,
            is_completed,
            run_id,
            date_start: formatDate(data.date_start, 'YYYY-M-D HH:mm:ss [GMT]'),
            entry_tick: data.entry_spot,
            entry_tick_time: data.entry_tick_time && formatDate(data.entry_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            exit_tick: (data as any).exit_spot || data.exit_tick,
            exit_tick_time: data.exit_tick_time && formatDate(data.exit_tick_time, 'YYYY-M-D HH:mm:ss [GMT]'),
            profit: is_completed ? data.profit : 0,
        };

        if (!this.elements[current_account]) {
            this.elements = {
                ...this.elements,
                [current_account]: [],
            };
        }

        const same_contract_index = this.elements[current_account]?.findIndex(c => {
            if (typeof c.data === 'string') return false;
            return (
                c.type === transaction_elements.CONTRACT &&
                c.data?.transaction_ids &&
                c.data.transaction_ids.buy === data.transaction_ids?.buy
            );
        });

        if (same_contract_index === -1) {
            // Render a divider if the "run_id" for this contract is different.
            if (this.elements[current_account]?.length > 0) {
                const temp_contract = this.elements[current_account]?.[0];
                const is_contract = temp_contract.type === transaction_elements.CONTRACT;
                const is_new_run =
                    is_contract &&
                    typeof temp_contract.data === 'object' &&
                    contract.run_id !== temp_contract?.data?.run_id;

                if (is_new_run) {
                    this.elements[current_account]?.unshift({
                        type: transaction_elements.DIVIDER,
                        data: contract.run_id,
                    });
                }
            }

            this.elements[current_account]?.unshift({
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        } else {
            // If data belongs to existing contract in memory, update it.
            this.elements[current_account]?.splice(same_contract_index, 1, {
                type: transaction_elements.CONTRACT,
                data: contract,
            });
        }

        this.elements = { ...this.elements }; // force update
    }

    /** Wipes the visible history for the current account. Only Reset calls this. */
    clear() {
        const key = this.account_key || ((this.core?.client?.loginid as string) ?? '');
        if (key && this.elements?.[key]?.length > 0) {
            this.elements[key] = [];
        }
        this.recovered_completed_transactions = this.recovered_completed_transactions?.slice(0, 0);
        this.recovered_transactions = this.recovered_transactions?.slice(0, 0);
        this.is_transaction_details_modal_open = false;
    }

    registerReactions() {
        const { client } = this.core;

        // Follow the authorized account. A blank loginid (socket blip, OTP
        // re-authorize, Stop + session resync) is deliberately ignored so the
        // history on screen stays put until the user resets it.
        const disposeAccountKeyListener = reaction(
            () => client?.loginid,
            loginid => {
                if (loginid) this.setAccountKey(loginid as string);
            }
        );

        // Write transactions to session storage on each change in transaction elements.
        const disposeTransactionElementsListener = reaction(
            () => this.elements[this.account_key],
            elements => {
                if (!this.account_key) return;
                const stored_transactions = getStoredItemsByKey(this.TRANSACTION_CACHE, {});
                stored_transactions[this.account_key] = elements?.slice(0, 5000) ?? [];
                setStoredItemsByKey(this.TRANSACTION_CACHE, stored_transactions);
            }
        );

        // User could've left the page mid-contract. On initial load, try
        // to recover any pending contracts so we can reflect accurate stats
        // and transactions.
        const disposeRecoverContracts = reaction(
            () => this.transactions.length,
            () => this.recoverPendingContracts()
        );

        return () => {
            disposeAccountKeyListener();
            disposeTransactionElementsListener();
            disposeRecoverContracts();
        };
    }

    recoverPendingContracts(contract = null) {
        this.transactions.forEach(({ data: trx }) => {
            if (
                typeof trx === 'string' ||
                trx?.is_completed ||
                !trx?.contract_id ||
                this.recovered_transactions.includes(trx?.contract_id)
            )
                return;
            this.recoverPendingContractsById(trx.contract_id, contract);
        });
    }

    updateResultsCompletedContract(contract: ProposalOpenContract) {
        const { journal, summary_card } = this.root_store;
        const { contract_info } = summary_card;
        const { currency, profit } = contract;

        if (contract.contract_id !== contract_info?.contract_id) {
            this.onBotContractEvent(contract);

            if (contract.contract_id && !this.recovered_transactions.includes(contract.contract_id)) {
                this.recovered_transactions.push(contract.contract_id);
            }
            if (
                contract.contract_id &&
                !this.recovered_completed_transactions.includes(contract.contract_id) &&
                isEnded(contract)
            ) {
                this.recovered_completed_transactions.push(contract.contract_id);

                journal.onLogSuccess({
                    log_type: profit && profit > 0 ? LogTypes.PROFIT : LogTypes.LOST,
                    extra: { currency, profit },
                });
            }
        }
    }

    sortOutPositionsBeforeAction(positions: TPortfolioPosition[], element_id?: number) {
        positions?.forEach(position => {
            if (!element_id || (element_id && position.id === element_id)) {
                const contract_details = position.contract_info;
                this.updateResultsCompletedContract(contract_details);
            }
        });
    }

    async recoverPendingContractsById(contract_id: number, contract: ProposalOpenContract | null = null) {
        // TODO: need to fix as the portfolio is not available now
        // const positions = this.core.portfolio.positions;
        const positions: unknown[] = [];

        if (contract) {
            this.is_called_proposal_open_contract = true;
            if (contract.contract_id === contract_id) {
                this.updateResultsCompletedContract(contract);
            }
        }

        if (!this.is_called_proposal_open_contract) {
            if (this.core?.client?.loginid) {
                const current_account = this.core?.client?.loginid;
                if (!this.elements[current_account]?.length) {
                    this.sortOutPositionsBeforeAction(positions);
                }

                const elements = this.elements[current_account];
                const [element = null] = elements;
                if (typeof element?.data === 'object' && !element?.data?.profit) {
                    const element_id = element.data.contract_id;
                    this.sortOutPositionsBeforeAction(positions, element_id);
                }
            }
        }
    }
}
