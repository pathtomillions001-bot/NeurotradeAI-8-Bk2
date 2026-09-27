/**
 * Shared Deriv-Bot (Blockly) XML builder.
 *
 * Extracted verbatim from `overunder-turbo-dbot.ts` — the generator that already
 * ships "Create DBot" — so every NeuroTrade strategy generator emits byte-identical
 * block shapes. The Turbo fixture snapshots (`overunder-turbo-dbot.fixtures.ts`)
 * are the regression test for that extraction: if this file changes the shape of
 * any block, those fixtures fail.
 *
 * RULES
 *  - Only emit block types the vendored builder registers in `window.Blockly.Blocks`.
 *    `load()` (scratch/utils/index.js) rejects the WHOLE workspace when it meets one
 *    unknown type, so every generator must assert its output against an allowlist.
 *  - Every variable used by a `variables_get` / `variables_set` must be registered
 *    through `variable()` so `variablesXml()` can declare it.
 *  - Blockly mutations are not optional: `controls_if` needs `<mutation elseif/else>`,
 *    `lists_getSublist` needs `<mutation at1/at2>`, and Deriv's `text_join` is a
 *    STATEMENT (joins into a variable), not a value.
 */

export function esc(text: string | number): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** A statement block: `inner` holds its fields/values/statements, `next` chains. */
export interface Stmt {
  type: string;
  inner: string;
  attrs?: string;
}

export class XmlBuilder {
  private seq = 0;
  private readonly vars = new Map<string, string>();

  private id(): string {
    this.seq += 1;
    return `nt${this.seq.toString(36).padStart(4, "0")}`;
  }

  /** Register (or fetch) a workspace variable and return its id. */
  variable(name: string): string {
    let id = this.vars.get(name);
    if (!id) {
      id = `ntv${(this.vars.size + 1).toString(36).padStart(3, "0")}`;
      this.vars.set(name, id);
    }
    return id;
  }

  variablesXml(): string {
    const rows = [...this.vars.entries()].map(
      ([name, id]) => `<variable id="${id}">${esc(name)}</variable>`,
    );
    return `<variables>${rows.join("")}</variables>`;
  }

