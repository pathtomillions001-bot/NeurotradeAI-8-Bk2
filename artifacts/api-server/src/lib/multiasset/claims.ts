/**
 * Global MT5 account claims — one broker account, one Desk, at any moment.
 *
 * The Desk's live state (`store.ts`) is keyed by browser session, so on its own
 * it cannot answer "is this account already connected somewhere else?". Without
 * that answer the same login could be paired from two browsers: both would
 * stream the same account, both would arm plans against it, and either could
 * flatten positions the other believed it owned — one balance counted against
 * two independent sets of risk limits.
 *
 * Enforcement is therefore global and two-layered:
 *
 *  1. **Postgres** (`mt5_account_claims`) is the real guarantee. The unique
 *     index on `account_key` makes concurrent pairings race on a single INSERT,
 *     so exactly one wins even across processes and even across a redeploy.
 *  2. **An in-process map** mirrors it so the hot path (`/sync`, which runs
 *     twice a second per terminal) never touches the database.
 *
 * A claim is released when the user unlinks, when that session pairs a
 * different account, or when the terminal stops heartbeating for
 * CLAIM_IDLE_RELEASE_MS — so a browser that is simply closed can never lock an
 * account out permanently.
 *
 * The database is optional: when it is unavailable (unit tests, a cold start
 * before the pool exists) the in-process layer still enforces the rule for
 * this process, and the failure is logged rather than allowed to break pairing.
 */

const CLAIM_TABLE = "mt5_account_claims";

/**
 * How long a claim survives with no heartbeat.
 *
 * Long enough that a terminal reconnecting after a network blip or a broker
 * server switch keeps its slot; short enough that a user who walks away from
 * a browser can re-pair on another device without waiting hours.
 */
export const CLAIM_IDLE_RELEASE_MS = 10 * 60 * 1000;

export interface AccountClaim {
  /** Normalised `login@SERVER` — the identity actually being protected. */
  accountKey: string;
  login: number;
  server: string;
  company: string;
  /** Browser session that owns this account. */
  sessionId: string;
  pairedAt: number;
  lastSeenAt: number;
}

export type ClaimResult =
  | { ok: true; claim: AccountClaim }
  | { ok: false; reason: "held"; holder: AccountClaim };

/**
 * Normalise the account identity.
 *
 * Broker server names differ only by case between terminals and builds, and
 * the EA sometimes reports them with padding. Two spellings of one server must
 * not look like two different accounts — that would defeat the whole check.
 */
export function accountKeyFor(login: number, server: string): string {
  const normalised = String(server ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  return `${Math.trunc(login)}@${normalised}`;
}

/** True once a claim has gone quiet long enough to be considered abandoned. */
function isIdle(claim: AccountClaim, now: number): boolean {
  return now - claim.lastSeenAt > CLAIM_IDLE_RELEASE_MS;
}

// ── In-process mirror ────────────────────────────────────────────────────────

const claims = new Map<string, AccountClaim>();

/** Drop claims whose terminal has stopped heartbeating. */
function prune(now = Date.now()): void {
  for (const [key, claim] of claims) {
    if (isIdle(claim, now)) claims.delete(key);
  }
}

/** The session holding this key right now, if any. */
export function claimHolder(accountKey: string): AccountClaim | null {
  prune();
  const claim = claims.get(accountKey);
  return claim ?? null;
}

/** Every claim currently held by a session. */
export function claimsForSession(sessionId: string): AccountClaim[] {
  prune();
  return [...claims.values()].filter((claim) => claim.sessionId === sessionId);
}

function setLocal(claim: AccountClaim): void {
  claims.set(claim.accountKey, claim);
}

function deleteLocal(accountKey: string, sessionId?: string): void {
  const existing = claims.get(accountKey);
  if (!existing) return;
  if (sessionId && existing.sessionId !== sessionId) return;
  claims.delete(accountKey);
}

// ── Database ─────────────────────────────────────────────────────────────────

async function pool(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } | null> {
  try {
    const mod = await import("@workspace/db");
    return (mod as { pool?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } }).pool ?? null;
  } catch {
    return null;
  }
}

let dbWarned = false;

