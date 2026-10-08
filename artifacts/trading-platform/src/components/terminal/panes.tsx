/**
 * Multi-Asset Desk — responsive information panes.
 *
 * The Desk intentionally has no embedded chart. Every panel answers an
 * operational question using the paired broker's own live terminal data:
 * what is selected, what is fresh, what is the agent refusing/allowing, what
 * is exposed, and whether high-impact news is blocking new risk.
 */

import { useId, useMemo, useState } from "react";
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
    <section className={`group/pane relative min-w-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-zinc-950/60 shadow-[0_12px_40px_-18px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-colors hover:border-white/10 ${className}`}>
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-cyan-400/25 to-transparent opacity-0 transition-opacity group-hover/pane:opacity-100" />
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-white/[0.05] px-4 py-2.5">
        <h2 className="flex min-w-0 items-center gap-2 truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-300">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
          <span className="truncate">{title}</span>
        </h2>
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

// ── Shared primitives ───────────────────────────────────────────────────────

/** Coloured status light for a feed. Live feeds glow; warming ones breathe. */
function StatusDot({ status }: { status: FeedStatus }) {
  const tone =
    status === "live"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]"
      : status === "warming"
        ? "animate-pulse bg-amber-400"
        : "bg-red-400";
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} aria-hidden="true" />;
}

function StatusChip({ status }: { status: FeedStatus }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider ${statusClass(status)}`}>
      <StatusDot status={status} />
      {status}
    </span>
  );
}

/** Small switch used for selection, so "in live coverage" reads as a state, not a tick box. */
function Toggle({ on }: { on: boolean }) {
  return (
    <span className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${on ? "bg-emerald-400/90" : "bg-white/10"}`}>
      <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}`} />
    </span>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2.5 p-5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.03]">
        <Radio className="h-4 w-4 text-zinc-500" />
      </span>
      <p className="text-xs leading-relaxed text-zinc-500">{children}</p>
    </div>
  );
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500">{children}</p>
      {right}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-zinc-100";
  return (
    <div className="min-w-0 rounded-xl border border-white/[0.06] bg-white/[0.02] px-2.5 py-2">
      <dt className="truncate text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 truncate font-mono text-xs ${colour}`}>{value}</dd>
    </div>
  );
}

/** Price to a sensible precision for its magnitude (2 digits for gold/indices, 5 for FX). */
function formatPrice(value: number): string {
  if (value >= 100) return value.toFixed(2);
  if (value >= 10) return value.toFixed(3);
  return value.toFixed(5);
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
    () =>
      markets.filter(
        (market) =>
          (assetClass === "all" || market.assetClass === assetClass) &&
          (!needle || `${market.symbol} ${market.description} ${market.path}`.toLowerCase().includes(needle)),
      ),
    [markets, assetClass, needle],
  );
  const classesPresent = ASSET_CLASSES.filter((kind) => markets.some((market) => market.assetClass === kind));

  if (markets.length === 0) {
    return <EmptyNote>Pair MT5 to load the complete symbol catalogue offered by your broker.</EmptyNote>;
  }

  const chip = (active: boolean) =>
    `shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
      active ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-200" : "border-white/[0.06] bg-white/[0.02] text-zinc-400 hover:text-zinc-200"
    }`;

  return (
    <div className="space-y-3 p-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search symbol, name or path"
          className="h-9 w-full rounded-xl border border-white/[0.07] bg-white/[0.03] pl-9 pr-3 text-xs text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-cyan-400/40 focus:bg-white/[0.05] focus:ring-2 focus:ring-cyan-400/10"
        />
      </div>

      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
        <button type="button" onClick={() => setAssetClass("all")} className={chip(assetClass === "all")}>
          All <span className="ml-1 font-mono text-[10px] opacity-60">{markets.length}</span>
        </button>
        {classesPresent.map((kind) => (
          <button key={kind} type="button" onClick={() => setAssetClass(kind)} className={chip(assetClass === kind)}>
            {ASSET_CLASS_LABELS[kind]}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span>{filtered.length} of {markets.length} markets</span>
        <span className="font-medium text-emerald-300/90">{selected.length} in live coverage</span>
      </div>

      <ul className="max-h-[26rem] space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {filtered.map((market) => {
          const isSelected = selectedSet.has(market.symbol);
          return (
            <li
              key={market.symbol}
              className={`group flex items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors ${
                isSelected ? "border-emerald-400/15 bg-emerald-400/[0.05]" : "border-transparent hover:border-white/[0.06] hover:bg-white/[0.02]"
              }`}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={isSelected}
                disabled={!market.tradeable || updating}
                onClick={() => onToggle(market.symbol, !isSelected)}
                className="shrink-0 rounded-full disabled:cursor-not-allowed disabled:opacity-40"
                title={market.tradeable ? (isSelected ? "Remove from live coverage" : "Add to live coverage") : "Broker marks this symbol unavailable"}
              >
                <Toggle on={isSelected} />
              </button>
              <button type="button" onClick={() => onFocus(market.symbol)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-[12px] font-semibold text-zinc-100">{market.symbol}</span>
                  {isSelected && <StatusChip status={market.dataStatus} />}
                </div>
                <p className="truncate text-[11px] text-zinc-500">{market.description || market.path || ASSET_CLASS_LABELS[market.assetClass]}</p>
              </button>
              <span className="hidden shrink-0 rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-500 sm:inline">
                {ASSET_CLASS_LABELS[market.assetClass]}
              </span>
            </li>
          );
        })}
        {filtered.length === 0 && <li className="p-3 text-[11px] text-zinc-500">No broker market matches this filter.</li>}
      </ul>
    </div>
  );
}

