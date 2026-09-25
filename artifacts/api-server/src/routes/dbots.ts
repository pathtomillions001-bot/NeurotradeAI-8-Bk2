/**
 * Deriv DBot routes — create a bot from a scan, run it, watch it, stop it.
 *
 * The builder itself is served by the web app at /bot/ (same origin), so every
 * endpoint here is a plain session-cookie API:
 *
 *   POST   /api/dbots                  create a DBot from a scan result
 *   GET    /api/dbots                  list this session's bots (+ live flag)
 *   GET    /api/dbots/:id              one bot (metadata + seed + fills)
 *   GET    /api/dbots/:id/xml          the compiled Blockly XML (Bot Studio loads it)
 *   POST   /api/dbots/:id/live         the bot is RUNNING → take the account lock
 *   POST   /api/dbots/:id/heartbeat    still running → mirror new fills
 *   POST   /api/dbots/:id/stop         kill switch (user / account switch)
 *   DELETE /api/dbots/:id              remove a stored bot
 *
 * Account isolation is the same as everywhere else in this app: records live
 * under the requesting BROWSER SESSION, and the bot is built for that session's
 * ACTIVE account only — demo stays demo, real stays real, and no endpoint here
 * can be pointed at another session's account.
 */

import { Router } from "express";
import { logger } from "../lib/logger";
import { TURBO_NORMAL_CONTRACTS, TURBO_RECOVERY_CONTRACTS } from "../lib/overunder-turbo-analysis";
import { isNormalContract, isRecoveryContract } from "../lib/dual-lock-analysis";
import { createDbot, TURBO_DBOT_CONSOLE } from "../lib/dbots/factory";
import { mirrorDbotFills } from "../lib/dbots/mirror";
import {
  deleteDbot,
  getDbot,
  heartbeatDbot,
  isDbotRunning,
  listDbots,
  markLive,
  reconcileLive,
  runningDbot,
  stopDbot,
  type DbotRecord,
} from "../lib/dbots/registry";
import type { DbotContract } from "../lib/dbots/strategy-xml";

const router = Router();

/** Public shape of a bot: never leaks the compiled program in list responses. */
function toSummary(record: DbotRecord) {
  const totalProfit = record.fills.reduce((sum, fill) => sum + fill.profit, 0);
  return {
    id: record.id,
    name: record.name,
    symbol: record.symbol,
    displayName: record.displayName,
    contractTypes: record.contractTypes,
    accountId: record.accountId,
    isVirtual: record.isVirtual,
    createdAt: new Date(record.createdAt).toISOString(),
    live: isDbotRunning(record),
    liveSince: record.liveSince ? new Date(record.liveSince).toISOString() : null,
    lastSeenAt: record.lastSeenAt ? new Date(record.lastSeenAt).toISOString() : null,
    stoppedAt: record.stoppedAt ? new Date(record.stoppedAt).toISOString() : null,
    stopReason: record.stopReason,
    /** Set while Bot Studio must stop the builder (kill switch). */
    stopRequested: record.live && record.stopRequestedAt !== null,
    tradeCount: record.fills.length,
    totalProfit: Math.round(totalProfit * 100) / 100,
    source: { console: record.spec.source.console, botId: record.spec.source.botId },
    /** What the run panel shows about the program that will trade. */
    program: {
      stake: record.spec.stake,
      duration: record.spec.duration,
      normal: record.spec.normal,
      recovery: record.spec.recovery,
      limits: record.spec.limits,
      recoveryState: record.spec.recoveryState,
      seed: {
        debt: record.spec.recoveryState.debt,
        markupPercent: record.spec.recoveryState.markupPercent,
        mode: record.spec.recoveryState.debt > 0 ? "recovery" : "normal",
      },
      procedures: ["NeuroTrade Setup", "NeuroTrade Ladder", "NeuroTrade After Purchase"],
    },
    lastFill: record.fills[record.fills.length - 1] ?? null,
  };
}

function parseContract(raw: unknown): DbotContract | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { contractType?: unknown; prediction?: unknown; side?: unknown; barrier?: unknown };
  const contractType = String(value.contractType ?? value.side ?? "");
  const prediction = Number(value.prediction ?? value.barrier);
  if (!contractType || !Number.isFinite(prediction)) return null;
  return { contractType, prediction: Math.round(prediction) };
}

// ── Create ────────────────────────────────────────────────────────────────────

