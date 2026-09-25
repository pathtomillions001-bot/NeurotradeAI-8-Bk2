/**
 * Compiles a DbotStrategyManifest into a Deriv DBot (Blockly) strategy XML.
 *
 * Structure (verified against the vendored builder's block definitions and
 * its own quick-strategy templates):
 *
 *   trade_definition
 *     ├─ TRADE_OPTIONS: market → tradetype → contracttype → candleinterval
 *     │                 → restartbuysell → restartonerror
 *     ├─ SUBMARKET:     trade_definition_tradeoptions (prediction = barrier,
 *     │                 duration ticks, amount = "NeuroTrade Stake" procedure)
 *     └─ INITIALIZATION: seed ladder variables once
 *   before_purchase → purchase (DIGITOVER | DIGITUNDER)
 *   after_purchase  → if "NeuroTrade Continue"(profit, win) then trade_again
 *   procedures: "NeuroTrade Stake" (ladder lookup) and
 *               "NeuroTrade Continue" (recovery bookkeeping + TP/SL/breaker)
 *
 * The recovery ladder embedded here is the account's own debt-exact math
 * (see ./ladder.ts), so the DBot trades the same stakes our engines would.
 */
import type { DbotStrategyManifest } from "./manifest";
import { computeRecoveryLadder, type RecoveryLadder } from "./ladder";

const V = {
  stake: "nt-var-stake",
  streak: "nt-var-streak",
  debt: "nt-var-debt",
  total: "nt-var-total",
  cont: "nt-var-cont",
  profitArg: "nt-arg-profit",
  winArg: "nt-arg-win",
} as const;

let uid = 0;
const id = (p: string) => `${p}-${(++uid).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const num = (n: number, prefix = "n") =>
  `<block type="math_number" id="${id(prefix)}"><field name="NUM">${n}</field></block>`;

const getVar = (name: string, varId: string) =>
  `<block type="variables_get" id="${id("vg")}"><field name="VAR" id="${varId}" variabletype="">${esc(name)}</field></block>`;

const setVar = (name: string, varId: string, valueXml: string) =>
  `<block type="variables_set" id="${id("vs")}"><field name="VAR" id="${varId}" variabletype="">${esc(name)}</field><value name="VALUE">${valueXml}</value></block>`;

const add = (a: string, b: string) =>
  `<block type="math_arithmetic" id="${id("ma")}"><field name="OP">ADD</field><value name="A">${a}</value><value name="B">${b}</value></block>`;

const cmp = (op: "EQ" | "GT" | "GTE" | "LT" | "LTE", a: string, b: string) =>
  `<block type="logic_compare" id="${id("lc")}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;

/** procedures_callreturn with named args wired to value blocks. */
const callProc = (name: string, dataId: string, args: Array<{ name: string; value?: string }>) => {
  const mutation =
    `<mutation name="${esc(name)}">` +
    args.map((a) => `<arg name="${esc(a.name)}"></arg>`).join("") +
    `</mutation>`;
  const values = args
    .map((a, i) => (a.value ? `<value name="ARG${i}">${a.value}</value>` : ""))
    .join("");
  return (
    `<block type="procedures_callreturn" id="${id("pc")}">${mutation}` +
    `<data>${dataId}</data>${values}</block>`
  );
};

export interface GeneratedStrategy {
  xml: string;
  ladder: RecoveryLadder;
}

