import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * NeuroTrade-only blocks used by Combo Forge's generated XML.
 *
 * Combo Forge carries a USER-DEFINED candidate list — Over/Under, Even/Odd,
 * Matches/Differs AND 1-tick Rise/Fall — one set for normal trades and another
 * for recovery, over any markets the user picked. All mathematics (prequential
 * mixture e-process, Bonferroni over every scanned candidate, lag-corrected
 * state, edge expiry, log-growth recovery utility) runs in the bot runtime
 * (`combo-forge-analysis.js`), so the strategy keeps working after Run with no
 * NeuroTrade server in the loop.
 *
 * CONTRACTS field wire format: comma-separated `TYPE:DIGIT:PAYOUT` entries,
 * e.g. `DIGITOVER:1:1.23,DIGITEVEN:-1:1.95,CALL:-1:1.92`
 * (DIGIT −1 = none for parity / Rise / Fall, auto for Matches & Differs).
 *
 * The purchase itself reuses `nt_purchase_contract`, whose native already
 * carries the digit for barrier contracts and strips it for everything else,
 * including CALL / PUT.
 */
window.Blockly.Blocks.nt_analyse_combo = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse my combo'))
            .appendField(new window.Blockly.FieldDropdown([['normal', 'NORMAL'], ['recovery', 'RECOVERY']]), 'MODE')
            .appendField(localize('markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50'), 'MARKETS')
            .appendField(localize('contracts'))
            .appendField(new window.Blockly.FieldTextInput('DIGITOVER:1:1.23'), 'CONTRACTS')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(500, 40, 1000, 1), 'WINDOW')
            .appendField(localize('evidence'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['strict', 'strict'],
                    ['balanced', 'balanced'],
                    ['always', 'always'],
                ]),
                'STRICTNESS'
            )
            .appendField(localize('markup %'))
            .appendField(new window.Blockly.FieldNumber(10, 0, 500, 0.1), 'MARKUP')
            .appendField(localize('max stake'))
            .appendField(new window.Blockly.FieldNumber(500, 0.35, 100000, 0.01), 'MAXSTAKE');
        this.appendValueInput('DEBT').appendField(localize('debt'));
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(
            localize(
                'Ranks your contract list (digits and Rise/Fall) across every watched market with an evidence test, a multiple-testing correction and a recovery log-growth utility.'
            )
        );
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_combo = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const mode = JSON.stringify(block.getFieldValue('MODE') || 'NORMAL');
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
    const contracts = JSON.stringify(block.getFieldValue('CONTRACTS') || 'DIGITOVER:1:1.23');
    const windowSize = Number(block.getFieldValue('WINDOW')) || 500;
    const strictness = JSON.stringify(block.getFieldValue('STRICTNESS') || 'strict');
    const markup = Number(block.getFieldValue('MARKUP'));
    const maxStake = Number(block.getFieldValue('MAXSTAKE')) || 500;
    const debt = generator.valueToCode(block, 'DEBT', generator.ORDER_NONE) || '0';
    return `Bot.ntAnalyseCombo(${mode}, ${markets}, ${contracts}, ${windowSize}, ${strictness}, ${debt}, ${
        Number.isFinite(markup) ? markup : 10
    }, ${maxStake});\n`;
};

window.Blockly.Blocks.nt_combo_decision = {
    init() {
        this.appendDummyInput().appendField(localize('combo analysis')).appendField(new window.Blockly.FieldDropdown([
            ['market', 'symbol'], ['contract', 'contract'], ['barrier', 'barrier'], ['eligible', 'eligible'],
            ['can force', 'forceable'], ['score', 'score'], ['payout', 'payout'], ['probability', 'probability'],
            ['lower bound', 'lowerBound'], ['break-even', 'breakEven'], ['EV', 'ev'], ['evidence', 'evidence'],
            ['threshold', 'threshold'], ['margin', 'margin'], ['clustering', 'clustering'], ['samples', 'samples'],
            ['candidates', 'candidates'], ['reason', 'reason'], ['changed market', 'changedMarket'],
        ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_combo_decision = block => [
    `Bot.ntComboDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
