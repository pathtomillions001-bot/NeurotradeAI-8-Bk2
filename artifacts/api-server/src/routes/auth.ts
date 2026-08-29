import { Router, type Request, type Response } from "express";
import { db, accountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  authorizeWithDeriv,
  clearJournalManager,
  exchangeOAuthCode,
  getDerivAccounts,
  getJournalManager,
  DERIV_AUTH_BASE,
  APP_ID,
} from "../lib/deriv";
import { ConnectDerivAccountBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  hasRiskAcknowledgment,
  RISK_ACKNOWLEDGMENT_REQUIRED,
  setRiskAcknowledgment,
} from "../lib/session";

const router = Router();

// PKCE state is bound to the browser session that initiated it. This prevents a
// callback from one visitor being consumed by another visitor on the same app.
const pendingPkce = new Map<string, {
  codeVerifier: string;
  redirectUri: string;
  sessionId: string;
  expiresAt: number;
}>();

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingPkce) {
    if (value.expiresAt < now) pendingPkce.delete(key);
  }
}, 10 * 60 * 1000).unref();

/**
 * Kept for startup API compatibility. Credentials are intentionally no longer
 * loaded into a process-global cache: every request resolves only the account
 * rows belonging to its HttpOnly browser session.
 */
export async function loadPersistedToken(): Promise<void> {
  logger.info("Per-browser credential isolation enabled; global token restore skipped");
}

function accountWhere(sessionId: string, loginId: string) {
  return and(eq(accountsTable.sessionId, sessionId), eq(accountsTable.loginId, loginId));
}

async function getSessionAccounts(sessionId: string) {
  return db.select().from(accountsTable).where(eq(accountsTable.sessionId, sessionId));
}

async function getActiveSessionAccount(sessionId: string) {
  let rows = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, sessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (rows.length === 0) {
    rows = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, sessionId)).limit(1);
  }
  return rows[0] ?? null;
}

function formatAccount(account: typeof accountsTable.$inferSelect, balance?: number) {
  return {
    id: account.id,
    loginId: account.loginId,
    currency: account.currency,
    balance: balance ?? Number(account.balance),
    isVirtual: account.isVirtual,
    isActive: account.isActive,
    email: account.email,
    fullName: account.fullName,
    country: account.country,
    connectedAt: account.connectedAt.toISOString(),
  };
}

function requireRiskAcknowledgment(req: Request, res: Response): boolean {
  if (hasRiskAcknowledgment(req)) return true;
  res.status(428).json({ error: RISK_ACKNOWLEDGMENT_REQUIRED, code: "RISK_ACK_REQUIRED" });
  return false;
}

router.post("/risk-acknowledgment", (req, res): void => {
  setRiskAcknowledgment(res, req.sessionId);
  res.json({ success: true });
});

router.get("/risk-acknowledgment", (req, res): void => {
  res.json({ accepted: hasRiskAcknowledgment(req) });
});

router.get("/oauth/initiate", (req, res): void => {
  if (!requireRiskAcknowledgment(req, res)) return;

  const { code_challenge, code_challenge_method, redirect_uri, state } =
    req.query as Record<string, string>;
  const codeVerifier = req.query["code_verifier"] as string | undefined;

  if (!code_challenge || !redirect_uri || !state || !codeVerifier) {
    res.status(400).json({
      error: "Missing required OAuth params: code_challenge, redirect_uri, state, code_verifier",
    });
    return;
  }
  if (!APP_ID) {
    res.status(503).json({ error: "DERIV_APP_ID is not configured on the server." });
    return;
  }

  pendingPkce.set(state, {
    codeVerifier,
    redirectUri: redirect_uri,
    sessionId: req.sessionId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: APP_ID,
    redirect_uri,
    scope: "trade",
    state,
    code_challenge,
    code_challenge_method: code_challenge_method ?? "S256",
  });

  res.json({ url: `${DERIV_AUTH_BASE}/oauth2/auth?${params.toString()}` });
});

