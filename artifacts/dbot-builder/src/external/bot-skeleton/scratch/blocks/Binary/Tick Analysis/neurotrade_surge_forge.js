import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

window.Blockly.Blocks.nt_analyse_surge_markets = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse Rise/Fall markets'))
            .appendField(new window.Blockly.FieldDropdown([['normal', 'NORMAL'], ['recovery', 'RECOVERY']]), 'MODE')
            .appendField(localize('markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50'), 'MARKETS')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(240, 100, 500, 1), 'WINDOW')
            .appendField(localize('weights'))
            .appendField(new window.Blockly.FieldTextInput('0.3:0.25:0.2:0.25'), 'WEIGHTS')
            .appendField(localize('tau'))
            .appendField(new window.Blockly.FieldNumber(1, 0.5, 2.5, 0.01), 'TAU');
        this.appendValueInput('PAYOUT').appendField(localize('payout'));
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Ranks Rise and Fall across watched markets: regime gate (persistence/runs z), adaptive-memory Bayes, Markov conditional, recency run-hazard, robust drift — fired by a conditional G-test evidence boundary.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_surge_markets = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const mode = JSON.stringify(block.getFieldValue('MODE') || 'NORMAL');
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
    const windowSize = Number(block.getFieldValue('WINDOW')) || 240;
    const weights = JSON.stringify(block.getFieldValue('WEIGHTS') || '0.3:0.25:0.2:0.25');
    const tau = Number(block.getFieldValue('TAU')) || 1;
    const payout = generator.valueToCode(block, 'PAYOUT', generator.ORDER_NONE) || '1.92';
    return `Bot.ntAnalyseSurgeMarkets(${mode}, ${markets}, ${windowSize}, ${weights}, ${tau}, ${payout});\n`;
};

window.Blockly.Blocks.nt_surge_decision = {
    init() {
        this.appendDummyInput().appendField(localize('Rise/Fall analysis')).appendField(new window.Blockly.FieldDropdown([
            ['market', 'symbol'], ['contract', 'contract'], ['eligible', 'eligible'], ['score', 'score'],
            ['payout', 'payout'], ['probability', 'probability'], ['lower bound', 'lowerBound'],
            ['break-even', 'breakEven'], ['utility', 'utility'], ['loss continuation', 'qLL'],
            ['pair risk', 'pairRisk'], ['instability', 'instability'], ['confirmations', 'confirmations'],
            ['regime', 'regime'], ['edge probability', 'edgeProb'], ['evidence', 'evidence'],
            ['persistence z', 'zPersist'], ['runs z', 'runsZ'], ['memory', 'memory'],
            ['reason', 'reason'], ['changed market', 'changedMarket'],
        ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_surge_decision = block => [
    `Bot.ntSurgeDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
