import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Hedge Pair Forge's single paired-execution block. It owns family replay,
 * quote validation, concurrent buys, settlement, and the paired debt ledger.
 * The block fulfils the Builder's mandatory purchase slot but never calls the
 * stock one-contract purchase path.
 */

const familyOptions = [
    ['Over 5 / Under 4', 'DIGIT_OVERUNDER'],
    ['Only Ups / Only Downs', 'ONLY_UPS_DOWNS'],
    ['Higher / Lower', 'HIGHER_LOWER'],
    ['Touch upper / Touch lower', 'TOUCH_UPPER_LOWER'],
    ['No Touch upper / No Touch lower', 'NO_TOUCH_UPPER_LOWER'],
    ['Ends Between / Ends Outside', 'ENDS_BETWEEN_OUTSIDE'],
    ['Stays Between / Goes Outside', 'STAYS_BETWEEN_OUTSIDE'],
];

window.Blockly.Blocks.nt_hedge_pair_cycle = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Hedge Pair Forge'))
            .appendField(new window.Blockly.FieldDropdown(familyOptions), 'FAMILY')
            .appendField(localize('one-tick target; live minimum if needed'))
            .appendField(new window.Blockly.FieldNumber(1, 1, 1, 1), 'DURATION');
        this.appendDummyInput()
            .appendField(localize('upper offset'))
            .appendField(new window.Blockly.FieldNumber(0.5, 0, 100000, 0.01), 'UPPER_OFFSET')
            .appendField(localize('lower offset'))
            .appendField(new window.Blockly.FieldNumber(0.5, 0, 100000, 0.01), 'LOWER_OFFSET');
        this.appendDummyInput()
            .appendField(localize('analysis window'))
            .appendField(new window.Blockly.FieldNumber(500, 100, 1000, 10), 'WINDOW')
            .appendField(localize('min pairs'))
            .appendField(new window.Blockly.FieldNumber(80, 20, 1000, 5), 'MIN_SAMPLES');
        this.appendDummyInput()
            .appendField(localize('required joint EV lower bound'))
            .appendField(new window.Blockly.FieldNumber(0.01, 0, 0.5, 0.005), 'EDGE_HURDLE')
            .appendField(localize('recovery multiplier'))
            .appendField(new window.Blockly.FieldNumber(1.62, 1.01, 5, 0.01), 'RECOVERY_MULTIPLIER');
        this.appendDummyInput()
            .appendField(localize('max recovery steps'))
            .appendField(new window.Blockly.FieldNumber(3, 1, 10, 1), 'MAX_RECOVERY_STEPS')
            .appendField(localize('markup percent'))
            .appendField(new window.Blockly.FieldNumber(10, 0, 100, 1), 'MARKUP_PERCENT');
        this.appendDummyInput()
            .appendField(localize('max stake per leg'))
            .appendField(new window.Blockly.FieldNumber(500, 0.35, 50000, 0.01), 'MAX_STAKE')
            .appendField(localize('take profit'))
            .appendField(new window.Blockly.FieldNumber(10, 0.01, 100000, 0.01), 'TAKE_PROFIT');
        this.appendDummyInput()
            .appendField(localize('stop loss'))
            .appendField(new window.Blockly.FieldNumber(5, 0.01, 100000, 0.01), 'STOP_LOSS')
            .appendField(localize('double-loss breaker'))
            .appendField(new window.Blockly.FieldNumber(6, 1, 20, 1), 'LOSS_BREAKER');
        this.appendDummyInput()
            .appendField(localize('entry confirmations (family floor)'))
            .appendField(new window.Blockly.FieldNumber(2, 2, 12, 1), 'ENTRY_CONFIRMATIONS')
            .appendField(localize('recovery confirmations (family floor)'))
            .appendField(new window.Blockly.FieldNumber(3, 2, 12, 1), 'RECOVERY_CONFIRMATIONS');
        this.setPreviousStatement(true, 'Purchase');
        this.setColour(window.Blockly.Colours.Special1.colour);
        this.setTooltip(localize('Runs family-specific paired analysis and timing, validates both live proposals, submits the two buys concurrently, and monitors both settlements. Create DBot does not trade; press this Builder’s Run button. Recovery requires both legs to lose.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_hedge_pair_cycle = block => {
    const readNumber = (name, fallback) => {
        const value = Number(block.getFieldValue(name));
        return Number.isFinite(value) ? value : fallback;
    };
    const fields = [
        JSON.stringify(block.getFieldValue('FAMILY') || 'DIGIT_OVERUNDER'),
        readNumber('DURATION', 1),
        readNumber('UPPER_OFFSET', 0),
        readNumber('LOWER_OFFSET', 0),
        readNumber('WINDOW', 500),
        readNumber('MIN_SAMPLES', 80),
        readNumber('EDGE_HURDLE', 0.01),
        readNumber('RECOVERY_MULTIPLIER', 1.62),
        readNumber('MAX_RECOVERY_STEPS', 3),
        readNumber('MARKUP_PERCENT', 0),
        readNumber('MAX_STAKE', 500),
        readNumber('TAKE_PROFIT', 10),
        readNumber('STOP_LOSS', 5),
        readNumber('LOSS_BREAKER', 6),
        readNumber('ENTRY_CONFIRMATIONS', 2),
        readNumber('RECOVERY_CONFIRMATIONS', 3),
    ];
    return `Bot.ntHedgePairCycle(${fields.join(', ')});\n`;
};

window.Blockly.Blocks.nt_hedge_pair_status = {
    init() {
        this.appendDummyInput()
            .appendField(localize('hedge pair'))
            .appendField(new window.Blockly.FieldDropdown([
                ['continue', 'continue'],
                ['recovery debt', 'debt'],
                ['session P&L', 'profit'],
                ['recovery step', 'step'],
                ['halt reason', 'reason'],
                ['completed pairs', 'pairs'],
                ['recovery armed', 'recovery armed'],
            ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Reads paired settlement and stop state.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_hedge_pair_status = block => [
    `Bot.ntHedgePairStatus(${JSON.stringify(block.getFieldValue('FIELD') || 'continue')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
