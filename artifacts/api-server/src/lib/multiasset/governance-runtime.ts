/**
 * WP9 — the governing runtime: the desk's own memory of what its agents did.
 *
 * `governance.ts` decides; `governance-store.ts` remembers; this module is the
 * part that lives inside a running desk and connects the two to the decision
 * path. Three jobs, and each one is a rule:
 *
 *   1. **The overlay.** `governanceOverlay(sessionId)` answers, synchronously,
 *      which agents may not propose at all and which propose at half budget. The
 *      registry is seeded from the durable rows on the first call for a session
 *      and then kept in process; a load that arrives later may only make the
 *      registry MORE restrictive, never less. A deploy that restarts the API
 *      therefore cannot hand an agent that was on its way out a clean slate.
 *
 *   2. **The attribution.** A trade has to be charged to the agents that
 *      proposed it. The decision carries their ids; the plan's arm time is the
 *      join point; and the fill is what ties a plan to a ticket. Those three
 *      links are held here, bounded, because they are the only place the desk
 *      knows which detector to credit.
 *
 *   3. **The loop.** When a position closes: one `desk_trades` row, one resolved
 *      shadow evaluation, one e-process update per proposing agent, and a journal
 *      entry naming any agent whose threshold was crossed. Every step is
 *      best-effort and none of them can throw into the bridge's heartbeat.
 */

import { ALPHA_IDS, type AlphaId } from "./alpha/types";
import {
  applyGovernanceOutcome,
  disabledAgents,
  halvedAgents,
  initialGovernanceRegistry,
  weeklyReport,
  weekWindow,
  type AgentGovernanceState,
  type AgentOutcome,
  type GovernanceAction,
  type WeeklyReport,
} from "./governance";
import {
  listShadowEvaluations,
  listTrades,
  loadGovernanceState,
  recordShadowEvaluation,
  recordTrade,
  resolveShadowEvaluation,
  saveGovernanceState,
  saveArtifact,
  loadArtifact,
  type ShadowEvaluationRow,
  type TradeRow,
} from "./governance-store";
import type { HmmModel } from "./regime-hmm";
import type { TradeMode } from "./types";

/** Bounded in-process caches. A desk tracks a handful of symbols, not thousands. */
const PLAN_LIMIT = 256;
const TICKET_LIMIT = 512;

interface PlanMemory {
  sessionId: string;
  planId: string;
  symbol: string;
  mode: TradeMode;
  direction: string;
  agents: AlphaId[];
  predictedProbability: number | null;
  armedAtMs: number;
}

const registries = new Map<string, AgentGovernanceState[]>();
const loading = new Set<string>();
const plans = new Map<string, PlanMemory>();
const planOrder: string[] = [];
const tickets = new Map<number, string>();

/** The registry for a session, seeded locally and merged with durable state. */
export function governanceRegistry(sessionId: string): AgentGovernanceState[] {
  const existing = registries.get(sessionId);
  if (existing) return existing;
  const seeded = initialGovernanceRegistry();
  registries.set(sessionId, seeded);
  void ensureGovernanceLoaded(sessionId);
  return seeded;
}

/**
 * Load the durable registry once per session and merge it in RESTRICTIVELY.
 *
 * `statusRank` is why: a stored row that says "disabled" must never be softened
 * to "halved" by a process that happens to have a fresher-looking in-memory
 * value, and an e-value is evidence — it cannot decrease by merging.
 */
function statusRank(status: AgentGovernanceState["status"]): number {
  return status === "disabled" ? 2 : status === "halved" ? 1 : 0;
}

export async function ensureGovernanceLoaded(sessionId: string): Promise<void> {
  if (loading.has(sessionId)) return;
  loading.add(sessionId);
  try {
    const stored = await loadGovernanceState(sessionId);
    if (!stored || stored.length === 0) return;
    const current = registries.get(sessionId) ?? initialGovernanceRegistry();
    const merged = current.map((entry) => {
      const other = stored.find((candidate) => candidate.agentId === entry.agentId);
      if (!other) return entry;
      const status =
        statusRank(other.status) > statusRank(entry.status) ? other.status : entry.status;
      return {
        ...entry,
        status,
        eValue: Math.max(entry.eValue, other.eValue),
        outcomes: Math.max(entry.outcomes, other.outcomes),
        wins: Math.max(entry.wins, other.wins),
        totalR: Math.abs(other.totalR) > Math.abs(entry.totalR) ? other.totalR : entry.totalR,
        phValue: Math.max(entry.phValue, other.phValue),
        phAlarms: Math.max(entry.phAlarms, other.phAlarms),
        reason: statusRank(other.status) > statusRank(entry.status) ? other.reason : entry.reason,
      };
    });
    // Agents the durable rows know about but this process has never seen (a new
    // deploy with an added agent) are carried over rather than dropped.
    for (const entry of stored) {
      if (!merged.some((candidate) => candidate.agentId === entry.agentId)) merged.push(entry);
    }
    registries.set(sessionId, merged);
  } catch {
    // A registry that cannot be loaded is still a registry: the in-process
    // initial state governs this process, conservatively and by name.
  } finally {
    loading.delete(sessionId);
  }
}

