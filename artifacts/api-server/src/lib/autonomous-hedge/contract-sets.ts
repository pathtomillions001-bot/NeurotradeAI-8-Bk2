/**
 * Autonomous engine — the contracts it may trade, chosen separately for NORMAL
 * and RECOVERY trades (pure).
 *
 * Same model as the Nexus Hedge Forge: any mix of Over 0–8, Under 1–9, Even,
 * Odd, Matches 0–9 / auto, Differs 0–9 / auto, Rise, Fall, up to 8 per set.
 * The normal set and the recovery set are independent, so a user may trade
 * Even only in normal and Matches only in recovery.
 *
 * A stored set is authoritative. A set that has never been saved is derived
 * from the legacy settings (preferredContractTypes plus the barrier columns),
 * so an existing account keeps exactly the contracts it had before.
 *
 * Wire format: "TYPE:digit", e.g. "DIGITOVER:3", "DIGITEVEN:-1", "DIGITMATCH:-1".
 * A digit of -1 means "no digit" (Even, Odd, Rise, Fall) or "auto" (Matches and
 * Differs: the ranker picks the hottest / coldest digit on the live tape).
 */

import type { HedgeContractType, HedgeFamilySpec, HedgeMode } from "./hedge-analysis";

export const AUTONOMOUS_SET_MAX = 8;

/** Canonical order: the order families are ranked and listed in. */
const CANONICAL_ORDER: readonly HedgeContractType[] = [
  "CALL",
  "PUT",
  "DIGITOVER",
  "DIGITUNDER",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITMATCH",
  "DIGITDIFF",
];

/** The contracts a fresh account trades before it saves its own sets. */
const DEFAULT_TYPES: readonly HedgeContractType[] = ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];

export interface AutonomousContractSpec {
  type: HedgeContractType;
  /** Over: barrier 0–8. Under: barrier 1–9. Matches/Differs: 0–9, or −1 = auto. −1 otherwise. */
  digit: number;
}

export interface AutonomousContractSets {
  normal: AutonomousContractSpec[];
  recovery: AutonomousContractSpec[];
}

/** The legacy settings a derived set is built from. */
export interface LegacyContractInput {
  preferredContractTypes: readonly string[];
  normalOverDigit: number;
  normalUnderDigit: number;
  recoveryOverDigit: number;
  recoveryUnderDigit: number;
}

export function hasDigitBarrier(type: HedgeContractType): boolean {
  return type === "DIGITOVER" || type === "DIGITUNDER" || type === "DIGITMATCH" || type === "DIGITDIFF";
}

export function allowsAutoDigit(type: HedgeContractType): boolean {
  return type === "DIGITMATCH" || type === "DIGITDIFF";
}

/** Map a stored or client type onto a known contract type. RISE/FALL are CALL/PUT. */
export function normaliseContractType(raw: unknown): HedgeContractType | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toUpperCase();
  const mapped = t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t;
  return (CANONICAL_ORDER as readonly string[]).includes(mapped) ? (mapped as HedgeContractType) : null;
}

/**
 * Check one spec and return it with a clean digit, or null when it is invalid.
 * Digit-less types always carry −1. Matches/Differs accept −1 (auto) or 0–9.
 */
export function cleanContractSpec(type: unknown, digit: unknown): AutonomousContractSpec | null {
  const t = normaliseContractType(type);
  if (!t) return null;
  if (!hasDigitBarrier(t)) return { type: t, digit: -1 };
  const d = typeof digit === "number" || typeof digit === "string" ? Number(digit) : Number.NaN;
  if (!Number.isInteger(d)) return null;
  if (t === "DIGITOVER") return d >= 0 && d <= 8 ? { type: t, digit: d } : null;
  if (t === "DIGITUNDER") return d >= 1 && d <= 9 ? { type: t, digit: d } : null;
  // Matches / Differs: −1 is auto.
  if (d === -1) return { type: t, digit: -1 };
  return d >= 0 && d <= 9 ? { type: t, digit: d } : null;
}

/** Stable identity of a spec, used to de-duplicate a set. */
export function contractSpecKey(spec: AutonomousContractSpec): string {
  return `${spec.type}:${spec.digit}`;
}

/** Human label used in the UI and the journal: "Over 3", "Matches auto", "Rise". */
export function contractSpecLabel(spec: AutonomousContractSpec): string {
  switch (spec.type) {
    case "DIGITOVER": return `Over ${spec.digit}`;
    case "DIGITUNDER": return `Under ${spec.digit}`;
    case "DIGITEVEN": return "Even";
    case "DIGITODD": return "Odd";
    case "DIGITMATCH": return spec.digit < 0 ? "Matches auto" : `Matches ${spec.digit}`;
    case "DIGITDIFF": return spec.digit < 0 ? "Differs auto" : `Differs ${spec.digit}`;
    case "CALL": return "Rise";
    case "PUT": return "Fall";
  }
}

/** Encode one set for the API and the DB: ["DIGITOVER:3", "DIGITEVEN:-1"]. */
export function encodeContractSet(specs: readonly AutonomousContractSpec[]): string[] {
  return specs.map(contractSpecKey);
}

/**
 * Lenient parse for STORED values (a comma-separated string or an array). Drops
 * anything it cannot read and de-duplicates. Use `validateContractSet` to reject
 * bad input from a client.
 */
export function parseContractSpecs(raw: string | readonly string[] | null | undefined): AutonomousContractSpec[] {
  const tokens: string[] = Array.isArray(raw)
    ? [...raw]
    : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const out: AutonomousContractSpec[] = [];
  for (const token of tokens) {
    const [typePart, digitPart] = String(token).trim().split(":");
    const digit = digitPart === undefined || digitPart === "" ? -1 : Number(digitPart);
    const spec = cleanContractSpec(typePart, digit);
    if (!spec) continue;
    const key = contractSpecKey(spec);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(spec);
  }
  return sortCanonical(out);
}

