import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * NeuroTrade-only blocks used by Digit Forge's adaptive XML.  The mathematics
 * runs in the bot runtime (not on the NeuroTrade server), so the strategy keeps
 * working after the user presses Run and the host page is no longer involved.
 */
window.Blockly.Blocks.nt_analyse_digit_markets = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse digit markets'))
            .appendField(new window.Blockly.FieldDropdown([['normal', 'NORMAL'], ['recovery', 'RECOVERY']]), 'MODE')
            .appendField(localize('markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50'), 'MARKETS')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(120, 20, 300, 1), 'WINDOW');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Ranks every enabled market and legal barrier with Bayesian, EV, stability and Markov statistics.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_digit_markets = block => {
    const mode = JSON.stringify(block.getFieldValue('MODE') || 'NORMAL');
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    return `Bot.ntAnalyseDigitMarkets(${mode}, ${markets}, ${windowSize});\n`;
};

window.Blockly.Blocks.nt_digit_decision = {
    init() {
        this.appendDummyInput().appendField(localize('digit analysis')).appendField(new window.Blockly.FieldDropdown([
            ['market', 'symbol'], ['contract', 'contract'], ['barrier', 'barrier'], ['eligible', 'eligible'],
            ['score', 'score'], ['payout', 'payout'], ['probability', 'probability'], ['lower bound', 'lowerBound'],
            ['break-even', 'breakEven'], ['EV', 'ev'], ['Markov', 'markov'], ['clustering', 'clustering'],
            ['samples', 'samples'], ['reason', 'reason'], ['changed market', 'changedMarket'],
        ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_digit_decision = block => [
    `Bot.ntDigitDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.nt_switch_market = {
    init() {
        this.appendValueInput('SYMBOL').appendField(localize('safely switch market to'));
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Switches only with no open contract, clears stale proposals and requotes the next trade.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_switch_market = block => {
    const symbol = window.Blockly.JavaScript.javascriptGenerator.valueToCode(block, 'SYMBOL', window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE) || "''";
    return `Bot.ntSwitchMarket(${symbol});\n`;
};
