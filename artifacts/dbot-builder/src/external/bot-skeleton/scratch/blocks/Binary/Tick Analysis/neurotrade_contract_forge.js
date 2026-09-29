import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * NeuroTrade-only blocks used by Omni Forge's generated XML — the fully
 * user-configurable DBot factory. Unlike Digit Forge (whose barrier menu is
 * fixed), Omni Forge carries a USER-DEFINED candidate list: any mix of digit
 * Over/Under barriers, Even/Odd and Matches/Differs, one set for normal
 * trades and another for recovery. All mathematics (Beta-shrunk probability,
 * Wilson lower bound, 2-state Markov conditioned on the loss state for
 * recovery, clustering and instability penalties) runs in the bot runtime, so
 * the strategy keeps working after Run with no NeuroTrade server in the loop.
 *
 * CONTRACTS field wire format: comma-separated `TYPE:DIGIT:PAYOUT` entries,
 * e.g. `DIGITOVER:1:1.23,DIGITEVEN:-1:1.95,DIGITMATCH:-1:8.93`
 * (DIGIT −1 = none for parity / auto-pick for Matches & Differs).
 */
window.Blockly.Blocks.nt_analyse_contracts = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse my contracts'))
            .appendField(new window.Blockly.FieldDropdown([['normal', 'NORMAL'], ['recovery', 'RECOVERY']]), 'MODE')
            .appendField(localize('markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50'), 'MARKETS')
            .appendField(localize('contracts'))
            .appendField(new window.Blockly.FieldTextInput('DIGITOVER:1:1.23'), 'CONTRACTS')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(120, 20, 300, 1), 'WINDOW');
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Ranks your own contract list (Over/Under, Even/Odd, Matches/Differs) across every watched market with Bayesian, EV, stability and Markov statistics.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_contracts = block => {
    const mode = JSON.stringify(block.getFieldValue('MODE') || 'NORMAL');
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
    const contracts = JSON.stringify(block.getFieldValue('CONTRACTS') || 'DIGITOVER:1:1.23');
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    return `Bot.ntAnalyseContracts(${mode}, ${markets}, ${contracts}, ${windowSize});\n`;
};

window.Blockly.Blocks.nt_contract_decision = {
    init() {
        this.appendDummyInput().appendField(localize('contract analysis')).appendField(new window.Blockly.FieldDropdown([
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
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_contract_decision = block => [
    `Bot.ntContractDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];

window.Blockly.Blocks.nt_purchase_contract = {
    init() {
        this.appendValueInput('CONTRACT').appendField(localize('purchase contract'));
        this.appendValueInput('BARRIER').appendField(localize('with digit'));
        this.setInputsInline(true);
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Special1.colour);
        this.setTooltip(localize('Buys any digit contract type. The digit is applied for Over/Under/Matches/Differs and ignored for Even/Odd (-1 = none).'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};
window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_purchase_contract = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const contract = generator.valueToCode(block, 'CONTRACT', generator.ORDER_NONE) || "'DIGITOVER'";
    const barrier = generator.valueToCode(block, 'BARRIER', generator.ORDER_NONE) || '-1';
    return `Bot.ntPurchaseContract(${contract}, ${barrier});\n`;
};
