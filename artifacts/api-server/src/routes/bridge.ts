/**
 * MetaTrader 5 bridge API.
 *
 * The EA is the only market-data and execution client for the multi-asset
 * Desk. A pairing code creates a bearer token scoped to one browser session;
 * MT5 passwords never traverse this service. The bridge accepts the broker's
 * full catalogue at pairing, then only accepts real quotes/candles/account
 * snapshots from the paired terminal — there is no replay fallback.
 *
 * ── THE LINK OUTLIVES BOTH ENDS ─────────────────────────────────────────────
 *
 * The pairing code lives in the EA's inputs, which the user cannot edit while
 * MT5 is running, and the bridge token lives in the EA's memory. Neither side
 * can therefore recover a connection by itself: if this service forgets them,
 * the terminal is stranded retrying `/pair` with a code that no longer exists
 * ("Unknown or expired pairing code." every five seconds, forever).
 *
 * So both are persisted (see lib/multiasset/bridge-links.ts) and are dropped
 * ONLY when the user unlinks the terminal from the Desk. Closing MT5,
 * restarting MT5, closing the browser or redeploying this service all resume
 * the same connection: a heartbeat whose token is not in memory is resolved
 * against the stored link and the Desk is rebuilt around it.
 */

import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { getBrowserSessionId } from "../lib/session";
import { recordOutcome } from "../lib/multiasset/risk";
import {
  barTimestampUsable,
  feedHealth,
  quoteTimestampUsable,
  updateClockSkew,
} from "../lib/multiasset/integrity";
import { broadcastSSE } from "../lib/sse";
import { maybeAutoSelect } from "../lib/multiasset/auto-select";
import {
  TERMINAL_DEGRADED_MS,
  terminalIsDegraded,
  terminalIsFresh,
  terminalSilenceMs,
  terminalStaleWindowMs,
} from "../lib/multiasset/live";
import { recordTick } from "../lib/multiasset/subminute";
import {
  createPairingCode,
  deleteBridgeLink,
  findLinkByToken,
  findLinkForSession,
  findPairingCode,
  markPairingRedeemed,
  MAX_LIVE_CODES_PER_SESSION,
  notePairingAttempt,
  rememberLink,
  revokePairingCodesForSession,
  saveBridgeLink,
  touchLinkLastSync,
  type BridgeLink,
} from "../lib/multiasset/bridge-links";
import {
  accountKeyFor,
  describeConflict,
  releaseClaimsForSession,
  touchClaim,
  tryClaimAccount,
} from "../lib/multiasset/claims";
import {
  acknowledgeResult,
  applyAccount,
  candleKey,
  clearTerminalData,
  drainOutbox,
  expirePlans,
  getDesk,
  journal,
  pruneDeselectedSymbols,
  reconcilePositions,
  rememberBridgeToken,
  requeueStaleCommands,
  revokeBridgeToken,
  sessionForToken,
  syncUnackedPlans,
  ticksFor,
  upsertCandles,
  issueBridgeToken,
  type DeskState,
} from "../lib/multiasset/store";
import { quoteSnapshot, deskSummary } from "../lib/multiasset/presenter";
import {
  ASSET_CLASSES,
  TIMEFRAMES,
  type AccountSnapshot,
  type AssetClass,
  type Bar,
  type CommandResult,
  type HighImpactNewsEvent,
  type MarketCatalogEntry,
  type NewsFeed,
  type Position,
  type Quote,
  type SymbolSpec,
  type SyncClock,
  type SyncResponse,
  type Timeframe,
} from "../lib/multiasset/types";

const router: IRouter = Router();

/**
 * In-process cache of the codes this Desk has issued.
 *
 * The database (`mt5_pairing_codes`) is the source of truth — see
 * bridge-links.ts — because the code has to survive a restart of this service,
 * which is precisely when the EA needs it again. The cache only keeps the hot
 * path off the database. Codes are NOT pruned by age any more: a code that
 * expired while the user's terminal was running could not be replaced without
 * editing the EA's inputs inside a live MT5, so it is revoked only when the
 * user unlinks the terminal (or when the per-Desk retention cap is reached).
 */
const pendingPairings = new Map<string, PendingPairing>();

interface PendingPairing {
  code: string;
  sessionId: string;
  createdAt: number;
}

