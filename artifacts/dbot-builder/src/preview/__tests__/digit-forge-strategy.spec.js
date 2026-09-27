/**
 * Digit Forge "Create DBot" — end-to-end proof against the REAL builder.
 *
 * Digit Forge's whole promise is that the ANALYSIS RUNS INSIDE THE GENERATED
 * BOT: no NeuroTrade service is in the loop once the user presses Run. That
 * makes this suite the acceptance test for the product, not a nicety — the
 * generated workspace has to load into the real Deriv Blockly, compile through
 * `dbot.generateCode()`, and then actually execute its own gate, its own
 * Markov counters and the shared recovery ladder against a scripted market.
 *
 * Fixtures come from artifacts/api-server/src/lib/digit-forge-dbot.fixtures.ts
 * (`npx tsx src/lib/digit-forge-dbot.fixtures.ts --write`); the API-side test
 * asserts the committed files still equal the generator output, so the two
 * packages cannot drift.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

const PAYOUT = {
    'DIGITOVER:2': 1.4,
    'DIGITOVER:4': 1.95,
    'DIGITOVER:1': 1.23,
    'DIGITOVER:5': 2.43,
    'DIGITUNDER:7': 1.4,
    'DIGITUNDER:5': 1.95,
};

/**
 * A tape of `n` digits where exactly `rate` of them satisfy `wins`, laid out
 * with a deterministic low-discrepancy sequence so the two-state Markov test
 * sees no artificial run structure (a naive "WWWW…LLLL" block would).
 */
function tape({ n = 200, rate, win, lose }) {
    const digits = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += rate;
        if (acc >= 1) { acc -= 1; digits.push(win); } else { digits.push(lose); }
    }
    return digits;
}

const OVER2_HOT = tape({ rate: 0.92, win: 9, lose: 0 }); // Over 2 wins 92 %
const OVER2_DEAD = tape({ rate: 0.05, win: 9, lose: 0 }); // Over 2 wins 5 %
const UNDER7_HOT = tape({ rate: 0.95, win: 0, lose: 9 }); // Under 7 wins 95 %
const UNDER7_DEAD = tape({ rate: 0.02, win: 0, lose: 9 });
const OVER1_DEAD = tape({ rate: 0.02, win: 9, lose: 0 });

/** Mirror of dbot.generateCode() + the interpreter's main loop, run natively. */
function buildRunner(workspace) {
    window.Blockly.derivWorkspace = workspace;
    const varDB = new window.Blockly.Names('window');
    varDB.variableMap = workspace.getVariableMap();
    window.Blockly.JavaScript.variableDB_ = varDB;

    const generator = window.Blockly.JavaScript.javascriptGenerator;
    generator.init(workspace);
    const body = generator.workspaceToCode(workspace);

    return `
        var BinaryBotPrivateInit;
        var BinaryBotPrivateStart;
        var BinaryBotPrivateBeforePurchase;
        var BinaryBotPrivateDuringPurchase;
        var BinaryBotPrivateAfterPurchase;
        var BinaryBotPrivateLastTickTime;
        var BinaryBotPrivateTickAnalysisList = [];
        var BinaryBotPrivateHasCalledTradeOptions = false;
        function BinaryBotPrivateRun(f, arg) { if (f) return f(arg); return false; }
        function BinaryBotPrivateTickAnalysis() {}
        var BinaryBotPrivateLimitations = {};
        ${body}
        BinaryBotPrivateRun(BinaryBotPrivateInit);
        var guard = 0;
        while (true) {
            if (++guard > 500) throw new Error('runaway trade loop');
            BinaryBotPrivateRun(BinaryBotPrivateStart);
            if (!BinaryBotPrivateHasCalledTradeOptions) { sleep(1); continue; }
            var beforeGuard = 0;
            while (watch('before')) {
                if (++beforeGuard > 400) throw new Error('GATE_NEVER_FIRED');
                BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);
            }
            while (watch('during')) { BinaryBotPrivateRun(BinaryBotPrivateDuringPurchase); }
            if (!BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase)) break;
        }
    `;
}

