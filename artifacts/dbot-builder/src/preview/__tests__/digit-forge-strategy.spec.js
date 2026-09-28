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
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';
import { isDigitForgeContract } from '../../external/bot-skeleton/services/tradeEngine/trade/digit-forge-contracts';
// The actual app policy is the oracle, not a second handwritten stake formula.
import {
    addMoney, applyRecoveryStakeLimits, calculateBotRecoveryStake, settleRecoveryWin,
} from '../../../../api-server/src/lib/recovery-math';

localize.mockImplementation((text, args) =>
    typeof text === 'string'
        ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match))
        : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

const PAYOUT = {
    'DIGITOVER:2': 1.4,
    'DIGITOVER:4': 1.95,
    'DIGITOVER:1': 1.23,
    'DIGITOVER:5': 2.43,
    'DIGITUNDER:7': 1.4,
    'DIGITUNDER:8': 1.23,
    'DIGITUNDER:5': 1.95,
    'DIGITUNDER:4': 2.43,
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
        if (acc >= 1) {
            acc -= 1;
            digits.push(win);
        } else {
            digits.push(lose);
        }
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
function fakeMarket({ results, digits = () => OVER2_HOT, balance = 1000, recoveryHoldEvaluations = 0, decisionFor, payoutFor, switchFails = false }) {
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
        recoveryAnalyses: 0,
        exhausted: false,
        debt: 0,
        preparations: [],
        purchases: [],
    };
    const contract = { buy_price: 0, sell_price: 0, profit: 0, result: 'win' };
    const Bot = {
        init: (account, options) => {
            state.init = { account, ...options };
        },
        start: options => {
            state.tradeOptions = options;
            state.baseStake ??= options.amount;
            state.purchased = false;
        },
        highlightBlock: () => {},
        purchase: type => {
            if (state.trades.length >= results.length) {
                state.exhausted = true;
                throw new Error('SCRIPT_EXHAUSTED');
            }
            const won = results[state.trades.length] === 'W';
            const stake = state.tradeOptions.amount;
            const prediction = state.tradeOptions.prediction;
            const multiplier = state.prepared?.payout ?? PAYOUT[`${type}:${prediction}`];
            if (!multiplier) throw new Error(`unexpected contract ${type} barrier ${prediction}`);
            const sell = won ? Math.round(stake * multiplier * 100) / 100 : 0;
            contract.buy_price = stake;
            contract.sell_price = sell;
            contract.profit = Math.round((sell - stake) * 100) / 100;
            contract.result = won ? 'win' : 'loss';
            state.totalProfit = Math.round((state.totalProfit + contract.profit) * 100) / 100;
            state.balance = Math.round((state.balance + contract.profit) * 100) / 100;
            state.trades.push({ type, prediction, stake, won, profit: contract.profit, symbol: state.init.symbol });
            state.debt = won
                ? settleRecoveryWin({ unrecoveredAmount: state.debt, remainingTargetProfit: 0, actualNetProfit: contract.profit }).remainingDebt
                : addMoney(state.debt, stake);
            state.purchased = true;
        },
        isResult: r => contract.result === r,
        readDetails: i => [null, null, contract.buy_price, contract.sell_price, contract.profit][i],
        getTotalProfit: () => state.totalProfit,
        getBalance: () => state.balance,
        getLastDigitList: () => {
            state.digitReads += 1;
            return digits(state);
        },
        ntAnalyseDigitMarkets: mode => {
            state.digitReads += 1;
            const tape = digits(state);
            const under = state.init?.symbol === '1HZ100V';
            const over1 = state.init?.symbol === 'R_10';
            const contractType = under ? 'DIGITUNDER' : 'DIGITOVER';
            const barrier = mode === 'RECOVERY' ? (under ? 4 : 5) : over1 ? 1 : under ? 7 : 2;
            const hits = tape.filter(d => (contractType === 'DIGITOVER' ? d > barrier : d < barrier)).length;
            const probability = hits / tape.length;
            const payout = PAYOUT[`${contractType}:${barrier}`];
            if (mode === 'RECOVERY') state.recoveryAnalyses += 1;
            const eligible =
                mode === 'RECOVERY' ? state.recoveryAnalyses > recoveryHoldEvaluations : probability * payout > 1;
            state.decision = {
                mode,
                digits: tape,
                symbol: state.init.symbol,
                contract: contractType,
                barrier,
                payout,
                probability,
                lowerBound: probability - 0.01,
                breakEven: 1 / payout,
                ev: probability * payout - 1,
                markov: probability,
                clustering: 1,
                samples: tape.length,
                score: eligible ? 5 : -5,
                eligible,
                reason: eligible ? 'READY' : 'HOLD: EV negative',
                changedMarket: false,
            };
            if (decisionFor) {
                Object.assign(state.decision, decisionFor(state, mode));
                state.decision.changedMarket = state.decision.symbol !== state.init.symbol;
            }
            return state.decision.eligible;
        },
        ntDigitDecision: field => state.decision?.[field] ?? 0,
        ntPrepareDigitTrade: (inRecovery, symbol, type, barrier, forced) => {
            state.prepared = null;
            const mode = inRecovery ? 'RECOVERY' : 'NORMAL';
            if (!isDigitForgeContract(mode, type, barrier) || symbol !== state.init.symbol ||
                state.decision.mode !== mode || state.decision.contract !== type || state.decision.barrier !== barrier ||
                (!state.decision.eligible && !(forced && !inRecovery)) || state.decision.samples < 20) return 0;
            const payout = payoutFor?.(state, mode) ?? PAYOUT[`${type}:${barrier}`];
            if (!(payout > 1)) return 0;
            state.prepared = { inRecovery, symbol, type, barrier, payout };
            state.preparations.push(state.prepared);
            return payout;
        },
        ntPurchaseDigitTrade: (inRecovery, symbol, type, barrier, amount, maxStake) => {
            const prepared = state.prepared;
            if (!prepared || prepared.inRecovery !== inRecovery || prepared.symbol !== symbol ||
                prepared.type !== type || prepared.barrier !== barrier ||
                amount < 0.35 || amount > maxStake || amount > state.balance) return false;
            // Every trade's mode/stake must agree with the real application's
            // debt-only ledger and configurable-markup bot recovery policy.
            expect(inRecovery).toBe(state.debt > 0);
            const expected = inRecovery
                ? applyRecoveryStakeLimits(calculateBotRecoveryStake(state.debt, prepared.payout, 10), maxStake, state.balance)
                : state.baseStake;
            expect(amount).toBe(expected);
            state.purchases.push({ inRecovery, symbol, type, barrier, amount, debt: state.debt });
            state.tradeOptions = { ...state.tradeOptions, symbol, prediction: barrier, amount };
            Bot.purchase(type);
            return true;
        },
        ntSwitchMarket: symbol => {
            if (switchFails) return false;
            state.init.symbol = symbol;
            return true;
        },
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
        loadFixture('forge-r50-over2-over5');
        const tops = workspace
            .getTopBlocks(false)
            .map(b => b.type)
            .sort();
        expect(tops).toEqual([
            'after_purchase',
            'before_purchase',
            'procedures_defnoreturn',
            'procedures_defnoreturn',
            'trade_definition',
        ]);

        const market = workspace.getBlocksByType('trade_definition_market', false)[0];
        expect(market.getFieldValue('SYMBOL_LIST')).toBe('R_50');
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe(
            'overunder'
        );
        expect(workspace.getBlocksByType('trade_definition_contracttype', false)[0].getFieldValue('TYPE_LIST')).toBe(
            'both'
        );

        // Both procedure calls must bind to the two definitions we emitted —
        // Blockly silently ROOTS A NEW empty definition when a call's mutation
        // names a procedure that does not exist, which would run as a no-op.
        const defs = workspace
            .getBlocksByType('procedures_defnoreturn', false)
            .map(b => b.getFieldValue('NAME'))
            .sort();
        expect(defs).toEqual(['Measure the tape', 'Size recovery stake']);
        const calls = workspace.getBlocksByType('procedures_callnoreturn', false);
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const call of calls) {
            expect(defs).toContain(call.getProcedureCall());
        }

        // The analysis really is in the workspace: a digit list, a loop over it
        // and the transition counters the Markov test needs.
        expect(workspace.getBlocksByType('lastDigitList', false)).toHaveLength(1);
        expect(workspace.getBlocksByType('controls_forEach', false)).toHaveLength(1);
        const names = workspace.getAllVariables().map(v => v.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'Win to Win',
                'Loss to Win',
                'Dependence G2',
                'Conditional Rate',
                'Worst Case Rate',
            ])
        );
    });

    it('passes the run-button gate — nt_purchase_digit_trade satisfies the mandatory Purchase block', () => {
        // Reproduces the "The Purchase block is mandatory and cannot be
        // deleted/disabled." failure: Digit Forge buys through
        // `nt_purchase_digit_trade` (no stock `purchase` block), so the gate must
        // accept it — otherwise Deriv's Run button refuses to start the bot.
        // Same contract Omni Forge established for `nt_purchase_contract`.
        for (const fixture of ['forge-r50-over2-over5', 'forge-r10-over1-over5-forced', 'forge-1hz100v-under7-under4-open']) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);
            // getDisabledBlocks reads the active workspace off this global.
            window.Blockly.derivWorkspace = workspace;
            expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
            expect(workspace.getBlocksByType('nt_purchase_digit_trade', false)).toHaveLength(1);
            expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
        }
    });

    it('compiles to runnable code and reads the tape itself before every normal entry', () => {
        loadFixture('forge-r50-over2-over5');
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
        expect(market.state.notifications[0]).toMatch(
            /NeuroTrade Digit Forge · Volatility 50 Index · Over 2 normal → Over 5 recovery/
        );

        // Journal transparency, deliberately minimal: the user sees the state
        // and the subject of each decision, never the model behind it.
        expect(market.state.notifications.some(m => /^ENTRY · R_50 · DIGITOVER 2 · stake 1 USD$/.test(m))).toBe(
            true
        );
        for (const message of market.state.notifications.slice(1)) {
            expect(message).not.toMatch(/score|EV |lower bound|LCB|Markov|clustering/i);
        }
    });

    it('refuses to trade a tape that has not earned it, and never throws while waiting', () => {
        loadFixture('forge-r50-over2-over5');
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
        loadFixture('forge-1hz100v-under7-under4-open');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W'], digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('exhausted');

        const trades = market.state.trades.map(t => [t.type, t.prediction, t.stake, t.won ? 'W' : 'L']);
        expect(trades).toEqual([
            ['DIGITUNDER', 7, 0.5, 'L'], // normal leg at base stake → debt 0.50
            ['DIGITUNDER', 4, 0.39, 'L'], // ceil₂(0.50 × 1.1 / 1.43) = 0.39 → debt 0.89
            ['DIGITUNDER', 4, 0.69, 'W'], // ceil₂(0.89 × 1.1 / 1.43) = 0.69 → +0.99 clears it
            ['DIGITUNDER', 7, 0.5, 'W'], // debt cleared → back to the gated normal leg
        ]);
        expect(
            market.state.notifications.some(m => /Recovery step 1 — debt 0.5 USD; scanning Over 5 \/ Under 4/.test(m))
        ).toBe(true);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
    });

    it('binds the selected Under 7 barrier at purchase instead of the startup Over 2 barrier', () => {
        loadFixture('forge-r50-over2-over5');
        const market = fakeMarket({
            results: ['W'],
            decisionFor: () => ({ contract: 'DIGITUNDER', barrier: 7, payout: 1.4, eligible: true }),
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        expect(market.state.trades[0]).toMatchObject({ type: 'DIGITUNDER', prediction: 7, stake: 1 });
    });

    it('keeps the selected side and barrier paired when recovery switches from Over 5 to Under 4', () => {
        loadFixture('forge-r50-over2-over5');
        const market = fakeMarket({
            results: ['L', 'W', 'W'],
            decisionFor: (_state, mode) => mode === 'RECOVERY'
                ? { contract: 'DIGITUNDER', barrier: 4, payout: 2.43, eligible: true }
                : { contract: 'DIGITOVER', barrier: 2, payout: 1.4, eligible: true },
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        expect(market.state.trades.map(t => [t.type, t.prediction, t.stake])).toEqual([
            ['DIGITOVER', 2, 1],
            ['DIGITUNDER', 4, 0.77],
            ['DIGITOVER', 2, 1],
        ]);
    });

    it('follows every legal normal/recovery pair across market changes without mixing any tuple fields', () => {
        loadFixture('forge-r50-over2-over5');
        const choices = [
            ['R_50', 'DIGITOVER', 1],
            ['R_75', 'DIGITUNDER', 8],
            ['R_50', 'DIGITOVER', 2],
            ['R_75', 'DIGITUNDER', 7],
            ['R_50', 'DIGITOVER', 5],
            ['R_75', 'DIGITUNDER', 4],
            ['R_75', 'DIGITUNDER', 8],
        ];
        const market = fakeMarket({
            results: ['W', 'W', 'W', 'L', 'L', 'W', 'W'],
            decisionFor: state => {
                const [symbol, contract, barrier] = choices[Math.min(state.trades.length, choices.length - 1)];
                return { symbol, contract, barrier, payout: PAYOUT[`${contract}:${barrier}`], eligible: true };
            },
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        expect(market.state.trades.map(t => [t.symbol, t.type, t.prediction])).toEqual(choices);
        expect(market.state.trades.map(t => t.stake)).toEqual([1, 1, 1, 1, 0.77, 1.37, 1]);
    });

    it('recomputes each recovery stake AFTER the selected live payout is known', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        const market = fakeMarket({
            results: ['L', 'L', 'W', 'W'],
            digits: () => UNDER7_HOT,
            // Both recovery trades are Under 4, but Deriv's quote changed.
            payoutFor: (state, mode) => mode === 'RECOVERY' ? (state.trades.length === 1 ? 2 : 3) : 1.4,
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        // App oracle is checked on EVERY purchase by the harness as well.
        expect(market.state.trades.map(t => t.stake)).toEqual([0.5, 0.55, 0.58, 0.5]);
        expect(market.state.trades.map(t => t.prediction)).toEqual([7, 4, 4, 7]);
    });

    it('retains partial recovery debt, respects a fractional hard cap, then returns to base stake only when repaid', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        // Edit the generated max-stake setting exactly as a workspace user can.
        for (const block of workspace.getBlocksByType('math_number', false)) {
            if (Number(block.getFieldValue('NUM')) === 500) block.setFieldValue('0.609', 'NUM');
        }
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W', 'W'], digits: () => UNDER7_HOT });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        expect(market.state.trades.map(t => [t.prediction, t.stake])).toEqual([
            [7, 0.5], [4, 0.39], [4, 0.6], [4, 0.35], [7, 0.5],
        ]);
        expect(market.state.notifications.some(m => /Partial recovery — 0.03 USD debt remains/.test(m))).toBe(true);
        expect(market.state.debt).toBe(0);
    });

    it('never abandons outstanding debt when the recovery-step counter reaches its cap', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        const market = fakeMarket({ results: ['L', 'L', 'L', 'L', 'W', 'W'], digits: () => UNDER7_HOT });
        expect(runStrategy(buildRunner(workspace), market)).toBe('exhausted');
        expect(market.state.trades.map(t => t.prediction)).toEqual([7, 4, 4, 4, 4, 7]);
        expect(market.state.notifications.filter(m => /Recovery step 3/.test(m))).toHaveLength(2);
    });

    it('does not push the 0.35 minimum above the remaining account balance', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        const market = fakeMarket({ results: ['L', 'L', 'W'], digits: () => UNDER7_HOT, balance: 1.1 });
        expect(runStrategy(buildRunner(workspace), market)).toBe('never-fired');
        expect(market.state.trades.map(t => t.stake)).toEqual([0.5, 0.39]);
        expect(market.state.balance).toBe(0.21);
        expect(market.state.debt).toBe(0.89);
    });

    it('normal patience never forces a recovery buy through its confirmation gate', () => {
        loadFixture('forge-r10-over1-over5-forced');
        const market = fakeMarket({ results: ['L', 'W'], digits: () => OVER1_DEAD, recoveryHoldEvaluations: 1000 });
        expect(runStrategy(buildRunner(workspace), market)).toBe('never-fired');
        expect(market.state.trades.map(t => [t.type, t.prediction])).toEqual([['DIGITOVER', 1]]);
        expect(market.state.debt).toBe(1);
        expect(market.state.notifications.filter(m => /Patience limit/.test(m))).toHaveLength(1);
    });

    it.each([['NORMAL', 'DIGITUNDER', 2], ['RECOVERY', 'DIGITOVER', 4], ['RECOVERY', 'DIGITUNDER', 5]])
    ('holds instead of buying a forbidden %s %s %s decision', (mode, contract, barrier) => {
        loadFixture('forge-r50-over2-over5');
        const market = fakeMarket({
            results: ['L', 'W'],
            decisionFor: (_state, currentMode) => currentMode === mode ? { contract, barrier, eligible: true } : {},
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(mode === 'NORMAL' ? 0 : 1);
    });

    it('retains recovery debt while its live payout is unavailable', () => {
        loadFixture('forge-r50-over2-over5');
        const market = fakeMarket({ results: ['L', 'W'], payoutFor: (_state, mode) => mode === 'RECOVERY' ? 0 : 1.4 });
        expect(runStrategy(buildRunner(workspace), market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(1);
        expect(market.state.debt).toBe(1);
    });

    it('never purchases on the old market when the selected market switch fails', () => {
        loadFixture('forge-r50-over2-over5');
        const market = fakeMarket({
            results: ['W'], switchFails: true,
            decisionFor: () => ({ symbol: 'R_75', contract: 'DIGITUNDER', barrier: 7, eligible: true }),
        });
        expect(runStrategy(buildRunner(workspace), market)).toBe('never-fired');
        expect(market.state.trades).toHaveLength(0);
        expect(market.state.init.symbol).toBe('R_50');
    });

    it('keeps recovery debt pending safely until the recovery ranker confirms an entry', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        const code = buildRunner(workspace);
        // After the normal loss, the runtime ranker refuses three evaluations.
        // The workspace must hold the sized debt without throwing or buying,
        // then execute exactly once when the ranker confirms the setup.
        const market = fakeMarket({
            results: ['L', 'W', 'W'],
            digits: state => (state.trades.length === 0 ? UNDER7_HOT : UNDER7_DEAD),
            recoveryHoldEvaluations: 3,
        });
        expect(runStrategy(code, market)).toBe('never-fired');
        expect(market.state.recoveryAnalyses).toBeGreaterThan(3);
        expect(market.state.trades.map(t => t.prediction)).toEqual([7, 4]);
        expect(market.state.notifications.some(m => /Recovery complete — debt cleared/.test(m))).toBe(true);
        expect(market.state.notifications.some(m => /ANALYSING/.test(m))).toBe(true);
    });

    it('trips the circuit breaker on a clustered losing run', () => {
        loadFixture('forge-1hz100v-under7-under4-open');
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: Array.from({ length: 12 }, () => 'L'), digits: () => UNDER7_HOT });
        expect(runStrategy(code, market)).toBe('stopped');
        expect(market.state.trades).toHaveLength(5); // breakerDepth 5
        expect(market.state.notifications.some(m => /Circuit breaker: 5 consecutive losses/.test(m))).toBe(true);
    });

    it('stops at take-profit and at stop-loss', () => {
        loadFixture('forge-r50-over2-over5');
        let code = buildRunner(workspace);
        const winner = fakeMarket({ results: Array.from({ length: 60 }, () => 'W'), digits: () => OVER2_HOT });
        expect(runStrategy(code, winner)).toBe('stopped');
        expect(winner.state.totalProfit).toBeGreaterThanOrEqual(10);
        expect(winner.state.notifications.some(m => /Take profit 10.00 USD reached/.test(m))).toBe(true);

        workspace.dispose();
        workspace = new window.Blockly.Workspace();
        loadFixture('forge-r50-over2-over5');
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
        for (const fixture of [
            'forge-r50-over2-over5',
            'forge-1hz100v-under7-under4-open',
            'forge-r10-over1-over5-forced',
        ]) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);
            const code = buildRunner(workspace);
            const market = fakeMarket({
                results: Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 'L' : 'W')),
                digits: () =>
                    fixture.includes('under7')
                        ? UNDER7_HOT
                        : fixture.includes('over1')
                          ? tape({ rate: 0.97, win: 9, lose: 0 })
                          : OVER2_HOT,
            });
            // `purchase` throws on an unknown contract:barrier pair, so simply
            // completing the run proves every buy was legal.
            expect(['stopped', 'exhausted']).toContain(runStrategy(code, market));
            expect(market.state.trades.length).toBeGreaterThan(0);
        }
    });
});
