/**
 * Match Prism console — the Matches-only compositional-Bayes bot.
 *
 * Every other bot console in this suite shows the user a WIN RATE and asks them
 * to trust it. Match Prism's whole design is the opposite claim: at 8.93× the
 * break-even rate is 11.20% against a fair 10%, so a Matches bot that cannot
 * PROVE the market is biased is buying a 10.7% tax per shot. This console
 * therefore leads with the proofs — is the distribution non-uniform, does the
 * previous digit matter, does being overdue matter — and only then shows the
 * posterior, the out-of-sample accuracy and the priced ladder.
 *
 * Two consequences the UI has to get right:
 *  - REFUSAL IS A FIRST-CLASS RESULT. When no market clears the gates the
 *    console says so with the exact gate that failed, rather than nudging the
 *    user into a coin flip.
 *  - THE MODE IS CHOSEN AFTER THE SCAN, from the measured card. Locked and
 *    Switching are offered side by side on the same candidate, because the
 *    decision is about the market that was just measured, not about a
 *    preference expressed before it.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, RefreshCw, ChevronLeft, X, Lock,
  Shuffle, Target, ShieldCheck, Sigma, FlaskConical, Activity, Ban, Check,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Certainty = "elite" | "strict" | "balanced";
type Verdict = "certified" | "qualified" | "watch" | "refused";
type Hazard = "rising" | "falling" | "flat";

interface PrismCandidate {
  symbol: string;
  displayName: string;
  digit: number;
  verdict: Verdict;
  confidence: number;
  deployable: boolean;
  reason: string;
  failReasons: string[];
  breakEven: number;
  payout: number;
  pBiased: number;
  bayesFactor: number;
  chi2P: number;
  alphaHat: number;
  deltaBic: number;
  hasMemory: boolean;
  memoryless: boolean;
  memoryVerdict: string;
  pMean: number;
  pLower: number;
  pClear: number;
  pArgmax: number;
  edgePerShot: number;
  edgePerDollar: number;
  fdrP: number;
  fdrSurvives: boolean;
  ladderClear: number;
  ladderClearPessimistic: number;
  requiredWinRate: number;
  ladderDepth: number;
  oosShots: number;
  oosWinRate: number;
  oosWinRateLower: number;
  inSampleWinRate: number;
  tau: number;
  evidence: number;
  score: number;
}

interface PrismScanResult {
  suitable: boolean;
  best: PrismCandidate | null;
  bestAvailable: PrismCandidate | null;
  allScored: PrismCandidate[];
  reason: string;
  certainty: Certainty;
  marketsScanned: number;
  historyDepth: number;
  universe: {
    candidatesScreened: number;
    candidatesRefined: number;
    pBiasedMax: number;
    alphaHat: number;
    requiredWinRate: number;
    deepHistoryDegraded: boolean;
    summary: string;
    ladderSummary: string;
  };
  plan: any;
}

const VERDICT_TONE: Record<Verdict, string> = {
  certified: "text-green-400 bg-green-500/10 border-green-500/30",
  qualified: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  watch: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  refused: "text-red-400 bg-red-500/10 border-red-500/30",
};

const VERDICT_DOT: Record<Verdict, string> = {
  certified: "bg-green-400",
  qualified: "bg-sky-400",
  watch: "bg-amber-400",
  refused: "bg-red-400",
};

const CERTAINTIES: Array<{ id: Certainty; label: string; hint: string }> = [
  { id: "elite", label: "Elite", hint: "rarest, most proof" },
  { id: "strict", label: "Strict", hint: "balanced proof" },
  { id: "balanced", label: "Balanced", hint: "most setups" },
];

const HAZARD_COPY: Record<Hazard, { label: string; detail: string }> = {
  rising: {
    label: "Overdue counts",
    detail: "Gaps are non-geometric with a RISING hazard — a long absence makes the digit more likely. Prism waits for the overdue tick.",
  },
  falling: {
    label: "Fresh counts",
    detail: "Gaps are non-geometric with a FALLING hazard — the digit is most likely right after it has just printed. Prism enters while the gap is short.",
  },
  flat: {
    label: "Dormancy ignored",
    detail: "The gaps fit a Geometric law, so dormancy is the gambler's fallacy. Prism gives it exactly zero weight and never times entries from it.",
  },
};

const ALL_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Probability with the precision the number actually deserves. */
function pct(p: number, digits = 2): string {
  if (!Number.isFinite(p)) return "—";
  const v = p * 100;
  if (v > 0 && v < 0.01) return "<0.01%";
  return `${v.toFixed(digits)}%`;
}