// ── Selected live coverage ──────────────────────────────────────────────────

export function WatchlistPane({ instruments, selected, onSelect }: { instruments: Instrument[]; selected: string; onSelect: (symbol: string) => void }) {
  if (instruments.length === 0) {
    return <EmptyNote>Select any number of broker markets above. The EA rotates their live coverage and never trades an unfresh quote.</EmptyNote>;
  }
  const total = instruments.length;
  const count = (predicate: (status: FeedStatus) => boolean) => instruments.filter((entry) => predicate(entry.dataStatus)).length;
  const live = count((status) => status === "live");
  const warming = count((status) => status === "warming");
  const attention = total - live - warming;
  const share = (value: number) => `${(value / total) * 100}%`;

  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-white/[0.05]">
          <div className="bg-emerald-400" style={{ width: share(live) }} />
          <div className="bg-amber-400" style={{ width: share(warming) }} />
          <div className="bg-red-400/80" style={{ width: share(attention) }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-400">
          <Legend tone="bg-emerald-400" label="Live" value={live} />
          <Legend tone="bg-amber-400" label="Warming" value={warming} />
          <Legend tone="bg-red-400/80" label="Stale / flagged" value={attention} />
        </div>
      </div>

      <ul className="max-h-[24rem] space-y-1 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {instruments.map((instrument) => {
          const active = instrument.symbol === selected;
          const change = instrument.changePct;
          const up = (change ?? 0) >= 0;
          return (
            <li key={instrument.symbol}>
              <button
                type="button"
                onClick={() => onSelect(instrument.symbol)}
                aria-pressed={active}
                data-testid={`watchlist-row-${instrument.symbol}`}
                className={`grid w-full grid-cols-[minmax(0,1fr)_76px_auto] items-center gap-3 rounded-xl border px-2.5 py-2 text-left transition-colors ${
                  active ? "border-cyan-400/25 bg-cyan-400/[0.07]" : "border-transparent hover:border-white/[0.06] hover:bg-white/[0.025]"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <StatusDot status={instrument.dataStatus} />
                    <span className={`truncate font-mono text-[12px] font-semibold ${active ? "text-cyan-200" : "text-zinc-100"}`}>{instrument.symbol}</span>
                  </div>
                  <p className="mt-0.5 truncate pl-3.5 font-mono text-[10px] text-zinc-500">
                    {formatQuote(instrument.bid, instrument.digits)} / {formatQuote(instrument.ask, instrument.digits)}
                    <span className="text-zinc-600"> · {instrument.spreadPoints ?? "—"} pts</span>
                  </p>
                </div>
                <div className="h-8">
                  <Sparkline values={instrument.sparkline} up={up} className="h-full" />
                </div>
                <span
                  className={`min-w-[62px] rounded-md px-1.5 py-0.5 text-right font-mono text-[11px] font-semibold tabular-nums ${
                    change === null ? "text-zinc-600" : up ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"
                  }`}
                >
                  {change === null ? "—" : `${up ? "+" : ""}${change.toFixed(2)}%`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Legend({ tone, label, value }: { tone: string; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-sm ${tone}`} />
      {label} <span className="font-mono text-zinc-200">{value}</span>
    </span>
  );
}

// ── Live market pulse ───────────────────────────────────────────────────────

/**
 * Live market pulse: the instrument in focus.
 *
 * One layout for every width. The price is the hero, the spread sits between
 * the bid and ask, the sparkline shows the recent path, and a session-range bar
 * shows where the price sits in today's high/low.
 */
export function LiveQuotePane({ instrument }: { instrument: Instrument | null }) {
  if (!instrument) return <EmptyNote>Choose a selected broker market to inspect its live quote and agent assessment.</EmptyNote>;
  const stale = instrument.dataStatus !== "live";
  const change = instrument.changePct;
  const up = (change ?? 0) >= 0;
  const spread = instrument.spreadPoints === null ? "—" : `${instrument.spreadPoints} pts`;
  const hasRange =
    instrument.bid !== null && instrument.sessionHigh !== null && instrument.sessionLow !== null && instrument.sessionHigh > instrument.sessionLow;
  const position = hasRange
    ? Math.min(1, Math.max(0, ((instrument.bid as number) - (instrument.sessionLow as number)) / ((instrument.sessionHigh as number) - (instrument.sessionLow as number))))
    : null;

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-lg font-semibold tracking-tight text-zinc-50">{instrument.symbol}</span>
            <StatusChip status={instrument.dataStatus} />
          </div>
          <p className="mt-0.5 truncate text-xs text-zinc-500">{instrument.description}</p>
        </div>
        <span
          className={`shrink-0 rounded-lg px-2 py-1 font-mono text-sm font-semibold tabular-nums ${
            change === null ? "bg-white/[0.04] text-zinc-500" : up ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"
          }`}
        >
          {change === null ? "—" : `${up ? "+" : ""}${change.toFixed(2)}%`}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-2">
        <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-emerald-300/70">Bid</p>
          <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-emerald-300 sm:text-2xl">{formatQuote(instrument.bid, instrument.digits)}</p>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.02] px-3">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">Spread</p>
          <p className="font-mono text-xs text-zinc-200">{spread}</p>
        </div>
        <div className="rounded-xl border border-red-400/15 bg-red-400/[0.04] px-3 py-2.5 text-right">
          <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-red-300/70">Ask</p>
          <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-red-300 sm:text-2xl">{formatQuote(instrument.ask, instrument.digits)}</p>
        </div>
      </div>

      {instrument.sparkline.length > 1 && (
        <div className="rounded-xl border border-white/[0.05] bg-white/[0.015] p-2">
          <AreaSparkline values={instrument.sparkline} up={up} className="h-20" />
        </div>
      )}

      {position !== null && instrument.sessionLow !== null && instrument.sessionHigh !== null && (
        <div>
          <SectionLabel right={<span className="font-mono text-[10px] text-zinc-500">{((position) * 100).toFixed(0)}% of range</span>}>Session range</SectionLabel>
          <div className="relative h-1.5 rounded-full bg-gradient-to-r from-red-400/50 via-zinc-500/30 to-emerald-400/60">
            <span
              className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-zinc-950 bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.8)]"
              style={{ left: `${position * 100}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-500">
            <span>{formatQuote(instrument.sessionLow, instrument.digits)}</span>
            <span>{formatQuote(instrument.sessionHigh, instrument.digits)}</span>
          </div>
        </div>
      )}

      <dl className="grid grid-cols-3 gap-2">
        <MiniStat label="Tick age" value={instrument.quoteAgeMs === null ? "—" : instrument.quoteAgeMs < 1000 ? "<1s" : `${(instrument.quoteAgeMs / 1000).toFixed(1)}s`} tone={instrument.quoteAgeMs !== null && instrument.quoteAgeMs > 4000 ? "bad" : undefined} />
        <MiniStat label="Contract" value={instrument.contractSize === null ? "—" : instrument.contractSize.toLocaleString()} />
        <MiniStat label="Class" value={ASSET_CLASS_LABELS[instrument.assetClass]} />
      </dl>

      {instrument.priceWarning && (
        <p className="rounded-xl border border-red-500/40 bg-red-500/10 p-2.5 text-[11px] leading-relaxed text-red-200">{instrument.priceWarning}</p>
      )}
      {stale && !instrument.priceWarning && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-200">
          This symbol is not fresh enough for analysis or execution.
        </p>
      )}
    </div>
  );
}

/** Area chart for the recent price path: a gradient fill under a crisp line. */
export function AreaSparkline({ values, up, className = "h-20" }: { values: number[]; up: boolean; className?: string }) {
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 100;
  const height = 30;
  const coords = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    const y = height - ((value - min) / span) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const stroke = up ? "#34d399" : "#fb7185";
  const area = `M0,${height} L${coords.join(" L")} L${width},${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth={1.4} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Minimal dependency-free line sparkline. */
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
      const y = height - ((value - min) / span) * (height - 2) - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const stroke = up ? "#34d399" : "#fb7185";
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.3} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
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
        <div className="m-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3" data-testid="auto-select-report">
          <div className="flex items-center gap-2">
            <span className={`flex h-5 w-5 items-center justify-center rounded-md ${last.chosen ? "bg-emerald-400/15 text-emerald-300" : "bg-white/[0.04] text-zinc-500"}`}>
              <Zap className="h-3 w-3" />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">Auto-select · {last.mode}</span>
            <span className="ml-auto font-mono text-[10px] text-zinc-500">{relativeTime(last.at)}</span>
          </div>
          <p className={`mt-2 text-[11px] leading-relaxed ${last.chosen ? "text-emerald-200/90" : "text-zinc-400"}`}>{last.reason}</p>
          {last.ranked.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {last.ranked.slice(0, 4).map((row) => (
                <span
                  key={row.symbol}
                  className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${row.armed ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300" : "border-white/[0.06] text-zinc-500"}`}
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
  if (rows.length === 0) return <EmptyNote>Select broker markets to start live coverage and scanning.</EmptyNote>;
  return (
    <ul className="max-h-[32rem] divide-y divide-white/[0.04] overflow-auto [scrollbar-width:thin]">
      {rows.map((row) => {
        const isLive = row.status === "live";
        return (
          <li
            key={row.symbol}
            onClick={() => onSelect(row.symbol)}
            className={`cursor-pointer px-4 py-2.5 transition-colors ${row.symbol === selected ? "bg-cyan-400/[0.06]" : "hover:bg-white/[0.02]"}`}
            data-testid={`scan-row-${row.symbol}`}
          >
            <div className="flex items-center gap-2.5">
              <DirectionIcon direction={row.direction} />
              <span className="w-[78px] truncate font-mono text-[12px] font-semibold text-zinc-100">{row.symbol}</span>
              <span className={`rounded-md border px-1.5 py-px text-[10px] font-bold ${isLive ? gradeColor(row.grade) : statusClass(row.status)}`}>
                {isLive ? row.grade : row.status}
              </span>
              {isLive ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div className={`h-full rounded-full ${row.score >= 80 ? "bg-emerald-400" : row.score >= 65 ? "bg-amber-400" : "bg-zinc-500"}`} style={{ width: `${Math.min(100, row.score)}%` }} />
                  </div>
                  <span className="w-7 text-right font-mono text-[11px] text-zinc-300">{row.score.toFixed(0)}</span>
                </div>
              ) : (
                <span className="flex-1" />
              )}
              {row.armed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <Ban className="h-3.5 w-3.5 shrink-0 text-zinc-700" />}
            </div>
            <p className="mt-1 line-clamp-1 pl-[22px] text-[11px] leading-snug text-zinc-500">
              {row.armed && row.expectancyR !== null ? `E ${row.expectancyR.toFixed(2)}R · ${((row.winProbability ?? 0) * 100).toFixed(0)}% win · ${row.lots ?? 0} lots` : (row.rejections[0] ?? "No setup")}
            </p>
          </li>
        );
      })}
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
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
      <SectionLabel
        right={
          <span className="font-mono text-[10px] text-zinc-500">
            {evidence.agreeingFamilies}/{evidence.totalFamilies} agree
            {evidence.dissentingFamilies > 0 && <span className="text-amber-400/90"> · {evidence.dissentingFamilies} opposed</span>}
            <span className="text-zinc-600"> · {evidence.timeframe}</span>
          </span>
        }
      >
        Evidence vote
      </SectionLabel>
      <ul className="space-y-2">
        {evidence.factors.map((factor) => (
          <li key={factor.family} className="flex items-center gap-2.5">
            <span className="w-[76px] shrink-0 truncate text-[11px] text-zinc-400">{factor.label}</span>
            <span
              className={`w-9 shrink-0 rounded px-1 py-px text-center text-[9px] font-bold tracking-wider ${
                factor.vote === 1 ? "bg-emerald-400/10 text-emerald-300" : factor.vote === -1 ? "bg-red-400/10 text-red-300" : "bg-white/[0.04] text-zinc-600"
              }`}
            >
              {factor.vote === 1 ? "FOR" : factor.vote === -1 ? "VS" : "—"}
            </span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className={`absolute top-0 h-full rounded-full ${factor.vote === 1 ? "bg-emerald-400" : factor.vote === -1 ? "bg-red-400" : "bg-zinc-600"}`}
                style={{
                  width: `${(Math.abs(factor.contribution) / maxAbs) * 50}%`,
                  left: factor.vote === -1 ? `${50 - (Math.abs(factor.contribution) / maxAbs) * 50}%` : "50%",
                  opacity: 0.45 + 0.55 * factor.reliability,
                }}
                title={`${factor.detail} · reliability ${(factor.reliability * 100).toFixed(0)}%`}
              />
              <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[10px] leading-relaxed text-zinc-500">{evidence.factors[0]?.detail ?? "No statistical evidence available."}</p>
    </div>
  );
}

/** Confidence ring: the grade in the centre, quality as the arc. */
function GradeRing({ grade, score }: { grade: string; score: number }) {
  const size = 64;
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(100, Math.max(0, score));
  const tone = grade === "A+" || grade === "A" ? "text-emerald-300" : grade === "B" ? "text-amber-300" : grade === "C" ? "text-orange-300" : "text-zinc-400";
  const arc = grade === "A+" || grade === "A" ? "#34d399" : grade === "B" ? "#fbbf24" : grade === "C" ? "#fb923c" : "#71717a";
  return (
    <div className="relative flex h-16 w-16 shrink-0 items-center justify-center">
      <svg viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={arc}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        />
      </svg>
      <span className={`font-mono text-xl font-bold ${tone}`}>{grade}</span>
    </div>
  );
}

export function AgentPane({ decision, horizonMinutes, onArm, arming, armError }: { decision: AgentDecision | null; horizonMinutes: number; onArm: () => void; arming: boolean; armError: string | null }) {
  if (!decision) return <EmptyNote>Select a market with a fresh live quote to run the agent.</EmptyNote>;
  const { confluence, monteCarlo, sizing } = decision;
  const up = confluence.direction === "up";
  const down = confluence.direction === "down";
  const quality = Math.min(100, Math.max(0, decision.qualityScore));
  const threshold = Math.min(100, Math.max(0, decision.qualityThreshold));
  const barTone = decision.qualityScore >= decision.qualityThreshold + 10 ? "bg-emerald-400" : decision.qualityScore >= decision.qualityThreshold ? "bg-amber-400" : "bg-zinc-500";

  return (
    <div className="space-y-4 p-4">
      {decision.news.status !== "clear" && (
        <div className={`flex gap-2 rounded-xl border p-2.5 text-[11px] leading-snug ${decision.news.status === "blackout" ? "border-red-500/40 bg-red-500/10 text-red-200" : "border-amber-500/40 bg-amber-500/10 text-amber-200"}`}>
          <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{decision.news.reason}</span>
        </div>
      )}

      {/* Verdict: grade, direction and the quality gate, read at a glance. */}
      <div className="flex items-center gap-4">
        <GradeRing grade={confluence.grade} score={quality} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <DirectionIcon direction={confluence.direction} />
            <span className={`text-base font-semibold ${up ? "text-emerald-300" : down ? "text-red-300" : "text-zinc-300"}`}>
              {confluence.direction === "none" ? "No bias" : up ? "Long bias" : "Short bias"}
            </span>
          </div>
          {/*
            The horizon is the DECISION's horizon, not the mode's nominal one.
            It used to be printed from the mode while the simulation ran on the
            fastest scored frame, so the pane described a trade nobody analysed.
          */}
          <p className="mt-0.5 text-[11px] leading-snug text-zinc-500">
            Horizon ≈ {decision.horizonMinutes ?? horizonMinutes} min{decision.entryTimeframe ? ` (${decision.entryTimeframe})` : ""} · confluence {confluence.score.toFixed(0)}
            {decision.evidence ? ` · evidence ${decision.evidence.confidence.toFixed(0)}` : ""}
            {!confluence.higherTimeframeAligned && ` · higher timeframe opposed (−${confluence.contextPenalty.toFixed(0)})`}
          </p>
          <div className="relative mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className={`h-full rounded-full ${barTone}`} style={{ width: `${quality}%` }} />
            </div>
            <span className="absolute -top-1 h-3.5 w-px bg-zinc-200/70" style={{ left: `${threshold}%` }} title="Arming threshold" />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10px] text-zinc-500">
            <span>quality {decision.qualityScore.toFixed(0)}</span>
            <span>threshold {decision.qualityThreshold.toFixed(0)}</span>
          </div>
        </div>
      </div>

      {decision.evidence && <EvidenceBlock evidence={decision.evidence} />}

      {monteCarlo && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Win" value={`${(monteCarlo.winProbability * 100).toFixed(0)}%`} />
          <Metric label="Net E" value={`${monteCarlo.expectancyR >= 0 ? "+" : ""}${monteCarlo.expectancyR.toFixed(2)}R`} tone={monteCarlo.expectancyR > 0 ? "good" : "bad"} />
          <Metric label="R:R" value={monteCarlo.rewardRisk.toFixed(1)} />
          <Metric label="Bars" value={monteCarlo.meanBarsToResolve.toFixed(0)} />
        </dl>
      )}

      {/*
        The cost budget, in R. This is the number that decides whether a setup
        can pay for itself. `stop widened` is stated explicitly: a risk unit
        that had to be widened to cover the spread is a fact about the trade.
      */}
      {decision.costR !== null && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-zinc-400">
          <span className="font-mono">Cost {(decision.costR * 100).toFixed(0)}% of the risk unit</span>
          <span className="text-zinc-700">·</span>
          <span>stop {decision.stopWidened ? "widened to cover it" : "structural"}</span>
          <span className="text-zinc-700">·</span>
          <span className={decision.costR <= 0.25 ? "text-emerald-300/90" : "text-amber-300/90"}>
            {decision.costR <= 0.25 ? "edge can clear it" : "wide for this market"}
          </span>
        </div>
      )}

      <section>
        <SectionLabel>Timeframe agreement</SectionLabel>
        <div className="space-y-2">
          {confluence.views.map((view) => (
            <div key={view.timeframe} className="flex items-center gap-2.5 text-[11px]">
              <span className="w-7 font-mono text-zinc-500">{view.timeframe}</span>
              <span className={`w-[78px] truncate ${regimeColor(view.kind)}`}>{view.kind}</span>
              <div className="relative h-1.5 flex-1 rounded-full bg-white/[0.06]">
                <span className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
                <div
                  className={`absolute top-0 h-full rounded-full ${view.contribution >= 0 ? "bg-emerald-400" : "bg-red-400"}`}
                  style={{
                    width: `${Math.min(50, Math.abs(view.contribution) * 110)}%`,
                    left: view.contribution >= 0 ? "50%" : `${50 - Math.min(50, Math.abs(view.contribution) * 110)}%`,
                  }}
                />
              </div>
              <span className="w-7 text-right font-mono text-zinc-500">{view.rsi.toFixed(0)}</span>
            </div>
          ))}
        </div>
      </section>

      {sizing && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
          <SectionLabel>Position sizing</SectionLabel>
          <p className="font-mono text-[11px] leading-relaxed text-zinc-300">{sizing.explanation}</p>
        </div>
      )}

      {decision.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-300/80">
            <AlertTriangle className="h-3 w-3" />Carried cautions
          </p>
          <ul className="space-y-1.5">
            {decision.warnings.map((warning) => (
              <li key={warning} className="flex gap-2 text-[11px] leading-snug text-amber-200/85">
                <span className="text-amber-500/70">•</span>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {decision.armed && decision.plan ? (
        <div className="space-y-3 overflow-hidden rounded-2xl border border-emerald-400/25 bg-gradient-to-b from-emerald-400/[0.08] to-transparent p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />A+ live setup — ready to arm
          </div>
          <div className="grid grid-cols-3 gap-2">
            <PlanLevel label="Trigger" value={formatPrice(decision.plan.trigger)} />
            <PlanLevel label="Stop" value={formatPrice(decision.plan.sl)} tone="bad" />
            <PlanLevel label="Target" value={formatPrice(decision.plan.tp[0] ?? decision.plan.trigger)} tone="good" />
          </div>
          <button
            type="button"
            onClick={onArm}
            disabled={arming}
            className="w-full rounded-xl bg-gradient-to-r from-emerald-400 to-cyan-300 py-2.5 text-xs font-semibold text-zinc-950 shadow-[0_0_24px_-6px_rgba(52,211,153,0.7)] transition-all hover:brightness-110 disabled:opacity-50"
            data-testid="arm-plan"
          >
            {arming ? "Arming…" : `Arm ${decision.plan.side.toUpperCase()} ${decision.plan.lots} lots`}
          </button>
          {armError && (
            <p className="flex gap-1.5 text-[11px] leading-snug text-amber-300">
              <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
              {armError}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <XCircle className="h-4 w-4 text-zinc-500" />No trade
          </div>
          <ul className="space-y-1.5">
            {decision.rejections.map((reason) => (
              <li key={reason} className="flex gap-2 text-[11px] leading-snug text-zinc-500">
                <span className="text-zinc-700">•</span>
                {reason}
              </li>
            ))}
            {decision.rejections.length === 0 && <li className="text-[11px] text-zinc-500">Waiting for a qualifying setup.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function PlanLevel({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-zinc-100";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-zinc-950/60 px-2.5 py-2">
      <p className="text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-xs font-semibold tabular-nums ${colour}`}>{value}</p>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-red-300" : "text-zinc-100";
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-center">
      <dt className="text-[9px] font-medium uppercase tracking-[0.14em] text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 font-mono text-sm font-semibold tabular-nums ${colour}`}>{value}</dd>
    </div>
  );
}

// ── Positions / plans / risk ─────────────────────────────────────────────────

export function PositionsPane({ positions, currency, onClose }: { positions: Position[]; currency: string; onClose: (ticket: number) => void }) {
  if (positions.length === 0) return <p className="p-4 text-xs text-zinc-500">No open terminal positions.</p>;
  return <div className="overflow-auto"><table className="w-full min-w-[500px] text-[11px] font-mono"><thead className="bg-zinc-950 text-zinc-500"><tr className="border-b border-white/[0.06]"><th className="px-2 py-2 text-left font-medium">Symbol</th><th className="px-2 py-2 text-right font-medium">Vol</th><th className="px-2 py-2 text-right font-medium">Entry</th><th className="px-2 py-2 text-right font-medium">SL</th><th className="px-2 py-2 text-right font-medium">P&L</th><th className="px-2 py-2" /></tr></thead><tbody>{positions.map((position) => { const net = position.profit + position.swap + position.commission; return <tr key={position.ticket} className="border-b border-white/[0.04]"><td className="px-2 py-2"><span className="flex items-center gap-1"><DirectionIcon direction={position.side} /><span className="text-zinc-200">{position.symbol}</span></span></td><td className="px-2 py-2 text-right text-zinc-300">{position.volume}</td><td className="px-2 py-2 text-right text-zinc-400">{position.openPrice}</td><td className="px-2 py-2 text-right text-zinc-500">{position.sl ?? "—"}</td><td className={`px-2 py-2 text-right ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>{formatMoney(net, currency)}</td><td className="px-2 py-2 text-right"><button type="button" onClick={() => onClose(position.ticket)} className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:border-red-500/50 hover:text-red-400">Close</button></td></tr>; })}</tbody></table></div>;
}

export function ArmedPlansPane({ plans, onCancel }: { plans: DeskStateResponse["plans"]; onCancel: (id: string) => void }) {
  if (plans.length === 0) return <p className="p-4 text-xs leading-relaxed text-zinc-500">No plans are armed. The agent only creates one after live data, risk and red-folder news gates all pass.</p>;
  return <ul className="divide-y divide-white/[0.04]">{plans.map((plan) => <li key={plan.id} className="px-3 py-2 text-[10px] font-mono"><div className="flex items-center gap-1.5"><span className={plan.side === "buy" ? "text-emerald-400" : "text-red-400"}>{plan.side.toUpperCase()}</span><span className="text-zinc-200">{plan.symbol}</span><span className="text-zinc-500">{plan.lots} lots</span><button type="button" onClick={() => onCancel(plan.id)} className="ml-auto text-zinc-600 transition-colors hover:text-red-400">cancel</button></div><div className="mt-1 leading-relaxed text-zinc-600">trg {plan.trigger} · sl {plan.sl} · tp {plan.tp[0]} · expires in {Math.max(0, Math.round((plan.expiresAt - Date.now()) / 1000))}s</div></li>)}</ul>;
}

export function RiskPane({ state, onResume }: { state: DeskStateResponse; onResume: (symbol: string) => void }) {
  const { risk, account, policy } = state;
  if (!account || !risk.budget) return <p className="p-4 text-xs text-zinc-500">Risk budget is calculated only after the paired terminal sends a real account snapshot.</p>;
  const budgetColour = risk.budget.usedPct >= 80 ? "bg-red-500" : risk.budget.usedPct >= 50 ? "bg-amber-500" : "bg-emerald-500";
  return <div className="space-y-3 p-3 text-[11px]">{risk.state.haltedUntilNextSession && <div className="flex gap-1.5 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300"><ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" /><span className="text-[10px] leading-snug">{risk.state.haltReason}</span></div>}<div><div className="mb-1 flex justify-between gap-2 text-[10px] text-zinc-500"><span>Daily loss budget</span><span className="font-mono text-right">{formatMoney(risk.budget.remainingMoney, account.currency)} left of {formatMoney(risk.budget.limitMoney, account.currency)}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className={`h-full ${budgetColour}`} style={{ width: `${risk.budget.usedPct}%` }} /></div></div><dl className="grid grid-cols-2 gap-2"><Stat label="Equity" value={formatMoney(account.equity, account.currency)} /><Stat label="Balance" value={formatMoney(account.balance, account.currency)} /><Stat label="Free margin" value={formatMoney(account.freeMargin, account.currency)} /><Stat label="Margin level" value={Number.isFinite(account.marginLevel) ? `${account.marginLevel.toFixed(0)}%` : "∞"} /><Stat label="Loss streak" value={String(risk.state.consecutiveLosses)} /><Stat label="Trades today" value={String(risk.state.tradesToday)} /></dl>{risk.exposure.length > 0 && <div><p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Net exposure (cap {policy.maxCurrencyExposurePct}%)</p><div className="space-y-1">{risk.exposure.map((entry) => <div key={entry.key} className="flex items-center gap-2 font-mono text-[10px]"><span className="w-12 text-zinc-400">{entry.key}</span><div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]"><div className={entry.riskPct >= policy.maxCurrencyExposurePct ? "h-full bg-red-500" : "h-full bg-sky-500"} style={{ width: `${Math.min(100, (entry.riskPct / policy.maxCurrencyExposurePct) * 100)}%` }} /></div><span className="w-10 text-right text-zinc-500">{entry.riskPct.toFixed(2)}%</span></div>)}</div></div>}{risk.state.suspendedSymbols.length > 0 && <div><p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Suspended — awaiting regime change</p><div className="flex flex-wrap gap-1">{risk.state.suspendedSymbols.map((symbol) => <button key={symbol} type="button" onClick={() => onResume(symbol)} className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300 transition-colors hover:bg-amber-500/20">{symbol} ↻</button>)}</div></div>}</div>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-2 py-1.5"><dt className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</dt><dd className="font-mono text-[11px] text-zinc-200">{value}</dd></div>; }

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
  /**
   * EMPTY IS NOT AN ALL-CLEAR.
   *
   * The terminal can (and does) return a successful, empty calendar read while
   * MT5 is still syncing its economic calendar database. The old pane rendered
   * that as "No high-impact events in the next 24 hours. The gate stays armed."
   * — claiming a calm the terminal had never verified, while the broker's own
   * calendar tab was showing three red-folder releases. `rawCount` is the row
   * count BEFORE filtering; zero means "no data", and the pane now says so.
   */
  const unverified = feed.rawCount === 0 && events.length === 0;
  const ahead = events.filter((event) => !event.passed);
  const behind = events.filter((event) => event.passed);

  /**
   * ── SAY WHAT WAS READ ─────────────────────────────────────────────────────
   *
   * "0 red-folder events" is only meaningful next to the span it describes.
   * The EA that was being served by the Desk's download button read a
   * two-hour window and reported nothing about it, so a session with three
   * red-folder releases still on the terminal's own calendar rendered as "No
   * high-impact events in the next 24 hours" — a claim for a day the terminal
   * had never looked at. The covered range is now stated, and when it does not
   * reach the next 24 hours the pane says that too, instead of quietly
   * narrowing the promise.
   */
  const coveredFrom = typeof feed.windowFromMs === "number" ? feed.windowFromMs : null;
  const coveredTo = typeof feed.windowToMs === "number" ? feed.windowToMs : null;
  const coveredLabel =
    coveredFrom !== null && coveredTo !== null
      ? `${formatInZone(coveredFrom, timeZone, { hour: "2-digit", minute: "2-digit" })} → ${formatInZone(coveredTo, timeZone, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
      : null;
  const coversNext24h = coveredTo !== null && coveredTo - now >= 20 * 60 * 60_000;

  return (
    <div className="divide-y divide-white/[0.04]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 text-[10px] uppercase tracking-wider text-zinc-500">
        <span className="flex items-center gap-1"><Globe className="h-3 w-3" />Next 24 h · {ahead.length} red-folder {ahead.length === 1 ? "event" : "events"}</span>
        {behind.length > 0 && <><span className="text-zinc-700">·</span><span>{behind.length} earlier today</span></>}
        <span className="text-zinc-700">·</span>
        <span>{zoneAbbreviation(now, timeZone)} · {timeZone.replace("_", " ")}</span>
      </div>
      {unverified ? (
        <div className="flex gap-2 p-3 text-[11px] leading-relaxed text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The terminal returned no calendar rows at all, so "no high-impact events" cannot be confirmed — MT5's economic
            calendar is most likely still syncing. Compare it with the terminal's own Calendar tab; new entries stay paused
            until the read succeeds.
          </span>
        </div>
      ) : events.length === 0 ? (
        <div className="p-4 text-xs text-zinc-500">
          <p>
            No red-folder releases in the range the terminal read{coveredLabel ? <> (<span className="text-zinc-400">{coveredLabel}</span>)</> : null}.
            The gate stays armed for new entries — the calendar is re-read by the terminal every minute.
          </p>
          {coveredLabel && !coversNext24h && (
            <p className="mt-2 flex gap-1.5 text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This terminal reports a narrower calendar window than the Desk lists, so a release later in the day would not
                appear here even though MT5's own Calendar tab shows it. Re-download the EA from this dialog and recompile it in
                MetaEditor to cover the last 12 h and the next 24 h.
              </span>
            </p>
          )}
        </div>
      ) : (
        events.map((event) => <NewsRow key={event.id} event={event} timeZone={timeZone} />)
      )}
      <p className="flex items-center gap-1.5 px-3 py-2 text-[9px] text-zinc-600">
        <Clock3 className="h-3 w-3" />Calendar checked {feed.checkedAt ? relativeTime(feed.checkedAt) : "never"}
        {typeof feed.rawCount === "number" && ` · ${feed.rawCount} row${feed.rawCount === 1 ? "" : "s"} read from MT5`}
        {coveredLabel && ` · covered ${coveredLabel}`}
        {" "}· new entries fail closed if this feed goes stale.
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
  const imminent = !event.passed && event.time - now <= 30 * 60_000 && event.time >= now - 15 * 60_000;
  return (
    <div className={`flex gap-2 px-3 py-2 ${event.next ? "bg-red-500/5" : event.passed ? "opacity-60" : ""}`}>
      <CalendarDays className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${imminent ? "text-red-400" : "text-red-400/70"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="rounded bg-red-500/15 px-1 text-[9px] font-bold text-red-300">{event.currency || "HIGH"}</span>
          <span className="truncate text-[11px] text-zinc-200">{event.name}</span>
          {event.next && <span className="shrink-0 rounded border border-red-500/40 px-1 text-[8px] uppercase tracking-wider text-red-300">next</span>}
          {/* Released earlier today: it is why the session is quiet, so it stays
              on the list — greyed, labelled, and not counted as upcoming. */}
          {event.passed && <span className="shrink-0 rounded border border-zinc-700 px-1 text-[8px] uppercase tracking-wider text-zinc-500">released</span>}
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
          <p className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Equity curve</p>
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
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">P&amp;L by symbol</p>
          <ul className="space-y-1.5">
            {bySymbol.slice(0, 8).map((entry) => (
              <li key={entry.symbol} className="flex items-center gap-2">
                <span className="w-16 shrink-0 truncate font-mono text-[10px] text-zinc-300">{entry.symbol}</span>
                <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
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
          <p className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">Recently closed</p>
          <ul className="divide-y divide-white/[0.04] overflow-hidden rounded-lg border border-white/[0.04]">
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
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] p-2">
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
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] px-2 py-1.5">
      <dt className="truncate text-[10px] uppercase tracking-wider text-zinc-500">{label}</dt>
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
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.04] px-3 py-1.5">
        <div className="flex gap-1 overflow-x-auto">{(["all", "signal", "execution", "risk"] as const).map((kind) => <button key={kind} type="button" onClick={() => setFilter(kind)} className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider transition-colors ${filter === kind ? "bg-zinc-800 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"}`}>{kind}</button>)}</div>
        <span className="shrink-0 font-mono text-[9px] text-zinc-600">{zoneAbbreviation(Date.now(), timeZone)}</span>
      </div>
      <ul className="max-h-72 divide-y divide-white/[0.04] overflow-auto [scrollbar-width:thin]">
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
