/**
 * Omni Forge "Create DBot" — end-to-end proof against the REAL builder.
 *
 * Omni Forge's promise is TOTAL contract freedom with the analysis running
 * INSIDE the generated bot: the user picks any mix of digit contracts
 * (Over/Under barriers, Even/Odd, Matches/Differs) for normal trades and an
 * independent mix for recovery, and the workspace itself ranks that list
 * across every watched market before every entry. This suite loads the
 * committed fixtures into the real Deriv Blockly, compiles them through the
 * real generator, and executes the bot code against a scripted market —
 * including the just-in-time purchase that must CARRY a digit for
 * Over/Under/Matches/Differs and STRIP it for Even/Odd within one workspace.
 *
 * Fixtures come from artifacts/api-server/src/lib/omni-forge-dbot.fixtures.ts
 * (`npx tsx src/lib/omni-forge-dbot.fixtures.ts --write`); the API-side test
 * asserts the committed files still equal the generator output, so the two
 * packages cannot drift.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

// Payouts the scripted Deriv quotes — mirrors the API's canonical tables for
// exactly the contracts the three fixtures may legally buy.
const OVERUNDER_PAYOUT = {
    'DIGITOVER:1': 1.23,
    'DIGITOVER:4': 1.95,
    'DIGITUNDER:7': 1.4,
    'DIGITUNDER:8': 1.23,
};
function payoutOf(type, prediction) {
    if (type === 'DIGITEVEN' || type === 'DIGITODD') return prediction === undefined ? 1.95 : null; // parity NEVER carries a digit
    if (!(Number.isInteger(prediction) && prediction >= 0 && prediction <= 9)) return null;
    if (type === 'DIGITMATCH') return 8.93;
    if (type === 'DIGITDIFF') return 1.09;
    return OVERUNDER_PAYOUT[`${type}:${prediction}`] || null;
}

/**
 * A tape of `n` digits where exactly `rate` of them are `win`, laid out with a
 * deterministic low-discrepancy sequence so no artificial run structure leaks
 * into the statistics.
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

const NINES_HOT = tape({ rate: 0.9, win: 9, lose: 0 }); // Over 1 wins 90 %, Under 8 wins 10 %
const BALANCED_DEAD = tape({ rate: 0.5, win: 9, lose: 0 }); // both Over 1 and Under 8 sit at 50 % — EV negative for each
const UNDER7_HOT = tape({ rate: 0.95, win: 0, lose: 9 });
const UNDER7_DEAD = tape({ rate: 0.02, win: 0, lose: 9 });
const UNIFORM = Array.from({ length: 200 }, (_, i) => i % 10); // every digit 10 % — Differs EV is negative by construction

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
 * The fake `ntAnalyseContracts` re-implements the ranker's OBSERVABLE contract
 * — parse the user's `TYPE:DIGIT:PAYOUT` CSV, resolve auto digits from the
 * tape, rank by EV, gate normal entries on a positive edge and always admit
 * recovery — so the generated workspace's control flow is exercised for real.
 */