/** Bayes factors span 30 orders of magnitude — never print them raw. */
function bf(x: number): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  if (x >= 10000 || (x > 0 && x < 0.001)) return x.toExponential(1);
  return x.toFixed(x >= 10 ? 1 : 3);
}

function NumInput({ label: lbl, value, onChange, min, step = 1, suffix, accent, help }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; step?: number; suffix?: string; accent: AccentKey; help?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex-1 min-w-0">
        <span className="text-xs text-muted-foreground">{lbl}</span>
        {help && <p className="text-[9px] text-muted-foreground/50 leading-tight">{help}</p>}
      </div>
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
    <div className="bg-black/25 rounded-lg px-2 py-1.5 min-w-0">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60 truncate">{lbl}</p>
      <p className={`text-[11px] font-mono font-bold truncate ${tone ?? "text-white/90"}`}>{value}</p>
    </div>
  );
}

/** One of the three structure proofs, rendered as pass / fail / not-needed. */
function Proof({
  index, title, question, passed, value, detail, tone,
}: {
  index: number; title: string; question: string;
  passed: boolean | null; value: string; detail: string; tone?: "neutral";
}) {
  const color = passed === null || tone === "neutral"
    ? "text-muted-foreground bg-white/[0.04] border-white/10"
    : passed
      ? "text-green-400 bg-green-500/10 border-green-500/25"
      : "text-red-400 bg-red-500/10 border-red-500/25";
  return (
    <div className="rounded-lg border border-white/10 bg-black/25 p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="w-4 h-4 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-[8px] font-mono text-muted-foreground flex-shrink-0">
          {index}
        </span>
        <p className="text-[10px] font-bold text-white/90 flex-1 min-w-0 truncate">{title}</p>
        <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border flex items-center gap-1 flex-shrink-0 ${color}`}>
          {passed === null || tone === "neutral" ? (
            <><Ban className="w-2.5 h-2.5" /> N/A</>
          ) : passed ? (
            <><Check className="w-2.5 h-2.5" /> PASS</>
          ) : (
            <><Ban className="w-2.5 h-2.5" /> FAIL</>
          )}
          {value}
        </span>
      </div>
      <p className="text-[9px] text-muted-foreground/70 leading-tight">{question}</p>
      <p className="text-[10px] text-muted-foreground leading-relaxed">{detail}</p>
    </div>
  );
}

export function PrismConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<PrismScanResult | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 19,
  });
  const [showProofs, setShowProofs] = useState(true);
  const { data: settings } = useGetSettings();

  const [aiDigit, setAiDigit] = useState(true);
  const [digit, setDigit] = useState<number>(5);
  const [certainty, setCertainty] = useState<Certainty>("strict");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">("switching");
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
  const Icon = BOT_ICON[bot.icon] ?? Target;

  const buildBody = () => ({
    botId: bot.id,
    certainty,
    ...config,
    ...(aiDigit ? {} : { digit }),
  });

  const scanEndpoint = "/api/bots/prism/scan";
  const startEndpoint = "/api/bots/prism/start";
  const stopEndpoint = "/api/bots/prism/stop";

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
      setScanResult(data as PrismScanResult);
      setStep("scan-result");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleStart = async (c: PrismCandidate, mode: "locked" | "switching") => {
    setLoading(true);
    try {
      const res = await fetch(startEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          marketMode: mode,
          symbol: c.symbol,
          digit: c.digit,
          card: { ...c, plan: scanResult?.plan },
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
          ? `🔒 Locked on ${c.displayName} — the digit may rotate, the market won't`
          : `🔁 Deployed on ${c.displayName} — Prism will re-read and switch when it cools`,
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
      toast.success("Match Prism stopped");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const profit = session?.totalProfit ?? 0;
  const winRate = session && session.tradeCount > 0
    ? Math.round((session.winCount / session.tradeCount) * 100) : 0;
  const watch = (session as any)?.prismWatch as
    | {
      phase: "watching" | "armed" | "firing" | "settling";
      digit: number; p: number; pClear: number; bar: number; reason: string;
      switched: boolean; confidence: number; verdict: string; ticksWatched: number;
      memoryWeight: number; memoryless: boolean;
      renewalMode: "ignored" | "wait-for-overdue" | "enter-while-fresh";
      gap: number; ladderClear: number; requiredWinRate: number;
    }
    | undefined;
  const deployed = (session as any)?.deployed as
    | (PrismCandidate & { hurdle: number; memoryVerdict: string; hazardDirection: Hazard; certainty: Certainty; tau: number })
    | undefined;

  /** The proof ledger. Shared by the scan card and the running session. */
  const ProofLedger = ({ c, compact }: { c: PrismCandidate; compact?: boolean }) => {
    const hazard = (c.memoryless ? "flat" : (c.deltaBic > 0 ? "rising" : "flat")) as Hazard;
    return (
      <div className={compact ? "space-y-1.5" : "space-y-2"}>
        <Proof
          index={1}
          title="Is the market biased at all?"
          question="Compositional Bayes factor against the exact point null p = 1/10, with the bias model integrated over a log-uniform concentration prior out to α=5000."
          passed={c.pBiased > 0.95}
          value={`BF ${bf(c.bayesFactor)}`}
          detail={`Posterior probability of bias ${pct(c.pBiased)}, fitted concentration α̂ ${c.alphaHat.toFixed(0)}. A χ² test alone calls a 0.2pp wobble significant — six times smaller than the 1.20pp the 8.93× payout actually demands — so Prism decides on the posterior, not the p-value.`}
        />
        {!compact && (
          <Proof
            index={2}
            title="Does the previous digit matter?"
            question="The 10×10 transition table against the memoryless model, by ΔBIC on the held-out second half."
            passed={c.hasMemory}
            value={`ΔBIC ${c.deltaBic.toFixed(1)}`}
            detail={c.hasMemory
              ? "The previous digit carries information, so the transition row joins the estimate — through an exact conjugate Dirichlet posterior shrunk toward the marginal by its own evidence, never at full weight."
              : "The chain is indistinguishable from memoryless once the extra ten parameters are paid for. Prism discards the transition row entirely rather than injecting 5,000-tick noise into a 2,500-observation fit."}
          />
        )}
        <Proof
          index={compact ? 2 : 3}
          title="Does being overdue matter?"
          question="The digit's own inter-arrival gaps against the fitted Geometric: binned χ² goodness-of-fit plus a pooled early-vs-late hazard comparison."
          passed={c.memoryless ? false : true}
          value={c.memoryless ? "geometric" : HAZARD_COPY[hazard].label}
          detail={c.memoryVerdict}
        />
      </div>
    );
  };

  const CandidateCard = ({ c }: { c: PrismCandidate }) => (
    <div className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2.5`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-bold text-white truncate">
          {c.displayName} · <span className="text-white/80">Match {c.digit}</span>
        </p>
        <span className="text-[10px] font-mono font-bold uppercase flex-shrink-0">{c.verdict}</span>
      </div>

      <p className="text-[10px] text-muted-foreground leading-relaxed">{c.reason}</p>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="P(rate > break-even)" value={pct(c.pClear, 1)}
              tone={c.pClear >= 0.95 ? "text-green-400" : undefined} />
        <Stat label="Pessimistic 5%" value={pct(c.pLower)}
              tone={c.pLower >= c.requiredWinRate ? "text-green-400" : "text-red-400"} />
        <Stat label="Ladder clears" value={pct(c.ladderClear, 0)}
              tone={c.ladderClear >= 0.95 ? "text-green-400" : "text-amber-300"} />
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="Out-of-sample" value={`${pct(c.oosWinRate, 1)} / ${c.oosShots}`} />
        <Stat label="In-sample" value={pct(c.inSampleWinRate, 1)} />
        <Stat label="Expectancy / $1"
              value={`${c.edgePerDollar >= 0 ? "+" : ""}${(c.edgePerDollar * 100).toFixed(1)}%`}
              tone={c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"} />
      </div>

      {showProofs && <ProofLedger c={c} />}

      <div className="text-[9px] font-mono text-muted-foreground/60 flex flex-wrap gap-x-3 gap-y-0.5">
        <span>needs ≥ {pct(c.requiredWinRate, 2)}</span>
        <span>break-even {pct(c.breakEven, 2)}</span>
        <span>ladder depth {c.ladderDepth}</span>
        <span>P(argmax) {pct(c.pArgmax, 1)}</span>
        <span className={c.fdrSurvives ? "text-green-400/80" : "text-red-400/80"}>
          FDR {c.fdrSurvives ? "survives" : "fails"} (p={c.fdrP.toExponential(1)})
        </span>
      </div>

      {c.failReasons.length > 0 && (
        <ul className="text-[9px] text-red-300/80 space-y-0.5 list-disc pl-4">
          {c.failReasons.slice(0, 4).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
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
            className={`fixed bottom-20 right-4 z-50 w-88 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
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
                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg} space-y-1`}>
                  <p className={`text-[10px] font-bold ${a.text} flex items-center gap-1.5`}>
                    <Sigma className="w-3 h-3" /> Matches only · 8.93× · break-even 11.20%
                  </p>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Differs does not exist in this bot. On a fair stream every Matches strategy loses 10.7% a shot,
                    so Prism refuses to fire until it can prove the market is not fair.
                  </p>
                </div>

                <button onClick={() => setAiDigit(v => !v)}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-[11px] text-left transition-colors ${
                    aiDigit ? `${a.activeBg} border ${a.activeBorder}` : "bg-white/[0.03] border border-white/5"}`}>
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                    aiDigit ? `${a.dot} border-transparent` : "border-white/20"}`}>
                    {aiDigit && <span className="text-[8px] text-black font-bold">✓</span>}
                  </span>
                  <span className={aiDigit ? a.text : "text-muted-foreground"}>
                    Let Prism score all ten digits
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
                    <p className="text-[9px] text-muted-foreground/60 leading-tight">
                      Prism still demands the market be proven biased before it deploys a locked digit.
                    </p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Proof required</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {CERTAINTIES.map(c => (
                      <button key={c.id} onClick={() => setCertainty(c.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${
                          certainty === c.id ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"}`}>
                        <span className="block text-[11px] font-semibold">{c.label}</span>
                        <span className="block text-[8px] text-muted-foreground/70">{c.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session boundaries</p>
                  <NumInput label="Stake per shot" value={config.stake} onChange={v => set("stake", v)}
                            min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                  <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)}
                            min={1} step={1} suffix="USD" accent={bot.accent} />
                  <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)}
                            min={1} step={1} suffix="USD" accent={bot.accent}
                            help="The stop loss sets how deep the ladder may run — and therefore the win rate Prism insists on." />
                  <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)}
                            min={1} step={1} accent={bot.accent} />
                </div>

                <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                  Market mode — <span className="text-white/80">locked</span> or{" "}
                  <span className="text-white/80">switching</span> — is chosen after the scan, from the market
                  that was actually measured.
                </p>

                <Button onClick={handleScan} disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                  <ScanSearch className="w-4 h-4 mr-2" /> Measure every market
                </Button>
              </div>
            )}

            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">Proving structure, then measuring out of sample</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `${progress.scanning}…` : "Loading 4,999 digits per market…"}
                  </p>
                </div>
                <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className={`h-full ${a.solidBtn} transition-all`}
                       style={{ width: `${(progress.scanned / Math.max(1, progress.total)) * 100}%` }} />
                </div>
                <p className="text-[10px] font-mono text-muted-foreground/70">
                  {progress.scanned}/{progress.total} markets
                </p>
                <p className="text-[9px] text-muted-foreground/50 leading-tight">
                  190 candidates screened in closed form, then the expensive estimators on the handful that could pass.
                </p>
              </div>
            )}

            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                <div className={`rounded-lg px-2.5 py-2 border ${a.panelBorder} ${a.panelBg} space-y-1`}>
                  <div className="flex items-center justify-between">
                    <p className={`text-[10px] font-bold ${a.text} flex items-center gap-1.5`}>
                      <FlaskConical className="w-3 h-3" /> UNIVERSE
                    </p>
                    <button onClick={() => setShowProofs(v => !v)}
                            className="text-[9px] font-mono text-muted-foreground hover:text-white">
                      {showProofs ? "hide proofs" : "show proofs"}
                    </button>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">{scanResult.universe.summary}</p>
                  <div className="grid grid-cols-4 gap-1.5 pt-0.5">
                    <Stat label="Screened" value={String(scanResult.universe.candidatesScreened)} />
                    <Stat label="Refined" value={String(scanResult.universe.candidatesRefined)} />
                    <Stat label="Max P(bias)" value={pct(scanResult.universe.pBiasedMax, 1)} />
                    <Stat label="Needs ≥" value={pct(scanResult.universe.requiredWinRate, 2)} />
                  </div>
                  <p className="text-[9px] text-muted-foreground/70 leading-relaxed pt-0.5">
                    {scanResult.universe.ladderSummary}
                  </p>
                  {scanResult.universe.deepHistoryDegraded && (
                    <p className="text-[9px] text-amber-300/80">
                      ⚠ Deep history was not fully available — Prism measured what it could and widened its intervals.
                    </p>
                  )}
                </div>

                {scanResult.best && scanResult.suitable ? (
                  <>
                    <CandidateCard c={scanResult.best} />
                    <div className="space-y-2">
                      <Button onClick={() => handleStart(scanResult.best!, "locked")} disabled={loading}
                              className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}>
                        <Lock className="w-4 h-4 mr-2" /> Trade Locked on {scanResult.best.displayName}
                      </Button>
                      <p className="text-[9px] text-muted-foreground/70 leading-tight pl-1">
                        The market is frozen; the digit may still rotate as new ticks arrive.
                      </p>
                      <Button onClick={() => handleStart(scanResult.best!, "switching")} disabled={loading}
                              variant="outline" className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Trade with Smart Market Switching
                      </Button>
                      <p className="text-[9px] text-muted-foreground/70 leading-tight pl-1">
                        Prism re-reads every market and moves when this one cools below the bar.
                      </p>
                    </div>
                  </>
                ) : scanResult.bestAvailable && scanResult.bestAvailable.edgePerDollar > 0 ? (
                  <>
                    <CandidateCard c={scanResult.bestAvailable} />
                    <div className="rounded-lg bg-amber-500/[0.06] border border-amber-500/25 p-2.5">
                      <p className="text-[10px] text-amber-300 font-semibold">Cleared the economics, not the full proof</p>
                      <p className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">
                        This market's measured expectancy is positive but it did not pass every gate. Starting it is a
                        deliberate choice — Prism keeps re-measuring and will stand down if it cools.
                      </p>
                    </div>
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
                  <div className="rounded-xl bg-red-500/[0.06] border border-red-500/25 p-3 space-y-2">
                    <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
                      <Ban className="w-3.5 h-3.5" /> No market is provably unfair right now
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{scanResult.reason}</p>
                    <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
                      At 8.93× the break-even is 11.20% against a fair 10%. Standing down and re-measuring is the
                      correct trade — every Matches bot that fires anyway is paying that 10.7% tax on purpose.
                    </p>
                    {scanResult.bestAvailable && (
                      <p className="text-[10px] font-mono text-muted-foreground/60">
                        Best available: {scanResult.bestAvailable.displayName} · Match {scanResult.bestAvailable.digit} ·{" "}
                        {pct(scanResult.bestAvailable.oosWinRate, 1)} out-of-sample
                      </p>
                    )}
                  </div>
                )}

                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">Runner-ups</p>
                    {scanResult.allScored.slice(1, 6).map((c, i) => (
                      <div key={i} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs bg-white/[0.03] text-left">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${VERDICT_DOT[c.verdict]}`} />
                        <span className="font-medium flex-1 truncate text-white/80">
                          {c.displayName} · Match {c.digit}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground/70">{pct(c.oosWinRate, 1)}</span>
                        <span className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {c.edgePerDollar >= 0 ? "+" : ""}{(c.edgePerDollar * 100).toFixed(1)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <Button onClick={handleScan} disabled={loading} variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}>
                  <RefreshCw className="w-3.5 h-3.5 mr-2" /> Re-measure
                </Button>
                <button onClick={() => setStep("config")}
                        className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1">
                  <ChevronLeft className="w-3 h-3" /> Change risk or proof level
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
                    <span className="text-muted-foreground">Matches only</span>
                  </div>
                </div>

                {deployed && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {marketMode === "locked" ? "Locked market" : "Active market"}
                      </p>
                      {watch?.switched && <span className="text-[9px] font-mono text-amber-300">↻ rotated</span>}
                    </div>
                    <p className="text-xs font-bold text-white">
                      {deployed.displayName} · Match {deployed.digit}
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Contract" value="DIGITMATCH" tone={a.text} />
                      <Stat label="Verdict" value={String(deployed.verdict).toUpperCase()}
                            tone={deployed.verdict === "refused" ? "text-red-400" : "text-green-400"} />
                      <Stat label="Certainty" value={String(deployed.certainty ?? certainty).toUpperCase()} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="P(bias)" value={pct(deployed.pBiased, 1)} />
                      <Stat label="Out-of-sample" value={`${pct(deployed.oosWinRate, 1)} / ${deployed.oosShots}`} />
                      <Stat label="Needs ≥" value={pct(deployed.requiredWinRate, 2)} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Pessimistic 5%" value={pct(deployed.pLower)}
                            tone={deployed.pLower >= deployed.requiredWinRate ? "text-green-400" : "text-red-400"} />
                      <Stat label="Ladder clears" value={pct(deployed.ladderClear, 0)} />
                      <Stat label="Ladder depth" value={String(deployed.ladderDepth)} />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}>
                    <div className="flex items-center justify-between">
                      <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}>
                        {watch.phase === "firing" ? "Firing"
                          : watch.phase === "armed" ? "Armed"
                          : watch.phase === "settling" ? "Settling" : "Watching"}
                      </p>
                      <span className="text-[9px] font-mono text-muted-foreground/70">
                        p {pct(watch.p, 1)} / bar {pct(watch.bar, 1)}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">{watch.reason || "Waiting…"}</p>
                    <div className="h-2 rounded-full bg-black/40 overflow-hidden">
                      <div className={`h-full transition-all duration-700 ${
                        watch.bar > 0 && watch.p >= watch.bar ? "bg-green-400" : a.dot}`}
                           style={{ width: `${Math.max(3, Math.min(100, watch.bar > 0 ? (watch.p / watch.bar) * 100 : 0))}%` }} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Digits watched" value={String(watch.ticksWatched)} />
                      <Stat label="Posterior" value={pct(watch.p)} />
                      <Stat label="Memory weight" value={watch.memoryWeight.toFixed(3)} />
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat label="Gate" value={String(watch.verdict).toUpperCase()} />
                      <Stat label="Gap" value={String(watch.gap)} />
                      <Stat label="Ladder clears" value={pct(watch.ladderClear, 0)}
                            tone={watch.ladderClear >= 0.95 ? "text-green-400" : "text-amber-300"} />
                    </div>
                    <p className="text-[9px] text-muted-foreground/70 leading-tight">
                      {watch.memoryless
                        ? HAZARD_COPY.flat.detail
                        : watch.renewalMode === "wait-for-overdue"
                          ? HAZARD_COPY.rising.detail
                          : watch.renewalMode === "enter-while-fresh"
                            ? HAZARD_COPY.falling.detail
                            : "Renewal carries no measurable information — Prism is not waiting on a dormancy band."}
                    </p>
                    <p className="text-[9px] font-mono text-muted-foreground/50">
                      needs ≥ {pct(watch.requiredWinRate, 2)} for the current debt · P(clear) {pct(watch.pClear, 1)}
                    </p>
                  </div>
                )}

                {session?.message && (
                  <div className={`text-xs px-3 py-2 rounded-lg border font-mono ${
                    session.message.startsWith("✅") ? "bg-green-500/10 border-green-500/20 text-green-400" :
                    session.message.startsWith("🛑") ? "bg-red-500/10 border-red-500/20 text-red-400" :
                    session.message.startsWith("❌") ? "bg-red-500/10 border-red-500/20 text-red-300" :
                    session.message.startsWith("🔁") ? "bg-sky-500/10 border-sky-500/25 text-sky-300" :
                    session.message.startsWith("🔒") ? "bg-lime-500/10 border-lime-500/25 text-lime-300" :
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
                      Same shared ledger and debt-driven stake as Match Sniper — plus one rule of Prism's own: a
                      recovery shot is refused when the digit can no longer cover what the larger debt requires.
                    </p>
                    {(session as any).consecutiveRecoveryLosses !== undefined && (
                      <p className="text-[9px] font-mono text-muted-foreground/70 flex items-center gap-1">
                        <Activity className="w-3 h-3" />
                        {session.consecutiveRecoveryLosses} consecutive recovery loss
                        {session.consecutiveRecoveryLosses === 1 ? "" : "es"} · current stake $
                        {Number(session.currentStake ?? 0).toFixed(2)}
                      </p>
                    )}
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

export default PrismConsole;
