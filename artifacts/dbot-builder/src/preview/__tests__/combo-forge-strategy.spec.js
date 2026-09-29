/**
 * Combo Forge "Create DBot" — end-to-end proof against the REAL builder.
 *
 * Combo Forge generates a workspace that carries its OWN analysis: a prequential
 * evidence ranker (`nt_analyse_combo`) over every (market, contract) candidate —
 * digits AND Rise/Fall — with a strict default that stays silent on a fair tape.
 * This suite loads the committed fixtures into the real Deriv Blockly, compiles
 * them through the real generator and executes the bot code against scripted
 * markets. Crucially the fake `ntAnalyseCombo` calls the REAL `analyseCombo`
 * module on scripted tapes, so the decisions the workspace reacts to are the
 * ones the running bot would compute — not hand-written stubs.
 *
 * Fixtures come from artifacts/api-server/src/lib/combo-forge-dbot.fixtures.ts
 * (`npx tsx src/lib/combo-forge-dbot.fixtures.ts --write`); the API-side test
 * asserts the committed files still equal the generator output.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';
import {
    analyseCombo,
    parseComboContracts,
    normaliseStrictness,
} from '../../external/bot-skeleton/services/tradeEngine/trade/combo-forge-analysis';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

// Payouts the scripted Deriv quotes — mirrors the API's canonical tables for
// exactly the contracts the fixtures may legally buy.
const OVERUNDER_PAYOUT = {
    'DIGITOVER:1': 1.23,
    'DIGITOVER:4': 1.95,
    'DIGITUNDER:7': 1.4,
    'DIGITUNDER:8': 1.23,
};
function payoutOf(type, prediction) {
    if (type === 'CALL' || type === 'PUT') return prediction === undefined ? 1.92 : null; // direction NEVER carries a digit
    if (type === 'DIGITEVEN' || type === 'DIGITODD') return prediction === undefined ? 1.95 : null;
    if (!(Number.isInteger(prediction) && prediction >= 0 && prediction <= 9)) return null;
    if (type === 'DIGITMATCH') return 8.93;
    if (type === 'DIGITDIFF') return 1.09;
    return OVERUNDER_PAYOUT[`${type}:${prediction}`] || null;
}

// ── deterministic tapes ─────────────────────────────────────────────────────
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/** i.i.d. fair tape: uniform digits, symmetric random-walk quotes. */
function fairTape(seed, n = 1000) {
    const rand = rng(seed);
    const digits = [];
    const quotes = [];
    let q = 1000;
    for (let i = 0; i < n; i++) {
        digits.push(Math.floor(rand() * 10));
        q += rand() < 0.5 ? 0.01 : -0.01;
        quotes.push(Math.round(q * 100) / 100);
    }
    return { digits, quotes };
}
/** Digits where `rate` of ticks are `win`, the rest `lose` (low-discrepancy layout); quotes fair. */
function digitTape({ rate, win, lose, n = 1000, seed = 7 }) {
    const digits = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += rate;
        if (acc >= 1) { acc -= 1; digits.push(win); } else { digits.push(lose); }
    }
    return { digits, quotes: fairTape(seed, n).quotes };
}
/** Quotes where `upRate` of moves are up (low-discrepancy), digits fair. */
function trendTape({ upRate, n = 1000, seed = 11 }) {
    const quotes = [];
    let q = 1000;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += upRate;
        if (acc >= 1) { acc -= 1; q += 0.01; } else { q -= 0.01; }
        quotes.push(Math.round(q * 100) / 100);
    }
    return { digits: fairTape(seed, n).digits, quotes };
}

const FAIR = fairTape(12345);
const NINES_HOT = digitTape({ rate: 0.92, win: 9, lose: 0 }); // Over 1 wins 92 %
const UP_TREND = trendTape({ upRate: 0.8 });
const DOWN_TREND = trendTape({ upRate: 0.2 });
/** Every recovery leg looks BAD: only 1s and 3s (Even 0 %, Over 4 0 %) while quotes trend up (Fall ≈ 20 %). */
const RECOVERY_HOSTILE = {
    digits: Array.from({ length: 1000 }, (_, i) => (i % 2 ? 3 : 1)),
    quotes: UP_TREND.quotes,
};

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

/**
 * Scripted Deriv: `results` are the outcomes of successive purchases.
 * `tapes(state)` returns either one tape or `{ SYMBOL: tape }`; the fake
 * `ntAnalyseCombo` feeds them to the REAL analyser, exactly as the vendored
 * native does after fetching ticks.
 */