/** Drop this Desk's cached codes beyond the retention cap (oldest first). */
function pruneCachedPairings(sessionId: string): void {
  const live = [...pendingPairings.values()]
    .filter((pairing) => pairing.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const surplus = live.slice(0, Math.max(0, live.length - MAX_LIVE_CODES_PER_SESSION));
  for (const pairing of surplus) pendingPairings.delete(pairing.code);
}

/** Unambiguous alphabet: no O/0 or I/1 when a user types the code by hand. */
function makePairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += "-";
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

/**
 * Issue a pairing code.
 *
 * Previously issued codes are deliberately left valid. The value is baked into
 * a running EA's inputs, so revoking it the moment the user reopens this dialog
 * is how a bridge got killed by an action that was supposed to be harmless.
 * The retention cap in bridge-links.ts keeps the row count bounded instead.
 */
router.post("/pairing-code", async (_req, res) => {
  const sessionId = getBrowserSessionId();

  const code = makePairingCode();
  pendingPairings.set(code, { code, sessionId, createdAt: Date.now() });
  pruneCachedPairings(sessionId);
  await createPairingCode(code, sessionId);

  journal(
    getDesk(sessionId),
    "bridge",
    null,
    `Pairing code ${code} issued. It stays valid until this Desk unlinks the terminal, so the EA can be restarted without a new code.`,
  );

  // `expiresInMs: null` is the contract: this code has no expiry.
  return res.json({ pairingCode: code, expiresInMs: null, revokedBy: "unlink" });
});


/**
 * Exchange a screen code for a terminal-scoped bearer token.
 *
 * A broker account may only be held by one Desk at a time. Two Desks on one
 * account would both stream it, both arm plans against it and either could
 * flatten positions the other believed it owned — one balance counted against
 * two independent sets of risk limits. The claim is taken here, atomically,
 * before any token exists.
 *
 * The code is NOT consumed by this call. It stays valid until the Desk unlinks
 * the terminal, so an EA that restarts — or a service that redeploys — pairs
 * again with the value already sitting in its inputs.
 */
router.post("/pair", async (req, res) => {
  const code = String(req.body?.pairingCode ?? "").trim().toUpperCase();
  const terminal = req.body?.terminal ?? {};

  const cached = pendingPairings.get(code);
  // The cache only covers codes this process issued. After a restart (or on a
  // second instance) the code lives only in the database, and that lookup is
  // what stops a healthy terminal being told its code never existed.
  const pairing = cached
    ? { code: cached.code, sessionId: cached.sessionId, createdAt: cached.createdAt, revokedAt: null }
    : await findPairingCode(code);

  if (!pairing) {
    const error =
      "This pairing code is not recognised. Open the Desk → Link MT5 dialog and copy the current code into the EA's PairingCode input.";
    logger.warn({ code: code.slice(0, 4) + "…" }, "MT5 pairing refused: unknown code");
    return res.status(401).json({ error, code: "pairing_code_unknown" });
  }
  if (pairing.revokedAt) {
    const error =
      "This pairing code was revoked when the terminal was unlinked from the Desk. Open the Desk → Link MT5 dialog for a new code.";
    logger.warn({ sessionId: pairing.sessionId }, "MT5 pairing refused: code revoked");
    return res.status(401).json({ error, code: "pairing_code_revoked" });
  }

  const login = Number(terminal.login ?? 0);
  const server = String(terminal.server ?? "unknown");
  if (!Number.isFinite(login) || login <= 0) {
    // The code survives a malformed payload: it is still the user's only way
    // in, and burning it here would turn a fixable bug into a re-pair ritual.
    void notePairingAttempt(code, Date.now(), "terminal.login missing");
    return res.status(400).json({ error: "terminal.login is required." });
  }

  const desk = getDesk(pairing.sessionId);

  // ── Global uniqueness check ──────────────────────────────────────────────
  const claim = await tryClaimAccount({
    login,
    server,
    company: String(terminal.company ?? ""),
    sessionId: pairing.sessionId,
  });
  if (!claim.ok) {
    // The code deliberately survives a refusal. The EA retries every few
    // seconds with the same value, so keeping it alive means the user sees one
    // clear explanation instead of "unknown or expired code", and the terminal
    // connects by itself the moment the other Desk lets go.
    const message = describeConflict(claim.holder.login || login, claim.holder.server || server);
    desk.lastPairingError = { message, login, server, at: Date.now() };
    void notePairingAttempt(code, Date.now(), "account already connected");
    journal(desk, "bridge", null, `Pairing refused — ${message}`);
    logger.warn({ login, server, heldBySession: claim.holder.sessionId }, "MT5 pairing refused: account already claimed");
    return res.status(409).json({ error: message, code: "account_already_connected" });
  }

  // Redeemed — recorded, not destroyed. The same EA must be able to pair again
  // after an MT5 restart or a service redeploy without a new code.
  void markPairingRedeemed(code);

  const reattaching = Boolean(desk.terminal);
  const previousAccount = desk.terminal?.accountId ?? null;
  if (desk.terminal) revokeBridgeToken(desk.terminal.bridgeToken);
  clearTerminalData(desk);
  desk.lastPairingError = null;

  const bridgeToken = issueBridgeToken(pairing.sessionId);
  const pairedAt = Date.now();
  desk.terminal = {
    accountId: `mt5:${login}@${server}`,
    login,
    server,
    company: String(terminal.company ?? ""),
    bridgeToken,
    pairedAt,
    lastSyncAt: pairedAt,
    lastSeq: 0,
    // Filled in from the first heartbeat that reports it. Until then the desk
    // uses its fixed staleness window.
    syncIntervalMs: 0,
  };

  // Persisted so a heartbeat can rebuild this Desk after a restart of this
  // service — the terminal keeps trading and streaming without the user
  // touching MT5 or the browser.
  await saveBridgeLink({
    sessionId: pairing.sessionId,
    bridgeToken,
    login,
    server,
    company: String(terminal.company ?? ""),
    pairedAt,
    lastSyncAt: pairedAt,
    syncIntervalMs: 0,
  });

  const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog : [];
  let catalogCount = 0;
  for (const raw of catalog) {
    const entry = parseCatalogEntry(raw);
    if (!entry) continue;
    desk.catalog.set(entry.symbol, entry);
    catalogCount++;
  }

  journal(
    desk,
    "bridge",
    null,
    `${reattaching && previousAccount === desk.terminal.accountId ? "MetaTrader 5 terminal re-attached" : "MetaTrader 5 terminal paired"}: ` +
      `${login}@${server}. ${catalogCount} broker markets discovered. This account is now reserved for this Desk, ` +
      `and the link survives MT5 and service restarts until it is unlinked here.`,
  );
  logger.info({ login, server, catalogCount, reattaching }, "MT5 bridge paired");

  return res.status(201).json({
    bridgeToken,
    accountId: desk.terminal.accountId,
    syncIntervalMs: 1000,
    // Tells the EA (and the setup dialog) that nothing about this link expires
    // on a timer: it is dropped only by an explicit unlink from the Desk.
    linkPersistence: "until-unlinked",
    subscriptions: { symbols: desk.watchlist, timeframes: TIMEFRAMES },
  });
});

/**
 * Unlink the terminal — the ONLY thing that ends a bridge.
 *
 * Revokes the bearer token, revokes every pairing code this Desk has issued
 * (so the EA still holding one cannot silently re-attach), releases the global
 * account claim and removes every terminal-derived value.
 *
 * Releasing the claim is what lets the same account be connected somewhere
 * else afterwards; without it the account would stay reserved for a Desk that
 * is no longer using it.
 */
router.post("/unpair", async (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  if (!desk.terminal) return res.status(404).json({ error: "No terminal is linked." });

  const bridgeToken = desk.terminal.bridgeToken;
  revokeBridgeToken(bridgeToken);
  await deleteBridgeLink(desk.sessionId, bridgeToken);
  const revokedCodes = await revokePairingCodesForSession(desk.sessionId);
  for (const [code, pairing] of pendingPairings) {
    if (pairing.sessionId === desk.sessionId) pendingPairings.delete(code);
  }
  await releaseClaimsForSession(desk.sessionId);
  const { login, server } = desk.terminal;
  desk.terminal = null;
  desk.lastPairingError = null;
  clearTerminalData(desk);
  journal(
    desk,
    "bridge",
    null,
    `MetaTrader 5 terminal unlinked: ${login}@${server} released, its pairing code${revokedCodes === 1 ? "" : "s"} revoked ` +
      `and live terminal data cleared. The EA will stop syncing until a new code is entered.`,
  );
  logger.info({ login, server, revokedCodes }, "MT5 bridge unlinked");
  return res.json({ ok: true, revokedCodes });
});

// ── Authentication ───────────────────────────────────────────────────────────

function bearerToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Rebuild a Desk's terminal record from the stored link.
 *
 * `lastSyncAt` is restored as stored, NOT set to "now": a terminal that went
 * away while this service was down must still read as stale until it actually
 * beats again. Re-asserting the account claim matters for the same reason —
 * after a restart the in-process claim registry is empty, so without this the
 * database row would age out and a second Desk could take the same account
 * while this one was still streaming it.
 *
 * Returns null when the account has since been claimed by another Desk.
 */
async function restoreLinkIntoDesk(desk: DeskState, link: BridgeLink): Promise<boolean> {
  const claim = await tryClaimAccount({
    login: link.login,
    server: link.server,
    company: link.company,
    sessionId: desk.sessionId,
  });
  if (!claim.ok) {
    await deleteBridgeLink(desk.sessionId, link.bridgeToken);
    const message = describeConflict(claim.holder.login || link.login, claim.holder.server || link.server);
    desk.lastPairingError = { message, login: link.login, server: link.server, at: Date.now() };
    journal(desk, "bridge", null, `Bridge link not restored — ${message}`);
    logger.warn({ login: link.login, server: link.server }, "MT5 bridge link dropped: account claimed by another Desk");
    return false;
  }

  desk.terminal = {
    accountId: `mt5:${link.login}@${link.server}`,
    login: link.login,
    server: link.server,
    company: link.company,
    bridgeToken: link.bridgeToken,
    pairedAt: link.pairedAt,
    lastSyncAt: link.lastSyncAt,
    lastSeq: 0,
    syncIntervalMs: link.syncIntervalMs,
  };
  rememberBridgeToken(desk.sessionId, link.bridgeToken);
  journal(
    desk,
    "bridge",
    null,
    `MetaTrader 5 link restored: ${link.login}@${link.server}. The terminal kept its pairing code and token, ` +
      `so no re-pairing was needed after the platform restarted.`,
  );
  logger.info({ login: link.login, server: link.server }, "MT5 bridge link restored from storage");
  return true;
}

/**
 * Resolve the Desk an EA heartbeat belongs to.
 *
 * A token that this process has never issued is looked up in the stored links:
 * that is the ordinary case after a redeploy or on a second instance, and
 * answering 401 to it is exactly what used to leave the user's terminal stuck
 * re-pairing with a code the service no longer knew.
 */
async function deskForRequest(req: Request): Promise<DeskState | null> {
  const token = bearerToken(req);
  if (!token) return null;

  const sessionId = sessionForToken(token) ?? (await findLinkByToken(token))?.sessionId ?? null;
  if (!sessionId) return null;

  const desk = getDesk(sessionId);
  if (desk.terminal?.bridgeToken === token) return desk;

  // This Desk is already paired under a DIFFERENT token, so the one presented
  // has been superseded — a re-pair from the same terminal, or a second EA
  // still holding an old credential. It must be refused, never restored over
  // the top of the live link, or the newest terminal would silently lose its
  // Desk to whatever beat last.
  if (desk.terminal) return null;

  const link = await findLinkByToken(token);
  if (!link || link.bridgeToken !== token) return null;
  return (await restoreLinkIntoDesk(desk, link)) ? desk : null;
}

// ── Parse + validate terminal payloads ───────────────────────────────────────

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assetClass(value: unknown): AssetClass {
  return typeof value === "string" && (ASSET_CLASSES as readonly string[]).includes(value)
    ? value as AssetClass
    : "other";
}

export function parseCatalogEntry(raw: unknown): MarketCatalogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  if (!symbol || symbol.length > 128) return null;
  return {
    symbol,
    description: String(r.description ?? symbol).slice(0, 512),
    path: String(r.path ?? "").slice(0, 512),
    assetClass: assetClass(r.assetClass),
    tradeable: r.tradeable !== false,
  };
}

