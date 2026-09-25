import { useEffect } from 'react';
import {
    BOT_BUILDER_SYNC_MESSAGE,
    resetEmbeddedPreviewSession,
    syncEmbeddedPreviewSession,
} from './session-bridge';

type PreviewBrandingProps = {
    uiReady: boolean;
};

type PreviewSyncMessage = {
    type?: string;
    source?: string;
    connected?: boolean;
    loginId?: string | null;
};

/**
 * Compatibility shim for the builder's App Builder preview mode.
 *
 * The upstream app-content module lazy-loads this file only when
 * NEXT_PUBLIC_APP_BUILD=true. Keeping it side-effect-only preserves the original
 * builder UI while allowing the static /bot/preview bundle to compile, stay tied
 * to NeuroTrade's connected Deriv account, and notify the embedding host that the
 * iframe is ready.
 */
export default function PreviewBranding({ uiReady }: PreviewBrandingProps) {
    useEffect(() => {
        const handleMessage = async (event: MessageEvent<PreviewSyncMessage>) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type !== BOT_BUILDER_SYNC_MESSAGE) return;

            if (!event.data.connected) {
                resetEmbeddedPreviewSession();
                await syncEmbeddedPreviewSession(null);
                return;
            }

            await syncEmbeddedPreviewSession(event.data.loginId ?? null);
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, []);

    useEffect(() => {
        if (!uiReady) return;
        window.parent?.postMessage({ type: 'PREVIEW_READY', source: 'deriv-bot-builder' }, '*');
    }, [uiReady]);

    return null;
}
