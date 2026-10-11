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

/**
 * Port of the EA's `JsonArray()`: the raw text between `"key":[` and the
 * matching `]`, respecting nesting so a nested object cannot end the array.
 */
function jsonArray(json: string, key: string): string {
  const needle = `"${key}":[`;
  let start = json.indexOf(needle);
  if (start < 0) return "";
  start += needle.length;
  let depth = 0;
  for (let i = start; i < json.length; i++) {
    const ch = json[i];
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      if (ch === "]" && depth === 0) return json.slice(start, i);
      depth--;
    }
  }
  return "";
}

/** Port of the EA's `NextObjectInArray()`: the next brace-balanced object. */
function nextObjectInArray(body: string, cursor: { at: number }): string {
  let start = -1;
  for (let i = cursor.at; i < body.length; i++) {
    if (body[i] === "{") {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        cursor.at = i + 1;
        return body.slice(start, i + 1);
      }
    }
  }
  return "";
}

/** Port of the EA's `ApplyServerResponse` command splitter. */
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
      guards: { maxSpreadPoints: 24, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    },
    entryTimeframe: "M15",
    costPoints: 18.5,
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

// ── v4.00: the management contract (WP0) ────────────────────────────────────

test("EA reads the whole management block it needs to manage the position", () => {
  const raw = JSON.stringify(sampleResponse([{ id: "c1", type: "arm_plan", plan: samplePlan() }]));
  const plan = jsonObject(splitCommands(raw)[0] as string, "plan");
  const mgmt = jsonObject(plan, "management");
  const guards = jsonObject(mgmt, "guards");
  const timeStop = jsonObject(mgmt, "timeStop");

  // The entry frame and the round-trip cost ride on the PLAN, not inside
  // `management`: the machine needs the first for its chandelier ATR and the
  // second to put break-even at entry + cost rather than at entry.
  assert.equal(jsonString(plan, "entryTimeframe"), "M15");
  assert.equal(jsonNumber(plan, "costPoints"), 18.5);

  assert.equal(jsonBool(jsonObject(mgmt, "breakeven"), "structureBuffer"), 1);
  assert.equal(jsonNumber(timeStop, "noProgressBars"), 25);
  assert.equal(jsonString(timeStop, "timeframe"), "M15");
  assert.equal(jsonBool(guards, "flatBeforeSessionClose"), 1);
  assert.equal(jsonNumber(guards, "maxSpreadPoints"), 24);
});

test("the partial ladder is read element by element, not by first match", () => {
  const raw = JSON.stringify(sampleResponse([{ id: "c1", type: "arm_plan", plan: samplePlan() }]));
  const plan = jsonObject(splitCommands(raw)[0] as string, "plan");
  const partials = jsonArray(jsonObject(plan, "management"), "partials");

  // The regression this guards: a flat `jsonNumber(json, "atR")` over the array
  // text returns the FIRST element's 1.5 for every slot, so a two-rung ladder
  // collapses into "take 35% at 1.5R" twice and the 3R rung never fires.
  const cursor = { at: 0 };
  const rungs: { atR: number; closePct: number }[] = [];
  let element = nextObjectInArray(partials, cursor);
  while (element !== "") {
    rungs.push({ atR: jsonNumber(element, "atR"), closePct: jsonNumber(element, "closePct") });
    element = nextObjectInArray(partials, cursor);
  }

  assert.deepEqual(rungs, [
    { atR: 1.5, closePct: 35 },
    { atR: 3, closePct: 25 },
  ]);
  assert.notEqual(
    jsonNumber(partials, "atR"),
    rungs[1]?.atR,
    "a flat read over the array text must not be what the EA relies on",
  );
});

