/**
 * KILL-SHOT PRECISION SNIPER — execution engine (7th specialist bot).
 *
 * OPERATING MODEL
 * ───────────────
 * The inverse of every other bot in the section. The other six are throughput
 * engines: they look for a good trade and take it. This one is a patience
 * engine. It sits on ONE locked market watching one locked contract, and it
 * takes no action at all — for minutes, for hours — until Wald's sequential
 * probability ratio test says the accumulated evidence for a real edge has
 * crossed a 200:1 threshold AND six independent structural gates are clear.
 * Then it fires once.
 *
 * The design consequences of that, all of which differ from `bot-engine.ts`:
 *
 *  · NO MARKET ROTATION, EVER. The market is chosen once, before the session,
 *    and frozen. It is not re-picked after a loss, after a win, on a stall, or
 *    on any timer. `config.symbol` is the only market this session will ever
 *    touch, and it is re-asserted on every single fire.
 *
 *  · NO CONTRACT DRIFT. The user names exactly one contract — Over N, Under N,
 *    Matches D, Even, or Odd. Never both sides of a pair. The only degree of
 *    freedom the AI has is the Matches digit, and only when the user explicitly
 *    delegates it. A sovereignty check runs immediately before every buy.
 *
 *  · WAITING IS THE DEFAULT STATE. The loop's normal condition is "armed,
 *    watching, not trading". Firing is the exception. The console shows the
 *    SPRT evidence bar filling so the user can see the bot working while it is
 *    deliberately doing nothing.
 *
 *  · THE SAME SHARED RECOVERY SYSTEM. Identical to the other bots: the ONE
 *    account-global ledger (`lib/agents/recovery-engine.ts`), the ONE recovery
 *    stake formula (`getBotRecoveryStake` — debt × (1 + markup) / (payout − 1))
 *    and the same max-step ceiling. No private debt state.
 *
 *  · RECOVERY IS ALSO SNIPED. This is the one place the bot departs from the
 *    others in a way that matters: a recovery trade is not fired on the next
 *    tick. It waits for the same full evidence stack to re-clear. A recovery
 *    trade taken in a hurry is exactly how a two-loss streak becomes a five-loss
 *    streak, and this bot's entire premise is that that must not happen.
 *
 *  · SINGLE-EXECUTOR ARBITER. Shares `lib/engine-arbiter.ts` (owner `bots`) with
 *    every other engine — one ledger, one executor.
 */