export function parseSpec(raw: unknown): SymbolSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "").trim();
  const point = num(r.point);
  if (!symbol || !(point > 0)) return null;

  const tickSize = num(r.tickSize, point);
  return {
    symbol,
    assetClass: assetClass(r.assetClass),
    point,
    digits: Math.round(num(r.digits, 5)),
    tickSize: tickSize > 0 ? tickSize : point,
    tickValue: num(r.tickValue),
    contractSize: num(r.contractSize, 1),
    volumeMin: num(r.volumeMin, 0.01),
    volumeMax: num(r.volumeMax, 100),
    volumeStep: num(r.volumeStep, 0.01),
    stopsLevel: num(r.stopsLevel),
    freezeLevel: num(r.freezeLevel),
    marginInitial: num(r.marginInitial),
    swapLong: num(r.swapLong),
    swapShort: num(r.swapShort),
    commissionPerLot: num(r.commissionPerLot),
    spreadPoints: num(r.spreadPoints),
    baseCurrency: typeof r.baseCurrency === "string" ? r.baseCurrency : undefined,
    quoteCurrency: typeof r.quoteCurrency === "string" ? r.quoteCurrency : undefined,
  };
}

export function parseAccount(raw: unknown): AccountSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const equity = num(r.equity, NaN);
  if (!Number.isFinite(equity)) return null;

  const margin = num(r.margin);
  return {
    balance: num(r.balance, equity),
    equity,
    margin,
    freeMargin: num(r.freeMargin, equity - margin),
    marginLevel: margin > 0 ? num(r.marginLevel, (equity / margin) * 100) : Number.POSITIVE_INFINITY,
    currency: String(r.currency ?? "USD"),
    leverage: num(r.leverage, 100),
    mode: r.mode === "netting" ? "netting" : "hedging",
    isLive: Boolean(r.isLive),
  };
}

