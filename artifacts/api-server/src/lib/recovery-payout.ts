import { getContractProposal } from "./deriv";
import { getFallbackPayout } from "./payouts";

export interface RecoveryPayoutQuote {
  payoutMultiplier: number;
  source: "live" | "fallback";
}

const quoteCache = new Map<string, { quote: RecoveryPayoutQuote; expiresAt: number }>();
const LIVE_QUOTE_TTL_MS = 60_000;
const LIVE_QUOTE_TIMEOUT_MS = 2_500;

function normalizeContractType(contractType: string): string {
  return contractType === "RISE" ? "CALL"
    : contractType === "FALL" ? "PUT"
    : contractType;
}

/**
 * Resolve the payout multiplier used by recovery stake math.
 *
 * The public Deriv proposal is requested with a $1 stake so its payout can be
 * read directly as a multiplier. If the quote cannot be obtained quickly, the
 * canonical user-provided payout schedule is used. Quotes are cached briefly so
 * an instant recovery loop does not add a WebSocket round-trip to every trade.
 */
export async function resolveRecoveryPayout(params: {
  symbol: string;
  contractType: string;
  barrier?: number | null;
  duration: number;
  durationUnit?: string;
  currency?: string;
}): Promise<RecoveryPayoutQuote> {
  const contractType = normalizeContractType(params.contractType);
  const fallback: RecoveryPayoutQuote = {
    payoutMultiplier: getFallbackPayout(contractType, params.barrier),
    source: "fallback",
  };

  const duration = Math.max(1, Math.round(params.duration || 1));
  const durationUnit = params.durationUnit || "t";
  const currency = params.currency || "USD";
  const key = [params.symbol, contractType, params.barrier ?? "", duration, durationUnit, currency].join(":");
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.quote;

  try {
    const proposal = await Promise.race([
      getContractProposal(null, {
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
      const quote: RecoveryPayoutQuote = { payoutMultiplier: multiplier, source: "live" };
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
