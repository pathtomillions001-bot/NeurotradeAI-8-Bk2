/**
 * Autonomous engine — what to do when Deriv refuses a 1-tick purchase (pure).
 *
 * The engine used to treat EVERY definite rejection the same way: bump a
 * counter and hard-stop after three with the broker's raw text. That is wrong in
 * both directions.
 *
 *  - A rejected quote→purchase handoff ("Unknown contract proposal",
 *    `InvalidContractProposal`) placed nothing and says nothing about the
 *    account's ability to trade. `executeLiveTrade` already re-quotes once; if
 *    the broker still refuses, the engine should hold and try the next tick —
 *    not die after three ticks with a message nobody can act on.
 *  - A contract this account is not offered (market access, closed market,
 *    unsupported contract type or barrier) fails identically on every tick and
 *    after every restart. Retrying it three times and stopping teaches the user
 *    nothing; the engine should stop trading THAT candidate immediately, keep
 *    trading the rest of the selected set, and only stop itself when nothing in
 *    the set can be traded — then say exactly which contract on which market
 *    the account cannot trade.
 *  - An account-level refusal (no balance, self-exclusion, disabled client,
 *    expired authorisation) is not a streak at all. It stops the engine on the
 *    first occurrence with the reason and the way out.
 *
 * The policy is pure so it can be tested without a broker, a socket or a
 * database; cycle.ts only applies the returned action.
 */

import {
  classifyDerivRejection,
  describeDerivRejection,
  type DerivRejectionKind,
  type DerivRejectionStage,
} from "../trade-rejection";

/** Definite, unclassified rejections before the engine stops (unchanged behaviour). */
export const EXEC_FAILURE_LIMIT = 3;

/**
 * Quote-handoff / throttling refusals before the engine stops. These place
 * nothing and usually clear within seconds, so the budget is deliberately much
 * larger than the definite-rejection budget — but it is still finite: an engine
 * that can never reach the broker must stop and say so rather than spin forever.
 */
export const QUOTE_FAILURE_LIMIT = 8;

export interface ExecutionFailureState {
  /** Consecutive definite, unclassified rejections. Reset by any placed trade. */
  execFailures: number;
  /** Consecutive quote-handoff / throttling refusals. Reset by any placed trade. */
  quoteFailures: number;
  /** Candidate keys this run already learned the account cannot trade. */
  blocked: readonly string[];
  /** Every candidate key the engine could build on this tick. */
  candidateKeys: readonly string[];
}

export interface ExecutionFailureInput {
  /** Deriv error code, when the caller has one. */
  code?: string | null;
  /** Broker text, e.g. "Unknown contract proposal". */
  message?: string | null;
  /** Which request was rejected. Unknown is treated conservatively. */
  stage?: DerivRejectionStage;
  /** Pre-classified kind, when the caller already has one (`DerivTradeError`). */
  kind?: DerivRejectionKind;
  symbol: string;
  contractType: string;
  /** Digit barrier, or -1 when the contract has none. */
  barrier: number;
  /** `symbol:contract:barrier` — the identity the engine ranks candidates by. */
  candidateKey: string;
  /** Human label ("Over 3", "Rise") when the caller has one. */
  contractLabel?: string | null;
  state: ExecutionFailureState;
}

export interface ExecutionFailureAction {
  kind: DerivRejectionKind;
  /** Add `candidateKey` to this run's blocked set. */
  quarantine: boolean;
  countAsExecFailure: boolean;
  countAsQuoteFailure: boolean;
  stop: boolean;
  /** Stop reason shown in the UI when `stop` is true. */
  reason?: string;
  /** Journal / SSE line used when the engine keeps running. */
  held: string;
}

