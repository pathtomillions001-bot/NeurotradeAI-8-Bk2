/**
 * Deriv WebSocket Client + Persistent TickManager
 *
 * NEW Architecture (Deriv Developer Platform):
 *  ┌────────────────────────────────────────────────────────────────────┐
 *  │ Surface              │ URL                                         │
 *  │──────────────────────│─────────────────────────────────────────────│
 *  │ Public market data   │ wss://api.derivws.com/trading/v1/options/   │
 *  │ (ticks, symbols,     │   ws/public  (no auth, no app_id)           │
 *  │  proposals)          │                                             │
 *  │──────────────────────│─────────────────────────────────────────────│
 *  │ Authenticated trading│ OTP-issued URL from                         │
 *  │ (buy, portfolio,     │   POST /trading/v1/options/accounts/{id}/otp│
 *  │  profit_table)       │   → wss://…/ws/real?otp=…                  │
 *  └────────────────────────────────────────────────────────────────────┘
 *
 * Auth flow:
 *  1. OAuth2 + PKCE → Bearer access token
 *  2. GET /trading/v1/options/accounts  (Bearer) → accountId, balance
 *  3. POST /trading/v1/options/accounts/{accountId}/otp (Bearer) → OTP WS URL
 *  4. new WebSocket(otpUrl) — NO authorize message needed
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "./logger";
import { RISE_FALL_PAYOUT } from "./payouts";

// ── Deriv API base URLs ───────────────────────────────────────────────────────
export const DERIV_REST_BASE = "https://api.derivws.com";
export const DERIV_AUTH_BASE = "https://auth.deriv.com";

/**
 * Public WebSocket — no authentication, no app_id in URL.
 * Use for: active_symbols, ticks, ticks_history, proposal (pricing).
 */
export const DERIV_PUBLIC_WS_URL =
  "wss://api.derivws.com/trading/v1/options/ws/public";

/**
 * App ID — alphanumeric string from app.deriv.com/apps.
 * Used as the `Deriv-App-ID` HTTP header on REST calls and as `client_id` in OAuth.
 * NOT appended to the WebSocket URL (the new API doesn't use query-param app_id).
 */
export const APP_ID = (process.env["DERIV_APP_ID"] ?? "").trim();
if (!APP_ID) {
  logger.warn(
    "DERIV_APP_ID is not set. Register your app at https://app.deriv.com/apps and " +
    "set DERIV_APP_ID to the alphanumeric app ID. Market data (public WS) will still work " +
    "but OAuth-based authenticated trading requires this value.",
  );
}

// ── REST helpers ──────────────────────────────────────────────────────────────

