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
  /**
   * Alpha agents (WP4). Each is independently switchable.
   *
   * The keys are the SHIPPED agents, one per file in `alpha/`, and they are
   * named exactly as `ALPHA_IDS` names them so that a flag, a report and a
   * journal entry can never disagree about which detector is meant:
   *   trend         → alpha/trend.ts            (A)
   *   meanReversion → alpha/mean-reversion.ts   (B)
   *   sweep         → alpha/liquidity-sweep.ts  (C)
   *   volRegime     → alpha/vol-regime.ts       (D)
   *   seasonality   → alpha/seasonality.ts      (E)
   *
   * Being switchable is not permission: the WP4 study measured which agents may
   * be wired in, per mode (research-reports/2026-10-11-wp4-alpha-*-agent-study.json),
   * and the composition point is the WP6 gatekeeper. All five default OFF.
   */
  agents: {
    trend: DeskV4AgentFlag;
    meanReversion: DeskV4AgentFlag;
    sweep: DeskV4AgentFlag;
    volRegime: DeskV4AgentFlag;
    seasonality: DeskV4AgentFlag;
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
  /** Outbound alerts (WP10). Off by default, and inert without credentials. */
  alerts: DeskV4Feature;
  /**
   * WP10's regime-mismatch vote in the ensemble: an agent proposing against the
   * desk's own directional regime reading counts half in the blend.
   *
   * Off by default, and it must stay off until the meta study and the gatekeeper
   * study have both been re-run with it on (§12.6): the blend is the model's
   * `meanAgentProbability` feature and the weighted sums set `netDirection`, so
   * arming this moves `p_LCB` and which plans clear the EV floor. Both studies
   * have now been run at 0.5: the gatekeeper passes, and WP5's intraday
   * calibration gate FAILS (home slope 0.7908 vs 0.80) — so the flag stays off.
   */
  ensembleRegimeWeight: DeskV4Feature;
  /** Research harness only — never consulted by the live path. */
  research: { paths: number; seed: number };
}

/** Modes an agent is allowed to propose in by default. */
/**
 * The modes each agent may propose in **by default**, and it is not a guess: the
 * list is the WP4 study's measured allowlist per mode
 * (`research-reports/2026-10-11-wp4-alpha-*-agent-study.json`, §6 of
 * docs/mt5-live-desk-v4.md).
 *
 *   intraday allowlist: liquidity-sweep, seasonality
 *   swing allowlist:    (none — the swing study's verdict is FAIL)
 *
 * An agent that failed its gates in BOTH modes gets an EMPTY list, so it cannot
 * propose anywhere until an operator sets `DESK_V4_AGENT_*_MODES` explicitly —
 * a deliberate two-step, because the one thing this layer must not do is quietly
 * come back to life. Note what emptiness does NOT mean: `trend` and
 * `meanReversion` both measure a *positive* edge in one or both modes and are
 * still not allowed, because they fail the selectivity bar or the Brier gate
 * (§6.6). The lists encode the whole verdict, not the sign of one number.
 */
export const DEFAULT_AGENT_MODES: Record<keyof DeskV4Config["agents"], TradeMode[]> = {
  // −8.2 / −7.4 points against a matched random entry: worse than entering at
  // random in its own fixture, in both modes.
  trend: [],
  // +5.9 points in both modes, but it fires on 13.1% of driftless decisions
  // against the 3% bar (§6.5) — a measured edge in the wrong place.
  meanReversion: [],
  sweep: ["intraday"],
  // No edge on its GARCH fixture in either mode (+/−4.5 points at n ≈ 545).
  volRegime: [],
  // An intraday-scale effect: on swing the hour drift averages out inside the
  // holding window (measured: −0.8 points against +43.7 intraday).
  seasonality: ["intraday"],
};

/**
 * The shipped agent ids (WP4's `AlphaId`) mapped onto their configuration keys.
 *
 * The two namespaces have to disagree somewhere: the registry calls the family
 * "liquidity-sweep" because that is what it detects, and the config calls the flag
 * `AGENT_SWEEP` because that is what an operator types. One table, in one place,
 * so a study that asks "which agents may propose in swing?" cannot answer with a
 * different list than the desk that is executing.
 */
export const ALPHA_ID_TO_AGENT_KEY = {
  trend: "trend",
  "mean-reversion": "meanReversion",
  "liquidity-sweep": "sweep",
  "vol-regime": "volRegime",
  seasonality: "seasonality",
} as const satisfies Record<string, keyof DeskV4Config["agents"]>;

/**
 * The agent ids the DEFAULT (measured) allowlist permits in a mode.
 *
 * Empty for a mode where the WP4 study allowed nothing — swing, as measured.
 * This is the reference policy the WP5 study compares the fitted meta policy
 * against, and in WP6 it is what the desk falls back to when the meta model is
 * off.
 */
export function defaultAllowlistForMode(mode: TradeMode): string[] {
  return (Object.keys(ALPHA_ID_TO_AGENT_KEY) as (keyof typeof ALPHA_ID_TO_AGENT_KEY)[]).filter((id) =>
    (DEFAULT_AGENT_MODES[ALPHA_ID_TO_AGENT_KEY[id]] ?? []).includes(mode),
  );
}

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
      volRegime: agentFlag(env, `${V4_ENV_PREFIX}AGENT_VOLREGIME`, "volRegime"),
      seasonality: agentFlag(env, `${V4_ENV_PREFIX}AGENT_SEASONALITY`, "seasonality"),
    },
    metaModel: gate(feature(env, `${V4_ENV_PREFIX}META_MODEL`, false)),
    gatekeeper: gate(feature(env, `${V4_ENV_PREFIX}GATEKEEPER`, false)),
    monteCarloV2: gate(feature(env, `${V4_ENV_PREFIX}MC_V2`, false)),
    execution: gate(feature(env, `${V4_ENV_PREFIX}EXECUTION`, false)),
    portfolio: gate(feature(env, `${V4_ENV_PREFIX}PORTFOLIO`, false)),
    governance: gate(feature(env, `${V4_ENV_PREFIX}GOVERNANCE`, false)),
    // WP10's outbound channel. Off unless asked for, and inert without credentials
    // even when on (see alerts.ts): watching a desk is never allowed to be a
    // condition of trading it.
    alerts: gate(feature(env, `${V4_ENV_PREFIX}ALERTS`, false)),
    ensembleRegimeWeight: gate(feature(env, `${V4_ENV_PREFIX}ENSEMBLE_REGIME_WEIGHT`, false)),
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
