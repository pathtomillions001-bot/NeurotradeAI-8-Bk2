/**
 * Compounding Range Sentinel console — the accumulator bot's control room.
 *
 * The console is deliberately a MEASUREMENT INSTRUMENT first, because that is
 * what an accumulator is: a band the platform sizes from its own volatility
 * model so that the chance of staying inside equals 1/(1+g). Expected value
 * therefore multiplies by λ = p(1+g) per tick, and the only honest edge is a
 * realised tick volatility below the one the band was cut from.
 *
 * So the flow is: pick the growth rate (the compounding rate, which sets BOTH
 * the payout schedule and the break-even survival) → measure every market →
 * read λ and its lower bound per market → deploy only if something certified →
 * watch the live survival, the value, and the exit policy work.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Loader2,
  StopCircle,
  ScanSearch,
  X,
  Lock,
  Shuffle,
  Activity,
  ShieldCheck,
  RefreshCw,
  TrendingUp,
  LineChart,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";

// ── Engine shapes (mirrors of lib/accumulator-engine.ts) ─────────────────────

interface EdgeReading {
  symbol: string;
  growthRate: number;
  barrierRatio: number;
  barrierCalibrated: boolean;
  pBreakEven: number;
  p: number;
  pHatLower: number;
  pHatUpper: number;
  lambda: number;
  lambdaLower: number;
  lambdaUpper: number;
  zBreakEven: number;
  sigmaModel: number;
  sigmaReal: number;
  volRatio: number;
  zVolEdge: number;
  samples: number;
  markovRunLength: number;
  markovHitProb: number[];
  markovSpreadZ: number;
  clusteringZ: number;
  verdict: "CERTIFIED" | "QUALIFIED" | "WATCH" | "REFUSED";
  reason: string;
}

interface Candidate {
  symbol: string;
  displayName: string;
  growthRate: number;
  verdict: EdgeReading["verdict"];
  edge: EdgeReading;
  optimalTicks: number;
  optimalEvMultiple: number;
  optimalEvLower: number;
  survivalAtHorizon: number;
  barrierRatio: number;
  barrierPrice: number | null;
  maxTicks: number;
  sigmaModel: number;
  sigmaReal: number;
  markovHitProb: number[];
  markovSpreadZ: number;
  markovRunLength: number;
  clusteringZ: number;
  reason: string;
  score: number;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  allScored: Candidate[];
  reason: string;
  hypotheses: number;
  fdrThreshold: number;
  certified: number;
}

interface ExplainResult {
  symbol: string;
  displayName: string;
  growthRate: number;
  barrierRatio: number;
  barrierCalibrated: boolean;
  breakEvenSurvival: number;
  empiricalSurvival: number;
  lambda: number;
  lambdaLower: number;
  sigmaModel: number;
  sigmaReal: number;
  volRatio: number;
  requiredVolRatio: number;
  optimalTicks: number;
  payoutMultiple: number;
  evMultiple: number;
  evLower: number;
  markovRunLength: number;
  clusteringZ: number;
  verdict: string;
  reason: string;
  maxTicks: number;
  curve: Array<{ ticks: number; payoutMultiple: number; survival: number; ev: number }>;
  iid: Array<{ ticks: number; survival: number }>;
}

interface AccuStatus extends BotSessionStatus {
  growthRate?: number | null;
  bailOutCount?: number;
  rotationCount?: number;
  currentSymbol?: string;
  currentValue?: number;
  currentProfit?: number;
  ticksSurvived?: number;
  targetTicks?: number;
  lastResult?: "won" | "lost";
  rotations?: Array<{ from: string; to: string; at: number; reason: string }>;
  recoveryPlan?: {
    stake: number; debt: number; horizonTicks: number | null; requiredSurvival: number;
    survival: number; survivalLower: number; performanceMultiple: number;
    viable: boolean; abandoned: boolean; reason: string;
  } | null;
  monitor?: {
    ticksSurvived: number; inBand: boolean; currentValue: number; profit: number;
    lambdaLive: number; lambdaLowerLive: number; flags: number;
    sprt: string; cusum: number; rateZ: number; lastDecision: string; lastReason: string;
  } | null;
}

const VERDICT_TONE: Record<string, string> = {
  CERTIFIED: "text-green-400 border-green-500/30 bg-green-500/10",
  QUALIFIED: "text-emerald-300 border-emerald-500/25 bg-emerald-500/10",
  WATCH: "text-amber-300 border-amber-500/30 bg-amber-500/10",
  REFUSED: "text-red-400 border-red-500/30 bg-red-500/10",
};

// ── Presentation helpers ─────────────────────────────────────────────────────

function Stat({ label, value, tone = "text-white" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-black/30 border border-white/5 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-[11px] font-mono font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function NumInput({
  label, value, onChange, min, step = 1, suffix, hint,
}: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; step?: number; suffix?: string; hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5 mt-0.5">
        <Input
          type="number"
          value={value}
          min={min}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-8 text-xs bg-black/30 border-white/10"
        />
        {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="text-[9px] text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

/**
 * The strategy, drawn. Grey line: the measured Kaplan–Meier survival curve.
 * Coloured line: expected value per unit staked, i.e. survival × payout − 1.
 * The marker is the horizon where the CONSERVATIVE curve peaks — past it the
 * payout compounds more slowly than the knockout odds grow, so holding longer
 * destroys value even on a certified market.
 */
