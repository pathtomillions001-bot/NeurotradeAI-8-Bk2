/**
 * Autonomous engine contract sets — the pure rules behind the Settings editor.
 *
 * The user builds two independent sets (normal and recovery) from the same
 * contract menu as the Nexus Hedge Forge. Each set holds 1–8 contracts. Matches
 * and Differs accept a fixed digit or "auto" (−1). The server stores each set as
 * "TYPE:digit" strings, and these helpers convert between that wire form and the
 * editor's specs. They must agree with api-server/src/lib/autonomous-hedge/contract-sets.ts.
 */

export type AutonomousContractType =
  | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF" | "CALL" | "PUT";

export interface AutonomousContractSpec {
  type: AutonomousContractType;
  /** Over 0–8, Under 1–9, Matches/Differs 0–9 or −1 (auto). −1 for the rest. */
  digit: number;
}

export const AUTONOMOUS_SET_MAX = 8;

/** Menu order, matching Nexus. */
export const AUTONOMOUS_CONTRACT_MENU: ReadonlyArray<{
  type: AutonomousContractType;
  label: string;
  /** Short label used on chips. */
  short: string;
  needsDigit: boolean;
  allowsAuto: boolean;
  digitMin: number;
  digitMax: number;
  digitLabel: string | null;
}> = [
  { type: "CALL", label: "Rise", short: "Rise", needsDigit: false, allowsAuto: false, digitMin: 0, digitMax: 0, digitLabel: null },
  { type: "PUT", label: "Fall", short: "Fall", needsDigit: false, allowsAuto: false, digitMin: 0, digitMax: 0, digitLabel: null },
  { type: "DIGITOVER", label: "Over", short: "Over", needsDigit: true, allowsAuto: false, digitMin: 0, digitMax: 8, digitLabel: "Barrier" },
  { type: "DIGITUNDER", label: "Under", short: "Under", needsDigit: true, allowsAuto: false, digitMin: 1, digitMax: 9, digitLabel: "Barrier" },
  { type: "DIGITEVEN", label: "Even", short: "Even", needsDigit: false, allowsAuto: false, digitMin: 0, digitMax: 0, digitLabel: null },
  { type: "DIGITODD", label: "Odd", short: "Odd", needsDigit: false, allowsAuto: false, digitMin: 0, digitMax: 0, digitLabel: null },
  { type: "DIGITMATCH", label: "Matches", short: "Matches", needsDigit: true, allowsAuto: true, digitMin: 0, digitMax: 9, digitLabel: "Digit" },
  { type: "DIGITDIFF", label: "Differs", short: "Differs", needsDigit: true, allowsAuto: true, digitMin: 0, digitMax: 9, digitLabel: "Digit" },
];

const MENU_BY_TYPE = new Map(AUTONOMOUS_CONTRACT_MENU.map((m) => [m.type, m]));

/** Map a stored or legacy type onto the menu. RISE/FALL alias CALL/PUT. */
export function menuTypeOf(raw: string): AutonomousContractType | null {
  const t = raw.trim().toUpperCase();
  const mapped = t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t;
  return MENU_BY_TYPE.has(mapped as AutonomousContractType) ? (mapped as AutonomousContractType) : null;
}

/** Digit rules for one type. Returns the clean digit, or null when it is out of range. */
export function cleanDigit(type: AutonomousContractType, digit: number): number | null {
  const m = MENU_BY_TYPE.get(type);
  if (!m) return null;
  if (!m.needsDigit) return -1;
  if (!Number.isInteger(digit)) return null;
  if (m.allowsAuto && digit === -1) return -1;
  return digit >= m.digitMin && digit <= m.digitMax ? digit : null;
}

export function specKey(spec: AutonomousContractSpec): string {
  return `${spec.type}:${spec.digit}`;
}

export function specLabel(spec: AutonomousContractSpec): string {
  const m = MENU_BY_TYPE.get(spec.type);
  if (!m) return spec.type;
  if (!m.needsDigit) return m.label;
  if (m.allowsAuto && spec.digit < 0) return `${m.label} auto`;
  return `${m.label} ${spec.digit}`;
}

/** Encode a set for the API: ["DIGITOVER:3", "CALL:-1"]. */
export function encodeContractSet(specs: readonly AutonomousContractSpec[]): string[] {
  return specs.map(specKey);
}

/** Decode the API form. Unknown or out-of-range entries are dropped and duplicates collapse. */
export function decodeContractSet(raw: readonly string[] | null | undefined): AutonomousContractSpec[] {
  const out: AutonomousContractSpec[] = [];
  const seen = new Set<string>();
  for (const token of raw ?? []) {
    const [typePart, digitPart] = String(token).split(":");
    const type = menuTypeOf(typePart ?? "");
    if (!type) continue;
    const digit = cleanDigit(type, digitPart === undefined || digitPart === "" ? -1 : Number(digitPart));
    if (digit === null) continue;
    const spec = { type, digit };
    if (seen.has(specKey(spec))) continue;
    seen.add(specKey(spec));
    out.push(spec);
  }
  return out;
}

/**
 * Check a set before saving. Returns an error message, or null when it is valid
 * (1–8 entries, no duplicates).
 */
export function contractSetError(specs: readonly AutonomousContractSpec[], which: "Normal" | "Recovery"): string | null {
  if (specs.length < 1) return `${which} contracts need at least one contract`;
  if (specs.length > AUTONOMOUS_SET_MAX) return `${which} contracts allow at most ${AUTONOMOUS_SET_MAX}`;
  return null;
}

/** First digit a set uses for a given contract type, or null if the set has none. */
export function firstDigitOf(specs: readonly AutonomousContractSpec[], type: AutonomousContractType): number | null {
  const hit = specs.find((s) => s.type === type);
  return hit ? hit.digit : null;
}
