/**
 * Boundary Hedge Sentinel console.
 *
 * SIMPLIFIED from the old Twin-Lock that had too many gates and never traded.
 * The contract choice that every other console makes is GONE here — by design.
 * The pair is hard-wired (normal Over 4 + Under 5, recovery Over 5 + Under 4,
 * both legs on one tick, recovery armed only on a both-lost round). What the
 * scan earns the user is the only choice that matters: WHICH market, and
 * whether to LOCK it or let the engine SWITCH when the 4/5 rate rises.
 *
 * The running view is a hedge monitor: round-type tallies (both-win / split /
 * both-lost) and the recovery ledger. The gate is deliberately minimal — the
 * hedge IS the edge, and the only thing the gate checks is whether the market's
 * 4/5 frequency is below 30%.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Lock,
  ChevronLeft, X, ShieldCheck, Layers, Shuffle, Gauge,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type MarketMode = "locked" | "switching";

interface TwinCandidate {
  symbol: string;
  displayName: string;
  score: number;
  gapHazard: number;
  gapHazardWorst: number;
  safeRate: number;
  safeLcb: number;
  recoveryBreakEven: number;
  recoveryViable: boolean;
  crossingRate: number;
  payoutNormal: number;
  payoutRecovery: number;
  samples: number;
  reason: string;
  signals: string[];
  significant?: boolean;
}

interface ScanResult {
  suitable: boolean;
  best: TwinCandidate | null;
  allScored: TwinCandidate[];
  reason: string;
}

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

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function TwinHedgeConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [selectedSym, setSelectedSym] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 20,
  });
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
  });
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

  const isRunning = session?.running === true && session.botId === "twinhedge";

  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setSelectedSym(null);
    setStep(isRunning ? "running" : "config");
    fetch("/api/bots/twin/status")
      .then(r => (r.ok ? r.json() : null))
      .then(s => {
        if (s && s.running && s.botId === "twinhedge") { onSession(s); setStep("running"); }
      })
      .catch(() => { /* non-fatal */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyStatus = useCallback((d: BotSessionStatus) => {
    if (d?.botId && d.botId !== "twinhedge") return;
    onSession(d);
  }, [onSession]);

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
          if (p.botId !== "twinhedge") return;
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
  const Icon = BOT_ICON[bot.icon] ?? Layers;

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 20 });
    try {
      const res = await fetch("/api/bots/twin/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      setScanResult(data as ScanResult);
      setSelectedSym(null);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleDeploy = async (c: TwinCandidate, mode: MarketMode) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          marketMode: mode,
          ...config,
          analysis: c,
          ranked: scanResult?.allScored ?? [c],
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(`🔁 ${mode === "locked" ? "Locked" : "Switching"} on ${c.displayName} — both legs per tick`);
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twin/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Boundary Hedge session stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;

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
            aria-label="Boundary Hedge Sentinel console"
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
                    <Layers className="w-3 h-3" /> Hard-wired — nothing to choose here
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    <span className="text-white/80">Normal:</span> Over 4 + Under 5, both legs, same stake, same tick.
                    One leg always wins on any digit except 4 and 5.
                    A split round (one win + one loss) is ignored. Only a round where <span className="text-white/80">both legs lose</span>{" "}
                    arms <span className="text-white/80">recovery</span>: Over 5 + Under 4, sized against the TOTAL lost amount.
                    The scan ranks markets by their 4/5 frequency — lower is better.
                    Choose the market and LOCK it or let it SWITCH.
                  </p>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session Boundaries</p>
                  <NumInput label="Base stake (per leg)" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} step={1} accent={bot.accent} />
                  <p className="text-[9px] text-muted-foreground/60">
                    A both-lose round stakes 2 × base per round; recovery sizes each of its two legs from the
                    shared ledger formula (debt + markup over the pair's net profit rate).
                  </p>
                </div>

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan the boundary structure
                </Button>
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Measuring 4/5 exposure in every market</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `Analysing ${progress.scanning}…` : "Preparing…"}
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

            {/* SCAN RESULT */}
            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {(() => {
                  const c = scanResult.allScored.find(x => x.symbol === selectedSym) ?? scanResult.best;
                  if (!c) {
                    return (
                      <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                          <p className="text-xs font-semibold text-amber-300">No market scanned yet</p>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                      </div>
                    );
                  }
                  const isBest = c.symbol === scanResult.best?.symbol;
                  const borderline = isBest && !scanResult.suitable;
                  return (
                    <>
                      <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                        <div className="flex items-center justify-between">
                          <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                            {isBest ? "Best boundary market" : "Selected from scan"}
                          </p>
                          <span className={`text-[10px] font-mono ${c.recoveryViable ? "text-green-400" : "text-amber-300"}`}>
                            {c.recoveryViable ? "RECOVERY VIABLE" : "BELOW DIGEST LINE"}
                          </span>
                        </div>
                        <p className="text-sm font-bold text-white">{c.displayName}</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          <Stat label="Gap hazard (point)" value={pct(c.gapHazard)}
                                tone={c.gapHazard <= 0.23 ? "text-green-400" : "text-amber-300"} />
                          <Stat label="Gap hazard (worst)" value={pct(c.gapHazardWorst)}
                                tone={c.gapHazardWorst <= 0.23 ? "text-green-400" : "text-amber-300"} />
                          <Stat label="Safe rate q̂" value={pct(c.safeRate)} />
                          <Stat label="Recovery digest line" value={pct(c.recoveryBreakEven)} tone="text-cyan-300" />
                          <Stat label="Crossing rate" value={pct(c.crossingRate)} />
                          <Stat label="Score" value={String(c.score)} tone={c.score >= 50 ? "text-green-400" : "text-amber-300"} />
                        </div>
                        <p className="text-[9px] text-muted-foreground leading-relaxed">{c.reason}</p>
                        {c.signals.length > 0 && (
                          <div className="space-y-0.5">
                            {c.signals.map((s, i) => (
                              <p key={i} className={`text-[9px] ${s.startsWith("OK") ? "text-green-400/80" : s.startsWith("WARN") || s.startsWith("INFO") ? "text-amber-300/80" : "text-muted-foreground/60"}`}>
                                {s}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {!c.recoveryViable && (
                        <p className="text-[10px] text-amber-200/90 leading-relaxed px-1 flex items-start gap-1.5">
                          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <span>
                            Below the digest line: recovery rounds work harder here, but the normal
                            pair (Over 4 + Under 5) is self-hedged and trades freely on any measured market.
                            Select another market below if you want better recovery viability.
                          </span>
                        </p>
                      )}
                      {borderline && (
                        <p className="text-[10px] text-muted-foreground leading-relaxed px-1">
                          This market did not clear the scan's suitability bar (4/5 &gt; 30%).
                          Deploying it is a deliberate choice — the switch button lets it move on when the rate cools.
                        </p>
                      )}
                      <div className="space-y-2">
                        <Button onClick={() => handleDeploy(c, "locked")} disabled={loading}
                                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                          <Lock className="w-4 h-4 mr-2" />
                          {borderline ? `Lock ${c.displayName} anyway` : `Trade Locked on ${c.displayName}`}
                        </Button>
                        <Button onClick={() => handleDeploy(c, "switching")} disabled={loading}
                                variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                          <Shuffle className="w-3.5 h-3.5 mr-2" />
                          {borderline ? "Start with Smart Market Switching" : "Trade with Smart Market Switching"}
                        </Button>
                      </div>
                    </>
                  );
                })()}

                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Scanned universe — select to deploy</p>
                    {scanResult.allScored.slice(0, 8).map(c => {
                      const isSel = c.symbol === (scanResult.allScored.find(x => x.symbol === selectedSym)?.symbol ?? scanResult.best?.symbol);
                      return (
                        <button key={c.symbol} onClick={() => setSelectedSym(c.symbol)}
                                title={c.reason}
                                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors ${
                                  isSel ? `${a.panelBorder} ${a.panelBg} ring-1 ring-inset` : "border border-transparent bg-white/[0.03] hover:bg-white/[0.07]"
                                }`}>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            c.recoveryViable ? "bg-green-400" : "bg-amber-400"
                          }`} />
                          <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                          <span className="font-mono text-[10px] text-muted-foreground/70">
                            4/5 {pct(c.gapHazard)}
                          </span>
                          <span className={`font-mono font-bold ${c.score >= 50 ? "text-green-400" : "text-amber-400"}`}>
                            {c.score}
                          </span>
                        </button>
                      );
                    })}
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

            {/* RUNNING — the hedge monitor */}
            {step === "running" && (
              <div className="p-4 space-y-3">
                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&L</span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                        {session?.marketMode === "switching" ? "SWITCHING" : "LOCKED"} · BOTH LEGS
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
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} rounds</span>
                  </div>
                  {/* Round-type anatomy — the three outcomes of the hedge. */}
                  <div className="grid grid-cols-3 gap-1.5 mt-2">
                    <Stat label="Both win" value={String(session?.bothWinCount ?? 0)} tone="text-green-400" />
                    <Stat label="Split (ignored)" value={String(session?.splitCount ?? 0)} tone="text-cyan-300" />
                    <Stat label="Both lost → R" value={String(session?.bothLoseCount ?? 0)} tone="text-red-400" />
                  </div>
                </div>

                {/* Live gate read */}
                {isRunning && session?.gate && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                    <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                      <Gauge className="w-3 h-3" /> Boundary gate
                    </p>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 bg-black/40 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${session.gate.hazard > 0.30 ? "bg-red-400" : "bg-green-400"}`}
                          style={{ width: `${Math.min(100, session.gate.hazard * 100 * 2.5)}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-white/80">{pct(session.gate.hazard)}</span>
                    </div>
                    <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">{session.gate.reason}</p>
                  </div>
                )}

                {session?.lock && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                      <Layers className="w-3 h-3" /> Hard-wired for this session
                    </p>
                    <p className="text-xs font-bold text-white">{session.lock.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Normal" value={session.lock.normalPair ?? "Over 4 + Under 5"} tone={a.text} />
                      <Stat label="Recovery" value={session.lock.recoveryPair ?? "Over 5 + Under 4"} tone="text-amber-300" />
                      <Stat label="Gap hazard" value={session.lock.gapHazard ? pct(session.lock.gapHazard) : "—"} tone="text-cyan-300" />
                      <Stat label="Safe rate" value={session.lock.safeRate ? pct(session.lock.safeRate) : "—"} tone="text-green-300" />
                      <Stat label="Digest line q*" value={session.lock.recoveryBreakEven ? pct(session.lock.recoveryBreakEven) : "—"} tone="text-cyan-300" />
                      <Stat label="Crossing rate" value={session.lock.crossingRate ? pct(session.lock.crossingRate) : "—"} />
                    </div>
                  </div>
                )}

                {/* Last round, per leg */}
                {session?.lastRound && (
                  <div className="bg-white/[0.03] rounded-lg px-3 py-2 border border-white/5">
                    <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60 mb-1">
                      Last round · {session.lastRound.mode} · {session.lastRound.market}
                      {session.lastRound.forced && <span className="text-amber-400"> · FORCED</span>}
                    </p>
                    <div className="flex items-center gap-2">
                      {session.lastRound.legs.map(l => (
                        <span key={l.contract}
                              className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${l.won ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"}`}>
                          {l.contract} {l.won ? "+" : ""}{l.profit.toFixed(2)}
                        </span>
                      ))}
                      <span className={`ml-auto text-[11px] font-mono font-bold ${session.lastRound.net >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {session.lastRound.net >= 0 ? "+" : "-"}${Math.abs(session.lastRound.net).toFixed(2)}
                      </span>
                    </div>
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") || session.message.startsWith("⛔") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                    session.message.startsWith("🔀") ? "bg-cyan-500/10 border-cyan-500/20 text-cyan-300" :
                    "bg-secondary/30 border-border text-muted-foreground"
                  }`}>
                    {session.message}
                  </div>
                )}

                {session?.inRecovery && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                        Recovery (Step {session.recoveryStep}) — both legs, one tick
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      A both-lost normal round armed this: Over 5 + Under 4 sized to digest the TOTAL loss.
                      Exits as soon as the debt clears — split rounds here also pay it down.
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
                        New Setup
                      </Button>
                      <Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}>
                        <ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-Scan
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

export default TwinHedgeConsole;