/**
 * Omni Sentinel's causal, multi-contract opportunity tournament.
 *
 * All probabilities are estimates, not promises of an edge. Five categorical
 * experts (fair prior, slow/fast marginals, order-1/2 Markov backoff) are mixed
 * using ONLY their past prequential log loss. A shrunk reliability correction
 * and a continuous search-breadth penalty temper noisy winners. Flat price
 * ticks are a third outcome, never silently counted as Rise or Fall.
 *
 * Recovery changes the OBJECTIVE, not an entry threshold: expected log return,
 * probability of paying debt, quote-sized exposure and measured loss pairs.
 * There is one fixed opportunity rule: utility > 0. No loss-count/step argument,
 * ratchet, forced trade, losing-digit ban, or post-loss cooldown exists here.
 */
import { getFallbackPayout } from "./payouts";
import {
  calculateBotRecoveryStake,
  roundRecoveryStakeUp,
  settleRecoveryWin,
} from "./recovery-math";

export const OMNI_CONTRACT_TYPES = [
  "CALL",
  "PUT",
  "DIGITEVEN",
  "DIGITODD",
  "DIGITDIFF",
  "DIGITMATCH",
  "DIGITOVER",
  "DIGITUNDER",
] as const;
export type OmniContractType = (typeof OMNI_CONTRACT_TYPES)[number];
export const OMNI_MIN_HISTORY = 160;
export const OMNI_HISTORY = 2400;
export const OMNI_UTILITY_FLOOR = 0;
export const OMNI_PAPER_BALANCE = 1000;

export interface OmniContract {
  id: string;
  contractType: OmniContractType;
  barrier?: number;
  label: string;
  fair: number;
}
export interface OmniSample {
  price: number;
  digit: number;
}
export interface OmniPrediction {
  contract: OmniContract;
  probability: number;
  rawProbability: number;
  uncertainty: number;
  lossAfterLoss: number;
  samples: number;
  expertWeights: number[];
}
export interface OmniRisk {
  baseStake: number;
  debt: number;
  markupPercent: number;
  balance: number;
  maxStake: number;
  lossBudget: number;
}
export interface OmniOpportunity extends OmniPrediction {
  symbol: string;
  displayName: string;
  payout: number;
  quoteSource: "live" | "indicative";
  stake: number;
  breakEven: number;
  expectedValue: number;
  lossPairRisk: number;
  debtCoverage: number;
  utility: number;
  ready: boolean;
  reason: string;
}
export interface OmniReplay {
  ticks: number;
  normalShots: number;
  normalWins: number;
  recoveryShots: number;
  recoveryWins: number;
  recoveryLossPairs: number;
  profit: number;
  remainingDebt: number;
  maxStake: number;
  stoppedByRisk: boolean;
}

const clamp = (p: number, lo = 1e-6, hi = 1 - 1e-6) =>
  Math.max(lo, Math.min(hi, p));
const normalize = (xs: number[]) => {
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.map((x) => x / sum);
};
const direction = (before: number, after: number) =>
  after < before ? 0 : after === before ? 1 : 2;

export function omniContracts(
  enabled: readonly OmniContractType[],
): OmniContract[] {
  const out: OmniContract[] = [];
  for (const type of OMNI_CONTRACT_TYPES.filter((t) => enabled.includes(t))) {
    const add = (label: string, fair: number, barrier?: number) =>
      out.push({
        id: `${type}${barrier === undefined ? "" : `:${barrier}`}`,
        contractType: type,
        label,
        fair,
        ...(barrier === undefined ? {} : { barrier }),
      });
    if (type === "CALL") add("Rise", 0.5);
    else if (type === "PUT") add("Fall", 0.5);
    else if (type === "DIGITEVEN") add("Even", 0.5);
    else if (type === "DIGITODD") add("Odd", 0.5);
    else if (type === "DIGITMATCH" || type === "DIGITDIFF") {
      for (let d = 0; d < 10; d++)
        add(
          `${type === "DIGITMATCH" ? "Matches" : "Differs"} ${d}`,
          type === "DIGITMATCH" ? 0.1 : 0.9,
          d,
        );
    } else if (type === "DIGITOVER") {
      for (let d = 0; d <= 8; d++) add(`Over ${d}`, (9 - d) / 10, d);
    } else {
      for (let d = 1; d <= 9; d++) add(`Under ${d}`, d / 10, d);
    }
  }
  return out;
}

