/** Responsive, live-data-only panels used by the Multi-Asset Desk. */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  CalendarDays,
  Clock3,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Minus,
  Search,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  formatMoney,
  gradeColor,
  regimeColor,
  relativeTime,
  type AgentDecision,
  type AssetClass,
  type DeskNewsState,
  type DeskStateResponse,
  type Instrument,
  type JournalEntry,
  type Position,
  type ScanRow,
} from "@/lib/desk";

export function Pane({
  title,
  right,
  children,
  className = "",
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col rounded-xl border border-zinc-800 bg-zinc-950/70 ${className}`}>
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="min-w-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          {title}
        </h2>
        {right}
      </header>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "up" || direction === "buy") {
    return <ArrowUpRight className="h-4 w-4 shrink-0 text-emerald-400" />;
  }
  if (direction === "down" || direction === "sell") {
    return <ArrowDownRight className="h-4 w-4 shrink-0 text-red-400" />;
  }
  return <Minus className="h-4 w-4 shrink-0 text-zinc-600" />;
}

const ASSET_CLASSES: { id: AssetClass | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "forex", label: "Forex" },
  { id: "metals", label: "Metals" },
  { id: "indices", label: "Indices" },
  { id: "commodities", label: "Commodities" },
  { id: "crypto", label: "Crypto" },
  { id: "futures", label: "Futures" },
  { id: "stocks", label: "Stocks" },
  { id: "other", label: "Other" },
];

export function MarketUniversePane({
  instruments,
  selectedClass,
  onClassChange,
  search,
  onSearch,
  onToggle,
  watchlistCount,
  busy = false,
}: {
  instruments: Instrument[];
  selectedClass: AssetClass | "all";
  onClassChange: (value: AssetClass | "all") => void;
  search: string;
  onSearch: (value: string) => void;
  onToggle: (symbol: string, watched: boolean) => void;
  watchlistCount: number;
  busy?: boolean;
}) {
  const query = search.trim().toLowerCase();
  const filtered = instruments.filter((instrument) => {
    const classMatch = selectedClass === "all" || instrument.assetClass === selectedClass;
    const searchMatch = !query || `${instrument.symbol} ${instrument.description ?? ""} ${instrument.path ?? ""}`
      .toLowerCase()
      .includes(query);
    return classMatch && searchMatch;
  });
  const counts = instruments.reduce<Record<string, number>>((result, instrument) => {
    result[instrument.assetClass] = (result[instrument.assetClass] ?? 0) + 1;
    return result;
  }, {});

  return (
    <div className="space-y-3 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search the linked broker's symbols…"
          aria-label="Search broker markets"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2.5 pl-9 pr-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-500/50"
        />
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Asset classes">
        {ASSET_CLASSES.map(({ id, label }) => {
          const count = id === "all" ? instruments.length : counts[id] ?? 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onClassChange(id)}
              aria-pressed={selectedClass === id}
              className={`shrink-0 rounded-full border px-2.5 py-1.5 text-[10px] font-medium transition-colors ${
                selectedClass === id
                  ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-200"
                  : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
              }`}
            >
              {label} <span className="ml-1 text-zinc-500">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-500">
        <span>{filtered.length} of {instruments.length} broker markets</span>
        <span>{watchlistCount} selected</span>
      </div>

      {instruments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-4 py-8 text-center">
          <p className="text-sm font-medium text-zinc-300">No broker catalog received</p>
          <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
            Link a running MT5 terminal. The market list is discovered from that broker; the desk does not invent symbols or prices.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 p-5 text-center text-xs text-zinc-500">No symbols match this filter.</p>
      ) : (
        <ul className="max-h-[440px] divide-y divide-zinc-900 overflow-y-auto rounded-lg border border-zinc-900">
          {filtered.map((instrument) => (
            <li key={instrument.symbol} className="flex min-w-0 items-center gap-3 px-3 py-2.5 hover:bg-zinc-900/60">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs font-semibold text-zinc-100">{instrument.symbol}</p>
                <p className="truncate text-[10px] capitalize text-zinc-600">
                  {instrument.assetClass}{instrument.path ? ` · ${instrument.path}` : ""}
                </p>
              </div>
              <span className={`shrink-0 text-[9px] uppercase tracking-wide ${instrument.dataFresh ? "text-emerald-400" : instrument.subscribed ? "text-amber-400" : "text-zinc-600"}`}>
                {instrument.dataFresh ? "Live" : instrument.subscribed ? "Waiting" : "Catalog"}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onToggle(instrument.symbol, !instrument.watched)}
                className={`min-w-[70px] shrink-0 rounded-md border px-2.5 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-wait disabled:opacity-50 ${
                  instrument.watched
                    ? "border-zinc-700 text-zinc-400 hover:border-red-500/40 hover:text-red-300"
                    : "border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
                }`}
              >
                {instrument.watched ? "Remove" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[10px] leading-relaxed text-zinc-600">
        The available universe is determined by your broker. Add any number of its symbols to the live watchlist; only selected instruments stream full history for analysis.
      </p>
    </div>
  );
}

export function LiveWatchlistPane({
  instruments,
  selected,
  onSelect,
}: {
  instruments: Instrument[];
  selected: string;
  onSelect: (symbol: string) => void;
}) {
  if (instruments.length === 0) {
    return <p className="p-5 text-center text-xs text-zinc-500">Choose instruments from the broker catalog to subscribe to real-time quotes.</p>;
  }
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[580px] text-left font-mono text-[11px]">
          <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
            <tr className="border-b border-zinc-800">
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 text-right font-medium">Bid</th>
              <th className="px-3 py-2 text-right font-medium">Ask</th>
              <th className="px-3 py-2 text-right font-medium">Spread</th>
              <th className="px-3 py-2 text-right font-medium">5m</th>
              <th className="px-3 py-2 text-right font-medium">Feed</th>
            </tr>
          </thead>
          <tbody>
            {instruments.map((instrument) => (
              <tr
                key={instrument.symbol}
                onClick={() => onSelect(instrument.symbol)}
                className={`cursor-pointer border-b border-zinc-900 transition-colors ${instrument.symbol === selected ? "bg-cyan-500/10" : "hover:bg-zinc-900/70"}`}
              >
                <td className="px-3 py-2">
                  <span className="font-semibold text-zinc-200">{instrument.symbol}</span>
                  <span className="ml-2 text-[9px] capitalize text-zinc-600">{instrument.assetClass}</span>
                </td>
                <td className="px-3 py-2 text-right text-zinc-300">{price(instrument.bid, instrument.digits)}</td>
                <td className="px-3 py-2 text-right text-zinc-300">{price(instrument.ask, instrument.digits)}</td>
                <td className="px-3 py-2 text-right text-zinc-500">{instrument.spreadPoints ?? "—"}</td>
                <td className={`px-3 py-2 text-right ${instrument.changePct === null ? "text-zinc-600" : instrument.changePct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {instrument.changePct === null ? "—" : `${instrument.changePct >= 0 ? "+" : ""}${instrument.changePct.toFixed(2)}%`}
                </td>
                <td className="px-3 py-2 text-right"><FeedStatus instrument={instrument} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-zinc-900 md:hidden">
        {instruments.map((instrument) => (
          <li key={instrument.symbol}>
            <button
              type="button"
              onClick={() => onSelect(instrument.symbol)}
              className={`w-full px-3 py-3 text-left transition-colors ${instrument.symbol === selected ? "bg-cyan-500/10" : "hover:bg-zinc-900/70"}`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-sm font-semibold text-zinc-100">{instrument.symbol}</span>
                <FeedStatus instrument={instrument} />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
                <span>Bid <b className="text-zinc-300">{price(instrument.bid, instrument.digits)}</b></span>
                <span>Ask <b className="text-zinc-300">{price(instrument.ask, instrument.digits)}</b></span>
                <span>Spread <b className="text-zinc-300">{instrument.spreadPoints ?? "—"}</b></span>
                <span>5m <b className={instrument.changePct === null ? "text-zinc-600" : instrument.changePct >= 0 ? "text-emerald-400" : "text-red-400"}>{instrument.changePct === null ? "—" : `${instrument.changePct >= 0 ? "+" : ""}${instrument.changePct.toFixed(2)}%`}</b></span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function price(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function FeedStatus({ instrument }: { instrument: Instrument }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[9px] font-semibold uppercase tracking-wider ${instrument.dataFresh ? "text-emerald-400" : instrument.subscribed ? "text-amber-400" : "text-zinc-600"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${instrument.dataFresh ? "bg-emerald-400" : instrument.subscribed ? "bg-amber-400" : "bg-zinc-700"}`} />
      {instrument.dataFresh ? `Live · ${Math.max(0, Math.floor((instrument.quoteAgeMs ?? 0) / 1000))}s` : instrument.subscribed ? "Waiting for tick" : "Not subscribed"}
    </span>
  );
}

export function ScannerPane({
  rows,
  waitingSymbols = [],
  unavailableReason,
  onSelect,
  selected,
}: {
  rows: ScanRow[];
  waitingSymbols?: string[];
  unavailableReason?: string;
  onSelect: (symbol: string) => void;
  selected: string;
}) {
  if (unavailableReason) {
    return <p className="p-4 text-xs leading-relaxed text-zinc-500">{unavailableReason}</p>;
  }
  if (rows.length === 0) {
    return (
      <div className="p-4 text-xs text-zinc-500">
        {waitingSymbols.length ? (
          <>
            <p className="text-zinc-300">Waiting for live quotes and history on {waitingSymbols.length} selected market{waitingSymbols.length === 1 ? "" : "s"}.</p>
            <p className="mt-1 leading-relaxed">The MT5 EA streams history in batches. No analysis is shown until the broker data is ready.</p>
          </>
        ) : "Select one or more broker markets to start the live scanner."}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-zinc-900">
      {rows.map((row) => (
        <li
          key={row.symbol}
          className={`flex items-center gap-2 px-3 py-2.5 transition-colors ${row.symbol === selected ? "bg-cyan-500/10" : "hover:bg-zinc-900/60"}`}
        >
          <button type="button" onClick={() => onSelect(row.symbol)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <DirectionIcon direction={row.direction} />
            <span className="w-[76px] shrink-0 truncate font-mono text-xs text-zinc-200">{row.symbol}</span>
            <span className={`shrink-0 rounded border px-1 py-0.5 text-[9px] font-semibold ${gradeColor(row.grade)}`}>{row.grade}</span>
            <span className="ml-auto font-mono text-xs text-zinc-300">{row.score.toFixed(0)}</span>
          </button>
          <span className="hidden max-w-[38%] truncate text-[10px] text-zinc-600 sm:block">
            {row.armed && row.expectancyR !== null
              ? `E ${row.expectancyR.toFixed(2)}R · ${((row.winProbability ?? 0) * 100).toFixed(0)}% modeled win`
              : row.rejections[0] ?? "No qualifying setup"}
          </span>
          {row.armed ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" /> : <Ban className="h-4 w-4 shrink-0 text-zinc-700" />}
        </li>
      ))}
      {waitingSymbols.length > 0 && (
        <li className="px-3 py-2 text-[10px] text-amber-400">Live data still loading for {waitingSymbols.length} more selected symbol{waitingSymbols.length === 1 ? "" : "s"}.</li>
      )}
    </ul>
  );
}

export function AgentPane({
  decision,
  horizonMinutes,
  onArm,
  arming,
  armError,
  executionEnabled,
  emptyMessage,
}: {
  decision: AgentDecision | null;
  horizonMinutes: number;
  onArm: () => void;
  arming: boolean;
  armError: string | null;
  executionEnabled: boolean;
  emptyMessage?: string;
}) {
  if (!decision) {
    return <p className="p-4 text-xs leading-relaxed text-zinc-500">{emptyMessage ?? "Select a subscribed market after its live data is ready."}</p>;
  }

  const { confluence, monteCarlo, sizing } = decision;
  return (
    <div className="space-y-4 p-3">
      <div className="flex items-start gap-3">
        <span className={`rounded-md border px-2 py-1 text-sm font-bold ${gradeColor(confluence.grade)}`}>{confluence.grade}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <DirectionIcon direction={confluence.direction} />
            <span className="text-sm font-semibold text-zinc-100">
              {confluence.direction === "none" ? "No directional bias" : confluence.direction === "up" ? "Long bias" : "Short bias"}
            </span>
            <span className="ml-auto font-mono text-xs text-zinc-400">{confluence.score.toFixed(0)}/100</span>
          </div>
          <p className="mt-1 text-[10px] text-zinc-500">Approx. {horizonMinutes} minute horizon{!confluence.higherTimeframeAligned && " · higher timeframe opposed"}</p>
        </div>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full ${confluence.score >= 72 ? "bg-emerald-500" : confluence.score >= 60 ? "bg-amber-500" : "bg-zinc-600"}`} style={{ width: `${Math.min(100, confluence.score)}%` }} />
      </div>

      {monteCarlo && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Modeled win" value={`${(monteCarlo.winProbability * 100).toFixed(0)}%`} />
          <Metric label="Net expectancy" value={`${monteCarlo.expectancyR >= 0 ? "+" : ""}${monteCarlo.expectancyR.toFixed(2)}R`} tone={monteCarlo.expectancyR > 0 ? "good" : "bad"} />
          <Metric label="Reward / risk" value={monteCarlo.rewardRisk.toFixed(1)} />
          <Metric label="Resolve bars" value={monteCarlo.meanBarsToResolve.toFixed(0)} />
        </dl>
      )}

      <div>
        <p className="mb-2 text-[9px] uppercase tracking-wider text-zinc-600">Live-feed timeframe confluence</p>
        <div className="space-y-1.5">
          {confluence.views.map((view) => (
            <div key={view.timeframe} className="flex items-center gap-2 font-mono text-[10px]">
              <span className="w-8 shrink-0 text-zinc-500">{view.timeframe}</span>
              <span className={`w-[78px] shrink-0 truncate ${regimeColor(view.kind)}`}>{view.kind}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div className={`h-full ${view.contribution >= 0 ? "bg-emerald-500/70" : "bg-red-500/70"}`} style={{ width: `${Math.min(100, Math.abs(view.contribution) * 220)}%` }} />
              </div>
              <span className="w-8 text-right text-zinc-500">RSI {view.rsi.toFixed(0)}</span>
              <span className="w-9 text-right text-zinc-600">{(view.persistence * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      {sizing && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Broker-spec position sizing</p>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-lg text-zinc-100">{sizing.lots} lots</span>
            <span className="font-mono text-xs text-zinc-400">Risk {formatMoney(sizing.riskMoney)}</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{sizing.explanation}</p>
        </div>
      )}

      {decision.armed && decision.plan ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500">
            <span>Trigger {decision.plan.trigger}</span><span>Stop {decision.plan.sl}</span><span>Target {decision.plan.tp[0]}</span>
          </div>
          <button
            type="button"
            onClick={onArm}
            disabled={arming || !executionEnabled}
            className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="arm-plan"
          >
            {arming ? "Submitting plan…" : executionEnabled ? `Arm ${decision.plan.side.toUpperCase()} · ${decision.plan.lots} lots` : "Enable execution to arm"}
          </button>
          {armError && <p className="flex gap-1.5 text-[10px] leading-snug text-amber-400"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{armError}</p>}
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300"><XCircle className="h-4 w-4 text-zinc-500" />No trade setup</div>
          <ul className="space-y-1">
            {(decision.rejections.length ? decision.rejections : ["Waiting for every live-data and risk gate to pass."]).map((reason) => (
              <li key={reason} className="flex gap-1.5 text-[10px] leading-snug text-zinc-500"><span className="text-zinc-700">•</span>{reason}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-200";
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 py-2 text-center"><dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt><dd className={`mt-1 font-mono text-sm ${colour}`}>{value}</dd></div>;
}

export function PositionsPane({
  positions,
  currency,
  onClose,
}: {
  positions: Position[];
  currency: string;
  onClose: (ticket: number) => void;
}) {
  if (positions.length === 0) return <p className="p-4 text-xs text-zinc-500">No open positions reported by the linked terminal.</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[600px] font-mono text-[11px]">
          <thead className="text-zinc-500"><tr className="border-b border-zinc-800 text-left"><th className="px-3 py-2">Instrument</th><th className="px-3 py-2">Side</th><th className="px-3 py-2 text-right">Lots</th><th className="px-3 py-2 text-right">Entry</th><th className="px-3 py-2 text-right">SL / TP</th><th className="px-3 py-2 text-right">Net P&L</th><th className="px-3 py-2" /></tr></thead>
          <tbody>{positions.map((position) => <PositionRow key={position.ticket} position={position} currency={currency} onClose={onClose} />)}</tbody>
        </table>
      </div>
      <ul className="divide-y divide-zinc-900 md:hidden">{positions.map((position) => <PositionCard key={position.ticket} position={position} currency={currency} onClose={onClose} />)}</ul>
    </>
  );
}

function PositionRow({ position, currency, onClose }: { position: Position; currency: string; onClose: (ticket: number) => void }) {
  const net = position.profit + position.swap + position.commission;
  return <tr className="border-b border-zinc-900"><td className="px-3 py-2 font-semibold text-zinc-200">{position.symbol}</td><td className={`px-3 py-2 uppercase ${position.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>{position.side}</td><td className="px-3 py-2 text-right text-zinc-300">{position.volume}</td><td className="px-3 py-2 text-right text-zinc-400">{position.openPrice}</td><td className="px-3 py-2 text-right text-zinc-500">{position.sl ?? "—"} / {position.tp ?? "—"}</td><td className={`px-3 py-2 text-right ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatMoney(net, currency)}</td><td className="px-3 py-2 text-right"><CloseButton ticket={position.ticket} onClose={onClose} /></td></tr>;
}

function PositionCard({ position, currency, onClose }: { position: Position; currency: string; onClose: (ticket: number) => void }) {
  const net = position.profit + position.swap + position.commission;
  return <li className="space-y-2 p-3"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2"><DirectionIcon direction={position.side} /><span className="truncate font-mono text-sm font-semibold text-zinc-100">{position.symbol}</span><span className={`text-[10px] uppercase ${position.side === "buy" ? "text-emerald-400" : "text-red-400"}`}>{position.side}</span></div><span className={`font-mono text-sm ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatMoney(net, currency)}</span></div><div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-500"><span>Volume <b className="text-zinc-300">{position.volume} lots</b></span><span>Entry <b className="text-zinc-300">{position.openPrice}</b></span><span>Stop <b className="text-zinc-300">{position.sl ?? "—"}</b></span><span>Target <b className="text-zinc-300">{position.tp ?? "—"}</b></span></div><div className="flex justify-end"><CloseButton ticket={position.ticket} onClose={onClose} /></div></li>;
}

function CloseButton({ ticket, onClose }: { ticket: number; onClose: (ticket: number) => void }) {
  return <button type="button" onClick={() => onClose(ticket)} className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-[10px] text-zinc-400 transition-colors hover:border-red-500/50 hover:text-red-300">Close</button>;
}

export function PlansPane({ plans, onCancel }: { plans: DeskStateResponse["plans"]; onCancel: (id: string) => void }) {
  if (plans.length === 0) return <p className="p-4 text-xs text-zinc-500">No active plans. Plans appear here only after a live analysis passes every gate and is armed.</p>;
  return <ul className="divide-y divide-zinc-900">{plans.map((plan) => <li key={plan.id} className="space-y-2 p-3"><div className="flex items-center gap-2"><DirectionIcon direction={plan.side} /><span className="font-mono text-sm font-semibold text-zinc-100">{plan.symbol}</span><span className="rounded border border-zinc-800 px-1.5 py-0.5 text-[9px] uppercase text-zinc-500">{plan.mode}</span><button type="button" onClick={() => onCancel(plan.id)} className="ml-auto text-[10px] text-zinc-500 hover:text-red-400">Cancel</button></div><div className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-zinc-500 sm:grid-cols-3"><span>Trigger <b className="text-zinc-300">{plan.trigger}</b></span><span>Stop <b className="text-zinc-300">{plan.sl}</b></span><span>Target <b className="text-zinc-300">{plan.tp[0] ?? "—"}</b></span><span>Size <b className="text-zinc-300">{plan.lots} lots</b></span><span>Risk <b className="text-zinc-300">{formatMoney(plan.riskMoney)}</b></span><span>Expires <b className="text-zinc-300">{Math.max(0, Math.round((plan.expiresAt - Date.now()) / 1000))}s</b></span></div></li>)}</ul>;
}

export function RiskPane({ state, onResume }: { state: DeskStateResponse; onResume: (symbol: string) => void }) {
  const { risk, account, policy } = state;
  if (!account || !risk.budget) return <p className="p-4 text-xs leading-relaxed text-zinc-500">Live risk metrics appear after MT5 reports a real account snapshot. No placeholder balance is used.</p>;
  const budgetColour = risk.budget.usedPct >= 80 ? "bg-red-500" : risk.budget.usedPct >= 50 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div className="space-y-4 p-3 text-[11px]">
      {risk.state.haltedUntilNextSession && <div className="flex gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-red-300"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /><span className="leading-snug">{risk.state.haltReason}</span></div>}
      <div><div className="mb-1.5 flex flex-wrap justify-between gap-2 text-[10px] text-zinc-500"><span>Daily loss budget</span><span className="font-mono">{formatMoney(risk.budget.remainingMoney, account.currency)} left of {formatMoney(risk.budget.limitMoney, account.currency)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full ${budgetColour}`} style={{ width: `${risk.budget.usedPct}%` }} /></div></div>
      <dl className="grid grid-cols-2 gap-2"><Stat label="Equity" value={formatMoney(account.equity, account.currency)} /><Stat label="Balance" value={formatMoney(account.balance, account.currency)} /><Stat label="Free margin" value={formatMoney(account.freeMargin, account.currency)} /><Stat label="Margin level" value={Number.isFinite(account.marginLevel) ? `${account.marginLevel.toFixed(0)}%` : "∞"} /><Stat label="Loss streak" value={String(risk.state.consecutiveLosses)} /><Stat label="Trades today" value={String(risk.state.tradesToday)} /></dl>
      {risk.exposure.length > 0 && <div><p className="mb-2 text-[9px] uppercase tracking-wider text-zinc-600">Portfolio risk · cap {policy.maxCurrencyExposurePct}%</p><div className="space-y-1.5">{risk.exposure.map((entry) => <div key={entry.key} className="flex items-center gap-2 font-mono text-[10px]"><span className="w-12 text-zinc-400">{entry.key}</span><div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800"><div className={entry.riskPct >= policy.maxCurrencyExposurePct ? "h-full bg-red-500" : "h-full bg-sky-500"} style={{ width: `${Math.min(100, (entry.riskPct / policy.maxCurrencyExposurePct) * 100)}%` }} /></div><span className="w-12 text-right text-zinc-500">{entry.riskPct.toFixed(2)}%</span></div>)}</div></div>}
      {risk.state.suspendedSymbols.length > 0 && <div><p className="mb-2 text-[9px] uppercase tracking-wider text-zinc-600">Suspended · regime change required</p><div className="flex flex-wrap gap-1.5">{risk.state.suspendedSymbols.map((symbol) => <button key={symbol} type="button" onClick={() => onResume(symbol)} className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">{symbol} ↻</button>)}</div></div>}
    </div>
  );
}

export function HighImpactNewsPane({ news }: { news: DeskNewsState }) {
  const now = Date.now();
  const calendarReady = news.ready && news.fetchedAt !== null &&
    news.fetchedAt <= now + 30_000 && now - news.fetchedAt <= news.staleAfterMs;
  const ageSeconds = Math.floor(Math.max(0, now - (news.fetchedAt ?? now)) / 1000);
  const formatUtc = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
  const statusLabel = calendarReady
    ? "MT5 calendar verified"
    : news.ready || news.status === "stale"
      ? "MT5 calendar stale"
      : news.status === "unknown"
        ? "Waiting for MT5 calendar"
        : "MT5 calendar unavailable";

  return (
    <div className="space-y-3 p-3 text-[11px]">
      <div className={`flex min-w-0 items-start gap-2 rounded-lg border p-3 ${calendarReady ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
        {calendarReady
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />}
        <div className="min-w-0">
          <p className={`font-semibold ${calendarReady ? "text-emerald-300" : "text-amber-300"}`}>{statusLabel}</p>
          <p className="mt-1 break-words text-[10px] leading-relaxed text-zinc-500">
            {calendarReady
              ? `Updated ${ageSeconds}s ago. New entries are blocked from ${Math.round(news.blackoutBeforeMs / 60_000)} minutes before until ${Math.round(news.blackoutAfterMs / 60_000)} minutes after a matching high-impact release.`
              : `${news.error ?? (news.ready ? "The cached MT5 calendar snapshot has aged out; new entries are blocked until the feed is refreshed." : "New entries are blocked until the calendar is verified.")} Existing positions remain manageable.`}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-wider text-zinc-600">
        <span className="flex items-center gap-1.5"><CalendarDays className="h-3 w-3" />Red-folder events relevant to selected markets</span>
        <span className="shrink-0">UTC</span>
      </div>

      {!calendarReady ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[10px] leading-relaxed text-zinc-500">
          Attach the updated NeurotradeBridge EA to a live MT5 terminal with its economic calendar available. The desk will not substitute an external, replayed, or mock calendar.
        </p>
      ) : news.events.length === 0 ? (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[10px] text-zinc-500">
          No matching high-impact events in the MT5 calendar for the next 48 hours.
        </p>
      ) : (
        <ul className="max-h-[300px] divide-y divide-zinc-900 overflow-y-auto rounded-lg border border-zinc-900">
          {news.events.map((event) => {
            const timing = event.inBlackout
              ? `BLACKOUT · ${Math.max(0, Math.ceil((event.blackoutEnd - now) / 60_000))}m cooldown`
              : event.minutesUntil > 0
                ? `in ${event.minutesUntil}m`
                : "recent";
            return (
              <li key={`${event.id}-${event.ts}`} className="min-w-0 p-3">
                <div className="flex min-w-0 items-start gap-2">
                  <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] font-semibold ${event.inBlackout ? "border-red-500/40 bg-red-500/10 text-red-300" : "border-amber-500/30 bg-amber-500/5 text-amber-300"}`}>
                    {event.currency}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[10px] font-medium leading-snug text-zinc-200">{event.title || "High-impact economic event"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] text-zinc-500">
                      <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />{formatUtc(event.ts)}</span>
                      {event.affectedSymbols.length > 0 && <span className="break-words">· {event.affectedSymbols.join(", ")}</span>}
                    </div>
                  </div>
                  <span className={`shrink-0 text-right text-[9px] font-semibold uppercase ${event.inBlackout ? "text-red-300" : "text-amber-400"}`}>{timing}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-[9px] leading-relaxed text-zinc-600">High-impact MT5 events only · scheduled data can change; the server and EA both fail closed when the feed is stale or uncertain.</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-2"><dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt><dd className="mt-1 truncate font-mono text-[11px] text-zinc-200">{value}</dd></div>;
}

const JOURNAL_COLOURS: Record<JournalEntry["kind"], string> = {
  signal: "text-emerald-400",
  no_trade: "text-zinc-500",
  execution: "text-sky-400",
  risk: "text-amber-400",
  bridge: "text-violet-400",
};

export function JournalPane({ entries }: { entries: JournalEntry[] }) {
  const [filter, setFilter] = useState<"all" | JournalEntry["kind"]>("all");
  const visible = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);
  return (
    <div className="p-3">
      <div className="mb-2 flex gap-1 overflow-x-auto">
        {(["all", "signal", "execution", "risk", "bridge"] as const).map((kind) => (
          <button key={kind} type="button" onClick={() => setFilter(kind)} className={`shrink-0 rounded px-2 py-1 text-[9px] uppercase tracking-wider ${filter === kind ? "bg-zinc-800 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}>{kind}</button>
        ))}
      </div>
      {visible.length === 0 ? <p className="py-4 text-xs text-zinc-500">No live activity recorded yet.</p> : <ul className="max-h-[340px] divide-y divide-zinc-900 overflow-y-auto">{visible.map((entry) => <li key={entry.id} className="flex gap-3 py-2"><span className="w-14 shrink-0 pt-0.5 font-mono text-[9px] text-zinc-600">{relativeTime(entry.ts)}</span><div className="min-w-0"><span className={`mr-2 text-[9px] uppercase ${JOURNAL_COLOURS[entry.kind]}`}>{entry.kind.replace("_", " ")}</span>{entry.symbol && <span className="mr-2 font-mono text-[10px] text-zinc-400">{entry.symbol}</span>}<p className="mt-0.5 break-words text-[10px] leading-relaxed text-zinc-400">{entry.message}</p></div></li>)}</ul>}
    </div>
  );
}
