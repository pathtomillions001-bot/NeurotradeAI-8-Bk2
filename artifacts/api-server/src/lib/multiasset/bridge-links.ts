/** Durable MT5 credentials. Never persist prices or executable orders. */
import { createHash, randomBytes } from "node:crypto";
import { pool, schemaReady } from "@workspace/db";
import { getDesk, type DeskState } from "./store";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const bridgeTokenForCode = (code: string) =>
  `nt_${hash(`mt5-bridge:${code}`)}`;
export const normalisePairingCode = (code: string) => code.trim().toUpperCase();

export async function createPairingCode(sessionId: string): Promise<string> {
  await schemaReady;
  // A reusable code is a credential, not a short PIN. 128 bits of entropy.
  const code = randomBytes(16)
    .toString("hex")
    .toUpperCase()
    .match(/.{4}/g)!
    .join("-");
  await pool.query(
    `INSERT INTO mt5_bridge_links (session_id, code_hash) VALUES ($1, $2)
     ON CONFLICT (session_id) DO UPDATE SET code_hash = EXCLUDED.code_hash, code_account_key = NULL`,
    [sessionId, hash(code)],
  );
  return code;
}

export async function findPairing(
  code: string,
): Promise<{ sessionId: string; terminal: DeskState["terminal"] } | null> {
  await schemaReady;
  const { rows } = await pool.query(
    `SELECT session_id, terminal FROM mt5_bridge_links WHERE code_hash = $1`,
    [hash(normalisePairingCode(code))],
  );
  const row = rows[0];
  return row
    ? { sessionId: String(row.session_id), terminal: row.terminal ?? null }
    : null;
}

export async function saveBridgeLink(desk: DeskState): Promise<void> {
  if (!desk.terminal) return;
  const { bridgeToken, ...terminal } = desk.terminal;
  // User authorisation/settings survive restarts; executable orders never do.
  await pool.query(
    `UPDATE mt5_bridge_links SET token_hash = COALESCE($2, token_hash), terminal = $3, settings = $4 WHERE session_id = $1`,
    [
      desk.sessionId,
      bridgeToken ? hash(bridgeToken) : null,
      JSON.stringify(terminal),
      JSON.stringify({
        watchlist: desk.watchlist,
        autoTrade: desk.autoTrade,
        mode: desk.mode,
        timezone: desk.timezone,
        policy: desk.policy,
        riskState: desk.riskState,
      }),
    ],
  );
}

export async function restoreBridgeLink(
  sessionId: string,
  token?: string,
): Promise<DeskState> {
  await schemaReady;
  const desk = getDesk(sessionId);
  if (desk.terminal) return desk;
  const { rows } = await pool.query(
    `SELECT terminal, settings FROM mt5_bridge_links WHERE session_id = $1 AND terminal IS NOT NULL`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return desk;
  // A browser restore need not know the secret. Auth always checks token_hash.
  desk.terminal = {
    ...row.terminal,
    bridgeToken: token ?? "",
    lastSyncAt: 0,
    lastSeq: 0,
  };
  const settings = row.settings ?? {};
  desk.watchlist = settings.watchlist ?? [];
  desk.mode = settings.mode ?? desk.mode;
  desk.timezone = settings.timezone ?? desk.timezone;
  desk.policy = settings.policy ?? desk.policy;
  desk.riskState = settings.riskState ?? desk.riskState;
  desk.autoTrade = settings.autoTrade === true;
  return desk;
}

export async function authenticateBridgeToken(
  token: string,
): Promise<DeskState | null> {
  await schemaReady;
  // Read revocation from durable storage, including after an API redeploy.
  const { rows } = await pool.query(
    `SELECT session_id FROM mt5_bridge_links WHERE token_hash = $1 AND terminal IS NOT NULL`,
    [hash(token)],
  );
  if (!rows[0]) return null;
  const desk = await restoreBridgeLink(String(rows[0].session_id), token);
  if (desk.terminal) desk.terminal.bridgeToken = token;
  return desk;
}

export async function deleteBridgeLink(sessionId: string): Promise<void> {
  await schemaReady;
  await pool.query(`DELETE FROM mt5_bridge_links WHERE session_id = $1`, [
    sessionId,
  ]);
}

/** Compare-and-set: one reusable code can only bind one broker account. */
export async function bindPairing(
  code: string,
  accountKey: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `UPDATE mt5_bridge_links SET code_account_key = $2 WHERE code_hash = $1
      AND (code_account_key IS NULL OR code_account_key = $2) RETURNING session_id`,
    [hash(normalisePairingCode(code)), accountKey],
  );
  return rows.length > 0;
}

/** Pair/unpair are serialised per session; a disconnect cannot resurrect in-flight work. */
const locks = new Map<string, Promise<void>>();
export async function withBridgeLock<T>(
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(sessionId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(sessionId) === current) locks.delete(sessionId);
  }
}

/** Single executor lease, shared across API processes and terminal installations.
 * Longer than the EA's 120s server-silence circuit breaker. No command replay
 * on handover: an uncertain broker acknowledgement must never become a retry.
 */
export async function acquireConnector(
  sessionId: string,
  instanceId: string,
  now: number,
): Promise<{ ok: boolean; changed: boolean }> {
  const { rows: previous } = await pool.query(
    `SELECT connector_id FROM mt5_bridge_links WHERE session_id = $1`,
    [sessionId],
  );
  const { rows } = await pool.query(
    `UPDATE mt5_bridge_links SET connector_id = $2, connector_seen_ms = $3
     WHERE session_id = $1 AND (connector_id IS NULL OR connector_id = $2 OR connector_seen_ms < $4)
     RETURNING connector_id`,
    [sessionId, instanceId, now, now - 150_000],
  );
  return {
    ok: rows.length > 0,
    changed: Boolean(
      previous[0]?.connector_id && previous[0].connector_id !== instanceId,
    ),
  };
}
