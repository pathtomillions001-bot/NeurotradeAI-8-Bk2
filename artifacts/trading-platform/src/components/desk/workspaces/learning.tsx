/**
 * v5 Desk — the Learning workspace's seven panels.
 *
 * The old /learning page, folded into the Desk without losing a sentence: the
 * governance registry with its e-value bars and the operator resume (reason ≥
 * 3 characters), the weekly report split across three panels (calibration
 * buckets, the week itself, the refusal histogram), the desk-timeframe regime
 * states, the rollout kill rules, and the durable journal.
 *
 * The v4 layers ship OFF, so every panel treats "not available" (404) as a
 * normal answer with the old page's own explanation — never as zeros dressed
 * up as measurements. All verdicts, fractions and formatters come from
 * src/lib/learning.ts (exports kept intact, per the brief).
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import {
  formatInZone,
  type GovernanceAgent,
  type JournalEntryRow,
  type RegimeRead,
  type WeeklyReport,
} from "@/lib/desk";
import {
  agentStatusTone,
  brierVerdict,
  calibrationVerdict,
  eBarFraction,
  eHalveFraction,
  formatEValue,
  formatPoints,
  formatProbability,
  formatR,
  journalKindLabel,
  killRuleStatus,
  refusalRows,
  weeklyHeadline,
  type AgentStatus,
} from "@/lib/learning";
import { regimePermitLabel, regimeSplit, regimeStateLabel } from "@/lib/desk-ui";
import { DESK_THRESHOLDS } from "../desk-layout";

import { Panel } from "../panel";
import { Badge, Chip, Meter, PanelEmpty, SkeletonRows, SubHeader, Table, TR, type Tone } from "../primitives";

function statusTone(status: AgentStatus | string): Tone {
  if (status === "disabled") return "dn";
  if (status === "halved") return "am";
  if (status === "active") return "up";
  return "mute";
}

/** v5 token mapping of the old regimeTone; violet stays reserved for range. */
function regimeTokenTone(state: string): Tone {
  if (state === "trend_up") return "up";
  if (state === "trend_down") return "cy";
  if (state === "range") return "vi";
  if (state === "volatile") return "am";
  return "mute";
}

// ── governance ──────────────────────────────────────────────────────────────

