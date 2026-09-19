/** Broker boundary for Match Pulse. Injectable transport; tests never place orders. */
import { sameDigitTick, type DigitTick } from "./digit-tape";

export interface PulseTransport {
  request(message: Record<string, unknown>, timeoutMs: number, hooks?: {
    beforeSend?: () => void;
    onSent?: () => void;
  }): Promise<any>;
}

export class PulseOrderError extends Error {
  constructor(message: string, readonly disposition: "not-bought" | "unknown") {
    super(message);
    this.name = "PulseOrderError";
  }
}

/** No score, recovery step or patience timeout can override a failed guard. */
export function assertPulseTick(input: {
  decision: DigitTick;
  current: DigitTick | null | undefined;
  now: number;
  maxAgeMs: number;
  expectedIntervalMs?: number;
  live: boolean;
  stopped: boolean;
  ownsExecution: boolean;
}): void {
  const { decision, current, now, maxAgeMs } = input;
  if (input.stopped || !input.ownsExecution) throw new PulseOrderError("Session stopped or execution ownership changed", "not-bought");
  if (!sameDigitTick(decision, current)) throw new PulseOrderError("The decision tick changed; wait for a new setup", "not-bought");
  if (!Number.isFinite(now) || now < decision.receivedAt || now - decision.receivedAt > maxAgeMs) {
    throw new PulseOrderError("The entry window expired before the order could be sent", "not-bought");
  }
  // Receipt age alone misses network-delayed ticks. Leave a margin before
  // the NEXT broker epoch as well; never send after the predicted tick is due.
  if (input.live && (decision.source !== "live" || now < decision.epoch * 1000 - 1000 ||
      now + 150 >= decision.epoch * 1000 + (input.expectedIntervalMs ?? 2000))) {
    throw new PulseOrderError("Live orders require a fresh, broker-origin tick", "not-bought");
  }
}

export interface PulseQuote {
  proposalId: string;
  ask: number;
  payout: number;
  multiplier: number;
}
export interface PulsePurchase extends PulseQuote {
  contractId: number;
  buyPrice: number;
  startTime: number | null;
}

export type PulseBuyConfirmation = { rejected: true } | {
  rejected: false; contractId: number; buyPrice: number; startTime: number | null;
};

/** Only an exact, unique order reference may resolve a late purchase reply. */
export function readPulseBuyConfirmation(message: any, reference: string): PulseBuyConfirmation | null {
  const direct = message?.passthrough?.match_pulse_order;
  const echoed = message?.echo_req?.passthrough?.match_pulse_order;
  if (!reference || message?.msg_type !== "buy" || (direct ?? echoed) !== reference ||
      (direct !== undefined && direct !== reference) || (echoed !== undefined && echoed !== reference)) return null;
  if (message.error) return { rejected: true };
  const contractId = Number(message.buy?.contract_id);
  const buyPrice = Number(message.buy?.buy_price);
  if (!Number.isSafeInteger(contractId) || contractId <= 0 || !Number.isFinite(buyPrice) || buyPrice <= 0) return null;
  const start = Number(message.buy?.start_time);
  return { rejected: false, contractId, buyPrice, startTime: Number.isFinite(start) && start > 0 ? start : null };
}

/**
 * One quote, at most one buy. Never retry an ambiguous buy. The guard is run
 * INSIDE the transport's send queue, not just before awaiting the proposal.
 */
export async function buyPulseMatch(input: {
  transport: PulseTransport;
  symbol: string;
  digit: number;
  stake: number;
  currency: string;
  guard: (quote?: PulseQuote) => void;
  onBuySent: () => void;
  timeoutMs?: number;
  /** Echoed by Deriv, including a response that arrives after a local timeout. */
  reference?: string;
}): Promise<PulsePurchase> {
  const { transport, guard } = input;
  if (!Number.isInteger(input.digit) || input.digit < 0 || input.digit > 9 ||
      !Number.isFinite(input.stake) || input.stake < 0.35 || input.stake !== Math.round(input.stake * 100) / 100) {
    throw new PulseOrderError("Invalid Matches order", "not-bought");
  }
  let sent = false;
  try {
    guard();
    const proposal = await transport.request({
      proposal: 1, amount: input.stake, basis: "stake", contract_type: "DIGITMATCH",
      currency: input.currency, duration: 1, duration_unit: "t",
      underlying_symbol: input.symbol, barrier: String(input.digit),
    }, input.timeoutMs ?? 5000, { beforeSend: () => guard() });
    if (!proposal || proposal.error) throw new PulseOrderError(proposal?.error?.message ?? "Proposal unavailable; no order sent", "not-bought");
    const quoted = proposal.proposal;
    const ask = Number(quoted?.ask_price);
    const payout = Number(quoted?.payout);
    if (!quoted?.id || !Number.isFinite(ask) || !Number.isFinite(payout) || ask <= 0 || payout <= ask ||
        Math.abs(ask - input.stake) > 0.000001) {
      throw new PulseOrderError("Invalid quote or changed ask price; no order sent", "not-bought");
    }
    const quote: PulseQuote = { proposalId: String(quoted.id), ask, payout, multiplier: payout / ask };
    guard(quote);
    const buy = await transport.request({ buy: quote.proposalId, price: ask,
      ...(input.reference ? { passthrough: { match_pulse_order: input.reference } } : {}),
    }, input.timeoutMs ?? 5000, {
      beforeSend: () => guard(quote),
      onSent: () => { sent = true; input.onBuySent(); },
    });
    if (buy?.error) throw new PulseOrderError(buy.error.message ?? "Broker rejected the buy", "not-bought");
    const contractId = Number(buy?.buy?.contract_id);
    const buyPrice = Number(buy?.buy?.buy_price);
    if (!Number.isSafeInteger(contractId) || contractId <= 0 || !Number.isFinite(buyPrice) || buyPrice <= 0) {
      throw new PulseOrderError("Purchase is unconfirmed. Do not retry; reconcile with Deriv first", "unknown");
    }
    const startTime = Number(buy.buy.start_time);
    return { ...quote, contractId, buyPrice, startTime: Number.isFinite(startTime) && startTime > 0 ? startTime : null };
  } catch (error) {
    if (error instanceof PulseOrderError) throw error;
    throw new PulseOrderError(error instanceof Error ? error.message : "Broker request failed", sent ? "unknown" : "not-bought");
  }
}

/** Hard pre-trade caps apply to normal AND recovery stakes, before rounding. */
export function capPulseStake(requested: number, maxStake: number, balance: number, remainingLossBudget: number): number {
  if (![requested, maxStake, balance, remainingLossBudget].every(v => Number.isFinite(v) && v >= 0)) return 0;
  const capacity = Math.floor((Math.min(maxStake, balance, remainingLossBudget) + 1e-9) * 100) / 100;
  if (capacity < 0.35 || requested < 0.35) return 0;
  return Math.min(Math.round(requested * 100) / 100, capacity);
}
