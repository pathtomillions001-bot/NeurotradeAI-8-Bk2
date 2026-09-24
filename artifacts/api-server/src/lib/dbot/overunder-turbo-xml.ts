/**
 * DBot XML compiler — Over/Under Turbo.
 *
 * WHAT THIS IS
 * ────────────
 * Takes the (market, normal barrier, recovery barrier) lock produced by the
 * Over/Under Turbo scan plus the user's session metrics and compiles it into
 * a Blockly XML strategy for the embedded Deriv bot builder (the MIT-licensed
 * deriv-com/binary-bot fork vendored at /vendor/binary-bot and served at /dbot).
 *
 * The generated bot trades EXACTLY like the in-app engine's locked mode:
 *
 *   · 1-tick Digit Over/Under contracts, back-to-back, no gating.
 *   · NORMAL leg:    fixed barrier from the scan, stake = baseStake.
 *   · RECOVERY leg:  fixed recovery barrier from the scan, stake = the app's
 *     shared formula  ceil2( debt × (1 + markup/100) / (payout − 1) ),
 *     clamped to [0.35, maxStake]  (calculateBotRecoveryStake +
 *     applyRecoveryStakeLimits in lib/recovery-math.ts).
 *   · Debt ledger:   a win's net profit repays debt first; recovery ends the
 *     instant debt ≤ 0; every loss adds its stake-sized loss to the debt.
 *     (settleRecoveryWin semantics.)
 *   · Session boundaries: stop on total ≥ takeProfit, total ≤ −stopLoss, or
 *     a consecutive-loss run ≥ maxConsecutiveLosses (the circuit breaker the
 *     engine models with its bootstrap). A stopped DBot simply never calls
 *     trade_again — the same "stop" the reference martingale.xml uses.
 *
 * SCHEMA NOTES (embedded builder = the archived Blockly 3 binary-bot):
 *   · Root is `<xml collection="false">` — NEW-style `is_dbot` documents are
 *     REJECTED by this builder (see load() in vendor/binary-bot/src/blockly).
 *   · tradeOptions AMOUNT / PREDICTION accept expression blocks that are
 *     RE-EVALUATED before every purchase (the stock martingale.xml relies on
 *     this), so stake/prediction are procedures reading our state variables
 *     and the before_purchase block only chooses WHICH side to buy.
 *   · "Stop" = reach the end of after_purchase WITHOUT calling trade_again.
 *
 * The XML is deterministic for a given spec (block ids are sequential) so the
 * route and tests can rely on stable output.
 */

import {
  TURBO_NORMAL_CONTRACTS,
  TURBO_RECOVERY_CONTRACTS,
  contractKey,
  contractLabel,
  type TurboContract,
} from "../overunder-turbo-analysis";

export interface TurboDbotSpec {
  /** Deriv symbol, e.g. "R_100" — the locked market from the scan. */
  symbol: string;
  /** Human market name for the strategy comment + filename. */
  displayName: string;
  /** Account currency for tradeOptions, e.g. "USD". */
  currency: string;
  /** Normal leg — one of Over 1/2, Under 7/8 (fixed turbo vocabulary). */
  normal: TurboContract;
  /** Recovery leg — one of Over/Under 4/5 (fixed turbo vocabulary). */
  recovery: TurboContract;
  /** Normal-leg stake (account currency units). */
  baseStake: number;
  /** Total-profit session boundary (stop when reached). */
  takeProfit: number;
  /** Total-loss session boundary (stop when reached, positive number). */
  stopLoss: number;
  /** Recovery markup % applied to outstanding debt (settings.botRecoveryMarkup). */
  recoveryMarkupPct: number;
  /** Consecutive losses that stop the session — the engine's circuit breaker. */
  maxConsecutiveLosses: number;
  /** Total-return payout multiplier of the recovery contract (live quote or fallback schedule). */
  recoveryPayout: number;
  /** Whether the payout came from a live proposal or the fallback schedule (metadata only). */
  payoutSource?: "live" | "fallback";
}

export class TurboDbotSpecError extends Error {}

const MIN_STAKE = 0.35;

function validateContract(c: TurboContract, allowed: readonly TurboContract[], kind: string): void {
  const ok = allowed.some(a => contractKey(a) === contractKey(c));
  if (!ok) {
    throw new TurboDbotSpecError(
      `${kind} contract ${contractLabel(c)} is outside the fixed Over/Under Turbo vocabulary — run the scan and use its result`,
    );
  }
}

