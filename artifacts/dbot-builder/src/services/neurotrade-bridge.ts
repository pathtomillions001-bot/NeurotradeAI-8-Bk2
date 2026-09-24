/**
 * NeuroTrade ⇄ DBot bridge (embedded mode only).
 *
 * WHY THIS EXISTS
 * ───────────────
 * A hosted Deriv Bot authenticates itself: it sends the user to Deriv's OAuth
 * page, receives an access token in the browser, fetches the account list and
 * asks for an OTP WebSocket URL. Inside NeuroTrade that would mean asking a user
 * who is ALREADY connected to log in a second time, and it would put a Deriv
 * bearer token in the browser — which the platform deliberately never does
 * (tokens live server-side in the `accounts` table).
 *
 * So in embedded mode the builder delegates BOTH steps to the host app:
 *
 *   GET /api/dbot/session   → which account is selected (demo or real), and
 *                             every account linked to this browser session
 *   GET /api/dbot/ws-url    → a freshly minted, single-use OTP WebSocket URL for
 *                             that exact account (the host refreshes the OAuth
 *                             token server-side when it is near expiry)
 *
 * Both are same-origin requests carrying the platform's session cookie, so this
 * works inside the iframe with no postMessage handshake and no shared secret.
 * Because the OTP URL is fetched per connection, every reconnect in the builder
 * automatically gets a fresh one — which is exactly what Deriv's one-time-use
 * OTP URLs require (see replit.md → Gotchas).
 */

import { isEmbeddedMode } from '@/utils/embedded-mode';

export interface NeuroTradeAccount {
    accountId: string;
    loginId: string;
    currency: string;
    balance: number;
    isVirtual: boolean;
    isActive: boolean;
}

export interface NeuroTradeSession {
    connected: true;
    accountId: string;
    loginId: string;
    currency: string;
    balance: number;
    accountType: 'demo' | 'real';
    isVirtual: boolean;
    accounts: NeuroTradeAccount[];
}

/** Thrown when the host app has no connected Deriv account for this session. */
export class NotConnectedError extends Error {
    constructor(message = 'No Deriv account is connected in NeuroTrade yet.') {
        super(message);
        this.name = 'NotConnectedError';
    }
}

let cachedSession: NeuroTradeSession | null = null;
let inflight: Promise<NeuroTradeSession> | null = null;

/**
 * Asks the host app which account this builder should trade.
 *
 * Returns null when the host has no connected account (the caller then renders
 * the "connect in NeuroTrade" state instead of a login form).
 */
export async function fetchHostSession(force = false): Promise<NeuroTradeSession | null> {
    if (isEmbeddedMode() === false) return null;
    if (cachedSession && !force) return cachedSession;
    if (inflight) return inflight;

    inflight = (async () => {
        try {
            const res = await fetch('/api/dbot/session', {
                credentials: 'same-origin',
                headers: { accept: 'application/json' },
            });
            if (res.status === 404 || res.status === 401) return null;
            if (!res.ok) throw new Error(`session lookup failed (${res.status})`);
            const data = (await res.json()) as NeuroTradeSession | { connected: false };
            if (!('connected' in data) || !data.connected) return null;
            cachedSession = data;
            return data;
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

/** Drops the cached answer (called when the host app switches account). */
export function invalidateHostSession(): void {
    cachedSession = null;
}

/**
 * Seeds the storage keys the builder's own account readers use, from the host
 * app's answer. This is what makes the builder "already logged in":
 *
 *   active_loginid    → which account to trade (demo VRT* / real CR*)
 *   account_type      → demo | real
 *   deriv_accounts    → the account list its OTP service iterates
 *
 * Nothing here is a credential — only public account metadata.
 */
export function applyHostSession(session: NeuroTradeSession): void {
    try {
        localStorage.setItem('active_loginid', session.accountId);
        localStorage.setItem('account_type', session.accountType);
        sessionStorage.setItem(
            'deriv_accounts',
            JSON.stringify(
                session.accounts.map(a => ({
                    account_id: a.accountId,
                    balance: String(a.balance ?? 0),
                    currency: a.currency || 'USD',
                    group: '',
                    status: 'active',
                    account_type: a.isVirtual ? 'demo' : 'real',
                })),
            ),
        );
        // The builder's balance/currency readers (client-store, fiat displays)
        // look at these two keys; keep them in step with the host app's answer.
        localStorage.setItem('client.currency', session.currency || 'USD');
        const selected = session.accounts.find(a => a.accountId === session.accountId);
        if (selected) localStorage.setItem('client.balance', String(selected.balance ?? 0));
    } catch (error) {
        console.error('[NeuroTrade] could not seed builder storage from host session:', error);
    }
}

/** One-shot bootstrap used by App/AppContent before the socket is created. */
export async function bootstrapHostSession(): Promise<NeuroTradeSession | null> {
    if (!isEmbeddedMode()) return null;
    const session = await fetchHostSession();
    if (session) applyHostSession(session);
    return session;
}

/**
 * The embedded replacement for `getSocketURL()`: a single-use OTP URL for the
 * account the host app currently has selected (demo or real — whichever the user
 * chose in NeuroTrade Settings / the account switcher).
 */
export async function getHostSocketUrl(accountId?: string): Promise<string | null> {
    if (!isEmbeddedMode()) return null;
    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    const res = await fetch(`/api/dbot/ws-url${query}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 401) throw new NotConnectedError();
    if (!res.ok) {
        let detail = '';
        try {
            detail = ((await res.json()) as { error?: string }).error ?? '';
        } catch {
            /* non-JSON error body */
        }
        throw new Error(detail || `could not obtain a trading connection (${res.status})`);
    }
    const data = (await res.json()) as { url?: string; accountId?: string };
    if (!data.url) throw new Error('the host app returned no WebSocket URL');
    // Keep the builder's "active account" in step with what the host just minted
    // a connection for — otherwise a host-side account switch could leave the UI
    // claiming one account while trading another.
    if (data.accountId) {
        try {
            localStorage.setItem('active_loginid', data.accountId);
        } catch {
            /* storage blocked — the connection itself is still correct */
        }
    }
    return data.url;
}
