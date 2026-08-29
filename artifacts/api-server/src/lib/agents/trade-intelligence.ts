/**
 * Trade Intelligence Agent
 *
 * RESPONSIBILITY: After every completed trade, deeply analyze WHY it won or
 * lost by comparing agent scores, market conditions, timing, and alternative
 * contracts.  Produces a structured TradeIntelligenceReport persisted to DB
 * and feeds findings back to the Dynamic Confidence Engine.
 *
 * Questions answered for every trade:
 *   • Why did this trade win / lose?
 *   • Could the loss have been avoided?
 *   • Was the AI confidence too high, too low, or appropriate?
 *   • Would another contract type or barrier have been better?
 *   • Was the entry timing optimal?
 *   • Which agents dissented — and were they right?
 *   • How should future confidence thresholds be adjusted?
 */

import { db } from "@workspace/db";
import { tradeIntelligenceReportsTable } from "@workspace/db";
import { desc, sql } from "drizzle-orm";
import type { CoordinatorOutput } from "./types";
import { recordTradeOutcome as recordDynamicOutcome } from "./dynamic-confidence";
import { logger } from "../logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TradeIntelligenceInput {
  tradeId: number;
  symbol: string;
  contractType: string;
  barrier?: number | null;
  stake: number;
  won: boolean;
  profit: number;
  output: CoordinatorOutput;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Mean of an array of numbers */
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Sample std-dev */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Extract key agent scores from a CoordinatorOutput.
 * Returns scores keyed by agentId (0–100).
 */
function extractAgentScores(output: CoordinatorOutput): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const [id, agent] of Object.entries(output.agents ?? {})) {
    if (agent && typeof agent.score === "number") {
      scores[id] = agent.score;
    }
  }
  return scores;
}

/** True when agents were largely in agreement (low spread). */
function agentAgreementScore(scores: Record<string, number>): number {
  const vals = Object.values(scores).filter(s => typeof s === "number");
  if (vals.length < 2) return 50;
  const sd = stddev(vals);
  // Low std-dev → high agreement (score near 100); high sd → disagreement (near 0)
  return Math.max(0, Math.min(100, Math.round(100 - sd * 2)));
}

/** Agents that disagreed with the trade decision (scored < 40 when trade was approved). */
function findDissidentAgents(
  scores: Record<string, number>,
  shouldTrade: boolean,
): string[] {
  if (!shouldTrade) return [];
  return Object.entries(scores)
    .filter(([, score]) => score < 40)
    .map(([id]) => id);
}

// ── Market condition extraction ────────────────────────────────────────────────

function extractMarketFeatures(output: CoordinatorOutput) {
  const feAgent = output.agents["featureEngineering"];
  const tickAgent = output.agents["tickIntelligence"];
  const regimeAgent = output.agents["marketRegime"];

  const momentum    = (feAgent?.data?.["features"] as any)?.price?.momentum5 ?? null;
  const volatility  = (feAgent?.data?.["features"] as any)?.price?.vol20 ?? null;
  const tickData     = tickAgent?.data as Record<string, unknown> | undefined;
  const tickResult   = tickData?.["tickResult"] as Record<string, unknown> | undefined;
  const noiseScore  = (tickData?.["noiseScore"] ?? tickResult?.["noiseScore"] ?? null) as number | null;
  const tickAccel   = (tickResult?.["acceleration"] ?? tickData?.["acceleration"] ?? null) as number | null;
  const regime      = output.regime ?? (regimeAgent?.data?.["regime"] as string | undefined) ?? null;

  return { momentum, volatility, noiseScore, tickAccel, regime };
}

// ── Alternative contract comparison ──────────────────────────────────────────

function findBetterAlternative(output: CoordinatorOutput, actualProduct: string) {
  const evAgent = output.agents["evCalculator"] ?? output.agents["evAgent"];
  const allEV = (evAgent?.data?.["allEVResults"] ?? []) as any[];

  if (allEV.length < 2) return { betterContractType: null, betterBarrier: null };

  // Sort by EV descending; skip the contract actually traded
  const sorted = [...allEV]
    .filter(ev => {
      const key = `${ev.product}${ev.barrier ?? ""}`;
      const actual = `${actualProduct}${output.recommendation?.barrier ?? ""}`;
      return key !== actual;
    })
    .sort((a, b) => b.expectedValue - a.expectedValue);

  if (sorted.length === 0) return { betterContractType: null, betterBarrier: null };

  const top = sorted[0];
  // Only suggest if it has meaningfully better EV
  if (top.expectedValue > (output.recommendation?.expectedValue ?? 0) + 0.02) {
    return { betterContractType: top.product as string, betterBarrier: (top.barrier ?? null) as number | null };
  }
  return { betterContractType: null, betterBarrier: null };
}

