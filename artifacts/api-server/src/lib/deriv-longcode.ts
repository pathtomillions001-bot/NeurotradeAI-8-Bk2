/**
 * Deriv longcode parsing — shared by the journal route and the DBot mirror.
 *
 * Deriv's profit_table has no structured "barrier" field for digit contracts,
 * so the barrier has to be parsed out of the longcode sentence. The naive
 * approach — "grab the last digit anywhere in the string" — is WRONG: longcodes
 * end with a duration clause ("...after 3 ticks."), so a contract barrier of 8
 * traded with a 3-tick duration would read back as barrier 3. Match the
 * specific phrase the barrier actually appears in instead of scanning the whole
 * sentence:
 *   DIGITOVER:  "...is strictly higher than 8 after 5 ticks."
 *   DIGITUNDER: "...is strictly lower than 8 after 5 ticks."
 *   DIGITMATCH: "...is 5 after 5 ticks."
 *   DIGITDIFF:  "...is not 5 after 5 ticks."
 *   DIGITEVEN/DIGITODD have no barrier — none of these patterns match.
 */

export const BARRIER_PATTERNS: RegExp[] = [
  /strictly higher than (\d)/i,
  /strictly lower than (\d)/i,
  /is not (\d) after \d+ tick/i,
  /is (\d) after \d+ tick/i,
  /matches (\d)/i,
  /differs from (\d)/i,
];

export function extractBarrierFromLongcode(longcode: unknown): number | null {
  if (typeof longcode !== "string") return null;
  for (const pattern of BARRIER_PATTERNS) {
    const match = longcode.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Canonical: CALL (Rise) and PUT (Fall). Normalize legacy RISE/FALL → CALL/PUT. */
export function normalizeDerivContractType(ct: string): string {
  if (ct === "RISE") return "CALL";
  if (ct === "FALL") return "PUT";
  return ct;
}
