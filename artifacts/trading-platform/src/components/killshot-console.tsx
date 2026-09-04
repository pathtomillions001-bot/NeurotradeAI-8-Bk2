/**
 * Kill-Shot Precision Sniper console.
 *
 * A third interaction model, because the bot is a third kind of thing. The five
 * generalists are cockpits and the Dual-Lock is a monitor; this one is a
 * SCOPE. The user's job is a single decision — which contract — plus one about
 * how the market is chosen: HUNT (default) re-scans every digit market
 * continuously and moves to the strongest one, LOCK freezes a single market for
 * the session.
 *
 * The screen's job is to make the waiting legible, and the waiting now has two
 * distinct phases that must not be confused: the EVIDENCE bar (is there an edge
 * at all?) and the ENTRY bar (is this the tick to be in on?). A bot that is
 * armed but holding for a better entry is working correctly, and the UI has to
 * say so clearly or the user will think it is broken.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Target,
  ChevronLeft, X, ShieldCheck, Eye, Crosshair, Lock,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";

type Step = "config" | "scanning" | "scan-result" | "running";
type Kind = "over" | "under" | "match" | "even" | "odd";

interface Contract { kind: Kind; digit?: number }

interface Candidate {
  symbol: string;
  displayName: string;
  contract: Contract;
  label: string;
  confidence: number;
  pWin: number;
  pLower: number;
  breakEven: number;
  payout: number;
  expectedValue: number;
  sprt: { logLR: number; upper: number; decision: string; oddsForEdge: number; progress: number; expectedRemaining: number };
  loss: { clusterRatio: number; pTwoInARow: number; maxLossRun: number; expectedMaxRun: number };
  concordance: { agreeing: number; total: number; spread: number };
  samples: number;
  /** prime | standard | marginal — the evidence bar this candidate met. */
  tier: "prime" | "standard" | "marginal";
  /** Win rate of an unbiased stream on this contract. */
  fairRate: number;
  /** The rate the SPRT must be convinced of. */
  requiredRate: number;
  /** fairRate − breakEven in percentage points (the house margin, negated). */
  headroomPP: number;
  /** P(two losses in a row) if losses were independent — the comparison basis. */
  pairBaseline: number;
  deployable: boolean;
  blockers: string[];
  signals: string[];
  significant: boolean;
}

interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  allScored: Candidate[];
  reason: string;
}

