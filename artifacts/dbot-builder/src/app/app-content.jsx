import React, { lazy, Suspense, useEffect, useLayoutEffect } from 'react';
import { observer } from 'mobx-react-lite';
import { ToastContainer } from 'react-toastify';
import AuthLoadingWrapper from '@/components/auth-loading-wrapper';
import { botNotification } from '@/components/bot-notification/bot-notification';
import useLiveChat from '@/components/chat/useLiveChat';
import { lazyWithRetry } from '@/utils/lazy-retry';
import { getUrlBase } from '@/components/shared';
import TransactionDetailsModal from '@/components/transaction-details';
import { api_base, ApiHelpers, ServerTime } from '@/external/bot-skeleton';
import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { useApiBase } from '@/hooks/useApiBase';
import useDevMode from '@/hooks/useDevMode';
import { useStore } from '@/hooks/useStore';
import useThemeSwitcher from '@/hooks/useThemeSwitcher';
import { isPreviewMode } from '@/utils/is-preview-mode';
import { ThemeProvider } from '@deriv-com/quill-ui';
import { setSmartChartsPublicPath } from '@deriv-com/smartcharts-champion';
import { localize } from '@deriv-com/translations';
import Audio from '../components/audio';
import BlocklyLoading from '../components/blockly-loading';
import BotBuilder from '../pages/bot-builder';
import Main from '../pages/main';
import './app.scss';
import 'react-toastify/dist/ReactToastify.css';
import '../components/bot-notification/bot-notification.scss';

// App Builder live-preview branding listener. Mounted only in the preview deployment
// (NEXT_PUBLIC_APP_BUILD === 'true'); the inline check is constant-folded by rsbuild so
// the import — and all of src/preview/ — is dead-code-eliminated from standalone partner
// builds (where the BFF strips src/preview/ entirely).
const PreviewBranding =
    process.env.NEXT_PUBLIC_APP_BUILD === 'true' ? lazyWithRetry(() => import('../preview/preview-branding')) : null;

