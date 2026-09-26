// A generated paired strategy eventually returns false (partial buy, TP/SL or
// recovery cap). This must actually STOP the Bot Builder, not leave Run lit.
import dbot from '../../external/bot-skeleton/scratch/dbot';
import { api_base } from '../../external/bot-skeleton/services/api/api-base';
import { observer as globalObserver } from '../../external/bot-skeleton/utils/observer';

jest.mock('../../external/bot-skeleton/scratch/blockly', () => ({
    ensureBlocklyLoaded: jest.fn(() => Promise.resolve()),
    loadBlockly: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../external/bot-skeleton/services/tradeEngine/utils/interpreter', () =>
    jest.fn(() => ({ bot: { tradeEngine: { watchTicks: jest.fn(() => Promise.resolve()) } } }))
);
jest.mock('../../external/bot-skeleton/services/api/api-base', () => ({
    api_base: { is_stopping: false, digit45Unresolved: false, setIsRunning: jest.fn() },
}));

describe('Bot Builder Run/Stop lifecycle for finite paired XML', () => {
    beforeEach(() => {
        window.Blockly ??= {};
        api_base.is_stopping = false;
        api_base.digit45Unresolved = false;
        api_base.setIsRunning.mockClear();
        dbot.generateCode = jest.fn(() => 'finite paired strategy');
        dbot.symbol = 'R_100';
        dbot.is_bot_running = false;
    });
    it('tears down and resets the UI when the last after-purchase block finishes normally', async () => {
        const active = {
            bot: { tradeEngine: { checkTicksPromiseExists: () => true } },
            run: jest.fn(() => Promise.resolve()),
            stop: jest.fn(() => Promise.resolve()),
        };
        dbot.interpreter = active;
        dbot.runBot();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(active.run).toHaveBeenCalledWith('finite paired strategy');
        expect(active.stop).toHaveBeenCalledTimes(1);
        expect(dbot.is_bot_running).toBe(false);
        expect(api_base.setIsRunning).toHaveBeenNthCalledWith(1, true);
        expect(api_base.setIsRunning).toHaveBeenNthCalledWith(2, false);
    });

    it('refuses another Run after unresolved buys even when Stop has unlocked the generic flag', () => {
        const active = { bot: { tradeEngine: { checkTicksPromiseExists: () => true } }, run: jest.fn() };
        dbot.interpreter = active;
        api_base.digit45Unresolved = true;
        const onError = jest.fn();
        const onStop = jest.fn();
        globalObserver.register('ui.log.error', onError);
        globalObserver.register('bot.stop', onStop);
        dbot.runBot();
        expect(active.run).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledWith(expect.stringMatching(/Reconcile BOTH contract IDs/));
        expect(onStop).toHaveBeenCalledTimes(1); // reset RunPanel without a fake active bot
        globalObserver.unregister('ui.log.error', onError);
        globalObserver.unregister('bot.stop', onStop);
    });
});
