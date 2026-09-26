import { config } from '../constants/config';

/**
 * Mandatory-block equivalence helpers.
 *
 * A strategy is only allowed to run when every mandatory block is present and
 * enabled. Some NeuroTrade strategies replace a stock mandatory block with a
 * custom block that performs the same engine operation — `purchase_pair` buys
 * two digit rails as one atomic basket and therefore stands in for `purchase`.
 * These helpers are the single place that knows about those substitutions, so
 * the missing-block check, the disabled-block check and the delete guard all
 * agree.
 */

/** Alternatives configured for a mandatory block type (never includes itself). */
export const getMandatoryBlockAlternatives = (block_type: string): string[] =>
    config().mandatoryBlockAlternatives?.[block_type] ?? [];

/** The block type plus every block type that may stand in for it. */
export const getMandatoryBlockFamily = (block_type: string): string[] => [
    block_type,
    ...getMandatoryBlockAlternatives(block_type),
];

/** Expands a list of required block types with all their accepted stand-ins. */
export const expandMandatoryBlockTypes = (block_types: string[]): string[] => [
    ...new Set(block_types.flatMap(block_type => getMandatoryBlockFamily(block_type))),
];

/** True when `present_block_types` contains the block type or one of its stand-ins. */
export const isMandatoryBlockPresent = (block_type: string, present_block_types: string[]): boolean =>
    getMandatoryBlockFamily(block_type).some(type => present_block_types.includes(type));
