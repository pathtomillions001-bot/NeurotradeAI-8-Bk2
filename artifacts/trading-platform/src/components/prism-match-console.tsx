/**
 * Prism Match console (Matches only).
 *
 * Designed to match the elegant, compact specialist console design language
 * (KillShot, Dual-Lock, Specialist) — simple, focused, with relevant details:
 * 1. Config: Pacing, target digit (AI or specific 0-9), session boundaries (stake, TP, SL, recovery).
 * 2. Scanning: Fast multi-market scan with animated progress.
 * 3. Scan Results: Best market recommendation, top candidates ranking, and choice between
 *    Locked (pin market symbol) or Switching (smart dynamic market rotation).
 * 4. Running Session: Live session P&L, recovery step & debt, active market/digit,
 *    current signal edge, win/loss stats, execution timing, and clean Stop control.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2,
  StopCircle,
  ScanSearch,
  RefreshCw,
  ChevronLeft,
  X,
  Lock,
  Shuffle,
  ShieldCheck,
  Target,
  Zap,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";
import {
  canDeployPrism,
  prismDeployBody,
  prismPercent as pct,
  prismMoney as money,
  type PrismActivity,
  type PrismConfig,
  type PrismMarketView,
  type PrismScanView,
  type PrismTelemetry,
} from "@/lib/prism-match";

type Step = "config" | "scanning" | "scan-result" | "running";

const BASE = "/api/bots/prism-match";

const PACING_PROFILES: Array<{ id: PrismActivity; label: string; desc: string }> = [
  { id: "active", label: "Active", desc: "42% entry fraction · faster action" },
  { id: "balanced", label: "Balanced", desc: "26% entry fraction · balanced edge" },
  { id: "patient", label: "Patient", desc: "14% entry fraction · high selectivity" },
];

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

function NumInput({
  label: lbl,
  value,
  onChange,
  min,
  step = 1,
  suffix,
  accent,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  step?: number;
  suffix?: string;
  accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{lbl}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
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

export function PrismMatchConsole({
  bot,
  open,
  onOpenChange,
  session,
  onSession,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<PrismScanView | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">("locked");
  const [activity, setActivity] = useState<PrismActivity>("balanced");
  const [aiDigit, setAiDigit] = useState(true);
  const [digit, setDigit] = useState<number>(7);
  const [executionMode, setExecutionMode] = useState<"paper" | "live">("paper");
  const [confirmLive, setConfirmLive] = useState(false);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null,
    scanned: 0,
    total: 19,
  });

  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
  });

  const setParam = <K extends keyof typeof config>(k: K, v: number) =>
    setConfig((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    setConfig((prev) => ({
      ...prev,
      stake: s.riskAmountValue ?? prev.stake,
      maxRecoverySteps: s.maxRecoverySteps ?? prev.maxRecoverySteps,
    }));
  }, [settings]);

  const isRunning = session?.running === true && session?.botId === (bot?.id ?? "prism-match");

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
    if (!open) return;
    let es: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    function connect() {
      if (dead) return;
      es = new EventSource(withTabSession("/api/ai/events"));
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          if (d.botId === "prism-match") applyStatus(d as BotSessionStatus);
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("prism_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          setProgress({ scanning: p.scanning, scanned: p.scanned, total: p.total });
        } catch {
          /* ignore */
        }
      });
      es.onerror = () => {
        es.close();
        if (!dead) timer = setTimeout(connect, 2000);
      };
    }
    connect();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [open, applyStatus]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent ?? "fuchsia"];
  const Icon = BOT_ICON[bot.icon] ?? Zap;

  const buildScanInput = (): PrismConfig => ({
    activity,
    digit: aiDigit ? undefined : digit,
    stake: config.stake,
    stopLoss: config.stopLoss,
    takeProfit: config.takeProfit,
    maxRecoverySteps: config.maxRecoverySteps,
    executionMode,
  });

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: "Inspecting deep digit ticks…", scanned: 0, total: 19 });
    try {
      const res = await fetch(`${BASE}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildScanInput()),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Scan failed");
        setStep("config");
        return;
      }
      const scanView = data as PrismScanView;
      setScanResult(scanView);
      if (scanView.markets.length > 0) {
        setSelectedSymbol(scanView.markets[0]!.symbol);
      }
      setStep("scan-result");
    } catch {
      toast.error("Could not reach Prism analysis engine");
      setStep("config");
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async (symbol: string, mode: "locked" | "switching") => {
    if (!scanResult) return;
    const chosenMarket = scanResult.markets.find((m) => m.symbol === symbol);
    if (!chosenMarket) return;

    if (scanResult.config.executionMode === "live" && !confirmLive) {
      toast.error("Please confirm live real-money risk");
      return;
    }

    setLoading(true);
    try {
      const deployPayload = prismDeployBody(
        scanResult,
        symbol,
        mode,
        scanResult.config.executionMode === "live" && confirmLive,
      );
      const res = await fetch(`${BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deployPayload),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start Prism Match");
        return;
      }
      onSession(data.status);
      setMarketMode(mode);
      setStep("running");
      toast.success(
        mode === "locked"
          ? `🔒 Locked on ${chosenMarket.displayName} (Matches)`
          : `🔁 Deployed on ${chosenMarket.displayName} (Matches · Auto-Switching)`,
      );
    } catch {
      toast.error("Could not start Prism Match");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${BASE}/stop`, { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Prism Match session stopped");
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate =
    session && session.tradeCount > 0
      ? Math.round((session.winCount / session.tradeCount) * 100)
      : 0;
  const telemetry = session?.prism;
  const selectedMarket = scanResult?.markets.find((m) => m.symbol === selectedSymbol);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label={`${bot.name} console`}
            className={`fixed bottom-20 right-4 z-50 w-88 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            {/* Header */}
            <div
              className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}
                >
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}
                    >
                      {bot.code}
                    </span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {bot.tagline}
                  </p>
                </div>
              </div>
              <button
                onClick={() => onOpenChange(false)}
                aria-label="Close console"
                className="text-muted-foreground hover:text-white p-1 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* STEP 1: CONFIG */}
            {step === "config" && (
              <div className="p-4 space-y-4">
                {/* Mode Selector: Paper vs Live */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Execution Mode
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      onClick={() => setExecutionMode("paper")}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                        executionMode === "paper"
                          ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                          : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                      }`}
                    >
                      🧪 Paper (Test)
                    </button>
                    <button
                      onClick={() => setExecutionMode("live")}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold transition-colors ${
                        executionMode === "live"
                          ? "bg-red-500/15 border border-red-500/40 text-red-300"
                          : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                      }`}
                    >
                      ⚡ Live Account
                    </button>
                  </div>
                </div>

                {/* Target Digit (Matches only) */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Target Digit (1-Tick Matches)
                  </p>
                  <button
                    onClick={() => setAiDigit((v) => !v)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] text-left transition-colors ${
                      aiDigit
                        ? `${a.activeBg} border ${a.activeBorder}`
                        : "bg-white/[0.03] border border-white/5"
                    }`}
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                        aiDigit ? `${a.dot} border-transparent` : "border-white/20"
                      }`}
                    >
                      {aiDigit && <span className="text-[8px] text-black font-bold">✓</span>}
                    </span>
                    <span className={aiDigit ? a.text : "text-muted-foreground"}>
                      AI selects best match digit dynamically (7-model ensemble)
                    </span>
                  </button>
                  {!aiDigit && (
                    <div className="space-y-1 pt-1">
                      <p className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
                        Lock Fixed Digit
                      </p>
                      <div className="grid grid-cols-5 gap-1">
                        {ALL_DIGITS.map((d) => (
                          <button
                            key={d}
                            onClick={() => setDigit(d)}
                            className={`h-8 rounded-lg text-xs font-mono font-bold transition-colors ${
                              digit === d
                                ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                                : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                            }`}
                          >
                            {d}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Pacing Profiles */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Pacing Profile
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {PACING_PROFILES.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setActivity(p.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${
                          activity === p.id
                            ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                        }`}
                      >
                        <span className="block text-[11px] font-semibold">{p.label}</span>
                        <span className="block text-[8px] text-muted-foreground/70">
                          {p.id === "active" ? "42%" : p.id === "balanced" ? "26%" : "14%"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Session Risk & Recovery */}
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Session Boundaries
                  </p>
                  <NumInput
                    label="Base Stake"
                    value={config.stake}
                    onChange={(v) => setParam("stake", v)}
                    min={0.35}
                    step={0.5}
                    suffix="USD"
                    accent={bot.accent ?? "fuchsia"}
                  />
                  <NumInput
                    label="Take Profit"
                    value={config.takeProfit}
                    onChange={(v) => setParam("takeProfit", v)}
                    min={1}
                    step={1}
                    suffix="USD"
                    accent={bot.accent ?? "fuchsia"}
                  />
                  <NumInput
                    label="Stop Loss"
                    value={config.stopLoss}
                    onChange={(v) => setParam("stopLoss", v)}
                    min={1}
                    step={1}
                    suffix="USD"
                    accent={bot.accent ?? "fuchsia"}
                  />
                  <NumInput
                    label="Max Recovery Steps"
                    value={config.maxRecoverySteps}
                    onChange={(v) => setParam("maxRecoverySteps", v)}
                    min={1}
                    step={1}
                    accent={bot.accent ?? "fuchsia"}
                  />
                </div>

                {/* Live Risk Confirmation */}
                {executionMode === "live" && (
                  <div className="p-2.5 rounded-lg border border-red-500/30 bg-red-500/10 space-y-1.5">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={confirmLive}
                        onChange={(e) => setConfirmLive(e.target.checked)}
                        className="mt-0.5 rounded border-red-500/40 text-red-500"
                      />
                      <span className="text-[11px] text-red-200 leading-tight">
                        I confirm this session trades with <strong>real live account funds</strong> on Deriv.
                      </span>
                    </label>
                  </div>
                )}

                <Button
                  onClick={handleScan}
                  disabled={loading}
                  className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                >
                  <ScanSearch className="w-4 h-4 mr-2" /> Scan 19 Markets
                </Button>
              </div>
            )}

            {/* STEP 2: SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">
                    Measuring 19 markets out-of-sample
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning || "Analyzing deep digit patterns…"}
                  </p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={`h-full ${a.solidBtn} transition-all`}
                    style={{
                      width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%`,
                    }}
                  />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">
                  {progress.scanned}/{progress.total} markets measured
                </p>
              </div>
            )}

            {/* STEP 3: SCAN RESULTS & DEPLOY CHOICE */}
            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {selectedMarket ? (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-white">
                        {selectedMarket.displayName}
                      </span>
                      <span className={`text-[10px] font-mono font-bold ${a.text}`}>
                        Matches Digit {selectedMarket.decision.digit}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat
                        label="Prob P(Win)"
                        value={pct(selectedMarket.decision.p)}
                        tone={a.text}
                      />
                      <Stat
                        label="Utility Edge"
                        value={`${selectedMarket.decision.utility >= 0 ? "+" : ""}${(selectedMarket.decision.utility * 100).toFixed(1)}%`}
                        tone={selectedMarket.decision.utility >= 0 ? "text-green-400" : "text-amber-400"}
                      />
                      <Stat
                        label="Break-Even"
                        value={pct(selectedMarket.decision.breakEven)}
                      />
                      <Stat
                        label="Held-Out Hit Rate"
                        value={pct(selectedMarket.validation.hitRate)}
                      />
                    </div>

                    <p className="text-[10px] text-muted-foreground leading-relaxed pt-1">
                      {selectedMarket.decision.reason}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-1 text-center">
                    <p className="text-xs font-semibold text-amber-300">No qualified market</p>
                    <p className="text-[11px] text-muted-foreground">
                      {scanResult.note || "Markets currently exhibit near-uniform noise."}
                    </p>
                  </div>
                )}

                {/* Candidate Selector if multiple */}
                {scanResult.markets.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                      Top Ranked Markets
                    </p>
                    <div className="space-y-1 max-h-36 overflow-y-auto">
                      {scanResult.markets.slice(0, 5).map((m) => (
                        <button
                          key={m.symbol}
                          onClick={() => setSelectedSymbol(m.symbol)}
                          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                            selectedSymbol === m.symbol
                              ? `${a.activeBg} border ${a.activeBorder}`
                              : "bg-white/[0.03] text-muted-foreground hover:bg-white/[0.06]"
                          }`}
                        >
                          <span className="font-medium text-white/90 truncate">
                            {m.displayName} (Matches {m.decision.digit})
                          </span>
                          <span
                            className={`font-mono text-[11px] font-bold ${
                              m.decision.utility >= 0 ? "text-green-400" : "text-amber-400"
                            }`}
                          >
                            {pct(m.decision.p)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Deployment Choice: Locked vs. Switching */}
                {selectedMarket && (
                  <div className="space-y-2 pt-2 border-t border-white/5">
                    <Button
                      onClick={() => handleStart(selectedSymbol, "locked")}
                      disabled={loading || !canDeployPrism(scanResult, selectedMarket, Date.now(), confirmLive)}
                      className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                    >
                      <Lock className="w-4 h-4 mr-2" /> Lock {selectedMarket.displayName}
                    </Button>
                    <Button
                      onClick={() => handleStart(selectedSymbol, "switching")}
                      disabled={loading || !canDeployPrism(scanResult, selectedMarket, Date.now(), confirmLive)}
                      variant="outline"
                      className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}
                    >
                      <Shuffle className="w-3.5 h-3.5 mr-2" /> Start with Smart Market Switching
                    </Button>
                  </div>
                )}

                <Button
                  onClick={handleScan}
                  disabled={loading}
                  variant="outline"
                  className={`w-full h-8 ${a.outlineBtn} text-[11px] font-semibold mt-1`}
                >
                  <RefreshCw className="w-3 h-3 mr-1.5" /> Re-scan
                </Button>

                <button
                  onClick={() => setStep("config")}
                  className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1"
                >
                  <ChevronLeft className="w-3 h-3" /> Change configuration
                </button>
              </div>
            )}

            {/* STEP 4: RUNNING SESSION */}
            {step === "running" && (
              <div className="p-4 space-y-3">
                {/* Session P&L */}
                <div
                  className={`rounded-xl p-3 border ${
                    isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Session P&amp;L ({telemetry?.executionMode?.toUpperCase() || "PAPER"})
                    </span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] font-semibold ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                        {marketMode === "locked" ? "LOCKED" : "SWITCHING"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">STOPPED</span>
                    )}
                  </div>
                  <div
                    className={`text-2xl font-bold font-mono ${
                      profit >= 0 ? "text-green-400" : "text-red-400"
                    }`}
                  >
                    {money(profit)}
                  </div>
                  <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                    <span className="text-green-400">{session?.winCount ?? 0}W</span>
                    <span className="text-red-400">{session?.lossCount ?? 0}L</span>
                    <span className="text-muted-foreground">{winRate}% WR</span>
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} trades</span>
                  </div>
                </div>

                {/* Active Market & Digit */}
                <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                  <div className="flex items-center justify-between">
                    <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                      {marketMode === "locked" ? "Locked Market" : "Active Market"}
                    </p>
                    <span className="text-[9px] font-mono text-muted-foreground">
                      {telemetry?.phase?.toUpperCase() || "WATCHING"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-bold text-white">
                      {session?.currentMarket || "Loading market…"}
                    </p>
                    <span className={`text-xs font-mono font-bold ${a.text}`}>
                      {session?.currentContractType || "Matches"}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Stat
                      label="Target Digit"
                      value={telemetry?.digit !== null && telemetry?.digit !== undefined ? String(telemetry.digit) : "—"}
                      tone={a.text}
                    />
                    <Stat
                      label="Prob P(Win)"
                      value={pct(telemetry?.decision?.p)}
                    />
                    <Stat
                      label="Current Stake"
                      value={session?.currentStake ? `$${session.currentStake.toFixed(2)}` : "—"}
                    />
                    <Stat
                      label="Latency P95"
                      value={telemetry?.executionP95Ms ? `${Math.round(telemetry.executionP95Ms)}ms` : "—"}
                    />
                  </div>
                </div>

                {/* Recovery Status */}
                {session?.inRecovery && (
                  <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-300 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" /> Matches Recovery (Step {session.recoveryStep})
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Sizing 1-tick Matches against exact quote payout.
                    </p>
                  </div>
                )}

                {/* Status Message */}
                {session?.message && (
                  <div
                    className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                      session.message.includes("won") || session.message.includes("match")
                        ? "bg-green-500/10 border-green-500/20 text-green-400"
                        : session.message.includes("stop") || session.message.includes("Loss")
                        ? "bg-red-500/10 border-red-500/20 text-red-400"
                        : "bg-secondary/30 border-border text-muted-foreground"
                    }`}
                  >
                    {session.message}
                  </div>
                )}

                {/* Session Actions */}
                <div className="flex gap-2">
                  {isRunning ? (
                    <Button
                      onClick={handleStop}
                      disabled={loading}
                      variant="destructive"
                      className="flex-1 h-9 text-xs"
                    >
                      <StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop Session
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={() => setStep("config")}
                        variant="outline"
                        className="flex-1 h-9 text-xs border-white/10"
                      >
                        New Session
                      </Button>
                      <Button
                        onClick={handleScan}
                        disabled={loading}
                        className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}
                      >
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

export default PrismMatchConsole;
