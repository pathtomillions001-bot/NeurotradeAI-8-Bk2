/**
 * MT5 bridge pairing codes and links — scoped to the life of the terminal.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A pairing code is active only while the MT5 terminal it paired is open.
 * Closing MT5 ends the link, the code that created it stops working with it,
 * and reconnecting is a deliberate act: the user generates a NEW code in the
 * Desk and pastes it into the EA again. EA reloads, API restarts and network
 * outages are not terminal closes: the saved credential resumes the same link.
 * See `docs/mt5-bridge-link-lifetime.md` and `docs/mt5-bridge-store-recovery.md`.
 *
 * ── WHAT IS STILL PERSISTED, AND WHY ────────────────────────────────────────
 *
 * The rows below still live in Postgres, because a link must survive the
 * API's own restart while the terminal is still up: the EA saves its token per
 * account, and a redeploy that forgot the row would disconnect a terminal
 * that never went away. What changed is the LIFETIME, not the storage:
 *
 *   • `mt5_pairing_codes` — a code is minted for one browser session, is single
 *     use, and expires 15 minutes after it is handed out if no terminal ever
 *     redeems it. Once redeemed it is bound to the link it created
 *     (`expiresAt = 0` = "lives exactly as long as that link") so the same
 *     terminal can re-present it after an API restart or a second chart. The
 *     moment that link ends the code is RETIRED — stamped with the time it
 *     stopped working so the next attempt can be told "this code's terminal is
 *     gone, take a new one" instead of "unknown code" — and pruned for good
 *     `SPENT_CODE_KEEP_MS` later. It can never mint a token in that window: the
 *     only way /pair redeems it is while its LINK is alive, and a retired code
 *     has no live link (see `codeIsLive`).
 *   • `mt5_bridge_links` — a link ends for exactly TWO reasons, and neither of
 *     them is a timer:
 *
 *       1. the user unlinks the terminal in the Desk (`/unpair`, which REVOKES
 *          rather than deletes, because that answer is final for the EA); or
 *       2. the user closes MT5 (the EA's `OnDeinit` sends `/disconnect` for
 *          `REASON_CLOSE` — the terminal itself going down).
 *
 *     Silence past `BRIDGE_LINK_LEASE_MS` no longer ends anything. A laptop
 *     lid, a weekend market close, a sleeping VPS, a five-minute network
 *     outage — every one of those used to retire the token, release the claim
 *     and clear the Desk, and the user was told their terminal had "stopped
 *     syncing" when nothing had gone wrong with it. Now a silent link is
 *     reported as STALE (the Desk already renders `MT5 STALE`, and the analysis
 *     path gates on quote freshness, not on the link's liveness) and stays
 *     paired until one of the two things above happens.
 *
 * The lease constant is kept because two things still need the number: the Desk
 * reports how long a silent terminal has been silent, and the sweep below prunes
 * the rows of revoked links.
 *
 * ── WHY THE STORE REPORT IS STILL HERE ──────────────────────────────────────
 *
 * Every read reports whether the store was actually consulted, so a route can
 * answer `503 … nothing was revoked, retry` instead of `401 your credential is
 * invalid`. A *live* link never needs that answer (the in-process mirror serves
 * the hot path); the store is only consulted for a token this process has not
 * seen — a redeploy, or a second chart. Reads retry briefly before giving up,
 * so a single slow query during a failover no longer surfaces as a 503 on a
 * 500 ms heartbeat.
 */

import { createHash } from "node:crypto";

export const BRIDGE_LINK_TABLE = "mt5_bridge_links";
export const PAIRING_CODE_TABLE = "mt5_pairing_codes";

/**
 * How long an UNREDEEMED pairing code stays usable.
 *
 * The code is read out of the Desk and typed (or pasted) into the EA, so it has
 * to survive a terminal that is opened a few minutes later — and no longer.
 * Once a terminal redeems it, this timer stops applying: the code then lives
 * exactly as long as the link it created (see `CODE_TTL_BOUND_BY_LINK`).
 */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;

/**
 * `expiresAt` sentinel for a redeemed code: no timer of its own.
 *
 * A redeemed code is bounded by its LINK, not by a clock, so that a terminal
 * which re-presents it (an EA reload, a second chart, an API redeploy the
 * terminal survived) is not refused for a reason neither the user nor the
 * terminal can see. The link ends → the code is retired with it (see
 * `retirePairingCode`), which is what puts a real timestamp in this field again
 * and expires the code.
 */
export const CODE_TTL_BOUND_BY_LINK = 0;

/**
 * How long a retired code keeps explaining itself.
 *
 * When a link ends, its code is "retired" — stamped with the moment it stopped
 * being usable — rather than deleted outright. It can never mint a token (it is
 * expired, and `/pair` only accepts a redeemed code whose LINK is alive), but
 * for this long the server can still answer a terminal that comes back with
 * "this code was used and the terminal it connected is closed" instead of the
 * indistinguishable "unknown code". The row is pruned after that.
 */
export const SPENT_CODE_KEEP_MS = 30 * 60_000;