/** Which leg of the session an opportunity is being ranked for. */
export type OmniPhase = "normal" | "recovery";

/**
 * Recovery-phase instrument restriction (house rule).
 *
 * While a loss is being worked off, the engine must NOT use the far ends of the
 * digit ladder or the "Differs" digit contracts:
 *
 *   • Over 0, Over 1, Over 2        → banned in recovery
 *   • Under 7, Under 8, Under 9     → banned in recovery
 *   • Differs (DIGITDIFF, any digit)→ banned in recovery
 *
 * Everything else stays available: recovery may use Over 3–8 and Under 1–6,
 * plus Rise/Fall, Even/Odd and Matches.
 *
 * This is phase scoping, NOT post-loss tightening. The contracts are only
 * skipped while the session carries debt; whenever they are enabled they keep
 * trading normally, and no contract is ever banned after a loss in normal mode.
 * Recovery therefore chooses from a smaller instrument set, which is why the
 * blocked digits can never be re-introduced by a "best utility" argument.
 */
export const OMNI_RECOVERY_BLOCKED_OVER_BARRIERS = [0, 1, 2] as const;
export const OMNI_RECOVERY_BLOCKED_UNDER_BARRIERS = [7, 8, 9] as const;
export const OMNI_RECOVERY_BLOCKED_CONTRACT_TYPES = ["DIGITDIFF"] as const;

/** True when `contract` is allowed to be selected during the given phase. */
export function omniContractAllowedInPhase(
  contract: Pick<OmniContract, "contractType" | "barrier">,
  phase: OmniPhase,
): boolean {
  if (phase === "normal") return true;
  if (
    (OMNI_RECOVERY_BLOCKED_CONTRACT_TYPES as readonly string[]).includes(
      contract.contractType,
    )
  )
    return false;
  if (contract.contractType === "DIGITOVER")
    return !(
      OMNI_RECOVERY_BLOCKED_OVER_BARRIERS as readonly number[]
    ).includes(contract.barrier!);
  if (contract.contractType === "DIGITUNDER")
    return !(
      OMNI_RECOVERY_BLOCKED_UNDER_BARRIERS as readonly number[]
    ).includes(contract.barrier!);
  return true;
}

/** Human-readable summary of the recovery restriction, for consoles/logs. */
export function omniRecoveryRestrictionNote(): string {
  return `Recovery skips Over ${OMNI_RECOVERY_BLOCKED_OVER_BARRIERS.join(", ")}, Under ${OMNI_RECOVERY_BLOCKED_UNDER_BARRIERS.join(", ")} and Differs — those stay available in normal mode.`;
}

export function omniWins(
  contract: OmniContract,
  before: OmniSample,
  after: OmniSample,
): boolean {
  switch (contract.contractType) {
    case "CALL":
      return after.price > before.price;
    case "PUT":
      return after.price < before.price;
    case "DIGITEVEN":
      return after.digit % 2 === 0;
    case "DIGITODD":
      return after.digit % 2 === 1;
    case "DIGITMATCH":
      return after.digit === contract.barrier;
    case "DIGITDIFF":
      return after.digit !== contract.barrier;
    case "DIGITOVER":
      return after.digit > contract.barrier!;
    case "DIGITUNDER":
      return after.digit < contract.barrier!;
  }
}

/** Lazy exponential counts: O(alphabet) per updated context, not per whole tree. */
class Counts {
  private values: number[];
  private at = 0;
  constructor(
    size: number,
    private halfLife: number,
  ) {
    this.values = Array(size).fill(0);
  }
  read(time: number): number[] {
    const decay = 2 ** (-(time - this.at) / this.halfLife);
    return this.values.map((n) => n * decay);
  }
  add(value: number, time: number) {
    this.values = this.read(time);
    this.at = time;
    this.values[value]++;
  }
}

