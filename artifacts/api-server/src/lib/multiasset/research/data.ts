/**
 * Desk v4 research harness — MT5 data loader (WP2).
 *
 * ── HOW TO EXPORT DATA FROM METATRADER 5 ─────────────────────────────────────
 *
 * The harness reads MetaTrader's own CSV exports. Nothing else is required and
 * no broker API is contacted.
 *
 * M1 BARS (the primary input)
 *   1. In MT5: View → Symbols → select the symbol → "Bars" tab. (Or right-click
 *      a chart of the symbol → Symbols → Bars.)
 *   2. Request the history range you want, then use "Export" (the toolbar
 *      button in the Bars tab) and save as CSV.
 *   3. The produced columns are, in order:
 *        <DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<SPREAD>\t<REALVOL>
 *      Tab-separated, with the datetime in the terminal's SERVER timezone. The
 *      SPREAD column is in POINTS. Both facts are handled below (see
 *      `clock` in the returned Dataset and the `--broker-offset` CLI flag).
 *   4. Alternatively, for a scripted export of exactly the window you want,
 *      run this on a chart of the symbol (MT5 → Tools → MetaQuotes Language
 *      Editor → new Script):
 *
 *        void OnStart() {
 *          MqlRates rates[];
 *          int copied = CopyRates(_Symbol, PERIOD_M1, 0, 200000, rates);
 *          int h = FileOpen(_Symbol + "_M1.csv", FILE_WRITE|FILE_CSV|FILE_ANSI, ',');
 *          for (int i = 0; i < copied; i++) {
 *            FileWrite(h, TimeToString(rates[i].time, TIME_DATE|TIME_MINUTES),
 *                      DoubleToString(rates[i].open, _Digits),
 *                      DoubleToString(rates[i].high, _Digits),
 *                      DoubleToString(rates[i].low, _Digits),
 *                      DoubleToString(rates[i].close, _Digits),
 *                      (string)rates[i].tick_volume,
 *                      (string)rates[i].spread);
 *          }
 *          FileClose(h);
 *        }
 *
 *      The file lands in MQL5/Files/ inside the terminal's data folder.
 *
 * TICKS (only needed for the WP4-D flow agent and WP7 slippage calibration)
 *   1. View → Symbols → symbol → "Ticks" tab → Export. Columns:
 *        <DATE>\t<TIME>\t<BID>\t<ASK>\t<LAST>\t<VOLUME>\t<FLAGS>
 *   2. `parseMt5TicksCsv` reads it; `barsFromTicks` aggregates it to M1 bars and
 *      `spreadProfileFromTicks` builds the minute-of-week spread profile WP7
 *      needs.
 *
 * ── WHAT THIS MODULE GUARANTEES ──────────────────────────────────────────────
 *
 *   • Tolerant of the real-world mess: UTF-8 BOM, CRLF, comma/tab/semicolon
 *     separators, either column order, and a `<DATE> <TIME>` split over two
 *     columns or a single ISO timestamp.
 *   • Rows are returned strictly ascending and de-duplicated by timestamp.
 *     Bars with a non-positive price, or a high below the low, are dropped and
 *     COUNTED, so a malformed export shows up as a note in the report instead
 *     of as silence.
 *   • No lookahead is introduced here: the loader only reshapes the file.
 */

import fs from "node:fs";
import path from "node:path";
import { TIMEFRAME_MINUTES, type Bar, type SymbolSpec, type Timeframe } from "../types";
import type { Dataset } from "./types";

export interface CsvParseResult {
  bars: Bar[];
  /** Spread in points per row, or null when the export had no spread column. */
  spreadPoints: number[] | null;
  rowsRead: number;
  rowsDropped: number;
  /** Reasons rows were dropped, for the report. Never silently swallowed. */
  notes: string[];
}

/** Milliseconds in one bar of a timeframe. */
export function timeframeMs(timeframe: Timeframe): number {
  return TIMEFRAME_MINUTES[timeframe] * 60_000;
}

