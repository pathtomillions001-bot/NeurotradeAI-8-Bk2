/**
 * Bot-engine singleton registry tests.
 *
 * The promise: ONE executing bot engine at a time — starting bot B while bot A
 * runs must refuse, loudly, with A's name. This is what keeps the single shared
 * recovery ledger single.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { registerBotEngine, runningOtherEngines, type EngineProbe } from "./engine-registry.js";

const fakes: EngineProbe[] = [];

function fake(key: string, name: string): { set: (running: boolean) => void } {
  const state: EngineProbe = { running: false, name };
  fakes.push(state);
  registerBotEngine(key, () => ({ ...state }));
  return { set: (running: boolean) => { state.running = running; } };
}

beforeEach(() => {
  for (const s of fakes) s.running = false;
});

describe("engine registry — one executing bot at a time", () => {
  it("reports the other running engines and never the caller itself", () => {
    const a = fake("reg-a", "Engine A");
    const b = fake("reg-b", "Engine B");
    a.set(true);
    b.set(false);
    assert.deepEqual(runningOtherEngines("reg-b").map(e => e.key), ["reg-a"]);
    assert.deepEqual(runningOtherEngines("reg-a"), [], "the caller must never report itself");
  });

  it("finds a running engine no matter which one asks", () => {
    const a = fake("reg-c", "Engine C");
    const d = fake("reg-d", "Engine D");
    d.set(true);
    const others = runningOtherEngines("reg-c");
    assert.equal(others.length, 1);
    assert.equal(others[0]!.name, "Engine D");
    d.set(false);
    a.set(true);
    assert.deepEqual(runningOtherEngines("reg-d").map(e => e.key), ["reg-c"]);
  });

  it("reports nothing when the class is idle", () => {
    fake("reg-e", "Engine E").set(false);
    assert.deepEqual(runningOtherEngines("reg-e"), []);
  });
});