test("a plan with no partials yields an empty ladder, not a zero-rung one", () => {
  const plan = samplePlan();
  (plan.management as { partials: unknown[] }).partials = [];
  const raw = JSON.stringify(sampleResponse([{ id: "c1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  const partials = jsonArray(jsonObject(nested, "management"), "partials");
  assert.equal(partials, "");
  assert.equal(nextObjectInArray(partials, { at: 0 }), "");
});

test("set_management carries the same block at the top level", () => {
  const command: BridgeCommand = {
    id: "c9",
    type: "set_management",
    ticket: 55201,
    management: {
      breakeven: { triggerR: 1.5, offsetR: 0.2, structureBuffer: true },
      partials: [{ atR: 1.5, closePct: 35 }],
      trail: { mode: "atr_chandelier", period: 14, mult: 3, activateAtR: 1.2, stepPoints: 12 },
      pyramid: null,
      timeStop: { noProgressBars: 25, timeframe: "M15" },
      guards: { maxSpreadPoints: 24, newsBlackoutMin: 15, flatBeforeSessionClose: true },
    },
  };
  const raw = JSON.stringify(sampleResponse([command]));
  const obj = splitCommands(raw)[0] as string;

  assert.equal(jsonString(obj, "type"), "set_management");
  assert.equal(jsonNumber(obj, "ticket"), 55201);
  // The EA reads the block from the command itself when there is no enclosing
  // `plan` object — `ParseManagementIntoPlan` falls back to the top level.
  const mgmt = jsonObject(obj, "management");
  assert.equal(jsonNumber(jsonObject(mgmt, "breakeven"), "triggerR"), 1.5);
  assert.equal(jsonArray(mgmt, "partials").includes("35"), true);
});

test("EA reads the round-trip cost and entry frame it needs for break-even", () => {
  const plan = samplePlan();
  const raw = JSON.stringify(sampleResponse([{ id: "c1", type: "arm_plan", plan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  assert.ok(jsonNumber(nested, "costPoints") > 0, "break-even needs a real cost to offset");
  assert.ok(jsonString(nested, "entryTimeframe").length > 0);
});

test("an older plan without the new optional fields still parses", () => {
  // Backwards compatibility: `entryTimeframe` and `costPoints` are OPTIONAL, so
  // a payload that predates them must read as present-but-zero rather than
  // throwing the reader off.
  const plan = samplePlan() as Record<string, unknown>;
  delete plan.entryTimeframe;
  delete plan.costPoints;
  const raw = JSON.stringify(sampleResponse([{ id: "c1", type: "arm_plan", plan: plan as ArmedPlan }]));
  const nested = jsonObject(splitCommands(raw)[0] as string, "plan");
  assert.equal(jsonNumber(nested, "costPoints"), 0);
  assert.equal(jsonString(nested, "entryTimeframe"), "");
  // The rest of the ladder is unaffected.
  assert.equal(jsonNumber(jsonObject(jsonObject(nested, "management"), "breakeven"), "triggerR"), 1.2);
});

// ── v4.00: the WP0 defect, pinned at the source level ───────────────────────
//
// These assertions read NeurotradeBridge.mq5 directly. They exist because the
// defect they describe is invisible to any payload test: the wire contract was
// always correct, and the EA simply threw the correctly-parsed rules away one
// line after reading them.

// src/lib/multiasset → repo root is five levels up.
const EA_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "..", "..", "..", "artifacts", "mt5-ea", "NeurotradeBridge.mq5"),
  "utf8",
);

test("the EA captures management AT FILL, before the plan is cleared", () => {
  // Scope the check to ExecutePlan: `g_plans[index].active = false;` also appears
  // in its early rejection branch, so a file-wide index comparison would compare
  // against the wrong line.
  const start = EA_SOURCE.indexOf("void ExecutePlan(");
  assert.ok(start > 0, "ExecutePlan must exist");
  const body = EA_SOURCE.slice(start, EA_SOURCE.indexOf("void ManageOpenPositions()"));

  const fill = body.indexOf("CapturePositionStateFromPlan(");
  assert.ok(fill > 0, "a filled plan must hand its rules to the position");

  // The plan is still cleared — that is correct and intentional — but the
  // capture must come first, or the rules die with it.
  const clear = body.lastIndexOf("g_plans[index].active = false;");
  assert.ok(clear > fill, "the capture must precede the plan being cleared");
});

test("position management does not depend on an armed plan surviving", () => {
  // The exact regression: `ManageOpenPositions()` used `FindPlanForSymbol()`,
  // which requires `active` — so after a fill there was no plan to find and the
  // whole ladder silently degraded to a hard-coded +1.0R break-even.
  const start = EA_SOURCE.indexOf("void ManageOpenPositions()");
  assert.ok(start > 0, "ManageOpenPositions must exist");
  const manage = EA_SOURCE.slice(start, EA_SOURCE.indexOf("void HandleCommand("));
  assert.equal(
    /FindPlanForSymbol\s*\(/.test(manage),
    false,
    "management must be looked up by POSITION, never through an armed plan",
  );
  assert.match(manage, /ManagePositionState\s*\(/, "the machine must be what runs");
});

test("the EA persists and restores position state across a restart", () => {
  for (const marker of [
    "SavePositionState",
    "LoadPositionState",
    "ClearPositionState",
    "GlobalVariableSet",
    "GlobalVariableGet",
  ]) {
    assert.match(EA_SOURCE, new RegExp(marker), `the EA must carry ${marker}`);
  }
  // Restored on init, before anything can start managing.
  const init = EA_SOURCE.slice(EA_SOURCE.indexOf("int OnInit()"), EA_SOURCE.indexOf("void OnDeinit"));
  assert.match(init, /LoadPositionState/, "state must be rebuilt before the first tick");
  assert.match(init, /g_positions\[s\]\.active = false/, "the table starts empty, not stale");
});

test("the EA releases its cached indicator handles", () => {
  const deinit = EA_SOURCE.slice(EA_SOURCE.indexOf("void OnDeinit"), EA_SOURCE.indexOf("void OnTick()"));
  assert.match(deinit, /ReleaseAtrHandles\s*\(/, "cached handles must be released on deinit");
  // The old implementation created and released a handle per call.
  assert.equal(
    /double AtrValue[\s\S]{0,400}?IndicatorRelease/.test(EA_SOURCE),
    false,
    "AtrValue must not create/release a handle on every call",
  );
  assert.match(EA_SOURCE, /BarsCalculated\s*\(/, "an unwarmed handle must report no ATR");
});

test("the EA implements the five management steps in the contract order", () => {
  const dispatch = EA_SOURCE.slice(
    EA_SOURCE.indexOf("void ManagePositionState("),
    EA_SOURCE.indexOf("// Capture the plan's rules into a fresh position state"),
  );
  const order = [
    "PositionTerminalExit",
    "PositionApplyPartials",
    "PositionApplyBreakeven",
    "PositionApplyTrail",
    "PositionApplyPyramid",
  ].map((fn) => dispatch.indexOf(`${fn}(`));
  for (const [index, position] of order.entries()) {
    assert.ok(position > 0, `${["terminal exit", "partials", "breakeven", "trail", "pyramid"][index]} must run`);
  }
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(
      (order[i] as number) > (order[i - 1] as number),
      "the steps must run in the documented order",
    );
  }
});

test("the EA only ever tightens a stop, and only through one modification", () => {
  assert.match(EA_SOURCE, /bool Tightens\s*\(/, "the tightening guard must exist");
  // One pending stop per tick: break-even and the trail propose into the same
  // variable, so a tick can never send two competing modifications.
  const dispatch = EA_SOURCE.slice(
    EA_SOURCE.indexOf("void ManagePositionState("),
    EA_SOURCE.indexOf("// Capture the plan's rules into a fresh position state"),
  );
  const modifies = [...dispatch.matchAll(/ApplyStopModify\s*\(/g)];
  assert.equal(modifies.length, 1, "exactly one stop modification per tick");
  assert.match(EA_SOURCE, /Tightens\(st\.isBuy, candidate, reference, st\.point \* 0\.01\)/);
});

test("the EA reports what it did to the desk", () => {
  assert.match(EA_SOURCE, /void AddMgmtEvent\s*\(/, "management events must be queued");
  assert.match(EA_SOURCE, /body \+= "\\"management\\":\[" \+ g_mgmtEvents \+ "\]"/, "and shipped on the heartbeat");
  // Drained only after a successful sync, so a failed beat does not lose them.
  const sync = EA_SOURCE.slice(EA_SOURCE.indexOf("void Sync()"), EA_SOURCE.indexOf("void LearnBrokerClock"));
  const okAt = sync.indexOf("g_lastOk = NowServer();");
  const drainAt = sync.indexOf('g_mgmtEvents = "";');
  assert.ok(okAt > 0 && drainAt > okAt, "events are drained only once the server acknowledged them");
});

test("the EA runs the chandelier on the ENTRY timeframe, not a fixed M15", () => {
  const trail = EA_SOURCE.slice(
    EA_SOURCE.indexOf("void PositionApplyTrail("),
    EA_SOURCE.indexOf("// ── Step 5: pyramid"),
  );
  assert.match(trail, /st\.entryPeriod/, "the trail must use the plan's entry frame");
  assert.equal(
    /\(ENUM_TIMEFRAMES\)st\.entryPeriod[\s\S]{0,80}PERIOD_M15/.test(trail),
    false,
    "the entry frame must not be overridden by M15",
  );
});

test("a fresh fill never inherits a stale regime-exit latch", () => {
  // regimeExit is a one-way latch: once the desk says the regime that justified
  // the trade is gone, management stops trying to nurse the position and closes
  // it. That makes it dangerous to carry between tickets — a recycled ticket
  // whose old state still had `rexit = 1` would flatten a brand-new position on
  // its first tick. Capture must therefore initialise it explicitly.
  const start = EA_SOURCE.indexOf("void CapturePositionStateFromPlan(");
  assert.ok(start > 0, "CapturePositionStateFromPlan must exist");
  const body = EA_SOURCE.slice(start, EA_SOURCE.indexOf("\n}", start));
  assert.match(body, /st\.regimeExit\s*=\s*false\s*;/, "capture must clear the latch");

  // And the time stop's frame falls back to the entry frame when the plan does
  // not carry one, so a legacy payload counts bars on the right series.
  assert.match(
    body,
    /st\.timeStopPeriod\s*=\s*plan\.timeStopPeriod\s*>\s*0\s*\?\s*plan\.timeStopPeriod\s*:\s*st\.entryPeriod\s*;/,
    "a missing time-stop frame must fall back to the entry frame",
  );
});

test("the desk can push a regime exit at runtime, and it survives a restart", () => {
  // The latch is only useful if the desk can set it on a live position, if the
  // state that carries it is persisted, and if management acts on it.
  const setStart = EA_SOURCE.indexOf("void SetManagementCommand(");
  assert.ok(setStart > 0, "set_management handling must exist");
  const setBody = EA_SOURCE.slice(setStart, EA_SOURCE.indexOf("\n}", setStart));
  assert.match(setBody, /JsonBool\(obj,\s*"regimeExit"\)\s*==\s*1/, "set_management must accept regimeExit");

  assert.match(EA_SOURCE, /StateKey\(st\.ticket,\s*"rexit"\)/, "the latch must be persisted");
  assert.match(EA_SOURCE, /ReadState\(ticket,\s*"rexit",\s*0\)/, "and restored");

  // Management honours it as a full close, inside Step 1 (terminal exits). It
  // sits after the session and news flats and BEFORE the time stop, because the
  // time stop is a soft "free the margin" rule while a regime exit is the desk
  // saying the trade's premise is gone — it must not be reachable only after the
  // softer rule has already decided to wait.
  const start = EA_SOURCE.indexOf("bool PositionTerminalExit(");
  assert.ok(start > 0, "the terminal-exit step must exist");
  const body = EA_SOURCE.slice(start, EA_SOURCE.indexOf("\n}", start));
  const regime = body.indexOf("if(st.regimeExit)");
  assert.ok(regime > 0, "the terminal-exit step must act on the latch");
  assert.ok(
    regime < body.indexOf("if(st.timeStopBars"),
    "the regime exit must outrank the time stop",
  );
  // It closes and journals, so the decision is auditable after the fact.
  const branch = body.slice(regime, body.indexOf("if(st.timeStopBars", regime));
  assert.match(branch, /ClosePosition\(st\.ticket, 0, ""\)/, "the branch must flatten the position");
  assert.match(branch, /"close_all"/, "and report it as a close_all");
});