/** Scripted Deriv: `results` are the outcomes of successive purchases. */
function fakeMarket({ results, digits = () => OVER2_HOT, balance = 1000 }) {
    const state = {
        trades: [],
        notifications: [],
        totalProfit: 0,
        balance,
        purchased: false,
        tradeOptions: null,
        init: null,
        beforeEvaluations: 0,
        digitReads: 0,
        exhausted: false,
    };
    const contract = { buy_price: 0, sell_price: 0, profit: 0, result: 'win' };
    const Bot = {
        init: (account, options) => { state.init = { account, ...options }; },
        start: options => { state.tradeOptions = options; state.purchased = false; },
        highlightBlock: () => {},
        purchase: type => {
            if (state.trades.length >= results.length) { state.exhausted = true; throw new Error('SCRIPT_EXHAUSTED'); }
            const won = results[state.trades.length] === 'W';
            const stake = state.tradeOptions.amount;
            const prediction = state.tradeOptions.prediction;
            const multiplier = PAYOUT[`${type}:${prediction}`];
            if (!multiplier) throw new Error(`unexpected contract ${type} barrier ${prediction}`);
            const sell = won ? Math.round(stake * multiplier * 100) / 100 : 0;
            contract.buy_price = stake;
            contract.sell_price = sell;
            contract.profit = Math.round((sell - stake) * 100) / 100;
            contract.result = won ? 'win' : 'loss';
            state.totalProfit = Math.round((state.totalProfit + contract.profit) * 100) / 100;
            state.balance = Math.round((state.balance + contract.profit) * 100) / 100;
            state.trades.push({ type, prediction, stake, won, profit: contract.profit });
            state.purchased = true;
        },
        isResult: r => contract.result === r,
        readDetails: i => [null, null, contract.buy_price, contract.sell_price, contract.profit][i],
        getTotalProfit: () => state.totalProfit,
        getBalance: () => state.balance,
        getLastDigitList: () => { state.digitReads += 1; return digits(state); },
        ntAnalyseDigitMarkets: mode => {
            state.digitReads += 1;
            const tape = digits(state);
            const under = state.init?.symbol === '1HZ100V';
            const over1 = state.init?.symbol === 'R_10';
            const contractType = under ? 'DIGITUNDER' : 'DIGITOVER';
            const barrier = mode === 'RECOVERY' ? (over1 ? 5 : under ? 5 : 4) : (over1 ? 1 : under ? 7 : 2);
            const hits = tape.filter(d => contractType === 'DIGITOVER' ? d > barrier : d < barrier).length;
            const probability = hits / tape.length;
            const payout = PAYOUT[`${contractType}:${barrier}`];
            const eligible = mode === 'RECOVERY' || probability * payout > 1;
            state.decision = { symbol: state.init.symbol, contract: contractType, barrier, payout, probability, lowerBound: probability - 0.01, breakEven: 1 / payout, ev: probability * payout - 1, markov: probability, clustering: 1, samples: tape.length, score: eligible ? 5 : -5, eligible, reason: eligible ? 'READY' : 'HOLD: EV negative', changedMarket: false };
            return eligible;
        },
        ntDigitDecision: field => state.decision?.[field] ?? 0,
        ntSwitchMarket: symbol => { state.init.symbol = symbol; return true; },
        notify: n => state.notifications.push(n.message),
        isTradeAgain: () => {},
        getLastTick: () => ({ epoch: Date.now() }),
    };
    const watch = scope => {
        if (scope !== 'before') return false;
        if (state.purchased) return false;
        state.beforeEvaluations += 1;
        return true;
    };
    return { Bot, watch, sleep: () => {}, state };
}

function runStrategy(code, market) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('Bot', 'watch', 'sleep', code);
    try {
        fn(market.Bot, market.watch, market.sleep);
        return 'stopped';
    } catch (error) {
        if (error.message === 'SCRIPT_EXHAUSTED') return 'exhausted';
        if (error.message === 'GATE_NEVER_FIRED') return 'never-fired';
        throw error;
    }
}

