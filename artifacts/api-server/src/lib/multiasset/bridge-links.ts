/**
 * Durable MT5 bridge identity: pairing codes and the terminal link itself.
 *
 * WHY THIS MODULE EXISTS
 *
 * The pairing code and the bridge token used to live in two process-local
 * `Map`s, and the code was additionally deleted the moment it was redeemed. The
 * EA cannot change its own inputs while MT5 is running, so both of those
 * decisions turned an ordinary restart into a dead bridge:
 *
 *   • API restart / redeploy / crash → every token and code forgotten. The EA
 *     keeps retrying `/pair` with the code in its inputs and gets
 *     `401 Unknown or expired pairing code.` forever.
 *   • MT5 restart (or the EA re-attached to a chart) → the EA's token is gone
 *     with the process, so it pairs again with the same code — which the server
 *     had already deleted on redemption → the same 401 loop.
 *
 * Either way the Desk shows "Reconnecting to the MT5 terminal", the calendar
 * pane freezes on its last read, and armed plans never reach the terminal
 * because `/sync` — the only channel that delivers them — is being rejected.
 *
 * The rule this module implements, as the product requires it:
 *
 *   A pairing code and its bridge link stay valid until the user explicitly
 *   unlinks the terminal from the Desk. Closing MT5, restarting MT5, closing the
 *   browser or redeploying this service resumes the SAME connection.
 *
 * Like `claims.ts`, this keeps an in-process mirror so the heartbeat hot path
 * never needs the database, and degrades to that mirror alone when no pool is
 * available (unit tests, cold start) instead of failing the request.
 */

const CODE_TABLE = "mt5_pairing_codes";
const LINK_TABLE = "mt5_bridge_links";

/**
 * How many un-revoked codes one Desk may hold at once.
 *
 * Issuing a new code deliberately does NOT revoke the previous one: the old
 * value is still sitting in a running EA's inputs, and revoking it is exactly
 * how a user who merely reopened the setup dialog broke their own bridge. The
 * cap only stops rows accumulating forever on a Desk that is re-opened often.
 */
export const MAX_LIVE_CODES_PER_SESSION = 5;

/**
 * How often a heartbeat is allowed to touch the database.
 *
 * The EA beats every 250 ms–10 s. Writing `last_sync_at_ms` on every beat would
 * be one UPDATE per second per terminal for a value nobody reads at that
 * resolution; ten seconds is far finer than the Desk's own staleness window.
 */
export const LINK_SYNC_PERSIST_INTERVAL_MS = 10_000;

export interface PairingCodeRecord {
  code: string;
  sessionId: string;
  createdAt: number;
  /** Set only by an explicit unlink from the Desk. */
  revokedAt: number | null;
  /** Diagnostic only — a redeemed code stays usable. */
  redeemedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface BridgeLink {
  sessionId: string;
  bridgeToken: string;
  login: number;
  server: string;
  company: string;
  pairedAt: number;
  lastSyncAt: number;
  syncIntervalMs: number;
}

// ── In-process mirrors ───────────────────────────────────────────────────────

const codes = new Map<string, PairingCodeRecord>();
const linksByToken = new Map<string, BridgeLink>();
const linksBySession = new Map<string, BridgeLink>();
const lastLinkPersistAt = new Map<string, number>();

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
  console.warn("[mt5-bridge] database unavailable; pairing codes and links survive this process only", err);
}

function parseCodeRow(row: Record<string, unknown>): PairingCodeRecord | null {
  const code = typeof row.code === "string" ? row.code : "";
  const sessionId = typeof row.session_id === "string" ? row.session_id : "";
  if (!code || !sessionId) return null;
  return {
    code,
    sessionId,
    createdAt: Number(row.created_at_ms ?? 0),
    revokedAt: row.revoked_at_ms === null || row.revoked_at_ms === undefined ? null : Number(row.revoked_at_ms),
    redeemedAt: row.redeemed_at_ms === null || row.redeemed_at_ms === undefined ? null : Number(row.redeemed_at_ms),
    lastAttemptAt: row.last_attempt_at_ms === null || row.last_attempt_at_ms === undefined ? null : Number(row.last_attempt_at_ms),
    lastError: typeof row.last_error === "string" ? row.last_error : null,
  };
}

