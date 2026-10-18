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
        // Seven families, plus the console's real one-pip R_50 offsets.
        expect(HEDGE_PAIR_FIXTURES).toHaveLength(8);
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
        // Watch list and patience valve are appended LAST, so fourteen-argument
        // workspaces saved before they existed still compile unchanged.
        expect(code).toContain('"R_50", 0);');
    });

    /**
     * The one-pip regression, proven against the REAL vendored Blockly.
     *
     * A pipSize-4 index defaults its barrier offsets to one pip (0.0001). The
     * offset field used to declare `precision 0.01`, and Blockly's own
     * `FieldNumber.doClassValidation_` rounds every value — including one read
     * back from XML — with `Math.round(v / precision) * precision` and then
     * `toFixed(decimalPlaces)`. So 0.0001 came back as 0, `normalizePairConfig`
     * threw "offsets must both be positive", the cycle caught it and held, and
     * five of the seven families never analysed a single tick.
     */
    it('preserves a one-pip barrier offset through the real Blockly number field', () => {
        loadFixture(workspace, 'hedge-pair-higher-lower-r50-one-pip.xml');
        const [cycle] = workspace.getBlocksByType('nt_hedge_pair_cycle', false);
        expect(cycle.getFieldValue('UPPER_OFFSET')).toBe(0.0001);
        expect(cycle.getFieldValue('LOWER_OFFSET')).toBe(0.0001);
        expect(cycle.getFieldValue('WINDOW')).toBe(4999);
        expect(cycle.getFieldValue('EDGE_HURDLE')).toBe(0);
        expect(cycle.getFieldValue('RECOVERY_MULTIPLIER')).toBe(2.43);
        expect(cycle.getFieldValue('MARKUP_PERCENT')).toBe(40);
        expect(cycle.getFieldValue('MARKETS')).toBe('R_50');
        expect(cycle.getFieldValue('FORCE_ENTRY_AFTER')).toBe(0);

        // A value typed into the field survives too, and 0.01 precision would
        // have destroyed both of these.
        cycle.setFieldValue(0.00000001, 'UPPER_OFFSET');
        expect(cycle.getFieldValue('UPPER_OFFSET')).toBe(1e-8);
        cycle.setFieldValue(0.0001, 'UPPER_OFFSET');
        expect(cycle.getFieldValue('UPPER_OFFSET')).toBe(0.0001);

        const generator = window.Blockly.JavaScript.javascriptGenerator;
        generator.init(workspace);
        const code = generator.workspaceToCode(workspace);
        const call = code.match(/Bot\.ntHedgePairCycle\(([^)]*)\)/)[1].split(',').map(part => part.trim());
        // Eighteen positional arguments, offsets intact, watch list and patience
        // valve appended last.
        expect(call).toHaveLength(18);
        expect(call.slice(0, 4)).toEqual(['"HIGHER_LOWER"', '1', '0.0001', '0.0001']);
        expect(call[4]).toBe('4999');
        expect(call[6]).toBe('0');
        expect(call[7]).toBe('2.43');
        expect(call[9]).toBe('40');
        expect(call[16]).toBe('"R_50"');
        expect(call[17]).toBe('0');
    });

    it('exposes the analysis fields through the status block dropdown', () => {
        loadFixture(workspace, 'hedge-pair-overunder-r50.xml');
        const [status] = workspace.getBlocksByType('nt_hedge_pair_status', false);
        const options = status.getField('FIELD').getOptions(false).map(option => option[1]);
        for (const field of ['continue', 'debt', 'profit', 'step', 'reason', 'pairs', 'recovery armed',
            'market', 'mode', 'samples', 'samples required', 'low confidence', 'edge', 'lower bound',
            'instability', 'timing', 'timing ready', 'both win', 'only a', 'only b', 'both lost',
            'repayment', 'hard blockers', 'soft blockers', 'analysis', 'multiplier a', 'multiplier b',
            'win multiplier', 'markets watched', 'markets', 'best market', 'rank', 'switches', 'forced entry']) {
            expect(options).toContain(field);
        }
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
