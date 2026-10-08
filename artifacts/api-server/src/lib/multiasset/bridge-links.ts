/**
 * Durable MT5 bridge links and pairing codes.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The bridge used to be entirely process-local: the pairing code lived in a
 * `Map`, and the bearer token the EA received lived in another `Map`. That is
 * fine until the process restarts — and it restarts on every deploy, crash,
 * scale event and cold start. What the user saw was:
 *
 *   1. the Desk (and the EA) silently lost the link after a restart;
 *   2. the EA fell back to its saved pairing code — which had ALSO been lost,
 *      so every retry printed `HTTP 401 … Unknown or expired pairing code` in
 *      the MT5 journal, every 5 seconds, forever;
 *   3. with no successful sync there were no heartbeats, so the Desk showed
 *      "Reconnecting to the MT5 terminal — last heartbeat 23s ago";
 *   4. armed plans were never delivered to the terminal, so nothing executed.
 *
 * Both records are now persisted in Postgres, which is the same store the
 * account claims already use for exactly this reason. The rules:
 *
 *   • A **pairing code** belongs to the browser session that generated it,
 *     survives restarts, and stays valid until the user unlinks the terminal
 *     or explicitly rotates it. Re-opening the setup dialog no longer silently
 *     invalidates the code the EA is currently retrying with.
 *   • A **bridge link** stores the SHA-256 of the bearer token, never the token
 *     itself. A terminal that presents a valid raw token after a restart is
 *     re-adopted: the Desk is rehydrated and the link continues, so neither
 *     the user nor the EA has to do anything.
 *   • Revocation is explicit (unlink) and sticks across restarts: the row is
 *     kept, marked `revoked_at_ms`, so a token cannot be resurrected by a
 *     later restart that has no memory of the unlink.
 *
 * Every function degrades to the in-process mirror when the database is
 * unavailable (unit tests, a cold start before the pool exists). The mirror is
 * always written first, so the hot path — one heartbeat every ~500 ms — never
 * waits on a query.
 */

import { createHash } from "node:crypto";

export const BRIDGE_LINK_TABLE = "mt5_bridge_links";
export const PAIRING_CODE_TABLE = "mt5_pairing_codes";

/**
 * How long a pairing code stays usable.
 *
 * Deliberately long: the code is the user's recovery credential, and the whole
 * point of this change is that a restart (of MT5, of the browser, of the API)
 * does not force them to fetch and paste a new one. It is scoped to one
 * browser session and dies the moment the user unlinks the terminal or asks
 * for a new code, so its lifetime is bounded by the user's own intent rather
 * than by a timer they cannot see.
 */
export const PAIRING_CODE_TTL_MS = 30 * 24 * 60 * 60_000;

export interface StoredPairingCode {
  code: string;
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
}

export interface StoredBridgeLink {
  tokenHash: string;
  sessionId: string;
  accountKey: string;
  login: number;
  server: string;
  company: string;
  pairedAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

// ── In-process mirror ────────────────────────────────────────────────────────

const codes = new Map<string, StoredPairingCode>();
const linksByTokenHash = new Map<string, StoredBridgeLink>();

/**
 * Negative cache for unknown tokens.
 *
 * `/sync` now consults the durable store when a token is not in memory, which
 * is the whole point of the fix — but a terminal (or an attacker) presenting
 * random tokens would otherwise turn every request into a database query. A
 * short "this hash is not a link" memory keeps the unauthorised path as cheap
 * as it was before.
 */
const unknownTokens = new Map<string, number>();
const UNKNOWN_TOKEN_TTL_MS = 60_000;

export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
  console.warn("[mt5-bridge-links] database unavailable; keeping the link in-process only", err);
}

// ── Pairing codes ────────────────────────────────────────────────────────────

/** Store (or refresh) a pairing code. Mirrored in-process for the retry loop. */
export async function savePairingCode(record: StoredPairingCode): Promise<void> {
  codes.set(record.code, record);
  const db = await pool();
  if (!db) return warnOnce(new Error("pool unavailable"));
  try {
    await db.query(
      `INSERT INTO ${PAIRING_CODE_TABLE} (code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             expires_at_ms = EXCLUDED.expires_at_ms,
             redeemed_at_ms = EXCLUDED.redeemed_at_ms`,
      [record.code, record.sessionId, record.createdAt, record.expiresAt, record.redeemedAt],
    );
  } catch (err) {
    warnOnce(err);
  }
}

function rowToCode(row: Record<string, unknown> | undefined): StoredPairingCode | null {
  if (!row) return null;
  const code = String(row.code ?? "");
  if (!code) return null;
  return {
    code,
    sessionId: String(row.session_id ?? ""),
    createdAt: Number(row.created_at_ms ?? 0),
    expiresAt: Number(row.expires_at_ms ?? 0),
    redeemedAt: row.redeemed_at_ms === null || row.redeemed_at_ms === undefined ? null : Number(row.redeemed_at_ms),
  };
}