describe('Digit Forge → Deriv DBot strategy', () => {
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

    const loadFixture = name => {
        const xml = readFixture(name);
        const dom = window.Blockly.utils.xml.textToDom(xml);
        // The same gates load() applies before touching the workspace.
        const block_types = Array.from(dom.querySelectorAll('block')).map(b => b.getAttribute('type'));
        expect(block_types.length).toBeGreaterThan(0);
        const unknown = block_types.filter(type => !Object.keys(window.Blockly.Blocks).includes(type));
        expect(unknown).toEqual([]);
        window.Blockly.Xml.domToWorkspace(dom, workspace);
        return xml;
    };

    it('loads into the real builder with every Deriv root block and both procedures intact', () => {
        loadFixture('forge-r50-over2-over4');
        const tops = workspace.getTopBlocks(false).map(b => b.type).sort();
        expect(tops).toEqual([
            'after_purchase',
            'before_purchase',
            'procedures_defnoreturn',
            'procedures_defnoreturn',
            'trade_definition',
        ]);

        const market = workspace.getBlocksByType('trade_definition_market', false)[0];
        expect(market.getFieldValue('SYMBOL_LIST')).toBe('R_50');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe('overunder');
        expect(workspace.getBlocksByType('trade_definition_contracttype', false)[0].getFieldValue('TYPE_LIST')).toBe('both');

        // Both procedure calls must bind to the two definitions we emitted —
        // Blockly silently ROOTS A NEW empty definition when a call's mutation
        // names a procedure that does not exist, which would run as a no-op.
        const defs = workspace.getBlocksByType('procedures_defnoreturn', false).map(b => b.getFieldValue('NAME')).sort();
        expect(defs).toEqual(['Measure the tape', 'Size recovery stake']);
        const calls = workspace.getBlocksByType('procedures_callnoreturn', false);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) {
            expect(defs).toContain(call.getProcedureCall());
        }

        // The analysis really is in the workspace: a digit list, a loop over it
        // and the transition counters the Markov test needs.
        expect(workspace.getBlocksByType('lastDigitList', false)).toHaveLength(1);
        expect(workspace.getBlocksByType('controls_forEach', false)).toHaveLength(1);
        const names = workspace.getAllVariables().map(v => v.name);
        expect(names).toEqual(expect.arrayContaining(['Win to Win', 'Loss to Win', 'Dependence G2', 'Conditional Rate', 'Worst Case Rate']));
    });

    it('compiles to runnable code and reads the tape itself before every normal entry', () => {
        loadFixture('forge-r50-over2-over4');
        const code = buildRunner(workspace);
        expect(code).toContain("symbol              : 'R_50'");
        expect(code).toContain('"DIGITOVER","DIGITUNDER"');
        expect(code).toContain('Bot.getLastDigitList()');

        const market = fakeMarket({ results: ['W', 'W'], digits: () => OVER2_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');

        expect(market.state.init.symbol).toBe('R_50');
        expect(market.state.tradeOptions.duration).toBe(1);
        expect(market.state.tradeOptions.duration_unit).toBe('t');
        // It measured the tape (in-bot analysis), then traded the normal barrier.
        expect(market.state.digitReads).toBeGreaterThan(0);
        expect(market.state.trades[0]).toMatchObject({ type: 'DIGITOVER', prediction: 2, stake: 1 });
        expect(market.state.notifications[0]).toMatch(/NeuroTrade Digit Forge · Volatility 50 Index · Over 2 normal → Over 4 recovery/);

        // Journal transparency, deliberately minimal: the user sees the state
        // and the subject of each decision, never the model behind it.
        expect(market.state.notifications.some(m => /^ENTRY · R_50 · DIGITOVER 2 · setup qualified$/.test(m))).toBe(true);
        for (const message of market.state.notifications.slice(1)) {
            expect(message).not.toMatch(/score|EV |lower bound|LCB|Markov|clustering/i);
        }
    });

    it('refuses to trade a tape that has not earned it, and never throws while waiting', () => {
        loadFixture('forge-r50-over2-over4');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['W'], digits: () => OVER2_DEAD });

        // No forced entry configured → the bot waits forever rather than trade
        // a barrier its own numbers reject. The harness guard ends the run.
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(0);
        expect(market.state.beforeEvaluations).toBeGreaterThan(100);
        expect(
            market.state.notifications.some(m => /^ANALYSING R_50 · no qualified setup yet — holding$/.test(m))
        ).toBe(true);
        // Holding is reported without leaking the statistics behind it.
        expect(market.state.notifications.some(m => /score|lower bound|clustering/i.test(m))).toBe(false);
    });

    it('runs the shared recovery ladder exactly like every other NeuroTrade bot', () => {
        loadFixture('forge-1hz100v-under7-under5-open');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W'], digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');

        const trades = market.state.trades.map(t => [t.type, t.prediction, t.stake, t.won ? 'W' : 'L']);
        expect(trades).toEqual([
            ['DIGITUNDER', 7, 0.5, 'L'], // normal leg at base stake → debt 0.50
            ['DIGITUNDER', 5, 0.58, 'L'], // ceil₂(0.50 × 1.1 / 0.95) = 0.58 → debt 1.08
            ['DIGITUNDER', 5, 1.26, 'W'], // ceil₂(1.08 × 1.1 / 0.95) = 1.26 → +1.20 clears it
            ['DIGITUNDER', 7, 0.5, 'W'], // debt cleared → back to the gated normal leg
        ]);
        expect(market.state.notifications.some(m => /Recovery step 1 — Under 5 at 0.58 USD to clear 0.5 USD/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
    });

    it('fires recovery without consulting the gate (debt is cleared at the 50 % barrier, not waited out)', () => {
        loadFixture('forge-1hz100v-under7-under5-open');
        const code = buildRunner(workspace);
        // Tape goes dead immediately after the first (winning-gate) entry: the
        // normal leg would be refused, but the recovery leg must still fire.
        const market = fakeMarket({
            results: ['L', 'W', 'W'],
            digits: state => (state.trades.length === 0 ? UNDER7_HOT : UNDER7_DEAD),
        });
        // The recovery leg fires on the dead tape (debt does not wait), the
        // debt clears, and then the bot goes straight back to refusing — the
        // third scripted result is never used.
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades.map(t => t.prediction)).toEqual([7, 5]);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /ANALYSING/.test(m))).toBe(true);
    });

    it('trips the circuit breaker on a clustered losing run', () => {
        loadFixture('forge-1hz100v-under7-under5-open');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: Array.from({ length: 12 }, () => 'L'), digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('stopped');
        expect(market.state.trades).toHaveLength(5); // breakerDepth 5
        expect(market.state.notifications.some(m => /Circuit breaker: 5 consecutive losses/.test(m))).toBe(true);
    });

    it('stops at take-profit and at stop-loss', () => {
        loadFixture('forge-r50-over2-over4');
        let code = buildRunner(workspace);
        const winner = fakeMarket({ results: Array.from({ length: 60 }, () => 'W'), digits: () => OVER2_HOT });
        expect(runStrategy(code, winner)).toBe('stopped');
        expect(winner.state.totalProfit).toBeGreaterThanOrEqual(10);
        expect(winner.state.notifications.some(m => /Take profit 10.00 USD reached/.test(m))).toBe(true);

        workspace.dispose();
        workspace = new window.Blockly.Workspace();
        loadFixture('forge-r50-over2-over4');
        code = buildRunner(workspace);
        const loser = fakeMarket({ results: Array.from({ length: 20 }, () => 'L'), digits: () => OVER2_HOT });
        expect(runStrategy(code, loser)).toBe('stopped');
        expect(loser.state.totalProfit).toBeLessThanOrEqual(-5);
        expect(loser.state.notifications.some(m => /Stop loss 5.00 USD hit/.test(m))).toBe(true);
    });

    it('honours the patience limit: a bot that never qualifies still eventually trades', () => {
        loadFixture('forge-r10-over1-over5-forced');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['W'], digits: () => OVER1_DEAD });
        expect(runStrategy(code, market)).toBe('exhausted');
        // forceEntryAfter = 3 → refuses three times, then takes the entry.
        expect(market.state.beforeEvaluations).toBeLessThanOrEqual(6);
        expect(market.state.trades).toHaveLength(1);
        expect(market.state.notifications.some(m => /Patience limit 3/.test(m))).toBe(true);
    });

    it('never buys a contract type or barrier the trade definition did not declare', () => {
        for (const fixture of ['forge-r50-over2-over4', 'forge-1hz100v-under7-under5-open', 'forge-r10-over1-over5-forced']) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);
            const code = buildRunner(workspace);
            const market = fakeMarket({
                results: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'L' : 'W')),
                digits: () => (fixture.includes('under7') ? UNDER7_HOT : fixture.includes('over1') ? tape({ rate: 0.97, win: 9, lose: 0 }) : OVER2_HOT),
            });
            // `purchase` throws on an unknown contract:barrier pair, so simply
            // completing the run proves every buy was legal.
            expect(['stopped', 'exhausted']).toContain(runStrategy(code, market));
            expect(market.state.trades.length).toBeGreaterThan(0);
        }
    });
});
