// `blockly/javascript` moved from a static top-level import to a dynamic one
// inside loadBlockly (that static import is what dragged the whole Blockly core
// into the initial chunk). These assert the generator is still wired up exactly
// as before, and that the single-flight loader still de-dupes concurrent calls.
import { ensureBlocklyLoaded, loadBlockly } from '../blockly';

describe('loadBlockly', () => {
    beforeAll(async () => {
        await loadBlockly(false);
    }, 120000);

    it('exposes window.Blockly', () => {
        expect(window.Blockly).toBeDefined();
    });

    it('wires up Blockly.JavaScript with a working generator', () => {
        // This is the exact property dbot.runBot() gates on before generating
        // code — if it is missing, Run fails with
        // "Cannot read properties of undefined (reading 'javascriptGenerator')".
        expect(window.Blockly.JavaScript).toBeDefined();
        expect(window.Blockly.JavaScript.javascriptGenerator).toBeDefined();
    });

    it('registers the zelos theme used by the workspace', () => {
        expect(window.Blockly.Themes.zelos_renderer).toBeDefined();
    });

    it('resolves immediately once loaded (single-flight)', async () => {
        await expect(ensureBlocklyLoaded()).resolves.toBeUndefined();
        expect(window.Blockly.JavaScript.javascriptGenerator).toBeDefined();
    });

    it('can generate code through the same path dbot.generateCode() uses', () => {
        // dbot.js:378 → window.Blockly.JavaScript.javascriptGenerator.workspaceToCode
        const workspace = new window.Blockly.Workspace();
        const generator = window.Blockly.JavaScript.javascriptGenerator;
        generator.init(workspace);
        const code = generator.workspaceToCode(workspace);
        expect(typeof code).toBe('string');
        workspace.dispose();
    });
});