/** Split a CSV/TSV line on any of the common separators, honouring quotes. */
function splitLine(line: string): string[] {
  const separator = line.includes("\t") ? "\t" : line.includes(";") ? ";" : ",";
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === separator && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((value) => value.trim());
}

/**
 * Parse a MetaTrader datetime.
 *
 * MT5 writes either `YYYY.MM.DD HH:MM[:SS]` (with the date and time often in
 * separate columns) or `YYYY.MM.DD` alone for daily data. The value is in the
 * BROKER's server timezone; the loader deliberately does NOT shift it, because
 * doing so silently would make the session rules depend on an assumption. The
 * caller records the offset in `Dataset.clock` and any session-sensitive
 * analysis applies it explicitly.
 */
export function parseMt5DateTime(dateText: string, timeText = ""): number | null {
  const combined = `${dateText} ${timeText}`.trim();
  const match = combined.match(
    /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = match[4] ? Number(match[4]) : 0;
    const minute = match[5] ? Number(match[5]) : 0;
    const second = match[6] ? Number(match[6]) : 0;
    // Date.UTC keeps the reading as if the wall clock were UTC — which is what
    // "the broker's clock" means until an offset is applied.
    return Date.UTC(year, month - 1, day, hour, minute, second);
  }
  // ISO fallback, for exports run through other tooling.
  const iso = Date.parse(combined.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(combined) ? "" : "Z"));
  return Number.isFinite(iso) ? iso : null;
}

/** Numeric parse that returns NaN rather than throwing on junk. */
function num(text: string | undefined): number {
  if (text === undefined) return NaN;
  const cleaned = text.replace(/\s/g, "").replace(/(?<=\d),(?=\d{3}\b)/g, "");
  return Number(cleaned);
}

/**
 * Parse an M1 (or any timeframe) bars CSV.
 *
 * Column detection is by header when a header is present, and by METATRADER'S
 * FIXED ORDER when it is not — because the standard export has no header at
 * all, and guessing there would misread the spread column as volume.
 */
export function parseMt5BarsCsv(text: string): CsvParseResult {
  const notes: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const rows: { ts: number; bar: Bar; spread: number }[] = [];
  let rowsRead = 0;
  let rowsDropped = 0;
  let spreadColumnSeen = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const cells = splitLine(line);
    if (cells.length < 5) {
      rowsRead += 1;
      rowsDropped += 1;
      continue;
    }
    // Skip a header row.
    if (/^(date|time|datetime|open)$/i.test(cells[0]!) || /[A-Za-z]/.test(cells[0]!) && !/^\d/.test(cells[0]!)) {
      continue;
    }
    rowsRead += 1;

    const ts = parseMt5DateTime(cells[0]!, /^\d{1,2}:\d{2}/.test(cells[1] ?? "") ? cells[1]! : "");
    if (ts === null) {
      rowsDropped += 1;
      continue;
    }
    // With a split date/time, the OHLC starts at index 2; otherwise at 1.
    const splitDateTime = /^\d{1,2}:\d{2}/.test(cells[1] ?? "");
    const base = splitDateTime ? 2 : 1;
    const open = num(cells[base]);
    const high = num(cells[base + 1]);
    const low = num(cells[base + 2]);
    const close = num(cells[base + 3]);
    const volume = num(cells[base + 4]);
    const spread = num(cells[base + 5]);

    if (
      ![open, high, low, close].every((value) => Number.isFinite(value) && value > 0) ||
      high < low
    ) {
      rowsDropped += 1;
      continue;
    }
    if (Number.isFinite(spread)) spreadColumnSeen = true;
    rows.push({
      ts,
      bar: [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0],
      spread: Number.isFinite(spread) && spread > 0 ? spread : NaN,
    });
  }

  if (rows.length === 0) {
    notes.push("No usable rows were found in the CSV. Check the export format.");
    return { bars: [], spreadPoints: null, rowsRead, rowsDropped, notes };
  }

  // Strictly ascending, de-duplicated. A duplicate timestamp keeps the LAST
  // row, which is what MetaTrader's own export does when it re-writes a bar.
  rows.sort((a, b) => a.ts - b.ts);
  const deduped: typeof rows = [];
  for (const row of rows) {
    if (deduped.length > 0 && deduped[deduped.length - 1]!.ts === row.ts) deduped[deduped.length - 1] = row;
    else deduped.push(row);
  }
  if (deduped.length !== rows.length) {
    notes.push(`Dropped ${rows.length - deduped.length} duplicate timestamp(s).`);
  }
  if (rowsDropped > 0) notes.push(`Dropped ${rowsDropped} unparseable row(s).`);

  const hasSpread = spreadColumnSeen && deduped.some((row) => Number.isFinite(row.spread));
  if (!hasSpread) {
    notes.push(
      "The export carried no usable SPREAD column; the harness will fall back to the symbol spec's spread.",
    );
  }

  return {
    bars: deduped.map((row) => row.bar),
    spreadPoints: hasSpread ? deduped.map((row) => row.spread) : null,
    rowsRead,
    rowsDropped,
    notes,
  };
}

