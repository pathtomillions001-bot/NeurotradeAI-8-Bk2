import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
import { LiveBotsProvider } from "@/lib/live-bots";
import LandingPage from "./pages/landing";

import Dashboard from "./pages/dashboard";
import Markets from "./pages/markets";
import MarketDetail from "./pages/market-detail";
import Trades from "./pages/trades";
import Analytics from "./pages/analytics";
import Connect from "./pages/connect";
import Settings from "./pages/settings";
import Intelligence from "./pages/intelligence";
import RiskCalculator from "./pages/risk-calculator";
import Bots from "./pages/bots";
import { onSessionChange, withTabSession } from "@/lib/tab-session";
import {
  isLandingDismissed,
  landingGateState,
  markLandingDismissed,
  type LandingGateState,
} from "@/lib/landing-gate";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function getApiUrl(path: string) {
  return `${BASE}/api${path}`;
}

// ── Global midnight-reset hook ────────────────────────────────────────────────
// 1. On mount: tells the server the browser's timezone offset so all "today"
//    boundaries (daily stats, recovery state, session counters) align with the
//    user's local clock rather than server UTC.
// 2. Schedules a setTimeout that fires at EXACTLY local midnight → calls
//    POST /api/ai/day-reset?reset=true which clears all in-memory counters on
//    the server and broadcasts a `day_reset` SSE event.
// 3. Listens for the `day_reset` SSE event (may come from the server-side
//    scheduler when the browser is not the trigger) and invalidates every
//    daily-data React Query cache so all pages re-fetch immediately with no lag.
function useSessionChangeRefresh() {
  // The server may serve a this tab a DIFFERENT session than its own: a fresh
  // tab inherits the durable browser binding, and connect/disconnect rotate the
  // identity. Everything already cached belongs to the previous identity, so
  // the whole cache is invalidated the moment that happens — otherwise the UI
  // would keep showing the previous account's journal/intelligence.
  const qc = useQueryClient();
  useEffect(() => onSessionChange(() => qc.invalidateQueries()), [qc]);
}

