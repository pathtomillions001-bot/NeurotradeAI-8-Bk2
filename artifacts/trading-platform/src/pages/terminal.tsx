/** Live-only, responsive Multi-Asset Desk for a user's linked MT5 broker. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Link2,
  Power,
  RefreshCw,
  ShieldAlert,
  Unplug,
  Zap,
} from "lucide-react";
import {
  AgentPane,
  HighImpactNewsPane,
  JournalPane,
  LiveWatchlistPane,
  MarketUniversePane,
  Pane,
  PlansPane,
  PositionsPane,
  RiskPane,
  ScannerPane,
} from "@/components/terminal/panes";
import { BridgeDialog } from "@/components/terminal/bridge-dialog";
import {
  TRADE_MODES,
  deskApi,
  formatMoney,
  type AssetClass,
  type TradeMode,
} from "@/lib/desk";

const STATE_REFRESH_MS = 4000;
const INSTRUMENT_REFRESH_MS = 5000;
const SCAN_REFRESH_MS = 12_000;

export default function Terminal() {
  const queryClient = useQueryClient();
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [selectedClass, setSelectedClass] = useState<AssetClass | "all">("all");
  const [marketSearch, setMarketSearch] = useState("");
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [armError, setArmError] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ["desk-state"],
    queryFn: deskApi.state,
    refetchInterval: STATE_REFRESH_MS,
  });
  const instruments = useQuery({
    queryKey: ["desk-instruments"],
    queryFn: deskApi.instruments,
    refetchInterval: INSTRUMENT_REFRESH_MS,
  });

  const mode: TradeMode = state.data?.mode ?? "intraday";
  const feedReady = state.data?.feedReady === true && !(state.error instanceof Error);
  const newsReady = Boolean(
    state.data?.news.ready &&
    state.data.news.fetchedAt !== null &&
    Date.now() - state.data.news.fetchedAt <= state.data.news.staleAfterMs &&
    state.data.news.fetchedAt <= Date.now() + 30_000 &&
    !(state.error instanceof Error),
  );
  const liveLinked = state.data?.source === "mt5";
  const watchlist = state.data?.watchlist ?? [];
  const watchedInstruments = useMemo(
    () => (instruments.data?.instruments ?? []).filter((instrument) => instrument.watched),
    [instruments.data?.instruments],
  );

  // The server owns the durable watchlist. Mirror it locally for immediate
  // checkbox feedback, then keep the selected analysis symbol on that list.
  useEffect(() => {
    setSelectedSymbols(watchlist);
  }, [watchlist.join("\u0000")]);

  useEffect(() => {
    if (selectedSymbol && watchlist.includes(selectedSymbol)) return;
    setSelectedSymbol(watchlist[0] ?? "");
  }, [selectedSymbol, watchlist.join("\u0000")]);

  const analysisEnabled = Boolean(feedReady && selectedSymbol && watchlist.includes(selectedSymbol));
  const analysis = useQuery({
    queryKey: ["desk-analysis", selectedSymbol, mode],
    queryFn: () => deskApi.analysis(selectedSymbol, mode),
    enabled: analysisEnabled,
    refetchInterval: analysisEnabled ? STATE_REFRESH_MS * 2 : false,
  });
  const scanEnabled = Boolean(feedReady && watchlist.length > 0);
  const scan = useQuery({
    queryKey: ["desk-scan", watchlist.join("\u0000"), mode],
    queryFn: () => deskApi.scan(mode),
    enabled: scanEnabled,
    // Full multi-symbol analysis is intentionally slower than quote refresh.
    refetchInterval: scanEnabled ? SCAN_REFRESH_MS : false,
  });

  const invalidateDesk = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["desk-state"] });
    void queryClient.invalidateQueries({ queryKey: ["desk-instruments"] });
    void queryClient.invalidateQueries({ queryKey: ["desk-analysis"] });
    void queryClient.invalidateQueries({ queryKey: ["desk-scan"] });
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
    mutationFn: () => deskApi.arm(selectedSymbol, mode),
    onSuccess: () => {
      setArmError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setArmError(error.message),
  });
  const flatten = useMutation({
    mutationFn: () => deskApi.flatten("Manual desk flatten"),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const closePosition = useMutation({
    mutationFn: (ticket: number) => deskApi.closePosition(ticket),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const cancelPlan = useMutation({
    mutationFn: (id: string) => deskApi.cancelPlan(id),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const resumeSymbol = useMutation({
    mutationFn: (symbol: string) => deskApi.resumeSymbol(symbol),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });

  const changeWatchlist = (symbol: string, add: boolean) => {
    const next = add
      ? [...new Set([...selectedSymbols, symbol])]
      : selectedSymbols.filter((entry) => entry !== symbol);
    setSelectedSymbols(next);
    if (add) setSelectedSymbol(symbol);
    else if (selectedSymbol === symbol) setSelectedSymbol(next[0] ?? "");
    settings.mutate({ watchlist: next });
  };

  const account = state.data?.account ?? null;
  const terminal = state.data?.terminal ?? null;
  const decision = analysis.data?.decision ?? null;
  const emptyMessage = !state.data
    ? state.error instanceof Error ? state.error.message : "Loading live desk status…"
    : !feedReady
      ? state.data.feedError ?? "Waiting for a live MT5 connection."
      : !selectedSymbol
        ? "Choose a broker instrument and add it to the live watchlist to analyse it."
        : analysis.isLoading
          ? `Loading live broker history for ${selectedSymbol}…`
          : analysis.error instanceof Error
            ? analysis.error.message
            : "Waiting for live analysis.";

  const statusLabel = !liveLinked
    ? "MT5 NOT LINKED"
    : feedReady
      ? "MT5 · LIVE"
      : terminal?.stale
        ? "MT5 · STALE"
        : "MT5 · CONNECTING";
  const statusClass = !liveLinked
    ? "border-zinc-700 bg-zinc-900 text-zinc-400"
    : feedReady
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : terminal?.stale
        ? "border-red-500/40 bg-red-500/10 text-red-300"
        : "border-amber-500/40 bg-amber-500/10 text-amber-300";

  return (
    <div className="min-h-full bg-[#070a10] px-3 py-4 text-zinc-200 sm:px-4 lg:px-5">
      <div className="mx-auto w-full max-w-[1800px] space-y-3">
        <header className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <Activity className="h-5 w-5 shrink-0 text-cyan-400" />
              <div className="min-w-0">
                <h1 className="text-sm font-bold tracking-wide text-zinc-100">MULTI-ASSET TERMINAL</h1>
                <p className="text-[10px] text-zinc-500">Broker-discovered markets · live MT5 quotes only</p>
              </div>
            </div>
            <span className={`rounded-full border px-2.5 py-1 text-[9px] font-semibold tracking-wider ${statusClass}`} data-testid="data-source">
              {statusLabel}
            </span>
            {account && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-400">
                <span>Equity <b className="text-zinc-100">{formatMoney(account.equity, account.currency)}</b></span>
                <span>Balance <b className="text-zinc-300">{formatMoney(account.balance, account.currency)}</b></span>
                {account.isLive && <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-sans text-[9px] uppercase text-red-300">Real account</span>}
              </div>
            )}
            <div className="flex-1" />
            <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-lg border border-zinc-800 p-1">
              {TRADE_MODES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  title={item.blurb}
                  onClick={() => settings.mutate({ mode: item.id })}
                  disabled={settings.isPending}
                  className={`shrink-0 rounded-md px-2.5 py-1.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${mode === item.id ? "bg-cyan-500/15 text-cyan-200" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"}`}
                  data-testid={`mode-${item.id}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => settings.mutate({ autoTrade: !state.data?.autoTrade })}
              disabled={settings.isPending || (!state.data?.autoTrade && (!feedReady || !watchlist.length || !newsReady))}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-2 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${state.data?.autoTrade ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-900"}`}
              data-testid="auto-trade-toggle"
              title="Execution requires a healthy live MT5 feed, selected markets, and a fresh complete MT5 economic calendar."
            >
              <Zap className="h-3.5 w-3.5" />
              Execution {state.data?.autoTrade ? "ON" : "OFF"}
            </button>
            <button
              type="button"
              onClick={() => setBridgeOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-[10px] text-zinc-200 transition-colors hover:border-cyan-500/40 hover:bg-zinc-900"
              data-testid="open-bridge"
            >
              {liveLinked ? <Link2 className="h-3.5 w-3.5 text-emerald-400" /> : <Unplug className="h-3.5 w-3.5" />}
              {liveLinked ? `MT5 ${terminal?.login ?? ""}` : "Link MT5"}
            </button>
            <button
              type="button"
              onClick={() => flatten.mutate()}
              disabled={!liveLinked || flatten.isPending}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              title="Cancel armed plans and request the EA to close managed positions."
              data-testid="kill-switch"
            >
              <Power className="h-3.5 w-3.5" />
              FLATTEN
            </button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px]">
            <span className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 text-zinc-400">
              Broker catalog <b className="ml-1 text-zinc-200">{instruments.data?.instruments.length ?? state.data?.catalogCount ?? 0}</b>
            </span>
            <span className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 text-zinc-400">
              Selected markets <b className="ml-1 text-zinc-200">{watchlist.length}</b>
            </span>
            <span className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 text-zinc-400">
              Open positions <b className="ml-1 text-zinc-200">{state.data?.positions.length ?? "—"}</b>
            </span>
            <span className="rounded-md border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 text-zinc-400">
              Armed plans <b className="ml-1 text-zinc-200">{state.data?.plans.length ?? "—"}</b>
            </span>
            {terminal && <span className="min-w-0 truncate text-zinc-600">{terminal.server} · last heartbeat {terminal.stale ? "stale" : "current"}</span>}
            <button type="button" onClick={() => { void state.refetch(); void instruments.refetch(); void scan.refetch(); }} className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" aria-label="Refresh desk">
              <RefreshCw className={`h-3.5 w-3.5 ${state.isFetching || instruments.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          {state.data?.risk.state.haltedUntilNextSession && (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">
              <ShieldAlert className="h-4 w-4 shrink-0" />{state.data.risk.state.haltReason}
            </div>
          )}
          {!feedReady && (
            <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
              {state.data?.feedError ?? (state.isLoading ? "Connecting to the desk service…" : "Desk status is not available. Check the API connection.")}
            </div>
          )}
          {(actionError || state.error instanceof Error) && (
            <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
              {actionError ?? (state.error as Error).message}
              {actionError && <button type="button" onClick={() => setActionError(null)} className="ml-2 underline">Dismiss</button>}
            </div>
          )}
        </header>

        <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 2xl:grid-cols-12">
          <Pane
            title="Broker market universe"
            right={<span className="text-[10px] text-zinc-600">{watchlist.length} selected</span>}
            className="md:col-span-2 2xl:col-span-5"
          >
            <MarketUniversePane
              instruments={instruments.data?.instruments ?? []}
              selectedClass={selectedClass}
              onClassChange={setSelectedClass}
              search={marketSearch}
              onSearch={setMarketSearch}
              onToggle={changeWatchlist}
              watchlistCount={watchlist.length}
              busy={settings.isPending}
            />
          </Pane>

          <Pane
            title="Live watchlist"
            right={<span className="text-[10px] text-zinc-600">MT5 quotes · selected symbols only</span>}
            className="md:col-span-2 2xl:col-span-7"
          >
            <LiveWatchlistPane instruments={watchedInstruments} selected={selectedSymbol} onSelect={setSelectedSymbol} />
          </Pane>

          <Pane
            title="Multi-market scanner"
            right={
              <button
                type="button"
                onClick={() => void scan.refetch()}
                disabled={!scanEnabled || scan.isFetching}
                aria-label="Rescan selected markets"
                className="rounded p-1 text-zinc-600 transition-colors hover:text-zinc-200 disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${scan.isFetching ? "animate-spin" : ""}`} />
              </button>
            }
            className="md:col-span-2 2xl:col-span-7"
          >
            <ScannerPane
              rows={scan.data?.results ?? []}
              waitingSymbols={scan.data?.waitingSymbols ?? []}
              unavailableReason={scan.data?.unavailableReason ?? (!feedReady ? state.data?.feedError ?? undefined : undefined)}
              onSelect={setSelectedSymbol}
              selected={selectedSymbol}
            />
          </Pane>

          <Pane
            title={selectedSymbol ? `Live analysis · ${selectedSymbol}` : "Live analysis"}
            right={<span className="text-[9px] uppercase tracking-wider text-zinc-600">{mode}</span>}
            className="md:col-span-2 2xl:col-span-5"
          >
            <AgentPane
              decision={decision}
              horizonMinutes={analysis.data?.horizonMinutes ?? 0}
              onArm={() => arm.mutate()}
              arming={arm.isPending}
              armError={armError}
              executionEnabled={feedReady && state.data?.autoTrade === true && newsReady}
              emptyMessage={emptyMessage}
            />
          </Pane>

          <Pane
            title="Open positions"
            right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.positions.length ?? 0}</span>}
            className="md:col-span-2 2xl:col-span-8"
          >
            <PositionsPane
              positions={state.data?.positions ?? []}
              currency={account?.currency ?? ""}
              onClose={(ticket) => closePosition.mutate(ticket)}
            />
          </Pane>

          <Pane
            title="Armed plans"
            right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.plans.length ?? 0}</span>}
            className="md:col-span-2 2xl:col-span-4"
          >
            <PlansPane plans={state.data?.plans ?? []} onCancel={(id) => cancelPlan.mutate(id)} />
          </Pane>

          <Pane title="Account & risk" className="md:col-span-1 2xl:col-span-4">
            {state.data ? <RiskPane state={state.data} onResume={(symbol) => resumeSymbol.mutate(symbol)} /> : <p className="p-4 text-xs text-zinc-500">Waiting for desk status…</p>}
          </Pane>

          <Pane
            title="High-impact news"
            right={<span className="text-[9px] uppercase tracking-wider text-zinc-600">MT5 calendar</span>}
            className="md:col-span-1 2xl:col-span-4"
          >
            {state.data
              ? <HighImpactNewsPane news={state.data.news} />
              : <p className="p-4 text-xs text-zinc-500">Waiting for MT5 calendar status…</p>}
          </Pane>

          <Pane title="Desk activity" className="md:col-span-2 2xl:col-span-4">
            <JournalPane entries={state.data?.journal ?? []} />
          </Pane>
        </div>
      </div>

      <BridgeDialog
        open={bridgeOpen}
        onClose={() => setBridgeOpen(false)}
        linked={liveLinked}
        onChanged={invalidateDesk}
      />
    </div>
  );
}
