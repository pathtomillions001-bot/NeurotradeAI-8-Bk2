/**
 * Twin-Hedge Edge console (11th bot).
 *
 * The user picks a digit pair (Over A / Under B), a certainty bar and whether
 * the market is LOCKED or may SWITCH between pair-shots. The bot then measures
 * every digit market out of sample, and when a shot fires it places BOTH legs
 * on the SAME market at the SAME tick with a small adaptive stake-skew on the
 * favoured side.
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
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useGetSettings } from "@workspace/api-client-react";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "scan-result" | "running";
type Certainty = "elite" | "strict" | "balanced";
type Primary = "over" | "under";

interface Pair {
  overDigit: number;
  underDigit: number;
}
interface Candidate {
  symbol: string;
  displayName: string;
  contract: Pair;
  label: string;
  verdict: "certified" | "qualified" | "watch" | "refused";
  confidence: number;
  edgePerDollar: number;
  evLowerPerDollar: number;
  oosWinRate: number;
  oosShots: number;
  primary: Primary;
  bias: number;
  breakEvenWinRate: number;
  overPayout: number;
  underPayout: number;
  netOnWinPerBase: number;
  netOnLossPerBase: number;
  ladderSafety: number;
  ladderLimit: number;
  deployable: boolean;
  card: any;
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
  outcome?: {
    overCount: number;
    underCount: number;
    bothCount: number;
    noneCount: number;
    complementary: boolean;
  };
}

const VERDICT_TONE: Record<Candidate["verdict"], string> = {
  certified: "text-green-400 bg-green-500/10 border-green-500/30",
  qualified: "text-sky-300 bg-sky-500/10 border-sky-500/30",
  watch: "text-amber-300 bg-amber-500/10 border-amber-500/30",
  refused: "text-red-400 bg-red-500/10 border-red-500/30",
};

const CERTAINTIES: Array<{ id: Certainty; label: string; hint: string }> = [
  { id: "balanced", label: "Balanced", hint: "most shots" },
  { id: "strict", label: "Strict", hint: "balanced proof" },
  { id: "elite", label: "Elite", hint: "rarest, most proof" },
];

const PRESET_PAIRS: Array<Pair & { label: string }> = [
  { overDigit: 4, underDigit: 5, label: "Over 4 / Under 5" },
  { overDigit: 7, underDigit: 2, label: "Over 7 / Under 2" },
  { overDigit: 6, underDigit: 3, label: "Over 6 / Under 3" },
  { overDigit: 8, underDigit: 1, label: "Over 8 / Under 1" },
  { overDigit: 2, underDigit: 8, label: "Over 2 / Under 8" },
  { overDigit: 1, underDigit: 9, label: "Over 1 / Under 9" },
];

const OVER_DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const UNDER_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

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
          <span className="text-[10px] text-muted-foreground w-6">
            {suffix}
          </span>
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
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
        {lbl}
      </p>
      <p
        className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}
      >
        {value}
      </p>
    </div>
  );
}

function labelOf(p: Pair): string {
  return `Over ${p.overDigit} · Under ${p.underDigit}`;
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
  const [progress, setProgress] = useState<{
    scanning: string | null;
    scanned: number;
    total: number;
  }>({
    scanning: null,
    scanned: 0,
    total: 19,
  });
  const { data: settings } = useGetSettings();

  const [pair, setPair] = useState<Pair>({ overDigit: 4, underDigit: 5 });
  const [certainty, setCertainty] = useState<Certainty>("balanced");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">(
    "locked",
  );
  const [targetEv, setTargetEv] = useState(0.01);
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
    if (isRunning) {
      setStep("running");
      const m = (session?.config as any)?.marketMode;
      if (m === "locked" || m === "switching") setMarketMode(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);
  useEffect(() => {
    if (!open) return;
    setScanResult(null);
    setStep(isRunning ? "running" : "config");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const applyStatus = useCallback(
    (d: BotSessionStatus) => onSession(d),
    [onSession],
  );

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
          setProgress({
            scanning: p.scanning,
            scanned: p.scanned,
            total: p.total,
          });
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

  const buildBody = () => ({
    botId: bot.id,
    overDigit: pair.overDigit,
    underDigit: pair.underDigit,
    certainty,
    targetEvPerDollar: targetEv,
    ...config,
  });

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

  const handleStart = async (c: Candidate, mode: "locked" | "switching") => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/twin/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          marketMode: mode,
          symbol: c.symbol,
          card: c.card,
          analysis: c,
          ...(mode === "locked" ? { lockedSymbol: c.symbol } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start");
        return;
      }
      onSession(data.status);
      setMarketMode(mode);
      setStep("running");
      toast.success(
        mode === "locked"
          ? `🔒 Locked on ${c.displayName} — both legs trade this market only`
          : `🔁 Deployed on ${c.displayName} — switching re-measures, both legs stay on one market`,
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

  const CandidateCard = ({ c }: { c: Candidate }) => (
    <div
      className={`rounded-xl border ${VERDICT_TONE[c.verdict]} p-3 space-y-2`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold text-white">
          {c.displayName} · <span className="text-white/80">{c.label}</span>
        </p>
        <span className="text-[10px] font-mono font-bold uppercase">
          {c.verdict}
        </span>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-mono text-white/80">{c.oosShots}</span> unseen
        pair shots at{" "}
        <span className="font-mono text-white/80">
          {(c.oosWinRate * 100).toFixed(0)}%
        </span>{" "}
        joint win rate — net{" "}
        <span
          className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}
        >
          {c.edgePerDollar >= 0 ? "+" : ""}
          {(c.edgePerDollar * 100).toFixed(2)}%
        </span>{" "}
        per $1 base · skew {c.primary.toUpperCase()} +
        {(c.bias * 100).toFixed(1)}%
      </p>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat
          label="Win net"
          value={`${(c.netOnWinPerBase * 100).toFixed(2)}%`}
          tone="text-green-400"
        />
        <Stat
          label="Loss net"
          value={`${(c.netOnLossPerBase * 100).toFixed(2)}%`}
          tone="text-red-400"
        />
        <Stat label="Ladder" value={`${(c.ladderSafety * 100).toFixed(0)}%`} />
      </div>
    </div>
  );

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

            {/* CONFIG */}
            {step === "config" && (
              <div className="p-4 space-y-4">
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Digit pair (both legs)
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {PRESET_PAIRS.map((p) => (
                      <button
                        key={`${p.overDigit}-${p.underDigit}`}
                        onClick={() =>
                          setPair({
                            overDigit: p.overDigit,
                            underDigit: p.underDigit,
                          })
                        }
                        className={`px-2 py-2 rounded-lg text-[11px] font-semibold transition-colors ${
                          pair.overDigit === p.overDigit &&
                          pair.underDigit === p.underDigit
                            ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Over digit
                    </p>
                    <div className="grid grid-cols-5 gap-1">
                      {OVER_DIGITS.map((d) => (
                        <button
                          key={`o${d}`}
                          onClick={() =>
                            setPair((prev) => ({ ...prev, overDigit: d }))
                          }
                          className={`h-8 rounded-lg text-xs font-mono font-bold transition-colors ${
                            pair.overDigit === d
                              ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                              : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Under digit
                    </p>
                    <div className="grid grid-cols-5 gap-1">
                      {UNDER_DIGITS.map((d) => (
                        <button
                          key={`u${d}`}
                          onClick={() =>
                            setPair((prev) => ({ ...prev, underDigit: d }))
                          }
                          className={`h-8 rounded-lg text-xs font-mono font-bold transition-colors ${
                            pair.underDigit === d
                              ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                              : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Proof */}
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Proof required
                  </p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {CERTAINTIES.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => setCertainty(c.id)}
                        className={`px-2 py-2 rounded-lg text-center transition-colors ${
                          certainty === c.id
                            ? `${a.activeBg} border ${a.activeBorder} ${a.text}`
                            : "bg-white/[0.03] border border-white/5 text-muted-foreground hover:bg-white/[0.07]"
                        }`}
                      >
                        <span className="block text-[11px] font-semibold">
                          {c.label}
                        </span>
                        <span className="block text-[8px] text-muted-foreground/70">
                          {c.hint}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <NumInput
                    label="Target edge / $1 base"
                    value={targetEv}
                    onChange={setTargetEv}
                    min={0.001}
                    step={0.005}
                    suffix="USD"
                    accent={bot.accent}
                  />
                  <NumInput
                    label="Stake per shot"
                    value={config.stake}
                    onChange={(v) => set("stake", v)}
                    min={0.35}
                    step={0.5}
                    suffix="USD"
                    accent={bot.accent}
                  />
                  <NumInput
                    label="Take profit"
                    value={config.takeProfit}
                    onChange={(v) => set("takeProfit", v)}
                    min={1}
                    step={1}
                    suffix="USD"
                    accent={bot.accent}
                  />
                  <NumInput
                    label="Stop loss"
                    value={config.stopLoss}
                    onChange={(v) => set("stopLoss", v)}
                    min={1}
                    step={1}
                    suffix="USD"
                    accent={bot.accent}
                  />
                  <NumInput
                    label="Max recovery steps"
                    value={config.maxRecoverySteps}
                    onChange={(v) => set("maxRecoverySteps", v)}
                    min={1}
                    step={1}
                    accent={bot.accent}
                  />
                </div>

                <Button
                  onClick={handleScan}
                  disabled={loading}
                  className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                >
                  <ScanSearch className="w-4 h-4 mr-2" /> Measure both legs
                  everywhere
                </Button>
              </div>
            )}

            {/* SCANNING */}
            {step === "scanning" && (
              <div className="p-6 space-y-4 text-center">
                <Loader2 className={`w-8 h-8 ${a.text} animate-spin mx-auto`} />
                <div>
                  <p className="text-sm font-semibold text-white">
                    Measuring the joint pair out of sample
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {progress.scanning ? `${progress.scanning}…` : "Preparing…"}
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
                  {progress.scanned}/{progress.total} markets
                </p>
              </div>
            )}

            {/* SCAN RESULT */}
            {step === "scan-result" && scanResult && (
              <div className="p-4 space-y-3">
                {scanResult.best && scanResult.suitable ? (
                  <>
                    <CandidateCard c={scanResult.best} />
                    <div className="space-y-2">
                      <Button
                        onClick={() => handleStart(scanResult.best!, "locked")}
                        disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                      >
                        <Lock className="w-4 h-4 mr-2" /> Trade locked on{" "}
                        {scanResult.best.displayName}
                      </Button>
                      <Button
                        onClick={() =>
                          handleStart(scanResult.best!, "switching")
                        }
                        disabled={loading}
                        variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}
                      >
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Smart market
                        switching
                      </Button>
                    </div>
                  </>
                ) : scanResult.bestAvailable &&
                  scanResult.bestAvailable.edgePerDollar > 0 ? (
                  <>
                    <CandidateCard c={scanResult.bestAvailable} />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Measured expectancy is positive but this pair did not
                      clear the full bar. Starting it is a deliberate choice —
                      the bot re-measures and stops if the pair cools.
                    </p>
                    <div className="space-y-2">
                      <Button
                        onClick={() =>
                          handleStart(scanResult.bestAvailable!, "locked")
                        }
                        disabled={loading}
                        className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
                      >
                        <Lock className="w-4 h-4 mr-2" /> Lock{" "}
                        {scanResult.bestAvailable.displayName} anyway
                      </Button>
                      <Button
                        onClick={() =>
                          handleStart(scanResult.bestAvailable!, "switching")
                        }
                        disabled={loading}
                        variant="outline"
                        className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}
                      >
                        <Shuffle className="w-3.5 h-3.5 mr-2" /> Start switching
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2 text-center">
                    <p className="text-xs font-semibold text-amber-300">
                      No positive pair edge right now
                    </p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {scanResult.reason}
                    </p>
                  </div>
                )}

                {scanResult.outcome && (
                  <div className="rounded-lg bg-white/[0.03] border border-white/10 px-2.5 py-2 text-[10px] font-mono text-muted-foreground">
                    {scanResult.outcome.complementary
                      ? "Complementary pair — exactly one leg always wins (no both-lose zone)."
                      : `${scanResult.outcome.overCount} over digits · ${scanResult.outcome.underCount} under digits · ${scanResult.outcome.bothCount} overlap · ${scanResult.outcome.noneCount} dead digit(s).`}
                  </div>
                )}

                {scanResult.allScored.length > 1 && (
                  <div className="space-y-1 pt-1 border-t border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                      Runner-ups
                    </p>
                    {scanResult.allScored.slice(1, 6).map((c, i) => (
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
                        <span className="font-medium flex-1 truncate text-white/80">
                          {c.displayName} · {c.label}
                        </span>
                        <span
                          className={`font-mono font-bold ${c.edgePerDollar >= 0 ? "text-green-400" : "text-red-400"}`}
                        >
                          {c.edgePerDollar >= 0 ? "+" : ""}
                          {(c.edgePerDollar * 100).toFixed(1)}%
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
                  <ChevronLeft className="w-3 h-3" /> Change pair or risk
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
                      <span
                        className={`flex items-center gap-1 text-[10px] ${a.text}`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`}
                        />
                        {marketMode === "locked" ? "LOCKED" : "SWITCHING"}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        STOPPED
                      </span>
                    )}
                  </div>
                  <div
                    className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}
                  >
                    {profit >= 0 ? "+" : "−"}${Math.abs(profit).toFixed(2)}
                  </div>
                  <div className="flex gap-3 mt-2 text-[11px] flex-wrap">
                    <span className="text-green-400">
                      {session?.winCount ?? 0}W
                    </span>
                    <span className="text-red-400">
                      {session?.lossCount ?? 0}L
                    </span>
                    <span className="text-muted-foreground">{winRate}% WR</span>
                    <span className="text-muted-foreground">
                      {session?.tradeCount ?? 0} pair shots
                    </span>
                  </div>
                </div>

                {deployed && (
                  <div
                    className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}
                      >
                        {marketMode === "locked"
                          ? "Locked market"
                          : "Active market"}
                      </p>
                      {watch?.switched && (
                        <span className="text-[9px] font-mono text-amber-300">
                          ↻ rotated
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-bold text-white">
                      {deployed.displayName}
                    </p>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Stat
                        label="Pair"
                        value={deployed.contract}
                        tone={a.text}
                      />
                      <Stat
                        label="Verdict"
                        value={deployed.verdict.toUpperCase()}
                        tone={
                          deployed.verdict === "refused"
                            ? "text-red-400"
                            : "text-green-400"
                        }
                      />
                      <Stat
                        label="Primary"
                        value={`${deployed.primary.toUpperCase()} +${(deployed.bias * 100).toFixed(1)}%`}
                      />
                      <Stat
                        label="Measured net"
                        value={`${deployed.edgePerDollar >= 0 ? "+" : ""}${(deployed.edgePerDollar * 100).toFixed(2)}%`}
                        tone={
                          deployed.edgePerDollar >= 0
                            ? "text-green-400"
                            : "text-red-400"
                        }
                      />
                    </div>
                  </div>
                )}

                {isRunning && watch && (
                  <div
                    className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}
                  >
                    <div className="flex items-center justify-between">
                      <p
                        className={`text-[10px] uppercase tracking-widest font-semibold ${a.text}`}
                      >
                        {watch.phase === "firing"
                          ? "Firing"
                          : watch.phase === "armed"
                            ? "Armed"
                            : "Watching"}
                      </p>
                      <span className="text-[9px] font-mono text-muted-foreground/70">
                        edge {watch.z.toFixed(2)}σ / {watch.bar.toFixed(2)}σ bar
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {watch.reason || "Waiting…"}
                    </p>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Stat
                        label="P(over|ctx)"
                        value={`${(watch.pOver * 100).toFixed(1)}%`}
                      />
                      <Stat
                        label="P(under|ctx)"
                        value={`${(watch.pUnder * 100).toFixed(1)}%`}
                      />
                      <Stat
                        label="Skew"
                        value={`${watch.primary.toUpperCase()} +${(watch.bias * 100).toFixed(1)}%`}
                        tone={a.text}
                      />
                    </div>
                    {watch.overStake > 0 && (
                      <div className="grid grid-cols-2 gap-1.5">
                        <Stat
                          label="Over stake"
                          value={`$${watch.overStake.toFixed(2)}`}
                          tone="text-green-400"
                        />
                        <Stat
                          label="Under stake"
                          value={`$${watch.underStake.toFixed(2)}`}
                          tone="text-red-300"
                        />
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
                        <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />{" "}
                        Recovery (Step {session.recoveryStep})
                      </span>
                      <span className="font-mono text-[10px] text-amber-400">
                        ${(session.unrecoveredAmount ?? 0).toFixed(2)} debt
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      The recovery pair-shot keeps the same skew but raises the
                      base so a winning favored leg repays the debt.
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
