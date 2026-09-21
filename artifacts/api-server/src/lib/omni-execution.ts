/**
 * A single guarded proposal -> buy, on the existing persistent account socket.
 * No trade on indicative pricing. No automatic retry of an unacknowledged buy.
 * Guards run again INSIDE the socket's paced queue, not just before awaiting it.
 */
import type { AccountRequestHooks } from "./deriv";
import { sameDigitTick, type DigitTick } from "./digit-tape";
import type { OmniOpportunity } from "./omni-analysis";

export interface OmniBroker {
  request(
    message: Record<string, unknown>,
    timeoutMs?: number,
    hooks?: AccountRequestHooks,
  ): Promise<any>;
}
export interface OmniQuote {
  id: string;
  ask: number;
  payout: number;
  multiplier: number;
}
export type OmniBuyResult =
  | {
      kind: "bought";
      contractId: number;
      buyPrice: number;
      quote: OmniQuote;
      opportunity: OmniOpportunity;
    }
  | { kind: "skipped"; reason: string; quoteUnavailable?: boolean }
  | { kind: "unknown"; reason: string };

export function readOmniQuote(message: any): OmniQuote | null {
  const p = message?.proposal;
  const ask = Number(p?.ask_price);
  const payout = Number(p?.payout);
  if (
    message?.error ||
    !p?.id ||
    !Number.isFinite(ask) ||
    !Number.isFinite(payout) ||
    ask < 0.35 ||
    payout <= ask
  )
    return null;
  return { id: String(p.id), ask, payout, multiplier: payout / ask };
}

/** No price/digit comparison as a clock: identical-valued consecutive ticks count. */
export function omniTickIsExecutable(
  analysed: DigitTick,
  current: DigitTick | null | undefined,
  now: number,
  periodMs: number,
  live: boolean,
): boolean {
  if (!sameDigitTick(analysed, current) || (live && analysed.source !== "live"))
    return false;
  if (!Number.isFinite(periodMs) || periodMs <= 0 || !Number.isFinite(now))
    return false;
  const receivedAge = now - analysed.receivedAt;
  if (receivedAge < 0 || receivedAge > periodMs * 1.5) return false;
  if (!live) return true;
  const brokerAge = now - analysed.epoch * 1000;
  // Clock skew, delayed packets and the closing edge of a tick window must not
  // become a prediction for an entirely different tick. Headroom is fixed.
  return brokerAge >= -200 && brokerAge < periodMs - 180;
}

export async function placeOmniOrder(input: {
  opportunity: OmniOpportunity;
  currency: string;
  broker: OmniBroker;
  guard: () => void;
  reprice: (multiplier: number) => OmniOpportunity;
  /** Durable journal + last account/settings check, BEFORE any buy is sent. */
  prepare: (opportunity: OmniOpportunity, quote: OmniQuote) => Promise<void>;
  onBuySent: () => void;
}): Promise<OmniBuyResult> {
  let sent = false;
  let stake = input.opportunity.stake;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      input.guard();
      const c = input.opportunity.contract;
      const message = await input.broker.request(
        {
          proposal: 1,
          amount: stake,
          basis: "stake",
          contract_type: c.contractType,
          currency: input.currency,
          duration: 1,
          duration_unit: "t",
          underlying_symbol: input.opportunity.symbol,
          ...(c.barrier === undefined ? {} : { barrier: String(c.barrier) }),
        },
        2500,
        { beforeSend: input.guard },
      );
      input.guard();
      const quote = readOmniQuote(message);
      if (!quote)
        return {
          kind: "skipped",
          reason:
            message?.error?.message ?? "A valid live quote is unavailable",
          quoteUnavailable: true,
        };
      const repriced = input.reprice(quote.multiplier);
      if (!repriced.ready)
        return {
          kind: "skipped",
          reason: "Live payout no longer supports a positive opportunity",
        };
      // Stake-dependent payouts must be priced at the ACTUAL debt-sized amount.
      if (
        Math.abs(quote.ask - repriced.stake) > 0.001 ||
        Math.abs(quote.ask - stake) > 0.001
      ) {
        stake = repriced.stake;
        continue;
      }
      await input.prepare(repriced, quote);
      input.guard();
      const buy = await input.broker.request(
        { buy: quote.id, price: quote.ask },
        8000,
        {
          beforeSend: input.guard,
          onSent: () => {
            sent = true;
            input.onBuySent();
          },
        },
      );
      if (buy?.error)
        return {
          kind: "skipped",
          reason: buy.error.message ?? "Broker rejected this purchase",
          quoteUnavailable: true,
        };
      const contractId = Number(buy?.buy?.contract_id);
      const buyPrice = Number(buy?.buy?.buy_price);
      if (
        !buy?.buy ||
        !Number.isSafeInteger(contractId) ||
        contractId <= 0 ||
        !Number.isFinite(buyPrice) ||
        buyPrice <= 0
      ) {
        return {
          kind: sent ? "unknown" : "skipped",
          reason: "Purchase not confirmed — no repeat buy will be sent",
        };
      }
      return {
        kind: "bought",
        contractId,
        buyPrice,
        quote,
        opportunity: repriced,
      };
    }
    return {
      kind: "skipped",
      reason: "Payout changed while sizing; re-evaluating on a fresh tick",
    };
  } catch (error) {
    return {
      kind: sent ? "unknown" : "skipped",
      reason: error instanceof Error ? error.message : "Order interrupted",
    };
  }
}

/**
 * Only accept an unambiguous broker record for a lost acknowledgement. Missing
 * identifying fields are NOT wildcards. An uncertain purchase stays locked for
 * reconciliation instead of being invented as a loss/win or bought a second time.
 */
export function matchOmniPurchase(
  rows: readonly any[],
  expected: {
    symbol: string;
    contractType: string;
    barrier?: number;
    stake: number;
    sentAt: number;
  },
): number | null {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = Number(row.contract_id);
    const type =
      row.contract_type === "RISE"
        ? "CALL"
        : row.contract_type === "FALL"
          ? "PUT"
          : row.contract_type;
    const time = Number(row.purchase_time ?? row.date_start);
    const barrier = row.barrier === undefined ? undefined : Number(row.barrier);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(time))
      continue;
    if (
      (row.underlying_symbol ?? row.symbol) !== expected.symbol ||
      type !== expected.contractType
    )
      continue;
    if (expected.barrier !== undefined && barrier !== expected.barrier)
      continue;
    if (
      !Number.isFinite(Number(row.buy_price)) ||
      row.buy_price == null ||
      Math.abs(Number(row.buy_price) - expected.stake) > 0.001
    )
      continue;
    if (
      time < Math.floor(expected.sentAt / 1000) ||
      time > Math.ceil(expected.sentAt / 1000) + 5
    )
      continue;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}
