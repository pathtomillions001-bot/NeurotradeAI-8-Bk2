/**
 * Bot Studio bridge — the endpoints the vendored Deriv DBot builder calls when
 * it runs embedded inside NeuroTrade.
 *
 * WHY THESE EXIST
 * ───────────────
 * A hosted Deriv Bot authenticates itself with OAuth and holds a Deriv bearer
 * token in the browser. Inside NeuroTrade that would mean (a) asking a user who
 * is ALREADY connected to log in a second time and (b) putting a credential in
 * the browser that this platform deliberately keeps server-side (see
 * lib/db/auth: `accounts.bearer_token` / `refresh_token`).
 *
 * Instead the builder asks the platform, over its own session cookie:
 *
 *   GET /api/dbot/session → which account is selected (demo or real) + the list
 *                           of accounts linked to THIS browser session
 *   GET /api/dbot/ws-url  → a fresh, single-use OTP WebSocket URL for that exact
 *                           account, minted with the stored (and, when near
 *                           expiry, refreshed) bearer token
 *
 * DEMO vs REAL is therefore never a builder setting: it is whatever the platform
 * has active for this session, which is what the user chose in Settings / the
 * account switcher. Switching accounts in the platform switches what the builder
 * trades; the builder cannot pick a different account for itself.
 *
 * SERIALISED HANDSHAKES: getOtpWebSocketUrl() chains OTP requests process-wide
 * (Deriv's endpoint rate-limits), so this route reuses it rather than fetching.
 */

import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, accountsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { getOtpWebSocketUrl, ensureFreshBearerToken } from "../lib/deriv";

const router = Router();

/** Shape the builder consumes — public account metadata only, never a token. */
interface BridgeAccount {
  accountId: string;
  loginId: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  isActive: boolean;
}

async function accountsForSession(sessionId: string) {
  return db
    .select()
    .from(accountsTable)
    .where(eq(accountsTable.sessionId, sessionId));
}

function toBridgeAccount(row: typeof accountsTable.$inferSelect): BridgeAccount {
  return {
    accountId: row.derivAccountId || row.loginId,
    loginId: row.loginId,
    currency: row.currency,
    balance: Number(row.balance ?? 0),
    isVirtual: Boolean(row.isVirtual),
    isActive: Boolean(row.isActive),
  };
}

/**
 * Which account should the embedded builder trade?
 *
 * Never leaks credentials: the response carries ids, balances and the demo/real
 * flag, and nothing else.
 */
router.get("/session", async (req, res): Promise<void> => {
  const sessionId = req.sessionId;
  try {
    const rows = await accountsForSession(sessionId);
    if (rows.length === 0) {
      res.status(404).json({ connected: false, error: "No Deriv account connected" });
      return;
    }
    const accounts = rows.map(toBridgeAccount);
    const active = rows.find((r) => r.isActive) ?? rows[0]!;
    const activeBridge = toBridgeAccount(active);

    res.json({
      connected: true,
      accountId: activeBridge.accountId,
      loginId: activeBridge.loginId,
      currency: activeBridge.currency,
      balance: activeBridge.balance,
      isVirtual: activeBridge.isVirtual,
      accountType: activeBridge.isVirtual ? "demo" : "real",
      accounts,
    });
  } catch (err) {
    logger.error({ err, sessionId }, "dbot bridge: session lookup failed");
    res.status(500).json({ error: "Could not read the connected account" });
  }
});

/**
 * Mint a single-use OTP WebSocket URL for the session's active account.
 *
 * `?accountId=` is accepted so the builder can follow an account switch, but it
 * is only honoured for accounts that belong to THIS session — a builder running
 * in one browser session can never obtain a connection to another session's
 * (or another user's) account.
 */
router.get("/ws-url", async (req, res): Promise<void> => {
  const sessionId = req.sessionId;
  const requested = typeof req.query.accountId === "string" ? req.query.accountId : "";

  try {
    const rows = await accountsForSession(sessionId);
    if (rows.length === 0) {
      res.status(404).json({ connected: false, error: "No Deriv account connected" });
      return;
    }

    const row =
      (requested
        ? rows.find(
            (r) => r.derivAccountId === requested || r.loginId === requested,
          )
        : undefined) ??
      rows.find((r) => r.isActive) ??
      rows[0]!;

    const accountId = row.derivAccountId || row.loginId;

    // Prefer an active flag that matches what we are about to trade — the
    // builder's account chip reads this, and it must not claim "demo" while the
    // connection is to a real account (or vice versa).
    if (!row.isActive) {
      await db
        .update(accountsTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(accountsTable.sessionId, sessionId));
      await db
        .update(accountsTable)
        .set({ isActive: true, updatedAt: new Date() })
        .where(and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.id, row.id)));
    }

    // Refresh an OAuth token that is about to lapse before asking for an OTP;
    // PAT connections have no refresh token and are returned unchanged.
    const stored = row.bearerToken ?? row.token ?? "";
    const bearer = stored ? await ensureFreshBearerToken(accountId, stored) : "";
    if (!bearer) {
      res.status(409).json({
        connected: true,
        error:
          "The connected Deriv account has no usable credential. Reconnect the account in Settings.",
      });
      return;
    }

    const url = await getOtpWebSocketUrl(bearer, accountId);

    res.json({
      connected: true,
      url,
      accountId,
      loginId: row.loginId,
      currency: row.currency,
      isVirtual: Boolean(row.isVirtual),
      accountType: row.isVirtual ? "demo" : "real",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not open a trading connection";
    logger.error({ err, sessionId }, "dbot bridge: OTP mint failed");
    res.status(502).json({ connected: true, error: message });
  }
});

export default router;
