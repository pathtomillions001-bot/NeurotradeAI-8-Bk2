/**
 * Multi-Asset Desk — terminal panes.
 *
 * Dense, monospaced, information-first. Every pane answers one question a
 * desk operator actually asks: what is moving, what does the agent think,
 * what am I holding, how much risk is left, and what just happened.
 */

import { useState } from "react";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  Minus,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  formatMoney,
  gradeColor,
  regimeColor,
  relativeTime,
  type AgentDecision,
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
    <section
      className={`flex flex-col min-h-0 rounded-md border border-zinc-800 bg-zinc-950/60 ${className}`}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0">
        <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
          {title}
        </h2>
        {right}
      </header>
      <div className="flex-1 min-h-0 overflow-auto">{children}</div>
    </section>
  );
}

function DirectionIcon({ direction }: { direction: string }) {
  if (direction === "up" || direction === "buy") {
    return <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  }
  if (direction === "down" || direction === "sell") {
    return <ArrowDownRight className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  }
  return <Minus className="w-3.5 h-3.5 text-zinc-600 shrink-0" />;
}

// ── Watchlist / quote board ──────────────────────────────────────────────────

export function WatchlistPane({
  instruments,
  selected,
  onSelect,
}: {
  instruments: Instrument[];
  selected: string;
  onSelect: (symbol: string) => void;
}) {
  return (
    <table className="w-full text-[11px] font-mono">
      <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
        <tr className="border-b border-zinc-800">
          <th className="text-left font-medium px-2 py-1">Symbol</th>
          <th className="text-right font-medium px-2 py-1">Bid</th>
          <th className="text-right font-medium px-2 py-1">Ask</th>
          <th className="text-right font-medium px-2 py-1">Spr</th>
          <th className="text-right font-medium px-2 py-1">Chg</th>
        </tr>
      </thead>
      <tbody>
        {instruments.map((instrument) => {
          const active = instrument.symbol === selected;
          const up = instrument.changePct >= 0;
          return (
            <tr
              key={instrument.symbol}
              onClick={() => onSelect(instrument.symbol)}
              className={`cursor-pointer border-b border-zinc-900 transition-colors ${
                active ? "bg-emerald-500/10" : "hover:bg-zinc-900/70"
              }`}
              data-testid={`watchlist-row-${instrument.symbol}`}
            >
              <td className="px-2 py-1">
                <div className={active ? "text-emerald-300 font-semibold" : "text-zinc-200"}>
                  {instrument.symbol}
                </div>
                <div className="text-[9px] uppercase tracking-wider text-zinc-600">
                  {instrument.assetClass}
                </div>
              </td>
              <td className="px-2 py-1 text-right text-zinc-300">
                {instrument.bid.toFixed(instrument.digits)}
              </td>
              <td className="px-2 py-1 text-right text-zinc-300">
                {instrument.ask.toFixed(instrument.digits)}
              </td>
              <td className="px-2 py-1 text-right text-zinc-500">{instrument.spreadPoints}</td>
              <td className={`px-2 py-1 text-right ${up ? "text-emerald-400" : "text-red-400"}`}>
                {up ? "+" : ""}
                {instrument.changePct.toFixed(2)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Scanner ──────────────────────────────────────────────────────────────────

export function ScannerPane({
  rows,
  onSelect,
  selected,
}: {
  rows: ScanRow[];
  onSelect: (symbol: string) => void;
  selected: string;
}) {
  if (rows.length === 0) {
    return <p className="p-3 text-[11px] text-zinc-500">Scanning the watchlist…</p>;
  }

  return (
    <ul className="divide-y divide-zinc-900">
      {rows.map((row) => (
        <li
          key={row.symbol}
          onClick={() => onSelect(row.symbol)}
          className={`px-2.5 py-1.5 cursor-pointer transition-colors ${
            row.symbol === selected ? "bg-emerald-500/10" : "hover:bg-zinc-900/70"
          }`}
          data-testid={`scan-row-${row.symbol}`}
        >
          <div className="flex items-center gap-2">
            <DirectionIcon direction={row.direction} />
            <span className="font-mono text-[11px] text-zinc-200 w-[68px]">{row.symbol}</span>
            <span
              className={`px-1 rounded border text-[9px] font-semibold ${gradeColor(row.grade)}`}
            >
              {row.grade}
            </span>
            <span className="font-mono text-[11px] text-zinc-400 ml-auto">
              {row.score.toFixed(0)}
            </span>
            {row.armed ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Ban className="w-3.5 h-3.5 text-zinc-700" />
            )}
          </div>
          <p className="text-[10px] text-zinc-500 mt-0.5 line-clamp-1 pl-[22px]">
            {row.armed && row.expectancyR !== null
              ? `E ${row.expectancyR.toFixed(2)}R · ${((row.winProbability ?? 0) * 100).toFixed(0)}% win · ${row.lots ?? 0} lots`
              : (row.rejections[0] ?? "No setup")}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ── Agent analysis ───────────────────────────────────────────────────────────

export function AgentPane({
  decision,
  horizonMinutes,
  onArm,
  arming,
  armError,
}: {
  decision: AgentDecision | null;
  horizonMinutes: number;
  onArm: () => void;
  arming: boolean;
  armError: string | null;
}) {
  if (!decision) {
    return <p className="p-3 text-[11px] text-zinc-500">Analysing…</p>;
  }

  const { confluence, monteCarlo, sizing } = decision;

  return (
    <div className="p-2.5 space-y-2.5">
      {/* Verdict */}
      <div className="flex items-start gap-2">
        <div
          className={`px-1.5 py-0.5 rounded border text-[11px] font-bold ${gradeColor(confluence.grade)}`}
        >
          {confluence.grade}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <DirectionIcon direction={confluence.direction} />
            <span className="text-[12px] font-semibold text-zinc-100">
              {confluence.direction === "none"
                ? "No bias"
                : confluence.direction === "up"
                  ? "Long bias"
                  : "Short bias"}
            </span>
            <span className="font-mono text-[11px] text-zinc-500">
              {confluence.score.toFixed(0)}/100
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-0.5">
            Horizon ≈ {horizonMinutes} min
            {!confluence.higherTimeframeAligned && " · higher timeframe opposed"}
          </p>
        </div>
      </div>

      {/* Score bar */}
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full ${
            confluence.score >= 72
              ? "bg-emerald-500"
              : confluence.score >= 60
                ? "bg-amber-500"
                : "bg-zinc-600"
          }`}
          style={{ width: `${Math.min(100, confluence.score)}%` }}
        />
      </div>

      {/* Probabilities */}
      {monteCarlo && (
        <dl className="grid grid-cols-4 gap-1.5 text-center">
          <Metric label="Win" value={`${(monteCarlo.winProbability * 100).toFixed(0)}%`} />
          <Metric
            label="Net E"
            value={`${monteCarlo.expectancyR >= 0 ? "+" : ""}${monteCarlo.expectancyR.toFixed(2)}R`}
            tone={monteCarlo.expectancyR > 0 ? "good" : "bad"}
          />
          <Metric label="R:R" value={monteCarlo.rewardRisk.toFixed(1)} />
          <Metric label="Bars" value={monteCarlo.meanBarsToResolve.toFixed(0)} />
        </dl>
      )}

      {/* Timeframe grid */}
      <div>
        <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">Timeframes</p>
        <div className="space-y-0.5">
          {confluence.views.map((view) => (
            <div key={view.timeframe} className="flex items-center gap-1.5 text-[10px] font-mono">
              <span className="w-7 text-zinc-500">{view.timeframe}</span>
              <span className={`w-[70px] ${regimeColor(view.kind)}`}>{view.kind}</span>
              <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={view.contribution >= 0 ? "h-full bg-emerald-500/70" : "h-full bg-red-500/70"}
                  style={{ width: `${Math.min(100, Math.abs(view.contribution) * 220)}%` }}
                />
              </div>
              <span className="w-8 text-right text-zinc-500">{view.rsi.toFixed(0)}</span>
              <span className="w-9 text-right text-zinc-600">
                {(view.persistence * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Sizing */}
      {sizing && (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
          <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">Position sizing</p>
          <p className="text-[10px] font-mono text-zinc-300 leading-relaxed">{sizing.explanation}</p>
        </div>
      )}

      {/* Verdict / refusals */}
      {decision.armed && decision.plan ? (
        <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-300 font-semibold">
            <CheckCircle2 className="w-3.5 h-3.5" /> A+ setup — ready to arm
          </div>
          <div className="grid grid-cols-3 gap-1 text-[10px] font-mono text-zinc-400">
            <span>Trigger {decision.plan.trigger.toFixed(5)}</span>
            <span className="text-red-400">SL {decision.plan.sl.toFixed(5)}</span>
            <span className="text-emerald-400">TP {decision.plan.tp[0]?.toFixed(5)}</span>
          </div>
          <button
            type="button"
            onClick={onArm}
            disabled={arming}
            className="w-full py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-[11px] font-semibold text-white transition-colors"
            data-testid="arm-plan"
          >
            {arming ? "Arming…" : `Arm ${decision.plan.side.toUpperCase()} ${decision.plan.lots} lots`}
          </button>
          {armError && (
            <p className="text-[10px] text-amber-400 leading-snug flex gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
              {armError}
            </p>
          )}
        </div>
      ) : (
        <div className="rounded border border-zinc-800 bg-zinc-900/50 p-2">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-300 font-semibold mb-1">
            <XCircle className="w-3.5 h-3.5 text-zinc-500" /> No trade
          </div>
          <ul className="space-y-1">
            {decision.rejections.map((reason) => (
              <li key={reason} className="text-[10px] text-zinc-500 leading-snug flex gap-1">
                <span className="text-zinc-700">•</span>
                {reason}
              </li>
            ))}
            {decision.rejections.length === 0 && (
              <li className="text-[10px] text-zinc-500">Waiting for a qualifying setup.</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  const colour = tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-red-400" : "text-zinc-200";
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 py-1">
      <dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className={`font-mono text-[12px] ${colour}`}>{value}</dd>
    </div>
  );
}

// ── Positions ────────────────────────────────────────────────────────────────

export function PositionsPane({
  positions,
  currency,
  onClose,
}: {
  positions: Position[];
  currency: string;
  onClose: (ticket: number) => void;
}) {
  if (positions.length === 0) {
    return <p className="p-3 text-[11px] text-zinc-500">No open positions.</p>;
  }

  return (
    <table className="w-full text-[11px] font-mono">
      <thead className="sticky top-0 bg-zinc-950 text-zinc-500">
        <tr className="border-b border-zinc-800">
          <th className="text-left font-medium px-2 py-1">Symbol</th>
          <th className="text-right font-medium px-2 py-1">Vol</th>
          <th className="text-right font-medium px-2 py-1">Entry</th>
          <th className="text-right font-medium px-2 py-1">SL</th>
          <th className="text-right font-medium px-2 py-1">P&L</th>
          <th className="px-2 py-1" />
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const net = position.profit + position.swap + position.commission;
          return (
            <tr key={position.ticket} className="border-b border-zinc-900">
              <td className="px-2 py-1">
                <span className="flex items-center gap-1">
                  <DirectionIcon direction={position.side} />
                  <span className="text-zinc-200">{position.symbol}</span>
                </span>
              </td>
              <td className="px-2 py-1 text-right text-zinc-300">{position.volume}</td>
              <td className="px-2 py-1 text-right text-zinc-400">{position.openPrice}</td>
              <td className="px-2 py-1 text-right text-zinc-500">{position.sl ?? "—"}</td>
              <td className={`px-2 py-1 text-right ${net >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {formatMoney(net, currency)}
              </td>
              <td className="px-2 py-1 text-right">
                <button
                  type="button"
                  onClick={() => onClose(position.ticket)}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:border-red-500/50 hover:text-red-400 transition-colors"
                >
                  Close
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Risk ─────────────────────────────────────────────────────────────────────

export function RiskPane({
  state,
  onResume,
}: {
  state: DeskStateResponse;
  onResume: (symbol: string) => void;
}) {
  const { risk, account, policy } = state;
  const budgetColour =
    risk.budget.usedPct >= 80 ? "bg-red-500" : risk.budget.usedPct >= 50 ? "bg-amber-500" : "bg-emerald-500";

  return (
    <div className="p-2.5 space-y-2.5 text-[11px]">
      {risk.state.haltedUntilNextSession && (
        <div className="flex gap-1.5 rounded border border-red-500/40 bg-red-500/10 p-2 text-red-300">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="text-[10px] leading-snug">{risk.state.haltReason}</span>
        </div>
      )}

      <div>
        <div className="flex justify-between text-[10px] text-zinc-500 mb-1">
          <span>Daily loss budget</span>
          <span className="font-mono">
            {formatMoney(risk.budget.remainingMoney, account.currency)} left of{" "}
            {formatMoney(risk.budget.limitMoney, account.currency)}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div className={`h-full ${budgetColour}`} style={{ width: `${risk.budget.usedPct}%` }} />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-1.5">
        <Stat label="Equity" value={formatMoney(account.equity, account.currency)} />
        <Stat label="Balance" value={formatMoney(account.balance, account.currency)} />
        <Stat label="Free margin" value={formatMoney(account.freeMargin, account.currency)} />
        <Stat
          label="Margin level"
          value={Number.isFinite(account.marginLevel) ? `${account.marginLevel.toFixed(0)}%` : "∞"}
        />
        <Stat label="Loss streak" value={String(risk.state.consecutiveLosses)} />
        <Stat label="Trades today" value={String(risk.state.tradesToday)} />
      </dl>

      {risk.exposure.length > 0 && (
        <div>
          <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">
            Net exposure (cap {policy.maxCurrencyExposurePct}%)
          </p>
          <div className="space-y-0.5">
            {risk.exposure.map((entry) => (
              <div key={entry.key} className="flex items-center gap-2 font-mono text-[10px]">
                <span className="w-12 text-zinc-400">{entry.key}</span>
                <div className="flex-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className={
                      entry.riskPct >= policy.maxCurrencyExposurePct ? "h-full bg-red-500" : "h-full bg-sky-500"
                    }
                    style={{
                      width: `${Math.min(100, (entry.riskPct / policy.maxCurrencyExposurePct) * 100)}%`,
                    }}
                  />
                </div>
                <span className="w-10 text-right text-zinc-500">{entry.riskPct.toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {risk.state.suspendedSymbols.length > 0 && (
        <div>
          <p className="text-[9px] uppercase tracking-wider text-zinc-600 mb-1">
            Suspended — awaiting regime change
          </p>
          <div className="flex flex-wrap gap-1">
            {risk.state.suspendedSymbols.map((symbol) => (
              <button
                key={symbol}
                type="button"
                onClick={() => onResume(symbol)}
                className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-300 hover:bg-amber-500/20 transition-colors"
                title="Lift the suspension once the regime has changed"
              >
                {symbol} ↻
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1">
      <dt className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className="font-mono text-[11px] text-zinc-200">{value}</dd>
    </div>
  );
}

// ── Journal ──────────────────────────────────────────────────────────────────

const JOURNAL_COLOURS: Record<JournalEntry["kind"], string> = {
  signal: "text-emerald-400",
  no_trade: "text-zinc-600",
  execution: "text-sky-400",
  risk: "text-amber-400",
  bridge: "text-violet-400",
};

export function JournalPane({ entries }: { entries: JournalEntry[] }) {
  const [filter, setFilter] = useState<"all" | JournalEntry["kind"]>("all");
  const visible = filter === "all" ? entries : entries.filter((e) => e.kind === filter);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex gap-1 px-2 py-1 border-b border-zinc-900 shrink-0">
        {(["all", "signal", "execution", "risk"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setFilter(kind)}
            className={`px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider transition-colors ${
              filter === kind ? "bg-zinc-800 text-zinc-200" : "text-zinc-600 hover:text-zinc-400"
            }`}
          >
            {kind}
          </button>
        ))}
      </div>
      <ul className="flex-1 min-h-0 overflow-auto divide-y divide-zinc-900">
        {visible.length === 0 && (
          <li className="p-3 text-[11px] text-zinc-500">Nothing logged yet.</li>
        )}
        {visible.map((entry) => (
          <li key={entry.id} className="px-2 py-1 flex gap-2">
            <span className="font-mono text-[9px] text-zinc-600 shrink-0 w-14 pt-px">
              {relativeTime(entry.ts)}
            </span>
            <span className={`text-[10px] leading-snug ${JOURNAL_COLOURS[entry.kind]}`}>
              {entry.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
