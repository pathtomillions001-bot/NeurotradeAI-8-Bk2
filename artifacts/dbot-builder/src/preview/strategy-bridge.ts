// @ts-nocheck — bridges into vendored bot code with known upstream type gaps; see AGENTS.md
import { load, save_types } from '@/external/bot-skeleton';
import { ApiHelpers } from '@/external/bot-skeleton/services/api';
import { DBOT_TABS } from '@/constants/bot-contents';
import { isPreviewMode } from '@/utils/is-preview-mode';
import type RootStore from '@/stores/root-store';

/**
 * NeuroTrade → Deriv Bot Builder strategy bridge.
 *
 * The host app (NeuroTrade web) generates a stock Deriv-Bot Blockly strategy —
 * for example from the Over/Under Turbo scan — and posts it into this iframe.
 * We load it through the builder's ordinary `load()` path (the same code the
 * Load modal and Quick Strategy use), switch to the Bot Builder tab and
 * acknowledge, so the user only has to verify the blocks and press Run.
 *
 * Nothing about Deriv's builder behaviour changes: this file only listens for a
 * host message and calls existing builder APIs.
 */

export const BOT_BUILDER_LOAD_STRATEGY_MESSAGE = 'NEUROTRADE_BOT_BUILDER_LOAD_STRATEGY';
export const BOT_BUILDER_STRATEGY_LOADED_MESSAGE = 'NEUROTRADE_BOT_BUILDER_STRATEGY_LOADED';

export type HostStrategyMessage = {
    type?: string;
    source?: string;
    requestId?: string;
    name?: string;
    xml?: string;
    symbol?: string | null;
};

const WORKSPACE_WAIT_MS = 30_000;

// requestId → in-flight/finished load. The host re-sends its request every
// second until it is acknowledged, so repeats must never re-load the workspace.
const loads = new Map<string, Promise<{ ok: boolean; error?: string }>>();

function ack(requestId: string, ok: boolean, error?: string) {
    try {
        window.parent?.postMessage(
            {
                type: BOT_BUILDER_STRATEGY_LOADED_MESSAGE,
                source: 'deriv-bot-builder',
                requestId,
                ok,
                error: error ?? null,
            },
            window.location.origin
        );
    } catch {
        // Host gone — nothing to acknowledge.
    }
}

function waitForWorkspace(timeout_ms: number): Promise<any | null> {
    return new Promise(resolve => {
        const started = Date.now();
        const tick = () => {
            const workspace = window.Blockly?.derivWorkspace;
            if (workspace) return resolve(workspace);
            if (Date.now() - started > timeout_ms) return resolve(null);
            window.setTimeout(tick, 250);
        };
        tick();
    });
}

/**
 * Confirm the trade-definition market path from the live `contracts_for`
 * catalogue when the builder has it. The host already fills a correct static
 * path; this only guards against Deriv re-homing a symbol.
 */
async function withVerifiedMarketPath(xml: string, symbol: string | null | undefined): Promise<string> {
    if (!symbol) return xml;
    try {
        const contracts_for = ApiHelpers?.instance?.contracts_for;
        if (!contracts_for) return xml;
        const [market, submarket] = await Promise.all([
            contracts_for.getMarketBySymbol(symbol),
            contracts_for.getSubmarketBySymbol(symbol),
        ]);
        if (!market || market === 'na' || !submarket || submarket === 'na') return xml;

        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) return xml;
        const market_block = doc.querySelector('block[type="trade_definition_market"]');
        if (!market_block) return xml;
        const set = (field_name: string, value: string) => {
            const field = market_block.querySelector(`:scope > field[name="${field_name}"]`);
            if (field) field.textContent = value;
        };
        set('MARKET_LIST', market);
        set('SUBMARKET_LIST', submarket);
        set('SYMBOL_LIST', symbol);
        return new XMLSerializer().serializeToString(doc);
    } catch {
        return xml;
    }
}

async function performLoad(message: HostStrategyMessage, store: RootStore | null) {
    const { name, xml, symbol } = message;
    if (!xml || typeof xml !== 'string') return { ok: false, error: 'No strategy XML was supplied' };

    if (store?.run_panel?.is_running) {
        return { ok: false, error: 'Stop the bot that is currently running before loading a new strategy' };
    }

    const workspace = await waitForWorkspace(WORKSPACE_WAIT_MS);
    if (!workspace) return { ok: false, error: 'The bot builder workspace is still loading — try again' };

    // Show the workspace the strategy is going into.
    try {
        store?.dashboard?.setActiveTab(DBOT_TABS.BOT_BUILDER);
    } catch {
        /* dashboard store not ready — the load itself still succeeds */
    }

    const block_string = await withVerifiedMarketPath(xml, symbol);
    const result = await load({
        block_string,
        file_name: name || 'NeuroTrade strategy',
        workspace,
        from: save_types.UNSAVED,
        drop_event: {},
        strategy_id: null,
        showIncompatibleStrategyDialog: false,
        show_snackbar: true,
    });
    if (result?.error) return { ok: false, error: String(result.error) };

    workspace.strategy_to_load = block_string;
    return { ok: true };
}

/** Handle one host request; idempotent per requestId. */
export function handleHostStrategyMessage(message: HostStrategyMessage, store: RootStore | null) {
    if (!isPreviewMode()) return;
    const requestId = message.requestId;
    if (!requestId) return;

    let pending = loads.get(requestId);
    if (!pending) {
        pending = performLoad(message, store).catch(error => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }));
        loads.set(requestId, pending);
        // Failed loads may be retried by a fresh host request with the same id.
        pending.then(result => {
            if (!result.ok) loads.delete(requestId);
        });
    }
    pending.then(result => ack(requestId, result.ok, result.error));
}
