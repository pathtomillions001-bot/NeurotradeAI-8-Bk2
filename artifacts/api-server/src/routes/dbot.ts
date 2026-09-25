/**
 * DBot integration routes — the embedded Deriv DBot builder.
 *
 *  GET  /bridge-token   SSO seed for the iframed builder: the token of the
 *                       account currently ACTIVE in NeuroTrade (demo or real),
 *                       so the builder authorizes onto exactly that account
 *                       without a second login.
 *  POST /strategies     Save a compiled scanner manifest + XML (Create Bot).
 *  GET  /strategies     List this session's saved strategies.
 *  GET  /strategies/:id Fetch one (the Bot Builder loads its XML).
 *  POST /run-state      Arbiter claim/release for owner `dbot` — while the
 *                       embedded DBot executes, our server engines may not.
 *  POST /events         Journaling bridge: contract open/settle events from
 *                       the embedded builder land in the trades table, the
 *                       market win-rate store and the single recovery ledger.
 */
import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, accountsTable, dbotStrategiesTable, settingsTable, tradesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import * as recoveryEngine from "../lib/agents/recovery-engine";
import { recordTradeOutcome } from "../lib/agent-coordinator";
import { acquireTradingOwnership, releaseTradingOwnership } from "../lib/engine-arbiter";

const router = Router();

const KNOWN_CONTRACT_TYPES = new Set([
  "CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF",
]);

interface BridgeContract {
  contract_id?: number;
  transaction_id?: number | null;
  shortcode?: string;
  display_name?: string;
  currency?: string;
  buy_price?: number;
  payout?: number;
  profit?: number;
  bid_price?: number;
  is_completed?: boolean;
  status?: string;
  entry_spot?: string | null;
  exit_spot?: string | null;
  barrier?: string | null;
}

/**
 * Deriv shortcodes: DIGITOVER_R_10_1T_<ts>_<barrier> — first token is the
 * family; the symbol is `R_<n>` for volatility indices (two tokens) or a
 * single token otherwise (1HZ100V, WLDAUD, …).
 */
function parseShortcode(shortcode: string): { contractType: string; symbol: string; barrier: number | null } | null {
  const parts = (shortcode ?? "").split("_");
  if (parts.length < 2) return null;
  const contractType = KNOWN_CONTRACT_TYPES.has(parts[0]) ? parts[0] : "";
  const symbol = parts[1] === "R" && parts.length > 2 ? `${parts[1]}_${parts[2]}` : parts[1];
  const last = parts[parts.length - 1];
  const barrier = /^\d$/.test(last) ? Number(last) : null;
  if (!contractType || !symbol) return null;
  return { contractType, symbol, barrier };
}

/** The account this browser session trades with — demo or real, whichever is active. */
async function activeAccount(sessionId: string) {
  const rows = await db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.sessionId, sessionId));
  if (rows.length === 0) return null;
  const active = rows.find((r) => r.isActive) ?? rows[0];
  const token = active.bearerToken ?? active.token;
  if (!token) return null;
  return {
    token,
    loginid: active.derivAccountId ?? active.loginId,
    isVirtual: Boolean(active.isVirtual),
    currency: active.currency,
    expiresAt: (active as any).tokenExpiresAt ?? null,
  };
}

router.get("/bridge-token", async (req, res): Promise<void> => {
  const account = await activeAccount(req.sessionId);
  if (!account) {
    res.status(409).json({
      error:
        "No connected Deriv account in this session. Connect one at /connect first — " +
        "the Bot Builder trades with exactly that account.",
    });
    return;
  }
  res.json({
    token: account.token,
    loginid: account.loginid,
    accountType: account.isVirtual ? "demo" : "real",
    currency: account.currency,
    expiresAt: account.expiresAt instanceof Date ? account.expiresAt.toISOString() : account.expiresAt,
  });
});

router.post("/strategies", async (req, res): Promise<void> => {
  const body = req.body as { name?: string; source?: string; symbol?: string; manifest?: unknown; xml?: string };
  if (!body.xml || !body.symbol || !body.manifest) {
    res.status(400).json({ error: "symbol, manifest and xml are required" });
    return;
  }
  const [row] = await db
    .insert(dbotStrategiesTable)
    .values({
      sessionId: req.sessionId,
      name: body.name || `${body.source ?? "scanner"} ${body.symbol}`,
      source: body.source ?? "scanner",
      symbol: body.symbol,
      manifest: JSON.stringify(body.manifest),
      xml: body.xml,
    })
    .returning();
  res.status(201).json({ id: row.id, name: row.name, symbol: row.symbol, createdAt: row.createdAt });
});

