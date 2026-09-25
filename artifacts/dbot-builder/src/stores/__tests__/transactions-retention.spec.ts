// @ts-nocheck — the store expects the full DBot/core store graph; this spec only
// exercises the small slice the retention behaviour touches.
import TransactionsStore from '../transactions-store';
import { getStoredItemsByKey, setStoredItemsByKey } from '@/utils/session-storage';
import { storeSetting } from '@/utils/settings';

const ACCOUNT = 'CR123456';

const buildStore = (loginid = ACCOUNT) => {
    const root_store = { run_panel: { run_id: 'run-1' } };
    const core = { client: { loginid } };
    return new TransactionsStore(root_store, core);
};

describe('TransactionsStore — trading data is kept until Reset', () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    it('restores the cached history for the remembered account', () => {
        setStoredItemsByKey('transaction_cache', {
            [ACCOUNT]: [{ type: 'contract', data: { contract_id: 42 } }],
        });
        storeSetting('transaction_cache_account', ACCOUNT);

        // The socket has not authorized yet — no live loginid.
        const store = buildStore('');

        expect(store.transactions).toHaveLength(1);
        expect(store.transactions[0].data.contract_id).toBe(42);
    });

    it('keeps showing the history when the loginid goes blank (stop / socket blip)', () => {
        const store = buildStore();

        store.pushTransaction({ contract_id: 111, transaction_ids: { buy: 1 }, profit: 5 } as never);
        expect(store.transactions).toHaveLength(1);

        // What a stop/disconnect used to do: `client.loginid` blanks out and the
        // getter re-keys to nothing, so the Transactions tab rendered empty while
        // the Journal (an in-memory list) kept everything.
        store.core.client.loginid = '';
        expect(store.transactions).toHaveLength(1);

        // And the data is still there when the account comes back.
        store.core.client.loginid = ACCOUNT;
        expect(store.transactions).toHaveLength(1);
    });

    it('only empties the history when the user resets', () => {
        const store = buildStore();
        store.pushTransaction({ contract_id: 222, transaction_ids: { buy: 2 }, profit: 1 } as never);

        store.clear();

        expect(store.transactions).toHaveLength(0);
    });

    it('migrates a legacy single-account (array) cache instead of losing it', () => {
        setStoredItemsByKey('transaction_cache', [{ type: 'contract', data: { contract_id: 7 } }]);
        localStorage.setItem('active_loginid', ACCOUNT);

        const store = buildStore('');

        expect(getStoredItemsByKey('transaction_cache', {})).toBeTruthy();
        expect(store.transactions).toHaveLength(1);
    });
});
