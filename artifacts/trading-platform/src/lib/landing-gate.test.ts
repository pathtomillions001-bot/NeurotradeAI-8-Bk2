/**
 * Landing-gate routing rules.
 *
 * Regression cover for the reported refresh bug:
 *   "when I refresh, I'm first taken into the app and then bounced back to the
 *    landing page; and refreshing on Bots/Connect throws me back to landing."
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { landingGateState, markLandingDismissed, isLandingDismissed } from "./landing-gate.js";

const base = { dismissed: false, isLoading: false, hasAccount: false, timedOut: false };

describe("landingGateState", () => {
  it("is undecided while the account check is in flight — never paints the app first", () => {
    // THE FLASH BUG: previously this state rendered the Dashboard, which was
    // then replaced by the landing page once the request resolved.
    assert.equal(landingGateState({ ...base, isLoading: true }), "undecided");
  });

  it("shows the landing page on the root for a first-time visitor", () => {
    assert.equal(landingGateState({ ...base }), "landing");
  });

  it("shows the app for a connected visitor even if never dismissed", () => {
    assert.equal(landingGateState({ ...base, hasAccount: true }), "app");
  });

  it("shows the app for a returning visitor without waiting on the account check", () => {
    // A dismissed visitor must render instantly — no boot splash on refresh.
    assert.equal(landingGateState({ ...base, dismissed: true, isLoading: true }), "app");
  });

  it("falls back to the landing page after the safety timeout", () => {
    assert.equal(landingGateState({ ...base, isLoading: true, timedOut: true }), "landing");
  });

  it("never shows the landing page to a connected visitor after a timeout", () => {
    assert.equal(
      landingGateState({ ...base, isLoading: true, timedOut: true, hasAccount: true }),
      "app",
    );
  });
});

describe("entered-the-app flag", () => {
  it("is sticky once set — a connect or a landing click-through is permanent", () => {
    assert.equal(isLandingDismissed(), false);
    markLandingDismissed();
    assert.equal(isLandingDismissed(), true);
    markLandingDismissed(); // idempotent
    assert.equal(isLandingDismissed(), true);
  });
});
