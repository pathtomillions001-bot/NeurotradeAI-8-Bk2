import RunPanelStore from '../../stores/run-panel-store';
import { contract_stages } from '../../constants/contract-stage';

function panel() {
    const root = { dbot: {}, summary_card: { clearContractUpdateConfigValues: jest.fn() } };
    const core = { client: {}, common: { is_socket_opened: false },
        ui: { setAccountSwitcherDisabledMessage: jest.fn() } };
    return new RunPanelStore(root, core);
}

describe('finite paired strategy → Run panel STOP state', () => {
    it('starts collapsed at phone/tablet widths and opens by default on desktop', () => {
        const originalWidth = window.innerWidth;
        try {
            for (const [width, open] of [[390, false], [900, false], [1440, true]]) {
                Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
                const store = panel();
                expect(store.is_drawer_open).toBe(open);
                store.disposeReactionsFn();
            }
        } finally {
            Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
        }
    });
    it('resets running and account-switching status after a settled pair', () => {
        const store = panel();
        store.setIsRunning(true);
        store.setHasOpenContract(true);
        store.onBotStopEvent();
        expect(store.is_running).toBe(false);
        expect(store.has_open_contract).toBe(false);
        expect([contract_stages.NOT_RUNNING, contract_stages.CONTRACT_CLOSED]).toContain(store.contract_stage);
        expect(store.core.ui.setAccountSwitcherDisabledMessage).toHaveBeenCalled();
        store.disposeReactionsFn();
    });
    it('does not report the whole pair CLOSED when only the first leg is sold', () => {
        const store = panel();
        store.setIsRunning(true);
        store.setContractStage(contract_stages.PURCHASE_RECEIVED);
        store.onBotContractEvent({ is_sold: true, pairPending: true });
        store.onContractStatusEvent({ id: 'contract.sold', pairPending: true });
        expect(store.contract_stage).toBe(contract_stages.PURCHASE_RECEIVED);
        expect(store.is_running).toBe(true);
        store.onBotContractEvent({ is_sold: true, pairPending: false });
        expect(store.contract_stage).toBe(contract_stages.CONTRACT_CLOSED);
        store.disposeReactionsFn();
    });

    it('also resets running if stopped before the first contract', () => {
        const store = panel();
        store.setIsRunning(true);
        store.onBotStopEvent();
        expect(store.is_running).toBe(false);
        expect(store.contract_stage).toBe(contract_stages.NOT_RUNNING);
        store.disposeReactionsFn();
    });

    it('keeps the phone drawer CLOSED after Run so Stop remains visible below the handle', async () => {
        const store = panel();
        store.core.client.is_logged_in = true;
        store.core.ui.is_mobile = true;
        store.core.ui.setPromptHandler = jest.fn();
        store.root_store.summary_card.clear = jest.fn();
        store.dbot.saveRecentWorkspace = jest.fn();
        store.dbot.unHighlightAllBlocks = jest.fn();
        store.dbot.shouldRunBot = jest.fn(() => true);
        store.dbot.getStrategySounds = jest.fn(() => []);
        store.dbot.runBot = jest.fn();
        store.root_store.transactions = { onBotContractEvent: jest.fn() };
        store.toggleDrawer(false);
        await store.onRunButtonClick();
        expect(store.dbot.runBot).toHaveBeenCalledTimes(1);
        expect(store.is_running).toBe(true);
        expect(store.is_drawer_open).toBe(false);
        store.unregisterBotListeners();
        store.disposeReactionsFn();
    });
});
