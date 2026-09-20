/** Match Nexus integration: account isolation, server-owned scans and durable execution. */
import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { accountsTable, db, settingsTable, tradesTable } from "@workspace/db";
import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  getAccountConnection,
  getLiveBalance,
  waitForContractResult,
  tickSecondsFor,
  type TickEvent,
} from "./deriv";
import {
  createSessionScoped,
  getBrowserSessionId,
  runWithSessionId,
} from "./session";
import {
  acquireTradingOwnership,
  currentTradingOwner,
  hasTradingOwnership,
  releaseTradingOwnership,
} from "./engine-arbiter";
import { registerLiveBot } from "./live-registry";
import { broadcastSSE } from "./sse";
import * as recovery from "./agents/recovery-engine";
import { addMoney } from "./recovery-math";
import { MATCH_PAYOUT } from "./payouts";
import {
  correctNexusEvidence,
  NEXUS_VERSION,
  type NexusRiskInput,
} from "./match-nexus-analysis";
import { loadNexusMarket } from "./match-nexus-data";
import {
  MATCH_NEXUS_BOT_ID,
  NEXUS_PENDING,
  NEXUS_SCAN_TTL_MS,
  isNexusPending,
  type NexusScanInput,
  type NexusStartInput,
} from "./match-nexus-policy";
import {
  NexusRunner,
  NexusRejected,
  NexusPaperFeedError,
  advanceNexusMarket,
  type NexusMarket,
  type NexusOrder,
  type NexusOutcome,
  type NexusPurchase,
  type NexusRuntime,
} from "./match-nexus-runner";

export { MATCH_NEXUS_BOT_ID, MATCH_NEXUS_BOT_NAME } from "./match-nexus-policy";
export class NexusRequestError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

interface StoredScan {
  id: string;
  owner: string;
  createdAt: number;
  config: NexusScanInput;
  risk: NexusRiskInput;
  markets: NexusMarket[];
}
const scans = new Map<string, StoredScan>();
const { state } = createSessionScoped<{
  runner: NexusRunner | null;
  scanning: boolean;
  starting: boolean;
  cancelStart: boolean;
}>(() => ({
  runner: null,
  scanning: false,
  starting: false,
  cancelStart: false,
}));
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const owner = () => getBrowserSessionId();

export function isRunning(): boolean {
  return state.starting || !!state.runner?.isRunning;
}
export function getOwnerSessionId(): string | null {
  return state.runner || state.starting ? owner() : null;
}
export function getStatus() {
  return state.runner?.status() ?? null;
}
export function stopSession(): void {
  state.cancelStart = true;
  state.runner?.stop();
}

async function settingsFor(sessionId: string) {
  const [row] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.sessionId, sessionId))
    .limit(1);
  const cap = Number(row?.maxTradeStake ?? 500),
    markup = Number(row?.botRecoveryMarkup ?? 10);
  if (
    !Number.isFinite(cap) ||
    cap < 0 ||
    !Number.isFinite(markup) ||
    markup < 0
  )
    throw new NexusRequestError(
      "Account risk settings are invalid; correct them before trading",
      400,
    );
  // An explicit zero/subminimum cap is restrictive, not permission to use $500.
  return { row, maxStake: cap, markupPercent: markup };
}

/** JSON intentionally excludes model state/card: deployment never trusts a client model. */
export function nexusMarketView(m: NexusMarket, mode: "paper" | "live") {
  return {
    symbol: m.symbol,
    displayName: m.displayName,
    source: m.source,
    historySource: m.historySource,
    samples: m.model.samples,
    deployable: mode === "paper" || m.source === "live",
    prediction: m.prediction,
    decision: m.decision,
    validation: m.validation,
    risk: m.risk,
    analysisMs: m.analysisMs,
    warnings: m.warnings,
    calibration: m.policy.calibration,
    payoutSource: "indicative" as const,
  };
}

