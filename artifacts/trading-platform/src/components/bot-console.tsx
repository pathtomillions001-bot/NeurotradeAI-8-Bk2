/**
 * Specialist Bot Deploy Console.
 *
 * The full control surface for one specialist bot: contract side, digit lock,
 * risk parameters, recovery policy, market mode, neural scan and the live
 * session monitor with the bot's own specialist telemetry.
 *
 * Mirrors the NeuroAI Quantum FAB's interaction model (config → scan → locked or
 * switching) but exposes the two things only a specialist has: the side/digit
 * sovereignty controls and the live specialist read.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, CheckCircle2, AlertTriangle, RefreshCw,
  Lock, Shuffle, ShieldCheck, Hash, Scale, Crosshair, TrendingUp,
  Sparkles, Activity, Target, ChevronLeft,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { useGetSettings } from "@workspace/api-client-react";
import { OVER_PAYOUTS, UNDER_PAYOUTS } from "@/lib/payouts";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS, SCAN_MARKET_COUNT } from "@/lib/bots";

type Step = "config" | "scanning" | "scan-result" | "running";
type MarketMode = "locked" | "switching";
type SideMode = "both" | "primary" | "secondary";

interface BotConfigState {
  sideMode: SideMode;
  overBarrier: number;
  underBarrier: number;
  lockedBarrier: number | null;
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryAutoMode: boolean;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  marketMode: MarketMode;
  lockedSymbol: string;
}

interface ScanMarketScore {
  symbol: string;
  displayName: string;
  contractType: string;
  barrier?: number;
  score: number;
  winProbability: number;
  expectedValue?: number;
  entropyBits?: number;
  reason: string;
  specialist?: {
    family: string;
    bonus: number;
    confidence: number;
    favoured?: string;
    metrics: Record<string, number>;
    signals: string[];
  };
}

interface ScanResult {
  suitable: boolean;
  best: ScanMarketScore | null;
  allScored: ScanMarketScore[];
  reason: string;
}

interface ScanProgress {
  scanning: string | null;
  symbol: string | null;
  scanned: number;
  total: number;
  results: Array<{ symbol: string; score: number; entropyBits?: number }>;
}

// ── Small building blocks ─────────────────────────────────────────────────────

function NumInput({ label, value, onChange, min, max, step = 1, suffix, accent }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string; accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(Number(e.target.value))}
          className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>}
      </div>
    </div>
  );
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{children}</p>
      {right && <span className="text-[9px] font-mono text-muted-foreground/70">{right}</span>}
    </div>
  );
}

function scoreColor(score: number) {
  if (score >= 60) return "text-green-400";
  if (score >= 54) return "text-cyan-400";
  if (score >= 48) return "text-amber-400";
  return "text-red-400";
}

function SpecialistPanel({ specialist, accent }: { specialist: ScanMarketScore["specialist"]; accent: AccentKey }) {
  if (!specialist) return null;
  const a = ACCENTS[accent];
  const entries = Object.entries(specialist.metrics).filter(([, v]) => typeof v === "number");
  return (
    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className={`w-3.5 h-3.5 ${a.text}`} />
          <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>Specialist Layer</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono ${specialist.bonus >= 0 ? "text-green-400" : "text-red-400"}`}>
            {specialist.bonus >= 0 ? "+" : ""}{specialist.bonus.toFixed(1)}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground/60">{specialist.confidence}% conf</span>
        </div>
      </div>

      <div className="space-y-1">
        {specialist.signals.map((s, i) => (
          <p key={i} className="text-[10px] font-mono text-muted-foreground leading-relaxed">· {s}</p>
        ))}
      </div>

      {entries.length > 0 && (
        <div className="grid grid-cols-4 gap-1 pt-1">
          {entries.slice(0, 8).map(([key, value]) => (
            <div key={key} className="bg-black/25 rounded px-1.5 py-1 text-center">
              <p className="text-[8px] text-muted-foreground/60 uppercase truncate">{key}</p>
              <p className="text-[10px] font-mono text-white/90">
                {Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Console ───────────────────────────────────────────────────────────────────

export function BotConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress>({
    scanning: null, symbol: null, scanned: 0, total: SCAN_MARKET_COUNT, results: [],
  });
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState<BotConfigState>({
    sideMode: "both",
    overBarrier: 1,
    underBarrier: 8,
    lockedBarrier: null,
    stake: 1,
    stopLoss: 5,
    takeProfit: 10,
    recoveryAutoMode: true,
    recoveryMultiplier: 1.62,
    recoveryMethod: "split",
    maxRecoverySteps: 3,
    marketMode: "switching",
    lockedSymbol: "1HZ100V",
  });

  const set = <K extends keyof BotConfigState>(k: K, v: BotConfigState[K]) =>
    setConfig(prev => ({ ...prev, [k]: v }));

  // Prefill from the account's saved risk/recovery settings, exactly like the FAB.
  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (!settings || settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;
    const s = settings as any;
    setConfig(prev => ({
      ...prev,
      overBarrier:        s.normalOverDigit    ?? prev.overBarrier,
      underBarrier:       s.normalUnderDigit   ?? prev.underBarrier,
      recoveryAutoMode:   s.recoveryAutoMode   ?? prev.recoveryAutoMode,
      recoveryMultiplier: s.recoveryMultiplier ?? prev.recoveryMultiplier,
      recoveryMethod:     (s.recoveryMethod    ?? prev.recoveryMethod) as "split" | "instant",
      maxRecoverySteps:   s.maxRecoverySteps   ?? prev.maxRecoverySteps,
      stake:              s.riskAmountValue    ?? prev.stake,
    }));
  }, [settings]);

  // Reflect an externally-started session (e.g. started from the card).
  useEffect(() => {
    if (session?.running && session.botId === bot?.id) setStep("running");
  }, [session, bot?.id]);

  // Reset when a different bot is opened.
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setScanProgress({ scanning: null, symbol: null, scanned: 0, total: SCAN_MARKET_COUNT, results: [] });
    setStep(session?.running && session.botId === bot?.id ? "running" : "config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.id, open]);

  const applyStatus = useCallback((data: BotSessionStatus) => {
    onSession(data);
  }, [onSession]);

  // ── SSE: live session + scan progress ───────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let es: EventSource;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    function connect() {
      if (destroyed) return;
      es = new EventSource("/api/ai/events");

      es.addEventListener("bot_update", (e: MessageEvent) => {
        try { applyStatus(JSON.parse(e.data) as BotSessionStatus); } catch { /* ignore */ }
      });

      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data) as ScanProgress & { botId?: string };
          if (p.botId && bot && p.botId !== bot.id) return;
          setScanProgress({
            scanning: p.scanning, symbol: p.symbol,
            scanned: p.scanned, total: p.total, results: p.results ?? [],
          });
        } catch { /* ignore */ }
      });

      es.onerror = () => {
        es.close();
        if (!destroyed) reconnectTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [open, bot, applyStatus]);

  if (!bot) return null;
  const accent = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Sparkles;
  const isThisBotRunning = session?.running === true && session.botId === bot.id;
  const anyEngineBusy = (session?.running === true && session.botId !== bot.id);

  // ── Request body ────────────────────────────────────────────────────────────
  function buildBody(forcedSymbol?: string, forcedMode?: MarketMode) {
    const effectiveMode = forcedMode ?? config.marketMode;
    const effectiveSymbol = forcedSymbol ?? (effectiveMode === "locked" ? config.lockedSymbol : undefined);
    return {
      sideMode:           config.sideMode,
      overBarrier:        config.overBarrier,
      underBarrier:       config.underBarrier,
      lockedBarrier:      config.lockedBarrier,
      stake:              config.stake,
      stopLoss:           config.stopLoss,
      takeProfit:         config.takeProfit,
      recoveryAutoMode:   config.recoveryAutoMode,
      recoveryMultiplier: config.recoveryMultiplier,
      recoveryMethod:     config.recoveryMethod,
      maxRecoverySteps:   config.maxRecoverySteps,
      marketMode:         effectiveMode,
      ...(effectiveMode === "locked" ? { lockedSymbol: effectiveSymbol } : {}),
    };
  }

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setScanProgress({ scanning: null, symbol: null, scanned: 0, total: SCAN_MARKET_COUNT, results: [] });
    try {
      const res = await fetch(`/api/bots/${bot.id}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error((data as any).error ?? "Scan failed");
        setStep("config");
        return;
      }
      setScanResult(data as ScanResult);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async (symbolToLock?: string, mode?: MarketMode) => {
    setLoading(true);
    try {
      const payload = buildBody(symbolToLock, mode);
      const res = await fetch(`/api/bots/${bot.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Failed to start ${bot.name}`);
        return;
      }
      onSession(data.status);
      setStep("running");
      toast.success(
        payload.marketMode === "locked"
          ? `⚡ ${bot.name} live — locked on ${payload.lockedSymbol ?? "selected asset"}`
          : `⚡ ${bot.name} live — smart market switching active`,
      );
    } catch {
      toast.error(`Could not start ${bot.name}`);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/bots/${bot.id}/stop`, { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success(`${bot.name} stopped`);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  };

  const armedSide = bot.sides.find(s => s.id === config.sideMode) ?? bot.sides[0]!;
  const armsOver = armedSide.contracts.includes("DIGITOVER");
  const armsUnder = armedSide.contracts.includes("DIGITUNDER");

  const profit = session?.totalProfit ?? 0;
  const profitColor = profit >= 0 ? "text-green-400" : "text-red-400";
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-0 bg-[#080d17] border-l border-white/10 flex flex-col gap-0 overflow-hidden"
      >
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <SheetHeader className={`p-4 border-b border-white/5 bg-gradient-to-r ${accent.headerGrad} text-left space-y-0`}>
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-xl ${accent.iconBg} ${accent.iconBorder} flex items-center justify-center flex-shrink-0`}>
              <Icon className={`w-4.5 h-4.5 ${accent.text}`} />
            </div>
            <div className="min-w-0">
              <SheetTitle className="text-sm font-bold text-white flex items-center gap-2">
                {bot.name}
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${accent.badgeBg} ${accent.text} font-normal`}>
                  {bot.code}
                </span>
              </SheetTitle>
              <SheetDescription className="text-[11px] text-muted-foreground mt-0.5">
                {bot.contractLabel} specialist · {bot.tagline}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {/* ── STEP: CONFIG ─────────────────────────────────────────────── */}
          {step === "config" && (
            <div className="p-4 space-y-4">

              {/* Contract sovereignty */}
              <div className="space-y-2">
                <SectionLabel right="Strict Contract Lock">Contract Sovereignty</SectionLabel>
                <div className={`grid ${bot.sides.length > 1 ? "grid-cols-3" : "grid-cols-1"} gap-1.5`}>
                  {bot.sides.map(side => {
                    const active = config.sideMode === side.id;
                    return (
                      <button
                        key={side.id}
                        onClick={() => set("sideMode", side.id)}
                        className={`px-2 py-2 rounded-lg text-left text-xs border transition-all ${
                          active
                            ? `${accent.activeBg} ${accent.activeBorder} ${accent.text} shadow-sm`
                            : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
                        }`}
                      >
                        <span className="font-medium block truncate">{side.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[9px] text-muted-foreground/60">{armedSide.desc}.</p>
              </div>

              {/* Over / Under barriers */}
              {(armsOver || armsUnder) && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-muted-foreground/60">Barrier digit{armsOver && armsUnder ? "s" : ""}</p>
                  <div className={`grid ${armsOver && armsUnder ? "grid-cols-2" : "grid-cols-1"} gap-2`}>
                    {armsOver && (
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-1">OVER digit</p>
                        <Select value={String(config.overBarrier)} onValueChange={v => set("overBarrier", Number(v))}>
                          <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(b => (
                              <SelectItem key={b} value={String(b)}>
                                OVER {b} · {(100 * (9 - b) / 10).toFixed(0)}% · {OVER_PAYOUTS[b]?.toFixed(2)}×
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {armsUnder && (
                      <div>
                        <p className="text-[10px] text-muted-foreground mb-1">UNDER digit</p>
                        <Select value={String(config.underBarrier)} onValueChange={v => set("underBarrier", Number(v))}>
                          <SelectTrigger className="h-7 text-xs bg-black/30 border-white/10">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(b => (
                              <SelectItem key={b} value={String(b)}>
                                UNDER {b} · {(100 * b / 10).toFixed(0)}% · {UNDER_PAYOUTS[b]?.toFixed(2)}×
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Digit lock (match / differ) */}
              {bot.hasDigitLock && (
                <div className="space-y-2">
                  <SectionLabel right="Auto = AI-selected">Traded Digit</SectionLabel>
                  <div className="grid grid-cols-6 gap-1">
                    <button
                      onClick={() => set("lockedBarrier", null)}
                      className={`col-span-2 py-1.5 rounded-lg text-[10px] font-medium border transition-all ${
                        config.lockedBarrier === null
                          ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}`
                          : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
                      }`}
                    >
                      Auto
                    </button>
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => (
                      <button
                        key={d}
                        onClick={() => set("lockedBarrier", d)}
                        className={`py-1.5 rounded-lg text-[11px] font-mono border transition-all ${
                          config.lockedBarrier === d
                            ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}`
                            : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                  {bot.digitLockHelp && (
                    <p className="text-[9px] text-muted-foreground/60">{bot.digitLockHelp}</p>
                  )}
                </div>
              )}

              {/* Market mode */}
              <div className="space-y-2 pt-1 border-t border-white/5">
                <SectionLabel right="Asset Selection">Market Mode</SectionLabel>
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => set("marketMode", "switching")}
                    className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs border font-medium transition-all ${
                      config.marketMode === "switching"
                        ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}`
                        : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
                    }`}
                  >
                    <Shuffle className="w-3.5 h-3.5" /> Smart Switching
                  </button>
                  <button
                    onClick={() => set("marketMode", "locked")}
                    className={`flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs border font-medium transition-all ${
                      config.marketMode === "locked"
                        ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}`
                        : "bg-white/5 border-white/10 text-muted-foreground hover:border-white/20"
                    }`}
                  >
                    <Lock className="w-3.5 h-3.5" /> Lock Market
                  </button>
                </div>
                {config.marketMode === "locked" && (
                  <Select value={config.lockedSymbol} onValueChange={v => set("lockedSymbol", v)}>
                    <SelectTrigger className="h-8 text-xs bg-black/30 border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCAN_MARKETS.map(m => (
                        <SelectItem key={m.symbol} value={m.symbol}>{m.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Risk parameters */}
              <div className="space-y-2 pt-1 border-t border-white/5">
                <SectionLabel right="Session Boundaries">Risk Parameters</SectionLabel>
                <div className="space-y-1.5">
                  <NumInput label="Base stake" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                </div>
              </div>

              {/* Recovery engine */}
              <div className="space-y-2 pt-1 border-t border-white/5">
                <SectionLabel right={`Recovery stays in ${bot.contractLabel}`}>Recovery Engine</SectionLabel>

                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => set("recoveryAutoMode", true)}
                    className={`py-1.5 px-2 rounded-lg text-xs border font-medium transition-all ${
                      config.recoveryAutoMode ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}` : "bg-white/5 border-white/10 text-muted-foreground"
                    }`}
                  >
                    AI Exact Auto
                  </button>
                  <button
                    onClick={() => set("recoveryAutoMode", false)}
                    className={`py-1.5 px-2 rounded-lg text-xs border font-medium transition-all ${
                      !config.recoveryAutoMode ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}` : "bg-white/5 border-white/10 text-muted-foreground"
                    }`}
                  >
                    Manual Multiplier
                  </button>
                </div>

                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">Recovery mode</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => set("recoveryMethod", "split")}
                        className={`px-2 py-1 rounded text-xs border ${config.recoveryMethod === "split" ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}` : "bg-white/5 border-white/10 text-muted-foreground"}`}
                      >
                        Split (Safe)
                      </button>
                      <button
                        onClick={() => set("recoveryMethod", "instant")}
                        className={`px-2 py-1 rounded text-xs border ${config.recoveryMethod === "instant" ? `${accent.activeBg} ${accent.activeBorder} ${accent.text}` : "bg-white/5 border-white/10 text-muted-foreground"}`}
                      >
                        Instant (1-Win)
                      </button>
                    </div>
                  </div>

                  {!config.recoveryAutoMode && (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground flex-1">Multiplier</span>
                      <div className="flex items-center gap-1">
                        <Input
                          type="number" value={config.recoveryMultiplier} step={0.01}
                          onChange={e => set("recoveryMultiplier", Number(e.target.value))}
                          className="w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10"
                        />
                        <span className="text-[10px] text-muted-foreground">×</span>
                      </div>
                    </div>
                  )}

                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} max={10} accent={bot.accent} />
                </div>

                <p className="text-[9px] text-muted-foreground/60 leading-relaxed">
                  Recovery executes exclusively inside {bot.contractLabel}. A loss puts the shared
                  account ledger into recovery and every recovery trade stays in this bot&apos;s contract.
                </p>
              </div>

              {/* Specialist edge */}
              <div className={`rounded-xl border ${accent.panelBorder} ${accent.panelBg} p-3 space-y-1.5`}>
                <p className={`text-[10px] uppercase tracking-widest font-semibold ${accent.text}`}>Specialist Advantage</p>
                {bot.edge.map((e, i) => (
                  <p key={i} className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                    <span className={accent.text}>▸</span><span>{e}</span>
                  </p>
                ))}
              </div>

              {anyEngineBusy && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 flex gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-[10px] text-amber-200/80 leading-relaxed">
                    {session?.botName ?? "Another bot"} is currently trading. One account = one recovery
                    ledger = one executing engine, so stop it before deploying {bot.name}.
                  </p>
                </div>
              )}

              <Button
                onClick={handleScan}
                disabled={loading || anyEngineBusy}
                className={`w-full h-10 bg-gradient-to-r ${accent.grad} text-white font-bold text-sm shadow-lg`}
              >
                <ScanSearch className="w-4 h-4 mr-2" />
                Neural Scan All Markets
              </Button>
            </div>
          )}

          {/* ── STEP: SCANNING ───────────────────────────────────────────── */}
          {step === "scanning" && (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <motion.div
                    className={`w-5 h-5 rounded-full ${accent.iconBg} ${accent.iconBorder} flex items-center justify-center`}
                    animate={{ opacity: [0.5, 1, 0.5] }}
                    transition={{ duration: 1.6, repeat: Infinity }}
                  >
                    <Loader2 className={`w-3 h-3 ${accent.text} animate-spin`} />
                  </motion.div>
                  <div>
                    <p className="text-xs font-bold text-white tracking-wide leading-none">Specialist Neural Scan</p>
                    <p className={`text-[9px] ${accent.text} opacity-70 mt-0.5`}>{bot.contractLabel} estimators active</p>
                  </div>
                </div>
                <div className="text-right">
                  <span className={`text-sm font-bold font-mono ${accent.text}`}>
                    {scanProgress.scanning !== null ? scanProgress.scanned + 1 : scanProgress.scanned}
                  </span>
                  <span className="text-xs text-muted-foreground/40 font-mono"> / {scanProgress.total || SCAN_MARKET_COUNT}</span>
                </div>
              </div>

              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                  className={`h-full rounded-full bg-gradient-to-r ${accent.grad}`}
                  animate={{ width: `${(scanProgress.scanned / (scanProgress.total || SCAN_MARKET_COUNT)) * 100}%` }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                />
              </div>

              <div className={`rounded-xl border ${accent.panelBorder} ${accent.panelBg} flex items-center gap-3 px-3 py-3`}>
                <ScanSearch className={`w-4 h-4 ${accent.text} flex-shrink-0`} />
                <div className="min-w-0 flex-1">
                  <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-0.5">Analyzing Asset</p>
                  <p className="text-sm font-bold text-white truncate">
                    {scanProgress.scanning ?? "Calibrating specialist estimators…"}
                  </p>
                </div>
              </div>

              {scanProgress.results.length > 0 && (
                <div className="space-y-1 max-h-56 overflow-y-auto pr-0.5">
                  {[...scanProgress.results].sort((a, b) => b.score - a.score).map((r, i) => {
                    const market = SCAN_MARKETS.find(m => m.symbol === r.symbol);
                    return (
                      <div
                        key={r.symbol}
                        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs ${
                          i === 0 ? `${accent.activeBg} border ${accent.activeBorder} text-white` : "bg-white/[0.03] text-white/70"
                        }`}
                      >
                        <span className="font-mono text-[10px] text-muted-foreground/40 w-4">{i + 1}</span>
                        <span className="font-medium flex-1 truncate">{market?.short ?? r.symbol}</span>
                        <span className={`font-mono font-bold ${scoreColor(r.score)}`}>{r.score.toFixed(0)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── STEP: SCAN RESULT ────────────────────────────────────────── */}
          {step === "scan-result" && scanResult && (
            <div className="p-4 space-y-4">
              {scanResult.suitable && scanResult.best ? (
                <>
                  <div className="rounded-xl bg-green-500/5 border border-green-500/25 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                        <p className="text-xs font-semibold text-green-300">Statistical Edge Verified</p>
                      </div>
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">+EV</span>
                    </div>

                    <div className="bg-black/30 rounded-lg p-2.5 space-y-2">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-bold text-white truncate">{scanResult.best.displayName}</p>
                        <span className={`text-sm font-bold font-mono ${scoreColor(scanResult.best.score)}`}>
                          {scanResult.best.score.toFixed(0)}
                          <span className="text-[10px] font-normal text-muted-foreground">/100</span>
                        </span>
                      </div>

                      <div className="flex items-center gap-2 text-[11px] flex-wrap">
                        <span className={`px-1.5 py-0.5 rounded ${accent.badgeBg} ${accent.text} font-mono font-medium`}>
                          {scanResult.best.contractType}{scanResult.best.barrier !== undefined ? ` ${scanResult.best.barrier}` : ""}
                        </span>
                        <span className="text-muted-foreground">{(scanResult.best.winProbability * 100).toFixed(1)}% win rate</span>
                        {scanResult.best.expectedValue !== undefined && (
                          <span className="text-muted-foreground">
                            EV {scanResult.best.expectedValue >= 0 ? "+" : ""}{(scanResult.best.expectedValue * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>

                      <p className="text-[10px] text-muted-foreground leading-relaxed">{scanResult.best.reason}</p>
                    </div>
                  </div>

                  <SpecialistPanel specialist={scanResult.best.specialist} accent={bot.accent} />

                  <div className="space-y-2">
                    <Button
                      onClick={() => handleStart(scanResult.best!.symbol, "locked")}
                      disabled={loading || anyEngineBusy}
                      className={`w-full h-10 bg-gradient-to-r ${accent.grad} text-white font-bold text-xs shadow-lg`}
                    >
                      <Lock className="w-3.5 h-3.5 mr-2" />
                      Trade Locked on {scanResult.best.displayName}
                    </Button>
                    <Button
                      onClick={() => handleStart(undefined, "switching")}
                      disabled={loading || anyEngineBusy}
                      variant="outline"
                      className={`w-full h-9 ${accent.outlineBtn} text-xs font-semibold`}
                    >
                      <Shuffle className="w-3.5 h-3.5 mr-2" />
                      Trade with Smart Market Switching
                    </Button>
                  </div>

                  <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                    <ChevronLeft className="w-3 h-3" /> Change settings
                  </button>
                </>
              ) : (
                <>
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <p className="text-xs font-semibold text-amber-300">No Decisive Edge Found</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{scanResult.reason}</p>
                  </div>
                  <Button onClick={handleScan} disabled={loading} className={`w-full h-10 ${accent.solidBtn} text-white font-bold text-xs`}>
                    <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-Scan Markets
                  </Button>
                  <button onClick={() => setStep("config")} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                    <ChevronLeft className="w-3 h-3" /> Change settings
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── STEP: RUNNING ────────────────────────────────────────────── */}
          {step === "running" && (
            <div className="p-4 space-y-4">
              <div className={`rounded-xl p-3 border ${isThisBotRunning ? `${accent.panelBg} ${accent.panelBorder}` : "bg-secondary/30 border-border"}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                  {isThisBotRunning ? (
                    <span className={`flex items-center gap-1 text-[10px] ${accent.text}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${accent.dot} animate-pulse`} />
                      LIVE 1-TICK
                    </span>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">STOPPED</span>
                  )}
                </div>
                <div className={`text-2xl font-bold font-mono ${profitColor}`}>
                  {profit >= 0 ? "+" : "-"}${Math.abs(profit).toFixed(2)}
                </div>
                <div className="flex gap-3 mt-2 text-[11px]">
                  <span className="text-green-400">{session?.winCount ?? 0}W</span>
                  <span className="text-red-400">{session?.lossCount ?? 0}L</span>
                  <span className="text-muted-foreground">{winRate}% WR</span>
                  <span className="text-muted-foreground">{session?.tradeCount ?? 0} trades</span>
                </div>

                {session?.config && (
                  <div className="mt-2 space-y-1">
                    <div className="flex justify-between text-[9px] text-muted-foreground">
                      <span>SL -${session.config.stopLoss.toFixed(2)}</span>
                      <span>TP +${session.config.takeProfit.toFixed(2)}</span>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden relative">
                      <div className="absolute left-1/2 top-0 w-px h-full bg-white/20" />
                      <div
                        className={`absolute top-0 h-full rounded-full transition-all ${profit >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
                        style={{ width: `${Math.min(50, Math.abs(profit) / (profit >= 0 ? session.config.takeProfit : session.config.stopLoss) * 50)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {session?.message && (
                <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                  session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                  session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                  session.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300" :
                  "bg-secondary/30 border-border text-muted-foreground"
                }`}>
                  {session.message}
                </div>
              )}

              {isThisBotRunning && session?.currentMarket && (
                <div className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-3 py-2 border border-white/5">
                  <Loader2 className={`w-3 h-3 ${accent.text} animate-spin flex-shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${accent.dot} inline-block`} />
                      Active Asset
                    </p>
                    <p className="text-xs font-semibold text-white truncate">{session.currentMarket}</p>
                    <p className={`text-[10px] font-mono ${accent.text}`}>
                      {session.currentContractType} · ${(session.currentStake ?? 0).toFixed(2)}
                    </p>
                  </div>
                  {session.lastResult && (
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      session.lastResult === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"
                    }`}>
                      {session.lastResult.toUpperCase()}
                    </span>
                  )}
                </div>
              )}

              {/* Live specialist telemetry */}
              <AnimatePresence>
                {session?.specialist && (
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <SpecialistPanel specialist={session.specialist} accent={bot.accent} />
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Digit candidate table for match / differ bots */}
              {session?.digitCandidates && session.digitCandidates.length > 0 && (
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
                  <div className="flex items-center gap-1.5">
                    <Target className={`w-3.5 h-3.5 ${accent.text}`} />
                    <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground">Digit Risk Table</p>
                  </div>
                  <div className="grid grid-cols-5 gap-1">
                    {[...session.digitCandidates].sort((a, b) => a.digit - b.digit).map(c => {
                      const isTarget = session.currentContractType?.endsWith(` ${c.digit}`);
                      return (
                        <div
                          key={c.digit}
                          className={`rounded px-1 py-1 text-center border ${
                            isTarget ? `${accent.activeBg} ${accent.activeBorder}` : "bg-black/25 border-white/5"
                          }`}
                        >
                          <p className={`text-[10px] font-mono font-bold ${isTarget ? accent.text : "text-white/80"}`}>{c.digit}</p>
                          <p className="text-[8px] font-mono text-muted-foreground/70">{(c.upper * 100).toFixed(0)}%</p>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-[9px] text-muted-foreground/60">Upper-bound appearance rate per digit — the loss side this bot is priced against.</p>
                </div>
              )}

              {session?.inRecovery && (
                <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                      Sniper Recovery (Step {session.recoveryStep})
                    </span>
                    <span className="font-mono text-[10px] text-amber-400">
                      ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Recovery executes only in {bot.contractLabel}. Exits the instant the debt is cleared.
                  </p>
                </div>
              )}

              {/* Top markets under watch */}
              {session?.topMarkets && session.topMarkets.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70 flex items-center gap-1.5">
                    <Activity className="w-3 h-3" /> Ranked Markets
                  </p>
                  {session.topMarkets.slice(0, 5).map((m, i) => (
                    <div key={`${m.symbol}-${i}`} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03]">
                      <span className="font-mono text-[10px] text-muted-foreground/40 w-4">{i + 1}</span>
                      <span className="font-medium flex-1 truncate text-white/80">{m.displayName}</span>
                      <span className="font-mono text-[10px] text-muted-foreground/60">
                        {m.contractType}{m.barrier !== undefined ? ` ${m.barrier}` : ""}
                      </span>
                      <span className={`font-mono font-bold ${scoreColor(m.score)}`}>{m.score.toFixed(0)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                {isThisBotRunning ? (
                  <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                    <StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop {bot.name}
                  </Button>
                ) : (
                  <>
                    <Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                      New Session
                    </Button>
                    <Button onClick={handleScan} disabled={loading || anyEngineBusy} className={`flex-1 h-9 text-xs ${accent.solidBtn} text-white font-bold`}>
                      <ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-Scan
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Icon aliases re-exported so the page can render the same glyphs. */
export const BOT_ICONS = { Hash, Scale, Crosshair, TrendingUp, ShieldCheck };
