import { useGetSettings, useUpdateSettings, useGetAccount, getGetSettingsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DollarSign, Percent } from "lucide-react";
import { AutonomousContractSetEditor } from "@/components/autonomous-contract-set-editor";
import {
  contractSetError,
  decodeContractSet,
  encodeContractSet,
  type AutonomousContractSpec,
} from "@/lib/autonomous-contracts";

// ── Presentation primitives ──────────────────────────────────────────────────
// Full class strings only: Tailwind cannot see dynamically assembled names.
const ACCENT = {
  cyan: {
    card: "border-cyan-400/20 shadow-[0_0_35px_rgba(34,211,238,0.05)]",
    dot: "bg-cyan-400 shadow-[0_0_10px_rgb(34_211_238)]",
    label: "text-cyan-300",
    panel: "border-cyan-400/15",
    chip: "border-cyan-400/25 bg-cyan-400/5 text-cyan-200",
  },
  amber: {
    card: "border-amber-400/20 shadow-[0_0_35px_rgba(251,191,36,0.05)]",
    dot: "bg-amber-400 shadow-[0_0_10px_rgb(251_191_36)]",
    label: "text-amber-300",
    panel: "border-amber-400/15",
    chip: "border-amber-400/25 bg-amber-400/5 text-amber-200",
  },
  violet: {
    card: "border-violet-400/20 shadow-[0_0_35px_rgba(167,139,250,0.05)]",
    dot: "bg-violet-400 shadow-[0_0_10px_rgb(167_139_250)]",
    label: "text-violet-300",
    panel: "border-violet-400/15",
    chip: "border-violet-400/25 bg-violet-400/5 text-violet-200",
  },
} as const;

type AccentKey = keyof typeof ACCENT;

