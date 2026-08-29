import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain, Target, AlertTriangle, CheckCircle2, XCircle,
  Lightbulb, Activity, BarChart3, Shield, Zap, TrendingUp, TrendingDown,
  ArrowRight, Cpu, Eye,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";

// ── Data hooks ────────────────────────────────────────────────────────────────

function useIntelligenceSummary() {
  return useQuery({
    queryKey: ["intelligence-summary"],
    queryFn: () => fetch("/api/ai/intelligence/summary").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useRecentReports() {
  return useQuery({
    queryKey: ["intelligence-reports-5"],
    queryFn: () => fetch("/api/ai/intelligence/reports?limit=5").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useRecentMissed() {
  return useQuery({
    queryKey: ["intelligence-missed"],
    queryFn: () => fetch("/api/ai/intelligence/missed?limit=8").then(r => r.json()),
    refetchInterval: 15_000, staleTime: 8_000, refetchOnWindowFocus: true,
  });
}

function useThresholds() {
  return useQuery({
    queryKey: ["intelligence-thresholds"],
    queryFn: () => fetch("/api/ai/intelligence/thresholds").then(r => r.json()),
    refetchInterval: 10_000, staleTime: 5_000, refetchOnWindowFocus: true,
  });
}

function useEngineStatus() {
  return useQuery({
    queryKey: ["engine-status-intel"],
    queryFn: () => fetch("/api/ai/engine/status").then(r => r.json()),
    refetchInterval: 10_000, staleTime: 5_000, refetchOnWindowFocus: true,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number | null | undefined) {
  return n == null ? "—" : `${Math.round(n)}%`;
}
function fmt2(n: number) {
  return isNaN(n) ? "0.00" : n.toFixed(2);
}
function confLabel(a: string) {
  if (a === "too_high") return { text: "Overconfident",  cls: "border-red-500/40 text-red-400" };
  if (a === "too_low")  return { text: "Underconfident", cls: "border-yellow-500/40 text-yellow-400" };
  return                       { text: "Calibrated",     cls: "border-green-500/40 text-green-400" };
}

const AGENT_DISPLAY: Record<string, string> = {
  marketScanner:        "Market Scanner",
  tickIntelligence:     "Tick Intelligence",
  digitProbability:     "Digit Probability",
  riseFallAgent:        "Rise/Fall Model",
  marketRegime:         "Market Regime",
  executionTiming:      "Execution Timing",
  confidenceFusion:     "Confidence Fusion",
  recoveryIntelligence: "Recovery Intel",
  riskIntelligence:     "Risk Intelligence",
  portfolioManager:     "Portfolio Manager",
  learningAgent:        "Learning Agent",
  patternDiscovery:     "Pattern Discovery",
};

// ── KPI bar ───────────────────────────────────────────────────────────────────

function KpiBar({ summary, missed, tradesAnalyzed }: { summary: any; missed: any; tradesAnalyzed: number }) {
  // Use summary.totalAnalyzed as the primary count — it comes from ai_insights so wins+losses
  // always adds up to it. tradesAnalyzed (from dynamic-confidence engine) is a separate counter
  // shown in the EngineHealth panel; mixing them caused the visible 417 vs 67W+34L mismatch.
  const insightTotal = summary?.totalAnalyzed ?? 0;
  const kpis = [
    {
      icon: Brain,
      label: "Trades Analyzed",
      value: insightTotal > 0 ? insightTotal : (tradesAnalyzed > 0 ? tradesAnalyzed : 0),
      sub: insightTotal > 0
        ? `${summary.winsAnalyzed}W · ${summary.lossesAnalyzed}L`
        : tradesAnalyzed > 0 ? `${tradesAnalyzed} in calibration engine` : "No data yet",
      color: "text-primary",
      accent: "from-primary/20",
    },
    {
      icon: Shield,
      label: "Avoidable Losses",
      value: summary?.totalAnalyzed > 0 ? `${summary.avoidableLossRate}%` : "—",
      sub: `${summary?.avoidableLosses ?? 0} of ${summary?.lossesAnalyzed ?? 0} losses flagged`,
      color: (summary?.avoidableLossRate ?? 0) > 30 ? "text-red-400" : "text-green-400",
      accent: "from-green-500/10",
    },
    {
      icon: Target,
      label: "Confidence Accuracy",
      value: summary?.totalAnalyzed > 0 ? `${summary.appropriateConfidenceRate}%` : "—",
      sub: "Trades with calibrated confidence",
      color: (summary?.appropriateConfidenceRate ?? 0) > 65 ? "text-green-400" : "text-yellow-400",
      accent: "from-yellow-500/10",
    },
    {
      icon: AlertTriangle,
      label: "Rejected Win Rate",
      value: missed?.evaluated > 0 ? `${missed.wouldHaveWonRate}%` : "—",
      sub: `${missed?.wouldHaveWon ?? 0} of ${missed?.evaluated ?? 0} skipped trades`,
      color: (missed?.wouldHaveWonRate ?? 0) > 50 ? "text-yellow-400" : "text-green-400",
      accent: "from-yellow-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {kpis.map((k, i) => (
        <motion.div
          key={k.label}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
        >
          <Card className={`bg-gradient-to-br ${k.accent} to-card border-border overflow-hidden`}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest mb-1">{k.label}</p>
                  <p className={`text-2xl font-bold font-mono ${k.color}`}>{k.value}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{k.sub}</p>
                </div>
                <div className="p-2 rounded-lg bg-card/60">
                  <k.icon className={`w-4 h-4 ${k.color}`} />
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}

// ── Engine health panel ───────────────────────────────────────────────────────

function EngineHealth({ status, summary }: { status: any; summary: any }) {
  if (!status) {
    return (
      <Card className="bg-card border-border h-full">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" /> Live Engine Health
          </CardTitle>
        </CardHeader>
        <CardContent><p className="text-xs text-muted-foreground animate-pulse">Waiting for engine data…</p></CardContent>
      </Card>
    );
  }

  const minScore    = Number(status.confidenceThreshold ?? 50).toFixed(0);
  const minEV       = ((Number(status.evThreshold ?? -0.05)) * 100).toFixed(1);
  const recentWR    = status.recentWinRate != null ? `${status.recentWinRate}%` : "—";
  const analyzed    = status.tradesAnalyzed ?? 0;
  const recentN     = status.recentSampleSize ?? 0;

  const calBars = summary ? [
    { label: "Calibrated",    value: summary.appropriateConfidenceRate ?? 0, color: "bg-green-500" },
    { label: "Overconfident", value: summary.overconfidentRate ?? 0,         color: "bg-red-500"   },
    { label: "Underconfident",value: summary.underconfidentRate ?? 0,        color: "bg-yellow-500"},
  ] : [];

  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Zap className="w-4 h-4 text-primary" />
          Live Engine Health
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Active thresholds */}
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Active Thresholds</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Min Score",  value: minScore, unit: "pts", tip: "Minimum agent consensus to trade" },
              { label: "Min EV",     value: minEV,    unit: "%",   tip: "Minimum expected value to trade" },
              { label: "Win Rate",   value: recentWR, unit: "",    tip: "Recent session win rate" },
            ].map(t => (
              <div key={t.label} className="rounded-lg bg-secondary/40 py-2.5 px-1" title={t.tip}>
                <p className="text-base font-bold font-mono text-primary leading-none">
                  {t.value}<span className="text-[9px] text-muted-foreground ml-0.5">{t.unit}</span>
                </p>
                <p className="text-[9px] text-muted-foreground mt-1 leading-tight">{t.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Data summary */}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground border-t border-border pt-3">
          <Activity className="w-3 h-3 shrink-0" />
          <span>{analyzed} trades in memory · {recentN} in recent window</span>
        </div>

        {/* Calibration bars */}
        {calBars.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
              <BarChart3 className="w-3 h-3" /> Confidence Calibration
            </p>
            {calBars.map(b => (
              <div key={b.label}>
                <div className="flex justify-between text-[10px] mb-0.5">
                  <span className="text-muted-foreground">{b.label}</span>
                  <span className="font-mono font-semibold">{b.value}%</span>
                </div>
                <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                  <div className={`${b.color} h-full rounded-full transition-all duration-500`} style={{ width: `${b.value}%` }} />
                </div>
              </div>
            ))}
            {summary && (
              <div className="flex justify-between text-[10px] text-muted-foreground pt-1 border-t border-border/60">
                <span>Avg agent agreement</span>
                <span className="font-mono font-semibold text-foreground">{summary.avgAgentAgreement}/100</span>
              </div>
            )}
          </div>
        )}

        {analyzed < 10 && (
          <p className="text-[10px] text-muted-foreground italic border-t border-border pt-2">
            Dynamic calibration activates after 10 trades.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Agent accuracy ranking ────────────────────────────────────────────────────

function AgentAccuracy({ status }: { status: any }) {
  const agents: any[] = (status?.agentStats ?? []).filter((a: any) => a.samples > 0);

  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Cpu className="w-4 h-4 text-primary" />
          Agent Performance Ranking
          {agents.length > 0 && (
            <span className="ml-auto text-[10px] text-muted-foreground font-normal">{agents.length} active</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Cpu className="w-7 h-7 text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground text-center">
              Agent accuracy data builds up after your first trades.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {[...agents]
              .sort((a: any, b: any) => b.accuracy - a.accuracy)
              .map((agent: any, i: number) => {
                const name = AGENT_DISPLAY[agent.agentId] ?? agent.agentId.replace(/([A-Z])/g, " $1").trim();
                const acc: number = agent.accuracy;
                const color = acc > 60 ? "text-green-400" : acc > 48 ? "text-yellow-400" : "text-red-400";
                const barColor = acc > 60 ? "bg-green-500" : acc > 48 ? "bg-yellow-500" : "bg-red-500";
                return (
                  <motion.div
                    key={agent.agentId}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className="flex items-center gap-2.5"
                  >
                    <span className="text-[9px] text-muted-foreground/50 font-mono w-4 shrink-0 text-right">{i + 1}</span>
                    <span className="text-[10px] text-muted-foreground flex-1 truncate min-w-0">{name}</span>
                    <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden shrink-0">
                      <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${acc}%` }} />
                    </div>
                    <span className={`text-[10px] font-mono font-semibold w-9 text-right shrink-0 ${color}`}>
                      {acc}%
                    </span>
                    <span className="text-[9px] text-muted-foreground/50 w-10 text-right shrink-0">
                      {agent.samples}t
                    </span>
                  </motion.div>
                );
              })}
            <p className="text-[10px] text-muted-foreground pt-1.5 border-t border-border/50 flex items-center gap-1">
              <TrendingUp className="w-3 h-3" />
              Accurate agents get higher weight in future trade decisions
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recent trades ─────────────────────────────────────────────────────────────

function RecentTrades({ reports, loading }: { reports: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          Last 5 Trades
          {loading && !reports.length && <Activity className="w-3 h-3 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!reports.length ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Brain className="w-7 h-7 text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground text-center">
              {loading ? "Loading…" : "No trade intelligence yet — run some trades."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {reports.slice(0, 5).map((r: any, i: number) => {
              const conf = confLabel(r.confidenceAssessment ?? "");
              const profit = Number(r.profit);
              return (
                <motion.div
                  key={r.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={`rounded-lg border p-3 ${r.won ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {r.won
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" />
                        : <XCircle      className="w-3.5 h-3.5 text-red-400   shrink-0" />
                      }
                      <span className="text-xs font-mono font-semibold truncate">
                        {r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0 ml-2">
                      {r.couldHaveAvoided && (
                        <Badge variant="outline" className="text-[8px] border-yellow-500/40 text-yellow-400 px-1 py-0 h-4">Avoidable</Badge>
                      )}
                      <Badge variant="outline" className={`text-[8px] px-1 py-0 h-4 ${conf.cls}`}>
                        {conf.text}
                      </Badge>
                      <span className={`text-xs font-mono font-bold ${r.won ? "text-green-400" : "text-red-400"}`}>
                        {r.won ? "+" : ""}{fmt2(profit)}
                      </span>
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug line-clamp-2">
                    {r.won ? r.whyWon : r.whyLost}
                  </p>
                  {r.avoidanceReason && (
                    <p className="text-[10px] text-yellow-400/80 mt-0.5 leading-snug line-clamp-1">⚠ {r.avoidanceReason}</p>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recurring patterns ────────────────────────────────────────────────────────

function TopFindings({ findings, loading }: { findings: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-yellow-400" />
          Recurring Patterns
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && !findings.length ? (
          <p className="text-xs text-muted-foreground animate-pulse">Detecting patterns…</p>
        ) : findings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Lightbulb className="w-7 h-7 text-muted-foreground/25" />
            <p className="text-xs text-muted-foreground text-center">
              Patterns emerge after more trades are analyzed.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {findings.slice(0, 6).map((f: any, i: number) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: i * 0.05 }}
                className="flex items-start gap-2.5 p-2.5 rounded-lg bg-secondary/30"
              >
                <span className="text-xs font-mono font-bold text-primary shrink-0 mt-0.5 w-5 text-right">{f.count}×</span>
                <p className="text-xs text-foreground leading-relaxed">{f.finding}</p>
              </motion.div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Rejected trades ───────────────────────────────────────────────────────────

function MissedCompact({ summary, records, loading }: { summary: any; records: any[]; loading: boolean }) {
  return (
    <Card className="bg-card border-border h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Eye className="w-4 h-4 text-yellow-400" />
          Rejected Trades
          {loading && <Activity className="w-3 h-3 animate-spin text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">

        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            { label: "Correct",   value: pct(summary?.correctRejectionRate), color: "text-green-400" },
            { label: "Too Strict",value: pct(summary?.strictFilterRate),     color: "text-yellow-400" },
            { label: "Would Win", value: pct(summary?.wouldHaveWonRate),     color: "text-primary" },
          ].map(s => (
            <div key={s.label} className="rounded-lg bg-secondary/40 py-2.5 px-1">
              <p className={`text-base font-bold font-mono leading-none ${s.color}`}>{s.value}</p>
              <p className="text-[9px] text-muted-foreground mt-1 leading-tight">{s.label}</p>
            </div>
          ))}
        </div>

        {(!summary || summary.totalTracked === 0) && (
          <div className="flex flex-col items-center justify-center py-4 gap-1.5">
            <Shield className="w-6 h-6 text-muted-foreground/25" />
            <p className="text-[11px] text-muted-foreground text-center">
              Rejected trades appear here once the engine starts filtering.
            </p>
          </div>
        )}

        {summary?.topBlockingFilters?.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Top Filters</p>
            {summary.topBlockingFilters.slice(0, 4).map((f: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <p className="text-[10px] text-foreground flex-1 truncate">{f.filter}</p>
                <div className="flex items-center gap-1.5 shrink-0">
                  {f.tooStrictCount > 0 && (
                    <span className="text-[9px] text-yellow-400">{f.tooStrictCount}×⚠</span>
                  )}
                  <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">{f.count}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {records && records.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Recent</p>
            {records.slice(0, 5).map((r: any) => (
              <div key={r.id} className="flex items-center gap-2 py-1 border-b border-border/40 last:border-0">
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-mono">{r.symbol} · {r.contractType}{r.barrier != null ? ` @${r.barrier}` : ""}</span>
                </div>
                {r.evaluatedAt ? (
                  <span className={`text-[9px] font-semibold shrink-0 ${r.wouldHaveWon ? "text-yellow-400" : "text-green-400"}`}>
                    {r.wouldHaveWon ? "W↑" : "L↓"}
                  </span>
                ) : (
                  <span className="text-[9px] text-muted-foreground shrink-0">…</span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Signal quality banner ─────────────────────────────────────────────────────

function SignalQualityBanner({ status, summary }: { status: any; summary: any }) {
  if (!status) return null;

  const threshold = Number(status.confidenceThreshold ?? 50);
  const evThresh = Number(status.evThreshold ?? -0.05) * 100;
  const winRate = status.recentWinRate;
  const analyzed = status.tradesAnalyzed ?? 0;

  // Determine overall health colour
  const healthy = (winRate == null || winRate >= 50) && analyzed >= 5;
  const warning = winRate != null && winRate < 45;

  const color = warning ? "border-red-500/30 bg-red-500/5 text-red-400"
    : healthy ? "border-green-500/30 bg-green-500/5 text-green-400"
    : "border-primary/30 bg-primary/5 text-primary";
  const dot = warning ? "bg-red-500" : healthy ? "bg-green-500" : "bg-primary";

  return (
    <div className={`rounded-lg border px-4 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 ${color}`}>
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${dot}`} />
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider">
          {warning ? "Caution" : healthy ? "Engine healthy" : "Warming up"}
        </span>
      </div>
      <span className="text-[10px] font-mono opacity-80">Min score: {threshold}pts</span>
      <span className="text-[10px] font-mono opacity-80">EV floor: {evThresh.toFixed(1)}%</span>
      {winRate != null && (
        <span className="text-[10px] font-mono opacity-80">Recent win rate: {winRate}%</span>
      )}
      {analyzed > 0 && (
        <span className="text-[10px] font-mono opacity-80">{analyzed} trades calibrated</span>
      )}
      {summary?.avoidableLossRate > 0 && (
        <span className="ml-auto text-[10px] font-mono opacity-70">
          {summary.avoidableLossRate}% losses were avoidable
        </span>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Intelligence() {
  const { data: summaryData,    isLoading: summaryLoading }    = useIntelligenceSummary();
  const { data: reportsData,    isLoading: reportsLoading }    = useRecentReports();
  const { data: missedData,     isLoading: missedLoading }     = useRecentMissed();
  const { data: thresholdsData, isLoading: thresholdsLoading } = useThresholds();
  const { data: engineData }                                    = useEngineStatus();

  const summary       = summaryData?.summary;
  const missedSummary = summaryData?.missedSummary;
  const dynamicStatus = summaryData?.dynamicStatus ?? thresholdsData;
  const reports       = Array.isArray(reportsData) ? reportsData : [];
  const missed        = Array.isArray(missedData)  ? missedData  : [];
  // Single source of truth for "trades analyzed" everywhere on this page:
  // summary.totalAnalyzed (true count from trade_intelligence_reports), falling
  // back to the confidence engine's counter only when no reports exist yet.
  // This keeps the header badge and the KPI card from ever showing different numbers.
  const tradesAnalyzed = summary?.totalAnalyzed > 0 ? summary.totalAnalyzed : (dynamicStatus?.tradesAnalyzed ?? 0);

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Brain className="w-6 h-6 text-primary" />
            Trade Intelligence
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Real-time insights from your AI engine — every trade sharpens the model
          </p>
        </div>
        {tradesAnalyzed > 0 && (
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Analyzed</p>
            <p className="text-2xl font-mono font-bold text-primary">{tradesAnalyzed}</p>
          </div>
        )}
      </div>

      {/* ── Signal quality banner ───────────────────────────────────────── */}
      <AnimatePresence>
        {dynamicStatus && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
            <SignalQualityBanner status={dynamicStatus} summary={summary} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── KPI bar ────────────────────────────────────────────────────── */}
      {summaryLoading && !summaryData ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => (
            <Card key={i} className="bg-card border-border animate-pulse">
              <CardContent className="p-4 h-[88px]" />
            </Card>
          ))}
        </div>
      ) : (
        <KpiBar summary={summary} missed={missedSummary} tradesAnalyzed={tradesAnalyzed} />
      )}

      {/* ── Row 2: Engine health + Agent accuracy ranking ───────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <EngineHealth
          status={dynamicStatus}
          summary={summary}
        />
        <AgentAccuracy status={dynamicStatus} />
      </div>

      {/* ── Row 3: Last 5 trades · Patterns · Rejected trades ──────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <RecentTrades reports={reports} loading={reportsLoading} />
        <TopFindings  findings={summary?.topFindings ?? []} loading={summaryLoading && !summaryData} />
        <MissedCompact summary={missedSummary} records={missed} loading={missedLoading} />
      </div>

    </div>
  );
}
