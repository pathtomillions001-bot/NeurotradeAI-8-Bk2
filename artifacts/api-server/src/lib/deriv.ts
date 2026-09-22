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
import { DigitTape, type DigitSnapshot } from "./digit-tape";
import { logger } from "./logger";
import { RISE_FALL_PAYOUT } from "./payouts";
import {
  describeDerivHttpFailure,
  isTransientDerivFailure,
} from "./friendly-error";

// ── Index specifications (annualised volatility and tick interval) ───────────
// Single source of truth for "how volatile is R_10": the published
// annualised volatilities Deriv uses to generate its synthetic indices, plus
// each family's tick interval.

/** Seconds in the year Deriv's volatility definitions use (365 d). */
export const YEAR_SECONDS = 365 * 24 * 3600;

const ANNUAL_VOL: Record<string, number> = {
  R_10: 0.10, R_25: 0.25, R_50: 0.50, R_75: 0.75, R_100: 1.00,
  "1HZ10V": 0.10, "1HZ15V": 0.15, "1HZ25V": 0.25, "1HZ30V": 0.30,
  "1HZ50V": 0.50, "1HZ75V": 0.75, "1HZ90V": 0.90, "1HZ100V": 1.00,
  JD10: 0.10, JD25: 0.25, JD50: 0.50, JD75: 0.75, JD100: 1.00,
  RDBULL: 0.40, RDBEAR: 0.40,
};

/** Every Volatility-family index ticks every 2 s; the 1-second family every 1 s. */
export function tickSecondsFor(symbol: string): number {
  return symbol.startsWith("1HZ") ? 1 : 2;
}

export function annualVolFor(symbol: string): number {
  return ANNUAL_VOL[symbol] ?? 0.25;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Deriv API base URLs ───────────────────────────────────────────────────────
/**
 * Deriv REST base. Overridable ONLY so the test suite can point the real
 * handshake path (OTP → WebSocket) at a local fake Deriv server; production
 * never sets it and always talks to api.derivws.com.
 */
export const DERIV_REST_BASE = (
  process.env.DERIV_REST_BASE ?? "https://api.derivws.com"
).replace(/\/+$/, "");
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
    throw new Error(
      describeDerivHttpFailure("Sign-in with Deriv", res.status, text),
    );
  }
  const data = await res.json() as any;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 3600,
  };
}

/**
 * Exchange an OAuth refresh token for a fresh access token.
 *
 * OAuth access tokens expire after ~1h. Before this existed the app simply kept
 * using the expired token, every Deriv call 401'd, and the user was shown the
 * "connect your account" screen — a silent logout they never asked for. The
 * refresh token is long-lived, so a connected account now stays connected until
 * the user actually revokes access.
 */