function SectionCard({
  index,
  title,
  description,
  accent,
  aside,
  children,
}: {
  index: string;
  title: string;
  description: string;
  accent: AccentKey;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const a = ACCENT[accent];
  return (
    <Card className={`bg-card ${a.card}`}>
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground/70">{index}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${a.dot}`} />
                <CardTitle className="text-base">{title}</CardTitle>
              </div>
              <CardDescription className="text-xs mt-1 max-w-2xl leading-relaxed">{description}</CardDescription>
            </div>
          </div>
          {aside}
        </div>
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

function Panel({ label, accent, children }: { label: string; accent: AccentKey; children: React.ReactNode }) {
  const a = ACCENT[accent];
  return (
    <div className={`rounded-xl border ${a.panel} bg-secondary/10 px-4 pb-1`}>
      <div className="pt-3 pb-1">
        <span className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${a.label}`}>{label}</span>
      </div>
      {children}
    </div>
  );
}

function StatPill({ label, value, accent }: { label: string; value: string; accent: AccentKey }) {
  return (
    <div className={`rounded-lg border ${ACCENT[accent].chip} px-2.5 py-1`}>
      <div className="text-[9px] uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="font-mono text-xs font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-border/50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm">{label}</div>
        {description && <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NumInput({ value, onChange, min, max, step = 1, suffix, disabled }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-24 text-right font-mono text-sm bg-secondary/50 disabled:opacity-40"
      />
      {suffix && <span className="text-xs text-muted-foreground w-8">{suffix}</span>}
    </div>
  );
}

/** Segmented two-way control used for Risk Amount Type and Auto/Manual. */
function SegmentedChoice<T extends string | boolean>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; icon?: React.ReactNode; title: string; hint?: string }>;
}) {
  return (
    <div className="flex w-full rounded-xl overflow-hidden border border-border/80 bg-secondary/20 shadow-inner">
      {options.map((option, i) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2 text-xs font-medium transition-colors ${i > 0 ? "border-l border-border" : ""} ${active ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
          >
            <span className="flex items-center gap-1.5 font-semibold">
              {option.icon}
              {option.title}
            </span>
            {option.hint && (
              <span className={`text-[10px] ${active ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Default contract sets, used only before the server has answered. The server
// always returns the sets the engine actually trades.
const DEFAULT_NORMAL_CONTRACTS: AutonomousContractSpec[] = [
  { type: "CALL", digit: -1 },
  { type: "PUT", digit: -1 },
  { type: "DIGITOVER", digit: 1 },
  { type: "DIGITUNDER", digit: 8 },
  { type: "DIGITEVEN", digit: -1 },
  { type: "DIGITODD", digit: -1 },
];
const DEFAULT_RECOVERY_CONTRACTS: AutonomousContractSpec[] = [
  { type: "CALL", digit: -1 },
  { type: "PUT", digit: -1 },
  { type: "DIGITOVER", digit: 3 },
  { type: "DIGITUNDER", digit: 6 },
  { type: "DIGITEVEN", digit: -1 },
  { type: "DIGITODD", digit: -1 },
];

/** Mirrors the engine's risk-profile multiplier so the preview matches execution. */
const PROFILE_MULTIPLIER: Record<string, number> = { conservative: 0.4, moderate: 0.7, aggressive: 1 };

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    riskProfile: "moderate" as "conservative" | "moderate" | "aggressive",
    riskAmountType: "fixed" as "fixed" | "percentage",
    riskAmountValue: 1,
    dailyTarget: 50,
    dailyLossLimit: 30,
    maxDrawdown: 10,
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    cooldownEnabled: true,
    marketRotationAfter: 5,
    tradeDurationSec: 5,
    maxTradeStake: 500,
    autonomousEnabled: false,
    recoveryMode: false,
    recoveryAutoMode: true,
    recoveryMethod: "split" as "split" | "instant",
    recoveryMultiplier: 1.62,
    maxRecoverySteps: 3,
    scanAllMarkets: true,
    paperTradeMode: false,
    requirePositiveEv: true,
    minConfidenceThreshold: 50,
    loopIntervalSec: 15,
    preferredCategories: ["synthetic"],
    allowedMarkets: [] as string[],
    normalContracts: DEFAULT_NORMAL_CONTRACTS,
    recoveryContracts: DEFAULT_RECOVERY_CONTRACTS,
  });

  useEffect(() => {
    if (settings) {
      setForm({
        riskProfile: settings.riskProfile as any,
        riskAmountType: ((settings as any).riskAmountType ?? "fixed") as "fixed" | "percentage",
        riskAmountValue: (settings as any).riskAmountValue ?? 1,
        dailyTarget: settings.dailyTarget,
        dailyLossLimit: settings.dailyLossLimit,
        maxDrawdown: settings.maxDrawdown,
        consecutiveLossLimit: settings.consecutiveLossLimit,
        cooldownMinutes: (settings as any).cooldownMinutes ?? 30,
        cooldownEnabled: settings.cooldownEnabled ?? true,
        marketRotationAfter: settings.marketRotationAfter,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryAutoMode: (settings as any).recoveryAutoMode ?? true,
        recoveryMethod: ((settings as any).recoveryMethod ?? "split") as "split" | "instant",
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.62,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        paperTradeMode: (settings as any).paperTradeMode ?? false,
        requirePositiveEv: (settings as any).requirePositiveEv ?? true,
        minConfidenceThreshold: (settings as any).minConfidenceThreshold ?? 50,
        loopIntervalSec: (settings as any).loopIntervalSec ?? 15,
        preferredCategories: (settings as any).preferredCategories?.length > 0
          ? (settings as any).preferredCategories
          : ["synthetic"],
        allowedMarkets: (settings as any).allowedMarkets ?? [],
        normalContracts: decodeContractSet(settings.autonomousNormalContracts).length > 0
          ? decodeContractSet(settings.autonomousNormalContracts)
          : DEFAULT_NORMAL_CONTRACTS,
        recoveryContracts: decodeContractSet(settings.autonomousRecoveryContracts).length > 0
          ? decodeContractSet(settings.autonomousRecoveryContracts)
          : DEFAULT_RECOVERY_CONTRACTS,
      });
    }
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));

  const handleSave = () => {
    const { normalContracts, recoveryContracts, ...rest } = form;
    const setError = contractSetError(normalContracts, "Normal") ?? contractSetError(recoveryContracts, "Recovery");
    if (setError) {
      toast.error(setError);
      return;
    }
    updateSettings.mutate({
      data: {
        ...rest,
        autonomousNormalContracts: encodeContractSet(normalContracts),
        autonomousRecoveryContracts: encodeContractSet(recoveryContracts),
      } as any,
    }, {
      onSuccess: (saved: any) => {
        // Update settings cache directly so the toggles reflect immediately.
        // IMPORTANT: must use the actual query key from the orval hook (["/api/settings"]),
        // not a hand-rolled key — mismatch causes the form to revert to stale data on re-render.
        const settingsKey = getGetSettingsQueryKey();
        queryClient.setQueryData(settingsKey, saved);
        // Invalidate all data that depends on settings (contract types, market rankings, etc.)
        // The server will also broadcast SSE "settings_updated" to all open tabs/dashboard
        queryClient.invalidateQueries({ queryKey: settingsKey });
        queryClient.invalidateQueries({ queryKey: ["markets-top-signals"] });
        queryClient.invalidateQueries({ queryKey: ["markets", "ranked-all"] });
        queryClient.invalidateQueries({ queryKey: ["/api/markets/top"] });
        queryClient.invalidateQueries({ queryKey: ["getAiEngineStatus"] });
        toast.success("Settings saved — engine and market data updated");
      },
      onError: (err: any) => {
        const msg = err?.data?.error || err?.message || "Failed to save settings";
        toast.error(msg);
      },
    });
  };

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm animate-pulse">Loading settings…</div>;

  // Preview only — execution stays with the engine. Percentage mode needs the
  // live balance, so it shows nothing until the account has loaded.
  const balance = account ? Number(account.balance) : null;
  const profileMult = PROFILE_MULTIPLIER[form.riskProfile] ?? 0.7;
  const rawStake = form.riskAmountType === "fixed"
    ? form.riskAmountValue * profileMult
    : (balance ?? 0) * (form.riskAmountValue / 100) * profileMult;
  const stakePreview = Number.isFinite(rawStake) && rawStake > 0
    ? Math.max(0.35, Math.min(rawStake, form.maxTradeStake))
    : null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-6xl mx-auto space-y-5 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">The AI engine learns autonomously — configure risk and trade mode only.</p>
        </div>
        {account && (
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-green-500/5 border border-green-500/20">
            <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0 animate-pulse" />
            <span className="text-xs text-green-400">
              Live on <span className="font-mono">{account.loginId}</span>
              <span className="text-green-400/60"> · </span>
              <span className="font-mono">{account.currency} {Number(account.balance).toFixed(2)}</span>
            </span>
          </div>
        )}
      </div>

      {/* 01 — Risk Profile and Daily Limits, one control surface */}
      <SectionCard
        index="01"
        title="Risk & Daily Controls"
        description="Per-trade exposure on the left, the automatic stop conditions on the right. Everything the engine checks before it risks a cent lives here."
        accent="cyan"
        aside={
          <div className="flex flex-wrap gap-2">
            <StatPill accent="cyan" label="Per trade" value={stakePreview === null ? "—" : `$${stakePreview.toFixed(2)}`} />
            <StatPill accent="amber" label="Daily stop" value={`−$${form.dailyLossLimit}`} />
            <StatPill accent="amber" label="Cooldown" value={form.cooldownEnabled ? `${form.cooldownMinutes}m` : "off"} />
          </div>
        }
      >
        <div className="grid gap-4 xl:grid-cols-2 xl:gap-5">
          <Panel label="Exposure" accent="cyan">
            <SettingRow label="Profile Preset" description="Scales every stake: conservative ×0.4, moderate ×0.7, aggressive ×1.0.">
              <Select value={form.riskProfile} onValueChange={(v) => set("riskProfile", v)}>
                <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">Conservative</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="aggressive">Aggressive</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow label="Risk Amount Type" description="A fixed amount, or a percentage of the live balance.">
              <div className="w-44">
                <SegmentedChoice
                  value={form.riskAmountType}
                  onChange={(v) => set("riskAmountType", v)}
                  options={[
                    { value: "fixed", title: "Fixed $", icon: <DollarSign className="w-3 h-3" /> },
                    { value: "percentage", title: "% Balance", icon: <Percent className="w-3 h-3" /> },
                  ]}
                />
              </div>
            </SettingRow>
            <SettingRow
              label={form.riskAmountType === "fixed" ? "Risk Amount" : "Risk Percentage"}
              description={form.riskAmountType === "fixed"
                ? "Fixed amount at risk per trade, before the profile multiplier."
                : "Share of the current balance at risk per trade, before the profile multiplier."}
            >
              <NumInput
                value={form.riskAmountValue}
                onChange={(v) => set("riskAmountValue", v)}
                min={form.riskAmountType === "fixed" ? 0.35 : 0.1}
                max={form.riskAmountType === "fixed" ? 50000 : 50}
                step={form.riskAmountType === "fixed" ? 0.5 : 0.1}
                suffix={form.riskAmountType === "fixed" ? "$" : "%"}
              />
            </SettingRow>
            <SettingRow label="Max Stake Per Trade" description="Hard cap on any single stake, including a recovery stake.">
              <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={0.5} suffix="$" />
            </SettingRow>
          </Panel>

          <Panel label="Daily guardrails" accent="amber">
            <SettingRow label="Daily Profit Target" description="Engine stops for the day once this profit is banked.">
              <NumInput value={form.dailyTarget} onChange={(v) => set("dailyTarget", v)} min={1} max={100000} step={1} suffix="$" />
            </SettingRow>
            <SettingRow label="Daily Loss Limit" description="Engine stops for the day once total loss reaches this.">
              <NumInput value={form.dailyLossLimit} onChange={(v) => set("dailyLossLimit", v)} min={1} max={100000} step={1} suffix="$" />
            </SettingRow>
            <SettingRow label="Max Drawdown" description="Stop when the portfolio is down this much from its peak.">
              <NumInput value={form.maxDrawdown} onChange={(v) => set("maxDrawdown", v)} min={1} max={50} step={0.5} suffix="%" />
            </SettingRow>
            <SettingRow label="Consecutive Loss Limit" description="Pause after this many losses in a row.">
              <NumInput value={form.consecutiveLossLimit} onChange={(v) => set("consecutiveLossLimit", v)} min={1} max={20} />
            </SettingRow>
            <SettingRow
              label="Cooldown"
              description="Automatically pause the engine after the consecutive-loss limit and resume it once the cooldown elapses. Off: the engine still stops at the loss limit, but waits for you to resume it manually."
            >
              <Switch checked={form.cooldownEnabled} onCheckedChange={(v) => set("cooldownEnabled", v)} />
            </SettingRow>
            <SettingRow label="Cooldown Duration" description="Minutes before the engine auto-resumes after a loss-limit stop. Only used while the cooldown is enabled.">
              <NumInput value={form.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} min={1} max={1440} step={5} suffix="min" disabled={!form.cooldownEnabled} />
            </SettingRow>
          </Panel>
        </div>
        {/* NOTE: the AI Bot Recovery Markup intentionally does NOT live here.
            It is a bot-only setting, editable from the AI Bot section
            (bot deploy console). The main autonomous engine and the NeuroAI
            Quantum FAB use their own recovery logic. */}
      </SectionCard>

      {/* 02 — Engine Configuration */}
      <SectionCard
        index="02"
        title="Engine Configuration"
        description="How the engine behaves while it trades: whether orders are real, and how strong a signal has to be before it acts."
        accent="cyan"
      >
        <div className="grid gap-4 xl:grid-cols-2 xl:gap-5">
          <Panel label="Execution posture" accent="cyan">
            <SettingRow
              label="Paper Trade Mode"
              description="Log every trade to the journal without sending real orders to Deriv. Test a strategy with zero risk."
            >
              <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
            </SettingRow>
            <SettingRow
              label="Require Positive EV"
              description="Only trade when the calculated expected value is positive. Off allows more attempts at a lower win rate."
            >
              <Switch checked={form.requirePositiveEv} onCheckedChange={(v) => set("requirePositiveEv", v)} />
            </SettingRow>
          </Panel>
          <Panel label="Signal quality" accent="cyan">
            <SettingRow
              label="Min Confidence Threshold"
              description="Minimum AI confidence (0–100) before a trade is placed. Higher means fewer, better trades."
            >
              <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={30} max={95} step={1} suffix="%" />
            </SettingRow>
            <SettingRow
              label="Scan Interval"
              description="How often the autonomous engine scans markets for opportunities."
            >
              <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={120} step={1} suffix="s" />
            </SettingRow>
          </Panel>
        </div>
        {form.paperTradeMode && (
          <div className="mt-4 p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg text-[11px] text-amber-400">
            <strong>Paper Trade Mode is ON</strong> — no real orders will be sent to Deriv. All trades are simulated in the journal.
          </div>
        )}
      </SectionCard>

      {/* 03 — Recovery Mode */}
      <SectionCard
        index="03"
        title="Recovery Mode"
        description="After a loss the engine works the debt back. Recovery is one global state per account and ends the moment the accumulated loss debt is repaid — an optional target profit only helps size a stake, it never keeps recovery alive."
        accent="amber"
        aside={
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-muted-foreground">Enabled</span>
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </div>
        }
      >
        {!form.recoveryMode ? (
          <p className="text-xs text-muted-foreground py-2">
            Recovery is off — every trade is sized from your risk settings above, and a loss is simply a loss.
          </p>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2 xl:gap-5">
            <Panel label="Sizing" accent="amber">
              <div className="py-3 border-b border-border/50">
                <div className="font-medium text-sm mb-2">Calculator Mode</div>
                <SegmentedChoice
                  value={form.recoveryAutoMode}
                  onChange={(v) => set("recoveryAutoMode", v)}
                  options={[
                    { value: true, title: "Auto", hint: "engine computes the exact stake" },
                    { value: false, title: "Manual", hint: "you set the multiplier" },
                  ]}
                />
              </div>
              <SettingRow
                label="Recovery Method"
                description={form.recoveryAutoMode
                  ? "Split caps every attempt at one normal base stake and carries the remaining debt forward. Instant sizes one win to clear the debt plus the optional target."
                  : "Split uses your compounded multiplier as a cap on the exact target. Instant stakes your compounded multiplier directly."}
              >
                <Select value={form.recoveryMethod} onValueChange={(v) => set("recoveryMethod", v)}>
                  <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="split">Split</SelectItem>
                    <SelectItem value="instant">Instant</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>
              {!form.recoveryAutoMode && (
                <SettingRow
                  label="Recovery Multiplier"
                  description={`Used exactly as entered and compounded by step: 1 = ×${form.recoveryMultiplier.toFixed(2)}, 2 = ×${Math.pow(form.recoveryMultiplier, 2).toFixed(2)}, 3 = ×${Math.pow(form.recoveryMultiplier, 3).toFixed(2)}. Auto mode never reads this value.`}
                >
                  <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", v)} step={0.01} suffix="×" />
                </SettingRow>
              )}
              <SettingRow
                label="Max Recovery Steps"
                description={form.recoveryAutoMode
                  ? "Deepest recovery-loss step the engine records. Auto still recalculates from live debt and payout."
                  : "Highest exponent for your multiplier. Recovery continues past it, but the multiplier stops compounding."}
              >
                <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={10} />
              </SettingRow>
            </Panel>

            <Panel label="How it behaves" accent="amber">
              <div className="py-3 space-y-2.5">
                {form.recoveryAutoMode ? (
                  <>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      <span className="text-amber-300 font-medium">Auto — no multiplier. </span>
                      Each attempt is sized from the live payout of the contract the engine picks:
                      stake = (loss debt + optional target) ÷ (payout − 1). Payouts include the returned stake, so only payout − 1 repays debt.
                    </p>
                    <ul className="text-[11px] text-muted-foreground space-y-1.5">
                      <li className="flex gap-2"><span className="text-amber-400 mt-1 h-1 w-1 rounded-full bg-amber-400 flex-shrink-0" /><span><strong className="text-foreground">Split</strong> — never stakes more than one normal base stake; the rest of the debt rolls into the next attempt.</span></li>
                      <li className="flex gap-2"><span className="text-amber-400 mt-1 h-1 w-1 rounded-full bg-amber-400 flex-shrink-0" /><span><strong className="text-foreground">Instant</strong> — targets full clearance in a single win.</span></li>
                      <li className="flex gap-2"><span className="text-amber-400 mt-1 h-1 w-1 rounded-full bg-amber-400 flex-shrink-0" /><span>Deriv's $0.35 minimum and your Max Stake Per Trade stay hard limits.</span></li>
                    </ul>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      <span className="text-foreground font-medium">Manual — no calibration. </span>
                      Your multiplier is used exactly as entered, with no payout adjustment and no hidden floor. It compounds after each recovery loss and freezes at Max Recovery Steps.
                    </p>
                    <div className="flex gap-2 flex-wrap pt-1">
                      {Array.from({ length: Math.max(1, Math.min(form.maxRecoverySteps, 10)) }, (_, i) => i + 1).map((step) => (
                        <div key={step} className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-1.5 text-center">
                          <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Step {step}</div>
                          <div className="text-xs font-mono font-bold text-amber-300">
                            {form.recoveryMethod === "split" ? "≤ " : ""}×{Math.pow(form.recoveryMultiplier, step).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Panel>
          </div>
        )}
      </SectionCard>

      {/* 04 — Contract sets, side by side so the two are easy to compare */}
      <SectionCard
        index="04"
        title="Contract Sets"
        description="The two sets are independent: the engine ranks the normal set while trading normally and the recovery set while recovering, so you can trade Even normally and Matches in recovery. Pick any mix up to 8 per set — Over, Under, Matches and Differs take a digit, and Matches or Differs can use auto."
        accent="violet"
      >
        <div className="grid gap-4 xl:grid-cols-2 xl:gap-5">
          <Panel label="Normal trades" accent="cyan">
            <div className="py-3">
              <AutonomousContractSetEditor
                testId="normal-contracts"
                title="Normal contracts"
                description="Ranked on every normal trade."
                specs={form.normalContracts}
                onChange={(next) => set("normalContracts", next)}
              />
            </div>
          </Panel>
          <Panel label="Recovery trades" accent="violet">
            <div className="py-3">
              <AutonomousContractSetEditor
                testId="recovery-contracts"
                title="Recovery contracts"
                description="Ranked on every recovery trade; stakes are sized from the live payout of whichever of these the engine picks."
                specs={form.recoveryContracts}
                onChange={(next) => set("recoveryContracts", next)}
              />
            </div>
          </Panel>
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-[11px] text-muted-foreground">
          Saved settings apply to the running engine immediately and are broadcast to your other open tabs.
        </p>
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-full sm:w-52">
          {updateSettings.isPending ? "Saving…" : "Save All Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