import {
  tickManager,
  AUTOMATED_DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getLiveBalance,
  isAutomatedMarket,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { friendlyErrorMessage } from "./friendly-error";
import { db, accountsTable, settingsTable, tradesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { resolveRecoveryPayout } from "./recovery-payout";
import * as recoveryEngine from "./agents/recovery-engine";
import {
  acquireTradingOwnership,
  releaseTradingOwnership,
  hasTradingOwnership,
  currentTradingOwner,
  tradingOwnerLabel,
} from "./engine-arbiter";
import {
  evaluateKillShotCandidate,
  screenKillShotCandidates,
  killShotLabel,
  killShotWinSet,
  killShotPayout,
  KILLSHOT_CONTRACT_TYPE,
  KILLSHOT_GATES,
  type KillShotCandidate,
  type KillShotContract,
} from "./killshot-analysis";

export const KILLSHOT_BOT_ID = "killshot";
const BOT_NAME = "Kill-Shot Precision Sniper";

// ── Config / status ───────────────────────────────────────────────────────────

export interface KillShotConfig {
  ownerSessionId?: string;
  /** FROZEN market — never re-selected for the life of the session. */
  symbol: string;
  displayName: string;
  /** FROZEN contract — exactly one side, never both. */
  contract: KillShotContract;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  maxRecoverySteps: number;
  /** Stop after this many kill shots (0 = until TP/SL). */
  maxTrades: number;
  /** Pre-deploy analysis, kept for the UI and journaling. */
  lockedAnalysis?: KillShotCandidate;
}

export interface KillShotStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  config?: Omit<KillShotConfig, "ownerSessionId">;
  /** The frozen target and its pre-deploy read. */
  killLock?: {
    symbol: string;
    displayName: string;
    contract: string;
    confidence: number;
    pWin: number;
    pLower: number;
    breakEven: number;
    payout: number;
    expectedValue: number;
    pTwoInARow: number;
    clusterRatio: number;
    signals: string[];
  };
  /** Live evidence state — what the bot is waiting for right now. */
  hunt?: {
    /** "waiting" = accumulating evidence; "armed" = all gates clear. */
    phase: "waiting" | "armed" | "firing" | "settling";
    /** SPRT progress toward the fire threshold, 0–1. */
    evidence: number;
    logLR: number;
    threshold: number;
    oddsForEdge: number;
    /** Ticks the SPRT expects still to need. */
    expectedTicks: number;
    /** Live confidence, 0–100. */
    confidence: number;
    pWin: number;
    pLower: number;
    /** Gates currently blocking a shot. */
    blockers: string[];
    /** Ticks observed since the last shot (or since arming). */
    ticksWatched: number;
    /** Number of shots the bot has declined to take. */
    setupsRejected: number;
  };
}

export interface KillShotScanResult {
  suitable: boolean;
  best: KillShotCandidate | null;
  allScored: KillShotCandidate[];
  reason: string;
}

// ── Session state ─────────────────────────────────────────────────────────────

interface SessionState {
  running: boolean;
  sessionId: string | null;
  config: KillShotConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  stopRequested: boolean;
  hunt: NonNullable<KillShotStatus["hunt"]>;
}

function freshHunt(): NonNullable<KillShotStatus["hunt"]> {
  return {
    phase: "waiting",
    evidence: 0,
    logLR: 0,
    threshold: 0,
    oddsForEdge: 1,
    expectedTicks: 0,
    confidence: 0,
    pWin: 0,
    pLower: 0,
    blockers: [],
    ticksWatched: 0,
    setupsRejected: 0,
  };
}

function freshSession(): SessionState {
  return {
    running: false,
    sessionId: null,
    config: null,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: 0,
    consecutiveRecoveryLosses: 0,
    stopRequested: false,
    hunt: freshHunt(),
  };
}

let session: SessionState = freshSession();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  const ownerSessionId = session.config?.ownerSessionId;
  if (!ownerSessionId) return;
  broadcastSSE("bot_update", getStatus(), ownerSessionId);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getOwnerSessionId(): string | null {
  return session.config?.ownerSessionId ?? null;
}

export function isRunning(): boolean {
  return session.running;
}

export function getStatus(): KillShotStatus {
  const rec = recoveryEngine.getState();
  const cfg = session.config;
  const publicConfig = cfg
    ? (Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "ownerSessionId"),
      ) as Omit<KillShotConfig, "ownerSessionId">)
    : undefined;
  const a = cfg?.lockedAnalysis;
  return {
    running: session.running,
    botId: KILLSHOT_BOT_ID,
    botName: BOT_NAME,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: rec.inRecovery,
    recoveryStep: rec.recoveryStep,
    unrecoveredAmount: Math.round(rec.unrecoveredAmount * 100) / 100,
    recoveryTargetProfit: Math.round(rec.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(rec.remainingTargetProfit * 100) / 100,
    consecutiveRecoveryLosses: session.consecutiveRecoveryLosses,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    message: session.message,
    config: publicConfig,
    killLock: cfg
      ? {
          symbol: cfg.symbol,
          displayName: cfg.displayName,
          contract: killShotLabel(cfg.contract),
          confidence: a?.confidence ?? 0,
          pWin: a?.pWin ?? 0,
          pLower: a?.pLower ?? 0,
          breakEven: a?.breakEven ?? 0,
          payout: a?.payout ?? 0,
          expectedValue: a?.expectedValue ?? 0,
          pTwoInARow: a?.loss?.pTwoInARow ?? 0,
          clusterRatio: a?.loss?.clusterRatio ?? 1,
          signals: a?.signals ?? [],
        }
      : undefined,
    hunt: session.running ? session.hunt : undefined,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  releaseTradingOwnership("bots");
  broadcast();
  logger.info("Kill-Shot session stopped");
}

// ── Pre-deploy scan ───────────────────────────────────────────────────────────

/**
 * Find the single best market for the user's chosen contract.
 *
 * Every digit-enabled market is scored through the full seven-layer stack. When
 * the user chose Matches WITHOUT naming a digit, all ten digits are scored in
 * every market too, and the selection surcharge log(10 × markets) is applied to
 * the SPRT threshold so the winner cannot be a lucky argmax.
 *
 * The market this returns is the ONLY market the session will ever trade.
 */
export async function scanForTarget(
  ownerSessionId: string | undefined,
  contract: KillShotContract,
): Promise<KillShotScanResult> {
  const markets = AUTOMATED_DERIV_MARKETS.filter(m => m.digitEnabled);

  // Candidate contracts: the user's exact choice, or all ten digits when they
  // delegated the Matches digit to the AI.
  const contracts: KillShotContract[] =
    contract.kind === "match" && contract.digit === undefined
      ? Array.from({ length: 10 }, (_, d) => ({ kind: "match" as const, digit: d }))
      : [contract];

  // Selection surcharge — extra nats of evidence required, log(#candidates).
  const totalCandidates = markets.length * contracts.length;
  const penaltyNats = Math.log(Math.max(1, totalCandidates));

  const all: KillShotCandidate[] = [];
  let scanned = 0;

  for (const market of markets) {
    broadcastSSE("bot_scan_progress", {
      botId: KILLSHOT_BOT_ID,
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total: markets.length,
      results: screenKillShotCandidates(all).slice(0, 8),
    }, ownerSessionId);

    const digits = tickManager.getDigits(market.symbol, 600);
    for (const c of contracts) {
      const cand = evaluateKillShotCandidate(market.symbol, market.displayName, digits, c, penaltyNats);
      if (cand) all.push(cand);
    }
    scanned++;
    await sleep(50);
  }

  const ranked = screenKillShotCandidates(all);

  broadcastSSE("bot_scan_progress", {
    botId: KILLSHOT_BOT_ID,
    scanning: null,
    symbol: null,
    scanned: markets.length,
    total: markets.length,
    results: ranked.slice(0, 8),
  }, ownerSessionId);

  if (ranked.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: `No market has enough history yet — this bot needs ${KILLSHOT_GATES.minSamples}+ digits per market before it will look at anything. Wait a moment and re-scan.`,
    };
  }

  const best = ranked[0]!;
  const suitable = best.deployable;
  const reason = suitable
    ? `${best.displayName}: ${best.label} — ${best.confidence}% confidence, ` +
      `${(best.pWin * 100).toFixed(1)}% win rate (anytime-valid floor ${(best.pLower * 100).toFixed(1)}%), ` +
      `SPRT odds ${best.sprt.oddsForEdge.toFixed(0)}:1, P(2 losses in a row) ${(best.loss.pTwoInARow * 100).toFixed(2)}%`
    : `No market currently clears the kill-shot bar for ${killShotLabel(contract)}. ` +
      `Best was ${best.displayName} at ${best.confidence}% confidence — blocked by: ${best.blockers[0] ?? "insufficient evidence"}. ` +
      `This bot refuses marginal setups by design; re-scan in a few minutes.`;

  return { suitable, best, allScored: ranked.slice(0, 20), reason };
}