async function upsertDerivAccounts(args: {
  sessionId: string;
  bearerToken: string;
  refreshToken?: string | null;
  derivAccounts: Awaited<ReturnType<typeof getDerivAccounts>>;
  preferredId: string;
  profile?: { email: string | null; fullName: string | null; country: string | null };
}) {
  const { sessionId, bearerToken, refreshToken, derivAccounts, preferredId, profile } = args;

  await db.update(accountsTable).set({ isActive: false })
    .where(eq(accountsTable.sessionId, sessionId));

  let preferredDbAccount: typeof accountsTable.$inferSelect | null = null;
  for (const derivAccount of derivAccounts) {
    const isActive = derivAccount.account_id === preferredId;
    const existing = await db.select().from(accountsTable)
      .where(accountWhere(sessionId, derivAccount.account_id)).limit(1);

    const common = {
      bearerToken,
      refreshToken: refreshToken ?? existing[0]?.refreshToken ?? null,
      token: null,
      derivAccountId: derivAccount.account_id,
      currency: derivAccount.currency,
      balance: String(derivAccount.balance),
      isVirtual: derivAccount.account_type === "demo",
      isActive,
      email: isActive ? (profile?.email ?? existing[0]?.email ?? null) : (existing[0]?.email ?? null),
      fullName: isActive ? (profile?.fullName ?? existing[0]?.fullName ?? null) : (existing[0]?.fullName ?? null),
      country: isActive ? (profile?.country ?? existing[0]?.country ?? null) : (existing[0]?.country ?? null),
      updatedAt: new Date(),
    };

    let row: typeof accountsTable.$inferSelect;
    if (existing.length > 0) {
      [row] = await db.update(accountsTable).set(common)
        .where(accountWhere(sessionId, derivAccount.account_id)).returning();
    } else {
      [row] = await db.insert(accountsTable).values({
        sessionId,
        loginId: derivAccount.account_id,
        ...common,
      }).returning();
    }
    if (isActive) preferredDbAccount = row;
  }

  if (!preferredDbAccount) throw new Error("Unable to activate the selected Deriv account");
  getJournalManager(sessionId).setCredentials(bearerToken, preferredId);
  return preferredDbAccount;
}

router.post("/oauth/callback", async (req, res): Promise<void> => {
  if (!requireRiskAcknowledgment(req, res)) return;

  const { code, state, redirect_uri, code_verifier: bodyVerifier } = req.body as {
    code?: string;
    state?: string;
    redirect_uri?: string;
    code_verifier?: string;
  };
  if (!code || !state) {
    res.status(400).json({ error: "Missing authorization code or state" });
    return;
  }

  const pending = pendingPkce.get(state);
  if (!pending || pending.expiresAt < Date.now() || pending.sessionId !== req.sessionId) {
    pendingPkce.delete(state);
    res.status(400).json({ error: "OAuth state is invalid, expired, or belongs to another browser session" });
    return;
  }
  pendingPkce.delete(state);

  const codeVerifier = pending.codeVerifier || bodyVerifier;
  const redirectUri = pending.redirectUri || redirect_uri;
  if (!codeVerifier || !redirectUri) {
    res.status(400).json({ error: "PKCE verifier or redirect URI is missing" });
    return;
  }

  try {
    const tokens = await exchangeOAuthCode(code, redirectUri, codeVerifier);
    const derivAccounts = await getDerivAccounts(tokens.accessToken);
    if (derivAccounts.length === 0) {
      res.status(400).json({ error: "No trading accounts found for this Deriv account" });
      return;
    }
    const preferred = derivAccounts.find((a) => a.account_type === "real" && a.status === "active")
      ?? derivAccounts[0];

    let profile = { email: null, fullName: null, country: null } as {
      email: string | null;
      fullName: string | null;
      country: string | null;
    };
    try {
      const profileRes = await fetch(`${DERIV_AUTH_BASE}/oauth2/user`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      });
      if (profileRes.ok) {
        const data = await profileRes.json() as Record<string, unknown>;
        profile = {
          email: typeof data.email === "string" ? data.email : null,
          fullName: typeof data.name === "string" ? data.name : null,
          country: typeof data.country === "string" ? data.country : null,
        };
      }
    } catch { /* profile is best effort */ }

    const row = await upsertDerivAccounts({
      sessionId: req.sessionId,
      bearerToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      derivAccounts,
      preferredId: preferred.account_id,
      profile,
    });

    logger.info({ sessionId: req.sessionId, accountCount: derivAccounts.length },
      "OAuth login stored in isolated browser session");
    res.json(formatAccount(row, preferred.balance));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "OAuth callback failed";
    logger.error({ err, sessionId: req.sessionId }, "OAuth callback error");
    res.status(400).json({ error: message });
  }
});

