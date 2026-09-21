/**
 * Over/Under Navigator console.
 *
 * The control surface intentionally mirrors the dedicated recovery consoles,
 * but its signature is the four-way plan editor: normal Over/Under digits,
 * recovery Over/Under digits, plus an explicit same-digit shortcut. The live
 * view keeps the recovery radar and its static bar visible so a user can see
 * that the bot is waiting for quality, not silently hardening a gate after a
 * loss.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  Activity,
  Crosshair,
  Loader2,
  Lock,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Shuffle,
  StopCircle,
  X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card, CardContent } from "./ui/card";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";

type Step = "config" | "scanning" | "result" | "running";
type Side = "both" | "over" | "under";
type Candidate = {
  symbol: string;
  displayName: string;
  verdict: "prime" | "viable" | "thin";
  confidence: number;
  paperEdgePerDollar: number;
  normalHitRate: number;
  normalShots: number;
  recoveryHitRate: number;
  recoveryShots: number;
  recoveryLossPairs: number;
  avgTicksInRecovery: number;
  fireRatePer100: number;
  breakEvenNormal: number;
  breakEvenRecovery: number;
  params: any;
  diag: any;
  metrics: any;
};
type ScanResult = {
  suitable: boolean;
  best: Candidate | null;
  bestAvailable: Candidate | null;
  allScored: Candidate[];
  reason: string;
  marketsScanned: number;
  historyDepth: number;
};

function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  accent,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <label
      className={`flex items-center justify-between gap-2 text-muted-foreground ${max < 10 ? "text-[10px]" : "text-xs"}`}
    >
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(Math.max(min, Math.min(max, Number(e.target.value))))
        }
        className={`${max < 10 ? "w-12 px-2" : "w-20"} shrink-0 h-7 text-xs text-right font-mono bg-black/30 border-white/10 ${a.focusBorder}`}
      />
    </label>
  );
}
function SidePicker({
  value,
  onChange,
  accent,
  recovery = false,
}: {
  value: Side;
  onChange: (v: Side) => void;
  accent: AccentKey;
  recovery?: boolean;
}) {
  const a = ACCENTS[accent];
  return (
    <div
      className="grid grid-cols-3 gap-1.5"
      title={
        recovery
          ? "Recovery scores every enabled side and chooses the best utility."
          : "Normal timing uses the soft pacing valve."
      }
    >
      {(["both", "over", "under"] as Side[]).map((side) => (
        <button
          key={side}
          type="button"
          onClick={() => onChange(side)}
          className={`rounded-md border px-1.5 py-1.5 text-[10px] font-semibold transition ${value === side ? `${a.badgeBg} ${a.panelBorder} ${a.text}` : "border-white/10 text-muted-foreground hover:border-white/25"}`}
        >
          {side === "both"
            ? "Over + Under"
            : `${side[0]!.toUpperCase()}${side.slice(1)} only`}
        </button>
      ))}
    </div>
  );
}
function Stat({
  label,
  value,
  tone = "text-white/90",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg bg-black/25 px-2.5 py-2">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </p>
      <p className={`mt-0.5 text-[11px] font-mono font-bold ${tone}`}>
        {value}
      </p>
    </div>
  );
}
function DigitBand({
  normalOver,
  normalUnder,
  recoveryOver,
  recoveryUnder,
  accent,
}: {
  normalOver: number;
  normalUnder: number;
  recoveryOver: number;
  recoveryUnder: number;
  accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <div
      className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-2`}
    >
      <div className="flex items-center justify-between">
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/70">
          Your four barriers · 0–9
        </p>
        <span className="text-[9px] font-mono text-muted-foreground/60">
          normal → recovery
        </span>
      </div>
      <div className="grid grid-cols-10 gap-1">
        {Array.from({ length: 10 }, (_, d) => (
          <div key={d} className="space-y-1 text-center">
            <div
              className={`h-1.5 rounded-sm ${d > normalOver ? "bg-sky-400/75" : "bg-black/35"}`}
              title={`Normal Over ${normalOver}`}
            />
            <div
              className={`h-1.5 rounded-sm ${d < normalUnder ? "bg-indigo-400/75" : "bg-black/35"}`}
              title={`Normal Under ${normalUnder}`}
            />
            <div
              className={`h-1.5 rounded-sm ${d > recoveryOver ? "bg-fuchsia-400/80" : "bg-black/35"}`}
              title={`Recovery Over ${recoveryOver}`}
            />
            <div
              className={`h-1.5 rounded-sm ${d < recoveryUnder ? "bg-violet-400/80" : "bg-black/35"}`}
              title={`Recovery Under ${recoveryUnder}`}
            />
            <span className="text-[9px] font-mono text-muted-foreground/70">
              {d}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[8px] text-muted-foreground/70">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-sky-400/75" />
          normal over
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-indigo-400/75" />
          normal under
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-fuchsia-400/80" />
          recovery over
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-sm bg-violet-400/80" />
          recovery under
        </span>
      </div>
    </div>
  );
}

export function OverUnderNavigatorConsole({
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
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [progress, setProgress] = useState({
    scanning: "",
    scanned: 0,
    total: 19,
  });
  const [normalOver, setNormalOver] = useState(1);
  const [normalUnder, setNormalUnder] = useState(8);
  const [recoveryOver, setRecoveryOver] = useState(6);
  const [recoveryUnder, setRecoveryUnder] = useState(3);
  const [sameDigits, setSameDigits] = useState(false);
  const [normalSide, setNormalSide] = useState<Side>("both");
  const [recoverySide, setRecoverySide] = useState<Side>("both");
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const [risk, setRisk] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
  });
  const a = ACCENTS[bot?.accent ?? "fuchsia"];
  const isRunning = session?.running === true && session?.botId === bot?.id;
  const Icon = bot ? (BOT_ICON[bot.icon] ?? Crosshair) : Crosshair;

  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [step, selectedSymbol]);
  useEffect(() => {
    if (sameDigits) {
      setRecoveryOver(normalOver);
      setRecoveryUnder(normalUnder);
    }
  }, [sameDigits, normalOver, normalUnder]);
  useEffect(() => {
    if (isRunning) setStep("running");
  }, [isRunning]);
  useEffect(() => {
    if (open) {
      setScan(null);
      setStep(isRunning ? "running" : "config");
    }
  }, [open]);

  const applyStatus = useCallback(
    (data: BotSessionStatus) => onSession(data),
    [onSession],
  );
  useEffect(() => {
    if (!open || !bot) return;
    let source: EventSource;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dead = false;
    const connect = () => {
      if (dead) return;
      source = new EventSource(withTabSession("/api/ai/events"));
      source.addEventListener("bot_update", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          if (d.botId === bot.id) applyStatus(d);
        } catch {}
      });
      source.addEventListener("bot_scan_progress", (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data);
          if (d.botId === bot.id)
            setProgress({
              scanning: d.scanning ?? "",
              scanned: d.scanned ?? 0,
              total: d.total ?? 19,
            });
        } catch {}
      });
      source.onerror = () => {
        source.close();
        if (!dead) timer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [open, bot, applyStatus]);

  if (!bot) return null;
  const plan = {
    normalOver,
    normalUnder,
    recoveryOver,
    recoveryUnder,
    normalSide,
    recoverySide,
  };
  const buildBody = () => ({ ...plan, ...risk });
  const handleScan = async () => {
    setLoading(true);
    setStep("scanning");
    setScan(null);
    setSelectedSymbol("");
    setProgress({
      scanning: "Starting multi-market scan",
      scanned: 0,
      total: 19,
    });
    try {
      const res = await fetch("/api/bots/overunder-navigator/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scan failed");
      setScan(data);
      setStep("result");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Could not connect to the Navigator",
      );
      setStep("config");
    } finally {
      setLoading(false);
    }
  };
  const handleStart = async (
    candidate: Candidate,
    mode: "locked" | "switching",
  ) => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/overunder-navigator/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          marketMode: mode,
          symbol: candidate.symbol,
          lockedSymbol: mode === "locked" ? candidate.symbol : undefined,
          params: candidate.params,
          analysis: candidate,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Start failed");
      onSession(data.status);
      setStep("running");
      toast.success(
        mode === "locked"
          ? `Locked on ${candidate.displayName}`
          : "Recovery switching enabled — the Navigator can hunt better markets",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not start the Navigator",
      );
    } finally {
      setLoading(false);
    }
  };
  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/bots/overunder-navigator/stop", {
        method: "POST",
      });
      const data = await res.json();
      onSession(data.status ?? null);
      toast.success("Navigator stopped");
    } catch {
      toast.error("Could not stop the Navigator");
    } finally {
      setLoading(false);
    }
  };
  const candidate =
    scan?.allScored.find((market) => market.symbol === selectedSymbol) ??
    scan?.best ??
    scan?.bestAvailable;
  const watch = session?.navigatorWatch;
  const deployed = session?.navigatorDeployed;
  const profit = session?.totalProfit ?? 0;

  const Header = () => (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${a.iconBg} ${a.iconBorder}`}
        >
          <Icon className={`h-4 w-4 ${a.text}`} />
        </div>
        <div>
          <h2 className="text-xs font-bold text-white">{bot.name}</h2>
          <p className="text-[10px] text-muted-foreground">
            Custom barriers · recovery-first execution
          </p>
        </div>
      </div>
      <button
        aria-label="Close console"
        onClick={() => onOpenChange(false)}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-white/10"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
  const InfoStrip = () => (
    <div className="rounded-lg border border-fuchsia-500/25 bg-fuchsia-500/[0.06] p-2.5">
      <p className="text-[9px] font-bold text-fuchsia-300">
        FIXED RECOVERY BAR · PAIR-AWARE
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Recovery waits or hunts. Losses never tighten the entry rules.
      </p>
    </div>
  );

  const configPanel = (
    <div className="space-y-3">
      <InfoStrip />
      <div className="space-y-3">
        <div className="space-y-3">
          <details className="text-[10px] text-fuchsia-200">
            <summary className="cursor-pointer">
              Barrier map · normal {normalOver}/{normalUnder} → recovery{" "}
              {recoveryOver}/{recoveryUnder}
            </summary>
            <div className="mt-2">
              <DigitBand
                normalOver={normalOver}
                normalUnder={normalUnder}
                recoveryOver={recoveryOver}
                recoveryUnder={recoveryUnder}
                accent="fuchsia"
              />
            </div>
          </details>
          <Card className="border-white/10 bg-white/[.025]">
            <CardContent className="space-y-2.5 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Normal plan
                </p>
                <span className="text-[9px] font-mono text-sky-300">
                  outer choice
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumInput
                  label="Over digit"
                  value={normalOver}
                  onChange={setNormalOver}
                  min={0}
                  max={8}
                  accent="fuchsia"
                />
                <NumInput
                  label="Under digit"
                  value={normalUnder}
                  onChange={setNormalUnder}
                  min={1}
                  max={9}
                  accent="fuchsia"
                />
              </div>
              <SidePicker
                value={normalSide}
                onChange={setNormalSide}
                accent="fuchsia"
              />
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/[.025]">
            <CardContent className="space-y-2.5 p-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Recovery plan
                </p>
                <label className="flex cursor-pointer items-center gap-2 text-[10px] text-fuchsia-200">
                  <input
                    type="checkbox"
                    checked={sameDigits}
                    onChange={(e) => setSameDigits(e.target.checked)}
                    className="accent-fuchsia-400"
                  />{" "}
                  same digits as normal
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumInput
                  label="Over digit"
                  value={recoveryOver}
                  onChange={(v) => {
                    setSameDigits(false);
                    setRecoveryOver(v);
                  }}
                  min={0}
                  max={8}
                  accent="fuchsia"
                />
                <NumInput
                  label="Under digit"
                  value={recoveryUnder}
                  onChange={(v) => {
                    setSameDigits(false);
                    setRecoveryUnder(v);
                  }}
                  min={1}
                  max={9}
                  accent="fuchsia"
                />
              </div>
              <SidePicker
                value={recoverySide}
                onChange={setRecoverySide}
                accent="fuchsia"
                recovery
              />
            </CardContent>
          </Card>
        </div>
        <Card className="border-white/10 bg-white/[.025]">
          <CardContent className="space-y-2.5 p-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Execution budget
            </p>
            <NumInput
              label="Base stake"
              value={risk.stake}
              onChange={(v) => setRisk((r) => ({ ...r, stake: v }))}
              min={0.35}
              max={10000}
              accent="fuchsia"
            />
            <NumInput
              label="Take profit"
              value={risk.takeProfit}
              onChange={(v) => setRisk((r) => ({ ...r, takeProfit: v }))}
              min={0.01}
              max={100000}
              accent="fuchsia"
            />
            <NumInput
              label="Stop loss"
              value={risk.stopLoss}
              onChange={(v) => setRisk((r) => ({ ...r, stopLoss: v }))}
              min={0.01}
              max={100000}
              accent="fuchsia"
            />
            <NumInput
              label="Max recovery steps"
              value={risk.maxRecoverySteps}
              onChange={(v) =>
                setRisk((r) => ({ ...r, maxRecoverySteps: Math.round(v) }))
              }
              min={1}
              max={10}
              accent="fuchsia"
            />
            <Button
              onClick={handleScan}
              disabled={loading}
              className={`mt-2 w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
            >
              <ScanSearch className="mr-2 h-4 w-4" /> Scan all digit markets
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
  const scanningPanel = (
    <div className="space-y-4 py-10 text-center">
      <Loader2 className="mx-auto h-8 w-8 animate-spin text-fuchsia-300" />
      <p className="text-sm font-semibold text-white">
        Measuring your normal + recovery plan
      </p>
      <p className="text-xs text-muted-foreground">
        {progress.scanning} · {progress.scanned}/{progress.total} markets
      </p>
      <div className="mx-auto h-1.5 max-w-md overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full bg-fuchsia-400 transition-all"
          style={{
            width: `${Math.min(100, (progress.scanned / Math.max(1, progress.total)) * 100)}%`,
          }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground/70">
        Walk-forward lenses: digit Markov · loss clustering · hole hazard ·
        suffix memory
      </p>
    </div>
  );
  const resultPanel = scan && (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Navigator scan
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {scan.reason}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-[10px]"
          onClick={() => setStep("config")}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Edit plan
        </Button>
      </div>
      {candidate && (
        <Card
          className={`border ${candidate.verdict === "prime" ? "border-emerald-400/35 bg-emerald-400/[.06]" : "border-fuchsia-400/30 bg-fuchsia-400/[.05]"}`}
        >
          <CardContent className="space-y-2.5 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-bold text-white">
                  {candidate.displayName}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {candidate.symbol} · {candidate.verdict.toUpperCase()} ·
                  confidence {candidate.confidence}%
                </p>
              </div>
              <span className="shrink-0 rounded border border-white/10 px-1.5 py-1 text-[9px] font-mono text-fuchsia-200">
                {(candidate.paperEdgePerDollar * 100).toFixed(2)}% edge
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <Stat
                label="Normal hits"
                value={`${(candidate.normalHitRate * 100).toFixed(0)}% / ${candidate.normalShots}`}
              />
              <Stat
                label="Recovery hits"
                value={`${(candidate.recoveryHitRate * 100).toFixed(0)}% / ${candidate.recoveryShots}`}
                tone={
                  candidate.recoveryHitRate >= 0.55
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              />
              <Stat
                label="Loss pairs"
                value={`${candidate.recoveryLossPairs}`}
                tone={
                  candidate.recoveryLossPairs === 0
                    ? "text-emerald-300"
                    : "text-amber-300"
                }
              />
              <Stat
                label="Debt ticks"
                value={candidate.avgTicksInRecovery.toFixed(1)}
              />
              <Stat
                label="Fire rate"
                value={`${candidate.fireRatePer100.toFixed(1)}/100`}
              />
            </div>
            <div className="space-y-2">
              <Button
                onClick={() => handleStart(candidate, "locked")}
                disabled={loading}
                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
              >
                <Lock className="mr-2 h-4 w-4" /> Trade Locked
              </Button>
              <Button
                onClick={() => handleStart(candidate, "switching")}
                disabled={loading}
                variant="outline"
                className={`w-full h-9 ${a.outlineBtn} text-xs font-semibold`}
              >
                <Shuffle className="mr-2 h-3.5 w-3.5" /> Smart Switching
              </Button>
              <p className="text-[9px] leading-relaxed text-muted-foreground">
                Lock stays on this market. Switching can hunt recovery
                opportunities elsewhere.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      {scan.allScored
        .filter((c) => c.symbol !== candidate?.symbol)
        .slice(0, 4)
        .map((c) => (
          <div
            key={c.symbol}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[.02] p-3"
          >
            <div>
              <p className="text-xs font-semibold text-white">
                {c.displayName}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {c.verdict} · rec {(c.recoveryHitRate * 100).toFixed(0)}% ·{" "}
                {c.recoveryLossPairs} loss pairs
              </p>
            </div>
            <button
              onClick={() => setSelectedSymbol(c.symbol)}
              aria-label={`Select ${c.displayName}`}
              className="shrink-0 rounded border border-white/15 px-2 py-1 text-[10px] text-fuchsia-200 hover:bg-white/5"
            >
              Select
            </button>
          </div>
        ))}
    </div>
  );
  const livePanel = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-fuchsia-300">
            Navigator live
          </p>
          <p className="text-sm font-bold text-white">
            {session?.currentMarket ?? deployed?.displayName ?? "Starting…"}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {session?.message}
          </p>
        </div>
        <Button
          onClick={handleStop}
          disabled={loading}
          variant="outline"
          className="border-red-400/40 text-red-300"
        >
          <StopCircle className="mr-2 h-4 w-4" /> Stop
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Stat
          label="P&L"
          value={`${profit >= 0 ? "+" : "−"}$${Math.abs(profit).toFixed(2)}`}
          tone={profit >= 0 ? "text-emerald-300" : "text-red-300"}
        />
        <Stat
          label="Trades"
          value={`${session?.winCount ?? 0}W · ${session?.lossCount ?? 0}L`}
        />
        <Stat
          label="Mode"
          value={(
            watch?.mode ?? (session?.inRecovery ? "recovery" : "normal")
          ).toUpperCase()}
          tone={watch?.mode === "recovery" ? "text-amber-300" : "text-sky-300"}
        />
        <Stat label="Contract" value={watch?.sideLabel ?? "—"} />
        <Stat label="Bar" value={`${((watch?.bar ?? 0) * 100).toFixed(1)}%`} />
      </div>
      {watch && (
        <div
          className={`rounded-xl border p-4 ${watch.mode === "recovery" ? "border-amber-400/30 bg-amber-400/[.05]" : "border-sky-400/25 bg-sky-400/[.04]"}`}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[9px] uppercase tracking-widest text-muted-foreground">
                {watch.mode} timing · {watch.sideLabel}
              </p>
              <p className="text-xl font-bold font-mono text-white">
                {(watch.p * 100).toFixed(1)}%{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  vs {(watch.bar * 100).toFixed(1)}% bar
                </span>
              </p>
            </div>
            <span
              className={`rounded px-2 py-1 text-[10px] font-mono ${watch.ready ? "bg-emerald-400/15 text-emerald-300" : "bg-white/5 text-muted-foreground"}`}
            >
              {watch.ready
                ? "ARMED · next execution"
                : watch.phase.toUpperCase()}
            </span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded bg-white/10">
            <div
              className={`${watch.mode === "recovery" ? "bg-amber-400" : "bg-sky-400"} h-full transition-all`}
              style={{ width: `${Math.min(100, watch.p * 100)}%` }}
            />
            <div
              className="relative -mt-2 h-2 border-r-2 border-white/80"
              style={{ marginLeft: `${Math.min(100, watch.bar * 100)}%` }}
            />
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            {watch.reason}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {watch.recoveryRadar.map((r) => (
              <div
                key={r.label}
                className="flex items-center justify-between rounded-lg bg-black/20 px-2.5 py-2 text-[10px]"
              >
                <span className="text-white/80">{r.label}</span>
                <span
                  className={
                    r.ready ? "text-emerald-300" : "text-muted-foreground"
                  }
                >
                  {(r.p * 100).toFixed(1)}% · bar {(r.bar * 100).toFixed(0)}%{" "}
                  {r.ready ? "✓" : ""}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[9px] text-muted-foreground">
            <span>pair risk {(watch.pairRisk * 100).toFixed(1)}%</span>
            <span>qLL {(watch.qLL * 100).toFixed(1)}%</span>
            <span>{watch.switched ? "market switched" : "market stable"}</span>
            <span className="text-fuchsia-200">bar is static</span>
          </div>
        </div>
      )}
      {deployed && (
        <div className="grid grid-cols-2 gap-1.5">
          <Stat
            label="Measured normal"
            value={`${(deployed.normalHitRate * 100).toFixed(0)}% / ${deployed.normalShots}`}
          />
          <Stat
            label="Measured recovery"
            value={`${(deployed.recoveryHitRate * 100).toFixed(0)}% / ${deployed.recoveryShots}`}
          />
          <Stat
            label="Recovery pairs"
            value={`${deployed.recoveryLossPairs}`}
          />
          <Stat
            label="Unrecovered"
            value={`$${(session?.unrecoveredAmount ?? 0).toFixed(2)}`}
          />
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          <ShieldCheck className="mr-1 inline h-3.5 w-3.5 text-fuchsia-300" />
          No post-loss hardening is used.
        </span>
        <span>
          {session?.recoveryStep
            ? `Recovery step ${session.recoveryStep}`
            : "Normal leg"}
        </span>
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
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            ref={panelRef}
            role="dialog"
            aria-label={`${bot.name} console`}
            className="fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-2xl border border-fuchsia-400/20 bg-[#080b18]/[.98] shadow-2xl shadow-fuchsia-950/30 backdrop-blur-xl"
          >
            <div className="space-y-3 p-3">
              <Header />
              {step === "config" && configPanel}
              {step === "scanning" && scanningPanel}
              {step === "result" && resultPanel}
              {step === "running" && livePanel}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
