/**
 * Hedge Pair Forge XML fixtures loaded into the real vendored Deriv Blockly.
 *
 * This pins the generated workspace, the custom paired-purchase block, and the
 * exact Builder Run mandatory-block gate—not just XML string validity.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';
import { hasAllRequiredBlocks } from '../../external/bot-skeleton/utils/workspace';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const HEDGE_PAIR_FIXTURES = fs.readdirSync(FIXTURES)
    .filter(file => file.startsWith('hedge-pair-') && file.endsWith('.xml'))
    .sort();

const loadFixture = (workspace, file) => {
    const xml = fs.readFileSync(path.join(FIXTURES, file), 'utf8');
    const dom = window.Blockly.utils.xml.textToDom(xml);
    const blockTypes = Array.from(dom.querySelectorAll('block')).map(block => block.getAttribute('type'));
    const unknown = blockTypes.filter(type => !Object.keys(window.Blockly.Blocks).includes(type));
    expect(unknown).toEqual([]);
    window.Blockly.Xml.domToWorkspace(dom, workspace);
    window.Blockly.derivWorkspace = workspace;
    return xml;
};

describe('Hedge Pair Forge → real Deriv Blockly strategy', () => {
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

    it('loads one fixture per requested family into the real Blockly registry', () => {
        expect(HEDGE_PAIR_FIXTURES).toHaveLength(7);
        for (const file of HEDGE_PAIR_FIXTURES) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(workspace, file);
            expect(workspace.getBlocksByType('trade_definition', false)).toHaveLength(1);
            expect(workspace.getBlocksByType('before_purchase', false)).toHaveLength(1);
            expect(workspace.getBlocksByType('nt_hedge_pair_cycle', false)).toHaveLength(1);
            expect(workspace.getBlocksByType('nt_hedge_pair_status', false)).toHaveLength(1);
            expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
        }
    });

    it('passes the Run and save/load mandatory-block gates for every generated pair', () => {
        const results = [];
        for (const file of HEDGE_PAIR_FIXTURES) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(workspace, file);
            results.push({
                file,
                run: isAllRequiredBlocksEnabled(workspace),
                load: hasAllRequiredBlocks(),
            });
        }
        expect(results).toEqual(HEDGE_PAIR_FIXTURES.map(file => ({ file, run: true, load: true })));
    });

    it('compiles the paired strategy through the registered cycle/status blocks', () => {
        loadFixture(workspace, 'hedge-pair-higher-lower-r50.xml');
        const generator = window.Blockly.JavaScript.javascriptGenerator;
        generator.init(workspace);
        const code = generator.workspaceToCode(workspace);
        expect(code).toContain('Bot.ntHedgePairCycle("HIGHER_LOWER"');
        expect(code).toContain('Bot.ntHedgePairStatus("continue")');
        expect(code.match(/Bot\.ntHedgePairCycle\(/g)).toHaveLength(1);
    });

    it('every committed NeuroTrade fixture still clears the actual Builder Run gate', () => {
        const failing = [];
        for (const file of fs.readdirSync(FIXTURES).filter(candidate => candidate.endsWith('.xml')).sort()) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(workspace, file);
            if (!isAllRequiredBlocksEnabled(workspace)) failing.push(file);
        }
        expect(failing).toEqual([]);
    });
});