function parsePosition(raw: unknown): Position | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ticket = Math.round(num(r.ticket, NaN));
  const symbol = String(r.symbol ?? "");
  if (!Number.isFinite(ticket) || !symbol) return null;
  return {
    ticket,
    symbol,
    side: r.side === "sell" ? "sell" : "buy",
    volume: num(r.volume),
    openPrice: num(r.openPrice),
    openTime: num(r.openTime, Date.now()),
    sl: r.sl === null || r.sl === undefined ? null : num(r.sl) || null,
    tp: r.tp === null || r.tp === undefined ? null : num(r.tp) || null,
    profit: num(r.profit),
    swap: num(r.swap),
    commission: num(r.commission),
    comment: typeof r.comment === "string" ? r.comment : undefined,
    initialRiskMoney: r.initialRiskMoney === undefined ? undefined : num(r.initialRiskMoney),
    initialRiskPoints: r.initialRiskPoints === undefined ? undefined : num(r.initialRiskPoints),
  };
}

function parseQuote(raw: unknown): Quote | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const symbol = String(r.symbol ?? "");
  const bid = num(r.bid);
  const ask = num(r.ask);
  if (!symbol || !(bid > 0) || !(ask > 0)) return null;
  return { symbol, bid, ask, spreadPoints: num(r.spreadPoints), ts: num(r.ts, Date.now()) };
}