export async function refreshOAuthAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: APP_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(`${DERIV_AUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(describeDerivHttpFailure("Refreshing the Deriv session", res.status, text));
  }
  const data = (await res.json()) as any;
  return {
    accessToken: data.access_token,
    // Deriv may or may not rotate the refresh token; keep the old one when absent.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresIn: Number(data.expires_in ?? 3600),
  };
}

/**
 * GET /trading/v1/options/accounts — list all trading accounts for the Bearer token.
 *
 * Cached + single-flighted. The account list changes rarely, but the UI polls
 * `/api/account` and `/api/accounts` (and every engine checks the balance), and
 * each of those used to be a fresh REST call. Deriv allows 60 REST requests per
 * minute PER TOKEN, and burning that budget on a list that never changes is what
 * left no headroom for the OTP handshake a trade needs — the "rate limit of
 * requests per second" the user saw. One request now serves every caller.
 */
export type DerivAccountList = Array<{
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: string;
  account_type: "demo" | "real";
}>;

const ACCOUNTS_CACHE_TTL_MS = 30_000;
const accountsCache = new Map<string, { value: DerivAccountList; expiresAt: number }>();
const accountsInFlight = new Map<string, Promise<DerivAccountList>>();

function accountsCacheKey(bearerToken: string): string {
  // Token tail is enough to tell accounts apart without keeping the secret in a key.
  return bearerToken.slice(-16);
}

/** Drop the cached account list for a token (after connect/disconnect/switch). */
export function invalidateDerivAccountsCache(bearerToken?: string): void {
  if (!bearerToken) {
    accountsCache.clear();
    return;
  }
  accountsCache.delete(accountsCacheKey(bearerToken));
}

export async function getDerivAccounts(
  bearerToken: string,
  opts: { force?: boolean } = {},
): Promise<DerivAccountList> {
  const key = accountsCacheKey(bearerToken);
  if (!opts.force) {
    const cached = accountsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = accountsInFlight.get(key);
    if (inFlight) return inFlight;
  }

  const request = (async (): Promise<DerivAccountList> => {
    const res = await fetch(`${DERIV_REST_BASE}/trading/v1/options/accounts`, {
      headers: derivHeaders(bearerToken),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        describeDerivHttpFailure("Fetching your Deriv accounts", res.status, text),
      );
    }
    const data = (await res.json()) as any;
    return data.data ?? [];
  })();

  accountsInFlight.set(key, request);
  try {
    const value = await request;
    accountsCache.set(key, { value, expiresAt: Date.now() + ACCOUNTS_CACHE_TTL_MS });
    return value;
  } finally {
    accountsInFlight.delete(key);
  }
}

/**
 * POST /trading/v1/options/accounts/{accountId}/otp
 * Returns a one-time-password WebSocket URL for authenticated trading.
 * The OTP URL is single-use for establishing the WS connection; the connection
 * itself stays alive for multiple messages.
 *
 * Handshakes are serialized process-wide (see otpHandshakeChain): concurrent
 * OTP requests — rapid manual trades, bulk + engine overlap, two accounts
 * trading at once — arrive at Deriv's OTP endpoint as a burst and get
 * 503 CircuitBreakerBusy, and each rejection costs a 1–3 s retry backoff (the
 * "delayed" trades) or a failed execution after 3 attempts (the "missing"
 * ones). One handshake takes ~200–400 ms, so chaining costs milliseconds
 * where a throttle costs seconds. The chain never breaks on rejection.
 */
let otpHandshakeChain: Promise<void> = Promise.resolve();

export async function getOtpWebSocketUrl(
  bearerToken: string,
  accountId: string,
): Promise<string> {
  const previous = otpHandshakeChain;
  let release!: () => void;
  otpHandshakeChain = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fetchOtpWebSocketUrl(bearerToken, accountId);
  } finally {
    release();
  }
}

async function fetchOtpWebSocketUrl(
  initialBearerToken: string,
  accountId: string,
): Promise<string> {
  let bearerToken = initialBearerToken;
  // The OTP endpoint sits behind Cloudflare and returns raw 502 HTML pages or
  // 503 {"errors":[{"code":"CircuitBreakerBusy",...}]} envelopes during brief
  // Deriv health probes. Those recover within seconds, so retry transient
  // failures a few times before surfacing anything — and never leak the raw
  // response body (full HTML pages) into a user-visible error message.
  const maxAttempts = 3;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `${DERIV_REST_BASE}/trading/v1/options/accounts/${accountId}/otp`,
        { method: "POST", headers: derivHeaders(bearerToken) },
      );
    } catch (err) {
      // Network-level failure (DNS, reset, timeout) — transient, retry.
      lastStatus = 0;
      lastBody = err instanceof Error ? err.message : String(err);
      logger.warn({ attempt, maxAttempts, err: lastBody }, "OTP request network error — retrying");
      if (attempt < maxAttempts) {
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(
        "Trading session handshake failed — the connection to Deriv was interrupted. The engine will retry automatically.",
      );
    }

    if (res.ok) {
      const data = await res.json() as any;
      const url: string | undefined = data?.data?.url;
      if (!url) throw new Error("Deriv did not issue a trading session URL — please try again.");
      return url;
    }

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");

    // A 401/403 means the access token lapsed (OAuth tokens last ~1h). Refresh
    // it and retry instead of surfacing "session expired" to a connected user.
    if ((res.status === 401 || res.status === 403) && attempt < maxAttempts) {
      const refreshed = await ensureFreshBearerToken(accountId, bearerToken);
      if (refreshed && refreshed !== bearerToken) {
        bearerToken = refreshed;
        logger.info({ attempt }, "OTP: refreshed expired token — retrying handshake");
        continue;
      }
    }

    if (isTransientDerivFailure(res.status, lastBody) && attempt < maxAttempts) {
      const backoffMs = 1000 * 2 ** (attempt - 1); // 1s → 2s
      logger.warn(
        { attempt, maxAttempts, status: res.status, backoffMs },
        "OTP request hit a transient Deriv failure — retrying before surfacing",
      );
      await sleep(backoffMs);
      continue;
    }

    throw new Error(
      describeDerivHttpFailure("Trading session handshake (OTP)", res.status, lastBody),
    );
  }

  // Unreachable in practice (loop always throws or returns), but keeps types safe.
  throw new Error(
    describeDerivHttpFailure("Trading session handshake (OTP)", lastStatus, lastBody),
  );
}

// ── Market definitions (synthetics only) ──────────────────────────────────────
export const DERIV_MARKETS = [
  // Pip sizes verified from live Deriv prices:
  // R_10  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 4865.826]
  // R_25  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 2592.726]
  // 1HZ15V → pip=0.001 (3 d.p.) → pipSize=3  [confirmed: price like 13222.146]
  // 1HZ25V → pip=0.01  (2 d.p.) → pipSize=2   [confirmed: price like 830197.73]
  // 1HZ30V → pip=0.001 (3 d.p.) → pipSize=3  [confirmed: price like 6527.120]
  // 1HZ90V → pip=0.001 (3 d.p.) → pipSize=3  [confirmed: price like 18528.175]
  // R_50/R_75 → pip=0.0001 (4 d.p.) → pipSize=4
  // R_100/1HZ10V/1HZ50V/1HZ75V/1HZ100V → pip=0.01 (2 d.p.) → pipSize=2
  // ALL Jump indices → pip=0.01 (2 d.p.) → pipSize=2
  { symbol: "R_10",    displayName: "Volatility 10 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_25",    displayName: "Volatility 25 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_50",    displayName: "Volatility 50 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_75",    displayName: "Volatility 75 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_100",   displayName: "Volatility 100 Index",      category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ10V",  displayName: "Volatility 10 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ15V",  displayName: "Volatility 15 (1s) Index",  category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "1HZ25V",  displayName: "Volatility 25 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ30V",  displayName: "Volatility 30 (1s) Index",  category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "1HZ50V",  displayName: "Volatility 50 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ75V",  displayName: "Volatility 75 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ90V",  displayName: "Volatility 90 (1s) Index",  category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "RDBULL",  displayName: "Bull Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "RDBEAR",  displayName: "Bear Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "JD10",    displayName: "Jump 10 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD25",    displayName: "Jump 25 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD50",    displayName: "Jump 50 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD75",    displayName: "Jump 75 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD100",   displayName: "Jump 100 Index",            category: "synthetic", pipSize: 2, digitEnabled: true },
];

/** Markets available for manual trading but blocked from every AI scan/executor. */
export const MANUAL_ONLY_MARKET_SYMBOLS = new Set(["JD100"]);

/** Canonical universe for the main autonomous engine and NeuroAI Quantum FAB. */
export const AUTOMATED_DERIV_MARKETS = DERIV_MARKETS.filter(
  (market) => !MANUAL_ONLY_MARKET_SYMBOLS.has(market.symbol),
);

export function isAutomatedMarket(symbol: string): boolean {
  return !MANUAL_ONLY_MARKET_SYMBOLS.has(symbol) &&
    AUTOMATED_DERIV_MARKETS.some((market) => market.symbol === symbol);
}

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
//
// BUFFER DEPTH IS AN ANALYSIS PARAMETER, NOT A MEMORY DETAIL.
//
// A 300-digit ring buffer silently caps every statistical bot in the codebase:
// a walk-forward replay with a 120-tick burn-in then has ~180 decisions to make,
// and any gate that asks for "24 qualifying shots" can never be satisfied no
// matter how good the market is. Ten thousand digits across twenty symbols is
// 200k numbers — a rounding error in memory — and it is the difference between
// a bot that can be judged and a bot that can only ever say "gathering
// evidence". See `lib/killshot-analysis.ts` for what the depth buys.
/** Ticks the simulated feed pre-seeds per market when Deriv is unreachable. */
const SIM_SEED_TICKS = 3_000;
const TICK_BUFFER_SIZE = 5_000;
const DIGIT_BUFFER_SIZE = 10_000;

// ── Simulated price parameters ────────────────────────────────────────────────
const SIM_PARAMS: Record<string, { base: number; vol: number }> = {
  R_10:    { base: 4865.000,  vol: 0.00018 },
  R_25:    { base: 2592.726,  vol: 0.00035 },
  R_50:    { base: 6200.0000, vol: 0.00065 },
  R_75:    { base: 6800.0000, vol: 0.00095 },
  R_100:   { base: 1800.00,   vol: 0.00140 },
  "1HZ10V":  { base: 1000.00, vol: 0.00018 },
  "1HZ15V":  { base: 1000.00, vol: 0.00024 },
  "1HZ25V":  { base: 1000.00, vol: 0.00035 },
  "1HZ30V":  { base: 1000.00, vol: 0.00042 },
  "1HZ50V":  { base: 1000.00, vol: 0.00065 },
  "1HZ75V":  { base: 1000.00, vol: 0.00095 },
  "1HZ90V":  { base: 1000.00, vol: 0.00120 },
  "1HZ100V": { base: 1000.00, vol: 0.00140 },
  RDBULL:  { base: 5000.0000, vol: 0.00080 },
  RDBEAR:  { base: 5000.0000, vol: 0.00080 },
  JD10:    { base: 1000.00,  vol: 0.00025 },
  JD25:    { base: 1000.00,  vol: 0.00055 },
  JD50:    { base: 1000.00,  vol: 0.00100 },
  JD75:    { base: 1000.00,  vol: 0.00150 },
  JD100:   { base: 1000.00,  vol: 0.00200 },
};

/**
 * Per-tick σ of a simulated index, taken from the index's PUBLISHED annualised
 * volatility and its real tick interval rather than a hand-tuned constant.
 *
 * The `vol` column above is kept only as a display-scale fallback for symbols
 * outside the volatility family; for every Volatility / 1-second / Jump index
 * the real
 * specification is used, because the accumulator bot compares the measured
 * per-tick vol against the volatility implied by a live barrier — a simulator
 * that is 7× too volatile (which the hand-tuned constants were for R_10)
 * makes every such comparison meaningless.
 */
function simulatedSigmaTick(symbol: string): number {
  const specSec = tickSecondsFor(symbol);
  const annual = annualVolFor(symbol);
  const sigma = annual * Math.sqrt(specSec / YEAR_SECONDS);
  if (Number.isFinite(sigma) && sigma > 0) return sigma;
  const fallback = SIM_PARAMS[symbol];
  return fallback ? fallback.vol : 0.0005;
}

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
  /** Epoch (ms) of the last tick BROKER-SIDE, per symbol — the tick-window clock. */
  private lastTickEpochMs = new Map<string, number>();
  private digitTape = new DigitTape();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongMs = Date.now();

  private simInterval: ReturnType<typeof setInterval> | null = null;
  private simPrices = new Map<string, number>();
  /** Last simulated tick time per symbol — keeps each index on its real cadence. */
  private simLastTickMs = new Map<string, number>();
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
    // Process outgoing requests at a controlled rate (20 req/sec max).
    // Unref'd: the queue must never be what keeps the process alive on its own
    // (in production the HTTP server and live sockets always hold the loop, so
    // this changes nothing there; in tests it lets an importing file exit).
    this.queueInterval = setInterval(() => this.processQueue(), 50);
    this.queueInterval.unref();
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

  /** Execution-safe history with a monotonic tick identity and per-symbol provenance. */
  getDigitSnapshot(symbol: string, count = 5000): DigitSnapshot | null {
    return this.digitTape.snapshot(symbol, count);
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

  /**
   * The symbol's current tick window, on the MARKET's clock.
   *
   * A tick contract's entry is decided by the tick that is current when the
   * buy is processed, so two orders processed inside one window are the same
   * trade as far as the market is concerned: same entry tick, same entry digit,
   * same exit tick. The window start is the epoch Deriv stamps on the tick
   * itself (never our receipt time), so a delayed feed cannot shift the
   * boundary. Returns null when the symbol has not ticked yet.
   */
  getTickWindow(
    symbol: string,
  ): { periodMs: number; windowStartMs: number; elapsedMs: number } | null {
    const windowStartMs = this.lastTickEpochMs.get(symbol);
    if (!windowStartMs || !Number.isFinite(windowStartMs)) return null;
    return {
      periodMs: tickSecondsFor(symbol) * 1000,
      windowStartMs,
      elapsedMs: Date.now() - windowStartMs,
    };
  }

  /**
   * Seconds since the last tick arrived for this symbol (Infinity if it has
   * never ticked). Consumers that settle against the NEXT tick — the digit
   * bots — need this to know whether "next" means now or an unknown time after
   * a stalled feed.
   */
  getTickAgeSeconds(symbol: string): number {
    const last = this.lastTickMs.get(symbol);
    return last ? (Date.now() - last) / 1000 : Number.POSITIVE_INFINITY;
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

    if (market.digitEnabled && !this.digitTape.push({
      symbol, price, digit: extractLastDigit(price, market.pipSize), epoch,
      receivedAt: Date.now(), source: "live",
    }, tickSecondsFor(symbol) * 1000)) return;

    if (this.usingSimulated) this.stopSimulation();

    const prices = this.tickBuffers.get(symbol) ?? [];
    prices.push(price);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(symbol, prices);
    this.latestPrices.set(symbol, price);
    this.lastTickMs.set(symbol, Date.now());
    if (Number.isFinite(epoch) && epoch > 0) {
      this.lastTickEpochMs.set(symbol, epoch > 1e11 ? epoch : epoch * 1000);
    }

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
    const simEpochMs = Math.floor(Date.now() / 1000) * 1000;
    this.lastTickEpochMs.set(market.symbol, simEpochMs);
    if (market.digitEnabled) this.digitTape.push({
      symbol: market.symbol, price: rounded, digit: extractLastDigit(rounded, market.pipSize),
      epoch: Math.floor(Date.now() / 1000), receivedAt: Date.now(), source: "simulated",
    }, tickSecondsFor(market.symbol) * 1000);

    const prices = this.tickBuffers.get(market.symbol) ?? [];
    prices.push(rounded);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(market.symbol, prices);
    this.latestPrices.set(market.symbol, rounded);
    // The simulated feed must LOOK like a feed: engines that check tick
    // freshness before entering read this timestamp, and leaving it unset makes
    // the age infinite, which reads as a permanently stalled market and blocks
    // every timing layer in the app whenever Deriv is unreachable.
    this.lastTickMs.set(market.symbol, Date.now());

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

    // Seed a DEEP history, not a token one.
    //
    // Simulated mode is what runs whenever the public WS is unreachable, and the
    // analysis bots now measure themselves on a train/test split of a few
    // thousand digits. Seeding 150 ticks per market left them permanently unable
    // to say anything at all: the round-robin below hands each market roughly one
    // tick per second, so reaching a judgeable window would take hours. This
    // costs a few milliseconds at startup and makes the offline mode behave like
    // the live one.
    for (const market of DERIV_MARKETS) {
      const params = SIM_PARAMS[market.symbol];
      if (!params || !market.digitEnabled) continue;
      this.simPrices.set(market.symbol, params.base);
      const sigmaTick = simulatedSigmaTick(market.symbol);
      let price = params.base;
      for (let i = 0; i < SIM_SEED_TICKS; i++) {
        const delta = price * sigmaTick * this.gaussianRandom();
        price = Math.max(price * 0.5, price + delta);
        this.pushSimulatedTick(market, price);
      }
      this.simPrices.set(market.symbol, price);
    }

    let idx = 0;
    this.simInterval = setInterval(() => {
      const digitMarkets = DERIV_MARKETS.filter((m) => m.digitEnabled);
      const market = digitMarkets[idx % digitMarkets.length];
      idx++;

      const params = SIM_PARAMS[market.symbol];
      if (!params) return;

      // Each index keeps its OWN tick cadence: the 1-second indices tick every
      // second and everything else every 2 seconds. Without this the simulated
      // feed delivered one tick per second for every symbol, which made a
      // 2-second index look 41% more volatile per tick than it is and made every
      // barrier calculation meaningless in offline mode.
      const tickMs = tickSecondsFor(market.symbol) * 1000;
      const now = Date.now();
      const last = this.simLastTickMs.get(market.symbol) ?? 0;
      if (now - last < tickMs) return;
      this.simLastTickMs.set(market.symbol, now);

      const sigmaTick = simulatedSigmaTick(market.symbol);
      let price = this.simPrices.get(market.symbol) ?? params.base;
      const delta = price * sigmaTick * this.gaussianRandom();
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

// ── Deep digit history ────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// ───────────────
// The live ring buffer only holds what has arrived since the process started.
// A bot that must MEASURE its own entry rule before it risks money needs a few
// thousand digits on the first scan, not after an hour of warm-up. Deriv's
// `ticks_history` serves the last 4999 ticks in a single call (5000 is rejected
// outright), so one request per market gives a bot ~4999 digits immediately.
//
// The result is cached per symbol and topped up from the live buffer, so the
// analysis always sees "deep history + everything that has happened since".

const DEEP_HISTORY_MAX = 4999;
const DEEP_HISTORY_TTL_MS = 90_000;
/** One history request may not hold a scan up for longer than this. */
const DEEP_HISTORY_TIMEOUT_MS = 6_000;
/**
 * When the history endpoint is unreachable, STOP ASKING for a while.
 *
 * A scan walks 19 markets, so a per-request timeout is paid 19 times over: at 15
 * seconds each that is a four-minute "scan" that was never going to return
 * anything but the live buffer. After a few consecutive failures the feed is
 * declared unavailable and every caller degrades immediately, which turns the
 * same scan into a few seconds and an honest message.
 */
const DEEP_HISTORY_FAILURES_BEFORE_BACKOFF = 2;
const DEEP_HISTORY_BACKOFF_MS = 60_000;

let deepHistoryFailures = 0;
let deepHistoryBlockedUntil = 0;

function deepHistoryUnavailable(): boolean {
  return Date.now() < deepHistoryBlockedUntil;
}

function noteDeepHistoryFailure() {
  deepHistoryFailures++;
  if (deepHistoryFailures >= DEEP_HISTORY_FAILURES_BEFORE_BACKOFF) {
    deepHistoryBlockedUntil = Date.now() + DEEP_HISTORY_BACKOFF_MS;
  }
}

function noteDeepHistorySuccess() {
  deepHistoryFailures = 0;
  deepHistoryBlockedUntil = 0;
}

interface DeepHistoryEntry {
  digits: number[];
  fetchedAt: number;
  /** Length of the live digit buffer at the moment the history was fetched. */
  liveLenAtFetch: number;
  inFlight?: Promise<number[]> | null;
}

const deepHistoryCache = new Map<string, DeepHistoryEntry>();

async function requestDeepDigits(symbol: string, count: number): Promise<number[]> {
  const market = getMarketInfo(symbol);
  if (!market?.digitEnabled) return [];
  const msg = await tickManager.request(
    {
      ticks_history: symbol,
      count: Math.min(DEEP_HISTORY_MAX, Math.max(100, Math.floor(count))),
      end: "latest",
      style: "ticks",
    },
    DEEP_HISTORY_TIMEOUT_MS,
  );
  const prices: unknown[] | undefined = msg?.history?.prices;
  if (!Array.isArray(prices) || prices.length === 0) return [];
  return prices
    .map((p) => extractLastDigit(Number(p), market.pipSize))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 9);
}

/**
 * Deepest digit history available for a market, most-recent-last.
 *
 * Order of preference:
 *   1. a cached `ticks_history` pull (≤ 4999 digits) topped up with every live
 *      digit that has arrived since the pull,
 *   2. a fresh pull when the cache is cold or stale,
 *   3. the live ring buffer alone if the public WS cannot serve history (e.g.
 *      the feed is running on simulated prices).
 *
 * Never throws and never blocks longer than the WS request timeout — a scan
 * that cannot reach Deriv degrades to the live buffer instead of failing.
 */
export async function getDeepDigits(symbol: string, count = DEEP_HISTORY_MAX): Promise<number[]> {
  const want = Math.min(DEEP_HISTORY_MAX, Math.max(100, Math.floor(count)));
  const live = tickManager.getDigits(symbol, DEEP_HISTORY_MAX);
  const cached = deepHistoryCache.get(symbol);

  const merge = (entry: DeepHistoryEntry): number[] => {
    const grown = Math.max(0, live.length - entry.liveLenAtFetch);
    const tail = grown > 0 ? live.slice(-grown) : [];
    return [...entry.digits, ...tail].slice(-want);
  };

  if (cached && Date.now() - cached.fetchedAt < DEEP_HISTORY_TTL_MS && cached.digits.length > 0) {
    return merge(cached);
  }
  // The feed has already refused this recently — do not pay the timeout again.
  if (deepHistoryUnavailable()) {
    if (cached && cached.digits.length > 0) return merge(cached);
    return live.slice(-want);
  }
  if (cached?.inFlight) {
    try { await cached.inFlight; } catch { /* fall through */ }
    const settled = deepHistoryCache.get(symbol);
    if (settled && settled.digits.length > 0) return merge(settled);
    return live.slice(-want);
  }

  const entry: DeepHistoryEntry = cached ?? { digits: [], fetchedAt: 0, liveLenAtFetch: 0 };
  const liveLenAtFetch = live.length;
  entry.inFlight = requestDeepDigits(symbol, want)
    .then((digits) => {
      if (digits.length > 0) {
        entry.digits = digits;
        entry.fetchedAt = Date.now();
        entry.liveLenAtFetch = liveLenAtFetch;
        noteDeepHistorySuccess();
      } else {
        noteDeepHistoryFailure();
      }
      entry.inFlight = null;
      deepHistoryCache.set(symbol, entry);
      return digits;
    })
    .catch(() => {
      noteDeepHistoryFailure();
      entry.inFlight = null;
      return [];
    });
  deepHistoryCache.set(symbol, entry);

  const fetched = await entry.inFlight;
  if (fetched && fetched.length > 0) return merge(entry);
  return live.slice(-want);
}

/** Drop the cached deep history so the next read re-pulls from Deriv. */
export function invalidateDeepDigits(symbol?: string) {
  if (symbol) deepHistoryCache.delete(symbol);
  else deepHistoryCache.clear();
  deepHistoryFailures = 0;
  deepHistoryBlockedUntil = 0;
}

/** True when deep history is being skipped because the feed keeps refusing it. */
export function deepHistoryDegraded(): boolean {
  return deepHistoryUnavailable();
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
  /**
   * Deriv's own contract start time, in epoch MILLISECONDS (0 when Deriv did
   * not report one). Two legs of one batch that share a start time were opened
   * on the same tick — this is the broker-side proof that a batch really did
   * enter together, and it is what the bulk route reports back to the user.
   */
  startedAtMs?: number;
}

/** One leg of a bulk batch: either a confirmed contract or the rejection reason. */
export type BulkLeg = LiveTradeResult | { error: Error };

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  exitSpot: number;
  sellPrice: number;
  entrySpot: number;
  /** True when the settlement sweep finished without finding this leg's record. */
  missing?: boolean;
  /** Deriv's sell_time in epoch ms (0 when not journalled) — the closing tick. */
  exitedAtMs?: number;
  /** Deriv's purchase_time in epoch ms (0 when not journalled). */
  purchasedAtMs?: number;
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

// Legacy single-session cache is retained only for source compatibility. Live
// request paths use the account-keyed cache below and explicit account ids.
let cachedBalance: number | null = null;
let cachedBalanceAt = 0;
const BALANCE_CACHE_TTL_MS = 60_000;
const balanceCacheByAccount = new Map<string, { balance: number; cachedAt: number }>();

export function setDerivCredentials(bearerToken: string, accountId: string) {
  cachedBearerToken = bearerToken;
  cachedAccountId = accountId;
  cachedBalance = null;
  cachedBalanceAt = 0;
}

// Backward-compatible alias — accepts a Bearer token and optionally an accountId.
export function setDerivToken(token: string, accountId?: string) {
  cachedBearerToken = token;
  if (accountId) cachedAccountId = accountId;
  cachedBalance = null;
  cachedBalanceAt = 0;
}

export function clearDerivToken() {
  cachedBearerToken = null;
  cachedAccountId = null;
  cachedAccountInfo = null;
  cachedBalance = null;
  cachedBalanceAt = 0;
}

export function getCachedAccountInfo() { return cachedAccountInfo; }

/** Returns the active Bearer token (used everywhere a "token" is expected). */
export function getCachedToken(): string | null { return cachedBearerToken; }
export function getCachedBearerToken(): string | null { return cachedBearerToken; }
export function getCachedAccountId(): string | null { return cachedAccountId; }

export function invalidateBalanceCache() {
  cachedBalanceAt = 0;
  balanceCacheByAccount.clear();
}


/**
 * Make sure the Bearer token for an account is still valid, refreshing it with
 * the stored OAuth refresh token when it is about to expire.
 *
 * OAuth access tokens last ~1 hour. Without this, a user who connected with
 * "Sign in with Deriv" was silently signed out an hour later: every Deriv call
 * returned 401 and the app showed the connect screen even though the user had
 * never revoked anything. PAT connections carry no refresh token and never
 * expire, so they are left untouched.
 */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function ensureFreshBearerToken(
  accountId: string,
  bearerToken: string,
): Promise<string> {
  try {
    const { db, accountsTable } = await import("@workspace/db");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(accountsTable)
      .where(eq(accountsTable.derivAccountId, accountId)).limit(1);
    const row = rows[0];
    if (!row) return bearerToken;
    const refreshToken = row.refreshToken;
    if (!refreshToken) return bearerToken; // PAT — never expires
    const expiresAt = row.tokenExpiresAt ? new Date(row.tokenExpiresAt).getTime() : null;
    // Refresh when the expiry is unknown (legacy OAuth rows) or imminent.
    const needsRefresh =
      expiresAt === null || Number.isNaN(expiresAt) || expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS;
    if (!needsRefresh) return bearerToken;

    const refreshed = await refreshOAuthAccessToken(refreshToken);
    const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db.update(accountsTable)
      .set({
        bearerToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiresAt: newExpiry,
        updatedAt: new Date(),
      })
      .where(eq(accountsTable.id, row.id));
    // The account list cache is keyed by token tail — move it to the new token.
    invalidateDerivAccountsCache(bearerToken);
    logger.info({ accountId }, "Deriv OAuth token refreshed — connection kept alive");
    return refreshed.accessToken;
  } catch (err) {
    logger.warn({ err, accountId }, "Deriv token refresh failed — using the existing token");
    return bearerToken;
  }
}

// ── Authenticated connection pool (ONE socket per Deriv account) ──────────────
//
// WHY THIS EXISTS
//
// Deriv's published limits are: 5 concurrent WebSockets per user, 60 REST
// requests per minute per token, 100 messages per second per connection.
//
// The old code opened a BRAND-NEW authenticated WebSocket for every single
// operation — each with its own OTP handshake (a REST call):
//
//     executeLiveTrade()            → OTP + socket
//     waitForContractResult()       → OTP + socket, polling portfolio every 2 s
//     executeBulkLiveTrades()       → OTP + socket
//     waitForBulkContractResults()  → OTP + socket
//     fetchDerivProfitTable()       → OTP + socket
//     DerivJournalManager           → OTP + a permanently held socket
//
// One manual trade therefore cost 2 sockets + 2 REST calls, and a bulk
// batch of legs even more.
// With bots running, several accounts and the journal manager's background
// polling, the app sailed past both the 5-connection ceiling and the 60 REST
// requests/minute budget — which is exactly the Deriv page users reported:
//
//     "You have reached the rate limit of requests per second. Please try later."
//
// THE FIX
//
// Every authenticated operation for an account now shares ONE persistent,
// multiplexed WebSocket. Requests carry a `req_id` and are matched back to
// their promise, subscriptions (transactions) ride along on the same socket,
// and outgoing traffic is paced so the per-connection message rate stays far
// below Deriv's ceiling. A trade costs ZERO extra sockets and ZERO extra REST
// calls, so the app can trade as often as before without approaching a limit.

/** Minimum gap between two outgoing messages on one connection (40 msg/s max). */
const ACCOUNT_SEND_INTERVAL_MS = 25;
/** Default per-request timeout on the pooled socket. */
const ACCOUNT_REQUEST_TIMEOUT_MS = 20_000;
/** How long a RateLimit error pauses the outgoing queue. */
const ACCOUNT_RATE_LIMIT_PAUSE_MS = 2_000;
/** Tear a connection down when it has been idle this long (frees the slot). */
const ACCOUNT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function isRateLimitError(msg: any): boolean {
  const code = String(msg?.error?.code ?? "");
  const text = String(msg?.error?.message ?? "").toLowerCase();
  return code === "RateLimit" || text.includes("rate limit");
}

/** Guards run at socket-send time, AFTER connection, throttling and queue waits. */
export interface AccountRequestHooks {
  beforeSend?: () => void;
  /** Conservatively called immediately before handing the message to the socket. */
  onSent?: () => void;
}

class DerivAccountConnection extends EventEmitter {
  readonly accountId: string;
  private bearerToken: string;
  private ws: WebSocket | null = null;
  private nextReqId = 1;
  private pending = new Map<
    number,
    { resolve: (msg: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private sendQueue: Array<() => void> = [];
  private queueTimer: ReturnType<typeof setInterval> | null = null;
  private lastSendMs = 0;
  private pausedUntil = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private lastPongMs = Date.now();
  private connecting: Promise<void> | null = null;
  private closed = false;
  /** Subscriptions that must be re-sent after a reconnect. */
  private subscriptions: Array<Record<string, unknown>> = [];

  constructor(accountId: string, bearerToken: string) {
    super();
    this.accountId = accountId;
    this.bearerToken = bearerToken;
    this.setMaxListeners(0);
    this.queueTimer = setInterval(() => this.processQueue(), ACCOUNT_SEND_INTERVAL_MS);
    this.queueTimer.unref?.();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Swap in a freshly refreshed Bearer token without dropping the socket. */
  setToken(token: string): void {
    this.bearerToken = token;
  }

  /**
   * Send a BATCH of messages back-to-back inside one event-loop turn.
   *
   * THE BUG THIS FIXES (bulk trades): this connection paces ordinary traffic at
   * one message per `ACCOUNT_SEND_INTERVAL_MS` (25 ms) — a deliberate guard that
   * keeps the app under Deriv's per-connection message ceiling. But the bulk
   * executor's whole contract is "every leg leaves in the SAME millisecond", and
   * it rode `send()`, which is that same paced queue. So a 10-leg batch was
   * really emitted at 0/25/50/…/225 ms for the quotes and again at 25 ms per buy,
   * i.e. the batch straddled tick boundaries exactly as if it had been staggered
   * on purpose — legs opened on different ticks, different entry digits, and
   * closed seconds apart. The "one unscheduled burst" comment was only true on
   * the injected test socket; in production every batch went through the queue.
   *
   * A burst writes straight to the socket, in order, without touching the paced
   * queue — one turn, one millisecond, one tick. It is bounded by construction
   * (the bulk executor caps a batch at 10 legs × 2 phases), so a burst of ≤ 20
   * messages stays far below the 100 msg/s per-connection limit the pacing
   * exists to respect, and the pacing simply resumes afterwards.
   */
  burst(messages: Array<Record<string, unknown>>, hooks?: AccountRequestHooks): number {
    if (!this.isOpen()) return 0;
    let sent = 0;
    for (const message of messages) {
      try {
        hooks?.beforeSend?.();
        this.sendNow(message);
        hooks?.onSent?.();
        sent++;
      } catch (err) {
        logger.warn(
          { err, accountId: this.accountId, sent, of: messages.length },
          "AccountConnection: burst aborted mid-batch",
        );
        break;
      }
    }
    return sent;
  }

  /** Tail of the token this connection was opened with (identity check only). */
  tokenTail(): string {
    return this.bearerToken.slice(-12);
  }

  /** Adopt a refreshed token: use it for the next handshake/refresh. */
  adoptToken(token: string): void {
    this.bearerToken = token;
  }

  /** Send and wait for the response carrying this request's `req_id`. */
  async request(msg: Record<string, unknown>, timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS, hooks?: AccountRequestHooks): Promise<any> {
    await this.ensureConnected();
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(reqId, { resolve, timer });
      this.enqueue(() => {
        // A request which timed out while throttled MUST NOT be sent later.
        // This is especially important for a buy whose caller has already stopped.
        if (!this.pending.has(reqId)) return;
        if (!this.isOpen()) {
          const entry = this.pending.get(reqId);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(reqId);
            resolve(null);
          }
          return;
        }
        try {
          hooks?.beforeSend?.();
          hooks?.onSent?.();
          this.sendNow({ ...msg, req_id: reqId });
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(reqId);
          reject(error);
        }
      });
    });
  }

  /** Subscribe (no req_id) and remember it for automatic re-subscription. */
  async subscribe(msg: Record<string, unknown>): Promise<void> {
    this.subscriptions.push(msg);
    await this.send(msg);
  }

  /** One-shot send without a response binding. */
  async send(msg: Record<string, unknown>): Promise<void> {
    await this.ensureConnected();
    await new Promise<void>((resolve) => {
      this.enqueue(() => {
        if (this.isOpen()) this.sendNow(msg);
        resolve();
      });
    });
  }

  private sendNow(payload: Record<string, unknown>): void {
    if (!this.isOpen()) return;
    this.lastSendMs = Date.now();
    this.touchIdle();
    try {
      this.ws!.send(JSON.stringify(payload));
    } catch (err) {
      logger.debug({ err, accountId: this.accountId }, "AccountConnection: send failed");
    }
  }

  private enqueue(task: () => void): void {
    this.sendQueue.push(task);
    this.processQueue();
  }

  private processQueue(): void {
    if (Date.now() < this.pausedUntil) return;
    if (!this.isOpen()) return;
    if (this.sendQueue.length === 0) return;
    if (Date.now() - this.lastSendMs < ACCOUNT_SEND_INTERVAL_MS) return;
    const task = this.sendQueue.shift();
    try {
      task?.();
    } catch {
      /* ignore */
    }
  }

  private touchIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      // No traffic for a while — give the connection slot back to Deriv.
      if (this.pending.size === 0 && this.listenerCount("message") === 0) this.destroy();
    }, ACCOUNT_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error("This trading connection was closed.");
    if (this.isOpen()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    let otpUrl: string;
    try {
      // Refresh an expiring OAuth token BEFORE the handshake, so a long-lived
      // app never gets logged out an hour into a session.
      this.bearerToken = await ensureFreshBearerToken(this.accountId, this.bearerToken);
      otpUrl = await getOtpWebSocketUrl(this.bearerToken, this.accountId);
    } catch (err) {
      this.scheduleReconnect();
      throw err instanceof Error ? err : new Error("Trading session handshake failed");
    }
    if (this.closed) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(otpUrl, { perMessageDeflate: false });
      } catch (err) {
        reject(err instanceof Error ? err : new Error("WebSocket creation failed"));
        return;
      }
      this.ws = ws;

      const openTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.terminate(); } catch { /* ignore */ }
        reject(new Error("Trading connection timed out"));
      }, 15_000);

      ws.on("open", () => {
        this.reconnectDelay = 1_000;
        this.emit("open");
        this.lastPongMs = Date.now();
        this.startPing();
        this.touchIdle();
        // Restore subscriptions (transaction feed) after every reconnect so the
        // journal keeps updating in real time without a new handshake.
        for (const sub of this.subscriptions) {
          try { ws.send(JSON.stringify(sub)); } catch { /* ignore */ }
        }
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          resolve();
        }
      });

      ws.on("message", (data) => this.handleMessage(data));

      ws.on("error", (err) => {
        logger.debug({ msg: (err as Error).message, accountId: this.accountId },
          "AccountConnection: socket error");
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          reject(err instanceof Error ? err : new Error("Trading connection error"));
        }
      });

      ws.on("close", () => {
        this.stopPing();
        this.ws = null;
        this.failPending();
        // A batch riding this socket must learn that the pipe it was using is
        // gone, so it can re-propose over the reconnected one instead of
        // waiting out its deadline and reporting a failure for legs that were
        // never sent. Ordinary request/response callers are unaffected (the
        // pool reconnects transparently and their promise times out or retries).
        this.emit("dropped");
        if (!settled) {
          settled = true;
          clearTimeout(openTimeout);
          reject(new Error("Trading connection closed before it was ready"));
        }
        if (!this.closed) this.scheduleReconnect();
      });
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.lastPongMs = Date.now();

    if (msg.req_id !== undefined && msg.req_id !== null) {
      const entry = this.pending.get(Number(msg.req_id));
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(Number(msg.req_id));
        entry.resolve(msg);
      }
    }

    if (isRateLimitError(msg)) {
      // Deriv's throttle applies to the whole account: pause EVERYTHING for a
      // moment rather than hammering the same limit with retries.
      this.pausedUntil = Date.now() + ACCOUNT_RATE_LIMIT_PAUSE_MS;
      logger.warn({ accountId: this.accountId, echo: msg.echo_req },
        "AccountConnection: Deriv rate limit — pausing outgoing traffic");
    }

    if (msg.msg_type === "ping") {
      try { this.ws?.send(JSON.stringify({ pong: 1 })); } catch { /* ignore */ }
    }

    // Everything else (transaction / profit_table pushes) goes to subscribers.
    this.emit("message", msg);
  }

  private failPending(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    this.pending.clear();
    this.sendQueue = [];
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 60_000) {
        logger.debug({ accountId: this.accountId }, "AccountConnection: no pong — reconnecting");
        try { this.ws?.terminate(); } catch { /* ignore */ }
        return;
      }
      try { this.ws?.send(JSON.stringify({ ping: 1 })); } catch { /* ignore */ }
    }, 25_000);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 30_000);
      void this.ensureConnected().catch(() => {
        /* connect() already scheduled the next attempt */
      });
    }, this.reconnectDelay);
    this.reconnectTimer.unref?.();
  }

  destroy(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.queueTimer) { clearInterval(this.queueTimer); this.queueTimer = null; }
    this.failPending();
    try { this.ws?.terminate(); } catch { /* ignore */ }
    this.ws = null;
    this.removeAllListeners();
  }
}

// One connection per Deriv account id. Account ids are globally unique, so
// different browser sessions connecting the SAME Deriv account share one socket
// — correct, because Deriv's connection limit is per USER, not per browser.
const accountConnections = new Map<string, DerivAccountConnection>();

/**
 * The pooled, persistent authenticated connection for an account.
 *
 * Keyed by ACCOUNT ID ALONE — never by token. When an OAuth token is refreshed
 * mid-session the same connection simply adopts the new token; keying by token
 * would open a second socket for the same account and eat into Deriv's
 * 5-concurrent-WebSockets-per-user budget.
 */
export function getAccountConnection(
  bearerToken: string,
  accountId: string,
): DerivAccountConnection {
  let conn = accountConnections.get(accountId);
  if (!conn) {
    conn = new DerivAccountConnection(accountId, bearerToken);
    accountConnections.set(accountId, conn);
  } else if (bearerToken && bearerToken !== conn.tokenTail()) {
    conn.adoptToken(bearerToken);
  }
  return conn;
}

/** Drop pooled connections for one account, or every account when omitted. */
export function closeAccountConnections(accountId?: string): void {
  if (accountId) {
    const conn = accountConnections.get(accountId);
    if (conn) {
      conn.destroy();
      accountConnections.delete(accountId);
    }
    return;
  }
  for (const conn of accountConnections.values()) conn.destroy();
  accountConnections.clear();
}

/** Number of live authenticated sockets — exposed for diagnostics/healthz. */
export function accountConnectionCount(): number {
  let open = 0;
  for (const conn of accountConnections.values()) if (conn.isOpen()) open++;
  return open;
}

async function accountRequest(
  bearerToken: string,
  accountId: string,
  msg: Record<string, unknown>,
  timeoutMs = ACCOUNT_REQUEST_TIMEOUT_MS,
): Promise<any> {
  return getAccountConnection(bearerToken, accountId).request(msg, timeoutMs);
}

/**
 * The small subset of a broker ACCU contract specification that the bot needs
 * before it can form a proposal. The fields are deliberately optional because
 * Deriv has returned different `contracts_for` shapes during the API
 * transition; the live proposal remains authoritative when a value is present.
 */
export interface AccumulatorContractSpec {
  symbol: string;
  available: boolean;
  minDurationTicks?: number;
  maxDurationTicks?: number;
  /**
   * Per-growth-rate tick caps when the broker reports them separately.
   * ACCU max duration SHRINKS as the growth rate rises (5% allows far
   * fewer ticks than 1%), so a single global max is only a ceiling.
   */
  maxTicksByGrowth?: Record<string, number>;
  growthRates: number[];
  barrierPct?: number;
  source: "broker" | "fallback";
}

/**
 * Discover ACCU limits without opening a second authenticated socket. Public
 * market metadata is enough for the catalogue; authenticated callers may pass
 * credentials when their account-specific stake/contract limits are relevant.
 */
export async function discoverAccumulatorContractSpec(
  symbol: string,
  currency = "USD",
  bearerToken?: string,
  accountId?: string,
): Promise<AccumulatorContractSpec> {
  const fallback: AccumulatorContractSpec = {
    symbol,
    available: true,
    growthRates: [0.01, 0.02, 0.03, 0.04, 0.05],
    source: "fallback",
  };
  try {
    const msg = bearerToken && accountId
      ? await accountRequest(bearerToken, accountId, {
          contracts_for: symbol,
          product_type: "basic",
          currency,
        }, 10_000)
      : await tickManager.request({
          contracts_for: symbol,
          product_type: "basic",
          currency,
        }, 10_000);
    if (!msg || msg.error) return fallback;

    const rows = [
      ...(Array.isArray(msg.contracts_for?.available) ? msg.contracts_for.available : []),
      ...(Array.isArray(msg.contracts_for?.contracts) ? msg.contracts_for.contracts : []),
      ...(Array.isArray(msg.available) ? msg.available : []),
    ] as any[];
    // ACCU may appear once, or once per growth rate — collect every row so
    // per-growth tick caps survive discovery.
    const accuRows = rows.filter((row) => String(row.contract_type ?? row.contractType ?? "").toUpperCase() === "ACCU");
    if (!accuRows.length) return { ...fallback, available: false };

    const toNumber = (value: unknown): number | undefined => {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    };
    // The Deriv contracts_for payload reports duration limits as
    // `min_contract_duration` / `max_contract_duration` (tick counts for
    // ACCU). The old code read `min_duration`/`max_duration`, which the API
    // never sends — so the engine believed it had no broker bounds and the
    // exchange rejected every buy with "Invalid input (duration or
    // date_expiry)". Legacy names are kept as fallbacks for older payloads.
    const readMin = (row: any) => toNumber(row.min_contract_duration ?? row.min_duration ?? row.minimum_duration ?? row.min_ticks);
    const readMax = (row: any) => toNumber(row.max_contract_duration ?? row.max_duration ?? row.maximum_duration ?? row.max_ticks);
    const readGrowth = (row: any) => {
      const raw = row.growth_rate ?? row.growthRate;
      const n = toNumber(raw);
      return n === undefined ? undefined : (n > 1 ? n / 100 : n);
    };
    const readBarrier = (row: any) => toNumber(row.barrier ?? row.dynamic_barrier ?? row.barrier_pct);

    const allMins = accuRows.map(readMin).filter((n): n is number => n !== undefined);
    const allMaxes = accuRows.map(readMax).filter((n): n is number => n !== undefined);
    const allGrowthRows = accuRows
      .map((row) => ({ growth: readGrowth(row), max: readMax(row) }))
      .filter((r): r is { growth: number; max: number } => r.growth !== undefined && r.growth >= 0.01 && r.growth <= 0.05 && r.max !== undefined);
    const maxTicksByGrowth: Record<string, number> | undefined =
      allGrowthRows.length >= 2
        ? Object.fromEntries(allGrowthRows.map((r) => [String(r.growth), r.max]))
        : undefined;
    const ratesFromRows = accuRows
      .map((row) => (Array.isArray(row.growth_rate ?? row.growth_rates) ? (row.growth_rate ?? row.growth_rates) : [readGrowth(row)]))
      .flat()
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x))
      .map((x) => x > 1 ? x / 100 : x)
      .filter((x) => x >= 0.01 && x <= 0.05);
    const barrier = accuRows.map(readBarrier).find((n) => n !== undefined);
    return {
      symbol,
      available: true,
      minDurationTicks: allMins.length ? Math.min(...allMins) : undefined,
      maxDurationTicks: allMaxes.length ? Math.min(...allMaxes) : undefined,
      maxTicksByGrowth,
      growthRates: ratesFromRows.length ? [...new Set(ratesFromRows)] : fallback.growthRates,
      barrierPct: barrier !== undefined ? (barrier > 1 ? barrier / 100 : barrier) : undefined,
      source: "broker",
    };
  } catch (err) {
    logger.debug({ err, symbol }, "Accumulator contract discovery unavailable — using conservative fallback");
    return fallback;
  }
}

/** Request the current state of an open ACCU contract through the pooled socket. */
export async function getAccumulatorOpenContract(
  bearerToken: string,
  accountId: string,
  contractId: number,
): Promise<any | null> {
  if (!bearerToken || !accountId || !Number.isFinite(contractId)) return null;
  const msg = await accountRequest(bearerToken, accountId, {
    proposal_open_contract: 1,
    contract_id: contractId,
    subscribe: 0,
  }, 12_000);
  if (!msg || msg.error) return null;
  return msg.proposal_open_contract ?? null;
}

/**
 * Ask Deriv to close an open contract at the current bid. This helper is
 * intentionally idempotent: an exchange-side take-profit/knockout can win the
 * race with the local adverse-condition close, so callers may safely retry or
 * simply accept a null/already-settled response.
 */
export async function sellAccumulatorContract(
  bearerToken: string,
  accountId: string,
  contractId: number,
): Promise<any | null> {
  if (!bearerToken || !accountId || !Number.isFinite(contractId)) return null;
  const msg = await accountRequest(bearerToken, accountId, {
    sell: contractId,
    price: 0,
  }, 12_000);
  if (!msg || msg.error) return null;
  return msg.sell ?? msg;
}


/**
 * `ws`-shaped façade over a pooled connection.
 *
 * The bulk executor and (historically) the journal manager were written against
 * a raw `ws` object. Rather than rewrite their battle-tested message routing,
 * they receive this adapter: `send`/`on("message")`/`readyState` behave exactly
 * like the socket they expect, but every call lands on the ONE pooled
 * connection for the account, and `close()` is a no-op so a finished batch does
 * not tear the connection down for the next one.
 */
export interface PooledSocket {
  readonly readyState: number;
  readonly isOpen: () => boolean;
  send(payload: Record<string, unknown> | string): void;
  /**
   * Submit several messages as ONE atomic burst — same event-loop turn, same
   * millisecond, no queue pacing. This is the primitive the bulk executor
   * commits a batch with; see `DerivAccountConnection.burst`.
   */
  burst(messages: Array<Record<string, unknown>>): number;
  on(event: "message", cb: (data: { toString(): string }) => void): void;
  on(event: "open", cb: () => void): void;
  // Kept for the bulk executor's batch-fatal error handling. On a pooled
  // connection there is nothing to tear down (the pool owns reconnection), and
  // on a directly-opened test socket these are wired to the real events.
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "close", cb: () => void): void;
  /** Underlying transport dropped. Subscribe to re-propose in-flight work. */
  on(event: "dropped", cb: () => void): void;
  off(event: "message", cb: (data: { toString(): string }) => void): void;
  off(event: "dropped", cb: () => void): void;
  close(): void;
  terminate(): void;
  readonly connection: DerivAccountConnection;
}


/**
 * Connect straight to a WebSocket URL and expose the same façade as
 * `getPooledSocket`. Used only by callers that inject their own URL (tests).
 */
async function openDirectSocket(url: string): Promise<PooledSocket> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  // Buffer anything sent before the socket is up, and remember the "open"
  // transition so a listener registered afterwards still fires.
  let opened = false;
  const preOpenQueue: string[] = [];
  socket.once("open", () => {
    opened = true;
    for (const pending of preOpenQueue.splice(0)) {
      try { socket.send(pending); } catch { /* ignore */ }
    }
  });
  return {
    get readyState() {
      return socket.readyState;
    },
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send(payload) {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
      else if (opened) { /* closing */ }
      else preOpenQueue.push(text);
    },
    on(event: "message" | "open" | "error" | "close" | "dropped", cb: any) {
      if (event === "open" && socket.readyState === WebSocket.OPEN) {
        queueMicrotask(cb);
        return;
      }
      // A direct socket has exactly one drop event; the executor listens for
      // `dropped` (the pooled façade's name for it) so both transports behave
      // identically.
      socket.on(event === "dropped" ? "close" : event, cb);
    },
    burst(messages) {
      let sent = 0;
      for (const message of messages) {
        try {
          socket.send(JSON.stringify(message));
          sent++;
        } catch {
          break;
        }
      }
      return sent;
    },
    off(event, cb) {
      socket.off(event === "dropped" ? "close" : event, cb);
    },
    close() {
      try { socket.close(); } catch { /* ignore */ }
    },
    terminate() {
      try { socket.terminate(); } catch { /* ignore */ }
    },
    connection: null as unknown as DerivAccountConnection,
  };
}

export async function getPooledSocket(
  bearerToken: string,
  accountId: string,
): Promise<PooledSocket> {
  const connection = getAccountConnection(bearerToken, accountId);
  await connection.ensureConnected();
  // The message listener handed to the connection is a WRAPPER (Deriv messages
  // are objects; `ws` callers expect a Buffer-like). Remember it per callback so
  // `off()` removes the wrapper that was actually registered — otherwise every
  // finished batch would leave a listener on the shared connection forever,
  // which both leaks memory and stops the connection ever reaching its idle
  // teardown (the listener count is part of that decision).
  const messageWrappers = new WeakMap<object, (msg: any) => void>();
  return {
    get readyState() {
      return connection.isOpen() ? WebSocket.OPEN : WebSocket.CLOSED;
    },
    isOpen: () => connection.isOpen(),
    send(payload) {
      const msg = typeof payload === "string" ? JSON.parse(payload) : payload;
      void connection.send(msg);
    },
    burst(messages) {
      return connection.burst(messages);
    },
    on(event: "message" | "open" | "error" | "close" | "dropped", cb: any) {
      if (event === "message") {
        const wrapper = (msg: any) => cb({ toString: () => JSON.stringify(msg) });
        messageWrappers.set(cb, wrapper);
        connection.on("message", wrapper);
      } else if (event === "open") {
        // The caller registers this AFTER awaiting us, by which time the pooled
        // socket is usually already open — so replay it instead of hanging.
        if (connection.isOpen()) queueMicrotask(cb);
        else connection.on("open", cb);
      } else if (event === "dropped") {
        // The pool reconnects transparently, but an in-flight BATCH has to know:
        // its unconfirmed legs must be re-proposed on the fresh socket rather
        // than left to time out (the reported "bulk trades did nothing").
        connection.on("dropped", cb);
      }
      // A pooled connection never errors or closes underneath a single caller:
      // the pool transparently reconnects, so those events are intentionally
      // not forwarded (a batch must not be declared dead by a transient drop).
    },
    off(event: "message" | "dropped", cb: any) {
      if (event === "message") {
        const wrapper = messageWrappers.get(cb as object);
        if (wrapper) {
          connection.off("message", wrapper);
          messageWrappers.delete(cb as object);
        }
        return;
      }
      connection.off(event, cb);
    },
    close() {
      /* pooled: never close on behalf of one caller */
    },
    terminate() {
      /* pooled: never terminate on behalf of one caller */
    },
    connection,
  };
}

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
/**
 * How many durable journal rows a cold start reads back. High enough to cover
 * any realistic history for display, bounded so the read stays fast.
 */
const JOURNAL_DB_ROW_LIMIT = 5_000;

class DerivJournalManager extends EventEmitter {
  private sock: PooledSocket | null = null;
  private bearerToken: string | null = null;
  private accountId: string | null = null;
  private cachedTransactions: any[] = [];
  private lastFetchMs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private firstFetchTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** True once the pooled socket listener is attached (never attach twice). */
  private listening = false;
  /** True once this manager has hydrated its cache from Postgres. */
  private hydratedFromDb = false;
  /** Tracks the highest transaction_id we've already cached — used for incremental refresh
   *  so we only fetch NEW trades instead of re-fetching the entire history every time. */
  private lastKnownTransactionId = 0;
  /** Whether we have ever done a full initial paginated fetch (needed before incremental works) */
  private hasDoneInitialFetch = false;
  /** Self-healing backfill state: while a detail-repair profit_table fetch is outstanding */
  private backfillInFlight = false;
  private lastBackfillSentMs = 0;

  /**
   * Self-healing backfill: if the cache holds transactions whose payload lacks
   * display details (longcode/underlying_symbol — e.g. hydrated from rows
   * written by an incomplete snapshot), re-fetch the last 24 h of profit_table
   * with full descriptions and upsert them. Rate-limited to one request every
   * 60 s and never while a paginated chain is running, so trading is unaffected.
   */
  private maybeScheduleBackfill(): void {
    const now = Date.now();
    // Stuck-request safety: a lost/never-answered backfill response releases
    // the flag after 30 s so healing can retry.
    if (this.backfillInFlight && now - this.lastBackfillSentMs > 30_000) {
      this.backfillInFlight = false;
    }
    if (this.backfillInFlight || this.isFetchingPages || !this.sock?.isOpen()) return;
    if (now - this.lastBackfillSentMs < 60_000) return;
    const missing = this.cachedTransactions.filter((t: any) => !DerivJournalManager.hasFullDetail(t)).length;
    if (missing === 0) return;
    this.backfillInFlight = true;
    this.lastBackfillSentMs = now;
    const dateFrom = Math.floor((now - 24 * 60 * 60 * 1000) / 1000);
    this.sock.send({
      profit_table: 1, description: 1, sort: "DESC", limit: 500, date_from: dateFrom,
      passthrough: { backfill: true },
    });
    logger.info({ missing }, "JournalManager: detail backfill requested (last 24h)");
  }

  setCredentials(bearerToken: string, accountId: string) {
    const changed = this.bearerToken !== bearerToken || this.accountId !== accountId;
    this.bearerToken = bearerToken;
    this.accountId = accountId;
    if (changed) {
      // Clear stale cache from the previous account immediately so the journal
      // doesn't briefly show the wrong account's trades after switching. The
      // durable copy in Postgres is re-read per account (see hydrateFromDb).
      this.cachedTransactions = [];
      this.fetchAccumulator = [];
      this.isFetchingPages = false;
      this.lastFetchMs = 0;
      this.lastRefreshSentMs = 0;
      this.lastQuickRefreshSentMs = 0;
      this.hydratedFromDb = false;
      this.lastKnownTransactionId = 0;
      this.hasDoneInitialFetch = false;
      this.backfillInFlight = false;
      this.lastBackfillSentMs = 0;
      // Emit empty immediately so the frontend journal shows "loading" state
      this.emit("refreshed", []);
      this.detach();
    }
    void this.connect();
  }

  // Backward-compat: accept PAT token only (no accountId → can't use the pool)
  setToken(token: string) {
    logger.info("JournalManager.setToken: token stored; awaiting accountId for the pooled connection.");
    this.bearerToken = token;
  }

  clearCredentials() {
    this.bearerToken = null;
    this.accountId = null;
    this.cachedTransactions = [];
    this.fetchAccumulator = [];
    this.lastFetchMs = 0;
    this.hydratedFromDb = false;
    this.detach();
    logger.info("JournalManager: credentials cleared");
  }

  getCached(): any[] { return this.cachedTransactions; }

  isCacheFresh(maxAgeMs = 120_000): boolean {
    return this.lastFetchMs > 0 && (Date.now() - this.lastFetchMs) < maxAgeMs;
  }

  /** True once the on-disk (Postgres) journal has been read for this account. */
  hasHydrated(): boolean { return this.hydratedFromDb; }

  /**
   * Seed the in-memory cache from the durable journal table.
   *
   * This is what survives a redeploy: the process's memory is gone but the
   * trades are on disk, so the journal is populated the instant the page loads
   * instead of showing "no trades" until Deriv has been re-paginated (which a
   * rate limit can delay by minutes — the reported "my journal data vanished").
   */
  async hydrateFromDb(sessionId: string): Promise<void> {
    if (!this.accountId) return;
    this.hydratedFromDb = true;
    try {
      const { db, derivJournalTable } = await import("@workspace/db");
      const { and, desc, eq } = await import("drizzle-orm");
      const rows = await db.select().from(derivJournalTable)
        .where(and(
          eq(derivJournalTable.sessionId, sessionId),
          eq(derivJournalTable.accountId, this.accountId),
        ))
        .orderBy(desc(derivJournalTable.purchaseTime))
        .limit(JOURNAL_DB_ROW_LIMIT);
      if (rows.length === 0) return;
      // Never overwrite fresher live data with the disk snapshot.
      if (this.cachedTransactions.length >= rows.length) return;
      const parsed: any[] = [];
      for (const row of rows) {
        try {
          parsed.push(JSON.parse(row.payloadJson));
        } catch { /* skip corrupt row */ }
      }
      this.cachedTransactions = parsed;
      this.lastFetchMs = Date.now();
      logger.info({ count: parsed.length }, "JournalManager: hydrated journal from durable store");
      this.emit("refreshed", this.cachedTransactions);
      // Rows restored from disk may predate a detail-less snapshot — kick the
      // self-healing backfill so incomplete payloads get repaired automatically.
      this.maybeScheduleBackfill();
    } catch (err) {
      logger.debug({ err }, "JournalManager: journal hydration skipped");
    }
  }

  /** True if a profit_table transaction carries the display-critical details
   *  (longcode → market/contract/barrier, underlying_symbol → market name).
   *  Incomplete snapshots (from foreign/shared-socket profit_table responses)
   *  must never be persisted over complete ones. */
  private static hasFullDetail(t: any): boolean {
    return typeof t?.longcode === "string" && t.longcode.length > 0 && !!t?.underlying_symbol;
  }

  /**
   * Write transactions through to the durable journal.
   * Fire-and-forget: the UI must never wait on (or fail because of) persistence.
   * Incomplete transactions (missing longcode/symbol) are SKIPPED — writing them
   * would overwrite complete payloads already on disk (the reported "older
   * journal rows lose their market/contract details"). A later fetch of the
   * same transaction with full details upserts the complete payload instead.
   */
  private persistTransactions(sessionId: string | null, txs: any[]): void {
    if (!sessionId || txs.length === 0 || !this.accountId) return;
    const complete = txs.filter((tx) => DerivJournalManager.hasFullDetail(tx));
    if (complete.length === 0) return;
    const accountId = this.accountId;
    void (async () => {
      try {
        const { pool } = await import("@workspace/db");
        for (const tx of complete) {
          const transactionId = String(tx.transaction_id ?? tx.contract_id ?? "");
          if (!transactionId) continue;
          await pool.query(
            `INSERT INTO deriv_journal
               (session_id, account_id, transaction_id, contract_id, symbol, contract_type,
                buy_price, sell_price, purchase_time, sell_time, payload_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (session_id, account_id, transaction_id) DO UPDATE
               SET sell_price = EXCLUDED.sell_price,
                   sell_time  = EXCLUDED.sell_time,
                   payload_json = EXCLUDED.payload_json`,
            [
              sessionId, accountId, transactionId,
              tx.contract_id != null ? String(tx.contract_id) : null,
              tx.underlying_symbol ?? null,
              tx.contract_type ?? null,
              tx.buy_price != null ? String(tx.buy_price) : null,
              tx.sell_price != null ? String(tx.sell_price) : null,
              tx.purchase_time != null ? Number(tx.purchase_time) : null,
              tx.sell_time != null ? Number(tx.sell_time) : null,
              JSON.stringify(tx),
            ],
          );
        }
      } catch (err) {
        logger.debug({ err }, "JournalManager: durable journal write skipped");
      }
    })();
  }

  /** Transactions this manager knows about, tagged with their owning session. */
  private get sessionId(): string | null {
    return this._sessionId;
  }

  private _sessionId: string | null = null;

  /** Bind the manager to a browser session so writes land in the right scope. */
  bindSession(sessionId: string) { this._sessionId = sessionId; }

  /**
   * Quick refresh: fetches only the last 10 trades and MERGES them into the
   * existing cache. Used after real-time transaction `sell` events so the
   * journal reflects the settled contract within ~1-2 seconds, without waiting
   * for a full paginated profit_table chain. Rate-limited to once every 3 s.
   */
  forceQuickRefresh() {
    if (!this.sock?.isOpen()) return;
    const now = Date.now();
    if (now - this.lastQuickRefreshSentMs < DerivJournalManager.MIN_QUICK_REFRESH_MS) {
      logger.debug({ msSinceLast: now - this.lastQuickRefreshSentMs }, "JournalManager: quickRefresh skipped (rate-limit)");
      return;
    }
    this.lastQuickRefreshSentMs = now;
    // passthrough echoed back in the response so we can distinguish quick vs full
    this.sock.send({
      profit_table: 1, description: 1, sort: "DESC", limit: 10,
      passthrough: { quick: true },
    });
    logger.debug("JournalManager: quick refresh sent (limit 10)");
  }

  forceRefresh() {
    if (!this.sock?.isOpen()) return;
    // Block new chains while a paginated fetch is already in progress.
    if (this.isFetchingPages) {
      logger.debug("JournalManager: forceRefresh skipped (pagination in progress)");
      return;
    }
    const now = Date.now();
    if (now - this.lastRefreshSentMs < DerivJournalManager.MIN_REFRESH_INTERVAL_MS) {
      logger.debug({ msSinceLast: now - this.lastRefreshSentMs }, "JournalManager: forceRefresh skipped (rate-limit guard)");
      return;
    }
    this.lastRefreshSentMs = now;

    // INCREMENTAL REFRESH: After the initial full fetch, only fetch the 10 most
    // recent trades and merge them. This avoids re-fetching the entire history
    // (which drains Deriv's rate limits and causes "rate limit" errors).
    if (this.hasDoneInitialFetch && this.cachedTransactions.length > 0 && this.lastKnownTransactionId > 0) {
      logger.debug({ lastId: this.lastKnownTransactionId }, "JournalManager: incremental refresh (limit 10, merge mode)");
      this.sock.send({ profit_table: 1, description: 1, sort: "DESC", limit: 10, passthrough: { quick: true, incremental: true } });
      return;
    }

    // FULL INITIAL FETCH: paginated fetch of all trades (only on first connect).
    // passthrough.chain marks every response as OURS so the message handler can
    // distinguish it from foreign profit_table responses on the shared socket.
    this.isFetchingPages = true;
    this.fetchAccumulator = [];
    this.sock.send({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT, passthrough: { chain: true } });
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.txDebounceTimer) { clearTimeout(this.txDebounceTimer); this.txDebounceTimer = null; }
    if (this.firstFetchTimer) { clearTimeout(this.firstFetchTimer); this.firstFetchTimer = null; }
  }

  /** Detach from the pooled socket: stop timers and remove our listener only. */
  private detach() {
    this.stopTimers();
    if (this.sock && this.listening) {
      this.sock.connection?.off?.("message", this.onMessage);
      this.listening = false;
    }
    this.sock = null;
    this.isFetchingPages = false;
  }

  private startRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    // Background safety-net poll — real-time updates come from the subscription.
    // After the initial fetch, forceRefresh() automatically uses incremental mode (limit:10)
    // instead of full paginated chains — this cuts Deriv API calls by ~95%.
    this.refreshTimer = setInterval(() => { this.forceRefresh(); }, 60_000);
  }

  /** Debounced FULL refresh — runs after quick refresh to ensure complete accuracy */
  private scheduleTransactionRefresh() {
    if (this.txDebounceTimer) { clearTimeout(this.txDebounceTimer); }
    this.txDebounceTimer = setTimeout(() => {
      this.txDebounceTimer = null;
      this.forceRefresh();
    }, 5_000);
  }

  private async connect() {
    if (!this.bearerToken || !this.accountId) return;
    if (this.sock?.isOpen()) return;
    try {
      // RIDES THE SHARED POOLED SOCKET: the journal no longer owns a connection
      // of its own, so it costs zero extra OTP handshakes and zero extra
      // concurrent WebSockets against Deriv's 5-per-user ceiling.
      this.sock = await getPooledSocket(this.bearerToken, this.accountId);
    } catch (err) {
      logger.warn({ err }, "JournalManager: pooled connection unavailable, will retry");
      setTimeout(() => { void this.connect(); }, 10_000).unref?.();
      return;
    }
    const connection = this.sock.connection;
    if (connection && !this.listening) {
      connection.on("message", this.onMessage);
      this.listening = true;
    }
    this.lastPongMs = Date.now();
    logger.info("JournalManager: attached to pooled account connection — fetching profit table in 5 s");
    // Subscribe to real-time transaction events (re-sent automatically by the
    // pool after every reconnect, so a drop neither loses trades nor costs an
    // OTP handshake).
    if (connection) void connection.subscribe({ transaction: 1, subscribe: 1 });
    else this.sock.send({ transaction: 1, subscribe: 1 });
    this.startPing();
    this.startRefreshTimer();
    // Delay the first profit_table request so a rate-limit window inherited
    // from a previous connection has time to cool down.
    if (this.firstFetchTimer) clearTimeout(this.firstFetchTimer);
    this.firstFetchTimer = setTimeout(() => {
      if (this.sock?.isOpen() && !this.isFetchingPages) {
        this.fetchAccumulator = [];
        this.isFetchingPages = true;
        this.lastRefreshSentMs = Date.now();
        this.sock.send({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT, passthrough: { chain: true } });
      }
    }, 5_000);
  }

  /** Pooled-socket message handler (bound once, survives reconnects). */
  private onMessage = (raw: any): void => {
    try {
      const msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(JSON.stringify(raw));
      if (msg.msg_type === "profit_table" && msg.profit_table) {
        const isQuick: boolean = msg.passthrough?.quick === true || msg.passthrough?.incremental === true;
        const isOurChain: boolean = msg.passthrough?.chain === true;
        const isBackfill: boolean = msg.passthrough?.backfill === true;
        const batch: any[] = msg.profit_table.transactions ?? [];
        this.lastPongMs = Date.now();

        // A profit_table response on this POOLED socket may belong to another
        // consumer (trade settlement, bulk execution, portfolio). Only treat a
        // response as our own paginated chain when it carries our chain marker.
        // Anything else (no marker) is merged smartly instead of being committed
        // as a "full refresh" — that was corrupting the cache with truncated
        // snapshots and persisting detail-less payloads over complete ones.
        if (isQuick || isBackfill || (!isOurChain && !this.isFetchingPages)) {
          if (batch.length > 0) {
            // Track the highest transaction_id for incremental refresh
            for (const t of batch) {
              const tid = Number(t.transaction_id ?? 0);
              if (tid > this.lastKnownTransactionId) this.lastKnownTransactionId = tid;
            }
            // Smart merge: a complete transaction (with longcode/symbol) always
            // wins; an incomplete snapshot never replaces a complete one.
            const byId = new Map(this.cachedTransactions.map((t: any) => [t.transaction_id, t]));
            for (const t of batch) {
              const existing = byId.get(t.transaction_id);
              if (!existing || DerivJournalManager.hasFullDetail(t) || !DerivJournalManager.hasFullDetail(existing)) {
                byId.set(t.transaction_id, t);
              }
            }
            this.cachedTransactions = [...byId.values()].sort((a: any, b: any) =>
              Number(b.transaction_id ?? 0) - Number(a.transaction_id ?? 0));
            this.lastFetchMs = Date.now();
            this.persistTransactions(this.sessionId, batch);
            logger.info({ newInBatch: batch.length, total: this.cachedTransactions.length }, "JournalManager: refresh merged — live trades updated");
            this.emit("refreshed", this.cachedTransactions);
          }
          if (isBackfill) this.backfillInFlight = false;
          this.maybeScheduleBackfill();
          return;
        }

        // Full paginated refresh (our own chain — marker verified)
        this.fetchAccumulator.push(...batch);
        this.persistTransactions(this.sessionId, batch);
        // Track the highest transaction_id for future incremental refreshes
        for (const t of batch) {
          const tid = Number(t.transaction_id ?? 0);
          if (tid > this.lastKnownTransactionId) this.lastKnownTransactionId = tid;
        }

        if (batch.length >= JOURNAL_FETCH_LIMIT) {
          // More pages may exist — space requests out (Deriv throttles
          // profit_table to roughly one request every 3-5 s per account).
          const offset = this.fetchAccumulator.length;
          logger.info({ received: batch.length, totalSoFar: offset }, "JournalManager: fetching next page");
          setTimeout(() => {
            if (this.sock?.isOpen()) {
              this.sock.send({ profit_table: 1, description: 1, sort: "DESC", limit: JOURNAL_FETCH_LIMIT, offset, passthrough: { chain: true } });
            } else {
              this.isFetchingPages = false;
            }
          }, 5_000);
        } else {
          // Commit the page batch. MERGE with the existing cache (dedupe by
          // transaction_id, preferring the most DETAILED copy of each trade)
          // instead of a blind replace: a limit-10 incremental response that
          // missed the quick flag must NEVER wipe the full cached history —
          // engines read daily P&L/streaks from this cache, and a truncated
          // cache corrupts those inputs.
          if (this.hasDoneInitialFetch && this.cachedTransactions.length > this.fetchAccumulator.length) {
            const byId = new Map(this.cachedTransactions.map((t: any) => [t.transaction_id, t]));
            for (const t of this.fetchAccumulator) {
              const existing = byId.get(t.transaction_id);
              if (!existing || DerivJournalManager.hasFullDetail(t) || !DerivJournalManager.hasFullDetail(existing)) {
                byId.set(t.transaction_id, t);
              }
            }
            this.cachedTransactions = [...byId.values()].sort((a: any, b: any) =>
              Number(b.transaction_id ?? 0) - Number(a.transaction_id ?? 0));
          } else {
            this.cachedTransactions = this.fetchAccumulator;
          }
          this.fetchAccumulator = [];
          this.isFetchingPages = false;
          this.hasDoneInitialFetch = true;
          this.lastFetchMs = Date.now();
          logger.info({ count: this.cachedTransactions.length, lastTxId: this.lastKnownTransactionId }, "JournalManager: profit table refreshed — incremental mode active");
          this.emit("refreshed", this.cachedTransactions);
        }
      }

      // Real-time transaction events — immediate quick refresh on sell
      if (msg.msg_type === "transaction" && msg.transaction) {
        const actionType: string = msg.transaction.action ?? msg.transaction.action_type ?? "";
        if (actionType === "sell") {
          logger.info({ action: actionType, id: msg.transaction.contract_id }, "JournalManager: sell event — quick refresh + scheduled full refresh");
          this.forceQuickRefresh();
          this.scheduleTransactionRefresh();
        }
      }
      if (msg.msg_type === "pong" || msg.msg_type === "ping") this.lastPongMs = Date.now();
      if (msg.error) {
        logger.warn({ code: msg.error.code, message: msg.error.message }, "JournalManager: error");
        // Discard the partial accumulator — never commit truncated results.
        this.fetchAccumulator = [];
        this.isFetchingPages = false;
        if (msg.error.code === "RateLimit") {
          this.lastRefreshSentMs = Date.now();
          logger.info("JournalManager: RateLimit — will retry profit_table in 15 s");
          setTimeout(() => { this.forceRefresh(); }, 15_000).unref?.();
        }
      }
    } catch { /* ignore */ }
  };

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 90_000) {
        logger.warn("JournalManager: no data for 90s — reattaching to pooled connection");
        this.detach();
        void this.connect();
        return;
      }
      // The pool keeps the socket alive; this is only a liveness probe.
    }, 30_000);
  }
}

// One authenticated journal connection/cache per anonymous browser session.
// A process-wide singleton leaked one visitor's Deriv history into every browser.
const journalManagers = new Map<string, DerivJournalManager>();

export function getJournalManager(sessionId: string): DerivJournalManager {
  let manager = journalManagers.get(sessionId);
  if (!manager) {
    manager = new DerivJournalManager();
    manager.bindSession(sessionId);
    journalManagers.set(sessionId, manager);
  }
  return manager;
}

export function clearJournalManager(sessionId: string): void {
  const manager = journalManagers.get(sessionId);
  if (!manager) return;
  manager.clearCredentials();
  manager.removeAllListeners();
  journalManagers.delete(sessionId);
}

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

  return info;
}

// ── Live balance via REST ─────────────────────────────────────────────────────
export async function getLiveBalance(
  bearerToken: string,
  accountId?: string | null,
): Promise<number | null> {
  const cacheKey = accountId ? `${accountId}:${bearerToken.slice(-12)}` : `token:${bearerToken.slice(-12)}`;
  const cached = balanceCacheByAccount.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < BALANCE_CACHE_TTL_MS) return cached.balance;

  try {
    const accounts = await getDerivAccounts(bearerToken);
    if (accounts.length === 0) return null;
    const match = accountId ? accounts.find(a => a.account_id === accountId) : null;
    const real = accounts.find((a) => a.account_type === "real" && a.status === "active");
    const account = match ?? real ?? accounts[0];
    balanceCacheByAccount.set(cacheKey, { balance: account.balance, cachedAt: Date.now() });
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
  bearerToken: string,
  params: {
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    accountId: string;
    barrier?: number | string;
    /** ACCU only: growth rate 0.01–0.05. */
    growthRate?: number;
    /** ACCU only: exchange-side take-profit in account currency. */
    takeProfit?: number;
  },
): Promise<LiveTradeResult> {
  const accountId = params.accountId;

  if (!bearerToken || !accountId) {
    throw new Error(
      "No authenticated session. Please sign in with Deriv (OAuth) to enable live trading. " +
      "A Bearer token and account ID are required for the new Deriv API.",
    );
  }

  const buildProposal = (): Record<string, unknown> => {
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
    // Accumulators: the compounding schedule and the exchange-side exit.
    if (params.growthRate !== undefined) proposalParams.growth_rate = params.growthRate;
    if (params.takeProfit !== undefined) proposalParams.limit_order = { take_profit: params.takeProfit };
    return proposalParams;
  };

  // Quote over the account's PERSISTENT socket. A throttled quote is retried
  // with backoff instead of failing the trade; only a hard rejection settles it.
  let proposalMsg: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    proposalMsg = await accountRequest(
      bearerToken, accountId, { proposal: 1, ...buildProposal() }, ACCOUNT_REQUEST_TIMEOUT_MS,
    );
    if (proposalMsg && !proposalMsg.error) break;
    if (proposalMsg && proposalMsg.error && !isRetryableDerivError(proposalMsg) ) break;
    if (attempt === 3) break;
    const backoffMs = 600 * 2 ** (attempt - 1);
    logger.warn(
      { backoffMs, attempt, derivError: proposalMsg?.error },
      "executeLiveTrade: transient quote error — re-quoting",
    );
    await sleep(backoffMs);
  }

  if (!proposalMsg) {
    throw new Error("Trade execution timeout — Deriv did not answer the quote request.");
  }
  if (proposalMsg.error) {
    logger.error({ derivError: proposalMsg.error }, "executeLiveTrade: Deriv error");
    throw new Error(proposalMsg.error.message ?? "Trade rejected by Deriv");
  }
  if (proposalMsg.msg_type !== "proposal" || !proposalMsg.proposal) {
    throw new Error("Deriv returned an unexpected response to the quote request.");
  }

  const proposalId = String(proposalMsg.proposal.id);
  const askPrice = Number(proposalMsg.proposal.ask_price ?? params.stake);
  logger.info({ proposalId, askPrice }, "executeLiveTrade: proposal received, sending buy");

  const buyMsg = await accountRequest(
    bearerToken, accountId, { buy: proposalId, price: askPrice }, ACCOUNT_REQUEST_TIMEOUT_MS,
  );
  if (!buyMsg) throw new Error("Trade execution timeout — Deriv did not confirm the purchase.");
  if (buyMsg.error) throw new Error(buyMsg.error.message ?? "Trade rejected by Deriv");
  if (buyMsg.msg_type !== "buy" || !buyMsg.buy) {
    throw new Error("Deriv returned an unexpected response to the buy request.");
  }

  return {
    contractId: buyMsg.buy.contract_id,
    buyPrice: Number(buyMsg.buy.buy_price),
    entrySpot: Number(buyMsg.buy.start_time ?? 0),
    longcode: buyMsg.buy.longcode ?? "",
  };
}

// ── Bulk live trade execution (N legs, ONE tick, ONE logical entry) ───────────
/**
 * Execute N trades as ONE logical entry: every leg is quoted together, every
 * leg is COMMITTED in a single burst inside one tick window, and the batch is
 * settled in one sweep.
 *
 * WHY THIS WAS REWRITTEN (the "my 5 bulk trades never reached my Deriv account"
 * report)
 *
 * The previous version claimed to burst all proposals "in the same tick, same
 * millisecond". That was true only on the socket its tests injected. In
 * production it rode `getPooledSocket()`, whose `send()` is the account's
 * SHARED, PACED queue (one message per 25 ms — the guard that keeps the app
 * under Deriv's per-connection message ceiling). So a 10-leg batch was really
 * emitted at 0/25/50/…/225 ms, each buy appended behind the quotes still in the
 * queue, and the whole entry spread across roughly half a second. On a 1–2 s
 * tick market that straddles tick boundaries: legs entered on DIFFERENT ticks —
 * different entry digit — and therefore closed on different ticks, seconds
 * apart. That is precisely the reported symptom, and no amount of retry logic
 * could fix it because the delay was inserted by our own scheduler.
 *
 * It also had no defence against the transport dying mid-batch: the batch
 * simply waited out its 25 s deadline and reported every leg as failed although
 * nothing had ever been sent.
 *
 * THE CONTRACT THIS IMPLEMENTATION KEEPS
 *
 *   1. QUOTE  — all N proposals leave in ONE burst (`ws.burst`, no queue).
 *   2. BARRIER — the batch waits (bounded) for every leg's quote, so the commit
 *      is ONE event instead of N round-trips racing each other.
 *   3. ALIGN  — the commit burst is placed inside a FRESH tick window (see
 *      `commitDelayMs`). This is the only way to make "same tick" a property of
 *      the design rather than of luck: an order processed early in a window
 *      cannot be overtaken by the next tick while its siblings are still in
 *      flight.
 *   4. COMMIT — all N buys leave in ONE burst, same millisecond.
 *   5. VERIFY — every leg carries Deriv's own `start_time` and the burst that
 *      carried it, so the caller can prove (or disprove) same-tick entry from
 *      the broker's data instead of assuming it.
 *
 * A leg that cannot be quoted in time (throttled, retried, or stranded by a
 * dropped socket) is re-quoted on the reconnected socket and committed in a
 * follow-up burst, and is flagged `splitTick` so a caller can never silently
 * report a split entry as a synchronized one. A leg is only failed on a hard
 * rejection from Deriv (bad barrier, insufficient balance, invalid contract).
 */

/** Total quote attempts per leg (initial + retries) before the leg is failed. */
export const BULK_MAX_ATTEMPTS = 4;
/** First retry delay per leg; doubles on each subsequent retry (300 → 600 → 1200 ms). */
export const BULK_RETRY_BASE_MS = 300;
const BULK_EXECUTION_DEADLINE_MS = 25_000;
/**
 * How long the commit waits for the rest of the batch to be quoted before going
 * without the stragglers. Long enough to absorb a round trip plus a throttled
 * re-quote, short enough that one slow leg cannot push the batch into a second
 * tick on the fast markets.
 */
export const BULK_COMMIT_GRACE_MS = 450;
/** Headroom (ms) we want left in a tick window before committing inside it. */
export const BULK_MIN_WINDOW_HEADROOM_MS = 450;
/** Land this far past a boundary so the burst is unambiguously in the new window. */
export const BULK_ALIGN_OFFSET_MS = 120;
/** A batch is never delayed longer than this for tick alignment. */
export const BULK_MAX_ALIGN_WAIT_MS = 2_200;

/**
 * How long to hold the commit burst so that it lands inside a fresh tick window.
 *
 * Returns 0 — commit now — when there is no window information, when the feed
 * has rolled over or stalled (waiting then cannot help), when the current window
 * still has enough headroom for the burst, or when the next boundary is further
 * away than `maxWaitMs`. A batch is never parked indefinitely for perfect
 * alignment. Otherwise it returns the wait until the next boundary plus a small
 * offset: the moment the whole new window is ahead of the batch.
 */
export function commitDelayMs(
  nowMs: number,
  window: { periodMs: number; windowStartMs: number } | null | undefined,
  opts?: { minHeadroomMs?: number; alignOffsetMs?: number; maxWaitMs?: number },
): number {
  const minHeadroomMs = opts?.minHeadroomMs ?? BULK_MIN_WINDOW_HEADROOM_MS;
  const alignOffsetMs = opts?.alignOffsetMs ?? BULK_ALIGN_OFFSET_MS;
  const maxWaitMs = opts?.maxWaitMs ?? BULK_MAX_ALIGN_WAIT_MS;
  if (!window || !(window.periodMs > 0) || !Number.isFinite(window.windowStartMs)) return 0;
  const elapsedMs = nowMs - window.windowStartMs;
  if (!Number.isFinite(elapsedMs)) return 0;
  const remainingMs = window.periodMs - elapsedMs;
  if (remainingMs <= 0) return 0; // window already rolled over — nothing to align to
  const headroomNeededMs = Math.min(minHeadroomMs, window.periodMs * 0.5);
  if (remainingMs >= headroomNeededMs) return 0;
  const waitMs = remainingMs + alignOffsetMs;
  return waitMs <= maxWaitMs ? Math.ceil(waitMs) : 0;
}

/** req_id one leg's proposal/buy carries — attempt-suffixed so a stale retry response can never double-buy. */
export function bulkReqId(
  phase: "proposal" | "buy",
  legIndex: number,
  attempt: number,
): string {
  return `bulk-${phase}-${legIndex}-${attempt}`;
}

/**
 * Parse a Deriv response back to its (phase, leg, attempt).
 *
 * Deriv echoes our req_id at the top level of normal responses, but ERROR
 * envelopes only reliably carry the original request under `echo_req` —
 * matching errors on `msg.req_id` alone mis-attributes per-leg failures as
 * batch-fatal and kills the healthy legs with them.
 */
export function parseBulkLegRef(
  msg: any,
): { phase: "proposal" | "buy"; leg: number; attempt: number } | null {
  const raw = msg?.req_id ?? msg?.echo_req?.req_id;
  if (typeof raw !== "string") return null;
  const m = /^bulk-(proposal|buy)-(\d+)-(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return {
    phase: m[1] as "proposal" | "buy",
    leg: Number(m[2]),
    attempt: Number(m[3]),
  };
}

/**
 * True when a Deriv error is worth retrying the leg for: rate-limit throttles
 * (bursting N proposals + N buys trips Deriv's per-call throttle), transient
 * exchange hiccups, and stale-price buy rejections (the leg is simply
 * re-quoted). Anything else (bad barrier, insufficient balance, invalid
 * contract, …) fails the leg immediately — retrying would fail identically.
 */
export function isRetryableDerivError(msg: any): boolean {
  const code = String(msg?.error?.code ?? "");
  if (
    code === "RateLimit" ||
    code === "TemporaryUnavailable" ||
    code === "CircuitBreakerBusy"
  )
    return true;
  const text = `${code} ${String(msg?.error?.message ?? "")}`.toLowerCase();
  return (
    text.includes("rate limit") ||
    text.includes("too many") ||
    text.includes("temporar") ||
    text.includes("try again") ||
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("price mov") || // quote repriced between proposal and buy — re-quote
    text.includes("stale") ||
    text.includes("service unavailable") ||
    text.includes("internal server error")
  );
}

/** What the executor reports about one leg's synchrony, from Deriv's own data. */
export interface BulkLegReceipt {
  index: number;
  /** Deriv's contract start time in epoch ms — equal across legs means one tick. */
  startedAtMs: number;
  /** Local time the buy confirmation arrived (ms epoch). */
  confirmedAtMs: number;
  /** Which commit burst carried this leg. 0 = the batch's synchronized burst. */
  burst: number;
  /** True when this leg could not ride the batch's first commit burst. */
  splitTick: boolean;
}

/** One leg's outcome: the contract (with a synchrony receipt) or why it failed. */
export type BulkLegDelivery =
  | { contract: LiveTradeResult; receipt: BulkLegReceipt }
  | { error: Error; receipt: BulkLegReceipt };

export interface BulkExecutionOptions {
  /** Test-only: skip the OTP handshake and connect here instead. */
  otpUrl?: string;
  /**
   * The symbol's current tick window (`tickManager.getTickWindow(symbol)`).
   * Supply it and the commit burst is aligned inside a fresh window; omit it and
   * the burst still fires atomically, just without boundary alignment.
   */
  tickWindow?: { periodMs: number; windowStartMs: number } | null;
  /** Force alignment off (tests that assert the raw burst). */
  alignToTick?: boolean;
}

/** Normalise Deriv's start_time, which may arrive in seconds or milliseconds. */
function toEpochMs(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
}

export async function executeBulkLiveTrades(
  bearerToken: string,
  accountId: string,
  params: Array<{
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    barrier?: number | string;
  }>,
  opts?: BulkExecutionOptions,
): Promise<BulkLegDelivery[]> {
  if (!bearerToken || !accountId) {
    throw new Error(
      "No authenticated session. Please sign in with Deriv (OAuth) to enable live trading.",
    );
  }
  if (params.length === 0) return [];

  // The whole batch rides the account's PERSISTENT socket: no extra OTP
  // handshake and no extra connection per batch. `opts.otpUrl` is still
  // honoured for tests that inject a fake Deriv server.
  const ws: PooledSocket = opts?.otpUrl
    ? await openDirectSocket(opts.otpUrl)
    : await getPooledSocket(bearerToken, accountId);

  const alignToTick = opts?.alignToTick !== false && !!opts?.tickWindow;

  return new Promise((resolve, reject) => {
    type Phase = "idle" | "quoting" | "quoted" | "committing" | "done";
    interface LegState {
      phase: Phase;
      attempts: number;
      quoteAttempt: number;
      buyAttempt: number;
      proposalId: string | null;
      askPrice: number;
      /** Earliest time this leg may be re-quoted (backs off failed sends). */
      nextAttemptAtMs: number;
      burst: number;
      splitTick: boolean;
      confirmedAtMs: number;
      result: LiveTradeResult | null;
      failure: Error | null;
    }

    const legs: LegState[] = params.map(() => ({
      phase: "idle",
      attempts: 0,
      quoteAttempt: 0,
      buyAttempt: 0,
      proposalId: null,
      askPrice: 0,
      nextAttemptAtMs: 0,
      burst: 0,
      splitTick: false,
      confirmedAtMs: 0,
      result: null,
      failure: null,
    }));

    let finished = false;
    let started = false;
    let burstsFired = 0;
    let firstQuoteAtMs = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let pumpTimer: ReturnType<typeof setTimeout> | null = null;

    const deadline = setTimeout(() => {
      logger.warn(
        {
          count: params.length,
          confirmed: legs.filter((l) => l.result !== null).length,
        },
        "executeBulkLiveTrades: batch deadline reached — settling whatever Deriv confirmed",
      );
      finish();
    }, BULK_EXECUTION_DEADLINE_MS);

    const later = (ms: number, fn: () => void): ReturnType<typeof setTimeout> => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };

    const receiptFor = (index: number): BulkLegReceipt => {
      const leg = legs[index]!;
      return {
        index,
        startedAtMs: leg.result?.startedAtMs ?? 0,
        confirmedAtMs: leg.confirmedAtMs,
        burst: leg.burst,
        splitTick: leg.splitTick,
      };
    };

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      pumpTimer = null;
      ws.off("message", onMessage);
      ws.off("dropped", onDropped);
      // The pooled socket stays open for the next trade; `ws.close()` is a
      // deliberate no-op there (and for injected test sockets).
      ws.close();
      if (err) {
        reject(err);
        return;
      }
      // Legs that never confirmed are reported as errors so the caller settles
      // them without losing the rest of the batch.
      resolve(
        legs.map((leg, index): BulkLegDelivery => {
          const receipt = receiptFor(index);
          if (leg.result) return { contract: leg.result, receipt };
          return {
            error: leg.failure ?? new Error("Bulk trade leg unconfirmed"),
            receipt,
          };
        }),
      );
    };

    const markSettled = () => {
      if (legs.every((l) => l.result !== null || l.failure !== null)) finish();
    };

    const failLeg = (i: number, err: Error): void => {
      const leg = legs[i]!;
      if (leg.result !== null || leg.failure !== null) return;
      leg.failure = err;
      leg.phase = "done";
      markSettled();
    };

    // ── QUOTE: every leg's proposal leaves in ONE burst ──────────────────────
    const quoteSleeping = (indexes: number[]) => {
      if (finished || indexes.length === 0) return;
      const messages: Record<string, unknown>[] = [];
      const quoting: number[] = [];
      let awaitMs = Number.POSITIVE_INFINITY;
      for (const i of indexes) {
        const leg = legs[i]!;
        if (leg.result !== null || leg.failure !== null) continue;
        if (leg.phase !== "idle") continue;
        if (leg.attempts >= BULK_MAX_ATTEMPTS) {
          failLeg(
            i,
            new Error("Bulk trade leg could not be quoted — the trading connection was not usable"),
          );
          continue;
        }
        if (Date.now() < leg.nextAttemptAtMs) {
          awaitMs = Math.min(awaitMs, leg.nextAttemptAtMs);
          continue;
        }
        const p = params[i]!;
        leg.attempts += 1;
        leg.quoteAttempt = leg.attempts;
        leg.phase = "quoting";
        const message: Record<string, unknown> = {
          proposal: 1,
          amount: p.stake,
          basis: "stake",
          contract_type: p.contractType,
          currency: p.currency,
          duration: p.duration,
          duration_unit: p.durationUnit,
          underlying_symbol: p.symbol,
          req_id: bulkReqId("proposal", i, leg.attempts),
        };
        if (p.barrier !== undefined) message.barrier = String(p.barrier);
        messages.push(message);
        quoting.push(i);
      }
      if (messages.length === 0) {
        if (Number.isFinite(awaitMs) && !finished) schedulePump(awaitMs - Date.now());
        return;
      }
      const sent = ws.burst(messages);
      // A burst that could not drain (socket died mid-write) leaves those legs
      // un-asked: hand them back to the retry path instead of waiting forever.
      for (const [n, i] of quoting.entries()) {
        if (n < sent) continue;
        const leg = legs[i]!;
        leg.phase = "idle";
        leg.attempts = Math.max(0, leg.attempts - 1);
        leg.nextAttemptAtMs = Date.now() + BULK_RETRY_BASE_MS;
      }
      logger.info(
        { asked: messages.length, sent, of: params.length },
        "executeBulkLiveTrades: QUOTE burst — every leg quoted in one event-loop turn",
      );
    };

    const retryLeg = (i: number, err: Error): void => {
      const leg = legs[i]!;
      if (leg.result !== null || leg.failure !== null) return;
      if (leg.attempts >= BULK_MAX_ATTEMPTS) {
        logger.warn(
          { i, attempts: leg.attempts, err: err.message },
          "executeBulkLiveTrades: leg exhausted retries",
        );
        failLeg(i, err);
        return;
      }
      leg.phase = "idle";
      leg.proposalId = null;
      const backoffMs = BULK_RETRY_BASE_MS * 2 ** (leg.attempts - 1);
      leg.nextAttemptAtMs = Date.now() + backoffMs;
      logger.info(
        { i, backoffMs, attempt: leg.attempts + 1 },
        "executeBulkLiveTrades: retrying leg",
      );
      schedulePump(backoffMs);
    };

    // ── COMMIT: one burst, inside one tick window ────────────────────────────
    const commit = (ready: LegState[]) => {
      if (finished || ready.length === 0) return;
      const burst = burstsFired;
      burstsFired += 1;
      const messages: Record<string, unknown>[] = [];
      const indexes: number[] = [];
      for (const [n, leg] of ready.entries()) {
        const index = legs.indexOf(leg);
        leg.buyAttempt = leg.quoteAttempt;
        leg.phase = "committing";
        leg.burst = burst;
        leg.splitTick = burst > 0;
        messages.push({
          buy: leg.proposalId,
          price: leg.askPrice,
          req_id: bulkReqId("buy", index, leg.buyAttempt),
        });
        indexes.push(index);
        void n;
      }
      const sent = ws.burst(messages);
      logger.info(
        {
          burst,
          legs: messages.length,
          sent,
          splitTick: burst > 0,
          alignedToTick: alignToTick && burst === 0,
        },
        burst === 0
          ? "executeBulkLiveTrades: COMMIT burst — the whole batch bought in one event-loop turn"
          : "executeBulkLiveTrades: follow-up COMMIT burst for legs that missed the first tick",
      );
      // Legs the burst could not reach are re-quoted rather than lost.
      for (const [n, index] of indexes.entries()) {
        if (n < sent) continue;
        const leg = legs[index]!;
        leg.phase = "idle";
        leg.proposalId = null;
        leg.nextAttemptAtMs = Date.now() + BULK_RETRY_BASE_MS;
      }
      if (sent < messages.length) schedulePump(BULK_RETRY_BASE_MS);
    };

    const schedulePump = (delayMs: number) => {
      if (finished) return;
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = later(Math.max(0, delayMs), () => {
        pumpTimer = null;
        pump();
      });
    };

    /**
     * The batch's single decision point: re-quote whatever is due, then either
     * wait (barrier grace / tick alignment) or fire the commit burst.
     */
    const pump = () => {
      if (finished) return;
      const outstanding = legs.filter((l) => l.result === null && l.failure === null);
      if (outstanding.length === 0) return;

      const idle = outstanding.filter((l) => l.phase === "idle");
      if (idle.length > 0) {
        quoteSleeping(idle.map((l) => legs.indexOf(l)));
        if (finished) return;
      }

      const stillQuoting = legs.filter(
        (l) => l.result === null && l.failure === null && (l.phase === "quoting" || l.phase === "idle"),
      );
      const ready = legs.filter(
        (l) => l.result === null && l.failure === null && l.phase === "quoted",
      );

      if (ready.length === 0) {
        // Nothing to commit yet: the quotes/reconnect/retry timers drive the
        // next pump. Never spin — always leave a floor on the delay.
        const nextDue = Math.min(
          ...legs
            .filter((l) => l.result === null && l.failure === null && l.phase === "idle")
            .map((l) => l.nextAttemptAtMs || Date.now() + BULK_RETRY_BASE_MS),
        );
        schedulePump(
          Number.isFinite(nextDue) ? Math.max(50, nextDue - Date.now()) : BULK_COMMIT_GRACE_MS,
        );
        return;
      }

      // BARRIER: give the rest of the batch the grace window to join this commit.
      if (stillQuoting.length > 0 && firstQuoteAtMs > 0) {
        const waitedMs = Date.now() - firstQuoteAtMs;
        if (waitedMs < BULK_COMMIT_GRACE_MS) {
          schedulePump(BULK_COMMIT_GRACE_MS - waitedMs);
          return;
        }
      }

      // ALIGN: only the first burst is worth aligning — a later leg is a second
      // tick by definition and is flagged as such.
      if (alignToTick && burstsFired === 0) {
        const delayMs = commitDelayMs(Date.now(), opts?.tickWindow ?? null);
        if (delayMs > 0) {
          logger.info(
            { delayMs },
            "executeBulkLiveTrades: holding the commit for a fresh tick window so the whole batch enters on ONE tick",
          );
          schedulePump(delayMs);
          return;
        }
      }

      commit(ready);
    };

    // ── Response routing ─────────────────────────────────────────────────────
    function handleMessage(msg: any): void {
      if (msg.error) {
        const ref = parseBulkLegRef(msg);
        const err = new Error(msg.error?.message ?? "Bulk trade rejected by Deriv");
        if (ref && ref.leg >= 0 && ref.leg < params.length) {
          const leg = legs[ref.leg]!;
          if (leg.result !== null || leg.failure !== null) return; // late duplicate
          // Stale responses from a superseded attempt must not touch the leg.
          const current = ref.phase === "proposal" ? leg.quoteAttempt : leg.buyAttempt;
          const expected = ref.phase === "proposal" ? "quoting" : "committing";
          if (ref.attempt !== current || leg.phase !== expected) return;
          if (isRetryableDerivError(msg)) retryLeg(ref.leg, err);
          else failLeg(ref.leg, err);
          return;
        }
        if (ref) return; // leg already settled — late duplicate, ignore.
        // No leg attribution. Retryable/transient socket-level noise must NOT
        // kill confirmed-or-confirming legs; only hard errors abort the batch.
        if (isRetryableDerivError(msg)) {
          logger.warn(
            { derivError: msg.error },
            "executeBulkLiveTrades: unattributed transient error — continuing batch",
          );
          return;
        }
        logger.error(
          { derivError: msg.error },
          "executeBulkLiveTrades: Deriv error (batch)",
        );
        finish(err);
        return;
      }

      if (msg.msg_type === "proposal" && msg.proposal) {
        const ref = parseBulkLegRef(msg);
        if (!ref || ref.phase !== "proposal" || ref.leg < 0 || ref.leg >= params.length) return;
        const leg = legs[ref.leg]!;
        if (leg.result !== null || leg.failure !== null) return;
        if (ref.attempt !== leg.quoteAttempt || leg.phase !== "quoting") return;
        const askPrice = Number(msg.proposal.ask_price ?? params[ref.leg]?.stake ?? 0);
        const proposalId = String(msg.proposal.id ?? "");
        if (!proposalId) {
          // Proposal arrived without an id — re-quote the leg (transient).
          retryLeg(ref.leg, new Error("Deriv proposal missing id"));
          return;
        }
        leg.proposalId = proposalId;
        leg.askPrice = askPrice;
        leg.phase = "quoted";
        if (firstQuoteAtMs === 0) firstQuoteAtMs = Date.now();
        pump();
        return;
      }

      if (msg.msg_type === "buy" && msg.buy) {
        const ref = parseBulkLegRef(msg);
        if (!ref || ref.phase !== "buy" || ref.leg < 0 || ref.leg >= params.length) return;
        const leg = legs[ref.leg]!;
        if (leg.result !== null || leg.failure !== null) return;
        if (ref.attempt !== leg.buyAttempt || leg.phase !== "committing") return;
        leg.result = {
          contractId: Number(msg.buy.contract_id),
          buyPrice: Number(msg.buy.buy_price),
          // Deriv's own start time is the synchrony proof; `entrySpot` keeps its
          // historical meaning for existing callers.
          entrySpot: Number(msg.buy.start_time ?? 0),
          longcode: msg.buy.longcode ?? "",
          startedAtMs: toEpochMs(msg.buy.start_time),
        };
        leg.confirmedAtMs = Date.now();
        leg.phase = "done";
        markSettled();
      }
    }

    const onMessage = (data: { toString(): string }) => {
      if (finished) return;
      try {
        handleMessage(JSON.parse(data.toString()));
      } catch (e) {
        logger.error({ e }, "executeBulkLiveTrades: error parsing message");
      }
    };

    const onDropped = () => {
      if (finished) return;
      // The transport under the batch died. Unconfirmed legs go back to the
      // queue and are re-quoted on the reconnected socket, instead of sitting
      // until the deadline and being reported as trades that never happened.
      const stranded = legs.filter((l) => l.result === null && l.failure === null);
      if (stranded.length === 0) return;
      logger.warn(
        { stranded: stranded.length, of: params.length },
        "executeBulkLiveTrades: trading socket dropped mid-batch — re-quoting stranded legs",
      );
      for (const leg of stranded) {
        leg.phase = "idle";
        leg.proposalId = null;
        leg.nextAttemptAtMs = Math.max(leg.nextAttemptAtMs, Date.now() + 250);
      }
      schedulePump(250);
    };

    const start = () => {
      if (finished || started) return;
      started = true;
      logger.info(
        { count: params.length, alignedToTick: alignToTick },
        "executeBulkLiveTrades: batch starting — quote burst first, then ONE aligned commit burst",
      );
      quoteSleeping(params.map((_, i) => i));
      // If nothing ever answers (wedged socket), keep the batch moving.
      schedulePump(BULK_COMMIT_GRACE_MS);
    };

    // Register the listeners BEFORE any send: the pooled socket replays `open`
    // immediately when it is already connected, so `start()` must be safe to run
    // on the next microtask with routing already in place.
    ws.on("message", onMessage);
    ws.on("dropped", onDropped);
    ws.on("open", start);
    ws.on("error", (err) =>
      finish(err instanceof Error ? err : new Error("Bulk trade WebSocket error")),
    );
  });
}

// ── Bulk contract settlement (one OTP WS polling ALL contract ids) ───────────
/**
 * Wait until EVERY contract in `contractIds` has settled, reporting results in
 * ONE pass. The per-contract `waitForContractResult` opened its own OTP WS per
 * leg and polled every 2s on its own schedule, so leg results trickled in over
 * several seconds. Here a single socket polls the portfolio once per second and
 * all legs — which opened on the same tick and therefore close on the same
 * tick — are read back in the very next `profit_table` response.
 */
export async function waitForBulkContractResults(
  bearerToken: string,
  accountId: string,
  contractIds: number[],
  timeoutMs = 30_000,
): Promise<ContractResult[]> {
  if (!bearerToken || !accountId) {
    throw new Error("No authenticated session for contract result polling");
  }
  if (contractIds.length === 0) return [];

  const found = new Map<number, ContractResult>();
  // Ask for strictly more rows than the batch so a busy account (bots trading
  // on the same wallet) can never push a leg out of the page we read.
  const tableLimit = Math.min(500, Math.max(50, contractIds.length + 20));
  const deadline = Date.now() + timeoutMs + 10_000;

  const collectFromProfitTable = (msg: any): void => {
    const txs: any[] = msg.profit_table?.transactions ?? [];
    for (const id of contractIds) {
      if (found.has(id)) continue;
      const tx = txs.find((t) => Number(t.contract_id) === id);
      if (!tx) continue;
      const buyPrice = Number(tx.buy_price ?? 0);
      const sellPrice = Number(tx.sell_price ?? 0);
      found.set(id, {
        contractId: id,
        won: sellPrice - buyPrice > 0,
        profit: sellPrice - buyPrice,
        exitSpot: 0,
        sellPrice,
        entrySpot: buyPrice,
        // Deriv's own purchase/sell times: equal across a batch's legs is the
        // broker-side proof that they opened — and closed — on the same tick.
        purchasedAtMs: toEpochMs(tx.purchase_time),
        exitedAtMs: toEpochMs(tx.sell_time),
      });
    }
  };

  // Poll over the account's PERSISTENT socket — no OTP handshake, no extra
  // connection, and the same socket the batch was bought over.
  while (found.size < contractIds.length && Date.now() < deadline) {
    let portfolioMsg: any = null;
    let profitMsg: any = null;
    try {
      [portfolioMsg, profitMsg] = await Promise.all([
        accountRequest(bearerToken, accountId, { portfolio: 1 }, 12_000),
        accountRequest(
          bearerToken, accountId,
          { profit_table: 1, limit: tableLimit, sort: "DESC" },
          12_000,
        ),
      ]);
    } catch {
      // Transient socket problem — retry until the deadline. The contract is
      // safe on Deriv's side; the reconciler also covers a hard failure.
      await sleep(1_000);
      continue;
    }
    if (profitMsg) collectFromProfitTable(profitMsg);
    if (found.size >= contractIds.length) break;
    // `portfolio` tells us the legs are still open; keep polling. A transient
    // null (socket hiccup) also just means "poll again".
    if (!portfolioMsg && !profitMsg && Date.now() >= deadline) break;
    await sleep(1_000);
  }

  // Resolve with whatever settled; legs Deriv never journalued in time are
  // reported as `missing` so the caller can settle them as errors without
  // losing the rest of the batch.
  return contractIds.map((id) =>
    found.get(id) ?? { contractId: id, won: false, profit: 0, exitSpot: 0, sellPrice: 0, entrySpot: 0, missing: true },
  );
}

// ── Profit table fetch via OTP WebSocket ──────────────────────────────────────
export async function fetchDerivProfitTable(
  bearerToken: string,
  accountId: string,
  limit = 50,
): Promise<any[]> {
  if (!bearerToken || !accountId) {
    logger.warn("fetchDerivProfitTable: no Bearer token or accountId — returning empty");
    return [];
  }
  try {
    const msg = await accountRequest(
      bearerToken, accountId,
      { profit_table: 1, description: 1, sort: "DESC", limit },
      15_000,
    );
    if (!msg || msg.error) return [];
    return msg.profit_table?.transactions ?? [];
  } catch (err) {
    logger.warn({ err }, "fetchDerivProfitTable failed");
    return [];
  }
}

// ── Wait for contract result via OTP WebSocket ────────────────────────────────
/**
 * NOTE: proposal_open_contracts is unsupported for this account/app_id combination.
 * We poll `portfolio` (checks if contract is still open) then `profit_table`
 * (confirms settled buy/sell price) — same strategy as before, now on OTP WS.
 */
export async function waitForContractResult(
  bearerToken: string,
  accountId: string,
  contractId: number,
  timeoutMs = 30_000,
): Promise<ContractResult> {
  if (!bearerToken || !accountId) {
    throw new Error("No authenticated session for contract result polling");
  }

  // Poll over the account's PERSISTENT socket (portfolio + profit_table).
  //
  // The old implementation opened its own OTP WebSocket *per contract* and
  // rejected the moment that socket closed, which marked perfectly healthy
  // trades as failed. Riding the pooled connection removes both the connection
  // churn (the rate limit) and the spurious failures; a transient hiccup now
  // simply means "poll again" until the deadline.
  const deadline = Date.now() + timeoutMs + 5_000;

  while (Date.now() < deadline) {
    let portfolioMsg: any = null;
    let profitMsg: any = null;
    try {
      [portfolioMsg, profitMsg] = await Promise.all([
        accountRequest(bearerToken, accountId, { portfolio: 1 }, 12_000),
        accountRequest(bearerToken, accountId, { profit_table: 1, limit: 50, sort: "DESC" }, 12_000),
      ]);
    } catch {
      // Transient socket problem — keep polling until the deadline instead of
      // marking a healthy trade as failed.
      await sleep(2_000);
      continue;
    }

    if (profitMsg && !profitMsg.error) {
      const txs: any[] = profitMsg.profit_table?.transactions ?? [];
      const tx = txs.find((t) => Number(t.contract_id) === contractId);
      if (tx) {
        const buyPrice = Number(tx.buy_price ?? 0);
        const sellPrice = Number(tx.sell_price ?? 0);
        const profit = sellPrice - buyPrice;
        return {
          contractId,
          won: profit > 0,
          profit,
          exitSpot: 0,
          sellPrice,
          entrySpot: buyPrice,
          purchasedAtMs: toEpochMs(tx.purchase_time),
          exitedAtMs: toEpochMs(tx.sell_time),
        };
      }
    }

    // Not settled yet. If the contract is no longer in the open portfolio and
    // Deriv has not journalued it yet, keep polling — the journal entry is what
    // gives us Deriv's exact profit.
    void portfolioMsg;
    await sleep(2_000);
  }

  throw new Error("Contract result timeout — Deriv did not confirm settlement in time");
}
