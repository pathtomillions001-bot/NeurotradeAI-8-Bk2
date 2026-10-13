/**
 * v5 Desk — the Journal & performance workspace's three panels.
 *
 * Closed trades (the broker's own ledger, newest first, with the server's
 * fill→plan agent attribution and a client-side CSV export), By symbol &
 * agent (where the P&L actually came from), and the Decision journal (the
 * in-process desk log the old Command column showed, filters and all).
 *
 * No charts: the equity curve the old page carried is deliberately NOT
 * rendered anywhere on the v5 Desk — every number here is a table cell, and
 * an unmeasured R or an unknown attribution is an em dash, never a zero.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Download } from "lucide-react";

import {
  formatInZone,
  formatMoney,
  zoneAbbreviation,
  type DeskPerformance,
  type JournalEntry,
} from "@/lib/desk";
import {
  agentAttribution,
  closedTradesCsv,
  formatSignedR,
  shortCountdown,
} from "@/lib/desk-ui";
import { journalKindLabel } from "@/lib/learning";

import { Panel } from "../panel";
import { Badge, Chip, PanelEmpty, SkeletonRows, SubHeader, Table, TR, type Tone } from "../primitives";

// ── closed trades ───────────────────────────────────────────────────────────

export interface ClosedTradesPanelProps {
  performance: DeskPerformance | null;
  timeZone: string;
  loading?: boolean;
}

export function ClosedTradesPanel({ performance, timeZone, loading }: ClosedTradesPanelProps) {
  const trades = useMemo(
    () => [...(performance?.closedTrades ?? [])].sort((a, b) => b.closedAt - a.closedAt),
    [performance],
  );
  const overall = performance?.overall ?? null;

  const exportCsv = () => {
    if (!performance) return;
    const blob = new Blob([closedTradesCsv(performance.closedTrades)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `desk-closed-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      id="closed"
      title="Closed trades"
      right={
        <>
          {overall ? (
            <span className="tnum" data-testid="closed-overall">
              {overall.trades} trades · {Math.round(overall.winRate * 100)}% win
            </span>
          ) : null}
          <button
            type="button"
            className="desk-btn"
            style={{ height: 22, padding: "0 6px" }}
            disabled={!performance || performance.closedTrades.length === 0}
            onClick={exportCsv}
            title="Download the closed-trade ledger as CSV (closedAt, symbol, side, lots, agents, resultR, pnl)"
            data-testid="export-csv"
          >
            <Download className="h-3 w-3" aria-hidden="true" />CSV
          </button>
        </>
      }
      footer={
        performance ? (
          <span className="flex min-w-0 items-baseline gap-3 overflow-hidden" data-testid="closed-totals">
            <span>
              Net{" "}
              <span className={`tnum ${performance.realisedPnl > 0 ? "d-up" : performance.realisedPnl < 0 ? "d-dn" : "d-tx"}`}>
                {formatMoney(performance.realisedPnl, performance.currency)}
              </span>
            </span>
            <span>
              <span className={`tnum ${overall && overall.totalR > 0 ? "d-up" : overall && overall.totalR < 0 ? "d-dn" : "d-tx2"}`}>
                {overall ? formatSignedR(overall.totalR) : "—"}
              </span>{" "}
              measured
            </span>
            <span className="hidden sm:inline">
              PF <span className="tnum d-tx2">{overall ? overall.profitFactor.toFixed(2) : "—"}</span>
            </span>
            <span className="hidden md:inline">
              worst DD <span className="tnum d-tx2">{overall ? `${overall.maxDrawdownR.toFixed(1)}R` : "—"}</span>
            </span>
          </span>
        ) : null
      }
    >
      {loading && !performance ? (
        <SkeletonRows rows={8} columns={5} />
      ) : !performance ? (
        <PanelEmpty>No performance ledger is being served yet.</PanelEmpty>
      ) : trades.length === 0 ? (
        <PanelEmpty>No closed trades yet — the ledger fills as positions close.</PanelEmpty>
      ) : (
        <Table id="closedTrades" head={["Closed", "Market", "Lots", "Result", "Agents", "P&L", "Held"]}>
          {trades.map((trade) => {
            const net = trade.profit + trade.swap + trade.commission;
            return (
              <TR
                key={trade.ticket}
                data-testid={`closed-row-${trade.ticket}`}
                title={`Opened ${formatInZone(trade.openedAt, timeZone, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })} at ${trade.openPrice} · profit ${trade.profit.toFixed(2)}, swap ${trade.swap.toFixed(2)}, commission ${trade.commission.toFixed(2)}`}
              >
                <span className="tnum d-tx2 truncate">
                  {formatInZone(trade.closedAt, timeZone, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="t-body d-tx truncate">{trade.symbol}</span>
                  <span className={`t-cap shrink-0 ${trade.side === "buy" ? "d-up" : "d-dn"}`}>{trade.side}</span>
                </span>
                <Num right>{trade.volume}</Num>
                <Num right tone={trade.rMultiple === null ? "mute" : trade.rMultiple > 0 ? "up" : trade.rMultiple < 0 ? "dn" : undefined}>
                  {trade.rMultiple !== null ? formatSignedR(trade.rMultiple) : "—"}
                </Num>
                <AgentsCell agents={trade.agents ?? null} />
                <Num right tone={net > 0 ? "up" : net < 0 ? "dn" : undefined}>
                  {formatMoney(net, performance.currency)}
                </Num>
                <Num right tone="mute">
                  {trade.closedAt > trade.openedAt ? shortCountdown(trade.closedAt, trade.openedAt) : "—"}
                </Num>
              </TR>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

/**
 * The server's fill→plan attribution. Null means UNKNOWN (the plan memory
 * expired) and renders as an em dash — "unknown" is not "no agents".
 */