// ── Why won / lost analysis ────────────────────────────────────────────────────

function buildWhyStatement(
  won: boolean,
  scores: Record<string, number>,
  output: CoordinatorOutput,
  features: ReturnType<typeof extractMarketFeatures>,
): { whyWon?: string; whyLost?: string; couldHaveAvoided: boolean; avoidanceReason?: string } {
  const rec = output.recommendation;
  const ev = rec?.expectedValue ?? 0;
  const winProb = (rec?.winProbability ?? 50) / 100;
  const riskScore = scores["riskIntelligence"] ?? 50;
  const timingScore = scores["executionTiming"] ?? 50;
  const digitScore = scores["digitProbability"] ?? 50;
  const dirScore = scores["riseFallAgent"] ?? 50;

  if (won) {
    const parts: string[] = [];
    if (ev > 0.01) parts.push(`Positive EV (${(ev * 100).toFixed(1)}%) confirmed profitable edge`);
    if (winProb > 0.58) parts.push(`High win probability (${(winProb * 100).toFixed(0)}%) validated`);
    if (timingScore > 65) parts.push("Strong execution timing captured favourable entry");
    if (features.regime && !["choppy", "volatile"].includes(features.regime)) {
      parts.push(`Market regime (${features.regime.replace("_", " ")}) favoured the trade`);
    }
    if (digitScore > 65) parts.push("Digit probability agent confirmed statistical edge");
    if (dirScore > 65) parts.push("Direction model had strong directional conviction");
    return {
      whyWon: parts.length > 0 ? parts.join("; ") + "." : "Trade won within expected probability range.",
      couldHaveAvoided: false,
    };
  }

  // Loss analysis
  const lossParts: string[] = [];
  let couldHaveAvoided = false;
  let avoidanceReason: string | undefined;

  if (ev < -0.02) {
    lossParts.push(`Marginal or negative EV (${(ev * 100).toFixed(1)}%) — edge was already slim`);
    couldHaveAvoided = true;
    avoidanceReason = "EV was below -2% suggesting insufficient statistical edge";
  }
  if (timingScore < 42) {
    lossParts.push(`Poor execution timing (score ${timingScore}) — entry was not optimal`);
    if (!couldHaveAvoided) { couldHaveAvoided = true; avoidanceReason = "Timing score was below threshold suggesting bad entry window"; }
  }
  if (riskScore < 40) {
    lossParts.push(`Risk intelligence signalled concern (score ${riskScore})`);
  }
  if (features.regime === "choppy" || features.regime === "volatile") {
    lossParts.push(`Unfavourable market regime: ${features.regime}`);
    if (!couldHaveAvoided) { couldHaveAvoided = true; avoidanceReason = "Market was choppy/volatile at entry"; }
  }
  if (features.noiseScore !== null && features.noiseScore > 70) {
    lossParts.push(`High market noise (${features.noiseScore.toFixed(0)}) increased randomness`);
  }
  if (lossParts.length === 0) {
    lossParts.push(`Loss within statistical expectation (P(win)=${(winProb * 100).toFixed(0)}%) — no clear avoidance signal`);
  }

  return {
    whyLost: lossParts.join("; ") + ".",
    couldHaveAvoided,
    avoidanceReason,
  };
}

// ── Confidence assessment ─────────────────────────────────────────────────────

function assessConfidence(
  winProbability: number,   // 0–100 as stored in recommendation
  won: boolean,
): "too_high" | "appropriate" | "too_low" {
  const wp = winProbability / 100;
  if (won) {
    // Won — was AI cautious when it should have been bold?
    return wp < 0.53 ? "too_low" : "appropriate";
  }
  // Lost — was AI overconfident?
  if (wp > 0.70) return "too_high";
  if (wp > 0.60) return "appropriate"; // within statistical variance
  return "appropriate";
}

// ── Timing assessment ─────────────────────────────────────────────────────────

function assessTiming(timingScore: number, won: boolean): "too_early" | "optimal" | "too_late" {
  if (timingScore >= 65) return "optimal";
  if (!won && timingScore < 45) return "too_early";
  return "optimal";
}

// ── Findings builder ──────────────────────────────────────────────────────────

