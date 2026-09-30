/**
 * NeuroTrade — mandatory-block aliases (single source of truth).
 *
 * Deriv's Run-button gate requires a block of every type in
 * `config().mandatoryMainBlocks` (`trade_definition`, `purchase`,
 * `before_purchase`) to exist and be enabled before a strategy may start.
 * NeuroTrade strategies may buy through their OWN runtime blocks instead of
 * the stock `purchase` block, and every such block must be listed here so the
 * gate accepts it as filling the `purchase` slot.
 *
 * A purchase mechanism missing from this map makes the Run button refuse a
 * perfectly valid workspace with "The Purchase block is mandatory and cannot
 * be deleted/disabled." — exactly the failure this map exists to prevent
 * (first seen for `nt_purchase_contract`, then `nt_purchase_digit_trade`, then
 * `nt_purchase_hedge` for the Nexus Hedge Forge).
 *
 * Every `nt_purchase_*` block a generator can emit must be listed here. The
 * builder's `nexus-hedge-strategy.spec.js` loads EVERY committed fixture and
 * asserts this gate, so an unaliased purchase block fails in CI instead of on
 * the user's Run button.
 *
 * Consumers: scratch/utils/index.js (`isAllRequiredBlocksEnabled` — the Run
 * button) and utils/workspace.js (`hasAllRequiredBlocks`).
 */
export const MANDATORY_BLOCK_ALIASES = Object.freeze({
    purchase: ['purchase', 'nt_purchase_contract', 'nt_purchase_digit_trade', 'nt_purchase_hedge'],
});

/** The block types that can satisfy a given required block type. */
export const acceptedTypesFor = required_block_type =>
    MANDATORY_BLOCK_ALIASES[required_block_type] ?? [required_block_type];
