/**
 * Deriv trade rejections — what the broker actually said, and what a trader
 * should read.
 *
 * WHY THIS EXISTS: `executeLiveTrade` used to throw `new Error(msg.error.message)`,
 * which threw away the two things that decide how an engine must react:
 *
 *   1. the error CODE (`InvalidContractProposal`, `InsufficientBalance`, ...)
 *   2. the STAGE that produced it (`proposal` or `buy`)
 *
 * The same Deriv text means two completely different things depending on the
 * stage. "Unknown contract proposal" (`InvalidContractProposal`) is the classic
 * example:
 *
 *   - from `buy`   → the proposal ID we quoted is no longer known to the session
 *                    that received the purchase. The quote went stale (the buy
 *                    waited behind the account socket's send pacing or a
 *                    rate-limit pause) or the pooled socket re-handshook between
 *                    quote and purchase, so the ID belonged to a dead session.
 *                    NO CONTRACT WAS CREATED — Deriv could not find the thing we
 *                    asked it to buy. Re-quoting and buying the fresh ID once is
 *                    safe and is not "repeating a buy".
 *   - from `proposal` → this account/symbol/currency is not offered that
 *                    contract at all (market access, closed market, unsupported
 *                    contract type or barrier). Deterministic: it will fail on
 *                    every tick and on every restart until the contract set or
 *                    the account changes.
 *
 * Treating both as one opaque string is what made the autonomous engine stop
 * with "Deriv rejected 3 consecutive 1-tick buys — last: Unknown contract
 * proposal" and then refuse to survive a restart: it kept re-buying the same
 * untradeable/stale quote three times and hard-stopped, every single time.
 *
 * This module is pure (no I/O, no state) so the vocabulary can be tested
 * directly and reused by every engine and route that talks to the broker.
 */

/** Which request the broker rejected. */
export type DerivRejectionStage = "proposal" | "buy" | "unknown";

/**
 * What the rejection MEANS for the caller:
 *
 * - `unknown-proposal`     quote→purchase handoff broke; re-quote once, no strike
 * - `contract-unavailable` this account cannot trade this contract; quarantine it
 * - `account-blocked`      the account itself may not trade; stop, do not retry
 * - `transient`            rate limit / temporary / price moved; hold and retry
 * - `unspecified`          any other definite rejection
 */
export type DerivRejectionKind =
  | "unknown-proposal"
  | "contract-unavailable"
  | "account-blocked"
  | "transient"
  | "unspecified";

export interface DerivRejection {
  /** Where the rejection came from. Unknown callers may pass "unknown". */
  stage: DerivRejectionStage;
  code?: string | null;
  message?: string | null;
}

/** Broker codes for "the proposal ID you sent me means nothing here". */
const UNKNOWN_PROPOSAL_CODES = new Set([
  "InvalidContractProposal",
  "InvalidProposal",
  "ProposalNotFound",
]);

/** Broker codes for "this account/symbol/currency is not offered that contract". */
const CONTRACT_UNAVAILABLE_CODES = new Set([
  "UnknownContract",
  "UnknownContractProposal",
  "InvalidContract",
  "InvalidSymbol",
  "InvalidMarket",
  "MarketClosed",
  "MarketNotOpen",
  "MarketIsClosed",
  "ContractNotAllowed",
  "ContractTypeNotAllowed",
  "InvalidContractType",
  "ContractBuyValidationError",
  "InvalidBarrier",
  "BarrierOutOfRange",
  "InvalidDuration",
]);

/** Broker codes for "the account may not trade right now" — never retried. */
const ACCOUNT_BLOCKED_CODES = new Set([
  "InsufficientBalance",
  "InsufficientFund",
  "InsufficientFunds",
  "BalanceError",
  "DisabledClient",
  "AccountDisabled",
  "AccountClosed",
  "SelfExclusion",
  "SelfExcluded",
  "AuthorizationRequired",
  "InvalidToken",
  "AuthorizationError",
  "PermissionDenied",
  "NotAllowed",
  "TradingNotAllowed",
  "ClientRestriction",
  "RestrictedCountry",
]);

/** Broker codes that clear on their own — the contract itself is fine. */
const TRANSIENT_CODES = new Set([
  "RateLimit",
  "RateLimitReached",
  "TemporaryUnavailable",
  "TemporaryError",
  "CircuitBreakerBusy",
  "ServiceUnavailable",
  "InternalError",
  "PriceMoved",
  "PriceError",
  "StaleQuote",
]);

const UNKNOWN_PROPOSAL_TEXT =
  /unknown contract proposal|proposal (?:id )?(?:is )?(?:not found|unknown|invalid|expired|no longer (?:valid|available))|invalid proposal|no such proposal|proposal has expired/i;
const CONTRACT_UNAVAILABLE_TEXT =
  /unknown contract|contract (?:type )?(?:is )?(?:not|un)available|not (?:offered|available|allowed|supported)|market (?:is )?closed|symbol (?:is )?(?:invalid|not|unavailable)|invalid (?:symbol|barrier|contract|duration)|contract validation failed/i;