/** Legacy silence/display interval only. Never a credential-expiry deadline. */
export const BRIDGE_LINK_LEASE_MS = 120_000;

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
  /** The pairing code that created this link, so it can be deleted with it. */
  code: string | null;
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
 * A terminal (or an attacker) presenting random tokens would otherwise turn
 * every request into a database query. A short "this hash is not a link" memory
 * keeps the unauthorised path cheap; it is only ever populated by a successful
 * read that found no row, and `saveBridgeLink` clears the entry.
 */
const unknownTokens = new Map<string, number>();
const UNKNOWN_TOKEN_TTL_MS = 10_000;

export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── Store access, with an honest answer about WHY a lookup failed ────────────
//
// Every read here used to collapse three very different outcomes into one
// `null`:
//
//   1. the row is not there          → the credential really is unknown;
//   2. the store could not be asked  → no pool, a query that threw, or the
//                                      bootstrap DDL still being applied;
//   3. the row is there but revoked  → the user unlinked the terminal.
//
// Only (1) and (3) may end a link. Treating (2) that way is what turned a
// deploy, a database failover or a second replica into the user-visible
// `HTTP 503 from /api/bridge/sync — the bridge link store could not be
// reached`, which a terminal could only retry into the void because the link it
// was retrying belonged to a session that no longer existed.
//
// So a lookup reports whether the store was actually consulted, and the routes
// answer 503 (retry, nothing revoked) when it was not.

/** Why a lookup could not produce a row. `ok` means the answer is trustworthy. */
export type StoreHealth = "ok" | "unavailable" | "error" | "not-ready";

export interface StoreLookup<T> {
  record: T | null;
  /** True only when the durable store was consulted successfully. */
  checked: boolean;
  health: StoreHealth;
  /** Human-readable cause, for the log line and the Desk's own diagnostics. */
  detail?: string;
}

interface DbHandle {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

interface DbModule {
  pool?: DbHandle;
  schemaApplied?: () => boolean;
  databaseBackend?: string;
  databaseIsDurable?: boolean;
  databaseDetail?: string;
}

let dbModulePromise: Promise<DbModule | null> | null = null;

async function dbModule(): Promise<DbModule | null> {
  if (!dbModulePromise) {
    dbModulePromise = import("@workspace/db")
      .then((mod) => mod as unknown as DbModule)
      .catch(() => null);
  }
  return dbModulePromise;
}

async function pool(): Promise<DbHandle | null> {
  const mod = await dbModule();
  return mod?.pool ?? null;
}

/**
 * Set by tests to prove the outage path: a store that cannot answer must never
 * be reported as "this credential is invalid".
 */
let forcedStoreFailure: Error | null = null;

/**
 * Can a read be trusted right now?
 *
 * `schemaApplied()` is checked rather than awaited: `schemaReady` resolves even
 * when the DDL FAILED on its first attempt (deliberately, so routes are not
 * blocked behind a dead database), and the HTTP server listens while that retry
 * loop is still running. A request that lands in that window would otherwise
 * read a table that does not exist yet and report a perfectly good token as
 * unknown.
 */
async function storeConsultable(): Promise<{ ok: boolean; detail?: string }> {
  const mod = await dbModule();
  if (!mod?.pool) return { ok: false, detail: "no database pool" };
  if (typeof mod.schemaApplied === "function" && !mod.schemaApplied()) {
    return { ok: false, detail: "schema bootstrap has not been applied yet" };
  }
  return { ok: true };
}

/** Never acknowledge a credential that exists only in this process's memory. */
async function writableStore(): Promise<DbHandle> {
  if (forcedStoreFailure) throw forcedStoreFailure;
  const ready = await storeConsultable();
  if (!ready.ok) throw new Error(ready.detail ?? "bridge schema not ready");
  const mod = await dbModule();
  // Embedded container storage is useful locally, but is not shared or durable
  // across production deploys/replicas. Do not promise a persistent MT5 link on it.
  if (process.env.NODE_ENV === "production" && mod?.databaseBackend !== "postgres") {
    throw new Error("MT5 pairing requires a shared PostgreSQL DATABASE_URL in production");
  }
  const db = mod?.pool;
  if (!db) throw new Error("no database pool");
  return db;
}

/**
 * Run a read, retrying a FEW times before declaring the store unreadable.
 *
 * A 503 tells the terminal "I could not check — retry", which is a heavier
 * statement than it looks: it pauses new entries on the desk while it lasts. A
 * single query that timed out during a Postgres failover, a connection pool
 * that had to open a fresh socket, or a DDL that was mid-commit is exactly the
 * kind of blip that clears in a few hundred milliseconds, so the read tries
 * again (with a short, bounded backoff) before the route answers.
 */
async function withStoreRetry<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
  throw lastError;
}

/**
 * What the Desk and `/api/healthz` report about the link store, so a
 * deployment whose link rows are not durable says so on screen instead of
 * discovering it as a terminal that silently dies on the next restart.
 */