export async function scanForNexus(config: NexusScanInput) {
  if (state.scanning || state.starting)
    throw new NexusRequestError(
      "A Nexus scan or deployment is already in progress",
    );
  if (state.runner?.isRunning)
    throw new NexusRequestError(
      "Stop this Nexus session before making a new deployment scan",
    );
  state.scanning = true;
  const sessionId = owner(),
    began = Date.now(),
    scanId = randomUUID();
  for (const [id, scan] of scans)
    if (
      scan.owner === sessionId ||
      Date.now() - scan.createdAt > NEXUS_SCAN_TTL_MS
    )
      scans.delete(id);
  try {
    if (scans.size >= 64)
      throw new NexusRequestError(
        "Analysis capacity is busy; retry shortly",
        429,
      );
    const settings = await settingsFor(sessionId);
    const risk: NexusRiskInput = {
      stake: config.stake,
      stopLoss: config.stopLoss,
      takeProfit: config.takeProfit,
      maxStake: settings.maxStake,
      markupPercent: settings.markupPercent,
    };
    if (config.stake > risk.maxStake)
      throw new NexusRequestError(
        "Base stake exceeds the account's maximum trade stake",
        400,
      );
    const markets = AUTOMATED_DERIV_MARKETS.filter((m) => m.digitEnabled);
    const measured: NexusMarket[] = [];
    const omitted: Array<{ symbol: string; reason: string }> = [];
    let cursor = 0,
      completed = 0;
    // Four bounded workers. History I/O overlaps, but every tick-path remains incremental.
    await Promise.all(
      Array.from({ length: Math.min(4, markets.length) }, async () => {
        for (;;) {
          const market = markets[cursor++];
          if (!market) return;
          broadcastSSE(
            "bot_scan_progress",
            {
              botId: MATCH_NEXUS_BOT_ID,
              scanId,
              scanning: market.displayName,
              scanned: completed,
              total: markets.length,
            },
            sessionId,
          );
          try {
            const result = await loadNexusMarket(market.symbol, config, risk);
            if (result) measured.push(result);
            else
              omitted.push({
                symbol: market.symbol,
                reason:
                  "Need 300 contiguous, source-verified digits; history unavailable or feed warming up",
              });
          } catch {
            omitted.push({
              symbol: market.symbol,
              reason: "History could not be validated",
            });
          }
          completed++;
        }
      }),
    );
    correctNexusEvidence(measured);
    measured.sort(
      (a, b) =>
        Number(b.source === "live") - Number(a.source === "live") ||
        b.decision.utility - a.decision.utility,
    );
    const createdAt = Date.now();
    scans.set(scanId, {
      id: scanId,
      owner: sessionId,
      config: { ...config },
      risk,
      markets: measured,
      createdAt,
    });
    broadcastSSE(
      "bot_scan_progress",
      {
        botId: MATCH_NEXUS_BOT_ID,
        scanId,
        scanning: null,
        scanned: markets.length,
        total: markets.length,
      },
      sessionId,
    );
    return {
      scanId,
      version: NEXUS_VERSION,
      createdAt,
      expiresAt: createdAt + NEXUS_SCAN_TTL_MS,
      config,
      riskSettings: {
        maxStake: risk.maxStake,
        markupPercent: risk.markupPercent,
      },
      elapsedMs: Date.now() - began,
      marketsScanned: markets.length,
      markets: measured.map((m) => nexusMarketView(m, config.executionMode)),
      omitted,
      note: "All ten digits were selected causally inside the held-out policy, not cherry-picked afterwards. Cross-market evidence is multiplicity-adjusted. Quotes here are indicative; the actual broker quote must clear the same entry rule. Paper mode never changes your account's recovery debt.",
    };
  } finally {
    state.scanning = false;
  }
}

/** Exported for regression tests: first NEW tick settles paper, even if its digit repeats. */
export function paperOutcome(
  order: NexusOrder,
  payout: number,
  snapshot: ReturnType<typeof tickManager.getDigitSnapshot>,
): NexusOutcome | null {
  if (!snapshot) return null;
  if (
    snapshot.tick.generation !== order.tick.generation ||
    snapshot.tick.source !== order.tick.source
  )
    throw new NexusPaperFeedError(
      "Paper feed changed before a settlement could be observed",
    );
  const next = snapshot.ticks.find((t) => t.sequence > order.tick.sequence);
  if (!next) return null;
  if (next.sequence !== order.tick.sequence + 1)
    throw new NexusPaperFeedError(
      "Paper settlement tick was missed; outcome is unknown",
    );
  const won = next.digit === order.barrier;
  return {
    won,
    profit: won ? addMoney(order.stake * (payout - 1)) : -order.stake,
    entryPrice: order.tick.price,
    exitPrice: next.price,
  };
}

