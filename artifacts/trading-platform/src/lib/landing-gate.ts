/**
 * Landing-page "entered the app" flag.
 *
 * The landing page is a FIRST-VISIT funnel for the site root only. Once a
 * visitor has entered the app — by clicking through the landing page OR by
 * connecting a Deriv account — they must never be shown the funnel again, on
 * any refresh, in any tab.
 *
 * Kept in a tiny module (rather than inline in App.tsx) so non-router code such
 * as the connect flow can mark the visitor as entered without reaching into the
 * router's state.
 */

const LANDING_DISMISSED_KEY = "neurotrade_landing_dismissed";

/** True once the visitor has entered the app at least once on this browser. */
export function isLandingDismissed(): boolean {
  try {
    return localStorage.getItem(LANDING_DISMISSED_KEY) === "1";
  } catch {
    // Storage blocked (private mode / partitioned iframe): fall back to the
    // in-memory flag only, so the funnel cannot reappear mid-session.
    return memoryDismissed;
  }
}

let memoryDismissed = false;

/** Mark the visitor as having entered the app (idempotent, never cleared). */
export function markLandingDismissed(): void {
  memoryDismissed = true;
  try {
    localStorage.setItem(LANDING_DISMISSED_KEY, "1");
  } catch {
    /* non-critical — the in-memory flag still holds for this session */
  }
}

/** What the site root should render. */
export type LandingGateState = "undecided" | "landing" | "app";

/**
 * The routing decision for the site root, as a pure function.
 *
 * Order matters and encodes the two bugs this fixes:
 *  - "undecided" exists so the app is NEVER painted before the decision is
 *    known (the old flow rendered the Dashboard for a frame and then swapped in
 *    the landing page — the flash the user saw on refresh).
 *  - "app" wins for anyone who has entered before, so refreshing never throws a
 *    returning user back into the funnel.
 */
export function landingGateState(input: {
  /** The visitor has entered the app before (or just connected an account). */
  dismissed: boolean;
  /** The "is an account connected?" query has not resolved yet. */
  isLoading: boolean;
  /** An account IS connected for this browser. */
  hasAccount: boolean;
  /** The gate waited too long — decide with what we have. */
  timedOut: boolean;
}): LandingGateState {
  const { dismissed, isLoading, hasAccount, timedOut } = input;
  if (dismissed) return "app";
  if (isLoading && !timedOut) return "undecided";
  return hasAccount ? "app" : "landing";
}
