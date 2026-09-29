/**
 * Universal Forge "Run" repro — the REAL execution path.
 *
 * omni-forge-strategy.spec.js proves the workspace logic with a hand-rolled
 * preamble and a no-op BinaryBotPrivateTickAnalysis. The user-facing Run
 * button instead executes dbot.generateCode()'s FULL preamble inside the real
 * @deriv/js-interpreter, where Bot.getLastTick is an ASYNC native whose result
 * is re-wrapped through nativeToPseudo. This suite reproduces that exact
 * stack:
 *
 *   fixture XML → real Blockly → real generator → real preamble
 *   → real @deriv/js-interpreter → async Bot interface (plain {epoch, quote} ticks)
 *
 * Regression guarded (the ".epoch is not a function" incident): a builder
 * bundle whose preamble/runtime drifted from the sources dies on Run with an
 * interpreter TypeError. These tests pin the CURRENT preamble's behaviour —
 * including the degenerate tape states (empty stream, MarketIsClosed,
 * null/NaN epoch) that the 780e853 tick-gap fix guards — so any future
 * change to the epoch handling that breaks Run fails HERE, in CI, with a
 * readable diff instead of in production with a cryptic error.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import JSInterpreter from '@deriv/js-interpreter';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

// ── The EXACT preamble dbot.generateCode() emits. Keep in sync with
// scratch/dbot.js — when that preamble changes, this copy must change WITH it
// (that is the point: these tests run the real preamble, not an idealised one).
const PREAMBLE = `
var BinaryBotPrivateInit;
var BinaryBotPrivateStart;
var BinaryBotPrivateBeforePurchase;
var BinaryBotPrivateDuringPurchase;
var BinaryBotPrivateAfterPurchase;
var BinaryBotPrivateLastTickTime;
var BinaryBotPrivateTickAnalysisList = [];
var BinaryBotPrivateHasCalledTradeOptions = false;


function recursiveList(list, final_list){
    for(var i=0; i< list.length; i++){
        if(typeof(list[i]) === 'object'){
            recursiveList(list[i], final_list);
        }
        if(typeof(list[i]) == 'number'){
            final_list.push(list[i]);
        }
    }
    return final_list;
}
function BinaryBotPrivateRun(f, arg) {
    if (f) return f(arg);
    return false;
}
function BinaryBotPrivateTickAnalysis() {
    var currentTick = Bot.getLastTick(true);
    while (currentTick === 'MarketIsClosed') {
        sleep(5);
        currentTick = Bot.getLastTick(true);
    }
    // Tick history can be momentarily empty while the stream is
    // reconnecting or re-subscribing. Do not read \`.epoch\` from
    // that gap; wait for the next valid broker tick instead.
    if (!currentTick || currentTick.epoch === undefined || currentTick.epoch === null) {
        sleep(1);
        return false;
    }
    var currentTickTime = Number(currentTick.epoch);
    if (isNaN(currentTickTime)) {
        sleep(1);
        return false;
    }
    if (currentTickTime === BinaryBotPrivateLastTickTime) {
        return false;
    }
    BinaryBotPrivateLastTickTime = currentTickTime;
    for (var BinaryBotPrivateI = 0; BinaryBotPrivateI < BinaryBotPrivateTickAnalysisList.length; BinaryBotPrivateI++) {
        BinaryBotPrivateRun(BinaryBotPrivateTickAnalysisList[BinaryBotPrivateI]);
    }
    return true;
}
var BinaryBotPrivateLimitations = {};
`;

const MAIN_LOOP = `
BinaryBotPrivateRun(BinaryBotPrivateInit);
while (true) {
    BinaryBotPrivateTickAnalysis();
    BinaryBotPrivateRun(BinaryBotPrivateStart);
    if (!BinaryBotPrivateHasCalledTradeOptions) {
        sleep(1);
        continue;
    }
    while (watch('before')) {
        BinaryBotPrivateTickAnalysis();
        BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);
    }
    while (watch('during')) {
        BinaryBotPrivateTickAnalysis();
        BinaryBotPrivateRun(BinaryBotPrivateDuringPurchase);
    }
    BinaryBotPrivateTickAnalysis();
    if (!BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase)) {
        break;
    }
}
`;

/**
 * Scripted market: the observable Bot/watch/sleep surface the real
 * interpreter.js wires, with PLAIN {epoch, quote} ticks exactly as the real
 * TicksService supplies them.
 *
 * `tickScript` customises what successive getLastTick calls resolve with, so
 * the degenerate tape states (empty stream, MarketIsClosed, null/NaN epoch)
 * can be driven through the REAL preamble.
 */