export interface GovernancePanelProps {
  available: boolean;
  agents: GovernanceAgent[];
  loading?: boolean;
  /** Refetches governance, weekly and journal — the old page's Refresh button. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function GovernancePanel({ available, agents, loading, onRefresh, refreshing }: GovernancePanelProps) {
  const first = agents[0] ?? null;
  return (
    <Panel
      id="governance"
      title="Per-agent governance"
      right={
        <>
          {first ? (
            <span className="tnum" data-testid="governance-thresholds">
              e ≥ {first.halveAt} halves · e ≥ {first.disableAt} disables
            </span>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              className="desk-btn"
              style={{ height: 22, padding: "0 6px" }}
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Refresh the learning surfaces"
              title="Refetch governance, the weekly report and the journal"
              data-testid="learning-refresh"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            </button>
          ) : null}
        </>
      }
    >
      {!available ? (
        <PanelEmpty>
          The governance layer is switched off (<span className="tnum">DESK_V4_GOVERNANCE</span>). No agent is being
          governed, and nothing on this desk is being halved or disabled by its own record.
        </PanelEmpty>
      ) : loading && agents.length === 0 ? (
        <SkeletonRows rows={4} columns={4} />
      ) : agents.length === 0 ? (
        <PanelEmpty>The registry is live but empty — no agent has been enrolled yet.</PanelEmpty>
      ) : (
        <Table id="governance" head={["Agent", "State", "Evidence against (e)", "e", "Record"]}>
          {agents.map((agent) => {
            const tone = agentStatusTone(agent.status as AgentStatus);
            const fraction = eBarFraction(agent.eValue, agent.disableAt);
            const tick = eHalveFraction(agent.halveAt, agent.disableAt);
            return (
              <TR key={agent.agentId} data-testid={`governance-row-${agent.agentId}`} title={agent.reason ?? tone.blurb}>
                <span className="t-body d-tx truncate tnum">{agent.agentId}</span>
                <span className="flex items-center">
                  <Badge tone={statusTone(agent.status)}>{tone.label}</Badge>
                </span>
                <span className="flex min-w-0 flex-col justify-center gap-1">
                  <Meter fraction={fraction} tone={statusTone(agent.status)} tick={tick} />
                  <span className="t-cap d-mute truncate">{agent.reason ?? tone.blurb}</span>
                </span>
                <Num right>{formatEValue(agent.eValue)}</Num>
                <span className="flex min-w-0 flex-col items-end justify-center">
                  <span className="tnum d-tx2 text-[10.5px]">
                    {agent.wins}/{agent.outcomes} wins
                  </span>
                  <span className={`tnum text-[10.5px] ${agent.totalR >= 0 ? "d-up" : "d-dn"}`}>{formatR(agent.totalR)}</span>
                </span>
              </TR>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

/** A right-aligned tabular number cell. */
function Num({ children, right, tone, title }: { children: ReactNode; right?: boolean; tone?: Tone; title?: string }) {
  return (
    <span className={`tnum truncate ${right ? "text-right" : ""} ${tone ? `d-${tone}` : "d-tx2"}`} title={title}>
      {children}
    </span>
  );
}

// ── calibration ─────────────────────────────────────────────────────────────

export interface CalibrationPanelProps {
  available: boolean;
  report: WeeklyReport | null;
}

export function CalibrationPanel({ available, report }: CalibrationPanelProps) {
  const buckets = report?.trades.calibrationBuckets ?? [];
  const brier = brierVerdict(report?.trades.brier ?? null);
  const lower80 = report?.trades.meanRLower80 ?? null;

  return (
    <Panel
      id="calibration"
      title="Calibration"
      right={<span className={brier.tone === "ok" ? "d-up" : brier.tone === "warn" ? "d-am" : "d-mute"}>{brier.label}</span>}
      footer={
        <span className="flex min-w-0 items-baseline gap-3" data-testid="calibration-footer">
          <span>
            Brier <Num tone={brier.tone === "ok" ? "up" : brier.tone === "warn" ? "am" : "mute"}>{report?.trades.brier === null || report?.trades.brier === undefined ? "—" : report.trades.brier.toFixed(3)}</Num>
          </span>
          <span>
            mean R lower 80% <Num tone={lower80 !== null && lower80 > 0 ? "up" : lower80 !== null ? "dn" : "mute"}>{lower80 !== null && lower80 !== undefined ? formatR(lower80) : "—"}</Num>
          </span>
        </span>
      }
    >
      {!available || !report ? (
        <PanelEmpty>
          No weekly report is being served: it is built from the durable shadow ledger, which the governance layer
          writes.
        </PanelEmpty>
      ) : buckets.length === 0 ? (
        <PanelEmpty>
          This server's weekly report carries no per-bucket calibration rows — the footer verdicts are all it serves.
        </PanelEmpty>
      ) : (
        <Table id="calibration" head={["Predicted", "n", "Realised vs predicted", "Gap", "Verdict"]}>
          {buckets.map((bucket) => {
            const tooSmall = bucket.n < DESK_THRESHOLDS.calibrationMinBucketTrades;
            const verdict = calibrationVerdict(tooSmall ? null : bucket.gapPoints);
            return (
              <TR key={bucket.label} data-testid={`calibration-row-${bucket.label}`} title={`${bucket.n} trades predicted ${formatProbability(bucket.meanPredicted)}, realised ${formatProbability(bucket.realisedHitRate)}`}>
                <span className="t-body d-tx truncate">{bucket.label}</span>
                <Num>{bucket.n}</Num>
                <span className="flex min-w-0 items-center">
                  {tooSmall || bucket.realisedHitRate === null ? (
                    <span className="d-mute">-</span>
                  ) : (
                    <Meter
                      fraction={bucket.realisedHitRate}
                      tone="cy"
                      tick={bucket.meanPredicted ?? null}
                      className="w-full"
                    />
                  )}
                </span>
                <Num right>{tooSmall ? "-" : formatPoints(bucket.gapPoints)}</Num>
                <span className={`truncate text-right ${verdict.tone === "ok" ? "d-up" : verdict.tone === "warn" ? "d-am" : "d-mute"}`} title={verdict.label}>
                  {tooSmall ? "n too small" : verdict.label}
                </span>
              </TR>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

// ── this week ───────────────────────────────────────────────────────────────

export interface WeekPanelProps {
  available: boolean;
  report: WeeklyReport | null;
}

export function WeekPanel({ available, report }: WeekPanelProps) {
  return (
    <Panel
      id="week"
      title="This week"
      right={report ? <span className="tnum">{report.trades.closed} closed</span> : null}
      footer={
        report ? (
          <span className="tnum" data-testid="week-decisions">
            {report.decisions.armed} armed / {report.decisions.evaluated} evaluated · {report.decisions.refused} refused
          </span>
        ) : null
      }
    >
      {!available || !report ? (
        <PanelEmpty>
          No weekly report is being served: it is built from the durable shadow ledger, which the governance layer
          writes.
        </PanelEmpty>
      ) : (
        <>
          <p className="t-cap d-tx2 border-b border-[var(--desk-line)] px-3 py-2" data-testid="week-headline">
            {weeklyHeadline(report)}
          </p>
          {report.flags.length > 0 ? (
            <ul className="border-b border-[var(--desk-line)] px-3 py-1.5">
              {report.flags.map((flag) => (
                <li key={flag} className="t-cap d-am flex items-start gap-1.5 py-0.5">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                  {flag}
                </li>
              ))}
            </ul>
          ) : null}
          {report.perSymbol.length === 0 ? (
            <PanelEmpty>No closed trades this week.</PanelEmpty>
          ) : (
            <Table id="weekSymbols" head={["Symbol", "N", "Total R"]}>
              {report.perSymbol.map((row) => (
                <TR key={row.symbol} title={`mean ${formatR(row.meanR)}`}>
                  <span className="t-body d-tx truncate">{row.symbol}</span>
                  <Num right>{row.trades}</Num>
                  <Num right tone={row.totalR > 0 ? "up" : row.totalR < 0 ? "dn" : undefined}>
                    {formatR(row.totalR)}
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

// ── regime states ───────────────────────────────────────────────────────────

export interface RegimePanelProps {
  available: boolean;
  states: RegimeRead[];
  ttlMs?: number;
  loading?: boolean;
}

export function RegimePanel({ available, states, ttlMs, loading }: RegimePanelProps) {
  return (
    <Panel id="regime" title="Desk-timeframe state" right={ttlMs ? <span className="tnum">{ttlMs / 1000}s memo</span> : null}>
      {!available ? (
        <PanelEmpty>
          The regime layer is switched off (<span className="tnum">DESK_V4_REGIME_HMM</span>).
        </PanelEmpty>
      ) : loading && states.length === 0 ? (
        <SkeletonRows rows={4} columns={4} />
      ) : states.length === 0 ? (
        <PanelEmpty>No symbol is selected on the desk yet.</PanelEmpty>
      ) : (
        <Table id="regime" head={["Symbol", "State", "Frame", "Dwell", "Permits"]}>
          {states.map((read) => {
            const split = regimeSplit(read);
            const breakRisk = read.changeProbability >= DESK_THRESHOLDS.breakRiskWarnFraction;
            return (
              <TR key={read.symbol} data-testid={`regime-row-${read.symbol}`} title={read.reason || undefined}>
                <span className="t-body d-tx truncate">{read.symbol}</span>
                <span className="flex min-w-0 flex-col justify-center gap-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Badge tone={read.available ? regimeTokenTone(read.state) : "mute"}>
                      {read.available ? regimeStateLabel(read.state) : "unavailable"}
                    </Badge>
                    {split ? <Num tone="mute">{Math.round(split.trend * 100)}% trend</Num> : null}
                  </span>
                  {split ? (
                    <span className="desk-meter flex w-full" aria-hidden="true">
                      <span className="h-full d-up" style={{ width: `${split.trend * 100}%`, background: "currentColor" }} />
                      <span className="h-full d-vi" style={{ width: `${split.range * 100}%`, background: "currentColor" }} />
                      <span className="h-full d-am" style={{ width: `${split.disorder * 100}%`, background: "currentColor" }} />
                    </span>
                  ) : null}
                </span>
                <Num>{read.frame || "—"}</Num>
                <Num tone={breakRisk ? "am" : undefined} title={`Probability the state changes within the horizon: ${(read.changeProbability * 100).toFixed(0)}%`}>
                  {read.expectedDwellBars} bars
                </Num>
                <PermitCell read={read} />
              </TR>
            );
          })}
        </Table>
      )}
    </Panel>
  );
}

function PermitCell({ read }: { read: RegimeRead }) {
  if (!read.available) return <span className="d-mute text-right">—</span>;
  const label = regimePermitLabel(read);
  return (
    <span className="flex items-center justify-end gap-1.5" title={label ?? undefined}>
      <span className={read.sides.buy.permit ? "d-up" : "d-dn"}>
        B<span aria-hidden="true">{read.sides.buy.permit ? "✓" : "✕"}</span>
        <span className="sr-only">Buy {read.sides.buy.permit ? "permitted" : "blocked"}</span>
      </span>
      <span className={read.sides.sell.permit ? "d-up" : "d-dn"}>
        S<span aria-hidden="true">{read.sides.sell.permit ? "✓" : "✕"}</span>
        <span className="sr-only">Sell {read.sides.sell.permit ? "permitted" : "blocked"}</span>
      </span>
    </span>
  );
}

// ── refusals ────────────────────────────────────────────────────────────────

export interface RefusedPanelProps {
  available: boolean;
  report: WeeklyReport | null;
}

export function RefusedPanel({ available, report }: RefusedPanelProps) {
  const rows = report ? refusalRows(report.decisions.refusalCodes).slice(0, 8) : [];
  return (
    <Panel
      id="refused"
      title="Why trades were refused"
      right={report ? <span className="tnum">{report.decisions.refused} refused</span> : null}
      footer={
        report ? (
          <span className="tnum">
            arm rate{" "}
            <Num tone={report.decisions.armRate !== null && report.decisions.armRate < 0.05 ? "am" : undefined}>
              {report.decisions.armRate !== null ? `${(report.decisions.armRate * 100).toFixed(1)}%` : "—"}
            </Num>
          </span>
        ) : null
      }
    >
      {!available || !report ? (
        <PanelEmpty>Refusals are counted by the governance layer's durable journal — it is not serving.</PanelEmpty>
      ) : rows.length === 0 ? (
        <PanelEmpty>Nothing was refused this week.</PanelEmpty>
      ) : (
        <Table id="refusals" head={["Code", "Share", "N"]}>
          {rows.map((row) => (
            <TR key={row.code} data-testid={`refusal-row-${row.code}`} title={`${row.count} of ${report.decisions.refused} refusals`}>
              <span className="t-body d-tx2 truncate tnum">{row.code}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <Meter fraction={row.share} tone="mute" className="min-w-0 flex-1" />
                <Num>{Math.round(row.share * 100)}%</Num>
              </span>
              <Num right>{row.count}</Num>
            </TR>
          ))}
        </Table>
      )}
    </Panel>
  );
}

// ── safety & kill rules ─────────────────────────────────────────────────────

export interface SafetyPanelProps {
  agents: GovernanceAgent[];
  report: WeeklyReport | null;
  /** The operator resume — the ONE write on this workspace. Reason ≥ 3 chars. */
  onResumeAgent: (agentId: string, note: string) => void;
  resumePending: boolean;
}

export function SafetyPanel({ agents, report, onResumeAgent, resumePending }: SafetyPanelProps) {
  const [resuming, setResuming] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const worstE = agents.length > 0 ? Math.max(...agents.map((agent) => agent.eValue)) : null;
  const killRules = killRuleStatus({
    maxDrawdownPct: null,
    worstAgentE: worstE,
    meanSlippageR: report?.trades.meanSlippageR ?? null,
  });
  const inactive = agents.filter((agent) => agent.status !== "active");
  const noteOk = note.trim().length >= DESK_THRESHOLDS.resumeReasonMinChars;

  return (
    <Panel id="safety" title="Safety & kill rules" bodyClassName="flex flex-col">
      <div className="min-h-0 flex-1">
        <SubHeader>Rollout kill rules</SubHeader>
        {killRules.map((row) => (
          <div key={row.rule} className="desk-kv flex h-9 items-center justify-between gap-2 px-3" data-testid={`kill-rule-${row.rule}`}>
            <span className="t-body d-tx2 truncate">{row.rule}</span>
            <span className="flex min-w-0 shrink-0 items-center gap-2">
              <span className="t-cap d-mute truncate" title={row.detail}>{row.detail}</span>
              <Badge tone={row.breached === null ? "mute" : row.breached ? "dn" : "up"}>
                {row.breached === null ? "not measurable" : row.breached ? "breached" : "inside"}
              </Badge>
            </span>
          </div>
        ))}
        <p className="t-cap d-mute px-3 py-2">
          The rollout also requires slope ∈ [0.8, 1.2] and a hit rate within 8 points of predicted on the live ledger;
          both are measured by the weekly report above and neither is inferred here.
        </p>
      </div>

      {inactive.length > 0 ? (
        <>
          <SubHeader right={<span>{inactive.length} awaiting an operator</span>}>Resumes</SubHeader>
          <div className="px-3 py-2">
            {inactive.map((agent) => (
              <div key={agent.agentId} className="mb-2 flex flex-wrap items-center gap-2 last:mb-0" data-testid={`resume-block-${agent.agentId}`}>
                <span className="tnum t-body d-tx">{agent.agentId}</span>
                <Badge tone={statusTone(agent.status)}>{agentStatusTone(agent.status as AgentStatus).label}</Badge>
                {resuming === agent.agentId ? (
                  <>
                    <input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="Why is this agent being resumed?"
                      aria-label={`Resume reason for ${agent.agentId}`}
                      className="t-body d-tx min-w-[160px] flex-1 rounded-[4px] border border-[var(--desk-line2)] bg-[var(--desk-bg)] px-2 py-1 outline-none"
                      data-testid={`resume-note-${agent.agentId}`}
                    />
                    <button
                      type="button"
                      className="desk-btn desk-btn-primary"
                      disabled={!noteOk || resumePending}
                      onClick={() => {
                        onResumeAgent(agent.agentId, note.trim());
                        setResuming(null);
                        setNote("");
                      }}
                      title={noteOk ? "Resume this agent (the evidence is kept, so it can halt again at once)" : `The reason needs at least ${DESK_THRESHOLDS.resumeReasonMinChars} characters`}
                      data-testid={`resume-agent-${agent.agentId}`}
                    >
                      {resumePending ? "Resuming…" : "Resume"}
                    </button>
                    <button
                      type="button"
                      className="desk-btn"
                      onClick={() => {
                        setResuming(null);
                        setNote("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="desk-btn ml-auto"
                    onClick={() => {
                      setResuming(agent.agentId);
                      setNote("");
                    }}
                    data-testid={`resume-open-${agent.agentId}`}
                  >
                    Resume with a reason…
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Panel>
  );
}

// ── the durable journal ─────────────────────────────────────────────────────

const KIND_FILTERS = ["risk", "execution", "no_trade", "signal"] as const;

export interface LearningJournalPanelProps {
  available: boolean;
  entries: JournalEntryRow[];
  /** The query key's kind filter — owned by the page (["desk-journal", kind]). */
  kind: string | null;
  onKind: (kind: string | null) => void;
  timeZone: string;
  loading?: boolean;
}

export function LearningJournalPanel({ available, entries, kind, onKind, timeZone, loading }: LearningJournalPanelProps) {
  return (
    <Panel
      id="learning-journal"
      title="Desk journal"
      right={<span className="tnum">{entries.length}</span>}
      bodyClassName="flex flex-col"
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--desk-line)] px-3" role="group" aria-label="Filter the journal">
        <Chip active={kind === null} onClick={() => onKind(null)}>all</Chip>
        {KIND_FILTERS.map((option) => (
          <Chip key={option} active={kind === option} onClick={() => onKind(option)}>
            {journalKindLabel(option)}
          </Chip>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {!available ? (
          <PanelEmpty>
            The durable journal is written while the governance layer is on; with it off the desk keeps only its
            in-process log, which is capped and lost on deploy.
          </PanelEmpty>
        ) : loading && entries.length === 0 ? (
          <SkeletonRows rows={6} columns={4} />
        ) : entries.length === 0 ? (
          <PanelEmpty>Nothing journalled yet.</PanelEmpty>
        ) : (
          <Table id="learningJournal" head={["When", "Kind", "Symbol", "Message"]}>
            {entries.map((entry) => (
              <TR key={entry.id} data-testid={`learning-journal-row-${entry.id}`} title={new Date(entry.ts).toISOString()}>
                <Num>
                  {formatInZone(entry.ts, timeZone, { day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                </Num>
                <span className="flex items-center">
                  <Badge tone={entry.kind === "risk" ? "am" : entry.kind === "error" ? "dn" : "mute"}>
                    {journalKindLabel(entry.kind)}
                  </Badge>
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
