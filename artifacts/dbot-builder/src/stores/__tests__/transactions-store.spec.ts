// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { observable, runInAction } from 'mobx';
import { transaction_elements } from '@/constants/transactions';
import { setStoredItemsByKey } from '@/utils/session-storage';
import { getStoredItemsByKey } from '@/utils/session-storage';
import TransactionsStore from '../transactions-store';

const CACHE_KEY = 'transaction_cache';

function makeContract(overrides = {}) {
    return {
        contract_id: 1001,
        contract_type: 'DIGITMATCH',
        currency: 'USD',
        buy_price: 1,
        payout: 9,
        profit: 8,
        is_sold: 1,
        status: 'won',
        date_start: 1700000000,
        transaction_ids: { buy: 'buy-1001' },
        ...overrides,
    };
}

function buildStore(loginid?: string) {
    const client = observable({ loginid: loginid ?? undefined });
    const core = { client };
    const root_store = {
        run_panel: { run_id: 'run-1' },
        journal: { onLogSuccess: jest.fn() },
        summary_card: { contract_info: null },
    };
    const store = new TransactionsStore(root_store, core);
    return { store, client, core, root_store };
}

beforeEach(() => {
    sessionStorage.clear();
});

describe('TransactionsStore persistence', () => {
    it('restores cached transactions when the loginid resolves AFTER construction', () => {
        // A previous run left rows in the session cache for this account.
        setStoredItemsByKey(CACHE_KEY, {
            CR9000001: [{ type: transaction_elements.CONTRACT, data: makeContract() }],
        });

        // The builder boots before the account is known (embedded preview does
        // exactly this — the session bridge resolves the loginid later).
        const { store, client } = buildStore(undefined);
        expect(store.transactions).toEqual([]);

        // Account resolves. JournalStore has always rehydrated on this change;
        // TransactionsStore must too, or the panel renders empty.
        runInAction(() => {
            client.loginid = 'CR9000001';
        });

        expect(store.transactions).toHaveLength(1);
        expect(store.transactions[0].data.contract_id).toBe(1001);
    });

    it('does not clobber in-memory rows with a staler cache snapshot', () => {
        const { store } = buildStore('CR9000002');

        store.onBotContractEvent(makeContract({ contract_id: 2, transaction_ids: { buy: 'buy-2' } }));
        store.onBotContractEvent(makeContract({ contract_id: 3, transaction_ids: { buy: 'buy-3' } }));
        expect(store.transactions).toHaveLength(2);

        // Something writes an older, shorter snapshot into the cache behind our
        // back (a second tab, an out-of-band sync). Re-firing the restore must
        // not roll the live panel back to it.
        setStoredItemsByKey(CACHE_KEY, {
            CR9000002: [{ type: transaction_elements.CONTRACT, data: makeContract({ contract_id: 1 }) }],
        });
        store.restoreStoredTransactions('CR9000002');

        expect(store.transactions).toHaveLength(2);
        expect(store.transactions.map(t => t.data.contract_id)).toEqual([3, 2]);
    });

    it('persists transactions to session storage so they survive a remount', () => {
        // Regression: the session-storage writer used to be registered before
        // makeObservable, so it tracked nothing and never ran — transactions
        // were lost on every reload while the journal survived.
        const first = buildStore('CR9000005');
        first.store.onBotContractEvent(makeContract());
        first.store.onBotContractEvent(makeContract({ contract_id: 1002, transaction_ids: { buy: 'buy-1002' } }));
        expect(first.store.transactions).toHaveLength(2);

        expect(getStoredItemsByKey(CACHE_KEY, {})['CR9000005']).toHaveLength(2);

        // Simulate the builder remounting (store torn down and rebuilt).
        const second = buildStore('CR9000005');
        expect(second.store.transactions).toHaveLength(2);
    });

    it('keeps transactions after the bot stops — only Reset clears them', () => {
        const { store, root_store } = buildStore('CR9000003');
        store.onBotContractEvent(makeContract());
        store.onBotContractEvent(makeContract({ contract_id: 1002, transaction_ids: { buy: 'buy-1002' } }));
        expect(store.transactions).toHaveLength(2);

        // Stopping tears the bot listeners down and nulls the summary card; it
        // must not touch transaction history.
        root_store.summary_card.contract_info = null;
        expect(store.transactions).toHaveLength(2);

        // Reset (Clear stats) is the only path that wipes history.
        store.clear();
        expect(store.transactions).toHaveLength(0);
        expect(getStoredItemsByKey(CACHE_KEY, {})[ 'CR9000003' ]).toEqual([]);
    });

    it('computes statistics from the retained rows', () => {
        const { store } = buildStore('CR9000004');
        store.onBotContractEvent(makeContract({ buy_price: 1, payout: 9, profit: 8, is_sold: 1, status: 'won' }));
        store.onBotContractEvent(
            makeContract({
                contract_id: 1003,
                transaction_ids: { buy: 'buy-1003' },
                buy_price: 1,
                payout: 0,
                profit: -1,
                is_sold: 1,
                status: 'lost',
            })
        );

        expect(store.statistics.number_of_runs).toBe(2);
        expect(store.statistics.won_contracts).toBe(1);
        expect(store.statistics.lost_contracts).toBe(1);
        expect(store.statistics.total_profit).toBe(7);
    });
});
