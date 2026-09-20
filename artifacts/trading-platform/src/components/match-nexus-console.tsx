import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  FlaskConical,
  Gauge,
  Loader2,
  Lock,
  Radio,
  ScanSearch,
  ShieldCheck,
  Shuffle,
  Square,
  Target,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useGetSettings } from "@workspace/api-client-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { withTabSession } from "@/lib/tab-session";
import type { BotConsoleProps } from "@/lib/console-registry";
import type { BotSessionStatus } from "@/lib/bots";
import {
  canDeployNexus,
  nexusDeployBody,
  nexusMoney as money,
  nexusPercent as pct,
  type NexusActivity,
  type NexusConfig,
  type NexusPrediction,
  type NexusRisk,
  type NexusScanView,
  type NexusValidation,
} from "@/lib/match-nexus";

type Step = "configure" | "scanning" | "results" | "session";
const PROFILES: Array<{ id: NexusActivity; label: string; copy: string }> = [
  {
    id: "active",
    label: "Active",
    copy: "Lighter uncertainty discount. More opportunities.",
  },
  {
    id: "balanced",
    label: "Balanced",
    copy: "Entry quality and responsiveness, together.",
  },
  {
    id: "patient",
    label: "Patient",
    copy: "Larger uncertainty discount. More selective.",
  },
];
const BASE = "/api/bots/match-nexus";
async function request<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BASE}/${path}`, {
    ...(body !== undefined
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Nexus request failed");
  return data as T;
}
const ms = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : `${n < 10 ? n.toFixed(2) : n.toFixed(0)} ms`;
const panel = "rounded-xl border border-white/[0.08] bg-white/[0.025]";
const labelClass =
  "text-[10px] font-mono uppercase tracking-[0.16em] text-slate-500";

function Metric({
  label,
  value,
  note,
  bright = false,
}: {
  label: string;
  value: string;
  note?: string;
  bright?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      <p
        className={`mt-1 font-mono text-lg font-semibold tracking-tight ${bright ? "text-lime-300" : "text-slate-100"}`}
      >
        {value}
      </p>
      {note && (
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          {note}
        </p>
      )}
    </div>
  );
}
function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-mono uppercase tracking-wider ${source === "live" ? "border-emerald-400/20 bg-emerald-400/5 text-emerald-300" : "border-amber-400/20 bg-amber-400/5 text-amber-300"}`}
    >
      <span
        className={`size-1.5 rounded-full ${source === "live" ? "bg-emerald-400" : "bg-amber-400"}`}
      />
      {source === "live" ? "Live tape" : "Simulated tape"}
    </span>
  );
}
function DigitDistribution({
  prediction,
  selected,
}: {
  prediction: NexusPrediction | null;
  selected: number | null;
}) {
  const max = Math.max(0.15, ...(prediction?.probabilities ?? []));
  return (
    <div className={`${panel} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={labelClass}>Next-tick digit distribution</p>
        <span className="text-[10px] text-slate-500">
          Estimates, not outcomes
        </span>
      </div>
      <div
        className="mt-5 grid grid-cols-10 gap-1.5 sm:gap-2"
        aria-label="Estimated probability for each next digit"
      >
        {Array.from({ length: 10 }, (_, digit) => {
          const p = prediction?.probabilities[digit] ?? 0.1;
          return (
            <div
              key={digit}
              className="flex min-w-0 flex-col items-center gap-2"
              title={`Digit ${digit}: ${pct(p)}; observed gap ${prediction?.gaps[digit] ?? 0} ticks`}
            >
              <span
                className={`text-[8px] font-mono sm:text-[10px] ${digit === selected ? "text-lime-300" : "text-slate-500"}`}
              >
                {pct(p, 0)}
              </span>
              <div className="relative flex h-20 w-full items-end overflow-hidden rounded-t bg-white/[0.025]">
                <div
                  className={`w-full rounded-t transition-[height] duration-200 ${digit === selected ? "bg-gradient-to-t from-lime-500/50 to-lime-300" : "bg-slate-600/40"}`}
                  style={{ height: `${Math.max(3, (p / max) * 100)}%` }}
                />
                <div
                  className="pointer-events-none absolute w-full border-t border-dashed border-white/20"
                  style={{ bottom: `${(0.1 / max) * 100}%` }}
                />
              </div>
              <span
                className={`flex size-6 items-center justify-center rounded-md font-mono text-xs ${digit === selected ? "bg-lime-300 text-slate-950 font-bold" : "text-slate-500"}`}
              >
                {digit}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2 text-[10px] text-slate-500">
        <span>Dashed line: 10% fair baseline</span>
        <span>
          {prediction?.samples.toLocaleString() ?? "—"} observed digits
        </span>
      </div>
    </div>
  );
}
function Evidence({ validation: v }: { validation: NexusValidation }) {
  return (
    <div className={`${panel} p-4 space-y-4`}>
      <div className="flex items-center justify-between gap-2">
        <p className={labelClass}>Held-out policy check</p>
        <span
          className={`rounded px-2 py-1 text-[9px] font-mono uppercase ${v.evidence === "supported" ? "bg-emerald-400/10 text-emerald-300" : v.evidence === "developing" ? "bg-sky-400/10 text-sky-300" : "bg-white/5 text-slate-400"}`}
        >
          {v.evidence}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Metric
          label="Hit rate"
          value={pct(v.hitRate)}
          note={`${v.wins} matches / ${v.shots} entries`}
        />
        <Metric
          label="95% interval"
          value={v.shots ? `${pct(v.lower95, 0)}–${pct(v.upper95, 0)}` : "—"}
          note="Wilson sampling interval"
        />
        <Metric
          label="Net / $1 staked"
          value={v.evPerStake === null ? "—" : money(v.evPerStake)}
          note="Historical, indicative payout"
        />
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/5 pt-3 text-[10px] text-slate-500">
        <span>Train → held-out ticks</span>
        <span className="text-right font-mono text-slate-300">
          {v.trainTicks.toLocaleString()} → {v.testTicks.toLocaleString()}
        </span>
        <span>Entry frequency</span>
        <span className="text-right font-mono text-slate-300">
          {pct(v.fireRate)} of held-out ticks
        </span>
        <span>Brier skill vs fair baseline</span>
        <span className="text-right font-mono text-slate-300">
          {pct(v.brierSkill, 2)}
        </span>
        <span>Longest held-out loss run</span>
        <span className="text-right font-mono text-slate-300">
          {v.longestLossRun} entries
        </span>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        Digit selection was replayed before each outcome. The evidence label
        adjusts for scanning multiple markets; it is not a guarantee or a
        separate trade gate.
      </p>
    </div>
  );
}
function RiskScenario({ risk }: { risk: NexusRisk }) {
  return (
    <details className={`${panel} group p-4`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs text-slate-300">
        <span className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-lime-300/70" />
          Recovery stress test
        </span>
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Metric label="Stop reached" value={pct(risk.stopProbability)} />
        <Metric label="Target reached" value={pct(risk.targetProbability)} />
        <Metric label="Median P&L" value={money(risk.pnl50)} />
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
        {risk.paths} seeded paths · up to {risk.horizon} entries ·{" "}
        {risk.sampleShots} historical entry outcomes. 5th–95th percentile P&L:{" "}
        {money(risk.pnl05)} to {money(risk.pnl95)}. 95th-percentile drawdown:{" "}
        {money(risk.drawdown95)}.
      </p>
      <p className="mt-2 text-[10px] leading-relaxed text-amber-200/60">
        {risk.note}
      </p>
    </details>
  );
}

export function MatchNexusConsole({
  bot,
  open,
  onOpenChange,
  session,
  onSession,
}: BotConsoleProps) {
  const [step, setStep] = useState<Step>("configure");
  const [activity, setActivity] = useState<NexusActivity>("balanced");
  const [digit, setDigit] = useState("auto");
  const [executionMode, setExecutionMode] = useState<"paper" | "live">("paper");
  const [fields, setFields] = useState({
    stake: "1",
    stopLoss: "10",
    takeProfit: "10",
    maxRecoverySteps: "3",
  });
  const [scan, setScan] = useState<NexusScanView | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [marketMode, setMarketMode] = useState<"locked" | "switching">(
    "locked",
  );
  const [confirmLive, setConfirmLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({
    scanned: 0,
    total: 0,
    scanning: "Preparing source-verified history",
  });
  const [live, setLive] = useState<BotSessionStatus | null>(null);
  const [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | null>(null);
  const requestGeneration = useRef(0);
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [step]);
  const defaultsApplied = useRef(false);
  const { data: settings } = useGetSettings();

  useEffect(() => {
    if (!settings || defaultsApplied.current) return;
    defaultsApplied.current = true;
    setFields((prev) => ({
      ...prev,
      stake: String(settings.riskAmountValue ?? 1),
      maxRecoverySteps: String(settings.maxRecoverySteps ?? 3),
    }));
  }, [settings]);
  const applyStatus = useCallback(
    (value: BotSessionStatus | null) => {
      if (value?.botId !== "match-nexus") return;
      setLive(value);
      onSession(value);
      if (value.running) setStep("session");
    },
    [onSession],
  );
  useEffect(() => {
    if (session?.botId === "match-nexus") {
      setLive(session);
      if (session.running) setStep("session");
    }
  }, [session]);

  useEffect(() => {
    if (!open) return;
    let dead = false;
    setError("");
    const refresh = () => {
      void request<BotSessionStatus | null>("status")
        .then((value) => {
          if (!dead) applyStatus(value);
        })
        .catch(() => {});
    };
    refresh();
    const interval = setInterval(() => {
      setNow(Date.now());
      refresh();
    }, 2000);
    const es = new EventSource(withTabSession("/api/ai/events"));
    es.addEventListener("bot_update", (event: MessageEvent) => {
      try {
        if (!dead) applyStatus(JSON.parse(event.data));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("bot_scan_progress", (event: MessageEvent) => {
      try {
        const value = JSON.parse(event.data);
        if (value.botId === "match-nexus" && !dead)
          setProgress({
            scanned: value.scanned,
            total: value.total,
            scanning: value.scanning ?? "Finalizing results",
          });
      } catch {
        /* malformed event */
      }
    });
    return () => {
      dead = true;
      clearInterval(interval);
      es.close();
      controller.current?.abort();
      requestGeneration.current++;
    };
  }, [open, applyStatus]);

  const config = (): NexusConfig => ({
    activity,
    executionMode,
    ...(digit === "auto" ? {} : { digit: Number(digit) }),
    stake: Number(fields.stake),
    stopLoss: Number(fields.stopLoss),
    takeProfit: Number(fields.takeProfit),
    maxRecoverySteps: Number(fields.maxRecoverySteps),
  });
  const handleScan = async () => {
    const generation = ++requestGeneration.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setError("");
    setLoading(true);
    setStep("scanning");
    setScan(null);
    setConfirmLive(false);
    setProgress({
      scanned: 0,
      total: 0,
      scanning: "Preparing source-verified history",
    });
    try {
      const result = await request<NexusScanView>(
        "scan",
        config(),
        controller.current.signal,
      );
      if (generation !== requestGeneration.current) return;
      setScan(result);
      setSelectedSymbol(
        result.markets.find((m) => m.deployable)?.symbol ??
          result.markets[0]?.symbol ??
          "",
      );
      setNow(Date.now());
      setMarketMode("locked");
      setStep("results");
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setError(err instanceof Error ? err.message : "Scan failed");
      setStep("configure");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  };
  const handleDeploy = async () => {
    if (!scan) return;
    setLoading(true);
    setError("");
    try {
      const result = await request<{ status: BotSessionStatus }>(
        "start",
        nexusDeployBody(scan, selectedSymbol, marketMode, confirmLive),
      );
      applyStatus(result.status);
      setStep("session");
      toast.success(
        `Match Nexus deployed in ${scan.config.executionMode} mode`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed");
    } finally {
      setLoading(false);
    }
  };
  const handleStop = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await request<{ status: BotSessionStatus | null }>(
        "stop",
        {},
      );
      applyStatus(result.status);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not stop; retry immediately",
      );
    } finally {
      setLoading(false);
    }
  };
  const selected = scan?.markets.find((m) => m.symbol === selectedSymbol);
  const telemetry = live?.nexus;
  const expired = !!scan && scan.expiresAt <= now;
  const restart = () => {
    setStep("configure");
    setScan(null);
    setLoading(false);
    setError("");
    setConfirmLive(false);
  };
  const stage =
    step === "configure"
      ? 0
      : step === "scanning"
        ? 1
        : step === "results"
          ? 2
          : 3;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && step === "scanning") {
          requestGeneration.current++;
          controller.current?.abort();
          setLoading(false);
          setStep("configure");
        }
        onOpenChange(value);
      }}
    >
      <DialogContent className="w-[calc(100%_-_1.5rem)] max-w-[1080px] gap-0 overflow-hidden border-white/10 bg-[#090e17] p-0 text-slate-200 sm:rounded-2xl">
        <DialogHeader className="border-b border-white/[0.07] bg-gradient-to-r from-lime-300/[0.07] to-transparent px-5 py-5 pr-12 sm:px-7">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl border border-lime-300/20 bg-lime-300/10">
              <Zap className="size-5 text-lime-300" />
            </div>
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-lime-300/65">
                NEXUS / MATCHES LAB
              </p>
              <DialogTitle className="mt-1 text-xl font-semibold tracking-tight text-slate-50">
                {bot.name}
                <span className="ml-2 text-sm font-normal text-slate-500">
                  One tick ahead.
                </span>
              </DialogTitle>
            </div>
            <span className="ml-auto hidden rounded-full border border-white/10 px-2.5 py-1 text-[9px] font-mono text-slate-400 sm:block">
              DIGITMATCH ONLY · 1 TICK
            </span>
          </div>
          <DialogDescription className="sr-only">
            Configure and scan Match Nexus, then choose a locked or switching
            market. Trading and recovery are risky; probabilities and historical
            results are not guarantees.
          </DialogDescription>
        </DialogHeader>
        <div
          ref={scroller}
          className="max-h-[76vh] overflow-y-auto overscroll-contain px-5 py-5 sm:px-7"
        >
          <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/5 pb-4">
            {["Configure", "Analyze", "Choose & deploy", "Session"].map(
              (name, index) => (
                <div
                  key={name}
                  className={`flex items-center gap-2 text-[10px] font-mono ${index === stage ? "text-lime-300" : "text-slate-600"}`}
                >
                  <span
                    className={`flex size-5 items-center justify-center rounded-full border ${index === stage ? "border-lime-300/40 bg-lime-300/10" : "border-white/10"}`}
                  >
                    {index < stage ? <Check className="size-3" /> : index + 1}
                  </span>
                  {name}
                </div>
              ),
            )}
            <span className="ml-auto flex items-center gap-1.5 text-[10px] text-slate-500">
              <ShieldCheck className="size-3" />
              One executor · one ledger
            </span>
          </div>
          {error && (
            <div
              role="alert"
              className="mb-5 rounded-lg border border-rose-400/25 bg-rose-400/5 p-3 text-xs leading-relaxed text-rose-200"
            >
              {error}
            </div>
          )}

          {step === "configure" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleScan();
              }}
              className="space-y-6"
            >
              <div className="grid gap-6 md:grid-cols-[1.15fr_1fr]">
                <div className="space-y-5">
                  <div>
                    <p className={labelClass}>01 / Entry behavior</p>
                    <h3 className="mt-2 text-lg font-medium text-white">
                      Precision without the gate stack.
                    </h3>
                    <p className="mt-2 text-xs leading-relaxed text-slate-400">
                      Six models compete on what they predicted before the next
                      tick arrived. One payout-aware rule makes the entry
                      decision. No “due digit” shortcut.
                    </p>
                  </div>
                  <fieldset>
                    <legend className="mb-2 text-xs text-slate-300">
                      Activity preference
                    </legend>
                    <div className="grid grid-cols-3 gap-2">
                      {PROFILES.map((profile) => (
                        <button
                          type="button"
                          key={profile.id}
                          aria-pressed={activity === profile.id}
                          onClick={() => setActivity(profile.id)}
                          className={`rounded-xl border p-3 text-left transition-colors ${activity === profile.id ? "border-lime-300/40 bg-lime-300/[0.07]" : "border-white/[0.08] hover:bg-white/5"}`}
                        >
                          <p
                            className={`text-xs font-medium ${activity === profile.id ? "text-lime-300" : "text-slate-300"}`}
                          >
                            {profile.label}
                          </p>
                          <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                            {profile.copy}
                          </p>
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-500">
                      Pacing preference, not a trade quota. Waiting never forces
                      a negative-value entry.
                    </p>
                  </fieldset>
                  <div>
                    <label
                      htmlFor="nexus-digit"
                      className="mb-2 block text-xs text-slate-300"
                    >
                      Target digit
                    </label>
                    <select
                      id="nexus-digit"
                      value={digit}
                      onChange={(e) => setDigit(e.target.value)}
                      className="h-10 w-full rounded-lg border border-white/10 bg-[#101723] px-3 text-xs text-slate-200 outline-none focus:border-lime-300/40"
                    >
                      <option value="auto">
                        AI selects · compare all 10 digits
                      </option>
                      {Array.from({ length: 10 }, (_, d) => (
                        <option key={d} value={d}>
                          Lock digit {d} · Matches only
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 text-[10px] text-slate-500">
                      You choose the market and locked/switching behavior after
                      the scan.
                    </p>
                  </div>
                  <div className={`${panel} p-4`}>
                    <p className="flex items-center gap-2 text-xs text-slate-300">
                      <BarChart3 className="size-4 text-lime-300/70" />
                      Built to show its work
                    </p>
                    <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                      Next-digit probability, held-out hits, uncertainty, actual
                      quote checks and timing. On a fair stream a Matches digit
                      has a 10% chance—not 90% accuracy. No model or recovery
                      system guarantees profits.
                    </p>
                  </div>
                </div>
                <div className={`${panel} p-5 space-y-5`}>
                  <p className={labelClass}>02 / Risk & execution</p>
                  <fieldset>
                    <legend className="mb-2 text-xs text-slate-300">
                      Execution mode
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                      {(["paper", "live"] as const).map((mode) => (
                        <button
                          type="button"
                          key={mode}
                          onClick={() => setExecutionMode(mode)}
                          aria-pressed={executionMode === mode}
                          className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-xs ${executionMode === mode ? (mode === "paper" ? "border-lime-300/40 bg-lime-300/10 text-lime-300" : "border-amber-300/40 bg-amber-300/10 text-amber-300") : "border-white/10 text-slate-500"}`}
                        >
                          {mode === "paper" ? (
                            <FlaskConical className="size-3.5" />
                          ) : (
                            <Radio className="size-3.5" />
                          )}
                          {mode === "paper" ? "Paper first" : "Deriv account"}
                        </button>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                      {executionMode === "paper"
                        ? "A separate $10,000 paper bankroll. Settles on the next observed tick; never changes real balance or recovery debt."
                        : "Uses your active Deriv account (demo or real). Requires live data and a second confirmation after the scan."}
                    </p>
                  </fieldset>
                  <div className="grid grid-cols-2 gap-4">
                    {(
                      [
                        ["stake", "Base stake", "0.35", "0.01"],
                        ["stopLoss", "Stop-loss budget", "0.35", "0.01"],
                        ["takeProfit", "Take-profit target", "0.01", "0.01"],
                        ["maxRecoverySteps", "Recovery step cap", "1", "1"],
                      ] as const
                    ).map(([key, name, min, increment]) => (
                      <div key={key}>
                        <label
                          htmlFor={`nexus-${key}`}
                          className="mb-2 block text-[11px] text-slate-400"
                        >
                          {name}
                        </label>
                        <Input
                          id={`nexus-${key}`}
                          required
                          type="number"
                          min={min}
                          max={key === "maxRecoverySteps" ? "10" : "1000000"}
                          step={increment}
                          value={fields[key]}
                          onChange={(event) =>
                            setFields((prev) => ({
                              ...prev,
                              [key]: event.target.value,
                            }))
                          }
                          className="h-10 border-white/10 bg-black/20 font-mono text-sm focus-visible:ring-lime-300/30"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-white/5 pt-4">
                    <p className="text-xs text-slate-300">
                      Your Matches recovery. Unchanged.
                    </p>
                    <p className="mt-2 text-[10px] leading-relaxed text-slate-500">
                      Debt × (1 + your bot markup) ÷ (payout − 1), with the
                      $0.35 floor and stake/balance limits. The next loss cannot
                      spend beyond the remaining stop budget. The step cap
                      retains the shared ledger’s step-label behavior; it is not
                      a maximum number of recovery attempts.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-white/5 pt-5">
                <p className="max-w-md text-[10px] leading-relaxed text-slate-500">
                  Up to 4,999 source-verified digits per market. History
                  requests overlap; all ten digits share one analysis pass.
                </p>
                <Button
                  type="submit"
                  disabled={loading}
                  className="gap-2 bg-lime-300 px-6 text-slate-950 hover:bg-lime-200"
                >
                  <ScanSearch className="size-4" />
                  Scan markets
                  <ArrowRight className="size-4" />
                </Button>
              </div>
            </form>
          )}

          {step === "scanning" && (
            <div className="py-16 text-center" role="status" aria-live="polite">
              <div className="mx-auto flex size-16 items-center justify-center rounded-2xl border border-lime-300/20 bg-lime-300/5">
                <ScanSearch className="size-7 animate-pulse text-lime-300" />
              </div>
              <h3 className="mt-6 text-xl text-white">Reading the evidence.</h3>
              <p className="mt-3 text-sm text-slate-400">{progress.scanning}</p>
              <div className="mx-auto mt-6 h-1.5 max-w-sm overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full bg-lime-300 transition-[width] duration-300"
                  style={{
                    width: `${progress.total ? (progress.scanned / progress.total) * 100 : 5}%`,
                  }}
                />
              </div>
              <p className="mt-3 font-mono text-[10px] text-slate-500">
                {progress.scanned} / {progress.total || "—"} markets · training
                → causal held-out replay → recovery stress test
              </p>
              <p className="mx-auto mt-7 max-w-sm text-[11px] leading-relaxed text-slate-500">
                No trades are placed during analysis. Live and simulated
                histories are kept separate.
              </p>
            </div>
          )}

          {step === "results" && scan && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className={labelClass}>Scan complete</p>
                  <h3 className="mt-1 text-lg text-white">
                    Choose where Nexus works.
                  </h3>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {scan.markets.length} measured / {scan.marketsScanned}{" "}
                    markets · {(scan.elapsedMs / 1000).toFixed(2)} s ·{" "}
                    {expired
                      ? "Scan expired"
                      : `Deploy within ${Math.max(0, Math.ceil((scan.expiresAt - now) / 1000))} s`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={restart}
                  disabled={loading}
                  className="border-white/10 bg-transparent text-xs"
                >
                  Edit & rescan
                </Button>
              </div>
              {!scan.markets.length && (
                <div className={`${panel} p-8 text-center`}>
                  <Clock3 className="mx-auto size-7 text-slate-500" />
                  <p className="mt-4 text-sm">The feed is still warming up.</p>
                  <p className="mt-2 text-xs text-slate-500">
                    No market has enough validated history yet. No accuracy
                    figures have been invented. Wait for the feed, then scan
                    again.
                  </p>
                </div>
              )}
              {!!scan.markets.length && (
                <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
                  <div className={`${panel} overflow-hidden`}>
                    <p
                      className={`${labelClass} border-b border-white/5 px-4 py-3`}
                    >
                      Ranked by current entry value
                    </p>
                    <div className="max-h-[445px] overflow-y-auto">
                      {scan.markets.map((market, index) => (
                        <button
                          key={market.symbol}
                          type="button"
                          onClick={() => setSelectedSymbol(market.symbol)}
                          aria-pressed={market.symbol === selectedSymbol}
                          className={`w-full border-b border-white/5 px-4 py-3.5 text-left transition-colors ${market.symbol === selectedSymbol ? "border-l-2 border-l-lime-300 bg-lime-300/[0.055]" : "border-l-2 border-l-transparent hover:bg-white/[0.03]"}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-slate-200">
                              <span className="mr-2 font-mono text-slate-600">
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              {market.displayName}
                            </span>
                            <span className="font-mono text-xs text-lime-300">
                              {market.decision.digit}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center justify-between gap-2">
                            <SourceBadge source={market.source} />
                            <span className="font-mono text-[10px] text-slate-400">
                              {pct(market.decision.p)} est.
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                  {selected && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-lime-300/15 bg-lime-300/[0.03] p-4">
                        <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-lime-300/20 bg-lime-300/10 font-mono text-3xl text-lime-300">
                          {selected.decision.digit}
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-medium text-white">
                            Matches {selected.decision.digit} ·{" "}
                            {selected.displayName}
                          </p>
                          <p className="mt-1 max-w-lg text-[11px] leading-relaxed text-slate-500">
                            {selected.decision.reason}
                          </p>
                        </div>
                        <div className="min-w-[95px]">
                          <Metric
                            label="Est. next tick"
                            value={pct(selected.decision.p)}
                            bright
                            note={`Break-even ${pct(selected.decision.breakEven)}`}
                          />
                        </div>
                      </div>
                      <DigitDistribution
                        prediction={selected.prediction}
                        selected={selected.decision.digit}
                      />
                      <Evidence validation={selected.validation} />
                      <RiskScenario risk={selected.risk} />
                    </div>
                  )}
                </div>
              )}
              {selected && (
                <section
                  className="rounded-xl border border-lime-300/20 bg-lime-300/[0.035] p-5"
                  aria-label="Post-scan market mode"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium text-white">
                      Now choose your market mode.
                    </h4>
                    <span className="font-mono text-[10px] text-slate-500">
                      {scan.config.executionMode.toUpperCase()} ·{" "}
                      {money(scan.config.stake)} base ·{" "}
                      {money(scan.config.stopLoss)} stop
                    </span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(["locked", "switching"] as const).map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        aria-pressed={marketMode === mode}
                        onClick={() => setMarketMode(mode)}
                        className={`flex items-start gap-3 rounded-xl border p-4 text-left ${marketMode === mode ? "border-lime-300/40 bg-lime-300/[0.065]" : "border-white/10 bg-black/10"}`}
                      >
                        {mode === "locked" ? (
                          <Lock className="mt-0.5 size-4 shrink-0 text-lime-300" />
                        ) : (
                          <Shuffle className="mt-0.5 size-4 shrink-0 text-lime-300" />
                        )}
                        <div>
                          <p className="text-xs font-medium text-slate-200">
                            {mode === "locked"
                              ? `Lock ${selected.displayName}`
                              : "Allow market switching"}
                          </p>
                          <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                            {mode === "locked"
                              ? "The symbol never changes. Automatic digit selection can still adapt inside this market."
                              : "Start here, then compare the scanned market pool on fresh ticks. Hysteresis limits unnecessary switching."}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                  {scan.config.executionMode === "live" && (
                    <label className="mt-4 flex items-start gap-3 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-[11px] leading-relaxed text-amber-200">
                      <input
                        type="checkbox"
                        checked={confirmLive}
                        onChange={(e) => setConfirmLive(e.target.checked)}
                        className="mt-0.5 accent-lime-300"
                      />
                      <span>
                        I authorize trading on my active Deriv account. Matches
                        usually loses most individual entries; recovery
                        increases exposure and does not guarantee repayment.
                      </span>
                    </label>
                  )}
                  {!selected.deployable && (
                    <p role="alert" className="mt-3 text-xs text-amber-300">
                      This is simulated history. It cannot authorize live
                      trading. Rescan with a live feed, or choose paper mode.
                    </p>
                  )}
                  {expired && (
                    <p role="alert" className="mt-3 text-xs text-amber-300">
                      The scan has expired. Rescan before deploying; stale
                      client cards cannot authorize trades.
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="max-w-lg text-[10px] leading-relaxed text-slate-500">
                      Deploy means watch for a fresh qualifying tick, not buy
                      immediately. Recovery markup:{" "}
                      {scan.riskSettings.markupPercent}%. Maximum stake:{" "}
                      {money(scan.riskSettings.maxStake)}.
                    </p>
                    <Button
                      onClick={() => void handleDeploy()}
                      disabled={
                        loading ||
                        !canDeployNexus(scan, selected, now, confirmLive)
                      }
                      className="gap-2 bg-lime-300 text-slate-950 hover:bg-lime-200"
                    >
                      {loading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Zap className="size-4" />
                      )}
                      Deploy {scan.config.executionMode} · {marketMode}
                    </Button>
                  </div>
                </section>
              )}
              {selected && (
                <details className={`${panel} p-4`}>
                  <summary className="cursor-pointer text-xs text-slate-400">
                    Data quality & limitations
                  </summary>
                  <ul className="mt-3 list-disc space-y-2 pl-4 text-[11px] leading-relaxed text-slate-500">
                    {selected.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                    <li>{scan.note}</li>
                    <li>
                      History: {selected.historySource}; calibration retention:{" "}
                      {pct(selected.calibration)}; per-market analysis:{" "}
                      {ms(selected.analysisMs)}.
                    </li>
                    {scan.omitted.map((item) => (
                      <li key={item.symbol}>
                        {item.symbol}: {item.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {step === "session" && live && telemetry && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <span
                    className={`size-2 rounded-full ${live.running ? "animate-pulse bg-lime-300" : "bg-slate-500"}`}
                  />
                  <div>
                    <h3 className="text-lg text-white">
                      {live.running
                        ? "Nexus is on watch."
                        : "Session complete."}
                    </h3>
                    <p className="mt-1 font-mono text-[10px] text-slate-500">
                      {telemetry.executionMode.toUpperCase()} ·{" "}
                      {telemetry.marketMode.toUpperCase()} ·{" "}
                      {telemetry.activity.toUpperCase()} ·{" "}
                      {telemetry.phase.toUpperCase()}
                    </p>
                  </div>
                </div>
                {live.running ? (
                  <Button
                    onClick={() => void handleStop()}
                    disabled={loading || telemetry.stopRequested}
                    variant="outline"
                    className="gap-2 border-rose-400/30 bg-rose-400/5 text-rose-300 hover:bg-rose-400/10"
                  >
                    <Square className="size-3" />
                    {telemetry.stopRequested
                      ? "Draining position…"
                      : "Stop session"}
                  </Button>
                ) : (
                  <Button
                    onClick={restart}
                    className="bg-lime-300 text-slate-950 hover:bg-lime-200"
                  >
                    New scan
                  </Button>
                )}
              </div>
              <div
                role="status"
                aria-live="polite"
                className={`flex items-start gap-3 rounded-xl border p-4 ${telemetry.phase === "attention" ? "border-amber-300/30 bg-amber-300/5 text-amber-200" : "border-white/10 bg-white/[0.02] text-slate-400"}`}
              >
                <Activity className="mt-0.5 size-4 shrink-0" />
                <div>
                  <p className="text-xs leading-relaxed">{live.message}</p>
                  {telemetry.pendingContractId && (
                    <p className="mt-1.5 font-mono text-[10px] text-slate-500">
                      Pending contract {telemetry.pendingContractId}
                    </p>
                  )}
                </div>
              </div>
              <div
                className={`${panel} grid grid-cols-2 gap-5 p-5 sm:grid-cols-4`}
              >
                <Metric
                  label={
                    telemetry.executionMode === "paper"
                      ? "Paper net P&L"
                      : "Session net P&L"
                  }
                  value={money(live.totalProfit)}
                  bright={live.totalProfit >= 0}
                />
                <Metric
                  label="Settled matches"
                  value={`${live.winCount} / ${live.tradeCount}`}
                  note={
                    live.tradeCount
                      ? `${pct(live.winCount / live.tradeCount)} observed hit rate`
                      : "No settled trades yet"
                  }
                />
                <Metric
                  label="Current stake"
                  value={money(live.currentStake)}
                  note={
                    live.inRecovery
                      ? `Recovery step ${live.recoveryStep}`
                      : "Base stake"
                  }
                />
                <Metric
                  label="Unrecovered debt"
                  value={money(live.unrecoveredAmount)}
                  note={
                    telemetry.executionMode === "paper"
                      ? "Isolated paper ledger"
                      : "Account recovery ledger"
                  }
                />
              </div>
              <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm text-white">
                      {telemetry.marketMode === "locked" ? (
                        <Lock className="size-3.5 text-lime-300" />
                      ) : (
                        <Shuffle className="size-3.5 text-lime-300" />
                      )}
                      {live.currentMarket}
                    </p>
                    <SourceBadge source={telemetry.source} />
                  </div>
                  <DigitDistribution
                    prediction={telemetry.prediction}
                    selected={telemetry.digit}
                  />
                  <p className="text-[10px] leading-relaxed text-slate-500">
                    Indicative next-tick view, not the frozen order currently
                    settling. Live entries are checked again against the actual
                    broker quote.
                  </p>
                  <div className={`${panel} grid grid-cols-3 gap-3 p-4`}>
                    <Metric
                      label="Match estimate"
                      value={pct(telemetry.decision?.p)}
                      bright
                    />
                    <Metric
                      label="Break-even"
                      value={pct(telemetry.decision?.breakEven)}
                    />
                    <Metric
                      label="Entry value"
                      value={pct(telemetry.decision?.utility)}
                      note="After uncertainty discount"
                    />
                  </div>
                  {telemetry.validation && (
                    <Evidence validation={telemetry.validation} />
                  )}
                </div>
                <div className="space-y-4">
                  <div className={`${panel} p-4`}>
                    <p className="mb-4 flex items-center gap-2 text-xs text-slate-300">
                      <Gauge className="size-4 text-lime-300/70" />
                      Execution telemetry
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <Metric
                        label="Tick analysis"
                        value={ms(telemetry.analysisMs)}
                      />
                      <Metric label="Quote RTT" value={ms(telemetry.quoteMs)} />
                      <Metric label="Buy RTT" value={ms(telemetry.buyMs)} />
                      <Metric
                        label="Signal → send"
                        value={ms(telemetry.signalToSendMs)}
                      />
                      <Metric
                        label="Buy p95"
                        value={ms(telemetry.executionP95Ms)}
                      />
                      <Metric
                        label="Tick headroom"
                        value={ms(telemetry.headroomMs)}
                      />
                    </div>
                    <p className="mt-4 border-t border-white/5 pt-3 text-[10px] leading-relaxed text-slate-500">
                      {telemetry.ticksObserved.toLocaleString()} ticks observed
                      · {telemetry.switches} market switches ·{" "}
                      {telemetry.entriesSkipped} aborted entries.{" "}
                      {telemetry.executionMode === "paper"
                        ? "Paper timings are local; no broker order was sent."
                        : `Broker entry alignment: ${telemetry.lastEntryAligned === null ? "not verified yet" : telemetry.lastEntryAligned ? "same tick window" : "crossed a tick window"}. Network latency cannot be eliminated.`}
                    </p>
                  </div>
                  <div className={`${panel} p-4`}>
                    <p className={labelClass}>
                      Model weights · earned on past predictions
                    </p>
                    <div className="mt-4 space-y-3">
                      {telemetry.prediction?.experts.map((expert) => (
                        <div key={expert.name}>
                          <div className="mb-1.5 flex justify-between text-[10px]">
                            <span className="text-slate-400">
                              {expert.name}
                            </span>
                            <span className="font-mono text-slate-300">
                              {pct(expert.weight, 0)}
                            </span>
                          </div>
                          <div className="h-1 overflow-hidden rounded-full bg-white/5">
                            <div
                              className="h-full rounded-full bg-lime-300/60"
                              style={{ width: `${expert.weight * 100}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  {telemetry.risk && <RiskScenario risk={telemetry.risk} />}
                </div>
              </div>
              {telemetry.recentTrades.length > 0 && (
                <div className={`${panel} p-4`}>
                  <p className={labelClass}>Recent settled entries</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {telemetry.recentTrades.map((trade, i) => (
                      <div
                        key={`${trade.at}-${i}`}
                        title={`${trade.symbol} · Matches ${trade.digit}`}
                        className={`rounded-lg border px-3 py-2 font-mono text-[10px] ${trade.won ? "border-lime-300/20 bg-lime-300/5 text-lime-300" : "border-rose-300/15 bg-rose-300/5 text-rose-300"}`}
                      >
                        <span className="mr-2 opacity-60">M{trade.digit}</span>
                        {money(trade.profit)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="flex items-start gap-2 text-[10px] leading-relaxed text-slate-500">
                <CircleHelp className="mt-0.5 size-3 shrink-0" />
                Closing this panel does not stop the bot. Stop cancels unsent
                entries; an already-sent order must settle before ownership is
                released. Probability estimates are not guarantees.{" "}
                {telemetry.executionMode === "paper" &&
                  "All results in this session are paper results."}
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