/** A code from this process, or from the database after a restart. */
export async function loadPairingCode(code: string, now = Date.now()): Promise<StoredPairingCode | null> {
  const cached = codes.get(code);
  if (cached) return cached.expiresAt > now ? cached : null;

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
         FROM ${PAIRING_CODE_TABLE} WHERE code = $1 LIMIT 1`,
      [code],
    );
    const record = rowToCode(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record) return null;
    codes.set(record.code, record);
    return record.expiresAt > now ? record : null;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** Mark a code as used. The code stays valid so a restart can re-pair with it. */
export async function markPairingCodeRedeemed(code: string, now = Date.now()): Promise<StoredPairingCode | null> {
  const record = codes.get(code) ?? (await loadPairingCode(code, now));
  if (!record) return null;
  const updated: StoredPairingCode = {
    ...record,
    redeemedAt: record.redeemedAt ?? now,
    // Sliding expiry: an in-use code never dies under the user's feet.
    expiresAt: now + PAIRING_CODE_TTL_MS,
  };
  await savePairingCode(updated);
  return updated;
}

/** Codes this session still owns (newest first). Used to reuse instead of rotate. */
export async function pairingCodesForSession(sessionId: string, now = Date.now()): Promise<StoredPairingCode[]> {
  const found = [...codes.values()].filter((record) => record.sessionId === sessionId && record.expiresAt > now);
  const db = await pool();
  if (!db) return found.sort((a, b) => b.createdAt - a.createdAt);
  try {
    const result = await db.query(
      `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
         FROM ${PAIRING_CODE_TABLE}
        WHERE session_id = $1 AND expires_at_ms > $2
        ORDER BY created_at_ms DESC`,
      [sessionId, now],
    );
    const seen = new Map<string, StoredPairingCode>();
    for (const record of found) seen.set(record.code, record);
    for (const row of result?.rows ?? []) {
      const record = rowToCode(row as Record<string, unknown>);
      if (record) {
        seen.set(record.code, record);
        codes.set(record.code, record);
      }
    }
    return [...seen.values()].sort((a, b) => b.createdAt - a.createdAt);
  } catch (err) {
    warnOnce(err);
    return found.sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** Drop every code a session owns — the terminal is being unlinked. */
export async function deletePairingCodesForSession(sessionId: string): Promise<void> {
  for (const [code, record] of [...codes.entries()]) {
    if (record.sessionId === sessionId) codes.delete(code);
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`DELETE FROM ${PAIRING_CODE_TABLE} WHERE session_id = $1`, [sessionId]);
  } catch (err) {
    warnOnce(err);
  }
}

/** Remove expired codes. Codes are deleted, not kept forever. */
export async function prunePairingCodes(now = Date.now()): Promise<void> {
  for (const [code, record] of [...codes.entries()]) {
    if (record.expiresAt <= now) codes.delete(code);
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`DELETE FROM ${PAIRING_CODE_TABLE} WHERE expires_at_ms <= $1`, [now]);
  } catch {
    /* pruning is housekeeping — never fail a request over it */
  }
}

// ── Bridge links ─────────────────────────────────────────────────────────────

function rowToLink(row: Record<string, unknown> | undefined): StoredBridgeLink | null {
  if (!row) return null;
  const tokenHash = String(row.token_hash ?? "");
  if (!tokenHash) return null;
  return {
    tokenHash,
    sessionId: String(row.session_id ?? ""),
    accountKey: String(row.account_key ?? ""),
    login: Number(row.login ?? 0),
    server: String(row.server ?? ""),
    company: String(row.company ?? ""),
    pairedAt: Number(row.paired_at_ms ?? 0),
    lastSeenAt: Number(row.last_seen_at_ms ?? 0),
    revokedAt: row.revoked_at_ms === null || row.revoked_at_ms === undefined ? null : Number(row.revoked_at_ms),
  };
}

export interface BridgeLinkInput {
  token: string;
  sessionId: string;
  accountKey: string;
  login: number;
  server: string;
  company?: string;
  pairedAt?: number;
}

/** Record a newly issued link (token stored hashed). */
export async function saveBridgeLink(input: BridgeLinkInput): Promise<void> {
  const now = Date.now();
  const record: StoredBridgeLink = {
    tokenHash: hashBridgeToken(input.token),
    sessionId: input.sessionId,
    accountKey: input.accountKey,
    login: Math.trunc(input.login),
    server: input.server,
    company: input.company ?? "",
    pairedAt: input.pairedAt ?? now,
    lastSeenAt: now,
    revokedAt: null,
  };
  linksByTokenHash.set(record.tokenHash, record);
  unknownTokens.delete(record.tokenHash);

  const db = await pool();
  if (!db) return warnOnce(new Error("pool unavailable"));
  try {
    await db.query(
      `INSERT INTO ${BRIDGE_LINK_TABLE}
         (token_hash, session_id, account_key, login, server, company, paired_at_ms, last_seen_at_ms, revoked_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
       ON CONFLICT (token_hash) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             account_key = EXCLUDED.account_key,
             login = EXCLUDED.login,
             server = EXCLUDED.server,
             company = EXCLUDED.company,
             last_seen_at_ms = EXCLUDED.last_seen_at_ms,
             revoked_at_ms = NULL`,
      [
        record.tokenHash,
        record.sessionId,
        record.accountKey,
        record.login,
        record.server,
        record.company,
        record.pairedAt,
        record.lastSeenAt,
      ],
    );
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Resolve a presented bearer token.
 *
 * Returns the stored link — including a revoked one, so callers can tell
 * "never paired" (401) apart from "the user unlinked this terminal" (401 with
 * an explanation the EA prints once instead of looping on).
 */
export async function loadBridgeLink(token: string): Promise<StoredBridgeLink | null> {
  const tokenHash = hashBridgeToken(token);
  const cached = linksByTokenHash.get(tokenHash);
  if (cached) return cached;

  const unknownUntil = unknownTokens.get(tokenHash);
  if (unknownUntil && unknownUntil > Date.now()) return null;

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT token_hash, session_id, account_key, login, server, company, paired_at_ms, last_seen_at_ms, revoked_at_ms
         FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1 LIMIT 1`,
      [tokenHash],
    );
    const record = rowToLink(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (record) linksByTokenHash.set(record.tokenHash, record);
    else rememberUnknown(tokenHash);
    return record;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

function rememberUnknown(tokenHash: string): void {
  // Bounded: an attacker cannot grow this map without bound, and a real token
  // that appears later is accepted the moment its row exists (saveBridgeLink
  // clears the entry).
  if (unknownTokens.size > 5_000) unknownTokens.clear();
  unknownTokens.set(tokenHash, Date.now() + UNKNOWN_TOKEN_TTL_MS);
}

/** Live (non-revoked) link for a session, if any. */
export async function liveLinkForSession(sessionId: string): Promise<StoredBridgeLink | null> {
  const cached = [...linksByTokenHash.values()]
    .filter((record) => record.sessionId === sessionId && !record.revokedAt)
    .sort((a, b) => b.pairedAt - a.pairedAt)[0];
  if (cached) return cached;

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT token_hash, session_id, account_key, login, server, company, paired_at_ms, last_seen_at_ms, revoked_at_ms
         FROM ${BRIDGE_LINK_TABLE}
        WHERE session_id = $1 AND revoked_at_ms IS NULL
        ORDER BY paired_at_ms DESC LIMIT 1`,
      [sessionId],
    );
    const record = rowToLink(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (record) linksByTokenHash.set(record.tokenHash, record);
    return record;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/** Heartbeat marker. Fire-and-forget: never block a sync on bookkeeping. */
export function touchBridgeLink(token: string, now = Date.now()): void {
  const record = linksByTokenHash.get(hashBridgeToken(token));
  if (!record) return;
  record.lastSeenAt = now;
  void (async () => {
    const db = await pool();
    if (!db) return;
    try {
      await db.query(`UPDATE ${BRIDGE_LINK_TABLE} SET last_seen_at_ms = $2 WHERE token_hash = $1`, [
        record.tokenHash,
        now,
      ]);
    } catch {
      /* the in-process record is already refreshed */
    }
  })();
}

/** Revoke one token (the EA holding it must re-pair to be trusted again). */
export async function revokeBridgeLink(token: string, now = Date.now()): Promise<void> {
  const record = linksByTokenHash.get(hashBridgeToken(token));
  if (record) record.revokedAt = now;
  const tokenHash = hashBridgeToken(token);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`UPDATE ${BRIDGE_LINK_TABLE} SET revoked_at_ms = $2 WHERE token_hash = $1`, [tokenHash, now]);
  } catch (err) {
    warnOnce(err);
  }
}

/** Revoke every token a session holds — the user unlinked the terminal. */
export async function revokeBridgeLinksForSession(sessionId: string, now = Date.now()): Promise<void> {
  for (const record of linksByTokenHash.values()) {
    if (record.sessionId === sessionId) record.revokedAt = now;
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`UPDATE ${BRIDGE_LINK_TABLE} SET revoked_at_ms = $2 WHERE session_id = $1`, [sessionId, now]);
  } catch (err) {
    warnOnce(err);
  }
}

/** Test/maintenance helper — clears the in-process mirror only. */
export function resetBridgeLinks(): void {
  codes.clear();
  linksByTokenHash.clear();
  unknownTokens.clear();
  dbWarned = false;
}

export const __testing = {
  codeSnapshot(): StoredPairingCode[] {
    return [...codes.values()];
  },
  linkSnapshot(): StoredBridgeLink[] {
    return [...linksByTokenHash.values()];
  },
  /** Simulate a process restart: forget everything, keep the database. */
  forgetProcessMemory(): void {
    codes.clear();
    linksByTokenHash.clear();
    unknownTokens.clear();
  },
};
