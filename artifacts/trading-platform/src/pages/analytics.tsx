import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer,
  AreaChart, Area, ReferenceLine, CartesianGrid,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, Shield, Zap, Target,
  CheckCircle2, XCircle, Clock, Flame, AlertTriangle,
} from "lucide-react";
import { useMemo, useEffect } from "react";
import { useGetDrawdownAnalysis } from "@workspace/api-client-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

function fmtHour(h: number) {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${ampm}`;
}

function contractShort(ct: string, barrier?: number | null) {
  const map: Record<string, string> = {
    CALL: "Rise", PUT: "Fall",
    DIGITOVER: "OVER", DIGITUNDER: "UNDER",
    DIGITEVEN: "EVEN", DIGITODD: "ODD",
    DIGITMATCH: "MATCH", DIGITDIFF: "DIFF",
  };
  const label = map[ct] ?? ct;
  return barrier != null && ct.startsWith("DIGIT") ? `${label} ${barrier}` : label;
}

function contractColor(ct: string) {
  if (ct === "CALL") return "text-emerald-400";
  if (ct === "PUT") return "text-red-400";
  if (ct === "DIGITOVER" || ct === "DIGITUNDER") return "text-cyan-400";
  if (ct === "DIGITEVEN" || ct === "DIGITODD") return "text-violet-400";
  if (ct === "DIGITMATCH") return "text-amber-400";
  if (ct === "DIGITDIFF") return "text-rose-400";
  return "text-muted-foreground";
}

// ── Data hooks ────────────────────────────────────────────────────────────────

// Same query key AND same endpoint as Dashboard/Journal ("derivJournal") — this is
// what keeps "today's" profit/win-rate/streak/best-trade in sync across every page.
// Previously Analytics used its own query key + its own client-side midnight filter,
// which could drift from the Dashboard/Journal numbers (different fetch timing, and
// the server's day boundary vs the browser's day boundary are not guaranteed to be
// the same instant). Now Analytics reads the exact same `todayTrades` list and
// `stats.todayStats` the backend already computed — no re-derivation, no drift.
function useTodayTrades() {
  return useQuery({
    queryKey: ["derivJournal"],
    queryFn: async () => {
      const journal = await fetch("/api/trades/deriv-journal").then(r => r.json());
      if (journal?.source === "deriv" || journal?.source === "none") {
        return { todayTrades: journal.todayTrades ?? [], todayStats: journal.stats?.todayStats ?? null };
      }
      // No Deriv connection at all — fall back to local DB, filtered client-side
      // (there is no backend "today" computation to defer to on this path).
      const local = await fetch("/api/trades?limit=10000").then(r => r.json());
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayTrades = (Array.isArray(local) ? local : [])
        .filter((t: any) => (t.status === "won" || t.status === "lost") && new Date(t.createdAt) >= todayStart)
        .sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return { todayTrades, todayStats: null };
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  });
}

// ── Chart tooltip ─────────────────────────────────────────────────────────────
const TT = {
  contentStyle: { backgroundColor: "#09090b", border: "1px solid #27272a", borderRadius: "8px", fontSize: "11px", padding: "8px 12px" },
  labelStyle: { color: "#52525b", marginBottom: "2px" },
  cursor: { fill: "rgba(255,255,255,0.03)" },
};

// ── Stat pill ─────────────────────────────────────────────────────────────────
function Pill({ label, value, color, icon: Icon, sub }: { label: string; value: string; color: string; icon: React.ComponentType<any>; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-card/70 px-4 py-4 backdrop-blur">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-widest font-medium">
        <Icon className={`w-3 h-3 ${color}`} />
        {label}
      </div>
      <p className={`text-2xl font-mono font-bold leading-none mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Hourly P&L bar chart ──────────────────────────────────────────────────────
function HourlyChart({ trades }: { trades: any[] }) {
  const data = useMemo(() => {
    const map: Record<number, number> = {};
    for (const t of trades) {
      const h = new Date(t.createdAt).getHours();
      map[h] = (map[h] ?? 0) + (t.profit ?? 0);
    }
    // Build a continuous 0-23 range
    const now = new Date().getHours();
    return Array.from({ length: now + 1 }, (_, h) => ({
      hour: fmtHour(h),
      pnl: Math.round((map[h] ?? 0) * 100) / 100,
    }));
  }, [trades]);

  if (data.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4">
      <p className="text-xs font-semibold text-foreground mb-0.5">Hourly P&L</p>
      <p className="text-[10px] text-muted-foreground mb-4">Session performance by hour</p>
      <div className="h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
            <XAxis dataKey="hour" tick={{ fontSize: 9, fill: "#52525b" }} />
            <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
            <Tooltip {...TT} formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]} />
            <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
            <Bar dataKey="pnl" radius={[3, 3, 0, 0]} label={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.pnl >= 0 ? "#10b981" : "#ef4444"} opacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── P&L curve by trade ────────────────────────────────────────────────────────
function PnlCurve({ trades }: { trades: any[] }) {
  const data = useMemo(() => {
    let cum = 0;
    return trades.map((t, i) => {
      cum += t.profit ?? 0;
      return { n: i + 1, cum: Math.round(cum * 100) / 100, profit: t.profit ?? 0, won: t.won };
    });
  }, [trades]);

  const last = data[data.length - 1]?.cum ?? 0;

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4">
      <div className="flex items-center justify-between mb-4">
        <div>
          <p className="text-xs font-semibold text-foreground">Equity Curve</p>
          <p className="text-[10px] text-muted-foreground">Cumulative P&L — today</p>
        </div>
        <span className={`text-sm font-mono font-bold ${last >= 0 ? "text-emerald-400" : "text-red-400"}`}>
          {last >= 0 ? "+" : ""}{last.toFixed(2)}
        </span>
      </div>
      <div className="h-[140px]">
        {data.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
              <defs>
                <linearGradient id="pnlG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"   stopColor={last >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={last >= 0 ? "#10b981" : "#ef4444"} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="n" tick={{ fontSize: 9, fill: "#52525b" }} label={{ value: "Trade #", position: "insideBottomRight", offset: -4, style: { fontSize: 9, fill: "#52525b" } }} />
              <YAxis tick={{ fontSize: 9, fill: "#52525b" }} />
              <Tooltip {...TT} formatter={(v: number) => [`$${v.toFixed(2)}`, "Cumulative"]} />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="cum"
                stroke={last >= 0 ? "#10b981" : "#ef4444"}
                fill="url(#pnlG)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground/40 text-xs">
            {data.length === 1 ? "1 trade — more needed for curve" : "No data yet"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Contract breakdown ────────────────────────────────────────────────────────
function ContractBreakdown({ trades }: { trades: any[] }) {
  const data = useMemo(() => {
    const map: Record<string, { wins: number; losses: number; pnl: number }> = {};
    for (const t of trades) {
      const k = t.contractType ?? "UNKNOWN";
      if (!map[k]) map[k] = { wins: 0, losses: 0, pnl: 0 };
      map[k].pnl += t.profit ?? 0;
      if (t.won) map[k].wins++; else map[k].losses++;
    }
    return Object.entries(map)
      .map(([ct, d]) => ({ ct, total: d.wins + d.losses, wins: d.wins, losses: d.losses, pnl: Math.round(d.pnl * 100) / 100, wr: d.wins + d.losses > 0 ? d.wins / (d.wins + d.losses) : 0 }))
      .sort((a, b) => b.total - a.total);
  }, [trades]);

  if (data.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4">
      <p className="text-xs font-semibold text-foreground mb-0.5">By Contract Type</p>
      <p className="text-[10px] text-muted-foreground mb-3">Today's performance per type</p>
      <div className="space-y-2">
        {data.map(d => (
          <div key={d.ct} className="flex items-center gap-3">
            <span className={`text-[10px] font-mono font-bold w-16 shrink-0 ${contractColor(d.ct)}`}>
              {contractShort(d.ct)}
            </span>
            <div className="flex-1 h-2 bg-secondary/40 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${d.wr >= 0.6 ? "bg-emerald-500" : d.wr >= 0.45 ? "bg-amber-500" : "bg-red-500"}`}
                style={{ width: `${d.wr * 100}%`, transition: "width 0.5s ease" }} />
            </div>
            <span className="text-[10px] font-mono text-muted-foreground w-8 text-right shrink-0">{d.wins}W</span>
            <span className="text-[10px] font-mono text-muted-foreground w-8 text-right shrink-0">{d.losses}L</span>
            <span className={`text-[10px] font-mono w-14 text-right shrink-0 font-semibold ${d.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {d.pnl >= 0 ? "+" : ""}{d.pnl.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Live trade timeline ───────────────────────────────────────────────────────
function TradeTimeline({ trades }: { trades: any[] }) {
  const reversed = [...trades].reverse().slice(0, 30);

  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs font-semibold text-foreground">Trade Timeline</p>
          <p className="text-[10px] text-muted-foreground">Today's trades, newest first</p>
        </div>
        <span className="text-[10px] text-muted-foreground font-mono">{trades.length} total</span>
      </div>
      {reversed.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <Activity className="w-7 h-7 text-muted-foreground/20" />
          <p className="text-xs text-muted-foreground">No trades today yet</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          <AnimatePresence>
            {reversed.map((t, i) => {
              const profit = t.profit ?? 0;
              return (
                <motion.div
                  key={t.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.02 }}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2 border text-xs ${
                    t.won
                      ? "border-emerald-500/20 bg-emerald-500/5"
                      : "border-red-500/20 bg-red-500/5"
                  }`}
                >
                  {t.won
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    : <XCircle      className="w-3.5 h-3.5 text-red-400 shrink-0" />
                  }
                  <span className="text-muted-foreground font-mono w-10 shrink-0">{fmtTime(t.createdAt)}</span>
                  <span className="font-mono text-foreground/70 shrink-0">{t.symbol}</span>
                  <span className={`font-mono font-semibold shrink-0 ${contractColor(t.contractType)}`}>
                    {contractShort(t.contractType, t.barrier)}
                  </span>
                  <span className="text-muted-foreground/50 shrink-0 text-[10px]">${t.stake?.toFixed(2) ?? "—"}</span>
                  <span className={`ml-auto font-mono font-bold shrink-0 ${profit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {profit >= 0 ? "+" : ""}{profit.toFixed(2)}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ── Risk snapshot ─────────────────────────────────────────────────────────────
function RiskSnapshot({ drawdown, consecutiveLosses, consecutiveWins }: { drawdown: any; consecutiveLosses: number; consecutiveWins: number }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-4 space-y-3">
      <div className="flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs font-semibold text-foreground">Risk Status</p>
      </div>
      {drawdown ? (
        <>
          {drawdown.isAtRisk && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0" />
              <span className="text-[10px] text-red-400">Approaching drawdown limit — engine will stop soon</span>
            </div>
          )}
          {[
            { label: "Drawdown",   value: drawdown.currentDrawdown, limit: drawdown.drawdownLimit, color: "bg-red-500" },
            { label: "Max today",  value: drawdown.maxDrawdown,     limit: drawdown.drawdownLimit, color: "bg-amber-500" },
          ].map(item => (
            <div key={item.label}>
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-mono font-semibold">{item.value.toFixed(2)}%</span>
              </div>
              <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${item.color} transition-all`}
                  style={{ width: `${Math.min((item.value / item.limit) * 100, 100)}%` }} />
              </div>
            </div>
          ))}
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground animate-pulse">Loading risk data…</p>
      )}

      <div className="grid grid-cols-2 gap-2 pt-1">
        <div className="text-center rounded-lg bg-secondary/40 py-2.5">
          <p className={`text-xl font-mono font-bold ${consecutiveWins > 2 ? "text-emerald-400" : consecutiveWins > 0 ? "text-emerald-300" : "text-muted-foreground"}`}>
            {consecutiveWins}
          </p>
          <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-1 mt-0.5">
            {consecutiveWins > 2 && <Flame className="w-2.5 h-2.5 text-amber-400" />}
            Win streak
          </p>
        </div>
        <div className="text-center rounded-lg bg-secondary/40 py-2.5">
          <p className={`text-xl font-mono font-bold ${consecutiveLosses >= 3 ? "text-red-500" : consecutiveLosses > 0 ? "text-amber-400" : "text-muted-foreground"}`}>
            {consecutiveLosses}
          </p>
          <p className="text-[9px] text-muted-foreground flex items-center justify-center gap-1 mt-0.5">
            {consecutiveLosses >= 3 && <AlertTriangle className="w-2.5 h-2.5 text-red-500" />}
            Loss streak
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Analytics() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useTodayTrades();
  const trades = data?.todayTrades ?? [];
  const serverStats = data?.todayStats ?? null;
  const { data: drawdown } = useGetDrawdownAnalysis({ query: { refetchInterval: 15000 } } as any);

  // Same SSE-driven invalidation Dashboard/Journal use, on the same "derivJournal"
  // query key — so a trade completing anywhere in the app updates Analytics with
  // the same zero-latency feel, not just its 10s poll.
  useEffect(() => {
    const es = new EventSource("/api/ai/events");
    es.addEventListener("trade_completed", () => queryClient.invalidateQueries({ queryKey: ["derivJournal"] }));
    es.addEventListener("journal_refreshed", () => queryClient.invalidateQueries({ queryKey: ["derivJournal"] }));
    return () => es.close();
  }, [queryClient]);

  // Prefer the backend's todayStats (identical numbers to Dashboard/Journal) —
  // only fall back to a client-side recompute on the no-Deriv-token local-DB path,
  // where the backend hasn't already produced a todayStats object.
  const stats = useMemo(() => {
    if (serverStats) {
      return {
        won: serverStats.wonTrades, lost: serverStats.lostTrades,
        pnl: serverStats.totalProfit, wr: serverStats.winRate,
        best: serverStats.bestTrade, worst: serverStats.worstTrade,
        streak: serverStats.currentStreak,
      };
    }
    const won  = trades.filter((t: any) => t.won);
    const lost = trades.filter((t: any) => !t.won);
    const pnl  = Math.round(trades.reduce((s: number, t: any) => s + (t.profit ?? 0), 0) * 100) / 100;
    const wr   = trades.length > 0 ? won.length / trades.length : 0;
    const best  = won.length  > 0 ? Math.max(...won.map((t: any) => t.profit ?? 0))  : 0;
    const worst = lost.length > 0 ? Math.min(...lost.map((t: any) => t.profit ?? 0)) : 0;
    let streak = 0;
    for (const t of [...trades].reverse()) {
      if (streak === 0) streak = t.won ? 1 : -1;
      else if (t.won && streak > 0) streak++;
      else if (!t.won && streak < 0) streak--;
      else break;
    }
    return { won: won.length, lost: lost.length, pnl, wr, best, worst, streak };
  }, [trades, serverStats]);

  const consecutiveLosses = stats.streak < 0 ? Math.abs(stats.streak) : 0;
  const consecutiveWins   = stats.streak > 0 ? stats.streak : 0;

  const today = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-6 max-w-7xl mx-auto space-y-5 pb-10">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Activity className="w-6 h-6 text-primary" />
            Today's Session
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            {today} · resets at midnight
          </p>
        </div>

        {/* Hero P&L */}
        {!isLoading && trades.length > 0 && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-right"
          >
            <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-0.5">Net P&L</p>
            <p className={`text-4xl font-mono font-bold leading-none ${stats.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
              {stats.pnl >= 0 ? "+" : ""}{stats.pnl.toFixed(2)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">{trades.length} trades · {(stats.wr * 100).toFixed(1)}% win rate</p>
          </motion.div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40 gap-2 text-muted-foreground text-sm">
          <Activity className="w-4 h-4 animate-spin" /> Loading today's trades…
        </div>
      ) : trades.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card/50 py-20 flex flex-col items-center justify-center gap-3">
          <Activity className="w-10 h-10 text-muted-foreground/20" />
          <p className="text-sm text-muted-foreground font-medium">No trades yet today</p>
          <p className="text-xs text-muted-foreground/60">Start the autonomous engine or place a manual trade to see live analytics.</p>
        </div>
      ) : (
        <>
          {/* ── KPI pills ────────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-2 md:grid-cols-4 gap-3"
          >
            <Pill
              label="Win Rate"
              value={`${(stats.wr * 100).toFixed(1)}%`}
              sub={`${stats.won}W / ${stats.lost}L`}
              icon={Target}
              color={stats.wr >= 0.55 ? "text-emerald-400" : stats.wr >= 0.45 ? "text-amber-400" : "text-red-400"}
            />
            <Pill
              label="Best Trade"
              value={`+${stats.best.toFixed(2)}`}
              sub={`worst: ${stats.worst.toFixed(2)}`}
              icon={Zap}
              color="text-primary"
            />
            <Pill
              label="Win Streak"
              value={String(consecutiveWins)}
              sub={consecutiveLosses > 0 ? `${consecutiveLosses} loss streak` : "No losses in a row"}
              icon={consecutiveWins > 2 ? Flame : TrendingUp}
              color={consecutiveWins > 2 ? "text-amber-400" : consecutiveWins > 0 ? "text-emerald-400" : "text-muted-foreground"}
            />
            <Pill
              label="Trades"
              value={String(trades.length)}
              sub={`avg ${stats.pnl > 0 || trades.length > 0 ? (stats.pnl / trades.length).toFixed(2) : "0.00"} per trade`}
              icon={Activity}
              color="text-cyan-400"
            />
          </motion.div>

          {/* ── Charts row ───────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
              <PnlCurve trades={trades} />
            </motion.div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.15 }}>
              <HourlyChart trades={trades} />
            </motion.div>
          </div>

          {/* ── Bottom row: timeline + contract breakdown + risk ─────── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
              className="lg:col-span-2">
              <TradeTimeline trades={trades} />
            </motion.div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }}
              className="space-y-4">
              <ContractBreakdown trades={trades} />
              <RiskSnapshot
                drawdown={drawdown}
                consecutiveLosses={consecutiveLosses}
                consecutiveWins={consecutiveWins}
              />
            </motion.div>
          </div>
        </>
      )}
    </motion.div>
  );
}
