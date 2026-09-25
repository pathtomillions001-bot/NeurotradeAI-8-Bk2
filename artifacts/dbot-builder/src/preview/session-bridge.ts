import { clearAuthInfo } from '@/external/deriv-core';
import {
    isAuthorized$,
    setAccountList,
    setAuthData,
    setIsAuthorized,
    setIsAuthorizing,
} from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { isPreviewMode } from '@/utils/is-preview-mode';

const BOT_BUILDER_SESSION_ENDPOINT = '/api/auth/bot-builder/session';
const TAB_SESSION_STORAGE_KEY = 'neurotrade_tab_session';
const CLIENT_ID_STORAGE_KEY = 'neurotrade_client_id';
const RISK_ACK_STORAGE_KEY = 'neurotrade_risk_ack';
const TAB_SESSION_HEADER = 'x-tab-session';
const CLIENT_ID_HEADER = 'x-client-id';
const RISK_ACK_HEADER = 'x-risk-ack';

export const BOT_BUILDER_SYNC_MESSAGE = 'NEUROTRADE_BOT_BUILDER_SYNC';

type EmbeddedAccount = {
    loginId: string;
    currency: string;
    balance: number;
    isVirtual: boolean;
    isActive: boolean;
};

type EmbeddedSessionResponse = {
    connected: boolean;
    activeLoginId: string | null;
    activeAccount: EmbeddedAccount | null;
    accounts: EmbeddedAccount[];
    websocketUrl: string | null;
};

type EmbeddedStoredAccount = {
    account_id: string;
    balance: string;
    currency: string;
    group: string;
    status: 'active';
    account_type: 'demo' | 'real';
};

function toStoredAccounts(accounts: EmbeddedAccount[]): EmbeddedStoredAccount[] {
    return accounts.map(account => ({
        account_id: account.loginId,
        balance: String(account.balance),
        currency: account.currency,
        group: '',
        status: 'active',
        account_type: account.isVirtual ? 'demo' : 'real',
    }));
}

function toAccountMap(accounts: EmbeddedAccount[]) {
    return Object.fromEntries(
        accounts.map(account => [
            account.loginId,
            {
                loginid: account.loginId,
                currency: account.currency,
                balance: account.balance,
                is_virtual: account.isVirtual ? 1 : 0,
                is_disabled: 0,
            },
        ])
    );
}

function buildEmbeddedSessionHeaders() {
    const headers = new Headers({ Accept: 'application/json' });
    const tabSessionId = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    const clientId = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    const riskAck = sessionStorage.getItem(RISK_ACK_STORAGE_KEY);

    if (tabSessionId) headers.set(TAB_SESSION_HEADER, tabSessionId);
    if (clientId) headers.set(CLIENT_ID_HEADER, clientId);
    if (riskAck) headers.set(RISK_ACK_HEADER, riskAck);

    return headers;
}

function clearPreviewSessionState() {
    clearAuthInfo();
    sessionStorage.removeItem('deriv_accounts');
    localStorage.removeItem('active_loginid');
    localStorage.removeItem('account_type');
    localStorage.removeItem('accountsList');
    localStorage.removeItem('clientAccounts');
    setAccountList([]);
    setAuthData(null);
    setIsAuthorized(false);
    setIsAuthorizing(false);
}

function seedPreviewSessionState(session: EmbeddedSessionResponse) {
    if (!session.connected || !session.activeAccount || !session.activeLoginId) {
        clearPreviewSessionState();
        return;
    }

    const storedAccounts = toStoredAccounts(session.accounts);
    const accountMap = toAccountMap(session.accounts);

    sessionStorage.setItem('deriv_accounts', JSON.stringify(storedAccounts));
    localStorage.setItem('active_loginid', session.activeLoginId);
    localStorage.setItem('account_type', session.activeAccount.isVirtual ? 'demo' : 'real');
    localStorage.setItem('accountsList', JSON.stringify(accountMap));
    localStorage.setItem('clientAccounts', JSON.stringify(accountMap));
}

export async function fetchEmbeddedPreviewSession(): Promise<EmbeddedSessionResponse | null> {
    if (!isPreviewMode()) return null;

    try {
        const response = await fetch(BOT_BUILDER_SESSION_ENDPOINT, {
            credentials: 'include',
            headers: buildEmbeddedSessionHeaders(),
        });
        if (!response.ok) {
            throw new Error(`Embedded bot-builder session request failed (${response.status})`);
        }
        const session = (await response.json()) as EmbeddedSessionResponse;
        seedPreviewSessionState(session);
        return session;
    } catch (error) {
        console.error('[preview] Failed to bootstrap NeuroTrade session for Deriv Bot Builder:', error);
        return null;
    }
}

export async function syncEmbeddedPreviewSession(expectedLoginId?: string | null) {
    if (!isPreviewMode()) return;

    const activeLoginId = (localStorage.getItem('active_loginid') || '').trim();
    const shouldReconnect =
        !activeLoginId ||
        !expectedLoginId ||
        activeLoginId !== expectedLoginId ||
        !isAuthorized$.value;

    if (expectedLoginId) {
        localStorage.setItem('active_loginid', expectedLoginId);
    }

    try {
        if (shouldReconnect) {
            const { api_base } = await import('@/external/bot-skeleton');
            await api_base.init(true);
        }
    } catch (error) {
        console.error('[preview] Failed to synchronize NeuroTrade Deriv session:', error);
    }
}

export function resetEmbeddedPreviewSession() {
    clearPreviewSessionState();
}