export interface BridgeStoreReport {
  backend: string;
  durable: boolean;
  detail: string;
  schemaApplied: boolean;
  reachable: boolean;
  tables: string[];
}

let storeReportCache: { at: number; value: BridgeStoreReport } | null = null;
const STORE_REPORT_TTL_MS = 10_000;

export async function bridgeStoreReport(force = false): Promise<BridgeStoreReport> {
  if (!force && storeReportCache && Date.now() - storeReportCache.at < STORE_REPORT_TTL_MS) {
    return storeReportCache.value;
  }
  const mod = await dbModule();
  const applied = typeof mod?.schemaApplied === "function" ? mod.schemaApplied() : true;
  let reachable = false;
  const tables: string[] = [];
  try {
    if (forcedStoreFailure) throw forcedStoreFailure;
    const db = mod?.pool;
    if (db) {
      await db.query(`SELECT 1 FROM ${BRIDGE_LINK_TABLE} LIMIT 1`);
      await db.query(`SELECT 1 FROM ${PAIRING_CODE_TABLE} LIMIT 1`);
      reachable = true;
      tables.push(BRIDGE_LINK_TABLE, PAIRING_CODE_TABLE);
    }
  } catch (err) {
    warnOnce(err);
  }
  const value: BridgeStoreReport = {
    backend: mod?.databaseBackend ?? "unknown",
    durable: Boolean(mod?.databaseIsDurable),
    detail: mod?.databaseDetail ?? "database module unavailable",
    schemaApplied: applied,
    reachable,
    tables,
  };
  storeReportCache = { at: Date.now(), value };
  return value;
}

let dbWarned = false;

