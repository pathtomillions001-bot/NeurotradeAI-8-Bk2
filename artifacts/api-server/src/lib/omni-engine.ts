/** Omni Sentinel — one account, one executor, one LIVE recovery ledger. */
import { randomUUID } from "node:crypto";
import { and, asc, eq, like } from "drizzle-orm";
import {
  db,
  accountsTable,
  settingsTable,
  tradesTable,
  type Settings,
} from "@workspace/db";
import {
  AUTOMATED_DERIV_MARKETS,
  tickManager,
  tickSecondsFor,
  extractLastDigit,
  getAccountConnection,
  waitForContractResult,
  type ContractResult,
} from "./deriv";
import type { DigitSnapshot, DigitTick } from "./digit-tape";
import { sameDigitTick } from "./digit-tape";
import {
  createSessionScoped,
  getBrowserSessionId,
  runWithSession,
} from "./session";
import {
  acquireTradingOwnership,
  hasTradingOwnership,
  releaseTradingOwnership,
} from "./engine-arbiter";
import { registerBotEngine, runningOtherEngines } from "./engine-registry";
import { registerLiveBot, unregisterLiveBot } from "./live-registry";
import { broadcastSSE } from "./sse";
import { logger } from "./logger";
import { friendlyErrorMessage } from "./friendly-error";
import * as recovery from "./agents/recovery-engine";
import {
  omniConfigKey,
  omniConfigSchema,
  type OmniConfig,
} from "./omni-config";
import {
  OMNI_HISTORY,
  OMNI_MIN_HISTORY,
  OMNI_PAPER_BALANCE,
  OmniModel,
  measureOmniHistory,
  priceOmniOpportunity,
  rankOmniOpportunities,
  omniRecoveryRestrictionNote,
  omniWins,
  type OmniOpportunity,
  type OmniPhase,
  type OmniReplay,
  type OmniRisk,
  type OmniSample,
} from "./omni-analysis";
import {
  matchOmniPurchase,
  omniTickIsExecutable,
  placeOmniOrder,
} from "./omni-execution";

export const OMNI_BOT_ID = "omni";
export const OMNI_BOT_NAME = "Omni Sentinel";
const SCAN_TTL_MS = 5 * 60_000;
const JOURNAL_PREFIX = "[Omni Sentinel] ";
class RecheckEntry extends Error {}
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
type Market = (typeof AUTOMATED_DERIV_MARKETS)[number];

interface ModelEntry {
  model: OmniModel;
  tick: DigitTick;
  metrics: OmniReplay;
}
export interface OmniMarketCard {
  symbol: string;
  displayName: string;
  source: "live" | "simulated";
  samples: number;
  normal: OmniOpportunity | null;
  recovery: OmniOpportunity | null;
  replay: OmniReplay;
}
export interface OmniScan {
  scanId: string;
  expiresAt: number;
  config: OmniConfig;
  markets: OmniMarketCard[];
  marketsScanned: number;
  reason: string;
  currency: string;
}
export interface OmniWatch {
  phase: "watching" | "pricing" | "settling" | "reconciling" | "stopping";
  mode: "normal" | "recovery";
  reason: string;
  candidates: OmniOpportunity[];
  marketsConsidered: number;
  ticksEvaluated: number;
  source: "live" | "simulated" | "waiting";
  utilityFloor: number;
}
interface JournalMeta {
  engine: "omni";
  executionMode: "paper" | "live";
  accountId: string | null;
  runId: string;
  opportunity: OmniOpportunity;
  entryTick: DigitTick;
  sentAt: number;
  accounted: boolean;
  cancelled: boolean;
}
interface PendingOrder {
  rowId: number;
  meta: JournalMeta;
  contractId: number | null;
  result?: ContractResult;
  cancelReason?: string;
}
interface Context {
  account: typeof accountsTable.$inferSelect | null;
  token: string | null;
  accountId: string | null;
  currency: string;
  settings: Settings | null;
  balance: number;
}
interface Session {
  running: boolean;
  starting: boolean;
  stopRequested: boolean;
  owner: string | null;
  runId: string | null;
  config: OmniConfig | null;
  symbol: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message: string;
  paperLedger: recovery.RecoveryState;
  models: Map<string, ModelEntry>;
  prices: Map<string, { multiplier: number; at: number }>;
  unavailable: Map<string, number>;
  pending: PendingOrder[];
  countedRows: Set<number>;
  scan: OmniScan | null;
  scanning: boolean;
  watch: OmniWatch;
}
function freshSession(): Session {
  return {
    running: false,
    starting: false,
    stopRequested: false,
    owner: null,
    runId: null,
    config: null,
    symbol: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    message: "Choose contracts, scan, then deploy",
    paperLedger: recovery.createRecoveryState(),
    models: new Map(),
    prices: new Map(),
    unavailable: new Map(),
    pending: [],
    countedRows: new Set(),
    scan: null,
    scanning: false,
    watch: {
      phase: "watching",
      mode: "normal",
      reason: "",
      candidates: [],
      marketsConsidered: 0,
      ticksEvaluated: 0,
      source: "waiting",
      utilityFloor: 0,
    },
  };
}
const scoped = createSessionScoped(freshSession);
const session = scoped.state;
const ledger = () =>
  session.config?.executionMode === "live"
    ? recovery.getState()
    : session.paperLedger;
