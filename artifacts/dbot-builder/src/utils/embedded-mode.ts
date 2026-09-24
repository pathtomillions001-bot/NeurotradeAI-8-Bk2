/**
 * NeuroTrade embedded mode.
 *
 * The DBot builder is vendored into NeuroTrade and served from the SAME origin
 * as the trading platform, under `/bot/`. In this mode:
 *
 *   · account identity and the trading WebSocket come from the HOST app's API
 *     (`/api/dbot/session` and `/api/dbot/ws-url`) — the user has already
 *     connected their Deriv account there and must never be asked again, and the
 *     token never enters the browser;
 *   · the surface is trimmed to the Blockly workspace + run panel (the "trades
 *     window"), with no Deriv login/signup, dashboard, chart tab or tutorials.
 *
 * The flag is a build-time constant (`NEXT_PUBLIC_DBOT_EMBEDDED`), so rsbuild
 * dead-code-eliminates the hosted-mode branches from the embedded bundle.
 */
export const isEmbeddedMode = (): boolean => process.env.NEXT_PUBLIC_DBOT_EMBEDDED === 'true';

/**
 * Set by the host app on the builder's `window` (see the Trading platform's
 * Bot Studio page). Purely informational: account identity still comes from
 * `/api/dbot/session`, which is the authoritative, server-side answer.
 */
type NeuroTradeHostBridge = {
    /** Display name the host wants for the app chrome. */
    brandName?: string;
    /** True while the host has a Deriv account connected for this session. */
    connected?: boolean;
    /** Demo or real, as selected in the host app. */
    accountType?: 'demo' | 'real';
    /** Login id of the account the host is currently on. */
    accountId?: string;
};

declare global {
    interface Window {
        __NEUROTRADE_HOST__?: NeuroTradeHostBridge;
    }
}

export const getHostBridge = (): NeuroTradeHostBridge | undefined =>
    typeof window === 'undefined' ? undefined : window.__NEUROTRADE_HOST__;