/** What the decision path may and may not do with agents right now. */
export function governanceOverlay(sessionId: string): { disabled: AlphaId[]; halved: AlphaId[] } {
  const registry = governanceRegistry(sessionId);
  return { disabled: disabledAgents(registry), halved: halvedAgents(registry) };
}

/** Remember which agents a decision's plan came from — the join for attribution. */
export function rememberPlan(memory: PlanMemory): void {
  plans.set(memory.planId, memory);
  planOrder.push(memory.planId);
  while (planOrder.length > PLAN_LIMIT) {
    const oldest = planOrder.shift();
    if (oldest !== undefined) plans.delete(oldest);
  }
}

/** The plan's decision memory, if this process still has it. */
export function planMemory(planId: string): PlanMemory | null {
  return plans.get(planId) ?? null;
}

/** The plan a filled ticket belongs to (set when the fill is acknowledged). */
export function bindTicket(ticket: number, planId: string): void {
  tickets.set(ticket, planId);
  while (tickets.size > TICKET_LIMIT) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

export function planIdForTicket(ticket: number): string | null {
  return tickets.get(ticket) ?? null;
}

/**
 * v5 UI — the agents that proposed a filled ticket's plan, for the closed-trade
 * table's Agent column.
 *
 * The join already exists (`bindTicket` at fill acknowledgement → the plan's
 * own memory); this only exposes it. Plan memory is capped, so an old ticket
 * legitimately returns null — which renders as an em dash. It must never
 * render as "no agents", because "the memory expired" and "no agent proposed
 * this" are different claims.
 */
export function agentsForTicket(ticket: number): string[] | null {
  const planId = planIdForTicket(ticket);
  if (planId === null) return null;
  const memory = planMemory(planId);
  return memory ? [...memory.agents] : null;
}

/**
 * Apply one realised outcome to the agents that proposed it.
 *
 * Returns the actions taken so the caller can journal them — an agent being
 * disabled is not a silent event.
 */
export async function creditAgents(input: {
  sessionId: string;
  agents: AlphaId[];
  r: number;
  timestampMs: number;
}): Promise<GovernanceAction[]> {
  let registry = governanceRegistry(input.sessionId);
  const actions: GovernanceAction[] = [];
  for (const agentId of input.agents) {
    const outcome: AgentOutcome = { agentId, r: input.r, timestampMs: input.timestampMs };
    const applied = applyGovernanceOutcome(registry, outcome);
    registry = applied.registry;
    if (applied.action.action !== "none") actions.push(applied.action);
  }
  registries.set(input.sessionId, registry);
  await saveGovernanceState(input.sessionId, registry);
  return actions;
}

/** Persist a decision to the shadow ledger. Never throws. */
export async function recordShadowDecision(row: ShadowEvaluationRow): Promise<void> {
  await recordShadowEvaluation(row);
}

/**
 * The full close-of-trade loop.
 *
 * `net` is the broker's profit for the position including swap and commission.
 * `riskMoney` is the EA's own stamp of the risk at fill — without it there is no
 * R, and the trade is recorded with a NULL `realised_r` rather than a
 * fabricated zero. The shadow evaluation is resolved, the agents are charged,
 * and the trade row carries everything the weekly report needs.
 */
export async function recordClosedTrade(input: {
  sessionId: string;
  ticket: number;
  symbol: string;
  mode: TradeMode;
  side: string;
  lots: number;
  openedAtMs: number;
  closedAtMs: number;
  netProfit: number;
  riskMoney: number | null;
  slippageR: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  exitReason: string | null;
}): Promise<{ actions: GovernanceAction[]; realisedR: number | null; agents: AlphaId[] }> {
  const planId = planIdForTicket(input.ticket);
  const memory = planId ? planMemory(planId) : null;
  const agents: AlphaId[] = memory ? memory.agents : [];
  const realisedR =
    input.riskMoney !== null && input.riskMoney > 0 ? input.netProfit / input.riskMoney : null;

  await recordTrade({
    sessionId: input.sessionId,
    ticket: input.ticket,
    planId,
    symbol: input.symbol,
    mode: input.mode,
    side: input.side,
    openedAtMs: input.openedAtMs,
    closedAtMs: input.closedAtMs,
    lots: input.lots,
    riskMoney: input.riskMoney,
    netProfit: input.netProfit,
    realisedR,
    predictedProbability: memory ? memory.predictedProbability : null,
    slippageR: input.slippageR,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    exitReason: input.exitReason,
    agents,
    payload: memory ? { armedAtMs: memory.armedAtMs, direction: memory.direction } : null,
  });

  let actions: GovernanceAction[] = [];
  if (realisedR !== null && agents.length > 0) {
    actions = await creditAgents({
      sessionId: input.sessionId,
      agents,
      r: realisedR,
      timestampMs: input.closedAtMs,
    });
  }
  if (planId && realisedR !== null) {
    await resolveShadowEvaluation({
      sessionId: input.sessionId,
      planId,
      outcomeR: realisedR,
      resolvedAtMs: input.closedAtMs,
    });
  }
  return { actions, realisedR, agents };
}

/**
 * The weekly report for a session, straight off the durable rows.
 *
 * Reads through the store (which prefers the database), so the report is the
 * same document after a restart as it was before one — which is the only reason
 * to have written the rows down.
 */
export async function buildWeeklyReport(input: {
  sessionId: string;
  nowMs: number;
  weekStartMs?: number;
}): Promise<WeeklyReport> {
  const window = input.weekStartMs === undefined
    ? weekWindow(input.nowMs)
    : { weekStartMs: input.weekStartMs, weekEndMs: input.weekStartMs + 7 * 86_400_000 };
  const [trades, shadow] = await Promise.all([
    listTrades({ sessionId: input.sessionId, limit: 1000 }),
    listShadowEvaluations({ sessionId: input.sessionId, limit: 1000 }),
  ]);
  const registry = governanceRegistry(input.sessionId);
  return weeklyReport({
    weekStartMs: window.weekStartMs,
    weekEndMs: window.weekEndMs,
    generatedAtMs: input.nowMs,
    trades: trades.map((row: TradeRow) => ({
      symbol: row.symbol,
      mode: row.mode,
      side: row.side,
      closedAtMs: row.closedAtMs,
      realisedR: row.realisedR,
      netProfit: row.netProfit,
      predictedProbability: row.predictedProbability,
      slippageR: row.slippageR,
    })),
    evaluations: shadow.map((row) => ({
      symbol: row.symbol,
      mode: row.mode,
      evaluatedAtMs: row.evaluatedAtMs,
      armed: row.armed,
      refusals: row.refusals,
      gateCodes: row.gateCodes,
    })),
    registry,
  });
}

// ── Fitted artifacts (WP5 calibrators, WP3 HMM parameters) ───────────────────

/** Artifact kinds this desk stores. */
export const ARTIFACT_REGIME_HMM = "regime-hmm";
export const ARTIFACT_META_CALIBRATOR = "meta-calibrator";

/**
 * A version string that identifies a fit EXACTLY.
 *
 * The version is the identity of the window a model was fitted on, not the time
 * it was fitted: two desks that fit the same bars produce the same model (the
 * fit is seeded and deterministic), and a window that has moved on produces a
 * different version. That is what makes reusing a stored model equivalent to
 * re-fitting it rather than a bet on it being close enough.
 */
export function regimeModelVersion(input: {
  symbol: string;
  frame: string;
  fitBars: number;
  states: number;
  windowLength: number;
  lastBarOpenMs: number;
}): string {
  return [
    "hmm",
    input.symbol,
    input.frame,
    `fit${input.fitBars}`,
    `k${input.states}`,
    `n${input.windowLength}`,
    `t${input.lastBarOpenMs}`,
  ].join(":");
}

/** Store a fitted HMM for a scope. Fire-and-forget by design. */
export async function persistRegimeModel(input: {
  symbol: string;
  frame: string;
  version: string;
  model: HmmModel;
  samples: number;
  nowMs: number;
}): Promise<void> {
  await saveArtifact({
    kind: ARTIFACT_REGIME_HMM,
    refKey: `${input.symbol}|${input.frame}`,
    version: input.version,
    mode: null,
    symbol: input.symbol,
    samples: input.samples,
    payload: input.model,
    createdAtMs: input.nowMs,
  });
}

/** Load the stored HMM for a scope when its version matches the current window. */
export async function loadRegimeModel(input: {
  symbol: string;
  frame: string;
  version: string;
}): Promise<HmmModel | null> {
  const artifact = await loadArtifact({
    kind: ARTIFACT_REGIME_HMM,
    refKey: `${input.symbol}|${input.frame}`,
  });
  if (!artifact || artifact.version !== input.version) return null;
  const payload = artifact.payload as HmmModel | null;
  if (!payload || !Array.isArray(payload.means) || !Array.isArray(payload.transition)) return null;
  return payload;
}

/**
 * Store the fitted WP5 calibrator for a mode.
 *
 * The payload is the model snapshot the gatekeeper spends, so the version is
 * supplied by whoever fitted it (the harness, or a future online fitter). No
 * caller exists today: the desk refuses with `GK_NO_MODEL` until a model is
 * handed in, and this is the shelf that model will sit on.
 */
export async function persistMetaCalibrator(input: {
  mode: TradeMode;
  version: string;
  samples: number;
  payload: unknown;
  nowMs: number;
}): Promise<void> {
  await saveArtifact({
    kind: ARTIFACT_META_CALIBRATOR,
    refKey: `*|${input.mode}`,
    version: input.version,
    mode: input.mode,
    symbol: null,
    samples: input.samples,
    payload: input.payload,
    createdAtMs: input.nowMs,
  });
}

/** Test-only reset of every in-process cache this module holds. */
export function __resetGovernanceRuntimeForTests(): void {
  registries.clear();
  loading.clear();
  plans.clear();
  planOrder.length = 0;
  tickets.clear();
}

/** Every shipped agent, for tests and the UI that has to render all of them. */
export const GOVERNED_AGENTS: readonly AlphaId[] = ALPHA_IDS;
