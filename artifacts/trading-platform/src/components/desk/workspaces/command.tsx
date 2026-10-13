/**
 * v5 Desk — the Command workspace's five panels.
 *
 * Opportunities (what the desk can trade), Decision (what the agent concluded
 * about the selected symbol, gate by gate), Risk & safety (every live limit as
 * a meter against the server's own number), Positions & plans (what is open
 * and what is armed), Calendar (the red folder that can pause everything).
 *
 * All arithmetic arrives pre-computed from desk-ui's pure builders — these
 * components only render it, so a wrong number on screen is a bug in a tested
 * function, not in JSX. Every absent value renders as an em dash.
 */
import { useState, type ReactNode } from "react";

import {
  countdown,
  formatInZone,
  formatMoney,
  MODE_ANALYSIS_LABEL,
  type AgentDecision,
  type ArmedPlan,
  type NewsFeed,
  type NewsGate,
  type Position,
  type TradeMode,
  type UpcomingNewsEvent,
} from "@/lib/desk";
import {
  DESK_THRESHOLDS,
} from "../desk-layout";
import {
  filterOpportunities,
  formatSignedR,
  netOpenResults,
  opportunityTone,
  shortCountdown,
  triggerTypeLabel,
  type GateRow,
  type OpportunityFilter,
  type OpportunityRow,
  type RiskMeterRow,
} from "@/lib/desk-ui";

import { Panel } from "../panel";
import { Badge, Chip, Meter, Num, PanelEmpty, SkeletonRows, SubHeader, Table, TR, type Tone } from "../primitives";

// ── shared tone mapping ─────────────────────────────────────────────────────

function meterTone(tone: "good" | "warn" | "bad" | "neutral"): Tone {
  if (tone === "good") return "up";
  if (tone === "warn") return "am";
  if (tone === "bad") return "dn";
  return "mute";
}

/** A broker number, printed exactly as the server sent it — never re-rounded. */
function wire(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : String(value);
}

function SideGlyph({ side }: { side: "buy" | "sell" }) {
  return (
    <span className={side === "buy" ? "d-up" : "d-dn"} aria-hidden="true">
      {side === "buy" ? "▲" : "▼"}
    </span>
  );
}

// ── opportunities ───────────────────────────────────────────────────────────

const FILTERS: { id: OpportunityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "armed", label: "Armed" },
  { id: "forex", label: "Forex" },
  { id: "other", label: "Other" },
];

export interface OpportunitiesPanelProps {
  rows: OpportunityRow[];
  onSelect: (symbol: string) => void;
  loading?: boolean;
}

