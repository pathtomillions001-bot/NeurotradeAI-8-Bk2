/**
 * Autonomous engine — which contracts the 1-tick contest may consider (pure).
 *
 * Settings decide the contract families and the Over/Under barriers exactly as
 * before: normal uses the normal pair, recovery uses the recovery pair. Within
 * those settings the ranker chooses the winner. Matches/Differs use the
 * market's data-driven digit (most/least frequent), as Nexus does.
 */

import type { HedgeFamilySpec, HedgeMode } from "./hedge-analysis";

export interface FamilySettings {
  preferredContractTypes: string[];
  normalOverDigit: number;
  normalUnderDigit: number;
  recoveryOverDigit: number;
  recoveryUnderDigit: number;
}

/** Normalise RISE/FALL to CALL/PUT and drop duplicates and unknown types. */
export function normalizePreferredTypes(types: string[]): string[] {
  const known = new Set(["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"]);
  const mapped = types.map((t) => (t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t));
  return [...new Set(mapped)].filter((t) => known.has(t));
}

export function familySpecsFor(input: {
  settings: FamilySettings;
  mode: HedgeMode;
  digitEnabled: boolean;
}): HedgeFamilySpec[] {
  const { settings, mode, digitEnabled } = input;
  const types = new Set(normalizePreferredTypes(settings.preferredContractTypes));
  const specs: HedgeFamilySpec[] = [];
  if (types.has("CALL")) specs.push({ type: "CALL", barrier: -1 });
  if (types.has("PUT")) specs.push({ type: "PUT", barrier: -1 });
  if (!digitEnabled) return specs;
  const over = mode === "RECOVERY" ? settings.recoveryOverDigit : settings.normalOverDigit;
  const under = mode === "RECOVERY" ? settings.recoveryUnderDigit : settings.normalUnderDigit;
  if (types.has("DIGITOVER")) specs.push({ type: "DIGITOVER", barrier: over });
  if (types.has("DIGITUNDER")) specs.push({ type: "DIGITUNDER", barrier: under });
  if (types.has("DIGITEVEN")) specs.push({ type: "DIGITEVEN", barrier: -1 });
  if (types.has("DIGITODD")) specs.push({ type: "DIGITODD", barrier: -1 });
  if (types.has("DIGITMATCH")) specs.push({ type: "DIGITMATCH", barrier: -1 });
  if (types.has("DIGITDIFF")) specs.push({ type: "DIGITDIFF", barrier: -1 });
  return specs;
}
