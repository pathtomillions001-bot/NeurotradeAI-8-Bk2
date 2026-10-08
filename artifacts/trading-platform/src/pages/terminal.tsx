/**
 * Multi-Asset Desk.
 *
 * A live-terminal operations workspace, not a chart dashboard. The Desk only
 * renders broker data supplied by a paired MT5 EA; before pairing it provides
 * a clear connection workflow instead of demo balances, replay prices or mock
 * signals. The responsive layout stacks intentionally on small screens and
 * uses independent columns on desktop, so plans, positions and market controls
 * cannot overlap each other.
 *
 * Prices arrive over a server-sent event stream pushed the moment the MT5
 * terminal's heartbeat lands. Polling remains only as a fallback, so a dropped
 * stream degrades to a slower refresh instead of freezing on stale quotes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Globe,
  Link2,
  Power,
  RefreshCw,
  ShieldAlert,
  Unplug,
  WifiOff,
  Zap,
} from "lucide-react";
import {
  AgentPane,
  ArmedPlansPane,
  JournalPane,
  LiveQuotePane,
  MarketUniversePane,
  NewsPane,
  Pane,
  PerformancePane,
  PositionsPane,
  RiskPane,
  ScannerPane,
  WatchlistPane,
} from "@/components/terminal/panes";
import { BridgeDialog } from "@/components/terminal/bridge-dialog";
import { useDeskStream } from "@/hooks/use-desk-stream";
import {
  DEFAULT_DESK_TIMEZONE,
  MODE_ANALYSIS_LABEL,
  TRADE_MODES,
  deskApi,
  formatMoney,
  type Instrument,
  type TradeMode,
} from "@/lib/desk";

const REFRESH_MS = 5_000;

export default function Terminal() {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("");
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ["desk-state"],
    queryFn: deskApi.state,
    refetchInterval: REFRESH_MS,
  });
  const terminal = state.data?.terminal ?? null;
  const account = state.data?.account ?? null;
  const terminalLive = Boolean(terminal && !terminal.stale && account);
  const mode: TradeMode = state.data?.mode ?? "intraday";
  const selectedMarkets = state.data?.watchlist ?? [];
  const timeZone = state.data?.timezone ?? DEFAULT_DESK_TIMEZONE;

  // ── Live price stream ────────────────────────────────────────────────────
  // Quotes, account, positions and plans are pushed on every terminal
  // heartbeat. The polled `state` query is the fallback and the source of
  // everything that does not change tick-by-tick.
  const stream = useDeskStream(Boolean(terminal));

  const markets = useQuery({
    queryKey: ["desk-markets"],
    queryFn: deskApi.markets,
    enabled: Boolean(terminal),
    refetchInterval: 30_000,
  });
  const instruments = useQuery({
    queryKey: ["desk-instruments"],
    queryFn: deskApi.instruments,
    enabled: Boolean(terminal),
    // While the stream is actually delivering prices, polling is just a slow
    // fallback. The moment data stops flowing (socket open, no events) the
    // poll drops to 3s so the board reflects reality instead of waiting 20s.
    refetchInterval: stream.flowing ? 20_000 : 3_000,
  });
  const performance = useQuery({
    queryKey: ["desk-performance"],
    queryFn: deskApi.performance,
    enabled: Boolean(terminal),
    refetchInterval: 30_000,
  });
  const analysis = useQuery({
    queryKey: ["desk-analysis", symbol, mode],
    queryFn: () => deskApi.analysis(symbol, mode),
    enabled: terminalLive && Boolean(symbol),
    refetchInterval: 20_000,
  });
  const scan = useQuery({
    queryKey: ["desk-scan", mode, selectedMarkets],
    queryFn: () => deskApi.scan(mode),
    enabled: terminalLive && selectedMarkets.length > 0,
    refetchInterval: 30_000,
  });

  // Select a real selected symbol as soon as the terminal coverage changes.
  useEffect(() => {
    if (selectedMarkets.length === 0) {
      if (symbol) setSymbol("");
      return;
    }
    if (!selectedMarkets.includes(symbol)) setSymbol(selectedMarkets[0] as string);
  }, [selectedMarkets, symbol]);

  useEffect(() => setActionError(null), [symbol, mode]);

  const invalidateDesk = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["desk-state"] });
    queryClient.invalidateQueries({ queryKey: ["desk-markets"] });
    queryClient.invalidateQueries({ queryKey: ["desk-instruments"] });
    queryClient.invalidateQueries({ queryKey: ["desk-analysis"] });
    queryClient.invalidateQueries({ queryKey: ["desk-scan"] });
    queryClient.invalidateQueries({ queryKey: ["desk-performance"] });
  }, [queryClient]);

  const settings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => deskApi.settings(patch),
    onSuccess: () => {
      setActionError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setActionError(error.message),
  });
  const arm = useMutation({
    mutationFn: () => deskApi.arm(symbol, mode),
    onSuccess: () => {
      setActionError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setActionError(error.message),
  });
  const flatten = useMutation({
    mutationFn: () => deskApi.flatten("Manual Desk kill switch"),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const closePosition = useMutation({
    mutationFn: (ticket: number) => deskApi.closePosition(ticket),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const resumeSymbol = useMutation({
    mutationFn: (value: string) => deskApi.resumeSymbol(value),
    onSuccess: invalidateDesk,
  });
  const cancelPlan = useMutation({
    mutationFn: (id: string) => deskApi.cancelPlan(id),
    onSuccess: invalidateDesk,
  });

  // Live instruments win over polled ones; the stream is always fresher.
  const liveInstruments = stream.instruments ?? instruments.data?.instruments ?? [];
  const liveAccount = stream.account ?? account;
  const livePositions = stream.positions ?? state.data?.positions ?? [];
  const livePlans = stream.plans ?? state.data?.plans ?? [];

  const selectedInstrument = useMemo<Instrument | null>(
    () => liveInstruments.find((instrument) => instrument.symbol === symbol) ?? null,
    [liveInstruments, symbol],
  );

  const mismatched = liveInstruments.filter((instrument) => instrument.dataStatus === "mismatch");

  const toggleMarket = (marketSymbol: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...selectedMarkets, marketSymbol])]
      : selectedMarkets.filter((candidate) => candidate !== marketSymbol);
    settings.mutate({ watchlist: next });
  };

  const sourceLabel = !terminal ? "MT5 REQUIRED" : terminal.stale ? "MT5 STALE" : !account ? "MT5 WARMING" : "MT5 LIVE";
  const sourceClass = !terminal || !account
    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
    : terminal.stale
      ? "border-red-500/40 bg-red-500/10 text-red-300"
      : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";

  return (
    <div className="desk-surface min-h-full text-zinc-200">
      <div className="mx-auto max-w-[1880px] space-y-4 p-4 sm:p-5 lg:p-6">
        {/* ── Command bar ─────────────────────────────────────────────── */}
        <header className="relative overflow-hidden rounded-2xl border border-white/[0.07] bg-zinc-950/70 px-4 py-3.5 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl sm:px-5">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400/20 to-emerald-500/10 ring-1 ring-inset ring-cyan-300/25">
                <Activity className="h-4 w-4 text-cyan-300" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold tracking-[0.12em] text-zinc-50">MULTI-ASSET DESK</h1>
                <p className="hidden truncate text-[11px] text-zinc-500 sm:block">Live broker data · market universe · guarded execution</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${sourceClass}`} data-testid="data-source">
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {sourceLabel}
              </span>
              {terminal && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${stream.flowing ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-zinc-700 text-zinc-500"}`}
                  title={stream.flowing ? "Prices are pushed the instant the terminal heartbeats" : "No fresh prices are arriving — falling back to fast polling"}
                  data-testid="stream-status"
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${stream.flowing ? "animate-pulse bg-sky-400" : "bg-zinc-600"}`} />
                  {stream.flowing ? "Stream" : "Poll"}
                </span>
              )}
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <div className="flex rounded-lg border border-white/[0.08] bg-zinc-900/60 p-0.5">
                {TRADE_MODES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={!terminalLive || settings.isPending}
                    onClick={() => settings.mutate({ mode: entry.id })}
                    title={`${entry.label} — monitors ${entry.blurb}, and looks for the best of your selected markets in that band`}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${mode === entry.id ? "bg-cyan-400/15 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.35)]" : "text-zinc-400 hover:text-zinc-100"}`}
                    data-testid={`mode-${entry.id}`}
                  >
                    {entry.label}
                    <span className={`ml-1.5 font-mono text-[9px] ${mode === entry.id ? "text-cyan-300/70" : "text-zinc-600"}`}>{MODE_ANALYSIS_LABEL[entry.id]}</span>
                  </button>
                ))}
              </div>

              {/* Every timestamp on the desk is rendered in this zone. */}
              <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-zinc-900/60 px-2 py-1.5 text-[11px] text-zinc-400" title="Timezone for prices, news and journal entries">
                <Globe className="h-3.5 w-3.5 text-zinc-500" />
                <select
                  value={timeZone}
                  disabled={settings.isPending}
                  onChange={(event) => settings.mutate({ timezone: event.target.value })}
                  className="max-w-[120px] bg-transparent text-[11px] text-zinc-300 outline-none"
                  data-testid="timezone-select"
                >
                  {(state.data?.timezones ?? [{ id: DEFAULT_DESK_TIMEZONE, label: "Nairobi · EAT" }]).map((zone) => (
                    <option key={zone.id} value={zone.id} className="bg-zinc-900">{zone.label}</option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={!terminalLive || settings.isPending}
                onClick={() => settings.mutate({ autoTrade: !state.data?.autoTrade })}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-40 ${state.data?.autoTrade ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300 shadow-[0_0_20px_-4px_rgba(52,211,153,0.5)]" : "border-white/[0.08] bg-zinc-900/60 text-zinc-400 hover:text-zinc-100"}`}
                data-testid="auto-trade-toggle"
              >
                <Zap className="h-3.5 w-3.5" />Auto {state.data?.autoTrade ? "ON" : "OFF"}
              </button>
              <button
                type="button"
                onClick={() => setBridgeOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-zinc-900/60 px-3 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-white/15 hover:text-zinc-100"
                data-testid="open-bridge"
              >
                {terminal ? <Link2 className="h-3.5 w-3.5 text-emerald-400" /> : <Unplug className="h-3.5 w-3.5" />}
                {terminal ? `MT5 ${terminal.login}` : "Link MT5"}
              </button>
              <button
                type="button"
                disabled={!terminal || flatten.isPending}
                onClick={() => flatten.mutate()}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                title="Cancel every armed plan and request all MT5 positions be closed"
                data-testid="kill-switch"
              >
                <Power className="h-3.5 w-3.5" />FLATTEN
              </button>
            </div>
          </div>

          {/* Account KPI strip — the numbers a desk reads first. */}
          {liveAccount && (
            <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-white/[0.06] pt-3.5 sm:grid-cols-4">
              <Kpi label="Equity" value={formatMoney(liveAccount.equity, liveAccount.currency)} accent="cyan" />
              <Kpi label="Balance" value={formatMoney(liveAccount.balance, liveAccount.currency)} />
              <Kpi label="Free margin" value={formatMoney(liveAccount.freeMargin, liveAccount.currency)} />
              <Kpi
                label="Realised"
                value={performance.data?.overall.totalR !== undefined ? `${performance.data.overall.totalR >= 0 ? "+" : ""}${performance.data.overall.totalR.toFixed(1)}R` : "—"}
                tone={performance.data?.overall.totalR === undefined ? undefined : performance.data.overall.totalR >= 0 ? "good" : "bad"}
                trailing={liveAccount.isLive ? <span className="rounded-full bg-red-500/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-red-300">Real money</span> : undefined}
              />
            </div>
          )}
        </header>

        {state.data?.risk.state.haltedUntilNextSession && (
          <div className="flex gap-2.5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-300"><ShieldAlert className="mt-px h-4 w-4 shrink-0" />{state.data.risk.state.haltReason}</div>
        )}

        {/* Feed integrity: say so when a price cannot be trusted. */}
        {mismatched.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs leading-relaxed text-red-200">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" />
            <span>
              <strong className="font-semibold">{mismatched.map((entry) => entry.symbol).join(", ")}</strong>
              {" "}{mismatched.length === 1 ? "is" : "are"} reporting a price that disagrees with its own candles. Trading on {mismatched.length === 1 ? "it" : "them"} is blocked — check the broker symbol and that the EA is subscribed to it.
            </span>
          </div>
        )}
        {/*
          Clock health is deliberately NOT a desk-wide alarm any more: the EA
          (v3.04+) self-corrects it, and its own clock error is surfaced calmly in
          the bridge dialog (Link MT5) with the one action that fixes it — sync NTP.
        */}

        {/*
          Two states, deliberately distinct.

          A late heartbeat used to flip the whole desk into "paused" for a single
          missed round trip. While the terminal is merely late, every symbol is
          still checked against its own 8-second quote before anything is analysed
          or armed, so the desk keeps working and says so. Only the hard state
          stops work, and it takes a genuinely dead terminal to reach it.
        */}
        {terminal?.degraded && (
          <div className="flex gap-2.5 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-xs leading-relaxed text-sky-200"><RefreshCw className="mt-px h-4 w-4 shrink-0" /><span>Reconnecting to the MT5 terminal — last heartbeat {Math.max(0, Math.round((terminal.lastSyncAgeMs ?? Date.now() - terminal.lastSyncAt) / 1000))}s ago (it reports every {terminal.syncIntervalMs ? `${(terminal.syncIntervalMs / 1000).toFixed(1)}s` : "~1s"}). The link is saved on both sides, so a closed terminal, a restart or a redeploy reconnects by itself. The desk keeps analysing; every market is still gated on its own quote age, so nothing is traded on a stale price.</span></div>
        )}
        {terminal?.stale && (
          <div className="flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-200"><WifiOff className="mt-px h-4 w-4 shrink-0" /><span>The MT5 terminal has not synced for {Math.max(0, Math.round((terminal.lastSyncAgeMs ?? Date.now() - terminal.lastSyncAt) / 1000))}s (limit {Math.round((terminal.staleAfterMs ?? 120_000) / 1000)}s). Quotes and agent entries are paused until it resumes; any displayed account snapshot is explicitly the last terminal update.</span></div>
        )}
        {actionError && <div className="flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-200"><ShieldAlert className="mt-px h-4 w-4 shrink-0" /><span>{actionError}</span></div>}

        {!terminal ? (
          <EmptyDesk onConnect={() => setBridgeOpen(true)} />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-12">
            {/* Left rail — what the broker offers and what is trading. */}
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-5 xl:col-span-3">
              <Pane title="Broker market universe" right={<CountBadge>{state.data?.market.catalogCount ?? 0}</CountBadge>}>
                <MarketUniversePane
                  markets={markets.data?.markets ?? []}
                  selected={selectedMarkets}
                  updating={settings.isPending}
                  onToggle={toggleMarket}
                  onFocus={setSymbol}
                />
              </Pane>
              <Pane title="Selected live coverage" right={<CountBadge>{state.data?.market.liveSymbols ?? 0}/{state.data?.market.selectedCount ?? 0} fresh</CountBadge>}>
                <WatchlistPane instruments={liveInstruments} selected={symbol} onSelect={setSymbol} />
              </Pane>
            </div>

            {/* Centre — the instrument in focus and the agent's read on it. */}
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-7 xl:col-span-5">
              <Pane title="Live market pulse" right={selectedInstrument ? <CountBadge tone="cyan">broker feed</CountBadge> : undefined}>
                <LiveQuotePane instrument={selectedInstrument} />
              </Pane>
              <Pane title={symbol ? `Agent assessment · ${symbol}` : "Agent assessment"} right={<CountBadge tone="cyan">{mode}</CountBadge>}>
                <AgentPane
                  decision={analysis.data?.decision ?? null}
                  horizonMinutes={analysis.data?.horizonMinutes ?? 0}
                  onArm={() => arm.mutate()}
                  arming={arm.isPending}
                  armError={actionError}
                />
              </Pane>
              <Pane
                title="Live scanner"
                right={
                  <button type="button" disabled={!terminalLive} onClick={() => scan.refetch()} className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-40" aria-label="Rescan selected markets">
                    <RefreshCw className={`h-3.5 w-3.5 ${scan.isFetching ? "animate-spin" : ""}`} />
                  </button>
                }
              >
                {scan.data?.coverage && (
                  <p className="border-b border-white/[0.05] px-4 py-2 font-mono text-[11px] text-zinc-500">
                    <span className="text-emerald-400">{scan.data.coverage.live}</span> fresh · <span className="text-amber-300">{scan.data.coverage.warming}</span> warming · <span className="text-zinc-400">{scan.data.coverage.stale}</span> stale / {scan.data.coverage.selected} selected
                  </p>
                )}
                <ScannerPane
                  rows={scan.data?.results ?? []}
                  onSelect={setSymbol}
                  selected={symbol}
                  autoSelect={state.data?.autoSelect ?? null}
                />
              </Pane>
            </div>

            {/* Right — exposure, risk and the record. On wide screens this column
                splits into two side-by-side stacks so nothing becomes a tall sliver. */}
            <div className="grid min-w-0 gap-4 lg:col-span-12 lg:grid-cols-2 xl:col-span-4 xl:block xl:space-y-4">
              <div className="flex min-w-0 flex-col gap-4">
                <Pane title="Open positions" right={<CountBadge tone={livePositions.length > 0 ? "cyan" : undefined}>{livePositions.length} open</CountBadge>}>
                  <PositionsPane positions={livePositions} currency={liveAccount?.currency ?? "USD"} onClose={(ticket) => closePosition.mutate(ticket)} />
                </Pane>
                <Pane title="Armed plans" right={<CountBadge>{livePlans.length}</CountBadge>}>
                  <ArmedPlansPane plans={livePlans} onCancel={(id) => cancelPlan.mutate(id)} />
                </Pane>
                <Pane title="Risk controls"><RiskPane state={state.data!} onResume={(value) => resumeSymbol.mutate(value)} /></Pane>
                <Pane
                  title="Red-folder calendar"
                  right={<CountBadge tone={state.data?.news.available && state.data.news.rawCount !== 0 ? "emerald" : "amber"}>{state.data?.news.available ? (state.data.news.rawCount === 0 ? "unread" : "MT5 calendar") : "paused"}</CountBadge>}
                >
                  <NewsPane
                    feed={state.data?.news ?? { available: false, checkedAt: 0, events: [] }}
                    upcoming={state.data?.newsUpcoming ?? []}
                    timeZone={timeZone}
                  />
                </Pane>
              </div>
              <div className="flex min-w-0 flex-col gap-4">
                <Pane
                  title="Realised performance"
                  right={<CountBadge tone={performance.data?.overall.totalR === undefined ? undefined : performance.data.overall.totalR >= 0 ? "emerald" : "red"}>{performance.data?.overall.totalR !== undefined ? `${performance.data.overall.totalR >= 0 ? "+" : ""}${performance.data.overall.totalR.toFixed(1)}R` : "—"}</CountBadge>}
                >
                  <PerformancePane
                    performance={performance.data ?? null}
                    currency={liveAccount?.currency ?? "USD"}
                    timeZone={timeZone}
                  />
                </Pane>
                <Pane title="Decision journal"><JournalPane entries={state.data?.journal ?? []} timeZone={timeZone} /></Pane>
              </div>
            </div>
          </div>
        )}
      </div>
      <BridgeDialog open={bridgeOpen} onClose={() => setBridgeOpen(false)} linked={Boolean(terminal)} onChanged={invalidateDesk} />
    </div>
  );
}

function Kpi({ label, value, tone, accent, trailing }: { label: string; value: string; tone?: "good" | "bad"; accent?: "cyan"; trailing?: React.ReactNode }) {
  const valueClass = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : accent === "cyan" ? "text-cyan-200" : "text-zinc-100";
  return (
    <div className="group relative overflow-hidden rounded-xl border border-white/[0.06] bg-gradient-to-br from-white/[0.035] to-transparent px-3.5 py-2.5 transition-colors hover:border-white/10">
      <dt className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">
        {label}
        {trailing}
      </dt>
      <dd className={`mt-1 truncate font-mono text-base font-semibold tabular-nums sm:text-lg ${valueClass}`}>{value}</dd>
    </div>
  );
}

function CountBadge({ children, tone }: { children: React.ReactNode; tone?: "cyan" | "emerald" | "amber" | "red" }) {
  const toneClass =
    tone === "cyan" ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200"
    : tone === "emerald" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : tone === "amber" ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
    : tone === "red" ? "border-red-400/30 bg-red-400/10 text-red-300"
    : "border-white/[0.08] bg-white/[0.03] text-zinc-400";
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${toneClass}`}>{children}</span>;
}

function EmptyDesk({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/[0.08] bg-zinc-950/70 p-6 shadow-[0_20px_60px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl sm:p-10">
      <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl" />
      <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-400/25 to-emerald-500/10 ring-1 ring-inset ring-cyan-300/30">
            <Link2 className="h-6 w-6 text-cyan-300" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300/80">Standby</p>
            <h2 className="mt-1 text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl">Connect MT5 to bring the Desk online</h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">
              No balance, price, position, scanner result or agent decision is shown until your MetaTrader 5 terminal provides it. The Desk runs only on your broker’s live data.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onConnect}
          className="group inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-400 to-emerald-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_0_30px_-6px_rgba(34,211,238,0.6)] transition-transform hover:-translate-y-px sm:w-auto"
        >
          Set up MT5 bridge
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </button>
      </div>
      <ol className="relative mt-8 grid gap-3 border-t border-white/[0.06] pt-6 sm:grid-cols-3">
        <InfoStep number="01" title="Download & attach">Attach the resilient Neurotrade MT5 EA (v3 or later) to any chart. It stays attached and retries pairing instead of failing initialization.</InfoStep>
        <InfoStep number="02" title="Pair securely">Add this platform origin to MT5’s WebRequest allowlist and paste the one-time pairing code. No MT5 password leaves your terminal.</InfoStep>
        <InfoStep number="03" title="Select broker markets">The EA discovers the complete broker catalogue. Choose any number of forex, crypto, indices, stocks, metals, futures or other supported symbols.</InfoStep>
      </ol>
    </section>
  );
}

function InfoStep({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return (
    <li className="group rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 transition-colors hover:border-cyan-400/20 hover:bg-white/[0.035]">
      <span className="font-mono text-[11px] font-semibold text-cyan-300/80">{number}</span>
      <h3 className="mt-2 text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{children}</p>
    </li>
  );
}
