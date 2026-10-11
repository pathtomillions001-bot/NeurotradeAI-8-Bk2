/**
 * WP10 — the learning surface over HTTP.
 *
 * The unit tests prove the pieces; this proves the SURFACE, which is where the
 * shipped-API promise actually lives: every new endpoint must be absent while its
 * subsystem is off (a 404, not an empty 200), and present — with the desk's own
 * numbers — once it is on. A route that returned `{agents: []}` with the flag off
 * would still be part of the public API, and the v4 brief's rule is that a desk
 * which has never switched the layer on has exactly the API it had before.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import express from "express";

import { runWithSession } from "../lib/session";
import { deskV4, resolveDeskV4Config, setDeskV4ForTests } from "../lib/multiasset/desk-v4-config";
import { getDesk, resetDesk } from "../lib/multiasset/store";
import { recordJournalEntry, resetGovernanceStoreForTests } from "../lib/multiasset/governance-store";
import { __resetGovernanceRuntimeForTests } from "../lib/multiasset/governance-runtime";
import { resetRegimeStateCacheForTests } from "../lib/multiasset/regime-state";
import { resetAlertsForTests, setAlertTransportForTests } from "../lib/multiasset/alerts";
import type { DeskV4Config } from "../lib/multiasset/desk-v4-config";
import router from "./desk";

const SESSION = "11111111-2222-3333-4444-555555555555";

function configWith(overrides: Record<string, string>): DeskV4Config {
  return resolveDeskV4Config({ DESK_V4_ENABLED: "1", DESK_V4_SHADOW: "1", ...overrides } as NodeJS.ProcessEnv);
}

describe("WP10 — the learning surface", () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    runWithSession(SESSION, next);
  });
  app.use("/api/desk", router);
  const server = createServer(app);
  let baseUrl = "";
  let restore: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });
  after(async () => {
    restore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const post = async (path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  it("is absent until the layers are switched on", async () => {
    restore = setDeskV4ForTests(resolveDeskV4Config({} as NodeJS.ProcessEnv));
    assert.equal(deskV4().enabled, false);
    for (const path of ["/api/desk/regime", "/api/desk/learning/journal", "/api/desk/governance", "/api/desk/learning/weekly"]) {
      const response = await get(path);
      assert.equal(response.status, 404, `${path} must 404 while its flag is off`);
      assert.match(String(response.body.error), /switched off/);
    }
    const resume = await post("/api/desk/governance/resume", { agentId: "liquidity-sweep", note: "please" });
    assert.equal(resume.status, 404);
    restore();
  });

  it("serves the regime state, the journal, the registry and the weekly report when on", async () => {
    await resetGovernanceStoreForTests();
    __resetGovernanceRuntimeForTests();
    resetRegimeStateCacheForTests();
    resetAlertsForTests();
    setAlertTransportForTests(async () => ({ ok: true }));
    resetDesk(SESSION);
    restore = setDeskV4ForTests(configWith({ DESK_V4_REGIME_HMM: "1", DESK_V4_GOVERNANCE: "1" }));

    // The desk has no terminal yet, so the regime read must say so per symbol
    // rather than inventing a state.
    const desk = getDesk(SESSION);
    desk.watchlist = ["EURUSD"];
    const regime = await get("/api/desk/regime");
    assert.equal(regime.status, 200);
    assert.equal(regime.body.ttlMs, 2_000);
    const states = regime.body.states as Record<string, unknown>[];
    assert.equal(states.length, 1);
    assert.equal(states[0]?.available, false);
    assert.equal(states[0]?.bars, 0);
    assert.match(String(states[0]?.reason), /Regime state unavailable/);

    // The durable journal is what the page reads: write one row through the same
    // path the desk uses and read it back through the route.
    await recordJournalEntry({
      sessionId: SESSION,
      entryId: "route-journal-1",
      tsMs: Date.now(),
      kind: "risk",
      symbol: "EURUSD",
      message: "Agent liquidity-sweep halved by the WP9 e-process.",
      detail: { eValue: 5.3 },
    });
    const journal = await get("/api/desk/learning/journal?limit=10");
    assert.equal(journal.status, 200);
    const entries = journal.body.entries as Record<string, unknown>[];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.id, "route-journal-1");
    assert.equal(entries[0]?.kind, "risk");
    const filtered = await get("/api/desk/learning/journal?kind=execution");
    assert.equal((filtered.body.entries as unknown[]).length, 0, "the kind filter is applied server-side");
    // `DESK_V4_UI` is off in this configuration: the message survives and the
    // structured detail is withheld, which is what "no extra UI payloads" means.
    assert.equal(journal.body.detailIncluded, false);
    assert.equal(entries[0]?.detail, null);

    const registry = await get("/api/desk/governance");
    assert.equal(registry.status, 200);
    const agents = registry.body.agents as Record<string, unknown>[];
    assert.equal(agents.length, 5, "every shipped agent is governed, whether or not it has traded yet");
    assert.equal(agents[0]?.halveAt, 5);
    assert.equal(agents[0]?.disableAt, 20);
    assert.equal(agents[0]?.status, "active");
    assert.equal(agents[0]?.eValue, 1, "a fresh registry starts at the unit prior, not at zero");

    const weekly = await get("/api/desk/learning/weekly");
    assert.equal(weekly.status, 200);
    assert.equal((weekly.body.decisions as Record<string, unknown>).evaluated, 0);
    assert.ok(Array.isArray(weekly.body.flags));
    assert.match(String(weekly.body.weekStart), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("requires a reason to resume an agent, and refuses unknown ones", async () => {
    const missing = await post("/api/desk/governance/resume", { agentId: "liquidity-sweep" });
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /note is required/);

    const unknown = await post("/api/desk/governance/resume", { agentId: "not-an-agent", note: "because" });
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.body.error), /agentId must be one of/);

    const ok = await post("/api/desk/governance/resume", { agentId: "liquidity-sweep", note: "seasonal effect, not decay" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    const agent = ok.body.agent as Record<string, unknown>;
    assert.equal(agent.agentId, "liquidity-sweep");
    assert.equal(agent.status, "active");
    assert.match(String(agent.reason), /resumed by the operator at .*: seasonal effect, not decay/);

    // And the resume is visible in the desk's own journal — the operator action is
    // an event like any other, not a silent flag flip.
    const desk = getDesk(SESSION);
    assert.ok(
      desk.journal.some((entry) => /resumed by the operator/.test(entry.message)),
      "the resume must be journalled",
    );
    restore();
  });
});
