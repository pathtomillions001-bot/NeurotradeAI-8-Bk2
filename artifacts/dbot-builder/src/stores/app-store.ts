// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { action, makeObservable, reaction } from 'mobx';
import { api_base, ApiHelpers, DBot, runIrreversibleEvents } from '@/external/bot-skeleton';
import { setCurrency } from '@/external/bot-skeleton/scratch/utils';
import { isPreviewMode, PREVIEW_BASE_PATH } from '@/utils/is-preview-mode';
import { TApiHelpersStore } from '@/types/stores.types';
import RootStore from './root-store';

export default class AppStore {
    root_store: RootStore;
    core: RootStore['core'];
    dbot_store: RootStore | null;
    api_helpers_store: TApiHelpersStore | null;
    timer: ReturnType<typeof setInterval> | null;
    disposeReloadOnLanguageChangeReaction: unknown;
    disposeCurrencyReaction: unknown;
    disposeSwitchAccountListener: unknown;

    disposeResidenceChangeReaction: unknown;

    constructor(root_store: RootStore, core: RootStore['core']) {
        makeObservable(this, {
            onMount: action,
            onUnmount: action,
            refreshMarketBlocks: action,
            registerCurrencyReaction: action,
            registerOnAccountSwitch: action,

            registerResidenceChangeReaction: action,
            setDBotEngineStores: action,
            onClickOutsideBlockly: action,
        });

        this.root_store = root_store;
        this.core = core;
        this.dbot_store = null;
        this.api_helpers_store = null;
        this.timer = null;
    }

    onMount = async () => {
        const { blockly_store, run_panel } = this.root_store;
        const { ui } = this.core;

        let timer_counter = 1;

        this.timer = setInterval(() => {
            if (window.sendRequestsStatistic) {
                window.sendRequestsStatistic(false);
                performance.clearMeasures();
                if (timer_counter === 6 || run_panel?.is_running) {
                    if (this.timer) clearInterval(this.timer);
                } else {
                    timer_counter++;
                }
            }
        }, 10000);

        // The engine stores are normally wired by app-content's layout effect
        // before this runs. Wire them here too if they are missing: bailing
        // out silently (the old behaviour) meant a single ordering change left
        // the Bot Builder tab permanently empty, with no error anywhere.
        if (!this.dbot_store) {
            this.setDBotEngineStores();
        }
        if (!this.dbot_store) return;

        blockly_store.setLoading(true);
        // The base path seeds `window.__webpack_public_path__`, which Blockly media and
    // flyout image URLs are built from. In the embedded preview build the app is
    // served under /bot/preview, so pass that base instead of '/'.
    await DBot.initWorkspace(isPreviewMode() ? `${PREVIEW_BASE_PATH}/` : '/', this.dbot_store, this.api_helpers_store, ui.is_mobile, false);

        blockly_store.setContainerSize();
        blockly_store.setLoading(false);

        this.registerCurrencyReaction.call(this);
        this.registerOnAccountSwitch.call(this);

        this.registerResidenceChangeReaction.call(this);

        window.addEventListener('click', this.onClickOutsideBlockly);

        blockly_store.getCachedActiveTab();
    };

    onUnmount = () => {
        DBot.terminateBot();
        DBot.terminateConnection();
        if (window.Blockly?.derivWorkspace) {
            clearInterval(window.Blockly?.derivWorkspace.save_workspace_interval);
            window.Blockly.derivWorkspace?.dispose();
        }
        if (typeof this.disposeReloadOnLanguageChangeReaction === 'function') {
            this.disposeReloadOnLanguageChangeReaction();
        }
        if (typeof this.disposeCurrencyReaction === 'function') {
            this.disposeCurrencyReaction();
        }
        if (typeof this.disposeSwitchAccountListener === 'function') {
            this.disposeSwitchAccountListener();
        }

        if (typeof this.disposeResidenceChangeReaction === 'function') {
            this.disposeResidenceChangeReaction();
        }

        window.removeEventListener('click', this.onClickOutsideBlockly);

        // Ensure account switch is re-enabled.
        // TODO: fix
        const { ui } = this.core;

        ui.setAccountSwitcherDisabledMessage();
        ui.setPromptHandler(false);

        if (this.timer) clearInterval(this.timer);
        performance.clearMeasures();
    };