const ACCOUNT_BLOCKED_TEXT =
  /insufficient (?:balance|fund)|balance is|self[- ]exclu|account (?:is )?(?:disabled|closed|restricted|blocked)|client (?:is )?(?:disabled|restricted)|not authorized|unauthoriz|authoriz(?:e|ation) (?:failed|required)|invalid token|session expired|country (?:is )?not (?:allowed|supported)|kyc|verification required/i;
const TRANSIENT_TEXT =
  /rate limit|too many|temporar|try again|timed out|timeout|service unavailable|internal server error|price mov|quote (?:has )?moved|stale|connection (?:was |is )?(?:closed|lost|interrupted|unavailable)|socket|reconnect|no connection|network/i;

/**
 * Classify one broker rejection. `stage` decides between "the quote went stale"
 * and "this account cannot trade that contract" whenever the code is ambiguous —
 * `InvalidContractProposal` and friends arrive from both requests.
 */
export function classifyDerivRejection(rejection: DerivRejection): DerivRejectionKind {
  const code = String(rejection.code ?? "").trim();
  const message = String(rejection.message ?? "");
  const stage = rejection.stage;

  // 1. Nothing the caller did wrong and nothing about the account: the broker is
  //    busy or the quote repriced. Checked first because `RateLimit` text also
  //    matches "too many" inside longer envelopes.
  if (TRANSIENT_CODES.has(code)) return "transient";

  // 2. Account-level refusals are definite and identical on every retry.
  if (ACCOUNT_BLOCKED_CODES.has(code)) return "account-blocked";
  if (ACCOUNT_BLOCKED_TEXT.test(message)) return "account-blocked";

  // 3. The handoff broke: a `buy` whose proposal ID is unknown created nothing.
  if (stage === "buy" && (UNKNOWN_PROPOSAL_CODES.has(code) || UNKNOWN_PROPOSAL_TEXT.test(message))) {
    return "unknown-proposal";
  }
  // `UnknownContract` is the same family, and Deriv has used it for both stages.
  if (stage === "buy" && code === "UnknownContract") return "unknown-proposal";

  // 4. The same codes out of `proposal` mean the contract is not on offer here.
  if (
    stage === "proposal" &&
    (UNKNOWN_PROPOSAL_CODES.has(code) ||
      code === "UnknownContract" ||
      UNKNOWN_PROPOSAL_TEXT.test(message))
  ) {
    return "contract-unavailable";
  }
  if (CONTRACT_UNAVAILABLE_CODES.has(code)) return "contract-unavailable";
  if (CONTRACT_UNAVAILABLE_TEXT.test(message)) return "contract-unavailable";

  // 5. Transient text without a known code (the broker words these freely).
  if (TRANSIENT_TEXT.test(message)) return "transient";

  return "unspecified";
}

/** True when the proposal ID we bought was unknown to the session that got the buy. */
export function isUnknownProposalRejection(rejection: DerivRejection): boolean {
  return classifyDerivRejection(rejection) === "unknown-proposal";
}

/**
 * Read a rejection straight off a Deriv WebSocket envelope
 * (`{ error: { code, message }, msg_type }`). `msg_type` gives the stage.
 */
export function rejectionFromEnvelope(msg: any, fallbackStage: DerivRejectionStage): DerivRejection {
  const error = msg?.error ?? null;
  const msgType = String(msg?.msg_type ?? "");
  const stage: DerivRejectionStage =
    msgType === "proposal" || msgType === "buy" ? (msgType as DerivRejectionStage) : fallbackStage;
  return { stage, code: error?.code ?? null, message: error?.message ?? null };
}

/** One sentence per kind, for stop reasons, the journal and SSE payloads. */
const KIND_EXPLANATION: Record<DerivRejectionKind, string> = {
  "unknown-proposal":
    "the quote expired or the trading session was replaced before the purchase reached Deriv, so no contract was created",
  "contract-unavailable": "this Deriv account is not offered that contract on that market",
  "account-blocked": "Deriv will not let this account trade right now",
  transient: "Deriv is throttling or temporarily unable to price this account",
  unspecified: "Deriv rejected the purchase",
};

export function explainRejectionKind(kind: DerivRejectionKind): string {
  return KIND_EXPLANATION[kind];
}

/**
 * Build the sentence a trader should see. Always names the market and contract
 * (the raw broker text never does) and keeps the broker's own words and code so
 * a support ticket can be answered from the message alone.
 */
export function describeDerivRejection(input: {
  kind: DerivRejectionKind;
  code?: string | null;
  message?: string | null;
  symbol?: string | null;
  /** Human label — "Over 3", "Rise", "Matches auto" — not the raw contract type. */
  contractLabel?: string | null;
  stage?: DerivRejectionStage;
}): string {
  const brokerText = String(input.message ?? "").trim() || "Deriv rejected the trade";
  const code = String(input.code ?? "").trim();
  const coded = code ? ` (Deriv code ${code})` : "";
  const subject = [input.contractLabel, input.symbol].filter(Boolean).join(" on ");
  const explanation = explainRejectionKind(input.kind);
  return subject
    ? `${brokerText}${coded} — ${subject}: ${explanation}.`
    : `${brokerText}${coded} — ${explanation}.`;
}
