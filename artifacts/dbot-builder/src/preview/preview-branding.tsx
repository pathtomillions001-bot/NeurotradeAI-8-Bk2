// @ts-nocheck — NeuroTrade integration bridge, mounted only in the embedded
// (NEXT_PUBLIC_APP_BUILD) build that the NeuroTrade platform iframes at /dbot/.
//
// Responsibilities:
//  1. Embed chrome stripping — force the workspace tab and hide DBot's own
//     header/tabs so the frame shows ONLY the bot builder + run panel +
//     transactions/journal window.
//  2. Parent↔frame protocol (postMessage, same-origin):
//       parent → frame: nt:load-xml {xml,name}, nt:run, nt:stop
//       frame → parent: nt:ready {account}, nt:run-state {running},
//                       nt:contract {contract}, nt:auth-lost, nt:loaded {ok,error}
//  3. Contract journaling feed: every contract transaction (open updates and
//     final settlement) is forwarded to the parent, which persists it into the
//     NeuroTrade trades table + recovery ledger via POST /api/dbot/events.
//
// Auth is intentionally NOT handled here: the parent seeds the Deriv token of
// the account active in NeuroTrade into localStorage before this frame boots
// (same origin), so DBot authorizes straight onto that account (demo or real).
import React from 'react';
import { reaction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { load } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { isEmbedMode } from '@/utils/is-embed-mode';

const PARENT_ORIGIN = typeof window !== 'undefined' ? window.location.origin : '*';

const EMBED_CSS = `
body.nt-embed .main__tabs,
body.nt-embed .dc-tabs,
body.nt-embed .header,
body.nt-embed .footer,
body.nt-embed #header,
body.nt-embed .main__drawer,
body.nt-embed .bot-builder-tour { display: none !important; }
body.nt-embed, body.nt-embed #root, body.nt-embed .layout { height: 100% !important; overflow: hidden !important; }
`;

function post(msg: Record<string, unknown>) {
    try {
        window.parent.postMessage({ source: 'neurotrade-dbot', ...msg }, PARENT_ORIGIN);
    } catch {
        /* parent gone — nothing to do */
    }
}

const NeurotradeBridge = observer(() => {
    const store = useStore() as any;
    const wired = React.useRef(false);
    const seen = React.useRef<Map<number, { completed: boolean; profit: number }>>(new Map());
    const wasLoggedIn = React.useRef(false);

    // Chrome stripping + forced workspace tab (runs once, before paint effects).
    React.useLayoutEffect(() => {
        if (!isEmbedMode()) return;
        document.body.classList.add('nt-embed');
        const style = document.createElement('style');
        style.textContent = EMBED_CSS;
        document.head.appendChild(style);
    }, []);

    React.useEffect(() => {
        if (!store || wired.current) return;
        wired.current = true;

        if (isEmbedMode()) {
            // 1 = BOT_BUILDER workspace tab (constants/bot-contents DBOT_TABS).
            store.dashboard?.setActiveTab?.(1);
        }

        // Ready + account parity signal (parent double-checks demo/real).
        const disposeAuth = reaction(
            () => store.client?.is_logged_in,
            logged => {
                if (logged && !wasLoggedIn.current) {
                    wasLoggedIn.current = true;
                    post({
                        type: 'nt:ready',
                        account: {
                            loginid: store.client?.loginid,
                            currency: store.client?.currency,
                            is_virtual: !!store.client?.is_virtual,
                        },
                    });
                }
                if (wasLoggedIn.current && logged === false) {
                    post({ type: 'nt:auth-lost' });
                }
            },
            { fireImmediately: true }
        );

        // Run-state feed (drives the NeuroTrade arbiter owner 'dbot').
        const disposeRun = reaction(
            () => !!store.run_panel?.is_running,
            running => post({ type: 'nt:run-state', running })
        );

        // Contract journaling feed — forward every open update + settlement.
        const disposeTrx = reaction(
            () => {
                const trxs = store.transactions?.transactions ?? [];
                return trxs
                    .filter((t: any) => t?.type === 'contract' && t?.data?.contract_id)
                    .map((t: any) => {
                        const c = t.data;
                        return [
                            c.contract_id,
                            !!c.is_completed,
                            Number(c.profit) || 0,
                            Number(c.buy_price) || 0,
                            Number(c.payout) || 0,
                            c.status ?? '',
                            c.transaction_id ?? null,
                            c.display_name ?? '',
                            c.shortcode ?? '',
                            c.date_purchase ?? null,
                            c.date_expiry ?? null,
                        ].join('|');
                    })
                    .join(';');
            },
            () => {
                const trxs = store.transactions?.transactions ?? [];
                for (const t of trxs) {
                    if (t?.type !== 'contract' || !t?.data?.contract_id) continue;
                    const c = t.data;
                    const prev = seen.current.get(c.contract_id);
                    const completed = !!c.is_completed;
                    const profit = Number(c.profit) || 0;
                    if (!prev) {
                        seen.current.set(c.contract_id, { completed, profit });
                        post({ type: 'nt:contract', contract: sanitize(c), stage: 'open' });
                    } else if (completed && !prev.completed) {
                        seen.current.set(c.contract_id, { completed, profit });
                        post({ type: 'nt:contract', contract: sanitize(c), stage: 'settled' });
                    }
                }
            },
            { fireImmediately: true }
        );

        // Parent → frame commands.
        const onMessage = async (event: MessageEvent) => {
            if (event.origin !== PARENT_ORIGIN) return;
            const data: any = event.data;
            if (!data || data.source !== 'neurotrade-platform') return;
            try {
                if (data.type === 'nt:load-xml') {
                    const workspace = (window as any).Blockly?.derivWorkspace;
                    if (!workspace) throw new Error('workspace not ready');
                    const res: any = await load({
                        block_string: data.xml,
                        workspace,
                        file_name: data.name || 'neurotrade-strategy.xml',
                        from: 'neurotrade',
                        show_snackbar: true,
                    });
                    if (res?.error) post({ type: 'nt:loaded', ok: false, error: String(res.error) });
                    else post({ type: 'nt:loaded', ok: true });
                } else if (data.type === 'nt:run') {
                    await store.run_panel?.onRunButtonClick?.();
                } else if (data.type === 'nt:stop') {
                    store.run_panel?.onStopButtonClick?.();
                }
            } catch (err: any) {
                post({ type: 'nt:error', error: String(err?.message ?? err) });
            }
        };
        window.addEventListener('message', onMessage);

        return () => {
            window.removeEventListener('message', onMessage);
            disposeAuth();
            disposeRun();
            disposeTrx();
        };
    }, [store]);

    return null;
});

function sanitize(c: any) {
    return {
        contract_id: c.contract_id,
        transaction_id: c.transaction_id ?? null,
        shortcode: c.shortcode ?? '',
        display_name: c.display_name ?? '',
        currency: c.currency ?? '',
        buy_price: Number(c.buy_price) || 0,
        payout: Number(c.payout) || 0,
        profit: Number(c.profit) || 0,
        bid_price: Number(c.bid_price) || 0,
        is_completed: !!c.is_completed,
        status: c.status ?? '',
        is_sold: !!c.is_sold,
        entry_spot: c.entry_spot ?? null,
        exit_spot: c.exit_spot ?? null,
        barrier: c.barrier ?? null,
        date_purchase: c.date_purchase ?? null,
        date_expiry: c.date_expiry ?? null,
        date_settlement: c.date_settlement ?? null,
    };
}

export default NeurotradeBridge;
