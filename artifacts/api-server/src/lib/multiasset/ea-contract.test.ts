/**
 * EA wire-contract tests.
 *
 * The MQL5 Expert Advisor cannot be compiled or executed in CI, so the one
 * thing that can genuinely break without anyone noticing is the *contract*:
 * rename `plan.trigger`, nest `management.trail` one level deeper, or let the
 * command wrapper and the plan share a field name, and the EA silently reads
 * a zero. A zero trigger means "fire immediately"; a zero stop-loss means an
 * unprotected position. This is the highest-consequence seam in the system.
 *
 * So these tests port NeurotradeBridge.mq5's JSON readers to TypeScript —
 * deliberately line-for-line, including their limitations — and run them over
 * payloads produced by the real serialiser. If the server's shape drifts from
 * what the EA can read, this fails.
 *
 * When you change a parser in the .mq5 file, change it here too.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import type { ArmedPlan, BridgeCommand, SyncResponse } from "./types";

// ── Port of the EA's readers ────────────────────────────────────────────────

function jsonString(json: string, key: string): string {
  const needle = `"${key}":"`;
  let start = json.indexOf(needle);
  if (start < 0) return "";
  start += needle.length;
  const end = json.indexOf('"', start);
  return end < 0 ? "" : json.slice(start, end);
}

function jsonNumber(json: string, key: string): number {
  const needle = `"${key}":`;
  let start = json.indexOf(needle);
  if (start < 0) return 0;
  start += needle.length;
  let end = start;
  while (end < json.length && /[0-9+\-.eE]/.test(json[end] as string)) end++;
  return end === start ? 0 : Number(json.slice(start, end));
}

function jsonFirstArrayNumber(json: string, key: string): number {
  const needle = `"${key}":[`;
  let start = json.indexOf(needle);
  if (start < 0) return 0;
  start += needle.length;
  let end = start;
  while (end < json.length && /[0-9\-.eE]/.test(json[end] as string)) end++;
  return end === start ? 0 : Number(json.slice(start, end));
}

function jsonBool(json: string, key: string): number {
  const needle = `"${key}":`;
  const start = json.indexOf(needle);
  if (start < 0) return -1;
  return json.slice(start + needle.length, start + needle.length + 4) === "true" ? 1 : 0;
}

/** Port of the EA's dynamic subscription-list reader. */
function jsonStringArray(json: string, key: string): string[] {
  const needle = `"${key}":[`;
  const start = json.indexOf(needle);
  if (start < 0) return [];
  let cursor = start + needle.length;
  const values: string[] = [];
  while (cursor < json.length) {
    while (/[\s,]/.test(json[cursor] ?? "")) cursor++;
    if (json[cursor] === "]") break;
    if (json[cursor] !== '"') return [];
    cursor++;
    let value = "";
    let closed = false;
    while (cursor < json.length) {
      const ch = json[cursor++];
      if (ch === '"') {
        closed = true;
        break;
      }
      if (ch === "\\" && cursor < json.length) {
        const escaped = json[cursor++];
        value += ({ '"': '"', "\\": "\\", "/": "/", n: "\\n", r: "\\r", t: "\\t" } as Record<string, string>)[escaped ?? ""] ?? escaped;
      } else value += ch;
    }
    if (!closed) return [];
    values.push(value);
  }
  return values;
}

function jsonObject(json: string, key: string): string {
  const needle = `"${key}":{`;
  let start = json.indexOf(needle);
  if (start < 0) return "";
  start += needle.length - 1; // land on the opening brace
  let depth = 0;
  for (let i = start; i < json.length; i++) {
    if (json[i] === "{") depth++;
    else if (json[i] === "}") {
      depth--;
      if (depth === 0) return json.slice(start, i + 1);
    }
  }
  return "";
}