// ── Session start ─────────────────────────────────────────────────────────────

export async function startSession(config: KillShotConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A Kill-Shot session is already active — stop it first" };

  if (!acquireTradingOwnership("bots")) {
    const owner = currentTradingOwner();
    return {
      ok: false,
      error: `The ${owner ? tradingOwnerLabel(owner) : "another engine"} is currently trading on this account. Stop it first — only one engine may own the shared recovery ledger.`,
    };
  }

  const fail = (error: string) => { releaseTradingOwnership("bots"); return { ok: false as const, error }; };

  if (config.stake < 0.35) return fail("Minimum stake is $0.35");
  if (config.stopLoss <= 0) return fail("Stop loss must be positive");
  if (config.takeProfit <= 0) return fail("Take profit must be positive");
  if (!isAutomatedMarket(config.symbol)) return fail(`${config.symbol} cannot be traded by this bot`);
  if (config.contract.kind === "match" && config.contract.digit === undefined) {
    return fail("The Matches digit must be resolved by the scan before deployment");
  }

  session = {
    ...freshSession(),
    running: true,
    sessionId: `bot_killshot_${Date.now()}`,
    config,
    currentStake: config.stake,
    message: `Locked on ${config.displayName} · ${killShotLabel(config.contract)}. Hunting for a kill shot — no trade until the evidence is conclusive.`,
  };

  logger.info({
    symbol: config.symbol,
    contract: killShotLabel(config.contract),
    confidence: config.lockedAnalysis?.confidence,
  }, "Kill-Shot session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "Kill-Shot runLoop error");
    session.running = false;
    session.message = `⚠️ ${friendlyErrorMessage(err)}`;
    broadcast();
  }).finally(() => releaseTradingOwnership("bots"));

  return { ok: true };
}

