/** Wire validation and execution invariants. Pure and deliberately testable. */
import { sameDigitTick, type DigitTick } from "./digit-tape";
import { NEXUS_PROFILES, type NexusActivity } from "./match-nexus-analysis";
import {
  applyRecoveryStakeLimits,
  calculateBotRecoveryStake,
} from "./recovery-math";

export const MATCH_NEXUS_BOT_ID = "match-nexus";
export const MATCH_NEXUS_BOT_NAME = "Match Nexus";
export const NEXUS_PENDING = "[NEXUS_PENDING]";
export const NEXUS_SCAN_TTL_MS = 180_000;
export interface NexusScanInput {
  activity: NexusActivity;
  digit?: number;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  executionMode: "paper" | "live";
}
export interface NexusStartInput {
  scanId: string;
  symbol: string;
  marketMode: "locked" | "switching";
  confirmLive?: boolean;
}
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const money = (x: unknown, min: number) =>
  typeof x === "number" &&
  Number.isFinite(x) &&
  x >= min &&
  x <= 1_000_000 &&
  Math.abs(x * 100 - Math.round(x * 100)) < 1e-7;

export function parseNexusScan(raw: unknown): ParseResult<NexusScanInput> {
  if (!object(raw))
    return { ok: false, error: "A configuration object is required" };
  const allowed = [
    "activity",
    "digit",
    "stake",
    "stopLoss",
    "takeProfit",
    "maxRecoverySteps",
    "executionMode",
  ];
  if (Object.keys(raw).some((k) => !allowed.includes(k)))
    return {
      ok: false,
      error:
        "Unsupported setting: Nexus trades only 1-tick DIGITMATCH contracts",
    };
  if (
    typeof raw.activity !== "string" ||
    !Object.hasOwn(NEXUS_PROFILES, raw.activity)
  )
    return { ok: false, error: "activity must be active, balanced or patient" };
  if (
    raw.digit !== undefined &&
    (typeof raw.digit !== "number" ||
      !Number.isInteger(raw.digit) ||
      raw.digit < 0 ||
      raw.digit > 9)
  )
    return {
      ok: false,
      error: "digit must be an integer 0–9, or omitted for automatic selection",
    };
  if (
    !money(raw.stake, 0.35) ||
    !money(raw.stopLoss, 0.35) ||
    !money(raw.takeProfit, 0.01)
  )
    return {
      ok: false,
      error:
        "Use finite currency amounts with at most two decimal places (stake/stop ≥ 0.35; target > 0)",
    };
  if ((raw.stake as number) > (raw.stopLoss as number))
    return {
      ok: false,
      error: "The base stake cannot exceed the session stop-loss budget",
    };
  if (
    typeof raw.maxRecoverySteps !== "number" ||
    !Number.isInteger(raw.maxRecoverySteps) ||
    raw.maxRecoverySteps < 1 ||
    raw.maxRecoverySteps > 10
  )
    return { ok: false, error: "maxRecoverySteps must be an integer 1–10" };
  if (raw.executionMode !== "paper" && raw.executionMode !== "live")
    return { ok: false, error: "Choose paper or live execution explicitly" };
  return { ok: true, value: raw as unknown as NexusScanInput };
}

export function parseNexusStart(raw: unknown): ParseResult<NexusStartInput> {
  if (!object(raw))
    return { ok: false, error: "A deployment object is required" };
  if (
    Object.keys(raw).some(
      (k) => !["scanId", "symbol", "marketMode", "confirmLive"].includes(k),
    )
  )
    return {
      ok: false,
      error:
        "Deploy uses the server's scanned configuration; client model cards and risk overrides are not accepted",
    };
  if (
    typeof raw.scanId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(raw.scanId) ||
    typeof raw.symbol !== "string" ||
    raw.symbol.length > 40
  )
    return {
      ok: false,
      error: "A valid scanId and scanned symbol are required",
    };
  if (raw.marketMode !== "locked" && raw.marketMode !== "switching")
    return { ok: false, error: "Choose locked or switching AFTER the scan" };
  if (raw.confirmLive !== undefined && typeof raw.confirmLive !== "boolean")
    return { ok: false, error: "confirmLive must be boolean" };
  return { ok: true, value: raw as unknown as NexusStartInput };
}

/** Do not inherit applyRecoveryStakeLimits' legacy zero-balance-as-infinity rule. */
export function nexusStake(input: {
  baseStake: number;
  debt: number;
  payout: number;
  markupPercent: number;
  maxStake: number;
  balance: number;
  remainingStop: number;
}): number {
  if (
    ![
      input.baseStake,
      input.debt,
      input.payout,
      input.markupPercent,
      input.maxStake,
      input.balance,
      input.remainingStop,
    ].every(Number.isFinite)
  )
    throw new Error("Risk inputs must be finite");
  if (
    input.baseStake < 0.35 ||
    input.debt < 0 ||
    input.payout <= 1 ||
    input.maxStake < 0.35 ||
    input.markupPercent < 0
  )
    throw new Error("Invalid Matches risk or payout parameters");
  const cap =
    Math.floor(
      (Math.min(input.maxStake, input.balance, input.remainingStop) + 1e-9) *
        100,
    ) / 100;
  if (cap < 0.35)
    throw new Error(
      "No remaining balance / stop-loss budget for the minimum stake",
    );
  if (input.debt <= 0) {
    if (input.baseStake > cap)
      throw new Error(
        "Base stake exceeds balance, stake cap or remaining stop-loss budget",
      );
    return input.baseStake;
  }
  return applyRecoveryStakeLimits(
    calculateBotRecoveryStake(input.debt, input.payout, input.markupPercent),
    cap,
    cap,
  );
}

/** Checked again by the pooled transport immediately before socket.send(). */
export function assertNexusTick(input: {
  analysed: DigitTick;
  current: DigitTick | null | undefined;
  now: number;
  periodMs: number;
  live: boolean;
  stopped: boolean;
  owns: boolean;
  latencyBudgetMs?: number;
}): void {
  if (input.stopped || !input.owns)
    throw new Error(
      "Entry cancelled: session stopped or execution ownership changed",
    );
  if (!sameDigitTick(input.analysed, input.current))
    throw new Error(
      "Entry cancelled: a new tick or feed generation replaced this prediction",
    );
  if (input.live && input.analysed.source !== "live")
    throw new Error("Simulated data can never authorize a live purchase");
  const receiptAge = input.now - input.analysed.receivedAt;
  const brokerAge = input.now - input.analysed.epoch * 1000;
  const age = input.live ? Math.max(receiptAge, brokerAge) : receiptAge;
  const budget = Math.max(180, input.latencyBudgetMs ?? 250);
  if (
    !Number.isFinite(age) ||
    receiptAge < -100 ||
    (input.live && brokerAge < -500) ||
    age < 0 ||
    age + budget >= input.periodMs
  ) {
    throw new Error(
      "Waiting for a fresh tick: insufficient execution headroom",
    );
  }
}

/** A same-stake trade is NOT evidence of this intent. Reconcile exact IDs only. */
export function isNexusPending(reason: string | null | undefined): boolean {
  return !!reason?.includes(NEXUS_PENDING);
}
