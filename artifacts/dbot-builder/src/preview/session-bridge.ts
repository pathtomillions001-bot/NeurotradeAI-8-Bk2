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

export type EmbeddedSessionResponse = {
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

type SessionFetchOptions = {
    /** Request the one-time authenticated Deriv WebSocket URL. */
    includeWebsocket?: boolean;
    /** Ignore the cache, for an account switch or a reconnect. */
    force?: boolean;
};

// The account metadata request is deliberately separate from the OTP request.
// Metadata is safe to warm during first paint; an OTP handshake is comparatively
// expensive and must never hold the builder UI hostage.
let sessionPromise: Promise<EmbeddedSessionResponse | null> | null = null;
let authenticatedSessionPromise: Promise<EmbeddedSessionResponse | null> | null = null;
let authenticatedSessionLoginId: string | null = null;
let previewSyncLoginId: string | null = null;
let previewSyncPromise: Promise<boolean> | null = null;
let previewAuthenticatedConnectionReady = false;

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
    previewAuthenticatedConnectionReady = false;
    previewSyncPromise = null;
    previewSyncLoginId = null;
    authenticatedSessionPromise = null;
    authenticatedSessionLoginId = null;
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

/**
 * Fetch the parent app's active account. The default request does not ask the
 * API server for an OTP, so it is quick enough to run while the builder paints.
 * The authenticated URL is requested only when the socket is ready to trade.
 */
export async function fetchEmbeddedPreviewSession(
    options: SessionFetchOptions = {},
): Promise<EmbeddedSessionResponse | null> {
    if (!isPreviewMode()) return null;

    const includeWebsocket = options.includeWebsocket === true;
    if (!options.force) {
        if (includeWebsocket && authenticatedSessionPromise) return authenticatedSessionPromise;
        if (!includeWebsocket && sessionPromise) return sessionPromise;
    }

    const request = (async () => {
        try {
            const endpoint = includeWebsocket
                ? `${BOT_BUILDER_SESSION_ENDPOINT}?include_websocket=1`
                : BOT_BUILDER_SESSION_ENDPOINT;
            const response = await fetch(endpoint, {
                credentials: 'include',
                headers: buildEmbeddedSessionHeaders(),
            });
            if (!response.ok) {
                throw new Error(`Embedded bot-builder session request failed (${response.status})`);
            }
            const session = (await response.json()) as EmbeddedSessionResponse;
            // A forced account switch may have replaced this request while the
            // server was generating its response. Do not seed stale account data.
            const isCurrentRequest = includeWebsocket
                ? authenticatedSessionPromise === request
                : sessionPromise === request;
            if (isCurrentRequest) seedPreviewSessionState(session);
            return session;
        } catch (error) {
            console.error('[preview] Failed to bootstrap NeuroTrade session for Deriv Bot Builder:', error);
            return null;
        }
    })();

    if (includeWebsocket) {
        authenticatedSessionPromise = request;
        void request.then(session => {
            // An account switch can replace this request before its OTP returns.
            // Never let the stale response become the active account identity.
            if (authenticatedSessionPromise === request) {
                authenticatedSessionLoginId = session?.activeLoginId ?? null;
            }
        });
    } else {
        sessionPromise = request;
    }
    return request;
}

/** True only after the iframe has a server-issued authenticated trading URL. */
export function isEmbeddedPreviewConnectionReady() {
    return previewAuthenticatedConnectionReady;
}

/**
 * OTP WebSocket URLs are connection credentials, not a long-lived cache entry.
 * Once APIBase has consumed one for a socket, allow the next reconnect to ask
 * the server for a fresh URL while retaining the authenticated account state.
 */
export function consumeEmbeddedPreviewSession() {
    authenticatedSessionPromise = null;
}

/**
 * Switch the iframe to the currently active NeuroTrade account. This is kept
 * separate from the fast metadata warm-up so a page can paint immediately and
 * the one-time OTP handshake can run in the background.
 */
export function syncEmbeddedPreviewSession(expectedLoginId?: string | null) {
    if (!isPreviewMode()) return Promise.resolve(false);

    if (!expectedLoginId) {
        resetEmbeddedPreviewSession();
        return Promise.resolve(false);
    }

    // Parent account switches must invalidate the previous one-time URL.
    // Reusing it would reconnect the builder to the old account.
    const accountChanged = Boolean(
        expectedLoginId &&
            ((authenticatedSessionLoginId && expectedLoginId !== authenticatedSessionLoginId) ||
                (previewSyncLoginId && expectedLoginId !== previewSyncLoginId)),
    );
    if (accountChanged) {
        authenticatedSessionPromise = null;
        authenticatedSessionLoginId = null;
        previewAuthenticatedConnectionReady = false;
        previewSyncPromise = null;
        previewSyncLoginId = null;
    } else if (previewSyncPromise) {
        return previewSyncPromise;
    } else if (
        previewAuthenticatedConnectionReady &&
        authenticatedSessionLoginId === expectedLoginId &&
        isAuthorized$.value
    ) {
        return Promise.resolve(true);
    }

    previewSyncLoginId = expectedLoginId;
    let syncPromise: Promise<boolean>;
    syncPromise = (async () => {
        try {
            const session = await fetchEmbeddedPreviewSession({ includeWebsocket: true, force: accountChanged });
            if (!session?.connected || !session.websocketUrl || !session.activeLoginId) {
                previewAuthenticatedConnectionReady = false;
                return false;
            }
            if (previewSyncPromise !== syncPromise) return false;

            // The API session is authoritative. This also handles an account
            // switch that happens while the iframe is already open.
            previewAuthenticatedConnectionReady = true;
            const { api_base } = await import('@/external/bot-skeleton');
            await api_base.init(true);

            // APIBase starts authorization from the socket's open event. Keep
            // this synchronization in flight until that event has completed so
            // a duplicate PREVIEW_READY cannot start a second replacement.
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline) {
                if (
                    isAuthorized$.value &&
                    api_base.is_authorized &&
                    api_base.account_id === session.activeLoginId
                ) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            previewAuthenticatedConnectionReady = false;
            console.error('[preview] Timed out waiting for Deriv authorization during session sync');
            return false;
        } catch (error) {
            previewAuthenticatedConnectionReady = false;
            console.error('[preview] Failed to synchronize NeuroTrade Deriv session:', error);
            return false;
        }
    })();
    previewSyncPromise = syncPromise;
    void syncPromise.finally(() => {
        if (previewSyncPromise === syncPromise) {
            previewSyncPromise = null;
            previewSyncLoginId = null;
        }
    });
    return syncPromise;
}

/**
 * Ensure Run can never race the background OTP handshake. The function resolves
 * only after the authenticated socket has authorized the selected demo/real
 * account, or returns false when no account is connected.
 */
export async function ensureEmbeddedPreviewConnection(expectedLoginId?: string | null) {
    if (!isPreviewMode()) return true;

    // Refresh the small metadata response on Run. This closes the race where
    // the parent changed accounts while the iframe still had a cached OTP URL.
    const activeSession = await fetchEmbeddedPreviewSession({ force: true });
    // The parent server owns the active account. client.loginid can briefly be
    // stale during an account switch, so prefer the account returned here.
    const loginId = activeSession?.activeLoginId ?? expectedLoginId;
    if (!loginId || !activeSession?.connected) return false;

    const needsAuthenticatedSocket =
        !previewAuthenticatedConnectionReady ||
        authenticatedSessionLoginId !== loginId ||
        !isAuthorized$.value;
    if (needsAuthenticatedSocket) {
        const synchronized = await syncEmbeddedPreviewSession(loginId);
        if (!synchronized) return false;
    }

    const { api_base } = await import('@/external/bot-skeleton');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        // isAuthorized$ can briefly still be true for the previous account while
        // an account switch replaces its socket. Check the APIBase identity too.
        if (isAuthorized$.value && api_base.is_authorized && api_base.account_id === loginId) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }

    console.error('[preview] Timed out waiting for Deriv authorization before running the bot');
    return false;
}

export function resetEmbeddedPreviewSession() {
    sessionPromise = null;
    clearPreviewSessionState();
}