const priceKey = (c: OmniOpportunity) => `${c.symbol}:${c.contract.id}`;

export function getOwnerSessionId() {
  return session.owner;
}
export function isRunning() {
  return session.running || session.starting;
}
export function getStatus() {
  const debt = ledger();
  return {
    running: isRunning(),
    botId: session.config ? OMNI_BOT_ID : null,
    botName: session.config ? OMNI_BOT_NAME : null,
    sessionId: session.runId,
    totalProfit: session.totalProfit,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: debt.inRecovery,
    recoveryStep: debt.recoveryStep,
    unrecoveredAmount: debt.unrecoveredAmount,
    recoveryTargetProfit: debt.targetProfit,
    recoveryRemainingTargetProfit: debt.remainingTargetProfit,
    consecutiveRecoveryLosses: debt.streakLossCount,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    omni: session.config
      ? {
          config: session.config,
          lockedSymbol:
            session.config.marketMode === "locked" ? session.symbol : null,
          stopping: session.stopRequested,
          pendingOrder: session.pending.length > 0,
          watch: session.watch,
        }
      : undefined,
  };
}
registerBotEngine(OMNI_BOT_ID, () => ({
  running: isRunning(),
  name: OMNI_BOT_NAME,
}));
function broadcast() {
  if (session.owner) broadcastSSE("bot_update", getStatus(), session.owner);
}
function say(reason: string, phase: OmniWatch["phase"] = "watching") {
  session.message = reason;
  session.watch.reason = reason;
  session.watch.phase = phase;
  broadcast();
}

async function loadContext(config: OmniConfig): Promise<Context> {
  const owner = getBrowserSessionId();
  const [settings] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, owner))
    .limit(1);
  if (config.executionMode === "paper")
    return {
      account: null,
      token: null,
      accountId: null,
      currency: "USD",
      settings: settings ?? null,
      balance: OMNI_PAPER_BALANCE + session.totalProfit,
    };
  const [account] = await db
    .select()
    .from(accountsTable)
    .where(
      and(eq(accountsTable.sessionId, owner), eq(accountsTable.isActive, true)),
    )
    .limit(1);
  const token = account?.bearerToken ?? account?.token;
  if (!account || !token)
    throw new Error(
      "Connect an active Deriv account before deploying in live mode",
    );
  if (settings?.paperTradeMode)
    throw new Error(
      "Account paper-trade mode is enabled; disable it in Settings before trading on the connected account",
    );
  const balance = Number(account.balance);
  if (!Number.isFinite(balance) || balance < 0)
    throw new Error("A valid account balance is required");
  return {
    account,
    token,
    accountId: account.derivAccountId ?? account.loginId,
    currency: account.currency,
    settings: settings ?? null,
    balance,
  };
}
/** Balance comes from the socket pinned to THIS account, never a REST fallback account. */
async function refreshBalance(context: Context): Promise<number> {
  if (!context.token || !context.accountId) return context.balance;
  const response = await getAccountConnection(
    context.token,
    context.accountId,
  ).request({ balance: 1 }, 4000);
  const balance = response?.balance?.balance;
  if (
    response?.error ||
    balance == null ||
    !Number.isFinite(Number(balance)) ||
    Number(balance) < 0
  ) {
    throw new Error("Could not verify this account's live balance");
  }
  context.balance = Number(balance);
  if (context.account)
    await db
      .update(accountsTable)
      .set({ balance: String(balance), updatedAt: new Date() })
      .where(eq(accountsTable.id, context.account.id));
  return context.balance;
}

function riskFor(
  config: OmniConfig,
  context: Context,
  debt = ledger().unrecoveredAmount,
): OmniRisk {
  return {
    baseStake: config.stake,
    debt,
    markupPercent: Number(context.settings?.botRecoveryMarkup ?? 10),
    maxStake: Number(context.settings?.maxTradeStake ?? 500),
    balance: context.balance,
    lossBudget: config.stopLoss + session.totalProfit,
  };
}

/** Merge by broker epoch AND price; never splice simulated history into live data. */
export function mergeOmniHistory(
  prices: unknown[],
  times: unknown[],
  snapshot: DigitSnapshot,
  pipSize: number,
): OmniSample[] {
  if (snapshot.tick.source !== "live" || prices.length !== times.length)
    throw new Error("Incompatible broker history");
  const byTime = new Map<number, OmniSample>();
  let previous = -Infinity;
  for (let i = 0; i < prices.length; i++) {
    const epoch = Number(times[i]);
    const price = Number(prices[i]);
    if (
      !Number.isFinite(epoch) ||
      epoch <= previous ||
      !Number.isFinite(price) ||
      price <= 0
    )
      throw new Error("Malformed broker history");
    previous = epoch;
    if (epoch <= snapshot.tick.epoch)
      byTime.set(epoch, { price, digit: extractLastDigit(price, pipSize) });
  }
  for (const t of snapshot.ticks) {
    if (t.source !== "live" || t.generation !== snapshot.tick.generation)
      throw new Error("Mixed tick provenance");
    const historical = byTime.get(t.epoch);
    if (
      historical &&
      (historical.digit !== t.digit || historical.price !== t.price)
    )
      throw new Error("Broker history disagrees with live tape");
    byTime.set(t.epoch, { price: t.price, digit: t.digit });
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-OMNI_HISTORY)
    .map(([, v]) => v);
}

