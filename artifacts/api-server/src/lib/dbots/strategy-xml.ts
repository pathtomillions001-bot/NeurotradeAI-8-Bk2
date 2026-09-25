/**
 * Strategy XML compiler — a NeuroTrade scan result → a Deriv DBot (Blockly XML).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every scanner in this app (Over/Under Turbo today, Kill-Shot / Dual-Lock
 * next) ends its scan holding a *decision*: this market, this normal contract,
 * this recovery contract, this stake, this take-profit, this stop-loss. Until
 * now the only way to act on that decision was the server-side engine.
 *
 * The DBot path lets the user take the SAME decision into Deriv's own bot
 * runner, in their browser, on the account this app already has selected: the
 * decision is compiled into a Blockly program that
 *
 *   1. trades the scanned market with the scanned contract types,
 *   2. keeps the app's recovery ladder — `debt × (1 + markup) / (payout − 1)` —
 *      recomputed from the LAST fill's real payout, exactly like
 *      lib/recovery-math.calculateBotRecoveryStake() on the server,
 *   3. switches to the scanned recovery contract after a loss,
 *   4. resets to the base stake when the debt is cleared,
 *   5. stops on the session take-profit / stop-loss, and
 *   6. reports every trade to the DBot journal (visible in Bot Studio).
 *
 * The XML is written for the vendored builder in artifacts/dbot-builder. Block
 * types, field names and mutation flags below were read off that tree, not
 * guessed:
 *   - trade_definition + its TRADE_OPTIONS chain (market → tradetype →
 *     contracttype → candleinterval → restartbuysell → restartonerror),
 *   - INITIALIZATION, which trade_definition's codegen emits inside
 *     BinaryBotPrivateInit (`Bot.init(...)` + that statement) — that is where
 *     the seed belongs, because it runs once, before the first trade,
 *   - trade_definition_tradeoptions, whose `has_prediction` mutation flag is
 *     what makes it re-create the PREDICTION input on load (its domToMutation),
 *   - Bot.init's `contractTypes` come from `config().opposites[tradeType]` when
 *     TYPE_LIST is 'both' — so 'overunder' yields [DIGITOVER, DIGITUNDER],
 *   - proposal re-request keys (amount, prediction, duration, duration_unit,
 *     underlying_symbol …) — the ladder changes `amount` and `prediction`, which
 *     is exactly what makes the engine request fresh proposals every step,
 *   - payout(contract) → Bot.getPayout(contract) → the live proposal payout,
 *     which is how the ladder uses REAL payouts instead of an estimate,
 *   - read_details(4) → the settled profit, contract_check_result → win/loss,
 *     total_profit → the session profit so far, balance → Bot.getBalance('NUM').
 *
 * THE BOT IS THE MIRROR, NOT THE LEDGER
 * ─────────────────────────────────────
 * The shared recovery ledger lives on the server (lib/agents/recovery-engine).
 * The bot's variables are seeded from it (see factory.ts) and every fill is
 * mirrored back into it by lib/dbots/mirror.ts — the bot never owns a second
 * ledger, it just has to execute the same arithmetic between fills.
 *
 * The XML never depends on demo vs real: the builder connects with an OTP for
 * the account this app has active, so the same file trades demo on a demo
 * account and real on a real one.
 */

// ── XML tree helpers ─────────────────────────────────────────────────────────

/** Minimal XML element used by the compiler (attributes with undefined are skipped). */
export interface XmlElement {
  tag: "xml" | "variables" | "variable" | "block" | "field" | "value" | "statement" | "next" | "shadow" | "mutation";
  attrs?: Record<string, string | number | undefined>;
  children?: XmlElement[];
  text?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format a number for XML: at most 4 decimals, no trailing zeros. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10000) / 10000;
  return String(rounded);
}

