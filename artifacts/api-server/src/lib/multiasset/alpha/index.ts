/**
 * WP4 — the alpha-agent registry.
 *
 * One place that names the five families, so the harness, the study, the CLI and
 * (in WP6/WP10) the desk and the journal all mean the same thing by "agent A".
 * Adding a sixth agent is a line here plus its file; silently changing what an
 * existing id means is not possible without changing this table.
 */
import { trendAgent, type TrendAgentOptions } from "./trend";
import { meanReversionAgent, type MeanReversionAgentOptions } from "./mean-reversion";
import { liquiditySweepAgent, type LiquiditySweepAgentOptions } from "./liquidity-sweep";
import { volRegimeAgent, type VolRegimeAgentOptions } from "./vol-regime";
import { seasonalityAgent, type SeasonalityAgentOptions } from "./seasonality";
import { ALPHA_IDS, ALPHA_LABELS, type AlphaAgent, type AlphaContext, type AlphaId, type AlphaView } from "./types";

export * from "./types";
export { trendAgent } from "./trend";
export { meanReversionAgent } from "./mean-reversion";
export { liquiditySweepAgent } from "./liquidity-sweep";
export { volRegimeAgent } from "./vol-regime";
export { seasonalityAgent } from "./seasonality";

export interface AlphaOptions {
  trend?: TrendAgentOptions;
  "mean-reversion"?: MeanReversionAgentOptions;
  "liquidity-sweep"?: LiquiditySweepAgentOptions;
  "vol-regime"?: VolRegimeAgentOptions;
  seasonality?: SeasonalityAgentOptions;
}

/** Build all five agents; options exist so a study can vary one threshold. */
export function buildAlphaAgents(options: AlphaOptions = {}): Record<AlphaId, AlphaAgent> {
  return {
    trend: trendAgent(options.trend),
    "mean-reversion": meanReversionAgent(options["mean-reversion"]),
    "liquidity-sweep": liquiditySweepAgent(options["liquidity-sweep"]),
    "vol-regime": volRegimeAgent(options["vol-regime"]),
    seasonality: seasonalityAgent(options.seasonality),
  };
}

export interface AlphaReading {
  id: AlphaId;
  label: string;
  view: AlphaView | null;
}

/**
 * Every agent's view at one decision point.
 *
 * Agents are independent by design: nothing here negotiates between them, and no
 * agent can veto another. That job belongs to the regime permission (WP3) and
 * the gatekeeper (WP6) — a design in which one agent could silence another would
 * make every study ambiguous about which layer was responsible.
 */
export function readAlphaAgents(
  ctx: AlphaContext,
  agents: Record<AlphaId, AlphaAgent> = buildAlphaAgents(),
): AlphaReading[] {
  return ALPHA_IDS.map((id) => {
    const agent = agents[id] as AlphaAgent;
    let view: AlphaView | null = null;
    try {
      view = agent.view(ctx);
    } catch {
      // An agent must never take the desk down with it: a throwing detector is a
      // silently disabled detector, not an outage. The study reports the
      // abstention; the ledger is the only place a bug can hide, so the id is
      // carried in the reading either way.
      view = null;
    }
    return { id, label: ALPHA_LABELS[id], view };
  });
}

/**
 * How many agents agree at this decision point, and on what.
 *
 * Deliberately naive — a count, not a weighted score. A weighted sum of
 * unmeasured opinions is exactly the v3 defect WP2 measured; the count is used
 * for reporting and for the WP6 model's feature, and it decides nothing on its
 * own.
 */
export function alphaAgreement(readings: AlphaReading[]): {
  buys: number;
  sells: number;
  net: number;
  agreeIds: AlphaId[];
  bestProbability: number;
} {
  const buyers = readings.filter((r) => r.view?.direction === "buy");
  const sellers = readings.filter((r) => r.view?.direction === "sell");
  const side = buyers.length >= sellers.length ? "buy" : "sell";
  const agree = (side === "buy" ? buyers : sellers).map((r) => r.id);
  const best = (side === "buy" ? buyers : sellers).reduce(
    (acc, r) => Math.max(acc, r.view?.probability ?? 0),
    0,
  );
  return {
    buys: buyers.length,
    sells: sellers.length,
    net: buyers.length - sellers.length,
    agreeIds: agree,
    bestProbability: best,
  };
}
