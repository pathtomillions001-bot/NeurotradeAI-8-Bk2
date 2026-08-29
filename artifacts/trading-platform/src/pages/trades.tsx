import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { motion } from "framer-motion";
import { format, isToday } from "date-fns";
import { Activity, RefreshCw, Database, Wifi } from "lucide-react";

interface JournalTrade {
  id: string | number;
  symbol: string;
  displayName: string;
  contractType: string;
  barrier: number | null;
  stake: number;
  payout: number;
  profit: number;
  won: boolean;
  status: string;
  duration: number | null;
  durationUnit: string | null;
  createdAt: string;
  closedAt: string | null;
  longcode: string | null;
  isAutonomous: boolean;
  aiConfidence: number | null;
  source?: string;
}

interface JournalStats {
  totalTrades: number;
  wonTrades: number;
  lostTrades: number;
  winRate: number;
  totalProfit: number;
  avgProfit: number;
  bestTrade: number;
  worstTrade: number;
  todayProfit: number;
  todayTrades: number;
  todayWon: number;
  todayLost: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
  todayStats?: {
    totalTrades: number;
    wonTrades: number;
    lostTrades: number;
    winRate: number;
    totalProfit: number;
    avgProfit: number;
    bestTrade: number;
    worstTrade: number;
    currentStreak: number;
    longestWinStreak: number;
    longestLoseStreak: number;
  };
}

function formatContractLabel(contractType: string, barrier: number | null): string {
  if (contractType === "DIGITOVER" && barrier !== null) return `OVER ${barrier}`;
  if (contractType === "DIGITUNDER" && barrier !== null) return `UNDER ${barrier}`;
  if (contractType === "DIGITOVER") return "OVER";
  if (contractType === "DIGITUNDER") return "UNDER";
  if (contractType === "DIGITEVEN") return "EVEN";
  if (contractType === "DIGITODD") return "ODD";
  if (contractType === "CALL" || contractType === "RISE") return "Rise";
  if (contractType === "PUT"  || contractType === "FALL") return "Fall";
  return contractType;
}

function contractBadgeClass(contractType: string): string {
  if (contractType === "DIGITEVEN" || contractType === "DIGITODD") return "bg-cyan-500/10 text-cyan-400";
  if (contractType.startsWith("DIGIT")) return "bg-purple-500/10 text-purple-400";
  if (["RISE", "FALL", "CALL", "PUT"].includes(contractType)) return "bg-blue-500/10 text-blue-400";
  return "bg-zinc-500/10 text-zinc-400";
}

async function fetchDerivJournal() {
  const res = await fetch("/api/trades/deriv-journal");
  if (!res.ok) throw new Error("Failed to fetch journal");
  return res.json() as Promise<{ source: "deriv" | "local" | "paper"; trades: JournalTrade[]; stats: JournalStats }>;
}

