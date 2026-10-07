/**
 * Multi-Asset Desk — responsive information panes.
 *
 * The Desk intentionally has no embedded chart. Every panel answers an
 * operational question using the paired broker's own live terminal data:
 * what is selected, what is fresh, what is the agent refusing/allowing, what
 * is exposed, and whether high-impact news is blocking new risk.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Globe,
  Minus,
  Radio,
  Search,
  ShieldAlert,
  XCircle,
  Zap,
} from "lucide-react";
import {
  ASSET_CLASSES,
  ASSET_CLASS_LABELS,
  DEFAULT_DESK_TIMEZONE,
  countdown,
  formatInZone,
  formatMoney,
  gradeColor,
  regimeColor,
  relativeTime,
  zoneAbbreviation,
  type AgentDecision,
  type EvidenceResult,
  type DeskPerformance,
  type DeskStateResponse,
  type HighImpactNewsEvent,
  type FeedStatus,
  type Instrument,
  type JournalEntry,
  type Market,
  type NewsFeed,
  type Position,
  type ScanRow,
  type UpcomingNewsEvent,
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
    <section className={`min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/80 shadow-sm ${className}`}>
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{title}</h2>
        {right}
      </header>
      <div>{children}</div>
    </section>
  );
}

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "up" || direction === "buy") return <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (direction === "down" || direction === "sell") return <ArrowDownRight className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  return <Minus className="h-3.5 w-3.5 shrink-0 text-zinc-600" />;
}

function statusClass(status: FeedStatus) {
  if (status === "live") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  if (status === "warming") return "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return "border-red-500/40 bg-red-500/10 text-red-300";
}

function formatQuote(value: number | null, digits: number | null): string {
  if (value === null || digits === null) return "—";
  return value.toFixed(digits);
}

// ── Broker market universe ──────────────────────────────────────────────────

export function MarketUniversePane({
  markets,
  selected,
  updating,
  onToggle,
  onFocus,
}: {
  markets: Market[];
  selected: string[];
  updating: boolean;
  onToggle: (symbol: string, enabled: boolean) => void;
  onFocus: (symbol: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [assetClass, setAssetClass] = useState<"all" | Market["assetClass"]>("all");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => markets.filter((market) =>
      (assetClass === "all" || market.assetClass === assetClass) &&
      (!needle || `${market.symbol} ${market.description} ${market.path}`.toLowerCase().includes(needle)),
    ),
    [markets, assetClass, needle],
  );
  const classesPresent = ASSET_CLASSES.filter((kind) => markets.some((market) => market.assetClass === kind));

  if (markets.length === 0) {
    return <p className="p-4 text-xs leading-relaxed text-zinc-500">Pair MT5 to load the complete symbol catalogue offered by your broker.</p>;
  }

  return (
    <div className="space-y-2 p-2.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search broker markets"
          className="h-8 w-full rounded-md border border-zinc-800 bg-zinc-900 pl-8 pr-2 text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-emerald-500/50"
        />
      </div>
      <div className="flex max-w-full gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
        <button
          type="button"
          onClick={() => setAssetClass("all")}
          className={`shrink-0 rounded px-2 py-1 text-[9px] uppercase tracking-wider ${assetClass === "all" ? "bg-emerald-600 text-white" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
        >
          All {markets.length}
        </button>
        {classesPresent.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setAssetClass(kind)}
            className={`shrink-0 rounded px-2 py-1 text-[9px] uppercase tracking-wider ${assetClass === kind ? "bg-emerald-600 text-white" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
          >
            {ASSET_CLASS_LABELS[kind]}
          </button>
        ))}
      </div>
      <p className="px-0.5 text-[10px] text-zinc-600">{filtered.length} of {markets.length} broker markets · {selected.length} selected</p>
      <ul className="max-h-[29rem] divide-y divide-zinc-900 overflow-y-auto rounded-md border border-zinc-900 [scrollbar-width:thin]">
        {filtered.map((market) => {
          const isSelected = selectedSet.has(market.symbol);
          return (
            <li key={market.symbol} className={`flex items-center gap-2 px-2 py-2 ${isSelected ? "bg-emerald-500/5" : ""}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                disabled={!market.tradeable || updating}
                onClick={() => onToggle(market.symbol, !isSelected)}
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                  isSelected ? "border-emerald-500 bg-emerald-600 text-white" : "border-zinc-700 bg-zinc-900 text-transparent"
                } disabled:cursor-not-allowed disabled:opacity-40`}
                title={market.tradeable ? (isSelected ? "Remove from live coverage" : "Select for live coverage") : "Broker marks this symbol unavailable"}
              >
                <CheckCircle2 className="h-3 w-3" />
              </button>
              <button type="button" onClick={() => onFocus(market.symbol)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-mono text-[11px] font-medium text-zinc-200">{market.symbol}</span>
                  {isSelected && <span className={`rounded border px-1 py-px text-[8px] uppercase ${statusClass(market.dataStatus)}`}>{market.dataStatus}</span>}
                </div>
                <p className="truncate text-[9px] text-zinc-600">{market.description || market.path || ASSET_CLASS_LABELS[market.assetClass]}</p>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 && <li className="p-3 text-[11px] text-zinc-500">No broker market matches this filter.</li>}
      </ul>
    </div>
  );
}

// ── Selected live quote board ────────────────────────────────────────────────

export function WatchlistPane({ instruments, selected, onSelect }: { instruments: Instrument[]; selected: string; onSelect: (symbol: string) => void }) {
  if (instruments.length === 0) {
    return <p className="p-4 text-xs leading-relaxed text-zinc-500">Select any number of broker markets above. The EA rotates their live coverage and never trades an unfresh quote.</p>;
  }
  return (
    <div className="max-h-[25rem] overflow-auto [scrollbar-width:thin]">
      <table className="w-full min-w-[440px] text-[11px] font-mono">
        <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
          <tr className="border-b border-zinc-800">
            <th className="px-2 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-right font-medium">Bid</th>
            <th className="px-2 py-2 text-right font-medium">Ask</th>
            <th className="px-2 py-2 text-right font-medium">Spread</th>
            <th className="px-2 py-2 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {instruments.map((instrument) => {
            const active = instrument.symbol === selected;
            const up = (instrument.changePct ?? 0) >= 0;
            return (
              <tr
                key={instrument.symbol}
                onClick={() => onSelect(instrument.symbol)}
                className={`cursor-pointer border-b border-zinc-900 transition-colors ${active ? "bg-emerald-500/10" : "hover:bg-zinc-900/70"}`}
                data-testid={`watchlist-row-${instrument.symbol}`}
              >
                <td className="px-2 py-2">
                  <div className={active ? "font-semibold text-emerald-300" : "text-zinc-200"}>{instrument.symbol}</div>
                  <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-600">
                    {ASSET_CLASS_LABELS[instrument.assetClass]}
                    <span className={`rounded border px-1 py-px text-[8px] ${statusClass(instrument.dataStatus)}`}>{instrument.dataStatus}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right text-zinc-300">{formatQuote(instrument.bid, instrument.digits)}</td>
                <td className="px-2 py-2 text-right text-zinc-300">{formatQuote(instrument.ask, instrument.digits)}</td>
                <td className="px-2 py-2 text-right text-zinc-500">{instrument.spreadPoints ?? "—"}</td>
                <td className={`px-2 py-2 text-right ${instrument.changePct === null ? "text-zinc-600" : up ? "text-emerald-400" : "text-red-400"}`}>
                  {instrument.changePct === null ? "—" : `${up ? "+" : ""}${instrument.changePct.toFixed(2)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live market pulse.
 *
 * Two layouts, deliberately:
 *
 *  - Desktop keeps the compact four-column strip. It sits inside a narrow
 *    column next to two other panes, and a big number there would unbalance
 *    the whole row.
 *  - Mobile gets a card. On a phone the pane is full width, so the old strip
 *    degenerated into four cramped boxes with the price — the one thing the
 *    user opened the desk to see — no bigger than the spread. The mobile card
 *    leads with the price, then the spread/change/range as pills, then a
 *    sparkline of the last moves.
 */
