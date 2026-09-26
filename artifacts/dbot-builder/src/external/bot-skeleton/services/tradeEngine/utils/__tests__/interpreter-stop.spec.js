// Stop must ALWAYS settle and ALWAYS release api_base.is_stopping, otherwise
// dbot.runBot() and dbot.stopBot() both early-return forever and the builder
// looks permanently frozen (the "click Stop, then nothing works" report).
import { api_base } from '../../../api/api-base';
import { observer as globalObserver } from '../../../../utils/observer';
import Interpreter from '../interpreter';

jest.mock('@/components/shared', () => ({
    isMultiplierContract: jest.fn(() => false),
}));

jest.mock('../cliTools', () => ({
    createScope: jest.fn(() => ({
        stopped: false,
        is_error_triggered: false,
        ticksService: {
            // Deriv routinely rejects `forget` for subscriptions it already
            // dropped while stopping.
            unsubscribeFromTicksService: jest.fn(() => Promise.reject(new Error('Already forgotten'))),
        },
        // Required lazily: jest forbids out-of-scope references in mock factories.
        get observer() {
            return require('../../../../utils/observer').observer;
        },
    })),
}));

jest.mock('../../Interface', () =>
    jest.fn(() => ({
        tradeEngine: {
            contractId: 12345,
            isSold: true,
            data: { contract: { contract_type: 'DIGITMATCH' } },
            options: {},
        },
    }))
);

jest.mock('../../../api/api-base', () => ({
    api_base: {
        is_stopping: false,
        digit45Unresolved: false,
        clearSubscriptions: jest.fn(),
        setIsRunning: jest.fn(),
    },
}));

jest.mock('@deriv/js-interpreter', () => function JSInterpreter() {});

describe('interpreter.stop()', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        api_base.is_stopping = false;
        api_base.digit45Unresolved = false;
        jest.useRealTimers();
    });

    it('resolves even when the tick unsubscribe rejects', async () => {
        const interpreter = Interpreter();
        await expect(interpreter.stop()).resolves.toBeUndefined();
    });

    it('releases is_stopping so Run works again', async () => {
        api_base.is_stopping = true;
        const interpreter = Interpreter();
        await interpreter.stop();
        expect(api_base.is_stopping).toBe(false);
    });

    it('emits bot.stop so the run panel leaves the stopping state', async () => {
        const on_stop = jest.fn();
        globalObserver.register('bot.stop', on_stop);
        const interpreter = Interpreter();
        await interpreter.stop();
        expect(on_stop).toHaveBeenCalled();
        globalObserver.unregister('bot.stop', on_stop);
    });

    it('waits for BOTH paired settlements before Stop tears down the subscriptions', async () => {
        const Interface = require('../../Interface');
        let resolvePair;
        let active = true;
        const pairSettled = new Promise(resolve => { resolvePair = resolve; });
        Interface.mockImplementationOnce(() => ({ tradeEngine: {
            hasActiveDigit45Pair: () => active,
            waitForDigit45PairSettled: () => pairSettled,
            contractId: '', options: {}, data: { contract: {} },
        } }));
        const interpreter = Interpreter();
        const stop = interpreter.stop();
        expect(api_base.is_stopping).toBe(true);
        expect(api_base.clearSubscriptions).not.toHaveBeenCalled();
        active = false;
        resolvePair();
        await expect(stop).resolves.toBeUndefined();
        expect(api_base.is_stopping).toBe(false);
        expect(api_base.digit45Unresolved).toBe(false);
        expect(api_base.clearSubscriptions).toHaveBeenCalled();
    });

    it('releases the Stop UI after 45 seconds but LOCKS Run if a pair stays unresolved', async () => {
        jest.useFakeTimers();
        const Interface = require('../../Interface');
        Interface.mockImplementationOnce(() => ({ tradeEngine: {
            hasActiveDigit45Pair: () => true,
            waitForDigit45PairSettled: () => new Promise(() => {}),
            contractId: '', options: {}, data: { contract: {} },
        } }));
        const interpreter = Interpreter();
        const stop = interpreter.stop();
        expect(api_base.is_stopping).toBe(true);
        jest.advanceTimersByTime(45000);
        await expect(stop).resolves.toBeUndefined();
        expect(api_base.is_stopping).toBe(false);
        expect(api_base.digit45Unresolved).toBe(true);
        jest.useRealTimers();
    });

    it('does not hang when the ticks service never settles (watchdog)', async () => {
        jest.useFakeTimers();
        const { createScope } = require('../cliTools');
        createScope.mockImplementationOnce(() => ({
            stopped: false,
            is_error_triggered: false,
            ticksService: { unsubscribeFromTicksService: jest.fn(() => new Promise(() => {})) },
            observer: globalObserver,
        }));

        const interpreter = Interpreter();
        const stopping = interpreter.stop();

        let settled = false;
        stopping.then(() => {
            settled = true;
        });

        await Promise.resolve();
        expect(settled).toBe(false);

        jest.advanceTimersByTime(10000);
        await Promise.resolve();
        await Promise.resolve();

        expect(settled).toBe(true);
        expect(api_base.is_stopping).toBe(false);
        jest.useRealTimers();
    });
});
