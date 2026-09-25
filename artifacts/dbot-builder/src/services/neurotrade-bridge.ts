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


// ── Host-driven bot lifecycle (build from a scan → run → stop) ────────────────

/** The bot id the host deep-linked, if any (`?load=<id>`). */
function hostBotId(): string | null {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('load') ?? params.get('dbot');
}

/**
 * Load a bot the host app built from a scan.
 *
 * Bot Studio opens `/bot/?load=<dbotId>` for a bot created from a scan; the XML
 * comes from the host's own API, because the compiled program lives with the
 * scan that produced it — not in this bundle. Loading is what makes "Create
 * Deriv DBot" feel like opttraders: the scan, the program and the Run button are
 * one click apart.
 *
 * Returns true when the workspace now holds the bot.
 */
export async function loadHostBot(dbotId?: string): Promise<boolean> {
    if (!isEmbeddedMode()) return false;
    const id = dbotId ?? hostBotId();
    if (!id) return false;

    try {
        const res = await fetch(`/api/dbots/${encodeURIComponent(id)}/xml`, {
            credentials: 'same-origin',
            headers: { accept: 'application/xml' },
        });
        if (!res.ok) return false;
        const xml = await res.text();
        if (!xml.includes('<block')) return false;

        // This runs while the builder is still booting, so wait for the
        // workspace (Blockly is created well after the first paint).
        const deadline = Date.now() + 30_000;
        const workspaceReady = () =>
            Boolean((window as any).Blockly?.derivWorkspace && (window as any).Blockly?.Xml);
        while (!workspaceReady() && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const workspace = (window as any).Blockly?.derivWorkspace;
        if (!workspace) return false;

        const meta = await fetch(`/api/dbots/${encodeURIComponent(id)}`, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
        })
            .then(response => (response.ok ? response.json() : null))
            .catch(() => null);
        const name: string = meta?.bot?.name ?? 'NeuroTrade DBot';

        // `load` replaces the workspace (the host XML carries collection="false"),
        // naming the bot exactly as the app's journal will report it.
        const { load } = await import('@/external/bot-skeleton');
        await load({
            block_string: xml,
            file_name: name,
            workspace,
            from: 'unsaved',
            drop_event: null,
            strategy_id: id,
            showIncompatibleStrategyDialog: null,
        });
        return true;
    } catch (error) {
        console.error('[NeuroTrade] could not load the host bot:', error);
        return false;
    }
}

/**
 * Keep the host app in step with what this tab is doing.
 *
 * Outbound: `dbot:running {running, dbotId}` — the host turns `true` into
 * `POST /api/dbots/:id/live` and then keeps the run alive with heartbeats
 * (which is also what mirrors fills into the app's journal and the shared
 * recovery ledger); `false` releases the account's execution lock.
 *
 * Inbound: `neurotrade:stop-bot` — the host's kill switch (including an account
 * switch, where the bot must not keep trading the old account) stops the engine
 * in this tab, because this tab owns it.
 *
 * Returns a teardown function.
 */
export function installHostBotBridge(dbotId?: string): () => void {
    if (!isEmbeddedMode()) return () => {};
    const id = dbotId ?? hostBotId();

    let running = false;
    let announced: boolean | null = null;
    const announce = (next: boolean) => {
        if (next === announced) return;
        announced = next;
        window.parent?.postMessage({ type: 'dbot:running', running: next, dbotId: id }, window.location.origin);
    };

    const onRunning = () => { running = true; };
    const onStopped = () => { running = false; };
    let unregister: (() => void) | undefined;
    (async () => {
        try {
            const { observer } = await import('@/external/bot-skeleton');
            observer.register('bot.running', onRunning);
            observer.register('bot.stop', onStopped);
            unregister = () => {
                observer.unregister('bot.running', onRunning);
                observer.unregister('bot.stop', onStopped);
            };
        } catch (error) {
            console.error('[NeuroTrade] could not subscribe to the bot lifecycle:', error);
        }
    })();

    // Reconciliation poll: covers events that fired before this bridge was
    // installed, and a bot that died without emitting `bot.stop`. The stop
    // button is the builder's own running marker (see pages/main/main.tsx).
    const timer = window.setInterval(() => {
        const dom_running = typeof document !== 'undefined'
            ? document.getElementById('db-animation__stop-button') !== null
            : false;
        announce(running && dom_running);
    }, 2000);

    const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string } | undefined;
        if (data?.type === 'neurotrade:stop-bot') {
            void (async () => {
                try {
                    // The run panel subscribes to this event exactly as its own
                    // Stop button does.
                    const { observer } = await import('@/external/bot-skeleton');
                    observer.emit('bot.click_stop');
                    // If the interpreter was mid-tick the event may not have
                    // stopped it — the builder's own button is the last resort.
                    window.setTimeout(() => {
                        const button = document.getElementById('db-animation__stop-button') as HTMLElement | null;
                        button?.click();
                    }, 500);
                } catch (error) {
                    console.error('[NeuroTrade] could not stop the bot:', error);
                }
            })();
        }
    };
    window.addEventListener('message', onMessage);

    return () => {
        window.clearInterval(timer);
        window.removeEventListener('message', onMessage);
        unregister?.();
    };
}
