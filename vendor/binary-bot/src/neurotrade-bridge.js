/**
 * NeuroTrade DBot Bridge (fork patch — MIT licensed base).
 *
 * Lets the NeuroTrade host app (the same-origin page embedding this builder in
 * an iframe) drive the builder programmatically:
 *
 *   parent → builder   { source:'nt-host', type:'nt:auth', token }
 *      Logs the user's Deriv account in with their PAT — no OAuth round-trip,
 *      no re-pasting tokens. Uses the fork's own addTokenIfValid() so the
 *      account, currency and balance all end up in the builder's normal store.
 *
 *   parent → builder   { source:'nt-host', type:'nt:load', xml, name }
 *      Imports a generated strategy XML into the workspace (the same code path
 *      as the "Import" button) and reports block counts back.
 *
 *   builder → parent   { source:'nt-dbot', type:'nt:ready' }
 *                      { source:'nt-dbot', type:'nt:auth:ok' | 'nt:auth:error' | 'nt:loaded' | 'nt:load:error' | 'nt:run' | 'nt:stop', ... }
 *
 * Security note: the builder runs same-origin, so postMessage is not a trust
 * boundary — the '*' target mirrors how a single-page app talks to itself. The
 * host additionally validates `event.source === iframe.contentWindow`.
 */

import { load } from '@blockly';
import { addTokenIfValid } from './common/appId';
import { observer as globalObserver } from '@utilities/observer';

const MSG_SOURCE = 'nt-dbot';
const HOST_SOURCE = 'nt-host';

const post = (type, payload = {}) => {
    try {
        window.parent?.postMessage({ source: MSG_SOURCE, type, ...payload }, '*');
    } catch {
        /* standalone (not embedded) — nothing to notify */
    }
};

const workspaceReady = () => {
    const b = window.Blockly;
    return Boolean(b && (b.getMainWorkspace?.() ?? b.mainWorkspace));
};

const waitForWorkspace = (timeoutMs = 45000) =>
    new Promise((resolve, reject) => {
        const started = Date.now();
        const t = setInterval(() => {
            if (workspaceReady()) {
                clearInterval(t);
                resolve();
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(t);
                reject(new Error('timeout'));
            }
        }, 250);
    });

const blockCount = () => {
    const ws = window.Blockly?.getMainWorkspace?.() ?? window.Blockly?.mainWorkspace;
    try {
        return ws?.getAllBlocks?.().length ?? 0;
    } catch {
        return 0;
    }
};

const handlers = {
    'nt:auth': async ({ token, loginId }) => {
        if (!token) {
            post('nt:auth:error', { message: 'empty token' });
            return;
        }
        try {
            const account = await addTokenIfValid(token);
            post('nt:auth:ok', {
                loginId: account?.accountName ?? account?.loginid ?? loginId ?? null,
                currency: account?.loginInfo?.currency ?? account?.currency ?? undefined,
                isVirtual: account?.loginInfo?.is_virtual ?? account?.is_virtual ?? undefined,
            });
        } catch (e) {
            post('nt:auth:error', { message: e?.error?.message ?? e?.message ?? 'authorize failed' });
        }
    },

    'nt:load': async ({ xml, name }) => {
        if (typeof xml !== 'string' || !xml.includes('<xml')) {
            post('nt:load:error', { message: 'no xml supplied' });
            return;
        }
        try {
            await waitForWorkspace();
            load(xml);
            // load() reports through the global observer; give the workspace a
            // beat to materialise, then count what landed.
            setTimeout(() => {
                const blocks = blockCount();
                if (blocks > 0) {
                    post('nt:loaded', { name: name ?? null, blocks });
                } else {
                    post('nt:load:error', { message: 'workspace stayed empty after import' });
                }
            }, 600);
        } catch (e) {
            post('nt:load:error', { message: e?.message ?? 'import failed' });
        }
    },

    'nt:ping': () => post('nt:pong'),
};

const onMessage = event => {
    const data = event?.data;
    if (!data || data.source !== HOST_SOURCE || typeof data.type !== 'string') return;
    handlers[data.type]?.(data);
};

export const initNeuroTradeBridge = () => {
    if (window.__ntBridgeInit) return;
    window.__ntBridgeInit = true;
    window.addEventListener('message', onMessage);

    // Mirror run state out so the host's status bar can reflect the builder.
    globalObserver.register('bot.running', () => post('nt:run'), false);
    globalObserver.register('bot.stop', data => post('nt:stop', { summary: data ?? null }), false);
    globalObserver.register('Error', e => post('nt:error', { message: e?.message ?? String(e) }), false);

    waitForWorkspace()
        .then(() => post('nt:ready', { embedded: window.parent !== window }))
        .catch(() => post('nt:ready', { embedded: window.parent !== window, late: true }));
};

initNeuroTradeBridge();
