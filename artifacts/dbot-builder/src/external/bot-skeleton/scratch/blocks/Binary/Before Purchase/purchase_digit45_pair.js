import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

// NeuroTrade-specific paired purchase. Stock `purchase` accepts exactly ONE
// contract per cycle: placing two stock blocks in a stack would silently ignore
// the second buy. Keep the two-leg intent visible and editable in the workspace.
window.Blockly.Blocks.purchase_digit45_pair = {
    init() {
        this.jsonInit(this.definition());
        this.setNextStatement(false);
    },
    definition() {
        const number = (name) => ({ type: 'input_value', name, check: 'Number' });
        return {
            message0: localize('Buy TWO contracts: {{pair}}', { pair: '%1' }),
            args0: [{ type: 'field_dropdown', name: 'MODE', options: [
                ['Normal: Over 4 + Under 5', 'normal'],
                ['Recovery: Over 5 + Under 4', 'recovery'],
            ] }],
            message1: 'Base stake PER LEG %1 | Combined debt %2',
            args1: [number('BASE_STAKE'), number('DEBT')],
            message2: 'Recovery markup %1 percent | Maximum PER LEG %2',
            args2: [number('MARKUP'), number('MAX_STAKE')],
            message3: 'Session stop loss %1 | Session P/L %2',
            args3: [number('STOP_LOSS'), number('SESSION_PROFIT')],
            message4: 'Expected account currency %1',
            args4: [{ type: 'field_dropdown', name: 'EXPECTED_CURRENCY', options: [
                ['USD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['AUD', 'AUD'],
            ] }],
            previousStatement: null,
            colour: window.Blockly.Colours.Special1.colour,
            colourSecondary: window.Blockly.Colours.Special1.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special1.colourTertiary,
            tooltip: 'Submits two independent 1-tick buys together, then waits for BOTH results. Not an atomic broker order.',
            category: window.Blockly.Categories.Before_Purchase,
        };
    },
    meta() {
        return {
            display_name: 'Buy Digit 4/5 pair',
            description: 'NeuroTrade paired strategy: normal Over 4 + Under 5, recovery Over 5 + Under 4. Per-leg recovery stakes are sized from live payouts to cover the other leg and ALL prior combined debt.',
        };
    },
    getRequiredValueInputs() {
        return Object.fromEntries(['BASE_STAKE', 'DEBT', 'MARKUP', 'MAX_STAKE', 'STOP_LOSS', 'SESSION_PROFIT']
            .map(name => [name, value => {
                this.error_message = `Connect ${name.replaceAll('_', ' ').toLowerCase()} before running a paired trade.`;
                return !value;
            }]));
    },
    restricted_parents: ['before_purchase'],
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.purchase_digit45_pair = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const get = name => generator.valueToCode(block, name, generator.ORDER_ATOMIC) || 'NaN';
    const mode = block.getFieldValue('MODE');
    const expectedCurrency = block.getFieldValue('EXPECTED_CURRENCY');
    if (!['normal', 'recovery'].includes(mode)) throw new Error('Invalid paired-purchase mode');
    if (!['USD', 'EUR', 'GBP', 'AUD'].includes(expectedCurrency)) throw new Error('Invalid paired-purchase account currency');
    return `Bot.purchaseDigit45Pair({ mode: '${mode}', expectedCurrency: '${expectedCurrency}', ` +
        `baseStake: Number(${get('BASE_STAKE')}), ` +
        `debt: Number(${get('DEBT')}), markupPercent: Number(${get('MARKUP')}), ` +
        `maxStake: Number(${get('MAX_STAKE')}), stopLoss: Number(${get('STOP_LOSS')}), ` +
        `sessionProfit: Number(${get('SESSION_PROFIT')}) });\n`;
};
