/**
 * Barrier Bastion console — the recovery-first Over/Under engine.
 *
 * Flow mirrors the other dedicated consoles (config → scan → lock/switch →
 * live), but every panel is specific to this bot:
 *
 *  - the BAND RULER: the 0–9 digit line with the four frozen bands drawn on it
 *    (Over 1 / Under 8 outer normal bands, Over 3 / Under 6 inner recovery
 *    bands, and the {4,5} double-win overlap where BOTH recovery sides win);
 *  - the RECOVERY RADAR: both recovery sides scored every tick with fused
 *    probability, pair-risk and utility — the bot fires the better one;
 *  - the NO-RATCHET badge: the recovery bar is printed as a frozen constant so
 *    the user can SEE it never hardens after a loss.
 *
 * There is no pace selector: one mode, one budget, no gates to chase.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, RefreshCw, ChevronLeft, X, Lock,
  Shuffle, ShieldCheck, LockKeyhole,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Verdict = "prime" | "viable" | "thin";
type SideMode = "both" | "over" | "under";

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
  breakEvenNormal: number;
  breakEvenRecovery: number;
  params: any;
  diag: {
    weights: [number, number, number, number];
    tau: number;
    normalInitBar: number;
    historyUsed: number;
    qLL: { over3: number; under6: number };
    fireRatePer100: number;
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
  { id: "both", label: "Over 1 & Under 8", hint: "AI picks the leaning side" },
  { id: "over", label: "Over 1 only", hint: "normal band: 2–9" },
  { id: "under", label: "Under 8 only", hint: "normal band: 0–7" },
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
 * THE signature visual: the 0–9 digit line with the frozen bands on it.
 * Outer row = normal bands (Over 1 / Under 8). Inner row = recovery bands
 * (Over 3 / Under 6) with the {4,5} double-win overlap hatched.
 */
