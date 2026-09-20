/** Tick-driven Nexus lifecycle. Broker/storage/feed are injected for safety tests. */
import { type DigitSnapshot, type DigitTick } from "./digit-tape";
import {
  decideNexus,
  type NexusDecision,
  type NexusEvaluation,
  type NexusPrediction,
} from "./match-nexus-analysis";
import {
  assertNexusTick,
  MATCH_NEXUS_BOT_ID,
  MATCH_NEXUS_BOT_NAME,
  nexusStake,
  type NexusScanInput,
} from "./match-nexus-policy";
import { type RecoveryState } from "./agents/recovery-engine";
import { addMoney } from "./recovery-math";

export interface NexusMarket extends NexusEvaluation {
  symbol: string;
  displayName: string;
  tick: DigitTick;
  source: "live" | "simulated";
  historySource: "broker" | "buffer" | "simulated";
  valid: boolean;
  waitedTicks: number;
  refreshedAtSequence: number;
}
export interface NexusOrder {
  symbol: string;
  displayName: string;
  contractType: "DIGITMATCH";
  barrier: number;
  duration: 1;
  durationUnit: "t";
  stake: number;
  tick: DigitTick;
  decision: NexusDecision;
}
export interface NexusQuote {
  id: string;
  askPrice: number;
  payout: number;
  receivedAt: number;
  order: NexusOrder;
}
export interface NexusPurchase {
  contractId: string;
  buyPrice: number;
  startedAtMs?: number;
}
export interface NexusOutcome {
  won: boolean;
  profit: number;
  entryPrice?: number;
  exitPrice?: number;
}
export class NexusRejected extends Error {}
/** Paper has no external position to drain when the next tick was lost. */
export class NexusPaperFeedError extends Error {}
export type NexusPhase =
  | "watching"
  | "quoting"
  | "buying"
  | "settling"
  | "attention"
  | "stopped";
export interface NexusRuntime {
  now(): number;
  snapshot(symbol: string): DigitSnapshot | null;
  periodMs(symbol: string): number;
  subscribe(listener: (symbol: string) => void): () => void;
  owns(): boolean;
  /** Must also verify the originally selected account remains active. */
  risk(): Promise<{ balance: number; maxStake: number; markupPercent: number }>;
  recovery(): RecoveryState;
  refresh(market: NexusMarket): Promise<NexusMarket | null>;
  quote(order: NexusOrder, guard: () => void): Promise<NexusQuote>;
  createIntent(order: NexusOrder): Promise<number>;
  confirmIntent(intent: number, purchase: NexusPurchase): Promise<void>;
  cancelIntent(intent: number, reason: string): Promise<void>;
  buy(
    quote: NexusQuote,
    guard: () => void,
    onSent: () => void,
  ): Promise<NexusPurchase>;
  settle(
    purchase: NexusPurchase,
    order: NexusOrder,
    payout: number,
  ): Promise<NexusOutcome>;
  /** An uncertain send may ONLY be recovered by a confirmed broker receipt. */
  findPurchase(intent: number): Promise<NexusPurchase | null>;
  /** Atomic/idempotent journal + recovery commit. Paper implementation is isolated. */
  commit(
    intent: number,
    outcome: NexusOutcome,
    stake: number,
    payout: number,
  ): Promise<void>;
  delay(ms: number): Promise<void>;
  publish(status: NexusStatus): void;
  release(): void;
}
export interface NexusTelemetry {
  phase: NexusPhase;
  executionMode: "paper" | "live";
  marketMode: "locked" | "switching";
  activity: NexusScanInput["activity"];
  source: string;
  symbol: string;
  digit: number | null;
  prediction: NexusPrediction | null;
  decision: NexusDecision | null;
  validation: NexusMarket["validation"] | null;
  risk: NexusMarket["risk"] | null;
  stopRequested: boolean;
  pendingContractId: string | null;
  ticksObserved: number;
  switches: number;
  entriesSkipped: number;
  analysisMs: number;
  quoteMs: number | null;
  buyMs: number | null;
  signalToSendMs: number | null;
  executionP95Ms: number | null;
  tickAgeMs: number | null;
  headroomMs: number | null;
  lastEntryAligned: boolean | null;
  recentTrades: Array<{
    digit: number;
    symbol: string;
    won: boolean;
    profit: number;
    at: number;
  }>;
  markets: Array<{
    symbol: string;
    displayName: string;
    digit: number;
    p: number;
    utility: number;
    ready: boolean;
    source: string;
  }>;
}
export interface NexusStatus {
  running: boolean;
  botId: string;
  botName: string;
  sessionId: string;
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
  currentMarket: string;
  currentContractType: string;
  lastResult?: "won" | "lost";
  message: string;
  config: {
    stake: number;
    stopLoss: number;
    takeProfit: number;
    maxRecoverySteps: number;
    recoveryAutoMode: boolean;
    recoveryMultiplier: number;
    recoveryMethod: string;
    contractTypes: string[];
    barriers: number[];
    lockedBarrier?: number;
    marketMode: string;
    lockedSymbol?: string;
  };
  nexus: NexusTelemetry;
}

