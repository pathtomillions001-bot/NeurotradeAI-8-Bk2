import { configure } from 'mobx';
import ReactDOM from 'react-dom/client';
import { AuthWrapper } from './app/AuthWrapper';
// Removed AnalyticsInitializer import - analytics dependency removed
// See migrate-docs/ANALYTICS_IMPLEMENTATION_GUIDE.md for re-implementation
import {
    applyBrandFontFromConfig,
    applyDocumentTitle,
    applyFaviconFromLogo,
    applyPrimaryColorFromConfig,
} from './utils/document-branding';
import { applyReact19DomPolyfills } from './utils/react19-dom-polyfills';
import { performVersionCheck } from './utils/version-check';
import './styles/index.scss';

applyReact19DomPolyfills();

// Configure MobX to handle multiple instances in production builds
configure({ isolateGlobalState: true });

// Perform version check FIRST - before any other operations
performVersionCheck();

// Apply deploy-time document branding (tab title, favicon, web font, and primary color).
applyDocumentTitle();
applyFaviconFromLogo();
applyBrandFontFromConfig();
applyPrimaryColorFromConfig();

// Removed AnalyticsInitializer() call - analytics dependency removed

// App Builder preview branding (incl. PREVIEW_READY handshake) is handled by the
// src/preview/ listener, mounted from app-content only in the preview deployment
// (NEXT_PUBLIC_APP_BUILD === 'true') and stripped from standalone partner deploys.
ReactDOM.createRoot(document.getElementById('root')!).render(<AuthWrapper />);

/**
 * Warm the (large, ~250 kB) Blockly chunk while the user is still reading the
 * page instead of when the workspace mounts or the first Run is clicked.
 *
 * The chunk is on the critical path for both showing the workspace and starting
 * a trade, but nothing in the boot sequence needs it synchronously. Loading it
 * once the first frame is up lets the download overlap the Deriv socket
 * handshake, the account fetch and the active-symbol request, so the workspace
 * paints without another round-trip and Run is never blocked on a download.
 *
 * The call is intentionally fire-and-forget: `ensureBlocklyLoaded` is
 * single-flight and drops its memoised promise on failure, so a failed warm-up
 * simply means the workspace later retries the import itself.
 */
const warmBlocklyChunk = () => {
    import('@/external/bot-skeleton/scratch/blockly')
        .then(({ ensureBlocklyLoaded }) => ensureBlocklyLoaded())
        .catch(() => {
            /* the workspace will retry the import on demand */
        });
};

if (typeof window !== 'undefined') {
    const { requestIdleCallback } = window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    };
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(warmBlocklyChunk, { timeout: 2000 });
    } else {
        window.setTimeout(warmBlocklyChunk, 800);
    }
}
