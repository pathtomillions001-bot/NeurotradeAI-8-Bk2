/**
 * Vector Surge console — Rise/Fall momentum specialist with recovery-first intelligence.
 *
 * Flow mirrors Parity Forge / Bastion (config → scan → lock/switch → live), but every
 * panel is tailored to price momentum:
 *
 *  - the VECTOR GRID: Rise (CALL ↑) vs Fall (PUT ↓) with live fused-p halos,
 *    run-length ring, Hurst regime badge and drift t-stat so the user sees the tilt;
 *  - the RECOVERY RADAR: both sides scored every tick with fused p, pair-risk
 *    and utility — the bot fires the better one;
 *  - the MOMENTUM STRIP: Hurst exponent, drift t, dirAgreement and dead-chop
 *    flat/vol guards that gate the HurstDrift lens;
 *  - the NO-RATCHET badge: the 53% recovery bar printed as a frozen constant.
 *
 * No pace selector: one mode, pacing valve for normal, static bar for recovery.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, RefreshCw, ChevronLeft, X, Lock,
  Shuffle, ShieldCheck, LockKeyhole, TrendingUp, Activity, ArrowUp, ArrowDown, Waves,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Verdict = "prime" | "viable" | "thin";
type SideMode = "both" | "rise" | "fall";

interface Candidate {
  symbol: string;
  displayName: string;
  verdict: Verdict;
  confidence: number;
  paperEdgePerDollar: number;
  normalHitRate: number;
  normalShots: number;
  normalHits: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryHits: number;
  recoveryLossPairs: number;
  recoveryLosses: number;
  avgTicksInRecovery: number;
  fireRatePer100: number;
  breakEven: number;
  params: any;
  diag: {
    weights: [number, number, number, number];
    tau: number;
    normalInitBar: number;
    historyUsed: number;
    qLL: { rise: number; fall: number };
    fireRatePer100: number;
    hurst: number;
  };
  thinData: boolean;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  bestAvailable: Candidate | null;
  allScored: Candidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

const VERDICT_TONE: Record<Verdict, string> = {
  prime: "text-green-400 bg-green-500/10 border-green-500/30",
  viable: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  thin: "text-amber-300 bg-amber-500/10 border-amber-500/30",
};

const SIDE_MODES: Array<{ id: SideMode; label: string; hint: string }> = [
  { id: "both", label: "Rise & Fall", hint: "AI picks the vector" },
  { id: "rise", label: "Rise only", hint: "normal: CALL" },
  { id: "fall", label: "Fall only", hint: "normal: PUT" },
];

function NumInput({ label: lbl, value, onChange, min, step = 1, suffix, accent }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; step?: number; suffix?: string; accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{lbl}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} step={step}
          onChange={e => onChange(Number(e.target.value))}
          className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>}
      </div>
    </div>
  );
}

function Stat({ label: lbl, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-black/25 rounded-lg px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">{lbl}</p>
      <p className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}>{value}</p>
    </div>
  );
}

/**
 * Signature visual for Vector Surge: the Rise/Fall vector field.
 * Rise = emerald up-arrow, Fall = rose down-arrow. Live tilt halos pulse with p.
 * Hurst regime badge shows trending/mean-reverting/ambiguous.
 */