class CategoricalPool {
  private time = 0;
  private past: number[] = [];
  private slow: Counts;
  private fast: Counts;
  private contexts = new Map<string, Counts>();
  private losses = [0, 0, 0, 0, 0];
  constructor(private prior: number[]) {
    this.slow = new Counts(prior.length, 600);
    this.fast = new Counts(prior.length, 80);
  }
  private posterior(
    counts: number[],
    prior: number[],
    strength: number,
  ): number[] {
    const n = counts.reduce((a, b) => a + b, 0);
    return counts.map((v, i) => (v + strength * prior[i]!) / (n + strength));
  }
  private key(order: number): string {
    return this.past.slice(-order).join(",");
  }
  forecast() {
    const slow = this.posterior(this.slow.read(this.time), this.prior, 30);
    const fast = this.posterior(this.fast.read(this.time), slow, 24);
    const one =
      this.contexts.get(`1:${this.key(1)}`)?.read(this.time) ??
      Array(this.prior.length).fill(0);
    const two =
      this.contexts.get(`2:${this.key(2)}`)?.read(this.time) ??
      Array(this.prior.length).fill(0);
    const p1 = this.posterior(one, slow, 30);
    const p2 = this.posterior(two, p1, 45);
    const experts = [this.prior, slow, fast, p1, p2];
    const best = Math.min(...this.losses);
    const weights = normalize(
      [0.25, 0.2, 0.1, 0.3, 0.15].map(
        (w, i) => w * Math.exp(-8 * (this.losses[i]! - best)),
      ),
    );
    const p = this.prior.map((_, v) =>
      experts.reduce((s, e, i) => s + weights[i]! * e[v]!, 0),
    );
    return { p, experts, weights };
  }
  update(value: number) {
    const before = this.forecast();
    // Score a prediction BEFORE incorporating its outcome.
    const rate = this.time < 100 ? 1 / (this.time + 1) : 1 - 2 ** (-1 / 400);
    this.losses = this.losses.map(
      (v, i) =>
        (1 - rate) * v + rate * -Math.log(clamp(before.experts[i]![value]!)),
    );
    this.time++;
    this.slow.add(value, this.time);
    this.fast.add(value, this.time);
    for (const order of [1, 2]) {
      if (this.past.length < order) continue;
      const key = `${order}:${this.key(order)}`;
      let counts = this.contexts.get(key);
      if (!counts) {
        counts = new Counts(this.prior.length, 450);
        this.contexts.set(key, counts);
      }
      counts.add(value, this.time);
    }
    this.past.push(value);
    if (this.past.length > 2) this.past.shift();
  }
}

interface Reliability {
  count: number;
  residual: number;
  lossTransitions: number;
  lossPairs: number;
  wasLoss: boolean;
}

export class OmniModel {
  readonly contracts: OmniContract[];
  private digits = new CategoricalPool(Array(10).fill(0.1));
  private directions = new CategoricalPool([0.495, 0.01, 0.495]);
  private reliability = new Map<string, Reliability>();
  private previous: OmniSample | null = null;
  private pending: OmniPrediction[] = [];
  count = 0;

  constructor(
    enabled: readonly OmniContractType[],
    private searchBreadth = 1,
  ) {
    this.contracts = omniContracts(enabled);
    for (const c of this.contracts)
      this.reliability.set(c.id, {
        count: 0,
        residual: 0,
        lossTransitions: 0,
        lossPairs: 0,
        wasLoss: false,
      });
  }

  update(sample: OmniSample) {
    if (
      !Number.isFinite(sample.price) ||
      sample.price <= 0 ||
      !Number.isInteger(sample.digit) ||
      sample.digit < 0 ||
      sample.digit > 9
    ) {
      throw new Error("Invalid tick sample");
    }
    if (this.previous) {
      for (const prediction of this.pending) {
        const r = this.reliability.get(prediction.contract.id)!;
        const y = Number(omniWins(prediction.contract, this.previous, sample));
        const decay = 2 ** (-1 / 400);
        r.count = r.count * decay + 1;
        r.residual = r.residual * decay + (y - prediction.rawProbability);
        r.lossTransitions *= decay;
        r.lossPairs *= decay;
        if (r.wasLoss) {
          r.lossTransitions++;
          r.lossPairs += 1 - y;
        }
        r.wasLoss = y === 0;
      }
      this.directions.update(direction(this.previous.price, sample.price));
    }
    this.digits.update(sample.digit);
    this.previous = sample;
    this.count++;
    this.pending = this.predict();
  }

