import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Check,
  CircleHelp,
  Globe2,
  Loader2,
  LockKeyhole,
  Radar,
  ScanSearch,
  ShieldCheck,
  Shuffle,
  StopCircle,
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
import type { BotConsoleProps } from "@/lib/console-registry";
import type { BotSessionStatus } from "@/lib/bots";
import { withTabSession } from "@/lib/tab-session";
import {
  OMNI_CONTRACTS,
  omniConfigError,
  type OmniConfig,
  type OmniOpportunity,
  type OmniScan,
} from "@/lib/omni";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const money = (n: number) => n.toFixed(2);
const DEFAULT_CONFIG: OmniConfig = {
  enabledContracts: OMNI_CONTRACTS.map((c) => c.id),
  stake: 1,
  stopLoss: 10,
  takeProfit: 10,
  marketMode: "switching",
  executionMode: "paper",
};
async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/bots/omni/${path}`, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "The bot request failed");
  return data as T;
}
function Metric({
  label,
  value,
  tone = "text-white",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 p-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className={`mt-1 font-mono text-sm font-semibold ${tone}`}>{value}</p>
    </div>
  );
}
function Opportunity({
  shot,
  title,
}: {
  shot: OmniOpportunity | null;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-indigo-200">
          {title}
        </h4>
        <span
          className={`text-[10px] rounded-full px-2 py-1 ${shot?.ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}
        >
          {shot?.ready ? "Estimated opportunity" : "Waiting"}
        </span>
      </div>
      {shot ? (
        <>
          <p className="text-lg font-semibold">{shot.contract.label}</p>
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Estimated win" value={pct(shot.probability)} />
            <Metric label="Break-even" value={pct(shot.breakEven)} />
            <Metric
              label="Stake / payout"
              value={`${money(shot.stake)} / ${shot.payout.toFixed(2)}×`}
            />
            <Metric
              label="Utility / loss-pair risk"
              value={`${shot.utility.toFixed(3)} / ${pct(shot.lossPairRisk)}`}
            />
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {shot.reason}.{" "}
            <span className="text-slate-500">
              {shot.quoteSource === "live"
                ? "Broker-priced"
                : "Indicative payout"}
              ; estimates can be wrong.
            </span>
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-400">
          Waiting for enough market data.
        </p>
      )}
    </div>
  );
}