function fakeMarket({ results, digits = () => NINES_HOT, balance = 1000, switchTo = null }) {
    const state = {
        trades: [],
        notifications: [],
        totalProfit: 0,
        balance,
        purchased: false,
        tradeOptions: null,
        init: null,
        beforeEvaluations: 0,
        analyses: 0,
        decision: null,
        switched: false,
        exhausted: false,
    };
    const contract = { buy_price: 0, sell_price: 0, profit: 0, result: 'win' };
    const doPurchase = type => {
        if (state.trades.length >= results.length) { state.exhausted = true; throw new Error('SCRIPT_EXHAUSTED'); }
        const won = results[state.trades.length] === 'W';
        const stake = state.tradeOptions.amount;
        const prediction = state.tradeOptions.prediction;
        const multiplier = payoutOf(type, prediction);
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
    };
    const Bot = {
        init: (account, options) => { state.init = { account, ...options }; },
        start: options => { state.tradeOptions = options; state.purchased = false; },
        highlightBlock: () => {},
        purchase: doPurchase,
        ntPurchaseContract: (type, barrier) => {
            // The vendored native applies the digit just-in-time: barrier
            // contracts get a prediction, parity contracts must carry none.
            if (type === 'DIGITEVEN' || type === 'DIGITODD' || barrier < 0) delete state.tradeOptions.prediction;
            else state.tradeOptions.prediction = barrier;
            doPurchase(type);
        },
        ntAnalyseContracts: (mode, marketsCsv, contractsCsv, windowSize) => {
            state.analyses += 1;
            const tail = digits(state).slice(-windowSize);
            const freq = Array.from({ length: 10 }, (_, d) => tail.filter(t => t === d).length);
            const specs = contractsCsv.split(',').map(entry => {
                const [type, digit, payout] = entry.split(':');
                return { type, digit: Number(digit), payout: Number(payout) };
            });
            const resolve = s => {
                if (s.type === 'DIGITMATCH' && s.digit < 0) return freq.indexOf(Math.max(...freq));
                if (s.type === 'DIGITDIFF' && s.digit < 0) return freq.indexOf(Math.min(...freq));
                return s.digit;
            };
            const winRate = (s, barrier) =>
                tail.filter(d =>
                    s.type === 'DIGITOVER' ? d > barrier
                    : s.type === 'DIGITUNDER' ? d < barrier
                    : s.type === 'DIGITEVEN' ? d % 2 === 0
                    : s.type === 'DIGITODD' ? d % 2 === 1
                    : s.type === 'DIGITMATCH' ? d === barrier
                    : d !== barrier
                ).length / tail.length;
            let best = null;
            for (const s of specs) {
                const barrier = resolve(s);
                const probability = winRate(s, barrier);
                const ev = probability * s.payout - 1;
                if (!best || ev > best.ev) best = { ...s, barrier, probability, ev };
            }
            if (switchTo && mode === 'NORMAL' && !state.switched) {
                state.switched = true;
                state.decision = {
                    symbol: switchTo, contract: best.type, barrier: best.barrier, payout: best.payout,
                    probability: best.probability, lowerBound: best.probability - 0.01, breakEven: 1 / best.payout,
                    ev: best.ev, markov: best.probability, clustering: 1, samples: tail.length,
                    score: 5, eligible: true, reason: `SWITCH: ${switchTo} ranks higher`, changedMarket: true,
                };
                return true;
            }
            const eligible = mode === 'RECOVERY' || best.ev > 0;
            state.decision = {
                symbol: state.init.symbol,
                contract: best.type,
                barrier: best.type === 'DIGITEVEN' || best.type === 'DIGITODD' ? -1 : best.barrier,
                payout: best.payout,
                probability: best.probability,
                lowerBound: best.probability - 0.01,
                breakEven: 1 / best.payout,
                ev: best.ev,
                markov: best.probability,
                clustering: 1,
                samples: tail.length,
                score: eligible ? 5 : -5,
                eligible,
                reason: eligible ? 'READY' : 'HOLD: EV negative',
                changedMarket: false,
            };
            return eligible;
        },
        ntContractDecision: field => (state.decision ? state.decision[field] : 0),
        ntSwitchMarket: symbol => { state.init.symbol = symbol; return true; },
        isResult: r => contract.result === r,
        readDetails: i => [null, null, contract.buy_price, contract.sell_price, contract.profit][i],
        getTotalProfit: () => state.totalProfit,
        getBalance: () => state.balance,
        getLastDigitList: () => digits(state),
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

describe('Omni Forge → Deriv DBot strategy', () => {
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

    it('loads into the real builder with every Deriv root block and the user contract lists intact', () => {
        loadFixture('omni-forge-r50-mixed');
        const tops = workspace.getTopBlocks(false).map(b => b.type).sort();
        expect(tops).toEqual(['after_purchase', 'before_purchase', 'procedures_defnoreturn', 'trade_definition']);

        const market = workspace.getBlocksByType('trade_definition_market', false)[0];
        expect(market.getFieldValue('SYMBOL_LIST')).toBe('R_50');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe('overunder');
        expect(workspace.getBlocksByType('trade_definition_contracttype', false)[0].getFieldValue('TYPE_LIST')).toBe('both');

        // The recovery-sizing procedure call must bind to the definition we
        // emitted — Blockly silently roots a NEW empty definition when a
        // call's mutation names a missing procedure, which would run a no-op.
        const defs = workspace.getBlocksByType('procedures_defnoreturn', false).map(b => b.getFieldValue('NAME'));
        expect(defs).toEqual(['Size recovery stake']);
        const calls = workspace.getBlocksByType('procedures_callnoreturn', false);
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const call of calls) {
            expect(defs).toContain(call.getProcedureCall());
        }

        // The user's EXACT contract choices ride inside the workspace: one
        // analyser for the normal set, one for the recovery set.
        const analysers = workspace.getBlocksByType('nt_analyse_contracts', false);
        expect(analysers).toHaveLength(2);
        const byMode = Object.fromEntries(analysers.map(b => [b.getFieldValue('MODE'), b.getFieldValue('CONTRACTS')]));
        expect(byMode.NORMAL).toBe('DIGITOVER:1:1.23,DIGITUNDER:8:1.23');
        expect(byMode.RECOVERY).toBe('DIGITEVEN:-1:1.95,DIGITOVER:4:1.95');
        expect(workspace.getBlocksByType('nt_purchase_contract', false)).toHaveLength(1);

        const names = workspace.getAllVariables().map(v => v.name);
        expect(names).toEqual(expect.arrayContaining(['Gate Pass', 'Fire', 'Evaluations', 'Active Market', 'Recovery Debt', 'Recovery Payout']));
    });

    it('passes the run-button gate — nt_purchase_contract satisfies the mandatory Purchase block', () => {
        // Reproduces the "The Purchase block is mandatory and cannot be
        // deleted/disabled." failure: Omni Forge buys through
        // `nt_purchase_contract` (no stock `purchase` block), so the gate must
        // accept it — otherwise Deriv's Run button refuses to start the bot.
        for (const fixture of ['omni-forge-r50-mixed', 'omni-forge-1hz100v-under7-even', 'omni-forge-r10-matchdiff-forced']) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);
            // getDisabledBlocks reads the active workspace off this global.
            window.Blockly.derivWorkspace = workspace;
            expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
            expect(workspace.getBlocksByType('nt_purchase_contract', false)).toHaveLength(1);
            expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
        }
    });

    it('compiles to runnable code, ranks the user set and buys the best contract with its own digit', () => {
        loadFixture('omni-forge-r50-mixed');
        const code = buildRunner(workspace);
        expect(code).toContain("symbol              : 'R_50'");
        expect(code).toContain('Bot.ntAnalyseContracts');
        expect(code).toContain('Bot.ntPurchaseContract');

        // Tape is 90 % nines: Over 1 (EV +0.107) must beat Under 8 (EV −0.877).
        const market = fakeMarket({ results: ['W', 'W'], digits: () => NINES_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');

        expect(market.state.init.symbol).toBe('R_50');
        expect(market.state.tradeOptions.duration).toBe(1);
        expect(market.state.tradeOptions.duration_unit).toBe('t');
        expect(market.state.analyses).toBeGreaterThan(0);
        expect(market.state.trades[0]).toMatchObject({ type: 'DIGITOVER', prediction: 1, stake: 1 });
        expect(market.state.notifications[0]).toMatch(
            /NeuroTrade Omni Forge · Volatility 50 Index · normal \[Over 1, Under 8\] → recovery \[Even, Over 4\]/
        );
    });

    it('refuses to trade when EVERY chosen contract is EV-negative, and never throws while waiting', () => {
        loadFixture('omni-forge-r50-mixed');
        const code = buildRunner(workspace);
        // 50/50 nines and zeroes: Over 1 and Under 8 both win 50 % against a
        // 1.23 payout — the whole normal set is underwater, so the gate holds.
        const market = fakeMarket({ results: ['W'], digits: () => BALANCED_DEAD });
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(0);
        expect(market.state.beforeEvaluations).toBeGreaterThan(100);
        expect(market.state.notifications.some(m => /ANALYSING/.test(m))).toBe(true);
    });

    it('switches to a stronger market between contracts before firing', () => {
        loadFixture('omni-forge-r50-mixed');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['W'], digits: () => NINES_HOT, switchTo: 'R_75' });
        expect(runStrategy(code, market)).toBe('exhausted');
        // First evaluation switched instead of trading; the trade came after.
        expect(market.state.init.symbol).toBe('R_75');
        expect(market.state.notifications.some(m => /SWITCHED MARKET · now analysing R_75/.test(m))).toBe(true);
        expect(market.state.trades).toHaveLength(1);
    });

    it('runs the shared recovery ladder and strips the digit from a parity recovery leg', () => {
        loadFixture('omni-forge-1hz100v-under7-even');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W'], digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');

        const trades = market.state.trades.map(t => [t.type, t.prediction, t.stake, t.won ? 'W' : 'L']);
        expect(trades).toEqual([
            ['DIGITUNDER', 7, 0.5, 'L'], // normal leg carries its barrier → debt 0.50
            ['DIGITEVEN', undefined, 0.58, 'L'], // ceil₂(0.50 × 1.1 / 0.95) = 0.58, NO digit → debt 1.08
            ['DIGITEVEN', undefined, 1.26, 'W'], // ceil₂(1.08 × 1.1 / 0.95) = 1.26 → +1.20 clears it
            ['DIGITUNDER', 7, 0.5, 'W'], // debt cleared → back to the gated normal leg
        ]);
        expect(market.state.notifications.some(m => /Recovery step 1 — best of your recovery set at 0.58 USD to clear 0.5 USD/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
    });

    it('fires recovery without consulting the normal gate (debt is cleared, not waited out)', () => {
        loadFixture('omni-forge-1hz100v-under7-even');
        const code = buildRunner(workspace);
        // Tape goes dead right after the first (winning-gate) entry: the
        // normal leg would be refused, but the recovery leg must still fire.
        const market = fakeMarket({
            results: ['L', 'W', 'W'],
            digits: state => (state.trades.length === 0 ? UNDER7_HOT : UNDER7_DEAD),
        });
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.trades.map(t => [t.type, t.prediction])).toEqual([
            ['DIGITUNDER', 7],
            ['DIGITEVEN', undefined],
        ]);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /ANALYSING/.test(m))).toBe(true);
    });

    it('trips the circuit breaker on a clustered losing run', () => {
        loadFixture('omni-forge-1hz100v-under7-even');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: Array.from({ length: 12 }, () => 'L'), digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('stopped');
        expect(market.state.trades).toHaveLength(5); // breakerDepth 5
        expect(market.state.notifications.some(m => /Circuit breaker: 5 consecutive losses/.test(m))).toBe(true);
    });

    it('stops at take-profit and at stop-loss', () => {
        loadFixture('omni-forge-r50-mixed');
        let code = buildRunner(workspace);
        const winner = fakeMarket({ results: Array.from({ length: 60 }, () => 'W'), digits: () => NINES_HOT });
        expect(runStrategy(code, winner)).toBe('stopped');
        expect(winner.state.totalProfit).toBeGreaterThanOrEqual(10);
        expect(winner.state.notifications.some(m => /Take profit 10.00 USD reached/.test(m))).toBe(true);

        workspace.dispose();
        workspace = new window.Blockly.Workspace();
        loadFixture('omni-forge-r50-mixed');
        code = buildRunner(workspace);
        const loser = fakeMarket({ results: Array.from({ length: 20 }, () => 'L'), digits: () => NINES_HOT });
        expect(runStrategy(code, loser)).toBe('stopped');
        expect(loser.state.totalProfit).toBeLessThanOrEqual(-5);
        expect(loser.state.notifications.some(m => /Stop loss 5.00 USD hit/.test(m))).toBe(true);
    });

    it('honours the patience limit and round-trips auto digits for Matches/Differs', () => {
        loadFixture('omni-forge-r10-matchdiff-forced');
        const code = buildRunner(workspace);
        // Uniform tape: Differs wins 90 % but pays 1.09 → EV −0.019, never
        // qualifies. forceEntryAfter = 3 → refuses three times, then takes the
        // highest-ranked candidate with the tape-resolved auto digit.
        const market = fakeMarket({ results: ['W'], digits: () => UNIFORM });
        expect(runStrategy(code, market)).toBe('exhausted');
        expect(market.state.beforeEvaluations).toBeLessThanOrEqual(6);
        expect(market.state.trades).toHaveLength(1);
        expect(market.state.trades[0].type).toBe('DIGITDIFF');
        expect(market.state.trades[0].prediction).toBeGreaterThanOrEqual(0);
        expect(market.state.trades[0].prediction).toBeLessThanOrEqual(9);
        expect(market.state.notifications.some(m => /Patience limit 3/.test(m))).toBe(true);
    });

    it('never buys a contract/digit combination outside the user list on any fixture', () => {
        for (const fixture of ['omni-forge-r50-mixed', 'omni-forge-1hz100v-under7-even', 'omni-forge-r10-matchdiff-forced']) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);
            const code = buildRunner(workspace);
            const market = fakeMarket({
                results: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'L' : 'W')),
                digits: () => (fixture.includes('under7') ? UNDER7_HOT : fixture.includes('matchdiff') ? UNIFORM : NINES_HOT),
            });
            // `purchase` throws on an unknown contract/digit pair (and on a
            // parity contract that CARRIES a digit), so completing the run
            // proves every buy was legal and correctly shaped.
            expect(['stopped', 'exhausted']).toContain(runStrategy(code, market));
            expect(market.state.trades.length).toBeGreaterThan(0);
        }
    });
});