function buildFindings(
  won: boolean,
  scores: Record<string, number>,
  dissidents: string[],
  agentAgreement: number,
  output: CoordinatorOutput,
  better: { betterContractType: string | null; betterBarrier: number | null },
  confidenceAssessment: string,
  timingAssessment: string,
  couldHaveAvoided: boolean,
): string[] {
  const findings: string[] = [];
  const rec = output.recommendation;

  // Agent-level findings
  if (dissidents.length > 0) {
    findings.push(`${dissidents.length} dissident agent(s) [${dissidents.join(", ")}] warned against this trade — they were ${won ? "wrong (false alarm)" : "right (the loss was signalled)"}`);
  }
  if (agentAgreement > 75) {
    findings.push(`High agent consensus (${agentAgreement}/100) — multi-agent agreement ${won ? "confirmed the edge" : "did not prevent the loss (market randomness)"}`);
  } else if (agentAgreement < 45) {
    findings.push(`Low agent consensus (${agentAgreement}/100) — significant disagreement among agents; stronger consensus required`);
  }

  // Confidence findings
  if (confidenceAssessment === "too_high") {
    findings.push(`AI was overconfident (P(win)=${rec?.winProbability}%) — confidence should be calibrated lower for this setup`);
  } else if (confidenceAssessment === "too_low" && won) {
    findings.push(`AI underestimated win probability (${rec?.winProbability}%) — confidence could be raised for similar setups`);
  }

  // Alternative contract
  if (better.betterContractType) {
    const label = `${better.betterContractType}${better.betterBarrier != null ? ` @${better.betterBarrier}` : ""}`;
    findings.push(`Alternative contract ${label} had higher EV — consider preferring it in similar conditions`);
  }

  // Timing
  if (timingAssessment !== "optimal") {
    findings.push(`Entry timing was sub-optimal (${timingAssessment}) — waiting for better execution window may have improved outcome`);
  }

  // Avoidance
  if (couldHaveAvoided) {
    findings.push("This loss showed early warning signals — adaptive thresholds have been adjusted");
  }

  return findings;
}

// ── Main analysis function ────────────────────────────────────────────────────