function BandRuler({ live, accent }: {
  live?: { over1?: number; under8?: number; over3?: number; under6?: number };
  accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  const strong = (v?: number) => (v !== undefined && v >= 0.6 ? "ring-1 ring-green-400/80" : "");
  return (
    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-2.5 space-y-1.5`}>
      <div className="flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Band map · 0–9</p>
        <p className="text-[8px] text-muted-foreground/60 font-mono">■ win · {"{4,5}"} double-win</p>
      </div>
      <div className="grid grid-cols-10 gap-[3px]">
        {Array.from({ length: 10 }, (_, d) => {
          const isOver1 = d >= 2;
          const isUnder8 = d <= 7;
          const isOver3 = d >= 4;
          const isUnder6 = d <= 5;
          const overlap = isOver3 && isUnder6;
          return (
            <div key={d} className="space-y-[3px]">
              <div className={`h-3.5 rounded-[3px] ${isOver1 ? "bg-sky-400/70" : "bg-black/40"} ${strong(live?.over1)}`}
                   title={`Over 1 ${isOver1 ? "wins" : "loses"} on ${d}`} />
              <div className={`h-3.5 rounded-[3px] ${isUnder8 ? "bg-indigo-400/70" : "bg-black/40"} ${strong(live?.under8)}`}
                   title={`Under 8 ${isUnder8 ? "wins" : "loses"} on ${d}`} />
              <div className={`h-3.5 rounded-[3px] ${isOver3 ? (overlap ? "bg-emerald-400/90" : "bg-emerald-400/50") : "bg-black/40"} ${strong(live?.over3)}`}
                   title={`Over 3 ${isOver3 ? "wins" : "loses"} on ${d}`} />
              <div className={`h-3.5 rounded-[3px] ${isUnder6 ? (overlap ? "bg-emerald-400/90" : "bg-teal-400/50") : "bg-black/40"} ${strong(live?.under6)}`}
                   title={`Under 6 ${isUnder6 ? "wins" : "loses"} on ${d}`} />
              <p className="text-[9px] font-mono text-center text-muted-foreground/80">{d}</p>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-[8px] text-muted-foreground/70">
        <span><span className="inline-block w-2 h-2 rounded-[2px] bg-sky-400/70 mr-1" />Over 1</span>
        <span><span className="inline-block w-2 h-2 rounded-[2px] bg-indigo-400/70 mr-1" />Under 8</span>
        <span><span className="inline-block w-2 h-2 rounded-[2px] bg-emerald-400/50 mr-1" />Over 3</span>
        <span><span className="inline-block w-2 h-2 rounded-[2px] bg-teal-400/50 mr-1" />Under 6</span>
      </div>
    </div>
  );
}

export function BastionConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 19,
  });
  const { data: settings } = useGetSettings();

  const [sideMode, setSideMode] = useState<SideMode>("both");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">("locked");
  const [config, setConfig] = useState({ stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3 });
  const set = <K extends keyof typeof config>(k: K, v: number) =>
    setConfig(prev => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setConfig(prev => ({
      ...prev,
      stake: s.riskAmountValue ?? prev.stake,
      maxRecoverySteps: s.maxRecoverySteps ?? prev.maxRecoverySteps,
    }));
  }, [settings]);

  const isRunning = session?.running === true && session?.botId === bot?.id;
  useEffect(() => {
    if (isRunning) {
      setStep("running");
      const m = (session?.config as any)?.marketMode;
      if (m === "locked" || m === "switching") setMarketMode(m);
    }
  }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setStep(isRunning ? "running" : "config");
  }, [open]);

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
        try {
          const d = JSON.parse(e.data);
          if (d.botId === botId) applyStatus(d as BotSessionStatus);
        } catch { /* ignore */ }
      });
      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          if (p.botId !== botId) return;
          setProgress({ scanning: p.scanning, scanned: p.scanned, total: p.total });
        } catch { /* ignore */ }
      });
      es.onerror = () => { es.close(); if (!dead) timer = setTimeout(connect, 2000); };
    }
    connect();
    return () => { dead = true; if (timer) clearTimeout(timer); es?.close(); };
  }, [open, bot, applyStatus]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? ScanSearch;

  const buildBody = () => ({
    sideMode,
    ...config,
  });

  const scanEndpoint = "/api/bots/bastion/scan";
  const startEndpoint = "/api/bots/bastion/start";
  const stopEndpoint = "/api/bots/bastion/stop";

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch(scanEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      setScanResult(data as ScanResult);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleStart = async (c: Candidate, mode: "locked" | "switching") => {
    setLoading(true);
    try {
      const res = await fetch(startEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          marketMode: mode,
          symbol: c.symbol,
          params: c.params,
          analysis: c,
          ...(mode === "locked" ? { lockedSymbol: c.symbol } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setMarketMode(mode);
      setStep("running");
      toast.success(
        mode === "locked"
          ? `🔒 Locked on ${c.displayName} — recovery holds this market`
          : `🔁 Deployed on ${c.displayName} — recovery hunts all markets`,
      );
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch(stopEndpoint, { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Session stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;
  const watch = session?.bastionWatch;
  const bastionDeployed = session?.bastionDeployed;
  const inRecovery = session?.inRecovery === true;

  const CandidateCard = ({ c }: { c: Candidate }) => (
    <div className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-white">{c.displayName}</p>
        <span className="text-[10px] font-mono font-bold uppercase">{c.verdict}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Stat label="Recovery hits" value={`${(c.recoveryHitRate * 100).toFixed(0)}% / ${c.recoveryShots} shots`}
              tone={c.recoveryHitRate >= 0.6 ? "text-green-400" : "text-amber-300"} />
        <Stat label="Loss pairs" value={`${c.recoveryLossPairs} of ${c.recoveryLosses}`}
              tone={c.recoveryLossPairs === 0 ? "text-green-400" : "text-amber-300"} />
        <Stat label="Normal hits" value={`${(c.normalHitRate * 100).toFixed(0)}% / ${c.normalShots}`} />
        <Stat label="Avg ticks in debt" value={c.avgTicksInRecovery > 0 ? c.avgTicksInRecovery.toFixed(1) : "—"} />
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Paper expectancy{" "}
        <span className={`font-mono font-bold ${c.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
          {c.paperEdgePerDollar >= 0 ? "+" : ""}{(c.paperEdgePerDollar * 100).toFixed(1)}%
        </span>{" "}
        per $1 · bars {(c.breakEvenNormal * 100).toFixed(1)}% / {(c.breakEvenRecovery * 100).toFixed(1)}% break-even ·{" "}
        confidence {c.confidence}/100
      </p>
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] uppercase tracking-wider text-muted-foreground/60">lens mix</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/40 flex">
          <div className="bg-sky-400" style={{ width: `${c.diag.weights[0] * 100}%` }} title="digit markov" />
          <div className="bg-emerald-400" style={{ width: `${c.diag.weights[1] * 100}%` }} title="band markov" />
          <div className="bg-amber-400" style={{ width: `${c.diag.weights[2] * 100}%` }} title="hole hazard" />
          <div className="bg-fuchsia-400" style={{ width: `${c.diag.weights[3] * 100}%` }} title="suffix" />
        </div>
        <span className="text-[8px] font-mono text-muted-foreground/70">
          {c.diag.weights.map(w => (w * 100).toFixed(0)).join("/")}
        </span>
      </div>
    </div>
  );

  const liveBands = watch ? {
    over1: watch.sideLabel === "Over 1" ? watch.p : undefined,
    under8: watch.sideLabel === "Under 8" ? watch.p : undefined,
    over3: watch.recoveryRadar.find(r => r.label === "Over 3")?.p,
    under6: watch.recoveryRadar.find(r => r.label === "Under 6")?.p,
  } : undefined;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40" onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label={`${bot.name} console`}
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
              <button onClick={() => onOpenChange(false)} aria-label="Close console"
                      className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            {step === "config" && (
              <div className="p-4 space-y-4">
                <BandRuler accent={bot.accent} />

                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Normal band side · recovery always picks the best of Over 3 / Under 6
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {SIDE_MODES.map(s => (
                      <button key={s.id} onClick={() => setSideMode(s.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${
                          sideMode === s.id ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"}`}>
                        <span className="block text-[11px] font-semibold">{s.label}</span>
                        <span className="block text-[8px] text-muted-foreground/70">{s.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg} flex items-start gap-2`}>
                  <LockKeyhole className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${a.text}`} />
                  <div>
                    <p className={`text-[11px] font-bold ${a.text}`}>One mode · bars frozen for life</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      Normal: Over 1 / Under 8 at 1.23×. Recovery: Over 3 / Under 6 at 1.63×,
                      fired on the first tilt — the recovery bar NEVER hardens after a loss.
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

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan band + recovery quality
                </Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Replaying normal + recovery on unseen ticks</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `${progress.scanning}…` : "Preparing…"}
                  </p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full ${a.solidBtn} transition-all`}
                       style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">
                  {progress.scanned}/{progress.total} markets
                </p>
              </div>
            )}

            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {(scanResult.best ?? scanResult.bestAvailable) ? (
                  <>
                    <CandidateCard c={(scanResult.best ?? scanResult.bestAvailable)!} />
                    <BandRuler accent={bot.accent} />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                    <div className="space-y-2">
                      <Button onClick={() => handleStart((scanResult.best ?? scanResult.bestAvailable)!, "locked")} disabled={loading}
                              className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" /> Trade Locked on {(scanResult.best ?? scanResult.bestAvailable)!.displayName}
                      </Button>
                      <Button onClick={() => handleStart((scanResult.best ?? scanResult.bestAvailable)!, "switching")} disabled={loading}
                              variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Smart Switching — recovery hunts all markets
                      </Button>
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
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          c.verdict === "prime" ? "bg-green-400"
                            : c.verdict === "viable" ? "bg-sky-400" : "bg-amber-400"}`} />
                        <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                        <span className="font-mono text-muted-foreground/70">rec {(c.recoveryHitRate * 100).toFixed(0)}%</span>
                        <span className={`font-mono font-bold ${c.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {c.paperEdgePerDollar >= 0 ? "+" : ""}{(c.paperEdgePerDollar * 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <Button onClick={handleScan} disabled={loading} variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-scan
                </Button>
                <button onClick={() => setStep("config")}
                        className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Change side or risk
                </button>
              </div>
            )}

            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? (inRecovery ? "bg-amber-500/[0.07] border-amber-500/30" : `${a.panelBg} ${a.panelBorder}`) : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      {inRecovery ? `RECOVERY R${session?.recoveryStep ?? 1}` : "NORMAL BANDS"}
                    </span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${inRecovery ? "text-amber-300" : a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${inRecovery ? "bg-amber-400" : a.dot} animate-pulse`} />
                        {marketMode === "locked" ? "LOCKED" : "SWITCHING"}
                      </span>
                    ) : <span className="text-[10px] text-muted-foreground">STOPPED</span>}
                  </div>
                  <div className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {profit >= 0 ? "+" : "−"}${Math.abs(profit).toFixed(2)}
                  </div>
                  <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                    <span className="text-green-400">{session?.winCount ?? 0}W</span>
                    <span className="text-red-400">{session?.lossCount ?? 0}L</span>
                    <span className="text-muted-foreground">{winRate}% WR</span>
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} shots</span>
                  </div>
                </div>

                {bastionDeployed && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {marketMode === "locked" ? "Locked market" : "Active market"}
                      </p>
                      {watch?.switched && <span className="text-[9px] font-mono text-amber-300">↻ migrated</span>}
                    </div>
                    <p className="text-xs font-bold text-white">{bastionDeployed.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Recovery hits" value={`${(bastionDeployed.recoveryHitRate * 100).toFixed(0)}% / ${bastionDeployed.recoveryShots}`}
                            tone={bastionDeployed.recoveryHitRate >= 0.6 ? "text-green-400" : "text-amber-300"} />
                      <Stat label="Loss pairs" value={`${bastionDeployed.recoveryLossPairs}`} />
                      <Stat label="Normal hits" value={`${(bastionDeployed.normalHitRate * 100).toFixed(0)}% / ${bastionDeployed.normalShots}`} />
                      <Stat label="Paper EV / $1"
                            value={`${bastionDeployed.paperEdgePerDollar >= 0 ? "+" : ""}${(bastionDeployed.paperEdgePerDollar * 100).toFixed(1)}%`}
                            tone={bastionDeployed.paperEdgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <>
                    <BandRuler live={liveBands} accent={bot.accent} />

                    <div className={`rounded-xl border ${inRecovery ? "border-amber-500/30 bg-amber-500/[0.06]" : `${a.panelBorder} ${a.panelBg}`} p-3 space-y-2`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] uppercase tracking-widest font-semibold ${inRecovery ? "text-amber-300" : a.text}`}>
                          {watch.mode === "recovery" ? "Recovery shot" : "Normal shot"} · {watch.sideLabel}
                        </p>
                        <span className="text-[9px] font-mono text-muted-foreground/70">
                          {(watch.p * 100).toFixed(1)}% vs bar {(watch.bar * 100).toFixed(0)}%
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{watch.reason || "Waiting…"}</p>
                      <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                        <div className={`h-full ${watch.ready ? "bg-green-400" : inRecovery ? "bg-amber-400" : a.dot} transition-all duration-500`}
                             style={{ width: `${Math.max(3, Math.min(100, watch.bar > 0 ? (watch.p / Math.max(watch.bar, 0.01)) * 80 : 0))}%` }} />
                      </div>

                      {/* RECOVERY RADAR — both sides scored, every tick */}
                      {watch.recoveryRadar.length > 0 && (
                        <div className="space-y-1 pt-1 border-t border-white/5">
                          <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Recovery radar</p>
                          {watch.recoveryRadar.map(r => (
                            <div key={r.label} className="flex items-center gap-2 text-[10px]">
                              <span className={`w-1.5 h-1.5 rounded-full ${r.ready ? "bg-green-400" : "bg-white/20"}`} />
                              <span className="flex-1 text-white/80 font-medium">{r.label}</span>
                              <span className="font-mono text-muted-foreground">{(r.p * 100).toFixed(1)}%</span>
                              <span className={`font-mono ${r.utility >= 0 ? "text-green-400" : "text-red-400"}`}>
                                u {r.utility.toFixed(2)}
                              </span>
                            </div>
                          ))}
                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[9px] text-muted-foreground/70">
                              pair-risk {(watch.pairRisk * 100).toFixed(0)}% · qLL {(watch.qLL * 100).toFixed(0)}%
                            </span>
                            {/* THE no-ratchet badge: the bar as a frozen constant */}
                            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-black/40 text-muted-foreground/80 flex items-center gap-1">
                              <LockKeyhole className="w-2.5 h-2.5" /> bar frozen · no ratchet
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-4 gap-1 pt-1 border-t border-white/5">
                        {(["digit Mkv", "band Mkv", "hole hz", "suffix"] as const).map((lbl, i) => (
                          <Stat key={lbl} label={lbl} value={`${((watch.lenses[i] ?? 0) * 100).toFixed(0)}%`} />
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" :
                    session.message.startsWith("🔁") || session.message.startsWith("🔎") ? "bg-sky-500/10 border-sky-500/25 text-sky-300" :
                    session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                    session.message.startsWith("🛡") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                    "bg-secondary/30 border-border text-muted-foreground"
                  }`}>
                    {session.message}
                  </div>
                )}

                {session?.inRecovery && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> Recovery (Step {session.recoveryStep})
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Shared debt-driven ledger. Best Over 3 / Under 6 shot fires on the first tilt —
                      the bar is frozen at the fair rate no matter how deep the run goes.
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  {isRunning ? (
                    <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                      <StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop Session
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                        New Session
                      </Button>
                      <Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}>
                        <ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-scan
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default BastionConsole;