function parseBars(raw: unknown, timestampUsable?: (time: number) => boolean): Bar[] {
  if (!Array.isArray(raw)) return [];
  const out: Bar[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue;
    const bar = entry.slice(0, 6).map((v) => num(v));
    while (bar.length < 6) bar.push(0);
    if (!(bar[0] > 0) || !(bar[4] > 0)) continue;
    // Drop bars whose timestamp cannot be real. A broker clock reset or a
    // timezone bug otherwise injects candles from the future or from years ago
    // into the middle of a series, which corrupts every indicator downstream.
    if (timestampUsable && !timestampUsable(bar[0])) continue;
    out.push(bar as Bar);
  }
  return out;
}

/** Parse the terminal's clock context. Tolerant: absent means "unknown". */
function parseClock(raw: unknown): SyncClock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const terminalUtcMs = num(r.terminalUtcMs, NaN);
  if (!Number.isFinite(terminalUtcMs) || terminalUtcMs <= 0) return null;
  const syncIntervalMs = Math.round(num(r.syncIntervalMs, 0));
  return {
    serverUtcOffsetSeconds: Math.round(num(r.serverUtcOffsetSeconds, 0)),
    terminalUtcMs,
    label: typeof r.label === "string" ? r.label.slice(0, 64) : undefined,
    // Only a plausible heartbeat interval is accepted: 250ms (the EA's floor)
    // to 10 minutes. Anything else is noise and is ignored in favour of the
    // fixed window.
    syncIntervalMs: syncIntervalMs >= 250 && syncIntervalMs <= 600_000 ? syncIntervalMs : undefined,
  };
}

function parseResult(raw: unknown): CommandResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const commandId = String(r.commandId ?? "");
  if (!commandId) return null;
  const status = String(r.status ?? "done");
  return {
    commandId,
    status: (["filled", "rejected", "expired", "skipped", "done"].includes(status)
      ? status
      : "done") as CommandResult["status"],
    ticket: r.ticket === undefined ? undefined : Math.round(num(r.ticket)),
    price: r.price === undefined ? undefined : num(r.price),
    slippagePoints: r.slippagePoints === undefined ? undefined : num(r.slippagePoints),
    error: typeof r.error === "string" ? r.error : null,
    ts: num(r.ts, Date.now()),
  };
}

function parseNewsEvent(raw: unknown): HighImpactNewsEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? "").trim();
  const time = num(r.time, NaN);
  const name = String(r.name ?? "").trim();
  if (!id || !Number.isFinite(time) || !name) return null;
  return {
    id,
    time,
    currency: String(r.currency ?? "").trim().toUpperCase().slice(0, 12),
    country: String(r.country ?? "").trim().slice(0, 128),
    name: name.slice(0, 256),
    importance: "high",
    actual: r.actual === null || r.actual === undefined ? null : num(r.actual),
    forecast: r.forecast === null || r.forecast === undefined ? null : num(r.forecast),
    previous: r.previous === null || r.previous === undefined ? null : num(r.previous),
  };
}