export async function analyzeCompletedTrade(input: TradeIntelligenceInput): Promise<void> {
  try {
    const { tradeId, symbol, contractType, barrier, stake, won, profit, output } = input;

    const agentScores = extractAgentScores(output);
    const features = extractMarketFeatures(output);
    const agreement = agentAgreementScore(agentScores);
    const dissidents = findDissidentAgents(agentScores, output.shouldTrade);
    const better = findBetterAlternative(output, contractType);
    const rec = output.recommendation;

    const whyAnalysis = buildWhyStatement(won, agentScores, output, features);
    const confidenceAssessment = assessConfidence(rec?.winProbability ?? 50, won);
    const timingAssessment = assessTiming(agentScores["executionTiming"] ?? 50, won);
    const findings = buildFindings(
      won, agentScores, dissidents, agreement, output,
      better, confidenceAssessment, timingAssessment, whyAnalysis.couldHaveAvoided,
    );

    const now = new Date();
    const hourOfDay = now.getHours();
    const minuteOfHour = now.getMinutes();
    const dayOfWeek = now.getDay();

    // Update the Dynamic Confidence Engine FIRST — decoupled from DB insert
    // so adaptive learning always runs even if the report storage fails.
    recordDynamicOutcome(agentScores, won);

    await db.insert(tradeIntelligenceReportsTable).values({
      tradeId,
      symbol,
      contractType,
      barrier:              barrier ?? null,
      stake:                String(stake),
      won,
      profit:               String(profit),

      regime:               features.regime ?? null,
      volatility:           features.volatility != null ? String(features.volatility) : null,
      momentum:             features.momentum  != null ? String(features.momentum)  : null,
      tickAcceleration:     features.tickAccel != null ? String(features.tickAccel) : null,
      noiseScore:           features.noiseScore != null ? String(features.noiseScore) : null,
      confidenceAtEntry:    String(output.confidenceScore),
      evAtEntry:            String(rec?.expectedValue ?? 0),
      qualityScore:         String(output.qualityScore),
      winProbAtEntry:       String(rec?.winProbability ?? 50),
      agentScoresJson:      JSON.stringify(agentScores),

      whyWon:               whyAnalysis.whyWon ?? null,
      whyLost:              whyAnalysis.whyLost ?? null,
      couldHaveAvoided:     whyAnalysis.couldHaveAvoided,
      avoidanceReason:      whyAnalysis.avoidanceReason ?? null,
      confidenceAssessment,
      betterContractType:   better.betterContractType ?? null,
      betterBarrier:        better.betterBarrier ?? null,
      timingAssessment,
      agentAgreementScore:  String(agreement),
      dissidentAgentsJson:  JSON.stringify(dissidents),
      findingsJson:         JSON.stringify(findings),

      hourOfDay,
      minuteOfHour,
      dayOfWeek,
    });

    logger.debug({
      tradeId, symbol, contractType, won,
      agreement, dissidents: dissidents.length,
      confidenceAssessment, couldHaveAvoided: whyAnalysis.couldHaveAvoided,
    }, "Trade intelligence report stored");

  } catch (err) {
    logger.warn({ err }, "Trade intelligence analysis failed — skipping");
  }
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function getRecentReports(limit = 20) {
  return db
    .select()
    .from(tradeIntelligenceReportsTable)
    .orderBy(desc(tradeIntelligenceReportsTable.createdAt))
    .limit(limit);
}

export async function getIntelligenceSummary() {
  // Sample of the most recent reports drives the qualitative breakdown
  // (findings, confidence assessment, timing) — a rolling window is fine for that.
  const reports = await db
    .select()
    .from(tradeIntelligenceReportsTable)
    .orderBy(desc(tradeIntelligenceReportsTable.createdAt))
    .limit(100);

  // totalAnalyzed / winsAnalyzed / lossesAnalyzed must reflect the TRUE total
  // count of analyzed trades (not just the 100-row sample above), so this KPI
  // matches the "trades analyzed" counter shown elsewhere in the UI.
  const [{ total, wins, losses }] = await db
    .select({
      total:  sql<number>`count(*)`,
      wins:   sql<number>`count(*) filter (where ${tradeIntelligenceReportsTable.won} = true)`,
      losses: sql<number>`count(*) filter (where ${tradeIntelligenceReportsTable.won} = false)`,
    })
    .from(tradeIntelligenceReportsTable);
  const totalCount  = Number(total)  || 0;
  const winsCount   = Number(wins)   || 0;
  const lossesCount = Number(losses) || 0;

  if (totalCount === 0) {
    return {
      totalAnalyzed: 0,
      winsAnalyzed: 0,
      lossesAnalyzed: 0,
      avoidableLosses: 0,
      avoidableLossRate: 0,
      overconfidentRate: 0,
      underconfidentRate: 0,
      appropriateConfidenceRate: 0,
      timingIssueRate: 0,
      avgAgentAgreement: 0,
      topFindings: [],
      recentReports: [],
    };
  }

  const won  = reports.filter(r => r.won);
  const lost = reports.filter(r => !r.won);
  const avoidable = lost.filter(r => r.couldHaveAvoided);

  const overconfident  = reports.filter(r => r.confidenceAssessment === "too_high").length;
  const underconfident = reports.filter(r => r.confidenceAssessment === "too_low").length;
  const appropriate    = reports.filter(r => r.confidenceAssessment === "appropriate").length;

  const timingIssues = reports.filter(r => r.timingAssessment !== "optimal").length;
  const avgAgreement = reports.reduce((s, r) => s + Number(r.agentAgreementScore ?? 50), 0) / reports.length;

  // Collect top findings (most common)
  const findingCounts: Record<string, number> = {};
  for (const r of reports) {
    try {
      const findings = JSON.parse(r.findingsJson ?? "[]") as string[];
      for (const f of findings) {
        // Truncate to key phrase
        const key = f.substring(0, 80);
        findingCounts[key] = (findingCounts[key] ?? 0) + 1;
      }
    } catch { /* ignore */ }
  }
  const topFindings = Object.entries(findingCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([finding, count]) => ({ finding, count }));

  return {
    // True totals across ALL analyzed trades (matches the "trades analyzed" counter
    // shown elsewhere in the UI) — NOT limited to the 100-row sample used for the
    // qualitative breakdown below.
    totalAnalyzed:           totalCount,
    winsAnalyzed:            winsCount,
    lossesAnalyzed:          lossesCount,
    avoidableLosses:         avoidable.length,
    avoidableLossRate:       lost.length > 0 ? Math.round(avoidable.length / lost.length * 100) : 0,
    overconfidentRate:       Math.round(overconfident  / reports.length * 100),
    underconfidentRate:      Math.round(underconfident / reports.length * 100),
    appropriateConfidenceRate: Math.round(appropriate  / reports.length * 100),
    timingIssueRate:         Math.round(timingIssues   / reports.length * 100),
    avgAgentAgreement:       Math.round(avgAgreement),
    topFindings,
    recentReports: reports.slice(0, 10),
  };
}
