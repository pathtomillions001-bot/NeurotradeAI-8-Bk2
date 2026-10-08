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
import { readFileSync } from "node:fs";
import path from "node:path";
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
      breakeven: { triggerR: 1, offsetR: 0.1 },
      extension: { checkAtR: 1.8, extendToR: 3, lockR: 1, emaPeriod: 50, timeframe: "M15" },
      timeStop: { maxHoldMinutes: 360 },
      guards: { maxSpreadPoints: 24, newsBlackoutMin: 30, flatBeforeSessionClose: false },
    },
  } as ArmedPlan;
}

function sampleResponse(commands: BridgeCommand[]): SyncResponse {
  return {
    serverTime: 1791371596872,
    commands,
    needsHistory: false,
    subscriptions: { symbols: ["EURUSD"], timeframes: ["M1", "M5", "M15"] },
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

test("EA reads the nested management plan: breakeven, extension and time stop", () => {
  const plan = samplePlan();
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");

  const mgmt = jsonObject(nested, "management");
  const breakeven = jsonObject(mgmt, "breakeven");
  const extension = jsonObject(mgmt, "extension");
  const timeStop = jsonObject(mgmt, "timeStop");

  assert.notEqual(mgmt, "");
  assert.equal(jsonNumber(breakeven, "triggerR"), 1);
  assert.equal(jsonNumber(breakeven, "offsetR"), 0.1);
  assert.equal(jsonNumber(extension, "checkAtR"), 1.8);
  assert.equal(jsonNumber(extension, "extendToR"), 3);
  assert.equal(jsonNumber(extension, "lockR"), 1);
  assert.equal(jsonNumber(extension, "emaPeriod"), 50);
  assert.equal(jsonString(extension, "timeframe"), "M15");
  assert.equal(jsonNumber(timeStop, "maxHoldMinutes"), 360);
});

test("a plan with no extension is read as extension disabled, not as checkAtR=0", () => {
  const plan = samplePlan();
  plan.management.extension = null;
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  const extension = jsonObject(jsonObject(nested, "management"), "extension");

  // The EA keys `extEnabled` off the object's presence. An empty string here is
  // what makes that work.
  assert.equal(extension, "");
});

test("a plan with no time stop is read as no time stop, not as a zero-minute stop", () => {
  const plan = samplePlan();
  plan.management.timeStop = null;
  const raw = JSON.stringify(sampleResponse([{ id: "cmd-1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  const timeStop = jsonObject(jsonObject(nested, "management"), "timeStop");

  // The EA computes maxHoldSec = minutes × 60 and treats 0 as "no time stop".
  assert.equal(timeStop, "");
});

test("the EA declares the version the server expects", () => {
  // An EA that reports a different version is flagged as out of date, so the two
  // must move together. The heartbeat must also report the version it declares.
  const ea = readFileSync(
    path.resolve(import.meta.dirname, "../../../../mt5-ea/NeurotradeBridge.mq5"),
    "utf8",
  );
  const bridge = readFileSync(path.resolve(import.meta.dirname, "../../routes/bridge.ts"), "utf8");
  const declared = /#property version\s+"([\d.]+)"/.exec(ea)?.[1];
  const expected = /export const EXPECTED_EA_VERSION = "([\d.]+)"/.exec(bridge)?.[1];
  assert.ok(declared && expected, "both version strings are present");
  assert.equal(declared, expected);
  assert.ok(ea.includes(`\\"version\\":\\"${expected}\\"`), "the sync body reports the declared version");
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

test("the v2 EA remains attached while pairing is unavailable and discovers all broker markets", () => {
  const ea = readFileSync(
    path.resolve(import.meta.dirname, "../../../../mt5-ea/NeurotradeBridge.mq5"),
    "utf8",
  );
  // The failure that motivated v2: an initial pairing error returned
  // INIT_FAILED, so MT5 silently removed the EA from the chart. Pairing now
  // retries from the timer and OnInit has only the successful return path.
  assert.match(ea, /int\s+OnInit\s*\(\)/);
  assert.match(ea, /return\s*\(INIT_SUCCEEDED\)/);
  assert.doesNotMatch(ea, /return\s*\(INIT_FAILED\)/);
  assert.match(ea, /SymbolsTotal\(false\)/, "catalogue must enumerate the broker universe, not a hard-coded CSV");
  assert.match(ea, /CalendarValueHistory/, "EA must source red-folder events from MT5's economic calendar");
  assert.match(ea, /UpdateSubscriptions/, "server-selected markets must update without reattaching the EA");
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
