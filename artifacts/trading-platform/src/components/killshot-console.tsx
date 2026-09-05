/**
 * Kill-Shot Oracle console.
 *
 * The bot makes the user take exactly two decisions — WHICH CONTRACT and HOW
 * MUCH PROOF — and then does everything else itself. The screen's whole job is
 * to make two things legible:
 *
 *   1. WHAT WAS MEASURED, before deploying. Not a promised win rate: the number
 *      the bot's own entry rule scored on ticks the model was never fitted on,
 *      next to the in-sample number so over-fitting is visible, with the
 *      e-value, the calibration skill and the effect of the post-loss shield.
 *
 *   2. WHAT IT IS WAITING FOR, while running. A sniper that is armed and holding
 *      is working correctly and has to READ as working correctly, so all four
 *      gates get their own row: HEALTH, EDGE, SHIELD, TICK.
 *
 * And when nothing is CERTIFIED, the console does not dead-end. It shows the
 * best market available with the exact reason it fell short, and lets the user
 * lock it deliberately behind a confirmation — or drop the bar, which is an
 * honest trade, not a hidden one.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Target,
  ChevronLeft, X, ShieldCheck, Eye, Crosshair, Lock, Activity, FlaskConical,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";

type Step = "config" | "scanning" | "scan-result" | "running";
type Kind = "over" | "under" | "match" | "even" | "odd";
type Certainty = "elite" | "strict" | "balanced";
type Verdict = "certified" | "qualified" | "watch" | "refused";

interface Contract { kind: Kind; digit?: number }

interface ModelCard {
  tau: number;
  platt: { a: number; b: number; brierSkill: number; logLossSkill: number; n: number };
  hmm: { pHot: number; pCold: number; stay: number; prior: number };
  breakEven: number;
  payout: number;
  minSpacing: number;
  postLossTightening: number;
  postLossCoolTicks: number;
  fittedOn: number;
}

interface Ledger {
  nShots: number;
  examined: number;
  fireRate: number;
  winRate: number;
  winRateLower: number;
  evPerDollar: number;
  evLowerPerDollar: number;
  longestLossRun: number;
  ladderBroke: boolean;
  meanPredicted: number;
  evidence: { e: number; peak: number; pValue: number; n: number };
  chain: { xi: number; xiUpper: number; clusterZ: number; q: number; pLoss: number; maxLossRun: number; pTwoInARow: number; pairBaseline: number };
}

interface Candidate {
  symbol: string;
  displayName: string;
  contract: Contract;
  label: string;
  certainty: Certainty;
  verdict: Verdict;
  confidence: number;
  edgePerDollar: number;
  breakEven: number;
  payout: number;
  marginalRate: number;
  samples: number;
  kellyFraction: number;
  detect: { fairRate: number; hurdlePP: number; snrPerShot: number; shotsToCertify: number; note: string };
  walk: {
    trainTicks: number;
    testTicks: number;
    tau: number;
    platt: { a: number; brierSkill: number; logLossSkill: number; n: number };
    train: Ledger;
    test: Ledger;
    shield: { suppressed: number; shieldedWinRate: number; shieldedShots: number; pairsBefore: number; pairsAfter: number; longestRunAfter: number };
    hmm: { pHot: number; pCold: number; stay: number };
  };
  ladder: { limit: number; safety: number; horizon: number; expectedShotsToBreak: number; byStakeCap: number; byStopLoss: number };
  card: ModelCard;
  blockers: string[];
  signals: string[];
  deployable: boolean;
  significant: boolean;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  bestAvailable: Candidate | null;
  allScored: Candidate[];
  reason: string;
  certainty: Certainty;
  marketsScanned: number;
  historyDepth: number;
  detect: { fairRate: number; breakEven: number; hurdlePP: number; snrPerShot: number; shotsToCertify: number; note: string };
}

/** The five mutually-exclusive contract choices. Never both sides of a pair. */
const KINDS: Array<{ id: Kind; label: string; help: string }> = [
  { id: "over",  label: "Over",    help: "Wins when the last digit is ABOVE your number" },
  { id: "under", label: "Under",   help: "Wins when the last digit is BELOW your number" },
  { id: "match", label: "Matches", help: "Wins when the last digit is exactly your number" },
  { id: "even",  label: "Even",    help: "Wins on 0, 2, 4, 6, 8" },
  { id: "odd",   label: "Odd",     help: "Wins on 1, 3, 5, 7, 9" },
];

