/**
 * v5 Desk — the Markets workspace's four panels.
 *
 * Universe (the broker's whole catalogue with the selection checkboxes),
 * Scanner (every selected market's verdict in one 30px-row table), Auto-select
 * (what the automatic best-market pass last did, and its next pass) and Feed &
 * execution health (the diagnostics that decide whether any of the numbers
 * elsewhere can be trusted).
 *
 * Parity kept from the old desk: the universe checkbox semantics (role=
 * checkbox, disabled when the broker marks a symbol untradeable), the
 * scan-row-* testids, the auto-select report block and its ranked chips, and
 * the "unread calendar is not an all-clear" honesty everywhere a feed can be
 * empty.
 */
import { useMemo, useState, type ReactNode } from "react";
import { RefreshCw, Search } from "lucide-react";

import {
  ASSET_CLASS_LABELS,
  relativeTime,
  type AssetClass,
  type DeskExecutionReport,
  type DeskStateResponse,
  type Market,
  type ScanRow,
} from "@/lib/desk";
import {
  autoSelectSummary,
  formatSignedR,
  nextAutoSelectLabel,
} from "@/lib/desk-ui";

import { Panel } from "../panel";
import { Badge, Chip, PanelEmpty, SkeletonRows, SubHeader, Table, TR, type Tone } from "../primitives";

// ── shared ──────────────────────────────────────────────────────────────────

function feedTone(status: string): Tone {
  if (status === "live") return "up";
  if (status === "warming") return "am";
  if (status === "mismatch") return "dn";
  return "mute";
}

function gradeTone(grade: string): Tone {
  if (grade.startsWith("A")) return "up";
  if (grade.startsWith("B")) return "tx";
  if (grade.startsWith("C")) return "am";
  return "dn";
}

// ── universe ────────────────────────────────────────────────────────────────

export interface UniversePanelProps {
  markets: Market[];
  selected: string[];
  updating: boolean;
  onToggle: (symbol: string, enabled: boolean) => void;
  onFocus: (symbol: string) => void;
  loading?: boolean;
}