export function OpportunitiesPanel({ rows, onSelect, loading }: OpportunitiesPanelProps) {
  const [filter, setFilter] = useState<OpportunityFilter>("all");
  const visible = filterOpportunities(rows, filter);
  const countFor = (id: OpportunityFilter) => filterOpportunities(rows, id).length;

  return (
    <Panel
      id="opportunities"
      title="Opportunities"
      right={<span className="tnum" data-testid="opportunities-count">{rows.length}</span>}
      bodyClassName="flex flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--desk-line)] px-3" role="group" aria-label="Filter opportunities">
        {FILTERS.map((entry) => (
          <Chip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
            {entry.label}
            <span className="tnum d-mute">{countFor(entry.id)}</span>
          </Chip>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {visible.length === 0 ? (
          loading ? (
            <SkeletonRows rows={6} columns={3} />
          ) : (
            <PanelEmpty>
              {rows.length === 0
                ? "No selected markets yet — choose symbols on the Markets workspace."
                : "Nothing matches this filter right now."}
            </PanelEmpty>
          )
        ) : (
          <Table id="opportunities" head={[null, "Market", "Price", "Edge"]}>
            {visible.map((row) => (
              <TR
                key={row.symbol}
                selected={row.selected}
                onClick={() => onSelect(row.symbol)}
                data-testid={`watchlist-row-${row.symbol}`}
                title={`${row.symbol} — ${row.stateLabel}${row.regimeLabel ? ` · ${row.regimeLabel}` : ""}`}
              >
                <span className={`desk-dot d-${meterTone(opportunityTone(row.stateId))}`} aria-hidden="true" />
                <span className="flex min-w-0 flex-col justify-center">
                  <span className="t-title d-tx truncate">{row.symbol}</span>
                  <span className="t-cap d-mute truncate">{row.regimeLabel ?? row.stateLabel}</span>
                </span>
                <span className="flex min-w-0 flex-col items-end justify-center">
                  <Num className="d-tx2 truncate">{row.priceLabel}</Num>
                  {row.changePct !== null ? (
                    <span className={`t-cap tnum ${row.changePct > 0 ? "d-up" : row.changePct < 0 ? "d-dn" : "d-mute"}`}>
                      {row.changePct > 0 ? "+" : row.changePct < 0 ? "−" : ""}
                      {Math.abs(row.changePct).toFixed(2)}%
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 flex-col items-end justify-center">
                  <Num className={`t-title ${row.edgeR !== null && row.edgeR > 0 ? "d-up" : row.edgeR !== null ? "d-dn" : "d-mute"}`}>
                    {row.edgeR !== null ? formatSignedR(row.edgeR) : "—"}
                  </Num>
                  <span className={`t-cap ${opportunityTone(row.stateId) === "good" ? "d-up" : opportunityTone(row.stateId) === "warn" ? "d-am" : opportunityTone(row.stateId) === "bad" ? "d-dn" : "d-mute"}`}>
                    {row.stateLabel}
                  </span>
                </span>
              </TR>
            ))}
          </Table>
        )}
      </div>
    </Panel>
  );
}

// ── decision ────────────────────────────────────────────────────────────────

export interface DecisionPanelProps {
  symbol: string;
  mode: TradeMode;
  decision: AgentDecision | null;
  gateRows: GateRow[];
  /** The selected symbol's live price label (from the instruments feed). */
  priceLabel: string;
  horizonMinutes?: number | null;
  loading?: boolean;
  onArm: () => void;
  arming: boolean;
  armError: string | null;
}

export function DecisionPanel({ symbol, mode, decision, gateRows, priceLabel, horizonMinutes, loading, onArm, arming, armError }: DecisionPanelProps) {
  const plan = decision?.plan ?? null;
  const armable = Boolean(decision?.armed && plan);
  const verdict = !decision ? null : decision.armed ? { label: "ARMED", tone: "up" as Tone } : { label: "REFUSED", tone: "dn" as Tone };
  const firstRejection = decision?.rejections?.[0] ?? null;
  const horizonLabel = horizonMinutes ? (horizonMinutes >= 60 ? `${Math.round(horizonMinutes / 60)}h` : `${horizonMinutes}m`) : null;

  return (
    <Panel
      id="decision"
      focus
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">Decision{symbol ? ` · ${symbol}` : ""}</span>
          {decision?.confluence?.grade ? <Badge tone="cy">{decision.confluence.grade}</Badge> : null}
        </span>
      }
      right={
        <span className="truncate">
          {MODE_ANALYSIS_LABEL[mode]}
          {decision?.entryTimeframe ? ` · ${decision.entryTimeframe}` : ""}
          {horizonLabel ? ` · ${horizonLabel} horizon` : ""}
        </span>
      }
      bodyClassName="flex flex-col"
      footer={
        <div className="flex h-[62px] w-full flex-col justify-center gap-1">
          <div className="flex min-w-0 items-baseline gap-4 overflow-hidden">
            <FooterStat label="Entry" value={wire(plan?.trigger)} />
            <FooterStat label="Stop" value={wire(plan?.sl)} tone="dn" />
            <FooterStat label="Target" value={wire(plan?.tp?.[0])} tone="up" />
            <FooterStat label="Size" value={plan ? `${plan.lots} lots` : "—"} />
            {armError ? (
              <span className="t-cap d-dn min-w-0 flex-1 truncate text-right" title={armError} data-testid="arm-error">
                {armError}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="t-cap d-mute truncate">
              {armable
                ? `Risks ${plan ? formatMoney(plan.riskMoney) : "—"} if the stop is hit`
                : firstRejection ?? (decision ? "No armable plan" : "Waiting for the agent")}
            </span>
            <button
              type="button"
              className={`desk-btn ml-auto shrink-0 ${armable ? "desk-btn-primary" : ""}`}
              disabled={!armable || arming}
              onClick={onArm}
              title={armable ? "Place this plan with the broker" : firstRejection ?? "Nothing is armable right now"}
              data-testid="arm-plan"
            >
              {arming ? "Arming…" : armable && plan ? `Arm ${plan.side.toUpperCase()} ${plan.lots}` : "Arm"}
            </button>
          </div>
        </div>
      }
    >
      {/* The 70px top block: the price, the verdict, the one-line quality caption. */}
      <div className="flex h-[70px] shrink-0 items-center gap-3 border-b border-[var(--desk-line)] px-3">
        <Num className="t-key d-tx shrink-0">{priceLabel}</Num>
        {verdict ? <Badge tone={verdict.tone}>{verdict.label}</Badge> : <Badge tone="mute">WAITING</Badge>}
        <span className="t-cap d-mute min-w-0 flex-1 truncate" data-testid="decision-caption">
          {decision
            ? `Q ${decision.qualityScore ?? "—"} vs ${decision.qualityThreshold ?? "—"} · Win ${decision.winProbability !== null && decision.winProbability !== undefined ? `${Math.round(decision.winProbability * 100)}%` : "—"} · ${formatSignedR(decision.expectancyR)}`
            : "—"}
        </span>
      </div>

      <div className="min-h-0 flex-1">
        {!decision ? (
          loading ? (
            <SkeletonRows rows={5} columns={3} />
          ) : (
            <PanelEmpty>{symbol ? `Waiting for the agent's assessment of ${symbol}.` : "Select a market to see its decision."}</PanelEmpty>
          )
        ) : gateRows.length === 0 ? (
          <PanelEmpty>The agent reported no gates for this decision.</PanelEmpty>
        ) : (
          <Table id="decisionGates" head={[null, "Gate", "Value / need"]} className="pb-1">
            {gateRows.map((row) => (
              <TR key={row.id} data-testid={`gate-row-${row.id}`} title={row.detail ?? undefined}>
                <span className={`flex items-center justify-center ${row.pass ? "d-up" : "d-dn"}`}>
                  <span aria-hidden="true">{row.pass ? "✓" : "✕"}</span>
                  <span className="sr-only">{row.pass ? "Passed" : "Failed"}</span>
                </span>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className={`shrink-0 ${row.pass ? "d-tx" : "d-dn"}`}>{row.label}</span>
                  {row.detail ? <span className="t-cap d-mute truncate">{row.detail}</span> : null}
                </span>
                <span className="flex min-w-0 items-baseline justify-end gap-1">
                  <Num className={row.pass ? "d-tx2" : "d-dn"}>{row.value ?? "—"}</Num>
                  {row.threshold ? <span className="t-cap d-mute shrink-0">{row.threshold}</span> : null}
                </span>
              </TR>
            ))}
          </Table>
        )}
      </div>
    </Panel>
  );
}

function FooterStat({ label, value, tone }: { label: string; value: string; tone?: "up" | "dn" }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1">
      <span className="t-cap d-mute">{label}</span>
      <Num className={tone === "up" ? "d-up" : tone === "dn" ? "d-dn" : "d-tx"}>{value}</Num>
    </span>
  );
}

// ── risk & safety ───────────────────────────────────────────────────────────

export interface RiskPanelProps {
  rows: RiskMeterRow[];
  badge: { label: string; tone: "good" | "warn" | "bad" };
  suspended: string[];
  onResumeSymbol: (symbol: string) => void;
  loading?: boolean;
}

export function RiskPanel({ rows, badge, suspended, onResumeSymbol, loading }: RiskPanelProps) {
  return (
    <Panel
      id="risk"
      title="Risk & safety"
      right={
        <Badge tone={badge.tone === "good" ? "up" : badge.tone === "warn" ? "am" : "dn"} title="Session risk verdict from the meters below">
          {badge.label}
        </Badge>
      }
      footer={
        suspended.length > 0 ? (
          <span className="flex min-w-0 items-center gap-1.5 overflow-x-auto" data-testid="suspended-symbols">
            <span className="t-cap d-mute shrink-0">Suspended</span>
            {suspended.map((symbol) => (
              <button key={symbol} type="button" className="desk-chip desk-chip-active shrink-0" onClick={() => onResumeSymbol(symbol)} title={`Let ${symbol} trade again now (the desk also re-admits it on a regime change)`} data-testid={`resume-symbol-${symbol}`}>
                {symbol} ↻
              </button>
            ))}
          </span>
        ) : (
          <span className="d-mute">No suspensions — every selected symbol may trade.</span>
        )
      }
    >
      {loading && rows.length === 0 ? (
        <SkeletonRows rows={6} columns={2} />
      ) : (
        <Table id="risk" head={["Measure", "Value"]}>
          {rows.map((row) => (
            <TR key={row.id} data-testid={`risk-row-${row.id}`} title={row.unit ?? undefined}>
              <span className="flex min-w-0 flex-col justify-center gap-1">
                <span className="t-body d-tx truncate">{row.label}</span>
                <Meter fraction={row.fraction} tone={meterTone(row.tone)} tick={DESK_THRESHOLDS.nearLimitFraction} />
              </span>
              <span className="flex min-w-0 flex-col items-end justify-center">
                <Num className={`t-title ${row.tone === "bad" ? "d-dn" : row.tone === "warn" ? "d-am" : row.tone === "good" ? "d-tx" : "d-mute"}`}>{row.value}</Num>
                {row.unit ? <span className="t-cap d-mute truncate">{row.unit}</span> : null}
              </span>
            </TR>
          ))}
        </Table>
      )}
    </Panel>
  );
}

// ── positions & plans ───────────────────────────────────────────────────────

export interface PositionsPanelProps {
  positions: Position[];
  plans: ArmedPlan[];
  currency: string;
  onClosePosition: (ticket: number) => void;
  onCancelPlan: (id: string) => void;
  loading?: boolean;
}

export function PositionsPanel({ positions, plans, currency, onClosePosition, onCancelPlan, loading }: PositionsPanelProps) {
  const net = netOpenResults(positions);
  const nowMs = Date.now();

  return (
    <Panel
      id="positions"
      title="Positions & plans"
      right={
        <span className="tnum">
          {positions.length} open · {plans.length} armed
        </span>
      }
      footer={
        <span className="flex min-w-0 items-baseline gap-1.5" data-testid="positions-net">
          <span className="d-mute">Net open</span>
          <Num className={net.money > 0 ? "d-up" : net.money < 0 ? "d-dn" : "d-tx"}>{formatMoney(net.money, currency)}</Num>
          <Num className="d-tx2">{net.r !== null ? `(${formatSignedR(net.r)})` : ""}</Num>
          {net.unmeasured > 0 ? <span className="d-mute">· {net.unmeasured} without a stamped risk</span> : null}
        </span>
      }
    >
      {loading && positions.length === 0 && plans.length === 0 ? (
        <SkeletonRows rows={4} columns={4} />
      ) : positions.length === 0 && plans.length === 0 ? (
        <PanelEmpty>Nothing open, nothing armed. The agent only arms a plan after data, risk and news gates all pass.</PanelEmpty>
      ) : (
        <>
          <SubHeader right={<span className="tnum">{positions.length}</span>}>Open positions</SubHeader>
          {positions.length === 0 ? (
            <p className="t-body d-mute px-3 py-2">No open terminal positions.</p>
          ) : (
            <Table id="positions" head={["Market", "State", "", "Entry", "P&L", "Result", ""]}>
              {positions.map((position) => {
                const netMoney = position.profit + position.swap + position.commission;
                const measuredR = position.initialRiskMoney ? netMoney / position.initialRiskMoney : null;
                return (
                  <TR key={position.ticket} data-testid={`position-row-${position.ticket}`}>
                    <span className="flex min-w-0 flex-col justify-center">
                      <span className="t-body d-tx truncate">{position.symbol}</span>
                      <span className="t-cap d-mute truncate">
                        {position.side === "buy" ? "Buy" : "Sell"} · {position.volume} lots
                      </span>
                    </span>
                    <span className="flex items-center justify-center">
                      {position.managementState === "be" ? <Badge tone="am" title="Stop moved to break-even — the trade can no longer lose money">BE</Badge> : null}
                    </span>
                    <span className="flex items-center justify-center">
                      <SideGlyph side={position.side} />
                    </span>
                    <Num className="d-tx2 text-right">{wire(position.openPrice)}</Num>
                    <Num className={`text-right ${netMoney > 0 ? "d-up" : netMoney < 0 ? "d-dn" : "d-tx"}`}>{formatMoney(netMoney, currency)}</Num>
                    <span className="flex min-w-0 items-baseline justify-end gap-1.5">
                      <Num className={measuredR !== null ? (measuredR > 0 ? "d-up" : measuredR < 0 ? "d-dn" : "d-tx") : "d-mute"}>
                        {measuredR !== null ? formatSignedR(measuredR) : "—"}
                      </Num>
                      {position.sl !== null ? <span className="t-cap d-mute">sl {wire(position.sl)}</span> : null}
                    </span>
                    <span className="flex items-center justify-end">
                      <button
                        type="button"
                        className="desk-btn desk-btn-danger"
                        style={{ height: 22, padding: "0 6px" }}
                        onClick={() => onClosePosition(position.ticket)}
                        title={`Ask MT5 to close ${position.symbol} at market`}
                        data-testid={`close-position-${position.ticket}`}
                      >
                        Close
                      </button>
                    </span>
                  </TR>
                );
              })}
            </Table>
          )}

          <SubHeader right={<span className="tnum">{plans.length}</span>}>Armed plans</SubHeader>
          {plans.length === 0 ? (
            <p className="t-body d-mute px-3 py-2">No plans are armed.</p>
          ) : (
            <Table id="plans" head={["Plan", "Lots", "Trigger", "Stop", "Target", "Expires", ""]}>
              {plans.map((plan) => {
                const left = shortCountdown(plan.expiresAt, nowMs);
                return (
                  <TR key={plan.id} data-testid={`plan-row-${plan.id}`}>
                    <span className="flex min-w-0 flex-col justify-center">
                      <span className="t-body d-tx truncate">{plan.symbol}</span>
                      <span className="t-cap d-mute truncate">
                        {plan.side === "buy" ? "Buy" : "Sell"} · {triggerTypeLabel(plan.triggerType) ?? "—"}
                      </span>
                    </span>
                    <Num className="d-tx2 text-right">{plan.lots}</Num>
                    <Num className="d-tx text-right">{wire(plan.trigger)}</Num>
                    <Num className="d-dn text-right">{wire(plan.sl)}</Num>
                    <Num className="d-up text-right">{wire(plan.tp?.[0])}</Num>
                    <span className={`tnum text-right ${left === "expired" ? "d-dn" : "d-am"}`}>{left}</span>
                    <span className="flex items-center justify-end">
                      <button
                        type="button"
                        className="desk-btn"
                        style={{ height: 22, padding: "0 6px" }}
                        onClick={() => onCancelPlan(plan.id)}
                        title={`Cancel this plan before it triggers`}
                        data-testid={`cancel-plan-${plan.id}`}
                      >
                        Cancel
                      </button>
                    </span>
                  </TR>
                );
              })}
            </Table>
          )}
        </>
      )}
    </Panel>
  );
}

// ── calendar ────────────────────────────────────────────────────────────────

export interface CalendarPanelProps {
  news: NewsFeed | null;
  upcoming: UpcomingNewsEvent[];
  /** The selected symbol's news gate — its blackout reason is shown verbatim. */
  gate: NewsGate | null;
  timeZone: string;
}

export function CalendarPanel({ news, upcoming, gate, timeZone }: CalendarPanelProps) {
  const chip: ReactNode = !news ? (
    <Badge tone="mute">no feed</Badge>
  ) : news.available ? (
    (news.rawCount ?? 0) === 0 ? <Badge tone="am" title="The terminal could not read its calendar at all">unread</Badge> : <Badge tone="up">MT5 calendar</Badge>
  ) : (
    <Badge tone="am" title="The calendar feed is paused — the agent's news gate fails closed">paused</Badge>
  );

  const blackout = gate?.status === "blackout" ? gate.reason ?? "News blackout." : null;

  return (
    <Panel id="calendar" title="Red-folder calendar" right={chip} bodyClassName="flex flex-col">
      {blackout ? (
        <div className="desk-blackout flex h-[34px] shrink-0 items-center gap-2 px-3" data-testid="news-blackout">
          <span className="t-cap d-am shrink-0 font-semibold uppercase tracking-wider">Blackout</span>
          <span className="t-body d-tx2 truncate" title={blackout}>{blackout}</span>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {!news?.available ? (
          <PanelEmpty>
            The terminal's economic calendar is paused, so "no events" cannot be confirmed. The agent's news gate fails
            closed while it is unreadable.
          </PanelEmpty>
        ) : upcoming.length === 0 ? (
          <PanelEmpty>
            {(news.rawCount ?? 0) === 0
              ? "MT5 returned no calendar rows at all — an empty list is not an all-clear."
              : "No red-folder events in the next 24 hours."}
          </PanelEmpty>
        ) : (
          <Table id="calendar" head={["Time", "Cur", "Event", "In"]}>
            {upcoming.map((event) => {
              const distance = countdown(event.time);
              return (
                <TR key={event.id} selected={event.next} data-testid={`news-row-${event.id}`} title={`${event.name} (${event.country})`}>
                  <Num className="d-tx2">{formatInZone(event.time, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false })}</Num>
                  <span className="flex items-center">
                    <Badge tone={event.passed ? "mute" : "am"}>{event.currency}</Badge>
                  </span>
                  <span className={`truncate ${event.passed ? "d-mute" : "d-tx"}`}>{event.name}</span>
                  <span className={`tnum text-right ${event.passed ? "d-mute" : event.next ? "d-cy" : "d-am"}`}>{distance}</span>
                </TR>
              );
            })}
          </Table>
        )}
      </div>
    </Panel>
  );
}