function parseLinkRow(row: Record<string, unknown>): BridgeLink | null {
  const sessionId = typeof row.session_id === "string" ? row.session_id : "";
  const bridgeToken = typeof row.bridge_token === "string" ? row.bridge_token : "";
  if (!sessionId || !bridgeToken) return null;
  return {
    sessionId,
    bridgeToken,
    login: Number(row.login ?? 0),
    server: String(row.server ?? ""),
    company: String(row.company ?? ""),
    pairedAt: Number(row.paired_at_ms ?? 0),
    lastSyncAt: Number(row.last_sync_at_ms ?? 0),
    syncIntervalMs: Number(row.sync_interval_ms ?? 0),
  };
}

// ── Pairing codes ────────────────────────────────────────────────────────────

/** Record a freshly issued code in this process (used by tests and cold paths). */
export function rememberPairingCode(record: PairingCodeRecord): void {
  codes.set(record.code, { ...record });
}

/**
 * Store a new code.
 *
 * Older codes for the same Desk are kept until the retention cap is reached;
 * only then is the oldest revoked, so a code inside a running EA is never
 * invalidated by the user simply opening the setup dialog again.
 */
export async function createPairingCode(code: string, sessionId: string, now = Date.now()): Promise<void> {
  const record: PairingCodeRecord = {
    code,
    sessionId,
    createdAt: now,
    revokedAt: null,
    redeemedAt: null,
    lastAttemptAt: null,
    lastError: null,
  };
  rememberPairingCode(record);

  const db = await pool();
  if (db) {
    try {
      await db.query(
        `INSERT INTO ${CODE_TABLE} (code, session_id, created_at_ms, revoked_at_ms, redeemed_at_ms, last_attempt_at_ms, last_error)
         VALUES ($1, $2, $3, NULL, NULL, NULL, NULL)
         ON CONFLICT (code) DO UPDATE
           SET session_id = EXCLUDED.session_id,
               created_at_ms = EXCLUDED.created_at_ms,
               revoked_at_ms = NULL,
               redeemed_at_ms = NULL,
               last_attempt_at_ms = NULL,
               last_error = NULL`,
        [code, sessionId, now],
      );
      await enforceCodeRetention(db, sessionId);
    } catch (err) {
      warnOnce(err);
    }
  }
}