router.post("/", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const source = String(body["source"] ?? "overunder-turbo");
  const symbol = String(body["symbol"] ?? "");
  const normal = parseContract(body["normal"]);
  const recovery = parseContract(body["recovery"]);
  const displayName = typeof body["displayName"] === "string" ? body["displayName"] : undefined;

  if (!symbol || !normal || !recovery) {
    res.status(400).json({ error: "symbol, normal and recovery contracts are required" });
    return;
  }
  if (normal.contractType !== "DIGITOVER" && normal.contractType !== "DIGITUNDER") {
    res.status(400).json({ error: "only digit Over/Under contracts can be compiled into a DBot today" });
    return;
  }
  if (recovery.contractType !== "DIGITOVER" && recovery.contractType !== "DIGITUNDER") {
    res.status(400).json({ error: "only digit Over/Under contracts can be compiled into a DBot today" });
    return;
  }
  // The scan's own contract guards — a DBot may only trade contracts the
  // scanner is allowed to deploy (no hand-crafted barrier sneaking through).
  if (!isNormalContract(normal.contractType, normal.prediction)) {
    res.status(400).json({
      error: `normal contract is not deployable (${TURBO_NORMAL_CONTRACTS.map((c) => `${c.side} ${c.barrier}`).join(", ")})`,
    });
    return;
  }
  if (!isRecoveryContract(recovery.contractType, recovery.prediction)) {
    res.status(400).json({
      error: `recovery contract is not deployable (${TURBO_RECOVERY_CONTRACTS.map((c) => `${c.side} ${c.barrier}`).join(", ")})`,
    });
    return;
  }
  if (source !== "overunder-turbo") {
    res.status(400).json({ error: `unknown DBot source "${source}"` });
    return;
  }

  try {
    const result = await createDbot(req.sessionId, {
      source: { console: TURBO_DBOT_CONSOLE, botId: "overunder-turbo" },
      symbol,
      displayName,
      normal,
      recovery,
      stake: Number(body["stake"]) > 0 ? Number(body["stake"]) : undefined,
      takeProfit: Number(body["takeProfit"]) > 0 ? Number(body["takeProfit"]) : undefined,
      stopLoss: Number(body["stopLoss"]) > 0 ? Number(body["stopLoss"]) : undefined,
      maxRecoverySteps: Number(body["maxRecoverySteps"]) > 0 ? Number(body["maxRecoverySteps"]) : undefined,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    logger.info({ sessionId: req.sessionId, dbotId: result.record.id }, "dbots: created");
    res.status(201).json({ bot: toSummary(result.record), xml: result.record.xml });
  } catch (err) {
    logger.error({ err, sessionId: req.sessionId }, "dbots: create failed");
    res.status(500).json({ error: "Could not build the DBot — please try again." });
  }
});

// ── Read ──────────────────────────────────────────────────────────────────────

router.get("/", (req, res): void => {
  reconcileLive(req.sessionId);
  res.json({ bots: listDbots(req.sessionId).map(toSummary) });
});

router.get("/:id", (req, res): void => {
  const record = getDbot(req.sessionId, req.params["id"]!);
  if (!record) {
    res.status(404).json({ error: "DBot not found for this session" });
    return;
  }
  reconcileLive(req.sessionId);
  res.json({ bot: toSummary(record), fills: record.fills });
});

/** The compiled program — what Bot Studio loads into the workspace. */
router.get("/:id/xml", (req, res): void => {
  const record = getDbot(req.sessionId, req.params["id"]!);
  if (!record) {
    res.status(404).json({ error: "DBot not found for this session" });
    return;
  }
  res.set("Content-Type", "application/xml; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.send(record.xml);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * The bot is running: take the account's single-executor lock so no server
 * engine can start next to it and double-trade the shared recovery ledger.
 */
router.post("/:id/live", async (req, res): Promise<void> => {
  const id = req.params["id"]!;
  const result = markLive(req.sessionId, id);
  if (!result.ok && result.reason === "not-found") {
    res.status(404).json({ error: "DBot not found for this session" });
    return;
  }
  if (!result.ok) {
    res.status(409).json({
      error: "Another engine is trading this account. Stop it before running the DBot.",
      blockingBotId: result.owner,
    });
    return;
  }

  // Marking live is also the first mirror pass: anything already on the account
  // for this bot (a reload, a second tab) lands in the journal immediately.
  let fillCount = 0;
  try {
    const mirror = await mirrorDbotFills(req.sessionId, result.record);
    fillCount = mirror.newFills.length;
  } catch (err) {
    logger.warn({ err, dbotId: id }, "dbots: first mirror pass failed");
  }
  res.json({ bot: toSummary(result.record), newFills: fillCount });
});

/**
 * Heartbeat: "still running". Each beat mirrors the fills that settled since the
 * last one, and tells Bot Studio when the app wants the bot stopped (kill
 * switch / account switch) so the builder can stop the engine in the browser.
 */
router.post("/:id/heartbeat", async (req, res): Promise<void> => {
  const id = req.params["id"]!;
  const record = heartbeatDbot(req.sessionId, id);
  if (!record) {
    res.status(409).json({ error: "This DBot is not running", stopRequested: true });
    return;
  }

  let newFills = 0;
  try {
    const mirror = await mirrorDbotFills(req.sessionId, record);
    newFills = mirror.newFills.length;
  } catch (err) {
    logger.warn({ err, dbotId: id }, "dbots: mirror pass failed");
  }

  res.json({
    ok: true,
    // The mirror pass above can END the run on the spot: if the account this
    // bot was built for is no longer the session's active account (demo ↔ real
    // switch, a different linked account) the bot is stopped instead of
    // mirroring a stranger's fills. Bot Studio must then stop the engine in the
    // browser, so the heartbeat reports the truth rather than assuming the run
    // is still wanted.
    stopRequested: !isDbotRunning(record),
    newFills,
    bot: toSummary(record),
  });
});

/** Kill switch — releases the account, withdraws the badge, keeps the history. */
router.post("/:id/stop", async (req, res): Promise<void> => {
  const id = req.params["id"]!;
  const record = getDbot(req.sessionId, id);
  if (!record) {
    res.status(404).json({ error: "DBot not found for this session" });
    return;
  }
  const reason = typeof (req.body as { reason?: unknown })?.reason === "string"
    ? String((req.body as { reason?: string }).reason)
    : "user";
  stopDbot(req.sessionId, id, reason);
  res.json({ bot: toSummary(record) });
});

router.delete("/:id", (req, res): void => {
  const removed = deleteDbot(req.sessionId, req.params["id"]!);
  if (!removed) {
    res.status(404).json({ error: "DBot not found for this session" });
    return;
  }
  res.json({ ok: true });
});

/** Live summary for the console/run panel without polling the whole list. */
router.get("/live/current", (req, res): void => {
  const record = runningDbot(req.sessionId);
  res.json({ bot: record ? toSummary(record) : null });
});

export default router;
