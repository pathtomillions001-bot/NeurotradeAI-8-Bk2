/**
 * Multi-Asset Desk v4 — the single configuration module.
 *
 * EVERY behavioural change in the v4 work is behind a flag defined here, and
 * every flag defaults to OFF (or, where a subsystem is only observable anyway,
 * to shadow). Nothing in this file changes live behaviour on its own: with the
 * environment untouched, the Desk behaves exactly as it did before v4.
 *
 * ── WHY A SINGLE MODULE ─────────────────────────────────────────────────────
 *
 * The v4 programme touches the agent, the Monte Carlo, the risk governor, the
 * execution path and the EA at once. Reading flags from `process.env` at the
 * point of use makes it impossible to answer "what is switched on right now?"
 * and makes tests order-dependent. This module is the ONE place the flags are
 * parsed; everything else asks it.
 *
 * ── SHADOW IS THE DEFAULT, NOT OFF ──────────────────────────────────────────
 *
 * `shadow` is not "disabled". In shadow mode the whole v4 pipeline runs —
 * features, regime posterior, calibration, gatekeeper, journal — and the
 * decision that WOULD have been taken is recorded, but no order is armed from
 * it. That is what makes Phase 1 of the rollout measurable (see
 * docs/mt5-live-desk-v4.md): the desk collects an out-of-sample record of its
 * own would-be decisions without risking a cent.
 *
 * An unknown or unparseable value is treated as the DEFAULT (off/shadow). A
 * typo must never be able to switch a subsystem on.
 */

import type { TradeMode } from "./types";

export interface DeskV4Feature {
  /** The subsystem is on at all. Off ⇒ callers keep the legacy path. */
  enabled: boolean;
  /**
   * Live orders may be produced by this subsystem. `false` (the default for
   * every subsystem) means the subsystem computes and journals, but the plan
   * it would have produced is not armed.
   */
  live: boolean;
}

export interface DeskV4AgentFlag extends DeskV4Feature {
  /** Modes this agent may propose in. Empty ⇒ the agent's own default set. */
  modes: TradeMode[];
}

export interface DeskV4Config {
  /** Master switch. Off disables every subsystem below regardless of its own flag. */
  enabled: boolean;
  /** Global shadow switch: when true nothing v4 produces may arm an order. */
  shadow: boolean;
  /** Pure state machine (WP0) executed by the EA for live positions. */
  positionManager: DeskV4Feature;
  /** Hard invariants in agent.ts (WP1): RR_fill ≥ 2, one-SE target, backstop halt. */
  hardInvariants: DeskV4Feature;
  /** 3-state HMM regime agent + Bayesian online change-point detection (WP3). */
  regimeHmm: DeskV4Feature;
  changePoint: DeskV4Feature;
  /** Alpha agents (WP4). Each is independently switchable. */
  agents: {
    trend: DeskV4AgentFlag;
    meanReversion: DeskV4AgentFlag;
    sweep: DeskV4AgentFlag;
    flow: DeskV4AgentFlag;
    crossSection: DeskV4AgentFlag;
  };
  /** Triple-barrier labels + logistic/isotonic calibration (WP5). */
  metaModel: DeskV4Feature;
  /** Edge gatekeeper replacing the final arm decision (WP6). */
  gatekeeper: DeskV4Feature;
  /** GARCH-filtered historical simulation Monte Carlo (WP6). */
  monteCarloV2: DeskV4Feature;
  /** Pending-order execution agent, spread-z and session gates, slippage ledger (WP7). */
  execution: DeskV4Feature;
  /** Portfolio heat / Ledoit-Wolf covariance / Kelly sizing (WP8). */
  portfolio: DeskV4Feature;
  /** Shadow ledger and per-agent e-process governance (WP9). */
  governance: DeskV4Feature;
  /** Extra UI payloads (regime posteriors, gate reasons, management state) (WP10). */
  ui: DeskV4Feature;
  /** Research harness only — never consulted by the live path. */
  research: { paths: number; seed: number };
}

/** Modes an agent is allowed to propose in by default. */
export const DEFAULT_AGENT_MODES: Record<keyof DeskV4Config["agents"], TradeMode[]> = {
  trend: ["intraday", "swing"],
  meanReversion: ["intraday", "scalp"],
  sweep: ["intraday", "scalp"],
  flow: ["scalp"],
  crossSection: ["swing"],
};

type Env = Record<string, string | undefined>;

/** Truthy values, and ONLY these. Everything else ⇒ false. */
const TRUTHY = new Set(["1", "true", "yes", "on", "live", "shadow", "enabled"]);

function envFlag(env: Env, key: string, fallback = false): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Parse a feature flag pair: `<PREFIX>` = enabled, `<PREFIX>_LIVE` = live.
 *
 * `live` can never be true while `enabled` is false — a live switch with the
 * subsystem off reads as a mistake, and the conservative reading of a mistake
 * is "off".
 */