function AgentsCell({ agents }: { agents: string[] | null }) {
  if (agents === null) return <span className="d-mute truncate">—</span>;
  if (agents.length === 0) return <span className="d-mute truncate">none</span>;
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {agents.map((agent) => (
        <span key={agent} className="tnum t-cap d-tx2 shrink-0 truncate">
          {agent}
        </span>
      ))}
    </span>
  );
}

function Num({ children, right, tone }: { children: ReactNode; right?: boolean; tone?: Tone }) {
  return (
    <span className={`tnum truncate ${right ? "text-right" : ""} ${tone ? `d-${tone}` : "d-tx2"}`}>{children}</span>
  );
}

// ── by symbol & agent ───────────────────────────────────────────────────────

export interface BySymbolPanelProps {
  performance: DeskPerformance | null;
  loading?: boolean;
}

export function BySymbolPanel({ performance, loading }: BySymbolPanelProps) {
  const bySymbol = useMemo(
    () => [...(performance?.bySymbol ?? [])].sort((a, b) => b.stats.totalR - a.stats.totalR),
    [performance],
  );
  const byAgent = useMemo(() => agentAttribution(performance?.closedTrades ?? []), [performance]);

  return (
    <Panel id="by-symbol" title="Where the P&L came from">
      {loading && !performance ? (
        <SkeletonRows rows={6} columns={3} />
      ) : !performance || bySymbol.length === 0 ? (
        <PanelEmpty>Nothing closed yet — per-symbol and per-agent results appear with the first measured trade.</PanelEmpty>
      ) : (
        <>
          <SubHeader right={<span className="tnum">{bySymbol.length}</span>}>By symbol</SubHeader>
          <Table id="bySymbol" head={["Symbol", "N", "Win%", "Total R", "Avg R"]}>
            {bySymbol.map((row) => (
              <TR key={row.symbol} data-testid={`by-symbol-row-${row.symbol}`} title={`Profit factor ${row.stats.profitFactor.toFixed(2)} · worst streak ${row.stats.maxLosingStreak} · max DD ${row.stats.maxDrawdownR.toFixed(1)}R`}>
                <span className="t-body d-tx truncate">{row.symbol}</span>
                <Num right>{row.trades}</Num>
                <Num right>{Math.round(row.winRate * 100)}%</Num>
                <Num right tone={row.stats.totalR > 0 ? "up" : row.stats.totalR < 0 ? "dn" : undefined}>
                  {formatSignedR(row.stats.totalR)}
                </Num>
                <Num right tone="mute">{formatSignedR(row.stats.avgR)}</Num>
              </TR>
            ))}
          </Table>

          <SubHeader right={<span className="tnum">{byAgent.length}</span>}>By agent</SubHeader>
          {byAgent.length === 0 ? (
            <p className="t-body d-mute px-3 py-2">
              No closed trade carries an agent attribution — the plan memory only keeps recent fills.
            </p>
          ) : (
            <Table id="byAgent" head={["Agent", "N", "Total R"]}>
              {byAgent.map((row) => (
                <TR key={row.agent} data-testid={`by-agent-row-${row.agent}`} title={`${row.measured} of ${row.trades} trades carry a stamped R`}>
                  <span className="tnum t-body d-tx truncate">{row.agent}</span>
                  <Num right>{row.trades}</Num>
                  <Num right tone={row.totalR !== null && row.totalR > 0 ? "up" : row.totalR !== null && row.totalR < 0 ? "dn" : "mute"}>
                    {row.totalR !== null ? formatSignedR(row.totalR) : "—"}
                  </Num>
                </TR>
              ))}
            </Table>
          )}
        </>
      )}
    </Panel>
  );
}

