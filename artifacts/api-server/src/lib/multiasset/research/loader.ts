/**
 * Research harness — MT5 data loader (WP2).
 *
 * ── HOW TO PRODUCE THE INPUT FILES ──────────────────────────────────────────
 *
 * The harness reads what MetaTrader can export, and nothing else. There is no
 * vendor feed, no downloaded history and no hidden cache: if the numbers are
 * going to decide whether money is risked, the owner has to be able to
 * reproduce them from their own terminal.
 *
 *  BARS (required)
 *    1. Open any chart on the symbol, set the timeframe to M1.
 *    2. Press Home ~40 times (or scroll) so the terminal has the history you
 *       want — at least 6 months for a swing study, 3 months for intraday.
 *    3. View → Symbols → Bars tab, or right-click the chart → "Save As…", and
 *       export as CSV/TXT into a folder.
 *    Alternative, exact and repeatable: Tools → Options → Charts → "Export
 *    bars regularly", or run the bundled script `research-export.mq5` (it
 *    writes `EURUSD_M1.csv` with a header row).
 *    Columns the loader understands (header names are matched case
 *    insensitively, any delimiter, any order):
 *      DATE, TIME, OPEN, HIGH, LOW, CLOSE, TICKVOL, VOL, SPREAD
 *    Files without headers are accepted positionally in that same order.
 *
 *  TICKS (optional, needed only for the flow agent WP4D)
 *    Symbols → the symbol → Ticks tab → Export. Columns:
 *      DATE, TIME, BID, ASK, LAST, VOLUME, (FLAGS)
 *    The EA can also stream ticks live (`StreamTicks = true`), which is how
 *    the flow agent gets its tape in production.
 *
 *  SPREAD — the SPREAD column (in points) is read when present and used as the
 *    per-bar spread series. Without it the strategy's own `spec.spreadPoints`
 *    is applied uniformly, which UNDERSTATES cost on a calm chart and
 *    OVERSTATES it on a news bar; a study that decides anything must use real
 *    spreads.
 *
 * ── TIMEZONE ────────────────────────────────────────────────────────────────
 *
 * MT5 exports timestamps in the BROKER'S SERVER TIME, not UTC. Getting this
 * wrong shifts every bar by 2–3 hours, which silently changes session
 * boundaries, session-close flattens and news windows — the same defect the
 * v3.04 EA fixed on the wire. The loader therefore REQUIRES the offset:
 * `serverUtcOffsetMinutes` (e.g. +180 for GMT+3). It is deliberately not
 * guessed; a wrong guess here is invisible in the results.
 */

import type { Bar, Timeframe } from "../types";
import { TIMEFRAME_MINUTES } from "../types";
import type { SyntheticSeries } from "./generators";

export interface LoadedMarketData {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
  /** Per-bar spread in points, when the file carried a SPREAD column. */
  spreadPoints?: number[];
  /** Tick tape, when a ticks file was supplied. */
  ticks?: { ts: number; bid: number; ask: number }[];
  /** Where the data came from, for the report's provenance line. */
  source: string;
}

export interface LoadOptions {
  symbol: string;
  timeframe: Timeframe;
  /**
   * Minutes the broker's server clock is AHEAD of UTC (GMT+3 ⇒ 180).
   * Required: a guess here is invisible in every number that follows.
   */
  serverUtcOffsetMinutes: number;
  /** Overrides the timeframe inferred from the bars when resampling. */
  sourceTimeframe?: Timeframe;
}

/**
 * Parse MT5 CSV/TXT.
 *
 * The parser is deliberately forgiving about SHAPE (delimiter, header names,
 * column order, decimal commas) and deliberately strict about VALUES: a row
 * whose OHLC cannot be read is skipped rather than defaulted to zero, because a
 * zero price in a bar series produces an infinite return and a strategy that
 * looks brilliant for one bar.
 */