const CERTAINTIES: Array<{ id: Certainty; title: string; desc: string }> = [
  { id: "elite",    title: "Elite",    desc: "~1.5% of ticks · 26+ unseen shots · break-even +3pp · e-value ≥ 40 · 90% ladder safety · FDR-corrected" },
  { id: "strict",   title: "Strict",   desc: "~2.5% of ticks · 18+ unseen shots · break-even +1.5pp · e-value ≥ 12 · 80% ladder safety" },
  { id: "balanced", title: "Balanced", desc: "~4% of ticks · 12+ unseen shots · thinner but still positive measured expectancy" },
];

const VERDICT_TONE: Record<Verdict, { text: string; bg: string; border: string; label: string }> = {
  certified: { text: "text-green-400",  bg: "bg-green-500/10",  border: "border-green-500/30",  label: "CERTIFIED" },
  qualified: { text: "text-sky-300",    bg: "bg-sky-500/10",    border: "border-sky-500/30",    label: "QUALIFIED" },
  watch:     { text: "text-amber-300",  bg: "bg-amber-500/10",  border: "border-amber-500/30",  label: "WATCH" },
  refused:   { text: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/30",    label: "REFUSED" },
};

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

export function KillShotConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 19,
  });
  const { data: settings } = useGetSettings();

  const [certainty, setCertainty] = useState<Certainty>("strict");
  const [kind, setKind] = useState<Kind>("over");
  const [digit, setDigit] = useState<number>(7);
  /** For Matches only: let the AI pick the digit. */
  const [aiDigit, setAiDigit] = useState(true);

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    maxShots: 0,
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

  const isRunning = session?.running === true && session.botId === "killshot";

  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setConfirmForce(false);
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
      es = new EventSource("/api/ai/events");
      es.addEventListener("bot_update", (e: MessageEvent) => {
        try { applyStatus(JSON.parse(e.data) as BotSessionStatus); } catch { /* ignore */ }
      });
      es.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const p = JSON.parse(e.data);
          if (p.botId !== "killshot") return;
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
  const Icon = BOT_ICON[bot.icon] ?? Crosshair;

  const activeKind = KINDS.find(k => k.id === kind)!;
  const contractPayload = (): Contract => {
    if (kind === "even" || kind === "odd") return { kind };
    if (kind === "match") return aiDigit ? { kind: "match" } : { kind: "match", digit };
    return { kind, digit };
  };
  const contractLabel = () => {
    if (kind === "even") return "Even";
    if (kind === "odd") return "Odd";
    if (kind === "match") return aiDigit ? "Matches (AI picks the digit)" : `Matches ${digit}`;
    return `${kind === "over" ? "Over" : "Under"} ${digit}`;
  };

  // Over 9 and Under 0 can never win — the picker must not offer them.
  const digitRange = kind === "over" ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
    : kind === "under" ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
    : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setConfirmForce(false);
    setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch("/api/bots/killshot/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: contractPayload(), certainty, ...config }),
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

  const handleStart = async (c: Candidate, forced = false) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/killshot/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol, contract: c.contract, analysis: c, card: c.card, certainty, forced, ...config,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(`🔒 Locked on ${c.displayName} · ${c.label} — the market will not change`);
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/killshot/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Kill-Shot session stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;
  const watch = session?.watch;
  const lock = session?.killshotLock;

  /** The measurement card — the same layout whether the verdict is good or bad. */
  const MeasurementCard = ({ c }: { c: Candidate }) => {
    const v = VERDICT_TONE[c.verdict];
    const t = c.walk.test;
    return (
      <div className={`rounded-xl border ${v.border} ${v.bg} p-3 space-y-2`}>
        <div className="flex items-center justify-between">
          <p className={`text-[10px] uppercase tracking-widest font-semibold ${v.text} flex items-center gap-1.5`}>
            <Lock className="w-3 h-3" /> {v.label} · {c.displayName}
          </p>
          <span className="text-[10px] font-mono text-muted-foreground">{c.confidence}/100</span>
        </div>

        <div className="rounded-lg bg-black/30 border border-white/10 px-2.5 py-2">
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
            Measured on {c.walk.testTicks.toLocaleString()} ticks the model never saw
          </p>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className={`text-xl font-mono font-bold ${t.winRate >= c.breakEven ? "text-green-400" : "text-red-400"}`}>
              {(t.winRate * 100).toFixed(1)}%
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">
              over {t.nShots} shots · floor {(t.winRateLower * 100).toFixed(1)}% · break-even {(c.breakEven * 100).toFixed(1)}%
            </span>
          </div>
          <p className="text-[9px] font-mono text-muted-foreground/70 mt-1">
            in-sample was {(c.walk.train.winRate * 100).toFixed(1)}% over {c.walk.train.nShots} shots
            {" — "}the gap between the two is the over-fitting you would otherwise pay for
          </p>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="Contract (frozen)" value={c.label} tone={a.text} />
          <Stat label="Expectancy / $1"
                value={`${c.edgePerDollar >= 0 ? "+" : ""}${(c.edgePerDollar * 100).toFixed(2)}%`}
                tone={c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Evidence (e-value)"
                value={t.evidence.peak >= 1000 ? `${(t.evidence.peak / 1000).toFixed(1)}k` : t.evidence.peak.toFixed(1)}
                tone={t.evidence.peak >= 12 ? "text-green-400" : "text-amber-300"} />
          <Stat label="Calibration skill"
                value={`${(c.walk.platt.brierSkill * 100).toFixed(2)}%`}
                tone={c.walk.platt.brierSkill > 0 ? "text-green-400" : "text-red-400"} />
          <Stat label="Entry bar τ" value={`${c.walk.tau.toFixed(2)}σ`} />
          <Stat label="Selectivity" value={`${(t.fireRate * 100).toFixed(2)}% of ticks`} />
          <Stat label="Ladder safety"
                value={`${(c.ladder.safety * 100).toFixed(1)}%`}
                tone={c.ladder.safety >= 0.85 ? "text-green-400" : "text-amber-300"} />
          <Stat label="Absorbs"
                value={`${c.ladder.limit} loss${c.ladder.limit === 1 ? "" : "es"} in a row`}
                tone={c.ladder.limit >= 3 ? "text-green-400" : "text-amber-300"} />
          <Stat label="Loss pairs (shield)"
                value={`${c.walk.shield.pairsBefore} → ${c.walk.shield.pairsAfter}`}
                tone={c.walk.shield.pairsAfter <= c.walk.shield.pairsBefore ? "text-green-400" : "text-amber-300"} />
          <Stat label="Loss pairing ξ" value={c.walk.test.chain.xi.toFixed(2)}
                tone={c.walk.test.chain.xi <= 1 ? "text-green-400" : "text-amber-300"} />
          <Stat label="History used" value={`${c.samples.toLocaleString()} digits`} />
          <Stat label="Kelly at floor" value={`${(c.kellyFraction * 100).toFixed(1)}%`} />
        </div>
      </div>
    );
  };

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
            aria-label="Kill-Shot Oracle console"
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
                    <FlaskConical className="w-3 h-3" /> How this bot works
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Pick <span className="text-white/80">one contract</span> — it never changes. The AI pulls
                    <span className="text-white/80"> 4,999 real digits</span> from every market, fits a five-model
                    ensemble on the first half, then <span className="text-white/80">measures its own entry rule on
                    the second half it has never seen</span>. The best measured market is
                    <span className="text-white/80"> locked</span> — no switching, no rotation — and the bot waits
                    for health, edge, the post-loss shield and the tick to all agree before taking one shot.
                  </p>
                </div>

                {/* Contract choice — exactly one, never both sides */}
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Your Contract — pick exactly one
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {KINDS.map(k => (
                      <button
                        key={k.id}
                        onClick={() => {
                          setKind(k.id);
                          if (k.id === "over" && digit > 8) setDigit(7);
                          if (k.id === "under" && digit < 1) setDigit(2);
                        }}
                        className={`px-2 py-2 rounded-lg text-[11px] font-semibold transition-colors ${
                          kind === k.id
                            ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                        }`}
                      >
                        {k.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-muted-foreground/70 leading-relaxed">{activeKind.help}</p>
                </div>

                {/* Digit picker */}
                {(kind === "over" || kind === "under" || (kind === "match" && !aiDigit)) && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Digit</p>
                    <div className="grid grid-cols-5 gap-1">
                      {digitRange.map(d => (
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

                {kind === "match" && (
                  <button
                    onClick={() => setAiDigit(v => !v)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] text-left transition-colors ${
                      aiDigit ? `${a.activeBg} border ${a.activeBorder}` : "bg-white/[0.03] border border-white/5"
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                      aiDigit ? `${a.dot} border-transparent` : "border-white/20"
                    }`}>
                      {aiDigit && <span className="text-[8px] text-black font-bold">✓</span>}
                    </span>
                    <span className={aiDigit ? a.text : "text-muted-foreground"}>
                      Let the AI choose the digit — all ten scored in every market, FDR-corrected
                    </span>
                  </button>
                )}

                {/* Certainty bar */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Proof Required
                  </p>
                  <div className="space-y-1.5">
                    {CERTAINTIES.map(c => (
                      <button
                        key={c.id}
                        onClick={() => setCertainty(c.id)}
                        className={`w-full px-2.5 py-2 rounded-lg text-left transition-colors ${
                          certainty === c.id
                            ? `${a.activeBg} border ${a.activeBorder}`
                            : "bg-white/[0.03] border border-white/5 hover:bg-white/[0.07]"
                        }`}
                      >
                        <p className={`text-[11px] font-semibold ${certainty === c.id ? a.text : "text-muted-foreground"}`}>
                          {c.title}
                        </p>
                        <p className="text-[9px] text-muted-foreground/70 leading-snug mt-0.5">{c.desc}</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
                    This sets HOW PICKY the entry rule is and HOW MUCH PROOF the market must show. The threshold is
                    a quantile of the model's own live edge distribution, so every market keeps producing shots to
                    judge — the measurement decides, never the threshold. The scan never dead-ends: if nothing is
                    certified it shows the best market available and exactly what it fell short on.
                  </p>
                </div>

                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg}`}>
                  <p className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Selected</p>
                  <p className={`text-sm font-bold ${a.text}`}>{contractLabel()}</p>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session Boundaries</p>
                  <NumInput label="Stake per shot" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} step={1} accent={bot.accent} />
                  <NumInput label="Max shots (0 = unlimited)" value={config.maxShots} onChange={v => set("maxShots", v)} min={0} step={1} accent={bot.accent} />
                </div>

                <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
                  Your stake, stop loss and stake cap decide how many consecutive losses the shared recovery ladder
                  can absorb — the scan computes that number exactly, before you deploy.
                </p>

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Measure Every Market for {contractLabel()}
                </Button>
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Fitting, then measuring out of sample</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `${progress.scanning} — pulling 4,999 digits…` : "Preparing…"}
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
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <MeasurementCard c={scanResult.best} />

                    <div className="rounded-xl bg-black/25 border border-white/5 p-2.5 space-y-1">
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Evidence stack</p>
                      {scanResult.best.signals.filter(s => !s.startsWith("⛔")).slice(0, 8).map((s, i) => (
                        <p key={i} className="text-[10px] font-mono text-muted-foreground leading-relaxed">· {s}</p>
                      ))}
                    </div>

                    <Button onClick={() => handleStart(scanResult.best!)} disabled={loading}
                            className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                      <Target className="w-4 h-4 mr-2" />
                      Lock {scanResult.best.displayName} — {scanResult.best.label}
                    </Button>
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                        <p className="text-xs font-semibold text-amber-300">
                          Nothing Certified at the {certainty.charAt(0).toUpperCase() + certainty.slice(1)} Bar
                        </p>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                      {scanResult.bestAvailable && scanResult.bestAvailable.blockers.length > 0 && (
                        <div className="space-y-0.5 pt-1">
                          {scanResult.bestAvailable.blockers.slice(0, 4).map((b, i) => (
                            <p key={i} className="text-[10px] font-mono text-amber-200/70 leading-relaxed">⛔ {b}</p>
                          ))}
                        </div>
                      )}
                      <p className="text-[9px] font-mono text-muted-foreground/60 pt-1">
                        {scanResult.historyDepth.toLocaleString()} digits per market · {scanResult.marketsScanned} markets ·
                        {" "}{scanResult.detect.note}
                      </p>
                    </div>

                    {/* The best market available is always shown — never a dead end. */}
                    {scanResult.bestAvailable && (
                      <>
                        <MeasurementCard c={scanResult.bestAvailable} />
                        {scanResult.bestAvailable.verdict !== "refused" && (
                          confirmForce ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
                              <p className="text-[11px] text-amber-200 leading-relaxed">
                                This market did not clear the {certainty} bar. Its measured expectancy is
                                {" "}<span className="font-mono font-bold">
                                  {scanResult.bestAvailable.edgePerDollar >= 0 ? "+" : ""}
                                  {(scanResult.bestAvailable.edgePerDollar * 100).toFixed(2)}%
                                </span>{" "}per $1 on {scanResult.bestAvailable.walk.test.nShots} unseen shots.
                                Locking it is a deliberate decision, not a recommendation.
                              </p>
                              <div className="flex gap-2">
                                <Button onClick={() => setConfirmForce(false)} variant="outline"
                                        className="flex-1 h-8 text-[11px] border-white/10">Cancel</Button>
                                <Button onClick={() => handleStart(scanResult.bestAvailable!, true)} disabled={loading}
                                        className="flex-1 h-8 text-[11px] bg-amber-600 hover:bg-amber-500 text-white font-bold">
                                  Lock it anyway
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <Button onClick={() => setConfirmForce(true)} variant="outline"
                                    className="w-full h-9 border-amber-500/30 text-amber-300 hover:bg-amber-500/10 text-[11px] font-semibold">
                              Lock this market deliberately
                            </Button>
                          )
                        )}
                      </>
                    )}

                    {certainty !== "balanced" && (
                      <Button onClick={() => { setCertainty("balanced"); }} variant="outline"
                              className={`w-full h-8 ${a.outlineBtn} text-[11px]`}>
                        Drop to the Balanced bar and re-measure
                      </Button>
                    )}
                  </div>
                )}

                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">All markets measured</p>
                    {scanResult.allScored.slice(0, 8).map((c, i) => (
                      <button key={i} onClick={() => c.deployable && handleStart(c)} disabled={loading || !c.deployable}
                              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] hover:bg-white/[0.07] disabled:opacity-50 text-left">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          c.verdict === "certified" ? "bg-green-400"
                            : c.verdict === "qualified" ? "bg-sky-400"
                            : c.verdict === "watch" ? "bg-amber-400" : "bg-red-400"
                        }`} />
                        <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">
                          {(c.walk.test.winRate * 100).toFixed(0)}%/{c.walk.test.nShots}
                        </span>
                        <span className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {c.edgePerDollar >= 0 ? "+" : ""}{(c.edgePerDollar * 100).toFixed(1)}%
                        </span>
                      </button>
                    ))}
                    <p className="text-[9px] text-muted-foreground/60 px-1 leading-relaxed">
                      Columns: out-of-sample accuracy / shots, then measured expectancy per $1. Dot = verdict.
                    </p>
                  </div>
                )}

                <Button onClick={handleScan} disabled={loading} variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-Measure
                </Button>
                <button onClick={() => setStep("config")}
                        className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Change contract or risk
                </button>
              </div>
            )}

            {/* RUNNING */}
            {step === "running" && (
              <div className="p-4 space-y-3">
                {/* RESCAN ALERT — the one thing that must never be quiet */}
                {session?.needsRescan && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 space-y-2"
                  >
                    <p className="text-[11px] font-bold text-red-300 flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5" /> RESCAN REQUIRED
                    </p>
                    <p className="text-[10px] text-red-200/80 leading-relaxed">
                      {watch?.health.note || "The locked market has moved away from the regime it was measured in."}
                      {" "}The bot is holding fire and will not switch markets on its own.
                    </p>
                    <Button onClick={async () => { await handleStop(); setStep("config"); }}
                            className="w-full h-8 bg-red-600 hover:bg-red-500 text-white text-[11px] font-bold">
                      Stop and re-analyse
                    </Button>
                  </motion.div>
                )}

                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                        {watch?.phase === "armed" ? "ARMED" : watch?.phase === "firing" ? "FIRING" : "LOCKED · WAITING"}
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
                    <span className="text-muted-foreground">deepest run {session?.deepestLossRun ?? 0}</span>
                  </div>
                </div>

                {/* THE SCOPE — four gates, each its own row */}
                {isRunning && watch && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2.5`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                        {watch.phase === "watching" ? <Eye className="w-3 h-3" /> : <Crosshair className="w-3 h-3" />}
                        {watch.phase === "watching" ? "Watching · holding fire"
                          : watch.phase === "armed" ? "Armed · waiting for the tick"
                          : watch.phase === "firing" ? "Firing" : "Settling"}
                      </p>
                      <span className="text-[9px] font-mono text-muted-foreground/70">
                        {watch.ticksWatched} ticks · {watch.setupsRejected} declined
                      </span>
                    </div>

                    {/* Gate 1 — health */}
                    <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">1 · Market health</p>
                        <span className={`text-[9px] font-mono font-bold ${
                          watch.health.needsRescan ? "text-red-400" : watch.blockers.length === 0 ? "text-green-400" : "text-amber-300"
                        }`}>
                          {watch.verdict?.toUpperCase() ?? "—"} · PH {watch.health.ph.toFixed(1)}/{watch.health.threshold}
                        </span>
                      </div>
                      {watch.blockers.length > 0
                        ? watch.blockers.map((b, i) => (
                            <p key={i} className="text-[10px] font-mono text-amber-200/70 leading-relaxed">· {b}</p>
                          ))
                        : <p className="text-[10px] font-mono text-muted-foreground">Live read still matches the locked measurement.</p>}
                    </div>

                    {/* Gate 2 — edge */}
                    <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">2 · Edge</p>
                        <span className={`text-[9px] font-mono font-bold ${watch.marginZ >= 0 ? "text-green-400" : "text-amber-300"}`}>
                          {watch.z.toFixed(2)}σ / {watch.bar.toFixed(2)}σ
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                        <div className={`h-full ${watch.marginZ >= 0 ? "bg-green-400" : a.dot} transition-all duration-700`}
                             style={{ width: `${Math.max(2, Math.min(100, watch.bar > 0 ? (watch.z / watch.bar) * 100 : 0))}%` }} />
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        P(win|context) {(watch.p * 100).toFixed(1)}% · raw edge {watch.edgeZ?.toFixed(2) ?? "—"}σ · lead model {watch.leader} (order {watch.contextOrder}, n {watch.contextCount}) · regime hot {(watch.regimeHot * 100).toFixed(0)}%
                      </p>
                      {watch.experts.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {watch.experts.map(e => (
                            <span key={e.name} className="text-[8px] font-mono px-1 py-0.5 rounded bg-white/5 text-muted-foreground/70">
                              {e.name.replace("-", " ")} {(e.p * 100).toFixed(0)}% ·w{(e.weight * 100).toFixed(0)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Gate 3 — post-loss shield */}
                    <div className={`rounded-lg border p-2 space-y-1 ${
                      watch.shield.active ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-white/10 bg-black/30"
                    }`}>
                      <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">3 · Post-loss shield</p>
                        <span className={`text-[9px] font-mono font-bold ${watch.shield.active ? "text-amber-300" : "text-green-400"}`}>
                          {watch.shield.active ? `+${watch.shield.barBoost.toFixed(2)}σ` : "IDLE"}
                        </span>
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        {watch.shield.active
                          ? `Loss run ${watch.shield.lossRun} — bar raised ${watch.shield.barBoost.toFixed(2)}σ, cool-down ${Math.min(watch.shield.ticksSinceLoss, watch.shield.coolTicks)}/${watch.shield.coolTicks} ticks. This is the rule the scan simulated.`
                          : "No open loss run. The shield engages the moment a shot misses."}
                      </p>
                    </div>

                    {/* Gate 4 — the tick */}
                    <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">4 · Entry tick</p>
                        <span className={`text-[9px] font-mono font-bold ${watch.entry.ready ? "text-green-400" : "text-amber-300"}`}>
                          {watch.entry.score}/100
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
                        <div className={`h-full transition-all duration-500 ${watch.entry.ready ? "bg-green-400" : "bg-amber-400"}`}
                             style={{ width: `${Math.max(2, watch.entry.score)}%` }} />
                      </div>
                      <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                        {watch.entry.reason || "Waiting for the health and edge gates to clear first."}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="Short-run momentum"
                              value={`${watch.entry.momentumPP >= 0 ? "+" : ""}${watch.entry.momentumPP.toFixed(1)}pp`}
                              tone={watch.entry.momentumPP >= 0 ? "text-green-400" : "text-amber-300"} />
                        <Stat label="Renewal position" value={`${watch.entry.gapRatio.toFixed(2)}× due`} />
                        <Stat label="Favoured state"
                              value={watch.entry.preferredState === "none" ? "neutral" : watch.entry.preferredState}
                              tone={watch.entry.preferredState === "none" ? undefined : a.text} />
                        <Stat label="Frozen τ" value={`${watch.tau.toFixed(2)}σ`} />
                      </div>
                    </div>
                  </div>
                )}

                {lock && (
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                      <Lock className="w-3 h-3" /> Frozen lock · no switching, no rotation
                      {lock.forced && <span className="text-amber-300 font-mono">· forced</span>}
                    </p>
                    <p className="text-xs font-bold text-white">{lock.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Contract (frozen)" value={lock.contract} tone={a.text} />
                      <Stat label="Verdict at lock" value={lock.verdict.toUpperCase()}
                            tone={lock.verdict === "certified" ? "text-green-400" : "text-sky-300"} />
                      <Stat label="Out-of-sample" value={`${(lock.oosWinRate * 100).toFixed(1)}% / ${lock.oosShots}`} tone="text-green-400" />
                      <Stat label="Measured on" value={`${lock.oosTicks.toLocaleString()} unseen ticks`} />
                      <Stat label="Expectancy / $1"
                            value={`${lock.edgePerDollar >= 0 ? "+" : ""}${(lock.edgePerDollar * 100).toFixed(2)}%`}
                            tone={lock.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
                      <Stat label="e-value" value={lock.evidenceE >= 1000 ? `${(lock.evidenceE / 1000).toFixed(1)}k` : lock.evidenceE.toFixed(1)} />
                      <Stat label="Ladder safety" value={`${(lock.ladderSafety * 100).toFixed(1)}%`} tone={a.text} />
                      <Stat label="Absorbs" value={`${lock.ladderLimit} in a row`} />
                      <Stat label="Loss pairs (shield)" value={`${lock.pairsBefore} → ${lock.pairsAfter}`} tone="text-green-400" />
                      <Stat label="Loss pairing ξ" value={lock.xi.toFixed(2)}
                            tone={lock.xi <= 1 ? "text-green-400" : "text-amber-300"} />
                    </div>
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" :
                    session.message.startsWith("⚠️") ? "bg-red-500/10 border-red-500/25 text-red-300" :
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
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                        Recovery (Step {session.recoveryStep})
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Same shared ledger and same debt-driven stake formula as every other bot in this section — and
                      the recovery shot carries one EXTRA step of post-loss tightening on top. The debt is already
                      geometric; a hurried recovery entry is exactly what turns two losses into five.
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
                        <Activity className="w-3.5 h-3.5 mr-1.5" /> Re-Measure
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

export default KillShotConsole;
