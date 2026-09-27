import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);
const xml = () => fs.readFileSync(path.join(__dirname, 'fixtures/surge-r50-adaptive.xml'), 'utf8');

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
        var BinaryBotPrivateDuringPurchase, BinaryBotPrivateAfterPurchase, BinaryBotPrivateLastTickTime;
        var BinaryBotPrivateTickAnalysisList = [], BinaryBotPrivateHasCalledTradeOptions = false;
        function BinaryBotPrivateRun(f, arg) { if (f) return f(arg); return false; }
        function BinaryBotPrivateTickAnalysis() {}
        var BinaryBotPrivateLimitations = {};
        ${body}
        BinaryBotPrivateRun(BinaryBotPrivateInit);
        var guard = 0;
        while (true) {
            if (++guard > 500) throw new Error('RUNAWAY');
            BinaryBotPrivateRun(BinaryBotPrivateStart);
            if (!BinaryBotPrivateHasCalledTradeOptions) continue;
            while (watch('before')) BinaryBotPrivateRun(BinaryBotPrivateBeforePurchase);
            while (watch('during')) BinaryBotPrivateRun(BinaryBotPrivateDuringPurchase);
            if (!BinaryBotPrivateRun(BinaryBotPrivateAfterPurchase)) break;
        }
    `;
}

function fakeMarket({ results, switchFirst = false }) {
    const state = { trades: [], notifications: [], purchased: false, totalProfit: 0, balance: 1000, symbol: 'R_50', analyses: [], switched: false };
    const contract = { buy: 0, sell: 0, profit: 0, result: 'win' };
    const Bot = {
        init: (_account, options) => { state.symbol = options.symbol; },
        start: options => { state.options = options; state.purchased = false; },
        highlightBlock: () => {},
        ntAnalyseSurgeMarkets: mode => {
            state.analyses.push(mode);
            const changedMarket = switchFirst && !state.switched;
            state.decision = {
                symbol: changedMarket ? 'R_75' : state.symbol,
                contract: mode === 'RECOVERY' ? 'PUT' : 'CALL',
                eligible: true,
                score: 10,
                payout: 1.92,
                reason: 'READY',
                changedMarket,
            };
            return true;
        },
        ntSurgeDecision: field => state.decision?.[field] ?? 0,
        ntSwitchMarket: symbol => { state.symbol = symbol; state.switched = true; return true; },
        purchase: type => {
            if (state.trades.length >= results.length) throw new Error('EXHAUSTED');
            const won = results[state.trades.length] === 'W';
            const stake = state.options.amount;
            const sell = won ? Math.round(stake * 1.92 * 100) / 100 : 0;
            contract.buy = stake; contract.sell = sell; contract.profit = Math.round((sell - stake) * 100) / 100;
            contract.result = won ? 'win' : 'loss';
            state.totalProfit = Math.round((state.totalProfit + contract.profit) * 100) / 100;
            state.balance = Math.round((state.balance + contract.profit) * 100) / 100;
            state.trades.push({ type, stake, won }); state.purchased = true;
        },
        isResult: result => contract.result === result,
        readDetails: index => [null, null, contract.buy, contract.sell, contract.profit][index],
        getTotalProfit: () => state.totalProfit,
        getBalance: () => state.balance,
        notify: note => state.notifications.push(note.message),
        isTradeAgain: () => {},
        getLastTick: () => ({ epoch: Date.now() }),
    };
    const watch = scope => scope === 'before' && !state.purchased;
    return { Bot, watch, sleep: () => {}, state };
}

function execute(code, market) {
    try {
        new Function('Bot', 'watch', 'sleep', code)(market.Bot, market.watch, market.sleep);
        return 'stopped';
    } catch (error) {
        if (error.message === 'EXHAUSTED') return 'exhausted';
        throw error;
    }
}

describe('Vector Surge generated DBot', () => {
    let workspace;
    beforeAll(async () => {
        await loadBlockly(false);
        const proto = window.Blockly.Block.prototype;
        for (const method of ['initSvg', 'render', 'renderEfficiently', 'queueRender', 'bumpNeighbours', 'scheduleSnapAndBump', 'markDirty']) {
            if (!proto[method]) proto[method] = () => {};
        }
        DBotStore.setInstance({ client: { is_logged_in: true, loginid: 'VRTC1', currency: 'USD' }, setLoading: () => {}, load_modal: { setOpenButtonDisabled: () => {}, setLoadedLocalFile: () => {} } });
    }, 120000);
    beforeEach(() => {
        window.Blockly.Events.disable();
        workspace = new window.Blockly.Workspace();
        const dom = window.Blockly.utils.xml.textToDom(xml());
        const unknown = Array.from(dom.querySelectorAll('block')).map(block => block.getAttribute('type')).filter(type => !window.Blockly.Blocks[type]);
        expect(unknown).toEqual([]);
        window.Blockly.Xml.domToWorkspace(dom, workspace);
    });
    afterEach(() => { workspace.dispose(); window.Blockly.Events.enable(); });

    it('loads with Rise/Fall, both analysis modes, switching and mandatory purchases', () => {
        expect(workspace.getBlocksByType('trade_definition_tradetype', false)[0].getFieldValue('TRADETYPE_LIST')).toBe('callput');
        expect(workspace.getBlocksByType('trade_definition_contracttype', false)[0].getFieldValue('TYPE_LIST')).toBe('both');
        const modes = workspace.getBlocksByType('nt_analyse_surge_markets', false).map(block => block.getFieldValue('MODE')).sort();
        expect(modes).toEqual(['NORMAL', 'RECOVERY']);
        expect(workspace.getBlocksByType('nt_switch_market', false)).toHaveLength(1);
        expect(workspace.getBlocksByType('purchase', false)).toHaveLength(2);
        window.Blockly.derivWorkspace = workspace;
        expect(isAllRequiredBlocksEnabled(workspace)).toBe(true);
    });

    it('switches between contracts, trades both directions and runs the shared recovery ledger', () => {
        const code = buildRunner(workspace);
        const market = fakeMarket({ results: ['L', 'L', 'W', 'W'], switchFirst: true });
        expect(execute(code, market)).toBe('exhausted');
        expect(market.state.symbol).toBe('R_75');
        expect(market.state.trades.map(trade => [trade.type, trade.stake, trade.won ? 'W' : 'L'])).toEqual([
            ['CALL', 1, 'L'],
            ['PUT', 1.2, 'L'],
            ['PUT', 2.64, 'W'],
            ['CALL', 1, 'W'],
        ]);
        expect(market.state.analyses).toContain('NORMAL');
        expect(market.state.analyses).toContain('RECOVERY');
        expect(market.state.notifications.some(message => /Recovery complete/.test(message))).toBe(true);
    });
});