/** The five mutually-exclusive contract choices. Never both sides of a pair. */
const KINDS: Array<{ id: Kind; label: string; help: string; needsDigit: boolean }> = [
  { id: "over",  label: "Over",    help: "Wins when the last digit is ABOVE your number",  needsDigit: true },
  { id: "under", label: "Under",   help: "Wins when the last digit is BELOW your number",  needsDigit: true },
  { id: "match", label: "Matches", help: "Wins when the last digit is exactly your number", needsDigit: false },
  { id: "even",  label: "Even",    help: "Wins on 0, 2, 4, 6, 8",                           needsDigit: false },
  { id: "odd",   label: "Odd",     help: "Wins on 1, 3, 5, 7, 9",                           needsDigit: false },
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
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 19,
  });
  const { data: settings } = useGetSettings();

  /** hunt = rotate markets continuously (default); lock = freeze one market. */
  const [targetMode, setTargetMode] = useState<"hunt" | "lock">("hunt");
  const [kind, setKind] = useState<Kind>("over");
  const [digit, setDigit] = useState<number>(7);
  /** For Matches only: let the AI pick the digit. */
  const [aiDigit, setAiDigit] = useState(true);

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    maxTrades: 0,
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
  const Icon = BOT_ICON[bot.icon] ?? Target;

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
    setProgress({ scanning: null, scanned: 0, total: 19 });
    try {
      const res = await fetch("/api/bots/killshot/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: contractPayload() }),
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

  const handleStart = async (c: Candidate) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/killshot/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: c.symbol, contract: c.contract, analysis: c, targetMode, ...config }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(targetMode === "hunt"
        ? `🎯 Hunting with ${c.displayName} · ${c.label} as the opening market`
        : `🎯 Locked on ${c.displayName} · ${c.label}`);
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  /**
   * Deploy straight into hunt mode with no pre-scan. The market is only the
   * opening target — the loop re-selects it continuously — so a scan is no
   * longer a prerequisite for running the bot.
   */
  const handleStartHunt = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/killshot/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract: contractPayload(), targetMode: "hunt", ...config }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(`🎯 Hunting every digit market for ${contractLabel()}`);
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
  const hunt = session?.hunt;

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
            aria-label="Kill-Shot Precision Sniper console"
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
                    <Crosshair className="w-3 h-3" /> How this bot works
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Pick <span className="text-white/80">one contract</span> — that never changes. Then
                    choose how the <span className="text-white/80">market</span> is picked: hunt every
                    digit market continuously, or freeze one. Pressing run never trades immediately: the
                    bot waits for conclusive evidence <span className="text-white/80">and</span> for a
                    good entry tick, and only then fires.
                  </p>
                </div>

                {/* Market selection mode — the contract is frozen either way */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Market Selection
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      { id: "hunt" as const, title: "Hunt", desc: "Re-scans every digit market and moves to the strongest one" },
                      { id: "lock" as const, title: "Lock", desc: "Freeze one market for the whole session" },
                    ]).map(m => (
                      <button
                        key={m.id}
                        onClick={() => setTargetMode(m.id)}
                        className={`px-2 py-2 rounded-lg text-left transition-colors ${
                          targetMode === m.id
                            ? `${a.activeBg} border ${a.activeBorder}`
                            : "bg-white/[0.03] border border-white/5 hover:bg-white/[0.07]"
                        }`}
                      >
                        <p className={`text-[11px] font-semibold ${targetMode === m.id ? a.text : "text-muted-foreground"}`}>
                          {m.title}
                        </p>
                        <p className="text-[9px] text-muted-foreground/70 leading-snug mt-0.5">{m.desc}</p>
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-muted-foreground/70 leading-relaxed">
                    {targetMode === "hunt"
                      ? "Hunt mode keeps the same gates — it just stops the bot sitting on a market that has gone quiet. It never rotates while a recovery ladder is open."
                      : "Lock mode is the original behaviour: the market the scan returns is the only market this session will ever touch."}
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
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Digit
                    </p>
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
                      Let the AI choose the digit — it scores all ten in every market
                    </span>
                  </button>
                )}

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
                  <NumInput label="Max shots (0 = unlimited)" value={config.maxTrades} onChange={v => set("maxTrades", v)} min={0} step={1} accent={bot.accent} />
                </div>

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Find the Best Market for {contractLabel()}
                </Button>

                {targetMode === "hunt" && (
                  <Button onClick={handleStartHunt} disabled={loading} variant="outline"
                          className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                    <Target className="w-3.5 h-3.5 mr-2" /> Start Hunting Now — no scan needed
                  </Button>
                )}
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Hunting for a kill-shot setup</p>
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
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                      <div className="flex items-center justify-between">
                        <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>Kill-Shot Target</p>
                        <span className="text-[10px] font-mono text-green-400">
                          {scanResult.best.confidence}% confidence
                        </span>
                      </div>
                      <p className="text-sm font-bold text-white">{scanResult.best.displayName}</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat label="Contract" value={scanResult.best.label} tone={a.text} />
                        <Stat label="Win rate" value={`${(scanResult.best.pWin * 100).toFixed(1)}%`} tone="text-green-400" />
                        <Stat label="Worst case (valid)" value={`${(scanResult.best.pLower * 100).toFixed(1)}%`} />
                        <Stat label="Break-even" value={`${(scanResult.best.breakEven * 100).toFixed(1)}%`} />
                        <Stat label="Evidence odds" value={`${scanResult.best.sprt.oddsForEdge.toFixed(0)}:1`} tone={a.text} />
                        <Stat label="Evidence bar" value={scanResult.best.tier.toUpperCase()}
                              tone={scanResult.best.tier === "prime" ? "text-green-400" : "text-cyan-300"} />
                        <Stat label="EV per $1"
                              value={`${scanResult.best.expectedValue >= 0 ? "+" : ""}${(scanResult.best.expectedValue * 100).toFixed(1)}%`}
                              tone={scanResult.best.expectedValue > 0 ? "text-green-400" : "text-red-400"} />
                        <Stat label="Losses pair vs random"
                              value={`${(scanResult.best.loss.pTwoInARow * 100).toFixed(1)}% / ${(scanResult.best.pairBaseline * 100).toFixed(1)}%`}
                              tone={scanResult.best.loss.pTwoInARow <= scanResult.best.pairBaseline ? "text-green-400" : "text-amber-300"} />
                      </div>
                    </div>

                    <div className="rounded-xl bg-black/25 border border-white/5 p-2.5 space-y-1">
                      <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Evidence stack</p>
                      {scanResult.best.signals.slice(0, 7).map((s, i) => (
                        <p key={i} className="text-[10px] font-mono text-muted-foreground leading-relaxed">· {s}</p>
                      ))}
                    </div>

                    <Button onClick={() => handleStart(scanResult.best!)} disabled={loading}
                            className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                      <Target className="w-4 h-4 mr-2" />
                      Deploy Sniper — {scanResult.best.label} on {scanResult.best.displayName}
                    </Button>

                    {scanResult.allScored.length > 1 && (
                      <div className="space-y-1 pt-1 border-t border-white/5">
                        <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Other markets scored</p>
                        {scanResult.allScored.slice(1, 6).map((c, i) => (
                          <button key={i} onClick={() => handleStart(c)} disabled={loading || !c.deployable}
                                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] hover:bg-white/[0.07] disabled:opacity-40 text-left">
                            <span className="font-medium flex-1 truncate text-white/80">{c.displayName}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/70">{c.label}</span>
                            <span className={`font-mono font-bold ${c.deployable ? "text-green-400" : "text-muted-foreground/50"}`}>
                              {c.confidence}%
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <p className="text-xs font-semibold text-amber-300">No Kill-Shot Setup Available</p>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                    {scanResult.best && scanResult.best.blockers.length > 0 && (
                      <div className="space-y-0.5 pt-1">
                        {scanResult.best.blockers.slice(0, 4).map((b, i) => (
                          <p key={i} className="text-[10px] font-mono text-amber-200/70">⛔ {b}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <Button onClick={handleScan} disabled={loading} variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-Scan
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
                <div className={`rounded-xl p-3 border ${isRunning ? `${a.panelBg} ${a.panelBorder}` : "bg-secondary/30 border-border"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span>
                    {isRunning ? (
                      <span className={`flex items-center gap-1 text-[10px] ${a.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} /> SNIPER ARMED
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
                    <span className="text-muted-foreground">{session?.tradeCount ?? 0} shots</span>
                  </div>
                </div>

                {/* THE SCOPE — the evidence the sniper is accumulating.
                    This panel exists so a bot that is deliberately doing nothing
                    still visibly reads as working. */}
                {isRunning && hunt && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                        {hunt.phase === "waiting" ? <Eye className="w-3 h-3" /> : <Crosshair className="w-3 h-3" />}
                        {hunt.phase === "waiting" ? "Watching · holding fire"
                          : hunt.phase === "armed" ? "Armed — all gates clear"
                          : hunt.phase === "firing" ? "Firing kill shot"
                          : "Settling"}
                      </p>
                      <span className="text-[10px] font-mono text-muted-foreground/70 flex items-center gap-1.5">
                        {hunt.tier !== "marginal" && (
                          <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                            hunt.tier === "prime" ? "bg-green-500/20 text-green-300" : "bg-cyan-500/20 text-cyan-300"
                          }`}>{hunt.tier.toUpperCase()}</span>
                        )}
                        {hunt.confidence}% conf
                      </span>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                          SPRT evidence
                        </span>
                        <span className="text-[9px] font-mono text-muted-foreground/70">
                          {hunt.logLR.toFixed(1)} / {hunt.threshold.toFixed(1)} nats
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                        <div className={`h-full ${a.dot} transition-all duration-700`}
                             style={{ width: `${Math.max(1, Math.min(100, hunt.evidence * 100))}%` }} />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Evidence odds" value={`${hunt.oddsForEdge.toFixed(0)}:1`} tone={a.text} />
                      <Stat label="Ticks watched" value={String(hunt.ticksWatched)} />
                      <Stat label="Live win rate" value={`${(hunt.pWin * 100).toFixed(1)}%`} />
                      <Stat label="≈ ticks to shot"
                            value={hunt.expectedTicks >= 9999 ? "—" : String(hunt.expectedTicks)} />
                    </div>

                    {hunt.blockers.length > 0 && (
                      <div className="space-y-0.5">
                        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/60">Waiting on</p>
                        {hunt.blockers.map((b, i) => (
                          <p key={i} className="text-[10px] font-mono text-amber-200/70 leading-relaxed">· {b}</p>
                        ))}
                      </div>
                    )}

                    {/* ENTRY TIMING — the second, separate reason the bot waits.
                        Evidence says the market has an edge; this says whether the
                        NEXT tick is the one to be in on. Showing both is what makes
                        "armed but not firing" legible instead of looking stuck. */}
                    {hunt.phase === "armed" && hunt.timing && (
                      <div className="rounded-lg border border-white/10 bg-black/30 p-2 space-y-1.5">
                        <div className="flex items-center justify-between">
                          <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">Entry timing</p>
                          <span className={`text-[9px] font-mono font-bold ${hunt.timing.ready ? "text-green-400" : "text-amber-300"}`}>
                            {hunt.timing.score}/100
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-black/40 overflow-hidden">
                          <div className={`h-full transition-all duration-500 ${hunt.timing.ready ? "bg-green-400" : "bg-amber-400"}`}
                               style={{ width: `${Math.max(2, hunt.timing.score)}%` }} />
                        </div>
                        <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                          {hunt.timing.reason}
                        </p>
                        <div className="grid grid-cols-2 gap-1.5">
                          <Stat label="Short-run momentum"
                                value={`${hunt.timing.momentumPP >= 0 ? "+" : ""}${hunt.timing.momentumPP.toFixed(1)}pp`}
                                tone={hunt.timing.momentumPP >= 0 ? "text-green-400" : "text-amber-300"} />
                          <Stat label="Renewal position" value={`${hunt.timing.gapRatio.toFixed(2)}× due`} />
                        </div>
                        {hunt.timing.waitTicks > 0 && (
                          <p className="text-[9px] text-muted-foreground/60">
                            Holding {hunt.timing.waitTicks} tick(s) — the shot is taken anyway once the
                            objection has stood long enough, so a conclusive setup never rots.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {session?.killLock && (
                  <div className="rounded-xl border border-white/10 bg-black/25 p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                      <Lock className="w-3 h-3" />
                      {hunt?.targetMode === "lock"
                        ? "Frozen target · no switching"
                        : `Current target · hunting ${hunt?.marketsScanned || 0} markets`}
                    </p>
                    <p className="text-xs font-bold text-white">{session.killLock.displayName}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat label="Contract (frozen)" value={session.killLock.contract} tone={a.text} />
                      <Stat label="Payout" value={`${session.killLock.payout.toFixed(2)}×`} />
                      <Stat label="Win rate" value={`${(session.killLock.pWin * 100).toFixed(1)}%`} />
                      <Stat label="Loss pairing ξ" value={session.killLock.clusterRatio.toFixed(2)}
                            tone={session.killLock.clusterRatio <= 1 ? "text-green-400" : "text-amber-300"} />
                      {hunt?.targetMode === "hunt" && (
                        <Stat label="Best anywhere" value={`${hunt.bestConfidence}%`} tone={a.text} />
                      )}
                    </div>
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" :
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
                      The recovery shot is sniped with the same patience as a normal one — it waits for
                      the full evidence stack rather than firing on the next tick.
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

export default KillShotConsole;
