/**
 * Autonomous engine — pre-flight: what can THIS Deriv account actually quote?
 *
 * WHY: the engine's first act on a live account used to be spending real money.
 * An account that cannot quote the selected contracts (its market access, its
 * currency, its stake bounds, its jurisdiction) therefore discovered the fact
 * the expensive way — three rejected buys in, it stopped itself with Deriv's
 * bare sentence ("Unknown contract proposal") and no way to tell which account
 * property was responsible. Restarting changed nothing: the tape ranked the
 * same contracts and the broker refused them again.
 *
 * The pre-flight asks the broker FIRST, with quotes only (a `proposal` never
 * moves money). It is cheap — one quote per selected contract family, spread
 * over different markets — and it answers the question the user actually has:
 * which contracts this account can trade, and for the ones it cannot, which
 * broker code says so. Blocked families are quarantined so the engine never
 * ranks them; a start is refused only when every selected family is blocked and
 * the evidence spans more than one market, so a single odd market or a transient
 * Deriv error can never stop an account that is able to trade.
 */

import { logger } from "../logger";
import { probeAccountContract, type ContractProbe } from "../deriv";
import { friendlyErrorMessage } from "../friendly-error";
import { HEDGE_DURATION_TICKS, HEDGE_DURATION_UNIT } from "./constants";
import { familySpecsFor, type FamilySettings } from "./families";
import type { AutonomousContractSets } from "./contract-sets";
import type { HedgeContractType } from "./hedge-analysis";
import { clearQuarantine, rememberQuarantined } from "./contract-availability";
import { isTwoDecimalCurrency, roundStake } from "./stake-bounds";

/** One quote per family, on as many different markets as there are families. */
const MAX_PREFLIGHT_QUOTES = 12;
/** Fallback probe stake when the broker reports no minimum. */
const FALLBACK_PROBE_STAKE = 0.35;

export interface PreflightContract {
  symbol: string;
  contract: HedgeContractType;
  barrier: number | null;
  stake: number;
}

export interface PreflightBlocked extends PreflightContract {
  /** Deriv's machine-readable code, "" when it did not send one. */
  code: string;
  /** The broker's own words. */
  reason: string;
}

export interface PreflightResult {
  checkedAt: number;
  /** False when there was nothing to check (paper mode, no token). */
  ran: boolean;
  quotable: PreflightContract[];
  /** Definitive "this account cannot quote it" verdicts — quarantined. */
  blocked: PreflightBlocked[];
  /** Throttling, timeouts, stake problems: never a reason to refuse a start. */
  inconclusive: PreflightBlocked[];
  /** Distinct markets the verdicts came from. */
  marketsProbed: number;
}

/** A valid probe barrier for a family (auto digits get a concrete one). */
function barrierForProbe(contract: HedgeContractType): number | null {
  switch (contract) {
    case "DIGITOVER": return 4;
    case "DIGITUNDER": return 5;
    case "DIGITMATCH":
    case "DIGITDIFF": return 5;
    default: return null;
  }
}

function familySupportedOn(market: { digitEnabled?: boolean }, contract: HedgeContractType): boolean {
  return contract.startsWith("DIGIT") ? market.digitEnabled === true : true;
}

/** Every family in the user's normal + recovery selection, in canonical order. */
export function selectedFamilies(
  settings: FamilySettings,
  sets?: AutonomousContractSets,
): HedgeContractType[] {
  const types: HedgeContractType[] = [];
  for (const mode of ["NORMAL", "RECOVERY"] as const) {
    for (const spec of familySpecsFor({ settings, mode, digitEnabled: true, sets })) {
      if (!types.includes(spec.type)) types.push(spec.type);
    }
  }
  return types;
}

/**
 * Ask the account whether it can quote each selected family. Returns what it
 * found and quarantines the definitive refusals. Never throws: a pre-flight
 * that cannot run must not block an engine that might trade fine.
 */
/** The quote primitive. Injectable so the whole pre-flight decision is testable. */
export type ProbeFn = (
  token: string,
  accountId: string,
  params: {
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    barrier?: number | string | null;
  },
) => Promise<ContractProbe>;

