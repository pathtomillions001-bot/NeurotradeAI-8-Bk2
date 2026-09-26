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

// ── Boot warm-up ─────────────────────────────────────────────────────────────
// Everything below is fetched by the app a fraction of a second later anyway;
// starting it HERE turns a chunk waterfall into one parallel download burst.
//
//   index.js → lazy(layout) → lazy(app-root) → lazy(app-content) → Blockly
//
// was four sequential round-trips before the workspace could even start
// building — on a phone that is most of the "the builder keeps loading" wait.
// The imports below are the exact same modules (same resolved chunks) React
// lazy() and DBot.initWorkspace() ask for, so nothing is downloaded twice and
// by the time they are needed they are already in memory.
const warmUpBootChunks = () => {
    void import('./components/layout');
    void import('./app/app-root');
    void import('./app/app-content');
    // The Blockly core + block definitions are the single biggest chunk the
    // builder needs, and the workspace cannot render without them.
    void import('./external/bot-skeleton/scratch/blockly')
        .then(({ ensureBlocklyLoaded }) => ensureBlocklyLoaded())
        .catch(() => {
            // A failed warm-up is harmless: `ensureBlocklyLoaded` is
            // single-flight and retried by DBot.initWorkspace().
        });
};

warmUpBootChunks();
