/**
 * Multi-Asset Desk.
 *
 * A live-terminal operations workspace, not a chart dashboard. The Desk only
 * renders broker data supplied by a paired MT5 EA; before pairing it provides
 * a clear connection workflow instead of demo balances, replay prices or mock
 * signals. The responsive layout stacks intentionally on small screens and
 * uses independent columns on desktop, so plans, positions and market controls
 * cannot overlap each other.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
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
  PositionsPane,
  RiskPane,
  ScannerPane,
  WatchlistPane,
} from "@/components/terminal/panes";
import { BridgeDialog } from "@/components/terminal/bridge-dialog";
import {
  deskApi,
  formatMoney,
  type Instrument,
  type TradeMode,
} from "@/lib/desk";

const REFRESH_MS = 4_000;

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

  const markets = useQuery({
    queryKey: ["desk-markets"],
    queryFn: deskApi.markets,
    enabled: Boolean(terminal),
    refetchInterval: 12_000,
  });
  const instruments = useQuery({
    queryKey: ["desk-instruments"],
    queryFn: deskApi.instruments,
    enabled: Boolean(terminal),
    refetchInterval: REFRESH_MS,
  });
  const analysis = useQuery({
    queryKey: ["desk-analysis", symbol, mode],
    queryFn: () => deskApi.analysis(symbol, mode),
    enabled: terminalLive && Boolean(symbol),
    refetchInterval: REFRESH_MS * 2,
  });
  const scan = useQuery({
    queryKey: ["desk-scan", mode, selectedMarkets],
    queryFn: () => deskApi.scan(mode),
    enabled: terminalLive && selectedMarkets.length > 0,
    refetchInterval: REFRESH_MS * 4,
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

  const selectedInstrument = useMemo<Instrument | null>(
    () => instruments.data?.instruments.find((instrument) => instrument.symbol === symbol) ?? null,
    [instruments.data?.instruments, symbol],
  );

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
    <div className="min-h-full bg-zinc-950 p-3 text-zinc-200 sm:p-4 lg:p-5">
      <div className="mx-auto max-w-[1800px] space-y-3">
        <header className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2.5 shadow-sm sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-emerald-400" />
            <div className="min-w-0">
              <h1 className="truncate text-[13px] font-semibold tracking-wide text-zinc-100">MULTI-ASSET DESK</h1>
              <p className="hidden text-[10px] text-zinc-600 sm:block">Live MT5 data, broker market universe and guarded execution</p>
            </div>
          </div>
          <span className={`rounded border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${sourceClass}`} data-testid="data-source">
            {sourceLabel}
          </span>

          {account && (
            <div className="order-3 flex w-full items-center gap-x-3 gap-y-1 overflow-x-auto border-t border-zinc-900 pt-2 font-mono text-[11px] text-zinc-400 sm:order-none sm:ml-1 sm:w-auto sm:border-0 sm:pt-0">
              <span>Eq <strong className="font-medium text-zinc-100">{formatMoney(account.equity, account.currency)}</strong></span>
              <span>Bal <strong className="font-medium text-zinc-200">{formatMoney(account.balance, account.currency)}</strong></span>
              <span>Free <strong className="font-medium text-zinc-200">{formatMoney(account.freeMargin, account.currency)}</strong></span>
              {account.isLive && <span className="rounded bg-red-500/15 px-1 py-0.5 text-[9px] uppercase tracking-wider text-red-300">Real money</span>}
            </div>
          )}

          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <div className="flex overflow-hidden rounded border border-zinc-800">
              {["scalp", "intraday", "swing"].map((entry) => (
                <button
                  key={entry}
                  type="button"
                  disabled={!terminalLive || settings.isPending}
                  onClick={() => settings.mutate({ mode: entry })}
                  className={`px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${mode === entry ? "bg-emerald-600 text-white" : "text-zinc-400 hover:bg-zinc-900"}`}
                >
                  {entry === "intraday" ? "Day" : entry[0]?.toUpperCase() + entry.slice(1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={!terminalLive || settings.isPending}
              onClick={() => settings.mutate({ autoTrade: !state.data?.autoTrade })}
              className={`flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${state.data?.autoTrade ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"}`}
              data-testid="auto-trade-toggle"
            >
              <Zap className="h-3 w-3" />Auto {state.data?.autoTrade ? "ON" : "OFF"}
            </button>
            <button type="button" onClick={() => setBridgeOpen(true)} className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:bg-zinc-900" data-testid="open-bridge">
              {terminal ? <Link2 className="h-3 w-3 text-emerald-400" /> : <Unplug className="h-3 w-3" />}
              {terminal ? `MT5 ${terminal.login}` : "Link MT5"}
            </button>
            <button
              type="button"
              disabled={!terminal || flatten.isPending}
              onClick={() => flatten.mutate()}
              className="flex items-center gap-1 rounded border border-red-500/50 bg-red-500/10 px-2 py-1 text-[10px] font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              title="Cancel every armed plan and request all MT5 positions be closed"
              data-testid="kill-switch"
            >
              <Power className="h-3 w-3" />FLATTEN
            </button>
          </div>
        </header>

        {state.data?.risk.state.haltedUntilNextSession && (
          <div className="flex gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-300"><ShieldAlert className="mt-px h-4 w-4 shrink-0" />{state.data.risk.state.haltReason}</div>
        )}
        {terminal?.stale && (
          <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"><WifiOff className="mt-px h-4 w-4 shrink-0" /><span>The MT5 terminal last synced {Math.max(0, Math.round((Date.now() - terminal.lastSyncAt) / 1000))}s ago. Quotes and agent entries are paused until it resumes; any displayed account snapshot is explicitly the last terminal update.</span></div>
        )}
        {actionError && <div className="flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"><ShieldAlert className="mt-px h-4 w-4 shrink-0" /><span>{actionError}</span></div>}

        {!terminal ? (
          <EmptyDesk onConnect={() => setBridgeOpen(true)} />
        ) : (
          <div className="grid items-start gap-3 lg:grid-cols-12">
            <div className="space-y-3 lg:col-span-4 xl:col-span-3">
              <Pane title="Broker market universe" right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.market.catalogCount ?? 0}</span>}>
                <MarketUniversePane
                  markets={markets.data?.markets ?? []}
                  selected={selectedMarkets}
                  updating={settings.isPending}
                  onToggle={toggleMarket}
                  onFocus={setSymbol}
                />
              </Pane>
              <Pane title="Selected live coverage" right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.market.liveSymbols ?? 0}/{state.data?.market.selectedCount ?? 0} fresh</span>}>
                <WatchlistPane instruments={instruments.data?.instruments ?? []} selected={symbol} onSelect={setSymbol} />
              </Pane>
            </div>

            <div className="space-y-3 lg:col-span-5 xl:col-span-5">
              <Pane title="Live market pulse" right={selectedInstrument ? <span className="font-mono text-[10px] text-zinc-600">broker feed</span> : undefined}>
                <LiveQuotePane instrument={selectedInstrument} />
              </Pane>
              <Pane title={symbol ? `Agent assessment · ${symbol}` : "Agent assessment"} right={<span className="text-[9px] uppercase tracking-wider text-zinc-600">{mode}</span>}>
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
                right={<button type="button" disabled={!terminalLive} onClick={() => scan.refetch()} className="text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-40" aria-label="Rescan selected markets"><RefreshCw className={`h-3.5 w-3.5 ${scan.isFetching ? "animate-spin" : ""}`} /></button>}
              >
                {scan.data?.coverage && <p className="border-b border-zinc-900 px-3 py-2 text-[10px] text-zinc-600">{scan.data.coverage.live} fresh · {scan.data.coverage.warming} warming · {scan.data.coverage.stale} stale / {scan.data.coverage.selected} selected</p>}
                <ScannerPane rows={scan.data?.results ?? []} onSelect={setSymbol} selected={symbol} />
              </Pane>
            </div>

            <div className="space-y-3 lg:col-span-3 xl:col-span-4">
              <Pane title="Open positions" right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.positions.length ?? 0} open</span>}>
                <PositionsPane positions={state.data?.positions ?? []} currency={account?.currency ?? "USD"} onClose={(ticket) => closePosition.mutate(ticket)} />
              </Pane>
              <Pane title="Armed plans" right={<span className="font-mono text-[10px] text-zinc-600">{state.data?.plans.length ?? 0}</span>}>
                <ArmedPlansPane plans={state.data?.plans ?? []} onCancel={(id) => cancelPlan.mutate(id)} />
              </Pane>
              <Pane title="Risk controls"><RiskPane state={state.data!} onResume={(value) => resumeSymbol.mutate(value)} /></Pane>
              <Pane title="Red-folder calendar" right={<span className={`rounded border px-1 py-px text-[8px] uppercase ${state.data?.news.available ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/40 text-amber-300"}`}>{state.data?.news.available ? "MT5 calendar" : "paused"}</span>}><NewsPane feed={state.data?.news ?? { available: false, checkedAt: 0, events: [] }} /></Pane>
            </div>

            <div className="lg:col-span-12">
              <Pane title="Decision journal"><JournalPane entries={state.data?.journal ?? []} /></Pane>
            </div>
          </div>
        )}
      </div>
      <BridgeDialog open={bridgeOpen} onClose={() => setBridgeOpen(false)} linked={Boolean(terminal)} onChanged={invalidateDesk} />
    </div>
  );
}

function EmptyDesk({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="mx-auto max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-950/80 p-5 shadow-sm sm:p-8">
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10"><Link2 className="h-6 w-6 text-emerald-400" /></div>
        <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold text-zinc-100">Connect MT5 to start the Desk</h2><p className="mt-1 max-w-xl text-sm leading-relaxed text-zinc-400">No balance, price, position, scanner result or agent decision is shown until your MetaTrader 5 terminal provides it. The Desk only works with your broker’s live terminal data.</p></div>
        <button type="button" onClick={onConnect} className="w-full shrink-0 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 sm:w-auto">Set up MT5 bridge</button>
      </div>
      <div className="mt-6 grid gap-3 border-t border-zinc-800 pt-5 sm:grid-cols-3">
        <InfoStep number="1" title="Download & attach">Attach the resilient Neurotrade MT5 EA to any chart. It stays attached and retries pairing instead of failing initialization.</InfoStep>
        <InfoStep number="2" title="Pair securely">Add this platform origin to MT5’s WebRequest allowlist and paste the one-time pairing code. No MT5 password leaves your terminal.</InfoStep>
        <InfoStep number="3" title="Select broker markets">The EA discovers the complete broker catalogue. Choose any number of forex, crypto, indices, stocks, metals, futures or other supported symbols.</InfoStep>
      </div>
    </section>
  );
}

function InfoStep({ number, title, children }: { number: string; title: string; children: React.ReactNode }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-emerald-300">{number}</span><h3 className="mt-2 text-xs font-semibold text-zinc-200">{title}</h3><p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{children}</p></div>;
}
