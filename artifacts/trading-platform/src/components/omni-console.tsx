import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ChevronLeft,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
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
  executionMode: "live",
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
    <div className="min-w-0 rounded-lg border border-white/5 bg-black/20 p-2">
      <p className="text-[8px] uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p className={`mt-0.5 font-mono text-[11px] font-semibold ${tone}`}>
        {value}
      </p>
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
    <div className="rounded-xl border border-indigo-400/20 bg-indigo-500/5 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[9px] font-semibold uppercase tracking-wide text-indigo-200">
          {title}
        </h4>
        <span
          className={`shrink-0 text-[8px] rounded-full px-1.5 py-0.5 ${shot?.ready ? "bg-emerald-500/15 text-emerald-300" : "bg-amber-500/10 text-amber-200"}`}
        >
          {shot?.ready ? "Candidate" : "Waiting"}
        </span>
      </div>
      {shot ? (
        <>
          <p className="text-sm font-semibold">{shot.contract.label}</p>
          <div className="grid grid-cols-2 gap-1.5">
            <Metric label="Estimated win" value={pct(shot.probability)} />
            <Metric label="Break-even" value={pct(shot.breakEven)} />
          </div>
          <p className="text-[10px] text-slate-300">
            Stake {money(shot.stake)} · payout {shot.payout.toFixed(2)}×
            <span className="text-[9px] text-slate-500">
              {" "}
              · {shot.quoteSource}
            </span>
          </p>
          <details className="text-[9px] text-slate-400">
            <summary className="cursor-pointer">
              Utility {shot.utility.toFixed(3)} · loss-pair risk{" "}
              {pct(shot.lossPairRisk)}
            </summary>
            <p className="mt-1 leading-relaxed">
              {shot.reason}. Estimates can be wrong.
            </p>
          </details>
        </>
      ) : (
        <p className="text-[10px] text-slate-400">
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
  const panelRef = useRef<HTMLDivElement>(null);
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
    setSelected("");
    setAcknowledged(false);
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
      if (request.current === controller) {
        request.current = null;
        setBusy(null);
      }
    }
  };
  const handleStart = async (marketMode: OmniConfig["marketMode"]) => {
    if (!scan || !selected) return;
    setBusy("start");
    setError(null);
    try {
      const result = await api<{ status: BotSessionStatus }>("start", {
        config: { ...config, marketMode, executionMode: "live" },
        scanId: scan.scanId,
        symbol: selected,
        acknowledgeLiveRisk: acknowledged,
      });
      acceptStatus(result.status);
      setMonitor(true);
      toast.success(`${bot.name} deployed on your connected account`);
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
  const screen =
    monitor && details
      ? "monitor"
      : busy === "scan"
        ? "scanning"
        : scan
          ? "results"
          : "config";
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0 });
  }, [screen]);
  const startDisabled =
    busy !== null ||
    expired ||
    !selected ||
    !acknowledged ||
    chosen?.source !== "live";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={panelRef}
        className="left-auto top-auto bottom-20 right-4 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] translate-x-0 translate-y-0 overflow-y-auto border-indigo-400/20 bg-[#0a101f] p-0 gap-0 text-slate-100 rounded-2xl sm:rounded-2xl data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0"
      >
        <DialogHeader className="p-3 border-b border-white/10 text-left">
          <div className="flex items-center gap-2.5 pr-6">
            <div className="p-2 rounded-lg bg-indigo-500/15 border border-indigo-400/25">
              <Radar className="w-4 h-4 text-indigo-300" />
            </div>
            <div className="min-w-0">
              <p className="text-[9px] tracking-widest text-indigo-300 uppercase">
                Multi-contract intelligence
              </p>
              <DialogTitle className="mt-1 text-sm">{bot.name}</DialogTitle>
            </div>
          </div>
          <DialogDescription className="pt-1 text-left text-[10px] leading-relaxed text-slate-400">
            Your contracts. Bot-selected entries for normal trading and
            recovery.
          </DialogDescription>
        </DialogHeader>
        <div className="p-3 space-y-3">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-400/25 bg-red-500/10 p-2.5 text-[11px] text-red-200"
            >
              {error}
            </div>
          )}

          {monitor && details ? (
            <div className="space-y-3" data-testid="omni-monitor">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold flex items-center gap-1.5">
                    <Activity
                      className={`w-3.5 h-3.5 shrink-0 ${running ? "text-emerald-400" : "text-slate-500"}`}
                    />
                    {details.stopping && running
                      ? "Stopping safely"
                      : running
                        ? "Opportunity radar"
                        : "Session finished"}
                  </h3>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {enabledLabels}
                  </p>
                </div>
                <span
                  className={`text-[9px] font-semibold ${status?.inRecovery ? "text-amber-300" : "text-indigo-300"}`}
                >
                  {status?.inRecovery ? "RECOVERY" : "NORMAL"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
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
              <div className="rounded-xl border border-indigo-400/20 bg-indigo-400/5 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-indigo-200">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400 animate-pulse" : "bg-slate-500"}`}
                  />
                  {watch?.phase.toUpperCase() ?? "IDLE"}
                  <span className="ml-auto text-[9px] text-slate-400">
                    {details.lockedSymbol
                      ? `LOCKED · ${details.lockedSymbol}`
                      : `${watch?.marketsConsidered ?? 0} MARKETS · SWITCHING`}
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed">
                  {status?.message}
                </p>
                <p className="mt-1.5 text-[9px] text-slate-400">
                  Feed: {watch?.source ?? "waiting"} ·{" "}
                  {watch?.ticksEvaluated ?? 0} ticks evaluated · Shared account
                  debt ledger
                </p>
              </div>
              <div
                className="max-h-64 space-y-1.5 overflow-y-auto"
                aria-label="Ranked opportunities"
              >
                {watch?.candidates.map((shot, i) => (
                  <div
                    key={`${shot.symbol}:${shot.contract.id}`}
                    className={`rounded-lg border border-white/10 p-2.5 ${i === 0 ? "bg-indigo-500/10" : "bg-white/[0.02]"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold">
                        {shot.contract.label}
                      </p>
                      <span
                        className={`text-[10px] font-mono ${shot.utility > 0 ? "text-emerald-300" : "text-slate-400"}`}
                      >
                        {shot.utility.toFixed(3)} utility
                      </span>
                    </div>
                    <p className="mt-0.5 text-[9px] text-slate-400">
                      {shot.displayName}
                    </p>
                    <div className="mt-2 grid grid-cols-3 gap-1 text-[9px] text-slate-400">
                      <span>
                        Est. win{" "}
                        <b className="block text-[11px] font-mono text-slate-200">
                          {pct(shot.probability)}
                        </b>
                      </span>
                      <span>
                        Payout{" "}
                        <b className="block text-[11px] font-mono text-slate-200">
                          {shot.payout.toFixed(2)}×
                        </b>
                      </span>
                      <span>
                        Stake{" "}
                        <b className="block text-[11px] font-mono text-slate-200">
                          {money(shot.stake)}
                        </b>
                      </span>
                    </div>
                    <p className="mt-1.5 text-[9px] text-slate-400">
                      {shot.quoteSource} quote
                      {status?.inRecovery
                        ? ` · ${pct(shot.debtCoverage)} debt covered if won`
                        : ""}
                    </p>
                    <p
                      className={`mt-1 text-[9px] ${shot.ready ? "text-emerald-300" : "text-slate-500"}`}
                    >
                      {shot.ready ? "Candidate" : shot.reason}
                    </p>
                  </div>
                ))}
                {!watch?.candidates.length && (
                  <p className="p-3 text-center text-[11px] text-slate-400">
                    Collecting observations for the opportunity radar…
                  </p>
                )}
              </div>
              {running ? (
                <Button
                  className="w-full h-9 text-xs bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-400/25"
                  disabled={busy !== null || details.stopping}
                  onClick={handleStop}
                >
                  <StopCircle className="w-3.5 h-3.5 mr-2" />
                  {details.stopping ? "Waiting for settlement…" : "Stop bot"}
                </Button>
              ) : (
                <Button
                  className="w-full h-9 text-xs"
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
              <p className="text-[9px] leading-relaxed text-slate-500">
                Closing this console does not stop the bot. Stop waits for any
                outstanding order to settle.
              </p>
            </div>
          ) : busy === "scan" ? (
            <div
              role="status"
              className="py-6 space-y-3 text-center"
              data-testid="omni-scanning"
            >
              <Loader2 className="mx-auto w-7 h-7 animate-spin text-indigo-300" />
              <h3 className="text-xs font-semibold">Measuring opportunities</h3>
              <p className="text-[10px] text-slate-400">
                {progress.scanning} · {progress.scanned} /{" "}
                {progress.total || "—"}
              </p>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-400 transition-all"
                  style={{
                    width: `${progress.total ? (100 * progress.scanned) / progress.total : 3}%`,
                  }}
                />
              </div>
              <p className="text-[9px] text-slate-500">
                Causal model fitting and chronological replay. Scanning does not
                place trades.
              </p>
            </div>
          ) : scan ? (
            <section className="space-y-3" data-testid="omni-scan-results">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold flex items-center gap-1.5">
                    <Globe2 className="w-3.5 h-3.5 text-indigo-300" />
                    {scan.markets.length} / {scan.marketsScanned} markets
                  </h3>
                  <p className="mt-1 text-[10px] text-slate-400">
                    Choose a market, then lock or switch.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[10px] shrink-0"
                  onClick={() => {
                    setScan(null);
                    setSelected("");
                    setAcknowledged(false);
                    setError(null);
                  }}
                  disabled={busy !== null}
                >
                  <ChevronLeft className="w-3 h-3 mr-1" /> Edit setup
                </Button>
              </div>
              {scan.markets.length === 0 ? (
                <p className="text-[11px] text-slate-400">{scan.reason}</p>
              ) : (
                <>
                  <label className="block text-[10px] text-slate-400">
                    Deployment market
                    <select
                      aria-label="Deployment market"
                      className="mt-1 w-full rounded-lg border border-indigo-400/20 bg-[#10192c] px-2 py-2 text-[11px] text-white"
                      value={selected}
                      disabled={lockedControls}
                      onChange={(event) => setSelected(event.target.value)}
                    >
                      {scan.markets.map((market) => (
                        <option key={market.symbol} value={market.symbol}>
                          {market.displayName} · {market.source}
                        </option>
                      ))}
                    </select>
                  </label>
                  {chosen && (
                    <>
                      <Tabs defaultValue="normal">
                        <TabsList
                          aria-label="Opportunity previews"
                          className="grid w-full grid-cols-2 h-8 bg-black/20"
                        >
                          <TabsTrigger
                            value="normal"
                            className="text-[10px] data-[state=active]:bg-indigo-500/20 data-[state=active]:text-indigo-200"
                          >
                            Normal preview
                          </TabsTrigger>
                          <TabsTrigger
                            value="recovery"
                            className="text-[10px] data-[state=active]:bg-indigo-500/20 data-[state=active]:text-indigo-200"
                          >
                            Recovery preview
                          </TabsTrigger>
                        </TabsList>
                        <TabsContent value="normal" className="mt-2">
                          <Opportunity
                            shot={chosen.normal}
                            title="Normal opportunity"
                          />
                        </TabsContent>
                        <TabsContent value="recovery" className="mt-2">
                          <Opportunity
                            shot={chosen.recovery}
                            title="Recovery · one base-stake debt"
                          />
                        </TabsContent>
                      </Tabs>
                      <details className="rounded-lg border border-white/10 p-2.5 text-[10px]">
                        <summary className="cursor-pointer font-semibold text-slate-300">
                          Replay diagnostics · {chosen.samples} ticks
                        </summary>
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
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
                        <p className="mt-2 leading-relaxed text-slate-500">
                          {scan.reason} Warm-up uses the first 60%; replay uses
                          the last 40% with indicative next-tick fills. No
                          broker latency or historical quotes are modeled.
                          Comparing markets adds selection bias.{" "}
                          {chosen.replay.stoppedByRisk
                            ? "This replay exhausted its risk budget. "
                            : ""}
                          These are diagnostics, not a forecast of live returns.
                        </p>
                      </details>
                    </>
                  )}
                  <label className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2.5 text-[10px] leading-relaxed text-amber-100">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={busy !== null}
                      onChange={(event) =>
                        setAcknowledged(event.target.checked)
                      }
                      className="mt-0.5 accent-indigo-400"
                    />
                    I understand this trades my connected Deriv account.
                    Recovery stakes can grow; further losses are possible.
                    Profit is not guaranteed.
                  </label>
                  {expired && (
                    <p role="alert" className="text-[10px] text-amber-200">
                      This scan has expired. Run a fresh scan before deploying.
                    </p>
                  )}
                  {chosen?.source !== "live" && (
                    <p role="alert" className="text-[10px] text-amber-200">
                      A live market feed is required. Wait for live data and
                      scan again.
                    </p>
                  )}
                  <div className="space-y-2">
                    <Button
                      onClick={() => handleStart("locked")}
                      disabled={startDisabled}
                      className="w-full h-10 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold"
                    >
                      {busy === "start" ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <LockKeyhole className="w-4 h-4 mr-2" />
                      )}{" "}
                      Trade Locked
                    </Button>
                    <Button
                      onClick={() => handleStart("switching")}
                      disabled={startDisabled}
                      variant="outline"
                      className="w-full h-9 border-indigo-400/40 text-indigo-200 hover:bg-indigo-400/10 text-xs font-semibold"
                    >
                      <Shuffle className="w-3.5 h-3.5 mr-2" /> Smart Switching
                    </Button>
                    <p className="text-[9px] leading-relaxed text-slate-500">
                      Lock keeps both phases on this market. Switching searches
                      all supported markets for normal and recovery trades.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleScan}
                    disabled={busy !== null}
                    className="w-full py-1 text-[10px] text-slate-400 hover:text-white disabled:opacity-50"
                  >
                    Run a fresh scan
                  </button>
                </>
              )}
            </section>
          ) : (
            <div className="space-y-3" data-testid="omni-setup">
              <div className="flex flex-wrap gap-1.5 text-[9px] text-indigo-200">
                <span className="rounded-full px-2 py-1 bg-indigo-400/10 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3" /> Same recovery allowlist
                </span>
                <span className="rounded-full px-2 py-1 bg-white/5 text-slate-300">
                  No loss ratchets
                </span>
              </div>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[11px] font-semibold">
                    01 · Enable contracts
                  </h3>
                  <div className="flex gap-2.5 text-[10px]">
                    <button
                      type="button"
                      disabled={lockedControls}
                      onClick={() =>
                        change(
                          "enabledContracts",
                          OMNI_CONTRACTS.map((c) => c.id),
                        )
                      }
                      className="text-indigo-300 hover:text-indigo-100 disabled:opacity-50"
                    >
                      Enable all
                    </button>
                    <button
                      type="button"
                      disabled={lockedControls}
                      onClick={() => change("enabledContracts", [])}
                      className="text-slate-400 hover:text-white disabled:opacity-50"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {OMNI_CONTRACTS.map((contract) => {
                    const enabled = config.enabledContracts.includes(
                      contract.id,
                    );
                    return (
                      <button
                        key={contract.id}
                        type="button"
                        aria-label={`${contract.label} contract`}
                        aria-pressed={enabled}
                        title={contract.hint}
                        disabled={lockedControls}
                        onClick={() => toggle(contract.id)}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:opacity-50 ${enabled ? "bg-indigo-500/15 border-indigo-400/50 text-indigo-100" : "bg-black/15 border-white/10 text-slate-400 hover:border-indigo-400/30"}`}
                      >
                        <span
                          className={`flex w-3.5 h-3.5 shrink-0 items-center justify-center rounded border ${enabled ? "bg-indigo-400 border-indigo-400 text-indigo-950" : "border-slate-600"}`}
                        >
                          {enabled && <Check className="w-2.5 h-2.5" />}
                        </span>
                        <span className="text-[11px] font-semibold">
                          {contract.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[9px] text-slate-500">
                  {config.enabledContracts.length} of 8 enabled in both phases.
                  Digits and barriers are automatic.
                </p>
              </section>
              <section className="rounded-xl border border-white/10 p-2.5 space-y-2.5">
                <h3 className="text-[11px] font-semibold">
                  02 · Risk & execution
                </h3>
                <p className="text-[10px] text-slate-400">
                  Trades your connected Deriv account — demo or real.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { key: "stake", label: "Base stake" },
                      { key: "stopLoss", label: "Stop loss" },
                      { key: "takeProfit", label: "Take profit" },
                    ] as const
                  ).map((field) => (
                    <label
                      className="min-w-0 text-[9px] text-slate-400"
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
                        className="mt-1 h-8 px-2 bg-black/20 border-white/10 text-slate-200 font-mono text-xs"
                      />
                    </label>
                  ))}
                </div>
                <details className="text-[9px] text-slate-500">
                  <summary className="cursor-pointer">
                    Recovery sizing ·{" "}
                    {Number(settings?.botRecoveryMarkup ?? 10).toFixed(1)}%
                    markup
                  </summary>
                  <p className="mt-1 leading-relaxed">
                    Stake = debt × (1 + markup) ÷ net payout. Balance, max stake
                    and remaining stop-loss cap every order. Capped wins may
                    repay only part of the debt.
                  </p>
                </details>
              </section>
              {omniConfigError(config) && (
                <p role="alert" className="text-[10px] text-amber-200">
                  {omniConfigError(config)}
                </p>
              )}
              <Button
                onClick={handleScan}
                disabled={lockedControls || !!omniConfigError(config)}
                className="w-full h-10 bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold"
              >
                <ScanSearch className="w-4 h-4 mr-2" /> Scan markets
              </Button>
            </div>
          )}
          <details className="border-t border-white/10 pt-2.5 text-[9px] leading-relaxed text-slate-500">
            <summary className="cursor-pointer text-slate-400">
              <CircleHelp className="inline w-3 h-3 mr-1 text-indigo-300/70" />{" "}
              Estimated opportunities, not guaranteed wins
            </summary>
            <p className="mt-2">
              “Best” means the highest estimated utility among enabled
              opportunities. Scoring combines expected log return, uncertainty
              and loss-pair risk; recovery also weighs win probability and debt
              coverage. Every buy needs a valid quote and fresh tick. The
              utility floor stays at zero: no positive opportunity means wait,
              not force a trade.
            </p>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
