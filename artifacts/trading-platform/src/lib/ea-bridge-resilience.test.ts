/**
 * The EA must not throw away its saved link just because one answer was a 401.
 *
 * WHY THIS TEST EXISTS: a user reported the terminal losing the Desk "by
 * itself" — the EA still on the chart, the journal full of
 *
 *   HTTP 401 from /api/bridge/sync — {"error":"Invalid or revoked bridge token."}
 *   HTTP 401 from /api/bridge/pair — {"error":"Unknown or expired pairing code."}
 *
 * and nobody having pressed "Unlink". Both credentials live in the same store,
 * so anything that made that store unreadable for a few seconds — a deploy, a
 * database failover, the bootstrap DDL still being applied while the HTTP port
 * was already open, a second replica that had not seen the row — condemned both
 * at once. The server answered 401 for "I could not check", and the EA's
 * contract for 401 was "this credential is dead": it emptied `g_token`, wrote
 * that empty token over the link file in the terminal's COMMON folder (shared
 * by every chart of that account, so one chart's bad answer disarmed all of
 * them), disabled trading, and fell back to a pairing code that had failed for
 * the same reason. A transient server fault became a permanent disconnection
 * that only a human pasting a fresh code could undo.
 *
 * The fix has two halves: the server now answers 503 with
 * `code: "bridge_store_unavailable"` when it could not verify a credential, and
 * 401 with `code: "bridge_link_revoked"` only for an actual revocation
 * (`mt5-bridge-durability.test.ts` proves that half). This file pins the
 * terminal half, statically, because the EA is MQL5 and nothing here can run
 * it — the same position `ea-source-integrity.test.ts` takes for the v3.05
 * compile failure.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..", "..");
const eaSourcePath = path.join(repoRoot, "artifacts", "mt5-ea", "NeurotradeBridge.mq5");
const publishedPath = path.join(
  repoRoot,
  "artifacts",
  "trading-platform",
  "public",
  "downloads",
  "NeurotradeBridge.mq5",
);
const ea = fs.readFileSync(eaSourcePath, "utf8");

/** Strip comments so a rule is never satisfied by the prose describing it. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * The body of one MQL5 function, matched by brace depth.
 *
 * Located by its DEFINITION (a return type followed by the name), not by the
 * first occurrence of `name(` — these functions are all called from `OnTimer`
 * long before they are defined, and matching the call site returns somebody
 * else's body.
 */
