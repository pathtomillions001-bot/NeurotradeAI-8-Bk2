/**
 * The auto-trader's settings — one model, one sanitiser, one resolver.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Until now the whole management policy was compiled into the desk: partial
 * ladders, break-even triggers, trail multiples, the time stop and the pyramid
 * ladder were constants in `agent.ts::buildManagementPlan()`. The owner could
 * change `baseRiskPct` and nothing else. The report was blunt — "the user must
 * be able to adjust how the auto trader takes trades, and every setting must be
 * respected".
 *
 * So the policy moved here, and it is TOTAL: every knob that changes how a
 * trade is taken or managed has a field, a documented range, a default, and a
 * place it is enforced. A knob with no field would be a knob the owner cannot
 * set, which is the defect this module exists to remove.
 *
 * ── THREE RULES ─────────────────────────────────────────────────────────────
 *
 * 1. **Sanitise, never throw.** Anything the browser sends is untrusted: every
 *    number is clamped to its own range, every enum is matched against its
 *    allowed set, unknown keys are dropped. A malformed request can only ever
 *    produce a *tighter* policy, never a wider one.
 *
 * 2. **Presets are mode-specific.** "Aggressive" on a scalp is not "aggressive"
 *    on a swing: an aggressive scalp banks a partial at 0.7R and trails at
 *    1.0R, an aggressive swing gives the trade 2.2R of room because a swing
 *    stop inside the noise is how a swing trade gets scratched. Three modes ×
 *    three styles = nine policies, each written out below.
 *
 * 3. **One home per number.** `buildManagementPlan()` and the EA's default
 *    policy are the only readers; both are driven from `resolveManagement()`.
 *    There is no second copy of "trail at 1.2R" anywhere.
 */

import type { TradeMode, Timeframe, ManagementPlan } from "./types";
import { ENTRY_TIMEFRAME } from "./desk-constants";

/** The trader's stance for one mode. `custom` = a preset that was then edited. */
export type ModeStyle = "conservative" | "balanced" | "aggressive" | "custom";

export const MODE_STYLES: Exclude<ModeStyle, "custom">[] = ["conservative", "balanced", "aggressive"];

export const TRADE_MODES_ALL: TradeMode[] = ["scalp", "intraday", "swing"];

/** How the per-trade budget is expressed. */
export type SizingMode = "percent" | "fixed_money";

// ── The management policy ───────────────────────────────────────────────────

export interface BreakevenSettings {
  enabled: boolean;
  /** R progress that arms the stop move. */
  triggerR: number;
  /** How far beyond entry+round-trip the stop lands, in R. */
  offsetR: number;
  /**
   * Require a confirmed structure shift before moving (the v4 rule).
   *
   * `true` is the higher-quality reading; `false` moves on the R trigger alone.
   * Neither may ever mean "never": see `structureFallbackR` — which is the fix
   * for the reported "1R in profit and the stop did not move".
   */
  requireStructure: boolean;
  /**
   * R beyond `triggerR` after which a structurally unconfirmed stop moves
   * anyway. `0` disables the fallback (structure confirmation is then
   * mandatory and the stop waits for it).
   */
  structureFallbackR: number;
}

export interface PartialRung {
  atR: number;
  closePct: number;
}

export interface PartialSettings {
  enabled: boolean;
  /** Up to four rungs, ascending by `atR`. */
  rungs: PartialRung[];
}

export type TrailMode = "atr_chandelier" | "structure" | "fixed_points";

export interface TrailSettings {
  enabled: boolean;
  mode: TrailMode;
  /** ATR period, on the entry timeframe. */
  period: number;
  /** ATR multiple behind the extreme (chandelier). */
  mult: number;
  /** R progress at which the trail starts moving the stop. */
  activateAtR: number;
  /** Absolute minimum step, in points. */
  stepPoints: number;
  /**
   * Minimum meaningful step as a fraction of an ATR. A trail that moves by less
   * than this is noise and is skipped, which is what stops the stop from being
   * modified on every tick.
   */
  minStepAtr: number;
}

export interface PyramidSettings {
  enabled: boolean;
  maxAdds: number;
  addAtR: number;
  sizeRatio: number;
  requireBaseAtBreakeven: boolean;
  portfolioRiskCapR: number;
}