/** Ways out, per account-level refusal — the message must be actionable. */
function accountHint(code: string, message: string): string {
  const text = `${code} ${message}`.toLowerCase();
  if (text.includes("insufficient") || text.includes("balance")) {
    return "Lower the stake or top up this Deriv account, then start the engine again.";
  }
  if (text.includes("self-exclu") || text.includes("selfexclu")) {
    return "This account is self-excluded from trading — lift the exclusion in your Deriv account settings or connect a different account.";
  }
  if (text.includes("disabled") || text.includes("closed") || text.includes("restrict")) {
    return "Deriv has restricted this account — check its status in your Deriv account settings, or connect an account that can trade.";
  }
  if (text.includes("authoriz") || text.includes("token") || text.includes("session")) {
    return "Reconnect this Deriv account from the Connect page, then start the engine again.";
  }
  return "Check this account's status on Deriv, then start the engine again.";
}

/** True when the refused candidate was the last one this account could trade. */
function nothingTradeableLeft(input: ExecutionFailureInput): boolean {
  const keys = input.state.candidateKeys;
  if (keys.length === 0) return false;
  return keys.every((key) => key === input.candidateKey || input.state.blocked.includes(key));
}

export function decideExecutionFailure(input: ExecutionFailureInput): ExecutionFailureAction {
  const kind =
    input.kind ??
    classifyDerivRejection({
      stage: input.stage ?? "unknown",
      code: input.code ?? null,
      message: input.message ?? null,
    });
  const described = describeDerivRejection({
    kind,
    code: input.code ?? null,
    message: input.message ?? null,
    symbol: input.symbol,
    contractLabel: input.contractLabel ?? input.contractType,
    stage: input.stage ?? "unknown",
  });

  switch (kind) {
    case "account-blocked":
      return {
        kind,
        quarantine: false,
        countAsExecFailure: false,
        countAsQuoteFailure: false,
        stop: true,
        reason: `Stopped: Deriv will not let this account trade — ${described} ${accountHint(
          String(input.code ?? ""),
          String(input.message ?? ""),
        )}`,
        held: described,
      };

    case "contract-unavailable": {
      const last = nothingTradeableLeft(input);
      return {
        kind,
        quarantine: true,
        countAsExecFailure: false,
        countAsQuoteFailure: false,
        stop: last,
        reason: last
          ? `Stopped: this Deriv account cannot trade any contract in your selected set — ${described} ` +
            "The engine skipped every rejected contract and ran out of alternatives. " +
            "Pick different contracts or markets, or connect an account that can trade synthetic indices."
          : undefined,
        held: last
          ? described
          : `${described} Skipping that contract for this run and trading the rest of your selected set.`,
      };
    }

    case "unknown-proposal":
    case "transient": {
      const quoteFailures = input.state.quoteFailures + 1;
      const stop = quoteFailures >= QUOTE_FAILURE_LIMIT;
      return {
        kind,
        quarantine: false,
        countAsExecFailure: false,
        countAsQuoteFailure: true,
        stop,
        reason: stop
          ? `Stopped: Deriv refused ${QUOTE_FAILURE_LIMIT} quote→purchase handoffs in a row on this account — ${described} ` +
            "No contract was created and no money moved. The engine re-quoted on a fresh trading session each time. " +
            "This is usually Deriv throttling the account's connection: wait a minute and start again, and close other " +
            "apps or tabs trading the same Deriv login."
          : undefined,
        held: stop
          ? described
          : `${described} Nothing was purchased — the engine holds and re-quotes on the next tick (${quoteFailures}/${QUOTE_FAILURE_LIMIT}).`,
      };
    }

    case "unspecified":
    default: {
      const execFailures = input.state.execFailures + 1;
      const stop = execFailures >= EXEC_FAILURE_LIMIT;
      return {
        kind,
        quarantine: false,
        countAsExecFailure: true,
        countAsQuoteFailure: false,
        stop,
        reason: stop
          ? `Deriv rejected ${EXEC_FAILURE_LIMIT} consecutive 1-tick buys — last: ${described}`
          : undefined,
        held: described,
      };
    }
  }
}
