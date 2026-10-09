/**
 * Autonomous engine — which contracts THIS Deriv account may actually trade.
 *
 * WHY this module exists: a rejection like Deriv's "Unknown contract proposal"
 * is a property of the ACCOUNT (its market access, currency, stake bounds and
 * jurisdiction), not of the tick that happened to be on the tape. The engine
 * used to count every rejection against one 3-strike budget and stop, so an
 * account that simply cannot quote the selected contracts died three buys into
 * every start and every restart repeated the same three rejections — while an
 * account that could quote them never saw the error at all.
 *
 * A capability rejection is therefore quarantined at the narrowest scope the
 * evidence supports, and the engine keeps trading everything the account CAN
 * quote. It only stops when nothing selected is left, and then it says which
 * contracts and which broker code made that true.
 *
 * Quarantine keys never include the barrier: a broker that will not quote
 * DIGITOVER on a symbol will not quote it at barrier 3 and barrier 4 either,
 * and quarantining one digit at a time would waste a rejected buy per digit.
 */

import type { DerivRejectionKind } from "../deriv";

/** Narrowest → widest. */
export type QuarantineScope = "candidate" | "family" | "market" | "account";

export interface ContractRef {
  symbol: string;
  contract: string;
}

export interface QuarantineEntry {
  scope: QuarantineScope;
  /** null means "every market" (family / account scope). */
  symbol: string | null;
  /** null means "every contract" (market / account scope). */
  contract: string | null;
  /** Deriv's machine-readable code, "" when the broker did not send one. */
  code: string;
  /** The broker's own words — what the user is shown. */
  reason: string;
  kind: DerivRejectionKind;
  at: number;
}

/**
 * What the two follow-up probes said about a rejection. Each probe changes
 * exactly one variable, so the scope follows from which one also failed:
 *  - same contract, different market  → the contract family is the problem
 *  - same market, different contract  → the market is the problem
 *  - both failed                      → the account cannot trade these at all
 *  - neither failed                   → only this exact combination is out
 * "unknown" (the probe itself did not get a clear answer) never widens the
 * scope: a transport hiccup must not silence a contract the account can trade.
 */
export interface RejectionEvidence {
  sameContractOtherMarket: "ok" | "rejected" | "unknown";
  sameMarketOtherContract: "ok" | "rejected" | "unknown";
}

const stores = new Map<string, QuarantineEntry[]>();

export function clearQuarantine(sessionId: string): void {
  stores.delete(sessionId);
}

export function quarantineEntries(sessionId: string): readonly QuarantineEntry[] {
  return stores.get(sessionId) ?? [];
}

export function rememberQuarantined(
  sessionId: string,
  input: {
    scope: QuarantineScope;
    symbol: string;
    contract: string;
    code: string;
    reason: string;
    kind: DerivRejectionKind;
  },
): QuarantineEntry {
  const list = stores.get(sessionId) ?? [];
  const entry: QuarantineEntry = {
    scope: input.scope,
    symbol: input.scope === "family" || input.scope === "account" ? null : input.symbol,
    contract: input.scope === "market" || input.scope === "account" ? null : input.contract,
    code: input.code,
    reason: input.reason,
    kind: input.kind,
    at: Date.now(),
  };
  // An entry that already covers this combination stays as it was: the first
  // broker verdict is the evidence, a later identical one adds nothing.
  const already = list.some((e) => matches(e, input));
  if (!already) list.push(entry);
  stores.set(sessionId, list);
  return entry;
}

function matches(entry: QuarantineEntry, ref: ContractRef): boolean {
  const symbolOk = entry.symbol === null || entry.symbol === ref.symbol;
  const contractOk = entry.contract === null || entry.contract === ref.contract;
  return symbolOk && contractOk;
}

/** The entry that keeps this contract out of the rotation, if any. */
export function quarantineReasonFor(
  sessionId: string,
  ref: ContractRef,
): QuarantineEntry | null {
  for (const entry of stores.get(sessionId) ?? []) {
    if (matches(entry, ref)) return entry;
  }
  return null;
}

/** Drop every candidate this account cannot quote. Pure filter, same order. */
export function filterQuarantined<T extends ContractRef>(sessionId: string, rows: T[]): T[] {
  const list = stores.get(sessionId);
  if (!list || list.length === 0) return rows;
  return rows.filter((row) => !list.some((entry) => matches(entry, row)));
}

/** Decide the scope from the two probe results. */
export function inferQuarantineScope(evidence: RejectionEvidence): QuarantineScope {
  const familyWide = evidence.sameContractOtherMarket === "rejected";
  const marketWide = evidence.sameMarketOtherContract === "rejected";
  if (familyWide && marketWide) return "account";
  if (familyWide) return "family";
  if (marketWide) return "market";
  return "candidate";
}

/**
 * Does the user's selection still contain anything this account can quote?
 * `symbols` are the markets the engine is allowed to watch and `contracts` the
 * families in the user's normal + recovery sets. An empty selection on either
 * side means "unknown" and must not be reported as "nothing left".
 */
export function hasTradeableContract(
  sessionId: string,
  selection: { symbols: readonly string[]; contracts: readonly string[] },
): boolean {
  if (selection.symbols.length === 0 || selection.contracts.length === 0) return true;
  return selection.symbols.some((symbol) =>
    selection.contracts.some((contract) => !quarantineReasonFor(sessionId, { symbol, contract })),
  );
}

/** Human-readable lines for the UI ("DIGITOVER — Deriv code X: reason"). */
export function summarizeQuarantine(sessionId: string): string[] {
  return (stores.get(sessionId) ?? []).map((entry) => {
    const target =
      entry.scope === "account" ? "every selected contract"
      : entry.scope === "family" ? entry.contract
      : entry.scope === "market" ? entry.symbol
      : `${entry.contract} on ${entry.symbol}`;
    const code = entry.code ? ` (Deriv code ${entry.code})` : "";
    return `${target}: ${entry.reason}${code}`;
  });
}