const errorMessage = (err: unknown) =>
  err instanceof Error
    ? err.message.slice(0, 220)
    : "Unexpected execution error";
const percentile95 = (xs: number[]) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[
        Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)
      ]!
    : null;

/** Same generation/sequence, not digit or price equality, defines a new tick. */
export function advanceNexusMarket(
  market: NexusMarket,
  snapshot: DigitSnapshot | null,
): number {
  if (!snapshot) return 0;
  if (
    snapshot.tick.source !== market.tick.source ||
    snapshot.tick.generation !== market.tick.generation ||
    snapshot.tick.sequence < market.tick.sequence
  ) {
    market.valid = false;
    return 0;
  }
  const pending = snapshot.ticks.filter(
    (t) => t.sequence > market.tick.sequence,
  );
  for (const tick of pending) {
    if (
      tick.sequence !== market.tick.sequence + 1 ||
      tick.generation !== market.tick.generation ||
      tick.source !== market.tick.source
    ) {
      market.valid = false;
      return 0;
    }
    market.model.observe(tick.digit);
    market.tick = tick;
    market.waitedTicks++;
  }
  if (pending.length) {
    market.prediction = market.model.predict(market.policy.calibration);
    market.decision = decideNexus(
      market.prediction,
      market.policy,
      market.decision.payout,
      market.waitedTicks,
    );
  }
  return pending.length;
}

/** Locked means the SYMBOL is immutable; automatic digit selection still adapts. */
export function selectNexusMarket(
  markets: NexusMarket[],
  mode: "locked" | "switching",
  lockedSymbol: string,
  currentSymbol: string,
  ticksOnMarket: number,
): NexusMarket | undefined {
  const eligible = markets.filter(
    (m) => m.valid && (mode === "switching" || m.symbol === lockedSymbol),
  );
  const current = eligible.find((m) => m.symbol === currentSymbol);
  if (mode === "locked") return eligible[0];
  const best = [...eligible].sort(
    (a, b) =>
      Number(b.decision.ready) - Number(a.decision.ready) ||
      b.decision.utility - a.decision.utility,
  )[0];
  if (!best || !current) return best;
  if (
    best.symbol !== current.symbol &&
    (ticksOnMarket < 6 ||
      (current.decision.ready &&
        best.decision.utility < current.decision.utility + 0.03))
  )
    return current;
  return best;
}

/**
 * A runner owns one immutable session. Stop cannot replace its state while a
 * buy/settlement promise is in flight. Ownership survives ambiguous purchases
 * and is released ONLY when no order can still debit the account.
 */
