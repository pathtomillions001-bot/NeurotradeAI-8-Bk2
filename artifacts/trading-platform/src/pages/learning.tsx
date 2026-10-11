/**
 * WP10 — the learning page.
 *
 * This is the page that answers the two questions a desk's own record exists for:
 * "is what we are doing still working?" and "what did the desk actually do last
 * week, and why?". It reads four surfaces — the governance registry, the weekly
 * report, the durable journal and the desk-timeframe regime state — and it writes
 * exactly one thing: the operator's resume of an agent, which requires a reason.
 *
 * Every panel is present only when the API serves it. The v4 layers ship OFF, so on
 * a desk that has never switched them on this page says so plainly instead of
 * rendering zeros that look like measurements.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, BookOpen, Brain, Gauge, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deskApi, type GovernanceAgent } from "@/lib/desk";
import {
  agentStatusTone,
  brierVerdict,
  calibrationVerdict,
  eBarFraction,
  eHalveFraction,
  formatEValue,
  formatProbability,
  formatR,
  journalKindLabel,
  killRuleStatus,
  refusalRows,
  regimeTone,
  weeklyHeadline,
} from "@/lib/learning";

function Panel({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-zinc-800 bg-zinc-950/60">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            {icon}
            {title}
          </div>
          {right}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

const KIND_FILTERS = ["risk", "execution", "no_trade", "signal"] as const;

export default function Learning() {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [resuming, setResuming] = useState<string | null>(null);

  const governance = useQuery({
    queryKey: ["desk-governance"],
    queryFn: () => deskApi.governance(),
    refetchInterval: 30_000,
    retry: false,
  });
  const weekly = useQuery({
    queryKey: ["desk-weekly"],
    queryFn: () => deskApi.weeklyReport(),
    refetchInterval: 60_000,
    retry: false,
  });
  const journal = useQuery({
    queryKey: ["desk-journal", kind],
    queryFn: () => deskApi.journal({ kind, limit: 100 }),
    refetchInterval: 30_000,
    retry: false,
  });
  const regime = useQuery({
    queryKey: ["desk-regime"],
    queryFn: () => deskApi.regime(),
    refetchInterval: 2_000,
    retry: false,
  });

  const resume = useMutation({
    mutationFn: (input: { agentId: string; note: string }) => deskApi.resumeAgent(input.agentId, input.note),
    onSuccess: (_data, variables) => {
      toast.success(`${variables.agentId} resumed — the evidence is kept, so it can halt again at once.`);
      setResuming(null);
      setNote("");
      void queryClient.invalidateQueries({ queryKey: ["desk-governance"] });
      void queryClient.invalidateQueries({ queryKey: ["desk-journal"] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "The resume was refused.");
    },
  });

  const agents: GovernanceAgent[] = governance.data?.available ? governance.data.agents : [];
  const registryAvailable = governance.data?.available ?? false;
  const report = weekly.data?.available ? weekly.data.report : null;
  const entries = journal.data?.available ? journal.data.entries : [];
  const journalAvailable = journal.data?.available ?? false;
  const states = regime.data?.available ? regime.data.states : [];
  const regimeAvailable = regime.data?.available ?? false;

  const halveFraction = eHalveFraction(agents[0]?.halveAt ?? 5, agents[0]?.disableAt ?? 20);
  const worstE = agents.length > 0 ? Math.max(...agents.map((agent) => agent.eValue)) : null;
  const killRules = killRuleStatus({
    maxDrawdownPct: null,
    worstAgentE: worstE,
    meanSlippageR: report?.trades.meanSlippageR ?? null,
  });
  const calibration = calibrationVerdict(report?.trades.calibrationGapPoints ?? null);
  const brier = brierVerdict(report?.trades.brier ?? null);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-4 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Learning &amp; governance</h1>
            <p className="text-xs text-zinc-500">
              What the desk has learned from its own outcomes, and what it is allowed to do about it. Every number here
              comes from a stored row — nothing is estimated for display.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-2 border-zinc-700"
            onClick={() => {
              void governance.refetch();
              void weekly.refetch();
              void journal.refetch();
            }}
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </header>

        {/* ── the registry ─────────────────────────────────────────────────── */}
        <Panel
          title="Per-agent governance"
          icon={<ShieldCheck className="size-4 text-emerald-400" />}
          right={
            <span className="font-mono text-[10px] text-zinc-500">
              e ≥ {agents[0]?.halveAt ?? 5} halves · e ≥ {agents[0]?.disableAt ?? 20} disables
            </span>
          }
        >
          {!registryAvailable ? (
            <p className="text-xs text-zinc-500">
              The governance layer is switched off (<span className="font-mono">DESK_V4_GOVERNANCE</span>). No agent is
              being governed, and nothing on this desk is being halved or disabled by its own record.
            </p>
          ) : (
            <div className="space-y-2">
              {agents.map((agent) => {
                const tone = agentStatusTone(agent.status);
                const fraction = eBarFraction(agent.eValue, agent.disableAt);
                return (
                  <div key={agent.agentId} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-zinc-200">{agent.agentId}</span>
                        <Badge variant="outline" className={tone.className}>
                          {tone.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 font-mono text-[10px] text-zinc-500">
                        <span>e {formatEValue(agent.eValue)}</span>
                        <span>
                          {agent.wins}/{agent.outcomes} wins
                        </span>
                        <span>{formatR(agent.totalR)}</span>
                        <span>PH {agent.phValue.toFixed(1)}</span>
                      </div>
                    </div>
                    <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
                      <div
                        className={agent.status === "disabled" ? "h-full bg-rose-500" : "h-full bg-amber-400"}
                        style={{ width: `${(fraction * 100).toFixed(1)}%` }}
                      />
                      <div
                        className="absolute top-0 h-full w-px bg-zinc-500"
                        style={{ left: `${(halveFraction * 100).toFixed(1)}%` }}
                        title={`halve threshold (e ≥ ${agent.halveAt})`}
                      />
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-500">{agent.reason ?? tone.blurb}</p>
                    {agent.status !== "active" && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {resuming === agent.agentId ? (
                          <>
                            <input
                              value={note}
                              onChange={(event) => setNote(event.target.value)}
                              placeholder="Why is this agent being resumed?"
                              className="min-w-[220px] flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                            />
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={note.trim().length < 3 || resume.isPending}
                              onClick={() => resume.mutate({ agentId: agent.agentId, note: note.trim() })}
                            >
                              Resume
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => {
                                setResuming(null);
                                setNote("");
                              }}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 border-zinc-700 text-xs"
                            onClick={() => setResuming(agent.agentId)}
                          >
                            Resume with a reason…
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <p className="text-[11px] text-zinc-600">
                Distinct thresholds stop a degraded agent in two steps rather than pouring risk into it until an
                operator notices.
              </p>
            </div>
          )}
        </Panel>

        {/* ── the weekly report ────────────────────────────────────────────── */}
        <Panel title="This week" icon={<BookOpen className="size-4 text-sky-400" />}>
          {!report ? (
            <p className="text-xs text-zinc-500">
              No weekly report is being served: the report is built from the durable shadow ledger, which the governance
              layer writes.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="font-mono text-[11px] text-zinc-400">{weeklyHeadline(report)}</div>
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] text-zinc-400">
                <span>
                  calibration gap{" "}
                  <span className={calibration.tone === "ok" ? "text-emerald-400" : "text-amber-400"}>
                    {report.trades.calibrationGapPoints === null
                      ? "—"
                      : `${report.trades.calibrationGapPoints.toFixed(1)} pts`}
                  </span>{" "}
                  <span className="text-zinc-600">({calibration.label})</span>
                </span>
                <span>
                  Brier{" "}
                  <span className={brier.tone === "ok" ? "text-emerald-400" : "text-amber-400"}>
                    {report.trades.brier === null ? "—" : report.trades.brier.toFixed(3)}
                  </span>{" "}
                  <span className="text-zinc-600">({brier.label})</span>
                </span>
                <span>
                  mean predicted{" "}
                  <span className="text-zinc-200">{formatProbability(report.trades.meanPredictedProbability)}</span>
                </span>
                <span>
                  slippage <span className="text-zinc-200">{report.trades.meanSlippageR === null ? "—" : `${report.trades.meanSlippageR.toFixed(3)}R`}</span>
                </span>
                <span>
                  decisions{" "}
                  <span className="text-zinc-200">
                    {report.decisions.armed} armed / {report.decisions.evaluated} evaluated
                  </span>
                </span>
              </div>

              {report.decisions.refusalCodes.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500">Why the rest were refused</div>
                  {refusalRows(report.decisions.refusalCodes)
                    .slice(0, 8)
                    .map((row) => (
                      <div key={row.code} className="flex items-center gap-2">
                        <span className="w-40 shrink-0 truncate font-mono text-[10px] text-zinc-400">{row.code}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
                          <div className="h-full bg-zinc-500" style={{ width: `${(row.share * 100).toFixed(1)}%` }} />
                        </div>
                        <span className="w-8 text-right font-mono text-[10px] text-zinc-500">{row.count}</span>
                      </div>
                    ))}
                </div>
              )}

              {report.flags.length > 0 && (
                <ul className="space-y-1">
                  {report.flags.map((flag) => (
                    <li key={flag} className="flex items-start gap-2 text-[11px] text-amber-300/90">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                      {flag}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── the kill rules ─────────────────────────────────────────────── */}
          <Panel title="Rollout kill rules" icon={<Gauge className="size-4 text-amber-400" />}>
            <div className="space-y-2">
              {killRules.map((row) => (
                <div key={row.rule} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-zinc-300">{row.rule}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-zinc-500">{row.detail}</span>
                    <Badge
                      variant="outline"
                      className={
                        row.breached === null
                          ? "border-zinc-700 text-zinc-400"
                          : row.breached
                            ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                      }
                    >
                      {row.breached === null ? "not measurable" : row.breached ? "breached" : "inside"}
                    </Badge>
                  </span>
                </div>
              ))}
              <p className="text-[11px] text-zinc-600">
                The rollout also requires slope ∈ [0.8, 1.2] and a hit rate within 8 points of predicted on the live
                ledger; both are measured by the weekly report above and neither is inferred here.
              </p>
            </div>
          </Panel>

          {/* ── the regime state ──────────────────────────────────────────── */}
          <Panel
            title="Desk-timeframe state"
            icon={<Activity className="size-4 text-emerald-400" />}
            right={
              <span className="font-mono text-[10px] text-zinc-600">
                {regime.data?.ttlMs ? `${regime.data.ttlMs / 1000}s memo` : ""}
              </span>
            }
          >
            {!regimeAvailable ? (
              <p className="text-xs text-zinc-500">
                The regime layer is switched off (<span className="font-mono">DESK_V4_REGIME_HMM</span>).
              </p>
            ) : states.length === 0 ? (
              <p className="text-xs text-zinc-500">No symbol is selected on the desk yet.</p>
            ) : (
              <div className="space-y-2">
                {states.map((read) => (
                  <div key={read.symbol} className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono text-xs text-zinc-200">{read.symbol}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className={regimeTone(read.state)}>
                          {read.available ? read.state.replace("_", " ") : "unavailable"}
                        </Badge>
                        <span className="font-mono text-[10px] text-zinc-500">{read.frame}</span>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-500">{read.reason}</p>
                    {read.available && (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-500">
                        <span>
                          P(buy) {(read.sides.buy.probability * 100).toFixed(1)}% ·{" "}
                          <span className={read.sides.buy.permit ? "text-emerald-400" : "text-rose-400"}>
                            {read.sides.buy.permit ? "permitted" : read.sides.buy.codes.join(",")}
                          </span>
                        </span>
                        <span>
                          P(sell) {(read.sides.sell.probability * 100).toFixed(1)}% ·{" "}
                          <span className={read.sides.sell.permit ? "text-emerald-400" : "text-rose-400"}>
                            {read.sides.sell.permit ? "permitted" : read.sides.sell.codes.join(",")}
                          </span>
                        </span>
                        <span>age {read.cached ? `${read.ageMs}ms (memo)` : "fresh"}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        {/* ── the journal ───────────────────────────────────────────────────── */}
        <Panel
          title="Desk journal"
          icon={<Brain className="size-4 text-violet-400" />}
          right={
            <div className="flex gap-1">
              <Button
                size="sm"
                variant={kind === null ? "secondary" : "ghost"}
                className="h-6 text-[10px]"
                onClick={() => setKind(null)}
              >
                all
              </Button>
              {KIND_FILTERS.map((option) => (
                <Button
                  key={option}
                  size="sm"
                  variant={kind === option ? "secondary" : "ghost"}
                  className="h-6 text-[10px]"
                  onClick={() => setKind(option)}
                >
                  {journalKindLabel(option)}
                </Button>
              ))}
            </div>
          }
        >
          {!journalAvailable ? (
            <p className="text-xs text-zinc-500">
              The durable journal is written while the governance layer is on; with it off the desk keeps only its
              in-process log, which is capped and lost on deploy.
            </p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-zinc-500">Nothing journalled yet.</p>
          ) : (
            <div className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-start gap-3 border-b border-zinc-900 py-1.5">
                  <span className="w-28 shrink-0 font-mono text-[10px] text-zinc-600">
                    {new Date(entry.ts).toISOString().slice(5, 19).replace("T", " ")}
                  </span>
                  <Badge variant="outline" className="shrink-0 border-zinc-700 text-[10px] text-zinc-400">
                    {journalKindLabel(entry.kind)}
                  </Badge>
                  <span className="flex-1 text-[11px] text-zinc-300">
                    {entry.symbol ? <span className="font-mono text-zinc-500">{entry.symbol} · </span> : null}
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