async function measureMarket(
  market: Market,
  config: OmniConfig,
  risk: OmniRisk,
  deep: boolean,
): Promise<ModelEntry | null> {
  let snapshot = tickManager.getDigitSnapshot(market.symbol, OMNI_HISTORY);
  if (!snapshot) return null;
  let samples: OmniSample[] = snapshot.ticks;
  if (
    deep &&
    snapshot.tick.source === "live" &&
    snapshot.ticks.length < OMNI_HISTORY &&
    tickManager.getConnectionStatus()
  ) {
    try {
      const response = await tickManager.request(
        {
          ticks_history: market.symbol,
          count: OMNI_HISTORY,
          end: "latest",
          style: "ticks",
        },
        2000,
      );
      const current = tickManager.getDigitSnapshot(market.symbol, OMNI_HISTORY);
      if (
        current &&
        current.tick.generation === snapshot.tick.generation &&
        current.tick.source === "live" &&
        Array.isArray(response?.history?.prices) &&
        Array.isArray(response?.history?.times)
      ) {
        samples = mergeOmniHistory(
          response.history.prices,
          response.history.times,
          current,
          market.pipSize,
        );
        snapshot = current;
      }
    } catch {
      /* Local, provenance-safe tape is the only fallback. */
    }
  }
  if (samples.length < OMNI_MIN_HISTORY) return null;
  const { model, metrics } = measureOmniHistory(
    samples,
    config.enabledContracts,
    { ...risk, debt: 0 },
    AUTOMATED_DERIV_MARKETS.length,
  );
  return { model, metrics, tick: snapshot.tick };
}

function updateModel(market: Market, config: OmniConfig): ModelEntry | null {
  const snapshot = tickManager.getDigitSnapshot(market.symbol, OMNI_HISTORY);
  if (!snapshot) return null;
  let cached = session.models.get(market.symbol);
  const newTicks = cached
    ? snapshot.ticks.filter((t) => t.sequence > cached!.tick.sequence)
    : [];
  if (
    !cached ||
    cached.tick.generation !== snapshot.tick.generation ||
    cached.tick.source !== snapshot.tick.source ||
    (newTicks.length > 0 && newTicks[0]!.sequence !== cached.tick.sequence + 1)
  ) {
    if (snapshot.ticks.length < OMNI_MIN_HISTORY) {
      session.models.delete(market.symbol);
      return null;
    }
    const model = new OmniModel(
      config.enabledContracts,
      AUTOMATED_DERIV_MARKETS.length,
    );
    for (const tick of snapshot.ticks) model.update(tick);
    cached = {
      model,
      tick: snapshot.tick,
      metrics: {
        ticks: 0,
        normalShots: 0,
        normalWins: 0,
        recoveryShots: 0,
        recoveryWins: 0,
        recoveryLossPairs: 0,
        profit: 0,
        remainingDebt: 0,
        maxStake: 0,
        stoppedByRisk: false,
      },
    };
    session.models.set(market.symbol, cached);
  } else if (!sameDigitTick(cached.tick, snapshot.tick)) {
    for (const tick of newTicks) cached.model.update(tick);
    cached.tick = snapshot.tick;
    session.watch.ticksEvaluated += newTicks.length;
  }
  return cached;
}