function money(n: number): string {
  return n.toFixed(2);
}

/** Validate the spec the way the engine's sovereignty checks would. */
export function validateTurboDbotSpec(spec: TurboDbotSpec): void {
  validateContract(spec.normal, TURBO_NORMAL_CONTRACTS, "Normal");
  validateContract(spec.recovery, TURBO_RECOVERY_CONTRACTS, "Recovery");
  if (!Number.isFinite(spec.baseStake) || spec.baseStake < MIN_STAKE) {
    throw new TurboDbotSpecError(`baseStake must be ≥ ${MIN_STAKE}`);
  }
  if (!Number.isFinite(spec.takeProfit) || spec.takeProfit <= 0) {
    throw new TurboDbotSpecError("takeProfit must be > 0");
  }
  if (!Number.isFinite(spec.stopLoss) || spec.stopLoss <= 0) {
    throw new TurboDbotSpecError("stopLoss must be > 0");
  }
  if (!Number.isFinite(spec.recoveryMarkupPct) || spec.recoveryMarkupPct < 0 || spec.recoveryMarkupPct > 500) {
    throw new TurboDbotSpecError("recoveryMarkupPct must be within 0–500");
  }
  if (!Number.isInteger(spec.maxConsecutiveLosses) || spec.maxConsecutiveLosses < 1) {
    throw new TurboDbotSpecError("maxConsecutiveLosses must be a positive integer");
  }
  if (!Number.isFinite(spec.recoveryPayout) || spec.recoveryPayout <= 1) {
    throw new TurboDbotSpecError("recoveryPayout must be a total-return multiplier > 1");
  }
  if (!/^[A-Za-z0-9_]+$/.test(spec.symbol)) {
    throw new TurboDbotSpecError(`symbol "${spec.symbol}" is not a Deriv symbol`);
  }
}

// ── Tiny deterministic XML builder ────────────────────────────────────────────