function warnOnce(err: unknown): void {
  if (dbWarned) return;
  dbWarned = true;
  // eslint-disable-next-line no-console
  console.warn("[mt5-claims] database unavailable; enforcing account uniqueness in-process only", err);
}

/**
 * Atomically take the claim.
 *
 * The ON CONFLICT clause only overwrites an existing row when it belongs to
 * the same session (a re-pair after an EA restart) or when it has gone idle.
 * Otherwise the UPDATE matches nothing, no row comes back, and the caller is
 * told who holds the account.
 */
async function insertClaim(claim: AccountClaim, cutoff: number): Promise<"taken" | "held" | "unavailable"> {
  const db = await pool();
  if (!db) return "unavailable";
  try {
    const result = await db.query(
      `INSERT INTO ${CLAIM_TABLE}
         (account_key, login, server, company, session_id, paired_at_ms, last_seen_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (account_key) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             company = EXCLUDED.company,
             paired_at_ms = EXCLUDED.paired_at_ms,
             last_seen_at_ms = EXCLUDED.last_seen_at_ms
         WHERE ${CLAIM_TABLE}.session_id = EXCLUDED.session_id
            OR ${CLAIM_TABLE}.last_seen_at_ms < $8
       RETURNING session_id`,
      [
        claim.accountKey,
        claim.login,
        claim.server,
        claim.company,
        claim.sessionId,
        claim.pairedAt,
        claim.lastSeenAt,
        cutoff,
      ],
    );
    return (result?.rows?.length ?? 0) > 0 ? "taken" : "held";
  } catch (err) {
    warnOnce(err);
    return "unavailable";
  }
}