export async function scanForOmni(configInput: OmniConfig): Promise<OmniScan> {
  const config = omniConfigSchema.parse(configInput);
  if (session.scanning || isRunning())
    throw new Error(
      "Stop the bot or let the current scan finish before scanning again",
    );
  session.scanning = true;
  session.scan = null;
  try {
    const context = await loadContext(config);
    const scanRisk = {
      ...riskFor(config, context, 0),
      lossBudget: config.stopLoss,
      balance:
        config.executionMode === "paper" ? OMNI_PAPER_BALANCE : context.balance,
    };
    const cards: OmniMarketCard[] = [];
    const models = new Map<string, ModelEntry>();
    for (const [index, market] of AUTOMATED_DERIV_MARKETS.entries()) {
      broadcastSSE(
        "bot_scan_progress",
        {
          botId: OMNI_BOT_ID,
          scanning: market.displayName,
          scanned: index,
          total: AUTOMATED_DERIV_MARKETS.length,
        },
        getBrowserSessionId(),
      );
      const measured = await measureMarket(market, config, scanRisk, true);
      if (measured) {
        models.set(market.symbol, measured);
        const predictions = measured.model.predict();
        const normal =
          rankOmniOpportunities(
            predictions.map((p) => priceOmniOpportunity(p, market, scanRisk)),
            config.enabledContracts,
            undefined,
            "normal",
          )[0] ?? null;
        // The recovery preview must show the SAME instrument set the live
        // recovery leg may use — otherwise the card advertises a barrier the
        // engine would never buy.
        const recoveryShot =
          rankOmniOpportunities(
            predictions.map((p) =>
              priceOmniOpportunity(p, market, {
                ...scanRisk,
                debt: config.stake,
              }),
            ),
            config.enabledContracts,
            undefined,
            "recovery",
          )[0] ?? null;
        cards.push({
          symbol: market.symbol,
          displayName: market.displayName,
          source: measured.tick.source,
          samples: measured.model.count,
          normal,
          recovery: recoveryShot,
          replay: measured.metrics,
        });
      }
      await sleep(0); // let SSE, cancellation and the live feed run between markets
    }
    cards.sort(
      (a, b) =>
        Number(b.normal?.ready) - Number(a.normal?.ready) ||
        (b.normal?.utility ?? -1) - (a.normal?.utility ?? -1),
    );
    const result: OmniScan = {
      scanId: randomUUID(),
      expiresAt: Date.now() + SCAN_TTL_MS,
      config,
      markets: cards,
      marketsScanned: AUTOMATED_DERIV_MARKETS.length,
      currency: context.currency,
      reason: cards.length
        ? `All enabled contracts ranked. Scan prices are indicative; live deployment reprices before every buy. Recovery cards illustrate one base-stake of debt and obey the recovery instrument rule: ${omniRecoveryRestrictionNote()}`
        : "Not enough uninterrupted tick history yet. Wait for the feed to warm up and scan again.",
    };
    session.scan = result;
    session.models = models;
    return result;
  } finally {
    session.scanning = false;
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: OMNI_BOT_ID,
        scanning: null,
        scanned: AUTOMATED_DERIV_MARKETS.length,
        total: AUTOMATED_DERIV_MARKETS.length,
      },
      getBrowserSessionId(),
    );
  }
}

function parseMeta(reason: string | null): JournalMeta | null {
  if (!reason?.startsWith(JOURNAL_PREFIX)) return null;
  try {
    const meta = JSON.parse(reason.slice(JOURNAL_PREFIX.length));
    return meta.engine === "omni" ? (meta as JournalMeta) : null;
  } catch {
    return null;
  }
}
const journalReason = (meta: JournalMeta) =>
  JOURNAL_PREFIX + JSON.stringify(meta);

export async function startSession(input: {
  config: OmniConfig;
  scanId: string;
  symbol: string;
}): Promise<{ ok: boolean; error?: string }> {
  const parsed = omniConfigSchema.safeParse(input.config);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid configuration",
    };
  const config = parsed.data;
  if (isRunning() || session.scanning)
    return {
      ok: false,
      error: "This bot is already starting, running or scanning",
    };
  const scan = session.scan;
  if (
    !scan ||
    scan.scanId !== input.scanId ||
    scan.expiresAt < Date.now() ||
    omniConfigKey(scan.config) !== omniConfigKey(config)
  ) {
    return {
      ok: false,
      error:
        "Run a fresh scan with these exact contracts and risk settings before deploying",
    };
  }
  if (
    !scan.markets.some((m) => m.symbol === input.symbol) ||
    !AUTOMATED_DERIV_MARKETS.some((m) => m.symbol === input.symbol)
  ) {
    return { ok: false, error: "Select a market measured by your scan" };
  }
  if (
    config.executionMode === "live" &&
    !scan.markets.some((m) => m.symbol === input.symbol && m.source === "live")
  ) {
    return {
      ok: false,
      error:
        "Simulated data cannot authorize live trading. Wait for a real market feed and scan again.",
    };
  }
  const other = runningOtherEngines(OMNI_BOT_ID)[0];
  if (other)
    return {
      ok: false,
      error: `${other.name} is already running; one engine may own this account's recovery ledger`,
    };
  const owner = getBrowserSessionId();
  if (!acquireTradingOwnership("bots", owner))
    return {
      ok: false,
      error: "Another trading engine owns this account; stop it first",
    };
  const models = session.models;
  scoped.replace({
    ...freshSession(),
    starting: true,
    owner,
    config,
    symbol: input.symbol,
    runId: randomUUID(),
    models,
  });
  try {
    let context = await loadContext(config);
    if (config.executionMode === "live") {
      await refreshBalance(context);
      await db
        .insert(settingsTable)
        .values({ sessionId: owner })
        .onConflictDoNothing({ target: settingsTable.sessionId });
      const [settings] = await db
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.sessionId, owner))
        .limit(1);
      if (settings?.recoveryStateJson)
        recovery.hydrateStateIfNeeded(settings.recoveryStateJson);
      context.settings = settings ?? null;
      // Recover our own durable intent after a restart. The exact broker result
      // (not a journal-derived loss guess) is applied to the shared ledger once.
      const rows = await db
        .select()
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.sessionId, owner),
            like(tradesTable.agentReasoning, `${JOURNAL_PREFIX}%`),
          ),
        )
        .orderBy(asc(tradesTable.id));
      for (const row of rows) {
        const meta = parseMeta(row.agentReasoning);
        if (
          !meta ||
          meta.executionMode !== "live" ||
          meta.accounted ||
          meta.cancelled
        )
          continue;
        if (meta.accountId !== context.accountId)
          throw new Error(
            "An unsettled Omni order belongs to a different Deriv sub-account. Reconnect that account to reconcile it first.",
          );
        session.pending.push({
          rowId: row.id,
          meta,
          contractId: row.derivContractId ? Number(row.derivContractId) : null,
        });
      }
    }
    if (
      !session.pending.length &&
      (context.balance < config.stake ||
        Number(context.settings?.maxTradeStake ?? 500) < config.stake)
    ) {
      throw new Error(
        "Base stake exceeds your balance or maximum stake setting",
      );
    }
    session.starting = false;
    session.running = true;
    registerLiveBot(OMNI_BOT_ID, getStatus);
    say(
      `${config.executionMode === "paper" ? "PAPER · " : ""}${config.marketMode === "locked" ? "Market locked" : "All automated markets enabled"}; ${omniRecoveryRestrictionNote()}`,
    );
    const runId = session.runId!;
    void runWithSession(owner, () => runLoop(config, context, runId));
    return { ok: true };
  } catch (error) {
    session.starting = false;
    session.running = false;
    releaseTradingOwnership("bots", owner);
    const message = friendlyErrorMessage(error);
    say(message);
    return { ok: false, error: message };
  }
}