export function LiveQuotePane({ instrument }: { instrument: Instrument | null }) {
  if (!instrument) return <p className="p-4 text-xs text-zinc-500">Choose a selected broker market to inspect its live quote and agent assessment.</p>;
  const stale = instrument.dataStatus !== "live";
  const up = (instrument.changePct ?? 0) >= 0;
  const spread = instrument.spreadPoints === null ? "—" : `${instrument.spreadPoints} pts`;
  const riskPoints =
    instrument.bid !== null && instrument.ask !== null && instrument.point
      ? Math.round((instrument.ask - instrument.bid) / instrument.point)
      : instrument.spreadPoints;

  return (
    <>
      {/* ── Mobile: a price-first card ─────────────────────────────────────── */}
      <div className="p-3 sm:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <Radio className={`h-3.5 w-3.5 shrink-0 ${stale ? "text-amber-400" : "text-emerald-400"}`} />
              <span className="truncate font-mono text-[15px] font-semibold leading-none text-zinc-100">{instrument.symbol}</span>
            </div>
            <p className="mt-1 truncate text-[10px] text-zinc-500">{instrument.description}</p>
          </div>
          <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase ${statusClass(instrument.dataStatus)}`}>
            {instrument.dataStatus}
          </span>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
            <dt className="text-[9px] uppercase tracking-wider text-zinc-500">Bid</dt>
            <dd className="mt-0.5 font-mono text-[19px] font-semibold leading-tight text-emerald-300">
              {formatQuote(instrument.bid, instrument.digits)}
            </dd>
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
            <dt className="text-[9px] uppercase tracking-wider text-zinc-500">Ask</dt>
            <dd className="mt-0.5 font-mono text-[19px] font-semibold leading-tight text-red-300">
              {formatQuote(instrument.ask, instrument.digits)}
            </dd>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          <Pill label="Spread" value={spread} />
          <Pill
            label="Change"
            value={instrument.changePct === null ? "—" : `${up ? "+" : ""}${instrument.changePct.toFixed(2)}%`}
            tone={instrument.changePct === null ? undefined : up ? "good" : "bad"}
          />
          {instrument.sessionLow !== null && instrument.sessionHigh !== null && (
            <Pill
              label="24h range"
              value={`${formatQuote(instrument.sessionLow, instrument.digits)} – ${formatQuote(instrument.sessionHigh, instrument.digits)}`}
            />
          )}
          {instrument.quoteAgeMs !== null && (
            <Pill
              label="Tick age"
              value={instrument.quoteAgeMs < 1000 ? "<1s" : `${(instrument.quoteAgeMs / 1000).toFixed(1)}s`}
              tone={instrument.quoteAgeMs > 4000 ? "bad" : undefined}
            />
          )}
        </div>

        {instrument.sparkline.length > 1 && <Sparkline values={instrument.sparkline} up={up} className="mt-3 h-12" />}

        {instrument.priceWarning && (
          <p className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-[10px] leading-relaxed text-red-200">
            {instrument.priceWarning}
          </p>
        )}
        {stale && !instrument.priceWarning && (
          <p className="mt-2 text-[10px] leading-relaxed text-amber-300">
            This symbol is not fresh enough for analysis or execution.
          </p>
        )}
      </div>

      {/* ── Desktop: unchanged compact strip ───────────────────────────────── */}
      <div className="hidden sm:grid sm:grid-cols-[1.25fr_repeat(3,minmax(0,1fr))] gap-2 p-3">
        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5">
          <div className="flex items-center gap-2">
            <Radio className={`h-4 w-4 ${stale ? "text-amber-400" : "text-emerald-400"}`} />
            <span className="truncate font-mono text-sm font-semibold text-zinc-100">{instrument.symbol}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[9px] uppercase ${statusClass(instrument.dataStatus)}`}>{instrument.dataStatus}</span>
          </div>
          <p className="mt-1 truncate text-[10px] text-zinc-500">{instrument.description}</p>
        </div>
        <QuoteMetric label="Bid" value={formatQuote(instrument.bid, instrument.digits)} />
        <QuoteMetric label="Ask" value={formatQuote(instrument.ask, instrument.digits)} />
        <QuoteMetric label="Spread" value={riskPoints === null ? "—" : `${riskPoints} pts`} />
        {instrument.priceWarning && (
          <p className="sm:col-span-4 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-[10px] leading-relaxed text-red-200">
            {instrument.priceWarning}
          </p>
        )}
        {stale && !instrument.priceWarning && (
          <p className="sm:col-span-4 text-[10px] leading-relaxed text-amber-300">
            This symbol is not fresh enough for analysis or execution.
          </p>
        )}
      </div>
    </>
  );
}