function functionBody(name: string): string {
  const code = codeOnly(ea);
  const definition = new RegExp(
    `(?:^|\\n)\\s*(?:void|bool|int|string|double|long|ulong|datetime)\\s+${name}\\s*\\(`,
  );
  const match = definition.exec(code);
  assert.ok(match, `the EA must define ${name}()`);
  const open = code.indexOf("{", match.index + match[0].length);
  assert.ok(open >= 0, `${name}() must have a body`);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

test("HttpPost — the lowest level — never discards the token", () => {
  const body = functionBody("HttpPost");
  // This is where v3.05 did it: `if(status == 401 && authenticated) { g_token = ""; … SaveLink(); }`.
  // A function that cannot know whether the refusal was verified must not be
  // allowed to destroy a credential on the strength of a status code.
  assert.doesNotMatch(body, /g_token\s*=\s*""/, "HttpPost must not clear the token");
  assert.doesNotMatch(body, /SaveLink\s*\(/, "HttpPost must not rewrite the saved link file");
  assert.doesNotMatch(body, /ForgetSavedLinkToken\s*\(/, "HttpPost must not forget the saved link");
  // It still has to hand the verdict up, or the callers cannot decide.
  assert.match(body, /g_lastHttpCode\s*=\s*JsonString\(response,\s*"code"\)/, "HttpPost must publish the server's machine-readable code");
  assert.match(body, /g_lastHttpStatus\s*=\s*status/, "HttpPost must publish the status");
});

test("only an explicit revocation may clear the token on sight", () => {
  const body = functionBody("Sync");
  assert.match(
    body,
    /g_lastHttpCode\s*==\s*"bridge_link_revoked"/,
    "Sync must distinguish a revocation from an unverified refusal",
  );

  // Every `g_token = ""` in Sync must sit in a branch that has already decided
  // the refusal is final: a revocation, a 409 handover, or a spent retry budget.
  const clears = body.split("\n").map((line, index) => ({ line, index })).filter((entry) => /g_token\s*=\s*""/.test(entry.line));
  assert.ok(clears.length >= 2, "Sync clears the token for a revocation and for a spent budget");
  for (const { index } of clears) {
    const before = body.split("\n").slice(Math.max(0, index - 40), index + 1).join("\n");
    const justified =
      /"bridge_link_revoked"/.test(before) ||
      /g_lastHttpStatus\s*==\s*409/.test(before) ||
      /g_tokenRefusals\s*>=\s*TOKEN_REFUSAL_GRACE/.test(before);
    assert.ok(
      justified,
      `Sync clears the saved token at line offset ${index} without a final verdict above it`,
    );
  }
});

test("an unverified refusal is retried, spaced out, before the token is abandoned", () => {
  assert.match(ea, /#define\s+TOKEN_REFUSAL_GRACE\s+(\d+)/, "the grace budget must exist");
  const grace = Number(ea.match(/#define\s+TOKEN_REFUSAL_GRACE\s+(\d+)/)![1]);
  assert.ok(grace >= 2, `one refusal must not be fatal (TOKEN_REFUSAL_GRACE=${grace})`);
  assert.ok(grace <= 20, `the budget must still end (TOKEN_REFUSAL_GRACE=${grace})`);

  const retrySeconds = Number(ea.match(/#define\s+TOKEN_RETRY_SECONDS\s+(\d+)/)![1]);
  assert.ok(retrySeconds >= 5, "retries must be spaced — a 500 ms heartbeat must not become a 500 ms 401 loop");

  const body = functionBody("Sync");
  assert.match(body, /g_tokenRefusals\+\+/, "each unverified refusal is counted");
  assert.match(body, /g_nextTokenRetry\s*=\s*NowServer\(\)\s*\+\s*TOKEN_RETRY_SECONDS/, "and spaced");

  // The spacing has to be honoured by the beat, or the counter is decoration.
  const timer = functionBody("OnTimer");
  assert.match(timer, /waitingForLinkRetry/, "OnTimer must hold the beat while a refused link is waiting out its spacing");
  assert.match(timer, /g_nextTokenRetry/, "OnTimer must compare against the retry clock");

  // A confirmed link clears the budget, so a LATER outage gets its own retries.
  assert.match(body, /g_tokenRefusals\s*=\s*0/, "the budget resets — on success and on abandonment");
});

test("a 5xx is transient and cannot reach the 'your code is dead' branch", () => {
  const http = functionBody("HttpPost");
  assert.match(http, /status\s*>=\s*500/, "HttpPost must recognise a server-side failure");
  // The 5xx branch returns before the generic print, so a rolling deploy does
  // not put a line in the journal every 500 ms.
  assert.match(http, /WarnServerOnce\s*\(/, "a 5xx is reported at a rate limit, not on every beat");

  const warn = functionBody("WarnServerOnce");
  assert.match(warn, /g_lastStoreWarnAt/, "the rate limit is remembered");
  assert.match(warn, /<\s*300/, "and it is minutes, not seconds");

  const pair = functionBody("TryPair");
  // Order matters: the 401 branch tells the user their code is dead. A 503 must
  // never fall into it, so the transient branch has to come first or be
  // explicit — assert the code the branch keys on, and that a 5xx is not it.
  assert.doesNotMatch(pair, /g_lastHttpStatus\s*>=\s*500\s*\)[\s\S]{0,200}not valid any more/, "a 5xx must not be reported as an expired code");
  assert.match(pair, /else\s*\{[\s\S]{0,200}g_pairAttemptDelaySeconds\s*=\s*5/, "anything else keeps retrying quickly");

  // A 5xx spaces the next beat by the server's own hint instead of sending a
  // full payload (quotes, candles, positions) twice a second at a service that
  // is already struggling — but it must never become an excuse to stop
  // counting the outage against the server-silence budget.
  const sync = functionBody("Sync");
  assert.match(sync, /g_lastHttpStatus\s*>=\s*500/, "Sync must recognise a server-side failure");
  assert.match(sync, /JsonNumber\(response,\s*"retryAfterMs"\)/, "and honour the retry hint it carries");
  const silence = sync.indexOf("NowServer() - g_lastOk > ServerSilenceSec");
  const fiveHundred = sync.indexOf("g_lastHttpStatus >= 500");
  assert.ok(silence > fiveHundred, "the silence budget is evaluated after the 5xx branch");
  assert.doesNotMatch(
    sync.slice(fiveHundred, silence),
    /else\s+if\s*\(\s*NowServer\(\)\s*-\s*g_lastOk/,
    "the silence budget must run for EVERY failed beat, not only for the ones that are not a 5xx",
  );
});

test("OnDeinit names the reason MT5 stopped the expert", () => {
  const body = functionBody("OnDeinit");
  assert.match(body, /DeinitReasonText\s*\(\s*reason\s*\)/, "the bare reason number is no longer the whole answer");
  assert.match(body, /DeinitWasTerminalRestart\s*\(\s*reason\s*\)/, "a terminal-caused restart says so plainly");

  const reasons = functionBody("DeinitReasonText");
  /**
   * MQL5's ENUM_DEINIT_REASON, exactly as the reference documents it.
   *
   * These are NOT the MQL4 numbers and they do not start at 1, and the constant
   * family is `REASON_*` — there is no `DEINIT_PROGRAM` in MQL5, so writing one
   * is an "undeclared identifier" compile error. This EA has shipped a build
   * that did not compile before (docs/release-notes/mt5-ea-v305-compile-fix.md),
   * so both the NAMES and the VALUES are pinned here rather than trusted.
   */
  const deinitReasons: Array<[number, string]> = [
    [0, "REASON_PROGRAM"],
    [1, "REASON_REMOVE"],
    [2, "REASON_RECOMPILE"],
    [3, "REASON_CHARTCHANGE"],
    [4, "REASON_CHARTCLOSE"],
    [5, "REASON_PARAMETERS"],
    [6, "REASON_ACCOUNT"],
    [7, "REASON_TEMPLATE"],
    [8, "REASON_INITFAILED"],
    [9, "REASON_CLOSE"],
  ];
  for (const [, constant] of deinitReasons) {
    // Every code MT5 can pass, so an unexplained removal cannot come back as a
    // mystery number in a user's journal.
    assert.match(reasons, new RegExp(constant), `${constant} must be translated`);
  }
  // The wrong constant family would not compile at all.
  assert.doesNotMatch(codeOnly(ea), /\bDEINIT_[A-Z]+\b/, "MQL5 has no DEINIT_* constants — they are REASON_*");
  // And the numbers quoted to the reader must be the documented ones.
  for (const [value, constant] of deinitReasons) {
    assert.match(
      ea,
      // The table lives in the doc comment, so the line begins with " * ".
      new RegExp(`^\\s*\\*?\\s*${value}\\s+${constant}\\b`, "m"),
      `the documented value of ${constant} must be ${value}`,
    );
  }

  // The program never removes itself: that is the answer to "it detached
  // itself without me removing it", and it must stay true.
  assert.doesNotMatch(codeOnly(ea), /ExpertRemove\s*\(/, "the EA must never remove itself from the chart");
  const init = functionBody("OnInit");
  assert.match(init, /return\s*\(\s*INIT_SUCCEEDED\s*\)/, "OnInit must never fail to attach");
});

test("the shipped EA carries the v3.08 contract, and the Desk serves that same file", () => {
  const version = ea.match(/#property\s+version\s+"([^"]+)"/)![1];
  const reported = ea.match(/#define\s+EA_VERSION\s+"([^"]+)"/)![1];
  assert.equal(version, reported, "the declared version and the one sent on the wire must agree");
  assert.equal(version, "3.08");

  assert.equal(
    fs.readFileSync(publishedPath, "utf8"),
    ea,
    "public/downloads/NeurotradeBridge.mq5 is stale — run `node scripts/copy-mt5-ea.mjs`",
  );

  for (const marker of [
    "g_lastHttpCode",
    "bridge_link_revoked",
    "TOKEN_REFUSAL_GRACE",
    "WarnServerOnce",
    "DeinitReasonText",
  ]) {
    assert.match(ea, new RegExp(marker), `the published EA must carry the ${marker} contract`);
  }
});

/**
 * v3.08 — the link lives only as long as the terminal.
 *
 * The reversal of v3.03 note 9, pinned statically because the EA is MQL5 and
 * nothing here can run it. What must stay true of every future build:
 *
 *   • the bearer token is NEVER written to disk — the terminal's common folder
 *     held a link that outlived the session nobody closed on purpose;
 *   • a file an older build left behind is deleted, or the next MT5 start
 *     resumes a session the server has already released;
 *   • the pairing code comes only from the user's input — a remembered code is
 *     what let a closed terminal reconnect on a spent credential;
 *   • MT5 closing this chart or the terminal tells the server, so the link, its
 *     code and the account claim are freed immediately rather than after a
 *     timeout;
 *   • a code the server calls SPENT produces one actionable line, not a silent
 *     retry loop.
 */
test("the EA never persists its token, and removes what an older build left", () => {
  const code = codeOnly(ea);
  assert.doesNotMatch(code, /SaveLink\s*\(/, "the EA must not write a link file");
  assert.doesNotMatch(code, /LoadSavedLink\s*\(/, "the EA must not restore one");
  assert.doesNotMatch(code, /g_savedCode/, "a remembered pairing code is what v3.08 removed");
  assert.doesNotMatch(code, /g_savedCode/, "no remembered code");

  // The one place that touches the old file must DELETE it.
  const removal = functionBody("RemoveLegacyLinkFile");
  assert.match(removal, /FileDelete\s*\(/, "an older build's saved link must be deleted on attach");
  assert.doesNotMatch(removal, /FileWriteString\s*\(/, "and never rewritten");
  assert.match(code, /RemoveLegacyLinkFile\s*\(\s*\)\s*;/, "OnInit must call it");

  // No file WRITE may mention the token anywhere in the file: the position
  // manager's own records are the only thing this EA persists.
  for (const [, args] of ea.matchAll(/\bFileWriteString\s*\(([^;]*?)\)\s*;/g)) {
    assert.doesNotMatch(args, /g_token/, `the token must never reach a file: ${args}`);
  }
});

test("the pairing code is the user's input, and nothing else", () => {
  const body = functionBody("EffectivePairingCode");
  assert.match(body, /StringTrimmed\s*\(\s*PairingCode\s*\)/, "the input is the credential");
  // Any second source would be a remembered key by another name.
  assert.doesNotMatch(body, /g_/, "no global may stand in for the input");
  assert.equal(
    (body.match(/return/g) ?? []).length,
    1,
    "one return: there is no fallback code to fall back TO",
  );
});

test("closing the terminal tells the server, and only for the reasons that end a session", () => {
  const deinit = functionBody("OnDeinit");
  assert.match(deinit, /LinkEndsWithThisRun\s*\(\s*reason\s*\)/, "OnDeinit must ask whether the session is over");
  assert.match(deinit, /DisconnectBridge\s*\(/, "and say so to the server");

  const ends = functionBody("LinkEndsWithThisRun");
  for (const constant of ["REASON_CHARTCLOSE", "REASON_CLOSE", "REASON_INITFAILED", "REASON_ACCOUNT"]) {
    assert.match(ends, new RegExp(constant), `${constant} ends the link`);
  }
  // REASON_REMOVE is what MT5 also reports for some symbol/timeframe changes:
  // disconnecting there would drop a live link every time a user switched
  // timeframe, so it must stay out.
  assert.doesNotMatch(
    ends,
    /REASON_REMOVE/,
    "REASON_REMOVE must not end the link — MT5 reports symbol/timeframe changes with it",
  );

  const disconnect = functionBody("DisconnectBridge");
  assert.match(disconnect, /\/api\/bridge\/disconnect/, "the endpoint the server exposes");
  assert.match(disconnect, /true\s*\)/, "and it is authenticated with the token");
  // The token stays: MT5 may re-attach the EA while the link is still live.
  assert.doesNotMatch(disconnect, /g_token\s*=\s*""/, "a disconnect must not discard the token by itself");
});

test("a spent code is answered with something the user can act on", () => {
  const pair = functionBody("TryPair");
  assert.match(
    pair,
    /pairing_code_spent/,
    "the server's spent-code verdict must have its own branch, or the journal says 'not valid any more' for the ordinary case",
  );
  const spentLine = pair.slice(pair.indexOf("pairing_code_spent"));
  assert.match(
    spentLine.slice(0, 600),
    /Desk -> Link MT5/,
    "and the line must tell the user to fetch a NEW code",
  );
});