/** Stop cancels queued buys immediately but NEVER releases an unresolved purchase. */
export function stopSession() {
  session.stopRequested = true;
  if (isRunning())
    say(
      session.pending.length
        ? "Stop requested — reconciling the outstanding order before releasing the account"
        : "Stopping; no new orders will be sent",
      "stopping",
    );
  return getStatus();
}

function candidatesFor(config: OmniConfig, context: Context) {
  const all: OmniOpportunity[] = [];
  const risk = riskFor(config, context);
  const markets =
    config.marketMode === "locked"
      ? AUTOMATED_DERIV_MARKETS.filter((m) => m.symbol === session.symbol)
      : AUTOMATED_DERIV_MARKETS;
  for (const market of markets) {
    const entry = updateModel(market, config);
    if (!entry) continue;
    const executable = omniTickIsExecutable(
      entry.tick,
      tickManager.getDigitSnapshot(market.symbol, 1)?.tick,
      Date.now(),
      tickSecondsFor(market.symbol) * 1000,
      config.executionMode === "live",
    );
    for (const prediction of entry.model.predict()) {
      const key = `${market.symbol}:${prediction.contract.id}`;
      const quote = session.prices.get(key);
      const fresh = quote && Date.now() - quote.at < 30_000;
      const candidate = priceOmniOpportunity(
        prediction,
        market,
        risk,
        fresh ? quote.multiplier : undefined,
        fresh ? "live" : "indicative",
      );
      if (!executable) {
        candidate.ready = false;
        candidate.reason = "Waiting for a fresh, correctly sourced entry tick";
      }
      if ((session.unavailable.get(key) ?? 0) > Date.now()) {
        candidate.ready = false;
        candidate.reason =
          "Quote temporarily unavailable; checking other opportunities";
      }
      all.push(candidate);
    }
  }
  session.watch.marketsConsidered = markets.length;
  return rankOmniOpportunities(
    all,
    config.enabledContracts,
    config.marketMode === "locked" ? session.symbol! : undefined,
    // Carrying debt = recovery leg: Over 0–2, Under 7–9 and Differs drop out of
    // the tournament entirely (see omniContractAllowedInPhase).
    phaseFor(risk),
  );
}

/** Which leg the CURRENT risk object represents: debt means recovery. */
function phaseFor(risk: OmniRisk): OmniPhase {
  return risk.debt > 0 ? "recovery" : "normal";
}

async function cancelPrepared(pending: PendingOrder, reason: string) {
  pending.cancelReason = reason;
  const meta = { ...pending.meta, cancelled: true };
  await db
    .update(tradesTable)
    .set({
      status: "cancelled",
      profit: "0",
      payout: "0",
      closedAt: new Date(),
      agentReasoning: journalReason(meta),
    })
    .where(eq(tradesTable.id, pending.rowId));
  session.pending = session.pending.filter((p) => p.rowId !== pending.rowId);
  say(reason);
}

