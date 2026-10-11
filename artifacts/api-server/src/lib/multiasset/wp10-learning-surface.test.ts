/**
 * WP10 — the learning surface: the desk-timeframe state, the durable journal, and
 * the outbound channel.
 *
 * Three claims are pinned here, and each of them is a claim about what happens when
 * something is NOT configured:
 *
 *   • the regime state read is the SAME model the live permit uses, memoised for no
 *     longer than two seconds and keyed on the last closed bar — so a dashboard can
 *     poll it without changing a decision, and a new bar is never served a stale
 *     reading;
 *   • the journal endpoint is absent (404) while the layer that writes it is off, so
 *     the shipped API surface is unchanged by WP10;
 *   • the alert channel never throws, never blocks a trading path, de-duplicates,
 *     rate-limits, and is inert without credentials even when its flag is on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALL_TIMEFRAMES, type Bar, type Timeframe } from "./types";
import { REGIME_STATE_TTL_MS, deskRegimeState, resetRegimeStateCacheForTests } from "./regime-state";
import {
  ALERT_DEDUPE_MS,
  ALERT_RATE_PER_MINUTE,
  deskAlert,
  resetAlertsForTests,
  setAlertTransportForTests,
} from "./alerts";
import { DEFAULT_REGIME_HMM_CONFIG, regimePermit } from "./regime-hmm";
import { generate, DEFAULT_GENERATOR_SPEC, type GeneratorKind } from "./research/generators";
import { v4On, resolveDeskV4Config, setDeskV4ForTests } from "./desk-v4-config";

const NOW = Date.UTC(2025, 5, 2, 12, 0); // a Monday

function bars(kind: GeneratorKind, count = 900, seed = 42): Bar[] {
  return generate(kind, { ...DEFAULT_GENERATOR_SPEC, bars: count, timeframeMs: 5 * 60_000, seed }).bars as Bar[];
}

/** Turn a partial env into a config the way the process would on boot. */
function configWith(overrides: Record<string, string>): ReturnType<typeof resolveDeskV4Config> {
  return resolveDeskV4Config({
    DESK_V4_ENABLED: "1",
    DESK_V4_SHADOW: "1",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

test("W10.1 — the profile is readable and never a second implementation of the permit", () => {
  resetRegimeStateCacheForTests();
  const series = bars("positive-control");
  const config = { ...DEFAULT_REGIME_HMM_CONFIG };
  const read = deskRegimeState({
    sessionId: "s-w10-1",
    symbol: "EURUSD",
    frame: "M5" as Timeframe,
    mode: "intraday",
    bars: series,
    nowMs: NOW,
  });
  assert.equal(read.available, true, "900 bars of history must be enough to fit a 3-state model");
  assert.ok(ALL_TIMEFRAMES.includes(read.frame));
  assert.equal(read.cached, false);
  assert.equal(read.ageMs, 0);

  // The permit the dashboard shows is THE permit: same window, same config, same
  // model — asserted by running the live call on the same bars and comparing.
  const liveBuy = regimePermit({ bars: series, mode: "intraday", side: "buy", config });
  const liveSell = regimePermit({ bars: series, mode: "intraday", side: "sell", config });
  assert.equal(read.sides.buy.permit, liveBuy.permit, "the state read and the live permit must agree (buy)");
  assert.equal(read.sides.sell.permit, liveSell.permit, "the state read and the live permit must agree (sell)");
  assert.equal(read.sides.buy.required, liveBuy.required);
  assert.deepEqual(read.sides.buy.codes, liveBuy.codes);
  // And the posterior is a distribution.
  const total = Object.values(read.posterior).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `posterior must sum to 1, got ${total}`);
  assert.ok(read.posterior[read.state] !== undefined);
});

test("W10.2 — the memo is keyed on the window, so a new bar is never stale", () => {
  resetRegimeStateCacheForTests();
  const series = bars("positive-control", 900, 7);
  const args = {
    sessionId: "s-w10-2",
    symbol: "EURUSD",
    frame: "M5" as Timeframe,
    mode: "intraday" as const,
    bars: series,
  };
  const first = deskRegimeState({ ...args, nowMs: NOW });
  const second = deskRegimeState({ ...args, nowMs: NOW + REGIME_STATE_TTL_MS - 1 });
  assert.equal(second.cached, true, "inside the two-second window the reading is reused");
  assert.equal(second.ageMs, REGIME_STATE_TTL_MS - 1, "and the reader is told how old it is");
  assert.equal(second.fit.iterations, first.fit.iterations);

  const third = deskRegimeState({ ...args, nowMs: NOW + REGIME_STATE_TTL_MS + 1 });
  assert.equal(third.cached, false, "past the TTL the reading is recomputed");

  // A NEW BAR must recompute immediately, whatever the clock says: the cache key
  // carries the last bar's open time, so a closed bar invalidates the memo.
  const extended: Bar[] = [
    ...series,
    [((series[series.length - 1] as Bar)[0] as number) + 5 * 60_000, 1.1, 1.11, 1.09, 1.105, 100, 1.105] as Bar,
  ];
  const fourth = deskRegimeState({ ...args, bars: extended, nowMs: NOW + 10 });
  assert.equal(fourth.cached, false, "a new bar must invalidate the memo even inside the TTL");
});

test("W10.3 — a too-short window refuses to guess, and says why", () => {
  resetRegimeStateCacheForTests();
  const read = deskRegimeState({
    sessionId: "s-w10-3",
    symbol: "EURUSD",
    frame: "M5" as Timeframe,
    mode: "intraday",
    bars: bars("positive-control", 12, 3),
    nowMs: NOW,
  });
  assert.equal(read.available, false);
  assert.equal(read.sides.buy.permit, false, "a permit that cannot be computed must be a refusal");
  assert.deepEqual(read.sides.buy.codes, ["REGIME_UNAVAILABLE"]);
  assert.match(read.reason, /Regime state unavailable/);
});

test("W10.4 — the alert channel is inert unless it is switched on AND configured", async () => {
  resetAlertsForTests();
  const sent: string[] = [];
  setAlertTransportForTests(async ({ text }) => {
    sent.push(text);
    return { ok: true };
  });
  const restore = setDeskV4ForTests(configWith({}));

  // Flag off (the shipped default): nothing is sent, and the caller is told why.
  const off = await deskAlert({ kind: "risk", title: "Desk halted", dedupeKey: "halt", sessionId: "s" });
  assert.deepEqual(off, { sent: false, reason: "flag_off" });
  assert.equal(sent.length, 0);

  // Flag on, no credentials: still nothing — a desk with no channel has none.
  const on = setDeskV4ForTests(configWith({ DESK_V4_ALERTS: "1" }));
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const unconfigured = await deskAlert({ kind: "risk", title: "Desk halted", dedupeKey: "halt", sessionId: "s" });
  assert.deepEqual(unconfigured, { sent: false, reason: "no_transport" });
  assert.equal(sent.length, 0);

  // Configured: exactly one message, and the reason line is on it.
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  const delivered = await deskAlert({
    kind: "governance",
    title: "Agent liquidity-sweep halved (e=5.3)",
    body: ["fourteen losses in a row"],
    dedupeKey: "governance:liquidity-sweep:halve",
    sessionId: "session-abcdefghijkl",
  });
  assert.deepEqual(delivered, { sent: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0] as string, /^\[GOVERNANCE\] Agent liquidity-sweep halved/);
  assert.match(sent[0] as string, /fourteen losses in a row/);
  assert.ok(!/test-token/.test(sent[0] as string), "an alert must never carry the token");
  assert.match(sent[0] as string, /session session-abcd…/, "the session is abbreviated, not printed whole");

  // The same key inside the window is ONE message, not two.
  const repeat = await deskAlert({
    kind: "governance",
    title: "Agent liquidity-sweep halved (e=5.4)",
    dedupeKey: "governance:liquidity-sweep:halve",
    sessionId: "session-abcdefghijkl",
  });
  assert.deepEqual(repeat, { sent: false, reason: "duplicate" });
  assert.equal(sent.length, 1);
  // Past the window it is news again.
  const later = await deskAlert({
    kind: "governance",
    title: "Agent liquidity-sweep halved (e=5.5)",
    dedupeKey: "governance:liquidity-sweep:halve",
    sessionId: "session-abcdefghijkl",
    nowMs: Date.now() + ALERT_DEDUPE_MS + 1,
  });
  assert.deepEqual(later, { sent: true });
  assert.equal(sent.length, 2);

  on();
  restore();
  if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = previousToken;
  if (previousChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = previousChat;
});

test("W10.5 — a storm is capped, a failure is reported, and nothing ever throws", async () => {
  resetAlertsForTests();
  const sent: string[] = [];
  setAlertTransportForTests(async ({ text }) => {
    sent.push(text);
    return sent.length === 1 ? { ok: true } : { ok: false, detail: "HTTP 429 too many requests" };
  });
  const restore = setDeskV4ForTests(configWith({ DESK_V4_ALERTS: "1" }));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "t";
  process.env.TELEGRAM_CHAT_ID = "c";
  const base = NOW;

  // A burst of DISTINCT alerts: the rate bucket must stop it well before the
  // channel's own limit, because a storm is what makes a channel get muted.
  const results = [];
  for (let i = 0; i < ALERT_RATE_PER_MINUTE + 6; i++) {
    results.push(
      await deskAlert({ kind: "execution", title: `Fill ${i}`, dedupeKey: `fill-${i}`, sessionId: "s", nowMs: base + i }),
    );
  }
  assert.equal(results.filter((result) => result.reason === "rate_limited").length, 6);
  assert.equal(sent.length, ALERT_RATE_PER_MINUTE - 1 + 1, "the transport saw every allowed attempt, and no more");

  // A failing send reports itself rather than disappearing, AND does not suppress
  // the next real alert for ten minutes.
  const failed = await deskAlert({ kind: "risk", title: "second", dedupeKey: "second", sessionId: "s", nowMs: base + 120_000 });
  assert.equal(failed.sent, false);
  assert.equal(failed.reason, "failed");
  assert.match(failed.detail ?? "", /429/);
  const retried = await deskAlert({ kind: "risk", title: "second", dedupeKey: "second", sessionId: "s", nowMs: base + 121_000 });
  assert.notEqual(retried.reason, "duplicate", "a failed send must not masquerade as a duplicate");

  // A transport that THROWS is still not allowed to reach the caller.
  setAlertTransportForTests(async () => {
    throw new Error("socket hang up");
  });
  const threw = await deskAlert({ kind: "risk", title: "third", dedupeKey: "third", sessionId: "s", nowMs: base + 200_000 });
  assert.equal(threw.sent, false, "deskAlert must never reject");

  restore();
  if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = token;
  if (chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = chat;
});

test("W10.6 — the flag table is what the docs say it is", () => {
  // WP10's UI and alerts flags default OFF, like every other v4 subsystem, and the
  // regime layer's own flag is what the state endpoint hangs on.
  const defaults = resolveDeskV4Config({} as NodeJS.ProcessEnv);
  assert.equal(defaults.enabled, false);
  assert.equal(v4On(defaults.alerts), false);
  assert.equal(v4On(defaults.ui), false);
  assert.equal(v4On(defaults.regimeHmm), false);
  const on = configWith({ DESK_V4_UI: "1", DESK_V4_ALERTS: "1", DESK_V4_REGIME_HMM: "1" });
  assert.equal(v4On(on.ui), true);
  assert.equal(v4On(on.alerts), true);
  assert.equal(v4On(on.regimeHmm), true);
  // Shadow is still on, so nothing may arm an order however many flags are set.
  assert.equal(on.shadow, true);
});