export async function runAutonomousPreflight(args: {
  sessionId: string;
  token: string | null;
  accountId: string | null;
  currency: string;
  markets: Array<{ symbol: string; digitEnabled?: boolean }>;
  settings: FamilySettings;
  sets?: AutonomousContractSets;
  /** Broker minimum stake, when the caller already knows it. */
  minStake?: number;
  probe?: ProbeFn;
}): Promise<PreflightResult> {
  const probeContract: ProbeFn = args.probe ?? probeAccountContract;
  const result: PreflightResult = {
    checkedAt: Date.now(),
    ran: false,
    quotable: [],
    blocked: [],
    inconclusive: [],
    marketsProbed: 0,
  };
  // A start re-asks the broker what this account can trade: the user may have
  // connected a different Deriv login, or Deriv may have opened a market up.
  clearQuarantine(args.sessionId);
  if (!args.token || !args.accountId) return result;

  const families = selectedFamilies(args.settings, args.sets);
  if (families.length === 0 || args.markets.length === 0) return result;
  result.ran = true;

  const currency = args.currency || "USD";
  const stake = args.minStake && args.minStake > 0
    ? roundStake(args.minStake, currency)
    : (isTwoDecimalCurrency(currency) ? FALLBACK_PROBE_STAKE : roundStake(FALLBACK_PROBE_STAKE, currency));
  const probed = new Set<string>();

  for (let i = 0; i < families.length && i < MAX_PREFLIGHT_QUOTES; i++) {
    const contract = families[i]!;
    // Rotate the market per family so "every family is blocked" is evidence
    // about the ACCOUNT, not about one symbol that happens to be closed.
    const market =
      args.markets.slice(i).concat(args.markets.slice(0, i)).find((m) => familySupportedOn(m, contract));
    if (!market) continue;

    const barrier = barrierForProbe(contract);
    const probe = await probeContract(args.token, args.accountId, {
      symbol: market.symbol,
      contractType: contract,
      stake,
      duration: HEDGE_DURATION_TICKS,
      durationUnit: HEDGE_DURATION_UNIT,
      currency,
      barrier,
    });
    probed.add(market.symbol);
    const ref: PreflightContract = { symbol: market.symbol, contract, barrier, stake };

    if (probe.ok) {
      result.quotable.push(ref);
      continue;
    }
    const blocked: PreflightBlocked = { ...ref, code: probe.code, reason: probe.message || "Deriv refused the quote" };
    if (probe.kind === "contract-unavailable") {
      // Quarantined at candidate scope on purpose: one market's verdict must
      // not silence a family the account may trade elsewhere. The cycle's own
      // follow-up probes widen the scope when the evidence supports it.
      rememberQuarantined(args.sessionId, {
        scope: "candidate",
        symbol: market.symbol,
        contract,
        code: probe.code,
        reason: friendlyErrorMessage(blocked.reason),
        kind: probe.kind,
      });
      result.blocked.push(blocked);
    } else {
      result.inconclusive.push(blocked);
    }
  }

  result.marketsProbed = probed.size;
  logger.info(
    {
      sessionId: args.sessionId,
      currency,
      quotable: result.quotable.length,
      blocked: result.blocked.length,
      inconclusive: result.inconclusive.length,
      marketsProbed: result.marketsProbed,
      blockedDetail: result.blocked.map((b) => `${b.contract}@${b.symbol}:${b.code || "no-code"}`),
    },
    "Autonomous pre-flight: contract availability for this Deriv account",
  );
  return result;
}

/**
 * Should this start be refused? Only when every selected family got a
 * DEFINITIVE capability verdict and those verdicts did not all come from one
 * market — otherwise the engine starts and finds out per candidate, which is
 * the safer mistake.
 */
export function shouldRefuseStart(result: PreflightResult): boolean {
  if (!result.ran) return false;
  if (result.quotable.length > 0) return false;
  if (result.blocked.length === 0) return false;
  return result.inconclusive.length === 0 && (result.marketsProbed >= 2 || result.blocked.length === 1);
}

/** The sentence the user sees instead of a dead engine. */
export function preflightRefusalMessage(result: PreflightResult): string {
  const detail = result.blocked
    .map((b) => `${b.contract} on ${b.symbol}${b.code ? ` (Deriv code ${b.code})` : ""}: ${b.reason}`)
    .join("; ");
  return (
    "This Deriv account cannot quote any of the contracts the engine is set to trade, so it was not started. " +
    detail +
    " — choose different contracts, or connect the Deriv account that is allowed to trade them."
  );
}