/** Runtime factory is exported so the actual journal/transport path is integration-tested. */
export function createNexusRuntime(
  sessionId: string,
  config: NexusScanInput,
  scanRisk: NexusRiskInput,
  account: typeof accountsTable.$inferSelect | null,
): NexusRuntime {
  let paperState = recovery.createRecoveryState();
  let balance =
    config.executionMode === "paper" ? 10_000 : Number(account?.balance ?? 0);
  let token = account?.bearerToken ?? account?.token ?? "";
  const accountId = account?.derivAccountId ?? account?.loginId ?? "";
  let balanceAt = 0,
    paperIntentId = 0;
  const committedPaper = new Set<number>();
  const committedLive = new Set<number>();
  const paperPurchases = new Map<string, NexusOrder>();
  const intentByOrder = new WeakMap<NexusOrder, { id: number; tag: string }>();
  const receipts = new Map<number, NexusPurchase>();
  const lateRejections = new Map<number, string>();
  const receiptCleanups = new Set<() => void>();
  const scoped = <T>(fn: () => T) => runWithSessionId(sessionId, fn);
  const runtime: NexusRuntime = {
    now: Date.now,
    snapshot: (symbol) => tickManager.getDigitSnapshot(symbol),
    periodMs: (symbol) => tickSecondsFor(symbol) * 1000,
    subscribe(listener) {
      const receive = (tick: TickEvent) => scoped(() => listener(tick.symbol));
      tickManager.on("tick", receive);
      return () => tickManager.off("tick", receive);
    },
    owns: () => hasTradingOwnership("match-nexus", sessionId),
    recovery: () =>
      config.executionMode === "paper"
        ? { ...paperState }
        : scoped(() => recovery.getState()),
    async risk() {
      const settings = await settingsFor(sessionId);
      if (config.executionMode === "live") {
        if (settings.row?.paperTradeMode)
          throw new Error("Global paper mode is enabled; live entry cancelled");
        const [active] = await db
          .select()
          .from(accountsTable)
          .where(
            and(
              eq(accountsTable.id, account!.id),
              eq(accountsTable.sessionId, sessionId),
              eq(accountsTable.isActive, true),
            ),
          )
          .limit(1);
        if (
          !active ||
          !(active.bearerToken ?? active.token) ||
          (active.derivAccountId ?? active.loginId) !== accountId
        )
          throw new Error("The selected Deriv account is no longer active");
        token = active.bearerToken ?? active.token!;
        if (!balanceAt || Date.now() - balanceAt > 30_000) {
          const fresh = await getLiveBalance(token, accountId);
          if (fresh === null || !Number.isFinite(fresh) || fresh < 0)
            throw new Error("Live balance cannot be verified");
          balance = balanceAt ? Math.min(balance, fresh) : fresh;
          balanceAt = Date.now();
        }
      }
      return {
        balance,
        maxStake: settings.maxStake,
        markupPercent: settings.markupPercent,
      };
    },
    refresh: (market) => loadNexusMarket(market.symbol, config, scanRisk),
    async quote(order, guard) {
      guard();
      if (config.executionMode === "paper")
        return {
          id: `paper-quote-${randomUUID()}`,
          askPrice: order.stake,
          payout: order.stake * MATCH_PAYOUT,
          order,
          receivedAt: Date.now(),
        };
      const connection = getAccountConnection(token, accountId);
      const response = await connection.request(
        {
          proposal: 1,
          amount: order.stake,
          basis: "stake",
          contract_type: "DIGITMATCH",
          barrier: String(order.barrier),
          duration: 1,
          duration_unit: "t",
          currency: account!.currency,
          underlying_symbol: order.symbol,
        },
        3500,
        { beforeSend: guard },
      );
      if (response?.error)
        throw new NexusRejected(response.error.message ?? "Quote rejected");
      if (!response?.proposal?.id)
        throw new Error("Quote unavailable; nothing was purchased");
      return {
        id: String(response.proposal.id),
        askPrice: Number(response.proposal.ask_price),
        payout: Number(response.proposal.payout),
        order,
        receivedAt: Date.now(),
      };
    },
    async createIntent(order) {
      if (config.executionMode === "paper") return ++paperIntentId;
      const tag = `nexus:${randomUUID()}`;
      const reason = `${NEXUS_PENDING} [Match Nexus] DIGITMATCH ${order.barrier}; source=live; tick=${order.tick.generation}:${order.tick.sequence}; p=${order.decision.p.toFixed(6)}; quoteEV=${order.decision.expectedValue.toFixed(6)}; intent=${tag}`;
      const [row] = await db
        .insert(tradesTable)
        .values({
          sessionId,
          symbol: order.symbol,
          displayName: order.displayName,
          contractType: "DIGITMATCH",
          barrier: order.barrier,
          stake: String(order.stake),
          direction: "hold",
          status: "open",
          duration: 1,
          durationUnit: "t",
          isAutonomous: true,
          aiConfidence: String(Number((order.decision.p * 100).toFixed(2))),
          agentReasoning: reason,
          entryPrice: String(order.tick.price),
        })
        .returning({ id: tradesTable.id });
      if (!row) throw new Error("Could not persist the purchase intent");
      intentByOrder.set(order, { id: row.id, tag });
      return row.id;
    },
    async confirmIntent(intent, purchase) {
      if (config.executionMode === "paper") return;
      await db
        .update(tradesTable)
        .set({
          derivContractId: purchase.contractId,
          stake: String(purchase.buyPrice),
        })
        .where(
          and(eq(tradesTable.id, intent), eq(tradesTable.sessionId, sessionId)),
        );
    },
    async cancelIntent(intent, reason) {
      receipts.delete(intent);
      lateRejections.delete(intent);
      if (config.executionMode === "paper") return;
      // Cancelled is not an economic loss, nor a candidate for fuzzy reconciliation.
      await db
        .update(tradesTable)
        .set({
          status: "cancelled",
          closedAt: new Date(),
          agentReasoning: `[Match Nexus] Unpurchased entry: ${reason}`,
        })
        .where(
          and(eq(tradesTable.id, intent), eq(tradesTable.sessionId, sessionId)),
        );
    },
    async buy(quote, guard, onSent) {
      if (config.executionMode === "paper") {
        guard();
        onSent();
        const contractId = `paper-${randomUUID()}`;
        paperPurchases.set(contractId, quote.order);
        return { contractId, buyPrice: quote.askPrice };
      }
      const connection = getAccountConnection(token, accountId);
      const stored = intentByOrder.get(quote.order);
      const intent = stored?.id;
      // Correlation is durable, unique and contains no browser/session credential.
      const tag = stored?.tag ?? `nexus:${randomUUID()}`;
      const parseReceipt = (message: any): NexusPurchase | null => {
        const buy = message?.buy;
        if (
          !buy?.contract_id ||
          !Number.isFinite(Number(buy.buy_price)) ||
          Number(buy.buy_price) <= 0
        )
          return null;
        return {
          contractId: String(buy.contract_id),
          buyPrice: Number(buy.buy_price),
          startedAtMs: Number(buy.start_time)
            ? Number(buy.start_time) * 1000
            : undefined,
        };
      };
      const cleanup = () => {
        connection.off("message", receive);
        receiptCleanups.delete(cleanup);
      };
      const receive = (message: any) => {
        // The pooled request may time out before its acknowledgement arrives.
        // Its unique, echoed intent is proof; matching stake/time alone is not.
        const echoed =
          message?.echo_req?.passthrough?.nexus_intent ??
          message?.passthrough?.nexus_intent;
        if (echoed !== tag || message?.msg_type !== "buy") return;
        const receipt = parseReceipt(message);
        if (intent !== undefined && receipt) receipts.set(intent, receipt);
        if (intent !== undefined && message.error)
          lateRejections.set(
            intent,
            String(message.error.message ?? "Purchase rejected"),
          );
        if (receipt || message.error) cleanup();
      };
      connection.on("message", receive);
      receiptCleanups.add(cleanup);
      let dispatched = false;
      try {
        const response = await connection.request(
          {
            buy: quote.id,
            price: quote.askPrice,
            passthrough: { nexus_intent: tag },
          },
          6000,
          {
            beforeSend: guard,
            onSent: () => {
              dispatched = true;
              onSent();
            },
          },
        );
        if (response?.error)
          throw new NexusRejected(
            response.error.message ?? "Purchase rejected by broker",
          );
        const receipt = parseReceipt(response);
        if (!receipt)
          throw new Error("Purchase acknowledgement missing or invalid");
        if (intent !== undefined) receipts.set(intent, receipt);
        cleanup();
        return receipt;
      } catch (err) {
        // Retain only an ambiguous SEND's observer. It never issues a retry.
        if (!dispatched || err instanceof NexusRejected) cleanup();
        throw err;
      }
    },
    async settle(purchase, order, payout) {
      if (config.executionMode === "live") {
        const result = await waitForContractResult(
          token,
          accountId,
          Number(purchase.contractId),
          30_000,
        );
        if (result.missing) throw new Error("Settlement still unknown");
        return {
          won: result.won,
          profit: addMoney(result.profit),
          exitPrice: result.exitSpot || undefined,
        };
      }
      const original = paperPurchases.get(purchase.contractId) ?? order;
      const existing = paperOutcome(
        original,
        payout,
        tickManager.getDigitSnapshot(order.symbol),
      );
      if (existing) return existing;
      return new Promise<NexusOutcome>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          tickManager.off("tick", receive);
        };
        const receive = (event: TickEvent) => {
          if (event.symbol !== order.symbol) return;
          try {
            const result = paperOutcome(
              original,
              payout,
              tickManager.getDigitSnapshot(order.symbol),
            );
            if (result) {
              cleanup();
              resolve(result);
            }
          } catch (err) {
            cleanup();
            reject(err);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Paper settlement feed stalled"));
        }, 15_000);
        tickManager.on("tick", receive);
        // Close the race between the initial snapshot and subscription installation.
        receive({ symbol: order.symbol, price: 0, lastDigit: 0, epoch: 0 });
      });
    },
    async findPurchase(intent) {
      if (lateRejections.has(intent))
        throw new NexusRejected(lateRejections.get(intent)!);
      const confirmed = receipts.get(intent);
      if (confirmed) return confirmed;
      const [row] = await db
        .select()
        .from(tradesTable)
        .where(
          and(eq(tradesTable.id, intent), eq(tradesTable.sessionId, sessionId)),
        )
        .limit(1);
      return row?.derivContractId
        ? { contractId: row.derivContractId, buyPrice: Number(row.stake) }
        : null;
    },
    async commit(intent, outcome, stake, payout) {
      if (config.executionMode === "paper") {
        if (committedPaper.has(intent)) return;
        paperState = recovery.reduceRecoveryOutcome(
          paperState,
          outcome.won,
          outcome.profit,
          stake,
          config.maxRecoverySteps,
          "DIGITMATCH",
          payout,
        );
        balance = addMoney(balance, outcome.profit);
        committedPaper.add(intent);
        // There is only one outstanding paper purchase at a time.
        paperPurchases.clear();
        return;
      }
      const next = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(tradesTable)
          .where(
            and(
              eq(tradesTable.id, intent),
              eq(tradesTable.sessionId, sessionId),
            ),
          )
          .for("update");
        if (!row?.derivContractId)
          throw new Error(
            "Cannot settle a trade without its durable contract ID",
          );
        if (!isNexusPending(row.agentReasoning)) return null; // already atomically committed
        const updated = scoped(() =>
          recovery.reduceRecoveryOutcome(
            recovery.getState(),
            outcome.won,
            outcome.profit,
            stake,
            config.maxRecoverySteps,
            "DIGITMATCH",
            payout,
          ),
        );
        await tx
          .update(tradesTable)
          .set({
            status: outcome.won ? "won" : "lost",
            profit: String(outcome.profit),
            payout: String(Math.max(0, addMoney(stake, outcome.profit))),
            ...(outcome.exitPrice
              ? { exitPrice: String(outcome.exitPrice) }
              : {}),
            closedAt: new Date(),
            agentReasoning: row.agentReasoning!.replace(
              NEXUS_PENDING,
              "[NEXUS_SETTLED]",
            ),
          })
          .where(eq(tradesTable.id, intent));
        await tx
          .update(settingsTable)
          .set({
            recoveryStateJson: JSON.stringify(updated),
            updatedAt: new Date(),
          })
          .where(eq(settingsTable.sessionId, sessionId));
        return updated;
      });
      receipts.delete(intent);
      lateRejections.delete(intent);
      if (next) scoped(() => recovery.seedState(next));
      if (!committedLive.has(intent)) {
        balance = addMoney(balance, outcome.profit);
        committedLive.add(intent);
      }
    },
    delay,
    publish: (status) => broadcastSSE("bot_update", status, sessionId),
    release: () => {
      for (const cleanup of receiptCleanups) cleanup();
      releaseTradingOwnership("match-nexus", sessionId);
    },
  };
  return runtime;
}