export function parseMt5Csv(
  text: string,
  kind: "bars" | "ticks",
): { rows: Record<string, number>[]; header: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { rows: [], header: [] };

  const delimiter = detectDelimiter(lines[0] as string);
  const firstCells = splitLine(lines[0] as string, delimiter);
  const looksLikeHeader = firstCells.some((c) => /[A-Za-z]/.test(c));
  const header = looksLikeHeader
    ? firstCells.map((c) => c.toUpperCase().replace(/[<>]/g, "").trim())
    : kind === "bars"
      ? ["DATE", "TIME", "OPEN", "HIGH", "LOW", "CLOSE", "TICKVOL", "VOL", "SPREAD"]
      : ["DATE", "TIME", "BID", "ASK", "LAST", "VOLUME"];
  const dataLines = looksLikeHeader ? lines.slice(1) : lines;

  const rows: Record<string, number>[] = [];
  for (const line of dataLines) {
    const cells = splitLine(line, delimiter);
    const row: Record<string, number> = {};
    let hasPrice = false;
    for (let i = 0; i < header.length && i < cells.length; i++) {
      const name = header[i] as string;
      const raw = cells[i] as string;
      if (name === "DATE" || name === "TIME" || name === "") continue;
      // Decimal comma: "1,09345" → 1.09345. Only when there is no dot present,
      // so "1,234.56" (thousands separator) is not mangled.
      const normalised = raw.includes(".") ? raw.replace(/,/g, "") : raw.replace(",", ".");
      const value = Number(normalised);
      if (!Number.isFinite(value)) continue;
      row[name] = value;
      if (name === "OPEN" || name === "HIGH" || name === "LOW" || name === "CLOSE" || name === "BID") {
        hasPrice = true;
      }
    }
    // Timestamp: DATE + TIME columns, or a single DATETIME column.
    const ts = parseTimestamp(cells, header);
    if (ts !== null) row.TS = ts;
    if (hasPrice && row.TS !== undefined) rows.push(row);
  }
  return { rows, header };
}

function detectDelimiter(line: string): string {
  const candidates = ["\t", ";", ","];
  for (const c of candidates) if (line.includes(c)) return c;
  return " ";
}

function splitLine(line: string, delimiter: string): string[] {
  return delimiter === " " ? line.split(/\s+/) : line.split(delimiter).map((c) => c.trim());
}

function parseTimestamp(cells: string[], header: string[]): number | null {
  const indexOf = (name: string): number => header.indexOf(name);
  const dateIdx = indexOf("DATE");
  const timeIdx = indexOf("TIME");
  const stampIdx = indexOf("<DATE>") >= 0 ? indexOf("<DATE>") : indexOf("DATETIME");

  const dateCell = dateIdx >= 0 ? cells[dateIdx] : stampIdx >= 0 ? cells[stampIdx] : cells[0];
  if (!dateCell) return null;
  const timeCell = timeIdx >= 0 ? cells[timeIdx] : stampIdx >= 0 ? cells[stampIdx] : cells[1];
  const datePart = (dateCell ?? "").trim();
  const timePart = (timeCell ?? "00:00:00").trim();
  // MT5 format: 2026.01.05 12:34(:56)
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(datePart);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Seconds and MILLISECONDS: a tick export carries sub-second stamps
  // ("00:00:00.100"), and dropping them collapses a tape into one timestamp per
  // second and destroys every sub-minute feature.
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/.exec(timePart);
  const hour = t ? Number(t[1]) : 0;
  const minute = t ? Number(t[2]) : 0;
  const second = t && t[3] ? Number(t[3]) : 0;
  const millis = t && t[4] ? Number((t[4] as string).padEnd(3, "0")) : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second) + millis;
}

/**
 * Load bars from MT5 text, shift them from server time to UTC, and validate.
 *
 * Validation is the important half: a bar series with a gap, a duplicate or a
 * non-monotone timestamp will produce nonsense in every metric downstream, and
 * the failure is silent. Gaps and duplicates are reported to the caller.
 */
