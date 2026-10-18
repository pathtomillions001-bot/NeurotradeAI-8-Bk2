import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

/**
 * Hedge Pair Forge's single paired-execution block. It owns family replay,
 * quote validation, concurrent buys, settlement, and the paired debt ledger.
 * The block fulfils the Builder's mandatory purchase slot but never calls the
 * stock one-contract purchase path.
 *
 * FIELD PRECISION IS A CORRECTNESS PROPERTY, NOT COSMETICS
 * Blockly's `FieldNumber.doClassValidation_` (blockly 10.4.3, the version this
 * Builder ships) runs every value — including one read back from saved XML —
 * through `Math.round(v / precision) * precision` and then `Number(v.toFixed(decimalPlaces))`,
 * where `decimalPlaces` is derived from the precision literal. The barrier
 * offsets used to declare `precision = 0.01`, so a one-pip offset on a pipSize-4
 * index (0.0001, which is what the console defaults to) was rounded to **0**,
 * `normalizePairConfig` threw "offsets must both be positive", and all five
 * price-barrier families held forever having analysed nothing. They now declare
 * `1e-8`, which Blockly expands to eight decimal places — enough for one pip on
 * every symbol the console offers, and exactly the runtime's
 * `MIN_REPRESENTABLE_OFFSET`.
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

/** Smallest offset the field can hold; mirrors `MIN_REPRESENTABLE_OFFSET`. */
const OFFSET_PRECISION = 1e-8;
/** Deriv's hard maximum for one `ticks_history` call (5000 is rejected). */
const MAX_ANALYSIS_WINDOW = 5000;
const DEFAULT_ANALYSIS_WINDOW = 4999;
/** This bot's own recovery markup: a pair risks two premiums at once. */
const DEFAULT_MARKUP_PERCENT = 40;
/** Ceiling on the per-leg recovery ladder. 1.62 would clamp a $2 debt's $1.96. */
const DEFAULT_RECOVERY_MULTIPLIER = 2.43;

