/**
 * Over/Under Turbo console.
 *
 * A turbo bot gets a turbo console: ONE deep scan proposes the single best
 * (market, normal barrier, recovery barrier) triple; the user deploys it with
 * one of two buttons — LOCKED (never move) or SWITCHING (leave only an
 * unfavorable market) — and from then on the view is a live monitor of a
 * non-stop session: arming → trading, trade after trade, to TP or SL. There is
 * nothing to tune mid-session BY DESIGN (zero mid-session scanning), so the
 * running view mirrors the engine: frozen lock, live cadence, market health
 * and — in switching mode — the switch board.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Lock,
  ChevronLeft, X, ShieldCheck, Zap, ArrowRightLeft, Crosshair, Workflow,
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
  normal: Contract;
  recovery: Contract;
  score: number;
  survival: number;
  ruin: number;
  meanPnl: number;
  normalLcb: number;
  normalMean: number;
  normalBreakEven: number;
  recoveryConditional: number;
  recoveryLcb: number;
  recoveryBreakEven: number;
  clusterRatio: number;
  pTwoInARow: number;
  expectedMaxLossRun: number;
  stationarityZ: number;
  significant: boolean;
  pValue: number;
  samples: number;
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
  sessionParams?: { stake: number; takeProfit: number; stopLoss: number; maxRecoverySteps: number };
}

function label(c: Contract) {
  return `${c.side === "DIGITOVER" ? "Over" : "Under"} ${c.barrier}`;
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

export function OverUnderTurboConsole({
  bot, open, onOpenChange, session, onSession,
}: {
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
    scanning: null, scanned: 0, total: 20,
  });
  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
  });
  const { data: settings } = useGetSettings();

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setConfig(prev => ({
      ...prev,
      stake: s.riskAmountValue ?? prev.stake,
      maxRecoverySteps: s.maxRecoverySteps ?? prev.maxRecoverySteps,
    }));
  }, [settings]);

  const isRunning = session?.running === true && session.botId === "overunder-turbo";

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
          if (p.botId !== "overunder-turbo") return;
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
  const Icon = BOT_ICON[bot.icon] ?? Zap;

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 20 });
    try {
      const res = await fetch("/api/bots/overunder-turbo/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      const result = data as ScanResult;
      if (result.sessionParams) {
        setConfig(prev => ({
          ...prev,
          stake: result.sessionParams!.stake || prev.stake,
          takeProfit: result.sessionParams!.takeProfit || prev.takeProfit,
          stopLoss: result.sessionParams!.stopLoss || prev.stopLoss,
          maxRecoverySteps: result.sessionParams!.maxRecoverySteps || prev.maxRecoverySteps,
        }));
      }
      setScanResult(result);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleStart = async (c: Candidate, mode: "locked" | "switching") => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/overunder-turbo/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          normal: c.normal,
          recovery: c.recovery,
          marketMode: mode,
          analysis: c,
          ...config,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(
        mode === "locked"
          ? `⚡ Locked on ${c.displayName} — ${label(c.normal)} → ${label(c.recovery)}; arming for the non-stop run`
          : `⚡ Deployed on ${c.displayName} — ${label(c.normal)} → ${label(c.recovery)}; switching armed`,
      );
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  /**
   * CREATE DBOT — same scanned triple and session numbers as Locked, but instead
   * of starting NeuroTrade's executor the API renders a stock Deriv-Bot strategy
   * (market, Over/Under barriers, stake, TP/SL, the shared recovery ladder) and
   * we hand it to the embedded Deriv bot builder. The user verifies the blocks
   * and presses Deriv's own Run — Deriv Bot executes, not Turbo.
   */
  const handleCreateDbot = async (c: Candidate) => {
    setBuildingDbot(true);
    try {
      const res = await fetch("/api/bots/overunder-turbo/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          normal: c.normal,
          recovery: c.recovery,
          analysis: c,
          ...config,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.xml) {
        toast.error(data?.error ?? "Could not build the DBot strategy");
        return;
      }
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol: c.symbol });
      toast.info(
        `Building your DBot for ${c.displayName} — ${label(c.normal)} → ${label(c.recovery)}…`,
      );
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        toast.success(
          `DBot ready: ${c.displayName} · ${label(c.normal)} normal → ${label(c.recovery)} recovery · ` +
            `stake $${config.stake} · TP $${config.takeProfit} · SL $${config.stopLoss}. Verify the blocks, then press Run.`,
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
      const res = await fetch("/api/bots/overunder-turbo/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Turbo session stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;
  const watch = session?.turboWatch;
  const lock = session?.turboLock;
  const arming = watch?.phase === "arming";
  const armProgress = watch && watch.breakEven > 0
    ? Math.min(100, Math.round((watch.recentRate / watch.breakEven) * 100))
    : 0;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label="Over/Under Turbo console"
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            {/* Header */}
            <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-fuchsia-500/20 text-fuchsia-300">SCANNER</span>
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

            {/* CONFIG */}
            {step === "config" && (
              <div className="p-4 space-y-4">
                <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                  <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                    <Zap className="w-3 h-3" /> How this bot works
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    One scan tests every market against{" "}
                    <span className="text-white/80">Over 1 · Over 2 · Under 7 · Under 8</span> normal,{" "}
                    <span className="text-white/80">Over 4 · Over 5 · Under 4 · Under 5</span> recovery,
                    and returns the single best market + barriers. Deploy it, it arms on the best entry,
                    then trades <span className="text-white/80">non-stop</span> — no re-scanning, no
                    gating — until TP or SL.
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session Boundaries</p>
                  <NumInput label="Base stake" value={config.stake} onChange={v => setConfig(c => ({ ...c, stake: v }))} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => setConfig(c => ({ ...c, takeProfit: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => setConfig(c => ({ ...c, stopLoss: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => setConfig(c => ({ ...c, maxRecoverySteps: v }))} min={1} step={1} accent={bot.accent} />
                  <p className="text-[9px] text-muted-foreground/60">
                    The scan simulates these exact numbers, so the survival figure applies to this session.
                  </p>
                </div>

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan for the Best Turbo Lock
                </Button>
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Hunting the best market &amp; barrier combination</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `Analysing ${progress.scanning}…` : "Preparing…"}
                  </p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full ${a.solidBtn} transition-all`}
                       style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">
                  {progress.scanned}/{progress.total} markets · 16 barrier combinations each
                </p>
              </div>
            )}

            {/* SCAN RESULT */}
            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>Best Turbo Lock</p>
                        <span className="text-[10px] font-mono text-green-400">
                          {(scanResult.best.survival * 100).toFixed(0)}% survival
                        </span>
                      </div>
                      <p className="text-sm font-bold text-white">{scanResult.best.displayName}</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="Normal" value={label(scanResult.best.normal)} tone={a.text} />
                        <Stat label="Recovery" value={label(scanResult.best.recovery)} tone="text-amber-300" />
                        <Stat label="Risk of hitting SL"
                              value={`${(scanResult.best.ruin * 100).toFixed(0)}%`}
                              tone={scanResult.best.ruin < 0.3 ? "text-green-400" : "text-red-400"} />
                        <Stat label="Loss clustering"
                              value={scanResult.best.clusterRatio <= 1 ? "Low" : "Moderate"}
                              tone={scanResult.best.clusterRatio <= 1 ? "text-green-400" : "text-amber-300"} />
                        <Stat label="Worst-case normal"
                              value={`${(scanResult.best.normalLcb * 100).toFixed(1)}% vs ${(scanResult.best.normalBreakEven * 100).toFixed(0)}% BE`}
                              tone={scanResult.best.normalLcb > scanResult.best.normalBreakEven ? "text-green-400" : "text-amber-300"} />
                        <Stat label="Recovery (conditional)"
                              value={`${(scanResult.best.recoveryConditional * 100).toFixed(1)}% vs ${(scanResult.best.recoveryBreakEven * 100).toFixed(0)}% BE`}
                              tone="text-amber-300" />
                      </div>
                      <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
                        {scanResult.reason}
                      </p>
                    </div>

                    {/* The two deploy buttons — LOCKED or SWITCHING */}
                    <div className="grid grid-cols-2 gap-2">
                      <Button onClick={() => handleStart(scanResult.best!, "locked")} disabled={loading}
                              className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" />
                        Locked
                      </Button>
                      <Button onClick={() => handleStart(scanResult.best!, "switching")} disabled={loading}
                              variant="outline" className={`w-full h-10 ${a.outlineBtn} text-xs font-bold`}>
                        <ArrowRightLeft className="w-4 h-4 mr-2" />
                        Switching
                      </Button>
                      <p className="col-span-2 text-[9px] text-muted-foreground/60 leading-relaxed">
                        Locked never changes market. Switching keeps these exact barriers and moves
                        ONLY when this market stops being favorable — trading never pauses for a
                        healthy tape.
                      </p>

                      {/* CREATE DBOT — hand this exact lock to the Deriv bot builder */}
                      <Button onClick={() => handleCreateDbot(scanResult.best!)} disabled={loading || buildingDbot}
                              data-testid="turbo-create-dbot"
                              className="col-span-2 w-full h-10 bg-gradient-to-r from-fuchsia-600 to-violet-600 hover:from-fuchsia-500 hover:to-violet-500 text-white font-bold text-xs">
                        {buildingDbot
                          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          : <Workflow className="w-4 h-4 mr-2" />}
                        {buildingDbot ? "Building DBot…" : "Create DBot"}
                      </Button>
                      <p className="col-span-2 text-[9px] text-muted-foreground/60 leading-relaxed">
                        Builds a Deriv Bot for <span className="text-white/80">{scanResult.best.displayName}</span> —{" "}
                        {label(scanResult.best.normal)} normal → {label(scanResult.best.recovery)} recovery, your stake,
                        TP/SL and the same recovery ladder — and opens it in the Bot Builder. You verify the blocks and
                        press Run; Deriv Bot then executes the trades instead of Turbo.
                      </p>
                    </div>

                    {scanResult.allScored.length > 1 && (
                      <div className="space-y-1 pt-1 border-t border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Runner-up markets</p>
                        {scanResult.allScored.slice(1, 6).map((c, i) => (
                          <div key={i} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] text-left">
                            <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/70">
                              {label(c.normal)}→{label(c.recovery)}
                            </span>
                            <span className={`font-mono font-bold ${c.survival >= 0.7 ? "text-green-400" : c.survival >= 0.6 ? "text-cyan-400" : "text-amber-400"}`}>
                              {(c.survival * 100).toFixed(0)}%
                            </span>
                            <button onClick={() => handleStart(c, "locked")} disabled={loading}
                                    className="text-[10px] font-bold text-sky-300 hover:text-sky-200 disabled:opacity-40"
                                    title="Deploy this triple locked">
                              USE
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <p className="text-xs font-semibold text-amber-300">No Deployable Lock Right Now</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {scanResult.reason ?? "Every market is currently rejected by the survival screen. The bot waits and re-scans — it never deploys into a bad tape."}
                    </p>
                  </div>
                )}

                <Button onClick={handleScan} disabled={loading} variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-Scan
                </Button>
                <button onClick={() => setStep("config")}
                        className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Change settings
                </button>
              </div>
            )}

            {/* RUNNING */}
            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                    {isRunning ? (
                      arming ? (
                        <span className="flex items-center gap-1 text-[10px] text-amber-300">
                          <Crosshair className="w-3 h-3 animate-pulse" /> ARMING — WAITING FOR THE ENTRY
                        </span>
                      ) : (
                        <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} /> TURBO · NON-STOP
                        </span>
                      )
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
                  {isRunning && arming && watch && (
                    <div className="mt-2 space-y-1">
                      <div className="h-1.5 bg-black/30 rounded-full overflow-hidden">
                        <div className={`h-full ${a.solidBtn} transition-all`} style={{ width: `${armProgress}%` }} />
                      </div>
                      <p className="text-[9px] font-mono text-muted-foreground/70">
                        {lock?.normal ?? watch.contract}: {(watch.recentRate * 100).toFixed(0)}% recent vs {(watch.breakEven * 100).toFixed(0)}% break-even
                      </p>
                    </div>
                  )}
                </div>

                {lock && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                        <Lock className="w-3 h-3" /> Frozen for this session
                      </p>
                      <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${lock.marketMode === "locked" ? `${a.badgeBg} ${a.text}` : "bg-violet-500/20 text-violet-300"}`}>
                        {lock.marketMode === "locked" ? "LOCKED MARKET" : "SWITCHING ARMED"}
                      </span>
                    </div>
                    <p className="text-xs font-bold text-white">{lock.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Normal" value={lock.normal} tone={a.text} />
                      <Stat label="Recovery" value={lock.recovery} tone="text-amber-300" />
                      <Stat label="Pre-deploy survival" value={`${(lock.survival * 100).toFixed(0)}%`} />
                      <Stat label="Deepest loss run" value={String(session?.deepestLossRun ?? 0)} />
                    </div>
                    {lock.marketMode === "locked" && (
                      <p className="text-[9px] text-muted-foreground/60">
                        Circuit breaker at {Math.max(3, Math.round(lock.recoveryDepthP95)) + 2} consecutive losses (beyond the modelled ladder).
                      </p>
                    )}
                  </div>
                )}

                {isRunning && watch && !watch.marketFavorable && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-violet-500/[0.08] border-violet-500/30 space-y-1">
                    <p className="font-semibold text-violet-300 flex items-center gap-1.5">
                      <ArrowRightLeft className="w-3.5 h-3.5 text-violet-400" /> Market unfavorable
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {watch.healthReason} — the bot is looking for a better tape and will move
                      without stopping the run (barriers stay {lock?.normal ?? ""} → {lock?.recovery ?? ""}).
                    </p>
                  </div>
                )}

                {isRunning && watch && watch.switchBoard && watch.switchBoard.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1">
                      <ArrowRightLeft className="w-3 h-3" /> Switch board · {watch.switches} switch{watch.switches === 1 ? "" : "es"} this session
                    </p>
                    {watch.switchBoard.slice(0, 4).map((s, i) => (
                      <div key={i} className="flex items-center gap-2 px-2.5 py-1 rounded-lg text-[11px] bg-white/[0.03]">
                        <span className="flex-1 truncate text-white/70">{s.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/60">score {s.score}</span>
                        <span className={`font-mono font-bold ${s.survival >= 0.7 ? "text-green-400" : "text-cyan-400"}`}>
                          {(s.survival * 100).toFixed(0)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                    session.message.startsWith("⚡") ? "bg-sky-500/10 border-sky-500/25 text-sky-300" :
                    "bg-secondary/30 border-border text-muted-foreground"
                  }`}>
                    {session.message}
                  </div>
                )}

                {isRunning && session?.currentMarket && !arming && (
                  <div className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-3 py-2 border border-white/5">
                    <Loader2 className={`w-3 h-3 ${a.text} animate-spin flex-shrink-0`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground">Firing continuously</p>
                      <p className="text-xs font-semibold text-white truncate">{session.currentMarket}</p>
                      <p className={`text-[10px] font-mono ${a.text}`}>
                        {session.currentContractType} · ${(session.currentStake ?? 0).toFixed(2)}
                      </p>
                    </div>
                    {session.lastResult && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                        session.lastResult === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                      }`}>{session.lastResult.toUpperCase()}</span>
                    )}
                  </div>
                )}

                {session?.inRecovery && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                        Recovery (Step {session.recoveryStep})
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Firing the locked {lock?.recovery ?? "recovery"} contract back-to-back. Exits as soon as the debt is cleared — no pausing, no re-analysis.
                    </p>
                  </div>
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

export default OverUnderTurboConsole;