  predict(): OmniPrediction[] {
    const digits = this.digits.forecast();
    const prices = this.directions.forecast();
    return this.contracts.map((contract) => {
      const isPrice =
        contract.contractType === "CALL" || contract.contractType === "PUT";
      const pool = isPrice ? prices : digits;
      const probabilityOf = (distribution: number[]) => {
        if (isPrice)
          return distribution[contract.contractType === "CALL" ? 2 : 0]!;
        return distribution.reduce(
          (p, v, digit) =>
            p +
            (omniWins(contract, { price: 1, digit: 0 }, { price: 1, digit })
              ? v
              : 0),
          0,
        );
      };
      const raw = probabilityOf(pool.p);
      const r = this.reliability.get(contract.id)!;
      const corrected = clamp(raw + (0.5 * r.residual) / (r.count + 60));
      // Smooth winner's-curse shrinkage, NOT a multiple-testing pass/fail gate.
      const breadth = Math.max(1, this.searchBreadth * this.contracts.length);
      const trust = r.count / (r.count + 12 * Math.log1p(breadth));
      const probability = clamp(
        contract.fair + trust * (corrected - contract.fair),
      );
      const spread = pool.experts.reduce(
        (s, p, i) => s + pool.weights[i]! * (probabilityOf(p) - raw) ** 2,
        0,
      );
      const uncertainty = Math.sqrt(
        (probability * (1 - probability)) / (r.count + 60) + spread * 0.1,
      );
      const lossAfterLoss =
        (r.lossPairs + 30 * (1 - probability)) / (r.lossTransitions + 30);
      return {
        contract,
        probability,
        rawProbability: raw,
        uncertainty,
        lossAfterLoss,
        samples: r.count,
        expertWeights: pool.weights,
      };
    });
  }
}

/** Funding limits are absolute, including zero balance / less than broker minimum. */
export function omniStake(risk: OmniRisk, payout: number): number {
  if (
    ![
      risk.baseStake,
      risk.debt,
      risk.markupPercent,
      risk.balance,
      risk.maxStake,
      risk.lossBudget,
      payout,
    ].every(Number.isFinite) ||
    risk.baseStake < 0.35 ||
    risk.debt < 0 ||
    risk.markupPercent < 0 ||
    payout <= 1
  )
    return 0;
  const cap =
    Math.floor(
      (Math.min(risk.balance, risk.maxStake, risk.lossBudget) + 1e-9) * 100,
    ) / 100;
  if (cap < 0.35) return 0;
  // Exactly the existing bot debt+markup formula; a cap means PARTIAL recovery.
  const raw =
    risk.debt > 0
      ? calculateBotRecoveryStake(risk.debt, payout, risk.markupPercent)
      : risk.baseStake;
  if (risk.debt <= 0 && raw > cap) return 0;
  return Math.min(cap, Math.max(0.35, roundRecoveryStakeUp(raw)));
}

export function priceOmniOpportunity(
  prediction: OmniPrediction,
  market: { symbol: string; displayName: string },
  risk: OmniRisk,
  payout = getFallbackPayout(
    prediction.contract.contractType,
    prediction.contract.barrier,
  ),
  quoteSource: OmniOpportunity["quoteSource"] = "indicative",
): OmniOpportunity {
  const stake = omniStake(risk, payout);
  const p = prediction.probability;
  const lossPairRisk = (1 - p) * prediction.lossAfterLoss;
  const expectedValue = p * payout - 1;
  const debtCoverage =
    risk.debt > 0 ? Math.min(1, (stake * (payout - 1)) / risk.debt) : 1;
  const fraction = stake > 0 ? stake / risk.balance : 0;
  // Expected log-wealth prices both the probability and dollar size of a loss.
  const logReturn =
    fraction > 0 && fraction < 1
      ? (p * Math.log1p(fraction * (payout - 1)) +
          (1 - p) * Math.log1p(-fraction)) /
        fraction
      : -1;
  const inRecovery = risk.debt > 0;
  const penalty =
    0.25 * payout * prediction.uncertainty +
    (inRecovery ? 0.15 : 0.03) * lossPairRisk;
  const utility = (logReturn - penalty) * (inRecovery ? p * debtCoverage : 1);
  const finite = [
    p,
    payout,
    prediction.uncertainty,
    prediction.lossAfterLoss,
    utility,
  ].every(Number.isFinite);
  const ready =
    finite &&
    p > 0 &&
    p < 1 &&
    prediction.samples >= OMNI_MIN_HISTORY - 1 &&
    stake >= 0.35 &&
    utility > OMNI_UTILITY_FLOOR;
  const reason =
    stake < 0.35
      ? "Stake does not fit the remaining stop-loss, balance or stake limit"
      : prediction.samples < OMNI_MIN_HISTORY - 1
        ? "Collecting enough sequential observations"
        : !ready
          ? "No positive risk-adjusted opportunity at this payout — waiting, not tightening"
          : `${inRecovery ? "Recovery" : "Normal"}: positive risk-adjusted utility; ${debtCoverage < 1 ? "partial debt payment" : "quote-sized exposure"}`;
  return {
    ...prediction,
    ...market,
    payout,
    quoteSource,
    stake,
    breakEven: payout > 1 ? 1 / payout : 1,
    expectedValue,
    lossPairRisk,
    debtCoverage,
    utility: finite ? utility : -1,
    ready,
    reason,
  };
}