function fakeMarket({ results, tapes = () => FAIR, balance = 1000 }) {
    const state = {
        trades: [], notifications: [], totalProfit: 0, balance, purchased: false,
        tradeOptions: null, init: null, beforeEvaluations: 0, analyses: 0,
        decision: null, switches: [], exhausted: false, analysisArgs: [],
    };
    const contract = { buy_price: 0, sell_price: 0, profit: 0, result: 'win' };
    const doPurchase = type => {
        if (state.trades.length >= results.length) { state.exhausted = true; throw new Error('SCRIPT_EXHAUSTED'); }
        const won = results[state.trades.length] === 'W';
        const stake = state.tradeOptions.amount;
        const prediction = state.tradeOptions.prediction;
        const multiplier = payoutOf(type, prediction);
        if (!multiplier) throw new Error(`unexpected contract ${type} barrier ${prediction}`);
        if (!(stake >= 0.35)) throw new Error(`stake below the floor: ${stake}`);
        const sell = won ? Math.round(stake * multiplier * 100) / 100 : 0;
        contract.buy_price = stake;
        contract.sell_price = sell;
        contract.profit = Math.round((sell - stake) * 100) / 100;
        contract.result = won ? 'win' : 'loss';
        state.totalProfit = Math.round((state.totalProfit + contract.profit) * 100) / 100;
        state.balance = Math.round((state.balance + contract.profit) * 100) / 100;
        state.trades.push({ type, prediction, stake, won, profit: contract.profit, symbol: state.init.symbol });
        state.purchased = true;
    };
    const tapesFor = symbols => {
        const given = tapes(state);
        return symbols.map(symbol => {
            const t = given.digits ? given : given[symbol] || FAIR;
            return { symbol, digits: t.digits, quotes: t.quotes };
        });
    };
    const Bot = {
        init: (account, options) => { state.init = { account, ...options }; },
        start: options => { state.tradeOptions = options; state.purchased = false; },
        highlightBlock: () => {},
        purchase: doPurchase,
        ntPurchaseContract: (type, barrier) => {
            // The vendored native: barrier contracts get a just-in-time digit,
            // everything else (parity, Rise/Fall) must carry none.
            const needsDigit = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
            if (needsDigit) state.tradeOptions.prediction = Number.isInteger(barrier) && barrier >= 0 && barrier <= 9 ? barrier : 0;
            else delete state.tradeOptions.prediction;
            doPurchase(type);
        },
        ntAnalyseCombo: (mode, marketsCsv, contractsCsv, windowSize, strictness, debt, markupPercent, maxStake) => {
            state.analyses += 1;
            state.analysisArgs.push({ mode, marketsCsv, contractsCsv, windowSize, strictness, debt });
            const symbols = marketsCsv.split(',').filter(Boolean);
            const tapesList = tapesFor(symbols).map(t => ({ ...t, digits: t.digits.slice(-windowSize), quotes: t.quotes.slice(-windowSize) }));
            const { decision } = analyseCombo({
                mode, strictness: normaliseStrictness(strictness), tapes: tapesList,
                contracts: parseComboContracts(contractsCsv), currentSymbol: state.init.symbol,
                window: windowSize, rho: 0, debt: Number(debt) || 0,
                markupPercent, maxStake, balance: state.balance,
            });
            state.decision = decision;
            // Mirrors the native: the recovery stake follows the PICKED contract's payout.
            if (mode === 'RECOVERY' && decision.stake > 0) state.tradeOptions.amount = decision.stake;
            return decision.eligible === true;
        },
        ntComboDecision: field => (state.decision && state.decision[field] !== undefined ? state.decision[field] : 0),
        ntSwitchMarket: symbol => { state.switches.push(symbol); state.init.symbol = symbol; return true; },
        isResult: r => contract.result === r,
        readDetails: i => [null, null, contract.buy_price, contract.sell_price, contract.profit][i],
        getTotalProfit: () => state.totalProfit,
        getBalance: () => state.balance,
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

describe('Combo Forge → Deriv DBot strategy', () => {
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

    const reload = name => {
        workspace.dispose();
        workspace = new window.Blockly.Workspace();
        loadFixture(name);
        return buildRunner(workspace);
    };
    const FIXTURE_NAMES = ['combo-forge-r50-mixed', 'combo-forge-1hz100v-rise-fall', 'combo-forge-r10-always-forced'];

    it('loads into the real builder with every Deriv root block and the user contract lists intact', () => {
        loadFixture('combo-forge-r50-mixed');
        const tops = workspace.getTopBlocks(false).map(b => b.type).sort();
        expect(tops).toEqual(['after_purchase', 'before_purchase', 'procedures_defnoreturn', 'trade_definition']);
        expect(workspace.getBlocksByType('trade_definition_market', false)[0].getFieldValue('SYMBOL_LIST')).toBe('R_50');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe('overunder');

        const defs = workspace.getBlocksByType('procedures_defnoreturn', false).map(b => b.getFieldValue('NAME'));
        expect(defs).toEqual(['Size recovery stake']);
        const calls = workspace.getBlocksByType('procedures_callnoreturn', false);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) expect(defs).toContain(call.getProcedureCall());

        const analysers = workspace.getBlocksByType('nt_analyse_combo', false);
        expect(analysers).toHaveLength(2);
        const byMode = Object.fromEntries(analysers.map(b => [b.getFieldValue('MODE'), b]));
        expect(byMode.NORMAL.getFieldValue('CONTRACTS')).toBe('DIGITOVER:1:1.23,DIGITUNDER:8:1.23,CALL:-1:1.92');
        expect(byMode.RECOVERY.getFieldValue('CONTRACTS')).toBe('DIGITEVEN:-1:1.95,DIGITOVER:4:1.95,PUT:-1:1.92');
        expect(byMode.NORMAL.getFieldValue('STRICTNESS')).toBe('strict');
        expect(byMode.NORMAL.getFieldValue('MARKETS')).toBe('R_50,R_10,R_25,R_75');
        expect(byMode.NORMAL.getFieldValue('WINDOW')).toBe(500);
        expect(workspace.getBlocksByType('nt_purchase_contract', false)).toHaveLength(1);
    });

    it('declares a callput trade definition with no prediction for a Rise/Fall first contract', () => {
        loadFixture('combo-forge-1hz100v-rise-fall');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe('callput');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPECAT_LIST')).toBe('callput');
        expect(readFixture('combo-forge-1hz100v-rise-fall')).not.toContain('<value name="PREDICTION">');
    });

    it('passes the run-button gate on every fixture — nt_purchase_contract satisfies the mandatory Purchase block', () => {
        for (const fixture of FIXTURE_NAMES) {
            reload(fixture);
            window.Blockly.derivWorkspace = workspace;
            expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
            expect(workspace.getBlocksByType('nt_purchase_contract', false)).toHaveLength(1);
            expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
        }
    });

    it('compiles and, given real proof of an edge, buys the proven contract with its own digit', () => {
        loadFixture('combo-forge-r50-mixed');
        const code = buildRunner(workspace);
        expect(code).toContain('Bot.ntAnalyseCombo');
        expect(code).toContain('Bot.ntPurchaseContract');
        // 92 % nines: Over 1 (break-even 81.3 %) is proven; Under 8 and Rise are not.
        const market = fakeMarket({ results: ['W', 'W'], tapes: () => NINES_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.tradeOptions.duration).toBe(1);
        expect(market.state.tradeOptions.duration_unit).toBe('t');
        expect(market.state.trades[0]).toMatchObject({ type: 'DIGITOVER', prediction: 1, stake: 1, symbol: 'R_50' });
        expect(market.state.notifications[0]).toMatch(
            /NeuroTrade Combo Forge · Volatility 50 Index · normal \[Over 1, Under 8, Rise\] → recovery \[Even, Over 4, Fall\]/
        );
        expect(market.state.notifications[1]).toMatch(/^Combo Forge evidence STRICT/);
        expect(market.state.notifications.some(m => /^ENTRY · R_50 · DIGITOVER · setup qualified$/.test(m))).toBe(true);
        for (const message of market.state.notifications.slice(2)) {
            expect(message).not.toMatch(/evidence \d|nats|lower bound|LCB|e-value|threshold/i);
        }
    });

    it('STRICT: holds forever on a fair tape — never trades, never throws', () => {
        loadFixture('combo-forge-r50-mixed');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['W'], tapes: () => FAIR });
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(0);
        expect(market.state.beforeEvaluations).toBeGreaterThan(100);
        expect(market.state.notifications.some(m => /^ANALYSING R_50 · no qualified setup yet — holding$/.test(m))).toBe(true);
    }, 60000);

    it('buys Rise with NO digit when the tape is proven to trend up (Rise/Fall inside a digit workspace)', () => {
        loadFixture('combo-forge-r50-mixed');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['W'], tapes: () => UP_TREND });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.trades[0]).toMatchObject({ type: 'CALL', prediction: undefined, stake: 1 });
    });

    it('pure Rise/Fall fixture: proven downtrend buys Fall, and the window floor is honoured (80)', () => {
        loadFixture('combo-forge-1hz100v-rise-fall');
        const code = buildRunner(workspace);
        // `window: 40` in the fixture input is raised to the 80-tick floor by the generator.
        expect(code).toMatch(/\b80\b/);
        const market = fakeMarket({ results: ['W'], tapes: () => DOWN_TREND });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.trades[0]).toMatchObject({ type: 'PUT', prediction: undefined, stake: 0.5 });
        expect(market.state.analysisArgs[0].windowSize).toBe(80);
    });

    it('switches to the market that proves an edge, then trades there', () => {
        loadFixture('combo-forge-r50-mixed');
        const code = buildRunner(workspace);
        const market = fakeMarket({
            results: ['W'],
            tapes: () => ({ R_50: FAIR, R_10: FAIR, R_25: FAIR, R_75: NINES_HOT }),
        });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.switches).toEqual(['R_75']);
        expect(market.state.notifications.some(m => /SWITCHED MARKET · now analysing R_75/.test(m))).toBe(true);
        expect(market.state.trades).toHaveLength(1);
        expect(market.state.trades[0]).toMatchObject({ type: 'DIGITOVER', prediction: 1, symbol: 'R_75' });
    });

    it('runs the shared recovery ladder: debt×(1+markup)/(payout−1), rounded UP to the cent, cleared then back behind the gate', () => {
        loadFixture('combo-forge-1hz100v-rise-fall');
        const code = buildRunner(workspace);
        // Up-trend until the first trade, down-trend after: normal CALL loses, then
        // the recovery PUT (proven by the flipped tape) wins and clears the debt.
        const market = fakeMarket({
            results: ['L', 'L', 'W', 'W'],
            tapes: s => (s.trades.length === 0 ? UP_TREND : DOWN_TREND),
        });
        expect(runStrategy(code, market)).toBe('exhausted');
        const trades = market.state.trades.map(t => [t.type, t.prediction, t.stake, t.won ? 'W' : 'L']);
        expect(trades).toEqual([
            ['CALL', undefined, 0.5, 'L'], // normal leg → debt 0.50
            ['PUT', undefined, 0.6, 'L'], // ceil₂(0.50 × 1.1 / 0.92) = 0.60 → debt 1.10
            ['PUT', undefined, 1.32, 'W'], // ceil₂(1.10 × 1.1 / 0.92) = 1.32 → +1.21 clears it
            ['PUT', undefined, 0.5, 'W'], // debt cleared → base stake, gated normal leg
        ]);
        expect(market.state.notifications.some(m => /Recovery step 1 — clearing 0.5 USD with the best of your recovery set/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
        // The recovery analyser received the live debt.
        const recoveryCalls = market.state.analysisArgs.filter(a => a.mode === 'RECOVERY');
        expect(recoveryCalls.length).toBeGreaterThan(0);
        expect(recoveryCalls[0].debt).toBeCloseTo(0.5, 6);
    });

    it('recovery patience: after 20 evaluations with every recovery leg unfavourable the best ranked recovery contract is taken, at the ladder stake', () => {
        loadFixture('combo-forge-r50-mixed');
        const code = buildRunner(workspace);
        const market = fakeMarket({
            results: ['L', 'W'],
            tapes: s => (s.trades.length === 0 ? NINES_HOT : RECOVERY_HOSTILE),
        });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.trades).toHaveLength(2);
        const [first, second] = market.state.trades;
        expect(first).toMatchObject({ type: 'DIGITOVER', prediction: 1, stake: 1 });
        expect(['DIGITEVEN', 'DIGITOVER', 'PUT']).toContain(second.type);
        if (second.type === 'DIGITOVER') expect(second.prediction).toBe(4);
        if (second.type === 'DIGITEVEN') expect(second.prediction).toBeUndefined();
        if (second.type === 'PUT') expect(second.prediction).toBeUndefined();
        const payout = payoutOf(second.type, second.prediction);
        expect(second.stake).toBe(Math.ceil(((1 * 1.1) / (payout - 1)) * 100 - 1e-7) / 100);
        expect(market.state.notifications.some(m => /Patience limit 20/.test(m))).toBe(true);
        expect(market.state.beforeEvaluations).toBeGreaterThanOrEqual(21);
        expect(market.state.beforeEvaluations).toBeLessThan(30);
    }, 60000);

    it('recovery patience 0 never forces: without proof the bot holds with its debt while every recovery leg is unfavourable', () => {
        loadFixture('combo-forge-1hz100v-rise-fall');
        const code = buildRunner(workspace);
        const market = fakeMarket({
            results: ['L', 'W'],
            tapes: s => (s.trades.length === 0 ? UP_TREND : RECOVERY_HOSTILE),
        });
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(1);
    }, 60000);

    it('ALWAYS mode + patience: trades immediately on a fair tape, always with a legal concrete digit', () => {
        loadFixture('combo-forge-r10-always-forced');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W'], tapes: () => FAIR });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.trades.length).toBe(4);
        for (const trade of market.state.trades) {
            if (trade.type === 'DIGITDIFF' || trade.type === 'DIGITMATCH') {
                expect(trade.prediction).toBeGreaterThanOrEqual(0);
                expect(trade.prediction).toBeLessThanOrEqual(9);
            } else {
                expect(trade.prediction).toBeUndefined();
            }
        }
        expect(market.state.trades[0].type).toBe('DIGITDIFF');
        // A fair tape has no edge: Always mode must never pretend it found one.
        expect(market.state.notifications[1]).toMatch(/evidence ALWAYS/);
    });

    it('trips the circuit breaker after the configured consecutive losses', () => {
        loadFixture('combo-forge-r10-always-forced');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: Array.from({ length: 20 }, () => 'L'), tapes: () => FAIR });
        expect(runStrategy(code, market)).toBe('stopped');
        expect(market.state.trades).toHaveLength(8); // breakerDepth 8
        expect(market.state.notifications.some(m => /Circuit breaker: 8 consecutive losses/.test(m))).toBe(true);
        // Stakes never fell below the floor or rose above max stake / balance.
        for (const t of market.state.trades) {
            expect(t.stake).toBeGreaterThanOrEqual(0.35);
            expect(t.stake).toBeLessThanOrEqual(500);
        }
    }, 60000);

    it('stops at take-profit and at stop-loss', () => {
        let code = reload('combo-forge-r50-mixed');
        const winner = fakeMarket({ results: Array.from({ length: 80 }, () => 'W'), tapes: () => NINES_HOT });
        expect(runStrategy(code, winner)).toBe('stopped');
        expect(winner.state.totalProfit).toBeGreaterThanOrEqual(10);
        expect(winner.state.notifications.some(m => /Take profit 10.00 USD reached/.test(m))).toBe(true);

        code = reload('combo-forge-r50-mixed');
        const loser = fakeMarket({ results: Array.from({ length: 20 }, () => 'L'), tapes: () => NINES_HOT });
        expect(runStrategy(code, loser)).toBe('stopped');
        expect(loser.state.totalProfit).toBeLessThanOrEqual(-5);
        expect(loser.state.notifications.some(m => /Stop loss 5.00 USD hit/.test(m))).toBe(true);
    }, 120000);

    it('never buys a contract/digit combination outside the user list, on any fixture', () => {
        const allowed = {
            'combo-forge-r50-mixed': ['DIGITOVER', 'DIGITUNDER', 'CALL', 'DIGITEVEN', 'PUT'],
            'combo-forge-1hz100v-rise-fall': ['CALL', 'PUT'],
            'combo-forge-r10-always-forced': ['DIGITDIFF', 'DIGITMATCH', 'DIGITODD'],
        };
        for (const fixture of FIXTURE_NAMES) {
            const code = reload(fixture);
            const market = fakeMarket({
                results: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'L' : 'W')),
                tapes: s => (fixture.includes('rise-fall') ? (s.trades.length % 2 === 0 ? DOWN_TREND : UP_TREND) : fixture.includes('always') ? FAIR : s.trades.length % 2 === 0 ? NINES_HOT : DOWN_TREND),
            });
            // `purchase` throws on an unknown contract/digit pair and on a
            // digit-carrying direction/parity contract, so finishing proves legality.
            expect(['stopped', 'exhausted', 'never-fired']).toContain(runStrategy(code, market));
            expect(market.state.trades.length).toBeGreaterThan(0);
            for (const t of market.state.trades) expect(allowed[fixture]).toContain(t.type);
        }
    }, 180000);
});
