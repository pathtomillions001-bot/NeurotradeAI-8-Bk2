import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import NotFound from "@/pages/not-found";
import { Layout } from "@/components/layout";
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Persisted landing-page dismissal — survives refreshes so deep routes stay put. */
const LANDING_DISMISSED_KEY = "neurotrade_landing_dismissed";

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
    const es = new EventSource(getApiUrl("/ai/events"));
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

function useLandingGate() {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(LANDING_DISMISSED_KEY) === "1"; } catch { return false; }
  });
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

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(LANDING_DISMISSED_KEY, "1"); } catch { /* non-critical */ }
  };

  // Refresh-safe: the landing page is a FIRST-VISIT funnel, not a route guard.
  // 1. Once dismissed (persisted in localStorage) the gate never fires again —
  //    refreshing on Journal/Markets/Bots keeps the user on that page.
  // 2. While the account query is still loading we don't know whether an
  //    account exists, so we render the route the URL says instead of
  //    bouncing the user to the landing page and back.
  const showLanding = !dismissed && !hasAccount && !isLoading;

  return { showLanding, dismiss };
}

function Router() {
  useMidnightReset();
  const { showLanding, dismiss } = useLandingGate();
  const [location, setLocation] = useLocation();

  // Never block the /connect route — OAuth callbacks land here and need to
  // reach the Connect component directly (even before an account exists).
  const isConnectPage = location === "/connect" || location.startsWith("/connect?");

  if (showLanding && !isConnectPage) {
    return <LandingPage onEnter={() => { dismiss(); setLocation("/connect"); }} />;
  }

  return (
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
