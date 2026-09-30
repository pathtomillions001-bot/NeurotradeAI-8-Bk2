/**
 * Generated bot code must survive a momentarily EMPTY tick tape.
 *
 * THE BUG THIS GUARDS
 * ───────────────────
 *   Pressing Run used to race the tick subscription: right after Run the tape
 *   can briefly be empty (socket still connecting, subscription re-seeded by
 *   the AlreadySubscribed handler, or cleared by a Stop → Run cycle), so
 *   `Bot.getLastTick(true)` resolves `undefined`. The generated tick-analysis
 *   prologue then read `.epoch` off `undefined`, throwing
 *
 *       Cannot read property 'epoch' of undefined
 *
 *   INSIDE the interpreted bot — the journal printed exactly that and the bot
 *   stopped before its first trade. The guard added to the template (wait for
 *   the first real tick instead of reading .epoch blindly) is asserted here
 *   as BEHAVIOUR of the code the builder actually generates, not as a source
 *   string search: the analysis passes above must neither throw nor run a
 *   single analysis block until a real tick exists.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (m, key) => (args && key in args ? args[key] : m)) : text
);

const readFixture = name =>
    fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.xml`), 'utf8');

/** Extract + hydrate the generated tick-analysis prologue with test doubles. */
const hydrateTickAnalysis = generated => {
    const match = /function BinaryBotPrivateTickAnalysis\(\) \{[\s\S]*?\n {12}\}/.exec(generated);
    expect(match).not.toBeNull();
    const body = match[0];
    const factory = new Function(
        'Bot',
        'sleep',
        `
        var BinaryBotPrivateLastTickTime;
        var BinaryBotPrivateTickAnalysisList = [];
        var BinaryBotPrivateRun = function (f, arg) { return f ? f(arg) : false; };
        ${body}
        return {
            run: BinaryBotPrivateTickAnalysis,
            seen: function () { return BinaryBotPrivateLastTickTime; },
            list: BinaryBotPrivateTickAnalysisList,
        };
    `
    );
    return factory;
};

describe('generated bot code — empty tick tape safety', () => {
    let generateWith;

    beforeAll(async () => {
        await loadBlockly(false);
        const proto = window.Blockly.Block.prototype;
        for (const method of [
            'initSvg',
            'render',
            'renderEfficiently',
            'queueRender',
            'bumpNeighbours',
            'scheduleSnapAndBump',
            'markDirty',
        ]) {
            if (!proto[method]) proto[method] = () => {};
        }
        DBotStore.setInstance({
            client: { is_logged_in: true, loginid: 'VRTC0000001', currency: 'USD' },
            setLoading: () => {},
            load_modal: { setOpenButtonDisabled: () => {}, setLoadedLocalFile: () => {} },
        });
        window.Blockly.Events.disable();
        const workspace = new window.Blockly.Workspace();
        const dom = window.Blockly.utils.xml.textToDom(readFixture('nexus-hedge-parity-hedge'));
        window.Blockly.Xml.domToWorkspace(dom, workspace);
        window.Blockly.derivWorkspace = workspace;
        // Exactly what initWorkspace does for the running app (dbot.js): the
        // vendored variable blocks read names from this legacy namespace.
        const varDB = new window.Blockly.Names('window');
        varDB.variableMap = workspace.getVariableMap();
        window.Blockly.JavaScript.variableDB_ = varDB;
        generateWith = () => {
            // dbot.js' generateCode only reads this.workspace + the generator.
            const DBot = require('../../external/bot-skeleton/scratch/dbot').default;
            const previous = DBot.workspace;
            DBot.workspace = workspace;
            try {
                return DBot.generateCode();
            } finally {
                DBot.workspace = previous;
            }
        };
    }, 120000);

    const analysisRuns = () => {
        const calls = [];
        const Bot = { getLastTick: jest.fn(() => undefined) };
        const sleep = jest.fn();
        const factory = hydrateTickAnalysis(generateWith());
        const harness = factory(Bot, sleep);
        harness.list.push(() => calls.push('analysis'));
        return { calls, Bot, sleep, harness };
    };

    it('an empty tape (undefined tick) neither throws nor runs tick analysis — it waits', () => {
        const { calls, sleep, harness } = analysisRuns();
        expect(() => harness.run()).not.toThrow(); // previously: TypeError "Cannot read property 'epoch' of undefined"
        expect(calls).toHaveLength(0);
        expect(sleep).toHaveBeenCalled(); // waits for the first real tick instead of dying
        expect(harness.seen()).toBeUndefined();
    });

    it('a tape whose last tick lacks epoch is treated as empty, not as a crash', () => {
        const { calls, harness, Bot } = analysisRuns();
        Bot.getLastTick.mockImplementation(() => ({ quote: 100.05 }));
        expect(() => harness.run()).not.toThrow();
        expect(calls).toHaveLength(0);
    });

    it('a real tick resumes analysis exactly once per epoch (dedupe preserved)', () => {
        const { calls, harness, Bot } = analysisRuns();
        // One empty pass first (the old crash site), then ticks arrive.
        expect(() => harness.run()).not.toThrow();
        Bot.getLastTick.mockImplementation(() => ({ epoch: 42, quote: 100.05 }));
        harness.run();
        harness.run(); // same epoch → analysis must NOT re-run
        Bot.getLastTick.mockImplementation(() => ({ epoch: 43, quote: 100.06 }));
        harness.run();
        expect(calls).toHaveLength(2);
        expect(harness.seen()).toBe(43);
    });

    it('MarketIsClosed waiting behaviour is unchanged', () => {
        const { calls, harness, Bot, sleep } = analysisRuns();
        let polls = 0;
        Bot.getLastTick.mockImplementation(() => {
            polls += 1;
            return polls > 2 ? { epoch: 7, quote: 1 } : 'MarketIsClosed';
        });
        harness.run();
        expect(polls).toBe(3);
        expect(sleep.mock.calls.some(([seconds]) => seconds === 5)).toBe(true);
        expect(calls).toHaveLength(1);
    });
});