export function loadMt5Bars(
  text: string,
  options: LoadOptions,
): LoadedMarketData & { warnings: string[] } {
  const { rows } = parseMt5Csv(text, "bars");
  const offsetMs = options.serverUtcOffsetMinutes * 60_000;
  const warnings: string[] = [];
  const bars: Bar[] = [];
  const spreadPoints: number[] = [];
  let haveSpread = false;

  for (const row of rows) {
    const o = row.OPEN;
    const h = row.HIGH;
    const l = row.LOW;
    const c = row.CLOSE;
    if (!isPositiveFinite(o) || !isPositiveFinite(h) || !isPositiveFinite(l) || !isPositiveFinite(c)) continue;
    const ts = (row.TS as number) - offsetMs;
    bars.push([ts, o, h, l, c, row.TICKVOL ?? row.VOL ?? 0]);
    if (row.SPREAD !== undefined) {
      haveSpread = true;
      spreadPoints.push(row.SPREAD);
    }
  }

  bars.sort((a, b) => a[0] - b[0]);

  let gaps = 0;
  let duplicates = 0;
  for (let i = 1; i < bars.length; i++) {
    const dt = (bars[i] as Bar)[0] - (bars[i - 1] as Bar)[0];
    if (dt === 0) duplicates++;
    else if (dt > 3 * 60_000) gaps++;
  }
  if (duplicates > 0) warnings.push(`${duplicates} duplicate timestamp(s) — the loader keeps both; check the export range`);
  if (gaps > 0) warnings.push(`${gaps} gap(s) larger than 3 minutes — weekend/holiday breaks are expected, others are not`);
  if (!haveSpread) warnings.push("no SPREAD column: the strategy's uniform spread is used, which understates cost");
  if (bars.length < 500) warnings.push(`only ${bars.length} bars loaded — a study on this is anecdote, not evidence`);

  return {
    symbol: options.symbol,
    timeframe: options.timeframe,
    bars,
    spreadPoints: haveSpread ? spreadPoints : undefined,
    source: `mt5-csv (${bars.length} bars, server offset ${options.serverUtcOffsetMinutes} min)`,
    warnings,
  };
}

/** Load a tick tape (WP4D input). */
export function loadMt5Ticks(
  text: string,
  options: { serverUtcOffsetMinutes: number },
): { ts: number; bid: number; ask: number }[] {
  const { rows } = parseMt5Csv(text, "ticks");
  const offsetMs = options.serverUtcOffsetMinutes * 60_000;
  return rows
    .filter((r) => isPositiveFinite(r.BID) && isPositiveFinite(r.ASK) && r.TS !== undefined)
    .map((r) => ({ ts: (r.TS as number) - offsetMs, bid: r.BID as number, ask: r.ASK as number }))
    .sort((a, b) => a.ts - b.ts);
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Resample M1 bars to a slower frame.
 *
 * Only upward resampling is supported: synthesising minutes the terminal never
 * sent is fabrication, not data. Bars are aligned to the UTC epoch, which is
 * what MT5 does for every intraday frame.
 */
export function resampleBars(bars: Bar[], timeframe: Timeframe): Bar[] {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (minutes <= 1) return bars;
  const widthMs = minutes * 60_000;
  const out: Bar[] = [];
  let bucket: Bar | null = null;
  for (const bar of bars) {
    const start = Math.floor(bar[0] / widthMs) * widthMs;
    if (!bucket || bucket[0] !== start) {
      if (bucket) out.push(bucket);
      bucket = [start, bar[1], bar[2], bar[3], bar[4], bar[5]];
      continue;
    }
    bucket[2] = Math.max(bucket[2], bar[2]);
    bucket[3] = Math.min(bucket[3], bar[3]);
    bucket[4] = bar[4];
    bucket[5] += bar[5];
  }
  if (bucket) out.push(bucket);
  return out;
}

/** Adapt loaded bars to the shape the harness runs on. */
export function toSeries(data: LoadedMarketData): SyntheticSeries & { spreadPoints?: number[] } {
  return {
    kind: "driftless", // real data: the kind is informational only
    bars: data.bars,
    returns: returnsOf(data.bars),
    spreadPoints: data.spreadPoints,
  };
}

function returnsOf(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = (bars[i - 1] as Bar)[4];
    const next = (bars[i] as Bar)[4];
    out.push(prev > 0 && next > 0 ? Math.log(next / prev) : 0);
  }
  return out;
}