function warnOnce(err: unknown): void {
  if (dbWarned) return;
  dbWarned = true;
  // eslint-disable-next-line no-console
  console.warn("[mt5-bridge-links] store operation failed; new credentials require persistence, existing links are retained", err);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Pairing codes ────────────────────────────────────────────────────────────

/** Is this code usable at this moment? (See `CODE_TTL_BOUND_BY_LINK`.) */
export function codeIsLive(record: StoredPairingCode, now = Date.now()): boolean {
  // A redeemed code is either bound to its live link (0) or retired to a real
  // timestamp, which expires it. `redeemedAt` is what tells the two apart when
  // a code comes back after its terminal is gone — see `retirePairingCode`.
  if (record.redeemedAt !== null) return record.expiresAt === CODE_TTL_BOUND_BY_LINK || record.expiresAt > now;
  return record.expiresAt > now;
}

/** Store (or refresh) a pairing code. Mirrored in-process for the retry loop. */
export async function savePairingCode(record: StoredPairingCode): Promise<void> {
  const db = await writableStore();
  try {
    await withStoreRetry(() => db.query(
      `INSERT INTO ${PAIRING_CODE_TABLE} (code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             expires_at_ms = EXCLUDED.expires_at_ms,
             redeemed_at_ms = EXCLUDED.redeemed_at_ms`,
      [record.code, record.sessionId, record.createdAt, record.expiresAt, record.redeemedAt],
    ));
    codes.set(record.code, record);
  } catch (err) {
    warnOnce(err);
    throw err;
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

/**
 * A code from this process, or from the database after a restart — plus whether
 * the database was actually in a position to answer.
 */
export async function lookupPairingCode(code: string, now = Date.now()): Promise<StoreLookup<StoredPairingCode>> {
  const cached = codes.get(code);
  if (cached) {
    return codeIsLive(cached, now)
      ? { record: cached, checked: true, health: "ok" }
      : { record: null, checked: true, health: "ok", detail: "expired" };
  }

  const consultable = await storeConsultable();
  if (!consultable.ok) {
    return { record: null, checked: false, health: "not-ready", detail: consultable.detail };
  }
  try {
    if (forcedStoreFailure) throw forcedStoreFailure;
    const db = await pool();
    if (!db) return { record: null, checked: false, health: "unavailable", detail: "no database pool" };
    const result = await withStoreRetry(() =>
      db.query(
        `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
           FROM ${PAIRING_CODE_TABLE} WHERE code = $1 LIMIT 1`,
        [code],
      ),
    );
    const record = rowToCode(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record) return { record: null, checked: true, health: "ok", detail: "no such code" };
    codes.set(record.code, record);
    return codeIsLive(record, now)
      ? { record, checked: true, health: "ok" }
      : { record: null, checked: true, health: "ok", detail: "expired" };
  } catch (err) {
    warnOnce(err);
    return { record: null, checked: false, health: "error", detail: messageOf(err) };
  }
}

/** A code from this process, or from the database after a restart. */
export async function loadPairingCode(code: string, now = Date.now()): Promise<StoredPairingCode | null> {
  return (await lookupPairingCode(code, now)).record;
}

/**
 * Mark a code as used and bind it to the link it just created.
 *
 * `expiresAt` becomes `CODE_TTL_BOUND_BY_LINK` (0): from here the code has no
 * timer of its own, because its lifetime IS the lifetime of the link — the
 * terminal may re-present it (an EA reload, a second chart, an API redeploy it
 * survived) until the link ends, at which point the code is deleted.
 */
export async function markPairingCodeRedeemed(code: string, now = Date.now()): Promise<StoredPairingCode | null> {
  const record = codes.get(code) ?? (await loadPairingCode(code, now));
  if (!record) return null;
  const updated: StoredPairingCode = {
    ...record,
    redeemedAt: record.redeemedAt ?? now,
    expiresAt: CODE_TTL_BOUND_BY_LINK,
  };
  await savePairingCode(updated);
  return updated;
}

/** Codes this session still owns (newest first). Used to reuse instead of rotate. */
export async function pairingCodesForSession(sessionId: string, now = Date.now()): Promise<StoredPairingCode[]> {
  const found = [...codes.values()].filter((record) => record.sessionId === sessionId && codeIsLive(record, now));
  const db = await pool();
  if (!db) return found.sort((a, b) => b.createdAt - a.createdAt);
  try {
    const result = await withStoreRetry(() =>
      db.query(
        `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
           FROM ${PAIRING_CODE_TABLE}
          WHERE session_id = $1 AND (expires_at_ms = ${CODE_TTL_BOUND_BY_LINK} OR expires_at_ms > $2)
          ORDER BY created_at_ms DESC`,
        [sessionId, now],
      ),
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

/** Drop one code — its link ended, so the credential dies with it. */
export async function deletePairingCode(code: string): Promise<void> {
  codes.delete(code);
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`DELETE FROM ${PAIRING_CODE_TABLE} WHERE code = $1`, [code]);
  } catch (err) {
    warnOnce(err);
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

/**
 * Remove codes that are no longer usable. A code bound to a LIVE link
 * (`expiresAt = 0`) is never pruned here — it is retired when its link ends.
 *
 * Expired rows are kept for `SPENT_CODE_KEEP_MS` past their expiry, because an
 * expired-but-redeemed row is what lets the server answer a returning terminal
 * with "this code was used by a session that has ended" rather than "unknown
 * code".
 */
export async function prunePairingCodes(now = Date.now()): Promise<void> {
  const cutoff = now - SPENT_CODE_KEEP_MS;
  for (const [code, record] of [...codes.entries()]) {
    if (record.expiresAt !== CODE_TTL_BOUND_BY_LINK && record.expiresAt <= cutoff) codes.delete(code);
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(
      `DELETE FROM ${PAIRING_CODE_TABLE} WHERE expires_at_ms <> ${CODE_TTL_BOUND_BY_LINK} AND expires_at_ms <= $1`,
      [cutoff],
    );
  } catch {
    /* pruning is housekeeping — never fail a request over it */
  }
}

/**
 * Retire a code whose link has ended.
 *
 * A code that was redeemed becomes a SPENT record: not usable, but still able
 * to explain itself to the next attempt. A code that was never redeemed is
 * simply deleted — it never connected anything and there is nothing to explain.
 */
export async function retirePairingCode(code: string, now = Date.now()): Promise<void> {
  const cached = codes.get(code);
  if (cached) {
    if (cached.redeemedAt === null) return deletePairingCode(code);
    const spent: StoredPairingCode = { ...cached, expiresAt: now };
    codes.set(code, spent);
    await savePairingCode(spent);
    return;
  }

  const db = await pool();
  if (!db) return;
  try {
    const result = await db.query(
      `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
         FROM ${PAIRING_CODE_TABLE} WHERE code = $1 LIMIT 1`,
      [code],
    );
    const record = rowToCode(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record || record.redeemedAt === null) return deletePairingCode(code);
    const spent: StoredPairingCode = { ...record, expiresAt: now };
    codes.set(code, spent);
    await savePairingCode(spent);
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Look a code up REGARDLESS of whether it is still usable.
 *
 * Used only to explain a refusal: an expired row that carries `redeemedAt` is
 * the trace of a terminal session that has ended, which is a different message
 * from "there is no such code".
 */
export async function lookupSpentPairingCode(code: string): Promise<StoreLookup<StoredPairingCode>> {
  const cached = codes.get(code);
  if (cached) return { record: cached, checked: true, health: "ok" };

  const consultable = await storeConsultable();
  if (!consultable.ok) {
    return { record: null, checked: false, health: "not-ready", detail: consultable.detail };
  }
  try {
    if (forcedStoreFailure) throw forcedStoreFailure;
    const db = await pool();
    if (!db) return { record: null, checked: false, health: "unavailable", detail: "no database pool" };
    const result = await withStoreRetry(() =>
      db.query(
        `SELECT code, session_id, created_at_ms, expires_at_ms, redeemed_at_ms
           FROM ${PAIRING_CODE_TABLE} WHERE code = $1 LIMIT 1`,
        [code],
      ),
    );
    const record = rowToCode(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record) return { record: null, checked: true, health: "ok", detail: "no such code" };
    codes.set(record.code, record);
    return { record, checked: true, health: "ok" };
  } catch (err) {
    warnOnce(err);
    return { record: null, checked: false, health: "error", detail: messageOf(err) };
  }
}

// ── Bridge links ─────────────────────────────────────────────────────────────

function rowToLink(row: Record<string, unknown> | undefined): StoredBridgeLink | null {
  if (!row) return null;
  const tokenHash = String(row.token_hash ?? "");
  if (!tokenHash) return null;
  const code = row.code === null || row.code === undefined ? "" : String(row.code);
  return {
    tokenHash,
    sessionId: String(row.session_id ?? ""),
    accountKey: String(row.account_key ?? ""),
    login: Number(row.login ?? 0),
    server: String(row.server ?? ""),
    company: String(row.company ?? ""),
    code: code === "" ? null : code,
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
  /** The code that created this link; deleted when the link ends. */
  code?: string | null;
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
    code: input.code ?? null,
    pairedAt: input.pairedAt ?? now,
    lastSeenAt: now,
    revokedAt: null,
  };
  const db = await writableStore();
  try {
    // One statement: consuming the code and persisting its token either both
    // commit or neither does. In particular a failed INSERT cannot leave a
    // "spent" code with no link, and a redeploy cannot lose an acknowledged token.
    const result = await withStoreRetry(() => db.query(
      `WITH paired_code AS (
         UPDATE ${PAIRING_CODE_TABLE}
            SET redeemed_at_ms = COALESCE(redeemed_at_ms, $9), expires_at_ms = 0
          WHERE code = $7 AND session_id = $2
            AND (expires_at_ms = 0 OR expires_at_ms > $9)
          RETURNING code
       )
       INSERT INTO ${BRIDGE_LINK_TABLE}
         (token_hash, session_id, account_key, login, server, company, code, paired_at_ms, last_seen_at_ms, revoked_at_ms)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL
        WHERE $7::text IS NULL OR EXISTS (SELECT 1 FROM paired_code)
       ON CONFLICT (token_hash) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             account_key = EXCLUDED.account_key,
             login = EXCLUDED.login,
             server = EXCLUDED.server,
             company = EXCLUDED.company,
             code = EXCLUDED.code,
             last_seen_at_ms = EXCLUDED.last_seen_at_ms
       RETURNING token_hash`,
      [record.tokenHash, record.sessionId, record.accountKey, record.login,
        record.server, record.company, record.code, record.pairedAt, record.lastSeenAt],
    ));
    if (!result.rows.length) throw new Error("pairing code no longer usable; retry with the current Desk code");
    linksByTokenHash.set(record.tokenHash, record);
    unknownTokens.delete(record.tokenHash);
    const code = record.code ? codes.get(record.code) : null;
    if (code) codes.set(code.code, { ...code, redeemedAt: code.redeemedAt ?? now, expiresAt: 0 });
  } catch (err) {
    warnOnce(err);
    throw err;
  }
}

/**
 * Resolve a presented bearer token — and say whether the answer is trustworthy.
 *
 * Returns the stored link — including a revoked one, so callers can tell
 * "never paired" (401) apart from "the user unlinked this terminal" (401 with
 * an explanation the EA prints once instead of looping on) apart from "the
 * store could not be read" (503, retry, nothing revoked).
 */
export async function lookupBridgeLink(token: string): Promise<StoreLookup<StoredBridgeLink>> {
  const tokenHash = hashBridgeToken(token);
  const cached = linksByTokenHash.get(tokenHash);
  if (cached) return { record: cached, checked: true, health: "ok" };

  const unknownUntil = unknownTokens.get(tokenHash);
  if (unknownUntil && unknownUntil > Date.now()) {
    return { record: null, checked: true, health: "ok", detail: "not a known link" };
  }
  // Stale entry: drop it so a row written since (by this process or another
  // replica) is seen immediately instead of being refused for the rest of the
  // cache window.
  if (unknownUntil) unknownTokens.delete(tokenHash);

  const consultable = await storeConsultable();
  if (!consultable.ok) {
    return { record: null, checked: false, health: "not-ready", detail: consultable.detail };
  }
  try {
    if (forcedStoreFailure) throw forcedStoreFailure;
    const db = await pool();
    if (!db) return { record: null, checked: false, health: "unavailable", detail: "no database pool" };
    const result = await withStoreRetry(() =>
      db.query(
        `SELECT token_hash, session_id, account_key, login, server, company, code, paired_at_ms, last_seen_at_ms, revoked_at_ms
           FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      ),
    );
    const record = rowToLink(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (record) linksByTokenHash.set(record.tokenHash, record);
    else rememberUnknown(tokenHash);
    return record
      ? { record, checked: true, health: "ok" }
      : { record: null, checked: true, health: "ok", detail: "no such link" };
  } catch (err) {
    warnOnce(err);
    // Deliberately NOT negatively cached: an error says nothing about whether
    // the row exists, and caching it would keep refusing a valid token after
    // the store recovers.
    return { record: null, checked: false, health: "error", detail: messageOf(err) };
  }
}

/** Resolve a presented bearer token. */
export async function loadBridgeLink(token: string): Promise<StoredBridgeLink | null> {
  return (await lookupBridgeLink(token)).record;
}

/**
 * Was this token revoked on purpose (the user unlinked the terminal)?
 *
 * The EA may destroy its token for THIS answer and for no other: it is the one
 * refusal that is final.
 */
export async function bridgeLinkWasRevoked(token: string): Promise<boolean> {
  const lookup = await lookupBridgeLink(token);
  return Boolean(lookup.record?.revokedAt);
}

/** The live link a redeemed code created, if it is still alive. */
export async function linkByCode(code: string, now = Date.now()): Promise<StoreLookup<StoredBridgeLink>> {
  const cached = [...linksByTokenHash.values()]
    .filter((record) => record.code === code && !record.revokedAt)
    .sort((a, b) => b.pairedAt - a.pairedAt)[0];
  // A silent link's code still pairs: the terminal is coming back from a reboot,
  // a closed laptop or a redeploy, and it presents exactly this code. Refusing
  // it here is how a reconnect used to need a NEW code that the user had to
  // fetch from the browser.
  if (cached && linkIsValid(cached)) return { record: cached, checked: true, health: "ok" };

  const consultable = await storeConsultable();
  if (!consultable.ok) {
    return { record: null, checked: false, health: "not-ready", detail: consultable.detail };
  }
  try {
    if (forcedStoreFailure) throw forcedStoreFailure;
    const db = await pool();
    if (!db) return { record: null, checked: false, health: "unavailable", detail: "no database pool" };
    const result = await withStoreRetry(() =>
      db.query(
        `SELECT token_hash, session_id, account_key, login, server, company, code, paired_at_ms, last_seen_at_ms, revoked_at_ms
           FROM ${BRIDGE_LINK_TABLE}
          WHERE code = $1 AND revoked_at_ms IS NULL
          ORDER BY paired_at_ms DESC LIMIT 1`,
        [code],
      ),
    );
    const record = rowToLink(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record) return { record: null, checked: true, health: "ok", detail: "no link for this code" };
    linksByTokenHash.set(record.tokenHash, record);
    return linkIsValid(record)
      ? { record, checked: true, health: "ok" }
      : { record: null, checked: true, health: "ok", detail: "the code's link was revoked" };
  } catch (err) {
    warnOnce(err);
    return { record: null, checked: false, health: "error", detail: messageOf(err) };
  }
}

/**
 * Is this a LINK at all — i.e. may credentials issued under it still be used?
 *
 * The whole definition is now one clause: it has not been revoked. Silence does
 * not invalidate a credential, because silence is not a decision anybody made;
 * a power cut is not the user pressing Unlink.
 */
export function linkIsValid(link: StoredBridgeLink): boolean {
  return !link.revokedAt;
}

/**
 * Has this link been heard from recently?
 *
 * This is a REPORTING question — the Desk shows `MT5 STALE`, the pairing dialog
 * says "waiting for the terminal" — and deliberately not an authorisation one.
 * See `linkIsValid` for what may still be used.
 */
export function linkIsLive(link: StoredBridgeLink, now = Date.now()): boolean {
  if (link.revokedAt) return false;
  return now - link.lastSeenAt <= BRIDGE_LINK_LEASE_MS;
}

/** The session's link, if it has one that has not been revoked. */
export async function liveLinkForSession(sessionId: string, now = Date.now()): Promise<StoredBridgeLink | null> {
  const cached = [...linksByTokenHash.values()]
    .filter((record) => record.sessionId === sessionId && !record.revokedAt)
    .sort((a, b) => b.pairedAt - a.pairedAt)[0];
  if (cached && linkIsValid(cached)) return cached;

  const db = await pool();
  if (!db) return null;
  try {
    const result = await db.query(
      `SELECT token_hash, session_id, account_key, login, server, company, code, paired_at_ms, last_seen_at_ms, revoked_at_ms
         FROM ${BRIDGE_LINK_TABLE}
        WHERE session_id = $1 AND revoked_at_ms IS NULL
        ORDER BY paired_at_ms DESC LIMIT 1`,
      [sessionId],
    );
    const record = rowToLink(result?.rows?.[0] as Record<string, unknown> | undefined);
    if (!record) return null;
    linksByTokenHash.set(record.tokenHash, record);
    return linkIsValid(record) ? record : null;
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

/**
 * Links whose terminal has stopped heartbeating.
 *
 * The union of the in-process mirror and the database, because either may hold
 * the only copy: a row written by another replica before this process started,
 * or a mirror entry for a token issued here before its row was flushed. When
 * BOTH know a token, the mirror wins — it is what this process's heartbeat path
 * updates, and a slow write must not expire a terminal that is demonstrably
 * still beating.
 *
 * Read-only on purpose: the caller (`routes/bridge.ts`) performs the teardown,
 * because ending a link means revoking tokens, releasing the account claim and
 * clearing the Desk's terminal data — none of which belong in a storage module.
 */
export async function staleLinks(now = Date.now()): Promise<StoredBridgeLink[]> {
  const cutoff = now - BRIDGE_LINK_LEASE_MS;
  const found = new Map<string, StoredBridgeLink>();
  for (const record of linksByTokenHash.values()) {
    if (!record.revokedAt && record.lastSeenAt <= cutoff) found.set(record.tokenHash, record);
  }

  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT token_hash, session_id, account_key, login, server, company, code, paired_at_ms, last_seen_at_ms, revoked_at_ms
           FROM ${BRIDGE_LINK_TABLE}
          WHERE revoked_at_ms IS NULL AND last_seen_at_ms <= $1`,
        [cutoff],
      );
      for (const row of result?.rows ?? []) {
        const record = rowToLink(row as Record<string, unknown>);
        if (!record) continue;
        // The mirror knows a fresher lastSeenAt → this terminal is alive.
        const local = linksByTokenHash.get(record.tokenHash);
        if (local && local.lastSeenAt > cutoff) continue;
        found.set(record.tokenHash, record);
      }
    } catch (err) {
      warnOnce(err);
    }
  }
  return [...found.values()];
}

/**
 * Does this session still have a live terminal, apart from one token?
 *
 * A link is a (Desk, account) pair, so an MT5 terminal with the EA on two
 * charts holds one link with two tokens. When one of those charts goes away its
 * token is dropped — but the LINK must survive, because the other chart is
 * still streaming. This is the question the disconnect path and the lease
 * sweeper ask before ending anything: is anybody else still here?
 */
export async function sessionHasLiveLink(
  sessionId: string,
  exceptTokenHash: string,
  now = Date.now(),
): Promise<boolean> {
  const cutoff = now - BRIDGE_LINK_LEASE_MS;
  for (const record of linksByTokenHash.values()) {
    if (record.sessionId !== sessionId || record.revokedAt) continue;
    if (record.tokenHash === exceptTokenHash) continue;
    if (record.lastSeenAt > cutoff) return true;
  }
  const db = await pool();
  if (!db) return false;
  try {
    const result = await db.query(
      `SELECT 1 FROM ${BRIDGE_LINK_TABLE}
        WHERE session_id = $1 AND revoked_at_ms IS NULL AND last_seen_at_ms > $2 AND token_hash <> $3
        LIMIT 1`,
      [sessionId, cutoff, exceptTokenHash],
    );
    return (result?.rows?.length ?? 0) > 0;
  } catch (err) {
    warnOnce(err);
    return false;
  }
}

/**
 * Housekeeping for revoked rows.
 *
 * A revocation is kept for a while on purpose: the EA that holds the token
 * retries a few times, spaced out, and needs the `bridge_link_revoked` answer
 * each time — that is the one refusal it may treat as final. After that window
 * the row is dead weight, so it is deleted rather than left to accumulate.
 */
export async function pruneRevokedLinks(now = Date.now(), keepMs = 30 * 60_000): Promise<void> {
  const cutoff = now - keepMs;
  for (const [tokenHash, record] of [...linksByTokenHash.entries()]) {
    if (record.revokedAt && record.revokedAt <= cutoff) linksByTokenHash.delete(tokenHash);
  }
  const db = await pool();
  if (!db) return;
  try {
    await db.query(`DELETE FROM ${BRIDGE_LINK_TABLE} WHERE revoked_at_ms IS NOT NULL AND revoked_at_ms <= $1`, [
      cutoff,
    ]);
  } catch {
    /* housekeeping — never fail a request over it */
  }
}

function rememberUnknown(tokenHash: string): void {
  // Bounded: an attacker cannot grow this map without bound, and a real token
  // that appears later is accepted the moment its row exists (saveBridgeLink
  // clears the entry).
  //
  // 10 s, not 60: this cache is only ever populated by a SUCCESSFUL read that
  // found no row, but with more than one replica behind the router a row another
  // instance just wrote is a legitimate miss here. A minute of refusing a token
  // that is valid cluster-wide is a minute of "reconnecting" on the Desk; ten
  // seconds is enough to keep a random-token spray off the database.
  if (unknownTokens.size > 5_000) unknownTokens.clear();
  unknownTokens.set(tokenHash, Date.now() + UNKNOWN_TOKEN_TTL_MS);
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

/**
 * Delete one link row outright.
 *
 * Used when a link ENDS — the terminal is gone, or the Desk is replacing it.
 * Deletion (rather than revocation) is what makes the connection unrevivable:
 * nothing is left for a later process, replica or restart to re-adopt, so the
 * terminal must present a fresh pairing code. `unpair` deliberately still
 * REVOKES instead, so the EA is told `bridge_link_revoked` — the one answer it
 * is allowed to treat as final and stop retrying on.
 */
export async function deleteBridgeLink(token: string): Promise<void> {
  const tokenHash = hashBridgeToken(token);
  const local = linksByTokenHash.get(tokenHash);
  linksByTokenHash.delete(tokenHash);
  const db = await pool();
  if (!db) {
    if (local?.code) await retireCodeIfUnreferenced(local.code);
    return;
  }
  try {
    const result = await db.query(`SELECT code FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1`, [tokenHash]);
    const stored = (result?.rows?.[0] as Record<string, unknown> | undefined)?.code;
    const code = stored === null || stored === undefined || stored === "" ? local?.code ?? "" : String(stored);
    await db.query(`DELETE FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1`, [tokenHash]);
    if (code) await retireCodeIfUnreferenced(code);
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Delete a pairing code, unless another live row of the same link still needs
 * it.
 *
 * One MT5 terminal with the EA on two charts holds ONE link with two tokens —
 * and both rows carry the same code, because both re-presented it. When one
 * chart's row goes, the code must survive for the chart that is still streaming
 * (it is how that chart re-pairs after an API redeploy); it dies with the last
 * row, which is what makes a closed terminal need a new code.
 */
async function retireCodeIfUnreferenced(code: string): Promise<void> {
  for (const record of linksByTokenHash.values()) {
    if (record.code === code && !record.revokedAt) return;
  }
  const db = await pool();
  if (db) {
    try {
      const result = await db.query(
        `SELECT 1 FROM ${BRIDGE_LINK_TABLE} WHERE code = $1 AND revoked_at_ms IS NULL LIMIT 1`,
        [code],
      );
      if ((result?.rows?.length ?? 0) > 0) return;
    } catch (err) {
      warnOnce(err);
    }
  }
  await retirePairingCode(code);
}

/**
 * Delete one link row, addressed by its token hash (the sweeper's only handle).
 *
 * The row's pairing code is retired with it once nothing else points at it —
 * see `retireCodeIfUnreferenced`.
 */
export async function deleteBridgeLinkByHash(tokenHash: string): Promise<void> {
  const local = linksByTokenHash.get(tokenHash);
  linksByTokenHash.delete(tokenHash);
  const db = await pool();
  if (!db) {
    if (local?.code) await retireCodeIfUnreferenced(local.code);
    return;
  }
  try {
    const result = await db.query(`SELECT code FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1`, [tokenHash]);
    const stored = (result?.rows?.[0] as Record<string, unknown> | undefined)?.code;
    const code = stored === null || stored === undefined || stored === "" ? local?.code ?? "" : String(stored);
    await db.query(`DELETE FROM ${BRIDGE_LINK_TABLE} WHERE token_hash = $1`, [tokenHash]);
    if (code) await retireCodeIfUnreferenced(code);
  } catch (err) {
    warnOnce(err);
  }
}

/**
 * Delete every link row for a session — the link is over.
 *
 * Used when the terminal disconnects, when its heartbeats stop, and when the
 * Desk replaces it. The codes those rows carried are dropped with them (unless
 * another live row still references them), which is what makes a closed
 * terminal need a NEW code rather than being able to re-present an old one.
 */
export async function deleteBridgeLinksForSession(sessionId: string): Promise<void> {
  const codesToDrop = new Set<string>();
  for (const [tokenHash, record] of [...linksByTokenHash.entries()]) {
    if (record.sessionId !== sessionId) continue;
    if (record.code) codesToDrop.add(record.code);
    linksByTokenHash.delete(tokenHash);
  }

  const db = await pool();
  if (!db) {
    for (const code of codesToDrop) await retireCodeIfUnreferenced(code);
    return;
  }
  try {
    const result = await db.query(`SELECT code FROM ${BRIDGE_LINK_TABLE} WHERE session_id = $1`, [sessionId]);
    for (const row of result?.rows ?? []) {
      const code = (row as Record<string, unknown>).code;
      if (code) codesToDrop.add(String(code));
    }
    await db.query(`DELETE FROM ${BRIDGE_LINK_TABLE} WHERE session_id = $1`, [sessionId]);
    for (const code of codesToDrop) await retireCodeIfUnreferenced(code);
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
  forcedStoreFailure = null;
  storeReportCache = null;
}

export const __testing = {
  codeSnapshot(): StoredPairingCode[] {
    return [...codes.values()];
  },
  linkSnapshot(): StoredBridgeLink[] {
    return [...linksByTokenHash.values()];
  },
  /**
   * Simulate a process restart: forget everything, keep the database.
   *
   * NOTE: this is only meaningful for a terminal that is still open. A link and
   * its code now die with the terminal, so a "restart" that is not followed by
   * a heartbeat within the lease is exactly what the sweeper ends.
   */
  forgetProcessMemory(): void {
    codes.clear();
    linksByTokenHash.clear();
    unknownTokens.clear();
  },
  /** Forget process memory only, keeping what the tests deliberately kept. */
  forgetLinkMemory(): void {
    linksByTokenHash.clear();
    unknownTokens.clear();
  },
  /**
   * Simulate a store outage: the database is there but cannot answer (a deploy
   * mid-failover, a table that has not been created yet, a pool that timed out).
   * Routes must answer "try again" and must NOT revoke anything.
   */
  failStore(message = "simulated store outage"): void {
    forcedStoreFailure = new Error(message);
    storeReportCache = null;
  },
  healStore(): void {
    forcedStoreFailure = null;
    storeReportCache = null;
  },
};
