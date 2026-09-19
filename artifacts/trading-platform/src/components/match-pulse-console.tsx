/** Match Pulse follows the specialist console flow: settings → scan → deploy → monitor. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { motion } from "framer-motion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, ChevronLeft, Loader2, Lock, RefreshCw, ScanSearch, ShieldCheck, Shuffle, StopCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Link } from "wouter";
import { useGetAccount, getGetAccountQueryKey, useGetSettings, useUpdateSettings, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription, DialogClose } from "./ui/dialog";
import { ACCENTS, BOT_ICON, SCAN_MARKET_COUNT, type BotCardData, type BotSessionStatus } from "@/lib/bots";
import { bestPulseMarket, pulseRiskError, pulseScanMatchesAccount, type PulseConfig, type PulseMarketMode, type PulseReport, type PulseRiskSettings, type PulseScan } from "@/lib/match-pulse";
import { onSessionChange, withTabSession } from "@/lib/tab-session";

const API = "/api/bots/match-pulse";
const STATUS_KEY = ["match-pulse-status"];
type Step = "config" | "scanning" | "scan-result" | "running";
type Action = "scan" | "start" | "stop" | "reconcile";
const INITIAL_RISK: PulseRiskSettings = { stake: 1, stopLoss: 5, takeProfit: 10, maxRecoverySteps: 3, maxConsecutiveLosses: 6 };
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Request failed");
  return result as T;
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="flex items-center justify-between gap-2">
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{children}</p>
    {right && <span className="text-[9px] font-mono text-muted-foreground/70">{right}</span>}
  </div>;
}

function Evidence({ report }: { report: PulseReport }) {
  return <details className="rounded-lg border border-white/5 bg-white/[0.02] text-[10px] text-muted-foreground" data-testid="pulse-evidence">
    <summary className="cursor-pointer px-3 py-2 hover:text-white">Analysis details</summary>
    <div className="space-y-2.5 px-3 pb-3">
      <p>{report.history.toLocaleString()} ticks · {report.source === "live" ? "Broker feed" : "Simulated feed — cannot deploy"}</p>
      <table className="w-full text-[10px]">
        <thead><tr className="text-[9px] text-muted-foreground/60">
          <th className="pb-1 text-left font-normal">Unseen block</th><th className="text-right font-normal">Wins / entries</th><th className="text-right font-normal">Win rate</th><th className="text-right font-normal">Lower</th>
        </tr></thead>
        <tbody>{[{ label: "Validation", block: report.validation }, { label: "Latest audit", block: report.audit }].map(({ label, block }) =>
          <tr key={label} className="border-t border-white/5"><th scope="row" className="py-1.5 text-left font-medium text-white/80">{label}</th>
            <td className="text-right font-mono">{block.wins}/{block.shots}</td><td className="text-right font-mono">{block.shots ? pct(block.winRate) : "—"}</td><td className="text-right font-mono">{block.shots ? pct(block.lower) : "—"}</td></tr>)}
        </tbody>
      </table>
      <p>Break-even {pct(report.breakEven)} · payout {report.payout.toFixed(2)}× · longest unseen loss run {report.combined.longestLossRun}</p>
      <p className="font-mono text-[9px]">Evidence {report.logEvidence.toFixed(2)} / {report.requiredLogEvidence.toFixed(2)} · audit Brier skill {pct(report.audit.brierSkill)}</p>
      {!!report.reasons.length && <ul className="ml-3 list-disc space-y-1 text-amber-300/80">{report.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <p className="text-[9px] text-muted-foreground/60">Historical measurements, not a future win-rate guarantee. A fresh tick and acceptable broker quote are still required.</p>
    </div>
  </details>;
}

export function MatchPulseConsole({ bot, open, onOpenChange, session: incoming, onSession }: {
  bot: BotCardData; open: boolean; onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null; onSession: (session: BotSessionStatus | null) => void;
}) {
  const client = useQueryClient();
  const { data: settings } = useGetSettings();
  const { data: account, isLoading: accountLoading, isError: accountError } = useGetAccount({
    query: { queryKey: getGetAccountQueryKey(), enabled: open, retry: false, refetchInterval: 15_000 },
  });
  const updateSettings = useUpdateSettings();
  const [step, setStep] = useState<Step>("config");
  const [risk, setRisk] = useState<PulseRiskSettings>({ ...INITIAL_RISK });
  const [markupDraft, setMarkupDraft] = useState<string | null>(null);
  const [scan, setScan] = useState<PulseScan | null>(null);
  const [pendingAction, setPendingAction] = useState<Action | null>(null);
  const [progress, setProgress] = useState({ scanned: 0, total: SCAN_MARKET_COUNT, displayName: "" });
  const [now, setNow] = useState(Date.now());
  const settingsLoaded = useRef(false);
  const requestVersion = useRef(0);
  const { data: ownStatus, error: statusError, isPending: statusLoading } = useQuery({
    queryKey: STATUS_KEY, queryFn: () => request<BotSessionStatus>("/status"),
    enabled: open, refetchInterval: 2500, staleTime: 1000,
  });
  const status = incoming?.botId === "match-pulse" && incoming.running ? incoming : ownStatus;
  const telemetry = status?.pulse;
  const running = !!status?.running;
  const otherRunning = !!incoming?.running && incoming.botId !== "match-pulse";
  const busy = pendingAction !== null;
  const accent = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Activity;
  const best = bestPulseMarket(scan);
  const report = best ?? scan?.candidates[0] ?? null;
  const remaining = scan ? Math.max(0, Math.ceil((scan.expiresAt - now) / 1000)) : 0;
  const connectedAccount = !accountError && account?.isActive ? account : null;
  const sameAccount = pulseScanMatchesAccount(scan, connectedAccount);
  const invalidRisk = pulseRiskError(risk);
  const statusBlocked = !!statusError || statusLoading;
  const canStart = !!best && !!scan && remaining > 0 && sameAccount && !settings?.paperTradeMode &&
    !running && !otherRunning && !busy && !invalidRisk && !statusBlocked;
  const markupSaved = Number(settings?.botRecoveryMarkup ?? 10);
  const displayedAccount = step === "running" ? telemetry?.account : connectedAccount;
  const currency = displayedAccount?.currency ?? connectedAccount?.currency ?? "USD";
  const money = (amount: number, signed = false) => `${signed ? amount >= 0 ? "+" : "−" : ""}${currency === "USD" ? "$" : `${currency} `}${Math.abs(amount).toFixed(2)}`;
  const profit = status?.totalProfit ?? 0;
  const winRate = status?.tradeCount ? Math.round(status.winCount / status.tradeCount * 100) : 0;
  const view = running ? "running" : step;

  useEffect(() => {
    if (!settings || settingsLoaded.current) return;
    settingsLoaded.current = true;
    setRisk(previous => ({ ...previous, stake: Number(settings.riskAmountValue ?? previous.stake), maxRecoverySteps: settings.maxRecoverySteps ?? previous.maxRecoverySteps }));
  }, [settings]);
  useEffect(() => {
    if (ownStatus && (ownStatus.running || incoming?.botId === "match-pulse")) onSession(ownStatus);
  }, [ownStatus, onSession, incoming?.botId]);
  useEffect(() => { if (running) setStep("running"); }, [running]);
  useEffect(() => onSessionChange(() => {
    requestVersion.current++;
    settingsLoaded.current = false;
    setScan(null);
    setPendingAction(null);
    setStep("config");
  }), []);
  useEffect(() => () => { requestVersion.current++; }, []);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const stream = new EventSource(withTabSession("/api/ai/events"));
    stream.addEventListener("match_pulse_scan", event => {
      try { setProgress(JSON.parse((event as MessageEvent).data)); } catch { /* polling/results remain authoritative */ }
    });
    stream.addEventListener("bot_update", event => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as BotSessionStatus;
        if (next.botId === "match-pulse") client.setQueryData(STATUS_KEY, next);
      } catch { /* polling is the fallback */ }
    });
    return () => { clearInterval(timer); stream.close(); };
  }, [open, client]);

  const set = (key: keyof PulseRiskSettings, value: number) => {
    setRisk(previous => ({ ...previous, [key]: value }));
    setScan(null);
  };
  const sync = (next: BotSessionStatus) => { client.setQueryData(STATUS_KEY, next); onSession(next); };
  const changeSettings = () => { setScan(null); setStep("config"); };
  const saveMarkup = async (raw: string) => {
    if (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 100) {
      toast.error("Recovery markup must be 0–100%.");
      setMarkupDraft(null);
      return;
    }
    const next = Math.round(Number(raw) * 100) / 100;
    if (next === markupSaved) { setMarkupDraft(null); return; }
    try {
      const saved = await updateSettings.mutateAsync({ data: { botRecoveryMarkup: next } });
      client.setQueryData(getGetSettingsQueryKey(), saved);
      setMarkupDraft(null);
      toast.success(`AI Bot recovery markup set to ${next}%`);
    } catch { toast.error("Could not save recovery markup"); }
  };
  const handleScan = async () => {
    if (busy || running || otherRunning || statusBlocked) return;
    if (invalidRisk) { toast.error(invalidRisk); return; }
    const version = ++requestVersion.current;
    setPendingAction("scan");
    setStep("scanning");
    setScan(null);
    setProgress({ scanned: 0, total: SCAN_MARKET_COUNT, displayName: "" });
    try {
      // Mode and digit are deliberately absent: the server always scans for
      // broker execution on the selected demo/real account with AI digits.
      const result = await request<PulseScan>("/scan", {});
      if (version !== requestVersion.current) return;
      setScan(result);
      setNow(Date.now());
      setStep("scan-result");
    } catch (error) {
      if (version !== requestVersion.current) return;
      toast.error(error instanceof Error ? error.message : "Scan failed");
      setStep("config");
    } finally { if (version === requestVersion.current) setPendingAction(null); }
  };
  const handleStart = async (marketMode: PulseMarketMode) => {
    if (!scan || !best || !canStart) return;
    setPendingAction("start");
    try {
      const config: PulseConfig = { ...risk, scanId: scan.scanId, selectedSymbol: best.symbol, marketMode };
      const result = await request<{ status: BotSessionStatus }>("/start", config);
      sync(result.status);
      setStep("running");
      toast.success(marketMode === "locked" ? `Match Pulse armed — locked on ${best.displayName}` : "Match Pulse armed — smart market switching active");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Deployment failed"); }
    finally { setPendingAction(null); }
  };
  const action = async (name: "stop" | "reconcile") => {
    setPendingAction(name);
    try { sync((await request<{ status: BotSessionStatus }>(`/${name}`, {})).status); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Action failed"); }
    finally { setPendingAction(null); }
  };

  const numberField = (key: keyof PulseRiskSettings, label: string, min: number, max: number, suffix?: string, increment = 1) => <div className="flex items-center justify-between gap-3">
    <label htmlFor={`pulse-${key}`} className="flex-1 text-xs text-muted-foreground">{label}</label>
    <div className="flex items-center gap-1">
      <Input id={`pulse-${key}`} type="number" value={Number.isNaN(risk[key]) ? "" : risk[key]} min={min} max={max} step={increment}
        onChange={event => set(key, event.target.value === "" ? NaN : Number(event.target.value))} disabled={busy}
        className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${accent.focusBorder}`} />
      {suffix && <span className="w-6 text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
  </div>;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPortal>
      <DialogOverlay className="z-40 bg-black/40" />
      <DialogPrimitive.Content data-testid="match-pulse-console" aria-label={`${bot.name} console`}
        className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-2xl border ${accent.panelBorder} bg-[#080d17] shadow-2xl ${accent.cardGlow} outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 duration-200`}>
        <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${accent.headerGrad}`}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 rounded-xl ${accent.iconBg} ${accent.iconBorder} flex items-center justify-center flex-shrink-0`}><Icon className={`w-4.5 h-4.5 ${accent.text}`} /></div>
            <div className="min-w-0">
              <DialogTitle className="text-sm font-bold text-white flex items-center gap-2">{bot.name}<span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${accent.badgeBg} ${accent.text} font-normal`}>{bot.code}</span></DialogTitle>
              <DialogDescription className="text-[11px] text-muted-foreground mt-0.5 truncate">Matches specialist · {bot.tagline}</DialogDescription>
            </div>
          </div>
          <DialogClose aria-label="Close console" className="text-muted-foreground hover:text-white p-1 flex-shrink-0"><X className="w-4 h-4" /></DialogClose>
        </div>

        {statusError && <p role="alert" className="m-4 text-[11px] text-red-300">Cannot confirm engine status. Refresh before deploying.</p>}
        {otherRunning && <div role="alert" className="m-4 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 text-[10px] text-amber-200/80">{incoming?.botName ?? "Another bot"} is trading. Stop it and confirm settlement before deploying Match Pulse.</div>}

        {view === "config" && <div className="p-4 space-y-4" data-testid="pulse-settings">
          <div className="space-y-2">
            <SectionLabel right="Strict Contract Lock">Contract Sovereignty</SectionLabel>
            <div className={`px-2 py-2 rounded-lg text-xs border ${accent.activeBg} ${accent.activeBorder} ${accent.text}`}><span className="font-medium">Matches only</span></div>
            <p className="text-[9px] text-muted-foreground/60">AI selects the digit. Normal and recovery trades stay in Matches.</p>
          </div>
          <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>Trading account</span>
            {connectedAccount ? <span className="flex min-w-0 items-center gap-1.5"><span className="font-mono truncate">{connectedAccount.loginId}</span><span className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase ${connectedAccount.isVirtual ? "bg-amber-500/20 text-amber-400" : "bg-green-500/20 text-green-400"}`}>{connectedAccount.isVirtual ? "Demo" : "Real"}</span></span>
              : accountLoading ? <span>Checking account…</span> : <Link href="/connect" onClick={() => onOpenChange(false)} className={accent.text}>Connect an account</Link>}
          </div>
          <div className="space-y-2 pt-2 border-t border-white/5">
            <SectionLabel right="Session Boundaries">Risk Parameters</SectionLabel>
            <div className="space-y-1.5">
              {numberField("stake", "Base stake", 0.35, 1_000_000, currency, 0.01)}
              {numberField("takeProfit", "Take profit", 0.35, 1_000_000, currency, 0.01)}
              {numberField("stopLoss", "Stop loss", 0.35, 1_000_000, currency, 0.01)}
              {numberField("maxConsecutiveLosses", "Stop after losses", 3, 20)}
            </div>
          </div>
          <div className="space-y-2 pt-2 border-t border-white/5">
            <SectionLabel right="Match Sniper policy">Recovery Engine</SectionLabel>
            <div className={`flex items-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium ${accent.activeBg} ${accent.activeBorder} ${accent.text}`}><ShieldCheck className="w-3.5 h-3.5" /> Debt + markup recovery</div>
            <div className="space-y-1.5 pt-1">
              {numberField("maxRecoverySteps", "Max recovery steps", 1, 10)}
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="pulse-markup" className="flex-1 text-xs text-muted-foreground">Markup on debt</label>
                <div className="flex items-center gap-1"><Input id="pulse-markup" type="number" value={markupDraft ?? String(markupSaved)} min={0} max={100} step={0.5}
                  onChange={event => setMarkupDraft(event.target.value)} onBlur={event => { if (markupDraft !== null) void saveMarkup(event.target.value); }}
                  onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setMarkupDraft(null); }} disabled={updateSettings.isPending}
                  className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${accent.focusBorder}`} /><span className="w-6 text-[10px] text-muted-foreground">%</span></div>
              </div>
            </div>
            <p className="text-[9px] text-muted-foreground/60 leading-relaxed">Same debt-based recovery as Match Sniper. Markup saves automatically and is shared by the bots. The step cap tracks recovery depth; the loss limit stops new entries.</p>
          </div>
          {invalidRisk && <p role="alert" className="text-[10px] text-amber-300">{invalidRisk}</p>}
          <Button onClick={() => void handleScan()} disabled={busy || otherRunning || statusBlocked || !!invalidRisk}
            className={`w-full h-10 bg-gradient-to-r ${accent.grad} text-white font-bold text-sm shadow-lg`}><ScanSearch className="w-4 h-4 mr-2" />Neural Scan All Markets</Button>
        </div>}

        {view === "scanning" && <div className="p-4 space-y-4" role="status" data-testid="pulse-scanning">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><div className={`w-5 h-5 rounded-full ${accent.iconBg} ${accent.iconBorder} flex items-center justify-center`}><Loader2 className={`w-3 h-3 animate-spin ${accent.text}`} /></div><div><p className="text-xs font-bold text-white tracking-wide leading-none">Specialist Neural Scan</p><p className={`text-[9px] ${accent.text} opacity-70 mt-0.5`}>Matches estimators active</p></div></div>
            <span className="text-xs font-mono text-muted-foreground/40"><strong className={`text-sm ${accent.text}`}>{progress.scanned}</strong> / {progress.total || SCAN_MARKET_COUNT}</span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden"><motion.div className={`h-full rounded-full bg-gradient-to-r ${accent.grad}`} animate={{ width: `${Math.min(100, progress.scanned / (progress.total || SCAN_MARKET_COUNT) * 100)}%` }} transition={{ duration: 0.35 }} /></div>
          <div className={`rounded-xl border ${accent.panelBorder} ${accent.panelBg} flex items-center gap-3 px-3 py-3`}><ScanSearch className={`w-4 h-4 ${accent.text} flex-shrink-0`} /><div className="min-w-0"><p className="text-[9px] uppercase tracking-widest text-muted-foreground/60 mb-0.5">Analyzing Asset</p><p className="text-sm font-bold text-white truncate">{progress.displayName || "Calibrating specialist estimators…"}</p></div></div>
          <p className="text-[10px] text-muted-foreground/60 leading-relaxed">Measuring the AI digit-selection rule on validation and audit ticks. No trades are placed during the scan.</p>
        </div>}

        {view === "scan-result" && scan && <div className="p-4 space-y-4" data-testid="pulse-scan-result">
          <SectionLabel right={`${scan.qualifiedCount} / ${scan.marketsTested} eligible`}>Scan Complete</SectionLabel>
          {best ? <>
            <div className="rounded-xl bg-green-500/5 border border-green-500/25 p-3 space-y-3">
              <div className="flex items-center justify-between gap-2"><div className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-green-400" /><p className="text-xs font-semibold text-green-300">Qualified Matches Setup</p></div><span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-green-500/20 text-green-300">BEST</span></div>
              <div className="bg-black/30 rounded-lg p-2.5 space-y-2">
                <p className="text-sm font-bold text-white">{best.displayName}</p>
                <div className="flex items-center gap-2 text-[11px] flex-wrap"><span className={`px-1.5 py-0.5 rounded ${accent.badgeBg} ${accent.text} font-mono font-medium`}>DIGITMATCH</span><span className="text-muted-foreground">{pct(best.audit.winRate)} audit win rate</span></div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">Both unseen blocks passed. The bot chooses the digit and waits for a fresh eligible tick before buying.</p>
              </div>
            </div>
            <p className={`text-[9px] font-mono ${remaining ? "text-muted-foreground/70" : "text-amber-300"}`}>{remaining ? `Scan valid for ${remaining}s` : "Scan expired — re-scan before deploying."}</p>
            {!sameAccount && <p role="alert" className="text-[10px] text-amber-300">{connectedAccount ? "The connected account changed. Re-scan for this account before deploying." : "Connect a Deriv demo or real account, then re-scan to deploy."}</p>}
            {settings?.paperTradeMode && <p role="alert" className="text-[10px] text-amber-300">Broker orders are disabled by Paper Trade Mode in Settings. Disable it there to trade on your selected Deriv account.</p>}
            <div className="space-y-2">
              <Button onClick={() => void handleStart("locked")} disabled={!canStart} className={`w-full h-auto min-h-10 py-2 whitespace-normal bg-gradient-to-r ${accent.grad} text-white font-bold text-xs shadow-lg`}><Lock className="w-3.5 h-3.5 mr-2 flex-shrink-0" />Trade Locked on {best.displayName}</Button>
              <Button onClick={() => void handleStart("switching")} disabled={!canStart} variant="outline" className={`w-full h-9 ${accent.outlineBtn} text-xs font-semibold`}><Shuffle className="w-3.5 h-3.5 mr-2" />Trade with Smart Market Switching</Button>
              <p className="text-[9px] text-muted-foreground/60 leading-relaxed">Locked stays on this market. Smart switching can move to another qualified market when conditions change, between settled trades.</p>
            </div>
          </> : <div className="rounded-xl bg-amber-500/5 border border-amber-500/25 p-3 space-y-2">
            <div className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" /><p className="text-xs font-semibold text-amber-300">No Decisive Edge Found</p></div>
            <p className="text-[11px] text-muted-foreground">{scan.candidates.length ? "No market passed all Matches checks. Wait for conditions to improve, then scan again." : "No usable broker tick history yet. Let the feed warm up, then scan again."}</p>
          </div>}
          {report && <Evidence report={report} />}
          <Button onClick={() => void handleScan()} disabled={busy || otherRunning || statusBlocked} variant={best ? "outline" : "default"} className={`w-full h-9 text-xs font-semibold ${best ? accent.outlineBtn : `${accent.solidBtn} text-white`}`}><RefreshCw className="w-3.5 h-3.5 mr-2" />Re-Scan Markets</Button>
          <button type="button" disabled={busy} onClick={changeSettings} className="w-full text-[11px] text-muted-foreground hover:text-white text-center py-1 flex items-center justify-center gap-1 disabled:opacity-50"><ChevronLeft className="w-3 h-3" />Change settings</button>
        </div>}

        {view === "running" && <div className="p-4 space-y-4" data-testid="pulse-session">
          <div className={`rounded-xl p-3 border ${running ? `${accent.panelBg} ${accent.panelBorder}` : "bg-secondary/30 border-border"}`}>
            <div className="flex items-center justify-between mb-2"><span className="text-[10px] uppercase tracking-wider text-muted-foreground">Session P&amp;L</span><span className={`flex items-center gap-1 text-[10px] ${running ? accent.text : "text-muted-foreground"}`}>{running && <span className={`w-1.5 h-1.5 rounded-full ${accent.dot} animate-pulse`} />}{running ? `${displayedAccount ? displayedAccount.isVirtual ? "DEMO" : "REAL" : "ACCOUNT"} · 1-TICK` : "STOPPED"}</span></div>
            <div className={`text-2xl font-bold font-mono ${profit >= 0 ? "text-green-400" : "text-red-400"}`}>{money(profit, true)}</div>
            <div className="flex gap-3 mt-2 text-[11px]"><span className="text-green-400">{status?.winCount ?? 0}W</span><span className="text-red-400">{status?.lossCount ?? 0}L</span><span className="text-muted-foreground">{winRate}% WR</span><span className="text-muted-foreground">{status?.tradeCount ?? 0} trades</span></div>
            {telemetry?.config && <div className="mt-2 space-y-1"><div className="flex justify-between text-[9px] text-muted-foreground"><span>SL −{money(telemetry.config.stopLoss)}</span><span>TP +{money(telemetry.config.takeProfit)}</span></div><div className="h-1.5 bg-secondary rounded-full overflow-hidden relative"><div className="absolute left-1/2 top-0 w-px h-full bg-white/20" /><div className={`absolute top-0 h-full rounded-full transition-all ${profit >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`} style={{ width: `${Math.min(50, Math.abs(profit) / (profit >= 0 ? telemetry.config.takeProfit : telemetry.config.stopLoss) * 50)}%` }} /></div></div>}
          </div>
          {status?.message && <p role="status" className="text-xs px-3 py-2 rounded-lg border font-mono bg-secondary/30 border-border text-muted-foreground break-words">{status.message}</p>}
          {status?.currentMarket && <div className="flex items-center gap-2 bg-white/[0.03] rounded-lg px-3 py-2 border border-white/5"><Activity className={`w-3.5 h-3.5 ${accent.text} flex-shrink-0`} /><div className="min-w-0 flex-1"><p className="text-[10px] text-muted-foreground">Active Asset</p><p className="text-xs font-semibold text-white truncate">{status.currentMarket}</p><p className={`text-[10px] font-mono ${accent.text}`}>{status.currentContractType ?? "DIGITMATCH"} · {money(status.currentStake)}</p></div>{status.lastResult && <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${status.lastResult === "won" ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>{status.lastResult.toUpperCase()}</span>}</div>}
          {telemetry?.config && <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">{telemetry.config.marketMode === "locked" ? <Lock className="w-3 h-3" /> : <Shuffle className="w-3 h-3" />}{telemetry.config.marketMode === "locked" ? "Market locked" : "Smart market switching"}{displayedAccount && ` · ${displayedAccount.loginId}`}</p>}
          {status?.inRecovery && <div className="rounded-lg px-3 py-2 border text-xs bg-amber-500/[0.08] border-amber-500/30 space-y-1"><div className="flex items-center justify-between"><span className="font-semibold text-amber-300 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-amber-400" />Sniper Recovery (Step {status.recoveryStep})</span><span className="font-mono text-[10px] text-amber-400">{money(status.unrecoveredAmount)} debt</span></div><p className="text-[10px] text-muted-foreground leading-relaxed">Recovery stays in Matches and exits when the debt clears.</p></div>}
          {telemetry?.pending && <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5 space-y-2"><p className="text-[10px] text-amber-200">{telemetry.pending.contractId ? `Contract ${telemetry.pending.contractId} awaiting settlement.` : "Purchase awaiting confirmation."} No second order can be sent.</p>{telemetry.phase === "reconciling" && <Button variant="outline" size="sm" className="h-7 w-full text-[10px]" disabled={busy} onClick={() => void action("reconcile")}><RefreshCw className={`mr-1.5 w-3 h-3 ${pendingAction === "reconcile" ? "animate-spin" : ""}`} />Check settlement</Button>}</div>}
          <details className="text-[10px] text-muted-foreground"><summary className="cursor-pointer hover:text-white">Session diagnostics</summary><div className="mt-2 space-y-1 rounded-lg bg-white/[0.03] p-2.5 font-mono"><p>{telemetry?.ticksWatched ?? 0} fresh ticks · {telemetry?.rejectedEntries ?? 0} aborted entries</p><p>{telemetry?.cooldownTicks ?? 0} cooldown ticks remaining</p>{telemetry?.reading && <p>Digit {telemetry.reading.digit} · estimate {pct(telemetry.reading.probability)} · lower {pct(telemetry.reading.lower)}</p>}</div></details>
          {running ? <><Button variant="destructive" className="w-full h-9 text-xs" disabled={busy || telemetry?.stopRequested} onClick={() => void action("stop")}>{pendingAction === "stop" ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5 mr-1.5" />}{telemetry?.stopRequested ? "Stopping / settling" : "Stop Match Pulse"}</Button><p className="text-[9px] text-muted-foreground/60">Closing the console does not stop the bot. Unsettled orders keep the execution lock.</p></>
            : <div className="flex gap-2"><Button onClick={changeSettings} variant="outline" className="flex-1 h-9 text-xs border-white/10">New Session</Button><Button onClick={() => void handleScan()} disabled={busy || otherRunning || statusBlocked} className={`flex-1 h-9 text-xs ${accent.solidBtn} text-white font-bold`}><ScanSearch className="w-3.5 h-3.5 mr-1.5" />Re-Scan</Button></div>}
        </div>}
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