    registerCurrencyReaction = () => {
        // Syncs all trade options blocks' currency with the client's active currency.
        this.disposeCurrencyReaction = reaction(
            () => this.core.client.currency,
            () => {
                if (!window.Blockly?.derivWorkspace) return;

                const trade_options_blocks = window.Blockly?.derivWorkspace
                    .getAllBlocks()
                    .filter(
                        b =>
                            b.type === 'trade_definition_tradeoptions' ||
                            b.type === 'trade_definition_multiplier' ||
                            b.type === 'trade_definition_accumulator' ||
                            (b.isDescendantOf('trade_definition_multiplier') && b.category_ === 'trade_parameters')
                    );

                trade_options_blocks.forEach(trade_options_block => setCurrency(trade_options_block));
            }
        );
    };

    /**
     * Re-populate the market/submarket/symbol dropdowns of every
     * `trade_definition_market` block from the CURRENT symbol catalogue.
     *
     * The builder paints before the catalogue has arrived (the symbol fetch is
     * a background round-trip, no longer a full-screen gate), so the blocks
     * come up with the built-in fallback list; this re-fires the block-create
     * event Blockly listens to, which refreshes them in place the moment the
     * live list lands. Safe to call at any time — it is a no-op until both the
     * workspace and the catalogue exist.
     */
    refreshMarketBlocks = () => {
        const workspace = window.Blockly?.derivWorkspace;
        if (!workspace) return;
        if (!ApiHelpers?.instance?.active_symbols) return;

        ApiHelpers.instance.contracts_for?.disposeCache?.();
        workspace
            .getAllBlocks()
            .filter((block: { type: string }) => block.type === 'trade_definition_market')
            .forEach((block: unknown) => {
                runIrreversibleEvents(() => {
                    const fake_create_event = new window.Blockly.Events.BlockCreate(block);
                    window.Blockly.Events.fire(fake_create_event);
                });
            });
    };

    registerOnAccountSwitch = () => {
        this.disposeSwitchAccountListener = reaction(
            () => this.root_store.common?.is_socket_opened,
            is_socket_opened => {
                if (!is_socket_opened) return;
                this.api_helpers_store = {
                    server_time: this.root_store.common.server_time,
                    ws: api_base.api,
                };

                if (!ApiHelpers?.instance) {
                    ApiHelpers.setInstance(this.api_helpers_store);
                }

                const active_symbols = ApiHelpers?.instance?.active_symbols;
                const contracts_for = ApiHelpers?.instance?.contracts_for;

                if (ApiHelpers?.instance && active_symbols && contracts_for) {
                    if (window.Blockly?.derivWorkspace) {
                        active_symbols?.retrieveActiveSymbols(true).then(() => this.refreshMarketBlocks());
                    }
                    DBot.initializeInterpreter();
                }
            }
        );
    };

    registerResidenceChangeReaction = () => {
        // Country code no longer available from removed get_settings API
        // Previously set up residence change reaction here
    };

    setDBotEngineStores = () => {
        const { flyout, toolbar, save_modal, dashboard, load_modal, run_panel, blockly_store, summary_card } =
            this.root_store;
        const { client, common } = this.core;
        const { handleFileChange } = load_modal;
        const { setLoading } = blockly_store;
        const { setContractUpdateConfig } = summary_card;
        const {
            ui: { is_mobile },
        } = this.core;

        this.dbot_store = {
            client,
            flyout,
            toolbar,
            save_modal,
            dashboard,
            load_modal,
            run_panel,
            setLoading,
            setContractUpdateConfig,
            handleFileChange,
            is_mobile,
            common,
        };

        this.api_helpers_store = {
            server_time: this.core.common.server_time,
            ws: api_base.api,
        };
    };

    onClickOutsideBlockly = (event: Event) => {
        if (document.querySelector('.injectionDiv')) {
            const path = event.path || (event.composedPath && event.composedPath());
            const is_click_outside_blockly = !path.some(
                (el: Element) => el.classList && el.classList.contains('injectionDiv')
            );

            if (is_click_outside_blockly) {
                window.Blockly?.hideChaff(/* allowToolbox */ false);
            }
        }
    };
}