function parseNewsFeed(raw: unknown): NewsFeed | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const events = Array.isArray(r.events)
    ? r.events.map(parseNewsEvent).filter((event): event is HighImpactNewsEvent => event !== null)
    : [];
  const now = Date.now();
  // Keep a full day of history: the pane lists the day's releases so "0 in the
  // next 24 h" can be read against what already happened.
  const kept = events
    .filter((event) => event.time >= now - 24 * 60 * 60_000 && event.time <= now + 48 * 60 * 60_000)
    .sort((a, b) => a.time - b.time);
  const rawCount = Number.isFinite(num(r.rawCount, NaN)) ? Math.max(0, Math.round(num(r.rawCount))) : undefined;
  return {
    available: r.available === true,
    checkedAt: num(r.checkedAt, now),
    events: kept,
    detail: typeof r.detail === "string" ? r.detail.slice(0, 500) : undefined,
    // Passed through untouched: the desk needs to know whether the terminal
    // actually read calendar rows (rawCount) or returned nothing at all.
    rawCount,
    redCount: Number.isFinite(num(r.redCount, NaN)) ? Math.max(0, Math.round(num(r.redCount))) : kept.length,
  };
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/** POST /api/bridge/sync — the EA's authenticated state heartbeat. */
router.post("/sync", async (req, res) => {
  const desk = await deskForRequest(req);
  if (!desk || !desk.terminal) {
    // `code` lets the EA act on this instead of looping blindly: a revoked
    // token means "re-pair with your code now", not "retry the same token".
    return res
      .status(401)
      .json({ error: "Invalid or revoked bridge token.", code: "bridge_token_revoked" });
  }

  // ── Has this account been claimed by another Desk since the last beat? ───
  // The token is still cryptographically valid, so this is the only place the
  // superseded terminal can be stopped. Letting it continue would mean two
  // Desks streaming one account and each arming plans against it.
  const accountKey = accountKeyFor(desk.terminal.login, desk.terminal.server);
  if (!touchClaim(desk.sessionId, accountKey)) {
    const { login, server } = desk.terminal;
    revokeBridgeToken(desk.terminal.bridgeToken);
    // The stored link must go too, or the very next heartbeat would restore the
    // superseded terminal from the database and undo this handover.
    await deleteBridgeLink(desk.sessionId, desk.terminal.bridgeToken);
    desk.terminal = null;
    clearTerminalData(desk);
    journal(
      desk,
      "bridge",
      null,
      `MetaTrader 5 account ${login}@${server} was connected in another browser. This Desk has been unlinked so two desks never trade one balance.`,
    );
    logger.warn({ login, server }, "MT5 heartbeat rejected: account claimed by another session");
    return res
      .status(409)
      .json({ error: "This MT5 account is now connected in another browser.", code: "account_claimed_elsewhere" });
  }

  const body = req.body ?? {};
  const seq = Math.round(num(body.seq));
  const now = Date.now();

  if (seq > 0 && seq < desk.terminal.lastSeq) {
    desk.plans.clear();
    desk.inflight.clear();
    journal(desk, "bridge", null, "Terminal restarted — armed plans cleared and state resynchronised.");
  }
  desk.terminal.lastSeq = seq;
  desk.terminal.lastSyncAt = now;

  const account = parseAccount(body.account);
  if (account) applyAccount(desk, account);

  // The EA normally ships the whole catalogue once during pairing. Accepting a
  // later refresh handles broker symbol-list changes without a re-pair.
  if (Array.isArray(body.catalog)) {
    for (const raw of body.catalog) {
      const entry = parseCatalogEntry(raw);
      if (entry) desk.catalog.set(entry.symbol, entry);
    }
  }

  if (Array.isArray(body.specs)) {
    for (const raw of body.specs) {
      const spec = parseSpec(raw);
      if (!spec) continue;
      desk.specs.set(spec.symbol, spec);
      if (!desk.catalog.has(spec.symbol)) {
        desk.catalog.set(spec.symbol, {
          symbol: spec.symbol,
          description: spec.symbol,
          path: "",
          assetClass: spec.assetClass,
          tradeable: true,
        });
      }
    }
  }

  // ── Clock ────────────────────────────────────────────────────────────────
  // The EA now converts terminal timestamps to UTC before sending them, but a
  // terminal whose clock is wrong will still produce unusable timestamps.
  // Measuring the offset here is what lets the desk tell "this quote is 3
  // seconds old" from "this terminal thinks it is 1998".
  const clock = parseClock(body.clock);
  if (clock) {
    updateClockSkew(desk, clock.terminalUtcMs, now);
    // The terminal's own heartbeat contract. Recorded (not assumed) so the
    // desk's staleness window can be sized from it: an EA configured to beat
    // every 10 seconds must not be declared dead after 30. A missing value
    // leaves the fixed window in place.
    if (clock.syncIntervalMs) desk.terminal.syncIntervalMs = clock.syncIntervalMs;
  }

  // Persisted (throttled — the EA beats every 250 ms–10 s) so a restart of this
  // service can show the real heartbeat age instead of claiming a link is fresh
  // the moment it is rebuilt from storage.
  touchLinkLastSync(desk.sessionId, desk.terminal.bridgeToken, now, desk.terminal.syncIntervalMs);

  if (Array.isArray(body.quotes)) {
    let accepted = 0;
    let rejected = 0;
    for (const raw of body.quotes) {
      const quote = parseQuote(raw);
      if (!quote) {
        rejected++;
        continue;
      }
      // A quote timestamped hours away from now cannot be a real tick. Keeping
      // it would pin the symbol's freshness check permanently open or shut.
      if (!quoteTimestampUsable(desk, quote, now)) {
        rejected++;
        continue;
      }
      desk.quotes.set(quote.symbol, quote);
      const spec = desk.specs.get(quote.symbol);
      if (spec) spec.spreadPoints = quote.spreadPoints;
      // Feed the tick into the sub-minute bar builder. MetaTrader has no
      // period faster than M1, so S10/S30 exist only because this runs on
      // every accepted tick (see subminute.ts).
      recordTick(ticksFor(desk, quote.symbol), quote);
      accepted++;
    }
    if (rejected > 0) {
      // Loud, but only once per heartbeat — a permanently misclocked terminal
      // is a support problem the user must be able to see.
      logger.warn({ accepted, rejected, skewMs: desk.clockSkewMs }, "MT5 heartbeat quotes rejected on timestamp sanity");
    }
    if (accepted > 0) {
      const ages = desk.watchlist
        .map((symbol) => feedHealth(desk, symbol, now).ageMs)
        .filter((age): age is number => typeof age === "number");
      desk.lastQuoteAgeMs = ages.length > 0 ? Math.round(Math.max(...ages)) : null;
    }
  }

  // Symbols the user has deselected must stop contributing quotes, specs and
  // candles immediately, or their last price lingers on screen as if live.
  pruneDeselectedSymbols(desk);

  if (Array.isArray(body.candles)) {
    for (const raw of body.candles) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const symbol = String(r.symbol ?? "");
      const timeframe = String(r.timeframe ?? "");
      if (!symbol || !(TIMEFRAMES as readonly string[]).includes(timeframe)) continue;
      const bars = parseBars(r.bars, (time) => barTimestampUsable(desk, time, now));
      if (bars.length > 0) upsertCandles(desk, { symbol, timeframe: timeframe as Timeframe, bars });
    }
  }

  const news = parseNewsFeed(body.news);
  if (news) desk.news = news;

  if (Array.isArray(body.positions)) {
    const positions = (body.positions as unknown[])
      .map(parsePosition)
      .filter((position): position is Position => position !== null);
    const { opened, closed } = reconcilePositions(desk, positions);

    for (const position of opened) {
      journal(desk, "execution", position.symbol, `Position #${position.ticket} opened: ${position.side} ${position.volume} @ ${position.openPrice}.`);
    }
    for (const position of closed) {
      const net = position.profit + position.swap + position.commission;
      desk.riskState = recordOutcome(desk.riskState, { symbol: position.symbol, profit: net, closedAt: now }, desk.policy);
      journal(desk, "execution", position.symbol, `Position #${position.ticket} closed: ${net >= 0 ? "+" : ""}${net.toFixed(2)}.`, {
        consecutiveLosses: desk.riskState.consecutiveLosses,
      });
      if (desk.riskState.haltedUntilNextSession) {
        journal(desk, "risk", null, desk.riskState.haltReason ?? "Desk halted.");
      }
    }
  }

  if (Array.isArray(body.results)) {
    for (const raw of body.results) {
      const result = parseResult(raw);
      if (!result || !acknowledgeResult(desk, result)) continue;
      if (result.status === "rejected") {
        journal(desk, "execution", null, `Command rejected by the terminal: ${result.error ?? "unknown error"}.`, result);
      } else if (result.status === "filled") {
        journal(desk, "execution", null, `Filled at ${result.price} (slippage ${result.slippagePoints ?? 0} pts), ticket #${result.ticket}.`, result);
      }
    }
  }

  const expired = expirePlans(desk, now);
  if (expired.length > 0) journal(desk, "signal", null, `${expired.length} armed plan(s) expired untriggered.`);
  requeueStaleCommands(desk);

  // ── Deliver what the terminal never confirmed ────────────────────────────
  // An armed plan is only real once the EA has said so. This closes the hole
  // where the arm command was lost with a rejected token or a dropped response:
  // the desk would keep showing the plan as armed, the terminal would never
  // hold it, and nothing would ever execute.
  const resent = syncUnackedPlans(desk, now);
  if (resent > 0) {
    logger.warn({ resent, plans: desk.plans.size }, "Re-sent unacknowledged arm_plan commands to the MT5 terminal");
    journal(
      desk,
      "bridge",
      null,
      `${resent} armed plan(s) had not been acknowledged by the terminal, so the arm command was re-sent.`,
    );
  }

  // Ask only for history for selected symbols that the terminal has actually
  // reported. A large catalogue does not trigger megabytes of unused history.
  const reported = new Set(desk.specs.keys());
  const needsHistory = desk.watchlist
    .filter((symbol) => reported.has(symbol))
    .some((symbol) => TIMEFRAMES.some((timeframe) => {
      const series = desk.candles.get(candleKey(symbol, timeframe));
      return !series || series.bars.length < 60;
    }));

  // ── Automatic best-market pass ───────────────────────────────────────────
  // Runs here — after quotes, candles and positions have been folded in and
  // before the browser is updated — so the desk arms the best of the user's
  // selected markets on the same tick the decision was based on. Throttled per
  // mode; every gate the manual path uses still applies.
  try {
    maybeAutoSelect(desk, now);
  } catch (err) {
    logger.warn({ err }, "Auto-select pass failed");
  }

  // ── Push the new prices to the browser immediately ───────────────────────
  // The Desk used to be polled every 4 s, so a quote could be four seconds
  // old before it was even rendered and up to a full rotation old on symbols
  // the EA had not reached yet. The moment the terminal's heartbeat lands, the
  // browser gets it.
  try {
    broadcastSSE("desk", deskSummary(desk, now), desk.sessionId);
  } catch (err) {
    logger.debug({ err }, "Desk stream broadcast failed");
  }

  const response: SyncResponse = {
    serverTime: now,
    commands: drainOutbox(desk),
    needsHistory,
    subscriptions: { symbols: desk.watchlist, timeframes: [...TIMEFRAMES] },
    news: desk.news,
    limits: {
      maxDailyLossPct: desk.policy.maxDailyLossPct,
      maxOpenPositions: desk.policy.maxOpenPositions,
      // Auto-trade ON authorises the desk to create plans by itself. A plan the
      // USER armed must be executable regardless of the auto toggle — the EA
      // refuses every arm_plan when this flag is false, so gating it on
      // autoTrade alone silently discarded hand-armed setups ("trading disabled
      // by server" in the MT5 log, nothing on screen). Risk state still wins.
      tradingEnabled: (desk.autoTrade || desk.plans.size > 0) && !desk.riskState.haltedUntilNextSession,
      liveTradingEnabled: desk.policy.liveTradingEnabled,
      // The desk's REAL window (sized from the terminal's own heartbeat
      // cadence), not a hardcoded cliff that contradicted /bridge/status.
      staleAfterMs: terminalStaleWindowMs(desk),
      flatOnDisconnect: false,
    },
  };
  return res.json(response);
});

