import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation } from "wouter";
import {
  Calculator, TrendingUp, TrendingDown, ShieldAlert, Shield,
  AlertTriangle, Zap, GitBranch, Info, ChevronDown, Target,
  BarChart3, RefreshCw, ArrowRight, DollarSign, Sparkles,
  Wallet, Lock, Unlock, ChevronRight, CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useGetAccount } from "@workspace/api-client-react";
import {
  calcRisk, calcSuggestedStake, getPayout, getWinProb, streakProb,
  OVER_PAYOUTS, UNDER_PAYOUTS,
  type ContractType,
} from "@/lib/risk-math";

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TP_PCT = 0.10;   // 10 % of balance
const DEFAULT_SL_PCT = 0.30;   // 30 % of balance
const MIN_STAKE      = 0.35;   // Deriv minimum

// ── Helpers ───────────────────────────────────────────────────────────────────
const fmt  = (n: number, d = 2) => n.toFixed(d);
const pct  = (n: number)        => `${(n * 100).toFixed(1)}%`;
const usd  = (n: number)        => `$${fmt(n)}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Tiny primitives ───────────────────────────────────────────────────────────
function SectionHeader({ icon: Icon, title, accent = false }: {
  icon: React.ElementType; title: string; accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className={`w-4 h-4 ${accent ? "text-primary" : "text-muted-foreground"}`} />
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
    </div>
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NumField({
  value, onChange, min = 0, max, step = 1, prefix, suffix, width = "w-24", disabled,
}: {
  value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
  prefix?: string; suffix?: string; width?: string; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
      <Input
        type="number" value={value} min={min} max={max} step={step}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`${width} text-right font-mono text-sm bg-secondary/50 disabled:opacity-50`}
      />
      {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
    </div>
  );
}

// ── Risk gauge ────────────────────────────────────────────────────────────────
function RiskGauge({ score, color, label }: { score: number; color: string; label: string }) {
  const r = 42, circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="relative flex items-center justify-center">
        <svg width="110" height="110" viewBox="0 0 110 110">
          <circle cx="55" cy="55" r={r} fill="none" stroke="#1e293b" strokeWidth="11" />
          <circle
            cx="55" cy="55" r={r} fill="none"
            stroke={color} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            transform="rotate(-90 55 55)"
            style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
          />
        </svg>
        <div className="absolute text-center">
          <motion.div
            key={score}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-3xl font-bold tabular-nums leading-none"
            style={{ color }}
          >
            {score}
          </motion.div>
          <div className="text-[9px] text-muted-foreground mt-0.5 uppercase tracking-widest">/ 100</div>
        </div>
      </div>
      <div
        className="text-xs font-bold uppercase tracking-widest px-3 py-0.5 rounded-full"
        style={{ color, backgroundColor: `${color}20`, border: `1px solid ${color}40` }}
      >
        {label}
      </div>
    </div>
  );
}

// ── Stat pill ─────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, color = "text-foreground" }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="bg-secondary/40 rounded-lg p-3 border border-border/50">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

// ── Contract picker ───────────────────────────────────────────────────────────
const CONTRACT_OPTIONS = [
  { value: "CALL",       label: "Rise (CALL)",    group: "Direction" },
  { value: "PUT",        label: "Fall (PUT)",      group: "Direction" },
  { value: "DIGITEVEN",  label: "Even Digit",      group: "Parity" },
  { value: "DIGITODD",   label: "Odd Digit",       group: "Parity" },
  { value: "DIGITOVER",  label: "Over (Digit)",    group: "Over/Under" },
  { value: "DIGITUNDER", label: "Under (Digit)",   group: "Over/Under" },
  { value: "DIGITMATCH", label: "Matches (Digit)", group: "Match/Diff" },
  { value: "DIGITDIFF",  label: "Differs (Digit)", group: "Match/Diff" },
];

function ContractPicker({
  type, barrier, onTypeChange, onBarrierChange,
}: {
  type: ContractType; barrier: number;
  onTypeChange: (t: ContractType) => void;
  onBarrierChange: (b: number) => void;
}) {
  const showBarrier = type === "DIGITOVER" || type === "DIGITUNDER";
  const barriers =
    type === "DIGITOVER"
      ? Object.keys(OVER_PAYOUTS).map(Number).sort((a, b) => a - b)
      : Object.keys(UNDER_PAYOUTS).map(Number).sort((a, b) => b - a);
  const payout  = getPayout(type, barrier);
  const winProb = getWinProb(type, barrier);
  const ev      = winProb * (payout - 1) - (1 - winProb);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Select value={type} onValueChange={(v) => onTypeChange(v as ContractType)}>
          <SelectTrigger className="flex-1 bg-secondary/50">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTRACT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {showBarrier && (
          <Select value={String(barrier)} onValueChange={(v) => onBarrierChange(Number(v))}>
            <SelectTrigger className="w-28 bg-secondary/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {barriers.map((b) => {
                const p = type === "DIGITOVER" ? OVER_PAYOUTS[b] : UNDER_PAYOUTS[b];
                return (
                  <SelectItem key={b} value={String(b)}>
                    {type === "DIGITOVER" ? `> ${b}` : `< ${b}`} ({p}×)
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex gap-2 flex-wrap text-[11px]">
        <span className="bg-primary/10 text-primary border border-primary/20 px-2 py-0.5 rounded">
          {pct(winProb)} win
        </span>
        <span className="bg-secondary text-muted-foreground border border-border px-2 py-0.5 rounded">
          {payout}× payout
        </span>
        <span className={`border px-2 py-0.5 rounded ${ev >= 0 ? "bg-green-500/10 text-green-400 border-green-500/20" : "bg-secondary text-muted-foreground border-border"}`}>
          EV {ev >= 0 ? "+" : ""}{fmt(ev, 3)}
        </span>
      </div>
    </div>
  );
}

// ── Recovery ladder table ─────────────────────────────────────────────────────
function LadderTable({ ladder, totalCost, balance }: {
  ladder: number[]; totalCost: number; balance: number;
}) {
  const maxStake = Math.max(...ladder);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/50">
            <th className="text-left text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Loss #</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Stake</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">Cumulative</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-muted-foreground py-1.5 font-medium">% Balance</th>
          </tr>
        </thead>
        <tbody>
          {ladder.map((stake, i) => {
            const cumulative = ladder.slice(0, i + 1).reduce((a, b) => a + b, 0);
            const pctBal     = (cumulative / balance) * 100;
            const intensity  = stake / maxStake;
            const stakeColor =
              intensity > 0.7 ? "text-red-400" :
              intensity > 0.4 ? "text-orange-400" :
              intensity > 0.2 ? "text-yellow-400" :
              "text-green-400";
            return (
              <tr key={i} className="border-b border-border/30 last:border-0">
                <td className="py-2 text-muted-foreground">
                  {i === 0 ? (
                    <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">Base</span>
                  ) : (
                    <span className="font-mono">L{i}</span>
                  )}
                </td>
                <td className={`py-2 text-right font-mono font-semibold ${stakeColor}`}>{usd(stake)}</td>
                <td className="py-2 text-right font-mono text-muted-foreground">{usd(cumulative)}</td>
                <td className={`py-2 text-right font-mono text-xs ${pctBal > 40 ? "text-red-400" : pctBal > 20 ? "text-orange-400" : "text-muted-foreground"}`}>
                  {fmt(pctBal, 1)}%
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-primary/30 bg-primary/5">
            <td className="py-2 text-xs font-semibold text-primary" colSpan={2}>Total at risk</td>
            <td className="py-2 text-right font-mono font-bold text-primary">{usd(totalCost)}</td>
            <td className="py-2 text-right font-mono text-xs text-primary">{fmt((totalCost / balance) * 100, 1)}%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── Target bar ────────────────────────────────────────────────────────────────
function TargetBar({
  label, value, target, color, icon: Icon,
}: {
  label: string; value: number; target: number; color: string;
  icon: React.ElementType;
}) {
  const pctFill = clamp((value / target) * 100, 0, 100);
  const ok = value <= target;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5" style={{ color }} />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono font-bold" style={{ color }}>{usd(value)}</span>
          <span className="text-[10px] text-muted-foreground">/ {usd(target)}</span>
          {ok
            ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
            : <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
        </div>
      </div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: color }}
          initial={{ width: 0 }}
          animate={{ width: `${pctFill}%` }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        />
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function RiskCalculator() {
  const [, setLocation] = useLocation();

  // Live account balance
  const { data: account } = useGetAccount({} as any);
  const liveBalance = account?.balance ? parseFloat(String(account.balance)) : null;

  // Inputs
  const [autoBalance,        setAutoBalance]        = useState(true);
  const [balance,            setBalance]            = useState(500);
  const [baseStake,          setBaseStake]          = useState(1);
  const [maxLosses,          setMaxLosses]          = useState(5);
  const [tradesPerSession,   setTradesPerSession]   = useState(30);
  const [primaryType,        setPrimaryType]        = useState<ContractType>("DIGITDIFF");
  const [primaryBarrier,     setPrimaryBarrier]     = useState(5);
  const [recoveryType,       setRecoveryType]       = useState<ContractType>("DIGITMATCH");
  const [recoveryBarrier,    setRecoveryBarrier]    = useState(5);
  const [recoveryMethod,     setRecoveryMethod]     = useState<"instant" | "split">("instant");
  const [recoveryMultiplier, setRecoveryMultiplier] = useState(1.62);
  const [showLadder,         setShowLadder]         = useState(true);
  const [tpPct,              setTpPct]              = useState(DEFAULT_TP_PCT * 100);  // shown as %
  const [slPct,              setSlPct]              = useState(DEFAULT_SL_PCT * 100);

  // Sync live balance
  useEffect(() => {
    if (autoBalance && liveBalance && liveBalance > 0) {
      setBalance(parseFloat(liveBalance.toFixed(2)));
    }
  }, [autoBalance, liveBalance]);

  // Derived payouts / probs
  const primaryPayout  = getPayout(primaryType, primaryBarrier);
  const primaryWinProb = getWinProb(primaryType, primaryBarrier);
  const recoveryPayout = getPayout(recoveryType, recoveryBarrier);

  // Balance-based targets
  const targetTP = parseFloat(((tpPct / 100) * balance).toFixed(2));
  const targetSL = parseFloat(((slPct / 100) * balance).toFixed(2));

  // Suggested stake: tightest of SL constraint, TP-driven size, and 1% balance cap
  const suggestedStake = useMemo(() => calcSuggestedStake(
    balance,
    slPct / 100,
    recoveryMethod,
    recoveryPayout,
    recoveryMultiplier,
    maxLosses,
    primaryPayout,
    primaryWinProb,
    tpPct / 100,
  ), [balance, slPct, recoveryMethod, recoveryPayout, recoveryMultiplier, maxLosses,
      primaryPayout, primaryWinProb, tpPct]);

  // Full risk calculation
  const result = useMemo(() => calcRisk({
    baseStake,
    balance,
    primaryPayout,
    primaryWinProb,
    recoveryPayout,
    maxLosses,
    recoveryMethod,
    recoveryMultiplier,
    tradesPerSession,
  }), [
    baseStake, balance, primaryPayout, primaryWinProb, recoveryPayout,
    maxLosses, recoveryMethod, recoveryMultiplier, tradesPerSession,
  ]);

  const stakeAsPct = balance > 0 ? (baseStake / balance) * 100 : 0;
  const slOk = result.totalLadderCost * 1.1 <= targetSL;
  const stakeAtMin = baseStake <= MIN_STAKE + 0.005;

  return (
    <div className="min-h-full bg-background">
      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 md:px-6 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
          <Calculator className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-base font-bold leading-tight">Risk Calculator</h1>
          <p className="text-xs text-muted-foreground hidden sm:block">Configure stake, TP &amp; SL to avoid overexposure on Deriv markets</p>
        </div>
        <Button
          variant="outline" size="sm" className="ml-auto gap-1.5 text-xs flex-shrink-0"
          onClick={() => setLocation("/settings")}
        >
          <ArrowRight className="w-3 h-3" />
          Apply in Settings
        </Button>
      </div>

      <div className="p-4 md:p-6">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_500px] gap-5 max-w-[1400px] mx-auto">

          {/* ══ LEFT COLUMN: Inputs ══ */}
          <div className="space-y-4">

            {/* Account & Stake ─────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={Wallet} title="Account & Stake" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-0">

                {/* Balance row with auto toggle */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40">
                  <div>
                    <div className="text-sm font-medium">Account Balance</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                      {liveBalance
                        ? <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />Live: {usd(liveBalance)}</span>
                        : <span className="text-muted-foreground/60">No account connected</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5">
                      {autoBalance && liveBalance
                        ? <Lock className="w-3 h-3 text-primary" />
                        : <Unlock className="w-3 h-3 text-muted-foreground" />}
                      <Switch
                        checked={autoBalance && !!liveBalance}
                        disabled={!liveBalance}
                        onCheckedChange={setAutoBalance}
                        className="scale-75"
                      />
                    </div>
                    <NumField
                      value={balance}
                      onChange={setBalance}
                      min={1} step={10} prefix="$"
                      disabled={autoBalance && !!liveBalance}
                    />
                  </div>
                </div>

                {/* Base stake with "Apply suggested" */}
                <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40">
                  <div>
                    <div className="text-sm font-medium">Base Stake</div>
                    <div className="text-xs text-muted-foreground">{fmt(stakeAsPct, 2)}% of balance</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {baseStake !== suggestedStake && (
                      <button
                        onClick={() => setBaseStake(suggestedStake)}
                        className="text-[10px] flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary border border-primary/25 hover:bg-primary/20 transition-colors"
                      >
                        <Sparkles className="w-2.5 h-2.5" />
                        {usd(suggestedStake)}
                      </button>
                    )}
                    <NumField value={baseStake} onChange={setBaseStake} min={MIN_STAKE} step={0.5} prefix="$" />
                  </div>
                </div>

                <Row label="Max Consecutive Losses" hint="Point where you stop and reassess">
                  <NumField value={maxLosses} onChange={setMaxLosses} min={1} max={15} width="w-16" />
                </Row>
                <Row label="Trades per Session" hint="Used for streak probability">
                  <NumField value={tradesPerSession} onChange={setTradesPerSession} min={5} max={200} width="w-20" />
                </Row>
              </CardContent>
            </Card>

            {/* Session Targets ─────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={Target} title="Daily TP / SL Targets" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <Row label="Take Profit %" hint={`Target = ${usd(targetTP)}`}>
                  <NumField value={tpPct} onChange={setTpPct} min={1} max={100} step={1} suffix="%" width="w-16" />
                </Row>
                <Row label="Stop Loss %" hint={`Limit = ${usd(targetSL)}`}>
                  <NumField value={slPct} onChange={setSlPct} min={1} max={100} step={1} suffix="%" width="w-16" />
                </Row>
                <div className="text-[11px] text-muted-foreground bg-secondary/30 rounded-md p-2.5 border border-border/40 leading-relaxed">
                  <Info className="w-3 h-3 inline mr-1.5 text-primary" />
                  Defaults: TP = <strong className="text-foreground">10%</strong> of balance, SL = <strong className="text-foreground">30%</strong> of balance.
                  In binary trading the SL is typically larger than TP because a single losing streak
                  can exceed many small wins — this is intentional, not a mistake.
                </div>
              </CardContent>
            </Card>

            {/* Primary Contract ────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={TrendingUp} title="Normal Mode Contract" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-3">
                <ContractPicker
                  type={primaryType} barrier={primaryBarrier}
                  onTypeChange={setPrimaryType} onBarrierChange={setPrimaryBarrier}
                />
                <div className="p-2.5 rounded-md bg-secondary/30 border border-border/40 text-xs text-muted-foreground">
                  <Info className="w-3 h-3 inline mr-1.5 text-primary" />
                  Breakeven win rate: <strong className="text-foreground">{pct(result.breakevenWinRate)}</strong>
                  {"  "}·{"  "}EV per trade:{" "}
                  <strong className={result.evPerTrade >= 0 ? "text-green-400" : "text-orange-400"}>
                    {result.evPerTrade >= 0 ? "+" : ""}{fmt(result.evPerTrade * 100, 2)}¢ per $1 staked
                  </strong>
                </div>
              </CardContent>
            </Card>

            {/* Recovery Contract ───────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={RefreshCw} title="Recovery Mode Contract" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-4">
                <ContractPicker
                  type={recoveryType} barrier={recoveryBarrier}
                  onTypeChange={setRecoveryType} onBarrierChange={setRecoveryBarrier}
                />

                {/* Method toggle */}
                <div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-2">Recovery Method</div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["instant", "split"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setRecoveryMethod(m)}
                        className={`flex items-center gap-2 p-3 rounded-lg border text-sm font-medium transition-colors ${
                          recoveryMethod === m
                            ? "bg-primary/10 border-primary/40 text-primary"
                            : "bg-secondary/40 border-border/50 text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {m === "instant" ? <Zap className="w-4 h-4" /> : <GitBranch className="w-4 h-4" />}
                        <div className="text-left">
                          <div className="font-semibold capitalize">{m}</div>
                          <div className="text-[10px] opacity-70">
                            {m === "instant" ? "One trade to recover" : "Progressive steps"}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  {recoveryMethod === "split" && (
                    <div className="mt-3">
                      <Row label="Recovery Multiplier" hint="Stake multiplier per step">
                        <NumField value={recoveryMultiplier} onChange={setRecoveryMultiplier} min={1.1} max={5} step={0.1} width="w-20" />
                      </Row>
                    </div>
                  )}
                </div>

                <div className="p-2.5 rounded-md bg-secondary/30 border border-border/40 text-xs text-muted-foreground">
                  <Info className="w-3 h-3 inline mr-1.5 text-primary" />
                  {recoveryMethod === "instant"
                    ? "One winning trade covers all losses + base profit."
                    : "Losses spread over multiple increasing-stake trades."}
                  {"  "}Net P&L after a full cycle:{" "}
                  <strong className="text-green-400">+{usd(result.netAfterRecovery)}</strong>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ══ RIGHT COLUMN: Results ══ */}
          <div className="space-y-4">

            {/* Hero: Stake Recommendation ──────────────────────────── */}
            <Card
              className="border-2 overflow-hidden"
              style={{ borderColor: `${result.riskColor}40`, background: `linear-gradient(135deg, ${result.riskColor}08 0%, transparent 60%)` }}
            >
              <CardContent className="pt-5 pb-5 px-5">
                <div className="flex items-start gap-4">
                  <RiskGauge score={result.riskScore} color={result.riskColor} label={result.riskLabel} />

                  <div className="flex-1 space-y-3 pt-1 min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recommended Setup</div>

                    {/* Stake hero */}
                    <div className="bg-primary/8 border border-primary/25 rounded-xl p-3">
                      <div className="text-[10px] uppercase tracking-wider text-primary/70 mb-0.5">Stake per trade</div>
                      <div className="flex items-end gap-2">
                        <span className="text-3xl font-bold tabular-nums text-primary">{usd(suggestedStake)}</span>
                        <span className="text-xs text-muted-foreground mb-1">
                          {fmt((suggestedStake / balance) * 100, 2)}% of balance
                        </span>
                      </div>
                      {stakeAtMin && (
                        <div className="text-[10px] text-yellow-400 mt-1 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" />
                          Deriv minimum ($0.35) — balance too small for this ladder
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <Stat
                        label="Balance covers"
                        value={`${result.balanceCoverage >= 100 ? "99+" : fmt(result.balanceCoverage, 1)}×`}
                        sub="recovery cycles"
                        color={result.balanceCoverage < 2 ? "text-red-400" : result.balanceCoverage < 4 ? "text-yellow-400" : "text-green-400"}
                      />
                      <Stat
                        label="Session risk"
                        value={pct(result.streakProbSession)}
                        sub={`${tradesPerSession}-trade session`}
                        color={result.streakProbSession > 0.5 ? "text-red-400" : result.streakProbSession > 0.25 ? "text-yellow-400" : "text-green-400"}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* TP / SL Targets ─────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={Shield} title="Daily TP / SL" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-4">
                {/* Big TP/SL display */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingUp className="w-3.5 h-3.5 text-green-400" />
                      <span className="text-[10px] uppercase tracking-wider text-green-400 font-semibold">Take Profit</span>
                    </div>
                    <div className="text-3xl font-bold text-green-400 tabular-nums leading-none">{usd(targetTP)}</div>
                    <div className="text-[11px] text-green-400/60 mt-1.5">{tpPct}% of {usd(balance)}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      ≈ {fmt(targetTP / Math.max(baseStake * (primaryPayout - 1), 0.001), 0)} winning trades
                    </div>
                  </div>

                  <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                    <div className="flex items-center gap-1.5 mb-2">
                      <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-[10px] uppercase tracking-wider text-red-400 font-semibold">Stop Loss</span>
                    </div>
                    <div className="text-3xl font-bold text-red-400 tabular-nums leading-none">{usd(targetSL)}</div>
                    <div className="text-[11px] text-red-400/60 mt-1.5">{slPct}% of {usd(balance)}</div>
                    <div className={`text-[11px] mt-1 ${slOk ? "text-green-400" : "text-red-300"}`}>
                      {slOk ? "✓ covers full ladder" : "⚠ ladder exceeds this SL"}
                    </div>
                  </div>
                </div>

                {/* Bars showing ladder vs targets */}
                <div className="space-y-3">
                  <TargetBar
                    label="Ladder cost vs Stop Loss"
                    value={result.totalLadderCost * 1.1}
                    target={targetSL}
                    color={slOk ? "#10b981" : "#ef4444"}
                    icon={ShieldAlert}
                  />
                  <TargetBar
                    label="Expected session gain vs Take Profit"
                    value={result.netAfterRecovery}
                    target={targetTP}
                    color="#10b981"
                    icon={TrendingUp}
                  />
                </div>

                <div className="grid grid-cols-3 gap-2 pt-1">
                  <Stat
                    label="SL : TP ratio"
                    value={`${fmt(targetSL / Math.max(targetTP, 0.01), 1)}:1`}
                    sub="(binary norm > 2:1)"
                    color="text-muted-foreground"
                  />
                  <Stat
                    label="Cycle profit"
                    value={`+${usd(result.netAfterRecovery)}`}
                    sub="per full cycle"
                    color="text-green-400"
                  />
                  <Stat
                    label="Min balance"
                    value={usd(result.totalLadderCost * 3)}
                    sub="3× ladder cost"
                    color={balance < result.totalLadderCost * 3 ? "text-red-400" : "text-foreground"}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Streak Survival ─────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-1 pt-4 px-4">
                <SectionHeader icon={BarChart3} title="Streak Survival Analysis" accent />
              </CardHeader>
              <CardContent className="px-4 pb-4 space-y-2.5">
                {[
                  { trades: tradesPerSession, prob: result.streakProbSession, label: `${tradesPerSession}-trade session` },
                  { trades: 50,              prob: result.streakProb50,      label: "50-trade session" },
                  { trades: 100,             prob: streakProbValue(primaryWinProb, maxLosses, 100), label: "100-trade session" },
                ].map(({ label, prob }) => (
                  <div key={label}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-muted-foreground">{label}</span>
                      <span className={`text-xs font-bold tabular-nums ${prob > 0.5 ? "text-red-400" : prob > 0.25 ? "text-yellow-400" : "text-green-400"}`}>
                        {pct(prob)}
                      </span>
                    </div>
                    <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: prob > 0.5 ? "#ef4444" : prob > 0.25 ? "#f59e0b" : "#10b981" }}
                        initial={{ width: 0 }}
                        animate={{ width: `${prob * 100}%` }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    </div>
                  </div>
                ))}
                <div className="pt-1 text-[11px] text-muted-foreground">
                  Probability of hitting <strong className="text-foreground">{maxLosses} consecutive losses</strong> in
                  the given number of trades. Keep below <strong className="text-foreground">25%</strong> for a safe strategy.
                </div>
              </CardContent>
            </Card>

            {/* Recovery Ladder ─────────────────────────────────────── */}
            <Card className="border-border/60">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <SectionHeader icon={GitBranch} title="Recovery Ladder" />
                  <button
                    onClick={() => setShowLadder((s) => !s)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showLadder ? "rotate-180" : ""}`} />
                    {showLadder ? "Hide" : "Show"}
                  </button>
                </div>
              </CardHeader>
              <AnimatePresence>
                {showLadder && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    style={{ overflow: "hidden" }}
                  >
                    <CardContent className="px-4 pb-4">
                      <LadderTable ladder={result.ladder} totalCost={result.totalLadderCost} balance={balance} />
                    </CardContent>
                  </motion.div>
                )}
              </AnimatePresence>
            </Card>

            {/* Warnings ────────────────────────────────────────────── */}
            {result.warnings.length > 0 && (
              <Card className="border-yellow-500/30 bg-yellow-500/5">
                <CardContent className="px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-yellow-400">Risk Warnings</span>
                  </div>
                  {result.warnings.map((w, i) => (
                    <div key={i} className="flex gap-2 text-xs text-yellow-200/80">
                      <span className="text-yellow-500 mt-0.5 flex-shrink-0">•</span>
                      <span>{w}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Apply footer ────────────────────────────────────────── */}
            <div className="flex items-center gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
              <div className="flex-1 text-xs text-muted-foreground">
                Take these values to{" "}
                <button
                  className="text-primary underline underline-offset-2"
                  onClick={() => setLocation("/settings")}
                >
                  Settings → Daily Limits
                </button>
                . Set stake <strong className="text-foreground">{usd(suggestedStake)}</strong>,
                TP <strong className="text-foreground">{usd(targetTP)}</strong>,
                SL <strong className="text-foreground">{usd(targetSL)}</strong>.
              </div>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs flex-shrink-0" onClick={() => setLocation("/settings")}>
                <ChevronRight className="w-3 h-3" />
                Go
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// thin wrapper so JSX can call the pure function without import collision
function streakProbValue(winP: number, streak: number, trades: number): number {
  return streakProb(winP, streak, trades);
}
