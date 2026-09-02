/**
 * Regression tests for the friendly-error sanitizer.
 *
 * Bug context: a transient Deriv outage (Cloudflare 502 HTML page, or 503
 * {"errors":[{"code":"CircuitBreakerBusy",...}]}) was dumped VERBATIM into the
 * FAB activity panel and trade journal via `Trade retry: ${err.message}`.
 * These tests pin the contract: infra noise never reaches user-visible text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  describeDerivHttpFailure,
  friendlyErrorMessage,
  isTransientDerivFailure,
} from "./friendly-error.ts";

const CLOUDFLARE_502_BODY = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if gt IE 8]><!--> <html class="no-js" lang="en-US"> <!--<![endif]-->
<head> <title>derivws.com | 502: Bad gateway</title> <meta charset="UTF-8" /> </head>
<body> <div id="cf-wrapper"> <h1> <span>Bad gateway</span> <span class="code-label">Error code 502</span> </h1>
<div>Visit <a href="https://www.cloudflare.com/5xx-error-landing">cloudflare.com</a> for more information.</div>
<div class="mt-3">2026-09-02 07:03:04 UTC</div> </div> </body> </html>`;

const CIRCUIT_BREAKER_503_BODY = `{"errors":[{"code":"CircuitBreakerBusy","message":"Service temporarily unavailable. A health probe is in progress.","status":503}]}`;

test("OTP 503 CircuitBreakerBusy envelope → friendly one-liner, no JSON", () => {
  // The OLD error format: `OTP request failed: 503 {"errors":[...]}`
  const legacy = new Error(`OTP request failed: 503 ${CIRCUIT_BREAKER_503_BODY}`);
  const msg = friendlyErrorMessage(legacy);
  assert.match(msg, /health check/i);
  assert.ok(!msg.includes("{"), "must not contain JSON");
  assert.ok(!msg.includes("CircuitBreakerBusy"), "must not contain raw error codes");
  assert.ok(msg.length <= 160);
});

test("Cloudflare 502 HTML page → friendly one-liner, zero HTML tags", () => {
  const legacy = new Error(`OTP request failed: 502 ${CLOUDFLARE_502_BODY}`);
  const msg = friendlyErrorMessage(legacy);
  assert.ok(!/<[a-z!\/]/i.test(msg), `must not contain HTML tags: ${msg}`);
  assert.ok(!msg.includes("<!DOCTYPE"), "must not contain doctype");
  assert.ok(/502|gateway/i.test(msg), "should still mention the status meaningfully");
  assert.ok(/temporar|retry/i.test(msg), "should reassure that it is temporary / retried");
  assert.ok(msg.length <= 160);
});

test("describeDerivHttpFailure keeps HTML bodies out of thrown errors", () => {
  const msg = describeDerivHttpFailure("Trading session handshake (OTP)", 502, CLOUDFLARE_502_BODY);
  assert.ok(!/<[a-z!\/]/i.test(msg), "no HTML in thrown message");
  assert.match(msg, /Trading session handshake/);
  assert.match(msg, /edge network/i);
});

test("describeDerivHttpFailure explains CircuitBreakerBusy without the code", () => {
  const msg = describeDerivHttpFailure("Trading session handshake (OTP)", 503, CIRCUIT_BREAKER_503_BODY);
  assert.match(msg, /health check/i);
  assert.ok(!msg.includes("{"), "no JSON in thrown message");
});

test("transient classification: 5xx + circuit breaker + edge pages", () => {
  assert.equal(isTransientDerivFailure(503, CIRCUIT_BREAKER_503_BODY), true);
  assert.equal(isTransientDerivFailure(502, CLOUDFLARE_502_BODY), true);
  assert.equal(isTransientDerivFailure(429, ""), true);
  assert.equal(isTransientDerivFailure(401, `{"errors":[{"code":"AuthorizationRequired"}]}`), false);
  assert.equal(isTransientDerivFailure(400, `{"errors":[{"code":"InputValidationFailed"}]}`), false);
});

test("non-Error inputs and short clean messages pass through sanely", () => {
  assert.equal(friendlyErrorMessage("plain failure"), "plain failure");
  assert.equal(friendlyErrorMessage(undefined), "An unexpected error occurred — retrying.");
  assert.match(
    friendlyErrorMessage(new Error("request timeout: ECONNRESET")),
    /interrupted/i,
  );
});

test("very long unknown messages are truncated, never dumped raw", () => {
  const long = "x".repeat(2000);
  const msg = friendlyErrorMessage(new Error(long));
  assert.ok(msg.length <= 160);
});