/** Atomic trade + ledger commit; retrying a settlement cannot pay debt twice. */
async function accountForResult(pending: PendingOrder, result: ContractResult) {
  if (
    result.missing ||
    !Number.isFinite(result.profit) ||
    !Number.isFinite(result.sellPrice)
  )
    throw new Error("Broker settlement is not final");
  const meta = pending.meta;
  let next = ledger();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tradesTable)
      .where(eq(tradesTable.id, pending.rowId))
      .limit(1);
    if (!row)
      throw new Error("Order journal is missing; keeping the execution lock");
    const stored = parseMeta(row.agentReasoning);
    if (stored?.accounted) {
      if (meta.executionMode === "live") {
        const [settings] = await tx
          .select()
          .from(settingsTable)
          .where(eq(settingsTable.sessionId, session.owner!))
          .limit(1);
        if (settings?.recoveryStateJson)
          next = JSON.parse(
            settings.recoveryStateJson,
          ) as recovery.RecoveryState;
      } else if (!session.countedRows.has(pending.rowId)) {
        // The DB may have committed even if its acknowledgement was lost.
        // Reapply only the not-yet-observed PAPER transition in that case;
        // live recovery was part of the original transaction above.
        next = recovery.reduceRecoveryOutcome(
          ledger(),
          Number(row.profit) > 0,
          Number(row.profit),
          Number(row.stake),
          10,
          meta.opportunity.contract.contractType,
          meta.opportunity.payout,
        );
      }
      return;
    }
    next = recovery.reduceRecoveryOutcome(
      ledger(),
      result.profit > 0,
      result.profit,
      Number(row.stake),
      10,
      meta.opportunity.contract.contractType,
      meta.opportunity.payout,
    );
    await tx
      .update(tradesTable)
      .set({
        status: result.profit > 0 ? "won" : "lost",
        profit: String(Math.round(result.profit * 100) / 100),
        payout: String(result.sellPrice),
        entryPrice: String(result.entrySpot || meta.entryTick.price),
        exitPrice: result.exitSpot ? String(result.exitSpot) : null,
        derivContractId: pending.contractId ? String(pending.contractId) : null,
        closedAt: new Date(),
        agentReasoning: journalReason({ ...meta, accounted: true }),
      })
      .where(eq(tradesTable.id, pending.rowId));
    if (meta.executionMode === "live")
      await tx
        .update(settingsTable)
        .set({ recoveryStateJson: JSON.stringify(next), updatedAt: new Date() })
        .where(eq(settingsTable.sessionId, session.owner!));
  });
  if (meta.executionMode === "live") recovery.seedState(next);
  else session.paperLedger = next;
  if (!session.countedRows.has(pending.rowId)) {
    session.countedRows.add(pending.rowId);
    session.totalProfit =
      Math.round((session.totalProfit + result.profit) * 100) / 100;
    session.tradeCount++;
    if (result.profit > 0) session.winCount++;
    else session.lossCount++;
    session.lastResult = result.profit > 0 ? "won" : "lost";
  }
  session.pending = session.pending.filter((p) => p.rowId !== pending.rowId);
  const debt = ledger().unrecoveredAmount;
  say(
    `${result.profit > 0 ? "Win" : "Loss"}: ${result.profit.toFixed(2)} · ${debt > 0 ? `${debt.toFixed(2)} debt remains; ranking the next opportunity with the same utility rule` : "Debt cleared / normal mode"}`,
  );
}

async function settlePending(config: OmniConfig, context: Context) {
  const pending = session.pending[0]!;
  if (pending.cancelReason) {
    await cancelPrepared(pending, pending.cancelReason);
    return;
  }
  if (pending.result) {
    await accountForResult(pending, pending.result);
    return;
  }
  if (config.executionMode === "paper") {
    const snapshot = tickManager.getDigitSnapshot(
      pending.meta.entryTick.symbol,
      OMNI_HISTORY,
    );
    const next = snapshot?.ticks.find(
      (t) => t.sequence === pending.meta.entryTick.sequence + 1,
    );
    if (
      snapshot &&
      (snapshot.tick.generation !== pending.meta.entryTick.generation ||
        snapshot.tick.source !== pending.meta.entryTick.source)
    ) {
      await cancelPrepared(
        pending,
        "Paper order voided: feed provenance changed before its next tick",
      );
      return;
    }
    if (!next) {
      if (Date.now() - pending.meta.sentAt > 10_000 || session.stopRequested)
        await cancelPrepared(
          pending,
          "Paper order voided: no next tick was observed",
        );
      else await sleep(100);
      return;
    }
    const c = pending.meta.opportunity;
    const won = omniWins(c.contract, pending.meta.entryTick, next);
    const profit =
      Math.round((won ? c.stake * (c.payout - 1) : -c.stake) * 100) / 100;
    pending.result = {
      contractId: 0,
      won,
      profit,
      sellPrice: Math.round((c.stake + profit) * 100) / 100,
      entrySpot: pending.meta.entryTick.price,
      exitSpot: next.price,
    };
    await accountForResult(pending, pending.result);
    return;
  }
  // The pinned account (not whichever sub-account the UI now selects) owns the
  // outstanding contract and must be settled even after Stop/disconnect.
  if (!pending.contractId) {
    say(
      "Purchase acknowledgement unknown. Checking the broker; no repeat order or new trade is permitted.",
      "reconciling",
    );
    const broker = getAccountConnection(
      context.token!,
      pending.meta.accountId!,
    );
    const [portfolio, profit] = await Promise.all([
      broker.request({ portfolio: 1 }, 8000),
      broker.request({ profit_table: 1, limit: 100, sort: "DESC" }, 8000),
    ]);
    const c = pending.meta.opportunity;
    const id = matchOmniPurchase(
      [
        ...(portfolio?.portfolio?.contracts ?? []),
        ...(profit?.profit_table?.transactions ?? []),
      ],
      {
        symbol: c.symbol,
        contractType: c.contract.contractType,
        barrier: c.contract.barrier,
        stake: c.stake,
        sentAt: pending.meta.sentAt,
      },
    );
    if (!id) {
      await sleep(5000);
      return;
    }
    pending.contractId = id;
    await db
      .update(tradesTable)
      .set({ derivContractId: String(id) })
      .where(eq(tradesTable.id, pending.rowId));
  }
  say(
    session.stopRequested
      ? "Stopping after the outstanding contract settles"
      : "Awaiting the broker's exact settlement; execution slot held",
    "settling",
  );
  pending.result = await waitForContractResult(
    context.token!,
    pending.meta.accountId!,
    pending.contractId,
    25_000,
  );
  await accountForResult(pending, pending.result);
  try {
    await refreshBalance(context);
  } catch {
    /* The next order must still pass a fresh funding check. */
  }
}