// ── decision journal ────────────────────────────────────────────────────────

const JOURNAL_FILTERS = ["all", "signal", "execution", "risk"] as const;

function kindTone(kind: JournalEntry["kind"]): Tone {
  if (kind === "risk") return "am";
  if (kind === "execution") return "cy";
  if (kind === "signal") return "up";
  if (kind === "bridge") return "vi";
  return "mute";
}

export interface DecisionJournalPanelProps {
  entries: JournalEntry[];
  timeZone: string;
}

export function DecisionJournalPanel({ entries, timeZone }: DecisionJournalPanelProps) {
  const [filter, setFilter] = useState<(typeof JOURNAL_FILTERS)[number]>("all");
  const visible = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);

  return (
    <Panel
      id="decision-journal"
      title="Decision journal"
      right={<span className="tnum">{entries.length}</span>}
      bodyClassName="flex flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--desk-line)] px-3" role="group" aria-label="Filter the decision journal">
        {JOURNAL_FILTERS.map((kind) => (
          <Chip key={kind} active={filter === kind} onClick={() => setFilter(kind)}>
            {kind === "all" ? "all" : journalKindLabel(kind)}
          </Chip>
        ))}
        <span className="t-cap d-mute ml-auto shrink-0">{zoneAbbreviation(Date.now(), timeZone)}</span>
      </div>
      <div className="min-h-0 flex-1">
        {visible.length === 0 ? (
          <PanelEmpty>Nothing logged yet.</PanelEmpty>
        ) : (
          <Table id="decisionJournal" head={["When", "Kind", "Symbol", "Message"]}>
            {visible.map((entry) => (
              <TR key={entry.id} data-testid={`decision-journal-row-${entry.id}`} title={formatInZone(entry.ts, timeZone, { dateStyle: "medium", timeStyle: "short" })}>
                <Num>{formatInZone(entry.ts, timeZone, { day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}</Num>
                <span className="flex items-center">
                  <Badge tone={kindTone(entry.kind)}>{journalKindLabel(entry.kind)}</Badge>
                </span>
                <span className="tnum d-tx2 truncate">{entry.symbol ?? "—"}</span>
                <span className="t-body d-tx2 truncate">{entry.message}</span>
              </TR>
            ))}
          </Table>
        )}
      </div>
    </Panel>
  );
}
