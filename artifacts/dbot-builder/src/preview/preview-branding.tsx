import { useEffect } from 'react';

type PreviewBrandingProps = {
    uiReady: boolean;
};

/**
 * Compatibility shim for the builder's App Builder preview mode.
 *
 * The upstream app-content module lazy-loads this file only when
 * NEXT_PUBLIC_APP_BUILD=true. Keeping it side-effect-only preserves the original
 * builder UI while allowing the static /bot/preview bundle to compile and notify
 * an embedding host that the iframe is ready.
 */
export default function PreviewBranding({ uiReady }: PreviewBrandingProps) {
    useEffect(() => {
        if (!uiReady) return;
        window.parent?.postMessage({ type: 'PREVIEW_READY', source: 'deriv-bot-builder' }, '*');
    }, [uiReady]);

    return null;
}