class X {
  private n = 0;
  id(prefix = "b") { return `nt_${prefix}${++this.n}`; }
  esc(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  num(v: number): string {
    return `<block type="math_number" id="${this.id()}"><field name="NUM">${v}</field></block>`;
  }
  varGet(name: string): string {
    return `<block type="variables_get" id="${this.id()}"><field name="VAR" id="${this.esc(name)}_id" variabletype="">${this.esc(name)}</field></block>`;
  }
  varSet(name: string, valueXml: string): string {
    return `<block type="variables_set" id="${this.id()}"><field name="VAR" id="${this.esc(name)}_id" variabletype="">${this.esc(name)}</field><value name="VALUE">${valueXml}</value></block>`;
  }
  varChange(name: string, deltaXml: string): string {
    return `<block type="math_change" id="${this.id()}"><field name="VAR" id="${this.esc(name)}_id" variabletype="">${this.esc(name)}</field><value name="DELTA">${deltaXml}</value></block>`;
  }
  cmp(op: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE", a: string, b: string): string {
    return `<block type="logic_compare" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  or(a: string, b: string): string {
    return `<block type="logic_operation" id="${this.id()}"><field name="OP">OR</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  ternary(cond: string, thenXml: string, elseXml: string): string {
    return `<block type="logic_ternary" id="${this.id()}"><value name="IF">${cond}</value><value name="THEN">${thenXml}</value><value name="ELSE">${elseXml}</value></block>`;
  }
  arith(op: "ADD" | "MINUS" | "MULTIPLY" | "DIVIDE", a: string, b: string): string {
    return `<block type="math_arithmetic" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  roundup(inner: string): string {
    return `<block type="math_single" id="${this.id()}"><field name="OP">ROUNDUP</field><value name="NUM">${inner}</value></block>`;
  }
  ifElse(cond: string, doXml: string, elseXml: string): string {
    return `<block type="controls_if" id="${this.id()}"><mutation else="1"></mutation><value name="IF0">${cond}</value><statement name="DO0">${doXml}</statement><statement name="ELSE">${elseXml}</statement></block>`;
  }
  ifOnly(cond: string, doXml: string): string {
    return `<block type="controls_if" id="${this.id()}"><value name="IF0">${cond}</value><statement name="DO0">${doXml}</statement></block>`;
  }
  chain(blocks: string[]): string {
    // Wrap statements in <next> nesting.
    return blocks.reduceRight((acc, b) => {
      if (b.endsWith("</block>")) return b.slice(0, -"</block>".length) + `<next>${acc}</next></block>`;
      return b;
    });
  }
  text(s: string): string {
    return `<block type="text" id="${this.id()}"><field name="TEXT">${this.esc(s)}</field></block>`;
  }
}

// Variable names (single source of truth inside the strategy).
export const NT_VARS = {
  stake: "nt_stake",
  prediction: "nt_prediction",
  debt: "nt_debt",
  inRecovery: "nt_in_recovery",
  total: "nt_total",
  streak: "nt_streak",
  profit: "nt_profit",
} as const;

const FN_PREDICTION = "NT Prediction";
const FN_STAKE = "NT Stake";

/**
 * Expression: ceil2(x) = ROUNDUP(x*100)/100 — mirrors roundRecoveryStakeUp
 * semantics (recovery stakes always round UP so a win clears the debt).
 */
function ceil2(x: X, inner: string): string {
  return x.arith("DIVIDE", x.roundup(x.arith("MULTIPLY", inner, x.num(100))), x.num(100));
}

/** Expression: the exact shared recovery stake, clamped like applyRecoveryStakeLimits. */
function recoveryStakeExpr(x: X, spec: TurboDbotSpec): string {
  const markupFactor = 1 + spec.recoveryMarkupPct / 100;
  const netRate = +(spec.recoveryPayout - 1).toFixed(4);
  // NOTE: every expression is built by a THUNK — embedding the same string twice
  // would duplicate Blockly block ids and corrupt the workspace on import.
  const raw = () =>
    x.arith(
      "DIVIDE",
      x.arith("MULTIPLY", x.varGet(NT_VARS.debt), x.num(+markupFactor.toFixed(4))),
      x.num(netRate),
    );
  const ceiled = () => ceil2(x, raw());
  const maxStake = Math.max(MIN_STAKE, +(spec.stopLoss).toFixed(2));
  // clamp: if r < MIN → MIN ; else if r > MAX → MAX ; else r   (nested ternaries, pure)
  return x.ternary(
    x.cmp("LT", ceiled(), x.num(MIN_STAKE)),
    x.num(MIN_STAKE),
    x.ternary(x.cmp("GT", ceiled(), x.num(maxStake)), x.num(maxStake), ceiled()),
  );
}

function procReturn(x: X, name: string, returnXml: string): string {
  return `<block type="procedures_defreturn" id="${x.id()}" collapsed="true" x="0" y="0"><field name="NAME">${x.esc(name)}</field><comment pinned="false" h="80" w="160">${x.esc(`${name} — computed before every purchase (NeuroTrade Turbo lock).`)}</comment><value name="RETURN">${returnXml}</value></block>`;
}

export function buildTurboDbotXml(spec: TurboDbotSpec): { xml: string; filename: string } {
  validateTurboDbotSpec(spec);
  const x = new X();
  const inRecovery = () => x.cmp("EQ", x.varGet(NT_VARS.inRecovery), x.num(1));

  // tradeOptions: DURATION 1t, AMOUNT = NT Stake(), PREDICTION = NT Prediction().
  const tradeOptions = `<block type="tradeOptions" id="${x.id()}"><field name="DURATIONTYPE_LIST">t</field><field name="CURRENCY_LIST">${x.esc(spec.currency)}</field><value name="DURATION">${x.num(1)}</value><value name="AMOUNT"><block type="procedures_callreturn" id="${x.id()}"><mutation name="${FN_STAKE}"></mutation></block></value><value name="PREDICTION"><block type="procedures_callreturn" id="${x.id()}"><mutation name="${FN_PREDICTION}"></mutation></block></value></block>`;

  const trade = `<block type="trade" id="${x.id()}" x="0" y="0"><field name="MARKET_LIST">volidx</field><field name="SUBMARKET_LIST">random_index</field><field name="SYMBOL_LIST">${x.esc(spec.symbol)}</field><field name="TRADETYPECAT_LIST">digits</field><field name="TRADETYPE_LIST">overunder</field><field name="TYPE_LIST">both</field><field name="CANDLEINTERVAL_LIST">60</field><field name="TIME_MACHINE_ENABLED">FALSE</field><field name="RESTARTONERROR">TRUE</field><statement name="SUBMARKET">${tradeOptions}</statement></block>`;

  // before_purchase: pick WHICH side to buy based on the recovery flag.
  const before = `<block type="before_purchase" id="${x.id()}" x="0" y="140"><statement name="BEFOREPURCHASE_STACK">${x.ifElse(
    inRecovery(),
    `<block type="purchase" id="${x.id()}"><field name="PURCHASE_LIST">${spec.recovery.side}</field></block>`,
    `<block type="purchase" id="${x.id()}"><field name="PURCHASE_LIST">${spec.normal.side}</field></block>`,
  )}</statement></block>`;

  // after_purchase: ledger + boundaries + trade_again.
  const setProfit = x.varSet(NT_VARS.profit, `<block type="read_details" id="${x.id()}"><field name="DETAIL_INDEX">4</field></block>`);
  const bumpTotal = x.varChange(NT_VARS.total, x.varGet(NT_VARS.profit));

  const onWin = x.chain([
    x.varSet(NT_VARS.streak, x.num(0)),
    x.varSet(
      NT_VARS.debt,
      x.ternary(
        x.cmp("GT", x.arith("MINUS", x.varGet(NT_VARS.debt), x.varGet(NT_VARS.profit)), x.num(0)),
        x.arith("MINUS", x.varGet(NT_VARS.debt), x.varGet(NT_VARS.profit)),
        x.num(0),
      ),
    ),
    x.varSet(NT_VARS.inRecovery, x.ternary(x.cmp("GT", x.varGet(NT_VARS.debt), x.num(0)), x.num(1), x.num(0))),
  ]);
  const onLoss = x.chain([
    x.varChange(NT_VARS.streak, x.num(1)),
    // loss profit is negative (≈ −stake): debt -= profit adds the lost stake (engine: unrecoveredAmount += loss).
    x.varSet(NT_VARS.debt, x.arith("MINUS", x.varGet(NT_VARS.debt), x.varGet(NT_VARS.profit))),
    x.varSet(NT_VARS.inRecovery, x.num(1)),
  ]);
  const ledger = x.ifOnly(
    `<block type="contract_check_result" id="${x.id()}"><field name="CHECK_RESULT">win</field></block>`,
    onWin,
  );
  const ledgerWithElse = x.ifElse(
    `<block type="contract_check_result" id="${x.id()}"><field name="CHECK_RESULT">win</field></block>`,
    onWin,
    onLoss,
  );

  const boundaryHit = x.or(
    x.or(
      x.cmp("GTE", x.varGet(NT_VARS.total), x.num(+spec.takeProfit.toFixed(2))),
      x.cmp("LTE", x.varGet(NT_VARS.total), x.num(-+spec.stopLoss.toFixed(2))),
    ),
    x.cmp("GTE", x.varGet(NT_VARS.streak), x.num(spec.maxConsecutiveLosses)),
  );
  const stopNote = `<block type="notify" id="${x.id()}"><field name="NOTIFICATION_TYPE">success</field><field name="NOTIFICATION_SOUND">success</field><value name="MESSAGE">${x.text(
    `NeuroTrade Turbo: session boundary reached (TP $${money(spec.takeProfit)} / SL $${money(spec.stopLoss)} / max ${spec.maxConsecutiveLosses} losses in a row). Bot stopped.`,
  )}</value></block>`;
  const continueBlock = `<block type="trade_again" id="${x.id()}"></block>`;

  const after = `<block type="after_purchase" id="${x.id()}" x="0" y="300"><statement name="AFTERPURCHASE_STACK">${x.chain([
    setProfit,
    bumpTotal,
    ledgerWithElse,
    x.ifElse(boundaryHit, stopNote, continueBlock),
  ])}</statement></block>`;
  void ledger; // (kept for clarity; ledgerWithElse is the emitted one)

  const predictionProc = procReturn(
    x,
    FN_PREDICTION,
    x.ternary(inRecovery(), x.num(spec.recovery.barrier), x.num(spec.normal.barrier)),
  );
  const stakeProc = procReturn(
    x,
    FN_STAKE,
    x.ternary(inRecovery(), recoveryStakeExpr(x, spec), x.num(+spec.baseStake.toFixed(2))),
  );

  const variables = Object.values(NT_VARS)
    .map(v => `<variable type="" id="${x.esc(v)}_id">${x.esc(v)}</variable>`)
    .join("");

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false">` +
    `<variables>${variables}</variables>` +
    `${predictionProc}${stakeProc}${trade}${before}${after}</xml>`;

  const filename =
    `neurotrade-turbo_${spec.symbol}_${contractLabel(spec.normal).replace(/\s+/g, "")}` +
    `_rec-${contractLabel(spec.recovery).replace(/\s+/g, "")}.xml`;
  const lcFilename = filename.toLowerCase();

  return { xml, filename: lcFilename };
}