function feature(env: Env, prefix: string, defaultEnabled = false): DeskV4Feature {
  const enabled = envFlag(env, prefix, defaultEnabled);
  return { enabled, live: enabled && envFlag(env, `${prefix}_LIVE`, false) };
}

function agentFlag(
  env: Env,
  prefix: string,
  kind: keyof DeskV4Config["agents"],
): DeskV4AgentFlag {
  const base = feature(env, prefix, false);
  const modes = (env[`${prefix}_MODES`] ?? "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter((m): m is TradeMode => m === "scalp" || m === "intraday" || m === "swing");
  return { ...base, modes: modes.length > 0 ? modes : [...DEFAULT_AGENT_MODES[kind]] };
}

export const V4_ENV_PREFIX = "DESK_V4_";

export function resolveDeskV4Config(env: Env = process.env): DeskV4Config {
  const enabled = envFlag(env, `${V4_ENV_PREFIX}ENABLED`, false);
  const shadow = envFlag(env, `${V4_ENV_PREFIX}SHADOW`, true);

  /**
   * A subsystem is only ever "live" when the master switch is on AND the
   * global shadow switch is off. Both are required, so flipping `SHADOW=false`
   * alone cannot bring anything live on a desk that was never enabled.
   */
  const gate = (f: DeskV4Feature): DeskV4Feature =>
    enabled ? { enabled: f.enabled, live: f.live && !shadow } : { enabled: false, live: false };

  const cfg: DeskV4Config = {
    enabled,
    shadow,
    positionManager: gate(feature(env, `${V4_ENV_PREFIX}POSITION_MANAGER`, true)),
    hardInvariants: gate(feature(env, `${V4_ENV_PREFIX}HARD_INVARIANTS`, false)),
    regimeHmm: gate(feature(env, `${V4_ENV_PREFIX}REGIME_HMM`, false)),
    changePoint: gate(feature(env, `${V4_ENV_PREFIX}CHANGEPOINT`, false)),
    agents: {
      trend: agentFlag(env, `${V4_ENV_PREFIX}AGENT_TREND`, "trend"),
      meanReversion: agentFlag(env, `${V4_ENV_PREFIX}AGENT_MEANREV`, "meanReversion"),
      sweep: agentFlag(env, `${V4_ENV_PREFIX}AGENT_SWEEP`, "sweep"),
      flow: agentFlag(env, `${V4_ENV_PREFIX}AGENT_FLOW`, "flow"),
      crossSection: agentFlag(env, `${V4_ENV_PREFIX}AGENT_CROSSSECTION`, "crossSection"),
    },
    metaModel: gate(feature(env, `${V4_ENV_PREFIX}META_MODEL`, false)),
    gatekeeper: gate(feature(env, `${V4_ENV_PREFIX}GATEKEEPER`, false)),
    monteCarloV2: gate(feature(env, `${V4_ENV_PREFIX}MC_V2`, false)),
    execution: gate(feature(env, `${V4_ENV_PREFIX}EXECUTION`, false)),
    portfolio: gate(feature(env, `${V4_ENV_PREFIX}PORTFOLIO`, false)),
    governance: gate(feature(env, `${V4_ENV_PREFIX}GOVERNANCE`, false)),
    ui: gate(feature(env, `${V4_ENV_PREFIX}UI`, false)),
    research: {
      paths: clampInt(env[`${V4_ENV_PREFIX}RESEARCH_PATHS`], 200, 1_000_000, 4000),
      seed: clampInt(env[`${V4_ENV_PREFIX}RESEARCH_SEED`], 1, 2 ** 31 - 1, 1),
    },
  };

  /**
   * The position manager is the one subsystem that defaults to ENABLED — it is
   * a bug-fix for the lost-management-plan defect (D1), not a new strategy:
   * without it a filled position has no stop management at all. It still
   * requires the master switch, and it still defaults to shadow.
   */
  return cfg;
}

function clampInt(raw: string | undefined, lo: number, hi: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

let cached: DeskV4Config | null = null;

/** The process-wide configuration. Parsed once; env does not change at runtime. */
export function deskV4(): DeskV4Config {
  if (!cached) cached = resolveDeskV4Config();
  return cached;
}

/**
 * Test-only override. Returns a restore function so a test can never leak its
 * configuration into another test file.
 */
export function setDeskV4ForTests(config: DeskV4Config | null): () => void {
  const previous = cached;
  cached = config;
  return () => {
    cached = previous;
  };
}

/** Convenience predicate: is this subsystem enabled (and may it arm orders)? */
export function v4Live(feature: DeskV4Feature): boolean {
  return feature.enabled && feature.live;
}

/** Convenience predicate: is this subsystem computing at all? */
export function v4On(feature: DeskV4Feature): boolean {
  return feature.enabled;
}

/**
 * The full default configuration, for documentation and tests. Exported so a
 * reader can see what "off" means without setting 20 environment variables.
 */
export const DESK_V4_DEFAULTS: DeskV4Config = resolveDeskV4Config({});