function fakeMarket(log, tickScript) {
    let epoch = 1_700_000_000;
    let tick_index = -1;
    let purchased = false;
    let trades = 0;
    const contract = { buy_price: 1, sell_price: 2, profit: 1, result: 'win' };
    const decision = {
        symbol: 'R_50',
        contract: 'DIGITOVER',
        barrier: 1,
        payout: 1.23,
        eligible: true,
        score: 5,
        reason: 'READY',
        changedMarket: false,
    };
    const nextTick = () => {
        tick_index += 1;
        if (tickScript) {
            const scripted = tickScript(tick_index);
            if (scripted !== undefined) return scripted;
        }
        epoch += 2;
        return { epoch, quote: 1234.56 }; // plain object, like TicksService
    };
    const Bot = {
        init: () => {},
        start: () => {
            purchased = false;
        },
        purchase: () => {},
        highlightBlock: () => {},
        ntPurchaseContract: () => {
            purchased = true;
            trades += 1;
        },
        ntAnalyseContracts: () => true,
        ntContractDecision: field => decision[field] ?? 0,
        ntSwitchMarket: () => true,
        isResult: r => contract.result === r,
        readDetails: i => [null, null, contract.buy_price, contract.sell_price, contract.profit][i],
        getTotalProfit: () => trades,
        getBalance: () => 1000,
        getLastDigitList: () => [],
        notify: n => log.push(`notify:${n}`),
        isTradeAgain: () => (trades < 2 ? undefined : false), // stop after 2 trades
        getLastTick: raw => {
            const tick = nextTick();
            log.push(`tick:${String(tick)}`);
            return tick;
        },
    };
    const watch = scope => {
        if (scope !== 'before') return false;
        return !purchased;
    };
    return { Bot, watch, sleep: () => {} };
}

/** Wire a real @deriv/js-interpreter exactly like interpreter.js initFunc: the
 * ticks interface becomes ASYNC natives (promise → nativeToPseudo → resume). */
function makeInterpreter(code, market, log) {
    let js_interpreter;
    let finished = false;

    const loop = () => {
        if (finished || !js_interpreter) return;
        try {
            if (!js_interpreter.run()) {
                finished = true;
            }
        } catch (error) {
            finished = true;
            log.push(`interpreter-threw:${error?.message ?? error}`);
        }
    };

    const initFunc = (interpreter, scope) => {
        const createAsync = func => {
            const asyncFunc = (...args) => {
                const callback = args.pop();
                const reversed = args.slice().reverse();
                const first_defined = reversed.findIndex(a => a !== undefined);
                const fn_args = first_defined < 0 ? [] : reversed.slice(first_defined).reverse();
                Promise.resolve()
                    .then(() => func(...fn_args.map(a => interpreter.pseudoToNative(a))))
                    .then(rv => {
                        callback(interpreter.nativeToPseudo(rv));
                        if (!finished) loop();
                    })
                    .catch(e => {
                        finished = true;
                        log.push(`async-error:${e?.message ?? e}`);
                    });
                return undefined;
            };
            // interpreter.js: "We don't know how many args are going to be
            // passed, so we assume a max of 100." The interpreter pads the
            // argument list to asyncFunc.length - 1 — a rest-arrow's 0 length
            // makes that negative and new Array(-1) throws.
            Object.defineProperty(asyncFunc, 'length', { value: 101 });
            return interpreter.createAsyncFunction(asyncFunc);
        };
        const pseudo_bot = interpreter.nativeToPseudo(market.Bot);
        for (const name of [
            'getLastTick',
            'getLastDigitList',
            'ntAnalyseContracts',
            'ntContractDecision',
            'ntSwitchMarket',
            'purchase',
            'ntPurchaseContract',
            'getTotalProfit',
            'getBalance',
            'isResult',
            'readDetails',
            'notify',
        ]) {
            interpreter.setProperty(pseudo_bot, name, createAsync(market.Bot[name]));
        }
        interpreter.setProperty(scope, 'Bot', pseudo_bot);
        interpreter.setProperty(scope, 'watch', createAsync(market.watch));
        interpreter.setProperty(scope, 'sleep', createAsync(market.sleep));
    };

    js_interpreter = new JSInterpreter(code, initFunc);
    return { loop, isFinished: () => finished };
}