/**
 * Strict check for a set coming from a client. Returns an error message, or
 * null when the set is valid: 1–8 entries, each with a legal digit, no duplicates.
 */
export function validateContractSet(
  raw: readonly string[],
  which: "normal" | "recovery",
): { specs: AutonomousContractSpec[] } | { error: string } {
  const label = which === "normal" ? "Normal" : "Recovery";
  if (raw.length < 1) return { error: `${label} contracts need at least one contract` };
  if (raw.length > AUTONOMOUS_SET_MAX) return { error: `${label} contracts allow at most ${AUTONOMOUS_SET_MAX}` };
  const specs: AutonomousContractSpec[] = [];
  const seen = new Set<string>();
  for (const token of raw) {
    const [typePart, digitPart] = String(token).trim().split(":");
    const type = normaliseContractType(typePart);
    if (!type) return { error: `${label}: unknown contract type ${String(typePart)}` };
    const digit = digitPart === undefined || digitPart === "" ? -1 : Number(digitPart);
    const spec = cleanContractSpec(type, digit);
    if (!spec) {
      const range = type === "DIGITOVER" ? "0–8"
        : type === "DIGITUNDER" ? "1–9"
        : allowsAutoDigit(type) ? "0–9 or auto" : null;
      const name = type === "DIGITOVER" ? "Over" : type === "DIGITUNDER" ? "Under" : type === "DIGITMATCH" ? "Matches" : "Differs";
      return { error: range ? `${label}: ${name} digit must be ${range}` : `${label}: invalid contract ${String(token)}` };
    }
    const key = contractSpecKey(spec);
    if (seen.has(key)) return { error: `${label}: ${contractSpecLabel(spec)} is listed twice` };
    seen.add(key);
    specs.push(spec);
  }
  return { specs: sortCanonical(specs) };
}

/** The sets a legacy account trades: preferredContractTypes with its barrier columns. */
export function legacyContractSets(legacy: LegacyContractInput): AutonomousContractSets {
  const types = new Set<HedgeContractType>();
  for (const raw of legacy.preferredContractTypes) {
    const t = normaliseContractType(raw);
    if (t) types.add(t);
  }
  const chosen = types.size > 0 ? [...types] : [...DEFAULT_TYPES];
  const build = (over: number, under: number): AutonomousContractSpec[] => sortCanonical(
    chosen.map((type): AutonomousContractSpec => {
      if (type === "DIGITOVER") return { type, digit: over };
      if (type === "DIGITUNDER") return { type, digit: under };
      return { type, digit: -1 };
    }),
  );
  return {
    normal: build(legacy.normalOverDigit, legacy.normalUnderDigit),
    recovery: build(legacy.recoveryOverDigit, legacy.recoveryUnderDigit),
  };
}

/** Effective sets: stored values when present, the legacy derivation otherwise. */
export function resolveContractSets(input: {
  normal: string | readonly string[] | null | undefined;
  recovery: string | readonly string[] | null | undefined;
  legacy: LegacyContractInput;
}): AutonomousContractSets {
  const normal = parseContractSpecs(input.normal);
  const recovery = parseContractSpecs(input.recovery);
  const derived = legacyContractSets(input.legacy);
  return {
    normal: normal.length > 0 ? normal : derived.normal,
    recovery: recovery.length > 0 ? recovery : derived.recovery,
  };
}

/** The set the engine ranks in a given mode. Normal and recovery never mix. */
export function contractSetFor(sets: AutonomousContractSets, mode: HedgeMode): AutonomousContractSpec[] {
  return mode === "RECOVERY" ? sets.recovery : sets.normal;
}

/**
 * The legacy `preferredContractTypes` implied by both sets. Other engines (the
 * NeuroAI FAB, the markets scanner) still read that list, so it stays the union.
 */
export function preferredTypesFromSets(sets: AutonomousContractSets): string[] {
  const types = new Set<string>();
  for (const spec of [...sets.normal, ...sets.recovery]) {
    types.add(spec.type);
  }
  return CANONICAL_ORDER.filter((t) => types.has(t));
}

/** Barrier columns implied by a set: the first Over and first Under digit it lists, if any. */
export function legacyBarriersFrom(specs: readonly AutonomousContractSpec[]): { over?: number; under?: number } {
  const over = specs.find((s) => s.type === "DIGITOVER");
  const under = specs.find((s) => s.type === "DIGITUNDER");
  return { over: over?.digit, under: under?.digit };
}

function sortCanonical(specs: AutonomousContractSpec[]): AutonomousContractSpec[] {
  const rank = (t: HedgeContractType) => CANONICAL_ORDER.indexOf(t);
  return [...specs].sort((a, b) => rank(a.type) - rank(b.type) || a.digit - b.digit);
}

/** Family specs the ranker reads for one set. Digit families need a digit tape. */
export function familySpecsForSet(
  specs: readonly AutonomousContractSpec[],
  digitEnabled: boolean,
): HedgeFamilySpec[] {
  const out: HedgeFamilySpec[] = [];
  for (const spec of sortCanonical([...specs])) {
    if (spec.type === "CALL" || spec.type === "PUT") {
      out.push({ type: spec.type, barrier: -1 });
      continue;
    }
    if (!digitEnabled) continue;
    out.push({ type: spec.type, barrier: hasDigitBarrier(spec.type) ? spec.digit : -1 });
  }
  return out;
}
