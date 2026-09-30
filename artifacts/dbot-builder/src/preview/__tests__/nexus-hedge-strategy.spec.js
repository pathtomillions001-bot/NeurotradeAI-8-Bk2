/**
 * Nexus Hedge Forge "Create DBot" — the Run-button gate, against the REAL builder.
 *
 * WHY THIS SUITE EXISTS
 * ─────────────────────
 * Nexus Hedge Forge buys through its own `nt_purchase_hedge` block, exactly the
 * way Omni Forge buys through `nt_purchase_contract` and Digit Forge through
 * `nt_purchase_digit_trade`. Deriv's Run button requires a block of every type
 * in `config().mandatoryMainBlocks` — `['trade_definition', 'purchase',
 * 'before_purchase']` — and the generated strategy legitimately contains NO
 * stock `purchase` block. `nt_purchase_hedge` was never listed in
 * `utils/mandatory-block-aliases.js`, so pressing Run on a freshly generated
 * Nexus strategy failed with:
 *
 *     "The Purchase block is mandatory and cannot be deleted/disabled."
 *
 * Nothing caught it because no Nexus fixture had ever been loaded into the real
 * Blockly: the API-side test only checked the XML was stable. These fixtures
 * come from artifacts/api-server/src/lib/nexus-hedge-dbot.fixtures.ts
 * (`npx tsx src/lib/nexus-hedge-dbot.fixtures.ts --write`) and the API-side
 * test asserts the committed files still equal the generator output.
 *
 * The last test is the general guard: EVERY committed NeuroTrade fixture must
 * clear the same gate, so the next purchase mechanism cannot ship unaliased.
 */
import fs from 'fs';
import path from 'path';
import { localize } from '@deriv-com/translations';
import { loadBlockly } from '../../external/bot-skeleton/scratch/blockly';
import DBotStore from '../../external/bot-skeleton/scratch/dbot-store';
import { isAllRequiredBlocksEnabled } from '../../external/bot-skeleton/scratch/utils';
import { hasAllRequiredBlocks } from '../../external/bot-skeleton/utils/workspace';
import { observer as globalObserver } from '../../external/bot-skeleton/utils/observer';

localize.mockImplementation((text, args) =>
    typeof text === 'string' ? text.replace(/{{\s*(\w+)\s*}}/g, (match, key) => (args && key in args ? args[key] : match)) : text
);

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = name => fs.readFileSync(path.join(FIXTURES, `${name}.xml`), 'utf8');

const NEXUS_FIXTURES = fs
    .readdirSync(FIXTURES)
    .filter(file => file.startsWith('nexus-hedge-') && file.endsWith('.xml'))
    .map(file => file.replace(/\.xml$/, ''));

describe('Nexus Hedge Forge → Deriv DBot strategy', () => {
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
        expect(NEXUS_FIXTURES.length).toBeGreaterThanOrEqual(4);
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
        // The same gates load() applies before touching the workspace: the
        // builder rejects a whole workspace on ONE unknown block type.
        const block_types = Array.from(dom.querySelectorAll('block')).map(b => b.getAttribute('type'));
        expect(block_types.length).toBeGreaterThan(0);
        const unknown = block_types.filter(type => !Object.keys(window.Blockly.Blocks).includes(type));
        expect(unknown).toEqual([]);
        window.Blockly.Xml.domToWorkspace(dom, workspace);
        // getDisabledBlocks reads the active workspace off this global.
        window.Blockly.derivWorkspace = workspace;
        return xml;
    };

    it('buys through nt_purchase_hedge and carries no stock purchase block', () => {
        for (const fixture of NEXUS_FIXTURES) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(fixture);

            expect(workspace.getBlocksByType('purchase', false)).toHaveLength(0);
            expect(workspace.getBlocksByType('nt_purchase_hedge', false)).toHaveLength(1);
            // The two hedge analysers (normal set + recovery set) and the
            // decision reader are what make the purchase meaningful.
            expect(workspace.getBlocksByType('nt_analyse_hedge', false)).toHaveLength(2);
            expect(workspace.getBlocksByType('nt_hedge_decision', false).length).toBeGreaterThan(0);
        }
    });

    it('passes the run-button gate — nt_purchase_hedge satisfies the mandatory Purchase block', () => {
        // This is the exact gate that raised "The Purchase block is mandatory
        // and cannot be deleted/disabled." for every generated Nexus strategy
        // until `nt_purchase_hedge` joined MANDATORY_BLOCK_ALIASES.purchase.
        // Capturing ui.log.error means a regression fails with the literal
        // message the user sees on their Run button.
        const results = [];
        let errors = [];
        const onError = message => errors.push(message);
        globalObserver.register('ui.log.error', onError);
        try {
            for (const fixture of NEXUS_FIXTURES) {
                workspace.dispose();
                workspace = new window.Blockly.Workspace();
                loadFixture(fixture);

                // Both gates are collected (never thrown early) so one failure
                // prints the Run-button verdict, the save/load verdict and the
                // literal message the user was shown, side by side.
                const gate = isAllRequiredBlocksEnabled(workspace);
                const on_load = hasAllRequiredBlocks();
                results.push({ fixture, gate, on_load, errors });
                errors = [];
            }
        } finally {
            globalObserver.unregister('ui.log.error', onError);
        }
        expect(results).toEqual(
            NEXUS_FIXTURES.map(fixture => ({ fixture, gate: true, on_load: true, errors: [] }))
        );
    });

    it('every committed NeuroTrade fixture clears the mandatory-block gate', () => {
        // General guard: any new custom purchase block must be aliased before
        // its fixtures can pass here, so the failure surfaces in CI instead of
        // on the user's Run button.
        const failing = [];
        for (const file of fs.readdirSync(FIXTURES).filter(f => f.endsWith('.xml'))) {
            workspace.dispose();
            workspace = new window.Blockly.Workspace();
            loadFixture(file.replace(/\.xml$/, ''));
            if (!isAllRequiredBlocksEnabled(workspace)) failing.push(file);
        }
        expect(failing).toEqual([]);
    });
});