export function UniversePanel({ markets, selected, updating, onToggle, onFocus, loading }: UniversePanelProps) {
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState<AssetClass | "all">("all");
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return markets.filter((market) => {
      if (classFilter !== "all" && market.assetClass !== classFilter) return false;
      if (!needle) return true;
      return (
        market.symbol.toLowerCase().includes(needle) ||
        market.description.toLowerCase().includes(needle) ||
        market.path.toLowerCase().includes(needle)
      );
    });
  }, [markets, query, classFilter]);

  const classes = useMemo(() => {
    const present = new Set(markets.map((market) => market.assetClass));
    return (Object.keys(ASSET_CLASS_LABELS) as AssetClass[]).filter((entry) => present.has(entry));
  }, [markets]);

  return (
    <Panel
      id="universe"
      title="Broker universe"
      right={
        <span className="tnum">
          {filtered.length}/{markets.length} · {selected.length} selected
        </span>
      }
      bodyClassName="flex flex-col"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--desk-line)] px-3">
        <Search className="h-3.5 w-3.5 shrink-0 d-mute" aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search symbol, name or path…"
          aria-label="Search the broker universe"
          className="t-body d-tx min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--desk-tx3)]"
          data-testid="universe-search"
        />
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-[var(--desk-line)] px-3" role="group" aria-label="Filter by asset class">
        <Chip active={classFilter === "all"} onClick={() => setClassFilter("all")}>All</Chip>
        {classes.map((entry) => (
          <Chip key={entry} active={classFilter === entry} onClick={() => setClassFilter(entry)}>
            {ASSET_CLASS_LABELS[entry]}
          </Chip>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {loading && markets.length === 0 ? (
          <SkeletonRows rows={8} columns={2} />
        ) : filtered.length === 0 ? (
          <PanelEmpty>
            {markets.length === 0
              ? "The EA has not reported the broker catalogue yet."
              : "No broker market matches this filter."}
          </PanelEmpty>
        ) : (
          <Table id="universe" head={[null, "Market", "Class"]}>
            {filtered.map((market) => {
              const isSelected = selectedSet.has(market.symbol);
              return (
                <TR key={market.symbol} selected={isSelected} data-testid={`universe-row-${market.symbol}`}>
                  <span className="flex items-center justify-center">
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={`${isSelected ? "Remove" : "Select"} ${market.symbol} for live coverage`}
                      disabled={!market.tradeable || updating}
                      onClick={() => onToggle(market.symbol, !isSelected)}
                      className={`desk-chip h-4 w-4 justify-center rounded-[3px] p-0 ${isSelected ? "desk-chip-active" : ""}`}
                      title={market.tradeable ? (isSelected ? "Remove from live coverage" : "Select for live coverage") : "Broker marks this symbol unavailable"}
                    >
                      {isSelected ? <span aria-hidden="true" className="text-[9px] leading-none">✓</span> : null}
                    </button>
                  </span>
                  <button type="button" className="flex min-w-0 flex-col justify-center text-left" onClick={() => onFocus(market.symbol)} title={`Show ${market.symbol} on the Command workspace`}>
                    <span className="t-body d-tx truncate">{market.symbol}</span>
                    <span className="t-cap d-mute truncate">{market.description || market.path || ASSET_CLASS_LABELS[market.assetClass]}</span>
                  </button>
                  <span className="flex items-center justify-end">
                    <Badge tone={isSelected ? feedTone(market.dataStatus) : "mute"}>{ASSET_CLASS_LABELS[market.assetClass]}</Badge>
                  </span>
                </TR>
              );
            })}
          </Table>
        )}
      </div>
    </Panel>
  );
}

// ── scanner ─────────────────────────────────────────────────────────────────

export interface ScannerPanelProps {
  rows: ScanRow[];
  coverage: { selected: number; live: number; warming: number; stale: number } | null;
  selected: string;
  onSelect: (symbol: string) => void;
  onRescan: () => void;
  scanning: boolean;
  /** Rescan needs a live terminal. */
  enabled: boolean;
  loading?: boolean;
}

export function ScannerPanel({ rows, coverage, selected, onSelect, onRescan, scanning, enabled, loading }: ScannerPanelProps) {
  return (
    <Panel
      id="scanner"
      title="Live scanner"
      right={
        <>
          {coverage ? (
            <span className="tnum" data-testid="scan-coverage">
              <span className="d-up">{coverage.live} fresh</span>
              <span className="d-mute"> · </span>
              <span className={coverage.warming > 0 ? "d-am" : "d-mute"}>{coverage.warming} warming</span>
              <span className="d-mute"> · </span>
              <span className={coverage.stale > 0 ? "d-am" : "d-mute"}>{coverage.stale} stale</span>
              <span className="d-mute"> / {coverage.selected} selected</span>
            </span>
          ) : null}
          <button
            type="button"
            className="desk-btn"
            style={{ height: 22, padding: "0 6px" }}
            disabled={!enabled || scanning}
            onClick={onRescan}
            aria-label="Rescan selected markets"
            title="Rescan every selected market now"
            data-testid="rescan"
          >
            <RefreshCw className={`h-3 w-3 ${scanning ? "animate-spin" : ""}`} aria-hidden="true" />
          </button>
        </>
      }
    >
      {loading && rows.length === 0 ? (
        <SkeletonRows rows={6} columns={5} />
      ) : rows.length === 0 ? (
        <PanelEmpty>Select broker markets to start live coverage and scanning.</PanelEmpty>
      ) : (
        <Table
          id="scanner"
          head={["Market", "Status", "Gr", "Score", "Dir", "Win%", "R:R fill", "Edge", "Lots", "Risk", "Why"]}
        >
          {rows.map((row) => (
            <TR
              key={row.symbol}
              selected={row.symbol === selected}
              onClick={() => onSelect(row.symbol)}
              data-testid={`scan-row-${row.symbol}`}
              title={row.summary || row.rejections[0] || undefined}
            >
              <span className="t-body d-tx truncate">{row.symbol}</span>
              <span className="flex items-center">
                <Badge tone={feedTone(row.status)}>{row.status}</Badge>
              </span>
              <span className={`text-center ${row.status === "live" ? `d-${gradeTone(row.grade)}` : "d-mute"}`}>
                {row.status === "live" ? row.grade : "—"}
              </span>
              <Cell right>{row.status === "live" ? row.score.toFixed(0) : "—"}</Cell>
              <span className="flex items-center justify-center" title={row.direction === "none" ? "No direction" : `Direction: ${row.direction}`}>
                {row.direction === "up" ? <span className="d-up" aria-hidden="true">▲</span> : row.direction === "down" ? <span className="d-dn" aria-hidden="true">▼</span> : <span className="d-mute">—</span>}
                <span className="sr-only">{row.direction}</span>
              </span>
              <Cell right>{row.winProbability !== null ? `${Math.round(row.winProbability * 100)}%` : "—"}</Cell>
              <Cell right title={row.edgeRequiredR !== null && row.edgeRequiredR !== undefined ? `The mode requires ${row.edgeRequiredR}R` : undefined}>
                {row.rrFill !== null && row.rrFill !== undefined ? `${row.rrFill.toFixed(2)}` : "—"}
              </Cell>
              <Cell right tone={row.expectancyR !== null && row.expectancyR > 0 ? "up" : row.expectancyR !== null ? "dn" : undefined} title={row.edgeFloorR !== null && row.edgeFloorR !== undefined ? `EV at the lower bound: ${row.edgeFloorR.toFixed(2)}R` : undefined}>
                {row.expectancyR !== null ? formatSignedR(row.expectancyR) : "—"}
              </Cell>
              <Cell right>{row.lots !== null ? row.lots : "—"}</Cell>
              <Cell right>{row.riskMoney !== null ? Math.round(row.riskMoney) : "—"}</Cell>
              <span className="flex min-w-0 items-center">
                {row.armed ? (
                  <Badge tone="up">Armed</Badge>
                ) : (
                  <span className="t-cap d-mute truncate">{row.rejections[0] ?? "No setup"}</span>
                )}
              </span>
            </TR>
          ))}
        </Table>
      )}
    </Panel>
  );
}

/** A tabular cell for the numeric columns (right-aligned, tone-able). */
function Cell({ children, right, tone, title }: { children: ReactNode; right?: boolean; tone?: Tone; title?: string }) {
  return (
    <span className={`tnum truncate ${right ? "text-right" : ""} ${tone ? `d-${tone}` : "d-tx2"}`} title={title}>
      {children}
    </span>
  );
}

// ── auto-select ─────────────────────────────────────────────────────────────

export interface AutoSelectPanelProps {
  autoSelect: DeskStateResponse["autoSelect"] | null;
  onRunNow: () => void;
  running: boolean;
  /** Auto-select needs a live terminal. */
  enabled: boolean;
}

export function AutoSelectPanel({ autoSelect, onRunNow, running, enabled }: AutoSelectPanelProps) {
  const last = autoSelect?.last ?? null;
  const nextLabel = nextAutoSelectLabel(autoSelect?.nextDueAt ?? null, Date.now());

  return (
    <Panel
      id="autoselect"
      title="Auto-select"
      right={
        <>
          {nextLabel ? <span className="d-mute" data-testid="auto-select-next">{nextLabel}</span> : null}
          <button
            type="button"
            className="desk-btn"
            style={{ height: 22, padding: "0 6px" }}
            disabled={!enabled || running}
            onClick={onRunNow}
            title="Run the best-market pass now instead of waiting for the next scheduled one"
            data-testid="auto-select-run"
          >
            {running ? "Running…" : "Run now"}
          </button>
        </>
      }
    >
      {!last ? (
        <PanelEmpty>No automatic pass has run yet. It scans the selected markets on its own cadence.</PanelEmpty>
      ) : (
        <>
          <div className="border-b border-[var(--desk-line)] px-3 py-2" data-testid="auto-select-report">
            <div className="flex items-baseline gap-2">
              <span className="t-cap d-mute shrink-0 uppercase tracking-wider">
                {last.chosen ? <span className="d-up">Chose {last.chosen}</span> : "No qualification"} · {last.mode}
              </span>
              <span className="t-cap d-mute ml-auto shrink-0 tnum">{relativeTime(last.at)}</span>
            </div>
            <p className="t-body d-tx2 mt-0.5">{autoSelectSummary(last) ?? last.reason}</p>
          </div>
          {last.ranked.length > 0 ? (
            <Table id="autoSelect" head={["Symbol", "Grade · score", "Edge", "State"]}>
              {last.ranked.map((row) => (
                <TR key={row.symbol} data-testid={`auto-select-row-${row.symbol}`}>
                  <span className="t-body d-tx truncate">{row.symbol}</span>
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className={`shrink-0 d-${gradeTone(row.grade)}`}>{row.grade}</span>
                    <Cell>{row.score.toFixed(0)}</Cell>
                  </span>
                  <Cell right tone={row.expectancyR !== null && row.expectancyR > 0 ? "up" : undefined}>
                    {row.expectancyR !== null ? formatSignedR(row.expectancyR) : "—"}
                  </Cell>
                  <span className="flex items-center justify-end">
                    {row.armed ? <Badge tone="up">Armed</Badge> : <Badge tone="mute">refused</Badge>}
                  </span>
                </TR>
              ))}
            </Table>
          ) : null}
        </>
      )}
    </Panel>
  );
}

// ── feed & execution health ─────────────────────────────────────────────────

export interface HealthPanelProps {
  state: DeskStateResponse | null;
  /** The v4 execution ledger; available:false while its layers are off (404). */
  execution: DeskExecutionReport | null;
  /** From ["desk-bridge-status"]; null when unpaired or the query is off. */
  bridge: { eaVersion?: string | null; eaUpdateAvailable?: boolean; lastBeatRttMs?: number | null } | null;
  /** The Command-selected symbol, for its spread row. */
  selected: string;
}

function KV({ label, value, tone, title }: { label: string; value: ReactNode; tone?: Tone; title?: string }) {
  return (
    <div className="desk-kv flex h-7 items-center justify-between gap-3 px-3" title={title}>
      <span className="t-body d-tx2 shrink-0">{label}</span>
      <span className={`tnum truncate ${tone ? `d-${tone}` : "d-tx"}`}>{value}</span>
    </div>
  );
}

export function HealthPanel({ state, execution, bridge, selected }: HealthPanelProps) {
  const feed = state?.feed ?? null;
  const market = state?.market ?? null;
  const terminal = state?.terminal ?? null;
  const ledger = execution?.execution ?? null;
  const spread = ledger?.spreadSamples?.[selected] ?? null;

  const heartbeat =
    terminal === null
      ? "—"
      : `${Math.max(0, Math.round((terminal.lastSyncAgeMs ?? Date.now() - terminal.lastSyncAt) / 1000))}s`;

  return (
    <Panel id="health" title="Feed & execution health">
      {!state ? (
        <SkeletonRows rows={6} columns={2} />
      ) : (
        <>
          <SubHeader>Feed</SubHeader>
          <KV label="Quotes fresh for" value={market ? `${Math.round(market.quoteFreshForMs / 1000)}s` : "—"} />
          <KV
            label="Last quote age"
            value={feed?.lastQuoteAgeMs !== null && feed?.lastQuoteAgeMs !== undefined ? `${(feed.lastQuoteAgeMs / 1000).toFixed(1)}s` : "—"}
            tone={feed !== null && feed.lastQuoteAgeMs !== null && market !== null && feed.lastQuoteAgeMs > market.quoteFreshForMs ? "dn" : undefined}
          />
          <KV
            label="Clock skew"
            value={feed?.clockSkewMs !== null && feed?.clockSkewMs !== undefined ? `${(feed.clockSkewMs / 1000).toFixed(1)}s` : "—"}
            title={feed?.clockWarning ?? "The EA self-corrects its timestamps against the server clock"}
          />
          <KV
            label="Coverage"
            value={market ? `${market.liveSymbols} fresh · ${market.warmingSymbols} warming · ${market.staleSymbols} stale` : "—"}
            tone={market && market.staleSymbols > 0 ? "am" : undefined}
          />
          <KV
            label="Price mismatches"
            value={market ? market.mismatchSymbols : "—"}
            tone={market && market.mismatchSymbols > 0 ? "dn" : "up"}
            title="A quote that disagrees with its own candles — trading on it is blocked"
          />
          <KV
            label="Terminal heartbeat"
            value={heartbeat}
            tone={terminal?.stale ? "dn" : terminal?.degraded ? "am" : "up"}
            title={
              terminal
                ? `${terminal.company} · ${terminal.server} · syncs every ${terminal.syncIntervalMs ? `${(terminal.syncIntervalMs / 1000).toFixed(1)}s` : "~1s"}`
                : undefined
            }
          />

          <SubHeader>Link</SubHeader>
          <KV
            label="EA version"
            value={
              bridge?.eaVersion ? (
                <>
                  {bridge.eaVersion}
                  {bridge.eaUpdateAvailable ? <span className="d-am"> · update available</span> : null}
                </>
              ) : (
                "—"
              )
            }
            tone={bridge?.eaUpdateAvailable ? "am" : undefined}
          />
          <KV label="Heartbeat RTT" value={bridge?.lastBeatRttMs !== null && bridge?.lastBeatRttMs !== undefined ? `${Math.round(bridge.lastBeatRttMs)}ms` : "—"} />

          <SubHeader>Execution ledger</SubHeader>
          {!ledger ? (
            <p className="t-body d-mute px-3 py-2">
              The v4 execution ledger is not serving (its layers are off, or this server predates it). Slippage and
              spread history show em dashes everywhere until it does.
            </p>
          ) : (
            <>
              <KV
                label="Slippage EWMA"
                value={ledger.slippage.ewmaR !== null ? `${ledger.slippage.ewmaR.toFixed(3)}R` : "—"}
                title={`${ledger.slippage.observations} observations over ${ledger.slippage.samples} fills`}
              />
              <KV label={`Spread · ${selected || "—"}`} value={spread ? `${spread.last ?? "—"} pts · n=${spread.samples}` : "—"} />
              <KV
                label="Timing pool"
                value={`${ledger.timingPooled.wins}W / ${ledger.timingPooled.losses}L · ${formatSignedR(ledger.timingPooled.rSum)}`}
                title={`${ledger.timingBuckets} timing buckets recorded`}
              />
            </>
          )}
        </>
      )}
    </Panel>
  );
}
