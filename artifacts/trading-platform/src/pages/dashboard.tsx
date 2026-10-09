import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useGetAiEngineStatus,
  useGetSettings,
  useGetAccount,
  useGetDailySummary,
  useToggleAutonomousEngine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { AlertTriangle, Target, RefreshCw, TimerOff, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { QuickStrikeFlashCard } from "@/components/flash-card-3d";
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

interface FamilySummary {
  name: string;       // "direction" | "overunder" | "evenodd"
  contract: string | null;
  shouldTrade: boolean;
  confidence: number;
  quality: number;
  rejectReason: string | null;
}

interface GroupScanResult {
  group: string;
  scanned: number;
  bestSymbol: string;
  bestDisplayName: string;
  quality: number;
  shouldTrade: boolean;
  contract: string | null;
  confidence: number;
  family?: string;
  families?: FamilySummary[];   // all enabled families for this market
  rejectReason?: string | null;
  cursorIdx?: number;
  totalInGroup?: number;
  scanningAt?: number;
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

const GROUP_COLORS: Record<string, string> = {
  "Volatility 1s": "#00ffff",
  "Volatility":    "#8b5cf6",
  "Jump Indices":  "#f59e0b",
  "Bull/Bear":     "#10b981",
};
const CONTRACT_SHORT: Record<string, string> = {
  CALL: "RISE", PUT: "FALL", DIGITOVER: "OVER", DIGITUNDER: "UNDER", DIGITEVEN: "EVEN", DIGITODD: "ODD",
  DIGITMATCH: "MATCH", DIGITDIFF: "DIFF",
};
const FAMILY_COLORS: Record<string, string> = {
  direction:  "#10b981",
  overunder:  "#06b6d4",
  evenodd:    "#8b5cf6",
  matchdiff:  "#a855f7",
};
const CONTRACT_COLORS_MAP: Record<string, string> = {
  CALL: "#10b981", PUT: "#ef4444",
  DIGITOVER: "#06b6d4", DIGITUNDER: "#f59e0b",
  DIGITEVEN: "#8b5cf6", DIGITODD: "#ec4899",
  DIGITMATCH: "#a855f7", DIGITDIFF: "#14b8a6",
};

function ParallelGroupScanner({ groups, isScanning, winner, lastSkipReason }: {
  groups: Record<string, GroupScanResult | "scanning">;
  isScanning: boolean;
  winner: string | null;
  lastSkipReason: string | null;
}) {
  const GROUP_ORDER = ["Volatility 1s", "Volatility", "Jump Indices", "Bull/Bear"];
  const hasAnyData = Object.keys(groups).length > 0;

  if (!isScanning && !hasAnyData) return null;

  return (
    <div className="rounded-lg border border-primary/15 bg-primary/3 p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <div className="flex gap-0.5">
          {[0,1,2].map(i => (
            <span key={i} className="w-1 h-1 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        <span className="text-[10px] font-mono text-primary/80 uppercase tracking-widest">
          {isScanning ? "Scanning markets — rotating cursor across all groups" : "Last scan results"}
        </span>
        {winner && (
          <span className="ml-auto text-[9px] font-mono text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded">
            ✓ EXECUTING: {winner}
          </span>
        )}
      </div>

      {/* Per-group cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {GROUP_ORDER.map(groupName => {
          const result = groups[groupName];
          const color = GROUP_COLORS[groupName] ?? "#00ffff";
          const isGroupScanning = result === "scanning";
          const isWinner = result !== "scanning" && result && winner && result.bestSymbol === winner;

          return (
            <div
              key={groupName}
              className="rounded-md p-2 border transition-all"
              style={{
                borderColor: isWinner ? color : `${color}25`,
                background: isWinner ? `${color}12` : `${color}06`,
                boxShadow: isWinner ? `0 0 8px ${color}30` : undefined,
              }}
            >
              {/* Group header */}
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9px] font-mono font-bold uppercase tracking-wide" style={{ color }}>
                  {groupName}
                </span>
                {isGroupScanning ? (
                  <span className="w-1 h-1 rounded-full animate-pulse" style={{ background: color }} />
                ) : result ? (
                  <span className={`text-[8px] font-mono px-1 py-0.5 rounded ${result.shouldTrade ? "text-green-400 bg-green-500/15" : "text-zinc-500 bg-zinc-800/50"}`}>
                    {result.shouldTrade ? "GO" : "SKIP"}
                  </span>
                ) : (
                  <span className="text-[8px] text-zinc-600 font-mono">—</span>
                )}
              </div>

              {isGroupScanning ? (
                <div className="space-y-1">
                  <div className="h-2 rounded bg-black/20 overflow-hidden">
                    <div className="h-full rounded animate-pulse" style={{ width: "60%", background: color, opacity: 0.4 }} />
                  </div>
                  <div className="text-[8px] text-muted-foreground font-mono">Scanning…</div>
                </div>
              ) : result && typeof result === "object" ? (
                <div className="space-y-1.5">
                  {/* Market name + cursor position */}
                  <div>
                    <div className="text-[10px] font-semibold leading-tight truncate">{result.bestDisplayName}</div>
                    <div className="flex items-center gap-1">
                      <span className="text-[8px] font-mono text-muted-foreground">{result.bestSymbol}</span>
                      {result.cursorIdx !== undefined && result.totalInGroup !== undefined && (
                        <span className="text-[7px] font-mono text-zinc-600">[{result.cursorIdx + 1}/{result.totalInGroup}]</span>
                      )}
                    </div>
                  </div>

                  {/* Per-family badges — shows ALL enabled families, not just the winner */}
                  {result.families && result.families.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {result.families.map(fam => {
                        const ct = fam.contract ?? "";
                        const ctColor = CONTRACT_COLORS_MAP[ct] ?? FAMILY_COLORS[fam.name] ?? "#71717a";
                        const label = CONTRACT_SHORT[ct] ?? ct;
                        return (
                          <span
                            key={fam.name}
                            title={fam.rejectReason ?? (fam.shouldTrade ? "Ready to trade" : "Not ready")}
                            className="text-[7px] font-mono px-1 py-0.5 rounded border leading-none"
                            style={fam.shouldTrade
                              ? { color: ctColor, borderColor: `${ctColor}60`, background: `${ctColor}18` }
                              : { color: "#52525b", borderColor: "#3f3f46", background: "#18181b" }
                            }
                          >
                            {label || fam.name}{fam.shouldTrade ? " ✓" : ""}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    /* Fallback: single contract badge (old server version) */
                    result.contract && (
                      <span className="text-[8px] font-mono" style={{ color: `${color}90` }}>
                        {CONTRACT_SHORT[result.contract] ?? result.contract}
                      </span>
                    )
                  )}

                  {/* Confidence + quality bar */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-mono font-bold" style={{ color: result.shouldTrade ? color : "#71717a" }}>
                      {result.confidence.toFixed(0)}%
                    </span>
                    <span className="text-[7px] font-mono text-zinc-600">q{result.quality.toFixed(0)}</span>
                  </div>
                  <div className="h-0.5 w-full bg-black/20 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, result.quality)}%`, background: result.shouldTrade ? color : "#52525b" }} />
                  </div>
                </div>
              ) : (
                <div className="text-[8px] text-muted-foreground font-mono mt-1">Waiting…</div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Skip-reason status bar ─────────────────────────────────────────── */}
      {!winner && lastSkipReason && (
        <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5">
          <span className="text-amber-400 text-[9px] font-mono mt-0.5 shrink-0">⚠ SKIP</span>
          <span className="text-[9px] font-mono text-amber-300/80 leading-relaxed break-words">{lastSkipReason}</span>
        </div>
      )}
      {winner && (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-green-500/20 bg-green-500/5 px-2.5 py-1.5">
          <span className="text-green-400 text-[9px] font-mono shrink-0">✓ TRADE</span>
          <span className="text-[9px] font-mono text-green-300/80">Executing trade on {winner} — all gates passed</span>
        </div>
      )}
    </div>
  );
}

function AutonomousEngineView({
  engine,
  groups,
  isScanning,
  winner,
  lastSkipReason,
  onStop,
  isPending,
}: {
  engine: any;
  groups: Record<string, GroupScanResult | "scanning">;
  isScanning: boolean;
  winner: string | null;
  lastSkipReason: string | null;
  onStop: () => void;
  isPending: boolean;
}) {
  const dataMode = engine?.paperTradeMode ? "PAPER" : engine?.tickHealth?.usingSimulated ? "SIMULATED FEED" : "LIVE FEED";
  const activity = isScanning
    ? "Scanning contract families"
    : winner
      ? `Evaluating ${winner}`
      : engine?.currentMarket
        ? `Monitoring ${engine.currentMarket}`
        : "Waiting for fresh market ticks";

  return (
    <div className="relative h-full min-h-[260px] overflow-hidden rounded-2xl border border-cyan-300/20 bg-[#071014] shadow-[0_0_32px_rgba(34,211,238,0.08)]">
      <div
        className="absolute inset-0 opacity-[0.06]"
        style={{ backgroundImage: "linear-gradient(rgba(34,211,238,.8) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,.8) 1px, transparent 1px)", backgroundSize: "24px 24px" }}
      />
      <motion.div
        className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-cyan-300/[0.06] to-transparent"
        animate={{ x: ["-120%", "420%"] }}
        transition={{ duration: 5, ease: "linear", repeat: Infinity }}
      />
      <div className="relative z-10 flex h-full flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
              </span>
              <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-cyan-200">Autonomous Engine</span>
              <span className="rounded border border-emerald-400/25 bg-emerald-400/10 px-1.5 py-0.5 text-[8px] font-mono text-emerald-300">ACTIVE</span>
            </div>
            <div className="mt-1 truncate text-xs text-cyan-50/70">{activity}</div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onStop}
            disabled={isPending}
            className="h-7 shrink-0 border-red-400/30 px-2.5 text-[9px] font-mono text-red-300 hover:bg-red-400/10"
          >
            STOP ENGINE
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "MODE", value: engine?.mode?.toUpperCase() ?? "AUTONOMOUS" },
            { label: "FEED", value: dataMode },
            { label: "CYCLE", value: isScanning ? "SCANNING" : winner ? "QUALIFIED" : "MONITORING" },
          ].map(item => (
            <div key={item.label} className="rounded-md border border-cyan-300/10 bg-cyan-100/[0.025] px-2 py-1.5">
              <div className="text-[7px] font-mono tracking-widest text-cyan-100/40">{item.label}</div>
              <div className="mt-0.5 truncate text-[9px] font-mono text-cyan-100/80">{item.value}</div>
            </div>
          ))}
        </div>
        <ParallelGroupScanner
          groups={groups}
          isScanning={isScanning}
          winner={winner}
          lastSkipReason={lastSkipReason}
        />
        {!isScanning && Object.keys(groups).length === 0 && (
          <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-cyan-200/10 bg-cyan-200/[0.02] py-4 text-[10px] font-mono text-cyan-100/45">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Live monitoring is ready
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: summary } = useGetDailySummary({ query: { refetchInterval: 5000 } } as { query: any });
  const { data: engine, refetch: refetchEngine } = useGetAiEngineStatus({ query: { refetchInterval: 3000 } } as { query: any });
  const { data: account } = useGetAccount();
  const { data: settings } = useGetSettings();
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
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
      queryClient.invalidateQueries({ queryKey: ["autonomous-engine-preview"] });
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

  const targetPct = summary ? Math.max(0, Math.min(100, (summary.totalProfit / summary.dailyTarget) * 100)) : 0;
  const isProfit = (summary?.totalProfit ?? 0) >= 0;
  const cooldownEnabled = (settings as any)?.cooldownEnabled ?? true;
  const cooldownActive = cooldownEnabled && cooldownSecs !== null && !engine?.isRunning;


  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <header className="flex flex-wrap justify-between items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-1.5 h-1.5 rounded-full ${engine?.isRunning ? "bg-green-500 animate-pulse" : cooldownActive ? "bg-amber-500 animate-pulse" : "bg-zinc-600"}`} />
            <p className="text-muted-foreground font-mono text-xs">
              {engine?.isRunning ? "ENGINE ONLINE" : cooldownActive ? "COOLDOWN" : "ENGINE STANDBY"} &bull; {engine?.mode?.toUpperCase() ?? "MANUAL"} MODE
              {(engine as any)?.paperTradeMode && " · PAPER"}
              {(engine as any)?.tickHealth?.usingSimulated && " · SIM DATA"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {cooldownActive && cooldownSecs !== null && (
            <div className="flex items-center gap-2 rounded-md border border-amber-400/25 bg-amber-400/5 px-2 py-1" title={engine?.stopReasons?.[0] ?? "Consecutive losses triggered a safety pause"}>
              <TimerOff className="h-3 w-3 shrink-0 text-amber-300" />
              <span className="text-[9px] font-mono uppercase tracking-wide text-amber-200/80">Cooldown</span>
              <span className="text-[10px] font-mono font-bold tabular-nums text-amber-100">{formatCooldown(cooldownSecs)}</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 border-amber-400/30 px-2 text-[9px] text-amber-200 hover:bg-amber-400/10"
                onClick={() => runToggle(true)}
                disabled={toggleEngine.isPending}
              >
                Resume
              </Button>
            </div>
          )}
          {!engine?.isRunning && !cooldownActive && engine?.stopReasons?.[0] && (
            <div className="flex max-w-[min(36rem,80vw)] items-center gap-1.5 rounded-md border border-amber-400/20 px-2 py-1 text-[9px] text-amber-200/75" title={engine.stopReasons[0]}>
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate">{engine.stopReasons[0]}</span>
            </div>
          )}
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

      {/* Daily target + Quick Strike / active engine */}
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

        <div className="md:col-span-2 min-h-[260px]">
          {engine?.isRunning ? (
            <AutonomousEngineView
              engine={engine}
              groups={groupScans}
              isScanning={isScanningGroups}
              winner={tournamentWinner}
              lastSkipReason={lastSkipReason}
              onStop={() => runToggle(false)}
              isPending={toggleEngine.isPending}
            />
          ) : (
            <QuickStrikeFlashCard
              onStartEngine={() => runToggle(true)}
              engineTogglePending={toggleEngine.isPending}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}