export function OmniConsole({
  bot,
  open,
  onOpenChange,
  session: parentSession,
  onSession,
}: BotConsoleProps) {
  const [config, setConfig] = useState<OmniConfig>({ ...DEFAULT_CONFIG });
  const [scan, setScan] = useState<OmniScan | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<"scan" | "start" | "stop" | null>(null);
  const [progress, setProgress] = useState({
    scanning: "",
    scanned: 0,
    total: 0,
  });
  const [ownStatus, setOwnStatus] = useState<BotSessionStatus | null>(null);
  const [monitor, setMonitor] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const edited = useRef(false);
  const initialized = useRef(false);
  const { data: settings } = useGetSettings();
  const status =
    ownStatus?.botId === bot.id
      ? ownStatus
      : parentSession?.botId === bot.id
        ? parentSession
        : null;
  const details = status?.omni;
  const running = status?.running === true;
  const watch = details?.watch;

  useEffect(() => {
    if (!settings || initialized.current || edited.current) return;
    initialized.current = true;
    setConfig((prev) => ({
      ...prev,
      stake: Math.max(0.35, Number(settings.riskAmountValue) || 1),
    }));
  }, [settings]);
  const acceptStatus = useCallback(
    (next: BotSessionStatus) => {
      if (next.botId !== "omni") return;
      setOwnStatus(next);
      onSession(next);
      if (next.running) setMonitor(true);
    },
    [onSession],
  );
  useEffect(() => {
    if (parentSession?.botId === "omni") {
      setOwnStatus(parentSession);
      if (parentSession.running) setMonitor(true);
    }
  }, [parentSession]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const next = await api<BotSessionStatus>(
          "status",
          undefined,
          controller.signal,
        );
        if (alive) acceptStatus(next);
      } catch {
        /* SSE and the next status poll can recover. */
      }
    };
    void refresh();
    const poll = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 2000);
    const events = new EventSource(withTabSession("/api/ai/events"));
    events.addEventListener("bot_update", (event: MessageEvent) => {
      try {
        if (alive) acceptStatus(JSON.parse(event.data));
      } catch {
        /* malformed event */
      }
    });
    events.addEventListener("bot_scan_progress", (event: MessageEvent) => {
      try {
        const p = JSON.parse(event.data);
        if (p.botId === "omni" && alive)
          setProgress({
            scanning: p.scanning ?? "Finishing analysis",
            scanned: p.scanned,
            total: p.total,
          });
      } catch {
        /* malformed event */
      }
    });
    return () => {
      alive = false;
      controller.abort();
      request.current?.abort();
      clearInterval(poll);
      events.close();
    };
  }, [open, acceptStatus]);

  const change = <K extends keyof OmniConfig>(key: K, value: OmniConfig[K]) => {
    edited.current = true;
    setConfig((previous) => ({ ...previous, [key]: value }));
    setScan(null);
    setSelected("");
    setError(null);
    setAcknowledged(false);
  };
  const toggle = (id: OmniConfig["enabledContracts"][number]) =>
    change(
      "enabledContracts",
      config.enabledContracts.includes(id)
        ? config.enabledContracts.filter((c) => c !== id)
        : [...config.enabledContracts, id],
    );
  const handleScan = async () => {
    const invalid = omniConfigError(config);
    if (invalid) {
      setError(invalid);
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy("scan");
    setError(null);
    setScan(null);
    setProgress({ scanning: "Preparing market history", scanned: 0, total: 0 });
    try {
      const next = await api<OmniScan>("scan", config, controller.signal);
      setScan(next);
      setSelected(next.markets[0]?.symbol ?? "");
      setNow(Date.now());
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  const handleStart = async () => {
    if (!scan || !selected) return;
    setBusy("start");
    setError(null);
    try {
      const result = await api<{ status: BotSessionStatus }>("start", {
        config,
        scanId: scan.scanId,
        symbol: selected,
        acknowledgeLiveRisk: acknowledged,
      });
      acceptStatus(result.status);
      setMonitor(true);
      toast.success(`${bot.name} deployed in ${config.executionMode} mode`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed");
    } finally {
      setBusy(null);
    }
  };
  const handleStop = async () => {
    setBusy("stop");
    setError(null);
    try {
      const result = await api<{ status: BotSessionStatus }>("stop", {});
      acceptStatus(result.status);
      toast.info("Stop requested. Any outstanding order will settle first.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request a stop");
    } finally {
      setBusy(null);
    }
  };

  const chosen = scan?.markets.find((m) => m.symbol === selected);
  const expired = !!scan && now >= scan.expiresAt;
  const lockedControls = running || busy !== null;
  const activeConfig = monitor && details ? details.config : config;
  const enabledLabels = OMNI_CONTRACTS.filter((c) =>
    activeConfig.enabledContracts.includes(c.id),
  )
    .map((c) => c.label)
    .join(" · ");
  const isLive = activeConfig.executionMode === "live";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-5xl max-h-[92dvh] overflow-y-auto border-indigo-400/20 bg-[#0a101f] p-0 text-slate-100 rounded-2xl">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-white/10 sm:px-7">
          <div className="flex items-center gap-3 pr-7">
            <div className="p-3 rounded-xl bg-indigo-500/15 border border-indigo-400/25">
              <Radar className="w-6 h-6 text-indigo-300" />
            </div>
            <div>
              <p className="text-[10px] tracking-[0.2em] text-indigo-300 uppercase">
                Multi-contract intelligence
              </p>
              <DialogTitle className="mt-1 text-xl sm:text-2xl">
                {bot.name}
              </DialogTitle>
            </div>
            <span
              className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-bold tracking-wider ${isLive ? "bg-amber-500/15 text-amber-200" : "bg-sky-500/10 text-sky-300"}`}
            >
              {isLive ? "LIVE ACCOUNT" : "PAPER"}
            </span>
          </div>
          <DialogDescription className="pt-3 text-left text-xs leading-relaxed text-slate-400">
            You choose the contracts. The bot compares markets, digits, barriers
            and timing — for both normal trades and recovery. No progressively
            harder loss gates.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-5 sm:px-7 space-y-5">
          <div className="flex flex-wrap gap-2 text-[10px] font-medium">
            <span className="rounded-full px-2.5 py-1.5 bg-indigo-400/10 text-indigo-200 flex items-center gap-1">
              <ShieldCheck className="w-3 h-3" /> Same allowlist in recovery
            </span>
            <span className="rounded-full px-2.5 py-1.5 bg-white/5 text-slate-300 flex items-center gap-1">
              <LockKeyhole className="w-3 h-3" /> Utility floor stays at zero
            </span>
            <span className="rounded-full px-2.5 py-1.5 bg-white/5 text-slate-300">
              One outstanding trade at a time
            </span>
          </div>
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/25 bg-red-500/10 p-3 text-xs text-red-200"
            >
              {error}
            </div>
          )}

          {monitor && details ? (
            <div className="space-y-4" data-testid="omni-monitor">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="font-semibold flex items-center gap-2">
                    <Activity
                      className={`w-4 h-4 ${running ? "text-emerald-400" : "text-slate-500"}`}
                    />
                    {details.stopping && running
                      ? "Stopping safely"
                      : running
                        ? "Opportunity radar"
                        : "Session finished"}
                  </h3>
                  <p className="mt-1 text-xs text-slate-400">{enabledLabels}</p>
                </div>
                <span
                  className={`text-xs font-semibold ${status?.inRecovery ? "text-amber-300" : "text-indigo-300"}`}
                >
                  {status?.inRecovery ? "RECOVERY" : "NORMAL"}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Metric
                  label="Session P&L"
                  value={money(status?.totalProfit ?? 0)}
                  tone={
                    (status?.totalProfit ?? 0) >= 0
                      ? "text-emerald-300"
                      : "text-rose-300"
                  }
                />
                <Metric
                  label="Remaining debt"
                  value={money(status?.unrecoveredAmount ?? 0)}
                  tone="text-amber-200"
                />
                <Metric
                  label="Trades / wins"
                  value={`${status?.tradeCount ?? 0} / ${status?.winCount ?? 0}`}
                />
                <Metric
                  label="Current stake"
                  value={money(status?.currentStake ?? 0)}
                />
              </div>
              <div className="rounded-xl border border-indigo-400/20 bg-indigo-400/5 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-indigo-200">
                  <span
                    className={`h-2 w-2 rounded-full ${running ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`}
                  />
                  {watch?.phase.toUpperCase() ?? "IDLE"}
                  <span className="ml-auto text-[10px] text-slate-400">
                    {details.lockedSymbol
                      ? `LOCKED · ${details.lockedSymbol}`
                      : `${watch?.marketsConsidered ?? 0} MARKETS · SWITCHING`}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed">
                  {status?.message}
                </p>
                <p className="mt-2 text-[10px] text-slate-400">
                  Feed: {watch?.source ?? "waiting"} ·{" "}
                  {watch?.ticksEvaluated ?? 0} new ticks evaluated ·{" "}
                  {isLive
                    ? "Shared account debt ledger"
                    : "Isolated paper debt; no account money is used"}
                </p>
              </div>
              <div className="overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full text-left text-xs min-w-[620px]">
                  <caption className="sr-only">
                    Best allowed normal or recovery opportunities, ranked by
                    risk-adjusted utility
                  </caption>
                  <thead className="bg-white/5 text-[10px] uppercase tracking-wide text-slate-400">
                    <tr>
                      {[
                        "Market / contract",
                        "Estimated win",
                        "Payout",
                        "Stake",
                        "Debt paid if won",
                        "Utility",
                      ].map((h) => (
                        <th className="px-3 py-3 font-medium" key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {watch?.candidates.map((shot, i) => (
                      <tr
                        key={`${shot.symbol}:${shot.contract.id}`}
                        className={`border-t border-white/5 ${i === 0 ? "bg-indigo-500/10" : ""}`}
                      >
                        <td className="p-3">
                          <p className="font-semibold">{shot.contract.label}</p>
                          <p className="text-[10px] text-slate-400 mt-1">
                            {shot.displayName}
                          </p>
                          <p
                            className={`mt-1 text-[9px] ${shot.ready ? "text-emerald-300" : "text-slate-500"}`}
                          >
                            {shot.ready ? "Candidate" : shot.reason}
                          </p>
                        </td>
                        <td className="px-3 font-mono">
                          {pct(shot.probability)}
                        </td>
                        <td className="px-3 font-mono">
                          {shot.payout.toFixed(2)}×
                          <span className="block text-[9px] text-slate-500">
                            {shot.quoteSource}
                          </span>
                        </td>
                        <td className="px-3 font-mono">{money(shot.stake)}</td>
                        <td className="px-3 font-mono">
                          {status?.inRecovery ? pct(shot.debtCoverage) : "—"}
                        </td>
                        <td
                          className={`px-3 font-mono ${shot.utility > 0 ? "text-emerald-300" : "text-slate-400"}`}
                        >
                          {shot.utility.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!watch?.candidates.length && (
                  <p className="p-5 text-center text-xs text-slate-400">
                    Collecting observations for the opportunity radar…
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                {running ? (
                  <Button
                    className="bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-400/25"
                    disabled={busy !== null || details.stopping}
                    onClick={handleStop}
                  >
                    <StopCircle className="w-4 h-4 mr-2" />
                    {details.stopping ? "Waiting for settlement…" : "Stop bot"}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setMonitor(false);
                      setScan(null);
                      setAcknowledged(false);
                      setError(null);
                    }}
                  >
                    Configure a new session
                  </Button>
                )}
                <p className="text-[10px] leading-relaxed text-slate-500 self-center">
                  Closing this console does not stop a running bot. Use Stop
                  bot.
                </p>
              </div>
            </div>
          ) : (
            <>
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    01 <span className="ml-2">Enable your contracts</span>
                  </h3>
                  <div className="flex gap-3 text-[11px]">
                    <button
                      type="button"
                      className="text-indigo-300 hover:text-white disabled:opacity-40"
                      disabled={lockedControls}
                      onClick={() =>
                        change(
                          "enabledContracts",
                          OMNI_CONTRACTS.map((c) => c.id),
                        )
                      }
                    >
                      Enable all
                    </button>
                    <button
                      type="button"
                      className="text-slate-400 hover:text-white disabled:opacity-40"
                      disabled={lockedControls}
                      onClick={() => change("enabledContracts", [])}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {OMNI_CONTRACTS.map((contract) => {
                    const enabled = config.enabledContracts.includes(
                      contract.id,
                    );
                    return (
                      <button
                        type="button"
                        key={contract.id}
                        aria-label={`${contract.label} contract`}
                        aria-pressed={enabled}
                        disabled={lockedControls}
                        onClick={() => toggle(contract.id)}
                        className={`relative rounded-xl border p-3 text-left transition-colors disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${enabled ? "border-indigo-400/50 bg-indigo-500/15" : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}
                      >
                        <span className="text-[9px] uppercase tracking-widest text-slate-500">
                          {contract.group}
                        </span>
                        <span
                          className={`block mt-1 font-semibold text-sm ${enabled ? "text-indigo-100" : "text-slate-400"}`}
                        >
                          {contract.label}
                        </span>
                        <span className="block text-[10px] mt-1 text-slate-500">
                          {contract.hint}
                        </span>
                        <span
                          className={`absolute top-3 right-3 h-4 w-4 rounded flex items-center justify-center ${enabled ? "bg-indigo-400 text-slate-950" : "border border-white/15"}`}
                        >
                          {enabled && <Check className="w-3 h-3" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400">
                  {config.enabledContracts.length} of 8 enabled. Disabled
                  contracts are never used — including during recovery. Digits
                  and barriers are selected automatically.
                </p>
              </section>
              <section className="grid md:grid-cols-2 gap-4">
                <div className="rounded-xl border border-white/10 p-4 space-y-4">
                  <h3 className="text-sm font-semibold">
                    02 <span className="ml-2">Risk & execution</span>
                  </h3>
                  <div className="flex rounded-lg bg-black/25 p-1 gap-1">
                    {(["paper", "live"] as const).map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        disabled={lockedControls}
                        aria-pressed={config.executionMode === mode}
                        onClick={() => change("executionMode", mode)}
                        className={`flex-1 rounded-md p-2 text-xs transition-colors ${config.executionMode === mode ? "bg-indigo-500/20 text-indigo-200" : "text-slate-500 hover:text-white"}`}
                      >
                        {mode === "paper"
                          ? "Paper rehearsal"
                          : "Connected account"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400">
                    {config.executionMode === "paper"
                      ? "Starts with 1,000 virtual USD. Separate paper debt; account funds and live recovery debt are untouched."
                      : "Uses the active Deriv account, including demo accounts. Simulated feeds cannot place live orders."}
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    {(
                      [
                        { key: "stake", label: "Base stake" },
                        { key: "stopLoss", label: "Stop loss" },
                        { key: "takeProfit", label: "Take profit" },
                      ] as const
                    ).map((field) => (
                      <label
                        className="text-[10px] text-slate-400"
                        key={field.key}
                      >
                        {field.label}
                        <Input
                          aria-label={field.label}
                          type="number"
                          min={field.key === "takeProfit" ? 0.01 : 0.35}
                          step="0.01"
                          value={config[field.key]}
                          disabled={lockedControls}
                          onChange={(event) =>
                            change(field.key, Number(event.target.value))
                          }
                          className="mt-1.5 h-9 bg-black/20 border-white/10 text-slate-200 font-mono text-xs"
                        />
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-500">
                    Recovery stake = debt × (1 + markup) ÷ net payout. Markup:{" "}
                    {Number(settings?.botRecoveryMarkup ?? 10).toFixed(1)}% from
                    Settings. Balance, max stake and remaining stop-loss cap
                    every order; capped wins may only repay part of the debt.
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 p-4 space-y-3">
                  <h3 className="text-sm font-semibold">
                    03 <span className="ml-2">Market freedom</span>
                  </h3>
                  {(["switching", "locked"] as const).map((mode) => (
                    <button
                      type="button"
                      key={mode}
                      disabled={lockedControls}
                      aria-pressed={config.marketMode === mode}
                      onClick={() => change("marketMode", mode)}
                      className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${config.marketMode === mode ? "border-indigo-400/40 bg-indigo-500/10" : "border-white/5 bg-black/15"}`}
                    >
                      {mode === "switching" ? (
                        <Shuffle className="w-4 h-4 mt-0.5 text-indigo-300" />
                      ) : (
                        <LockKeyhole className="w-4 h-4 mt-0.5 text-indigo-300" />
                      )}
                      <span>
                        <span className="block text-xs font-medium">
                          {mode === "switching"
                            ? "Switch to the best opportunity"
                            : "Lock one market"}
                        </span>
                        <span className="block mt-1 text-[10px] leading-relaxed text-slate-400">
                          {mode === "switching"
                            ? "Normal and recovery both compare every supported automated market, even when another market already has a viable shot."
                            : "Choose a market after the scan. Contracts can change within your allowlist, but both phases stay on that market."}
                        </span>
                      </span>
                    </button>
                  ))}
                  <p className="text-[10px] text-slate-500">
                    If no positive risk-adjusted opportunity exists, the bot
                    waits. Neither the utility floor nor a cooldown increases
                    with the loss run.
                  </p>
                </div>
              </section>
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleScan}
                  disabled={lockedControls || !!omniConfigError(config)}
                  className="bg-indigo-500 hover:bg-indigo-400 text-white h-10"
                >
                  {busy === "scan" ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ScanSearch className="w-4 h-4 mr-2" />
                  )}
                  {busy === "scan"
                    ? "Measuring opportunities…"
                    : scan
                      ? "Run a fresh scan"
                      : "Scan all supported markets"}
                </Button>
                <p className="text-xs text-amber-200">
                  {omniConfigError(config)}
                </p>
              </div>
              {busy === "scan" && (
                <div
                  role="status"
                  className="rounded-xl border border-indigo-400/20 p-4 space-y-2"
                >
                  <div className="flex justify-between text-xs text-indigo-200">
                    <span>{progress.scanning}</span>
                    <span>
                      {progress.scanned} / {progress.total || "—"}
                    </span>
                  </div>
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-400 transition-all"
                      style={{
                        width: `${progress.total ? (100 * progress.scanned) / progress.total : 3}%`,
                      }}
                    />
                  </div>
                  <p className="text-[10px] text-slate-500">
                    Chronological replay and causal model fitting. No trades are
                    placed during the scan.
                  </p>
                </div>
              )}
              {scan && (
                <section className="space-y-4" data-testid="omni-scan-results">
                  <div>
                    <h3 className="text-sm font-semibold flex items-center gap-2">
                      <Globe2 className="w-4 h-4 text-indigo-300" />
                      {scan.markets.length} measured / {scan.marketsScanned}{" "}
                      supported markets
                    </h3>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                      {scan.reason}
                    </p>
                  </div>
                  {scan.markets.length > 0 && (
                    <>
                      <label className="block text-xs text-slate-400">
                        {config.marketMode === "locked"
                          ? "Market to lock for normal AND recovery"
                          : "Initial market (the bot can switch immediately)"}
                        <select
                          aria-label="Deployment market"
                          className="mt-2 w-full rounded-lg border border-indigo-400/20 bg-[#10192c] px-3 py-2.5 text-sm text-white"
                          value={selected}
                          disabled={lockedControls}
                          onChange={(event) => setSelected(event.target.value)}
                        >
                          {scan.markets.map((market) => (
                            <option key={market.symbol} value={market.symbol}>
                              {market.displayName} · {market.source} ·{" "}
                              {market.samples} ticks
                            </option>
                          ))}
                        </select>
                      </label>
                      {chosen && (
                        <>
                          <div className="grid md:grid-cols-2 gap-3">
                            <Opportunity
                              shot={chosen.normal}
                              title="Normal opportunity"
                            />
                            <Opportunity
                              shot={chosen.recovery}
                              title="Recovery · one base-stake debt"
                            />
                          </div>
                          <div className="rounded-xl border border-white/10 p-4 space-y-3">
                            <h4 className="text-[11px] uppercase tracking-wide text-slate-300">
                              Chronological replay · last 40% of{" "}
                              {chosen.samples} ticks · indicative fills
                            </h4>
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                              <Metric
                                label="Normal wins / shots"
                                value={`${chosen.replay.normalWins} / ${chosen.replay.normalShots}`}
                              />
                              <Metric
                                label="Recovery wins / shots"
                                value={`${chosen.replay.recoveryWins} / ${chosen.replay.recoveryShots}`}
                              />
                              <Metric
                                label="Recovery loss pairs"
                                value={String(chosen.replay.recoveryLossPairs)}
                              />
                              <Metric
                                label="Replay P&L"
                                value={`${money(chosen.replay.profit)} ${scan.currency}`}
                              />
                            </div>
                            <p className="text-[10px] leading-relaxed text-slate-500">
                              Warm-up uses the first 60%; each replay decision
                              only sees past observations. No broker latency or
                              actual historical quotes are modeled. Selecting a
                              market from many replays adds selection bias.{" "}
                              {chosen.replay.stoppedByRisk
                                ? "This replay exhausted its risk budget. "
                                : ""}
                              These are diagnostics, not a forecast of live
                              returns.
                            </p>
                          </div>
                        </>
                      )}
                      {config.executionMode === "live" && (
                        <label className="flex items-start gap-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-100">
                          <input
                            type="checkbox"
                            checked={acknowledged}
                            onChange={(event) =>
                              setAcknowledged(event.target.checked)
                            }
                            className="mt-0.5 accent-indigo-400"
                          />
                          I understand this places orders on my connected Deriv
                          account. Recovery stakes can grow, further losses are
                          possible, and none of these estimates guarantees
                          repayment or profit.
                        </label>
                      )}
                      {expired && (
                        <p role="alert" className="text-xs text-amber-200">
                          This scan has expired. Run a fresh scan before
                          deploying.
                        </p>
                      )}
                      {config.executionMode === "live" &&
                        chosen?.source !== "live" && (
                          <p role="alert" className="text-xs text-amber-200">
                            Only simulated data is available for this market.
                            Use Paper or wait for a live feed and scan again.
                          </p>
                        )}
                      <Button
                        onClick={handleStart}
                        disabled={
                          busy !== null ||
                          expired ||
                          !selected ||
                          (config.executionMode === "live" &&
                            (!acknowledged || chosen?.source !== "live"))
                        }
                        className="bg-indigo-500 hover:bg-indigo-400 text-white w-full sm:w-auto"
                      >
                        {busy === "start" ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <ArrowRight className="w-4 h-4 mr-2" />
                        )}
                        {config.executionMode === "paper"
                          ? "Start paper rehearsal"
                          : "Deploy on connected account"}
                      </Button>
                    </>
                  )}
                </section>
              )}
            </>
          )}
          <div className="border-t border-white/10 pt-4 flex gap-2 text-[10px] leading-relaxed text-slate-500">
            <CircleHelp className="w-4 h-4 shrink-0 text-indigo-300/70" />
            <p>
              “Best” means the highest estimated utility among supported,
              enabled opportunities — not a certain winner. The score combines
              expected log return, model uncertainty and loss-pair risk;
              recovery also weights win probability and debt coverage. A live
              buy requires a valid quote and fresh tick. No positive opportunity
              means wait, not force a trade.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
