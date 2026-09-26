/** Real Deriv Blockly + executable generated JS, not XML text matching alone. */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';
import { settleDigit45Pair, sizeDigit45Pair } from '../digit45-pair-math';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.xml`), 'utf8');

function buildRunner(workspace) {
    window.Blockly.derivWorkspace = workspace;
    const varDB = new window.Blockly.Names('window');
    varDB.variableMap = workspace.getVariableMap();
    window.Blockly.JavaScript.variableDB_ = varDB;
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    generator.init(workspace);
    const body = generator.workspaceToCode(workspace);
    return `
        var BinaryBotPrivateInit, BinaryBotPrivateStart, BinaryBotPrivateBeforePurchase;
        var BinaryBotPrivateDuringPurchase, BinaryBotPrivateAfterPurchase;
        var BinaryBotPrivateHasCalledTradeOptions = false;
        var BinaryBotPrivateLimitations = {};
        function BinaryBotPrivateRun(f, arg) { if (f) return f(arg); return false; }
        ${body}
        BinaryBotPrivateRun(BinaryBotPrivateInit);
        var guard = 0;
        while (true) {
            if (++guard > 60) throw new Error('runaway trading loop');
            BinaryBotPrivateRun(BinaryBotPrivateStart);
            if (!BinaryBotPrivateHasCalledTradeOptions) throw new Error('No trade options');
            var beforeGuard = 0;
            while (watch('before')) {
                if (++beforeGuard > 10) throw new Error('No paired buy in purchase conditions');
                BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);
            }
            while (watch('during')) { BinaryBotPrivateRun(BinaryBotPrivateDuringPurchase); }
            if (!BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase)) break;
        }
    `;
}

function fakeBroker(script, { stopLoss = 30, expectedCurrency = 'USD' } = {}) {
    const state = { pairs: [], notifications: [], balance: 100, pending: false, result: null, symbol: null };
    const Bot = {
        init: (_account, config) => { state.symbol = config.symbol; state.initOptions = config; },
        start: options => { state.options = options; state.pending = false; },
        highlightBlock: () => {},
        notify: n => state.notifications.push(n.message),
        isTradeAgain: () => {},
        purchaseDigit45Pair: config => {
            if (state.pairs.length >= script.length) throw new Error('SCRIPT_EXHAUSTED');
            expect(config.stopLoss).toBe(stopLoss);
            expect(config.expectedCurrency).toBe(expectedCurrency);
            const { stake } = sizeDigit45Pair({
                ...config, balance: state.balance,
                payoutOver: config.mode === 'recovery' ? 2.43 : 1.95,
                payoutUnder: config.mode === 'recovery' ? 2.43 : 1.95,
            });
            const outcomes = script[state.pairs.length];
            const multiplier = config.mode === 'recovery' ? 2.43 : 1.95;
            const legs = outcomes.map(outcome => ({ buyPrice: stake,
                sellPrice: outcome ? Math.round(stake * multiplier * 100) / 100 : 0 }));
            const result = settleDigit45Pair(legs, config.mode);
            state.result = result;
            state.pairs.push({ mode: config.mode, debtBefore: config.debt, ...result, stakePerLeg: stake });
            state.balance = Math.round((state.balance + result.profit) * 100) / 100;
            state.pending = true;
        },
        getDigit45PairResult: field => state.result[field],
    };
    const watch = scope => scope === 'before' && !state.pending;
    return { Bot, watch, sleep: () => {}, state };
}

function execute(code, broker) {
    const fn = new Function('Bot', 'watch', 'sleep', code); // eslint-disable-line no-new-func
    try { fn(broker.Bot, broker.watch, broker.sleep); return 'stopped'; }
    catch (err) { if (err.message === 'SCRIPT_EXHAUSTED') return 'exhausted'; throw err; }
}

describe('Digit 4/5 scanner → real Bot Builder', () => {
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
    beforeEach(() => { window.Blockly.Events.disable(); workspace = new window.Blockly.Workspace(); window.Blockly.derivWorkspace = workspace; });
    afterEach(() => { workspace.dispose(); window.Blockly.Events.enable(); });

    function load(name = 'digit45-r100-usd') {
        const dom = window.Blockly.utils.xml.textToDom(fixture(name));
        const types = [...dom.querySelectorAll('block')].map(b => b.getAttribute('type'));
        expect(types.filter(t => !window.Blockly.Blocks[t])).toEqual([]);
        window.Blockly.Xml.domToWorkspace(dom, workspace);
        return workspace;
    }

    it('loads every XML block, fixed market and BOTH pair modes without a misleading stock purchase', () => {
        load();
        expect(workspace.getTopBlocks(false).map(b => b.type).sort()).toEqual([
            'after_purchase', 'before_purchase', 'trade_definition',
        ]);
        expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
        const pairs = workspace.getBlocksByType('purchase_digit45_pair', false);
        expect(pairs).toHaveLength(2);
        expect(pairs.map(b => b.getFieldValue('MODE')).sort()).toEqual(['normal', 'recovery']);
        expect(pairs.map(b => b.getFieldValue('EXPECTED_CURRENCY'))).toEqual(['USD', 'USD']);
        expect(workspace.getBlocksByType('digit45_pair_result', false).length).toBeGreaterThanOrEqual(3);
        expect(workspace.getBlocksByType('trade_definition_market', false)[0].getFieldValue('SYMBOL_LIST')).toBe('R_100');
        expect(workspace.getBlocksByType('trade_definition_tradeoptions', false)[0].getFieldValue('DURATIONTYPE_LIST')).toBe('t');
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
    });

    it('rejects a deleted paired purchase mode before Run rather than spinning forever', () => {
        load();
        workspace.getBlocksByType('purchase_digit45_pair', false)[0].dispose();
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(false);
    });

    it('rejects a duplicated pair mode or mixed single/pair purchase before Run', () => {
        load();
        const pairs = workspace.getBlocksByType('purchase_digit45_pair', false);
        pairs[0].setFieldValue(pairs[1].getFieldValue('MODE'), 'MODE');
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(false);
        pairs[0].setFieldValue('normal', 'MODE');
        pairs[1].setFieldValue('recovery', 'MODE');
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
        workspace.newBlock('purchase');
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(false);
    });

    it('executes Over 4/Under 5 then Over 5/Under 4; $2 debt → $5.12 EACH recovery leg', () => {
        load();
        const code = buildRunner(workspace);
        expect(code).toContain("symbol              : 'R_100'");
        expect(code).toContain('Bot.purchaseDigit45Pair');
        const broker = fakeBroker([[false, false], [true, false], [true, false]]);
        expect(execute(code, broker)).toBe('exhausted');
        expect(broker.state.initOptions.contractTypes).toEqual(['DIGITOVER', 'DIGITUNDER']);
        expect(broker.state.options).toMatchObject({ duration: 1, duration_unit: 't', basis: 'stake' });
        expect(broker.state.pairs.map(p => [p.mode, p.stakePerLeg, p.debtBefore, p.profit])).toEqual([
            ['normal', 1, 0, -2],
            ['recovery', 5.12, 2, 2.2],
            ['normal', 1, 0, -0.05],
        ]);
        expect(broker.state.notifications.some(m => /Both legs lost/.test(m))).toBe(true);
        expect(broker.state.notifications.some(m => /Pair recovery complete/.test(m))).toBe(true);
    });

    it('accounts for partial fill and NEVER triggers another pair', () => {
        load();
        const broker = fakeBroker([[false]]);
        expect(execute(buildRunner(workspace), broker)).toBe('stopped');
        expect(broker.state.pairs).toHaveLength(1);
        expect(broker.state.pairs[0].partial).toBe(true);
        expect(broker.state.notifications.some(m => /Only one order filled/.test(m))).toBe(false);
        expect(broker.state.notifications.some(m => /One paired order failed/.test(m))).toBe(true);
    });

    it('stops after the configured recovery attempt limit with debt still outstanding', () => {
        load('digit45-partial-limit');
        const broker = fakeBroker([[false, false], [true, false], [true, false]], { stopLoss: 50 });
        // $2 stake cap cannot recover the full debt in one recovery win; after
        // the second recovery win, the attempt limit must stop the strategy.
        expect(execute(buildRunner(workspace), broker)).toBe('stopped');
        expect(broker.state.pairs.map(p => [p.mode, p.stakePerLeg, Number(p.debtBefore.toFixed(2))])).toEqual([
            ['normal', 1, 0], ['recovery', 2, 2], ['recovery', 2, 1.14],
        ]);
        expect(broker.state.notifications.some(m => /Recovery attempt limit reached/.test(m))).toBe(true);
    });

    it('loads an EUR fixture and pins the account currency to EUR before trading', () => {
        load('digit45-1hz50v-eur');
        expect(workspace.getBlocksByType('trade_definition_market', false)[0].getFieldValue('SYMBOL_LIST')).toBe('1HZ50V');
        expect(workspace.getBlocksByType('purchase_digit45_pair', false).map(b =>
            b.getFieldValue('EXPECTED_CURRENCY'))).toEqual(['EUR', 'EUR']);
        const client = DBotStore.instance.client;
        client.currency = 'EUR';
        try {
            const broker = fakeBroker([[true, false]], { stopLoss: 25, expectedCurrency: 'EUR' });
            expect(execute(buildRunner(workspace), broker)).toBe('exhausted');
            expect(broker.state.symbol).toBe('1HZ50V');
            expect(broker.state.options.currency).toBe('EUR');
            expect(broker.state.pairs[0].stakePerLeg).toBe(0.5);
        } finally { client.currency = 'USD'; }
    });
});