export interface TimeStopSettings {
  enabled: boolean;
  /** Closed bars on `timeframe` with no progress before the trade is cut. */
  noProgressBars: number;
  timeframe: Timeframe | null;
}

export interface GuardSettings {
  /** Maximum spread at fill, in points. `null` = derive from the asset's cost. */
  maxSpreadPoints: number | null;
  /** Minutes either side of a red-folder release during which entries pause. */
  newsBlackoutMin: number;
  /** Flatten before the session close (scalp/intraday; never swing by default). */
  flatBeforeSessionClose: boolean;
}

export interface ManagementSettings {
  breakeven: BreakevenSettings;
  partials: PartialSettings;
  trail: TrailSettings;
  pyramid: PyramidSettings;
  timeStop: TimeStopSettings;
  guards: GuardSettings;
}

// ── Risk ────────────────────────────────────────────────────────────────────

export interface RiskSettings {
  sizingMode: SizingMode;
  /** Percent of equity risked per trade when `sizingMode = "percent"`. */
  riskPerTradePct: number;
  /** Currency risked per trade when `sizingMode = "fixed_money"`. */
  riskPerTradeMoney: number;
  maxRiskPct: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxOpenPositions: number;
  maxPositionsPerSymbol: number;
  maxCurrencyExposurePct: number;
  haltAfterConsecutiveLosses: number;
  minMarginLevelPct: number;
  symbolCooldownMs: number;
  liveTradingEnabled: boolean;
}

export interface ModeSettings {
  style: ModeStyle;
  /** Per-trade budget for THIS mode, overriding `risk.riskPerTradePct`. */
  riskPerTradePct: number;
  management: ManagementSettings;
}

export interface AutoTradeSettings {
  /**
   * Schema version. Bumped when a field's *meaning* changes; the client uses it
   * to refuse to render a settings shape it does not understand.
   */
  version: number;
  risk: RiskSettings;
  perMode: Record<TradeMode, ModeSettings>;
  /** ms epoch of the last accepted change, for the audit trail. */
  updatedAt: number;
}

export const AUTO_TRADE_SETTINGS_VERSION = 1;

// ── Ranges: the single source of truth for clamping ─────────────────────────

export const RANGES = {
  riskPerTradePct: [0.05, 2] as const,
  riskPerTradeMoney: [1, 1_000_000] as const,
  maxRiskPct: [0.1, 5] as const,
  maxDailyLossPct: [0.5, 10] as const,
  maxDrawdownPct: [1, 30] as const,
  maxOpenPositions: [1, 50] as const,
  maxPositionsPerSymbol: [1, 10] as const,
  maxCurrencyExposurePct: [0.5, 20] as const,
  haltAfterConsecutiveLosses: [2, 20] as const,
  minMarginLevelPct: [150, 5000] as const,
  symbolCooldownMs: [60_000, 24 * 3600_000] as const,
  triggerR: [0.2, 10] as const,
  offsetR: [0, 2] as const,
  structureFallbackR: [0, 2] as const,
  partialAtR: [0.2, 10] as const,
  partialClosePct: [5, 100] as const,
  trailPeriod: [2, 200] as const,
  trailMult: [0.5, 10] as const,
  trailActivateR: [0.2, 10] as const,
  trailStepPoints: [0, 5000] as const,
  trailMinStepAtr: [0, 1] as const,
  pyramidMaxAdds: [0, 5] as const,
  pyramidAddAtR: [0.5, 10] as const,
  pyramidSizeRatio: [0.1, 2] as const,
  pyramidRiskCapR: [0.1, 10] as const,
  timeStopBars: [1, 500] as const,
  newsBlackoutMin: [0, 240] as const,
  maxSpreadPoints: [1, 100_000] as const,
} as const;

