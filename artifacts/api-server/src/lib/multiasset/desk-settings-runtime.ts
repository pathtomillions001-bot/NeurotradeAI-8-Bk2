/**
 * Making the owner's settings TRUE for a running desk.
 *
 * `desk-settings.ts` decides what the policy is; `agent.ts` puts it on every
 * plan the desk arms from now on. Neither of those touches a position that is
 * ALREADY OPEN, and that is where the report came from: "we may be 1R in profit
 * and what needs to happen does not happen". A policy that only applies to
 * trades taken after the change is a policy the owner cannot use to fix a trade
 * they are looking at.
 *
 * So this module owns the two ways a policy reaches a live position:
 *
 *   1. **On change** (`adoptSettings`) — the owner presses Save and every open
 *      position is sent a fresh `set_management` command.
 *   2. **On reconcile** (`reconcileManagement`) — called from the terminal's
 *      heartbeat, it re-sends a position's policy when the fingerprint the desk
 *      last sent no longer matches the settings, or when a position has never
 *      been given one at all (an EA-created position, a terminal that restarted
 *      between the fill and the first sync). This is what makes the promise
 *      hold across a restart rather than only at the moment of the click.
 *
 * Nothing here places, closes or sizes anything: it emits policy, and the EA's
 * position manager decides when the policy fires.
 */

import { randomUUID } from "node:crypto";

import type { ManagementPlan, Position, SymbolSpec, TradeMode } from "./types";
import {
  TRADE_MODES_ALL,
  managementFingerprint,
  resolveModePolicy,
  riskPolicyFromSettings,
  type AutoTradeSettings,
} from "./desk-settings";
import { buildManagementPlan } from "./agent";
import type { DeskState } from "./store";

/**
 * The spec `buildManagementPlan` reads when the terminal has not sent one.
 *
 * It is deliberately the most conservative possible volume grid (the tightest
 * step, the smallest minimum) because that is the assumption that lets a ladder
 * through: the EA re-checks every slice against the REAL spec before it closes
 * anything, so a too-permissive desk-side assumption cannot produce an illegal
 * order — it can only fail the way the EA's own volume check fails. The
 * alternative (dropping the ladder) is what left positions with no mechanism to
 * de-risk, which is the defect being fixed.
 */
const UNKNOWN_SPEC: SymbolSpec = {
  symbol: "UNKNOWN",
  assetClass: "forex",
  point: 0.00001,
  digits: 5,
  tickSize: 0.00001,
  tickValue: 1,
  contractSize: 100_000,
  volumeMin: 0.01,
  volumeMax: 100,
  volumeStep: 0.01,
  stopsLevel: 0,
  freezeLevel: 0,
  marginInitial: 0,
  swapLong: 0,
  swapShort: 0,
  commissionPerLot: 0,
  spreadPoints: 0,
};

/** The mode a position belongs to: its plan's mode, else the desk's own. */
export function modeForPosition(desk: DeskState, position: Position): TradeMode {
  const plan = [...desk.plans.values()].find((entry) => entry.symbol === position.symbol);
  return plan ? plan.mode : desk.mode;
}

/**
 * The management block for one position, from the owner's settings.
 *
 * `lots` is the position's CURRENT volume: the ladder is feasibility-checked
 * against what is actually open, not what was opened, so a position that has
 * already taken its first partial is not sent a rung that no longer fits.
 */
export function managementForPosition(
  desk: DeskState,
  position: Position,
  mode: TradeMode = modeForPosition(desk, position),
): ManagementPlan {
  const spec = desk.specs.get(position.symbol) ?? UNKNOWN_SPEC;
  const riskPoints = position.initialRiskPoints ?? 0;
  const atrPoints = riskPoints > 0 ? riskPoints : 0;
  return buildManagementPlan({
    spec,
    mode,
    lots: position.volume > 0 ? position.volume : spec.volumeMin,
    // The regime is not re-derived here on purpose: the plan that opened the
    // position already encoded it, and re-reading a regime at policy time would
    // make two identical settings produce different ladders a minute apart.
    regimeKind: desk.mode === "swing" ? "trend_up" : "range",
    atrPoints,
    retraceProbability: 0.5,
    settings: resolveModePolicy(desk.autoTradeSettings, mode).management,
  });
}

/**
 * Enqueue `set_management` for every open position whose policy is stale.
 *
 * Returns the tickets it sent, so the caller can journal them. A position whose
 * fingerprint already matches is left alone: the heartbeat runs twice a second
 * and a stop modification must never become chatter.
 */
export function reconcileManagement(desk: DeskState, options: { force?: boolean } = {}): number[] {
  if (!desk.terminal || desk.positions.length === 0) return [];
  const applied = (desk.managementSent ??= new Map<string, string>());
  const sent: number[] = [];

  for (const position of desk.positions) {
    const mode = modeForPosition(desk, position);
    const fingerprint = managementFingerprint(desk.autoTradeSettings, mode);
    const key = String(position.ticket);
    if (!options.force && applied.get(key) === fingerprint) continue;

    desk.outbox.push({
      id: randomUUID(),
      type: "set_management",
      ticket: position.ticket,
      management: managementForPosition(desk, position, mode),
    });
    applied.set(key, fingerprint);
    sent.push(position.ticket);
  }

  // Forget tickets that are no longer open, so the map cannot grow without
  // bound and a re-used ticket number is never mistaken for a managed one.
  const live = new Set(desk.positions.map((position) => String(position.ticket)));
  for (const key of [...applied.keys()]) if (!live.has(key)) applied.delete(key);

  return sent;
}

/**
 * Adopt a settings patch: the policy, the derived risk gates, and a re-push to
 * every open position.
 *
 * The order matters. The desk's own risk gates (`desk.policy`) are derived from
 * the SAME value the plans carry, so a "risk 0.25%" setting cannot be honoured
 * for sizing while the daily-loss budget still uses the old ceiling — the exact
 * way a settings screen ends up lying about what it controls.
 */
export function adoptSettings(
  desk: DeskState,
  settings: AutoTradeSettings,
): { pushed: number[]; riskPolicyChanged: boolean } {
  const before = JSON.stringify(desk.policy);
  desk.autoTradeSettings = settings;
  desk.policy = { ...desk.policy, ...riskPolicyFromSettings(settings) };
  const pushed = reconcileManagement(desk, { force: true });
  return { pushed, riskPolicyChanged: before !== JSON.stringify(desk.policy) };
}

/** The fingerprints currently in force — the diagnostics view of the above. */
export function currentFingerprints(desk: DeskState): Record<TradeMode, string> {
  const out = {} as Record<TradeMode, string>;
  for (const mode of TRADE_MODES_ALL) out[mode] = managementFingerprint(desk.autoTradeSettings, mode);
  return out;
}
