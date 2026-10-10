import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetTopMarket,
  useGetAiEngineStatus,
  useGetAccount,
  useGetDailySummary,
  useExecuteTrade,
  useToggleAutonomousEngine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { Target, Clock, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { MarketOpportunityFlashCard } from "@/components/flash-card-3d";
import { AutonomousEngineCard, type GroupScanResult } from "@/components/autonomous-engine-card";
import { withTabSession } from "@/lib/tab-session";

interface JournalStats {
  totalTrades: number;
  wonTrades: number;
  lostTrades: number;
  winRate: number;
  totalProfit: number;
  todayProfit: number;
  currentStreak: number;
}

interface PendingResult {
  won: boolean;
  profit: number;
  createdAt: string;
}

function formatCooldown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

// ── Recovery stat card (in the top KPI row) ───────────────────────────────────
// Recovery is a SINGLE global state now, regardless of which contract type
// caused the loss — the AI simply trades whatever the tournament ranks best,
// sized by the recovery-engine's dynamic stake. This card only reflects the
// engine's own recovery state; it does NOT show a scanned candidate table.
function RecoveryStatCard({ engine }: { engine: any }) {
  const active = engine?.recovery?.active;
  const queryClient = useQueryClient();

  const clearDebt = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/ai/recovery/clear-debt", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to clear debt");
      return res.json();
    },
    onSuccess: () => {
      toast.success("Recovery debt cleared — engine back to normal stake");
      // Use the generated query key so the engine-status card refreshes immediately.
      queryClient.invalidateQueries({ queryKey: ["/api/ai/engine/status"] });
    },
    onError: (err: any) => {
      toast.error(err?.message ?? "Failed to clear recovery debt");
    },
  });

  return (
    <Card className={`${active ? "bg-amber-500/5 border-amber-500/20" : "bg-card"}`}>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
          <ShieldAlert className="w-3 h-3" /> Recovery
        </div>
        {active ? (
          <>
            <div className="flex items-baseline gap-1.5">
              <div className="text-2xl font-mono font-bold text-amber-500">
                Active
              </div>
              {engine.recovery.recoveryStep > 0 && (
                <div className="text-xs text-amber-400/70 font-mono">step {engine.recovery.recoveryStep}</div>
              )}
            </div>
            <div className="text-xs text-amber-400/80 mt-0.5 font-medium">
              ${engine.recovery.totalUnrecovered?.toFixed(2) ?? "0.00"} debt
              {engine.recovery.remainingTargetProfit > 0 && (
                <> · optional sizing target +${engine.recovery.remainingTargetProfit.toFixed(2)}</>
              )}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {engine.recovery.totalStreakLosses > 0 ? (
                <span className="text-amber-500/70">
                  {engine.recovery.totalStreakLosses}-loss streak
                </span>
              ) : (
                <span>Partial win applied — debt remains until fully recovered</span>
              )}
            </div>
            <button
              onClick={() => clearDebt.mutate()}
              disabled={clearDebt.isPending}
              className="mt-2 w-full text-[10px] font-medium py-1 px-2 rounded border border-amber-500/30 text-amber-400/80 hover:bg-amber-500/10 hover:border-amber-500/50 hover:text-amber-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearDebt.isPending ? "Clearing…" : "Clear Debt"}
            </button>
          </>
        ) : (
          <>
            <div className="text-2xl font-mono font-bold text-green-500">Normal</div>
            <div className="text-xs text-muted-foreground mt-1">no active recovery</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } } as { query: any });
  const { data: topMarket } = useGetTopMarket({ query: { refetchInterval: 8000 } } as { query: any });
  const { data: engine, refetch: refetchEngine } = useGetAiEngineStatus({ query: { refetchInterval: 3000 } } as { query: any });
  const { data: account } = useGetAccount();
  const executeTrade = useExecuteTrade();
  const toggleEngine = useToggleAutonomousEngine();
  // Surfaces server-side refusals (e.g. 409 when a NeuroAI FAB session owns
  // trading) — without this the toggle fails silently with no explanation.
  const runToggle = (running: boolean) =>
    toggleEngine.mutate(
      { data: { running } },
      {
        onError: (err: any) =>
          toast.error(err?.data?.error ?? err?.message ?? "Could not toggle the engine"),
      },
    );

  const queryClient = useQueryClient();

  // Journal stats — tighter polling so new trades appear quickly
  const { data: journalData } = useQuery({
    queryKey: ["derivJournal"],
    queryFn: () => fetch("/api/trades/deriv-journal").then(r => r.json()),
    refetchInterval: 10000,
    staleTime: 5000,
  });
  // Dashboard shows a clean slate every day — pull the day-scoped `todayStats`
  // (win rate, streak, totals) rather than the all-time numbers. Full history
  // still lives in Analytics for anyone who wants deeper detail.
  const stats: JournalStats | undefined = useMemo(() => {
    const today = (journalData as any)?.stats?.todayStats;
    if (!today) return undefined;
    return { ...today, todayProfit: today.totalProfit };
  }, [journalData]);

  // Optimistic trade results — applied immediately when trade_completed SSE fires
  const [pendingResults, setPendingResults] = useState<PendingResult[]>([]);
  // Tracks stats.totalTrades as of the last time we reconciled pendingResults against
  // the server. Once the server's todayStats already includes N more trades than it
  // did before, the oldest N pendingResults are now double-counted (once by the
  // server, once by our optimistic overlay below) — drop them. Without this, a
  // pendingResults entry that never gets cleared by "journal_refreshed" (e.g. if that
  // SSE event is delayed or missed) stays applied on top of already-updated server
  // stats forever, which was producing a stale/incorrect streak on the Dashboard that
  // didn't match Journal/Analytics (which read the server value directly).
  const lastServerTotalRef = useRef<number | null>(null);
  useEffect(() => {
    if (!stats) return;
    const prevTotal = lastServerTotalRef.current;
    lastServerTotalRef.current = stats.totalTrades;
    if (prevTotal === null) return;
    const delta = stats.totalTrades - prevTotal;
    if (delta > 0) {
      setPendingResults(prev => prev.slice(delta));
    } else if (delta < 0) {
      // Day rolled over (today's stats reset) — nothing from the old day applies anymore.
      setPendingResults([]);
    }
  }, [stats?.totalTrades]);
  // Parallel group scanner state — driven by scan_started + group_scanned SSE events
  const [groupScans, setGroupScans] = useState<Record<string, GroupScanResult | "scanning">>({});
  const [isScanningGroups, setIsScanningGroups] = useState(false);
  const [tournamentWinner, setTournamentWinner] = useState<string | null>(null);
  // Last skip reason from scan_complete — shown in the status bar when no trade fires
  const [lastSkipReason, setLastSkipReason] = useState<string | null>(null);

  // SSE: journal_refreshed syncs journal; trade_completed applies immediate stat delta
  const sseRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource(withTabSession("/api/ai/events"));
    sseRef.current = es;

    // Parallel tournament scan events
    es.addEventListener("scan_started", (e: MessageEvent) => {
      try {
        // Do NOT wipe out existing group data — keep last results visible so the
        // cards never flash to blank/inactive when Even/Odd rescans rapidly (every
        // 500ms). Only set isScanningGroups=true to show the pulsing indicator.
        void e.data;
        setIsScanningGroups(true);
        setTournamentWinner(null);
      } catch {}
    });

    es.addEventListener("group_scanned", (e: MessageEvent) => {
      try {
        const payload: GroupScanResult = JSON.parse(e.data);
        setGroupScans(prev => ({ ...prev, [payload.group]: payload }));
      } catch {}
    });

    es.addEventListener("scan_complete", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        setIsScanningGroups(false);
        if (payload.shouldTrade && payload.symbol) {
          setTournamentWinner(payload.symbol);
          setLastSkipReason(null);
        } else {
          setTournamentWinner(null);
          // Show why this scan didn't result in a trade
          if (payload.rejectReason) setLastSkipReason(payload.rejectReason);
        }
      } catch {}
    });

    es.addEventListener("trade_completed", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const won = payload?.won;
        const profit = parseFloat(payload?.profit ?? "0");
        if (won !== undefined) {
          setPendingResults(prev => [...prev.slice(-9), {
            won: !!won,
            profit,
            createdAt: new Date().toISOString(),
          }]);
          queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
        }
        setTournamentWinner(null);
        setIsScanningGroups(false);
      } catch {}
    });

    es.addEventListener("journal_refreshed", () => {
      queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
      queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
      setPendingResults([]);
    });

    // New day — hard-reset all daily stats so the dashboard shows 0 immediately
    // instead of waiting for the next polling interval.
    es.addEventListener("day_reset", () => {
      setPendingResults([]);
      setGroupScans({});
      setIsScanningGroups(false);
      setTournamentWinner(null);
      queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
      queryClient.invalidateQueries({ queryKey: ["getDailySummary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/engine/status"] });
      queryClient.invalidateQueries({ queryKey: ["getAiEngineStatus"] });
      queryClient.invalidateQueries({ queryKey: ["markets-top-signals"] });
      queryClient.invalidateQueries({ queryKey: ["markets", "ranked-all"] });
    });

    // When the user saves Settings, immediately refetch all market + engine data
    // so the dashboard reflects the new contract types without needing a page reload.
    es.addEventListener("settings_updated", () => {
      // Invalidate every query that depends on settings / preferredContractTypes
      queryClient.invalidateQueries({ queryKey: ["markets-top-signals"] });
      queryClient.invalidateQueries({ queryKey: ["markets", "ranked-all"] });
      queryClient.invalidateQueries({ queryKey: ["/api/markets/top"] });
      queryClient.invalidateQueries({ queryKey: ["getAiEngineStatus"] });
      queryClient.invalidateQueries({ queryKey: ["getSettings"] });
      // Reset group scanner display — it shows stale labels from old settings
      setGroupScans({});
      setIsScanningGroups(false);
      setTournamentWinner(null);
    });

    return () => { es.close(); sseRef.current = null; };
  }, [queryClient]);

  // Merge server stats with optimistic pending results for <1s display latency
  const displayStats = useMemo((): JournalStats | undefined => {
    if (!stats) return undefined;
    if (pendingResults.length === 0) return stats;

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const pendingToday = pendingResults.filter(t => new Date(t.createdAt) >= todayStart);

    const addedWins = pendingResults.filter(t => t.won).length;
    const addedLosses = pendingResults.length - addedWins;
    const addedProfit = pendingResults.reduce((s, t) => s + t.profit, 0);
    const addedTodayProfit = pendingToday.reduce((s, t) => s + t.profit, 0);

    const newTotal = stats.totalTrades + pendingResults.length;
    const newWins = stats.wonTrades + addedWins;

    let newStreak = stats.currentStreak;
    for (const t of pendingResults) {
      if (t.won) newStreak = newStreak >= 0 ? newStreak + 1 : 1;
      else newStreak = newStreak <= 0 ? newStreak - 1 : -1;
    }

    return {
      ...stats,
      totalTrades: newTotal,
      wonTrades: newWins,
      lostTrades: stats.lostTrades + addedLosses,
      winRate: newTotal > 0 ? newWins / newTotal : 0,
      totalProfit: Math.round((stats.totalProfit + addedProfit) * 100) / 100,
      todayProfit: Math.round(((stats.todayProfit ?? 0) + addedTodayProfit) * 100) / 100,
      currentStreak: newStreak,
    };
  }, [stats, pendingResults]);

  // Live countdown to next autonomous trade
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (!engine?.isRunning || !engine?.nextScanIn) { setCountdown(null); return; }
    setCountdown(engine.nextScanIn);
    const iv = setInterval(() => {
      setCountdown((c) => {
        if (c === null || c <= 1) { refetchEngine(); return null; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [engine?.isRunning, engine?.nextScanIn]);

  // Cooldown countdown — counts down until engine auto-resumes
  const [cooldownSecs, setCooldownSecs] = useState<number | null>(null);
  useEffect(() => {
    const cooldownUntilStr = (engine as any)?.cooldownUntil;
    if (!cooldownUntilStr) { setCooldownSecs(null); return; }
    const target = new Date(cooldownUntilStr).getTime();
    const update = () => {
      const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000));
      setCooldownSecs(remaining > 0 ? remaining : null);
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [(engine as any)?.cooldownUntil]);

  // A dedicated in-flow row keeps controls clear of both card headers.
  const engineControls = (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/10 pt-3 mt-auto">
      {cooldownSecs !== null && (
        <p className="mr-auto min-w-0 basis-full text-[10px] text-amber-400 font-mono break-words" role="status">
          {engine?.stopReasons?.[0] ?? "Safety cooldown"} · {formatCooldown(cooldownSecs)} until auto-resume
        </p>
      )}
      {cooldownSecs !== null && (
        <Button size="sm" variant="outline" className="h-8 text-xs shrink-0"
          onClick={() => runToggle(true)} disabled={toggleEngine.isPending}>
          Resume Now
        </Button>
      )}
      <Button size="sm" variant="outline"
        className={`h-8 text-xs font-mono shrink-0 ${engine?.isRunning ? "border-red-500/40 text-red-400 hover:bg-red-500/10" : "border-primary/40 text-primary hover:bg-primary/10"}`}
        onClick={() => runToggle(!engine?.isRunning)} disabled={toggleEngine.isPending}>
        {toggleEngine.isPending ? "PLEASE WAIT…" : engine?.isRunning ? "STOP ENGINE" : "START ENGINE"}
      </Button>
    </div>
  );

  const targetPct = summary ? Math.max(0, Math.min(100, (summary.totalProfit / summary.dailyTarget) * 100)) : 0;
  const isProfit = (summary?.totalProfit ?? 0) >= 0;


  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex justify-between items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-1.5 h-1.5 rounded-full ${engine?.isRunning ? "bg-green-500 animate-pulse" : cooldownSecs ? "bg-amber-500 animate-pulse" : "bg-zinc-600"}`} />
            <p className="text-muted-foreground font-mono text-xs">
              {engine?.isRunning ? "ENGINE ONLINE" : cooldownSecs ? "COOLDOWN" : "ENGINE STANDBY"} &bull; {engine?.mode?.toUpperCase() ?? "MANUAL"} MODE
              {(engine as any)?.paperTradeMode && " · PAPER"}
              {(engine as any)?.tickHealth?.usingSimulated && " · SIM DATA"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {account ? (
            <div className="text-right">
              <div className="text-xs text-muted-foreground font-mono">{account.loginId}</div>
              <div className="font-mono font-bold">{account.currency} {Number(account.balance).toFixed(2)}</div>
            </div>
          ) : (
            <Link href="/connect">
              <Badge variant="outline" className="cursor-pointer border-primary/50 text-primary hover:bg-primary/10">
                Connect Deriv Account
              </Badge>
            </Link>
          )}
        </div>
      </header>


      {/* Stat strip — displayStats applies pending optimistic updates instantly */}
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Performance</span>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.winRate ?? 0) >= 0.55 ? "text-green-500" : (displayStats?.winRate ?? 0) >= 0.45 ? "text-amber-500" : "text-red-500"}`}>
                {displayStats ? `${(displayStats.winRate * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? `${displayStats.wonTrades}W / ${displayStats.lostTrades}L` : "no trades yet"}
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Today's Profit</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.totalProfit ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {displayStats ? `${displayStats.totalProfit >= 0 ? "+" : ""}${displayStats.totalProfit.toFixed(2)}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                resets daily · see Analytics for all-time
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
              <div className={`text-2xl font-mono font-bold ${(displayStats?.currentStreak ?? 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                {displayStats ? `${displayStats.currentStreak > 0 ? "+" : ""}${displayStats.currentStreak}` : "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? ((displayStats.currentStreak ?? 0) >= 0 ? "winning streak" : "losing streak") : "no data"}
              </div>
            </CardContent>
          </Card>
          <RecoveryStatCard engine={engine} />
          <Card className="bg-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Trades</div>
              <div className="text-2xl font-mono font-bold">
                {displayStats?.totalTrades ?? "—"}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {displayStats ? `${(displayStats.winRate * 100).toFixed(1)}% win rate` : "no trades yet"}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Daily target + Top opportunity */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Target className="w-3.5 h-3.5" /> Daily Target
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-end">
              <span className={`text-xl font-mono font-bold ${isProfit ? "text-green-500" : "text-red-500"}`}>
                {isProfit ? "+" : ""}{summary?.totalProfit?.toFixed(2) ?? "0.00"}
              </span>
              <span className="text-sm text-muted-foreground font-mono">/ ${summary?.dailyTarget?.toFixed(0) ?? "50"}</span>
            </div>
            <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${targetPct >= 100 ? "bg-green-500" : targetPct >= 50 ? "bg-primary" : "bg-amber-500"}`}
                initial={{ width: 0 }}
                animate={{ width: `${targetPct}%` }}
                transition={{ duration: 0.6 }}
              />
            </div>
            <div className="text-xs text-muted-foreground">
              {targetPct >= 100 ? "Target reached!" : `${targetPct.toFixed(0)}% of daily target`}
            </div>
            {summary?.isLossLimitHit && (
              <Badge variant="outline" className="text-red-500 border-red-500/30 text-xs w-full justify-center">
                Loss limit hit — trading paused
              </Badge>
            )}
          </CardContent>
        </Card>

        {/* One surface, two faces: Quick Strike for manual trading, the
            autonomous engine itself the moment it is switched on. */}
        <div className="md:col-span-2">
          {engine?.isRunning ? (
            <AutonomousEngineCard
              engineControls={engineControls}
              countdown={countdown}
              groups={groupScans}
              isScanning={isScanningGroups}
              winner={tournamentWinner}
              lastSkipReason={lastSkipReason}
            />
          ) : (
            <MarketOpportunityFlashCard engineControls={engineControls} currentStreak={displayStats?.currentStreak ?? 0} />
          )}
        </div>
      </div>

    </motion.div>
  );
}