/** Render an element tree to the indented XML text the builder loads. */
export function renderXml(element: XmlElement, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(element.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  const children = element.children ?? [];
  if (children.length === 0 && element.text === undefined) {
    return `${pad}<${element.tag}${attrs} />`;
  }
  const inner =
    children.length > 0
      ? `\n${children.map((child) => renderXml(child, depth + 1)).join("\n")}\n${pad}`
      : element.text ?? "";
  return `${pad}<${element.tag}${attrs}>${inner}</${element.tag}>`;
}

const block = (
  type: string,
  children: XmlElement[] = [],
  attrs: Record<string, string | number | undefined> = {},
): XmlElement => ({ tag: "block", attrs: { type, ...attrs }, children });

const field = (name: string, value: string | number, extra: Record<string, string | undefined> = {}): XmlElement => ({
  tag: "field",
  attrs: { name, ...extra },
  text: String(value),
});

const valueInput = (name: string, ...children: XmlElement[]): XmlElement => ({ tag: "value", attrs: { name }, children });

const statementInput = (name: string, ...children: XmlElement[]): XmlElement => ({
  tag: "statement",
  attrs: { name },
  children,
});

const nextOf = (child: XmlElement): XmlElement => ({ tag: "next", children: [child] });

/** Chain blocks as a `next` stack (execution order top → bottom). */
function chain(blocks: XmlElement[]): XmlElement[] {
  if (blocks.length <= 1) return blocks;
  const [head, ...rest] = blocks as [XmlElement, ...XmlElement[]];
  return [{ ...head, children: [...(head.children ?? []), nextOf(chain(rest)[0]!)] }];
}

/** `IF0`/`DO0`/`ELSE` statement block, with the `else="1"` mutation when needed. */
function ifBlock(condition: XmlElement, thenBlocks: XmlElement[], elseBlocks: XmlElement[] = []): XmlElement {
  const children: XmlElement[] = [
    block("mutation", [], { else: elseBlocks.length > 0 ? "1" : undefined }),
    valueInput("IF0", condition),
    statementInput("DO0", ...chain(thenBlocks)),
  ];
  if (elseBlocks.length > 0) children.push(statementInput("ELSE", ...chain(elseBlocks)));
  return block("controls_if", children);
}

// ── Value expressions ────────────────────────────────────────────────────────

const shadowNumber = (n: number): XmlElement =>
  block("shadow", [field("NUM", formatNumber(n))], { type: "math_number_positive" });
const number = (n: number): XmlElement => block("math_number_positive", [field("NUM", formatNumber(n))]);
const textBlock = (s: string): XmlElement => block("text", [field("TEXT", s)]);
const textShadow = (s: string): XmlElement => block("shadow", [field("TEXT", s)], { type: "text" });
const boolean = (v: boolean): XmlElement => block("logic_boolean", [field("BOOL", v ? "TRUE" : "FALSE")]);

function mathOp(op: "ADD" | "MINUS" | "MULTIPLY" | "DIVIDE" | "POWER", a: XmlElement, b: XmlElement): XmlElement {
  return block("math_arithmetic", [
    field("OP", op),
    valueInput("A", shadowNumber(1), a),
    valueInput("B", shadowNumber(1), b),
  ]);
}

function compare(op: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE", a: XmlElement, b: XmlElement): XmlElement {
  return block("logic_compare", [field("OP", op), valueInput("A", a), valueInput("B", b)]);
}

const negate = (expr: XmlElement): XmlElement =>
  block("math_single", [field("OP", "NEG"), valueInput("NUM", shadowNumber(1), expr)]);

const round = (num: XmlElement): XmlElement =>
  block("math_round", [field("OP", "ROUND"), valueInput("NUM", shadowNumber(1), num)]);

/** Round to a currency amount — `round(x * 100) / 100`, mirroring toCents(). */
const round2 = (expr: XmlElement): XmlElement =>
  mathOp("DIVIDE", round(mathOp("MULTIPLY", expr, number(100))), number(100));

// ── The spec ─────────────────────────────────────────────────────────────────

/** One leg of the scan's decision: a digit contract (side + prediction digit). */
export interface DbotContract {
  /** Deriv contract type, e.g. DIGITOVER / DIGITUNDER. */
  contractType: string;
  /** The digit the tick must beat (Deriv's `prediction` for over/under). */
  prediction: number;
}

/** The scanner-agnostic description of the bot to build. */
export interface DbotStrategySpec {
  /** Stable bot id (already persisted by the caller) — used in the bot name. */
  id: string;
  /** Human name shown in the builder's bot-name field and the run panel. */
  name: string;
  /** Provenance: which console/scan produced this spec. */
  source: {
    /** Console contract id, e.g. "overunder-turbo@2". */
    console: string;
    /** Catalogue bot id, e.g. "overunder-turbo". */
    botId: string;
    /** Account the scan ran under (a DBot is never built for another account). */
    accountId: string;
    /** True when the account is virtual (demo) at scan time. */
    isVirtual: boolean;
  };
  market: {
    symbol: string;
    displayName: string;
    /** Deriv `market` value (synthetic_index for every index this app trades). */
    market: string;
    /** Deriv `submarket` value (random_index / random_daily / jump_index). */
    submarket: string;
  };
  tradeType: {
    /** Trade-type category for the builder's dropdown, e.g. "digits". */
    category: string;
    /** Trade type inside the category, e.g. "overunder". */
    type: string;
  };
  /**
   * Contract types the bot may buy (DIGITOVER + DIGITUNDER for over/under).
   * With TYPE_LIST = 'both' the builder derives this from
   * `config().opposites[tradeType.type]`, so the two must agree.
   */
  contractTypes: string[];
  /** Base stake (the app's risk amount) and the hard per-trade cap, if any. */
  stake: { initial: number; max?: number | null };
  duration: { value: number; unit: "t" | "s" | "m" | "h" | "d" };
  /** Normal leg — used while the shared ledger has no debt. */
  normal: DbotContract;
  /** Recovery leg — used while recovering debt. */
  recovery: DbotContract;
  /** Shared-ledger state at build time: the bot is SEEDED from it, never forks it. */
  recoveryState: {
    /** Unrecovered amount in the app's single shared ledger. */
    debt: number;
    /** Recovery markup in percent (settings.botRecoveryMarkup, default 10). */
    markupPercent: number;
    /** Maximum recovery steps per cycle (settings.maxRecoverySteps). */
    maxSteps: number;
    /** Payout multiplier estimate for the recovery leg (payout / stake). */
    payoutMultiplier: number;
  };
  /** Session risk limits — the bot stops at exactly these. */
  limits: { takeProfit: number; stopLoss: number };
  /** Account currency, when known (the trade-options currency label). */
  currency?: string;
}

// ── Variable bookkeeping ─────────────────────────────────────────────────────

const VARIABLE_NAMES = {
  stake: "NeuroTrade stake",
  debt: "NeuroTrade debt",
  markup: "NeuroTrade markup percent",
  mode: "NeuroTrade mode",
  digit: "NeuroTrade digit",
  normalDigit: "NeuroTrade normal digit",
  recoveryDigit: "NeuroTrade recovery digit",
  multNormal: "NeuroTrade normal payout",
  multRecovery: "NeuroTrade recovery payout",
  maxStake: "NeuroTrade max stake",
  takeProfit: "NeuroTrade take profit",
  stopLoss: "NeuroTrade stop loss",
  totalProfit: "NeuroTrade total profit",
  profit: "NeuroTrade last profit",
  tradeAgain: "NeuroTrade trade again",
  step: "NeuroTrade recovery step",
  message: "NeuroTrade message",
} as const;

type VariableKey = keyof typeof VARIABLE_NAMES;

/** Deterministic variable id, so the same spec always produces the same XML. */
const variableId = (key: VariableKey): string => `nt_dbot_${key}`;

/**
 * A Blockly variable field. Blockly needs the variable's identity in the `id`
 * attribute as well as its display name in the text, so the same spec always
 * maps to the same variable (and a reload never forks a duplicate one).
 */
const varField = (key: VariableKey): XmlElement =>
  field("VAR", VARIABLE_NAMES[key], { id: variableId(key), variabletype: "" });

const varGet = (key: VariableKey): XmlElement => block("variables_get", [varField(key)]);

const varSet = (key: VariableKey, value: XmlElement): XmlElement =>
  block("variables_set", [varField(key), valueInput("VALUE", value)]);

/** `text_join` writes the space-joined concatenation of `parts` into a variable. */
function joinInto(key: VariableKey, parts: Array<string | XmlElement>): XmlElement {
  const statements = parts.map((part) =>
    block("text_statement", [
      valueInput(
        "TEXT",
        // A plain string lives in the shadow; a variable/number is a real block.
        typeof part === "string" ? textShadow(part) : textShadow(""),
        ...(typeof part === "string" ? [] : [part]),
      ),
    ]),
  );
  return block("text_join", [
    varField(key),
    statementInput("STACK", ...chain(statements)),
  ]);
}

const notify = (
  type: "info" | "success" | "warn" | "error",
  message: XmlElement,
  sound: "silent" | "announcement" | "earned-money" | "job-done" | "error" | "severe-error" = "silent",
): XmlElement =>
  block("notify", [
    field("NOTIFICATION_TYPE", type),
    field("NOTIFICATION_SOUND", sound),
    valueInput("MESSAGE", textShadow(""), message),
  ]);

const purchase = (contractType: string): XmlElement => block("purchase", [field("PURCHASE_LIST", contractType)]);
const payoutOf = (contractType: string): XmlElement => block("payout", [field("PURCHASE_LIST", contractType)]);
const readDetail = (index: number): XmlElement => block("read_details", [field("DETAIL_INDEX", index)]);
const checkResult = (result: "win" | "loss"): XmlElement =>
  block("contract_check_result", [field("CHECK_RESULT", result)]);
const totalProfit = (): XmlElement => block("total_profit", []);
const balanceNum = (): XmlElement => block("balance", [field("BALANCE_TYPE", "NUM")]);
const tradeAgainBlock = (): XmlElement => block("trade_again", []);

// ── Procedures ───────────────────────────────────────────────────────────────

const PROCEDURE_SETUP = "NeuroTrade Setup";
const PROCEDURE_LADDER = "NeuroTrade Ladder";
const PROCEDURE_AFTER = "NeuroTrade After Purchase";

const callNoReturn = (name: string): XmlElement => block("procedures_callnoreturn", [block("mutation", [], { name })]);

const defNoReturn = (name: string, stack: XmlElement[]): XmlElement =>
  block("procedures_defnoreturn", [field("NAME", name), statementInput("STACK", ...chain(stack))]);

// ── Compilation ──────────────────────────────────────────────────────────────

export interface CompiledStrategy {
  /** The Blockly XML the DBot builder loads (`window.Blockly.utils.xml.textToDom`). */
  xml: string;
  /** Bot name as it appears in the builder / saved bot. */
  name: string;
  /** Procedure names, so tests and docs stay honest about what was emitted. */
  procedures: { setup: string; ladder: string; afterPurchase: string };
  /** Variables seeded from the shared ledger, for the run panel and docs. */
  seed: { debt: number; markupPercent: number; stake: number; mode: "normal" | "recovery" };
}

/**
 * Compile a scan-derived spec into DBot XML.
 *
 * Deterministic by design: the same spec always produces byte-identical XML,
 * which is what makes the golden fixtures in docs/bot-studio-strategy-xml
 * meaningful and lets the web check load the very files the API emits.
 */
export function compileStrategyXml(spec: DbotStrategySpec): CompiledStrategy {
  const normalType = spec.normal.contractType;
  const recoveryType = spec.recovery.contractType;
  const currency = (spec.currency ?? "USD").toUpperCase();
  const initialDebt = Math.max(0, spec.recoveryState.debt);

  // ── NeuroTrade Setup: seed every constant, then let the ladder choose the
  //    first (stake, digit, mode). A bot built while the shared ledger still
  //    holds debt must open in recovery, not at the base stake.
  const setup: XmlElement[] = [
    varSet("stake", number(spec.stake.initial)),
    varSet("debt", number(initialDebt)),
    varSet("markup", number(spec.recoveryState.markupPercent)),
    varSet("normalDigit", number(spec.normal.prediction)),
    varSet("recoveryDigit", number(spec.recovery.prediction)),
    varSet("mode", textBlock("normal")),
    // Payout multipliers start at the scan's estimate and are replaced by the
    // live proposal payouts before the first purchase (see before_purchase).
    varSet("multNormal", number(spec.recoveryState.payoutMultiplier)),
    varSet("multRecovery", number(spec.recoveryState.payoutMultiplier)),
    varSet("maxStake", number(spec.stake.max && spec.stake.max > 0 ? spec.stake.max : 0)),
    varSet("takeProfit", number(spec.limits.takeProfit)),
    varSet("stopLoss", number(spec.limits.stopLoss)),
    varSet("totalProfit", number(0)),
    varSet("profit", number(0)),
    varSet("tradeAgain", boolean(true)),
    varSet("step", number(0)),
    callNoReturn(PROCEDURE_LADDER),
  ];

  // ── NeuroTrade Ladder: debt → (stake, digit, mode).
  //    stake = round2(debt × (1 + markup/100) / (payout − 1)) — the same
  //    arithmetic as lib/recovery-math.calculateBotRecoveryStake().
  const recoveryStake = round2(
    mathOp(
      "DIVIDE",
      mathOp(
        "MULTIPLY",
        varGet("debt"),
        mathOp("ADD", number(1), mathOp("DIVIDE", varGet("markup"), number(100))),
      ),
      mathOp("MINUS", varGet("multRecovery"), number(1)),
    ),
  );

  const recoveryBranch: XmlElement[] = [
    varSet("mode", textBlock("recovery")),
    varSet("digit", varGet("recoveryDigit")),
    varSet("stake", recoveryStake),
    // Two hard limits, exactly like the server engine (applyRecoveryStakeLimits
    // caps by the configured per-trade max and by the available balance).
    ifBlock(compare("GT", varGet("maxStake"), number(0)), [
      ifBlock(compare("GT", varGet("stake"), varGet("maxStake")), [varSet("stake", varGet("maxStake"))]),
    ]),
    ifBlock(compare("GT", balanceNum(), number(0)), [
      ifBlock(compare("GT", varGet("stake"), balanceNum()), [varSet("stake", balanceNum())]),
    ]),
  ];

  const normalBranch: XmlElement[] = [
    varSet("mode", textBlock("normal")),
    varSet("digit", varGet("normalDigit")),
    varSet("stake", number(spec.stake.initial)),
  ];

  const ladderProcedure = defNoReturn(PROCEDURE_LADDER, [
    ifBlock(compare("GT", varGet("debt"), number(0)), recoveryBranch, normalBranch),
  ]);

  // ── NeuroTrade After Purchase: settle into the ledger mirror, then decide
  //    whether to trade again (TP/SL are the app's session limits).
  const afterPurchaseStack: XmlElement[] = [
    varSet("profit", readDetail(4)),
    varSet("totalProfit", totalProfit()),
    // debt = debt − profit → a win pays the ledger down, a loss grows it.
    varSet("debt", mathOp("MINUS", varGet("debt"), varGet("profit"))),
    ifBlock(compare("LT", varGet("debt"), number(0)), [varSet("debt", number(0))]),
    ifBlock(
      checkResult("win"),
      [
        varSet("step", number(0)),
        joinInto("message", ["NeuroTrade: win, profit ", varGet("profit"), " — debt ", varGet("debt")]),
        notify("success", varGet("message")),
      ],
      [
        varSet("step", mathOp("ADD", varGet("step"), number(1))),
        joinInto("message", [
          "NeuroTrade: loss, ",
          negate(varGet("profit")),
          " lost — debt ",
          varGet("debt"),
          " (step ",
          varGet("step"),
          ")",
        ]),
        notify("warn", varGet("message")),
      ],
    ),
    varSet("tradeAgain", boolean(true)),
    ifBlock(compare("GTE", varGet("totalProfit"), varGet("takeProfit")), [
      joinInto("message", ["NeuroTrade: take profit reached ", varGet("totalProfit")]),
      notify("success", varGet("message"), "earned-money"),
      varSet("tradeAgain", boolean(false)),
    ]),
    ifBlock(compare("LTE", varGet("totalProfit"), negate(varGet("stopLoss"))), [
      joinInto("message", ["NeuroTrade: stop loss reached ", varGet("totalProfit")]),
      notify("error", varGet("message"), "error"),
      varSet("tradeAgain", boolean(false)),
    ]),
    callNoReturn(PROCEDURE_LADDER),
    ifBlock(varGet("tradeAgain"), [tradeAgainBlock()]),
  ];

  // ── Before purchase: refresh the two live payout multipliers, then buy the
  //    leg the current mode points at. Both legs' proposals exist every step
  //    (TYPE_LIST is 'both'), so both payouts are readable here — that is what
  //    lets the ladder use the recovery leg's REAL payout rather than a guess.
  const beforePurchaseStack: XmlElement[] = [
    varSet("multNormal", mathOp("DIVIDE", payoutOf(normalType), varGet("stake"))),
    varSet("multRecovery", mathOp("DIVIDE", payoutOf(recoveryType), varGet("stake"))),
    ifBlock(
      compare("EQ", varGet("mode"), textBlock("recovery")),
      [purchase(recoveryType)],
      [purchase(normalType)],
    ),
  ];

  const variables: XmlElement = {
    tag: "variables",
    children: (Object.keys(VARIABLE_NAMES) as VariableKey[]).map((key) => ({
      tag: "variable",
      attrs: { type: "", id: variableId(key), islocal: "false", iscloud: "false" },
      text: VARIABLE_NAMES[key],
    })),
  };

  const marketChain = block(
    "trade_definition_market",
    [
      field("MARKET_LIST", spec.market.market),
      field("SUBMARKET_LIST", spec.market.submarket),
      field("SYMBOL_LIST", spec.market.symbol),
      nextOf(
        block("trade_definition_tradetype", [
          field("TRADETYPECAT_LIST", spec.tradeType.category),
          field("TRADETYPE_LIST", spec.tradeType.type),
          nextOf(
            block("trade_definition_contracttype", [
              field("TYPE_LIST", "both"),
              nextOf(
                block("trade_definition_candleinterval", [
                  field("CANDLEINTERVAL_LIST", "60"),
                  nextOf(
                    block("trade_definition_restartbuysell", [
                      field("TIME_MACHINE_ENABLED", "FALSE"),
                      nextOf(block("trade_definition_restartonerror", [field("RESTARTONERROR", "TRUE")])),
                    ]),
                  ),
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ],
    { deletable: "false", movable: "false" },
  );

  const tradeOptions = block("trade_definition_tradeoptions", [
    block("mutation", [], { has_first_barrier: "false", has_second_barrier: "false", has_prediction: "true" }),
    field("DURATIONTYPE_LIST", spec.duration.unit),
    field("CURRENCY_LIST", currency),
    valueInput("DURATION", shadowNumber(spec.duration.value), number(spec.duration.value)),
    valueInput("AMOUNT", shadowNumber(spec.stake.initial), varGet("stake")),
    valueInput("PREDICTION", shadowNumber(spec.normal.prediction), varGet("digit")),
  ]);

  const tradeDefinition = block(
    "trade_definition",
    [
      statementInput("TRADE_OPTIONS", marketChain),
      statementInput("INITIALIZATION", callNoReturn(PROCEDURE_SETUP)),
      statementInput("SUBMARKET", tradeOptions),
    ],
    { deletable: "false", x: 0, y: 0 },
  );

  const beforePurchaseBlock = block(
    "before_purchase",
    [statementInput("BEFOREPURCHASE_STACK", ...chain(beforePurchaseStack))],
    { deletable: "false", x: 640, y: 0 },
  );

  const afterPurchaseBlock = block(
    "after_purchase",
    [statementInput("AFTERPURCHASE_STACK", callNoReturn(PROCEDURE_AFTER))],
    { x: 640, y: 480 },
  );

  const root: XmlElement = {
    tag: "xml",
    attrs: { xmlns: "http://www.w3.org/1999/xhtml", is_dbot: "true", collection: "false" },
    children: [
      variables,
      tradeDefinition,
      beforePurchaseBlock,
      afterPurchaseBlock,
      defNoReturn(PROCEDURE_SETUP, setup),
      ladderProcedure,
      defNoReturn(PROCEDURE_AFTER, afterPurchaseStack),
    ],
  };

  return {
    xml: `${renderXml(root)}\n`,
    name: spec.name,
    procedures: { setup: PROCEDURE_SETUP, ladder: PROCEDURE_LADDER, afterPurchase: PROCEDURE_AFTER },
    seed: {
      debt: initialDebt,
      markupPercent: spec.recoveryState.markupPercent,
      stake: spec.stake.initial,
      mode: initialDebt > 0 ? "recovery" : "normal",
    },
  };
}