/** Port of the EA's ApplyServerResponse command splitter. */
function splitCommands(json: string): string[] {
  const cursor = json.indexOf('"commands"');
  if (cursor < 0) return [];
  const start = json.indexOf("[", cursor);
  if (start < 0) return [];

  const out: string[] = [];
  let depth = 0;
  let objStart = -1;
  for (let i = start; i < json.length; i++) {
    const ch = json[i];
    if (ch === "{") {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        out.push(json.slice(objStart, i + 1));
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

/** Port of UpdateNewsCalendarFromResponse's flat event-object splitter. */
function jsonObjectArray(json: string, key: string): string[] {
  const needle = `"${key}":[`;
  const start = json.indexOf(needle);
  if (start < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let objectStart = -1;
  for (let i = start + needle.length; i < json.length; i++) {
    const ch = json[i];
    if (ch === "{") {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objectStart >= 0) {
        out.push(json.slice(objectStart, i + 1));
        objectStart = -1;
      }
    } else if (ch === "]" && depth === 0) break;
  }
  return out;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function samplePlan(): ArmedPlan {
  return {
    id: "4edcd98d-5f5c-44c7-b916-d47e06bb5f80",
    symbol: "EURUSD",
    side: "buy",
    mode: "intraday",
    trigger: 1.0931769352942222,
    triggerType: "break",
    confirmTicks: 2,
    invalidate: 1.0928953235288885,
    sl: 1.0925433088222214,
    tp: [1.095476764711114, 1.0981],
    lots: 0.57,
    riskMoney: 36.12,
    // = |trigger - sl| / point, i.e. measured from the realistic fill.
    riskPoints: 63.36264720008255,
    maxSpreadPoints: 24,
    maxSlippagePoints: 6,
    expiresAt: 1791372196872,
    createdAt: 1791371596872,
    management: {
      breakeven: { triggerR: 1.2, offsetR: 0.2, structureBuffer: true },
      partials: [
        { atR: 1.5, closePct: 35 },
        { atR: 3, closePct: 25 },
      ],
      trail: { mode: "atr_chandelier", period: 14, mult: 2.5, activateAtR: 1.2, stepPoints: 5 },
      pyramid: {
        maxAdds: 1,
        addAtR: 1.5,
        sizeRatio: 0.5,
        requireBaseAtBreakeven: true,
        portfolioRiskCapR: 1.5,
      },
      timeStop: { noProgressBars: 25, timeframe: "M15" },
    },
  } as ArmedPlan;
}

function sampleResponse(commands: BridgeCommand[]): SyncResponse {
  return {
    serverTime: 1791371596872,
    commands,
    needsHistory: false,
    needsUniverse: false,
    subscriptions: { symbols: ["EURUSD"], timeframes: ["M1", "M5", "M15"] },
    newsCalendar: {
      ready: true,
      fetchedAt: 1791371596872,
      staleAfterMs: 600_000,
      blackoutBeforeMs: 1_800_000,
      blackoutAfterMs: 900_000,
      events: [{ id: "event-123", currency: "USD", ts: 1791376996872 }],
    },
    limits: {
      maxDailyLossPct: 3,
      maxOpenPositions: 4,
      tradingEnabled: true,
      liveTradingEnabled: false,
      staleAfterMs: 30_000,
      flatOnDisconnect: false,
    },
  } as SyncResponse;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("EA reads every armed-plan field the server sends", () => {
  const plan = samplePlan();
  const command: BridgeCommand = { id: "5bc2c8c9-9dbb-41fc-acb2-b975a13431b4", type: "arm_plan", plan };
  const raw = JSON.stringify(sampleResponse([command]));

  const objects = splitCommands(raw);
  assert.equal(objects.length, 1);
  const obj = objects[0] as string;

  const nested = jsonObject(obj, "plan");
  assert.notEqual(nested, "", "EA must find the nested plan object");

  assert.equal(jsonString(obj, "id"), command.id);
  assert.equal(jsonString(obj, "type"), "arm_plan");

  // The regression that motivated jsonObject(): the command wrapper and the
  // plan both carry "id". A flat search returns the wrapper's, so the EA would
  // register the plan under the wrong key and never match a cancel_plan.
  assert.equal(jsonString(nested, "id"), plan.id);
  assert.notEqual(jsonString(nested, "id"), jsonString(obj, "id"));

  assert.equal(jsonString(nested, "symbol"), plan.symbol);
  assert.equal(jsonString(nested, "side"), plan.side);
  assert.equal(jsonNumber(nested, "trigger"), plan.trigger);
  assert.equal(jsonNumber(nested, "invalidate"), plan.invalidate);
  assert.equal(jsonNumber(nested, "sl"), plan.sl);
  assert.equal(jsonFirstArrayNumber(nested, "tp"), plan.tp[0]);
  assert.equal(jsonNumber(nested, "lots"), plan.lots);
  assert.equal(jsonNumber(nested, "maxSpreadPoints"), plan.maxSpreadPoints);
  assert.equal(jsonNumber(nested, "maxSlippagePoints"), plan.maxSlippagePoints);
  assert.equal(jsonNumber(nested, "expiresAt"), plan.expiresAt);
  assert.equal(jsonNumber(nested, "confirmTicks"), plan.confirmTicks);
});

test("EA reads the nested management plan", () => {
  const plan = samplePlan();
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");

  const mgmt = jsonObject(nested, "management");
  const breakeven = jsonObject(mgmt, "breakeven");
  const trail = jsonObject(mgmt, "trail");

  assert.notEqual(mgmt, "");
  assert.equal(jsonNumber(breakeven, "triggerR"), 1.2);
  assert.equal(jsonNumber(breakeven, "offsetR"), 0.2);
  assert.equal(jsonNumber(trail, "mult"), 2.5);
  assert.equal(jsonNumber(trail, "activateAtR"), 1.2);

  // "mult" also appears nowhere above trail — but if it ever did, the scoped
  // read must still win. Guard against a flat search regression.
  assert.notEqual(jsonNumber(trail, "mult"), jsonNumber(breakeven, "mult"));
});

test("a plan with no trail is read as trailing disabled, not as mult=0", () => {
  const plan = samplePlan();
  delete (plan.management as { trail?: unknown }).trail;
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  const trail = jsonObject(jsonObject(nested, "management"), "trail");

  // The EA keys `trailEnabled` off the object's presence. An empty string here
  // is what makes that work.
  assert.equal(trail, "");
});

test("EA receives the current calendar status and exact event time/currency for its local blackout veto", () => {
  const response = sampleResponse([]);
  const raw = JSON.stringify(response);
  const calendar = jsonObject(raw, "newsCalendar");
  assert.notEqual(calendar, "");
  assert.equal(jsonBool(calendar, "ready"), 1);
  assert.equal(jsonNumber(calendar, "staleAfterMs"), 600_000);
  assert.equal(jsonNumber(calendar, "blackoutBeforeMs"), 1_800_000);
  assert.equal(jsonNumber(calendar, "blackoutAfterMs"), 900_000);
  assert.equal(jsonNumber(calendar, "fetchedAt"), 1791371596872);

  const events = jsonObjectArray(calendar, "events");
  assert.equal(events.length, 1);
  assert.equal(jsonString(events[0] as string, "id"), "event-123");
  assert.equal(jsonString(events[0] as string, "currency"), "USD");
  assert.equal(jsonNumber(events[0] as string, "ts"), 1791376996872);

  response.newsCalendar.ready = false;
  const unavailable = jsonObject(JSON.stringify(response), "newsCalendar");
  assert.equal(jsonBool(unavailable, "ready"), 0, "a missing/stale feed must tell the EA to refuse new entries");
});

test("EA reads the limit flags it gates trading on", () => {
  const raw = JSON.stringify(sampleResponse([]));
  assert.equal(jsonBool(raw, "tradingEnabled"), 1);
  assert.equal(jsonBool(raw, "liveTradingEnabled"), 0);
  assert.equal(jsonBool(raw, "needsHistory"), 0);

  // An absent key must read as -1 (unknown), never as 0/false, so the EA can
  // tell "server said no" apart from "server never said".
  assert.equal(jsonBool(raw, "noSuchFlag"), -1);
});

test("EA follows the server's dynamic broker subscriptions and universe request", () => {
  const raw = JSON.stringify({
    ...sampleResponse([]),
    needsUniverse: true,
    subscriptions: { symbols: ["EURUSD.a", "BTCUSD", "US30"], timeframes: ["M1", "M5"] },
  });
  assert.equal(jsonBool(raw, "needsUniverse"), 1);
  assert.deepEqual(jsonStringArray(raw, "symbols"), ["EURUSD.a", "BTCUSD", "US30"]);
});

test("the command splitter handles several commands and nested braces", () => {
  const raw = JSON.stringify(
    sampleResponse([
      { id: "a", type: "arm_plan", plan: samplePlan() },
      { id: "b", type: "cancel_plan", planId: "zzz" },
      { id: "c", type: "flatten_all", reason: "kill switch" },
    ] as BridgeCommand[]),
  );

  const objects = splitCommands(raw);
  assert.equal(objects.length, 3, "deeply nested plan objects must not split early");
  assert.equal(jsonString(objects[0] as string, "type"), "arm_plan");
  assert.equal(jsonString(objects[1] as string, "type"), "cancel_plan");
  assert.equal(jsonString(objects[1] as string, "planId"), "zzz");
  assert.equal(jsonString(objects[2] as string, "type"), "flatten_all");
});

test("an empty command list yields no commands", () => {
  assert.deepEqual(splitCommands(JSON.stringify(sampleResponse([]))), []);
});

test("sizing round-trips through the wire without precision loss", () => {
  // Lots and price levels are the two things that must survive serialisation
  // exactly. A truncated stop-loss is a real-money error.
  const plan = samplePlan();
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");

  assert.equal(jsonNumber(nested, "lots"), 0.57);
  assert.equal(jsonNumber(nested, "sl").toFixed(5), plan.sl.toFixed(5));

  // The EA measures risk from the price it actually fills at — the trigger —
  // so riskPoints on the wire must be the TRIGGER-to-stop distance, not the
  // quote-to-stop distance. Sizing off the quote silently risks more than the
  // budget, because the trigger sits further from the stop.
  const point = 0.00001;
  const triggerToStop = Math.abs(jsonNumber(nested, "trigger") - jsonNumber(nested, "sl")) / point;
  assert.ok(
    Math.abs(triggerToStop - plan.riskPoints) < 0.01,
    `riskPoints (${plan.riskPoints}) must equal the trigger-to-stop distance (${triggerToStop})`,
  );

  // And the lots the EA receives must reproduce exactly from that distance.
  const lots = Math.floor(plan.riskMoney / (triggerToStop * 1.0) / 0.01) * 0.01;
  assert.equal(Number(lots.toFixed(2)), plan.lots);
});
