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
  /** User-chosen normal set (empty/absent = legacy settings). */
  autonomousNormalContracts?: { type: string; digit: number }[];
  /** User-chosen recovery set (empty/absent = legacy settings). */
  autonomousRecoveryContracts?: { type: string; digit: number }[];
}

/** Most contracts the user may put in one set — the ranker needs candidates, not noise. */
export const MAX_CONTRACTS_PER_SET = 8;

/** Normalise RISE/FALL to CALL/PUT and drop duplicates and unknown types. */
export function normalizePreferredTypes(types: string[]): string[] {
  const known = new Set(["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"]);
  const mapped = types.map((t) => (t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t));
  return [...new Set(mapped)].filter((t) => known.has(t));
}

/**
 * Turn a user-chosen set into ranker families. Each entry carries its own
 * barrier, so the user can trade e.g. Even in normal and Matches in recovery
 * without any engine-side switching between contract types.
 */
export function userContractSpecs(
  entries: { type: string; digit: number }[],
  digitEnabled: boolean,
): HedgeFamilySpec[] {
  const out: HedgeFamilySpec[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const [normalized] = normalizePreferredTypes([entry.type]);
    if (!normalized) continue;
    const digit = Number.isInteger(entry.digit) ? entry.digit : -1;
    let barrier = -1;
    if (normalized === "DIGITOVER") {
      if (!digitEnabled || digit < 0 || digit > 8) continue;
      barrier = digit;
    } else if (normalized === "DIGITUNDER") {
      if (!digitEnabled || digit < 1 || digit > 9) continue;
      barrier = digit;
    } else if (normalized === "DIGITMATCH" || normalized === "DIGITDIFF") {
      if (!digitEnabled) continue;
      barrier = digit >= 0 && digit <= 9 ? digit : -1; // -1 = auto from the tape
    } else if (normalized === "DIGITEVEN" || normalized === "DIGITODD") {
      if (!digitEnabled) continue;
    }
    const key = `${normalized}:${barrier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: normalized as HedgeFamilySpec["type"], barrier });
    if (out.length >= MAX_CONTRACTS_PER_SET) break;
  }
  return out;
}

export function familySpecsFor(input: {
  settings: FamilySettings;
  mode: HedgeMode;
  digitEnabled: boolean;
}): HedgeFamilySpec[] {
  const { settings, mode, digitEnabled } = input;
  // Each mode trades its own user-chosen set, independently of the other mode.
  const userSet = mode === "RECOVERY"
    ? settings.autonomousRecoveryContracts
    : settings.autonomousNormalContracts;
  if (userSet && userSet.length > 0) return userContractSpecs(userSet, digitEnabled);

  // Legacy fallback: one shared type list plus the per-mode barrier pair.
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

/** Stored form of a user set: a JSON array in a text column ("" = not set). */
export function parseStoredContractSet(raw: string | null | undefined): { type: string; digit: number }[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is { type: unknown; digit: unknown } => typeof e === "object" && e !== null)
      .filter((e) => typeof e.type === "string")
      .map((e) => ({ type: e.type as string, digit: typeof e.digit === "number" ? e.digit : -1 }))
      .slice(0, MAX_CONTRACTS_PER_SET);
  } catch {
    return [];
  }
}

export function serializeContractSet(entries: { type: string; digit: number }[] | null | undefined): string {
  return JSON.stringify((entries ?? []).slice(0, MAX_CONTRACTS_PER_SET).map((e) => ({ type: e.type, digit: e.digit })));
}