export async function startSession(input: NexusStartInput) {
  const sessionId = owner();
  if (isRunning())
    throw new NexusRequestError(
      "Match Nexus is active or still settling; stop/drain it before deploying again",
    );
  const scan = scans.get(input.scanId);
  if (
    !scan ||
    scan.owner !== sessionId ||
    Date.now() - scan.createdAt > NEXUS_SCAN_TTL_MS
  )
    throw new NexusRequestError(
      "This scan is missing, expired or belongs to another account; scan again",
    );
  const selected = scan.markets.find((m) => m.symbol === input.symbol);
  if (!selected)
    throw new NexusRequestError("Select a market returned by this scan", 400);
  if (
    scan.config.executionMode === "live" &&
    (!input.confirmLive || selected.source !== "live")
  )
    throw new NexusRequestError(
      "Live deployment requires explicit confirmation and a live-data scan",
      400,
    );
  if (
    currentTradingOwner(sessionId) ||
    !acquireTradingOwnership("match-nexus", sessionId)
  )
    throw new NexusRequestError(
      "Another engine owns this account's execution/recovery ledger; stop it first",
    );
  state.starting = true;
  state.cancelStart = false;
  try {
    const settings = await settingsFor(sessionId);
    const [account] = await db
      .select()
      .from(accountsTable)
      .where(
        and(
          eq(accountsTable.sessionId, sessionId),
          eq(accountsTable.isActive, true),
        ),
      )
      .limit(1);
    if (
      scan.config.executionMode === "live" &&
      (!account || !(account.bearerToken ?? account.token))
    )
      throw new NexusRequestError(
        "Connect an active Deriv account before choosing live execution",
        400,
      );
    if (scan.config.executionMode === "live" && settings.row?.paperTradeMode)
      throw new NexusRequestError(
        "Global Paper Trade mode is enabled. Keep Nexus in paper mode or disable that setting first.",
        400,
      );
    await db.insert(settingsTable).values({ sessionId }).onConflictDoNothing();
    if (scan.config.executionMode === "live" && settings.row?.recoveryStateJson)
      recovery.hydrateStateIfNeeded(settings.row.recoveryStateJson);
    const runtime = createNexusRuntime(
      sessionId,
      scan.config,
      scan.risk,
      account ?? null,
    );
    if (scan.config.executionMode === "live") {
      const pending = await db
        .select()
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.sessionId, sessionId),
            like(tradesTable.agentReasoning, `%${NEXUS_PENDING}%`),
          ),
        );
      for (const row of pending) {
        if (
          !row.derivContractId ||
          !["won", "lost"].includes(row.status) ||
          row.profit === null
        )
          throw new NexusRequestError(
            "An earlier Nexus purchase/settlement is unresolved. No new entry is allowed; verify it in the Deriv journal first.",
          );
        const stake = Number(row.stake),
          profit = Number(row.profit);
        await runtime.commit(
          row.id,
          { won: profit > 0, profit },
          stake,
          profit > 0 ? (stake + profit) / stake : MATCH_PAYOUT,
        );
      }
      // A different engine's unclosed position is not permission to trade over it.
      const open = await db
        .select({ id: tradesTable.id })
        .from(tradesTable)
        .where(
          and(
            eq(tradesTable.sessionId, sessionId),
            eq(tradesTable.status, "open"),
          ),
        )
        .limit(1);
      if (open.length)
        throw new NexusRequestError(
          "There is an unsettled account trade; wait for it to close before deploying Nexus",
        );
    }
    // Replay ticks received while the user read the scan, including equal digits.
    const eligible =
      input.marketMode === "locked"
        ? [selected]
        : scan.markets.filter(
            (m) => scan.config.executionMode === "paper" || m.source === "live",
          );
    for (const market of eligible)
      advanceNexusMarket(market, tickManager.getDigitSnapshot(market.symbol));
    if (!selected.valid)
      throw new NexusRequestError(
        "The selected feed changed after the scan; scan again before deploying",
      );
    if (state.cancelStart)
      throw new NexusRequestError("Deployment cancelled by stop request");
    const runner = new NexusRunner(
      `nexus-${randomUUID()}`,
      scan.config,
      input.marketMode,
      selected.symbol,
      eligible,
      runtime,
    );
    state.runner = runner;
    scans.delete(input.scanId); // single-use deployment capability, never a client model card
    registerLiveBot("match-nexus", () => getStatus());
    runner.start();
    return runner.status();
  } catch (err) {
    releaseTradingOwnership("match-nexus", sessionId);
    throw err;
  } finally {
    state.starting = false;
  }
}
