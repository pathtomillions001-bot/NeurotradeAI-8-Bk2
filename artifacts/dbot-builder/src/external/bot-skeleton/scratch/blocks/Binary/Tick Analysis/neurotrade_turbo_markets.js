import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Adaptive multi-market Turbo recovery (2026-09-30 fix).
 * Scans ALL watchMarkets for the FIXED recovery contract with the same Bayesian
 * conditional timing model (lower bound, clustering, instability, log utility)
 * and picks the BEST qualifying market. Progressive rematch penalty + fresh-tick
 * confirmation (2→3 when lossRun≥3) guarantees an alternate market wins the
 * post-loss rescan instead of looping on one tape. No recovery without a fresh
 * multi-market rescan.
 */
window.Blockly.Blocks.nt_analyse_turbo_markets = {
    init() {
        this.appendDummyInput()
            .appendField(localize('analyse Turbo recovery across markets'))
            .appendField(new window.Blockly.FieldTextInput('R_50,R_100'), 'MARKETS')
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
                'Scans every watched market for the fixed Turbo recovery contract (Over 4/5, Under 4/5) with Bayesian 90% lower bound, clustering, instability and log-utility timing. Picks the best eligible market, demotes the losing market with a progressive penalty, and requires 2 fresh ticks (3 when lossRun≥3). No recovery without a fresh multi-market rescan.'
            )
        );
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_analyse_turbo_markets = block => {
    const markets = JSON.stringify(block.getFieldValue('MARKETS') || 'R_50');
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
    return `Bot.ntAnalyseTurboMarkets(${markets}, ${contract}, ${barrier}, ${payout}, ${windowSize}, ${stake});\n`;
};

window.Blockly.Blocks.nt_turbo_markets_decision = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Turbo markets analysis'))
            .appendField(
                new window.Blockly.FieldDropdown([
                    ['market', 'symbol'],
                    ['ready', 'eligible'],
                    ['score', 'score'],
                    ['payout', 'payout'],
                    ['probability', 'probability'],
                    ['90% lower bound', 'lowerBound'],
                    ['break-even', 'breakEven'],
                    ['loss clustering', 'clusterRatio'],
                    ['instability', 'instability'],
                    ['log utility', 'expectedUtility'],
                    ['samples', 'samples'],
                    ['context samples', 'contextSamples'],
                    ['confirmations', 'confirmations'],
                    ['reason', 'reason'],
                    ['changed market', 'changedMarket'],
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

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_turbo_markets_decision = block => [
    `Bot.ntTurboMarketsDecision(${JSON.stringify(block.getFieldValue('FIELD') || 'reason')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