/**
 * One allowlist and one market scope for BOTH phases, plus the recovery-phase
 * instrument restriction (see `omniContractAllowedInPhase`). Ineligible leaders
 * cannot hide viable runners-up: a contract blocked in recovery is filtered out
 * here, so the recovery leg simply selects the best of the remaining markets and
 * barriers instead of falling back to a banned digit.
 */
export function rankOmniOpportunities(
  opportunities: readonly OmniOpportunity[],
  enabled: readonly OmniContractType[],
  lockedSymbol?: string,
  phase: OmniPhase = "normal",
): OmniOpportunity[] {
  return opportunities
    .filter(
      (c) =>
        enabled.includes(c.contract.contractType) &&
        omniContractAllowedInPhase(c.contract, phase) &&
        (!lockedSymbol || c.symbol === lockedSymbol),
    )
    .sort(
      (a, b) =>
        Number(b.ready) - Number(a.ready) ||
        b.utility - a.utility ||
        a.contract.id.localeCompare(b.contract.id) ||
        a.symbol.localeCompare(b.symbol),
    );
}

/**
 * Walk-forward diagnostic: warm on the first 60%, replay the exact single-market
 * selector on the remaining 40%. Online updates see ONLY earlier observations.
 * Indicative payouts and ideal next-tick paper fills: not a live-profit forecast.
 */
export function measureOmniHistory(
  samples: readonly OmniSample[],
  enabled: readonly OmniContractType[],
  risk: OmniRisk,
  searchBreadth: number,
) {
  const model = new OmniModel(enabled, searchBreadth);
  const metrics: OmniReplay = {
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
  };
  const split = Math.max(OMNI_MIN_HISTORY, Math.floor(samples.length * 0.6));
  let lastRecoveryLost = false;
  for (let i = 0; i < samples.length; i++) {
    if (i >= split) {
      metrics.ticks++;
      const replayRisk = {
        ...risk,
        debt: metrics.remainingDebt,
        balance: risk.balance + metrics.profit,
        lossBudget: risk.lossBudget + metrics.profit,
      };
      if (replayRisk.lossBudget < 0.35 || replayRisk.balance < 0.35)
        metrics.stoppedByRisk = true;
      if (!metrics.stoppedByRisk) {
        // The replay must mirror production: once it carries debt it ranks the
        // RECOVERY allowlist (no Over 0–2, no Under 7–9, no Differs).
        const inRecovery = metrics.remainingDebt > 0;
        const ranked = rankOmniOpportunities(
          model
            .predict()
            .map((p) =>
              priceOmniOpportunity(
                p,
                { symbol: "replay", displayName: "Replay" },
                replayRisk,
              ),
            ),
          enabled,
          undefined,
          inRecovery ? "recovery" : "normal",
        );
        const best = ranked[0];
        if (best?.ready) {
          const recovery = inRecovery;
          const won = omniWins(best.contract, samples[i - 1]!, samples[i]!);
          const profit =
            Math.round(
              (won ? best.stake * (best.payout - 1) : -best.stake) * 100,
            ) / 100;
          if (recovery) {
            metrics.recoveryShots++;
            metrics.recoveryWins += Number(won);
            if (!won && lastRecoveryLost) metrics.recoveryLossPairs++;
            lastRecoveryLost = !won;
          } else {
            metrics.normalShots++;
            metrics.normalWins += Number(won);
            lastRecoveryLost = false;
          }
          metrics.remainingDebt = won
            ? settleRecoveryWin({
                unrecoveredAmount: metrics.remainingDebt,
                remainingTargetProfit: 0,
                actualNetProfit: profit,
              }).remainingDebt
            : Math.round((metrics.remainingDebt + best.stake) * 100) / 100;
          metrics.profit = Math.round((metrics.profit + profit) * 100) / 100;
          metrics.maxStake = Math.max(metrics.maxStake, best.stake);
        }
      }
    }
    model.update(samples[i]!);
  }
  return { model, metrics };
}