export interface TickRow {
  ts: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
}

/** Parse a MetaTrader ticks CSV (DATE, TIME, BID, ASK, LAST, VOLUME, FLAGS). */
export function parseMt5TicksCsv(text: string): { ticks: TickRow[]; notes: string[] } {
  const notes: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let dropped = 0;
  const ticks: TickRow[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const cells = splitLine(line);
    if (cells.length < 4) continue;
    if (/[A-Za-z]/.test(cells[0]!) && !/^\d/.test(cells[0]!)) continue;
    const splitDateTime = /^\d{1,2}:\d{2}/.test(cells[1] ?? "");
    const ts = parseMt5DateTime(cells[0]!, splitDateTime ? cells[1]! : "");
    if (ts === null) {
      dropped += 1;
      continue;
    }
    const base = splitDateTime ? 2 : 1;
    const bid = num(cells[base]);
    const ask = num(cells[base + 1]);
    if (!Number.isFinite(bid) || bid <= 0) {
      dropped += 1;
      continue;
    }
    ticks.push({
      ts,
      bid,
      ask: Number.isFinite(ask) && ask > 0 ? ask : bid,
      last: num(cells[base + 2]) || bid,
      volume: num(cells[base + 3]) || 0,
    });
  }
  ticks.sort((a, b) => a.ts - b.ts);
  if (dropped > 0) notes.push(`Dropped ${dropped} unparseable tick row(s).`);
  if (ticks.length === 0) notes.push("No usable ticks were found in the CSV.");
  return { ticks, notes };
}

/** Aggregate finer bars into a coarser timeframe, aligned to the epoch. */
export function aggregateBars(bars: Bar[], timeframe: Timeframe): Bar[] {
  const width = timeframeMs(timeframe);
  if (width <= 0 || bars.length === 0) return [];
  const out: Bar[] = [];
  let current: Bar | null = null;
  for (const bar of bars) {
    const bucket = Math.floor(bar[0] / width) * width;
    if (!current || current[0] !== bucket) {
      if (current) out.push(current);
      current = [bucket, bar[1], bar[2], bar[3], bar[4], bar[5]];
    } else {
      current[2] = Math.max(current[2], bar[2]);
      current[3] = Math.min(current[3], bar[3]);
      current[4] = bar[4];
      current[5] += bar[5];
    }
  }
  if (current) out.push(current);
  return out;
}

/** Build M1 bars from a tick stream. */
export function barsFromTicks(ticks: TickRow[]): Bar[] {
  const out: Bar[] = [];
  let current: Bar | null = null;
  for (const tick of ticks) {
    const bucket = Math.floor(tick.ts / 60_000) * 60_000;
    if (!current || current[0] !== bucket) {
      if (current) out.push(current);
      current = [bucket, tick.bid, tick.bid, tick.bid, tick.bid, tick.volume];
    } else {
      current[2] = Math.max(current[2], tick.bid);
      current[3] = Math.min(current[3], tick.bid);
      current[4] = tick.bid;
      current[5] += tick.volume;
    }
  }
  if (current) out.push(current);
  return out;
}

