import { modifyContextMenu } from '../../../utils';

window.Blockly.Blocks.digit45_pair_result = {
    init() { this.jsonInit(this.definition()); },
    definition() {
        return {
            message0: 'Paired result: %1',
            args0: [{ type: 'field_dropdown', name: 'DETAIL', options: [
                ['Combined net profit / loss', 'profit'],
                ['Both contracts lost', 'bothLost'],
                ['Only one order filled', 'partial'],
                ['Total cost of both contracts', 'stake'],
            ] }],
            output: null,
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: 'Available only after BOTH purchased contracts have settled. Combined P/L includes both stakes.',
            category: window.Blockly.Categories.After_Purchase,
        };
    },
    meta() { return { display_name: 'Paired trade result', description: 'Combined outcome of the two Digit 4/5 contracts.' }; },
    restricted_parents: ['after_purchase'],
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.digit45_pair_result = block => {
    const detail = block.getFieldValue('DETAIL');
    if (!['profit', 'bothLost', 'partial', 'stake'].includes(detail)) throw new Error('Invalid paired-result detail');
    return [`Bot.getDigit45PairResult('${detail}')`, window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