router.get("/strategies", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: dbotStrategiesTable.id,
      name: dbotStrategiesTable.name,
      source: dbotStrategiesTable.source,
      symbol: dbotStrategiesTable.symbol,
      createdAt: dbotStrategiesTable.createdAt,
    })
    .from(dbotStrategiesTable)
    .where(eq(dbotStrategiesTable.sessionId, req.sessionId))
    .orderBy(desc(dbotStrategiesTable.createdAt))
    .limit(50);
  res.json(rows);
});

router.get("/strategies/:id", async (req, res): Promise<void> => {
  const idNum = Number(req.params.id);
  if (!Number.isInteger(idNum)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const rows = await db
    .select()
    .from(dbotStrategiesTable)
    .where(and(eq(dbotStrategiesTable.id, idNum), eq(dbotStrategiesTable.sessionId, req.sessionId)))
    .limit(1);
  if (rows.length === 0) {
    res.status(404).json({ error: "strategy not found" });
    return;
  }
  const row = rows[0];
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    manifest = null;
  }
  res.json({ id: row.id, name: row.name, source: row.source, symbol: row.symbol, manifest, xml: row.xml, createdAt: row.createdAt });
});

router.post("/run-state", async (req, res): Promise<void> => {
  const { running } = req.body as { running?: boolean };
  if (running) {
    const ok = acquireTradingOwnership("dbot", req.sessionId);
    if (!ok) {
      res.status(409).json({ error: "Another engine already owns trading on this account — stop it before running the DBot." });
      return;
    }
    res.json({ running: true, owner: "dbot" });
  } else {
    releaseTradingOwnership("dbot", req.sessionId);
    res.json({ running: false });
  }
});

router.post("/events", async (req, res): Promise<void> => {
  const { contract, stage } = req.body as { contract?: BridgeContract; stage?: "open" | "settled" };
  if (!contract?.contract_id) {
    res.status(400).json({ error: "contract.contract_id is required" });
    return;
  }
  const parsed = parseShortcode(contract.shortcode ?? "");
  const contractType = parsed?.contractType ?? "DIGITOVER";
  const symbol = parsed?.symbol ?? contract.display_name ?? "UNKNOWN";
  const barrier = parsed?.barrier;
  const stake = Number(contract.buy_price) || 0;
  const contractId = String(contract.contract_id);

  try {
    if (stage !== "settled") {
      const existing = await db
        .select({ id: tradesTable.id })
        .from(tradesTable)
        .where(and(eq(tradesTable.sessionId, req.sessionId), eq(tradesTable.derivContractId, contractId)))
        .limit(1);
      if (existing.length === 0 && stake > 0) {
        await db.insert(tradesTable).values({
          sessionId: req.sessionId,
          symbol,
          displayName: contract.display_name || symbol,
          contractType,
          barrier: barrier ?? null,
          stake: String(stake),
          direction: contractType === "DIGITUNDER" ? "UNDER" : "OVER",
          status: "open",
          derivContractId: contractId,
          isAutonomous: true,
          agentReasoning: "[DBOT] Executed by the embedded Deriv DBot builder",
          duration: 1,
          durationUnit: "t",
        });
      }
      res.json({ ok: true });
      return;
    }

    // Settled: close the journal row and feed the single recovery ledger.
    const profit = Number(contract.profit) || 0;
    const payout = Number(contract.payout) || 0;
    const won = profit > 0;
    const [updated] = await db
      .update(tradesTable)
      .set({
        status: won ? "won" : "lost",
        payout: String(payout),
        profit: String(profit),
        exitPrice: contract.exit_spot ? String(contract.exit_spot) : null,
        closedAt: new Date(),
      })
      .where(and(eq(tradesTable.sessionId, req.sessionId), eq(tradesTable.derivContractId, contractId)))
      .returning();

    if (updated) {
      const settings = await db.select().from(settingsTable).where(eq(settingsTable.sessionId, req.sessionId)).limit(1);
      const maxSteps = settings.length > 0 ? (settings[0] as any).maxRecoverySteps ?? 3 : 3;
      const payoutMultiplier = stake > 0 ? payout / stake : 0;
      recordTradeOutcome(symbol, contractType, barrier ?? null, won, profit, stake);
      recoveryEngine.setPersistenceSession(req.sessionId);
      if (recoveryEngine.isTrackedContract(contractType)) {
        recoveryEngine.recordOutcome(won, profit, stake, maxSteps, contractType, payoutMultiplier);
      }
    } else {
      logger.warn({ contractId }, "dbot settle event without a matching open trade row");
    }
    res.json({ ok: true, recorded: Boolean(updated) });
  } catch (err) {
    logger.error({ err }, "dbot event journaling failed");
    res.status(500).json({ error: "journaling failed" });
  }
});

export default router;
