/**
 * Twin-Hedge Edge console — auto-configured twin pair, 4/5 dead-zone hunter.
 *
 * Frontend spec (from screenshots + user text):
 * - Auto-configured pairs · equal stakes · same tick
 * - Normal shot: Over 4 + Under 5 — Complementary, exactly one leg always wins (1.95×). Net −5%: price of hedge.
 * - Recovery shot: Over 5 + Under 4 — Wins +143% net on any digit but 4/5. The 4/5 dead zone is what analysis hunts.
 * - No pair picker, no digit picker, no market picker — AI measures every market,
 *   keeps closed digit out of {4,5} at every gated entry, decides locked vs switching itself.
 * - Stake per leg (normal shot) USD, Take profit USD, Stop loss USD, Max recovery steps
 * - Recovery stakes are not yours to set — shared ledger sizes them from debt (markup from Settings),
 *   exactly like every other bot. Both legs of a shot always carry SAME stake and open on SAME tick.
 *
 * Backend sync (verified):
 * - Engine: lib/twin-avoid-engine.ts — three-fused 4/5 model (forgetting Dirichlet half-life 69 ticks
 *   + order-1 Markov on last digit + order-2 Markov on last two digits, inverse-variance fused),
 *   hard vetos (4/5 hot cluster 3+ of last 6, post-4/5 state, >22% baseline, post-loss cooldown),
 *   worst-case gate P̂(4/5)+1.25σ < baseline, self-referential bars (30th percentile recovery / 55th normal),
 *   out-of-sample survival P(TP before SL), market mode decided by analysis (clear winner LOCKED,
 *   tight cluster SWITCHING with hysteresis), Page–Hinkley live 4/5 drift monitor, shared recovery ledger
 * - Analysis: lib/twin-avoid-analysis.ts — OOS replay with exact engine rules
 * - API: /api/bots/twin/scan, /start, /stop, /status — session-isolated, single-executor arbiter
 * - Console ID: twin-hedge@2 (bumped 2026-09-18 from v1 → v2 for new UI/flow)
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
  Layers,
  ShieldCheck,
  GitCompareArrows,
  Zap,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";

interface TwinCard {
  symbol: string;
  displayName: string;
  baseline: number;
  barNormal: number;
  barRecovery: number;
  nEff: number;
  opportunityNormal: number;
  opportunityRecovery: number;
  avoidanceLiftPp: number;
  survival: number;
  evPerNormalShot: number;
  deepestLadder: number;
  simNormalShots: number;
  simRecoveryShots: number;
  stationarityZ: number;
  minSpacing: number;
  verdict: "certified" | "qualified" | "watch" | "refused";
  deployable: boolean;
  score: number;
  summary: string;
}

interface ScanResult {
  suitable: boolean;
  best: TwinCard | null;
  bestAvailable: TwinCard | null;
  allScored: TwinCard[];
  mode: "locked" | "switching";
  cluster: TwinCard[];
  modeReason: string;
  reason: string;
  marketsScanned: number;
  historyDepth: number;
}

const VERDICT_TONE: Record<TwinCard["verdict"], string> = {
  certified: "text-green-400 bg-green-500/10 border-green-500/30",
  qualified: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  watch: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  refused: "text-red-400 bg-red-500/10 border-red-500/30",
};

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
        {suffix && (
          <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>
        )}
      </div>
    </div>
  );
}

function Stat({
  label: lbl,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="bg-black/25 rounded-lg px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">{lbl}</p>
      <p className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}>{value}</p>
    </div>
  );
}

/** The fixed plan — rendered read-only so the user always sees what will trade. */
function FixedPlanCard({ accent }: { accent: AccentKey }) {
  const a = ACCENTS[accent];
  return (
    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
        Auto-configured pairs · equal stakes · same tick
      </p>
      <div className="grid grid-cols-2 gap-1.5">
        <div className="rounded-lg bg-black/25 border border-white/10 p-2 space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Normal shot</p>
          <p className="text-[11px] font-mono font-bold text-white/90">Over 4 + Under 5</p>
          <p className="text-[9px] leading-snug text-muted-foreground">
            Complementary — exactly one leg always wins (1.95×). Net −5%: the price of the hedge.
          </p>
        </div>
        <div className="rounded-lg bg-black/25 border border-white/10 p-2 space-y-1">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Recovery shot</p>
          <p className="text-[11px] font-mono font-bold text-white/90">Over 5 + Under 4</p>
          <p className="text-[9px] leading-snug text-muted-foreground">
            Wins +143% net on any digit but 4/5. The 4/5 dead zone is what the analysis hunts.
          </p>
        </div>
      </div>
      <p className="text-[9px] leading-snug text-muted-foreground">
        No pair picker, no digit picker, no market picker — the AI measures every market,
        keeps the closed digit out of {`{4,5}`} at every gated entry, and decides
        locked vs switching itself.
      </p>
    </div>
  );
}

