/**
 * NeuroTrade embed mode.
 *
 * The builder is iframed inside the NeuroTrade trading platform under the
 * `/dbot/` base path. When the frame URL carries `?embed=1` (or a previous
 * frame visit persisted the flag in sessionStorage for subsequent in-frame
 * navigations) we render ONLY the bot builder: no Deriv header, no footer,
 * no dashboard/chart/tutorial tabs — the workspace, run panel and the
 * transactions/journal panel are the whole UI.
 *
 * Auth is never shown either: the parent app seeds the Deriv token of the
 * account that is active in NeuroTrade into localStorage before the frame
 * boots (same origin), so DBot starts already authorized on that account.
 */
const EMBED_FLAG = 'nt_embed';

let cached: boolean | null = null;

export function isEmbedMode(): boolean {
    if (cached !== null) return cached;
    if (typeof window === 'undefined') return false;
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('embed') === '1') {
            sessionStorage.setItem(EMBED_FLAG, '1');
            cached = true;
            return cached;
        }
        if (params.has('embed') && params.get('embed') !== '1') {
            sessionStorage.removeItem(EMBED_FLAG);
        }
        cached = sessionStorage.getItem(EMBED_FLAG) === '1';
    } catch {
        cached = false;
    }
    return cached;
}