const AppContent = observer(() => {
    const [is_api_initialized, setIsApiInitialized] = React.useState(false);
    // Whether the Deriv symbol catalogue has arrived. It is NOT a render gate:
    // the builder shell, workspace and Run panel paint immediately and the
    // market dropdowns refresh in place once the catalogue lands (see
    // `loadActiveSymbols` below). Blocking the whole UI on this round-trip was
    // the "Initializing Deriv Bot account..." splash users waited on at every
    // single boot.
    const [are_symbols_loaded, setAreSymbolsLoaded] = React.useState(false);

    const store = useStore();
    const { app, transactions, common, client } = store;
    const { is_dark_mode_on } = useThemeSwitcher();

    const { recovered_transactions, recoverPendingContracts } = transactions;
    const is_subscribed_to_msg_listener = React.useRef(false);
    const msg_listener = React.useRef(null);
    const { connectionStatus } = useApiBase();

    // Initialize dev mode keyboard shortcuts
    useDevMode();

    // Warn (once) when the OAuth app id isn't configured, so a developer running
    // locally understands why Log in / Sign up are disabled. Skipped inside the
    // App Builder static preview, which intentionally runs without env vars.
    useEffect(() => {
        if (isPreviewMode()) return;
        if (!process.env.NEXT_PUBLIC_DERIV_APP_ID) {
            botNotification(localize('Waiting for environment variables to be set…'), undefined, { type: 'warning' });
        }
    }, []);

    const livechat_client_information = {
        is_client_store_initialized: client?.is_logged_in ? true : !!client,
        is_logged_in: client?.is_logged_in,
        loginid: client?.loginid,
        currency: client?.currency,
        residence: client?.residence,
        email: '',
        first_name: '',
        last_name: '',
    };

    useLiveChat(livechat_client_information);

    // NOTE: Disabled Intercom until further notice
    // const token = V2GetActiveToken() ?? null;
    // useIntercom(token);

    useEffect(() => {
        if (connectionStatus === CONNECTION_STATUS.OPENED) {
            setIsApiInitialized(true);
            common.setSocketOpened(true);
        } else if (connectionStatus !== CONNECTION_STATUS.OPENED) {
            common.setSocketOpened(false);
        }
    }, [common, connectionStatus]);

    const { current_language } = common;
    const html = document.documentElement;
    React.useEffect(() => {
        html?.setAttribute('lang', current_language.toLowerCase());
        html?.setAttribute('dir', current_language.toLowerCase() === 'ar' ? 'rtl' : 'ltr');
    }, [current_language, html]);

    const handleMessage = React.useCallback(
        ({ data }) => {
            if (data?.msg_type === 'proposal_open_contract' && !data?.error) {
                const { proposal_open_contract } = data;
                if (
                    proposal_open_contract?.status !== 'open' &&
                    !recovered_transactions?.includes(proposal_open_contract?.contract_id)
                ) {
                    recoverPendingContracts(proposal_open_contract);
                }
            }
        },
        [recovered_transactions, recoverPendingContracts]
    );

    React.useEffect(() => {
        setSmartChartsPublicPath(getUrlBase('/js/smartcharts/'));
    }, []);

    React.useEffect(() => {
        // Check if api is initialized and then subscribe to the api messages
        // Also we should only subscribe to the messages once user is logged in
        // And is not already subscribed to the messages
        if (!is_subscribed_to_msg_listener.current && client.is_logged_in && is_api_initialized && api_base?.api) {
            is_subscribed_to_msg_listener.current = true;
            msg_listener.current = api_base.api.onMessage()?.subscribe(handleMessage);
        }
        return () => {
            if (is_subscribed_to_msg_listener.current && msg_listener.current) {
                is_subscribed_to_msg_listener.current = false;
                msg_listener.current.unsubscribe?.();
            }
        };
    }, [is_api_initialized, client.is_logged_in, client.loginid, handleMessage, connectionStatus]);

    const init = React.useCallback(() => {
        ServerTime.init(common);
        app.setDBotEngineStores();
        ApiHelpers.setInstance(app.api_helpers_store);
        import('@/utils/gtm').then(({ default: GTM }) => {
            GTM.init(store);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [app, common, store]);

    // Wire the DBot engine stores BEFORE the first paint of <BotBuilder />.
    // `app.onMount()` (which injects the Blockly workspace) needs
    // `app.dbot_store`, and a layout effect here runs before the children's
    // mount effects — so the workspace starts building in the very first
    // frame instead of waiting for the websocket handshake.
    useLayoutEffect(() => {
        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Fetch the symbol catalogue in the BACKGROUND and refresh the market
     * dropdowns of any block already on the canvas when it arrives. Nothing
     * here blocks rendering: `trade_definition_market` falls back to the
     * built-in market list until the live one lands.
     */
    const loadActiveSymbols = React.useCallback(() => {
        const retrieveActiveSymbols = () => {
            const { active_symbols } = ApiHelpers.instance ?? {};
            if (!active_symbols) return;

            active_symbols
                .retrieveActiveSymbols(true)
                .then(() => {
                    setAreSymbolsLoaded(true);
                    app.refreshMarketBlocks();
                })
                .catch(error => {
                    // eslint-disable-next-line no-console
                    console.error('Failed to load active symbols:', error);
                });
        };

        if (ApiHelpers?.instance?.active_symbols) {
            retrieveActiveSymbols();
            return undefined;
        }

        // ApiHelpers is created by `init()` above, but the socket may replace
        // the instance while reconnecting — poll briefly instead of failing.
        const intervalId = setInterval(() => {
            if (ApiHelpers?.instance?.active_symbols) {
                clearInterval(intervalId);
                retrieveActiveSymbols();
            }
        }, 500);
        return () => clearInterval(intervalId);
    }, [app]);

    React.useEffect(() => {
        if (!is_api_initialized) return undefined;
        init();
        return loadActiveSymbols();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [is_api_initialized, client.loginid]);

    if (common?.error) return null;

    return (
        <React.Fragment>
            {PreviewBranding && (
                <Suspense fallback={null}>
                    <PreviewBranding uiReady={are_symbols_loaded} />
                </Suspense>
            )}
            <AuthLoadingWrapper>
                <ThemeProvider theme={is_dark_mode_on ? 'dark' : 'light'}>
                    <BlocklyLoading />
                    <div className='bot-dashboard bot' data-testid='dt_bot_dashboard'>
                        <Audio />
                        <Main />
                        <BotBuilder />
                        <TransactionDetailsModal />
                        <ToastContainer limit={3} draggable={false} />
                    </div>
                </ThemeProvider>
            </AuthLoadingWrapper>
        </React.Fragment>
    );
});

export default AppContent;