export interface SpreadProfileEntry {
  /** 0 = Sunday, 1 = Monday … as `Date.getUTCDay()` returns. */
  weekday: number;
  hour: number;
  minute: number;
  medianSpreadPoints: number;
  samples: number;
}

/**
 * Minute-of-week spread profile from ticks — the input WP7's seasonality gate
 * needs. Weeks are indexed by the broker clock as exported, so the profile and
 * the live terminal agree without an offset conversion in the hot path.
 */
export function spreadProfileFromTicks(ticks: TickRow[], point: number): SpreadProfileEntry[] {
  const buckets = new Map<number, number[]>();
  for (const tick of ticks) {
    if (!(tick.ask > tick.bid)) continue;
    const date = new Date(tick.ts);
    const key =
      date.getUTCDay() * 24 * 60 + date.getUTCHours() * 60 + date.getUTCMinutes();
    const spreadPoints = (tick.ask - tick.bid) / point;
    const list = buckets.get(key);
    if (list) list.push(spreadPoints);
    else buckets.set(key, [spreadPoints]);
  }
  const out: SpreadProfileEntry[] = [];
  for (const [key, values] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    values.sort((a, b) => a - b);
    const mid = values[Math.floor(values.length / 2)]!;
    out.push({
      weekday: Math.floor(key / (24 * 60)),
      hour: Math.floor((key % (24 * 60)) / 60),
      minute: key % 60,
      medianSpreadPoints: mid,
      samples: values.length,
    });
  }
  return out;
}

export interface LoadDatasetOptions {
  /** Path to the bars CSV. */
  file: string;
  spec: SymbolSpec;
  /** Broker server offset from UTC in minutes, recorded as provenance. */
  brokerOffsetMinutes?: number;
  /** Constant spread fallback when the export has no spread column. */
  fallbackSpreadPoints?: number;
  notes?: string[];
}

/**
 * Load a bars CSV into a Dataset.
 *
 * The spread function prefers the export's own SPREAD column and falls back to
 * the spec, so the cost model is never accidentally zero.
 */
export function loadDataset(options: LoadDatasetOptions): Dataset {
  const text = fs.readFileSync(options.file, "utf8");
  const parsed = parseMt5BarsCsv(text);
  const notes = [...parsed.notes, ...(options.notes ?? [])];
  const fallback = options.fallbackSpreadPoints ?? options.spec.spreadPoints ?? 1;

  let spreadPointsAt: (ts: number) => number;
  if (parsed.spreadPoints) {
    // Index by timestamp so the simulator can ask for the spread at an
    // arbitrary bar without the caller carrying a parallel array.
    const byTs = new Map<number, number>();
    for (let i = 0; i < parsed.bars.length; i++) {
      const value = parsed.spreadPoints[i];
      byTs.set(parsed.bars[i]![0], Number.isFinite(value) && value! > 0 ? value! : fallback);
    }
    spreadPointsAt = (ts) => byTs.get(ts) ?? fallback;
    notes.push(
      `Spread column used: median ${medianOf([...byTs.values()]).toFixed(1)} pts over ${byTs.size} bars.`,
    );
  } else {
    spreadPointsAt = () => fallback;
    notes.push(`Constant spread of ${fallback} pts used (no spread column in the export).`);
  }

  return {
    source: options.file,
    symbol: options.spec.symbol,
    bars: parsed.bars,
    spreadPointsAt,
    spec: { ...options.spec, spreadPoints: spreadPointsAt(parsed.bars[0]?.[0] ?? 0) },
    clock:
      options.brokerOffsetMinutes && options.brokerOffsetMinutes !== 0
        ? { kind: "broker", offsetMinutes: options.brokerOffsetMinutes }
        : { kind: "utc" },
    notes,
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** Resolve the directory the harness writes reports to, creating it if needed. */
export function reportsDir(cwd = process.cwd()): string {
  const dir = path.resolve(cwd, "research-reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