async function runLoop(
  config: OmniConfig,
  initialContext: Context,
  runId: string,
) {
  let context = initialContext;
  const pinnedAccount = context.accountId;
  let lastContextCheck = 0;
  let lastBroadcast = 0;
  try {
    while (
      session.runId === runId &&
      (session.pending.length > 0 || !session.stopRequested)
    ) {
      try {
        if (session.pending.length) {
          await settlePending(config, context);
          continue;
        }
        if (!hasTradingOwnership("bots", session.owner!)) {
          say(
            "Execution ownership changed — stopped without placing another trade",
          );
          break;
        }
        if (
          session.totalProfit >= config.takeProfit ||
          session.totalProfit <= -config.stopLoss ||
          config.stopLoss + session.totalProfit < 0.35
        ) {
          say(
            session.totalProfit >= config.takeProfit
              ? "Take-profit reached"
              : "Stop-loss budget exhausted; remaining debt is retained",
          );
          break;
        }
        if (Date.now() - lastContextCheck > 1000) {
          const fresh = await loadContext(config);
          if (fresh.accountId !== pinnedAccount) {
            say("Active account changed — stopping before another trade");
            break;
          }
          context = fresh;
          lastContextCheck = Date.now();
        }
        const ranked = candidatesFor(config, context);
        session.watch.candidates = ranked.slice(0, 8);
        session.watch.source = ranked[0]
          ? (session.models.get(ranked[0].symbol)?.tick.source ?? "waiting")
          : "waiting";
        session.watch.mode = ledger().inRecovery ? "recovery" : "normal";
        const best = ranked.find((c) => c.ready);
        if (!best) {
          const reason =
            ranked[0]?.reason ??
            "Collecting uninterrupted tick history for the enabled contracts";
          session.watch.phase = "watching";
          session.watch.reason = reason;
          session.message = reason;
          if (Date.now() - lastBroadcast > 1000) {
            broadcast();
            lastBroadcast = Date.now();
          }
          await sleep(150);
          continue;
        }
        const analysed = session.models.get(best.symbol)!.tick;
        const debtAtSelection = ledger().unrecoveredAmount;
        session.watch.source = analysed.source;
        const guard = () => {
          if (
            session.stopRequested ||
            session.runId !== runId ||
            !session.running ||
            !hasTradingOwnership("bots", session.owner!)
          )
            throw new Error("Order cancelled — execution no longer authorized");
          if (
            !config.enabledContracts.includes(best.contract.contractType) ||
            (config.marketMode === "locked" && best.symbol !== session.symbol)
          )
            throw new Error(
              "Contract or market is outside the user's allowlist",
            );
          if (ledger().unrecoveredAmount !== debtAtSelection)
            throw new RecheckEntry("Debt changed while pricing; re-evaluating");
          if (
            !omniTickIsExecutable(
              analysed,
              tickManager.getDigitSnapshot(best.symbol, 1)?.tick,
              Date.now(),
              tickSecondsFor(best.symbol) * 1000,
              config.executionMode === "live",
            )
          )
            throw new RecheckEntry(
              "Entry tick changed or is too late — re-evaluating the next fresh tick",
            );
        };
        let prepared: PendingOrder | null = null;
        const prepare = async (opportunity: OmniOpportunity) => {
          const fresh = await loadContext(config);
          if (fresh.accountId !== pinnedAccount)
            throw new Error("Active account changed before purchase");
          await refreshBalance(fresh);
          const latest = await loadContext(config);
          if (latest.accountId !== pinnedAccount)
            throw new Error("Active account changed during the funding check");
          context = { ...latest, balance: fresh.balance };
          const checked = priceOmniOpportunity(
            opportunity,
            opportunity,
            riskFor(config, context),
            opportunity.payout,
            opportunity.quoteSource,
          );
          if (
            !checked.ready ||
            Math.abs(checked.stake - opportunity.stake) > 0.001
          )
            throw new RecheckEntry(
              "Funding or risk settings changed; re-evaluating",
            );
          guard();
          const meta: JournalMeta = {
            engine: "omni",
            executionMode: config.executionMode,
            accountId: context.accountId,
            runId,
            opportunity,
            entryTick: analysed,
            sentAt: Date.now(),
            accounted: false,
            cancelled: false,
          };
          const [row] = await db
            .insert(tradesTable)
            .values({
              sessionId: session.owner!,
              symbol: opportunity.symbol,
              displayName: opportunity.displayName,
              contractType: opportunity.contract.contractType,
              barrier: opportunity.contract.barrier,
              stake: String(opportunity.stake),
              direction:
                opportunity.contract.contractType === "CALL"
                  ? "rise"
                  : opportunity.contract.contractType === "PUT"
                    ? "fall"
                    : "hold",
              status: "open",
              aiConfidence: String(Math.round(opportunity.probability * 100)),
              aiRiskScore: String(
                Math.round((1 - opportunity.probability) * 100),
              ),
              isAutonomous: true,
              duration: 1,
              durationUnit: "t",
              agentReasoning: journalReason(meta),
            })
            .returning();
          if (!row)
            throw new Error("Could not journal the order before purchase");
          prepared = { rowId: row.id, meta, contractId: null };
          session.pending.push(prepared);
          session.currentStake = opportunity.stake;
          session.currentMarket = opportunity.displayName;
          session.currentContractType = opportunity.contract.contractType;
        };
        if (config.executionMode === "paper") {
          try {
            await prepare(best);
            guard();
            say(
              `PAPER · ${best.contract.label} on ${best.displayName}; waiting for the next observed tick`,
              "settling",
            );
          } catch (error) {
            if (prepared)
              await cancelPrepared(prepared, friendlyErrorMessage(error));
            else if (error instanceof RecheckEntry) say(error.message);
            else throw error;
            await sleep(100);
          }
          continue;
        }
        say(
          `Pricing ${best.contract.label} on ${best.displayName} at its actual stake`,
          "pricing",
        );
        const result = await placeOmniOrder({
          opportunity: best,
          currency: context.currency,
          broker: getAccountConnection(context.token!, context.accountId!),
          guard,
          reprice: (multiplier) => {
            session.prices.set(priceKey(best), { multiplier, at: Date.now() });
            const repriced = priceOmniOpportunity(
              best,
              best,
              riskFor(config, context),
              multiplier,
              "live",
            );
            const leader = candidatesFor(config, context).find((c) => c.ready);
            if (
              leader &&
              (leader.symbol !== best.symbol ||
                leader.contract.id !== best.contract.id) &&
              leader.utility > repriced.utility
            ) {
              return {
                ...repriced,
                ready: false,
                reason: "A better allowed opportunity is available; re-ranking",
              };
            }
            return repriced;
          },
          prepare,
          onBuySent: () => {
            if (prepared) prepared.meta.sentAt = Date.now();
          },
        });
        const pending = prepared as PendingOrder | null;
        if (result.kind === "bought" && pending) {
          pending.contractId = result.contractId;
          // Persist the broker id before waiting for a result; a restart can resume.
          pending.meta.opportunity = {
            ...result.opportunity,
            stake: result.buyPrice,
          };
          await db
            .update(tradesTable)
            .set({
              derivContractId: String(result.contractId),
              stake: String(result.buyPrice),
              agentReasoning: journalReason(pending.meta),
            })
            .where(eq(tradesTable.id, pending.rowId));
          say("Purchase confirmed — awaiting settlement", "settling");
        } else if (result.kind === "unknown" && pending) {
          say(result.reason, "reconciling");
        } else {
          if (pending)
            await cancelPrepared(
              pending,
              result.kind === "skipped" ? result.reason : "Order not sent",
            );
          if (result.kind === "skipped") {
            // Transport/availability backoff is fixed and unrelated to losses.
            // A stale tick is immediately reconsidered on the next observation.
            if (result.quoteUnavailable)
              session.unavailable.set(priceKey(best), Date.now() + 5000);
            say(result.reason);
          }
          await sleep(100);
        }
      } catch (error) {
        if (session.stopRequested && !session.pending.length) break;
        logger.warn(
          { err: error, botId: OMNI_BOT_ID },
          "Omni engine guarded retry",
        );
        if (!session.pending.length) {
          // Authentication/settings failures must not turn a live run into paper.
          say(`Stopped safely: ${friendlyErrorMessage(error)}`);
          break;
        }
        say(
          `Order reconciliation pending: ${friendlyErrorMessage(error)}. No new trades will be sent.`,
          "reconciling",
        );
        await sleep(2000);
      }
    }
  } finally {
    // The loop only finishes once ALL outstanding purchases have settled.
    session.running = false;
    session.starting = false;
    releaseTradingOwnership("bots", session.owner!);
    unregisterLiveBot(OMNI_BOT_ID);
    if (session.stopRequested)
      session.message =
        "Stopped. No outstanding Omni orders; any remaining recovery debt is retained.";
    broadcast();
  }
}
