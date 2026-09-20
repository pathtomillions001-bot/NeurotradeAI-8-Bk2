/**
 * Twin-Rail Sentinel console.
 *
 * The contracts are frozen, so this console has no side picker and no bridge:
 * the user sets risk, runs ONE measurement pass over every digit market, reads
 * the numbers, and then decides how the bot may move — locked to the measured
 * market or free to rotate to the best one it can measure. From then on the
 * console is a twin-leg monitor: two rails, one shared tick, and the sync
 * verdict of every round.
 *
 * Everything the trader needs to judge the bot is on screen and no number is
 * softened: the carrier toll the normal rail pays per round, the break-even
 * dead-rail rate implied by the live quotes next to the rate the tape prints,
 * the confidence bound that opens the gate, the burst latency, and the
 * milliseconds of tick window left when the burst went out.
 */

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Loader2, StopCircle, ScanSearch, AlertTriangle, RefreshCw, Lock, X,
  ChevronLeft, Layers, ShieldCheck, Zap, GitBranch,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Trigger = "pair-loss" | "both-legs";
type Discipline = "spec" | "measured";

interface PairQuote { overPayout: number; underPayout: number }
interface EdgeEstimate {
  mean: number; sd: number; lcb: number; ucb: number; pPositive: number;
  quota: number; deadRate: number; winNet: number; deadNet: number; samples: number;
}
interface Candidate {
  symbol: string;
  displayName: string;
  quotes: { normal: PairQuote; recovery: PairQuote };
  quotesLive: boolean;
  normal: EdgeEstimate;
  recovery: EdgeEstimate;
  tape: { deadRate: number; deadRaw: number; deadSd: number; samples: number; uniformityP: number; uniformityChi2: number };
  cycleEdge: number;
  cycleEdgeLcb: number;
  survival: number;
  profile: { periodMs: number; jitterMs: number; samples: number; ageMs: number };
  verdict: "certified" | "qualified" | "watch" | "refused";
  deployable: boolean;
  reason: string;
  signals: string[];
}
interface ScanResult {
  suitable: boolean;
  best: Candidate | null;
  allScored: Candidate[];
  reason: string;
  degraded: boolean;
  memoryNote: string;
  mechanics: string[];
  sessionParams?: { stake: number; maxPairStake: number; markupPercent: number };
}

