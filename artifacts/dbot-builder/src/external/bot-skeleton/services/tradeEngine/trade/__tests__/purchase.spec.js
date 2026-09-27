import withPurchase from '../Purchase';
import { BEFORE_PURCHASE, DURING_PURCHASE } from '../state/constants';
import { api_base } from '../../../api/api-base';

jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: {
            send: jest.fn(),
        },
    },
}));

jest.mock('../../utils/broadcast', () => ({
    contractStatus: jest.fn(),
    info: jest.fn(),
    log: jest.fn(),
}));

class BaseEngine {
    constructor() {
        this.options = {};
        this.tradeOptions = { amount: 1, symbol: 'R_50', duration: 1, duration_unit: 't' };
        this.data = { proposals: [], contract: {} };
        this.accountInfo = { loginid: 'CR12345' };
        this.updateAndReturnTotalRuns = () => 1;
        this.scope = BEFORE_PURCHASE;
        this.store = {
            getState: () => ({ scope: this.scope }),
            dispatch: jest.fn(action => {
                if (action?.scope === DURING_PURCHASE || action?.data?.type === 'PURCHASE_SUCCESSFUL') {
                    this.scope = DURING_PURCHASE;
                }
            }),
        };
    }
}

const PurchaseEngine = withPurchase(BaseEngine);

describe('Purchase engine concurrency & ntPurchaseContract safety', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('blocks concurrent in-flight purchase calls from sending duplicate buy orders', async () => {
        const engine = new PurchaseEngine();
        let resolveApiSend;
        api_base.api.send.mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveApiSend = resolve;
                })
        );

        // First purchase call fires
        const p1 = engine.purchase('DIGITOVER');
        expect(engine.is_purchasing).toBe(true);
        expect(api_base.api.send).toHaveBeenCalledTimes(1);

        // Second purchase call while first is in flight must be rejected/ignored
        const p2 = engine.purchase('DIGITOVER');
        expect(api_base.api.send).toHaveBeenCalledTimes(1);

        // Complete the first purchase
        resolveApiSend({ buy: { transaction_id: 111, contract_id: 222, buy_price: 1 } });
        await Promise.all([p1, p2]);

        expect(engine.is_purchasing).toBe(false);
        expect(api_base.api.send).toHaveBeenCalledTimes(1);
    });

    it('ntPurchaseContract sets barrier for digit contracts and removes for parity contracts', async () => {
        const engine = new PurchaseEngine();
        api_base.api.send.mockResolvedValue({
            buy: { transaction_id: 111, contract_id: 222, buy_price: 1 },
        });

        // Digit Over with barrier 5
        await engine.ntPurchaseContract('DIGITOVER', 5);
        expect(engine.tradeOptions.prediction).toBe(5);

        // Reset scope for next cycle
        engine.scope = BEFORE_PURCHASE;

        // Digit Even (parity must have no barrier)
        await engine.ntPurchaseContract('DIGITEVEN', -1);
        expect(engine.tradeOptions.prediction).toBeUndefined();
    });

    it('never sends the auto sentinel -1 for Matches/Differs', async () => {
        const engine = new PurchaseEngine();
        api_base.api.send.mockResolvedValue({
            buy: { transaction_id: 111, contract_id: 222, buy_price: 1 },
        });

        // A resolved auto digit is carried normally.
        await engine.ntPurchaseContract('DIGITDIFF', 7);
        expect(engine.tradeOptions.prediction).toBe(7);
        expect(api_base.api.send.mock.calls[0][0].parameters.barrier).toBe(7);

        engine.scope = BEFORE_PURCHASE;
        // If an old/imported workspace still supplies -1, preserve the last
        // legal seed instead of deleting prediction and sending an invalid buy.
        await engine.ntPurchaseContract('DIGITDIFF', -1);
        expect(engine.tradeOptions.prediction).toBe(7);
        expect(api_base.api.send.mock.calls[1][0].parameters.barrier).toBe(7);
    });
});
