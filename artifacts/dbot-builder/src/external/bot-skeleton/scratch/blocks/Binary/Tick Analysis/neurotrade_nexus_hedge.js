import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * NeuroTrade-only blocks for Nexus Hedge Forge — universal super-hedge DBot factory.
 * Supports the full digit vocabulary plus Rise/Fall (CALL/PUT) and hedge-aware ranking.
 * Wire format: CONTRACTS as `TYPE:DIGIT:PAYOUT` CSV, e.g.
 * `DIGITOVER:1:1.23,CALL:-1:1.92,DIGITEVEN:-1:1.95`
 */

window.Blockly.Blocks.nt_analyse_hedge = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse hedge contracts'))
            .appendField(new window.Blockly.FieldDropdown([['normal', 'NORMAL'], ['recovery', 'RECOVERY']]), 'MODE')
            .appendField(localize('markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50'), 'MARKETS')
            .appendField(localize('contracts'))
            .appendField(new window.Blockly.FieldTextInput('DIGITOVER:1:1.23,CALL:-1:1.92'), 'CONTRACTS')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(120, 20, 300, 1), 'WINDOW');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Ranks your hedge contract set (Over/Under, Even/Odd, Matches/Differs, Rise/Fall) across watched markets with multi-scale, Dirichlet and hedge-aware scoring.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_hedge = block => {
    const mode = JSON.stringify(block.getFieldValue('MODE') || 'NORMAL');
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
    const contracts = JSON.stringify(block.getFieldValue('CONTRACTS') || 'DIGITOVER:1:1.23');
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    return `Bot.ntAnalyseHedge(${mode}, ${markets}, ${contracts}, ${windowSize});\n`;
};

window.Blockly.Blocks.nt_hedge_decision = {
    init() {
        this.appendDummyInput().appendField(localize('hedge analysis')).appendField(new window.Blockly.FieldDropdown([
            ['market', 'symbol'], ['contract', 'contract'], ['barrier', 'barrier'], ['eligible', 'eligible'],
            ['score', 'score'], ['payout', 'payout'], ['probability', 'probability'], ['lower bound', 'lowerBound'],
            ['break-even', 'breakEven'], ['EV', 'ev'], ['Markov', 'markov'], ['clustering', 'clustering'],
            ['hedge score', 'hedgeScore'], ['samples', 'samples'], ['reason', 'reason'], ['changed market', 'changedMarket'],
        ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_hedge_decision = block => [
    `Bot.ntHedgeDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.nt_purchase_hedge = {
    init() {
        this.appendValueInput('CONTRACT').appendField(localize('purchase hedge contract'));
        this.appendValueInput('BARRIER').appendField(localize('with digit'));
        this.setInputsInline(true);
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Special1.colour);
        this.setTooltip(localize('Buys any hedge contract. Digit applied for Over/Under/Matches/Differs, ignored for Even/Odd and Rise/Fall.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_purchase_hedge = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const contract = generator.valueToCode(block, 'CONTRACT', generator.ORDER_NONE) || "'DIGITOVER'";
    const barrier = generator.valueToCode(block, 'BARRIER', generator.ORDER_NONE) || '-1';
    return `Bot.ntPurchaseHedge(${contract}, ${barrier});\n`;
};
