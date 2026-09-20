/**
 * Bulk-batch synchrony report.
 *
 * The bulk executor returns, for every leg, the contract it opened (if any) plus
 * a receipt carrying Deriv's OWN start time and the commit burst that carried
 * it. This module turns those receipts into one honest verdict:
 *
 *   "synchronized" — every leg Deriv accepted shares one start time (same entry
 *                    tick, therefore same entry digit and, for equal durations,
 *                    the same exit tick), and they closed together too.
 *   "split"        — every leg opened, but they did NOT all share a start time,
 *                    so some legs entered on a later tick. The user is told
 *                    which ones; the app never claims a sync it did not get.
 *   "partial"      — only some legs opened.
 *   "failed"       — no leg opened.
 *   "unverified"   — all legs opened, but Deriv reported no start time for at
 *                    least one of them, so synchrony can be neither proven nor
 *                    disproven. Reported as unknown rather than as success.
 *
 * Keeping this pure (no sockets, no DB) is deliberate: the synchrony claim is
 * the part of the feature most likely to be quietly wrong, so it is the part
 * with the tightest tests.
 */

export interface BulkSyncLegReceipt {
  index: number;
  startedAtMs: number;
  confirmedAtMs: number;
  burst: number;
  splitTick: boolean;
}

export interface BulkSyncLegInput {
  /** False when this leg never opened a contract on Deriv. */
  opened: boolean;
  receipt: BulkSyncLegReceipt;
  /** Deriv's sell/purchase times, when the settlement sweep found them. */
  exitedAtMs?: number;
}

export type BulkSyncVerdict =
  | "synchronized"
  | "split"
  | "partial"
  | "failed"
  | "unverified";

export interface BulkSyncReport {
  requested: number;
  opened: number;
  confirmed: number;
  verdict: BulkSyncVerdict;
  /** True when every OPENED leg shares one Deriv start time. null = unknown. */
  sameEntryTick: boolean | null;
  /** True when every SETTLED leg shares one Deriv exit time. null = unknown. */
  sameExitTick: boolean | null;
  /** Distinct Deriv start times (epoch ms), ascending. */
  entryTimesMs: number[];
  /** Distinct Deriv exit times (epoch ms), ascending. */
  exitTimesMs: number[];
  /**
   * Wall-clock spread between the first and last buy confirmation in THIS
   * process. Diagnostic only — the market-side proof is `entryTimesMs`.
   */
  localConfirmSpreadMs: number;
  /** Legs that could not ride the batch's first commit burst. */
  splitTickLegs: number[];
  /** Human-readable one-liner, safe to show to the user verbatim. */
  summary: string;
}

function distinctSorted(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))].sort(
    (a, b) => a - b,
  );
}

/**
 * What a bulk leg's journal row must say, given what Deriv actually did.
 *
 * The rule that matters: a leg Deriv CONFIRMED is never written as an error,
 * even when the settlement sweep was too slow to see it settle yet. It stays
 * `open` with its contract id so the reconciliation sweep settles it from
 * Deriv's profit table. Writing "error / $0" over a live contract is precisely
 * how a batch of real trades came to look like trades that "never executed".
 */
export type BulkLegSettlement =
  | {
      status: "won" | "lost";
      profit: number;
      payout: number;
      entryPrice: number;
      exitPrice: number;
      derivContractId: number;
    }
  | {
      status: "open";
      note: string;
      entryPrice: number;
      exitPrice: number;
      derivContractId: number;
    }
  | { status: "error"; note: string };

