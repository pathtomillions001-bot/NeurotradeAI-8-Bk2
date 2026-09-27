import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Recovery-entry analysis used by generated Over/Under Turbo DBots. The block
 * keeps the scanned market, side and barrier sovereign; it only decides WHEN
 * the fixed recovery contract has enough live evidence to execute.
 */
window.Blockly.Blocks.nt_analyse_turbo_recovery = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse Turbo recovery'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['Over', 'DIGITOVER'],
                    ['Under', 'DIGITUNDER'],
                ]),
                'CONTRACT'
            )
            .appendField(localize('barrier'))
            .appendField(new window.Blockly.FieldNumber(4, 0, 9, 1), 'BARRIER')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(120, 40, 300, 1), 'WINDOW');
        this.appendValueInput('PAYOUT').setCheck('Number').appendField(localize('payout'));
        this.appendValueInput('STAKE').setCheck('Number').appendField(localize('stake'));
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(
            localize(
                'Uses a Bayesian conditional transition model, a 90% lower bound, loss clustering, stability and balance-aware utility to time the fixed recovery contract.'
            )
        );
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_turbo_recovery = block => {
    const contract = JSON.stringify(block.getFieldValue('CONTRACT') || 'DIGITOVER');
    const barrier = Number(block.getFieldValue('BARRIER')) || 4;
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    const payout =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'PAYOUT',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE
        ) || '1.95';
    const stake =
        window.Blockly.JavaScript.javascriptGenerator.valueToCode(
            block,
            'STAKE',
            window.Blockly.JavaScript.javascriptGenerator.ORDER_NONE
        ) || '0';
    return `Bot.ntAnalyseTurboRecovery(${contract}, ${barrier}, ${payout}, ${windowSize}, ${stake});\n`;
};

window.Blockly.Blocks.nt_turbo_recovery_decision = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Turbo recovery analysis'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['ready', 'eligible'],
                    ['probability', 'probability'],
                    ['90% lower bound', 'lowerBound'],
                    ['break-even', 'breakEven'],
                    ['loss clustering', 'clusterRatio'],
                    ['instability', 'instability'],
                    ['log utility', 'expectedUtility'],
                    ['samples', 'samples'],
                    ['context samples', 'contextSamples'],
                    ['reason', 'reason'],
                ]),
                'FIELD'
            );
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_turbo_recovery_decision = block => [
    `Bot.ntTurboRecoveryDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