export function generateDbotXml(manifest: DbotStrategyManifest): GeneratedStrategy {
  const ladder = computeRecoveryLadder(manifest.recovery);
  const { stakes, maxSteps } = ladder;
  const currency = "USD";

  // ── "NeuroTrade Continue" — bookkeeping + TP/SL + ladder breaker. ──
  const contProcId = id("proc-cont");
  // loss branch: debt += stakeUsed; streak += 1; stake = ladder[streak]
  const ladderIfs = stakes
    .map((s, k) => ({ s, k }))
    .filter(({ k }) => k >= 1)
    .map(({ s, k }) => ({
      cond: cmp("EQ", getVar("nt:lossStreak", V.streak), num(k)),
      body: setVar("nt:stake", V.stake, num(s)),
    }));
  // build a controls_if with elseif chain
  let ladderBlock = "";
  {
    const first = ladderIfs[0];
    if (first) {
      let inner =
        `<block type="controls_if" id="${id("ci-lad")}">` +
        `<mutation elseif="${Math.max(0, ladderIfs.length - 1)}"></mutation>` +
        `<value name="IF0">${first.cond}</value><statement name="DO0">${first.body}</statement>`;
      ladderIfs.slice(1).forEach((b, i) => {
        inner += `<value name="IF${i + 1}">${b.cond}</value><statement name="DO${i + 1}">${b.body}</statement>`;
      });
      inner += `</block>`;
      ladderBlock = inner;
    }
  }

  const lossBranch =
    setVar("nt:debt", V.debt, add(getVar("nt:debt", V.debt), getVar("nt:stake", V.stake))) +
    setVar("nt:lossStreak", V.streak, add(getVar("nt:lossStreak", V.streak), num(1))) +
    ladderBlock;

  const winBranch =
    setVar("nt:lossStreak", V.streak, num(0)) +
    setVar("nt:debt", V.debt, num(0)) +
    setVar("nt:stake", V.stake, num(stakes[0]));

  const stopIfs =
    // TP hit → stop
    `<block type="controls_if" id="${id("ci-tp")}"><value name="IF0">` +
    cmp("GTE", getVar("nt:totalProfit", V.total), num(manifest.takeProfit)) +
    `</value><statement name="DO0">` +
    setVar("nt:continue", V.cont, `<block type="logic_boolean" id="${id("lb1")}"><field name="BOOL">FALSE</field></block>`) +
    `</statement></block>` +
    // SL hit → stop
    `<block type="controls_if" id="${id("ci-sl")}"><value name="IF0">` +
    cmp("LTE", getVar("nt:totalProfit", V.total), num(-manifest.stopLoss)) +
    `</value><statement name="DO0">` +
    setVar("nt:continue", V.cont, `<block type="logic_boolean" id="${id("lb2")}"><field name="BOOL">FALSE</field></block>`) +
    `</statement></block>` +
    // ladder exhausted → stop (circuit breaker)
    `<block type="controls_if" id="${id("ci-brk")}"><value name="IF0">` +
    cmp("GT", getVar("nt:lossStreak", V.streak), num(maxSteps)) +
    `</value><statement name="DO0">` +
    setVar("nt:continue", V.cont, `<block type="logic_boolean" id="${id("lb3")}"><field name="BOOL">FALSE</field></block>`) +
    `</statement></block>`;

  const contProc =
    `<block type="procedures_defreturn" id="${contProcId}" collapsed="true" x="0" y="1200">` +
    `<mutation><arg name="nt:profit"></arg><arg name="nt:win"></arg></mutation>` +
    `<field name="NAME">NeuroTrade Continue</field>` +
    `<statement name="STACK">` +
    setVar("nt:totalProfit", V.total, add(getVar("nt:totalProfit", V.total), getVar("nt:profit", V.profitArg))) +
    `<block type="controls_if" id="${id("ci-wl")}">` +
    `<value name="IF0">${getVar("nt:win", V.winArg)}</value>` +
    `<statement name="DO0">${winBranch}</statement>` +
    `<statement name="ELSE">${lossBranch}</statement>` +
    `</block>` +
    stopIfs +
    `</statement>` +
    `<value name="RETURN">${getVar("nt:continue", V.cont)}</value>` +
    `</block>`;

  // ── trade definition ──
  const initStack =
    setVar("nt:stake", V.stake, num(stakes[0])) +
    setVar("nt:lossStreak", V.streak, num(0)) +
    setVar("nt:debt", V.debt, num(0)) +
    setVar("nt:totalProfit", V.total, num(0)) +
    setVar("nt:continue", V.cont, `<block type="logic_boolean" id="${id("lb4")}"><field name="BOOL">TRUE</field></block>`);

  const tradeOptionsChain =
    `<block type="trade_definition_market" id="${id("tdm")}" deletable="false" movable="false">` +
    `<field name="MARKET_LIST">volidx</field>` +
    `<field name="SUBMARKET_LIST">random_index</field>` +
    `<field name="SYMBOL_LIST">${esc(manifest.symbol)}</field>` +
    `<next><block type="trade_definition_tradetype" id="${id("tdt")}" deletable="false" movable="false">` +
    `<field name="TRADETYPECAT_LIST">digits</field>` +
    `<field name="TRADETYPE_LIST">overunder</field>` +
    `<next><block type="trade_definition_contracttype" id="${id("tdc")}" deletable="false" movable="false">` +
    `<field name="TYPE_LIST">both</field>` +
    `<next><block type="trade_definition_candleinterval" id="${id("tdi")}" deletable="false" movable="false">` +
    `<field name="CANDLEINTERVAL_LIST">60</field>` +
    `<next><block type="trade_definition_restartbuysell" id="${id("tdr")}" deletable="false" movable="false">` +
    `<field name="TIME_MACHINE_ENABLED">FALSE</field>` +
    `<next><block type="trade_definition_restartonerror" id="${id("tde")}" deletable="false" movable="false">` +
    `<field name="RESTARTONERROR">TRUE</field>` +
    `</block></next></block></next></block></next></block></next></block></next></block>`;

  const tradeOptions =
    `<block type="trade_definition_tradeoptions" id="${id("tdo")}">` +
    `<mutation has_first_barrier="false" has_second_barrier="false" has_prediction="true"></mutation>` +
    `<field name="DURATIONTYPE_LIST">${esc(manifest.durationUnit)}</field>` +
    `<field name="CURRENCY_LIST">${esc(currency)}</field>` +
    `<value name="DURATION">${num(manifest.duration, "dur")}</value>` +
    `<value name="PREDICTION">${num(manifest.contract.barrier, "pred")}</value>` +
    `<value name="AMOUNT">${getVar("nt:stake", V.stake)}</value>` +
    `</block>`;

  const tradeDef =
    `<block type="trade_definition" id="${id("td")}" x="0" y="0">` +
    `<statement name="INITIALIZATION">${initStack}</statement>` +
    `<statement name="TRADE_OPTIONS">${tradeOptionsChain}</statement>` +
    `<statement name="SUBMARKET">${tradeOptions}</statement>` +
    `</block>`;

  const beforePurchase =
    `<block type="before_purchase" id="${id("bp")}" x="0" y="500">` +
    `<statement name="BEFOREPURCHASE_STACK">` +
    `<block type="purchase" id="${id("pu")}"><field name="PURCHASE_LIST">${esc(manifest.contract.side)}</field></block>` +
    `</statement></block>`;

  const afterPurchase =
    `<block type="after_purchase" id="${id("ap")}" x="400" y="500">` +
    `<statement name="AFTERPURCHASE_STACK">` +
    `<block type="controls_if" id="${id("ci-again")}"><value name="IF0">` +
    callProc("NeuroTrade Continue", contProcId, [
      { name: "nt:profit", value: `<block type="read_details" id="${id("rd")}"><field name="DETAIL_INDEX">4</field></block>` },
      {
        name: "nt:win",
        value: `<block type="contract_check_result" id="${id("ccr")}"><field name="CHECK_RESULT">win</field></block>`,
      },
    ]) +
    `</value><statement name="DO0">` +
    `<block type="trade_again" id="${id("ta")}"></block>` +
    `</statement></block></statement></block>`;

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<xml xmlns="http://www.w3.org/1999/xhtml" collection="false" is_dbot="true">\n` +
    `  <variables>\n` +
    `    <variable type="" id="${V.stake}" islocal="false" iscloud="false">nt:stake</variable>\n` +
    `    <variable type="" id="${V.streak}" islocal="false" iscloud="false">nt:lossStreak</variable>\n` +
    `    <variable type="" id="${V.debt}" islocal="false" iscloud="false">nt:debt</variable>\n` +
    `    <variable type="" id="${V.total}" islocal="false" iscloud="false">nt:totalProfit</variable>\n` +
    `    <variable type="" id="${V.cont}" islocal="false" iscloud="false">nt:continue</variable>\n` +
    `    <variable type="" id="${V.profitArg}" islocal="true" iscloud="false">nt:profit</variable>\n` +
    `    <variable type="" id="${V.winArg}" islocal="true" iscloud="false">nt:win</variable>\n` +
    `  </variables>\n` +
    `  ${tradeDef}\n  ${beforePurchase}\n  ${afterPurchase}\n  ${contProc}\n` +
    `</xml>\n`;

  return { xml, ladder };
}