function CandidateCard({ c }: { c: TwinCard }) {
  return (
    <div className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-white">{c.displayName}</p>
        <span className="text-[10px] font-mono font-bold uppercase">{c.verdict}</span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">{c.summary}</p>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat
          label="Survival (OOS)"
          value={`${(c.survival * 100).toFixed(0)}%`}
          tone={c.survival >= 0.7 ? "text-green-400" : c.survival >= 0.55 ? "text-sky-300" : "text-red-400"}
        />
        <Stat label="4/5 at gated entries" value={`${((c.baseline - c.avoidanceLiftPp / 100) * 100).toFixed(1)}%`} />
        <Stat
          label="Deep. ladder"
          value={`${c.deepestLadder}`}
          tone={c.deepestLadder <= 2 ? "text-green-400" : "text-amber-300"}
        />
        <Stat label="Gate opens (rec)" value={`${(c.opportunityRecovery * 100).toFixed(0)}% of ticks`} />
        <Stat
          label="4/5 avoidance lift"
          value={`${c.avoidanceLiftPp >= 0 ? "+" : ""}${c.avoidanceLiftPp.toFixed(1)}pp`}
          tone={c.avoidanceLiftPp >= 0 ? "text-green-400" : "text-red-400"}
        />
        <Stat
          label="Net / normal shot"
          value={`${c.evPerNormalShot >= 0 ? "+" : ""}$${c.evPerNormalShot.toFixed(3)}`}
          tone={c.evPerNormalShot >= 0 ? "text-green-400" : "text-red-400"}
        />
      </div>
    </div>
  );
}

