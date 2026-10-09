/**
 * Autonomous engine — which contracts the 1-tick contest may consider (pure).
 *
 * The user picks the normal and recovery contract sets independently (see
 * contract-sets.ts). The engine ranks only the set for the current mode, so a
 * recovery trade can use Matches while a normal trade uses Even. Matches and
 * Differs use the chosen digit, or the market's data-driven digit when the
 * user picked auto.
 */

import type { HedgeFamilySpec, HedgeMode } from "./hedge-analysis";
import {
  contractSetFor,
  familySpecsForSet,
  legacyContractSets,
  type AutonomousContractSets,
  type LegacyContractInput,
} from "./contract-sets";

export type FamilySettings = LegacyContractInput;

/** Normalise RISE/FALL to CALL/PUT and drop duplicates and unknown types. */
export function normalizePreferredTypes(types: string[]): string[] {
  const known = new Set(["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"]);
  const mapped = types.map((t) => (t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t));
  return [...new Set(mapped)].filter((t) => known.has(t));
}

/**
 * Family specs for one mode. Pass the user's `sets` when they are known. Without
 * them, the set is derived from the legacy settings, which is the behaviour an
 * account had before the contract sets existed.
 */
export function familySpecsFor(input: {
  settings: FamilySettings;
  mode: HedgeMode;
  digitEnabled: boolean;
  sets?: AutonomousContractSets;
}): HedgeFamilySpec[] {
  const sets = input.sets ?? legacyContractSets(input.settings);
  return familySpecsForSet(contractSetFor(sets, input.mode), input.digitEnabled);
}