// ── Execution loop ────────────────────────────────────────────────────────────

async function runLoop(config: KillShotConfig) {
  const ownerSessionId = config.ownerSessionId;
  if (!ownerSessionId) {
    session.running = false;
    session.message = "Browser session missing — session aborted safely";
    releaseTradingOwnership("bots");
    broadcast();
    return;
  }

  let accounts = await db.select().from(accountsTable).where(and(
    eq(accountsTable.sessionId, ownerSessionId),
    eq(accountsTable.isActive, true),
  )).limit(1);
  if (accounts.length === 0) {
    accounts = await db.select().from(accountsTable)
      .where(eq(accountsTable.sessionId, ownerSessionId)).limit(1);
  }

  const settings = await db.select().from(settingsTable)
    .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
  recoveryEngine.setPersistenceSession(ownerSessionId);

  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = accounts.length > 0 ? (accounts[0]!.bearerToken ?? accounts[0]!.token ?? null) : null;
  const currency = accounts.length > 0 ? accounts[0]!.currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0]!.maxTradeStake) : 500;
  let botRecoveryMarkup = settings.length > 0 ? Number((settings[0] as any).botRecoveryMarkup ?? 10) : 10;
  let availableBalance = accounts.length > 0 && Number(accounts[0]!.balance) > 0
    ? Number(accounts[0]!.balance)
    : Number.POSITIVE_INFINITY;

  // THE LOCK. Captured once, here, and never reassigned. Every read below goes
  // through these two constants, so there is no code path — not a stall, not a
  // loss streak, not an error retry — that can move this session to another
  // market or another contract.
  const LOCKED_SYMBOL = config.symbol;
  const LOCKED_CONTRACT: KillShotContract = { ...config.contract };
  const LOCKED_TYPE = KILLSHOT_CONTRACT_TYPE[LOCKED_CONTRACT.kind];
  const LOCKED_WINSET = killShotWinSet(LOCKED_CONTRACT);

  let consecutiveErrors = 0;
  let lastDigitCount = 0;

  while (session.running && !session.stopRequested) {
    try {
      if (!hasTradingOwnership("bots")) {
        const owner = currentTradingOwner();
        session.running = false;
        session.message = `⛔ Stopped — the ${owner ? tradingOwnerLabel(owner) : "other engine"} took over this account. One ledger = one engine.`;
        broadcast();
        return;
      }

      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed…";
        broadcast();
        await sleep(1000);
        continue;
      }

      // ── THE HUNT ───────────────────────────────────────────────────────────
      // Re-evaluate the LOCKED market and the LOCKED contract only. Nothing
      // here can select a different market — `scanForTarget` is not reachable
      // from the running loop at all.
      const digits = tickManager.getDigits(LOCKED_SYMBOL, 600);
      if (digits.length !== lastDigitCount) {
        session.hunt.ticksWatched += Math.max(0, digits.length - lastDigitCount);
        lastDigitCount = digits.length;
      }

      const read = evaluateKillShotCandidate(
        LOCKED_SYMBOL,
        config.displayName,
        digits,
        LOCKED_CONTRACT,
        0, // no selection penalty: the market is already fixed, nothing is being chosen
      );

      const inRecovery = recoveryEngine.isInRecovery();

      if (!read) {
        session.hunt.phase = "waiting";
        session.message = `Building history on ${config.displayName} — ${digits.length}/${KILLSHOT_GATES.minSamples} digits before analysis can begin.`;
        broadcast();
        await sleep(1500);
        continue;
      }

      // Publish the live evidence state so the user can watch the bot think.
      session.hunt.evidence = Math.max(0, read.sprt.progress);
      session.hunt.logLR = read.sprt.logLR;
      session.hunt.threshold = read.sprt.upper;
      session.hunt.oddsForEdge = read.sprt.oddsForEdge;
      session.hunt.expectedTicks = read.sprt.expectedRemaining;
      session.hunt.confidence = read.confidence;
      session.hunt.pWin = read.pWin;
      session.hunt.pLower = read.pLower;
      session.hunt.blockers = read.blockers.slice(0, 3);

      // THE ONE DECISION. Every gate must be clear. In recovery the bar is the
      // SAME — a recovery trade is sniped exactly as carefully as a normal one,
      // because a rushed recovery trade is how a 2-loss streak becomes a 5.
      if (!read.deployable) {
        session.hunt.phase = "waiting";
        const top = read.blockers[0] ?? "gathering evidence";
        session.message = inRecovery
          ? `🎯 Recovery armed — holding fire until the setup is conclusive. ${top}`
          : `👁 Watching ${config.displayName} · ${read.confidence}% confidence · ${top}`;
        broadcast();
        // Patience is free. Poll slowly — this is a sniper, not a scalper.
        await sleep(1400);
        continue;
      }

      // ── ARMED → FIRE ───────────────────────────────────────────────────────
      session.hunt.phase = "armed";
      broadcast();

      // Contract sovereignty — re-asserted immediately before every buy. A bug
      // anywhere upstream can never make this bot fire a contract or a market
      // the user did not choose.
      if (LOCKED_SYMBOL !== config.symbol
          || LOCKED_CONTRACT.kind !== config.contract.kind
          || LOCKED_CONTRACT.digit !== config.contract.digit) {
        session.running = false;
        session.message = "⚠️ Lock integrity check failed — session halted before firing";
        logger.error({ LOCKED_SYMBOL, LOCKED_CONTRACT, config }, "Kill-Shot lock violation");
        broadcast();
        return;
      }

      const barrier = LOCKED_CONTRACT.kind === "even" || LOCKED_CONTRACT.kind === "odd"
        ? undefined
        : LOCKED_CONTRACT.digit;

      const payoutQuote = await resolveRecoveryPayout({
        symbol: LOCKED_SYMBOL,
        contractType: LOCKED_TYPE,
        barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      const payout = payoutQuote.payoutMultiplier || killShotPayout(LOCKED_CONTRACT);

      if (inRecovery) {
        try {
          const fresh = await db.select().from(settingsTable)
            .where(eq(settingsTable.sessionId, ownerSessionId)).limit(1);
          if (fresh.length > 0) {
            const v = Number((fresh[0] as any).botRecoveryMarkup);
            if (Number.isFinite(v)) botRecoveryMarkup = v;
          }
        } catch { /* keep the previous value */ }
      }

      // Shared recovery stake formula — byte-identical to the other six bots.
      const stake = inRecovery
        ? recoveryEngine.getBotRecoveryStake(config.stake, maxStake, availableBalance, payout, botRecoveryMarkup)
        : config.stake;

      const sharedStep = recoveryEngine.getState().recoveryStep;
      session.hunt.phase = "firing";
      session.currentStake = stake;
      session.currentMarket = config.displayName;
      session.currentContractType = killShotLabel(LOCKED_CONTRACT);
      session.message = inRecovery
        ? `🎯 KILL SHOT [Recovery R${sharedStep}] ${killShotLabel(LOCKED_CONTRACT)} on ${config.displayName} · $${stake.toFixed(2)} · ${read.confidence}% conf`
        : `🎯 KILL SHOT ${killShotLabel(LOCKED_CONTRACT)} on ${config.displayName} · $${stake.toFixed(2)} · ${read.confidence}% conf · ${read.sprt.oddsForEdge.toFixed(0)}:1 odds`;
      broadcast();

      const reason = `[${BOT_NAME}${inRecovery ? " RECOVERY" : ""}] ${killShotLabel(LOCKED_CONTRACT)} · ` +
        `conf ${read.confidence}% · p̂ ${(read.pWin * 100).toFixed(1)}% (floor ${(read.pLower * 100).toFixed(1)}%) · ` +
        `SPRT ${read.sprt.logLR}/${read.sprt.upper} nats · ξ ${read.loss.clusterRatio.toFixed(2)} · ` +
        `${read.concordance.agreeing}/${read.concordance.total} horizons · watched ${session.hunt.ticksWatched} ticks`;

      const [journaled] = await db.insert(tradesTable).values({
        sessionId: ownerSessionId,
        symbol: LOCKED_SYMBOL,
        displayName: config.displayName,
        contractType: LOCKED_TYPE,
        barrier: barrier ?? null,
        stake: String(Math.round(stake * 100) / 100),
        direction: "hold",
        status: "open",
        aiConfidence: String(read.confidence),
        aiRiskScore: "20",
        isAutonomous: true,
        agentReasoning: `${paperTradeMode ? "[PAPER] " : ""}${reason}`,
        duration: 1,
        durationUnit: "t",
      }).returning();

      // ── Execute ────────────────────────────────────────────────────────────
      let won: boolean;
      let profit: number;
      let entryPrice = tickManager.getLatestPrice(LOCKED_SYMBOL) ?? 0;
      let exitPrice = entryPrice;

      if (isLive) {
        try {
          const liveResult = await executeLiveTrade(token!, {
            symbol: LOCKED_SYMBOL,
            contractType: LOCKED_TYPE,
            stake: Math.round(stake * 100) / 100,
            duration: 1,
            durationUnit: "t",
            currency,
            accountId: accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            ...(barrier !== undefined ? { barrier } : {}),
          } as any);
          const result = await waitForContractResult(
            token!, accounts[0]!.derivAccountId ?? accounts[0]!.loginId,
            liveResult.contractId, 30_000,
          );
          won = result.won;
          profit = result.profit;
          entryPrice = Number(result.entrySpot) || liveResult.buyPrice;
          exitPrice = Number(result.exitSpot) || entryPrice;
        } catch (err) {
          logger.warn({ err }, "Kill-Shot live execution error — returning to the hunt");
          try {
            await db.update(tradesTable).set({
              status: "error", profit: "0", payout: "0", closedAt: new Date(),
              agentReasoning: `${reason} [EXECUTION FAILED: ${friendlyErrorMessage(err, { max: 200 })}]`,
            }).where(eq(tradesTable.id, journaled!.id));
          } catch { /* best-effort */ }
          session.hunt.phase = "waiting";
          session.message = `🔁 Shot aborted — ${friendlyErrorMessage(err)}. Back to watching.`;
          broadcast();
          await sleep(2000);
          continue;
        }
      } else {
        // Paper mode settles against the market's REAL next digit — this bot's
        // entire thesis is the digit stream, so a coin flip would be meaningless.
        session.hunt.phase = "settling";
        const before = tickManager.getDigits(LOCKED_SYMBOL, 1)[0];
        let digit = before;
        for (let i = 0; i < 40; i++) {
          await sleep(120);
          const d = tickManager.getDigits(LOCKED_SYMBOL, 1)[0];
          if (d !== undefined && d !== before) { digit = d; break; }
          digit = d;
        }
        const d = digit ?? 0;
        won = LOCKED_WINSET.has(d);
        profit = won ? stake * (payout - 1) : -stake;
      }

      // ── Bookkeeping ────────────────────────────────────────────────────────
      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) { session.winCount++; session.lastResult = "won"; }
      else { session.lossCount++; session.lastResult = "lost"; }

      // The ONE shared ledger — same call, same semantics, as every other bot.
      recoveryEngine.recordOutcome(won, profit, stake, config.maxRecoverySteps, LOCKED_TYPE, payout);

      if (inRecovery) {
        session.consecutiveRecoveryLosses = won ? 0 : session.consecutiveRecoveryLosses + 1;
        if (!recoveryEngine.isInRecovery()) session.consecutiveRecoveryLosses = 0;
      }

      try {
        await db.update(tradesTable).set({
          status: won ? "won" : "lost",
          payout: String(won ? Math.round((stake + profit) * 100) / 100 : 0),
          profit: String(Math.round(profit * 100) / 100),
          entryPrice: String(entryPrice),
          exitPrice: String(exitPrice),
          closedAt: new Date(),
        }).where(eq(tradesTable.id, journaled!.id));
      } catch (dbErr) {
        logger.warn({ dbErr }, "Kill-Shot: failed to settle journaled trade");
      }

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + profit);
      }
      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!, accounts[0]?.derivAccountId ?? accounts[0]?.loginId);
          if (newBal !== null && accounts.length > 0) {
            availableBalance = newBal;
            await db.update(accountsTable)
              .set({ balance: String(newBal), updatedAt: new Date() })
              .where(eq(accountsTable.id, accounts[0]!.id));
          }
        } catch { /* best-effort */ }
      }

      // Reset the hunt: the next shot must earn its own evidence from scratch.
      session.hunt = { ...freshHunt(), setupsRejected: session.hunt.setupsRejected };
      session.message = won
        ? `✅ Kill shot landed — +$${profit.toFixed(2)}. Returning to the hunt.`
        : `❌ Shot missed — -$${Math.abs(profit).toFixed(2)}. Recovery armed; the next shot waits for full evidence.`;
      broadcast();

      // ── Boundaries ─────────────────────────────────────────────────────────
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached in ${session.tradeCount} shots.`;
        broadcast();
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        return;
      }
      if (config.maxTrades > 0 && session.tradeCount >= config.maxTrades) {
        session.running = false;
        session.message = `🏁 Shot limit reached (${config.maxTrades}). Session complete — P&L ${session.totalProfit >= 0 ? "+" : "-"}$${Math.abs(session.totalProfit).toFixed(2)}.`;
        broadcast();
        return;
      }

      // Cool-down before hunting again. Deliberately long: fresh, independent
      // evidence is the whole product, and re-firing on the same accumulated
      // window would be double-counting the evidence that justified this shot.
      await sleep(won ? 2500 : 3500);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "Kill-Shot stability catch");
      session.message = `Stabilizing engine — retry ${consecutiveErrors}/5`;
      broadcast();
      await sleep(Math.min(3000, 600 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for stability check — please restart";
        broadcast();
        return;
      }
    }
  }

  if (!session.running
      && !session.message?.startsWith("✅")
      && !session.message?.startsWith("🛑")
      && !session.message?.startsWith("🏁")
      && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}