export function decideLegSettlement(input: {
  /** True when Deriv confirmed a contract for this leg. */
  opened: boolean;
  /** Why the leg never opened (only used when `opened` is false). */
  failureMessage?: string | null;
  contractId?: number;
  buyPrice?: number;
  stake: number;
  result?: {
    won: boolean;
    profit: number;
    entrySpot?: number;
    exitSpot?: number;
    missing?: boolean;
  } | null;
}): BulkLegSettlement {
  if (!input.opened) {
    return {
      status: "error",
      note: input.failureMessage ?? "Leg never opened on Deriv",
    };
  }

  const contractId = input.contractId ?? 0;
  const buyPrice = input.buyPrice ?? 0;

  if (!input.result || input.result.missing) {
    return {
      status: "open",
      note: "Deriv has not journalled the settlement yet — it will settle automatically",
      entryPrice: buyPrice,
      exitPrice: buyPrice,
      derivContractId: contractId,
    };
  }

  // Money is handled in cents, never in floats: `1 + 1.43` is 2.4299999999999997
  // in IEEE-754 and a payout column must not inherit that.
  const profit = Math.round(Number(input.result.profit ?? 0) * 100) / 100;
  const entryPrice = input.result.entrySpot || buyPrice;
  return {
    status: profit > 0 ? "won" : "lost",
    profit,
    payout: profit > 0 ? Math.round((input.stake + profit) * 100) / 100 : 0,
    entryPrice,
    exitPrice: input.result.exitSpot || entryPrice,
    derivContractId: contractId,
  };
}

export function summarizeBulkSync(
  legs: BulkSyncLegInput[],
  opts?: { confirmed?: number },
): BulkSyncReport {
  const requested = legs.length;
  const openedLegs = legs.filter((l) => l.opened);
  const opened = openedLegs.length;
  const confirmed = opts?.confirmed ?? opened;

  const entryTimesMs = distinctSorted(openedLegs.map((l) => l.receipt.startedAtMs));
  const exitTimesMs = distinctSorted(openedLegs.map((l) => l.exitedAtMs ?? 0));

  // "Same tick" needs BOTH facts: every opened leg reported a start time, and
  // they all agree. A missing time is UNKNOWN (never a silent success), and two
  // different times are a proven split.
  const openedWithStartTime = openedLegs.filter((l) => l.receipt.startedAtMs > 0).length;
  const sameEntryTick =
    opened < 2
      ? null
      : entryTimesMs.length >= 2
        ? false
        : entryTimesMs.length === 1 && openedWithStartTime === opened
          ? true
          : null;

  const settledLegs = openedLegs.filter((l) => (l.exitedAtMs ?? 0) > 0);
  const sameExitTick =
    settledLegs.length < 2
      ? null
      : exitTimesMs.length >= 2
        ? false
        : settledLegs.length === opened
          ? true
          : null;

  const splitTickLegs = legs
    .filter((l) => l.opened && l.receipt.splitTick)
    .map((l) => l.receipt.index)
    .sort((a, b) => a - b);

  const confirmTimes = openedLegs
    .map((l) => l.receipt.confirmedAtMs)
    .filter((t) => Number.isFinite(t) && t > 0);
  const localConfirmSpreadMs =
    confirmTimes.length < 2
      ? 0
      : Math.max(...confirmTimes) - Math.min(...confirmTimes);

  let verdict: BulkSyncVerdict;
  if (opened === 0) verdict = "failed";
  else if (opened < requested) verdict = "partial";
  else if (splitTickLegs.length > 0 || sameEntryTick === false) verdict = "split";
  else if (sameEntryTick === null) verdict = "unverified";
  else verdict = "synchronized";

  const summary = (() => {
    switch (verdict) {
      case "failed":
        return `No leg of the ${requested}-leg batch reached Deriv.`;
      case "partial":
        return `${opened}/${requested} legs opened on Deriv.`;
      case "split":
        return sameEntryTick === false
          ? `${opened}/${requested} legs opened, but they did NOT all share one entry tick.`
          : `${opened}/${requested} legs opened; ${splitTickLegs.length} leg(s) missed the synchronized burst.`;
      case "unverified":
        return `${opened}/${requested} legs opened; Deriv reported no start time, so same-tick entry could not be verified.`;
      default:
        return sameExitTick === false
          ? `${opened}/${requested} legs opened on ONE tick (same entry digit), but closed at different times.`
          : `${opened}/${requested} legs opened on ONE tick — same entry digit and same closing tick.`;
    }
  })();

  return {
    requested,
    opened,
    confirmed,
    verdict,
    sameEntryTick,
    sameExitTick,
    entryTimesMs,
    exitTimesMs,
    localConfirmSpreadMs,
    splitTickLegs,
    summary,
  };
}