function useMidnightReset() {
  const qc = useQueryClient();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const tzOffsetMin = new Date().getTimezoneOffset(); // UTC − local, browser convention

    // ── Tell the server our timezone ────────────────────────────────────────
    fetch(getApiUrl("/ai/day-reset"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tzOffsetMin, reset: false }),
    }).catch(() => { /* non-critical */ });

    // ── SSE listener for day_reset (server fires this at midnight) ──────────
    const es = new EventSource(withTabSession(getApiUrl("/ai/events")));
    es.addEventListener("day_reset", () => {
      qc.invalidateQueries(); // invalidate everything — new day, fresh slate
    });

    // ── Compute ms until next local midnight ────────────────────────────────
    function msUntilLocalMidnight(): number {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      return Math.max(tomorrow.getTime() - now.getTime(), 1_000);
    }

    // ── Schedule the client-side midnight trigger ────────────────────────────
    function scheduleReset() {
      const ms = msUntilLocalMidnight();
      timerRef.current = setTimeout(() => {
        // Tell the server to perform the reset + broadcast SSE
        fetch(getApiUrl("/ai/day-reset"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tzOffsetMin: new Date().getTimezoneOffset(), reset: true }),
        }).catch(() => { /* non-critical — server-side scheduler is the fallback */ });

        // Also invalidate locally in case SSE delivery is delayed
        qc.invalidateQueries();

        // Reschedule for the next midnight
        scheduleReset();
      }, ms);
    }
    scheduleReset();

    return () => {
      es.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * How long the root gate is allowed to wait for the "is an account connected?"
 * answer before deciding with what it has. Purely a safety net: the account
 * query normally settles in a few hundred milliseconds, but a hung request must
 * never leave a visitor staring at the boot splash.
 */
const LANDING_GATE_TIMEOUT_MS = 6_000;

/**
 * Landing-page gate — decides what the SITE ROOT renders.
 *
 * Three rules, in order:
 *  1. It only ever applies to the root path. Every other path is a deep link
 *     the visitor explicitly asked for, so refreshing /bots, /connect, /trades…
 *     keeps them exactly there.
 *  2. It resolves BEFORE anything of the app is painted. The old code rendered
 *     the Dashboard for one frame while the account query was in flight and
 *     then replaced it with the landing page — the "app flashes, then bounces
 *     me back to the landing page" refresh bug.
 *  3. A visitor who is actually connected (or who already entered the app
 *     once) is permanently marked as entered, so neither a refresh nor a later
 *     disconnect can ever throw them back to the funnel.
 */
function useLandingGate() {
  const [dismissedState, setDismissedState] = useState(isLandingDismissed);
  const [timedOut, setTimedOut] = useState(false);
  // Re-read the flag on every render: the connect flow marks the visitor as
  // entered outside React, and navigating to "/" must honour that immediately
  // (otherwise a just-connected user would be shown the funnel they skipped).
  const dismissed = dismissedState || isLandingDismissed();

  const { data: account, isLoading } = useQuery({
    queryKey: ["account-gate"],
    queryFn: async () => {
      const r = await fetch(getApiUrl("/auth/account"));
      if (!r.ok) return null;
      const data = await r.json();
      return data?.loginId ? data : null;
    },
    staleTime: 10000,
  });

  const hasAccount = !!account;

  const dismiss = useCallback(() => {
    markLandingDismissed();
    setDismissedState(true);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), LANDING_GATE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  // A connected visitor has, by definition, entered the app: persist that so
  // the funnel can never reappear for them (e.g. after a disconnect, or on a
  // device where the click-through flag was never stored).
  useEffect(() => {
    if (hasAccount && !dismissed) dismiss();
  }, [hasAccount, dismissed, dismiss]);

  // The decision itself is a pure function so it is unit-tested (see
  // landing-gate.test.ts) — the flash-on-refresh regression must never return.
  const state: LandingGateState = landingGateState({
    dismissed, isLoading, hasAccount, timedOut,
  });

  return { state, dismiss };
}

/** Minimal branded first-paint screen, styled to match the landing page. */
function BootSplash() {
  return (
    <div
      data-testid="boot-splash"
      className="min-h-screen flex flex-col items-center justify-center gap-5"
      style={{ background: "radial-gradient(ellipse 120% 100% at 50% 30%, #0b0f1e 0%, #050816 60%, #050816 100%)" }}
    >
      <img
        src={`${BASE}/neuroai-logo.png`}
        alt="NeuroTrade AI"
        className="w-12 h-12 object-contain opacity-90"
      />
      <div
        className="w-7 h-7 rounded-full animate-spin"
        style={{
          border: "2px solid rgba(76,201,255,0.18)",
          borderTopColor: "#4CC9FF",
        }}
      />
    </div>
  );
}

function Router() {
  useMidnightReset();
  useSessionChangeRefresh();
  const { state: gateState, dismiss } = useLandingGate();
  const [location, setLocation] = useLocation();

  // Compare the PATH only — a query string (e.g. the OAuth `?code=…` callback)
  // must not stop a route from matching.
  const path = location.split("?")[0] || "/";
  const isRoot = path === "/";

  // The funnel belongs to the root URL alone. Deep links are rendered as-is so
  // a refresh on Journal/Markets/Bots/Connect keeps the visitor on that page.
  if (isRoot) {
    if (gateState === "undecided") return <BootSplash />;
    if (gateState === "landing") {
      return <LandingPage onEnter={() => { dismiss(); setLocation("/connect"); }} />;
    }
  }

  return (
    // One `/api/bots/live` poll for the whole app: the layout's status popup
    // and the Bot Arena cards read the same answer, so they cannot disagree
    // about which bot is running (or which Deriv account it is running on).
    <LiveBotsProvider>
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/markets" component={Markets} />
        <Route path="/markets/:symbol" component={MarketDetail} />
        <Route path="/bots" component={Bots} />
        <Route path="/trades" component={Trades} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/intelligence" component={Intelligence} />
        <Route path="/settings" component={Settings} />
        <Route path="/connect" component={Connect} />
        <Route path="/risk-calculator" component={RiskCalculator} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
    </LiveBotsProvider>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={BASE}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