function VectorGrid({ live, accent, hurst, qLLRise, qLLFall }: {
  live?: { rise?: number; fall?: number };
  accent: AccentKey;
  hurst?: number;
  qLLRise?: number;
  qLLFall?: number;
}) {
  const a = ACCENTS[accent];
  const halo = (p?: number) => {
    if (p === undefined) return "";
    if (p >= 0.57) return "ring-1 ring-emerald-400/80 shadow-[0_0_10px_rgba(16,185,129,0.5)]";
    if (p >= 0.53) return "ring-1 ring-amber-400/80";
    return "";
  };
  const hurstTone = hurst === undefined ? "text-muted-foreground" : hurst > 0.55 ? "text-emerald-400" : hurst < 0.45 ? "text-sky-400" : "text-amber-300";
  const hurstLabel = hurst === undefined ? "—" : hurst > 0.55 ? "trending" : hurst < 0.45 ? "mean-rev" : "walk";
  return (
    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-2.5 space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1.5">
          <TrendingUp className="w-3 h-3" /> Vector Surge · Rise / Fall
        </p>
        <p className="text-[8px] font-mono flex items-center gap-1">
          <Waves className="w-2.5 h-2.5 text-muted-foreground/60" />
          <span className={hurstTone}>H {hurst !== undefined ? hurst.toFixed(2) : "—"} {hurstLabel}</span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className={`rounded-lg p-2.5 flex flex-col items-center gap-1.5 border bg-emerald-500/10 border-emerald-500/20 ${live?.rise !== undefined ? halo(live.rise) : ""}`}>
          <div className="w-7 h-7 rounded-full bg-emerald-500/20 flex items-center justify-center">
            <ArrowUp className="w-4 h-4 text-emerald-400" />
          </div>
          <span className="text-[10px] font-bold text-emerald-300 tracking-widest">RISE</span>
          <span className="text-xs font-mono font-bold text-emerald-200">{live?.rise !== undefined ? `${(live.rise * 100).toFixed(1)}%` : "—"}</span>
          <span className="text-[8px] font-mono text-muted-foreground/60">CALL · 1.92×</span>
        </div>
        <div className={`rounded-lg p-2.5 flex flex-col items-center gap-1.5 border bg-rose-500/10 border-rose-500/20 ${live?.fall !== undefined ? halo(live.fall) : ""}`}>
          <div className="w-7 h-7 rounded-full bg-rose-500/20 flex items-center justify-center">
            <ArrowDown className="w-4 h-4 text-rose-400" />
          </div>
          <span className="text-[10px] font-bold text-rose-300 tracking-widest">FALL</span>
          <span className="text-xs font-mono font-bold text-rose-200">{live?.fall !== undefined ? `${(live.fall * 100).toFixed(1)}%` : "—"}</span>
          <span className="text-[8px] font-mono text-muted-foreground/60">PUT · 1.92×</span>
        </div>
      </div>
      {(qLLRise !== undefined || qLLFall !== undefined) && (
        <div className="flex items-center justify-between text-[8px] font-mono text-muted-foreground/60 pt-1 border-t border-white/5">
          <span>run hazard · rise {(qLLRise !== undefined ? `${(qLLRise * 100).toFixed(0)}%` : "—")} qLL</span>
          <span>fall {(qLLFall !== undefined ? `${(qLLFall * 100).toFixed(0)}%` : "—")} qLL</span>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 text-[8px] text-muted-foreground/60">
        <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1" />Rise ↑</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-rose-500 mr-1" />Fall ↓</span>
        <span className="ml-auto">bar 53% frozen</span>
      </div>
    </div>
  );
}

function MomentumStrip({ accent }: { accent: AccentKey }) {
  const a = ACCENTS[accent];
  return (
    <div className={`rounded-lg border ${a.panelBorder} ${a.panelBg} px-2.5 py-2 flex items-center gap-2`}>
      <Activity className={`w-3 h-3 ${a.text}`} />
      <div className="flex-1">
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Momentum timing</p>
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Normal paces at 0.20/tick via valve · Recovery fires the BEST Rise/Fall instantly at 53% — no hardening, best vector hunts if cold here.
        </p>
      </div>
    </div>
  );
}

export function SurgeConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({ scanning: null, scanned: 0, total: 19 });
  const { data: settings } = useGetSettings();

  const [sideMode, setSideMode] = useState<SideMode>("both");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">("locked");
  const [config, setConfig] = useState({ stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3 });
  const set = <K extends keyof typeof config>(k: K, v: number) => setConfig(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setConfig(prev => ({ ...prev, stake: s.riskAmountValue ?? prev.stake, maxRecoverySteps: s.maxRecoverySteps ?? prev.maxRecoverySteps }));
  }, [settings]);

  const isRunning = session?.running === true && session?.botId === bot?.id;
  useEffect(() => {
    if (isRunning) { setStep("running"); const m = (session?.config as any)?.marketMode; if (m === "locked" || m === "switching") setMarketMode(m); }
  }, [isRunning]);
  useEffect(() => { if (!open) return; setScanResult(null); setStep(isRunning ? "running" : "config"); }, [open]);

  const applyStatus = useCallback((d: BotSessionStatus) => onSession(d), [onSession]);

  useEffect(() => {
    if (!open || !bot) return;
    const botId = bot.id;
    let es: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    function connect() {
      if (dead) return;
      es = new EventSource(withTabSession("/api/ai/events"));
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try { const d = JSON.parse(e.data); if (d.botId === botId) applyStatus(d as BotSessionStatus); } catch { /* ignore */ }
      });
      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try { const p = JSON.parse(e.data); if (p.botId !== botId) return; setProgress({ scanning: p.scanning, scanned: p.scanned, total: p.total }); } catch { /* ignore */ }
      });
      es.onerror = () => { es.close(); if (!dead) timer = setTimeout(connect, 2000); };
    }
    connect();
    return () => { dead = true; if (timer) clearTimeout(timer); es?.close(); };
  }, [open, bot, applyStatus]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? TrendingUp;

  const buildBody = () => ({ sideMode, ...config });

  const scanEndpoint = "/api/bots/surge/scan";
  const startEndpoint = "/api/bots/surge/start";
  const stopEndpoint = "/api/bots/surge/stop";

  const handleScan = async () => {
    setLoading(true); setStep("scanning"); setScanResult(null); setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch(scanEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(buildBody()) });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      setScanResult(data as ScanResult); setStep("scan-result");
    } catch { toast.error("Could not connect to the analysis engine"); setStep("config"); } finally { setLoading(false); }
  };

  const handleStart = async (c: Candidate, mode: "locked" | "switching") => {
    setLoading(true);
    try {
      const res = await fetch(startEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...buildBody(), marketMode: mode, symbol: c.symbol, params: c.params, analysis: c, ...(mode === "locked" ? { lockedSymbol: c.symbol } : {}) }) });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status); setMarketMode(mode); setStep("running");
      toast.success(mode === "locked" ? `🔒 Locked on ${c.displayName} — recovery holds this market` : `🔁 Deployed on ${c.displayName} — recovery hunts all markets`);
    } catch { toast.error("Could not start the bot"); } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try { const res = await fetch(stopEndpoint, { method: "POST" }); const data = await res.json(); onSession(data.status ?? null); toast.success("Session stopped"); } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0 ? Math.round((session.winCount / session.tradeCount) * 100) : 0;
  const watch = (session as any)?.surgeWatch as SurgeWatchStatus | undefined;
  const deployed = (session as any)?.surgeDeployed as Candidate | undefined;
  const inRecovery = session?.inRecovery === true;

  const CandidateCard = ({ c }: { c: Candidate }) => (
    <div className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-white">{c.displayName}</p>
        <span className="text-[10px] font-mono font-bold uppercase">{c.verdict}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="Recovery hits" value={`${(c.recoveryHitRate * 100).toFixed(0)}% / ${c.recoveryShots} shots`} tone={c.recoveryHitRate >= 0.56 ? "text-green-400" : "text-amber-300"} />
        <Stat label="Loss pairs" value={`${c.recoveryLossPairs} of ${c.recoveryLosses}`} tone={c.recoveryLossPairs === 0 ? "text-green-400" : "text-amber-300"} />
        <Stat label="Normal hits" value={`${(c.normalHitRate * 100).toFixed(0)}% / ${c.normalShots}`} />
        <Stat label="Avg ticks in debt" value={c.avgTicksInRecovery > 0 ? c.avgTicksInRecovery.toFixed(1) : "—"} />
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Paper expectancy <span className={`font-mono font-bold ${c.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>{c.paperEdgePerDollar >= 0 ? "+" : ""}{(c.paperEdgePerDollar * 100).toFixed(1)}%</span> per $1 · break-even {(c.breakEven * 100).toFixed(1)}% · confidence {c.confidence}/100
      </p>
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] uppercase tracking-wider text-muted-foreground/60">lens mix</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/40 flex">
          <div className="bg-emerald-400" style={{ width: `${c.diag.weights[0] * 100}%` }} title="markov" />
          <div className="bg-amber-400" style={{ width: `${c.diag.weights[1] * 100}%` }} title="run hazard" />
          <div className="bg-sky-400" style={{ width: `${c.diag.weights[2] * 100}%` }} title="hurst drift" />
          <div className="bg-fuchsia-400" style={{ width: `${c.diag.weights[3] * 100}%` }} title="suffix" />
        </div>
        <span className="text-[8px] font-mono text-muted-foreground/70">{c.diag.weights.map(w => (w * 100).toFixed(0)).join("/")}</span>
      </div>
      <div className="flex items-center gap-3 text-[8px] font-mono text-muted-foreground/60">
        <span>H {(c.diag.hurst ?? 0).toFixed(2)}</span>
        <span>qLL ↑ {(c.diag.qLL.rise * 100).toFixed(0)}%</span>
        <span>↓ {(c.diag.qLL.fall * 100).toFixed(0)}%</span>
        <span className="ml-auto">{c.diag.historyUsed} ticks</span>
      </div>
    </div>
  );

  const liveVec = watch ? {
    rise: watch.sideLabel === "Rise" ? watch.p : watch.altLabel === "Rise" ? watch.altP : undefined,
    fall: watch.sideLabel === "Fall" ? watch.p : watch.altLabel === "Fall" ? watch.altP : undefined,
  } as { rise?: number; fall?: number } : undefined;

  type SurgeWatchStatus = {
    phase: string; mode: string; sideLabel: string; altLabel: string;
    p: number; altP: number; bar: number; ready: boolean;
    pairRisk: number; qLL: number; lenses: [number, number, number, number];
    recoveryRadar: Array<{ label: string; p: number; utility: number; ready: boolean }>;
    reason: string; switched: boolean; ticksWatched: number; confidence: number; verdict: string;
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 z-40" onClick={() => onOpenChange(false)} />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog" aria-label={`${bot.name} console`}
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}>{bot.code}</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.tagline}</p>
                </div>
              </div>
              <button onClick={() => onOpenChange(false)} aria-label="Close console" className="text-muted-foreground hover:text-white p-1 flex-shrink-0"><X className="w-4 h-4" /></button>
            </div>

            {step === "config" && (
              <div className="p-4 space-y-4">
                <VectorGrid accent={bot.accent} hurst={undefined} />
                <MomentumStrip accent={bot.accent} />

                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Normal direction · recovery always scores both Rise and Fall</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SIDE_MODES.map(s => (
                      <button key={s.id} onClick={() => setSideMode(s.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${sideMode === s.id ? `${a.activeBg} border ${a.activeBorder} ${a.text}` : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"}`}>
                        <span className="block text-[11px] font-semibold">{s.label}</span>
                        <span className="block text-[8px] text-muted-foreground/70">{s.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg} flex items-start gap-2`}>
                  <LockKeyhole className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${a.text}`} />
                  <div>
                    <p className={`text-[11px] font-bold ${a.text}`}>Recovery-first · bar frozen at 53%</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      Rise/Fall at 1.92× (≈52.08% break-even). Normal timed by pacing valve; recovery fires the BEST of Rise/Fall the moment it clears 53% — the bar NEVER hardens after a loss. Hurst + drift and run-hazard gate loss pairs.
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session boundaries</p>
                  <NumInput label="Stake per shot" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} step={1} accent={bot.accent} />
                </div>

                <Button onClick={handleScan} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan momentum + recovery quality
                </Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Replaying vector policy on unseen ticks</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{progress.scanning ? `${progress.scanning}…` : "Preparing…"}</p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden"><div className={`h-full ${a.solidBtn} transition-all`} style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} /></div>
                <p className="text-[10px] font-mono text-muted-foreground/70">{progress.scanned}/{progress.total} markets</p>
              </div>
            )}

            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {(scanResult.best ?? scanResult.bestAvailable) ? (
                  <>
                    <CandidateCard c={(scanResult.best ?? scanResult.bestAvailable)!} />
                    <VectorGrid accent={bot.accent} hurst={(scanResult.best ?? scanResult.bestAvailable)!.diag.hurst} />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                    <div className="space-y-2">
                      <Button onClick={() => handleStart((scanResult.best ?? scanResult.bestAvailable)!, "locked")} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}><Lock className="w-4 h-4 mr-2" /> Trade Locked on {(scanResult.best ?? scanResult.bestAvailable)!.displayName}</Button>
                      <Button onClick={() => handleStart((scanResult.best ?? scanResult.bestAvailable)!, "switching")} disabled={loading} variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}><Shuffle className="w-3.5 h-3.5 mr-2" /> Smart Switching</Button>
                    </div>
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2 text-center">
                    <p className="text-xs font-semibold text-amber-300">Feed still warming up</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                  </div>
                )}
                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Runner-ups</p>
                    {scanResult.allScored.slice(1, 6).map((c, i) => (
                      <div key={i} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] text-left">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.verdict === "prime" ? "bg-green-400" : c.verdict === "viable" ? "bg-sky-400" : "bg-amber-400"}`} />
                        <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                        <span className="font-mono text-muted-foreground/70">rec {(c.recoveryHitRate * 100).toFixed(0)}%</span>
                        <span className={`font-mono font-bold ${c.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>{c.paperEdgePerDollar >= 0 ? "+" : ""}{(c.paperEdgePerDollar * 100).toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button onClick={handleScan} disabled={loading} variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}><RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-scan</Button>
                <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1"><ChevronLeft className="w-3 h-3" /> Change side or risk</button>
              </div>
            )}

            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? (inRecovery ? "bg-amber-500/[0.07] border-amber-500/30" : `${a.panelBg} ${a.panelBorder}`) : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{inRecovery ? `RECOVERY R${session?.recoveryStep ?? 1}` : "MOMENTUM NORMAL"}</span>
                    {isRunning ? <span className={`flex items-center gap-1 text-[10px] ${inRecovery ? "text-amber-300" : a.text}`}><span className={`w-1.5 h-1.5 rounded-full ${inRecovery ? "bg-amber-400" : a.dot} animate-pulse`} />{marketMode === "locked" ? "LOCKED" : "SWITCHING"}</span> : <span className="text-[10px] text-muted-foreground">STOPPED</span>}
                  </div>
                  <div className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>{profit >= 0 ? "+" : "−"}${Math.abs(profit).toFixed(2)}</div>
                  <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                    <span className="text-green-400">{session?.winCount ?? 0}W</span>
                    <span className="text-red-400">{session?.lossCount ?? 0}L</span>
                    <span className="text-muted-foreground">{winRate}% WR</span>
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} shots</span>
                  </div>
                </div>

                {deployed && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>{marketMode === "locked" ? "Locked market" : "Active market"}</p>
                      {watch?.switched && <span className="text-[9px] font-mono text-amber-300">↻ migrated</span>}
                    </div>
                    <p className="text-xs font-bold text-white">{deployed.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Recovery hits" value={`${(deployed.recoveryHitRate * 100).toFixed(0)}% / ${deployed.recoveryShots}`} tone={deployed.recoveryHitRate >= 0.56 ? "text-green-400" : "text-amber-300"} />
                      <Stat label="Loss pairs" value={`${deployed.recoveryLossPairs}`} />
                      <Stat label="Normal hits" value={`${(deployed.normalHitRate * 100).toFixed(0)}% / ${deployed.normalShots}`} />
                      <Stat label="Paper EV / $1" value={`${deployed.paperEdgePerDollar >= 0 ? "+" : ""}${(deployed.paperEdgePerDollar * 100).toFixed(1)}%`} tone={deployed.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <>
                    <VectorGrid live={liveVec} accent={bot.accent} qLLRise={watch.qLL !== undefined ? watch.qLL : undefined} hurst={undefined} />

                    <div className={`rounded-xl border ${inRecovery ? "border-amber-500/30 bg-amber-500/[0.06]" : `${a.panelBorder} ${a.panelBg}`} p-3 space-y-2`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] uppercase tracking-widest font-semibold ${inRecovery ? "text-amber-300" : a.text}`}>{watch.mode === "recovery" ? "Recovery shot" : "Normal shot"} · {watch.sideLabel}</p>
                        <span className="text-[9px] font-mono text-muted-foreground/70">{(watch.p * 100).toFixed(1)}% vs bar {(watch.bar * 100).toFixed(0)}%</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{watch.reason || "Waiting…"}</p>
                      <div className="h-2 rounded-full bg-black/40 overflow-hidden"><div className={`h-full ${watch.ready ? "bg-green-400" : inRecovery ? "bg-amber-400" : a.dot} transition-all duration-500`} style={{ width: `${Math.max(3, Math.min(100, watch.bar > 0 ? (watch.p / Math.max(watch.bar, 0.01)) * 80 : 0))}%` }} /></div>

                      {watch.recoveryRadar.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-white/5">
                          <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Recovery radar · Rise / Fall</p>
                          {watch.recoveryRadar.map(r => (
                            <div key={r.label} className="flex items-center gap-2 text-[10px]">
                              <span className={`w-1.5 h-1.5 rounded-full ${r.ready ? "bg-green-400" : "bg-white/20"}`} />
                              <span className="flex-1 text-white/80 font-medium flex items-center gap-1">
                                {r.label === "Rise" ? <ArrowUp className="w-3 h-3 text-emerald-400" /> : <ArrowDown className="w-3 h-3 text-rose-400" />}
                                {r.label}
                              </span>
                              <span className="font-mono text-muted-foreground">{(r.p * 100).toFixed(1)}%</span>
                              <span className={`font-mono ${r.utility >= 0 ? "text-green-400" : "text-red-400"}`}>u {r.utility.toFixed(2)}</span>
                            </div>
                          ))}
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[9px] text-muted-foreground/70">pair-risk {(watch.pairRisk * 100).toFixed(0)}% · qLL {(watch.qLL * 100).toFixed(0)}%</span>
                            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-muted-foreground/80 flex items-center gap-1"><LockKeyhole className="w-2.5 h-2.5" /> bar 53% frozen · no ratchet</span>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-4 gap-1 pt-1 border-t border-white/5">
                        {(["riseMkv", "runHz", "hurstDrift", "suffix"] as const).map((lbl, i) => (
                          <Stat key={lbl} label={lbl} value={`${((watch.lenses[i] ?? 0) * 100).toFixed(0)}%`} />
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" : session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" : session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" : session.message.startsWith("🔁") || session.message.startsWith("🔎") ? "bg-sky-500/10 border-sky-500/25 text-sky-300" : session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" : session.message.startsWith("🛡") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" : "bg-secondary/30 border-border text-muted-foreground"}`}>
                    {session.message}
                  </div>
                )}

                {session?.inRecovery && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> Recovery (Step {session.recoveryStep})</span>
                      <span className="font-mono text-[10px] text-amber-400">${(session.unrecoveredAmount ?? 0).toFixed(2)} debt</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">Shared debt-driven ledger. Best Rise/Fall shot fires on the first tilt — the 53% bar is frozen no matter how deep the run goes. Switching hunts all markets; locked holds.</p>
                  </div>
                )}

                <div className="flex gap-2">
                  {isRunning ? <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs"><StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop Session</Button> : <><Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">New Session</Button><Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}><ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-scan</Button></>}
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default SurgeConsole;