export class NexusRunner {
  private running = true;
  private stopping = false;
  private busy = false;
  private phase: NexusPhase = "watching";
  private message = "Watching fresh ticks; no order is sent on deploy";
  private unsubscribe: (() => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private currentSymbol: string;
  private ticksOnMarket = 0;
  private totalProfit = 0;
  private trades = 0;
  private wins = 0;
  private losses = 0;
  private stake = 0;
  private lastResult?: "won" | "lost";
  private ticksObserved = 0;
  private switches = 0;
  private skipped = 0;
  private analysisMs = 0;
  private quoteMs: number | null = null;
  private buyMs: number | null = null;
  private signalToSendMs: number | null = null;
  private latencies: number[] = [];
  private pendingContractId: string | null = null;
  private lastEntryAligned: boolean | null = null;
  private attempted = new Map<string, string>();
  private refreshing = new Set<string>();
  private recentTrades: NexusTelemetry["recentTrades"] = [];
  private lastPublishedAt = 0;
  private lastPublishedMessage = "";
  private task: Promise<void> = Promise.resolve();

  constructor(
    readonly id: string,
    readonly config: NexusScanInput,
    readonly marketMode: "locked" | "switching",
    readonly selectedSymbol: string,
    private markets: NexusMarket[],
    private runtime: NexusRuntime,
  ) {
    this.currentSymbol = selectedSymbol;
    this.stake = config.stake;
  }

  start(): void {
    this.unsubscribe = this.runtime.subscribe((symbol) => this.onTick(symbol));
    this.heartbeat = setInterval(() => {
      if (!this.busy && this.running) {
        const m = this.current();
        if (!m || !this.isFresh(m))
          this.message =
            "Waiting for fresh market data; stale or simulated data cannot authorize live orders";
        this.publish();
      }
    }, 1000);
    this.heartbeat.unref?.();
    this.publish(true);
  }
  get isRunning(): boolean {
    return this.running;
  }
  /** Useful for deterministic lifecycle tests; does not start another task. */
  whenIdle(): Promise<void> {
    return this.task;
  }
  private current(): NexusMarket | undefined {
    return this.markets.find((m) => m.symbol === this.currentSymbol);
  }
  private guard(market: NexusMarket, tick: DigitTick): void {
    assertNexusTick({
      analysed: tick,
      current: this.runtime.snapshot(market.symbol)?.tick,
      now: this.runtime.now(),
      periodMs: this.runtime.periodMs(market.symbol),
      live: this.config.executionMode === "live",
      stopped: this.stopping || !this.running,
      owns: this.runtime.owns(),
      latencyBudgetMs: Math.max(
        250,
        (percentile95(this.latencies) ?? 150) * 1.25 + 60,
      ),
    });
  }
  private isFresh(m: NexusMarket): boolean {
    try {
      this.guard(m, m.tick);
      return m.valid;
    } catch {
      return false;
    }
  }

  private onTick(symbol: string): void {
    if (!this.running) return;
    const began = performance.now();
    const m = this.markets.find((row) => row.symbol === symbol);
    if (!m) return;
    try {
      const advanced = advanceNexusMarket(m, this.runtime.snapshot(symbol));
      this.ticksObserved += advanced;
      if (symbol === this.currentSymbol) this.ticksOnMarket += advanced;
      if (
        (!m.valid || m.tick.sequence - m.refreshedAtSequence >= 192) &&
        !this.refreshing.has(symbol)
      )
        this.refresh(m);
      this.analysisMs = Number((performance.now() - began).toFixed(3));
      if (this.busy || this.stopping) return;
      this.chooseAndExecute();
    } catch (err) {
      this.message = `Data update paused: ${errorMessage(err)}`;
      m.valid = false;
      this.publish(true);
    }
  }
  private refresh(m: NexusMarket): void {
    if (this.refreshing.size >= 2) return;
    this.refreshing.add(m.symbol);
    void this.runtime
      .refresh(m)
      .then((fresh) => {
        if (!this.running || !fresh) return;
        advanceNexusMarket(fresh, this.runtime.snapshot(m.symbol));
        const index = this.markets.findIndex((row) => row.symbol === m.symbol);
        if (index >= 0) this.markets[index] = fresh;
      })
      .catch(() => {
        /* keep the current causal model; never bridge a broken tape */
      })
      .finally(() => this.refreshing.delete(m.symbol));
  }
  private chooseAndExecute(): void {
    const fresh = this.markets.filter((m) => this.isFresh(m));
    const chosen = selectNexusMarket(
      fresh,
      this.marketMode,
      this.selectedSymbol,
      this.currentSymbol,
      this.ticksOnMarket,
    );
    if (!chosen) {
      this.message = "Waiting for a fresh, source-verified tick";
      this.publish();
      return;
    }
    if (chosen.symbol !== this.currentSymbol) {
      this.currentSymbol = chosen.symbol;
      this.ticksOnMarket = 0;
      this.switches++;
    }
    this.message = chosen.decision.reason;
    const key = `${chosen.tick.generation}:${chosen.tick.sequence}`;
    if (!chosen.decision.ready || this.attempted.get(chosen.symbol) === key) {
      this.publish();
      return;
    }
    this.attempted.set(chosen.symbol, key);
    this.busy = true;
    // Copy the decision/tick NOW. Subsequent ticks keep training, but cannot
    // rewrite the prediction which authorized an outstanding quote.
    const tick = { ...chosen.tick },
      decision = { ...chosen.decision };
    this.task = this.execute(chosen, tick, decision)
      .catch((err) => {
        // execute handles sent orders internally; this is pre-entry/storage failure.
        this.message = `Session paused safely: ${errorMessage(err)}`;
        this.stopping = true;
      })
      .finally(() => {
        this.busy = false;
        if (this.stopping) this.finish();
        else {
          this.phase = "watching";
          this.publish(true);
        }
      });
  }

  private async execute(
    market: NexusMarket,
    tick: DigitTick,
    decision: NexusDecision,
  ): Promise<void> {
    let intent: number | null = null;
    let sent = false;
    let purchase: NexusPurchase | null = null;
    let payout = decision.payout;
    let order: NexusOrder | null = null;
    try {
      let risk: Awaited<ReturnType<NexusRuntime["risk"]>>;
      try {
        risk = await this.runtime.risk();
      } catch (err) {
        this.message = `Risk/account check stopped the session: ${errorMessage(err)}`;
        this.stopping = true;
        return;
      }
      const debt = this.runtime.recovery().unrecoveredAmount;
      const stakeFor = (multiplier: number) =>
        nexusStake({
          baseStake: this.config.stake,
          debt,
          payout: multiplier,
          markupPercent: risk.markupPercent,
          maxStake: risk.maxStake,
          balance: risk.balance,
          remainingStop: this.config.stopLoss + this.totalProfit,
        });
      let stake: number;
      try {
        stake = stakeFor(payout);
      } catch (err) {
        this.message = `Risk stop: ${errorMessage(err)}`;
        this.stopping = true;
        return;
      }
      this.guard(market, tick);
      const guard = () => this.guard(market, tick);
      order = {
        symbol: market.symbol,
        displayName: market.displayName,
        contractType: "DIGITMATCH",
        barrier: decision.digit,
        duration: 1,
        durationUnit: "t",
        stake,
        tick,
        decision,
      };
      this.phase = "quoting";
      this.message = `Pricing Matches ${order.barrier} on ${order.displayName}`;
      this.publish(true);
      let began = this.runtime.now();
      let quote = await this.runtime.quote(order, guard);
      this.quoteMs = this.runtime.now() - began;
      guard();
      payout = quote.payout / quote.askPrice;
      const resized = stakeFor(payout);
      if (Math.abs(resized - stake) >= 0.009) {
        // The exact broker payout, not a cached nominal multiplier, sizes recovery.
        order = { ...order, stake: resized };
        quote = await this.runtime.quote(order, guard);
        guard();
        payout = quote.payout / quote.askPrice;
        if (Math.abs(stakeFor(payout) - resized) >= 0.009)
          throw new Error(
            "Payout changed while sizing recovery; wait for the next tick",
          );
      }
      if (
        ![quote.askPrice, quote.payout].every(Number.isFinite) ||
        quote.askPrice <= 0 ||
        quote.payout <= quote.askPrice ||
        Math.abs(quote.askPrice - order.stake) > 0.001
      )
        throw new Error("Broker returned an invalid or mismatched quote");
      const quotedDecision = {
        ...decision,
        payout,
        breakEven: 1 / payout,
        expectedValue: decision.p * payout - 1,
        utility: decision.conservativeP * payout - 1,
      };
      if (quotedDecision.utility < decision.threshold)
        throw new Error(
          "The actual broker payout no longer clears the entry value",
        );
      order.decision = quotedDecision;
      // A quote is never carried into the next tick or used for another digit.
      if (
        quote.order.symbol !== order.symbol ||
        quote.order.barrier !== order.barrier ||
        quote.order.contractType !== "DIGITMATCH"
      )
        throw new Error(
          "Quote contract does not match the analysed Matches entry",
        );
      intent = await this.runtime.createIntent(order);
      this.guard(market, tick);
      this.stake = order.stake;
      this.phase = "buying";
      this.message = `Submitting one Matches ${order.barrier} order`;
      this.publish(true);
      began = this.runtime.now();
      purchase = await this.runtime.buy(
        quote,
        () => {
          guard();
          if (
            this.runtime.now() - quote.receivedAt >
            this.runtime.periodMs(market.symbol)
          )
            throw new Error("Quote expired before send");
        },
        () => {
          sent = true;
          market.waitedTicks = 0;
          this.signalToSendMs = this.runtime.now() - tick.receivedAt;
        },
      );
      this.buyMs = this.runtime.now() - began;
      this.latencies.push(this.buyMs);
      if (this.latencies.length > 100) this.latencies.shift();
    } catch (err) {
      if (sent && !(err instanceof NexusRejected)) {
        // A timeout is NOT a rejection. There is deliberately no buy retry.
        this.phase = "attention";
        this.message =
          "Purchase unconfirmed. No retry or further orders; holding execution ownership while awaiting a confirmed broker receipt.";
        this.publish(true);
        while (!purchase) {
          await this.runtime.delay(5000);
          try {
            if (intent !== null)
              purchase = await this.runtime.findPurchase(intent);
          } catch (lateError) {
            if (lateError instanceof NexusRejected && intent !== null) {
              await this.runtime.cancelIntent(intent, errorMessage(lateError));
              this.skipped++;
              this.message =
                "Broker confirmed the delayed purchase was rejected; no outcome or debt recorded";
              return;
            }
            // No unambiguous receipt yet: keep holding, never guess/retry.
          }
        }
      } else {
        if (intent !== null)
          await this.runtime.cancelIntent(intent, errorMessage(err));
        this.skipped++;
        this.message = this.stopping
          ? "Stopping; unsent entry cancelled"
          : `Entry skipped: ${errorMessage(err)}`;
        return;
      }
    }
    if (!purchase || !order || intent === null)
      throw new Error("Missing purchase intent");
    this.pendingContractId = purchase.contractId;
    this.lastEntryAligned = purchase.startedAtMs
      ? purchase.startedAtMs >= tick.epoch * 1000 &&
        purchase.startedAtMs <
          tick.epoch * 1000 + this.runtime.periodMs(market.symbol)
      : null;
    // Even stop must drain a sent order. Persist its ID before polling results.
    for (;;) {
      try {
        await this.runtime.confirmIntent(intent, purchase);
        break;
      } catch {
        this.phase = "attention";
        this.message =
          "Purchase confirmed; retrying durable contract-ID storage. No further orders.";
        this.publish(true);
        await this.runtime.delay(2000);
      }
    }
    let outcome: NexusOutcome;
    for (;;) {
      this.phase = "settling";
      this.message = this.stopping
        ? "Stop requested; finishing the already-sent contract before releasing ownership"
        : `Awaiting confirmed settlement for ${purchase.contractId}`;
      this.publish(true);
      try {
        outcome = await this.runtime.settle(purchase, order, payout);
        if (
          !Number.isFinite(outcome.profit) ||
          (outcome.won && outcome.profit <= 0) ||
          (!outcome.won && outcome.profit > 0)
        )
          throw new Error("Invalid broker settlement");
        break;
      } catch (err) {
        if (
          this.config.executionMode === "paper" &&
          (this.stopping || err instanceof NexusPaperFeedError)
        ) {
          this.pendingContractId = null;
          this.stopping = true;
          this.message =
            "Paper entry unscored: the next tick was unavailable. No win, loss or recovery outcome was invented.";
          return;
        }
        this.phase = "attention";
        this.message =
          "Settlement not confirmed yet; retaining the position and recovery ledger unchanged. No new orders.";
        this.publish(true);
        await this.runtime.delay(5000);
      }
    }
    for (;;) {
      try {
        await this.runtime.commit(intent, outcome, purchase.buyPrice, payout);
        break;
      } catch {
        this.phase = "attention";
        this.message =
          "Settlement received; retrying atomic journal/recovery commit. No further orders.";
        this.publish(true);
        await this.runtime.delay(2000);
      }
    }
    this.pendingContractId = null;
    this.trades++;
    this.totalProfit = addMoney(this.totalProfit, outcome.profit);
    this.wins += Number(outcome.won);
    this.losses += Number(!outcome.won);
    this.lastResult = outcome.won ? "won" : "lost";
    this.recentTrades = [
      ...this.recentTrades,
      {
        digit: order.barrier,
        symbol: order.symbol,
        won: outcome.won,
        profit: outcome.profit,
        at: this.runtime.now(),
      },
    ].slice(-16);
    this.message = `${this.config.executionMode === "paper" ? "Paper " : ""}${outcome.won ? "match" : "miss"} settled; ${this.runtime.recovery().inRecovery ? "shared Matches recovery sizing on the next qualified entry" : "base stake restored"}`;
    if (this.totalProfit >= this.config.takeProfit) {
      this.message = "Take-profit target reached; session complete";
      this.stopping = true;
    }
    if (
      this.totalProfit <= -this.config.stopLoss ||
      this.config.stopLoss + this.totalProfit < 0.35
    ) {
      this.message = "Stop-loss budget exhausted; session complete";
      this.stopping = true;
    }
  }

  stop(): void {
    if (!this.running) return;
    this.stopping = true;
    this.message = this.busy
      ? "Stop requested; cancelling unsent orders and draining any already-sent contract"
      : "Session stopped by user";
    if (!this.busy) this.finish();
    else this.publish(true);
  }
  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.phase = "stopped";
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.runtime.release();
    // A completed session keeps its visible market/report, not an entire scan pool.
    this.markets = this.markets.filter((m) => m.symbol === this.currentSymbol);
    this.publish(true);
  }
  private publish(force = false): void {
    const now = this.runtime.now();
    if (
      !force &&
      now - this.lastPublishedAt < 400 &&
      this.message === this.lastPublishedMessage
    )
      return;
    this.lastPublishedAt = now;
    this.lastPublishedMessage = this.message;
    this.runtime.publish(this.status());
  }
  status(): NexusStatus {
    const rec = this.runtime.recovery(),
      m = this.current();
    const age = m ? Math.max(0, this.runtime.now() - m.tick.receivedAt) : null;
    return {
      running: this.running,
      botId: MATCH_NEXUS_BOT_ID,
      botName: MATCH_NEXUS_BOT_NAME,
      sessionId: this.id,
      totalProfit: this.totalProfit,
      tradeCount: this.trades,
      winCount: this.wins,
      lossCount: this.losses,
      currentStake: this.stake,
      inRecovery: rec.inRecovery,
      recoveryStep: rec.recoveryStep,
      unrecoveredAmount: rec.unrecoveredAmount,
      recoveryTargetProfit: rec.targetProfit,
      recoveryRemainingTargetProfit: rec.remainingTargetProfit,
      consecutiveRecoveryLosses: rec.consecutiveMatchLosses,
      currentMarket: m?.displayName ?? this.currentSymbol,
      currentContractType: `Matches ${m?.decision.digit ?? "—"}`,
      lastResult: this.lastResult,
      message: this.message,
      config: {
        stake: this.config.stake,
        stopLoss: this.config.stopLoss,
        takeProfit: this.config.takeProfit,
        maxRecoverySteps: this.config.maxRecoverySteps,
        recoveryAutoMode: true,
        recoveryMultiplier: 1.62,
        recoveryMethod: "instant",
        contractTypes: ["DIGITMATCH"],
        barriers: [],
        lockedBarrier: this.config.digit,
        marketMode: this.marketMode,
        lockedSymbol:
          this.marketMode === "locked" ? this.selectedSymbol : undefined,
      },
      nexus: {
        phase: this.phase,
        executionMode: this.config.executionMode,
        marketMode: this.marketMode,
        activity: this.config.activity,
        source: m?.source ?? "unavailable",
        symbol: this.currentSymbol,
        digit: m?.decision.digit ?? null,
        prediction: m?.prediction ?? null,
        decision: m?.decision ?? null,
        validation: m?.validation ?? null,
        risk: m?.risk ?? null,
        stopRequested: this.stopping,
        pendingContractId: this.pendingContractId,
        ticksObserved: this.ticksObserved,
        switches: this.switches,
        entriesSkipped: this.skipped,
        analysisMs: this.analysisMs,
        quoteMs: this.quoteMs,
        buyMs: this.buyMs,
        signalToSendMs: this.signalToSendMs,
        executionP95Ms: percentile95(this.latencies),
        tickAgeMs: age,
        headroomMs:
          age === null
            ? null
            : Math.max(0, this.runtime.periodMs(this.currentSymbol) - age),
        lastEntryAligned: this.lastEntryAligned,
        recentTrades: [...this.recentTrades],
        markets: this.markets
          .map((row) => ({
            symbol: row.symbol,
            displayName: row.displayName,
            digit: row.decision.digit,
            p: row.decision.p,
            utility: row.decision.utility,
            ready: row.valid && row.decision.ready,
            source: row.source,
          }))
          .sort((a, b) => b.utility - a.utility)
          .slice(0, 6),
      },
    };
  }
}