function derivHeaders(bearerToken: string) {
  return {
    "Deriv-App-ID": APP_ID,
    "Authorization": `Bearer ${bearerToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Exchange an OAuth2 authorization code for Bearer + refresh tokens.
 * Must be called from the backend (never the browser).
 */
export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: APP_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await fetch(`${DERIV_AUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OAuth token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * GET /trading/v1/options/accounts — list all trading accounts for the Bearer token.
 */
export async function getDerivAccounts(bearerToken: string): Promise<Array<{
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: string;
  account_type: "demo" | "real";
}>> {
  const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
    headers: derivHeaders(bearerToken),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET /accounts failed: ${res.status} ${text}`);
  }
  const data = await res.json() as any;
  return data.data ?? [];
}

/**
 * POST /trading/v1/options/accounts/{accountId}/otp
 * Returns a one-time-password WebSocket URL for authenticated trading.
 * The OTP URL is single-use for establishing the WS connection; the connection
 * itself stays alive for multiple messages.
 */
export async function getOtpWebSocketUrl(
  bearerToken: string,
  accountId: string,
): Promise<string> {
  const res = await fetch(
    `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
    { method: "POST", headers: derivHeaders(bearerToken) },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OTP request failed: ${res.status} ${text}`);
  }
  const data = await res.json() as any;
  const url: string | undefined = data?.data?.url;
  if (!url) throw new Error("OTP response did not contain a WebSocket URL");
  return url;
}

// ── Market definitions (synthetics only) ──────────────────────────────────────
export const DERIV_MARKETS = [
  // Pip sizes verified from live Deriv prices:
  // R_10  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 4865.826]
  // R_25  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 2592.726]
  // 1HZ25V → pip=0.01  (2 d.p.) → pipSize=2   [confirmed: price like 830197.73]
  // R_50/R_75 → pip=0.0001 (4 d.p.) → pipSize=4
  // R_100/1HZ10V/1HZ50V/1HZ75V/1HZ100V → pip=0.01 (2 d.p.) → pipSize=2
  // ALL Jump indices → pip=0.01 (2 d.p.) → pipSize=2
  { symbol: "R_10",    displayName: "Volatility 10 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_25",    displayName: "Volatility 25 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_50",    displayName: "Volatility 50 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_75",    displayName: "Volatility 75 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_100",   displayName: "Volatility 100 Index",      category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ10V",  displayName: "Volatility 10 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ25V",  displayName: "Volatility 25 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ50V",  displayName: "Volatility 50 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ75V",  displayName: "Volatility 75 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "RDBULL",  displayName: "Bull Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "RDBEAR",  displayName: "Bear Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "JD10",    displayName: "Jump 10 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD25",    displayName: "Jump 25 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD50",    displayName: "Jump 50 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD75",    displayName: "Jump 75 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD100",   displayName: "Jump 100 Index",            category: "synthetic", pipSize: 2, digitEnabled: true },
];

export function getMarketInfo(symbol: string) {
  return DERIV_MARKETS.find((m) => m.symbol === symbol);
}

export function extractLastDigit(price: number, pipSize: number): number {
  // e.g. price=1234.567, pipSize=3 → Math.round(1234.567 * 1000) = 1234567 → 1234567 % 10 = 7
  return Math.round(price * Math.pow(10, pipSize)) % 10;
}

// ── Digit distribution analysis ───────────────────────────────────────────────
export interface DigitStats {
  distribution: { digit: number; count: number; pct: number }[];
  overPct: number;
  underPct: number;
  fivePct: number;
  recommendOver: boolean;
  recommendUnder: boolean;
  streakInfo: string;
  hotDigits: number[];
  coldDigits: number[];
  bias: "over" | "under" | "neutral";
  samples: number;
  evenOddStats: EvenOddStats;
}

export function analyzeDigits(digits: number[]): DigitStats {
  const window = digits.slice(-100);
  const recent = digits.slice(-20);

  const counts = Array(10).fill(0);
  for (const d of window) counts[d]++;
  const total = window.length || 1;

  const distribution = counts.map((count, digit) => ({
    digit,
    count,
    pct: Math.round((count / total) * 100),
  }));

  const overCount = counts.slice(6).reduce((s, c) => s + c, 0);
  const underCount = counts.slice(0, 5).reduce((s, c) => s + c, 0);
  const fiveCount = counts[5];

  const overPct = Math.round((overCount / total) * 100);
  const underPct = Math.round((underCount / total) * 100);
  const fivePct = Math.round((fiveCount / total) * 100);

  const recentOverCount = recent.filter((d) => d > 5).length;
  const recentUnderCount = recent.filter((d) => d < 5).length;
  const recentOverPct = recent.length > 0 ? (recentOverCount / recent.length) * 100 : 40;
  const recentUnderPct = recent.length > 0 ? (recentUnderCount / recent.length) * 100 : 50;

  const hotDigits = distribution.filter((d) => d.pct > 12).map((d) => d.digit);
  const coldDigits = distribution.filter((d) => d.pct < 8).map((d) => d.digit);

  let bias: "over" | "under" | "neutral" = "neutral";
  let recommendOver = false;
  let recommendUnder = false;

  if (recentOverPct > 65) {
    bias = "under"; recommendUnder = true;
  } else if (recentUnderPct > 65) {
    bias = "over"; recommendOver = true;
  } else if (overPct > 45) {
    bias = "over"; recommendOver = true;
  } else if (underPct > 55) {
    bias = "under"; recommendUnder = true;
  } else {
    const coldOverDigits = [6, 7, 8, 9].filter((d) => coldDigits.includes(d)).length;
    const coldUnderDigits = [0, 1, 2, 3, 4].filter((d) => coldDigits.includes(d)).length;
    if (coldOverDigits >= 2) { bias = "under"; recommendUnder = true; }
    else if (coldUnderDigits >= 2) { bias = "over"; recommendOver = true; }
  }

  const lastStreak: number[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (lastStreak.length === 0) { lastStreak.push(recent[i]); continue; }
    if ((recent[i] > 5) === (lastStreak[0] > 5) && recent[i] !== 5) lastStreak.push(recent[i]);
    else break;
  }
  const streakType = lastStreak[0] > 5 ? "OVER" : lastStreak[0] < 5 ? "UNDER" : "FIVE";
  const streakInfo = lastStreak.length >= 3
    ? `${streakType} streak: ${lastStreak.length} consecutive`
    : `No significant streak`;

  const evenOddStats = analyzeEvenOdd(digits);
  return { distribution, overPct, underPct, fivePct, recommendOver, recommendUnder, streakInfo, hotDigits, coldDigits, bias, evenOddStats, samples: total };
}

// ── Even/Odd digit distribution analysis ──────────────────────────────────────
export interface EvenOddStats {
  evenPct: number;
  oddPct: number;
  recentEvenPct: number;
  recentOddPct: number;
  recent50EvenPct: number;
  recent50OddPct: number;
  bias: "even" | "odd" | "neutral";
  recommendEven: boolean;
  recommendOdd: boolean;
  streakInfo: string;
  currentStreak: number;
  currentStreakType: "even" | "odd";
  chiSquarePvalue: number;
  chiSquareSignificant: boolean;
  samples100: number;
  samples50: number;
  samples20: number;
  edge: number;
  markovEvenGivenEven?: number;
  markovEvenGivenOdd?: number;
  markovNextEvenProb?: number;
  markovSignal?: "even" | "odd" | "neutral";
  streakReversalSignal?: "even" | "odd" | "neutral";
}

export function analyzeEvenOdd(digits: number[]): EvenOddStats {
  const window100 = digits.slice(-100);
  const window50  = digits.slice(-50);
  const window20  = digits.slice(-20);

  const EVEN = [0, 2, 4, 6, 8];

  function countEven(arr: number[]) { return arr.filter((d) => EVEN.includes(d)).length; }

  const total100 = window100.length || 1;
  const total50  = window50.length  || 1;
  const total20  = window20.length  || 1;

  const even100 = countEven(window100);
  const even50  = countEven(window50);
  const even20  = countEven(window20);

  const evenPct        = (even100 / total100) * 100;
  const oddPct         = 100 - evenPct;
  const recent50EvenPct = (even50 / total50) * 100;
  const recent50OddPct  = 100 - recent50EvenPct;
  const recentEvenPct  = (even20 / total20) * 100;
  const recentOddPct   = 100 - recentEvenPct;

  const expected100 = total100 / 2;
  const chi2 = ((even100 - expected100) ** 2 / expected100) + (((total100 - even100) - expected100) ** 2 / expected100);
  const chiSquarePvalue = chi2 > 6.635 ? 0.01 : chi2 > 3.841 ? 0.05 : chi2 > 2.706 ? 0.10 : 0.50;
  const chiSquareSignificant = chi2 > 3.841;

  let currentStreak = 0;
  let currentStreakType: "even" | "odd" = EVEN.includes(digits[digits.length - 1] ?? 0) ? "even" : "odd";
  for (let i = digits.length - 1; i >= 0; i--) {
    const isEven = EVEN.includes(digits[i]);
    if ((currentStreakType === "even") === isEven) currentStreak++;
    else break;
  }

  let eeCount = 0, eoCount = 0, oeCount = 0, ooCount = 0;
  for (let i = 1; i < window100.length; i++) {
    const prevEven = EVEN.includes(window100[i - 1]);
    const currEven = EVEN.includes(window100[i]);
    if (prevEven && currEven)   eeCount++;
    else if (prevEven)          eoCount++;
    else if (currEven)          oeCount++;
    else                        ooCount++;
  }
  const pEvenGivenEven = eeCount + eoCount > 0 ? eeCount / (eeCount + eoCount) : 0.5;
  const pEvenGivenOdd  = oeCount + ooCount > 0 ? oeCount / (oeCount + ooCount) : 0.5;

  const lastIsEven = EVEN.includes(digits[digits.length - 1] ?? 0);
  const markovEvenProb = lastIsEven ? pEvenGivenEven : pEvenGivenOdd;
  const markovSignal = markovEvenProb > 0.55 ? "even" : markovEvenProb < 0.45 ? "odd" : "neutral";

  let bias: "even" | "odd" | "neutral" = "neutral";
  let recommendEven = false;
  let recommendOdd = false;

  const streakReversalSignal: "even" | "odd" | "neutral" =
    currentStreak >= 5
      ? (currentStreakType === "even" ? "odd" : "even")
      : currentStreak >= 3
        ? (currentStreakType === "even" ? "odd" : "even")
        : "neutral";

  const markovBias: "even" | "odd" | "neutral" =
    markovEvenProb > 0.52 ? "even" : markovEvenProb < 0.48 ? "odd" : "neutral";

  const chiSignal: "even" | "odd" | "neutral" = chiSquareSignificant
    ? (evenPct > 50 ? "even" : "odd")
    : "neutral";

  const recentReversalSignal: "even" | "odd" | "neutral" =
    recentEvenPct > 60 ? "odd" :
    recentOddPct  > 60 ? "even" :
    "neutral";

  const mid50Signal: "even" | "odd" | "neutral" =
    recent50EvenPct > 57 ? "odd" :
    recent50OddPct  > 57 ? "even" :
    "neutral";

  const allSignals = [streakReversalSignal, markovBias, chiSignal, recentReversalSignal, mid50Signal];
  const evenVotes = allSignals.filter((s) => s === "even").length;
  const oddVotes  = allSignals.filter((s) => s === "odd").length;

  const strongEven = currentStreak >= 5 && currentStreakType === "odd"
    || markovEvenProb > 0.58
    || (recentEvenPct > 65 && mid50Signal === "odd");
  const strongOdd  = currentStreak >= 5 && currentStreakType === "even"
    || markovEvenProb < 0.42
    || (recentOddPct > 65 && mid50Signal === "even");

  if ((evenVotes >= 2 || strongEven) && evenVotes >= oddVotes) {
    bias = "even"; recommendEven = true;
  } else if ((oddVotes >= 2 || strongOdd) && oddVotes >= evenVotes) {
    bias = "odd"; recommendOdd = true;
  }

  const markovEdge = Math.abs(markovEvenProb - 0.5) * 100;
  const streakEdge = currentStreak >= 4 ? Math.min(20, currentStreak * 3) : 0;
  const edge = Math.max(markovEdge, streakEdge, Math.abs(recentEvenPct - 50));

  const streakInfo = currentStreak >= 4
    ? `${currentStreak}× ${currentStreakType.toUpperCase()} streak → reversal likely`
    : currentStreak >= 2
    ? `${currentStreak}× ${currentStreakType.toUpperCase()} run`
    : "No streak detected";

  return {
    evenPct, oddPct,
    recentEvenPct, recentOddPct,
    recent50EvenPct, recent50OddPct,
    bias, recommendEven, recommendOdd,
    streakInfo, currentStreak, currentStreakType,
    chiSquarePvalue, chiSquareSignificant,
    samples100: total100, samples50: total50, samples20: total20,
    edge,
    markovEvenGivenEven: pEvenGivenEven,
    markovEvenGivenOdd:  pEvenGivenOdd,
    markovNextEvenProb:  markovEvenProb,
    markovSignal,
    streakReversalSignal,
  } as EvenOddStats & Record<string, unknown>;
}

// ── Trend / Rise-Fall analysis ────────────────────────────────────────────────
export interface TrendStats {
  risePct: number;
  fallPct: number;
  flatPct: number;
  strength: number;
  bias: "rise" | "fall" | "neutral";
  recommendRise: boolean;
  recommendFall: boolean;
  recentRisePct: number;
  recentFallPct: number;
  streakInfo: string;
  hotStreak: number;
  hotDirection: "rise" | "fall" | "none";
}

export function analyzeTrend(prices: number[]) {
  if (prices.length < 5) {
    return { direction: "up", strength: 0, winProb: { rise: 50, fall: 50, call: 50, put: 50 }, streak: 0, streakDir: "up" as const, momentum: 0, sma: prices[prices.length - 1] ?? 0, ema: prices[prices.length - 1] ?? 0, rsi: 50, samples: prices.length, risePct: 50, fallPct: 50, flatPct: 0, bias: "neutral" as const, recommendRise: false, recommendFall: false, recentRisePct: 50, recentFallPct: 50, streakInfo: "Insufficient data", hotStreak: 0, hotDirection: "none" as const };
  }

  const window = prices.slice(-100);
  const recent = prices.slice(-20);
  const samples = window.length;

  let rises = 0, falls = 0, flats = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] > window[i - 1]) rises++;
    else if (window[i] < window[i - 1]) falls++;
    else flats++;
  }
  const total = Math.max(window.length - 1, 1);
  const risePct = Math.round((rises / total) * 100);
  const fallPct = Math.round((falls / total) * 100);
  const flatPct = 100 - risePct - fallPct;

  let recentRises = 0, recentFalls = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) recentRises++;
    else if (recent[i] < recent[i - 1]) recentFalls++;
  }
  const recentTotal = Math.max(recent.length - 1, 1);
  const recentRisePct = Math.round((recentRises / recentTotal) * 100);
  const recentFallPct = Math.round((recentFalls / recentTotal) * 100);

  const last10 = prices.slice(-10);
  const momentum = last10.length >= 2
    ? (last10[last10.length - 1] - last10[0]) / (Math.abs(last10[0]) || 1)
    : 0;

  const sma = window.reduce((a, b) => a + b, 0) / window.length;
  let ema = window[0];
  const k = 2 / (window.length + 1);
  for (let i = 1; i < window.length; i++) ema = window[i] * k + ema * (1 - k);

  const rsiPeriod = Math.min(14, window.length - 1);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = window[window.length - i] - window[window.length - i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= rsiPeriod; avgLoss /= rsiPeriod;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = Math.round(100 - 100 / (1 + rs));

  const strength = Math.min(100, Math.abs(recentRisePct - 50) * 2);

  let bias: "rise" | "fall" | "neutral" = "neutral";
  let recommendRise = false, recommendFall = false;
  if (recentRisePct > 65) { bias = "fall"; recommendFall = true; }
  else if (recentFallPct > 65) { bias = "rise"; recommendRise = true; }
  else if (risePct > 55) { bias = "rise"; recommendRise = true; }
  else if (fallPct > 55) { bias = "fall"; recommendFall = true; }

  if (rsi > 70) { bias = "fall"; recommendFall = true; }
  else if (rsi < 30) { bias = "rise"; recommendRise = true; }

  const direction = bias === "rise" ? "up" : bias === "fall" ? "down" : recentRisePct >= recentFallPct ? "up" : "down";

  const riseWinProb = Math.round(50 + (recentFallPct - 50) * 0.4 + (rsi > 70 ? 10 : rsi < 30 ? -10 : 0));
  const fallWinProb = 100 - riseWinProb;
  const callWinProb = Math.round(50 + (sma > ema ? 5 : -5) + (momentum > 0 ? 8 : -8));
  const putWinProb = 100 - callWinProb;

  let hotStreak = 0;
  let hotDirection: "rise" | "fall" | "none" = "none";
  for (let i = window.length - 1; i > 0; i--) {
    const dir = window[i] > window[i - 1] ? "rise" : window[i] < window[i - 1] ? "fall" : null;
    if (!dir) break;
    if (hotStreak === 0) { hotDirection = dir; hotStreak = 1; }
    else if (dir === hotDirection) hotStreak++;
    else break;
  }

  const streakInfo = hotStreak >= 3
    ? `${hotDirection.toUpperCase()} streak: ${hotStreak} consecutive`
    : "No significant streak";

  return {
    direction,
    strength,
    winProb: { rise: Math.max(20, Math.min(80, riseWinProb)), fall: Math.max(20, Math.min(80, fallWinProb)), call: Math.max(20, Math.min(80, callWinProb)), put: Math.max(20, Math.min(80, putWinProb)) },
    streak: hotStreak,
    streakDir: hotDirection === "rise" ? "up" as const : hotDirection === "fall" ? "down" as const : "up" as const,
    momentum,
    sma,
    ema,
    rsi,
    samples,
    risePct, fallPct, flatPct, bias, recommendRise, recommendFall,
    recentRisePct, recentFallPct, streakInfo, hotStreak, hotDirection,
  };
}

// ── Persistent Tick Manager ───────────────────────────────────────────────────
const TICK_BUFFER_SIZE = 500;
const DIGIT_BUFFER_SIZE = 300;

// ── Simulated price parameters ────────────────────────────────────────────────
const SIM_PARAMS: Record<string, { base: number; vol: number }> = {
  R_10:    { base: 4865.000,  vol: 0.00018 },
  R_25:    { base: 2592.726,  vol: 0.00035 },
  R_50:    { base: 6200.0000, vol: 0.00065 },
  R_75:    { base: 6800.0000, vol: 0.00095 },
  R_100:   { base: 1800.00,   vol: 0.00140 },
  "1HZ10V":  { base: 1000.00, vol: 0.00018 },
  "1HZ25V":  { base: 1000.00, vol: 0.00035 },
  "1HZ50V":  { base: 1000.00, vol: 0.00065 },
  "1HZ75V":  { base: 1000.00, vol: 0.00095 },
  "1HZ100V": { base: 1000.00, vol: 0.00140 },
  RDBULL:  { base: 5000.0000, vol: 0.00080 },
  RDBEAR:  { base: 5000.0000, vol: 0.00080 },
  JD10:    { base: 1000.00,  vol: 0.00025 },
  JD25:    { base: 1000.00,  vol: 0.00055 },
  JD50:    { base: 1000.00,  vol: 0.00100 },
  JD75:    { base: 1000.00,  vol: 0.00150 },
  JD100:   { base: 1000.00,  vol: 0.00200 },
};

export interface TickEvent {
  symbol: string;
  price: number;
  lastDigit: number;
  epoch: number;
}

/**
 * DerivTickManager
 *
 * Maintains one persistent WebSocket connection to the Deriv PUBLIC endpoint.
 * No authentication required — the public WS serves all market data freely.
 *
 * On connect it calls active_symbols to discover which markets are available,
 * then subscribes to those symbols via `ticks` subscriptions.
 *
 * NEW API notes:
 *  - URL: wss://api.derivws.com/trading/v1/options/ws/public
 *  - No app_id in the URL
 *  - No `authorize` message (public endpoint)
 *  - active_symbols response uses `underlying_symbol` field (not `symbol`)
 */
class DerivTickManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectDelay = 3_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private desiredSymbols: string[] = [];
  private confirmedSymbols = new Set<string>();
  private invalidSymbols = new Set<string>();

  private tickBuffers = new Map<string, number[]>();
  private digitBuffers = new Map<string, number[]>();
  private latestPrices = new Map<string, number>();
  private lastTickMs = new Map<string, number>();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongMs = Date.now();

  private simInterval: ReturnType<typeof setInterval> | null = null;
  private simPrices = new Map<string, number>();
  private usingSimulated = false;

  // Request multiplexing & queueing over persistent public WS
  private nextReqId = 1;
  private pendingRequests = new Map<
    number,
    {
      resolve: (msg: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private requestQueue: Array<() => void> = [];
  private queueInterval: ReturnType<typeof setInterval> | null = null;
  private queuePausedUntil = 0;

  constructor() {
    super();
    // Process outgoing requests at a controlled rate (20 req/sec max)
    this.queueInterval = setInterval(() => this.processQueue(), 50);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(symbols: string[]) {
    this.desiredSymbols = symbols;
    for (const sym of symbols) {
      if (!this.tickBuffers.has(sym)) this.tickBuffers.set(sym, []);
      if (!this.digitBuffers.has(sym)) this.digitBuffers.set(sym, []);
    }
    logger.info({ count: symbols.length }, "TickManager starting on public WS");
    this.connect();
  }

  getTicks(symbol: string, count = 100): number[] {
    return (this.tickBuffers.get(symbol) ?? []).slice(-count);
  }

  getDigits(symbol: string, count = 300): number[] {
    const buf = this.digitBuffers.get(symbol) ?? [];
    if (buf.length >= 30) return buf.slice(-count);
    const market = getMarketInfo(symbol);
    if (market?.digitEnabled) {
      const ticks = this.getTicks(symbol, Math.max(count, 100));
      if (ticks.length >= 5) {
        const derived = ticks.map((p) => extractLastDigit(p, market.pipSize));
        return [...derived, ...buf].slice(-count);
      }
    }
    return buf.slice(-count);
  }

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) ?? null;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  getLiveTickCount(): number {
    let total = 0;
    for (const [, v] of this.tickBuffers) total += v.length;
    return total;
  }

  isLiveData(symbol: string): boolean {
    return (this.tickBuffers.get(symbol) ?? []).length >= 5;
  }

  getTickHealth(): {
    connected: boolean;
    liveSymbols: number;
    totalSymbols: number;
    invalidSymbols: number;
    usingSimulated: boolean;
  } {
    const valid = this.desiredSymbols.filter((s) => !this.invalidSymbols.has(s));
    let live = 0;
    for (const sym of valid) {
      if (this.isLiveData(sym)) live++;
    }
    return {
      connected: this.isConnected,
      liveSymbols: live,
      totalSymbols: valid.length,
      invalidSymbols: this.invalidSymbols.size,
      usingSimulated: this.usingSimulated,
    };
  }

  // ── Outgoing request queue & multiplexing (req_id) ─────────────────────────

  private processQueue() {
    if (Date.now() < this.queuePausedUntil) return;
    if (this.requestQueue.length === 0) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const task = this.requestQueue.shift();
    if (task) {
      try {
        task();
      } catch {
        /* ignore */
      }
    }
  }

  async request(msg: Record<string, unknown>, timeoutMs = 8_000): Promise<any> {
    const reqId = this.nextReqId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        resolve(null);
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve,
        reject: () => resolve(null),
        timer,
      });

      this.requestQueue.push(() => {
        if (
          this.ws?.readyState === WebSocket.OPEN &&
          this.pendingRequests.has(reqId)
        ) {
          this.ws.send(JSON.stringify({ ...msg, req_id: reqId }));
        } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(reqId);
            resolve(null);
          }
        }
      });
    });
  }

  // ── Internal connection logic ──────────────────────────────────────────────

  private connect() {
    this.cleanupWs();
    try {
      // Public WS — no app_id needed, no authorization
      this.ws = new WebSocket(DERIV_PUBLIC_WS_URL, { perMessageDeflate: false });
    } catch (err) {
      logger.warn({ err }, "TickManager: failed to create WebSocket, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isConnected = true;
      this.reconnectDelay = 3_000;
      this.lastPongMs = Date.now();
      logger.info({ url: DERIV_PUBLIC_WS_URL }, "TickManager: connected to public WS");
      // Discover available symbols — response uses `underlying_symbol` field
      this.ws!.send(JSON.stringify({ active_symbols: "brief" }));
      this.startPing();
      this.startStaleCheck();
    });

    this.ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch { /* ignore parse errors */ }
    });

    this.ws.on("error", (err) => {
      logger.warn({ msg: (err as Error).message }, "TickManager: WS error");
      if (!this.usingSimulated) this.startSimulation();
    });

    this.ws.on("close", () => {
      this.isConnected = false;
      this.stopTimers();
      logger.info("TickManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any) {
    if (msg.req_id !== undefined && msg.req_id !== null) {
      const reqId = Number(msg.req_id);
      const pending = this.pendingRequests.get(reqId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(reqId);
        pending.resolve(msg);
      }
    }
    switch (msg.msg_type) {
      case "active_symbols":
        this.onActiveSymbols(msg.active_symbols ?? []);
        return;
      case "tick":
        if (msg.tick) this.onTick(msg.tick);
        return;
      case "ping":
      case "pong":
        this.lastPongMs = Date.now();
        return;
    }
    if (msg.error) this.onError(msg);
  }

  private onActiveSymbols(
    symbols: Array<{ underlying_symbol: string; underlying_symbol_name?: string; pip_size?: number }>,
  ) {
    // New API uses `underlying_symbol` field (old API used `symbol`)
    const available = new Set(symbols.map((s) => s.underlying_symbol));
    const toSubscribe = this.desiredSymbols.filter((s) => available.has(s));

    if (symbols.length === 0) {
      logger.warn(
        "TickManager: active_symbols returned empty — starting simulated prices.",
      );
      this.startSimulation();
      this.subscribeSymbols(this.desiredSymbols);
    } else if (toSubscribe.length === 0) {
      logger.warn(
        {
          availableSample: [...available].slice(0, 8),
          desired: this.desiredSymbols.slice(0, 5),
        },
        "TickManager: none of our desired symbols found — Deriv may have renamed them. Subscribing anyway.",
      );
      this.subscribeSymbols(this.desiredSymbols);
    } else {
      this.confirmedSymbols = new Set(toSubscribe);
      logger.info(
        { confirmed: toSubscribe.length, total: this.desiredSymbols.length },
        "TickManager: symbol discovery complete",
      );
      this.subscribeSymbols(toSubscribe);
    }
  }

  private subscribeSymbols(symbols: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const valid = symbols.filter((s) => !this.invalidSymbols.has(s));
    valid.forEach((symbol, i) => {
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // `ticks` subscription — symbol name field unchanged
          this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
      }, i * 300);
    });
    logger.info({ count: valid.length, staggerMs: 300 }, "TickManager: subscribing to markets");
  }

  private onTick(tick: { symbol: string; quote: string; epoch: number }) {
    const { symbol, quote, epoch } = tick;
    const price = Number(quote);
    if (!Number.isFinite(price) || price <= 0) return;

    const market = getMarketInfo(symbol);
    if (!market) return;

    if (this.usingSimulated) this.stopSimulation();

    const prices = this.tickBuffers.get(symbol) ?? [];
    prices.push(price);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(symbol, prices);
    this.latestPrices.set(symbol, price);
    this.lastTickMs.set(symbol, Date.now());

    if (market.digitEnabled) {
      const digit = extractLastDigit(price, market.pipSize);
      if (digit >= 0 && digit <= 9) {
        const digits = this.digitBuffers.get(symbol) ?? [];
        digits.push(digit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(symbol, digits);
      }
    }

    const lastDigit = market.digitEnabled ? extractLastDigit(price, market.pipSize) : -1;
    this.emit("tick", { symbol, price, lastDigit, epoch } as TickEvent);
  }

  private onError(msg: any) {
    const code: string = msg.error?.code ?? "Unknown";
    const message: string = msg.error?.message ?? "";
    const sym: string | undefined = msg.echo_req?.ticks;

    logger.warn({ code, message, symbol: sym }, "TickManager: Deriv error");

    if (!sym || !this.desiredSymbols.includes(sym)) return;

    if (code === "InvalidSymbol") {
      this.invalidSymbols.add(sym);
      logger.warn({ symbol: sym }, "TickManager: symbol permanently invalid");
      return;
    }

    if (code === "RateLimit") {
      this.queuePausedUntil = Date.now() + 2_000;
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN && !this.invalidSymbols.has(sym)) {
          this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        }
      }, 60_000);
      return;
    }

    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN && !this.invalidSymbols.has(sym)) {
        this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      }
    }, 5_000);
  }

  // ── Keep-alive timers ──────────────────────────────────────────────────────

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 60_000) {
        logger.warn("TickManager: no pong for 60s, reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 25_000);
  }

  private startStaleCheck() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      const liveSymbols = this.desiredSymbols.filter(
        (s) => !this.invalidSymbols.has(s) && (this.lastTickMs.get(s) ?? 0) > 0,
      );
      for (const sym of liveSymbols) {
        if (now - (this.lastTickMs.get(sym) ?? 0) > 45_000) {
          logger.info({ symbol: sym }, "TickManager: re-subscribing stale symbol");
          this.ws!.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        }
      }
    }, 30_000);
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
  }

  // ── Price simulation ──────────────────────────────────────────────────────

  private gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  private pushSimulatedTick(market: (typeof DERIV_MARKETS)[0], price: number) {
    const factor = Math.pow(10, market.pipSize);
    const rounded = Math.round(price * factor) / factor;

    const prices = this.tickBuffers.get(market.symbol) ?? [];
    prices.push(rounded);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(market.symbol, prices);
    this.latestPrices.set(market.symbol, rounded);

    if (market.digitEnabled) {
      const digit = extractLastDigit(rounded, market.pipSize);
      if (digit >= 0 && digit <= 9) {
        const digits = this.digitBuffers.get(market.symbol) ?? [];
        digits.push(digit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(market.symbol, digits);
      }
    }
  }

  startSimulation() {
    if (this.simInterval) return;
    this.usingSimulated = true;
    logger.info("TickManager: starting simulated prices (no live symbols available)");

    for (const market of DERIV_MARKETS) {
      const params = SIM_PARAMS[market.symbol];
      if (!params || !market.digitEnabled) continue;
      this.simPrices.set(market.symbol, params.base);
      let price = params.base;
      for (let i = 0; i < 150; i++) {
        const delta = price * params.vol * this.gaussianRandom();
        price = Math.max(price * 0.5, price + delta);
        this.pushSimulatedTick(market, price);
      }
    }

    let idx = 0;
    this.simInterval = setInterval(() => {
      const digitMarkets = DERIV_MARKETS.filter((m) => m.digitEnabled);
      const market = digitMarkets[idx % digitMarkets.length];
      idx++;

      const params = SIM_PARAMS[market.symbol];
      if (!params) return;

      let price = this.simPrices.get(market.symbol) ?? params.base;
      const delta = price * params.vol * this.gaussianRandom();
      price = Math.max(price * 0.5, price + delta);
      this.simPrices.set(market.symbol, price);
      this.pushSimulatedTick(market, price);

      const factor = Math.pow(10, market.pipSize);
      const rounded = Math.round(price * factor) / factor;
      const lastDigit = extractLastDigit(rounded, market.pipSize);
      this.emit("tick", {
        symbol: market.symbol,
        price: rounded,
        lastDigit,
        epoch: Math.floor(Date.now() / 1000),
      } as TickEvent);
    }, Math.ceil(1000 / DERIV_MARKETS.filter((m) => m.digitEnabled).length));
  }

  stopSimulation() {
    if (!this.simInterval) return;
    clearInterval(this.simInterval);
    this.simInterval = null;
    this.usingSimulated = false;
    logger.info("TickManager: stopping simulation — real Deriv ticks taking over");
  }

  private cleanupWs() {
    this.stopTimers();
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    for (const [reqId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingRequests.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      logger.info({ delayMs: this.reconnectDelay }, "TickManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }
}

export const tickManager = new DerivTickManager();

// ── getTickHistory ────────────────────────────────────────────────────────────
// Fetches historical tick prices. Uses the in-memory buffer if warm, otherwise
// requests through the persistent PUBLIC WebSocket.
export async function getTickHistory(symbol: string, count = 50): Promise<number[]> {
  const buffered = tickManager.getTicks(symbol, count);
  if (buffered.length >= 5) return buffered;

  try {
    const msg = await tickManager.request(
      {
        ticks_history: symbol,
        count,
        end: "latest",
        style: "ticks",
      },
      8_000,
    );

    if (msg?.msg_type === "history" && msg.history?.prices) {
      return msg.history.prices.map(Number);
    }
  } catch {
    /* ignore */
  }
  return [];
}

// ── Account / auth types ──────────────────────────────────────────────────────
export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  balance: number;
  is_virtual: number;   // 0 = real, 1 = virtual
  email?: string;
  fullname?: string;
  country?: string;
}

export interface LiveTradeResult {
  contractId: number;
  buyPrice: number;
  entrySpot: number;
  longcode: string;
}

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  exitSpot: number;
  sellPrice: number;
  entrySpot: number;
}

export interface ContractProposal {
  payout: number;
  stake: number;
  payoutMultiplier: number;
  spot: number;
  longcode: string;
  proposalId: string;
  askPrice: number;
}

// ── Module-level credential cache ─────────────────────────────────────────────
// The Bearer token + accountId are needed for authenticated REST calls and OTP.
let cachedBearerToken: string | null = null;
let cachedAccountId: string | null = null;
let cachedAccountInfo: DerivAccountInfo | null = null;

// Balance cache (REST-based — no WS needed)
let cachedBalance: number | null = null;
let cachedBalanceAt = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

export function setDerivCredentials(bearerToken: string, accountId: string) {
  cachedBearerToken = bearerToken;
  cachedAccountId = accountId;
  cachedBalance = null;
  cachedBalanceAt = 0;
  journalManager.setCredentials(bearerToken, accountId);
}

// Backward-compatible alias — accepts a Bearer token and optionally an accountId.
export function setDerivToken(token: string, accountId?: string) {
  cachedBearerToken = token;
  if (accountId) cachedAccountId = accountId;
  cachedBalance = null;
  cachedBalanceAt = 0;
  if (accountId) {
    journalManager.setCredentials(token, accountId);
  }
}

export function clearDerivToken() {
  cachedBearerToken = null;
  cachedAccountId = null;
  cachedAccountInfo = null;
  cachedBalance = null;
  cachedBalanceAt = 0;
  journalManager.clearCredentials();
}

export function getCachedAccountInfo() { return cachedAccountInfo; }

/** Returns the active Bearer token (used everywhere a "token" is expected). */
export function getCachedToken(): string | null { return cachedBearerToken; }
export function getCachedBearerToken(): string | null { return cachedBearerToken; }
export function getCachedAccountId(): string | null { return cachedAccountId; }

export function invalidateBalanceCache() { cachedBalanceAt = 0; }

// ── Persistent Journal WebSocket Manager ─────────────────────────────────────
/**
 * DerivJournalManager
 *
 * Maintains a persistent authenticated WebSocket for profit_table fetches.
 *
 * Auth flow:
 *  1. Fetch OTP URL via POST /accounts/{accountId}/otp (Bearer token)
 *  2. Connect to the OTP URL (no `authorize` message)
 *  3. Send profit_table requests on the open connection
 *  4. On disconnect, fetch a fresh OTP URL and reconnect
 */
/** Max transactions per Deriv profit_table request (Deriv hard limit is 500) */
const JOURNAL_FETCH_LIMIT = 500;

class DerivJournalManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private bearerToken: string | null = null;
  private accountId: string | null = null;
  private cachedTransactions: any[] = [];
  private lastFetchMs = 0;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongMs = Date.now();
  /** Accumulates transactions across paginated fetches */
  private fetchAccumulator: any[] = [];
  /** Debounce timer for full background refreshes */
  private txDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rate-limit guard: timestamp of last FULL profit_table chain sent */
  private lastRefreshSentMs = 0;
  /** Rate-limit guard: timestamp of last QUICK (limit:10) profit_table sent */
  private lastQuickRefreshSentMs = 0;
  /** Minimum ms between full profit_table pagination chains */
  private static readonly MIN_REFRESH_INTERVAL_MS = 10_000;
  /** Minimum ms between quick (limit:10) profit_table requests — 3 s for near-live updates */
  private static readonly MIN_QUICK_REFRESH_MS = 3_000;
  /** True while a paginated profit_table fetch is in progress — blocks new full chains */
  private isFetchingPages = false;

  setCredentials(bearerToken: string, accountId: string) {
    const changed = this.bearerToken !== bearerToken || this.accountId !== accountId;
    this.bearerToken = bearerToken;
    this.accountId = accountId;
    if (changed) {
      // Clear stale cache from the previous account immediately so the journal
      // doesn't briefly show the wrong account's trades after switching.
      this.cachedTransactions = [];
      this.fetchAccumulator = [];
      this.isFetchingPages = false;
      this.lastFetchMs = 0;
      this.lastRefreshSentMs = 0;
      this.lastQuickRefreshSentMs = 0;
      // Emit empty immediately so the frontend journal shows "loading" state
      this.emit("refreshed", []);
      this.reconnectDelay = 3_000;
      this.connect();
      this.startRefreshTimer();
    }
  }

  // Backward-compat: accept PAT token only (no accountId → can't use OTP)
  setToken(token: string) {
    logger.info("JournalManager.setToken: token stored; awaiting accountId for OTP connection.");
    this.bearerToken = token;
    // Don't connect until we have accountId
  }

  clearCredentials() {
    this.bearerToken = null;
    this.accountId = null;
    this.cachedTransactions = [];
    this.fetchAccumulator = [];
    this.lastFetchMs = 0;
    this.stopTimers();
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    logger.info("JournalManager: credentials cleared");
  }

  getCached(): any[] { return this.cachedTransactions; }

  isCacheFresh(maxAgeMs = 120_000): boolean {
    return this.lastFetchMs > 0 && (Date.now() - this.lastFetchMs) < maxAgeMs;
  }

  /**
   * Quick refresh: fetches only the last 10 trades and MERGES them into the
   * existing cache. Used after real-time transaction `sell` events so the
   * journal reflects the settled contract within ~1-2 seconds, without
   * waiting for a full paginated profit_table chain.
   *
   * Rate-limited to once every 3 s to avoid Deriv per-account limits.
   * Does NOT block or interact with the full pagination lock.
   */
  forceQuickRefresh() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (now - this.lastQuickRefreshSentMs < DerivJournalManager.MIN_QUICK_REFRESH_MS) {
      logger.debug({ msSinceLast: now - this.lastQuickRefreshSentMs }, "JournalManager: quickRefresh skipped (rate-limit)");
      return;
    }
    this.lastQuickRefreshSentMs = now;
    // passthrough echoed back in the response so we can distinguish quick vs full
    this.ws.send(JSON.stringify({
      profit_table: 1, description: 1, sort: "DESC", limit: 10,
      passthrough: { quick: true },
    }));
    logger.debug("JournalManager: quick refresh sent (limit 10)");
  }

  forceRefresh() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Block new chains while a paginated fetch is already in progress.
    // With 5000+ trades, one refresh = 10+ sequential WS messages; starting
    // a new chain mid-pagination causes concurrent bursts that hit Deriv's
    // profit_table rate limit.
    if (this.isFetchingPages) {
      logger.debug("JournalManager: forceRefresh skipped (pagination in progress)");
      return;
    }
    const now = Date.now();
    if (now - this.lastRefreshSentMs < DerivJournalManager.MIN_REFRESH_INTERVAL_MS) {
      // Rate-limit guard: too soon since the last profit_table request.
      logger.debug({ msSinceLast: now - this.lastRefreshSentMs }, "JournalManager: forceRefresh skipped (rate-limit guard)");
      return;
    }
    this.lastRefreshSentMs = now;
    this.isFetchingPages = true;
    this.fetchAccumulator = [];
    this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT }));
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.txDebounceTimer) { clearTimeout(this.txDebounceTimer); this.txDebounceTimer = null; }
  }

  private startRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    // Background safety-net poll — real-time updates come from the transaction subscription.
    // Routes through forceRefresh() so the rate-limit guard is always enforced.
    this.refreshTimer = setInterval(() => { this.forceRefresh(); }, 30_000);
  }

  /** Debounced FULL refresh — runs after quick refresh to ensure complete accuracy */
  private scheduleTransactionRefresh() {
    if (this.txDebounceTimer) { clearTimeout(this.txDebounceTimer); }
    this.txDebounceTimer = setTimeout(() => {
      this.txDebounceTimer = null;
      this.forceRefresh();
    }, 5_000); // 5 s after the quick refresh — gives Deriv time to fully settle
  }

  private async connect() {
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    if (!this.bearerToken || !this.accountId) return;

    let otpUrl: string;
    try {
      otpUrl = await getOtpWebSocketUrl(this.bearerToken, this.accountId);
    } catch (err) {
      logger.warn({ err }, "JournalManager: failed to get OTP URL, will retry");
      this.scheduleReconnect();
      return;
    }

    try {
      this.ws = new WebSocket(otpUrl, { perMessageDeflate: false });
    } catch (err) {
      logger.warn({ err }, "JournalManager: failed to create WS, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.lastPongMs = Date.now();
      this.reconnectDelay = 10_000;
      logger.info("JournalManager: connected via OTP WS — will fetch profit table in 5 s");
      // Subscribe to real-time transaction events immediately (no rate-limit concern)
      this.ws!.send(JSON.stringify({ transaction: 1, subscribe: 1 }));
      this.startPing();
      // Delay the first profit_table request by 5 s.
      // Deriv's per-account rate limit persists across reconnects — if the previous
      // session was rate-limited, firing immediately on the new connection hits the
      // same limit before it has had time to cool down.
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN && !this.isFetchingPages) {
          this.fetchAccumulator = [];
          this.isFetchingPages = true;
          this.lastRefreshSentMs = Date.now();
          this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT }));
        }
      }, 5_000);
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "profit_table" && msg.profit_table) {
          const isQuick: boolean = msg.passthrough?.quick === true;
          const batch: any[] = msg.profit_table.transactions ?? [];

          if (isQuick) {
            // Quick refresh response (limit: 10) — MERGE into existing cache so the
            // journal shows the settled trade within ~1-2 s without replacing the
            // full history (which would require a complete re-pagination).
            if (batch.length > 0) {
              const batchIds = new Set(batch.map((t: any) => t.transaction_id));
              // Keep all cached trades that are not in the quick batch (avoid duplicates),
              // then prepend the fresh batch at the front (most recent first).
              const merged = [
                ...batch,
                ...this.cachedTransactions.filter((t: any) => !batchIds.has(t.transaction_id)),
              ];
              this.cachedTransactions = merged;
              this.lastFetchMs = Date.now();
              logger.info({ newInBatch: batch.length, total: merged.length }, "JournalManager: quick refresh merged — live trades updated");
              this.emit("refreshed", this.cachedTransactions);
            }
            return; // Do not run pagination logic for quick refreshes
          }

          // Full paginated refresh
          this.fetchAccumulator.push(...batch);

          if (batch.length >= JOURNAL_FETCH_LIMIT) {
            // There may be more pages — wait 5 s between page requests.
            // Deriv enforces a per-account profit_table rate limit of roughly
            // 1 request every 3-5 s. Sending pages back-to-back (even with 1.5 s
            // gaps) triggers "RateLimit" errors that abort the whole chain.
            // 5 s ensures we stay well below the limit regardless of account history size.
            const offset = this.fetchAccumulator.length;
            logger.info({ received: batch.length, totalSoFar: offset }, "JournalManager: fetching next page");
            setTimeout(() => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT, offset }));
              } else {
                // WS closed while waiting — release the lock
                this.isFetchingPages = false;
              }
            }, 5_000);
          } else {
            // All pages received — commit to cache and release the in-progress lock
            this.cachedTransactions = this.fetchAccumulator;
            this.fetchAccumulator = [];
            this.isFetchingPages = false;
            this.lastFetchMs = Date.now();
            logger.info({ count: this.cachedTransactions.length }, "JournalManager: full profit table refreshed");
            this.emit("refreshed", this.cachedTransactions);
          }
        }
        // Real-time transaction events — immediate quick refresh on sell (contract settled)
        if (msg.msg_type === "transaction" && msg.transaction) {
          const actionType: string = msg.transaction.action ?? msg.transaction.action_type ?? "";
          if (actionType === "sell") {
            logger.info({ action: actionType, id: msg.transaction.contract_id }, "JournalManager: sell event — quick refresh + scheduled full refresh");
            // 1. Immediate quick fetch (limit: 10) for near-live update within ~1-2 s
            this.forceQuickRefresh();
            // 2. Full refresh scheduled at 5 s to ensure complete accuracy
            this.scheduleTransactionRefresh();
          }
        }
        if (msg.msg_type === "pong" || msg.msg_type === "ping") {
          this.lastPongMs = Date.now();
        }
        if (msg.error) {
          logger.warn({ code: msg.error.code, message: msg.error.message }, "JournalManager: error");
          // Discard the partial accumulator — do NOT commit truncated results to cache.
          this.fetchAccumulator = [];
          this.isFetchingPages = false;
          if (msg.error.code === "RateLimit") {
            // Honour the full MIN_REFRESH_INTERVAL before any new request.
            this.lastRefreshSentMs = Date.now();
            // Schedule a full retry after 15 s so the background timer doesn't
            // have to wait a full 30 s cycle before the journal is populated.
            logger.info("JournalManager: RateLimit — will retry profit_table in 15 s");
            setTimeout(() => { this.forceRefresh(); }, 15_000);
          }
        }
      } catch { /* ignore */ }
    });

    this.ws.on("error", (err) => {
      logger.warn({ msg: (err as Error).message }, "JournalManager: WS error");
    });

    this.ws.on("close", () => {
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      logger.info("JournalManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 60_000) {
        logger.warn("JournalManager: no pong for 60s — reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 25_000);
  }

  private scheduleReconnect() {
    if (!this.bearerToken || !this.accountId) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      logger.info({ delay: this.reconnectDelay }, "JournalManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }
}

export const journalManager = new DerivJournalManager();

// ── Account authorization via REST ────────────────────────────────────────────
/**
 * Validate a Bearer token by calling GET /trading/v1/options/accounts.
 * Returns the first account's info mapped to DerivAccountInfo.
 *
 * This replaces the old `authorize` WebSocket message flow.
 */
export async function authorizeWithDeriv(bearerToken: string): Promise<DerivAccountInfo> {
  const accounts = await getDerivAccounts(bearerToken);
  if (accounts.length === 0) {
    throw new Error("No trading accounts found for this token");
  }

  // Use the first active account (prefer real over demo if available)
  const real = accounts.find((a) => a.account_type === "real" && a.status === "active");
  const account = real ?? accounts[0];

  const info: DerivAccountInfo = {
    loginid: account.account_id,
    currency: account.currency,
    balance: account.balance,
    is_virtual: account.account_type === "demo" ? 1 : 0,
  };

  cachedAccountInfo = info;
  cachedAccountId = account.account_id;
  return info;
}

// ── Live balance via REST ─────────────────────────────────────────────────────
export async function getLiveBalance(bearerToken: string): Promise<number | null> {
  const now = Date.now();
  if (cachedBalance !== null && now - cachedBalanceAt < BALANCE_CACHE_TTL_MS) {
    return cachedBalance;
  }

  try {
    const accounts = await getDerivAccounts(bearerToken);
    if (accounts.length === 0) return null;
    // Prefer the currently active account; fall back to real then first
    const match = cachedAccountId
      ? accounts.find(a => a.account_id === cachedAccountId)
      : null;
    const real = accounts.find((a) => a.account_type === "real" && a.status === "active");
    const account = match ?? real ?? accounts[0];
    cachedBalance = account.balance;
    cachedBalanceAt = Date.now();
    return account.balance;
  } catch {
    return null;
  }
}

// ── Contract proposal (public WS — no auth required) ─────────────────────────
export async function getContractProposal(
  _token: string | null,   // kept for API compat; proposals use the public WS
  params: {
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    barrier?: number | string;
  },
): Promise<ContractProposal | null> {
  try {
    const proposalParams: Record<string, unknown> = {
      amount: params.stake,
      basis: "stake",
      contract_type: params.contractType,
      currency: params.currency,
      duration: params.duration,
      duration_unit: params.durationUnit,
      // New API uses `underlying_symbol` (not `symbol`)
      underlying_symbol: params.symbol,
    };
    if (params.barrier !== undefined) proposalParams.barrier = String(params.barrier);

    const msg = await tickManager.request({ proposal: 1, ...proposalParams }, 8_000);

    if (msg?.error) {
      logger.debug({ symbol: params.symbol, ct: params.contractType, err: msg.error }, "getContractProposal: Deriv error");
      return null;
    }

    if (msg?.msg_type === "proposal" && msg.proposal) {
      const askPrice = Number(msg.proposal.ask_price ?? params.stake);
      const payout = Number(msg.proposal.payout ?? askPrice * RISE_FALL_PAYOUT);
      return {
        payout,
        stake: askPrice,
        payoutMultiplier: askPrice > 0 ? payout / askPrice : RISE_FALL_PAYOUT,
        spot: Number(msg.proposal.spot ?? 0),
        longcode: msg.proposal.longcode ?? "",
        proposalId: String(msg.proposal.id ?? ""),
        askPrice,
      };
    }
  } catch { /* ignore */ }
  return null;
}

// ── Live trade execution via OTP WebSocket ────────────────────────────────────
/**
 * Execute a live trade using the new OTP-authenticated WebSocket flow:
 *  1. POST /accounts/{accountId}/otp → OTP WS URL
 *  2. Connect to OTP URL (no authorize message)
 *  3. Send `proposal` with `underlying_symbol`
 *  4. On proposal response, send `buy` with the proposal ID
 *  5. On buy confirmation, resolve with contract details
 */
export async function executeLiveTrade(
  _token: string,   // kept for API compat; auth comes from module-level cache
  params: {
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    barrier?: number | string;
  },
): Promise<LiveTradeResult> {
  const bearerToken = cachedBearerToken;
  const accountId = cachedAccountId;

  if (!bearerToken || !accountId) {
    throw new Error(
      "No authenticated session. Please sign in with Deriv (OAuth) to enable live trading. " +
      "A Bearer token and account ID are required for the new Deriv API.",
    );
  }

  // Step 1: Get OTP WebSocket URL
  const otpUrl = await getOtpWebSocketUrl(bearerToken, accountId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(otpUrl, { perMessageDeflate: false });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Trade execution timeout"));
    }, 20_000);

    let proposalId: string | null = null;
    let askPrice: number | null = null;

    ws.on("open", () => {
      // Step 2: Connected — no authorize message needed
      // Step 3: Send proposal with `underlying_symbol`
      const proposalParams: Record<string, unknown> = {
        amount: params.stake,
        basis: "stake",
        contract_type: params.contractType,
        currency: params.currency,
        duration: params.duration,
        duration_unit: params.durationUnit,
        underlying_symbol: params.symbol,   // new field name
      };
      if (params.barrier !== undefined) proposalParams.barrier = String(params.barrier);
      logger.info({ proposalParams }, "executeLiveTrade: sending proposal");
      ws.send(JSON.stringify({ proposal: 1, ...proposalParams }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        logger.info({ msgType: msg.msg_type }, "executeLiveTrade: received message");

        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          logger.error({ derivError: msg.error }, "executeLiveTrade: Deriv error");
          reject(new Error(msg.error.message ?? "Trade rejected by Deriv"));
          return;
        }

        // Step 4: proposal received → send buy
        if (msg.msg_type === "proposal" && msg.proposal) {
          proposalId = String(msg.proposal.id);
          askPrice = Number(msg.proposal.ask_price ?? params.stake);
          logger.info({ proposalId, askPrice }, "executeLiveTrade: proposal received, sending buy");
          // New buy format: { buy: proposalId, price: askPrice }
          ws.send(JSON.stringify({ buy: proposalId, price: askPrice }));
        }

        // Step 5: buy confirmed
        if (msg.msg_type === "buy" && msg.buy) {
          clearTimeout(timeout);
          ws.close();
          resolve({
            contractId: msg.buy.contract_id,
            buyPrice: Number(msg.buy.buy_price),
            entrySpot: Number(msg.buy.start_time ?? 0),
            longcode: msg.buy.longcode ?? "",
          });
        }
      } catch (e) {
        logger.error({ e }, "executeLiveTrade: error parsing message");
      }
    });

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

// ── Profit table fetch via OTP WebSocket ──────────────────────────────────────
export async function fetchDerivProfitTable(
  _token: string,   // kept for API compat
  limit = 50,
): Promise<any[]> {
  const bearerToken = cachedBearerToken;
  const accountId = cachedAccountId;

  if (!bearerToken || !accountId) {
    logger.warn("fetchDerivProfitTable: no Bearer token or accountId — returning empty");
    return [];
  }

  let otpUrl: string;
  try {
    otpUrl = await getOtpWebSocketUrl(bearerToken, accountId);
  } catch (err) {
    logger.warn({ err }, "fetchDerivProfitTable: OTP fetch failed");
    return [];
  }

  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(otpUrl, { perMessageDeflate: false });
      const timeout = setTimeout(() => { ws.close(); resolve([]); }, 12_000);

      ws.on("open", () => {
        // No authorize — OTP URL is pre-authenticated
        ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit }));
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) { clearTimeout(timeout); ws.close(); resolve([]); return; }
          if (msg.msg_type === "profit_table" && msg.profit_table) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.profit_table.transactions ?? []);
          }
        } catch { /* ignore */ }
      });

      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve([]); });
    } catch { resolve([]); }
  });
}

// ── Wait for contract result via OTP WebSocket ────────────────────────────────
/**
 * NOTE: proposal_open_contracts is unsupported for this account/app_id combination.
 * We poll `portfolio` (checks if contract is still open) then `profit_table`
 * (confirms settled buy/sell price) — same strategy as before, now on OTP WS.
 */
export async function waitForContractResult(
  _token: string,   // kept for API compat
  contractId: number,
  timeoutMs = 30_000,
): Promise<ContractResult> {
  const bearerToken = cachedBearerToken;
  const accountId = cachedAccountId;

  if (!bearerToken || !accountId) {
    throw new Error("No authenticated session for contract result polling");
  }

  const otpUrl = await getOtpWebSocketUrl(bearerToken, accountId);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(otpUrl, { perMessageDeflate: false });
    let settled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const overallTimeout = setTimeout(() => finishError(new Error("Contract result timeout")), timeoutMs + 10_000);

    const cleanup = () => {
      clearTimeout(overallTimeout);
      if (pollInterval) clearInterval(pollInterval);
      try { ws.close(); } catch { /* ignore */ }
    };

    const finishOk = (result: ContractResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    ws.on("open", () => {
      // No authorize — OTP URL is pre-authenticated
      const poll = () => { if (!settled) ws.send(JSON.stringify({ portfolio: 1 })); };
      poll();
      // 4 s poll — digit contracts settle within 5-15 ticks (~5-15s at 1 Hz),
      // so 4 s still catches settlement quickly while cutting WS message rate
      // by 4× vs the old 1 s interval that was triggering Deriv's rate limit.
      pollInterval = setInterval(poll, 2_000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          // Ignore transient poll errors; if portfolio itself fails, keep polling
          return;
        }

        if (msg.msg_type === "portfolio") {
          const contracts: any[] = msg.portfolio?.contracts ?? [];
          const stillOpen = contracts.some((c) => Number(c.contract_id) === contractId);
          if (stillOpen) return;
          // Not in open portfolio — check profit_table for settled record
          ws.send(JSON.stringify({ profit_table: 1, limit: 10, sort: "DESC" }));
        }

        if (msg.msg_type === "profit_table") {
          const txs: any[] = msg.profit_table?.transactions ?? [];
          const tx = txs.find((t) => Number(t.contract_id) === contractId);
          if (tx) {
            const buyPrice = Number(tx.buy_price ?? 0);
            const sellPrice = Number(tx.sell_price ?? 0);
            const profit = sellPrice - buyPrice;
            finishOk({
              contractId,
              won: profit > 0,
              profit,
              exitSpot: 0,
              sellPrice,
              entrySpot: 0,
            });
          }
          // Not settled yet — keep polling portfolio
        }
      } catch { /* ignore */ }
    });

    ws.on("error", (err) => { finishError(err); });

    // Without a "close" handler, a silent WebSocket drop (no error event) hangs
    // the promise until overallTimeout fires ~47s later — keeping isLoopRunning=true
    // the whole time and causing the loop to warn "previous iteration still running"
    // on every 3s tick. Immediate rejection on unexpected close is much safer.
    ws.on("close", () => { finishError(new Error("Settlement WebSocket closed before contract was confirmed")); });
  });
}
