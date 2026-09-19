/**
 * Accumulator Edge Navigator console.
 *
 * ACCU is not rendered through the ordinary digit console: the important
 * numbers are target ticks, compounded factor, conservative survival versus
 * compounded break-even, dynamic-barrier provenance, and knockout/early-close
 * telemetry. The deploy buttons only accept a measured candidate that passed
 * the server-side lower-bound gates.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, ChevronLeft, Gauge, Loader2, Lock, RefreshCw,
  ScanSearch, Shuffle, StopCircle, TrendingUp, X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type MarketMode = "locked" | "switching";
type GrowthRate = number | "auto";

interface Candidate {
  symbol: string;
  displayName: string;
  growthRate: number;
  growthRatePct: number;
  barrierPct: number;
  barrierSource: string;
  targetTicks: number;
  durationTicks: number;
  compoundedFactor: number;
  netReturnMultiplier: number;
  breakEvenSurvival: number;
  survivalProbability: number;
  survivalLower: number;
  knockoutProbability: number;
  oneTickHazard: number;
  oneTickHazardUpper: number;
  markovStayInside: number;
  markovKnockoutGivenRecent: number;
  returnVolatility: number;
  recentVolatility: number;
  regime: string;
  recentShock: number;
  expectedNetReturn: number;
  lowerExpectedNetReturn: number;
  kellyFraction: number;
  score: number;
  deployable: boolean;
  reason: string;
  signals: string[];
  samples: number;
  maxObservedSafeRun: number;
  p95SafeRun: number;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  bestAvailable: Candidate | null;
  allScored: Candidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
  brokerDiscovery: "live" | "screening-fallback";
}

function NumInput({ label, value, onChange, min, max, step = 1, suffix, accent }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(event) => onChange(Number(event.target.value))}
          className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-7">{suffix}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, tone = "text-white/90" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-black/25 px-2 py-1.5 min-w-0">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 truncate">{label}</p>
      <p className={`text-[11px] font-mono font-bold truncate ${tone}`}>{value}</p>
    </div>
  );
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const moneyPercent = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;

function CandidateCard({ candidate, accent }: { candidate: Candidate; accent: AccentKey }) {
  const a = ACCENTS[accent];
  return (
    <div className={`rounded-xl border ${candidate.deployable ? `${a.panelBorder} ${a.panelBg}` : "border-amber-500/25 bg-amber-500/[0.04]"} p-3 space-y-2`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">{candidate.displayName}</p>
          <p className="text-[10px] font-mono text-muted-foreground">{candidate.symbol} · {candidate.regime.toUpperCase()} REGIME</p>
        </div>
        <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${candidate.deployable ? "bg-green-500/15 text-green-400" : "bg-amber-500/15 text-amber-300"}`}>
          {candidate.deployable ? "EDGE CLEAR" : "HOLD"} · {candidate.score}/100
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Growth" value={`${candidate.growthRatePct.toFixed(0)}% · ${candidate.targetTicks}t`} tone={a.text} />
        <Stat label="Compound" value={`${candidate.compoundedFactor.toFixed(3)}×`} tone="text-cyan-300" />
        <Stat label="Duration" value={`${candidate.durationTicks}t max`} />
        <Stat label="Survival floor" value={percent(candidate.survivalLower)} tone="text-green-400" />
        <Stat label="Break-even" value={percent(candidate.breakEvenSurvival)} tone="text-amber-300" />
        <Stat label="Lower EV" value={moneyPercent(candidate.lowerExpectedNetReturn)} tone={candidate.lowerExpectedNetReturn > 0 ? "text-green-400" : "text-red-400"} />
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">{candidate.reason}</p>
      <div className="flex flex-wrap gap-1.5 text-[9px] font-mono text-muted-foreground/80">
        <span className="rounded bg-black/25 px-1.5 py-1">barrier {candidate.barrierSource}</span>
        <span className="rounded bg-black/25 px-1.5 py-1">KO {percent(candidate.knockoutProbability)}</span>
        <span className="rounded bg-black/25 px-1.5 py-1">Markov shock→KO {percent(candidate.markovKnockoutGivenRecent)}</span>
        <span className="rounded bg-black/25 px-1.5 py-1">n {candidate.samples}</span>
      </div>
      {candidate.signals.slice(0, 3).map((signal) => (
        <p key={signal} className={`text-[9px] leading-relaxed ${signal.startsWith("⛔") ? "text-amber-300" : "text-muted-foreground/70"}`}>{signal}</p>
      ))}
    </div>
  );
}

export function AccumulatorConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState({ scanning: "", scanned: 0, total: 19 });
  const { data: settings } = useGetSettings();
  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 5,
    stopLoss: 5,
    maxRecoverySteps: 3,
    growthRate: "auto" as GrowthRate,
    targetTicks: 8,
    durationTicks: 60,
  });
  const [marketMode, setMarketMode] = useState<MarketMode>("switching");

  const setNumber = <K extends "stake" | "takeProfit" | "stopLoss" | "maxRecoverySteps" | "targetTicks" | "durationTicks">(key: K, value: number) => {
    setConfig((previous) => ({ ...previous, [key]: value }));
  };
  const isRunning = session?.running === true && session.botId === "accumulators";

  useEffect(() => {
    if (!settings) return;
    const value = settings as any;
    setConfig((previous) => ({
      ...previous,
      stake: Number(value.riskAmountValue) > 0 ? Number(value.riskAmountValue) : previous.stake,
      maxRecoverySteps: Number(value.maxRecoverySteps) > 0 ? Number(value.maxRecoverySteps) : previous.maxRecoverySteps,
    }));
  }, [settings]);

  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);

  useEffect(() => {
    if (!open) return;
    setStep(isRunning ? "running" : "config");
    setScanResult(null);
    fetch("/api/bots/accumulator/status")
      .then((response) => response.ok ? response.json() : null)
      .then((status) => {
        if (status?.running && status.botId === "accumulators") {
          onSession(status);
          setStep("running");
        }
      })
      .catch(() => { /* the main page poll remains authoritative */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyStatus = useCallback((status: BotSessionStatus) => {
    if (status?.botId === "accumulators") onSession(status);
  }, [onSession]);

  useEffect(() => {
    if (!open) return;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const connect = () => {
      if (closed) return;
      source = new EventSource(withTabSession("/api/ai/events"));
      source.addEventListener("bot_update", (event: MessageEvent) => {
        try { applyStatus(JSON.parse(event.data) as BotSessionStatus); } catch { /* ignore */ }
      });
      source.addEventListener("bot_scan_progress", (event: MessageEvent) => {
        try {
          const value = JSON.parse(event.data);
          if (value.botId === "accumulators") setProgress({ scanning: value.scanning ?? "", scanned: value.scanned ?? 0, total: value.total ?? 19 });
        } catch { /* ignore */ }
      });
      source.onerror = () => {
        source?.close();
        if (!closed) timer = setTimeout(connect, 2500);
      };
    };
    connect();
    return () => { closed = true; if (timer) clearTimeout(timer); source?.close(); };
  }, [open, applyStatus]);

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: "Preparing price-return models…", scanned: 0, total: 19 });
    try {
      const response = await fetch("/api/bots/accumulator/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? "Accumulator scan failed");
        setStep("config");
        return;
      }
      setScanResult(data as ScanResult);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the accumulator analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleDeploy = async (candidate: Candidate, mode: MarketMode) => {
    setLoading(true);
    try {
      const response = await fetch("/api/bots/accumulator/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...config,
          marketMode: mode,
          symbol: candidate.symbol,
          displayName: candidate.displayName,
          analysis: candidate,
          ranked: scanResult?.allScored ?? [candidate],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        toast.error(data.error ?? "Accumulator deployment failed");
        return;
      }
      onSession(data.status);
      setMarketMode(mode);
      setStep("running");
      toast.success(`${mode === "locked" ? "🔒 Locked" : "🔁 Switching"} on ${candidate.displayName} — ACCU risk gates active`);
    } catch {
      toast.error("Could not deploy the accumulator");
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/bots/accumulator/stop", { method: "POST" });
      const data = await response.json();
      onSession(data.status ?? null);
      setStep("running");
      toast.success("Accumulator session stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  if (!bot) return null;
  const accent = bot.accent;
  const a = ACCENTS[accent];
  const Icon = BOT_ICON[bot.icon] ?? TrendingUp;
  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0 ? session.winCount / session.tradeCount : 0;
  const candidate = session?.accumulator;
  const gate = session?.accumulatorGate;
  const lastTrade = session?.lastAccumulatorTrade;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/45 z-40" onClick={() => onOpenChange(false)} />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog" aria-label="Accumulator Edge Navigator console"
            className={`fixed bottom-20 right-4 z-50 w-[23rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center`}><Icon className={`w-4.5 h-4.5 ${a.text}`} /></div>
                <div className="min-w-0"><p className="text-sm font-bold text-white truncate">Accumulator Edge Navigator</p><p className={`text-[9px] font-mono ${a.text}`}>ACCU · COMPOUNDED SURVIVAL</p></div>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-white" onClick={() => onOpenChange(false)}><X className="w-4 h-4" /></Button>
            </div>

            {step === "config" && (
              <div className="p-4 space-y-3">
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3 text-[10px] leading-relaxed text-amber-200/90">
                  ACCU is not a guaranteed-profit product. A dynamic-range breach can lose the full stake. The server only deploys a measured candidate when its conservative survival lower bound clears the compounded break-even line.
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Broker contract model</p>
                  <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span>Growth rate</span><select value={String(config.growthRate)} onChange={(event) => setConfig((previous) => ({ ...previous, growthRate: event.target.value === "auto" ? "auto" : Number(event.target.value) }))} className="h-8 w-28 rounded-md border border-white/10 bg-black/30 px-2 text-xs font-mono text-white"><option value="auto">Auto · 1–5%</option><option value="0.01">1%</option><option value="0.02">2%</option><option value="0.03">3%</option><option value="0.04">4%</option><option value="0.05">5%</option></select></label>
                  <NumInput label="Target growth ticks" value={config.targetTicks} onChange={(value) => setNumber("targetTicks", value)} min={2} max={45} suffix="ticks" accent={accent} />
                  <NumInput label="Broker max duration" value={config.durationTicks} onChange={(value) => setNumber("durationTicks", value)} min={1} max={230} suffix="ticks" accent={accent} />
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Account boundaries</p>
                  <NumInput label="Stake" value={config.stake} onChange={(value) => setNumber("stake", value)} min={0.35} step={0.5} suffix="USD" accent={accent} />
                  <NumInput label="Session take profit" value={config.takeProfit} onChange={(value) => setNumber("takeProfit", value)} min={1} suffix="USD" accent={accent} />
                  <NumInput label="Session stop loss" value={config.stopLoss} onChange={(value) => setNumber("stopLoss", value)} min={1} suffix="USD" accent={accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={(value) => setNumber("maxRecoverySteps", value)} min={1} max={10} accent={accent} />
                </div>
                <Button onClick={handleScan} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}><ScanSearch className="w-4 h-4 mr-2" /> Measure ACCU markets</Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center"><Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} /><p className="text-sm font-semibold text-white">Compounding, Markov and block-bootstrap scan</p><p className="text-[11px] text-muted-foreground">{progress.scanning || "Preparing…"}</p><div className="h-1.5 bg-secondary rounded-full overflow-hidden"><div className={`h-full ${a.solidBtn} transition-all`} style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} /></div><p className="text-[10px] font-mono text-muted-foreground/70">{progress.scanned}/{progress.total} markets · broker discovery: runtime</p></div>
            )}

            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                <div className={`rounded-lg px-3 py-2 border ${scanResult.suitable ? "border-green-500/25 bg-green-500/[0.05]" : "border-amber-500/25 bg-amber-500/[0.05]"}`}><p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Analysis verdict</p><p className="text-xs text-white/90 leading-relaxed mt-1">{scanResult.reason}</p><p className="text-[9px] font-mono text-muted-foreground/70 mt-1">{scanResult.historyDepth} price ticks · {scanResult.brokerDiscovery === "live" ? "broker limits discovered" : "screening limits; proposal remains authoritative"}</p></div>
                {scanResult.best ? <><CandidateCard candidate={scanResult.best} accent={accent} /><div className="space-y-2"><Button onClick={() => handleDeploy(scanResult.best!, "locked")} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}><Lock className="w-4 h-4 mr-2" /> Lock {scanResult.best.displayName}</Button><Button onClick={() => handleDeploy(scanResult.best!, "switching")} disabled={loading} variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}><Shuffle className="w-3.5 h-3.5 mr-2" /> Smart-switch on deterioration</Button></div></> : <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3 text-center space-y-2"><AlertTriangle className="w-5 h-5 text-amber-300 mx-auto" /><p className="text-xs font-semibold text-amber-300">No conservative edge cleared yet</p><p className="text-[11px] text-muted-foreground leading-relaxed">The bot will not force an ACCU trade. Reduce duration/target or wait for a calmer measured regime, then re-scan.</p></div>}
                {scanResult.bestAvailable && (!scanResult.best || scanResult.bestAvailable.symbol !== scanResult.best.symbol) && <div className="space-y-2"><p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Best held candidate</p><CandidateCard candidate={scanResult.bestAvailable} accent={accent} /></div>}
                {scanResult.allScored.length > 1 && <div className="space-y-1"><p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Ranked markets</p>{scanResult.allScored.slice(0, 6).map((item) => <div key={`${item.symbol}-${item.growthRate}`} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-[10px]"><span className={`w-1.5 h-1.5 rounded-full ${item.deployable ? "bg-green-400" : "bg-amber-400"}`} /><span className="flex-1 truncate text-white/80">{item.displayName}</span><span className="font-mono text-muted-foreground">{item.growthRatePct.toFixed(0)}% · {percent(item.survivalLower)}</span></div>)}</div>}
                <Button onClick={handleScan} disabled={loading} variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs`}><RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-measure</Button><button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white py-1 flex items-center justify-center gap-1"><ChevronLeft className="w-3 h-3" /> Change settings</button>
              </div>
            )}

            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span><span className={`text-[10px] font-mono ${a.text}`}>{isRunning ? (session?.marketMode === "switching" ? "SWITCHING" : "LOCKED") : "STOPPED"} · ACCU</span></div>
                  <div className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>{profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}</div>
                  <div className="flex gap-3 mt-2 text-[11px]"><span className="text-green-400">{session?.winCount ?? 0}W</span><span className="text-red-400">{session?.lossCount ?? 0}L</span><span className="text-muted-foreground">{Math.round(winRate * 100)}% observed</span><span className="text-muted-foreground">{session?.tradeCount ?? 0} trades</span></div>
                </div>
                {candidate && <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}><p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}><TrendingUp className="w-3 h-3" /> Live compounding model</p><p className="text-xs font-bold text-white">{candidate.displayName} · {(candidate.growthRate * 100).toFixed(0)}% growth</p><div className="grid grid-cols-3 gap-1.5"><Stat label="Target" value={`${candidate.targetTicks} ticks`} tone={a.text} /><Stat label="Compound" value={`${candidate.compoundedFactor.toFixed(3)}×`} tone="text-cyan-300" /><Stat label="KO risk" value={percent(candidate.knockoutProbability)} tone="text-amber-300" /><Stat label="Survival floor" value={percent(candidate.survivalLower)} tone="text-green-400" /><Stat label="BE survival" value={percent(candidate.breakEvenSurvival)} /><Stat label="Lower EV" value={moneyPercent(candidate.lowerExpectedNetReturn)} tone={candidate.lowerExpectedNetReturn > 0 ? "text-green-400" : "text-red-400"} /></div></div>}
                {gate && <div className={`rounded-xl border ${gate.ready ? "border-green-500/25 bg-green-500/[0.05]" : "border-amber-500/25 bg-amber-500/[0.05]"} p-3 space-y-1.5`}><p className={`text-[10px] uppercase tracking-widest font-semibold ${gate.ready ? "text-green-400" : "text-amber-300"} flex items-center gap-1.5`}><Gauge className="w-3 h-3" /> Entry and close gate</p><div className="flex items-center gap-2"><div className="h-1.5 flex-1 bg-black/40 rounded-full overflow-hidden"><div className={`h-full ${gate.ready ? "bg-green-400" : "bg-amber-400"}`} style={{ width: `${Math.min(100, gate.shockRatio * 50)}%` }} /></div><span className="text-[10px] font-mono text-white/80">{gate.shockRatio.toFixed(2)}× vol</span></div><p className="text-[10px] font-mono text-muted-foreground leading-relaxed">{gate.reason}</p></div>}
                {lastTrade && <div className="rounded-lg bg-white/[0.03] px-3 py-2 border border-white/5"><p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Last ACCU settlement · {lastTrade.market}</p><div className="flex items-center gap-2 mt-1"><span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${lastTrade.profit > 0 ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>{lastTrade.profit >= 0 ? "+" : "-"}${Math.abs(lastTrade.profit).toFixed(2)}</span><span className="text-[10px] text-muted-foreground">{lastTrade.ticks} ticks{lastTrade.closedEarly ? " · early close" : ""}{lastTrade.knockedOut ? " · FULL-STAKE KO" : ""}</span></div></div>}
                {session?.inRecovery && <div className="rounded-lg px-3 py-2 border border-amber-500/30 bg-amber-500/[0.08] text-xs"><p className="font-semibold text-amber-300">Recovery step {session.recoveryStep} · ${session.unrecoveredAmount.toFixed(2)} debt</p><p className="text-[10px] text-muted-foreground mt-1">Stake sizing uses the compounded ACCU net return, then respects the broker/account cap. A positive early close only pays down its actual net profit.</p></div>}
                {session?.message && <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" : session.message.startsWith("🛑") || session.message.startsWith("⛔") ? "bg-red-500/10 border-red-500/20 text-red-400" : session.message.startsWith("🔀") ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-300" : "bg-secondary/30 border-border text-muted-foreground"}`}>{session.message}</div>}
                <div className="flex gap-2">{isRunning ? <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs"><StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop Session</Button> : <><Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">New Setup</Button><Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}><ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-Scan</Button></>}</div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default AccumulatorConsole;
