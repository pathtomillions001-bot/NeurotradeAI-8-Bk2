/**
 * Multi-Asset Desk — the terminal.
 *
 * A dense, multi-pane trading screen for forex, metals, indices, commodities,
 * crypto and futures CFDs, executed on the user's own MetaTrader 5 account
 * through the EA bridge.
 *
 * Design rules:
 *  • Every number is traceable. The agent shows its reasoning, the sizing
 *    engine shows its arithmetic, and a refusal shows the gate that failed.
 *  • The data source is always on screen. A trading UI that cannot tell you
 *    whether its prices are live is worse than no UI.
 *  • The kill switch is never more than one click away.
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
  Zap,
} from "lucide-react";
import { CandleChart } from "@/components/terminal/candle-chart";
import { TradingViewPanel } from "@/components/terminal/tradingview-panel";
import {
  AgentPane,
  JournalPane,
  Pane,
  PositionsPane,
  RiskPane,
  ScannerPane,
  WatchlistPane,
} from "@/components/terminal/panes";
import { BridgeDialog } from "@/components/terminal/bridge-dialog";
import {
  TIMEFRAMES,
  TRADE_MODES,
  deskApi,
  formatMoney,
  type Timeframe,
  type TradeMode,
} from "@/lib/desk";

const REFRESH_MS = 4000;

export default function Terminal() {
  const queryClient = useQueryClient();
  const [symbol, setSymbol] = useState("EURUSD");
  const [timeframe, setTimeframe] = useState<Timeframe>("M15");
  const [chartTab, setChartTab] = useState<"desk" | "tradingview">("desk");
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);

  // ── Data ───────────────────────────────────────────────────────────────────

  const state = useQuery({
    queryKey: ["desk-state"],
    queryFn: deskApi.state,
    refetchInterval: REFRESH_MS,
  });

  const mode: TradeMode = state.data?.mode ?? "intraday";

  const instruments = useQuery({
    queryKey: ["desk-instruments"],
    queryFn: deskApi.instruments,
    refetchInterval: REFRESH_MS,
  });

  const candles = useQuery({
    queryKey: ["desk-candles", symbol, timeframe],
    queryFn: () => deskApi.candles(symbol, timeframe),
    refetchInterval: REFRESH_MS,
  });

  const analysis = useQuery({
    queryKey: ["desk-analysis", symbol, mode],
    queryFn: () => deskApi.analysis(symbol, mode),
    refetchInterval: REFRESH_MS * 2,
  });

  const scan = useQuery({
    queryKey: ["desk-scan", mode],
    queryFn: () => deskApi.scan(mode),
    // The scan runs the full agent over every watchlist symbol, so it is the
    // expensive call: refresh it more slowly than the quote board.
    refetchInterval: REFRESH_MS * 3,
  });

  // Clear a stale arming error whenever the user looks at something else.
  useEffect(() => setArmError(null), [symbol, mode]);

  const invalidateDesk = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["desk-state"] });
    queryClient.invalidateQueries({ queryKey: ["desk-analysis"] });
    queryClient.invalidateQueries({ queryKey: ["desk-scan"] });
  }, [queryClient]);

  // ── Mutations ──────────────────────────────────────────────────────────────

  const arm = useMutation({
    mutationFn: () => deskApi.arm(symbol, mode),
    onSuccess: () => {
      setArmError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setArmError(error.message),
  });

  const settings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => deskApi.settings(patch),
    onSuccess: invalidateDesk,
  });

  const flatten = useMutation({
    mutationFn: () => deskApi.flatten("Manual kill switch"),
    onSuccess: invalidateDesk,
  });

  const closePosition = useMutation({
    mutationFn: (ticket: number) => deskApi.closePosition(ticket),
    onSuccess: invalidateDesk,
  });

  const resumeSymbol = useMutation({
    mutationFn: (s: string) => deskApi.resumeSymbol(s),
    onSuccess: invalidateDesk,
  });

  const cancelPlan = useMutation({
    mutationFn: (id: string) => deskApi.cancelPlan(id),
    onSuccess: invalidateDesk,
  });

  // ── Derived ────────────────────────────────────────────────────────────────

  const decision = analysis.data?.decision ?? null;
  const digits = candles.data?.spec?.digits ?? 5;

  /** Plan levels drawn on the chart: trigger, stop, target, invalidation. */
  const levels = useMemo(() => {
    const plan = decision?.plan;
    if (!plan) return [];
    return [
      { price: plan.trigger, label: "TRG", color: "#38bdf8" },
      { price: plan.sl, label: "SL", color: "#ef4444" },
      { price: plan.tp[0], label: "TP", color: "#10b981" },
      { price: plan.invalidate, label: "INV", color: "#71717a" },
    ];
  }, [decision]);

  const live = state.data?.source === "mt5";
  const terminalStale = state.data?.terminal?.stale ?? false;
  const account = state.data?.account;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] min-h-0 gap-1.5 p-1.5 bg-zinc-950 text-zinc-200">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-md border border-zinc-800 bg-zinc-950/80 shrink-0">
        <div className="flex items-center gap-1.5">
          <Activity className="w-4 h-4 text-emerald-400" />
          <h1 className="text-[12px] font-semibold tracking-wide">MULTI-ASSET DESK</h1>
        </div>

        {/* Data source — never hidden */}
        <span
          className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider border ${
            live && !terminalStale
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : live && terminalStale
                ? "border-red-500/40 bg-red-500/10 text-red-300"
                : "border-amber-500/40 bg-amber-500/10 text-amber-300"
          }`}
          data-testid="data-source"
          title={
            live
              ? "Prices and execution come from your MetaTrader 5 terminal"
              : "No terminal linked — the desk is running on a deterministic replay feed"
          }
        >
          {live ? (terminalStale ? "MT5 · STALE" : "MT5 · LIVE") : "REPLAY FEED"}
        </span>

        {account && (
          <div className="flex items-center gap-2.5 font-mono text-[11px] text-zinc-400">
            <span>
              Eq <span className="text-zinc-100">{formatMoney(account.equity, account.currency)}</span>
            </span>
            <span className="text-zinc-700">|</span>
            <span>
              Bal <span className="text-zinc-300">{formatMoney(account.balance, account.currency)}</span>
            </span>
            {account.isLive && (
              <span className="px-1 rounded bg-red-500/15 text-red-300 text-[9px] uppercase tracking-wider">
                Real money
              </span>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Mode */}
        <div className="flex rounded border border-zinc-800 overflow-hidden">
          {TRADE_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.blurb}
              onClick={() => settings.mutate({ mode: m.id })}
              className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                mode === m.id ? "bg-emerald-600 text-white" : "text-zinc-400 hover:bg-zinc-900"
              }`}
              data-testid={`mode-${m.id}`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Auto-trade */}
        <button
          type="button"
          onClick={() => settings.mutate({ autoTrade: !state.data?.autoTrade })}
          className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-medium transition-colors ${
            state.data?.autoTrade
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"
          }`}
          data-testid="auto-trade-toggle"
        >
          <Zap className="w-3 h-3" />
          Auto {state.data?.autoTrade ? "ON" : "OFF"}
        </button>

        {/* Bridge */}
        <button
          type="button"
          onClick={() => setBridgeOpen(true)}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-900 transition-colors"
          data-testid="open-bridge"
        >
          {live ? <Link2 className="w-3 h-3 text-emerald-400" /> : <Unplug className="w-3 h-3" />}
          {live ? `MT5 ${state.data?.terminal?.login ?? ""}` : "Link MT5"}
        </button>

        {/* Kill switch */}
        <button
          type="button"
          onClick={() => flatten.mutate()}
          disabled={flatten.isPending}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-red-500/50 bg-red-500/10 text-[10px] font-semibold text-red-300 hover:bg-red-500/20 transition-colors"
          title="Cancel every armed plan, close every position and disable auto-trade"
          data-testid="kill-switch"
        >
          <Power className="w-3 h-3" />
          FLATTEN
        </button>
      </header>

      {/* ── Halt banner ─────────────────────────────────────────────────── */}
      {state.data?.risk.state.haltedUntilNextSession && (
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-[11px] shrink-0">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          {state.data.risk.state.haltReason}
        </div>
      )}

      {/* ── Main grid ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 grid grid-cols-12 grid-rows-2 gap-1.5">
        {/* Left column */}
        <div className="col-span-12 lg:col-span-2 row-span-2 grid grid-rows-2 gap-1.5 min-h-0">
          <Pane
            title="Watchlist"
            right={
              <span className="text-[9px] font-mono text-zinc-600">
                {instruments.data?.instruments.length ?? 0}
              </span>
            }
          >
            <WatchlistPane
              instruments={instruments.data?.instruments ?? []}
              selected={symbol}
              onSelect={setSymbol}
            />
          </Pane>

          <Pane
            title="Scanner"
            right={
              <button
                type="button"
                onClick={() => scan.refetch()}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
                aria-label="Rescan"
              >
                <RefreshCw className={`w-3 h-3 ${scan.isFetching ? "animate-spin" : ""}`} />
              </button>
            }
          >
            <ScannerPane rows={scan.data?.results ?? []} onSelect={setSymbol} selected={symbol} />
          </Pane>
        </div>

        {/* Centre column */}
        <div className="col-span-12 lg:col-span-7 row-span-2 grid grid-rows-[1.35fr_1fr] gap-1.5 min-h-0">
          <Pane
            title={`${symbol} · ${timeframe}`}
            right={
              <div className="flex items-center gap-1.5">
                <div className="flex rounded border border-zinc-800 overflow-hidden">
                  {(["desk", "tradingview"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setChartTab(tab)}
                      className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${
                        chartTab === tab ? "bg-zinc-800 text-zinc-100" : "text-zinc-600 hover:text-zinc-400"
                      }`}
                    >
                      {tab === "desk" ? "Desk" : "TV"}
                    </button>
                  ))}
                </div>
                <div className="flex gap-0.5">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf}
                      type="button"
                      onClick={() => setTimeframe(tf)}
                      className={`px-1 py-0.5 rounded text-[9px] font-mono transition-colors ${
                        timeframe === tf
                          ? "bg-emerald-600 text-white"
                          : "text-zinc-500 hover:text-zinc-300"
                      }`}
                      data-testid={`tf-${tf}`}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            <div className="p-1">
              {chartTab === "desk" ? (
                <CandleChart bars={candles.data?.bars ?? []} digits={digits} levels={levels} height={320} />
              ) : (
                <TradingViewPanel symbol={symbol} timeframe={timeframe} height={320} />
              )}
            </div>
          </Pane>

          <div className="grid grid-cols-2 gap-1.5 min-h-0">
            <Pane
              title="Positions"
              right={
                <span className="text-[9px] font-mono text-zinc-600">
                  {state.data?.positions.length ?? 0} open
                </span>
              }
            >
              <PositionsPane
                positions={state.data?.positions ?? []}
                currency={account?.currency ?? "USD"}
                onClose={(ticket) => closePosition.mutate(ticket)}
              />
            </Pane>

            <Pane
              title="Armed plans"
              right={
                <span className="text-[9px] font-mono text-zinc-600">
                  {state.data?.plans.length ?? 0}
                </span>
              }
            >
              {(state.data?.plans.length ?? 0) === 0 ? (
                <p className="p-3 text-[11px] text-zinc-500">
                  No plans armed. The agent arms a plan only when every gate passes.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-900">
                  {state.data?.plans.map((plan) => (
                    <li key={plan.id} className="px-2 py-1.5 text-[10px] font-mono">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={plan.side === "buy" ? "text-emerald-400" : "text-red-400"}
                        >
                          {plan.side.toUpperCase()}
                        </span>
                        <span className="text-zinc-200">{plan.symbol}</span>
                        <span className="text-zinc-500">{plan.lots} lots</span>
                        <button
                          type="button"
                          onClick={() => cancelPlan.mutate(plan.id)}
                          className="ml-auto text-zinc-600 hover:text-red-400 transition-colors"
                        >
                          cancel
                        </button>
                      </div>
                      <div className="text-zinc-600 mt-0.5">
                        trg {plan.trigger} · sl {plan.sl} · tp {plan.tp[0]} · expires in{" "}
                        {Math.max(0, Math.round((plan.expiresAt - Date.now()) / 1000))}s
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Pane>
          </div>
        </div>

        {/* Right column */}
        <div className="col-span-12 lg:col-span-3 row-span-2 grid grid-rows-[1.4fr_1fr_1fr] gap-1.5 min-h-0">
          <Pane
            title={`Agent · ${symbol}`}
            right={
              <span className="text-[9px] uppercase tracking-wider text-zinc-600">{mode}</span>
            }
          >
            <AgentPane
              decision={decision}
              horizonMinutes={analysis.data?.horizonMinutes ?? 0}
              onArm={() => arm.mutate()}
              arming={arm.isPending}
              armError={armError}
            />
          </Pane>

          <Pane title="Risk">
            {state.data ? (
              <RiskPane state={state.data} onResume={(s) => resumeSymbol.mutate(s)} />
            ) : (
              <p className="p-3 text-[11px] text-zinc-500">Loading…</p>
            )}
          </Pane>

          <Pane title="Journal">
            <JournalPane entries={state.data?.journal ?? []} />
          </Pane>
        </div>
      </div>

      <BridgeDialog
        open={bridgeOpen}
        onClose={() => setBridgeOpen(false)}
        linked={live}
        onChanged={invalidateDesk}
      />
    </div>
  );
}
