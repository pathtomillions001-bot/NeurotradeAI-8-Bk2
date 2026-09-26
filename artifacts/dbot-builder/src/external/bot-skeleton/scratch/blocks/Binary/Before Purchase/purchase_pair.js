import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * NeuroTrade paired purchase. Unlike two stock Purchase blocks, this is one
 * engine operation: both buys are sent together and the cycle settles only
 * after BOTH contract ids close. The engine refuses to continue if their exit
 * ticks differ, preventing a false "hedged" result.
 */
window.Blockly.Blocks.purchase_pair = {
    init() {
        this.jsonInit({
            message0: localize('Purchase paired {{ over }} barrier {{ over_barrier }} + {{ under }} barrier {{ under_barrier }} · stake per rail {{ stake }}', {
                over: '%1', over_barrier: '%2', under: '%3', under_barrier: '%4', stake: '%5',
            }),
            args0: [
                { type: 'field_dropdown', name: 'OVER_TYPE', options: [[localize('Over'), 'DIGITOVER']] },
                { type: 'input_value', name: 'OVER_BARRIER', check: 'Number' },
                { type: 'field_dropdown', name: 'UNDER_TYPE', options: [[localize('Under'), 'DIGITUNDER']] },
                { type: 'input_value', name: 'UNDER_BARRIER', check: 'Number' },
                { type: 'input_value', name: 'STAKE', check: 'Number' },
            ],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: localize('Purchases and accounts for two digit rails as one synchronized basket.'),
            category: window.Blockly.Categories.Before_Purchase,
        });
        this.setNextStatement(false);
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
    restricted_parents: ['before_purchase'],
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_pair = block => {
    const over = block.getFieldValue('OVER_TYPE');
    const under = block.getFieldValue('UNDER_TYPE');
    const overBarrier = window.Blockly.JavaScript.javascriptGenerator.valueToCode(block, 'OVER_BARRIER', window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE) || '4';
    const underBarrier = window.Blockly.JavaScript.javascriptGenerator.valueToCode(block, 'UNDER_BARRIER', window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE) || '5';
    const stake = window.Blockly.JavaScript.javascriptGenerator.valueToCode(block, 'STAKE', window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE) || '0.35';
    return `Bot.purchasePair('${over}', ${overBarrier}, '${under}', ${underBarrier}, ${stake});\n`;
};