/** Browser-facing liveness / diagnostic view. */
router.get("/status", async (_req, res) => {
  const desk = getDesk(getBrowserSessionId());
  // A restart of this service empties the in-memory desks. Without restoring
  // the stored link here the dialog would report "not linked" — and offer a new
  // pairing code — while the user's terminal was still paired and heartbeating.
  if (!desk.terminal) {
    const link = await findLinkForSession(desk.sessionId);
    if (link) await restoreLinkIntoDesk(desk, link);
  }
  // Surfaced even while unlinked: the EA performs the pairing, so without this
  // the dialog would sit on "waiting for the terminal" forever while the MT5
  // log quietly explains that the account is already connected elsewhere.
  const lastPairingError = desk.lastPairingError?.message ?? null;
  if (!desk.terminal) {
    return res.json({ linked: false, catalogCount: 0, selectedCount: 0, lastPairingError });
  }

  /**
   * Staleness is judged by the SAME rules the desk trades by — the two-stage
   * window in live.ts, sized from the heartbeat the terminal reports. This
   * endpoint had its own hardcoded 30-second cliff, so the dialog could tell
   * the user the link was dead while the desk was still analysing normally.
   */
  const now = Date.now();
  return res.json({
    linked: true,
    accountId: desk.terminal.accountId,
    login: desk.terminal.login,
    server: desk.terminal.server,
    company: desk.terminal.company,
    pairedAt: desk.terminal.pairedAt,
    lastSyncAt: desk.terminal.lastSyncAt,
    lastSyncAgeMs: terminalSilenceMs(desk, now),
    stale: !terminalIsFresh(desk, now),
    degraded: terminalIsDegraded(desk, now),
    degradedAfterMs: TERMINAL_DEGRADED_MS,
    staleAfterMs: terminalStaleWindowMs(desk),
    syncIntervalMs: desk.terminal.syncIntervalMs || null,
    queuedCommands: desk.outbox.length,
    inflightCommands: desk.inflight.size,
    catalogCount: desk.catalog.size,
    selectedCount: desk.watchlist.length,
    calendarAvailable: desk.news.available,
    calendarAgeMs: desk.news.checkedAt ? Date.now() - desk.news.checkedAt : null,
    clockSkewMs: desk.clockSkewMs,
    lastQuoteAgeMs: desk.lastQuoteAgeMs,
    lastPairingError,
    /** The link ends only when the user unlinks it — never on a timer. */
    linkPersistence: "until-unlinked",
  });
});

export default router;
export { makePairingCode, pendingPairings };
export const __testing = { randomCommandId: randomUUID };
