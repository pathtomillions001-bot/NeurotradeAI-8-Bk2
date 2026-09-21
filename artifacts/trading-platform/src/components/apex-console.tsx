/**
 * Echo Apex console — the institutional Matches engine.
 *
 * Flow mirrors the other dedicated consoles (config → scan → lock/switch →
 * live), but every panel is tailored to this bot: pace budgets instead of
 * certainty walls, echo-lag / heat / memory diagnostics instead of generic
 * scores, and a live watch that shows the pacing valve's bar against the
 * fused probability in real time.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, RefreshCw, ChevronLeft, X, Lock,
  Shuffle, ShieldCheck,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Pace = "brisk" | "steady" | "patient";
type Verdict = "prime" | "viable" | "thin";

interface Candidate {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: Verdict;
  confidence: number;
  edgePerDollar: number;
  hitRate: number;
  hitRateLower: number;
  shots: number;
  fireRate: number;
  breakEven: number;
  payout: number;
  params: any;
  diag: {
    echoLags: Array<{ lag: number; rate: number; z: number }>;
    heatDigit: number;
    heatRatio: number;
    memoryOrder: number;
    memorySamples: number;
    weights: [number, number, number];
    tau: number;
    fireRate: number;
    brierSkill: number;
    historyUsed: number;
  };
  thinData: boolean;
}
interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  bestAvailable: Candidate | null;
  allScored: Candidate[];
  reason: string;
  pace: Pace;
  marketsScanned: number;
  historyDepth: number;
}

const VERDICT_TONE: Record<Verdict, string> = {
  prime: "text-green-400 bg-green-500/10 border-green-500/30",
  viable: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  thin: "text-amber-300 bg-amber-500/10 border-amber-500/30",
};

const PACES: Array<{ id: Pace; label: string; hint: string }> = [
  { id: "brisk", label: "Brisk", hint: "~6 shots / 100 ticks" },
  { id: "steady", label: "Steady", hint: "~3.5 shots / 100 ticks" },
  { id: "patient", label: "Patient", hint: "~2 shots / 100 ticks" },
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

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function ApexConsole({ bot, open, onOpenChange, session, onSession }: {
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

  const [pace, setPace] = useState<Pace>("steady");
  const [aiDigit, setAiDigit] = useState(true);
  const [digit, setDigit] = useState<number>(7);
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

  const buildBody = () => {
    const body: Record<string, unknown> = { pace, ...config };
    if (!aiDigit) body.digit = digit;
    return body;
  };

  const scanEndpoint = "/api/bots/apex/scan";
  const startEndpoint = "/api/bots/apex/start";
  const stopEndpoint = "/api/bots/apex/stop";

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
          ? `🔒 Locked on ${c.displayName} — digit rotates, market won't`
          : `🔁 Deployed on ${c.displayName} — migrates to better edges`,
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
  const watch = session?.apexWatch;
  const apexDeployed = session?.apexDeployed;

  const CandidateCard = ({ c }: { c: Candidate }) => (
    <div className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-white">
          {c.displayName} · <span className="text-white/80">Matches {c.digit}</span>
        </p>
        <span className="text-[10px] font-mono font-bold uppercase">{c.verdict}</span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Measured <span className="font-mono text-white/80">{(c.hitRate * 100).toFixed(0)}%</span> over{" "}
        <span className="font-mono text-white/80">{c.shots}</span> unseen shots (break-even{" "}
        <span className="font-mono text-white/80">{(c.breakEven * 100).toFixed(1)}%</span>) — expectancy{" "}
        <span className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
          {c.edgePerDollar >= 0 ? "+" : ""}{(c.edgePerDollar * 100).toFixed(1)}%
        </span>{" "}
        per $1 · {(c.fireRate * 100).toFixed(1)} shots/100 ticks · confidence {c.confidence}/100
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Echo lags" value={c.diag.echoLags.slice(0, 3).map(l => `${l.lag}@${(l.rate * 100).toFixed(0)}%`).join(" ") || "—"} />
        <Stat label="Heat" value={`${c.diag.heatDigit} ×${c.diag.heatRatio.toFixed(1)}`} />
        <Stat label="Memory" value={c.diag.memoryOrder > 0 ? `ord ${c.diag.memoryOrder} · ${Math.round(c.diag.memorySamples)}n` : "fair"} />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[8px] uppercase tracking-wider text-muted-foreground/60">lens mix</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/40 flex">
          <div className="bg-lime-400" style={{ width: `${c.diag.weights[0] * 100}%` }} title="echo" />
          <div className="bg-orange-400" style={{ width: `${c.diag.weights[1] * 100}%` }} title="hawkes" />
          <div className="bg-sky-400" style={{ width: `${c.diag.weights[2] * 100}%` }} title="suffix" />
        </div>
        <span className="text-[8px] font-mono text-muted-foreground/70">
          {(c.diag.weights[0] * 100).toFixed(0)}/{(c.diag.weights[1] * 100).toFixed(0)}/{(c.diag.weights[2] * 100).toFixed(0)}
        </span>
      </div>
    </div>
  );

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
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Pace budget</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {PACES.map(p => (
                      <button key={p.id} onClick={() => setPace(p.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${
                          pace === p.id ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"}`}>
                        <span className="block text-[11px] font-semibold">{p.label}</span>
                        <span className="block text-[8px] text-muted-foreground/70">{p.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <button onClick={() => setAiDigit(v => !v)}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] text-left transition-colors ${
                    aiDigit ? `${a.activeBg} border ${a.activeBorder}` : "bg-white/[0.03] border border-white/5"}`}>
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                    aiDigit ? `${a.dot} border-transparent` : "border-white/20"}`}>
                    {aiDigit && <span className="text-[8px] text-black font-bold">✓</span>}
                  </span>
                  <span className={aiDigit ? a.text : "text-muted-foreground"}>
                    Let the AI pick the hottest digit per market
                  </span>
                </button>
                {!aiDigit && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Locked digit</p>
                    <div className="grid grid-cols-5 gap-1">
                      {ALL_DIGITS.map(d => (
                        <button key={d} onClick={() => setDigit(d)}
                          className={`h-8 rounded-lg text-xs font-mono font-bold transition-colors ${
                            digit === d ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                              : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"}`}>
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg}`}>
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Selected</p>
                  <p className={`text-sm font-bold ${a.text}`}>
                    Matches {aiDigit ? "(AI picks)" : digit} · {pace === "brisk" ? "Brisk" : pace === "patient" ? "Patient" : "Steady"} pace
                  </p>
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
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan repeat rhythm
                </Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Fitting rhythm, then replaying unseen ticks</p>
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
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <CandidateCard c={scanResult.best} />
                    <div className="space-y-2">
                      <Button onClick={() => handleStart(scanResult.best!, "locked")} disabled={loading}
                              className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" /> Trade Locked on {scanResult.best.displayName}
                      </Button>
                      <Button onClick={() => handleStart(scanResult.best!, "switching")} disabled={loading}
                              variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Trade with Smart Market Switching
                      </Button>
                    </div>
                  </>
                ) : scanResult.bestAvailable ? (
                  <>
                    <CandidateCard c={scanResult.bestAvailable} />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {scanResult.reason} Starting it is a deliberate choice — the bot keeps
                      re-measuring and the pacing valve stands down while setups sit below break-even.
                    </p>
                    <div className="space-y-2">
                      <Button onClick={() => handleStart(scanResult.bestAvailable!, "locked")} disabled={loading}
                              className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" /> Lock {scanResult.bestAvailable.displayName} anyway
                      </Button>
                      <Button onClick={() => handleStart(scanResult.bestAvailable!, "switching")} disabled={loading}
                              variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Start with Smart Market Switching
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
                        <span className="font-medium flex-1 truncate text-white/80">{c.displayName} · M{c.digit}</span>
                        <span className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {c.edgePerDollar >= 0 ? "+" : ""}{(c.edgePerDollar * 100).toFixed(1)}%
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
                  <ChevronLeft className="w-3 h-3" /> Change pace, digit or risk
                </button>
              </div>
            )}

            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
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

                {apexDeployed && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {marketMode === "locked" ? "Locked market" : "Active market"}
                      </p>
                      {watch?.switched && (
                        <span className="text-[9px] font-mono text-amber-300">↻ rotated</span>
                      )}
                    </div>
                    <p className="text-xs font-bold text-white">{apexDeployed.displayName} · Matches {apexDeployed.digit}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Verdict" value={apexDeployed.verdict.toUpperCase()}
                            tone={apexDeployed.verdict === "thin" ? "text-amber-300" : "text-green-400"} />
                      <Stat label="Measured" value={`${(apexDeployed.hitRate * 100).toFixed(0)}% / ${apexDeployed.shots} shots`} />
                      <Stat label="Expectancy / $1"
                            value={`${apexDeployed.edgePerDollar >= 0 ? "+" : ""}${(apexDeployed.edgePerDollar * 100).toFixed(1)}%`}
                            tone={apexDeployed.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
                      <Stat label="Fire rate" value={`${(apexDeployed.fireRate * 100).toFixed(1)}/100`} />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {watch.phase === "firing" ? "Firing" : watch.phase === "armed" ? "Armed" : watch.phase === "settling" ? "Settling" : "Watching"}
                      </p>
                      <span className="text-[9px] font-mono text-muted-foreground/70">
                        {(watch.p * 100).toFixed(1)}% vs {(watch.bar * 100).toFixed(1)}% bar
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{watch.reason || "Waiting…"}</p>
                    <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                      <div className={`h-full ${watch.p >= watch.bar ? "bg-green-400" : a.dot} transition-all duration-500`}
                           style={{ width: `${Math.max(3, Math.min(100, watch.bar > 0 ? (watch.p / watch.bar) * 100 : 0))}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Top digits" value={watch.topDigits.map(t => `${t.digit}:${(t.p * 100).toFixed(0)}%`).join(" ") || "—"} />
                      <Stat label="Echo" value={watch.echoLags.map(l => `${l.lag}@${(l.rate * 100).toFixed(0)}%`).join(" ") || "—"} />
                      <Stat label="Heat" value={`${watch.heatDigit} ×${watch.heatRatio.toFixed(1)}`} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Memory" value={watch.memoryOrder > 0 ? `ord ${watch.memoryOrder}` : "fair"} />
                      <Stat label="Ticks watched" value={String(watch.ticksWatched)} />
                      <Stat label="Confidence" value={`${watch.confidence}/100`} />
                    </div>
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" :
                    session.message.startsWith("🔁") ? "bg-sky-500/10 border-sky-500/25 text-sky-300" :
                    session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
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
                      Shared recovery ledger, same debt-driven Matches stake as every other bot — the valve paces tighter while in debt.
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

export default ApexConsole;