const TIME_STOP_FRAMES: Timeframe[] = ["M1", "M2", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * One policy per mode and stance.
 *
 * The numbers are not decoration; each one is a statement about how that style
 * behaves, and they differ per mode on purpose:
 *
 *   scalp    — small R, short horizon: de-risk early (a scalp that gives back
 *              1R is a scalp that failed), trail tight, time stop short.
 *   intraday — the middle: the first rung at 1R, structure-confirmed BE, a
 *              chandelier at 1.2R.
 *   swing    — large R, long horizon: do not touch the stop inside the noise;
 *              bank a partial late, trail wide, no time stop on the default
 *              policy (a swing trade is allowed to take days).
 */
export const MANAGEMENT_PRESETS: Record<TradeMode, Record<Exclude<ModeStyle, "custom">, ManagementSettings>> = {
  scalp: {
    conservative: {
      breakeven: { enabled: true, triggerR: 0.8, offsetR: 0.1, requireStructure: false, structureFallbackR: 0.2 },
      partials: { enabled: true, rungs: [{ atR: 0.8, closePct: 50 }, { atR: 1.5, closePct: 25 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 14, mult: 1.6, activateAtR: 0.9, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: false, maxAdds: 0, addAtR: 1.5, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1 },
      timeStop: { enabled: true, noProgressBars: 10, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 10, flatBeforeSessionClose: true },
    },
    balanced: {
      breakeven: { enabled: true, triggerR: 1.0, offsetR: 0.15, requireStructure: false, structureFallbackR: 0.35 },
      partials: { enabled: true, rungs: [{ atR: 1.0, closePct: 50 }, { atR: 1.8, closePct: 25 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 14, mult: 2.0, activateAtR: 1.2, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: false, maxAdds: 0, addAtR: 1.8, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1 },
      timeStop: { enabled: true, noProgressBars: 15, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 10, flatBeforeSessionClose: true },
    },
    aggressive: {
      breakeven: { enabled: true, triggerR: 0.6, offsetR: 0.05, requireStructure: false, structureFallbackR: 0.2 },
      partials: { enabled: true, rungs: [{ atR: 0.7, closePct: 40 }, { atR: 1.4, closePct: 30 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 10, mult: 1.4, activateAtR: 0.8, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: true, maxAdds: 1, addAtR: 1.2, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1.5 },
      timeStop: { enabled: true, noProgressBars: 8, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 10, flatBeforeSessionClose: true },
    },
  },
  intraday: {
    conservative: {
      breakeven: { enabled: true, triggerR: 1.2, offsetR: 0.15, requireStructure: true, structureFallbackR: 0.3 },
      partials: { enabled: true, rungs: [{ atR: 1.2, closePct: 50 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 14, mult: 2.2, activateAtR: 1.4, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: false, maxAdds: 0, addAtR: 2.0, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1 },
      timeStop: { enabled: true, noProgressBars: 25, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    },
    balanced: {
      breakeven: { enabled: true, triggerR: 1.0, offsetR: 0.2, requireStructure: true, structureFallbackR: 0.35 },
      partials: { enabled: true, rungs: [{ atR: 1.0, closePct: 50 }, { atR: 2.0, closePct: 25 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: true, maxAdds: 1, addAtR: 1.5, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1.5 },
      timeStop: { enabled: true, noProgressBars: 25, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    },
    aggressive: {
      breakeven: { enabled: true, triggerR: 0.8, offsetR: 0.1, requireStructure: false, structureFallbackR: 0.25 },
      partials: { enabled: true, rungs: [{ atR: 0.8, closePct: 35 }, { atR: 1.6, closePct: 30 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 10, mult: 1.8, activateAtR: 0.9, stepPoints: 0, minStepAtr: 0.1 },
      pyramid: { enabled: true, maxAdds: 2, addAtR: 1.2, sizeRatio: 0.6, requireBaseAtBreakeven: true, portfolioRiskCapR: 2 },
      timeStop: { enabled: true, noProgressBars: 20, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    },
  },
  swing: {
    conservative: {
      breakeven: { enabled: true, triggerR: 2.0, offsetR: 0.3, requireStructure: true, structureFallbackR: 0.5 },
      partials: { enabled: true, rungs: [{ atR: 2.0, closePct: 33 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 20, mult: 3.5, activateAtR: 2.2, stepPoints: 0, minStepAtr: 0.15 },
      pyramid: { enabled: false, maxAdds: 0, addAtR: 3.0, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1 },
      timeStop: { enabled: false, noProgressBars: 60, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 30, flatBeforeSessionClose: false },
    },
    balanced: {
      breakeven: { enabled: true, triggerR: 1.5, offsetR: 0.25, requireStructure: true, structureFallbackR: 0.5 },
      partials: { enabled: true, rungs: [{ atR: 1.5, closePct: 35 }, { atR: 3.0, closePct: 25 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 14, mult: 3.0, activateAtR: 1.8, stepPoints: 0, minStepAtr: 0.15 },
      pyramid: { enabled: true, maxAdds: 2, addAtR: 1.5, sizeRatio: 0.5, requireBaseAtBreakeven: true, portfolioRiskCapR: 1.5 },
      timeStop: { enabled: false, noProgressBars: 48, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 30, flatBeforeSessionClose: false },
    },
    aggressive: {
      breakeven: { enabled: true, triggerR: 1.2, offsetR: 0.2, requireStructure: false, structureFallbackR: 0.4 },
      partials: { enabled: true, rungs: [{ atR: 1.2, closePct: 30 }, { atR: 2.4, closePct: 30 }] },
      trail: { enabled: true, mode: "atr_chandelier", period: 10, mult: 2.4, activateAtR: 1.4, stepPoints: 0, minStepAtr: 0.15 },
      pyramid: { enabled: true, maxAdds: 3, addAtR: 1.2, sizeRatio: 0.6, requireBaseAtBreakeven: true, portfolioRiskCapR: 2 },
      timeStop: { enabled: false, noProgressBars: 36, timeframe: null },
      guards: { maxSpreadPoints: null, newsBlackoutMin: 30, flatBeforeSessionClose: false },
    },
  },
};

/** The per-mode risk budget the presets inherit when the owner has not set one. */
export const PRESET_RISK_PCT: Record<TradeMode, number> = { scalp: 0.25, intraday: 0.5, swing: 0.5 };

export const PRESET_LABELS: Record<Exclude<ModeStyle, "custom">, { label: string; blurb: string }> = {
  conservative: { label: "Conservative", blurb: "De-risks late and keeps the widest room — fewest stop-outs, smallest winners." },
  balanced: { label: "Balanced", blurb: "The factory policy: bank a partial at 1R, confirm structure before break-even, trail behind the extreme." },
  aggressive: { label: "Aggressive", blurb: "De-risks early, trails tightly, allows pyramid adds — most trades reach break-even, more get scratched." },
};

export function presetFor(mode: TradeMode, style: Exclude<ModeStyle, "custom">): ManagementSettings {
  return deepClone(MANAGEMENT_PRESETS[mode][style]);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Defaults ────────────────────────────────────────────────────────────────

export function defaultModeSettings(mode: TradeMode): ModeSettings {
  return {
    style: "balanced",
    riskPerTradePct: PRESET_RISK_PCT[mode],
    management: presetFor(mode, "balanced"),
  };
}

export function defaultAutoTradeSettings(now = Date.now()): AutoTradeSettings {
  return {
    version: AUTO_TRADE_SETTINGS_VERSION,
    risk: {
      sizingMode: "percent",
      riskPerTradePct: 0.5,
      riskPerTradeMoney: 100,
      maxRiskPct: 1,
      maxDailyLossPct: 3,
      maxDrawdownPct: 10,
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 2,
      maxCurrencyExposurePct: 3,
      haltAfterConsecutiveLosses: 3,
      minMarginLevelPct: 200,
      symbolCooldownMs: 15 * 60_000,
      liveTradingEnabled: false,
    },
    perMode: {
      scalp: defaultModeSettings("scalp"),
      intraday: defaultModeSettings("intraday"),
      swing: defaultModeSettings("swing"),
    },
    updatedAt: now,
  };
}

// ── Sanitising ──────────────────────────────────────────────────────────────

function clampRange(value: unknown, range: readonly [number, number], fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(range[0], Math.min(range[1], parsed));
}

function clampInt(value: unknown, range: readonly [number, number], fallback: number): number {
  return Math.round(clampRange(value, range, fallback));
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
  }
  return fallback;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sanitiseBreakeven(current: BreakevenSettings, incoming: unknown): BreakevenSettings {
  const raw = obj(incoming);
  return {
    enabled: bool(raw.enabled, current.enabled),
    triggerR: clampRange(raw.triggerR, RANGES.triggerR, current.triggerR),
    offsetR: clampRange(raw.offsetR, RANGES.offsetR, current.offsetR),
    requireStructure: bool(raw.requireStructure, current.requireStructure),
    structureFallbackR: clampRange(raw.structureFallbackR, RANGES.structureFallbackR, current.structureFallbackR),
  };
}

function sanitisePartials(current: PartialSettings, incoming: unknown): PartialSettings {
  const raw = obj(incoming);
  const enabled = bool(raw.enabled, current.enabled);
  if (!Array.isArray(raw.rungs)) return { enabled, rungs: current.rungs.map((r) => ({ ...r })) };

  // ORDER OF OPERATIONS, and it matters: normalise, then sort by R, and only
  // then take the first four. Slicing first (as this used to) dropped whichever
  // rungs happened to arrive last, which is not the same set as "the four
  // earliest" — a ladder pasted in a different order produced a different
  // policy.
  const normalised: PartialRung[] = [];
  for (const entry of raw.rungs) {
    const r = obj(entry);
    const closePct = clampRange(r.closePct, RANGES.partialClosePct, 50);
    if (closePct <= 0) continue;
    normalised.push({ atR: clampRange(r.atR, RANGES.partialAtR, 1), closePct });
  }
  normalised.sort((a, b) => a.atR - b.atR);

  // The ladder may never bank more than the position: rungs past 100% are
  // dropped rather than trimmed, because a "25% at 4R" that would really close
  // 5% is a rule the desk would report and not execute.
  let total = 0;
  const capped: PartialRung[] = [];
  for (const rung of normalised.slice(0, 4)) {
    if (total >= 100) break;
    if (total + rung.closePct > 100) continue;
    capped.push(rung);
    total += rung.closePct;
  }
  return { enabled, rungs: capped };
}

function sanitiseTrail(current: TrailSettings, incoming: unknown): TrailSettings {
  const raw = obj(incoming);
  return {
    enabled: bool(raw.enabled, current.enabled),
    mode: enumValue(raw.mode, ["atr_chandelier", "structure", "fixed_points"] as const, current.mode),
    period: clampInt(raw.period, RANGES.trailPeriod, current.period),
    mult: clampRange(raw.mult, RANGES.trailMult, current.mult),
    activateAtR: clampRange(raw.activateAtR, RANGES.trailActivateR, current.activateAtR),
    stepPoints: clampInt(raw.stepPoints, RANGES.trailStepPoints, current.stepPoints),
    minStepAtr: clampRange(raw.minStepAtr, RANGES.trailMinStepAtr, current.minStepAtr),
  };
}

function sanitisePyramid(current: PyramidSettings, incoming: unknown): PyramidSettings {
  const raw = obj(incoming);
  return {
    enabled: bool(raw.enabled, current.enabled),
    maxAdds: clampInt(raw.maxAdds, RANGES.pyramidMaxAdds, current.maxAdds),
    addAtR: clampRange(raw.addAtR, RANGES.pyramidAddAtR, current.addAtR),
    sizeRatio: clampRange(raw.sizeRatio, RANGES.pyramidSizeRatio, current.sizeRatio),
    requireBaseAtBreakeven: bool(raw.requireBaseAtBreakeven, current.requireBaseAtBreakeven),
    portfolioRiskCapR: clampRange(raw.portfolioRiskCapR, RANGES.pyramidRiskCapR, current.portfolioRiskCapR),
  };
}

function sanitiseTimeStop(current: TimeStopSettings, incoming: unknown, mode: TradeMode): TimeStopSettings {
  const raw = obj(incoming);
  /**
   * `null` is a MEANING, not a missing value: it says "measure the time stop on
   * the mode's own entry frame" (M2 for a scalp, H1 for a swing), which is what
   * the desk's plan does. So the fallback for an unknown frame is whatever was
   * there — including `null` — and never a frame invented from the incoming
   * payload.
   */
  const frame: Timeframe | null =
    raw.timeframe === null || raw.timeframe === undefined || raw.timeframe === ""
      ? current.timeframe
      : TIME_STOP_FRAMES.includes(raw.timeframe as Timeframe)
        ? (raw.timeframe as Timeframe)
        : current.timeframe;
  return {
    enabled: bool(raw.enabled, current.enabled),
    noProgressBars: clampInt(raw.noProgressBars, RANGES.timeStopBars, current.noProgressBars),
    timeframe: frame,
  };
}

function sanitiseGuards(current: GuardSettings, incoming: unknown): GuardSettings {
  const raw = obj(incoming);
  const spread = raw.maxSpreadPoints;
  return {
    maxSpreadPoints:
      spread === null || spread === undefined || spread === ""
        ? current.maxSpreadPoints
        : clampInt(spread, RANGES.maxSpreadPoints, current.maxSpreadPoints ?? 20),
    newsBlackoutMin: clampInt(raw.newsBlackoutMin, RANGES.newsBlackoutMin, current.newsBlackoutMin),
    flatBeforeSessionClose: bool(raw.flatBeforeSessionClose, current.flatBeforeSessionClose),
  };
}

function sanitiseManagement(current: ManagementSettings, incoming: unknown, mode: TradeMode): ManagementSettings {
  const raw = obj(incoming);
  return {
    breakeven: sanitiseBreakeven(current.breakeven, raw.breakeven),
    partials: sanitisePartials(current.partials, raw.partials),
    trail: sanitiseTrail(current.trail, raw.trail),
    pyramid: sanitisePyramid(current.pyramid, raw.pyramid),
    timeStop: sanitiseTimeStop(current.timeStop, raw.timeStop, mode),
    guards: sanitiseGuards(current.guards, raw.guards),
  };
}

export function sanitiseRisk(current: RiskSettings, incoming: unknown): RiskSettings {
  const raw = obj(incoming);
  return {
    sizingMode: enumValue(raw.sizingMode, ["percent", "fixed_money"] as const, current.sizingMode),
    riskPerTradePct: clampRange(raw.riskPerTradePct, RANGES.riskPerTradePct, current.riskPerTradePct),
    riskPerTradeMoney: clampRange(raw.riskPerTradeMoney, RANGES.riskPerTradeMoney, current.riskPerTradeMoney),
    maxRiskPct: clampRange(raw.maxRiskPct, RANGES.maxRiskPct, current.maxRiskPct),
    maxDailyLossPct: clampRange(raw.maxDailyLossPct, RANGES.maxDailyLossPct, current.maxDailyLossPct),
    maxDrawdownPct: clampRange(raw.maxDrawdownPct, RANGES.maxDrawdownPct, current.maxDrawdownPct),
    maxOpenPositions: clampInt(raw.maxOpenPositions, RANGES.maxOpenPositions, current.maxOpenPositions),
    maxPositionsPerSymbol: clampInt(raw.maxPositionsPerSymbol, RANGES.maxPositionsPerSymbol, current.maxPositionsPerSymbol),
    maxCurrencyExposurePct: clampRange(raw.maxCurrencyExposurePct, RANGES.maxCurrencyExposurePct, current.maxCurrencyExposurePct),
    haltAfterConsecutiveLosses: clampInt(raw.haltAfterConsecutiveLosses, RANGES.haltAfterConsecutiveLosses, current.haltAfterConsecutiveLosses),
    minMarginLevelPct: clampInt(raw.minMarginLevelPct, RANGES.minMarginLevelPct, current.minMarginLevelPct),
    symbolCooldownMs: clampInt(raw.symbolCooldownMs, RANGES.symbolCooldownMs, current.symbolCooldownMs),
    liveTradingEnabled: bool(raw.liveTradingEnabled, current.liveTradingEnabled),
  };
}

/**
 * Apply a partial settings patch.
 *
 * `style` is the interesting case: sending a style WITHOUT a management block
 * means "adopt that preset", which is how the preset buttons work. Sending a
 * management block alongside the style means "these are my edits", and the
 * style is then recorded as `custom` unless the patch explicitly says
 * otherwise — a preset label must never describe a policy that was edited away
 * from it.
 */
export function sanitiseAutoTradeSettings(
  current: AutoTradeSettings,
  incoming: unknown,
  now = Date.now(),
): AutoTradeSettings {
  const raw = obj(incoming);
  const next: AutoTradeSettings = {
    version: AUTO_TRADE_SETTINGS_VERSION,
    risk: sanitiseRisk(current.risk, raw.risk),
    perMode: { ...current.perMode },
    updatedAt: now,
  };

  const perModeRaw = obj(raw.perMode);
  for (const mode of TRADE_MODES_ALL) {
    const modeCurrent = current.perMode[mode] ?? defaultModeSettings(mode);
    const modeRaw = obj(perModeRaw[mode]);
    if (Object.keys(modeRaw).length === 0) {
      next.perMode[mode] = modeCurrent;
      continue;
    }

    const requestedStyle = modeRaw.style === undefined
      ? modeCurrent.style
      : enumValue(modeRaw.style, ["conservative", "balanced", "aggressive", "custom"] as const, modeCurrent.style);

    // A preset chosen without edits replaces the mode's policy wholesale; a
    // `custom` style means the caller is sending (or already has) its own.
    let managementBase: ManagementSettings;
    if (requestedStyle !== "custom" && requestedStyle !== modeCurrent.style) {
      managementBase = presetFor(mode, requestedStyle);
    } else {
      managementBase = modeCurrent.management;
    }

    const managementProvided = modeRaw.management !== undefined && modeRaw.management !== null;
    const management = managementProvided
      ? sanitiseManagement(managementBase, modeRaw.management, mode)
      : managementBase;

    const style: ModeStyle = managementProvided && requestedStyle !== "custom" && matchesPreset(mode, requestedStyle, management)
      ? requestedStyle
      : managementProvided
        ? "custom"
        : requestedStyle;

    next.perMode[mode] = {
      style,
      riskPerTradePct: clampRange(modeRaw.riskPerTradePct, RANGES.riskPerTradePct, modeCurrent.riskPerTradePct),
      management,
    };
  }

  return next;
}

/** Does a policy equal a preset, field for field? (Used to keep style honest.) */
export function matchesPreset(mode: TradeMode, style: ModeStyle, settings: ManagementSettings): boolean {
  if (style === "custom") return false;
  return JSON.stringify(settings) === JSON.stringify(MANAGEMENT_PRESETS[mode][style]);
}

/** Set a mode's style to its preset and return the new settings (pure). */
export function applyPreset(current: AutoTradeSettings, mode: TradeMode, style: Exclude<ModeStyle, "custom">, now = Date.now()): AutoTradeSettings {
  return {
    ...current,
    perMode: {
      ...current.perMode,
      [mode]: { ...current.perMode[mode], style, management: presetFor(mode, style) },
    },
    updatedAt: now,
  };
}

// ── Resolution: what the desk actually trades ───────────────────────────────

/**
 * The resolved policy for one mode, in the shape the management layers consume.
 *
 * `management` is a `ManagementPlan` minus the two fields that are derived from
 * the asset and the position (`guards.maxSpreadPoints` when the owner left it
 * `null`, and `trail.stepPoints` defaults). `buildManagementPlan()` fills those
 * from the symbol spec, so the settings never have to know a symbol's tick size.
 */
export interface ResolvedModePolicy {
  mode: TradeMode;
  style: ModeStyle;
  /** Per-trade budget for this mode, already clamped to `risk.maxRiskPct`. */
  riskPct: number;
  management: ManagementSettings;
}

export function resolveModePolicy(settings: AutoTradeSettings, mode: TradeMode): ResolvedModePolicy {
  const entry = settings.perMode[mode] ?? defaultModeSettings(mode);
  return {
    mode,
    style: entry.style,
    riskPct: Math.max(0.05, Math.min(settings.risk.maxRiskPct, entry.riskPerTradePct)),
    management: entry.management,
  };
}

/** The RiskPolicy the rest of the desk already understands, from these settings. */
export function riskPolicyFromSettings(settings: AutoTradeSettings) {
  const risk = settings.risk;
  return {
    baseRiskPct: risk.riskPerTradePct,
    maxRiskPct: risk.maxRiskPct,
    maxDailyLossPct: risk.maxDailyLossPct,
    maxDrawdownPct: risk.maxDrawdownPct,
    maxOpenPositions: risk.maxOpenPositions,
    maxPositionsPerSymbol: risk.maxPositionsPerSymbol,
    maxCurrencyExposurePct: risk.maxCurrencyExposurePct,
    haltAfterConsecutiveLosses: risk.haltAfterConsecutiveLosses,
    minMarginLevelPct: risk.minMarginLevelPct,
    symbolCooldownMs: risk.symbolCooldownMs,
    liveTradingEnabled: risk.liveTradingEnabled,
  };
}

/**
 * A stable fingerprint of everything that changes how an OPEN position must be
 * managed. The desk compares it against what it last sent to the terminal, and
 * re-pushes when it differs — that is the mechanism that makes a settings
 * change apply to positions that are already open.
 */
export function managementFingerprint(settings: AutoTradeSettings, mode: TradeMode): string {
  const policy = resolveModePolicy(settings, mode);
  return JSON.stringify({
    style: policy.style,
    riskPct: Number(policy.riskPct.toFixed(4)),
    m: policy.management,
  });
}

export function settingsFingerprint(settings: AutoTradeSettings): string {
  return TRADE_MODES_ALL.map((mode) => managementFingerprint(settings, mode)).join("|");
}