window.Blockly.Blocks.nt_hedge_pair_cycle = {
    init() {
        this.appendDummyInput()
            .appendField(localize('Hedge Pair Forge'))
            .appendField(new window.Blockly.FieldDropdown(familyOptions), 'FAMILY')
            .appendField(localize('one-tick target; live minimum if needed'))
            .appendField(new window.Blockly.FieldNumber(1, 1, 1, 1), 'DURATION');
        this.appendDummyInput()
            .appendField(localize('upper offset'))
            .appendField(new window.Blockly.FieldNumber(0.5, 0, 100000, OFFSET_PRECISION), 'UPPER_OFFSET')
            .appendField(localize('lower offset'))
            .appendField(new window.Blockly.FieldNumber(0.5, 0, 100000, OFFSET_PRECISION), 'LOWER_OFFSET');
        this.appendDummyInput()
            .appendField(localize('analysis window (ticks)'))
            .appendField(new window.Blockly.FieldNumber(DEFAULT_ANALYSIS_WINDOW, 100, MAX_ANALYSIS_WINDOW, 1), 'WINDOW')
            .appendField(localize('min pairs'))
            .appendField(new window.Blockly.FieldNumber(80, 20, 1000, 5), 'MIN_SAMPLES');
        this.appendDummyInput()
            .appendField(localize('required joint EV (0 = break-even)'))
            .appendField(new window.Blockly.FieldNumber(0, 0, 0.5, 0.005), 'EDGE_HURDLE')
            .appendField(localize('recovery ladder ceiling'))
            .appendField(new window.Blockly.FieldNumber(DEFAULT_RECOVERY_MULTIPLIER, 1.01, 5, 0.01), 'RECOVERY_MULTIPLIER');
        this.appendDummyInput()
            .appendField(localize('max recovery steps'))
            .appendField(new window.Blockly.FieldNumber(3, 1, 10, 1), 'MAX_RECOVERY_STEPS')
            .appendField(localize('pair recovery markup percent'))
            .appendField(new window.Blockly.FieldNumber(DEFAULT_MARKUP_PERCENT, 0, 100, 1), 'MARKUP_PERCENT');
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
        // Appended LAST: generated code is positional, so a saved workspace from
        // before these fields existed still loads and still means what it meant.
        this.appendDummyInput()
            .appendField(localize('watch markets (comma separated; empty = this market)'))
            .appendField(new window.Blockly.FieldTextInput(''), 'MARKETS')
            .appendField(localize('force entry after seconds (0 = never)'))
            .appendField(new window.Blockly.FieldNumber(0, 0, 3600, 30), 'FORCE_ENTRY_AFTER');
        this.setPreviousStatement(true, 'Purchase');
        this.setColour(window.Blockly.Colours.Special1.colour);
        this.setTooltip(localize('Runs family-specific paired analysis and timing, validates both live proposals, submits the two buys concurrently, and monitors both settlements. Analysis replays up to 4 999 ticks of Deriv deep history and refuses to buy unless the measured joint expectation clears the required edge (0 = break-even) — every hold is written to the Journal with its arithmetic. List more than one market to let the bot rank them and switch between contracts. Recovery sizes each leg as debt × (1 + markup) ÷ (winning-leg payout − 1) and stays armed until the debt is zero. Create DBot does not trade; press this Builder’s Run button.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_hedge_pair_cycle = block => {
    const readNumber = (name, fallback) => {
        const value = Number(block.getFieldValue(name));
        return Number.isFinite(value) ? value : fallback;
    };
    const markets = String(block.getFieldValue('MARKETS') ?? '').trim();
    const fields = [
        JSON.stringify(block.getFieldValue('FAMILY') || 'DIGIT_OVERUNDER'),
        readNumber('DURATION', 1),
        readNumber('UPPER_OFFSET', 0),
        readNumber('LOWER_OFFSET', 0),
        readNumber('WINDOW', DEFAULT_ANALYSIS_WINDOW),
        readNumber('MIN_SAMPLES', 80),
        readNumber('EDGE_HURDLE', 0),
        readNumber('RECOVERY_MULTIPLIER', DEFAULT_RECOVERY_MULTIPLIER),
        readNumber('MAX_RECOVERY_STEPS', 3),
        readNumber('MARKUP_PERCENT', DEFAULT_MARKUP_PERCENT),
        readNumber('MAX_STAKE', 500),
        readNumber('TAKE_PROFIT', 10),
        readNumber('STOP_LOSS', 5),
        readNumber('LOSS_BREAKER', 6),
        readNumber('ENTRY_CONFIRMATIONS', 2),
        readNumber('RECOVERY_CONFIRMATIONS', 3),
        // Appended last: the runtime signature takes watchMarkets then
        // forceEntryAfter, so fourteen-argument XML keeps working unchanged.
        JSON.stringify(markets),
        readNumber('FORCE_ENTRY_AFTER', 0),
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
                ['recovery target', 'target'],
                ['market', 'market'],
                ['mode', 'mode'],
                ['paired samples', 'samples'],
                ['samples required', 'samples required'],
                ['low-confidence samples', 'low confidence'],
                ['measured joint EV', 'edge'],
                ['EV lower bound', 'lower bound'],
                ['estimate instability', 'instability'],
                ['timing score', 'timing'],
                ['timing ready', 'timing ready'],
                ['both legs won', 'both win'],
                ['leg A only won', 'only a'],
                ['leg B only won', 'only b'],
                ['both legs lost', 'both lost'],
                ['repayment rate', 'repayment'],
                ['hard blockers', 'hard blockers'],
                ['soft blockers', 'soft blockers'],
                ['analysis summary', 'analysis'],
                ['leg A payout', 'multiplier a'],
                ['leg B payout', 'multiplier b'],
                ['winning-leg payout', 'win multiplier'],
                ['markets watched', 'markets watched'],
                ['watch list', 'markets'],
                ['best market', 'best market'],
                ['rank reason', 'rank'],
                ['market switches', 'switches'],
                ['forced entry', 'forced entry'],
            ]), 'FIELD');
        this.setOutput(true, null);
        this.setOutputShape(window.Blockly.OUTPUT_SHAPE_ROUND);
        this.setColour(window.Blockly.Colours.Base.colour);
        this.setTooltip(localize('Reads paired settlement, stop state, and the live analysis: measured joint expectation, paired sample counts, joint win/loss state counts, entry timing, both legs’ payouts, and the multi-market ranking.'));
    },
    customContextMenu(menu) { modifyContextMenu(menu); },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.nt_hedge_pair_status = block => [
    `Bot.ntHedgePairStatus(${JSON.stringify(block.getFieldValue('FIELD') || 'continue')})`,
    window.Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC,
];