export default function Trades() {
  const queryClient = useQueryClient();
  const [tooltipId, setTooltipId] = useState<string | number | null>(null);
  // Instant SSE trades — prepended immediately on trade_completed before Deriv's profit_table syncs
  const pendingRef = useRef<JournalTrade[]>([]);
  const [pendingTrades, setPendingTrades] = useState<JournalTrade[]>([]);

  // Debounce timer ref — prevents stacking rapid SSE-triggered invalidations
  const invalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleInvalidate = useCallback(() => {
    if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
    invalidateTimerRef.current = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
    }, 400);
  }, [queryClient]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["derivJournal"],
    queryFn: fetchDerivJournal,
    // 3 s background poll matches the server-side quick-refresh interval so
    // the frontend always picks up the latest data within one poll cycle.
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    staleTime: 2000,
    // Only re-render when the actual data or loading flag changes.
    notifyOnChangeProps: ["data", "isLoading", "isFetching"],
  });

  // SSE: zero-latency trade insertion + authoritative journal sync
  useEffect(() => {
    const es = new EventSource("/api/ai/events");

    es.addEventListener("trade_completed", (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const trade: JournalTrade | null = payload?.trade ?? null;
        if (trade) {
          // Show the trade immediately in the pending list before Deriv syncs
          pendingRef.current = [trade, ...pendingRef.current.filter((t) => t.id !== trade.id)];
          setPendingTrades([...pendingRef.current]);
        }
        // Immediate invalidation — the server quick-refresh already merged the trade
        scheduleInvalidate();
      } catch { /* ignore */ }
    });

    // journal_refreshed fires after BOTH the quick refresh (limit:10, ~1-2 s)
    // AND the full profit_table re-fetch — invalidate immediately so the
    // frontend picks up the merged data without waiting the full debounce.
    es.addEventListener("journal_refreshed", () => {
      // Immediate (50 ms) invalidation on authoritative refresh signal
      if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
      invalidateTimerRef.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["derivJournal"] });
      }, 50);
    });

    return () => {
      es.close();
      if (invalidateTimerRef.current) clearTimeout(invalidateTimerRef.current);
    };
  }, [queryClient, scheduleInvalidate]);

  // Once fresh journal data arrives, drop pending trades that are now in the journal
  useEffect(() => {
    if (!data?.trades?.length) return;
    const journalIds = new Set(data.trades.map((t) => String(t.id)));
    const remaining = pendingRef.current.filter((t) => !journalIds.has(String(t.id)));
    if (remaining.length !== pendingRef.current.length) {
      pendingRef.current = remaining;
      setPendingTrades([...remaining]);
    }
  }, [data]);

  const journalTrades = data?.trades ?? [];
  // Merge pending (newest first) with journal, deduped by id
  const journalIds = new Set(journalTrades.map((t) => String(t.id)));
  const allTrades = [
    ...pendingTrades.filter((t) => !journalIds.has(String(t.id))),
    ...journalTrades,
  ];

  // Journal header cards show a clean slate every day — pull the day-scoped
  // `todayStats` rather than all-time numbers. Full history (and the trade list
  // below) still shows everything; Analytics is the place for all-time detail.
  const allTimeStats = data?.stats;
  const stats = allTimeStats?.todayStats
    ? { ...allTimeStats.todayStats, todayProfit: allTimeStats.todayStats.totalProfit, todayWon: allTimeStats.todayStats.wonTrades, todayLost: allTimeStats.todayStats.lostTrades }
    : undefined;
  const isDerivSource = data?.source === "deriv";

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trade Journal</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {isDerivSource
              ? "Live Deriv account history — source of truth for all P&L."
              : "Local records (no Deriv token connected)."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-[10px] gap-1 px-2 py-0.5 ${isDerivSource ? "border-green-500/40 text-green-400" : "border-amber-500/40 text-amber-400"}`}>
            {isDerivSource ? <><Wifi className="w-2.5 h-2.5" /> DERIV LIVE</> : <><Database className="w-2.5 h-2.5" /> LOCAL</>}
          </Badge>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-1.5 rounded-md hover:bg-secondary/50 transition-colors text-muted-foreground hover:text-foreground disabled:opacity-40"
            title="Refresh from Deriv"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Stats strip — from Deriv journal */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Win Rate</div>
              <div className={`text-xl font-mono font-bold ${stats.winRate >= 0.55 ? "text-green-500" : stats.winRate >= 0.45 ? "text-amber-500" : "text-red-500"}`}>
                {(stats.winRate * 100).toFixed(1)}%
              </div>
              <div className="text-[10px] text-muted-foreground">{stats.wonTrades}W / {stats.lostTrades}L</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Today's Profit</div>
              <div className={`text-xl font-mono font-bold ${stats.totalProfit >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats.totalProfit >= 0 ? "+" : ""}{stats.totalProfit.toFixed(2)}
              </div>
              <div className="text-[10px] text-muted-foreground">avg {stats.avgProfit >= 0 ? "+" : ""}{stats.avgProfit.toFixed(2)}/trade</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Today's Trades</div>
              <div className="text-xl font-mono font-bold">{stats.totalTrades}</div>
              <div className="text-[10px] text-muted-foreground">{stats.todayWon}W / {stats.todayLost}L today</div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Streak</div>
              <div className={`text-xl font-mono font-bold ${stats.currentStreak >= 0 ? "text-green-500" : "text-red-500"}`}>
                {stats.currentStreak >= 0 ? "+" : ""}{stats.currentStreak}
              </div>
              <div className="text-[10px] text-muted-foreground">
                best win: {stats.longestWinStreak} / loss: {stats.longestLoseStreak} (today)
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card">
            <CardContent className="p-3">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Best / Worst</div>
              <div className="text-xl font-mono font-bold text-green-500">+{stats.bestTrade.toFixed(2)}</div>
              <div className="text-[10px] text-muted-foreground">worst: {stats.worstTrade.toFixed(2)}</div>
            </CardContent>
          </Card>
        </div>
      )}
      <div className="text-[10px] text-zinc-600 -mt-2">
        Stats above reset daily. Full trade history and all-time performance are in Analytics.
      </div>

      {/* Trade list */}
      <div className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
        <div className="min-w-[640px]">
          {/* Column headers */}
          <div className="grid grid-cols-12 gap-2 px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            <div className="col-span-2">Time</div>
            <div className="col-span-2">Market</div>
            <div className="col-span-2">Contract</div>
            <div className="col-span-1">Stake</div>
            <div className="col-span-1">Ticks</div>
            <div className="col-span-2">Payout</div>
            <div className="col-span-1">Source</div>
            <div className="col-span-1 text-right">P/L</div>
          </div>

          <div className="space-y-1">
            {isLoading && pendingTrades.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <RefreshCw className="w-6 h-6 mx-auto mb-3 animate-spin opacity-40" />
                <div className="text-sm">Loading from Deriv…</div>
              </div>
            ) : allTrades.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <Activity className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <div className="text-sm">No trades in your Deriv account yet.</div>
                <div className="text-xs mt-1">Execute a trade on any market to see it here instantly.</div>
              </div>
            ) : allTrades.map((trade) => {
              const isWon = trade.won;
              const isPending = pendingRef.current.some((p) => String(p.id) === String(trade.id));
              const contractLabel = formatContractLabel(trade.contractType, trade.barrier);
              const profitColor = isWon ? "text-green-500" : "text-red-500";
              const tradeIsToday = isToday(new Date(trade.createdAt));

              return (
                <Card
                  key={`${trade.id}-${trade.createdAt}`}
                  className={`bg-card hover:bg-secondary/20 transition-colors border ${
                    isPending ? "border-amber-500/30 shadow-[0_0_8px_rgba(251,191,36,0.15)]"
                    : isWon ? "border-green-500/10" : "border-red-500/10"
                  }`}
                  onClick={() => setTooltipId(tooltipId === trade.id ? null : trade.id)}
                >
                  <CardContent className="p-2.5">
                    <div className="grid grid-cols-12 gap-2 items-center">
                      <div className="col-span-2">
                        <div className="text-[11px] font-mono text-muted-foreground">{format(new Date(trade.createdAt), "HH:mm:ss")}</div>
                        <div className={`text-[10px] ${tradeIsToday ? "text-primary" : "text-zinc-600"}`}>{format(new Date(trade.createdAt), "MMM d")}</div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-xs font-bold truncate">{trade.displayName ?? trade.symbol}</div>
                        <div className="text-[10px] text-zinc-600 font-mono">{trade.symbol}</div>
                      </div>

                      <div className="col-span-2">
                        <span className={`text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded ${contractBadgeClass(trade.contractType)}`}>
                          {contractLabel}
                        </span>
                      </div>

                      <div className="col-span-1">
                        <span className="text-xs font-mono">${trade.stake.toFixed(2)}</span>
                      </div>

                      <div className="col-span-1">
                        <span className="text-[11px] font-mono text-muted-foreground">
                          {trade.duration != null ? `${trade.duration}${trade.durationUnit ?? "t"}` : "—"}
                        </span>
                      </div>

                      <div className="col-span-2">
                        <div className={`text-xs font-mono font-semibold ${isWon ? "text-green-500" : "text-red-500"}`}>
                          ${trade.payout.toFixed(2)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{isWon ? "won" : "lost"}</div>
                      </div>

                      <div className="col-span-1">
                        <Badge variant="outline" className={`text-[9px] px-1 py-0 ${
                          trade.source === "live" ? "border-green-500/30 text-green-400"
                          : trade.source === "paper" ? "border-amber-500/30 text-amber-400"
                          : "border-border text-muted-foreground"
                        }`}>
                          {trade.source === "live" ? "LIVE" : trade.source === "paper" ? "PAPER" : "—"}
                        </Badge>
                      </div>

                      <div className="col-span-1 text-right">
                        <div className={`text-xs font-mono font-bold ${profitColor}`}>
                          {isWon ? "+" : ""}{trade.profit.toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Expandable longcode */}
                    {tooltipId === trade.id && trade.longcode && (
                      <div className="mt-2 pt-2 border-t border-border text-[10px] text-muted-foreground leading-relaxed">
                        {trade.longcode}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {allTrades.length > 0 && (
            <div className="text-center py-3 text-[10px] text-zinc-600">
              {allTrades.length} trade{allTrades.length !== 1 ? "s" : ""} shown
              {isDerivSource ? " · from Deriv account" : " · from local records"}
              {isFetching && " · syncing…"}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