/** Read the current holder straight from the database, bypassing the cache. */
async function readClaim(accountKey: string): Promise<AccountClaim | null> {
  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT account_key, login, server, company, session_id, paired_at_ms, last_seen_at_ms
         FROM ${CLAIM_TABLE} WHERE account_key = $1 LIMIT 1`,
      [accountKey],
    );
    const row = result?.rows?.[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      accountKey: String(row.account_key ?? accountKey),
      login: Number(row.login ?? 0),
      server: String(row.server ?? ""),
      company: String(row.company ?? ""),
      sessionId: String(row.session_id ?? ""),
      pairedAt: Number(row.paired_at_ms ?? 0),
      lastSeenAt: Number(row.last_seen_at_ms ?? 0),
    };
  } catch {
    return null;
  }
}

async function writeLastSeen(claim: AccountClaim): Promise<void> {
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `UPDATE ${CLAIM_TABLE} SET last_seen_at_ms = $2
        WHERE account_key = $1 AND session_id = $3`,
      [claim.accountKey, claim.lastSeenAt, claim.sessionId],
    );
  } catch {
    /* the in-process claim is already refreshed; the next pair re-reads the row */
  }
}

async function deleteRows(accountKey: string | null, sessionId: string | null): Promise<void> {
  const db = await pool();
  if (!db) return;
  try {
    if (accountKey && sessionId) {
      await db.query(`DELETE FROM ${CLAIM_TABLE} WHERE account_key = $1 AND session_id = $2`, [accountKey, sessionId]);
    } else if (sessionId) {
      await db.query(`DELETE FROM ${CLAIM_TABLE} WHERE session_id = $1`, [sessionId]);
    } else if (accountKey) {
      await db.query(`DELETE FROM ${CLAIM_TABLE} WHERE account_key = $1`, [accountKey]);
    }
  } catch {
    /* in-process state is already updated */
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to take exclusive ownership of an MT5 account for a browser session.
 *
 * Re-pairing the same account from the *same* session is always allowed — that
 * is what an EA restart or a redeploy looks like, and refusing it would strand
 * the user. Pairing a *different* account from the same session releases the
 * previous one, because a Desk holds exactly one terminal.
 */
export async function tryClaimAccount(input: {
  login: number;
  server: string;
  company?: string;
  sessionId: string;
}): Promise<ClaimResult> {
  const now = Date.now();
  const accountKey = accountKeyFor(input.login, input.server);
  const claim: AccountClaim = {
    accountKey,
    login: Math.trunc(input.login),
    server: String(input.server ?? ""),
    company: String(input.company ?? ""),
    sessionId: input.sessionId,
    pairedAt: now,
    lastSeenAt: now,
  };

  prune(now);
  const cutoff = now - CLAIM_IDLE_RELEASE_MS;

  // Fast path: another session in THIS process is demonstrably live.
  const local = claims.get(accountKey);
  if (local && local.sessionId !== input.sessionId && !isIdle(local, now)) {
    return { ok: false, reason: "held", holder: local };
  }

  // A Desk holds one terminal: pairing account B releases account A.
  for (const previous of claimsForSession(input.sessionId)) {
    if (previous.accountKey === accountKey) continue;
    deleteLocal(previous.accountKey, input.sessionId);
    void deleteRows(previous.accountKey, input.sessionId);
  }

  const outcome = await insertClaim(claim, cutoff);

  if (outcome === "held") {
    // Another process owns it. Trust the database row over our stale cache so
    // the rejection names the right holder.
    const holder = (await readClaim(accountKey)) ?? local;
    if (holder && holder.sessionId !== input.sessionId) {
      setLocal(holder);
      return { ok: false, reason: "held", holder };
    }
  }

  if (outcome === "unavailable") {
    // No database. Fall back to the in-process registry and say so once.
    const cached = local;
    if (cached && cached.sessionId !== input.sessionId && !isIdle(cached, now)) {
      return { ok: false, reason: "held", holder: cached };
    }
    warnOnce(new Error("pool unavailable"));
  }

  setLocal(claim);
  return { ok: true, claim };
}

/**
 * Confirm a heartbeat from a session that still owns its claim.
 *
 * Returns false when the account has since been claimed by another browser, so
 * the superseded terminal is disconnected instead of quietly continuing to
 * stream and trade an account the Desk no longer owns.
 */
export function touchClaim(sessionId: string, accountKey: string, now = Date.now()): boolean {
  prune(now);
  const claim = claims.get(accountKey);
  if (!claim) return true; // nothing claimed (e.g. database-only deployment)
  if (claim.sessionId !== sessionId) return false;
  claim.lastSeenAt = now;
  void writeLastSeen(claim);
  return true;
}

/** Release a single account, but only if this session is the one holding it. */
export async function releaseClaim(accountKey: string, sessionId: string): Promise<void> {
  deleteLocal(accountKey, sessionId);
  await deleteRows(accountKey, sessionId);
}

/** Release everything a session holds — used when it unlinks. */
export async function releaseClaimsForSession(sessionId: string): Promise<void> {
  for (const claim of claimsForSession(sessionId)) deleteLocal(claim.accountKey, sessionId);
  await deleteRows(null, sessionId);
}

/** Age of the last heartbeat for a key, or null when nobody holds it. */
export function claimAgeMs(accountKey: string, now = Date.now()): number | null {
  const claim = claimHolder(accountKey);
  return claim ? now - claim.lastSeenAt : null;
}

/**
 * Message shown when a pairing is refused.
 *
 * Deliberately does not leak the other session's id: it says what to do
 * (unlink there, or wait) rather than exposing another user's browser.
 */
export function describeConflict(login: number, server: string): string {
  return (
    `MT5 account ${Math.trunc(login)}@${server} is already connected in another browser. ` +
    `One account can only be linked to one Desk at a time, because two Desks would ` +
    `otherwise trade the same balance against separate risk limits. ` +
    `Open the Desk that holds it and choose "Unlink terminal", or wait a few minutes ` +
    `after that terminal stops syncing and try again.`
  );
}

/** Test/maintenance helper — never called from a request path. */
export function resetClaims(): void {
  claims.clear();
  dbWarned = false;
}

/** Test/maintenance helpers — never called from a request path. */
export const __testing = {
  /** Age a claim (in-process and in the database) to exercise idle release. */
  async ageClaim(accountKey: string, lastSeenAt: number): Promise<void> {
    const claim = claims.get(accountKey);
    if (claim) claim.lastSeenAt = lastSeenAt;
    const db = await pool();
    if (!db) return;
    try {
      await db.query(`UPDATE ${CLAIM_TABLE} SET last_seen_at_ms = $2 WHERE account_key = $1`, [
        accountKey,
        lastSeenAt,
      ]);
    } catch {
      /* no database — the in-process entry is already aged */
    }
  },
  snapshot(): AccountClaim[] {
    return [...claims.values()];
  },
};
