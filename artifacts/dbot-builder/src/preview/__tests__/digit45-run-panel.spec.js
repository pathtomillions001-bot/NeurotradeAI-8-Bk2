import RunPanelStore from '../../stores/run-panel-store';
import { contract_stages } from '../../constants/contract-stage';

function panel() {
    const root = { dbot: {}, summary_card: { clearContractUpdateConfigValues: jest.fn() } };
    const core = { client: {}, common: { is_socket_opened: false },
        ui: { setAccountSwitcherDisabledMessage: jest.fn() } };
    return new RunPanelStore(root, core);
}

describe('finite paired strategy → Run panel STOP state', () => {
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
});