function NumInput({ label, value, onChange, min = 0, step = 1, suffix, accent, disabled }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; step?: number; suffix?: string; accent: AccentKey; disabled?: boolean;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground flex-1">{label}</span>
      <div className="flex items-center gap-1">
        <Input
          type="number" value={value} min={min} step={step} disabled={disabled}
          onChange={e => onChange(Number(e.target.value))}
          className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 disabled:opacity-60 ${a.focusBorder}`}
        />
        {suffix && <span className="text-[10px] text-muted-foreground w-8">{suffix}</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="bg-black/25 rounded-lg px-2 py-1.5" title={hint}>
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">{label}</p>
      <p className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}>{value}</p>
    </div>
  );
}

const money = (v: number | undefined | null) =>
  v === undefined || v === null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

export function TwinRailConsole({ bot, open, onOpenChange, session, onSession }: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [step, setStep] = useState<Step>("config");
  const [loading, setLoading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ scanning: string | null; scanned: number; total: number }>({
    scanning: null, scanned: 0, total: 20,
  });
  const { data: settings } = useGetSettings();

  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    trigger: "pair-loss" as Trigger,
    discipline: "spec" as Discipline,
  });
  const set = <K extends keyof typeof config>(k: K, v: (typeof config)[K]) =>
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

  const isRunning = session?.running === true && session.botId === "twinrail";

  useEffect(() => { if (isRunning) setStep("running"); }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setLocked(null);
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

  // While the bot runs, poll its own status: the SSE stream covers updates, the
  // poll covers a reconnect.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/bots/twinrail/status");
        if (!res.ok || cancelled) return;
        const d = await res.json();
        if (!cancelled) onSession(d as BotSessionStatus);
      } catch { /* ignore */ }
    };
    const id = setInterval(tick, 4_000);
    tick();
    return () => { cancelled = true; clearInterval(id); };
  }, [open, onSession]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Layers;

  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScanResult(null);
    setProgress({ scanning: null, scanned: 0, total: 20 });
    try {
      const res = await fetch("/api/bots/twinrail/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stake: config.stake }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Scan failed"); setStep("config"); return; }
      const result = data as ScanResult;
      setScanResult(result);
      setStep("scan-result");
      if (!result.suitable) toast.warning("No market clears the cycle gate — you can still lock one deliberately");
    } catch {
      toast.error("Could not connect to the analysis engine");
      setStep("config");
    } finally { setLoading(false); }
  };

  const handleStart = async (c: Candidate, marketMode: "locked" | "switching", forced = false) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twinrail/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: c.symbol,
          lockedSymbol: marketMode === "locked" ? c.symbol : undefined,
          marketMode,
          score: c,
          forced,
          stake: config.stake,
          stopLoss: config.stopLoss,
          takeProfit: config.takeProfit,
          maxRecoverySteps: config.maxRecoverySteps,
          recoveryTrigger: config.trigger,
          discipline: config.discipline,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to start"); return; }
      onSession(data.status);
      setStep("running");
      toast.success(
        marketMode === "locked"
          ? `🔒 Locked on ${c.displayName} — Over 4 + Under 5 normal, Over 5 + Under 4 recovery`
          : `🚀 Deployed on ${c.displayName} — Twin-Rail may rotate to a better market`,
      );
    } catch {
      toast.error("Could not start the bot");
    } finally { setLoading(false); }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twinrail/stop", { method: "POST" });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Twin-Rail session stopped");
      setStep("config");
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const rail = (session as any)?.rail as
    | {
        symbol: string; displayName: string; normal: string; recovery: string;
        marketMode: string; trigger: string; discipline: string; quotesLive: boolean;
        normalQuote: PairQuote; recoveryQuote: PairQuote; carrierToll: number;
        quota: number; deadRate: number; contextualDeadRate: number; context: string;
        samples: number; verdict: string; score: number; reason: string; signals: string[]; forced: boolean;
      }
    | undefined;
  const watch = ((session as any)?.twinWatch ?? (session as any)?.watch) as
    | {
        phase: string; gateOpen: boolean; gateReason: string; cycleLcb: number; cycleMean: number;
        carrierToll: number; railMean: number; railLcb: number; tickPeriodMs: number; tickAgeMs: number;
        headroomMs: number; budgetMs: number; waitReason: string; holds: number;
      }
    | undefined;
  const ledger = ((session as any)?.twinLedger ?? (session as any)?.ledger) as
    | {
        roundCount: number; cycleCount: number; syncedRounds: number; deadRailHits: number;
        splitRounds: number; nakedRepairs: number; doubleLosses: number; syncRate: number;
        burstP50Ms: number; burstP95Ms: number; lastBurstMs: number; lastHeadroomMs: number;
        lastDigit: number | null; lastSync: string | null; legStake: number; pairExposure: number;
      }
    | undefined;

  const pnl = session?.totalProfit ?? 0;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          onClick={() => onOpenChange(false)}
        >
          <motion.div
            className={`w-full max-w-3xl rounded-2xl border ${a.panelBorder} bg-[#080d16] shadow-2xl my-4`}
            initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`flex items-center gap-3 px-4 py-3 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center`}>
                <Icon className={`w-4 h-4 ${a.text}`} />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-bold text-white truncate">{bot.name}</h2>
                <p className="text-[10px] font-mono text-muted-foreground truncate">
                  {bot.code} · Over 4 + Under 5 / Over 5 + Under 4 (frozen)
                </p>
              </div>
              {isRunning && (
                <span className={`flex items-center gap-1 text-[9px] font-mono px-2 py-1 rounded ${a.badgeBg} ${a.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} /> LIVE
                </span>
              )}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onOpenChange(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="p-4 space-y-4">
              {/* ── CONFIG ─────────────────────────────────────────────── */}
              {step === "config" && (
                <>
                  <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3`}>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Two frozen straddles on one tick. <span className={a.text}>Over 4 + Under 5</span> is the normal
                      rail — the legs partition the digits, so exactly one always wins and a double loss is impossible.
                      <span className={a.text}> Over 5 + Under 4</span> is the recovery rail: it pays ≈2.43× on digits
                      0–3 and 6–9 but loses BOTH legs on digits <span className="font-mono">4</span> and{" "}
                      <span className="font-mono">5</span>. The bot holds fire on that rail until the tape says those
                      digits are rarer than the quotes assume. You do not choose contracts here — they are fixed.
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                    <NumInput label="Stake per leg" value={config.stake} onChange={v => set("stake", v)} min={0.35} step={0.05} suffix="USD" accent={bot.accent} />
                    <NumInput label="Take profit" value={config.takeProfit} onChange={v => set("takeProfit", v)} suffix="USD" accent={bot.accent} />
                    <NumInput label="Stop loss" value={config.stopLoss} onChange={v => set("stopLoss", v)} suffix="USD" accent={bot.accent} />
                    <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => set("maxRecoverySteps", v)} min={1} accent={bot.accent} />
                  </div>

                  <div className="rounded-xl border border-white/5 p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Recovery trigger</p>
                    <div className="flex gap-2">
                      {([
                        { id: "pair-loss", label: "Pair net loss", hint: "Recover whenever a round takes money out of the account (covers a genuine double loss too)" },
                        { id: "both-legs", label: "Both legs lost (strict)", hint: "The literal rule — only a real double loss escalates, which the sync invariant flags" },
                      ] as const).map(opt => (
                        <button
                          key={opt.id}
                          title={opt.hint}
                          onClick={() => set("trigger", opt.id)}
                          className={`flex-1 text-[11px] px-2 py-2 rounded-lg border transition-colors ${
                            config.trigger === opt.id ? `${a.activeBg} ${a.activeBorder} ${a.text}` : "border-white/10 text-muted-foreground hover:border-white/20"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/5 p-3 space-y-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Carrier discipline</p>
                    <div className="flex gap-2">
                      {([
                        { id: "spec", label: "Continuous carrier (your rule)", hint: "The normal rail runs whenever the tick window allows; only the recovery rail is gated. The console prints its exact cost per round" },
                        { id: "measured", label: "Measured only", hint: "A round fires only when its own confidence bound clears zero — the bot holds fire when a cycle cannot pay for itself" },
                      ] as const).map(opt => (
                        <button
                          key={opt.id}
                          title={opt.hint}
                          onClick={() => set("discipline", opt.id)}
                          className={`flex-1 text-[11px] px-2 py-2 rounded-lg border transition-colors ${
                            config.discipline === opt.id ? `${a.activeBg} ${a.activeBorder} ${a.text}` : "border-white/10 text-muted-foreground hover:border-white/20"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <Button
                    onClick={handleScan}
                    disabled={loading || config.stake < 0.35}
                    className={`w-full h-10 text-xs font-semibold ${a.solidBtn} text-white`}
                  >
                    {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ScanSearch className="w-4 h-4 mr-2" />}
                    Measure every digit market
                  </Button>
                </>
              )}

              {/* ── SCANNING ───────────────────────────────────────────── */}
              {step === "scanning" && (
                <div className="py-8 text-center space-y-3">
                  <Loader2 className={`w-7 h-7 mx-auto animate-spin ${a.text}`} />
                  <p className="text-xs text-muted-foreground">
                    {progress.scanning ? `Measuring ${progress.scanning}…` : "Pulling deep digit history…"}
                  </p>
                  <p className="text-[10px] font-mono text-muted-foreground/60">
                    {progress.scanned} / {progress.total} markets · quoted payouts and tape frequencies for both rails
                  </p>
                  <div className="h-1 rounded-full bg-white/5 overflow-hidden max-w-xs mx-auto">
                    <div
                      className={`h-full bg-gradient-to-r ${a.grad} transition-all`}
                      style={{ width: `${Math.round((progress.scanned / Math.max(1, progress.total)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {/* ── SCAN RESULT ────────────────────────────────────────── */}
              {step === "scan-result" && scanResult && (
                <>
                  <div className={`rounded-xl border p-3 ${scanResult.suitable ? `${a.panelBorder} ${a.panelBg}` : "border-amber-500/30 bg-amber-500/[0.06]"}`}>
                    <div className="flex items-start gap-2">
                      {scanResult.suitable ? <ShieldCheck className={`w-4 h-4 mt-0.5 ${a.text}`} /> : <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-300" />}
                      <div className="min-w-0">
                        <p className="text-[11px] text-white/90 leading-relaxed">{scanResult.reason}</p>
                        <p className="text-[10px] font-mono text-muted-foreground mt-1">{scanResult.memoryNote}</p>
                        {scanResult.degraded && (
                          <p className="text-[10px] text-amber-300/90 mt-1">
                            Deriv's pricing feed could not be reached from this server, so the canonical payout table was used.
                            The analysis is complete; the quotes are nominal.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {scanResult.best && (
                    <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-bold text-white">{scanResult.best.displayName}</p>
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded ${a.badgeBg} ${a.text}`}>
                          {scanResult.best.verdict.toUpperCase()}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <Stat
                          label="Cycle edge (95% LB)"
                          value={money(scanResult.best.cycleEdgeLcb)}
                          tone={scanResult.best.cycleEdgeLcb > 0 ? "text-green-400" : "text-red-400"}
                          hint="Carrier net plus the recovery rail's lower confidence bound"
                        />
                        <Stat label="Carrier toll / round" value={money(scanResult.best.normal.mean)} tone="text-red-300" hint="What Over 4 + Under 5 returns per round at the live quotes — a fixed cost, not a coin flip" />
                        <Stat label="Dead-rail break-even" value={`${(scanResult.best.recovery.quota * 100).toFixed(2)}%`} hint="q* = (p − 2)/p from this market's own recovery quotes: the dead-rail rate the rail needs" />
                        <Stat
                          label="Tape dead-rail rate"
                          value={`${(scanResult.best.recovery.deadRate * 100).toFixed(2)}%`}
                          tone={scanResult.best.recovery.deadRate < scanResult.best.recovery.quota ? "text-green-400" : "text-amber-300"}
                          hint="Measured share of digits 4 and 5 in the deep history (Jeffreys-smoothed)"
                        />
                        <Stat label="Recovery win net" value={money(scanResult.best.recovery.winNet)} hint="Net of BOTH legs when one recovery leg wins" />
                        <Stat label="Dead-rail net" value={money(scanResult.best.recovery.deadNet)} tone="text-red-400" hint="Net of both legs when the digit is 4 or 5" />
                        <Stat label="Ticks measured" value={scanResult.best.tape.samples.toLocaleString()} />
                        <Stat label="Tick period" value={scanResult.best.profile.periodMs > 0 ? `${Math.round(scanResult.best.profile.periodMs)} ms` : "—"} />
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="rounded-lg bg-black/30 px-2 py-1.5">
                          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Normal rail quotes</p>
                          <p className="text-[11px] font-mono font-bold text-white/90">
                            Over 4 {scanResult.best.quotes.normal.overPayout.toFixed(2)}× · Under 5 {scanResult.best.quotes.normal.underPayout.toFixed(2)}×
                          </p>
                        </div>
                        <div className="rounded-lg bg-black/30 px-2 py-1.5">
                          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Recovery rail quotes</p>
                          <p className="text-[11px] font-mono font-bold text-white/90">
                            Over 5 {scanResult.best.quotes.recovery.overPayout.toFixed(2)}× · Under 4 {scanResult.best.quotes.recovery.underPayout.toFixed(2)}×
                          </p>
                        </div>
                      </div>

                      <ul className="space-y-1">
                        {scanResult.best.signals.map((sig, i) => (
                          <li key={i} className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                            <span className={a.text}>›</span><span>{sig}</span>
                          </li>
                        ))}
                      </ul>

                      <div className="flex flex-col sm:flex-row gap-2 pt-1">
                        <Button
                          onClick={() => handleStart(scanResult.best!, "locked")}
                          disabled={loading}
                          className={`flex-1 h-9 text-xs font-semibold ${a.solidBtn} text-white`}
                        >
                          <Lock className="w-3.5 h-3.5 mr-1.5" /> Lock {scanResult.best.symbol}
                        </Button>
                        <Button
                          onClick={() => handleStart(scanResult.best!, "switching")}
                          disabled={loading}
                          variant="outline"
                          className={`flex-1 h-9 text-xs font-semibold ${a.outlineBtn}`}
                        >
                          <GitBranch className="w-3.5 h-3.5 mr-1.5" /> Deploy · switching
                        </Button>
                      </div>
                      {!scanResult.best.deployable && (
                        <Button
                          onClick={() => handleStart(scanResult.best!, "locked", true)}
                          disabled={loading}
                          variant="outline"
                          className="w-full h-8 text-[11px] font-semibold border-red-500/40 text-red-300 hover:bg-red-500/10"
                        >
                          <AlertTriangle className="w-3.5 h-3.5 mr-1.5" /> Force-deploy anyway (labelled FORCED)
                        </Button>
                      )}
                    </div>
                  )}

                  {scanResult.allScored.length > 1 && (
                    <div className="rounded-xl border border-white/5 overflow-hidden">
                      <div className="px-3 py-2 bg-white/[0.02] flex items-center justify-between">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">All measured markets</p>
                        <p className="text-[10px] font-mono text-muted-foreground/60">ranked by cycle lower bound</p>
                      </div>
                      <div className="max-h-64 overflow-y-auto divide-y divide-white/5">
                        {scanResult.allScored.map(c => (
                          <div key={c.symbol} className="px-3 py-2 flex items-center gap-2 hover:bg-white/[0.02]">
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-white/90 truncate">{c.displayName}</p>
                              <p className="text-[9px] font-mono text-muted-foreground/70 truncate">
                                carrier {money(c.normal.mean)} · dead rail {(c.recovery.deadRate * 100).toFixed(1)}% vs quota {(c.recovery.quota * 100).toFixed(2)}% · {c.tape.samples} ticks
                              </p>
                            </div>
                            <span className={`text-[10px] font-mono ${c.cycleEdgeLcb > 0 ? "text-green-400" : "text-muted-foreground/60"}`}>
                              {money(c.cycleEdgeLcb)}
                            </span>
                            <Button
                              size="sm" variant="ghost" className="h-6 text-[10px]"
                              onClick={() => setLocked(locked === c.symbol ? null : c.symbol)}
                            >
                              {locked === c.symbol ? "selected" : "select"}
                            </Button>
                          </div>
                        ))}
                      </div>
                      {locked && (
                        <div className="px-3 py-2 border-t border-white/5 flex gap-2">
                          <Button
                            size="sm"
                            className={`flex-1 h-8 text-[11px] ${a.solidBtn} text-white`}
                            onClick={() => {
                              const c = scanResult.allScored.find(x => x.symbol === locked);
                              if (c) handleStart(c, "locked", !c.deployable);
                            }}
                          >
                            <Lock className="w-3 h-3 mr-1" /> Lock {locked}
                          </Button>
                          <Button
                            size="sm" variant="outline"
                            className={`flex-1 h-8 text-[11px] ${a.outlineBtn}`}
                            onClick={() => {
                              const c = scanResult.allScored.find(x => x.symbol === locked);
                              if (c) handleStart(c, "switching", !c.deployable);
                            }}
                          >
                            <GitBranch className="w-3 h-3 mr-1" /> Switching
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {scanResult.mechanics?.length > 0 && (
                    <details className="rounded-xl border border-white/5 px-3 py-2">
                      <summary className="text-[10px] uppercase tracking-wider text-muted-foreground/70 cursor-pointer">
                        How the twin rails are measured
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {scanResult.mechanics.map((m, i) => (
                          <li key={i} className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                            <span className={a.text}>›</span><span>{m}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  <Button variant="ghost" size="sm" className="w-full h-8 text-[11px]" onClick={() => setStep("config")}>
                    <ChevronLeft className="w-3 h-3 mr-1" /> Back to risk settings
                  </Button>
                </>
              )}

              {/* ── RUNNING ────────────────────────────────────────────── */}
              {step === "running" && (
                <>
                  <div className={`rounded-xl border ${a.panelBorder} bg-black/30 p-3 space-y-3`}>
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Session P&L</p>
                        <p className={`text-2xl font-bold font-mono ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                          {pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] font-mono text-muted-foreground">
                          {session?.winCount ?? 0}W · {session?.lossCount ?? 0}L · {ledger?.roundCount ?? 0} rounds
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground/70">
                          {rail?.marketMode === "locked" ? "🔒 locked" : "🔀 switching"} · {rail?.discipline === "spec" ? "continuous carrier" : "measured only"}
                        </p>
                      </div>
                    </div>

                    {session?.message && (
                      <p className="text-[11px] font-mono text-white/80 leading-relaxed">{session.message}</p>
                    )}
                    <p className="text-[10px] font-mono text-muted-foreground/70">{watch?.gateReason}</p>
                  </div>

                  {/* The two rails, side by side */}
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className={`rounded-xl border p-3 ${session?.inRecovery ? "border-white/5 opacity-60" : `${a.panelBorder} ${a.panelBg}`}`}>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Normal rail</p>
                      <p className="text-sm font-bold text-white mt-0.5">Over {4} + Under {5}</p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Digits 0–4 → Under wins · 5–9 → Over wins. Exactly one always wins; a double loss is impossible
                        on a shared tick.
                      </p>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <Stat label="Toll / round" value={money(rail?.carrierToll ?? watch?.carrierToll)} tone="text-red-300" />
                        <Stat
                          label="Quotes"
                          value={rail ? `${rail.normalQuote.overPayout.toFixed(2)}× / ${rail.normalQuote.underPayout.toFixed(2)}×` : "—"}
                        />
                      </div>
                    </div>

                    <div className={`rounded-xl border p-3 ${session?.inRecovery ? "border-amber-500/40 bg-amber-500/[0.06]" : "border-white/5 opacity-60"}`}>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Recovery rail</p>
                      <p className="text-sm font-bold text-white mt-0.5">Over {5} + Under {4}</p>
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Digits 0–3 → Under wins · 6–9 → Over wins · <span className="text-amber-300">4 and 5 lose BOTH legs</span>.
                      </p>
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <Stat
                          label="Dead rail (now)"
                          value={`${((rail?.contextualDeadRate ?? rail?.deadRate ?? 0) * 100).toFixed(2)}%`}
                          tone={(rail?.contextualDeadRate ?? 1) < (rail?.quota ?? 0) ? "text-green-400" : "text-amber-300"}
                        />
                        <Stat label="Quota" value={`${((rail?.quota ?? 0) * 100).toFixed(2)}%`} hint="Break-even dead-rail rate implied by the live quotes" />
                      </div>
                      <p className="text-[9px] font-mono text-muted-foreground/70 mt-1.5">
                        context: {rail?.context ?? "—"} · {rail?.samples?.toLocaleString() ?? "—"} ticks
                      </p>
                    </div>
                  </div>

                  {/* Execution integrity */}
                  <div className="rounded-xl border border-white/5 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Zap className={`w-3.5 h-3.5 ${a.text}`} />
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                        Same-tick execution
                      </p>
                      <span className={`ml-auto text-[10px] font-mono px-2 py-0.5 rounded ${
                        (ledger?.syncRate ?? 1) >= 0.999 ? "bg-green-500/15 text-green-300" : "bg-amber-500/15 text-amber-200"
                      }`}>
                        {((ledger?.syncRate ?? 1) * 100).toFixed(1)}% synced
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <Stat label="Burst p50" value={ledger?.burstP50Ms ? `${ledger.burstP50Ms} ms` : "—"} hint="Proposal → buy → ack for both legs" />
                      <Stat label="Burst p95" value={ledger?.burstP95Ms ? `${ledger.burstP95Ms} ms` : "—"} />
                      <Stat
                        label="Window at fire"
                        value={watch?.headroomMs !== undefined && Number.isFinite(watch.headroomMs) ? `${Math.round(watch.headroomMs)} ms` : "—"}
                        hint="Tick window left when the burst went out"
                      />
                      <Stat label="Tick period" value={watch?.tickPeriodMs ? `${Math.round(watch.tickPeriodMs)} ms` : "—"} />
                      <Stat label="Dead-rail rounds" value={String(ledger?.deadRailHits ?? 0)} tone={(ledger?.deadRailHits ?? 0) > 0 ? "text-amber-300" : undefined} />
                      <Stat label="Split-tick rounds" value={String(ledger?.splitRounds ?? 0)} tone={(ledger?.splitRounds ?? 0) > 0 ? "text-red-400" : undefined} hint="Both legs won or both lost on the normal rail — a desync, counted and reported" />
                      <Stat label="Double losses" value={String(ledger?.doubleLosses ?? 0)} tone={(ledger?.doubleLosses ?? 0) > 0 ? "text-red-400" : undefined} />
                      <Stat label="Naked-leg repairs" value={String(ledger?.nakedRepairs ?? 0)} />
                    </div>
                    <p className="text-[9px] font-mono text-muted-foreground/70 mt-2">
                      last settle digit {ledger?.lastDigit ?? "—"} · last verdict {ledger?.lastSync ?? "—"} ·{" "}
                      ${(ledger?.legStake ?? 0).toFixed(2)}/leg (pair ${(ledger?.pairExposure ?? 0).toFixed(2)})
                    </p>
                  </div>

                  {/* Recovery ledger */}
                  <div className="rounded-xl border border-white/5 p-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <Stat label="In recovery" value={session?.inRecovery ? "yes" : "no"} tone={session?.inRecovery ? "text-amber-300" : "text-green-400"} />
                    <Stat label="Step" value={String(session?.recoveryStep ?? 0)} />
                    <Stat label="Debt" value={`$${(session?.unrecoveredAmount ?? 0).toFixed(2)}`} tone={(session?.unrecoveredAmount ?? 0) > 0 ? "text-amber-300" : undefined} />
                    <Stat label="Cycles" value={String(ledger?.cycleCount ?? 0)} />
                  </div>

                  {rail?.signals?.length ? (
                    <details className="rounded-xl border border-white/5 px-3 py-2">
                      <summary className="text-[10px] uppercase tracking-wider text-muted-foreground/70 cursor-pointer">
                        Measurement behind this session
                      </summary>
                      <ul className="mt-2 space-y-1.5">
                        {rail.signals.map((s, i) => (
                          <li key={i} className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                            <span className={a.text}>›</span><span>{s}</span>
                          </li>
                        ))}
                        <li className="text-[10px] text-muted-foreground leading-relaxed flex gap-1.5">
                          <span className={a.text}>›</span>
                          <span>Quotes: {rail.quotesLive ? "live Deriv proposals" : "canonical payout table (feed unreachable)"} · trigger: {rail.trigger} · verdict: {rail.verdict}{rail.forced ? " (FORCED)" : ""}</span>
                        </li>
                      </ul>
                    </details>
                  ) : null}

                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      onClick={handleStop}
                      disabled={loading || !isRunning}
                      variant="outline"
                      className="flex-1 h-10 text-xs font-semibold border-red-500/40 text-red-300 hover:bg-red-500/10"
                    >
                      <StopCircle className="w-4 h-4 mr-1.5" /> Stop session
                    </Button>
                    {!isRunning && (
                      <Button
                        onClick={() => { setStep("config"); setScanResult(null); }}
                        variant="outline"
                        className={`flex-1 h-10 text-xs font-semibold ${a.outlineBtn}`}
                      >
                        <RefreshCw className="w-4 h-4 mr-1.5" /> New measurement
                      </Button>
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