function EvChart({ explain, accent }: { explain: ExplainResult; accent: string }) {
  const pts = explain.curve;
  if (pts.length < 2) return null;
  const W = 288;
  const H = 112;
  const maxT = pts[pts.length - 1].ticks || 1;
  const evs = pts.map((p) => p.ev);
  const lo = Math.min(-0.2, ...evs);
  const hi = Math.max(0.2, ...evs);
  const x = (t: number) => 6 + (t / maxT) * (W - 12);
  const y = (v: number) => H - 14 - ((v - lo) / (hi - lo)) * (H - 26);

  const evPath = pts
    .map((p, i) => `${i ? "L" : "M"}${x(p.ticks).toFixed(1)},${y(p.ev).toFixed(1)}`)
    .join(" ");
  const survPath = pts
    .map((p, i) => {
      // survival is on the same axis as EV after scaling by the payout multiple.
      const scaled = (p.survival * p.payoutMultiple - 1);
      return `${i ? "L" : "M"}${x(p.ticks).toFixed(1)},${y(scaled).toFixed(1)}`;
    })
    .join(" ");
  const zero = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[112px]">
      <line x1={6} x2={W - 6} y1={zero} y2={zero} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" />
      <path d={survPath} fill="none" stroke="rgba(148,163,184,0.7)" strokeWidth={1.2} />
      <path d={evPath} fill="none" stroke="currentColor" strokeWidth={1.8} className={accent} />
      {explain.optimalTicks > 0 && (
        <line
          x1={x(explain.optimalTicks)} x2={x(explain.optimalTicks)} y1={6} y2={H - 10}
          stroke="rgba(250,204,21,0.85)" strokeDasharray="2 2"
        />
      )}
      <text x={8} y={11} fontSize={8} fill="rgba(255,255,255,0.45)">EV per $1 staked</text>
      <text x={W - 56} y={11} fontSize={8} fill="rgba(148,163,184,0.8)">survival</text>
      <text x={W - 34} y={H - 2} fontSize={8} fill="rgba(255,255,255,0.35)">{maxT}t</text>
    </svg>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────

export function AccumulatorConsole({
  bot, open, onOpenChange, session, onSession,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const a = ACCENTS[bot?.accent ?? "teal"];
  const Icon = bot ? (BOT_ICON[bot.icon] ?? Activity) : Activity;

  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [explain, setExplain] = useState<ExplainResult | null>(null);
  const [params, setParams] = useState<{
    growthRates: number[];
    certainty: Array<{ id: string; label: string; description: string }>;
    tickCaps: Array<{ growthRate: number; maxTicks: number }>;
    markets: Array<{ symbol: string; displayName: string }>;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState({
    growthRate: 0.02,
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    certainty: "strict",
    marketMode: "switching" as "locked" | "switching",
    lockedSymbol: "R_10",
  });
  const set = <K extends keyof typeof config>(k: K, v: (typeof config)[K]) =>
    setConfig((prev) => ({ ...prev, [k]: v }));

  useEffect(() => {
    if (!settings) return;
    const s = settings as unknown as Record<string, unknown>;
    setConfig((prev) => ({
      ...prev,
      stake: (s.riskAmountValue as number) ?? prev.stake,
      maxRecoverySteps: (s.maxRecoverySteps as number) ?? prev.maxRecoverySteps,
    }));
  }, [settings]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/bots/accumulator/params")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setParams(d))
      .catch(() => undefined);
  }, [open]);

  const status = session as AccuStatus | null;
  const isRunning = status?.running === true && status?.botId === bot?.id;

  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScan(null);
    setExplain(null);
    setStep(isRunning ? "running" : "config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The accumulator emits its own richer frame; the page-level stream carries
  // the generic bot_update payload.
  useEffect(() => {
    if (!open) return;
    let es: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    function connect() {
      if (dead) return;
      es = new EventSource(withTabSession("/api/ai/events"));
      es.addEventListener("accumulator_update", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as AccuStatus;
          if (d.botId === "accumulator") onSession(d as unknown as BotSessionStatus);
        } catch { /* ignore */ }
      });
      es.onerror = () => {
        es.close();
        if (!dead) timer = setTimeout(connect, 2500);
      };
    }
    connect();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      es?.close();
    };
  }, [open, onSession]);

  const handleScan = useCallback(async () => {
    if (!bot) return;
    setLoading(true);
    setStep("scanning");
    try {
      const res = await fetch("/api/bots/accumulator/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          growthRate: config.growthRate,
          certainty: config.certainty,
          stake: config.stake,
        }),
      });
      const data = (await res.json()) as ScanResult;
      setScan(data);
      setSelected(data.best?.symbol ?? data.allScored[0]?.symbol ?? null);
      setStep("scan-result");
    } catch {
      setStep("config");
    } finally {
      setLoading(false);
    }
  }, [bot, config.growthRate, config.certainty, config.stake]);

  const handleExplain = useCallback(async (symbol: string) => {
    setSelected(symbol);
    setLoading(true);
    try {
      const res = await fetch("/api/bots/accumulator/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          growthRate: config.growthRate,
          certainty: config.certainty,
          stake: config.stake,
        }),
      });
      setExplain(res.ok ? ((await res.json()) as ExplainResult) : null);
    } catch {
      setExplain(null);
    } finally {
      setLoading(false);
    }
  }, [config.growthRate, config.certainty, config.stake]);

  const handleStart = useCallback(async () => {
    if (!bot) return;
    setLoading(true);
    try {
      const res = await fetch("/api/bots/accumulator/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          growthRate: config.growthRate,
          stake: config.stake,
          takeProfit: config.takeProfit,
          stopLoss: config.stopLoss,
          certainty: config.certainty,
          marketMode: config.marketMode,
          lockedSymbol: config.marketMode === "locked" ? config.lockedSymbol : undefined,
          recoveryAutoMode: true,
          maxRecoverySteps: config.maxRecoverySteps,
        }),
      });
      const data = await res.json();
      if (data.status) onSession(data.status as BotSessionStatus);
      if (data.error) return;
      setStep("running");
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [bot, config, onSession]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/accumulator/stop", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      onSession((data.status ?? null) as BotSessionStatus | null);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [onSession]);

  const tickCap = params?.tickCaps?.find((c) => Math.abs(c.growthRate - config.growthRate) < 1e-9)?.maxTicks
    ?? Math.round(230 * Math.pow(60 / 230, (config.growthRate - 0.01) / 0.04));
  const pBe = 1 / (1 + config.growthRate);
  const ranked = scan?.allScored ?? [];

  return (
    <AnimatePresence>
      {open && bot && (
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
            aria-label={`${bot.name} console`}
            className={`fixed bottom-20 right-4 z-50 w-[23rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
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
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}>
                      {bot.code}
                    </span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.tagline}</p>
                </div>
              </div>
              <button onClick={() => onOpenChange(false)} aria-label="Close console" className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* ── CONFIG ─────────────────────────────────────────────── */}
            {step === "config" && (
              <div className="space-y-4 p-4">
                <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                  <div className="flex items-center gap-2">
                    <Activity className={`w-3.5 h-3.5 ${a.text}`} />
                    <span className="text-[11px] font-semibold text-white">The compounding ladder</span>
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Barriers re-centre on the previous spot every tick. Survive a tick and the value
                    compounds by {(config.growthRate * 100).toFixed(0)} %; touch a barrier once and the whole stake
                    is gone — there is no partial payout to invert. Deriv cuts the band from the index's own
                    volatility so that survival is worth exactly {((pBe * 100)).toFixed(3)} % —
                    the break-even — which means the only edge is realised volatility coming in below the band.
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    <Stat label="Break-even p" value={pBe.toFixed(5)} />
                    <Stat label="Hold cap" value={`${tickCap}t`} />
                    <Stat label="Payout @ cap" value={`${Math.pow(1 + config.growthRate, tickCap).toFixed(1)}×`} tone={a.text} />
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <span className="text-[10px] text-muted-foreground">Growth rate (compounding per tick)</span>
                    <div className="flex gap-1 mt-1">
                      {(params?.growthRates ?? [0.01, 0.02, 0.03, 0.04, 0.05]).map((g) => (
                        <button
                          key={g}
                          onClick={() => set("growthRate", g)}
                          className={`flex-1 h-8 rounded-lg border text-[11px] font-bold transition ${
                            config.growthRate === g
                              ? `${a.solidBtn} text-white border-transparent`
                              : "border-white/10 text-muted-foreground hover:text-white hover:border-white/20"
                          }`}
                        >
                          {(g * 100).toFixed(0)}%
                        </button>
                      ))}
                    </div>
                    <p className="text-[9px] leading-snug text-muted-foreground mt-1">
                      Higher growth pays faster but needs a higher survival rate AND a shorter hold
                      (the cap shrinks from 230 ticks at 1 % to 60 ticks at 5 %).
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] text-muted-foreground">Certainty profile</span>
                    <div className="flex gap-1 mt-1">
                      {(params?.certainty ?? [
                        { id: "elite", label: "Elite" },
                        { id: "strict", label: "Strict (default)" },
                        { id: "balanced", label: "Balanced" },
                      ]).map((c) => (
                        <button
                          key={c.id}
                          title={(c as { description?: string }).description ?? c.label}
                          onClick={() => set("certainty", c.id)}
                          className={`flex-1 h-8 rounded-lg border text-[10px] font-semibold transition ${
                            config.certainty === c.id
                              ? `${a.solidBtn} text-white border-transparent`
                              : "border-white/10 text-muted-foreground hover:text-white hover:border-white/20"
                          }`}
                        >
                          {c.label.replace(" (default)", "")}
                        </button>
                      ))}
                    </div>
                    <p className="text-[9px] leading-snug text-muted-foreground mt-1">
                      {(params?.certainty ?? []).find((c) => c.id === config.certainty)?.description ??
                        "Bars the measurement must clear before a market may be traded."}
                    </p>
                  </div>

                  <div>
                    <span className="text-[10px] text-muted-foreground">Market mode</span>
                    <div className="flex gap-1 mt-1">
                      <button
                        onClick={() => set("marketMode", "locked")}
                        className={`flex-1 h-8 rounded-lg border text-[10px] font-semibold flex items-center justify-center gap-1.5 transition ${
                          config.marketMode === "locked"
                            ? `${a.solidBtn} text-white border-transparent`
                            : "border-white/10 text-muted-foreground hover:text-white"
                        }`}
                      >
                        <Lock className="w-3 h-3" /> Locked
                      </button>
                      <button
                        onClick={() => set("marketMode", "switching")}
                        className={`flex-1 h-8 rounded-lg border text-[10px] font-semibold flex items-center justify-center gap-1.5 transition ${
                          config.marketMode === "switching"
                            ? `${a.solidBtn} text-white border-transparent`
                            : "border-white/10 text-muted-foreground hover:text-white"
                        }`}
                      >
                        <Shuffle className="w-3 h-3" /> Auto-rotate
                      </button>
                    </div>
                    <p className="text-[9px] leading-snug text-muted-foreground mt-1">
                      {config.marketMode === "locked"
                        ? "Locked: stay on the market the scan certified — the bot will hold fire rather than leave it."
                        : "Auto-rotate: when the live monitors decide this market's survival no longer matches the reading it was opened on, the position is closed and every market is re-measured for a new home."}
                    </p>
                  </div>

                  {config.marketMode === "locked" && (
                    <label className="block">
                      <span className="text-[10px] text-muted-foreground">Locked market</span>
                      <select
                        value={config.lockedSymbol}
                        onChange={(e) => set("lockedSymbol", e.target.value)}
                        className="w-full h-8 mt-0.5 rounded-lg bg-black/30 border border-white/10 text-xs px-2 text-white"
                      >
                        {(params?.markets ?? [{ symbol: "R_10", displayName: "Volatility 10 Index" }]).map((m) => (
                          <option key={m.symbol} value={m.symbol}>{m.displayName}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  <NumInput label="Stake per position" value={config.stake} onChange={(v) => set("stake", v)} min={0.35} step={0.5} suffix="USD" />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={(v) => set("takeProfit", v)} min={1} step={1} suffix="USD" />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={(v) => set("stopLoss", v)} min={1} step={1} suffix="USD" />
                  <NumInput
                    label="Max recovery steps" value={config.maxRecoverySteps}
                    onChange={(v) => set("maxRecoverySteps", v)} min={1} step={1}
                    hint="Recovery buys a LONGER horizon at the same stake — never a bigger one."
                  />
                </div>

                <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2">
                  <p className="text-[9px] leading-relaxed text-amber-200/90">
                    Recovery works differently here. A knockout loses exactly the stake, so there is no
                    payout ratio to invert. The ledger computes the horizon
                    n* = ⌈ln(1 + debt/stake)/ln(1+g)⌉ and takes the shot only if the measured
                    survival curve clears (1+g)<sup>−n*</sup>. If n* runs past the {tickCap}-tick cap,
                    or the odds do not clear, the debt is written down rather than chased.
                  </p>
                </div>

                <Button onClick={handleScan} disabled={loading} className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Measure every market
                </Button>
                <button
                  onClick={() => void handleStart()}
                  disabled={loading}
                  className="w-full text-[10px] text-muted-foreground hover:text-white transition"
                >
                  or deploy now — the bot will hold fire until a market measures up
                </button>
              </div>
            )}

            {/* ── SCANNING ───────────────────────────────────────────── */}
            {step === "scanning" && (
              <div className="p-8 flex flex-col items-center gap-3">
                <Loader2 className={`w-7 h-7 animate-spin ${a.text}`} />
                <p className="text-xs text-muted-foreground">Measuring barriers across every automatable market…</p>
                <p className="text-[10px] text-muted-foreground/70 text-center leading-snug">
                  Each market is read out-of-sample, corrected with Benjamini–Hochberg, and refused
                  unless its survival beats break-even with the lower bound of its own interval.
                </p>
              </div>
            )}

            {/* ── SCAN RESULT ────────────────────────────────────────── */}
            {step === "scan-result" && scan && (
              <div className="space-y-3 p-4">
                <div className={`rounded-xl border px-3 py-2 ${scan.suitable ? "border-green-500/30 bg-green-500/10" : "border-amber-500/30 bg-amber-500/10"}`}>
                  <div className="flex items-center gap-2">
                    <TrendingUp className={`w-3.5 h-3.5 ${scan.suitable ? "text-green-400" : "text-amber-300"}`} />
                    <span className={`text-[11px] font-bold ${scan.suitable ? "text-green-400" : "text-amber-300"}`}>
                      {scan.suitable ? `Certified: ${scan.best?.displayName}` : "No market certified"}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{scan.reason}</p>
                  <div className="grid grid-cols-3 gap-1.5 mt-2">
                    <Stat label="Measured" value={String(scan.hypotheses)} />
                    <Stat label="Certified" value={String(scan.certified)} tone={scan.certified ? "text-green-400" : "text-red-400"} />
                    <Stat label="FDR gate" value={scan.fdrThreshold ? scan.fdrThreshold.toExponential(1) : "—"} />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-muted-foreground">Every measured market</span>
                    <span className="text-[9px] text-muted-foreground/70">p_be = {pBe.toFixed(5)} · λ = 1 is break-even</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
                    {ranked.map((c) => (
                      <button
                        key={`${c.symbol}-${c.growthRate}`}
                        onClick={() => void handleExplain(c.symbol)}
                        className={`w-full text-left px-2.5 py-2 hover:bg-white/[0.03] transition ${selected === c.symbol ? "bg-white/[0.05]" : ""}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] text-white font-semibold truncate">{c.displayName}</span>
                          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${VERDICT_TONE[c.verdict]}`}>
                            {c.verdict}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 text-[9px] font-mono text-muted-foreground">
                          <span>p̂={c.edge.p.toFixed(5)}</span>
                          <span className={c.edge.lambdaLower >= 1 ? "text-green-400" : "text-red-400"}>
                            λ={c.edge.lambda.toFixed(5)}
                          </span>
                          <span className={c.edge.volRatio >= 1 ? "text-green-400" : "text-red-400"}>
                            k={c.edge.volRatio.toFixed(3)}
                          </span>
                          <span>z={c.edge.zBreakEven.toFixed(2)}</span>
                          {c.optimalTicks > 0 && <span className="text-white/60">hold {c.optimalTicks}t</span>}
                          <span className="text-white/40">runs {c.markovRunLength.toFixed(0)}</span>
                        </div>
                      </button>
                    ))}
                    {ranked.length === 0 && (
                      <p className="px-3 py-4 text-[10px] text-muted-foreground">Nothing came back from the measurement pass.</p>
                    )}
                  </div>
                </div>

                {loading && (
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Loader2 className={`w-3.5 h-3.5 animate-spin ${a.text}`} /> Reading the survival curve…
                  </div>
                )}

                {explain && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center gap-2">
                      <LineChart className={`w-3.5 h-3.5 ${a.text}`} />
                      <span className="text-[11px] font-semibold text-white truncate">{explain.displayName} @ {(explain.growthRate * 100).toFixed(0)}%</span>
                      <span className={`ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded border ${VERDICT_TONE[explain.verdict] ?? ""}`}>
                        {explain.verdict}
                      </span>
                    </div>
                    <div className={a.text}>
                      <EvChart explain={explain} accent={a.text} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="σ band implies" value={explain.sigmaModel.toExponential(2)} />
                      <Stat label="σ measured" value={explain.sigmaReal.toExponential(2)} />
                      <Stat label="k = σm/σr" value={explain.volRatio.toFixed(4)} tone={explain.volRatio >= 1 ? "text-green-400" : "text-red-400"} />
                      <Stat label="Break-even p" value={explain.breakEvenSurvival.toFixed(5)} />
                      <Stat label="Measured p̂" value={explain.empiricalSurvival.toFixed(5)} tone={explain.empiricalSurvival >= explain.breakEvenSurvival ? "text-green-400" : "text-red-400"} />
                      <Stat label="Best horizon" value={explain.optimalTicks > 0 ? `${explain.optimalTicks}t` : "—"} />
                      <Stat label="λ" value={explain.lambda.toFixed(5)} tone={explain.lambda >= 1 ? "text-green-400" : "text-red-400"} />
                      <Stat label="λ lower" value={explain.lambdaLower.toFixed(5)} tone={explain.lambdaLower >= 1 ? "text-green-400" : "text-red-400"} />
                      <Stat label="k needed" value={explain.requiredVolRatio.toFixed(4)} />
                      <Stat label="Markov run" value={`${explain.markovRunLength.toFixed(1)}t`} />
                      <Stat
                        label="Vol clustering"
                        value={explain.clusteringZ.toFixed(2)}
                        tone={Math.abs(explain.clusteringZ) < 2 ? "text-white" : "text-amber-300"}
                      />
                      <Stat label="Horizon EV" value={`${explain.evMultiple.toFixed(3)}×`} tone={explain.evMultiple > 1 ? "text-green-400" : "text-red-400"} />
                    </div>
                    <p className="text-[9px] leading-relaxed text-muted-foreground">{explain.reason}</p>
                    <p className="text-[9px] leading-relaxed text-muted-foreground/70">
                      Grey: measured survival. Coloured: expected value per $1. The marker is the horizon
                      where the conservative EV peaks — past it the payout grows more slowly than the
                      knockout odds.
                    </p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                    Back
                  </Button>
                  <Button onClick={handleStart} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}>
                    {isRunning ? "View session" : "Deploy"}
                  </Button>
                </div>
                {!scan.suitable && (
                  <p className="text-[9px] text-amber-300/80 leading-snug text-center">
                    No market cleared the gate. Deploying now means the bot holds fire until one does —
                    which is the correct behaviour, not a failure.
                  </p>
                )}
              </div>
            )}

            {/* ── RUNNING ────────────────────────────────────────────── */}
            {step === "running" && (
              <div className="space-y-3 p-4">
                <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isRunning ? "bg-green-400 animate-pulse" : "bg-slate-500"}`} />
                      <span className="text-[11px] font-semibold text-white truncate">
                        {isRunning ? (status?.currentMarket ?? "Measuring…") : "Idle"}
                      </span>
                    </div>
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${a.badgeBg} ${a.text} flex-shrink-0`}>
                      {((status?.growthRate ?? config.growthRate) * 100).toFixed(0)}% / tick
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 mt-2">
                    <Stat label="Net" value={`${(status?.totalProfit ?? 0) >= 0 ? "+" : ""}$${(status?.totalProfit ?? 0).toFixed(2)}`} tone={(status?.totalProfit ?? 0) >= 0 ? "text-green-400" : "text-red-400"} />
                    <Stat label="Shots" value={`${status?.winCount ?? 0}W / ${status?.lossCount ?? 0}L`} />
                    <Stat label="Stake now" value={`$${(status?.currentStake ?? config.stake).toFixed(2)}`} />
                  </div>
                </div>

                {isRunning && (
                  <div className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Live position</span>
                      <span className={`text-[10px] font-mono ${(status?.monitor?.profit ?? 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {status?.currentValue != null ? `${status.currentValue.toFixed(4)}× ` : ""}
                        {(status?.monitor?.profit ?? status?.currentProfit ?? 0) >= 0 ? "+" : ""}
                        ${(status?.monitor?.profit ?? status?.currentProfit ?? 0).toFixed(2)}
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      <Stat
                        label="Ticks"
                        value={`${status?.monitor?.ticksSurvived ?? status?.ticksSurvived ?? 0}${status?.targetTicks ? `/${status.targetTicks}` : ""}`}
                      />
                      <Stat label="In band" value={status?.monitor?.inBand === false ? "NO" : "yes"} tone={status?.monitor?.inBand === false ? "text-red-400" : "text-green-400"} />
                      <Stat label="λ live" value={(status?.monitor?.lambdaLive ?? 0).toFixed(5)} tone={(status?.monitor?.lambdaLive ?? 0) >= 1 ? "text-green-400" : "text-amber-300"} />
                      <Stat label="Flags" value={String(status?.monitor?.flags ?? 0)} tone={(status?.monitor?.flags ?? 0) >= 2 ? "text-amber-300" : "text-white"} />
                    </div>
                    {(status?.monitor?.sprt || status?.monitor?.cusum !== undefined) && (
                      <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
                        <span>
                          SPRT:{" "}
                          <span className={
                            status?.monitor?.sprt === "accept_decayed" ? "text-red-400"
                              : status?.monitor?.sprt === "accept_fair" ? "text-green-400" : "text-white/70"
                          }>
                            {status?.monitor?.sprt ?? "continue"}
                          </span>
                        </span>
                        <span>CUSUM: <span className={(status?.monitor?.cusum ?? 0) > 0 ? "text-amber-300" : "text-white/70"}>{(status?.monitor?.cusum ?? 0).toFixed(2)}</span></span>
                        <span>z: <span className={(status?.monitor?.rateZ ?? 0) < -2 ? "text-amber-300" : "text-white/70"}>{(status?.monitor?.rateZ ?? 0).toFixed(2)}</span></span>
                      </div>
                    )}
                    {status?.monitor?.lastReason && (
                      <p className="text-[9px] leading-snug text-muted-foreground">{status.monitor.lastReason}</p>
                    )}
                  </div>
                )}

                {status?.recoveryPlan && (
                  <div className={`rounded-lg px-3 py-2 border text-[10px] space-y-1 ${
                    status.recoveryPlan.viable
                      ? "bg-amber-500/[0.08] border-amber-500/30 text-amber-200"
                      : "bg-red-500/[0.08] border-red-500/30 text-red-300"
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5" /> Recovery — step {status.recoveryStep ?? 0}
                      </span>
                      <span className="font-mono">${(status.recoveryPlan.debt ?? 0).toFixed(2)} debt</span>
                    </div>
                    <p className="leading-relaxed text-muted-foreground">
                      {status.recoveryPlan.horizonTicks
                        ? <>Horizon <span className="text-white">{status.recoveryPlan.horizonTicks}t</span> · needs survival ≥ {((status.recoveryPlan.requiredSurvival ?? 0) * 100).toFixed(2)} % · measured {((status.recoveryPlan.survivalLower ?? 0) * 100).toFixed(2)} %</>
                        : status.recoveryPlan.reason}
                    </p>
                  </div>
                )}

                {(status?.rotationCount ?? 0) > 0 && (
                  <div className="rounded-lg border border-sky-500/25 bg-sky-500/[0.07] px-3 py-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold text-sky-300 flex items-center gap-1.5">
                        <RefreshCw className="w-3.5 h-3.5" /> Market rotations
                      </span>
                      <span className="text-[9px] font-mono text-sky-400">
                        {status?.rotationCount} · bailed {status?.bailOutCount ?? 0}
                      </span>
                    </div>
                    {(status?.rotations ?? []).slice(-3).map((r, i) => (
                      <p key={`${r.at}-${i}`} className="text-[9px] leading-snug text-muted-foreground">
                        <span className="font-mono text-white/80">{r.from} → {r.to}</span> · {r.reason}
                      </p>
                    ))}
                  </div>
                )}

                {status?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    status.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400"
                      : status.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400"
                      : status.message.startsWith("🔁") ? "bg-sky-500/10 border-sky-500/25 text-sky-300"
                      : status.message.startsWith("🎯") ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
                      : status.message.startsWith("⚠️") ? "bg-amber-500/10 border-amber-500/25 text-amber-300"
                      : status.message.startsWith("⛔") ? "bg-red-500/10 border-red-500/25 text-red-300"
                      : "bg-secondary/30 border-border text-muted-foreground"
                  }`}>
                    {status.message}
                  </div>
                )}

                <div className="flex gap-2">
                  {isRunning ? (
                    <Button onClick={handleStop} disabled={loading} variant="destructive" className="flex-1 h-9 text-xs">
                      <StopCircle className="w-3.5 h-3.5 mr-1.5" /> Stop session
                    </Button>
                  ) : (
                    <>
                      <Button onClick={() => setStep("config")} variant="outline" className="flex-1 h-9 text-xs border-white/10">
                        New session
                      </Button>
                      <Button onClick={handleScan} disabled={loading} className={`flex-1 h-9 text-xs ${a.solidBtn} text-white font-bold`}>
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

export default AccumulatorConsole;
