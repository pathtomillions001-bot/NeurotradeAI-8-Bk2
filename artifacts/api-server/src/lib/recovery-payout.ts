import { getContractProposal } from "./deriv";
import { getFallbackPayout } from "./payouts";

export interface RecoveryPayoutQuote {
  payoutMultiplier: number;
  source: "live" | "fallback";
  /** Epoch ms the quote was taken (0 for table fallbacks). */
  takenAt: number;
}

const quoteCache = new Map<string, { quote: RecoveryPayoutQuote; expiresAt: number }>();
/**
 * WP2 (D7): recovery quotes age fast. The TTL is ≤ 3 s so a recovery stake is
 * never sized from a quote older than a couple of ticks; keyed per
 * symbol/contract/barrier/duration/currency. The previous 60 s cache let a
 * whole recovery ladder run on one stale quote.
 */
const LIVE_QUOTE_TTL_MS = 3_000;
const LIVE_QUOTE_TIMEOUT_MS = 2_500;
/** Buy-time proposal timeout: short, because recovery must not stall. */
const BUY_QUOTE_TIMEOUT_MS = 1_500;
/** A fallback (table) quote gets a 2 % safety margin on the stake. */
export const FALLBACK_SAFETY_MARGIN = 0.02;
/** Payout drift between decision and buy that triggers a one-time re-size. */
export const PAYOUT_DRIFT_TOLERANCE = 0.01;

function normalizeContractType(contractType: string): string {
  return contractType === "RISE" ? "CALL"
    : contractType === "FALL" ? "PUT"
    : contractType;
}

export type ProposalFetcher = (params: {
  symbol: string;
  contractType: string;
  stake: number;
  duration: number;
  durationUnit: string;
  currency: string;
  barrier?: number | string;
}) => Promise<{ payoutMultiplier: number; askPrice: number } | null>;

const defaultFetcher: ProposalFetcher = async (params) => {
  const proposal = await getContractProposal(null, params);
  if (!proposal) return null;
  return { payoutMultiplier: proposal.payoutMultiplier, askPrice: proposal.askPrice };
};

/**
 * Resolve the payout multiplier used by recovery stake math.
 *
 * The public Deriv proposal is requested with a $1 stake so its payout can be
 * read directly as a multiplier. If the quote cannot be obtained quickly, the
 * canonical user-provided payout schedule is used. Quotes are cached ≤ 3 s so
 * an instant recovery loop does not add a WebSocket round-trip to every trade
 * while never trusting a stale quote (WP2).
 */
export async function resolveRecoveryPayout(params: {
  symbol: string;
  contractType: string;
  barrier?: number | null;
  duration: number;
  durationUnit?: string;
  currency?: string;
  fetchProposal?: ProposalFetcher;
}): Promise<RecoveryPayoutQuote> {
  const contractType = normalizeContractType(params.contractType);
  const fallback: RecoveryPayoutQuote = {
    payoutMultiplier: getFallbackPayout(contractType, params.barrier),
    source: "fallback",
    takenAt: 0,
  };

  const duration = Math.max(1, Math.round(params.duration || 1));
  const durationUnit = params.durationUnit || "t";
  const currency = params.currency || "USD";
  const key = [params.symbol, contractType, params.barrier ?? "", duration, durationUnit, currency].join(":");
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  const fetcher = params.fetchProposal ?? defaultFetcher;
  try {
    const proposal = await Promise.race([
      fetcher({
        symbol: params.symbol,
        contractType,
        stake: 1,
        duration,
        durationUnit,
        currency,
        barrier: contractType.startsWith("DIGIT") && params.barrier != null
          ? params.barrier
          : undefined,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIVE_QUOTE_TIMEOUT_MS)),
    ]);

    const multiplier = Number(proposal?.payoutMultiplier);
    if (Number.isFinite(multiplier) && multiplier > 1) {
      const quote: RecoveryPayoutQuote = { payoutMultiplier: multiplier, source: "live", takenAt: Date.now() };
      quoteCache.set(key, { quote, expiresAt: Date.now() + LIVE_QUOTE_TTL_MS });
      return quote;
    }
  } catch {
    // Fall through to the canonical schedule. Recovery must not stall on pricing.
  }

  // Cache failures briefly too, avoiding repeated timeouts during an outage.
  quoteCache.set(key, { quote: fallback, expiresAt: Date.now() + 10_000 });
  return fallback;
}

/** Test hook: drop cached quotes (deterministic tests). */
export function clearRecoveryQuoteCache(): void {
  quoteCache.clear();
}