export function TwinHedgeConsole({
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
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
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
  const set = <K extends keyof typeof config>(k: K, v: number) =>
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

  const isRunning = session?.running === true && session?.botId === bot?.id;
  useEffect(() => {
    if (isRunning) setStep("running");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setStep(isRunning ? "running" : "config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        } catch {
          /* ignore */
        }
      });
      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          if (p.botId !== botId) return;
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
  }, [open, bot, applyStatus]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Layers;

  const buildBody = () => ({ ...config });

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch("/api/bots/twin/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Scan failed");
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

  const handleStart = async (c: TwinCard) => {
    if (!scanResult) return;
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          symbol: c.symbol,
          card: c,
          cluster: scanResult.cluster,
          marketMode: scanResult.mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start");
        return;
      }
      onSession(data.status);
      setStep("running");
      toast.success(
        scanResult.mode === "locked"
          ? `🔒 Locked on ${c.displayName} — the analysis found a clear winner`
          : `🔁 Deployed on ${c.displayName} — switching among the top ${scanResult.cluster.length}`,
      );
    } catch {
      toast.error("Could not start the bot");
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twin/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Session stopped");
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
  const watch = session?.twinWatch;
  const deployed = session?.twinDeployed;
  const lastShot = watch?.lastShot;
  const marketMode: "locked" | "switching" =
    deployed?.marketMode ?? (session?.config as any)?.marketMode ?? "locked";

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
            className={`fixed bottom-20 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            {/* Header */}
            <div
              className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
                  <Icon className="w-4.5 h-4.5" style={{ color: "currentColor" }} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}>
                      {bot.code}
                    </span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.tagline}</p>
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

            {/* CONFIG */}
            {step === "config" && (
              <div className="p-4 space-y-4">
                <FixedPlanCard accent={bot.accent} />

                <div className="space-y-2">
                  <NumInput label="Stake per leg (normal shot)" value={config.stake} onChange={(v) => set("stake", v)} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={(v) => set("takeProfit", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={(v) => set("stopLoss", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} step={1} accent={bot.accent} />
                </div>

                <p className="text-[9px] leading-snug text-muted-foreground">
                  Recovery stakes are not yours to set — the shared ledger sizes them from the
                  debt (markup from Settings), exactly like every other bot. Both legs of a shot
                  always carry the SAME stake and open on the SAME tick.
                </p>

                <Button
                  onClick={handleScan}
                  disabled={loading}
                  className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                >
                  <ScanSearch className="w-4 h-4 mr-2" /> Measure every market
                </Button>
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">
                    Fitting the 4/5 model & replaying the engine out of sample
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `${progress.scanning}…` : "Preparing…"}
                  </p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div
                    className={`h-full ${a.solidBtn} transition-all`}
                    style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }}
                  />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">
                  {progress.scanned}/{progress.total} markets
                </p>
              </div>
            )}

            {/* SCAN RESULT */}
            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {(scanResult.best ?? scanResult.bestAvailable) && (
                  <CandidateCard c={scanResult.best ?? scanResult.bestAvailable!} />
                )}

                {scanResult.best && scanResult.suitable ? (
                  <>
                    <div
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                        scanResult.mode === "locked"
                          ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-300"
                          : "bg-sky-500/10 border-sky-500/30 text-sky-300"
                      }`}
                    >
                      {scanResult.mode === "locked" ? (
                        <Lock className="w-4 h-4 flex-shrink-0" />
                      ) : (
                        <Shuffle className="w-4 h-4 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-[11px] font-bold uppercase tracking-wider">
                          {scanResult.mode === "locked"
                            ? `Locked — ${scanResult.best.displayName}`
                            : `Switching — top ${scanResult.cluster.length} cluster`}
                        </p>
                        <p className="text-[10px] leading-snug opacity-80">{scanResult.modeReason}</p>
                      </div>
                    </div>
                    <Button
                      onClick={() => handleStart(scanResult.best!)}
                      disabled={loading}
                      className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                    >
                      <Zap className="w-4 h-4 mr-2" /> Deploy on {scanResult.best.displayName}
                    </Button>
                  </>
                ) : scanResult.bestAvailable ? (
                  <>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      No market cleared the full bar. Starting anyway is a deliberate choice —
                      the gate still vetoes every hot 4/5 entry, and the session stops on TP/SL.
                    </p>
                    <Button
                      onClick={() => handleStart(scanResult.bestAvailable!)}
                      disabled={loading}
                      className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                    >
                      <Zap className="w-4 h-4 mr-2" /> Deploy on {scanResult.bestAvailable.displayName} anyway
                    </Button>
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2 text-center">
                    <p className="text-xs font-semibold text-amber-300">No measurable market right now</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>

                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                      Runner-ups
                    </p>
                    {scanResult.allScored.slice(0, 5).map((c, i) => (
                      <div
                        key={i}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] text-left"
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            c.verdict === "certified"
                              ? "bg-green-400"
                              : c.verdict === "qualified"
                                ? "bg-sky-400"
                                : c.verdict === "watch"
                                  ? "bg-amber-400"
                                  : "bg-red-400"
                          }`}
                        />
                        <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                        <span className="font-mono text-muted-foreground">
                          surv {(c.survival * 100).toFixed(0)}%
                        </span>
                        <span
                          className={`font-mono font-bold ${c.evPerNormalShot >= 0 ? "text-green-400" : "text-red-400"}`}
                        >
                          {c.evPerNormalShot >= 0 ? "+" : ""}${c.evPerNormalShot.toFixed(3)}/shot
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <Button
                  onClick={handleScan}
                  disabled={loading}
                  variant="outline"
                  className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-measure
                </Button>
                <button
                  onClick={() => setStep("config")}
                  className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1"
                >
                  <ChevronLeft className="w-3 h-3" /> Change risk settings
                </button>
              </div>
            )}

            {/* RUNNING */}
            {step === "running" && (
              <div className="p-4 space-y-3">
                <div
                  className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Session P&amp;L
                    </span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                        {marketMode === "locked" ? "LOCKED" : "SWITCHING"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">STOPPED</span>
                    )}
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

                {deployed && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {marketMode === "locked" ? "Locked market" : "Active market"}
                      </p>
                      {watch?.switched && (
                        <span className="text-[9px] font-mono text-amber-300 flex items-center gap-1">
                          <GitCompareArrows className="w-3 h-3" /> rotated
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-bold text-white">{deployed.displayName}</p>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat
                        label="Verdict"
                        value={deployed.verdict.toUpperCase()}
                        tone={deployed.verdict === "refused" ? "text-red-400" : "text-green-400"}
                      />
                      <Stat label="4/5 baseline" value={`${(deployed.baseline * 100).toFixed(1)}%`} />
                      <Stat label="Survival (OOS)" value={`${(deployed.survival * 100).toFixed(0)}%`} />
                      <Stat label="Rec. bar" value={`${(deployed.barRecovery * 100).toFixed(1)}%`} />
                      <Stat label="Norm. bar" value={`${(deployed.barNormal * 100).toFixed(1)}%`} />
                      <Stat
                        label="Net / normal"
                        value={`${deployed.evPerNormalShot >= 0 ? "+" : ""}$${deployed.evPerNormalShot.toFixed(3)}`}
                        tone={deployed.evPerNormalShot >= 0 ? "text-green-400" : "text-red-400"}
                      />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {watch.phase === "firing"
                          ? "Firing"
                          : watch.phase === "armed"
                            ? "Armed"
                            : "Watching"}
                        <span className={`ml-1.5 ${watch.mode === "recovery" ? "text-amber-400" : "text-white/60"}`}>
                          {watch.mode === "recovery" ? "· RECOVERY" : "· NORMAL"}
                        </span>
                      </p>
                      <span className="text-[9px] font-mono text-muted-foreground/70">
                        P(4/5) {(watch.p45 * 100).toFixed(1)}% / bar {(watch.bar * 100).toFixed(1)}%
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {watch.veto ? (
                        <span className="text-red-300">⛔ {watch.veto} — {watch.reason}</span>
                      ) : (
                        watch.reason || "Waiting…"
                      )}
                    </p>
                    {watch.overStake > 0 && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="Over leg" value={`$${watch.overStake.toFixed(2)}`} tone="text-green-400" />
                        <Stat label="Under leg" value={`$${watch.underStake.toFixed(2)}`} tone="text-red-300" />
                      </div>
                    )}
                    {lastShot && (
                      <div
                        className={`rounded-lg border px-2.5 py-2 space-y-1 ${
                          lastShot.sameTick
                            ? "bg-green-500/5 border-green-500/25"
                            : "bg-amber-500/10 border-amber-500/30"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`text-[10px] font-bold ${lastShot.sameTick ? "text-green-400" : "text-amber-300"}`}
                          >
                            {lastShot.paper ? "PAPER " : ""}
                            {lastShot.sameTick ? "✓ SAME TICK" : "⚠ SPLIT LEGS"}
                            {lastShot.spreadMs >= 0 && (
                              <span className="ml-1 font-mono text-[9px] opacity-70">Δ{lastShot.spreadMs}ms</span>
                            )}
                          </span>
                          <span className="text-[10px] font-mono text-white/80">
                            digit {lastShot.digit}
                          </span>
                        </div>
                        <div className="grid grid-cols-3 gap-1.5">
                          <Stat
                            label="Over leg"
                            value={lastShot.overWon ? "WIN" : "loss"}
                            tone={lastShot.overWon ? "text-green-400" : "text-red-400"}
                          />
                          <Stat
                            label="Under leg"
                            value={lastShot.underWon ? "WIN" : "loss"}
                            tone={lastShot.underWon ? "text-green-400" : "text-red-400"}
                          />
                          <Stat
                            label="Net"
                            value={`${lastShot.net >= 0 ? "+" : ""}$${lastShot.net.toFixed(2)}`}
                            tone={lastShot.net >= 0 ? "text-green-400" : "text-red-400"}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {session?.message && (
                  <div
                    className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                      session.message.startsWith("✅")
                        ? "bg-green-500/10 border-green-500/20 text-green-400"
                        : session.message.startsWith("🛑")
                          ? "bg-red-500/10 border-red-500/20 text-red-400"
                          : session.message.startsWith("❌")
                            ? "bg-red-500/10 border-red-500/20 text-red-300"
                            : session.message.startsWith("⚠️")
                              ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
                              : session.message.startsWith("🔁")
                                ? "bg-sky-500/10 border-sky-500/25 text-sky-300"
                                : session.message.startsWith("🎯")
                                  ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
                                  : "bg-secondary/30 border-border text-muted-foreground"
                    }`}
                  >
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
                      Recovery fires Over 5 + Under 4 — the gate holds every hot 4/5 entry,
                      and the ledger's debt-driven stake sizes both legs equally.
                    </p>
                  </div>
                )}

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
                        <ScanSearch className="w-3.5 h-3.5 mr-1.5" /> Re-measure
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