router.post("/connect", async (req, res): Promise<void> => {
  if (!requireRiskAcknowledgment(req, res)) return;

  const parsed = ConnectDerivAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const token = parsed.data.token.trim();
  if (!token) {
    res.status(400).json({ error: "Token cannot be empty" });
    return;
  }

  try {
    const derivAccounts = await getDerivAccounts(token);
    if (derivAccounts.length > 0) {
      const preferred = derivAccounts.find((a) => a.account_type === "real" && a.status === "active")
        ?? derivAccounts[0];
      const row = await upsertDerivAccounts({
        sessionId: req.sessionId,
        bearerToken: token,
        derivAccounts,
        preferredId: preferred.account_id,
      });
      logger.info({ sessionId: req.sessionId, accountCount: derivAccounts.length },
        "Token accounts stored in isolated browser session");
      res.json(formatAccount(row, preferred.balance));
      return;
    }

    // Compatibility fallback for PATs supported by the authorization helper.
    const info = await authorizeWithDeriv(token);
    const fallbackAccounts: Awaited<ReturnType<typeof getDerivAccounts>> = [{
      account_id: info.loginid,
      balance: info.balance,
      currency: info.currency,
      group: "",
      status: "active",
      account_type: info.is_virtual === 1 ? "demo" : "real",
    }];
    const row = await upsertDerivAccounts({
      sessionId: req.sessionId,
      bearerToken: token,
      derivAccounts: fallbackAccounts,
      preferredId: info.loginid,
      profile: {
        email: info.email ?? null,
        fullName: info.fullname ?? null,
        country: info.country ?? null,
      },
    });
    res.json(formatAccount(row, info.balance));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Authorization failed";
    logger.error({ err, sessionId: req.sessionId }, "Deriv connect failed");
    res.status(400).json({ error: message });
  }
});

router.get("/account", async (req, res): Promise<void> => {
  const account = await getActiveSessionAccount(req.sessionId);
  if (!account) {
    res.status(404).json({ error: "No account connected" });
    return;
  }

  const bearerToken = account.bearerToken ?? account.token;
  if (bearerToken) {
    getJournalManager(req.sessionId).setCredentials(
      bearerToken,
      account.derivAccountId ?? account.loginId,
    );
    try {
      const derivAccounts = await getDerivAccounts(bearerToken);
      const match = derivAccounts.find((candidate) =>
        candidate.account_id === (account.derivAccountId ?? account.loginId));
      if (match && Math.abs(match.balance - Number(account.balance)) > 0.01) {
        await db.update(accountsTable)
          .set({ balance: String(match.balance), updatedAt: new Date() })
          .where(eq(accountsTable.id, account.id));
        res.json(formatAccount(account, match.balance));
        return;
      }
    } catch { /* use cached balance */ }
  }

  res.json(formatAccount(account));
});

router.get("/accounts", async (req, res): Promise<void> => {
  const accounts = await getSessionAccounts(req.sessionId);
  if (accounts.length === 0) {
    res.json([]);
    return;
  }

  const active = accounts.find((account) => account.isActive) ?? accounts[0];
  const bearerToken = active.bearerToken ?? active.token;
  const balances = new Map<string, number>();
  if (bearerToken) {
    getJournalManager(req.sessionId).setCredentials(
      bearerToken,
      active.derivAccountId ?? active.loginId,
    );
    try {
      for (const account of await getDerivAccounts(bearerToken)) {
        balances.set(account.account_id, account.balance);
      }
    } catch { /* use cached balances */ }
  }

  res.json(accounts.map((account) => formatAccount(
    account,
    balances.get(account.derivAccountId ?? account.loginId),
  )));
});

router.post("/switch-account", async (req, res): Promise<void> => {
  const { loginId } = req.body as { loginId?: string };
  if (!loginId) {
    res.status(400).json({ error: "loginId is required" });
    return;
  }

  const target = await db.select().from(accountsTable)
    .where(accountWhere(req.sessionId, loginId)).limit(1);
  if (target.length === 0) {
    res.status(404).json({ error: `Account ${loginId} is not linked in this browser session` });
    return;
  }

  const token = target[0].bearerToken ?? target[0].token;
  if (!token) {
    res.status(400).json({ error: "No bearer token for this account" });
    return;
  }

  await db.update(accountsTable).set({ isActive: false })
    .where(eq(accountsTable.sessionId, req.sessionId));
  const [activated] = await db.update(accountsTable)
    .set({ isActive: true, updatedAt: new Date() })
    .where(accountWhere(req.sessionId, loginId)).returning();

  const derivAccountId = activated.derivAccountId ?? loginId;
  getJournalManager(req.sessionId).setCredentials(token, derivAccountId);

  let balance = Number(activated.balance);
  try {
    const match = (await getDerivAccounts(token))
      .find((account) => account.account_id === derivAccountId);
    if (match) {
      balance = match.balance;
      await db.update(accountsTable)
        .set({ balance: String(balance), updatedAt: new Date() })
        .where(eq(accountsTable.id, activated.id));
    }
  } catch { /* use cached balance */ }

  logger.info({ sessionId: req.sessionId, loginId }, "Browser session switched Deriv account");
  res.json(formatAccount(activated, balance));
});

router.post("/disconnect", async (req, res): Promise<void> => {
  clearJournalManager(req.sessionId);
  await db.delete(accountsTable).where(eq(accountsTable.sessionId, req.sessionId));
  res.json({ success: true, message: "Your Deriv accounts were disconnected from this browser only" });
});

export default router;