  // ── value (round) blocks ──
  num(n: number): string {
    return `<block type="math_number" id="${this.id()}"><field name="NUM">${esc(n)}</field></block>`;
  }
  text(s: string): string {
    return `<block type="text" id="${this.id()}"><field name="TEXT">${esc(s)}</field></block>`;
  }
  bool(v: boolean): string {
    return `<block type="logic_boolean" id="${this.id()}"><field name="BOOL">${v ? "TRUE" : "FALSE"}</field></block>`;
  }
  get(name: string): string {
    return `<block type="variables_get" id="${this.id()}"><field name="VAR" id="${this.variable(name)}">${esc(name)}</field></block>`;
  }
  arith(op: "ADD" | "MINUS" | "MULTIPLY" | "DIVIDE", a: string, b: string): string {
    return `<block type="math_arithmetic" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  compare(op: "EQ" | "NEQ" | "LT" | "LTE" | "GT" | "GTE", a: string, b: string): string {
    return `<block type="logic_compare" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  logic(op: "AND" | "OR", a: string, b: string): string {
    return `<block type="logic_operation" id="${this.id()}"><field name="OP">${op}</field><value name="A">${a}</value><value name="B">${b}</value></block>`;
  }
  round(op: "ROUND" | "ROUNDUP" | "ROUNDDOWN", v: string): string {
    return `<block type="math_round" id="${this.id()}"><field name="OP">${op}</field><value name="NUM">${v}</value></block>`;
  }
  constrain(v: string, low: string, high: string): string {
    return `<block type="math_constrain" id="${this.id()}"><value name="VALUE">${v}</value><value name="LOW">${low}</value><value name="HIGH">${high}</value></block>`;
  }
  readDetails(index: 2 | 3 | 4): string {
    return `<block type="read_details" id="${this.id()}"><field name="DETAIL_INDEX">${index}</field></block>`;
  }
  checkResult(result: "win" | "loss"): string {
    return `<block type="contract_check_result" id="${this.id()}"><field name="CHECK_RESULT">${result}</field></block>`;
  }
  totalProfit(): string {
    return `<block type="total_profit" id="${this.id()}"></block>`;
  }
  balance(): string {
    return `<block type="balance" id="${this.id()}"><field name="BALANCE_TYPE">NUM</field></block>`;
  }
  lastDigitList(): string {
    return `<block type="lastDigitList" id="${this.id()}"></block>`;
  }
  /** NeuroTrade Digit Forge runtime decision field (vendored builder only). */
  ntDecision(field: string): string {
    return `<block type="nt_digit_decision" id="${this.id()}"><field name="FIELD">${esc(field)}</field></block>`;
  }
  /** Run the adaptive multi-market/barrier ranker inside the bot runtime. */
  ntAnalyse(mode: "NORMAL" | "RECOVERY", markets: string[], window: number): Stmt {
    return {
      type: "nt_analyse_digit_markets",
      inner: `<field name="MODE">${mode}</field><field name="MARKETS">${esc(markets.join(","))}</field><field name="WINDOW">${esc(window)}</field>`,
    };
  }
  /** Analyse WHEN to execute a fixed Over/Under Turbo recovery contract. */
  ntAnalyseTurboRecovery(
    contract: "DIGITOVER" | "DIGITUNDER",
    barrier: number,
    payout: string,
    window: number,
    stake: string,
  ): Stmt {
    return {
      type: "nt_analyse_turbo_recovery",
      inner:
        `<field name="CONTRACT">${contract}</field>` +
        `<field name="BARRIER">${esc(barrier)}</field>` +
        `<field name="WINDOW">${esc(window)}</field>` +
        `<value name="PAYOUT">${payout}</value>` +
        `<value name="STAKE">${stake}</value>`,
    };
  }
  /** Read a field from the latest Turbo recovery timing decision. */
  ntTurboRecoveryDecision(field: string): string {
    return `<block type="nt_turbo_recovery_decision" id="${this.id()}"><field name="FIELD">${esc(field)}</field></block>`;
  }
  /** Safely retarget the vendored trade engine between contracts. */
  ntSwitchMarket(symbol: string): Stmt {
    return { type: "nt_switch_market", inner: `<value name="SYMBOL">${symbol}</value>` };
  }
  lastN(list: string, n: number): string {
    return (
      `<block type="lists_getSublist" id="${this.id()}"><mutation at1="true" at2="false"></mutation>` +
      `<field name="WHERE1">FROM_END</field><field name="WHERE2">LAST</field>` +
      `<value name="LIST">${list}</value><value name="AT1">${this.num(n)}</value></block>`
    );
  }
  length(list: string): string {
    return `<block type="lists_length" id="${this.id()}"><value name="VALUE">${list}</value></block>`;
  }

  // ── statement blocks ──
  set(name: string, value: string): Stmt {
    return {
      type: "variables_set",
      inner: `<field name="VAR" id="${this.variable(name)}">${esc(name)}</field><value name="VALUE">${value}</value>`,
    };
  }
  /** `if` with optional else-if branches and else. */
  ifElse(
    branches: Array<{ cond: string; then: Stmt[] }>,
    otherwise?: Stmt[],
  ): Stmt {
    const elseif = branches.length - 1;
    const mutation =
      elseif > 0 || otherwise
        ? `<mutation${elseif > 0 ? ` elseif="${elseif}"` : ""}${otherwise ? ` else="1"` : ""}></mutation>`
        : "";
    const body = branches
      .map(
        (b, i) =>
          `<value name="IF${i}">${b.cond}</value><statement name="DO${i}">${this.chain(b.then)}</statement>`,
      )
      .join("");
    const els = otherwise ? `<statement name="ELSE">${this.chain(otherwise)}</statement>` : "";
    return { type: "controls_if", inner: `${mutation}${body}${els}` };
  }
  forEach(itemVar: string, list: string, body: Stmt[]): Stmt {
    return {
      type: "controls_forEach",
      inner: `<field name="VAR" id="${this.variable(itemVar)}">${esc(itemVar)}</field><value name="LIST">${list}</value><statement name="DO">${this.chain(body)}</statement>`,
    };
  }
  /** Deriv's text_join is a statement: joins its parts into `target`. */
  joinInto(target: string, parts: string[]): Stmt {
    const stack = this.chain(
      parts.map((p) => ({
        type: "text_statement",
        inner: `<value name="TEXT">${p}</value>`,
        attrs: ` movable="false"`,
      })),
    );
    return {
      type: "text_join",
      inner: `<field name="VARIABLE" id="${this.variable(target)}">${esc(target)}</field><statement name="STACK">${stack}</statement>`,
    };
  }
  notify(kind: "success" | "info" | "warn" | "error", message: string, sound = "silent"): Stmt {
    return {
      type: "notify",
      inner: `<field name="NOTIFICATION_TYPE">${kind}</field><field name="NOTIFICATION_SOUND">${sound}</field><value name="MESSAGE">${message}</value>`,
    };
  }
  purchase(contract: "DIGITOVER" | "DIGITUNDER"): Stmt {
    return { type: "purchase", inner: `<field name="PURCHASE_LIST">${contract}</field>` };
  }
  tradeAgain(): Stmt {
    return { type: "trade_again", inner: "" };
  }
  call(procName: string): Stmt {
    return { type: "procedures_callnoreturn", inner: `<mutation name="${esc(procName)}"></mutation>` };
  }

  /** Nest statements with `<next>` the way Blockly serialises a stack. */
  chain(stmts: Stmt[]): string {
    if (stmts.length === 0) return "";
    const [head, ...rest] = stmts;
    const next = rest.length > 0 ? `<next>${this.chain(rest)}</next>` : "";
    return `<block type="${head!.type}" id="${this.id()}"${head!.attrs ?? ""}>${head!.inner}${next}</block>`;
  }

  /** Top-level (x/y positioned) block. */
  topLevel(type: string, inner: string, x: number, y: number, attrs = ""): string {
    return `<block type="${type}" id="${this.id()}" x="${x}" y="${y}"${attrs}>${inner}</block>`;
  }

  // ── Extensions for in-XML statistics ───────────────────────────────────────
  // Everything below is still a STOCK builder block; these are the primitives a
  // strategy needs to compute a confidence bound, a likelihood-ratio statistic
  // and a streak length inside the running bot (docs/digit-forge-market-switching.md §4.3).

  /** `math_single` — ROOT / ABS / NEG / LN / LOG10 / EXP / POW10. */
  single(op: "ROOT" | "ABS" | "NEG" | "LN" | "LOG10" | "EXP" | "POW10", v: string): string {
    return `<block type="math_single" id="${this.id()}"><field name="OP">${op}</field><value name="NUM">${v}</value></block>`;
  }

  /** `math_on_list` — SUM / MIN / MAX / AVERAGE / MEDIAN / MODE / ANTIMODE / STD_DEV / RANDOM. */
  onList(
    op: "SUM" | "MIN" | "MAX" | "AVERAGE" | "MEDIAN" | "MODE" | "ANTIMODE" | "STD_DEV" | "RANDOM",
    list: string,
  ): string {
    // NOTE: the vendored `math_on_list` defines no domToMutation (unlike upstream
    // Blockly), so emitting a <mutation> here would be dead weight the loader
    // ignores. The generator reads getFieldValue('OP') only.
    return `<block type="math_on_list" id="${this.id()}"><field name="OP">${op}</field><value name="LIST">${list}</value></block>`;
  }

  /** `math_modulo` — remainder of A ÷ B. */
  mod(a: string, b: string): string {
    return `<block type="math_modulo" id="${this.id()}"><value name="DIVIDEND">${a}</value><value name="DIVISOR">${b}</value></block>`;
  }

  /** `logic_negate` — NOT. */
  not(v: string): string {
    return `<block type="logic_negate" id="${this.id()}"><value name="BOOL">${v}</value></block>`;
  }

  /** Fold a list of conditions into a left-nested AND/OR chain (Blockly's op is binary). */
  all(op: "AND" | "OR", conds: string[]): string {
    if (conds.length === 0) return this.bool(op === "AND");
    return conds.reduce((acc, cond) => (acc === "" ? cond : this.logic(op, acc, cond)));
  }

  /** A value-returning procedure call. */
  callReturn(procName: string): string {
    return `<block type="procedures_callreturn" id="${this.id()}"><mutation name="${esc(procName)}"></mutation></block>`;
  }

  /** `procedures_defreturn` — statements then a RETURN value. */
  defReturn(procName: string, body: Stmt[], returnValue: string, x: number, y: number): string {
    return (
      `<block type="procedures_defreturn" id="${this.id()}" x="${x}" y="${y}">` +
      `<field name="NAME">${esc(procName)}</field>` +
      `<statement name="STACK">${this.chain(body)}</statement>` +
      `<value name="RETURN">${returnValue}</value>` +
      `</block>`
    );
  }

  /** `math_change` — increment a variable in place (cheaper than set+get+add). */
  change(name: string, delta: string): Stmt {
    return {
      type: "math_change",
      inner: `<field name="VAR" id="${this.variable(name)}">${esc(name)}</field><value name="DELTA">${delta}</value>`,
    };
  }
}
