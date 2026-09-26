import { Suspense, useEffect } from 'react';
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
                // settle regardless — nothing in the UI waits on this
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

    // The socket handshake is kicked off at module evaluation (above) and
    // again here for safety, but the UI NEVER waits for it: the builder shell,
    // the workspace and the Run panel all render straight away and the
    // connection, auth state and active-symbol list flow in live. Gating first
    // paint on the handshake used to add a full-screen "Loading..." splash to
    // every boot for no benefit.
    useEffect(() => {
        startApiInit();
    }, []);

    if (!store) return <AppRootLoader />;

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
