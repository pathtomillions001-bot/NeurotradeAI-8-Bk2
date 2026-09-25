import { Suspense, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import ErrorBoundary from '@/components/error-component/error-boundary';
import ErrorComponent from '@/components/error-component/error-component';
import ChunkLoader from '@/components/loader/chunk-loader';
import { lazyWithRetry } from '@/utils/lazy-retry';
import { api_base } from '@/external/bot-skeleton';
import { useStore } from '@/hooks/useStore';
import { localize } from '@deriv-com/translations';
import './app-root.scss';

const AppContent = lazyWithRetry(() => import('./app-content'));

const AppRootLoader = () => {
    return <ChunkLoader message={localize('Loading...')} />;
};

const ErrorComponentWrapper = observer(() => {
    const { common } = useStore();

    if (!common.error) return null;

    return (
        <ErrorComponent
            header={common.error?.header}
            message={common.error?.message}
            redirect_label={common.error?.redirect_label}
            redirectOnClick={common.error?.redirectOnClick}
            should_clear_error_on_click={common.error?.should_clear_error_on_click}
            setError={common.setError}
            redirect_to={common.error?.redirect_to}
            should_redirect={common.error?.should_redirect}
        />
    );
});

// How long the boot loader may stay up while `api_base.init()` is still in
// flight before the UI is rendered anyway (the connection, auth state and
// active-symbol list all settle in the background and update the UI live).
//
// Kept deliberately short (fail-open): the workspace/Blockly mount only starts
// once AppContent renders, so every millisecond spent gating on a Deriv
// round-trip is a millisecond the user waits before their bot is usable — and
// the Run button is separately disabled until the symbols arrive, so rendering
// early cannot start a trade with stale data.
const API_INIT_UI_GATE_MS = 1200;

let api_init_promise: Promise<void> | null = null;

/**
 * Kick off `api_base.init()` as early as possible and remember the promise so
 * every caller awaits the same attempt (the socket singleton makes a second
 * concurrent init redundant).
 *
 * The eager module-scope call overlaps the Deriv WebSocket handshake (and the
 * embedded NeuroTrade session fetch) with React mounting and the async chunks
 * downloading, which shaves the round-trips off the visible boot time.
 */
const startApiInit = () => {
    if (!api_init_promise) {
        api_init_promise = api_base
            .init()
            .then(() => {
                // settle regardless — the gate only controls when the UI shows
            })
            .catch((error: unknown) => {
                console.error('API initialization failed:', error);
            });
    }
    return api_init_promise;
};

// Start immediately at module evaluation — before the first React render.
startApiInit();

const AppRoot = () => {
    const store = useStore();
    const api_init_started = useRef(false);
    const [is_api_initialized, setIsApiInitialized] = useState(false);

    // Initialize API (module-scope call above usually already resolved this).
    useEffect(() => {
        const timeoutId = setTimeout(() => {
            setIsApiInitialized(true);
        }, API_INIT_UI_GATE_MS);

        startApiInit().finally(() => {
            setIsApiInitialized(true);
            clearTimeout(timeoutId);
        });

        return () => clearTimeout(timeoutId);
    }, []);

    useEffect(() => {
        api_init_started.current = true;
    }, []);

    if (!store || !is_api_initialized) return <AppRootLoader />;

    return (
        <Suspense fallback={<AppRootLoader />}>
            <ErrorBoundary root_store={store}>
                <ErrorComponentWrapper />
                <AppContent />
            </ErrorBoundary>
        </Suspense>
    );
};

export default AppRoot;