/** Revoke the oldest codes once a Desk holds more than the retention cap. */
async function enforceCodeRetention(
  db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  sessionId: string,
  now = Date.now(),
): Promise<void> {
  try {
    const result = await db.query(
      `SELECT code FROM ${CODE_TABLE}
        WHERE session_id = $1 AND revoked_at_ms IS NULL
        ORDER BY created_at_ms ASC`,
      [sessionId],
    );
    const live = (result?.rows ?? [])
      .map((row) => (row as { code?: unknown }).code)
      .filter((value): value is string => typeof value === "string");
    const surplus = live.slice(0, Math.max(0, live.length - MAX_LIVE_CODES_PER_SESSION));
    for (const code of surplus) {
      await db.query(`UPDATE ${CODE_TABLE} SET revoked_at_ms = $2 WHERE code = $1`, [code, now]);
      const cached = codes.get(code);
      if (cached) cached.revokedAt = now;
    }
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Resolve a code.
 *
 * A revoked code is returned (with `revokedAt` set) rather than hidden, so the
 * route can tell the user "this code was revoked when you unlinked" instead of
 * the misleading "unknown or expired".
 */
export async function findPairingCode(code: string): Promise<PairingCodeRecord | null> {
  const cached = codes.get(code);
  if (cached) return { ...cached };

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT code, session_id, created_at_ms, revoked_at_ms, redeemed_at_ms, last_attempt_at_ms, last_error
         FROM ${CODE_TABLE} WHERE code = $1 LIMIT 1`,
      [code],
    );
    const parsed = parseCodeRow((result?.rows?.[0] ?? {}) as Record<string, unknown>);
    if (parsed) codes.set(parsed.code, { ...parsed });
    return parsed;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** Note an attempt against a code — the diagnostic behind "why did it refuse?". */
export async function notePairingAttempt(code: string, at: number, error: string | null): Promise<void> {
  const cached = codes.get(code);
  if (cached) {
    cached.lastAttemptAt = at;
    cached.lastError = error;
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`UPDATE ${CODE_TABLE} SET last_attempt_at_ms = $2, last_error = $3 WHERE code = $1`, [
      code,
      at,
      error,
    ]);
  } catch {
    /* the in-process record already carries the diagnostic */
  }
}

/** Mark a code as redeemed. It stays valid — that is the whole point. */
export async function markPairingRedeemed(code: string, at = Date.now()): Promise<void> {
  const cached = codes.get(code);
  if (cached) cached.redeemedAt = at;
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`UPDATE ${CODE_TABLE} SET redeemed_at_ms = $2 WHERE code = $1`, [code, at]);
  } catch {
    /* diagnostic only */
  }
}

/**
 * Revoke every live code a Desk holds. Called ONLY from an explicit unlink, so
 * the terminal is disconnected when — and only when — the user asks for it.
 */
export async function revokePairingCodesForSession(sessionId: string, now = Date.now()): Promise<number> {
  let revoked = 0;
  for (const [code, record] of codes) {
    if (record.sessionId !== sessionId || record.revokedAt !== null) continue;
    record.revokedAt = now;
    revoked++;
  }
  const db = await pool();
  if (!db) return revoked;
  try {
    const result = await db.query(
      `UPDATE ${CODE_TABLE} SET revoked_at_ms = $2
        WHERE session_id = $1 AND revoked_at_ms IS NULL
        RETURNING code`,
      [sessionId, now],
    );
    // The database is authoritative for rows this process never issued.
    revoked = Math.max(revoked, result?.rows?.length ?? 0);
  } catch (err) {
    warnOnce(err);
  }
  return revoked;
}

// ── Bridge links ─────────────────────────────────────────────────────────────

/**
 * Mirror a link in this process (pairing, and tests).
 *
 * The previous token for this Desk is evicted first. Leaving it indexed is how
 * a superseded credential comes back to life: `findLinkByToken` would still
 * resolve it, and a heartbeat presenting it would then overwrite the Desk's
 * live terminal with a link that no longer owns anything.
 */
export function rememberLink(link: BridgeLink): void {
  const previous = linksBySession.get(link.sessionId);
  if (previous && previous.bridgeToken !== link.bridgeToken) {
    linksByToken.delete(previous.bridgeToken);
  }
  const stored: BridgeLink = { ...link };
  linksByToken.set(stored.bridgeToken, stored);
  linksBySession.set(stored.sessionId, stored);
  lastLinkPersistAt.set(stored.sessionId, stored.lastSyncAt);
}

/** Drop a link from this process. */
export function forgetLink(sessionId: string): void {
  const existing = linksBySession.get(sessionId);
  if (existing) linksByToken.delete(existing.bridgeToken);
  linksBySession.delete(sessionId);
  lastLinkPersistAt.delete(sessionId);
}

/** Persist the link created at pairing. */
export async function saveBridgeLink(link: BridgeLink): Promise<void> {
  rememberLink(link);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO ${LINK_TABLE}
         (session_id, bridge_token, login, server, company, paired_at_ms, last_sync_at_ms, sync_interval_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id) DO UPDATE
         SET bridge_token = EXCLUDED.bridge_token,
             login = EXCLUDED.login,
             server = EXCLUDED.server,
             company = EXCLUDED.company,
             paired_at_ms = EXCLUDED.paired_at_ms,
             last_sync_at_ms = EXCLUDED.last_sync_at_ms,
             sync_interval_ms = EXCLUDED.sync_interval_ms`,
      [
        link.sessionId,
        link.bridgeToken,
        link.login,
        link.server,
        link.company,
        link.pairedAt,
        link.lastSyncAt,
        link.syncIntervalMs,
      ],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Resolve a bearer token to its link.
 *
 * This is the function that makes a redeploy survivable: after a restart the
 * in-memory token index is empty, but the row is still there, so the EA's next
 * heartbeat restores the Desk instead of being told its token is invalid.
 */
export async function findLinkByToken(bridgeToken: string): Promise<BridgeLink | null> {
  const cached = linksByToken.get(bridgeToken);
  if (cached) return { ...cached };
  if (!bridgeToken) return null;

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT session_id, bridge_token, login, server, company, paired_at_ms, last_sync_at_ms, sync_interval_ms
         FROM ${LINK_TABLE} WHERE bridge_token = $1 LIMIT 1`,
      [bridgeToken],
    );
    const parsed = parseLinkRow((result?.rows?.[0] ?? {}) as Record<string, unknown>);
    if (parsed) rememberLink(parsed);
    return parsed;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** The link a Desk currently holds, if any. */
export async function findLinkForSession(sessionId: string): Promise<BridgeLink | null> {
  const cached = linksBySession.get(sessionId);
  if (cached) return { ...cached };

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT session_id, bridge_token, login, server, company, paired_at_ms, last_sync_at_ms, sync_interval_ms
         FROM ${LINK_TABLE} WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    const parsed = parseLinkRow((result?.rows?.[0] ?? {}) as Record<string, unknown>);
    if (parsed) rememberLink(parsed);
    return parsed;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/**
 * Refresh the stored heartbeat stamp, throttled to
 * {@link LINK_SYNC_PERSIST_INTERVAL_MS}. The in-process record is always
 * updated; only the database write is rate-limited.
 */
export function touchLinkLastSync(
  sessionId: string,
  bridgeToken: string,
  lastSyncAt: number,
  syncIntervalMs: number,
): void {
  const stored = linksByToken.get(bridgeToken) ?? linksBySession.get(sessionId);
  if (stored && stored.bridgeToken === bridgeToken) {
    stored.lastSyncAt = lastSyncAt;
    stored.syncIntervalMs = syncIntervalMs;
  }
  const previous = lastLinkPersistAt.get(sessionId) ?? 0;
  if (lastSyncAt - previous < LINK_SYNC_PERSIST_INTERVAL_MS) return;
  lastLinkPersistAt.set(sessionId, lastSyncAt);
  void persistLastSync(sessionId, lastSyncAt, syncIntervalMs);
}

async function persistLastSync(sessionId: string, lastSyncAt: number, syncIntervalMs: number): Promise<void> {
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `UPDATE ${LINK_TABLE} SET last_sync_at_ms = $2, sync_interval_ms = $3 WHERE session_id = $1`,
      [sessionId, lastSyncAt, syncIntervalMs],
    );
  } catch {
    /* the in-process record is already current; the next throttle window retries */
  }
}

/**
 * Delete a link — only from an explicit unlink, or when the account has been
 * handed to another Desk. `bridgeToken` guards against deleting a newer link
 * that was created while this call was in flight.
 */
export async function deleteBridgeLink(sessionId: string, bridgeToken?: string): Promise<void> {
  forgetLink(sessionId);
  const db = await pool();
  if (!db) return;
  try {
    if (bridgeToken) {
      await db.query(`DELETE FROM ${LINK_TABLE} WHERE session_id = $1 AND bridge_token = $2`, [sessionId, bridgeToken]);
    } else {
      await db.query(`DELETE FROM ${LINK_TABLE} WHERE session_id = $1`, [sessionId]);
    }
  } catch (err) {
    warnOnce(err);
  }
}

/** Test/maintenance helper — never called from a request path. */
export function resetBridgeLinks(): void {
  codes.clear();
  linksByToken.clear();
  linksBySession.clear();
  lastLinkPersistAt.clear();
  dbWarned = false;
}

/** Test/maintenance helper — never called from a request path. */
export const __testing = {
  snapshotCodes(): PairingCodeRecord[] {
    return [...codes.values()].map((record) => ({ ...record }));
  },
  snapshotLinks(): BridgeLink[] {
    return [...linksBySession.values()].map((link) => ({ ...link }));
  },
  /**
   * Forget every code and link, in memory and in the database.
   *
   * Tests need this because the whole point of the module is that a link
   * outlives the process's own state: without a purge, one test's terminal
   * would be "restored from storage" inside the next one.
   */
  async purgeAll(): Promise<void> {
    resetBridgeLinks();
    const db = await pool();
    if (!db) return;
    try {
      await db.query(`DELETE FROM ${LINK_TABLE}`);
      await db.query(`DELETE FROM ${CODE_TABLE}`);
    } catch {
      /* no database — the in-process state is already cleared */
    }
  },
};