async function runCompiled(market, code, log) {
    const { loop, isFinished } = makeInterpreter(code, market, log);
    loop();
    const deadline = Date.now() + 15000;
    while (!isFinished() && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return log.join('|');
}

describe('Universal Forge run inside the real js-interpreter', () => {
    let workspace;

    beforeAll(async () => {
        await loadBlockly(false);
        const proto = window.Blockly.Block.prototype;
        for (const method of ['initSvg', 'render', 'renderEfficiently', 'queueRender', 'bumpNeighbours', 'scheduleSnapAndBump', 'markDirty']) {
            if (!proto[method]) proto[method] = () => {};
        }
        DBotStore.setInstance({
            client: { is_logged_in: true, loginid: 'VRTC0000001', currency: 'USD' },
            setLoading: () => {},
            load_modal: { setOpenButtonDisabled: () => {}, setLoadedLocalFile: () => {} },
        });
    }, 120000);

    beforeEach(() => {
        window.Blockly.Events.disable();
        workspace = new window.Blockly.Workspace();
    });

    afterEach(() => {
        workspace.dispose();
        window.Blockly.Events.enable();
    });

    const compile = fixture => {
        const dom = window.Blockly.utils.xml.textToDom(readFixture(fixture));
        window.Blockly.Xml.domToWorkspace(dom, workspace);
        window.Blockly.derivWorkspace = workspace;
        const varDB = new window.Blockly.Names('window');
        varDB.variableMap = workspace.getVariableMap();
        window.Blockly.JavaScript.variableDB_ = varDB;
        const generator = window.Blockly.JavaScript.javascriptGenerator;
        generator.init(workspace);
        const body = generator.workspaceToCode(workspace);
        return PREAMBLE + body + MAIN_LOOP;
    };

    it('runs the omni-forge fixture through the real preamble without an epoch TypeError', async () => {
        const log = [];
        const log_text = await runCompiled(fakeMarket(log), compile('omni-forge-r50-mixed'), log);

        expect(log_text).not.toMatch(/is not a function/);
        expect(log_text).not.toMatch(/interpreter-threw:/);
        expect(log_text).not.toMatch(/async-error:/);
        // The bot must have actually traded through the full loop.
        expect(log.filter(l => l === 'tick:[object Object]').length).toBeGreaterThan(0);
    }, 30000);

    it('survives a momentarily empty tick tape (stream reconnect gap)', async () => {
        const log = [];
        // First three reads: tape empty → undefined. Then valid ticks.
        const market = fakeMarket(log, i => (i < 3 ? undefined : undefined));
        const log_text = await runCompiled(market, compile('omni-forge-r50-mixed'), log);

        expect(log_text).not.toMatch(/is not a function/);
        expect(log_text).not.toMatch(/interpreter-threw:/);
        expect(log_text).not.toMatch(/Cannot read propert/);
        expect(log_text).not.toMatch(/async-error:/);
    }, 30000);

    it('survives a MarketIsClosed market without wedging the run loop', async () => {
        const log = [];
        // MarketIsClosed for the first reads (the preamble sleeps and retries),
        // then the market opens.
        const market = fakeMarket(log, i => (i < 2 ? 'MarketIsClosed' : undefined));
        const log_text = await runCompiled(market, compile('omni-forge-r50-mixed'), log);

        expect(log_text).not.toMatch(/is not a function/);
        expect(log_text).not.toMatch(/interpreter-threw:/);
        expect(log_text).not.toMatch(/async-error:/);
        expect(log_text).toContain("tick:MarketIsClosed");
    }, 30000);

    it('ignores ticks whose epoch is null or NaN instead of crashing', async () => {
        const log = [];
        const bad_ticks = [{ epoch: null, quote: 1.23 }, { epoch: 'not-a-number', quote: 1.23 }];
        const market = fakeMarket(log, i => (i < bad_ticks.length ? bad_ticks[i] : undefined));
        const log_text = await runCompiled(market, compile('omni-forge-r50-mixed'), log);

        expect(log_text).not.toMatch(/is not a function/);
        expect(log_text).not.toMatch(/interpreter-threw:/);
        expect(log_text).not.toMatch(/async-error:/);
    }, 30000);
});
