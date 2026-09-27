import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * FIRST-ENTRY timing for generated Barrier Bastion strategies.
 *
 * The scan owns the market and the chosen Bastion bands. This block only times
 * the first purchase so the run does not start inside a short burst of band
 * violations. Once ready (or once patience is exhausted), the generated DBot
 * executes the locked normal/recovery bands without further analysis.
 */
window.Blockly.Blocks.nt_analyse_bastion_entry = {
    init() {
        this.appendDummyInput()
            .appendField(localize('time Bastion first entry'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['Over', 'DIGITOVER'],
                    ['Under', 'DIGITUNDER'],
                ]),
                'CONTRACT'
            )
            .appendField(localize('barrier'))
            .appendField(new window.Blockly.FieldNumber(1, 0, 9, 1), 'BARRIER')
            .appendField(localize('window'))
            .appendField(new window.Blockly.FieldNumber(120, 40, 300, 1), 'WINDOW')
            .appendField(localize('patience'))
            .appendField(new window.Blockly.FieldNumber(12, 3, 40, 1), 'PATIENCE');
        this.appendValueInput('WAITED').setCheck('Number').appendField(localize('ticks waited'));
        this.setPreviousStatement(true);
        this.setNextStatement(true);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(
            localize(
                'Times ONLY the first entry of the Bastion DBot: a recency-weighted baseline, state-conditional confidence and violation-cluster guards with a bounded patience deadline.'
            )
        );
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_bastion_entry = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const contract = JSON.stringify(block.getFieldValue('CONTRACT') || 'DIGITOVER');
    const barrier = Number(block.getFieldValue('BARRIER')) || 0;
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    const patience = Number(block.getFieldValue('PATIENCE')) || 12;
    const waited = generator.valueToCode(block, 'WAITED', generator.ORDER_NONE) || '0';
    return `Bot.ntAnalyseBastionEntry(${contract}, ${barrier}, ${windowSize}, ${patience}, ${waited});\n`;
};

window.Blockly.Blocks.nt_bastion_entry_decision = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Bastion entry timing'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['ready', 'ready'],
                    ['confidence', 'confidence'],
                    ['threshold', 'threshold'],
                    ['baseline', 'baseline'],
                    ['clean ticks', 'quietTicks'],
                    ['recent misses', 'burst'],
                    ['ticks waited', 'waited'],
                    ['patience', 'patience'],
                    ['samples', 'samples'],
                    ['forced', 'forced'],
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

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_bastion_entry_decision = block => [
    `Bot.ntBastionEntryDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
