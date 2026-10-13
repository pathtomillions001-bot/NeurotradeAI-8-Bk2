/**
 * Multi-Asset Desk — v5: ONE terminal-style dashboard.
 *
 * Four workspaces (Command | Markets | Learning | Journal & performance) in a
 * single frame: title bar 48 · tabs 40 · work area (context strip, alert
 * slot, twelve-column panel grid) · status bar 28. The old /learning page
 * lives here now as the Learning workspace (?tab=learning), and no chart is
 * rendered anywhere — markets are numbers, calibration is a table with bars.
 *
 * Everything operational about the v4 desk is untouched: the same queries and
 * keys, the same refetch intervals (the stream beats polling), the same
 * mutations and safety flows (FLATTEN, resume-symbol, resume-agent with a
 * ≥3-character reason, arm only when armable), the same data-testids, and the
 * same rule that nothing is shown until a paired MT5 terminal provides it.
 * Two lightweight keys were ADDED for the new surfaces: ["desk-execution"]
 * (30s) and ["desk-bridge-status"] (60s), both only while paired.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { toast } from "sonner";
import { Link2 } from "lucide-react";

import { AutoTradeSettingsDialog } from "@/components/desk/auto-trader-settings";
import { BridgeDialog } from "@/components/terminal/bridge-dialog";
import { useDeskStream } from "@/hooks/use-desk-stream";
import { DeskShell } from "@/components/desk/desk-shell";
import { TitleBar } from "@/components/desk/title-bar";
import { WorkspaceTabs } from "@/components/desk/workspace-tabs";
import { StatusBar } from "@/components/desk/status-bar";
import { StatStrip, type StatTile } from "@/components/desk/stat-strip";
import { PipelineStrip } from "@/components/desk/pipeline-strip";
import { ROLLOUT_STAGES, type DeskTab } from "@/components/desk/desk-layout";
import {
  CalendarPanel,
  DecisionPanel,
  OpportunitiesPanel,
  PositionsPanel,
  RiskPanel,
} from "@/components/desk/workspaces/command";
import {
  AutoSelectPanel,
  HealthPanel,
  ScannerPanel,
  UniversePanel,
} from "@/components/desk/workspaces/markets";
import {
  CalibrationPanel,
  GovernancePanel,
  LearningJournalPanel,
  RefusedPanel,
  RegimePanel,
  SafetyPanel,
  WeekPanel,
} from "@/components/desk/workspaces/learning";
import {
  BySymbolPanel,
  ClosedTradesPanel,
  DecisionJournalPanel,
} from "@/components/desk/workspaces/journal";
import {
  DEFAULT_DESK_TIMEZONE,
  TRADE_MODES,
  deskApi,
  formatInZone,
  formatMoney,
  type Instrument,
  type TradeMode,
} from "@/lib/desk";
import {
  buildAlerts,
  buildGateRows,
  buildOpportunityRows,
  buildPipeline,
  buildRiskRows,
  committedRisk,
  dayChangePct,
  deskSearchForTab,
  deskTabFromSearch,
  formatPct,
  formatPrice,
  formatSignedPct,
  formatSignedR,
  governedAgentAlertCount,
  netOpenResults,
  openRiskPct,
  riskBadge,
  rolloutDemoNote,
  rolloutStage,
} from "@/lib/desk-ui";
import type { ReactNode } from "react";

const REFRESH_MS = 5_000;

export default function Terminal() {
  const queryClient = useQueryClient();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const tab = deskTabFromSearch(search);

  const [symbol, setSymbol] = useState("");
  const [bridgeOpen, setBridgeOpen] = useState(false);
  // The auto-trader settings surface (change #2). It hangs off the title bar so
  // the policy is one click from the desk it governs — no navigation away.
  const [autoTradeOpen, setAutoTradeOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The LEARNING journal's kind filter — part of its query key. */
  const [journalKind, setJournalKind] = useState<string | null>(null);

  // ── the v4 desk's queries, keys and intervals, unchanged ─────────────────
  const state = useQuery({
    queryKey: ["desk-state"],
    queryFn: deskApi.state,
    refetchInterval: REFRESH_MS,
  });
  const terminal = state.data?.terminal ?? null;
  const account = state.data?.account ?? null;
  const terminalLive = Boolean(terminal && !terminal.stale && account);
  const mode: TradeMode = state.data?.mode ?? "intraday";
  const selectedMarkets = state.data?.watchlist ?? [];
  const timeZone = state.data?.timezone ?? DEFAULT_DESK_TIMEZONE;
  const hasTerminal = Boolean(terminal);

  // Quotes, account, positions and plans are pushed on every terminal
  // heartbeat; the polled `state` query is the fallback.
  const stream = useDeskStream(hasTerminal);

  const markets = useQuery({
    queryKey: ["desk-markets"],
    queryFn: deskApi.markets,
    enabled: hasTerminal,
    refetchInterval: 30_000,
  });
  const instruments = useQuery({
    queryKey: ["desk-instruments"],
    queryFn: deskApi.instruments,
    enabled: hasTerminal,
    // While the stream delivers prices polling is a slow fallback; the moment
    // data stops flowing the poll drops to 3s so the board reflects reality.
    refetchInterval: stream.flowing ? 20_000 : 3_000,
  });
  const performance = useQuery({
    queryKey: ["desk-performance"],
    queryFn: deskApi.performance,
    enabled: hasTerminal,
    refetchInterval: 30_000,
  });
  const analysis = useQuery({
    queryKey: ["desk-analysis", symbol, mode],
    queryFn: () => deskApi.analysis(symbol, mode),
    enabled: terminalLive && Boolean(symbol),
    refetchInterval: 20_000,
  });
  const scan = useQuery({
    queryKey: ["desk-scan", mode, selectedMarkets],
    queryFn: () => deskApi.scan(mode),
    enabled: terminalLive && selectedMarkets.length > 0,
    refetchInterval: 30_000,
  });

  // ── the learning surfaces (old /learning page: same keys, same intervals) ─
  const governance = useQuery({
    queryKey: ["desk-governance"],
    queryFn: () => deskApi.governance(),
    enabled: hasTerminal,
    refetchInterval: 30_000,
    retry: false,
  });
  const weekly = useQuery({
    queryKey: ["desk-weekly"],
    queryFn: () => deskApi.weeklyReport(),
    enabled: hasTerminal,
    refetchInterval: 60_000,
    retry: false,
  });
  const learningJournal = useQuery({
    queryKey: ["desk-journal", journalKind],
    queryFn: () => deskApi.journal({ kind: journalKind, limit: 100 }),
    enabled: hasTerminal,
    refetchInterval: 30_000,
    retry: false,
  });
  const regime = useQuery({
    queryKey: ["desk-regime"],
    queryFn: () => deskApi.regime(),
    enabled: hasTerminal,
    refetchInterval: 2_000,
    retry: false,
  });

  // ── v5 additions: the execution ledger and the bridge's own status ────────
  const execution = useQuery({
    queryKey: ["desk-execution"],
    queryFn: () => deskApi.execution(),
    enabled: hasTerminal,
    refetchInterval: 30_000,
    retry: false,
  });
  const bridgeStatus = useQuery({
    queryKey: ["desk-bridge-status"],
    queryFn: () => deskApi.bridgeStatus(),
    enabled: hasTerminal,
    refetchInterval: 60_000,
    retry: false,
  });

  // Select a real selected symbol as soon as the terminal coverage changes.
  useEffect(() => {
    if (selectedMarkets.length === 0) {
      if (symbol) setSymbol("");
      return;
    }
    if (!selectedMarkets.includes(symbol)) setSymbol(selectedMarkets[0] as string);
  }, [selectedMarkets, symbol]);

  useEffect(() => setActionError(null), [symbol, mode]);

  const invalidateDesk = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["desk-state"] });
    queryClient.invalidateQueries({ queryKey: ["desk-markets"] });
    queryClient.invalidateQueries({ queryKey: ["desk-instruments"] });
    queryClient.invalidateQueries({ queryKey: ["desk-analysis"] });
    queryClient.invalidateQueries({ queryKey: ["desk-scan"] });
    queryClient.invalidateQueries({ queryKey: ["desk-performance"] });
  }, [queryClient]);

  // ── mutations: the v4 desk's, plus the learning page's resume and run-now ─
  const settings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => deskApi.settings(patch),
    onSuccess: () => {
      setActionError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setActionError(error.message),
  });
  const arm = useMutation({
    mutationFn: () => deskApi.arm(symbol, mode),
    onSuccess: () => {
      setActionError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setActionError(error.message),
  });
  const flatten = useMutation({
    mutationFn: () => deskApi.flatten("Manual Desk kill switch"),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const closePosition = useMutation({
    mutationFn: (ticket: number) => deskApi.closePosition(ticket),
    onSuccess: invalidateDesk,
    onError: (error: Error) => setActionError(error.message),
  });
  const resumeSymbol = useMutation({
    mutationFn: (value: string) => deskApi.resumeSymbol(value),
    onSuccess: invalidateDesk,
  });
  const cancelPlan = useMutation({
    mutationFn: (id: string) => deskApi.cancelPlan(id),
    onSuccess: invalidateDesk,
  });
  const resumeAgent = useMutation({
    mutationFn: (input: { agentId: string; note: string }) => deskApi.resumeAgent(input.agentId, input.note),
    onSuccess: (_data, variables) => {
      toast.success(`${variables.agentId} resumed — the evidence is kept, so it can halt again at once.`);
      void queryClient.invalidateQueries({ queryKey: ["desk-governance"] });
      void queryClient.invalidateQueries({ queryKey: ["desk-journal"] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "The resume was refused.");
    },
  });
  const runAutoSelect = useMutation({
    mutationFn: () => deskApi.autoSelect(),
    onSuccess: () => {
      setActionError(null);
      invalidateDesk();
    },
    onError: (error: Error) => setActionError(error.message),
  });

  // ── live data: the stream always wins over the polls ──────────────────────
  const liveInstruments = stream.instruments ?? instruments.data?.instruments ?? [];
  const liveAccount = stream.account ?? account;
  const livePositions = stream.positions ?? state.data?.positions ?? [];
  const livePlans = stream.plans ?? state.data?.plans ?? [];

  const selectedInstrument = useMemo<Instrument | null>(
    () => liveInstruments.find((instrument) => instrument.symbol === symbol) ?? null,
    [liveInstruments, symbol],
  );
  const mismatchedSymbols = useMemo(
    () => liveInstruments.filter((instrument) => instrument.dataStatus === "mismatch").map((instrument) => instrument.symbol),
    [liveInstruments],
  );

  const toggleMarket = (marketSymbol: string, enabled: boolean) => {
    const next = enabled
      ? [...new Set([...selectedMarkets, marketSymbol])]
      : selectedMarkets.filter((candidate) => candidate !== marketSymbol);
    settings.mutate({ watchlist: next });
  };

  const onTab = useCallback(
    (next: DeskTab) => setLocation(`/terminal${deskSearchForTab(next)}`, { replace: true }),
    [setLocation],
  );

  // ── derived screen state (all pure, all tested in desk-ui.test.ts) ────────
  const decision = analysis.data?.decision ?? null;
  const regimeStates = regime.data?.available ? regime.data.states : [];
  const selectedRegime = useMemo(
    () => regimeStates.find((read) => read.symbol === symbol) ?? null,
    [regimeStates, symbol],
  );
  const dayPct = dayChangePct(liveAccount?.equity ?? null, liveAccount?.dayStartEquity ?? null);
  const openRiskValue = openRiskPct(state.data?.risk.exposure ?? null);
  const committed = committedRisk(state.data ?? null);
  const netOpen = netOpenResults(livePositions);
  const halted = Boolean(state.data?.risk.state.haltedUntilNextSession);
  const policy = state.data?.policy ?? null;

  const gateRows = useMemo(
    () =>
      buildGateRows({
        decision,
        thresholds: analysis.data?.thresholds ?? null,
        regime: selectedRegime,
        openRiskPctValue: account ? openRiskValue : null,
        exposureCapPct: policy?.maxCurrencyExposurePct ?? null,
        dailyLossUsedPct: state.data?.risk.budget?.usedPct ?? null,
        halted,
      }),
    [decision, analysis.data?.thresholds, selectedRegime, account, openRiskValue, policy, state.data?.risk.budget?.usedPct, halted],
  );

  const pipelineNodes = useMemo(
    () =>
      buildPipeline({
        liveSymbols: state.data?.market.liveSymbols ?? 0,
        selectedCount: state.data?.market.selectedCount ?? 0,
        mismatchSymbols: state.data?.market.mismatchSymbols ?? mismatchedSymbols.length,
        regime: selectedRegime,
        decision,
        gateRows,
        openPositions: livePositions.length,
      }),
    [state.data?.market, mismatchedSymbols.length, selectedRegime, decision, gateRows, livePositions.length],
  );

  const opportunityRows = useMemo(
    () =>
      buildOpportunityRows({
        instruments: liveInstruments,
        scans: scan.data?.results ?? [],
        regimes: regimeStates,
        selected: symbol,
      }),
    [liveInstruments, scan.data?.results, regimeStates, symbol],
  );

  const slippageEwmaR = execution.data?.execution?.slippage?.ewmaR ?? null;
  const riskRows = useMemo(
    () => buildRiskRows({ state: state.data ?? null, slippageEwmaR }),
    [state.data, slippageEwmaR],
  );
  const riskVerdict = useMemo(() => riskBadge(riskRows, halted), [riskRows, halted]);

  const alerts = useMemo(
    () =>
      buildAlerts({
        state: state.data ?? null,
        mismatchedSymbols,
        actionError,
        nowMs: Date.now(),
      }),
    // Date.now() advances on every state poll — the stale banner's seconds stay honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.data, mismatchedSymbols, actionError],
  );

  const agents = governance.data?.available ? governance.data.agents : [];
  const report = weekly.data?.available ? weekly.data.report : null;

  // ── title bar / tabs / status bar content ─────────────────────────────────
  //
  // The title bar is CONTROLS ONLY now: the data-source badge, the stream badge,
  // the v4 chip and the equity/day/open-risk block were deleted, and each value
  // they carried is still rendered where it belongs — feed state in the status
  // bar and the Feed & health panel, the v4 layer flags in the Learning
  // workspace, and equity/day/open risk in the stat strip below. Nothing was
  // lost by removing them; the two lines that computed them are.
  const modeLabel = TRADE_MODES.find((entry) => entry.id === mode)?.label ?? mode;

  const stage = rolloutStage({
    v4: state.data?.v4 ?? null,
    accountIsLive: Boolean(liveAccount?.isLive),
    liveTradingEnabled: Boolean(policy?.liveTradingEnabled),
    baseRiskPct: policy?.baseRiskPct ?? null,
  });

  const titleBar = (
    <TitleBar
      mode={mode}
      onMode={(next) => settings.mutate({ mode: next })}
      controlsEnabled={terminalLive}
      settingsBusy={settings.isPending}
      autoTrade={Boolean(state.data?.autoTrade)}
      onAutoTrade={() => settings.mutate({ autoTrade: !state.data?.autoTrade })}
      timeZone={timeZone}
      timezones={state.data?.timezones ?? []}
      onTimeZone={(id) => settings.mutate({ timezone: id })}
      bridgeLabel={terminal ? `MT5 ${terminal.login}` : "Link MT5"}
      hasTerminal={hasTerminal}
      onOpenBridge={() => setBridgeOpen(true)}
      onOpenSettings={() => setAutoTradeOpen(true)}
      onFlatten={() => flatten.mutate()}
      flattenBusy={flatten.isPending}
    />
  );

  const tabs = (
    <WorkspaceTabs
      tab={tab}
      onTab={onTab}
      badges={{
        markets: { count: selectedMarkets.length, tone: "mute", label: "selected markets" },
        learning: { count: governedAgentAlertCount(agents), tone: "am", label: "agents halved or disabled" },
      }}
      context={`Selected ${symbol || "—"} · ${modeLabel}`}
    />
  );

  const statTiles: StatTile[] = [
    {
      id: "equity",
      label: "Equity",
      value: liveAccount ? formatMoney(liveAccount.equity, liveAccount.currency) : "—",
      sub: liveAccount ? `bal ${formatMoney(liveAccount.balance, liveAccount.currency)}` : null,
    },
    {
      id: "day",
      label: "Day",
      value: formatSignedPct(dayPct),
      tone: dayPct === null ? "mute" : dayPct > 0 ? "up" : dayPct < 0 ? "dn" : undefined,
      sub: state.data ? formatMoney(state.data.risk.state.realisedPnlToday, liveAccount?.currency ?? "USD") : null,
    },
    {
      id: "open-risk",
      label: "Open risk",
      value: account ? formatPct(openRiskValue) : "—",
      meter: policy && account ? { fraction: openRiskValue / policy.maxCurrencyExposurePct, tone: "cy", tick: 0.8 } : undefined,
      sub: policy ? `cap ${policy.maxCurrencyExposurePct}%` : null,
    },
    {
      id: "daily-loss",
      label: "Daily loss used",
      value: state.data?.risk.budget ? `${Math.round(state.data.risk.budget.usedPct)}%` : "—",
      tone: (state.data?.risk.budget?.usedPct ?? 0) >= 100 ? "dn" : (state.data?.risk.budget?.usedPct ?? 0) >= 80 ? "am" : undefined,
      meter: state.data?.risk.budget ? { fraction: state.data.risk.budget.usedPct / 100, tone: "am", tick: 0.8 } : undefined,
      sub: state.data?.risk.budget ? `${formatMoney(state.data.risk.budget.remainingMoney, liveAccount?.currency ?? "USD")} left` : null,
    },
    {
      id: "positions",
      label: "Positions",
      value: hasTerminal ? `${livePositions.length} open` : "—",
      tone: netOpen.money > 0 ? "up" : netOpen.money < 0 ? "dn" : undefined,
      sub: livePositions.length > 0 ? `${formatMoney(netOpen.money, liveAccount?.currency ?? "USD")}${netOpen.r !== null ? ` (${formatSignedR(netOpen.r)})` : ""}` : null,
    },
    {
      id: "plans",
      label: "Armed plans",
      value: hasTerminal ? `${livePlans.length}` : "—",
      sub: committed.plansAddPct !== null ? `+${formatPct(committed.plansAddPct)} if all fill` : null,
    },
    {
      id: "week",
      label: "Week",
      value: performance.data ? formatSignedR(performance.data.overall.totalR) : "—",
      tone: (performance.data?.overall.totalR ?? 0) > 0 ? "up" : (performance.data?.overall.totalR ?? 0) < 0 ? "dn" : undefined,
      sub: performance.data ? `${performance.data.overall.trades} trades · ${Math.round(performance.data.overall.winRate * 100)}% win` : null,
    },
    {
      id: "rollout",
      label: "Rollout",
      value: ROLLOUT_STAGES[stage] ?? "—",
      tone: stage <= 1 ? "am" : "up",
      sub: stage === 1 ? rolloutDemoNote(report?.trades.closed ?? null) : policy ? `${policy.baseRiskPct}% per trade` : null,
      title: stage === 0 ? "The v4 guard layers record but never place a live order" : undefined,
    },
  ];

  const context: ReactNode = tab === "command" ? <PipelineStrip nodes={pipelineNodes} /> : <StatStrip tiles={statTiles} />;

  const statusBar = (
    <StatusBar
      fresh={state.data?.market.liveSymbols ?? 0}
      warming={state.data?.market.warmingSymbols ?? 0}
      stale={state.data?.market.staleSymbols ?? 0}
      mismatch={state.data?.market.mismatchSymbols ?? mismatchedSymbols.length}
      lastEventAt={stream.lastEventAt}
      eaVersion={bridgeStatus.data?.eaVersion ?? null}
      serverTime={state.data?.serverTime ?? null}
      stateFetchedAt={state.dataUpdatedAt ?? null}
      timeZone={timeZone}
      lastJournal={
        state.data?.journal?.[0]
          ? `${formatInZone(state.data.journal[0].ts, timeZone, { hour: "2-digit", minute: "2-digit", hour12: false })} ${state.data.journal[0].symbol ?? ""} ${state.data.journal[0].message}`.slice(0, 64)
          : null
      }
    />
  );

  // ── the workspace panels (only the active tab is built) ──────────────────
  const panels: Record<string, ReactNode> = {};
  if (tab === "command") {
    panels.opportunities = (
      <OpportunitiesPanel rows={opportunityRows} onSelect={setSymbol} loading={instruments.isPending} />
    );
    panels.decision = (
      <DecisionPanel
        symbol={symbol}
        mode={mode}
        decision={decision}
        gateRows={gateRows}
        priceLabel={formatPrice(selectedInstrument?.bid ?? null, selectedInstrument?.digits ?? null)}
        horizonMinutes={analysis.data?.horizonMinutes ?? null}
        loading={analysis.isPending}
        onArm={() => arm.mutate()}
        arming={arm.isPending}
        armError={actionError}
      />
    );
    panels.risk = (
      <RiskPanel
        rows={riskRows}
        badge={riskVerdict}
        suspended={state.data?.risk.state.suspendedSymbols ?? []}
        onResumeSymbol={(value) => resumeSymbol.mutate(value)}
        loading={state.isPending}
      />
    );
    panels.positions = (
      <PositionsPanel
        positions={livePositions}
        plans={livePlans}
        currency={liveAccount?.currency ?? "USD"}
        onClosePosition={(ticket) => closePosition.mutate(ticket)}
        onCancelPlan={(id) => cancelPlan.mutate(id)}
        loading={state.isPending}
      />
    );
    panels.calendar = (
      <CalendarPanel
        news={state.data?.news ?? null}
        upcoming={state.data?.newsUpcoming ?? []}
        gate={decision?.news ?? null}
        timeZone={timeZone}
      />
    );
  } else if (tab === "markets") {
    panels.universe = (
      <UniversePanel
        markets={markets.data?.markets ?? []}
        selected={selectedMarkets}
        updating={settings.isPending}
        onToggle={toggleMarket}
        onFocus={setSymbol}
        loading={markets.isPending}
      />
    );
    panels.scanner = (
      <ScannerPanel
        rows={scan.data?.results ?? []}
        coverage={scan.data?.coverage ?? null}
        selected={symbol}
        onSelect={setSymbol}
        onRescan={() => scan.refetch()}
        scanning={scan.isFetching}
        enabled={terminalLive}
        loading={scan.isPending}
      />
    );
    panels.autoselect = (
      <AutoSelectPanel
        autoSelect={state.data?.autoSelect ?? null}
        onRunNow={() => runAutoSelect.mutate()}
        running={runAutoSelect.isPending}
        enabled={terminalLive}
      />
    );
    panels.health = (
      <HealthPanel
        state={state.data ?? null}
        execution={execution.data ?? null}
        bridge={bridgeStatus.data ?? null}
        selected={symbol}
      />
    );
  } else if (tab === "learning") {
    const refreshLearning = () => {
      void governance.refetch();
      void weekly.refetch();
      void learningJournal.refetch();
    };
    panels.governance = (
      <GovernancePanel
        available={governance.data?.available ?? false}
        agents={agents}
        loading={governance.isPending}
        onRefresh={refreshLearning}
        refreshing={governance.isFetching || weekly.isFetching || learningJournal.isFetching}
      />
    );
    panels.calibration = <CalibrationPanel available={weekly.data?.available ?? false} report={report} />;
    panels.week = <WeekPanel available={weekly.data?.available ?? false} report={report} />;
    panels.regime = (
      <RegimePanel
        available={regime.data?.available ?? false}
        states={regimeStates}
        ttlMs={regime.data?.ttlMs}
        loading={regime.isPending}
      />
    );
    panels.refused = <RefusedPanel available={weekly.data?.available ?? false} report={report} />;
    panels.safety = (
      <SafetyPanel
        agents={agents}
        report={report}
        onResumeAgent={(agentId, note) => resumeAgent.mutate({ agentId, note })}
        resumePending={resumeAgent.isPending}
      />
    );
    panels["learning-journal"] = (
      <LearningJournalPanel
        available={learningJournal.data?.available ?? false}
        entries={learningJournal.data?.available ? learningJournal.data.entries : []}
        kind={journalKind}
        onKind={setJournalKind}
        timeZone={timeZone}
        loading={learningJournal.isPending}
      />
    );
  } else {
    panels.closed = (
      <ClosedTradesPanel performance={performance.data ?? null} timeZone={timeZone} loading={performance.isPending} />
    );
    panels["by-symbol"] = <BySymbolPanel performance={performance.data ?? null} loading={performance.isPending} />;
    panels["decision-journal"] = <DecisionJournalPanel entries={state.data?.journal ?? []} timeZone={timeZone} />;
  }

  // ── unlinked: the title bar (controls disabled, testids present) and the
  //    connection card — no tabs, no workspaces, no status bar, no numbers. ──
  if (!terminal) {
    return (
      <div className="desk-root h-full min-h-0">
        <div className="desk-frame" data-desk-size="unlinked">
          {titleBar}
          <div className="desk-work desk-scroll" style={{ overflowY: "auto" }}>
            <div className="m-auto w-full max-w-3xl">
              <section className="rounded-[6px] border border-[var(--desk-line)] bg-[var(--desk-s1)] p-5 sm:p-8" data-testid="connect-card">
                <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[6px] border border-[color-mix(in_srgb,var(--desk-up)_35%,transparent)] bg-[color-mix(in_srgb,var(--desk-up)_10%,transparent)]">
                    <Link2 className="h-6 w-6 d-up" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="t-tile d-tx">Connect MT5 to start the Desk</h2>
                    <p className="t-body d-tx2 mt-1 max-w-xl leading-relaxed">
                      No balance, price, position, scanner result or agent decision is shown until your MetaTrader 5
                      terminal provides it. The Desk only works with your broker's live terminal data.
                    </p>
                  </div>
                  <button type="button" className="desk-btn desk-btn-primary w-full shrink-0 sm:w-auto" style={{ height: 34 }} onClick={() => setBridgeOpen(true)}>
                    Set up MT5 bridge
                  </button>
                </div>
                <div className="mt-6 grid gap-3 border-t border-[var(--desk-line)] pt-5 sm:grid-cols-3">
                  <InfoStep number="1" title="Download & attach">
                    Attach the resilient Neurotrade MT5 EA (v3 or later) to any chart. It stays attached and retries
                    pairing instead of failing initialization.
                  </InfoStep>
                  <InfoStep number="2" title="Pair securely">
                    Add this platform origin to MT5's WebRequest allowlist and paste the one-time pairing code. No MT5
                    password leaves your terminal.
                  </InfoStep>
                  <InfoStep number="3" title="Select broker markets">
                    The EA discovers the complete broker catalogue. Choose any number of forex, crypto, indices,
                    stocks, metals, futures or other supported symbols.
                  </InfoStep>
                </div>
              </section>
            </div>
          </div>
        </div>
        <BridgeDialog open={bridgeOpen} onClose={() => setBridgeOpen(false)} linked={hasTerminal} onChanged={invalidateDesk} />
        <AutoTradeSettingsDialog open={autoTradeOpen} onClose={() => setAutoTradeOpen(false)} state={state.data ?? null} onSaved={invalidateDesk} />
      </div>
    );
  }

  return (
    <>
      <DeskShell tab={tab} titleBar={titleBar} tabs={tabs} context={context} alerts={alerts} panels={panels} status={statusBar} />
      <BridgeDialog open={bridgeOpen} onClose={() => setBridgeOpen(false)} linked={hasTerminal} onChanged={invalidateDesk} />
      <AutoTradeSettingsDialog open={autoTradeOpen} onClose={() => setAutoTradeOpen(false)} state={state.data ?? null} onSaved={invalidateDesk} />
    </>
  );
}

function InfoStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="rounded-[6px] border border-[var(--desk-line)] bg-[var(--desk-s2)] p-3">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--desk-s3)] t-cap d-up">{number}</span>
      <h3 className="t-title d-tx mt-2">{title}</h3>
      <p className="t-cap d-mute mt-1 leading-relaxed">{children}</p>
    </div>
  );
}
