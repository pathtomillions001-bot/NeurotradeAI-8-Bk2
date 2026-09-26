import { localize } from '@deriv-com/translations';
import { setColors } from './hooks/colours.js';
import goog from './goog.js';

window.goog = goog;

const modifyBlocklyWorkSpaceContextMenu = () => {
    const exclude_item = ['blockInline'];
    exclude_item.forEach(item_id => {
        const option = window.Blockly.ContextMenuRegistry.registry.getItem(item_id);
        option.preconditionFn = () => 'hidden';
    });

    const items_to_localize = {
        undoWorkspace: localize('Undo'),
        redoWorkspace: localize('Redo'),
        cleanWorkspace: localize('Clean up Blocks'),
        collapseWorkspace: localize('Collapse Blocks'),
        expandWorkspace: localize('Expand Blocks'),
        workspaceDelete: localize('Delete All Blocks'),
    };

    Object.keys(items_to_localize).forEach(item_id => {
        const option = window.Blockly.ContextMenuRegistry.registry.getItem(item_id);
        option.displayText = localize(items_to_localize[item_id]);
    });
};

export const loadBlockly = async isDarkMode => {
    // `blockly/javascript` used to be a STATIC import at the top of this module.
    // Because dbot.js imports this file synchronously, that single line dragged
    // the whole Blockly core into the INITIAL chunk group — a ~1.7 MB deferred
    // script plus a ~2.3 MB render-blocking stylesheet on first paint, even
    // though `import('blockly')` right below was meant to keep it lazy.
    // Importing both in parallel here makes Blockly fully async: first paint no
    // longer waits for it, and it still arrives before the workspace needs it.
    const [BlocklyModule, BlocklyJavaScript] = await Promise.all([import('blockly'), import('blockly/javascript')]);
    window.Blockly = BlocklyModule.default;
    window.Blockly.Colours = {};
    const BlocklyGenerator = new window.Blockly.Generator('code');
    const BlocklyJavaScriptGenerator = {
        ...BlocklyJavaScript,
        ...BlocklyGenerator,
    };
    window.Blockly.JavaScript = BlocklyJavaScriptGenerator;
    window.Blockly.Themes.zelos_renderer = window.Blockly.Theme.defineTheme('zelos_renderer', {
        base: window.Blockly.Themes.Zelos,
        componentStyles: {},
    });
    modifyBlocklyWorkSpaceContextMenu();
    setColors(isDarkMode);
    await import('./hooks/index.js');
    await import('./blocks');
};

// Single-flight loader: concurrent callers (double mount, fast Run clicks,
// re-inits) must not re-import the block definitions — importing `./blocks`
// twice re-runs its top-level generator registrations against a freshly
// replaced `window.Blockly`, and a half-finished second pass leaves
// `window.Blockly.JavaScript` unset while the first is still awaiting.
let blockly_load_promise = null;

/**
 * True only when Blockly is loaded AND the Deriv block definitions have been
 * registered. `window.Blockly.JavaScript` alone is NOT a valid readiness
 * signal: `loadBlockly` assigns it halfway through, before `./blocks` has
 * run, so a second caller that checked only the generator raced ahead and
 * crashed in `DBot.initWorkspace` with
 * "Cannot set properties of undefined (setting 'onchange')".
 */
const isBlocklyFullyLoaded = () =>
    Boolean(window.Blockly?.JavaScript?.javascriptGenerator && window.Blockly?.Blocks?.trade_definition_tradetype);

export const ensureBlocklyLoaded = (isDarkMode = false) => {
    // An in-flight load ALWAYS wins: every caller awaits the same attempt and
    // therefore only continues once the block definitions exist too.
    if (blockly_load_promise) return blockly_load_promise;
    if (isBlocklyFullyLoaded()) return Promise.resolve();

    blockly_load_promise = loadBlockly(isDarkMode).catch(error => {
        blockly_load_promise = null;
        throw error;
    });
    return blockly_load_promise;
};