export interface RecoveryBuyPlan {
  /** Stake to buy at so a win clears `targetClearance` at the ACTUAL multiplier. */
  stake: number;
  /** Payout multiplier the stake was sized on (live proposal or table). */
  payoutMultiplier: number;
  /** ask_price reported by the buy-time proposal (null on fallback). */
  askPrice: number | null;
  source: "live" | "fallback";
  /** True when a live payout drifted > 1 % from the assumption and we re-sized. */
  reSized: boolean;
  /** True when the fallback 2 % safety margin was applied. */
  safetyMarginApplied: boolean;
}

/**
 * WP2 — buy-time stake exactness (D7).
 *
 * Recovery completes when one win clears the outstanding target amount. That
 * promise only holds if the stake is sized on the payout the broker will
 * ACTUALLY pay. So at buy time we:
 *   1. request a fresh proposal for the candidate stake,
 *   2. read ask_price and payout,
 *   3. recompute the stake so `stake × (payout − 1) = targetClearance` at the
 *      ACTUAL multiplier; if the live payout differs from the assumption by
 *      more than 1 %, this re-size is the one repair we make (once),
 *   4. if no proposal arrives within the short timeout, fall back to the
 *      canonical table and mark the plan source=fallback with a 2 % safety
 *      margin on the stake (overpay slightly rather than under-recover).
 *
 * Pure with respect to an injected `fetchProposal` — the cycle passes the real
 * Deriv proposal call; tests pass deterministic fakes.
 */
export async function prepareRecoveryBuy(params: {
  symbol: string;
  contractType: string;
  barrier?: number | null;
  duration: number;
  durationUnit?: string;
  currency?: string;
  /** Amount a win must clear (loss debt; adaptive mode excludes target profit). */
  targetClearance: number;
  /** The payout multiplier the decision assumed (table or cached live). */
  assumedPayout: number;
  /** Candidate stake derived from the assumption: target/(assumed−1), pre-limits. */
  candidateStake: number;
  fetchProposal?: ProposalFetcher;
  timeoutMs?: number;
  now?: () => number;
}): Promise<RecoveryBuyPlan> {
  const contractType = normalizeContractType(params.contractType);
  const duration = Math.max(1, Math.round(params.duration || 1));
  const durationUnit = params.durationUnit || "t";
  const currency = params.currency || "USD";
  const target = Math.max(0, params.targetClearance);
  const assumed = Number.isFinite(params.assumedPayout) && params.assumedPayout > 1
    ? params.assumedPayout
    : getFallbackPayout(contractType, params.barrier);

  const fallbackPlan = (): RecoveryBuyPlan => ({
    // 2 % safety margin: a table stake that ends up paying slightly less than
    // the table says still clears the debt.
    stake: params.candidateStake * (1 + FALLBACK_SAFETY_MARGIN),
    payoutMultiplier: assumed,
    askPrice: null,
    source: "fallback",
    reSized: false,
    safetyMarginApplied: true,
  });

  const fetcher = params.fetchProposal ?? defaultFetcher;
  let proposal: { payoutMultiplier: number; askPrice: number } | null = null;
  try {
    proposal = await Promise.race([
      fetcher({
        symbol: params.symbol,
        contractType,
        stake: Math.max(0.35, params.candidateStake),
        duration,
        durationUnit,
        currency,
        barrier: contractType.startsWith("DIGIT") && params.barrier != null
          ? params.barrier
          : undefined,
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), params.timeoutMs ?? BUY_QUOTE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    proposal = null;
  }

  const livePayout = Number(proposal?.payoutMultiplier);
  if (!proposal || !Number.isFinite(livePayout) || livePayout <= 1) {
    return fallbackPlan();
  }

  const drift = Math.abs(livePayout - assumed) / assumed;
  if (drift <= PAYOUT_DRIFT_TOLERANCE) {
    // The assumption held: size on the live multiplier anyway (it IS the
    // assumed value up to tolerance) so the clearance is exact at the quote.
    return {
      stake: target / (livePayout - 1),
      payoutMultiplier: livePayout,
      askPrice: Number(proposal.askPrice) > 0 ? Number(proposal.askPrice) : null,
      source: "live",
      reSized: false,
      safetyMarginApplied: false,
    };
  }

  // Payout moved more than 1 % since the decision: ONE re-size on the actual
  // multiplier. (A second proposal is deliberately not requested — a moving
  // quote is a feed problem, and recovery must not stall chasing it.)
  return {
    stake: target / (livePayout - 1),
    payoutMultiplier: livePayout,
    askPrice: Number(proposal.askPrice) > 0 ? Number(proposal.askPrice) : null,
    source: "live",
    reSized: true,
    safetyMarginApplied: false,
  };
}
