/**
 * Dual-Lock Navigator (Twin Rail) console.
 *
 * One deep scan ranks every digit market on how SAFE the Over 4 + Under 5
 * (normal) and Over 5 + Under 4 (recovery) dual-leg pairs are, then returns
 * the single best market. The user can deploy it locked, or press Create
 * DBot to hand a ready-made Deriv Bot strategy to the embedded builder.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Lock,
  ChevronLeft, X, ShieldCheck, Workflow, Activity,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

type Step = "config" | "scanning" | "scan-result" | "running";

interface Contract { side: "DIGITOVER" | "DIGITUNDER"; barrier: number }

interface Candidate {
  symbol: string;
  displayName: string;
  normal: [Contract, Contract];
  recovery: [Contract, Contract];
  score: number;
  survival: number;
  ruin: number;
  boundaryRate: number;
  clusterXi: number;
  recoveryDoubleLossRate: number;
  recoverySuccessRate: number;
  recoveryDepthP95: number;
  stationarityZ: number;
  significant: boolean;
  reason: string;
  signals: string[];
  metrics: Record<string, number>;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  allScored: Candidate[];
  reason: string;
  marketsScanned?: number;
  normal?: { pair: string };
  recovery?: { pair: string };
  sessionParams?: { stake: number; takeProfit: number; stopLoss: number; maxRecoverySteps: number };
}

function labelPair(n: [Contract, Contract]): string {
  const lbl = (c: Contract) => `${c.side === "DIGITOVER" ? "Over" : "Under"} ${c.barrier}`;
  return `${lbl(n[0])} + ${lbl(n[1])}`;
}

function NumInput({ label: lbl, value, onChange, min, step = 1, suffix, accent, disabled }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; step?: number; suffix?: string; accent: AccentKey; disabled?: boolean;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{lbl}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} step={step} disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 disabled:opacity-60 ${a.focusBorder}`}
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

export function TwinRailConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [buildingDbot, setBuildingDbot] = useState(false);
  const [, navigate] = useLocation();
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 19,
  });
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
  });

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setConfig(prev => ({
      ...prev,
      stake: s.riskAmountValue ?? prev.stake,
      maxRecoverySteps: s.maxRecoverySteps ?? prev.maxRecoverySteps,
    }));
  }, [settings]);

  const isRunning = session?.running === true && session.botId === "twinrail";
  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setStep(isRunning ? "running" : "config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyStatus = useCallback((d: BotSessionStatus) => onSession(d), [onSession]);

  useEffect(() => {
    if (!open) return;
    let es: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    function connect() {
      if (dead) return;
      es = new EventSource(withTabSession("/api/ai/events"));
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try { applyStatus(JSON.parse(e.data) as BotSessionStatus); } catch { /* ignore */ }
      });
      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          if (p.botId !== "twinrail") return;
          setProgress({ scanning: p.scanning, scanned: p.scanned, total: p.total });
        } catch { /* ignore */ }
      });
      es.onerror = () => { es.close(); if (!dead) timer = setTimeout(connect, 2000); };
    }
    connect();
    return () => { dead = true; if (timer) clearTimeout(timer); es?.close(); };
  }, [open, applyStatus]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Activity;

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch("/api/bots/twinrail/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      if (data.sessionParams) setConfig(data.sessionParams);
      setScanResult(data);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleStart = async (c: Candidate) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twinrail/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: c.symbol, analysis: c, ...config }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(`⚡ Twin Rail locked on ${c.displayName} — ${labelPair(c.normal)} → ${labelPair(c.recovery)} (same tick)`);
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  const handleCreateDbot = async (c: Candidate) => {
    setBuildingDbot(true);
    try {
      const res = await fetch("/api/bots/twinrail/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: c.symbol, analysis: c, ...config }),
      });
      const data = await res.json();
      if (!res.ok || !data?.xml) {
        toast.error(data?.error ?? "Could not build the DBot strategy");
        return;
      }
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol: c.symbol });
      toast.info(`Building your DBot for ${c.displayName} — ${labelPair(c.normal)} → ${labelPair(c.recovery)} (same tick)…`);
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        toast.success(
          `DBot ready: ${c.displayName} · ${labelPair(c.normal)} normal → ${labelPair(c.recovery)} recovery (same-tick dual legs) · stake $${config.stake} · TP $${config.takeProfit} · SL $${config.stopLoss}. Verify blocks, then press Run.`,
          { duration: 12_000 },
        );
      } else {
        toast.error("The bot builder did not confirm the strategy loaded — open Bot Builder and try Create DBot again.");
      }
    } catch {
      toast.error("Could not reach the analysis engine to build the DBot");
    } finally {
      setBuildingDbot(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twinrail/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Dual-Lock Navigator stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0 ? Math.round((session.winCount / session.tradeCount) * 100) : 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/40 z-40" onClick={() => onOpenChange(false)} />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label="Dual-Lock Navigator console"
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
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300 font-semibold">SCANNER</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.tagline}</p>
                </div>
              </div>
              <button onClick={() => onOpenChange(false)} aria-label="Close console" className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            {step === "config" && (
              <div className="p-4 space-y-4">
                <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                  <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                    <Activity className="w-3 h-3" /> How this scanner works
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Scans every digit market for the tape where{" "}
                    <span className="text-white/80">digits 4 &amp; 5 are rarest and least clustered</span> — those are
                    the only two digits that can double-lose the recovery pair. Normal ={" "}
                    <span className="text-white/80">Over 4 + Under 5 same tick</span>, recovery ={" "}
                    <span className="text-white/80">Over 5 + Under 4 same tick</span>, sized to recover the total lost
                    amount when a pair loses.
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session Boundaries</p>
                  <NumInput label="Base stake (per leg)" value={config.stake} onChange={v => setConfig(c => ({ ...c, stake: v }))} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => setConfig(c => ({ ...c, takeProfit: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => setConfig(c => ({ ...c, stopLoss: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => setConfig(c => ({ ...c, maxRecoverySteps: v }))} min={1} step={1} accent={bot.accent} />
                </div>
                <Button onClick={handleScan} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan for Best Dual-Lock Market
                </Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Scanning every digit market</p>
                  <p className="text-[11px] text-muted-foreground mt-1">{progress.scanning ? `Analysing ${progress.scanning}…` : "Preparing…"}</p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full ${a.solidBtn} transition-all`} style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">{progress.scanned}/{progress.total} markets · measuring 4/5 frequency &amp; clustering</p>
              </div>
            )}

            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>Best Dual-Lock Market</p>
                        <span className="text-[10px] font-mono text-green-400">{(scanResult.best.survival * 100).toFixed(0)}% survival</span>
                      </div>
                      <p className="text-sm font-bold text-white">{scanResult.best.displayName}</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="Normal (same tick)" value={labelPair(scanResult.best.normal)} tone={a.text} />
                        <Stat label="Recovery (same tick)" value={labelPair(scanResult.best.recovery)} tone="text-amber-300" />
                        <Stat label="4/5 frequency" value={`${(scanResult.best.boundaryRate * 100).toFixed(1)}%`} tone={scanResult.best.boundaryRate < 0.18 ? "text-green-400" : "text-amber-300"} />
                        <Stat label="Clustering ξ" value={scanResult.best.clusterXi.toFixed(2)} tone={scanResult.best.clusterXi < 1.2 ? "text-green-400" : "text-amber-300"} />
                        <Stat label="Recovery double-loss" value={`${(scanResult.best.recoveryDoubleLossRate * 100).toFixed(1)}%`} tone="text-amber-300" />
                        <Stat label="Risk of SL" value={`${(scanResult.best.ruin * 100).toFixed(0)}%`} tone={scanResult.best.ruin < 0.3 ? "text-green-400" : "text-red-400"} />
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 leading-relaxed">{scanResult.reason}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={() => handleStart(scanResult.best!)} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" /> Locked Session
                      </Button>
                      <Button onClick={handleScan} disabled={loading} variant="outline" className={`w-full h-10 ${a.outlineBtn} text-xs font-bold`}>
                        <RefreshCw className="w-4 h-4 mr-2" /> Re-Scan
                      </Button>
                      <Button onClick={() => handleCreateDbot(scanResult.best!)} disabled={loading || buildingDbot} data-testid="twinrail-create-dbot"
                        className="col-span-2 w-full h-10 bg-gradient-to-r from-teal-500 to-cyan-600 hover:from-teal-400 hover:to-cyan-500 text-white font-bold text-xs">
                        {buildingDbot ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Workflow className="w-4 h-4 mr-2" />}
                        {buildingDbot ? "Building DBot…" : "Create DBot (same-tick dual)"}
                      </Button>
                      <p className="col-span-2 text-[9px] text-muted-foreground/60 leading-relaxed">
                        Builds a Deriv Bot for <span className="text-white/80">{scanResult.best.displayName}</span> —{" "}
                        {labelPair(scanResult.best.normal)} normal → {labelPair(scanResult.best.recovery)} recovery, your stake, TP/SL and the shared recovery ladder — with both legs fired on the SAME tick.
                      </p>
                    </div>
                    {scanResult.allScored.length > 1 && (
                      <div className="space-y-1 pt-1 border-t border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Runner-up markets</p>
                        {scanResult.allScored.slice(1, 6).map((c, i) => (
                          <div key={i} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] text-left">
                            <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/70">4/5 {(c.boundaryRate*100).toFixed(0)}%</span>
                            <span className={`font-mono font-bold ${c.survival >= 0.7 ? "text-green-400" : c.survival >= 0.6 ? "text-cyan-400" : "text-amber-400"}`}>{(c.survival * 100).toFixed(0)}%</span>
                            <button onClick={() => handleStart(c)} disabled={loading || !c.significant} className="text-[10px] font-bold text-sky-300 hover:text-sky-200 disabled:opacity-40">USE</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <p className="text-xs font-semibold text-amber-300">No Safe Dual-Lock Market Right Now</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                  </div>
                )}
                <Button onClick={handleScan} disabled={loading} variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-Scan
                </Button>
                <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Change settings
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
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} /> TWIN RAIL · DUAL-LEG
                      </span>
                    ) : <span className="text-[10px] text-muted-foreground">STOPPED</span>}
                  </div>
                  <div className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}
                  </div>
                  <div className="flex gap-3 mt-2 text-[11px]">
                    <span className="text-green-400">{session?.winCount ?? 0}W</span>
                    <span className="text-red-400">{session?.lossCount ?? 0}L</span>
                    <span className="text-muted-foreground">{winRate}% WR</span>
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} trades</span>
                  </div>
                </div>
                {session?.twinLock && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                      <Lock className="w-3 h-3" /> Frozen for this session
                    </p>
                    <p className="text-xs font-bold text-white">{session.twinLock.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Normal (dual)" value={session.twinLock.normal} tone={a.text} />
                      <Stat label="Recovery (dual)" value={session.twinLock.recovery} tone="text-amber-300" />
                    </div>
                  </div>
                )}
                {session?.message && (
                  <div className="text-xs px-3 py-2 rounded-lg border bg-secondary/30 border-border font-mono text-muted-foreground">{session.message}</div>
                )}
                <div className="flex gap-2">
                  {isRunning ? (
                    <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                      <StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop Session
                    </Button>
                  ) : (
                    <Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}>
                      <ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Scan Again
                    </Button>
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

export default TwinRailConsole;