function Pill({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-zinc-200";
  return (
    <div className="flex items-baseline gap-1 rounded-md border border-zinc-800 bg-zinc-900/50 px-2 py-1">
      <dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className={`font-mono text-[11px] ${colour}`}>{value}</dd>
    </div>
  );
}

/** Minimal dependency-free sparkline. */
export function Sparkline({
  values,
  up,
  className = "h-10",
}: {
  values: number[];
  up: boolean;
  className?: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 100;
  const height = 30;
  const points = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const stroke = up ? "#34d399" : "#fb7185";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function QuoteMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2 text-right"><dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt><dd className="mt-0.5 font-mono text-[12px] text-zinc-200">{value}</dd></div>;
}

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Live scanner, with the automatic best-market pass reported at the top.
 *
 * When auto-trade is on the desk is not waiting for a click: it ranks every
 * selected market and arms the best. This banner is where that decision is
 * accounted for — including the passes that armed nothing, which name the
 * closest miss so "why is it not trading?" is answered on screen.
 */
export function ScannerPane({
  rows,
  onSelect,
  selected,
  autoSelect,
}: {
  rows: ScanRow[];
  onSelect: (symbol: string) => void;
  selected: string;
  autoSelect?: DeskStateResponse["autoSelect"] | null;
}) {
  const last = autoSelect?.last ?? null;
  return (
    <div>
      {last && (
        <div className={`border-b border-zinc-900 px-3 py-2 text-[10px] leading-snug ${last.chosen ? "text-emerald-200/90" : "text-zinc-400"}`} data-testid="auto-select-report">
          <div className="flex items-center gap-1.5">
            <Zap className={`h-3 w-3 shrink-0 ${last.chosen ? "text-emerald-400" : "text-zinc-600"}`} />
            <span className="font-semibold uppercase tracking-wider text-[9px] text-zinc-500">Auto-select · {last.mode}</span>
            <span className="ml-auto font-mono text-[9px] text-zinc-600">{relativeTime(last.at)}</span>
          </div>
          <p className="mt-1">{last.reason}</p>
          {last.ranked.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {last.ranked.slice(0, 4).map((row) => (
                <span
                  key={row.symbol}
                  className={`rounded border px-1 py-px font-mono text-[9px] ${row.armed ? "border-emerald-500/40 text-emerald-300" : "border-zinc-800 text-zinc-500"}`}
                  title={`quality ${row.score} · grade ${row.grade}${row.expectancyR === null ? "" : ` · E ${row.expectancyR.toFixed(2)}R`}`}
                >
                  {row.symbol}{row.expectancyR === null ? "" : ` ${row.expectancyR >= 0 ? "+" : ""}${row.expectancyR.toFixed(2)}R`}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      <ScannerPaneRows rows={rows} onSelect={onSelect} selected={selected} />
    </div>
  );
}

function ScannerPaneRows({ rows, onSelect, selected }: { rows: ScanRow[]; onSelect: (symbol: string) => void; selected: string }) {
  if (rows.length === 0) return <p className="p-4 text-xs text-zinc-500">Select broker markets to start live coverage and scanning.</p>;
  return (
    <ul className="max-h-[32rem] divide-y divide-zinc-900 overflow-auto [scrollbar-width:thin]">
      {rows.map((row) => (
        <li
          key={row.symbol}
          onClick={() => onSelect(row.symbol)}
          className={`cursor-pointer px-3 py-2 transition-colors ${row.symbol === selected ? "bg-emerald-500/10" : "hover:bg-zinc-900/70"}`}
          data-testid={`scan-row-${row.symbol}`}
        >
          <div className="flex items-center gap-2">
            <DirectionIcon direction={row.direction} />
            <span className="w-[76px] truncate font-mono text-[11px] text-zinc-200">{row.symbol}</span>
            <span className={`rounded border px-1 text-[9px] font-semibold ${row.status === "live" ? gradeColor(row.grade) : statusClass(row.status)}`}>{row.status === "live" ? row.grade : row.status}</span>
            {row.status === "live" && <span className="ml-auto font-mono text-[11px] text-zinc-400">{row.score.toFixed(0)}</span>}
            {row.armed ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <Ban className="h-3.5 w-3.5 text-zinc-700" />}
          </div>
          <p className="mt-1 line-clamp-2 pl-[22px] text-[10px] leading-snug text-zinc-500">
            {row.armed && row.expectancyR !== null ? `E ${row.expectancyR.toFixed(2)}R · ${((row.winProbability ?? 0) * 100).toFixed(0)}% win · ${row.lots ?? 0} lots` : (row.rejections[0] ?? "No setup")}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ── Agent analysis ───────────────────────────────────────────────────────────

/**
 * The statistical evidence ensemble.
 *
 * Rendered as a vote, not a verdict: each family shows which way it points,
 * how strongly, and how much data backs it. A family that disagrees is shown
 * as disagreeing — it is not allowed to hide the trade.
 */
export function EvidenceBlock({ evidence }: { evidence: EvidenceResult }) {
  const maxAbs = Math.max(0.001, ...evidence.factors.map((factor) => Math.abs(factor.contribution)));
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[9px] uppercase tracking-wider text-zinc-600">Evidence vote</p>
        <p className="font-mono text-[9px] text-zinc-500">
          {evidence.agreeingFamilies}/{evidence.totalFamilies} agree
          {evidence.dissentingFamilies > 0 && <span className="text-amber-400/80"> · {evidence.dissentingFamilies} opposed</span>}
          <span className="text-zinc-600"> · {evidence.timeframe}</span>
        </p>
      </div>
      <ul className="space-y-1">
        {evidence.factors.map((factor) => (
          <li key={factor.family} className="flex items-center gap-1.5">
            <span className="w-[74px] shrink-0 truncate text-[9px] text-zinc-400">{factor.label}</span>
            <span className={`w-6 shrink-0 text-center text-[9px] font-bold ${factor.vote === 1 ? "text-emerald-400" : factor.vote === -1 ? "text-red-400" : "text-zinc-600"}`}>
              {factor.vote === 1 ? "FOR" : factor.vote === -1 ? "VS" : "—"}
            </span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`absolute top-0 h-full ${factor.vote === 1 ? "bg-emerald-500/80" : factor.vote === -1 ? "bg-red-500/80" : "bg-zinc-600"}`}
                style={{
                  width: `${(Math.abs(factor.contribution) / maxAbs) * 50}%`,
                  left: factor.vote === -1 ? `${50 - (Math.abs(factor.contribution) / maxAbs) * 50}%` : "50%",
                  opacity: 0.45 + 0.55 * factor.reliability,
                }}
                title={`${factor.detail} · reliability ${(factor.reliability * 100).toFixed(0)}%`}
              />
              <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[9px] leading-relaxed text-zinc-600">
        {evidence.factors[0]?.detail ?? "No statistical evidence available."}
      </p>
    </div>
  );
}

export function AgentPane({ decision, horizonMinutes, onArm, arming, armError }: { decision: AgentDecision | null; horizonMinutes: number; onArm: () => void; arming: boolean; armError: string | null }) {
  if (!decision) return <p className="p-4 text-xs text-zinc-500">Select a market with a fresh live quote to run the agent.</p>;
  const { confluence, monteCarlo, sizing } = decision;

  return (
    <div className="space-y-3 p-3">
      {decision.news.status !== "clear" && (
        <div className={`flex gap-2 rounded-lg border p-2 text-[11px] leading-snug ${decision.news.status === "blackout" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
          <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{decision.news.reason}</span>
        </div>
      )}
      <div className="flex items-start gap-2">
        <div className={`rounded border px-1.5 py-0.5 text-[11px] font-bold ${gradeColor(confluence.grade)}`}>{confluence.grade}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5"><DirectionIcon direction={confluence.direction} /><span className="text-[13px] font-semibold text-zinc-100">{confluence.direction === "none" ? "No bias" : confluence.direction === "up" ? "Long bias" : "Short bias"}</span><span className="font-mono text-[11px] text-zinc-500">{decision.qualityScore.toFixed(0)}/{decision.qualityThreshold.toFixed(0)}</span></div>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            Horizon ≈ {horizonMinutes} min · confluence {confluence.score.toFixed(0)}
            {decision.evidence ? ` · evidence ${decision.evidence.confidence.toFixed(0)}` : ""}
            {!confluence.higherTimeframeAligned && ` · higher timeframe opposed (−${confluence.contextPenalty.toFixed(0)})`}
          </p>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={decision.qualityScore >= decision.qualityThreshold + 10 ? "h-full bg-emerald-500" : decision.qualityScore >= decision.qualityThreshold ? "h-full bg-amber-500" : "h-full bg-zinc-600"} style={{ width: `${Math.min(100, decision.qualityScore)}%` }} /></div>
      {decision.evidence && <EvidenceBlock evidence={decision.evidence} />}
      {monteCarlo && <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4"><Metric label="Win" value={`${(monteCarlo.winProbability * 100).toFixed(0)}%`} /><Metric label="Net E" value={`${monteCarlo.expectancyR >= 0 ? "+" : ""}${monteCarlo.expectancyR.toFixed(2)}R`} tone={monteCarlo.expectancyR > 0 ? "good" : "bad"} /><Metric label="R:R" value={monteCarlo.rewardRisk.toFixed(1)} /><Metric label="Bars" value={monteCarlo.meanBarsToResolve.toFixed(0)} /></dl>}
      <div>
        <p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Timeframe agreement</p>
        <div className="space-y-1">
          {confluence.views.map((view) => <div key={view.timeframe} className="flex items-center gap-1.5 text-[10px] font-mono"><span className="w-7 text-zinc-500">{view.timeframe}</span><span className={`w-[70px] ${regimeColor(view.kind)}`}>{view.kind}</span><div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800"><div className={view.contribution >= 0 ? "h-full bg-emerald-500/70" : "h-full bg-red-500/70"} style={{ width: `${Math.min(100, Math.abs(view.contribution) * 220)}%` }} /></div><span className="w-8 text-right text-zinc-500">{view.rsi.toFixed(0)}</span></div>)}
        </div>
      </div>
      {sizing && <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2"><p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Position sizing</p><p className="font-mono text-[10px] leading-relaxed text-zinc-300">{sizing.explanation}</p></div>}
      {decision.warnings.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="mb-1 flex items-center gap-1 text-[9px] uppercase tracking-wider text-amber-400/80"><AlertTriangle className="h-3 w-3" />Carried cautions</p>
          <ul className="space-y-1">{decision.warnings.map((warning) => <li key={warning} className="flex gap-1 text-[10px] leading-snug text-amber-200/80"><span className="text-amber-700">•</span>{warning}</li>)}</ul>
        </div>
      )}
      {decision.armed && decision.plan ? (
        <div className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5"><div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" />A+ live setup — ready to arm</div><div className="grid grid-cols-3 gap-1 text-[10px] font-mono text-zinc-400"><span>Trigger {decision.plan.trigger.toFixed(5)}</span><span className="text-red-400">SL {decision.plan.sl.toFixed(5)}</span><span className="text-emerald-400">TP {decision.plan.tp[0]?.toFixed(5)}</span></div><button type="button" onClick={onArm} disabled={arming} className="w-full rounded bg-emerald-600 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50" data-testid="arm-plan">{arming ? "Arming…" : `Arm ${decision.plan.side.toUpperCase()} ${decision.plan.lots} lots`}</button>{armError && <p className="flex gap-1 text-[10px] leading-snug text-amber-400"><AlertTriangle className="mt-px h-3 w-3 shrink-0" />{armError}</p>}</div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5"><div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-zinc-300"><XCircle className="h-3.5 w-3.5 text-zinc-500" />No trade</div><ul className="space-y-1">{decision.rejections.map((reason) => <li key={reason} className="flex gap-1 text-[10px] leading-snug text-zinc-500"><span className="text-zinc-700">•</span>{reason}</li>)}{decision.rejections.length === 0 && <li className="text-[10px] text-zinc-500">Waiting for a qualifying setup.</li>}</ul></div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-200";
  return <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 py-1.5 text-center"><dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt><dd className={`font-mono text-[12px] ${colour}`}>{value}</dd></div>;
}

// ── Positions / plans / risk ─────────────────────────────────────────────────

export function PositionsPane({ positions, currency, onClose }: { positions: Position[]; currency: string; onClose: (ticket: number) => void }) {
  if (positions.length === 0) return <p className="p-4 text-xs text-zinc-500">No open terminal positions.</p>;
  return <div className="overflow-auto"><table className="w-full min-w-[500px] text-[11px] font-mono"><thead className="bg-zinc-950 text-zinc-500"><tr className="border-b border-zinc-800"><th className="px-2 py-2 text-left font-medium">Symbol</th><th className="px-2 py-2 text-right font-medium">Vol</th><th className="px-2 py-2 text-right font-medium">Entry</th><th className="px-2 py-2 text-right font-medium">SL</th><th className="px-2 py-2 text-right font-medium">P&L</th><th className="px-2 py-2" /></tr></thead><tbody>{positions.map((position) => { const net = position.profit + position.swap + position.commission; return <tr key={position.ticket} className="border-b border-zinc-900"><td className="px-2 py-2"><span className="flex items-center gap-1"><DirectionIcon direction={position.side} /><span className="text-zinc-200">{position.symbol}</span></span></td><td className="px-2 py-2 text-right text-zinc-300">{position.volume}</td><td className="px-2 py-2 text-right text-zinc-400">{position.openPrice}</td><td className="px-2 py-2 text-right text-zinc-500">{position.sl ?? "—"}</td><td className={`px-2 py-2 text-right ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatMoney(net, currency)}</td><td className="px-2 py-2 text-right"><button type="button" onClick={() => onClose(position.ticket)} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-red-500/50 hover:text-red-400">Close</button></td></tr>; })}</tbody></table></div>;
}

export function ArmedPlansPane({ plans, onCancel }: { plans: DeskStateResponse["plans"]; onCancel: (id: string) => void }) {
  if (plans.length === 0) return <p className="p-4 text-xs leading-relaxed text-zinc-500">No plans are armed. The agent only creates one after live data, risk and red-folder news gates all pass.</p>;
  return <ul className="divide-y divide-zinc-900">{plans.map((plan) => <li key={plan.id} className="px-3 py-2 text-[10px] font-mono"><div className="flex items-center gap-1.5"><span className={plan.side === "buy" ? "text-emerald-400" : "text-red-400"}>{plan.side.toUpperCase()}</span><span className="text-zinc-200">{plan.symbol}</span><span className="text-zinc-500">{plan.lots} lots</span><button type="button" onClick={() => onCancel(plan.id)} className="ml-auto text-zinc-600 transition-colors hover:text-red-400">cancel</button></div><div className="mt-1 leading-relaxed text-zinc-600">trg {plan.trigger} · sl {plan.sl} · tp {plan.tp[0]} · expires in {Math.max(0, Math.round((plan.expiresAt - Date.now()) / 1000))}s</div></li>)}</ul>;
}

export function RiskPane({ state, onResume }: { state: DeskStateResponse; onResume: (symbol: string) => void }) {
  const { risk, account, policy } = state;
  if (!account || !risk.budget) return <p className="p-4 text-xs text-zinc-500">Risk budget is calculated only after the paired terminal sends a real account snapshot.</p>;
  const budgetColour = risk.budget.usedPct >= 80 ? "bg-red-500" : risk.budget.usedPct >= 50 ? "bg-amber-500" : "bg-emerald-500";
  return <div className="space-y-3 p-3 text-[11px]">{risk.state.haltedUntilNextSession && <div className="flex gap-1.5 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300"><ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" /><span className="text-[10px] leading-snug">{risk.state.haltReason}</span></div>}<div><div className="mb-1 flex justify-between gap-2 text-[10px] text-zinc-500"><span>Daily loss budget</span><span className="font-mono text-right">{formatMoney(risk.budget.remainingMoney, account.currency)} left of {formatMoney(risk.budget.limitMoney, account.currency)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full ${budgetColour}`} style={{ width: `${risk.budget.usedPct}%` }} /></div></div><dl className="grid grid-cols-2 gap-2"><Stat label="Equity" value={formatMoney(account.equity, account.currency)} /><Stat label="Balance" value={formatMoney(account.balance, account.currency)} /><Stat label="Free margin" value={formatMoney(account.freeMargin, account.currency)} /><Stat label="Margin level" value={Number.isFinite(account.marginLevel) ? `${account.marginLevel.toFixed(0)}%` : "∞"} /><Stat label="Loss streak" value={String(risk.state.consecutiveLosses)} /><Stat label="Trades today" value={String(risk.state.tradesToday)} /></dl>{risk.exposure.length > 0 && <div><p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Net exposure (cap {policy.maxCurrencyExposurePct}%)</p><div className="space-y-1">{risk.exposure.map((entry) => <div key={entry.key} className="flex items-center gap-2 font-mono text-[10px]"><span className="w-12 text-zinc-400">{entry.key}</span><div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800"><div className={entry.riskPct >= policy.maxCurrencyExposurePct ? "h-full bg-red-500" : "h-full bg-sky-500"} style={{ width: `${Math.min(100, (entry.riskPct / policy.maxCurrencyExposurePct) * 100)}%` }} /></div><span className="w-10 text-right text-zinc-500">{entry.riskPct.toFixed(2)}%</span></div>)}</div></div>}{risk.state.suspendedSymbols.length > 0 && <div><p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Suspended — awaiting regime change</p><div className="flex flex-wrap gap-1">{risk.state.suspendedSymbols.map((symbol) => <button key={symbol} type="button" onClick={() => onResume(symbol)} className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-500/20">{symbol} ↻</button>)}</div></div>}</div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 py-1.5"><dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt><dd className="font-mono text-[11px] text-zinc-200">{value}</dd></div>; }

// ── Red-folder calendar ──────────────────────────────────────────────────────

/**
 * Red-folder calendar — the NEXT 24 HOURS.
 *
 * The window is the next 24 hours of high-impact events, in the order they will
 * happen, and it is decided by the server (`upcomingRedFolder`) so this pane,
 * the agent's news gate and the journal all describe the same window. Until
 * now the pane listed whatever the feed carried, capped at twelve rows, with a
 * "-30 minutes" cutoff decided here in the browser — which is why the next
 * red-folder release could be missing while a past one was still on screen.
 *
 * Every time is rendered in the desk's configured timezone (Nairobi EAT by
 * default) and labelled with that zone's abbreviation, so a countdown can never
 * be silently interpreted in the wrong clock. MT5 calendar times arrive in the
 * broker's trade-server timezone: without an explicit zone the same event reads
 * differently on a laptop, a phone and a VPS.
 */
export function NewsPane({
  feed,
  upcoming,
  timeZone = DEFAULT_DESK_TIMEZONE,
}: {
  feed: NewsFeed;
  upcoming?: UpcomingNewsEvent[];
  timeZone?: string;
}) {
  const now = Date.now();
  const events = upcoming ?? [];
  if (!feed.available) {
    return (
      <div className="flex gap-2 p-3 text-[11px] leading-relaxed text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{feed.detail || "MT5 economic calendar is unavailable. New entries are paused until it is available."}</span>
      </div>
    );
  }
  return (
    <div className="divide-y divide-zinc-900">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 text-[9px] uppercase tracking-wider text-zinc-600">
        <span className="flex items-center gap-1"><Globe className="h-3 w-3" />Next 24 h · {events.length} red-folder {events.length === 1 ? "event" : "events"}</span>
        <span className="text-zinc-700">·</span>
        <span>{zoneAbbreviation(now, timeZone)} · {timeZone.replace("_", " ")}</span>
      </div>
      {events.length === 0
        ? <p className="p-4 text-xs text-zinc-500">No high-impact events in the next 24 hours. The gate stays armed — the calendar is refreshed by the terminal every minute.</p>
        : events.map((event) => <NewsRow key={event.id} event={event} timeZone={timeZone} />)}
      <p className="flex items-center gap-1.5 px-3 py-2 text-[9px] text-zinc-600">
        <Clock3 className="h-3 w-3" />Calendar checked {feed.checkedAt ? relativeTime(feed.checkedAt) : "never"} · new entries fail closed if this feed goes stale.
      </p>
    </div>
  );
}

function NewsRow({ event, timeZone }: { event: UpcomingNewsEvent; timeZone: string }) {
  const now = Date.now();
  const timing = countdown(event.time, now);
  const local = formatInZone(event.time, timeZone, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  // The blackout the news gate actually applies starts 30 minutes before a
  // release (20 for a scalp, 20 for a swing). Showing it on the row means the
  // user can see the window closing rather than discovering it in a rejection.
  const imminent = event.time - now <= 30 * 60_000 && event.time >= now - 15 * 60_000;
  return (
    <div className={`flex gap-2 px-3 py-2 ${event.next ? "bg-red-500/5" : ""}`}>
      <CalendarDays className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${imminent ? "text-red-400" : "text-red-400/70"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-red-500/15 px-1 text-[9px] font-bold text-red-300">{event.currency || "HIGH"}</span>
          <span className="truncate text-[11px] text-zinc-200">{event.name}</span>
          {event.next && <span className="shrink-0 rounded border border-red-500/40 px-1 text-[8px] uppercase tracking-wider text-red-300">next</span>}
        </div>
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[9px] text-zinc-500">
          <span className="font-mono text-zinc-400">{local}</span>
          <span className="text-zinc-600">{zoneAbbreviation(event.time, timeZone)}</span>
          <span className="text-zinc-600">·</span>
          <span className={imminent ? "font-medium text-amber-300" : "text-zinc-500"}>{timing}</span>
        </p>
      </div>
    </div>
  );
}

// ── Realised performance ─────────────────────────────────────────────────────

/**
 * What the desk has actually done: equity curve, P&L by symbol, and the R-based
 * statistics that matter.
 *
 * Built only from closed broker positions and sampled equity — never from a
 * projection. It answers the question a trading desk asks at the end of a
 * session, which is the question a risk panel cannot answer on its own: is the
 * edge real, and where is it coming from?
 */
export function PerformancePane({
  performance,
  currency,
  timeZone = DEFAULT_DESK_TIMEZONE,
}: {
  performance: DeskPerformance | null;
  currency: string;
  timeZone?: string;
}) {
  if (!performance) return <p className="p-4 text-xs text-zinc-500">Pair MT5 to start recording realised performance.</p>;

  const { overall, bySymbol, equityCurve, closedTrades } = performance;
  if (overall.trades === 0 && equityCurve.length === 0) {
    return (
      <p className="p-4 text-xs leading-relaxed text-zinc-500">
        No closed trades yet. Every position the terminal closes will appear here — P&amp;L by symbol, the equity curve, and win rate in R.
      </p>
    );
  }

  const best = bySymbol[0];
  const worst = bySymbol[bySymbol.length - 1];
  const absMax = Math.max(1, ...bySymbol.map((entry) => Math.abs(entry.net)));

  return (
    <div className="space-y-3 p-3">
      {equityCurve.length > 1 && (
        <div>
          <p className="mb-1 text-[9px] uppercase tracking-wider text-zinc-600">Equity curve</p>
          <EquityCurve samples={equityCurve} />
        </div>
      )}

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PerfStat label="Closed trades" value={String(overall.trades)} />
        <PerfStat label="Win rate" value={`${(overall.winRate * 100).toFixed(0)}%`} tone={overall.winRate >= 0.5 ? "good" : "bad"} />
        <PerfStat label="Total R" value={`${overall.totalR >= 0 ? "+" : ""}${overall.totalR.toFixed(2)}R`} tone={overall.totalR >= 0 ? "good" : "bad"} />
        <PerfStat
          label="Profit factor"
          value={Number.isFinite(overall.profitFactor) ? overall.profitFactor.toFixed(2) : "∞"}
          tone={overall.profitFactor >= 1 ? "good" : "bad"}
        />
        <PerfStat label="Avg R" value={`${overall.avgR >= 0 ? "+" : ""}${overall.avgR.toFixed(2)}R`} tone={overall.avgR >= 0 ? "good" : "bad"} />
        <PerfStat label="Max DD (R)" value={overall.maxDrawdownR.toFixed(2)} tone={overall.maxDrawdownR > 5 ? "bad" : undefined} />
        <PerfStat label="Worst streak" value={String(overall.maxLosingStreak)} tone={overall.maxLosingStreak >= 4 ? "bad" : undefined} />
        <PerfStat label="Realised today" value={formatMoney(performance.realisedPnl, currency)} tone={performance.realisedPnl >= 0 ? "good" : "bad"} />
      </dl>

      {bySymbol.length > 0 && (
        <div>
          <p className="mb-1.5 text-[9px] uppercase tracking-wider text-zinc-600">P&amp;L by symbol</p>
          <ul className="space-y-1.5">
            {bySymbol.slice(0, 8).map((entry) => (
              <li key={entry.symbol} className="flex items-center gap-2">
                <span className="w-16 shrink-0 truncate font-mono text-[10px] text-zinc-300">{entry.symbol}</span>
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className={`absolute top-0 h-full ${entry.net >= 0 ? "bg-emerald-500" : "bg-red-500"}`}
                    style={{
                      width: `${(Math.abs(entry.net) / absMax) * 50}%`,
                      left: entry.net >= 0 ? "50%" : `${50 - (Math.abs(entry.net) / absMax) * 50}%`,
                    }}
                  />
                  <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-700" />
                </div>
                <span className={`w-16 shrink-0 text-right font-mono text-[10px] ${entry.net >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {entry.net >= 0 ? "+" : "−"}{Math.abs(entry.net).toFixed(2)}
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-[9px] text-zinc-600">{entry.trades}t</span>
              </li>
            ))}
          </ul>
          {(best || worst) && (
            <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">
              {best && <>Best: <span className="text-emerald-400">{best.symbol}</span> {formatMoney(best.net, currency)} across {best.trades} trade{best.trades === 1 ? "" : "s"}.</>}
              {worst && worst.net < 0 && <> Worst: <span className="text-red-400">{worst.symbol}</span> {formatMoney(worst.net, currency)}.</>}
            </p>
          )}
        </div>
      )}

      {closedTrades.length > 0 && (
        <div>
          <p className="mb-1.5 text-[9px] uppercase tracking-wider text-zinc-600">Recently closed</p>
          <ul className="divide-y divide-zinc-900 overflow-hidden rounded-md border border-zinc-900">
            {closedTrades.slice(0, 6).map((trade) => {
              const net = trade.profit + trade.swap + trade.commission;
              return (
                <li key={trade.ticket} className="flex items-center gap-2 px-2 py-1.5 text-[10px]">
                  <DirectionIcon direction={trade.side} />
                  <span className="w-16 shrink-0 truncate font-mono text-zinc-300">{trade.symbol}</span>
                  <span className="w-12 shrink-0 font-mono text-zinc-600">{trade.volume}</span>
                  <span className={`ml-auto font-mono ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {net >= 0 ? "+" : "−"}{Math.abs(net).toFixed(2)}
                  </span>
                  <span className={`w-12 shrink-0 text-right font-mono ${(trade.rMultiple ?? 0) >= 0 ? "text-zinc-400" : "text-zinc-500"}`}>
                    {trade.rMultiple === null ? "—" : `${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R`}
                  </span>
                  <span className="w-14 shrink-0 text-right text-[9px] text-zinc-600">
                    {formatInZone(trade.closedAt, timeZone, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function EquityCurve({ samples }: { samples: { t: number; equity: number; balance: number }[] }) {
  const values = samples.map((sample) => sample.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 320;
  const height = 60;
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * width},${height - ((value - min) / span) * height}`)
    .join(" ");
  const first = values[0];
  const last = values[values.length - 1];
  const colour = last >= first ? "#34d399" : "#fb7185";

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-16 w-full" aria-hidden="true">
        <polyline points={points} fill="none" stroke={colour} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-zinc-600">
        <span>{first.toFixed(2)}</span>
        <span className={last >= first ? "text-emerald-400" : "text-red-400"}>{last.toFixed(2)}</span>
      </div>
    </div>
  );
}

function PerfStat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-200";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-2 py-1.5">
      <dt className="truncate text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className={`font-mono text-[12px] ${colour}`}>{value}</dd>
    </div>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────

const JOURNAL_COLOURS: Record<JournalEntry["kind"], string> = { signal: "text-emerald-400", no_trade: "text-zinc-500", execution: "text-sky-400", risk: "text-amber-400", bridge: "text-violet-400" };

export function JournalPane({ entries, timeZone = DEFAULT_DESK_TIMEZONE }: { entries: JournalEntry[]; timeZone?: string }) {
  const [filter, setFilter] = useState<"all" | JournalEntry["kind"]>("all");
  const visible = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);
  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-zinc-900 px-3 py-1.5">
        <div className="flex gap-1 overflow-x-auto">{(["all", "signal", "execution", "risk"] as const).map((kind) => <button key={kind} type="button" onClick={() => setFilter(kind)} className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${filter === kind ? "bg-zinc-800 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}>{kind}</button>)}</div>
        <span className="shrink-0 font-mono text-[9px] text-zinc-600">{zoneAbbreviation(Date.now(), timeZone)}</span>
      </div>
      <ul className="max-h-72 divide-y divide-zinc-900 overflow-auto [scrollbar-width:thin]">
        {visible.length === 0 && <li className="p-4 text-xs text-zinc-500">Nothing logged yet.</li>}
        {visible.map((entry) => (
          <li key={entry.id} className="flex gap-2 px-3 py-2">
            <span className="w-16 shrink-0 pt-px font-mono text-[9px] text-zinc-600">{formatInZone(entry.ts, timeZone, { hour: "2-digit", minute: "2-digit" })}</span>
            <span className={`text-[10px] leading-snug ${JOURNAL_COLOURS[entry.kind]}`}>{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
