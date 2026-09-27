import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * FIRST-ENTRY timing for generated Dual-Lock Range Sentinel strategies.
 *
 * The scan keeps full sovereignty over the market, the side and the barrier —
 * this block only decides WHEN the run may start, so the bot never opens its
 * first trade inside a burst of range violations. It is consulted once per
 * tick until it reports ready (guaranteed within the patience budget), after
 * which the generated strategy executes the lock with no analysis at all.
 */
window.Blockly.Blocks.nt_analyse_dual_lock_entry = {
    init() {
        this.appendDummyInput()
            .appendField(localize('time Dual-Lock first entry'))
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
                'Times ONLY the first entry of the run: a recency-weighted Beta baseline, a state-conditional Markov confidence and violation-cluster guards, against a threshold that relaxes to the tape baseline by the patience deadline so the wait is always bounded.'
            )
        );
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_dual_lock_entry = block => {
    const generator = window.Blockly.JavaScript.javascriptGenerator;
    const contract = JSON.stringify(block.getFieldValue('CONTRACT') || 'DIGITOVER');
    const barrier = Number(block.getFieldValue('BARRIER')) || 0;
    const windowSize = Number(block.getFieldValue('WINDOW')) || 120;
    const patience = Number(block.getFieldValue('PATIENCE')) || 12;
    const waited = generator.valueToCode(block, 'WAITED', generator.ORDER_NONE) || '0';
    return `Bot.ntAnalyseDualLockEntry(${contract}, ${barrier}, ${windowSize}, ${patience}, ${waited});\n`;
};

window.Blockly.Blocks.nt_dual_lock_entry_decision = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Dual-Lock entry timing'))
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

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_dual_lock_entry_decision = block => [
    `Bot.ntDualLockEntryDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
