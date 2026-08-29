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
import { TrendingUp, TrendingDown, Hash, Equal, DollarSign, Percent } from "lucide-react";
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
  exactRecoveryStake,
  roundRecoveryStakeUp,
} from "@/lib/payouts";

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

// Contract type groups — what the AI engine trades
const CONTRACT_GROUPS = [
  {
    id: "riseFall",
    label: "Rise & Fall",
    icon: <TrendingUp className="w-4 h-4" />,
    desc: "Tick-to-tick momentum. Price ends higher (Rise = CALL) or lower (Fall = PUT) than entry at contract expiry.",
    types: ["CALL", "PUT"],
    color: "indigo",
  },
  {
    id: "overUnder",
    label: "Over & Under (Digits)",
    icon: <Hash className="w-4 h-4" />,
    desc: "Last digit of price. AI picks optimal barrier from live digit analysis.",
    types: ["DIGITOVER", "DIGITUNDER"],
    color: "emerald",
  },
  {
    id: "evenOdd",
    label: "Even & Odd (Digits)",
    icon: <TrendingDown className="w-4 h-4" />,
    desc: "Last digit parity. AI analyses digit frequency, chi-square bias and streak patterns to find edge.",
    types: ["DIGITEVEN", "DIGITODD"],
    color: "violet",
  },
  {
    id: "matchDiff",
    label: "Matches & Differs (Digits)",
    icon: <Equal className="w-4 h-4" />,
    desc: "Predict whether the last digit will match (MATCH) or differ from (DIFF) a specific digit. AI picks the hottest digit to match and coldest digit to differ from for positive EV.",
    types: ["DIGITMATCH", "DIGITDIFF"],
    color: "rose",
  },
];

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
    marketRotationAfter: 5,
    tradeDurationSec: 5,
    maxTradeStake: 500,
    autonomousEnabled: false,
    recoveryMode: false,
    recoveryAutoMode: true,
    recoveryMethod: "split" as "split" | "instant",
    recoveryMultiplier: 1.62,
    maxRecoverySteps: 3,
    normalOverDigit: 1,
    normalUnderDigit: 8,
    recoveryOverDigit: 3,
    recoveryUnderDigit: 6,
    scanAllMarkets: true,
    paperTradeMode: false,
    requirePositiveEv: true,
    minConfidenceThreshold: 50,
    loopIntervalSec: 15,
    preferredContractTypes: ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"],
    preferredCategories: ["synthetic"],
    allowedMarkets: [] as string[],
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
        marketRotationAfter: settings.marketRotationAfter,
        tradeDurationSec: (settings as any).tradeDurationSec ?? 5,
        maxTradeStake: (settings as any).maxTradeStake ?? 500,
        autonomousEnabled: settings.autonomousEnabled,
        recoveryMode: (settings as any).recoveryMode ?? false,
        recoveryAutoMode: (settings as any).recoveryAutoMode ?? true,
        recoveryMethod: ((settings as any).recoveryMethod ?? "split") as "split" | "instant",
        recoveryMultiplier: (settings as any).recoveryMultiplier ?? 1.62,
        maxRecoverySteps: (settings as any).maxRecoverySteps ?? 3,
        normalOverDigit: (settings as any).normalOverDigit ?? 1,
        normalUnderDigit: (settings as any).normalUnderDigit ?? 8,
        recoveryOverDigit: (settings as any).recoveryOverDigit ?? 3,
        recoveryUnderDigit: (settings as any).recoveryUnderDigit ?? 6,
        scanAllMarkets: (settings as any).scanAllMarkets ?? true,
        paperTradeMode: (settings as any).paperTradeMode ?? false,
        requirePositiveEv: (settings as any).requirePositiveEv ?? true,
        minConfidenceThreshold: (settings as any).minConfidenceThreshold ?? 50,
        loopIntervalSec: (settings as any).loopIntervalSec ?? 15,
        preferredContractTypes: settings.preferredContractTypes.length > 0
          ? settings.preferredContractTypes.map((t: string) => t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i)
          : ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD", "DIGITMATCH", "DIGITDIFF"],
        preferredCategories: (settings as any).preferredCategories?.length > 0
          ? (settings as any).preferredCategories
          : ["synthetic"],
        allowedMarkets: (settings as any).allowedMarkets ?? [],
      });
    }
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));

  // Toggle entire contract group
  const toggleGroup = (types: string[]) => {
    setForm((prev) => {
      const allActive = types.every(t => prev.preferredContractTypes.includes(t));
      if (allActive) {
        // Deactivate group — but don't allow empty
        const next = prev.preferredContractTypes.filter(t => !types.includes(t));
        return { ...prev, preferredContractTypes: next.length > 0 ? next : prev.preferredContractTypes };
      } else {
        return {
          ...prev,
          preferredContractTypes: [...new Set([...prev.preferredContractTypes, ...types])],
        };
      }
    });
  };

  const handleSave = () => {
    updateSettings.mutate({ data: { ...form } as any }, {
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

  // UI examples use the canonical fallback schedule. At execution time the
  // server asks Deriv for a live $1 proposal and only falls back to these values.
  const recoveryOverPayout = OVER_PAYOUTS[form.recoveryOverDigit] ?? OVER_PAYOUTS[3];
  const recoveryUnderPayout = UNDER_PAYOUTS[form.recoveryUnderDigit] ?? UNDER_PAYOUTS[6];
  const normalOverPayout = OVER_PAYOUTS[form.normalOverDigit] ?? OVER_PAYOUTS[1];
  const normalUnderPayout = UNDER_PAYOUTS[form.normalUnderDigit] ?? UNDER_PAYOUTS[8];
  const exampleBaseStake = form.riskAmountType === "percentage" && account
    ? Math.max(0.35, Number(account.balance) * form.riskAmountValue / 100)
    : Math.max(0.35, form.riskAmountValue);
  const overExampleTarget = exampleBaseStake * (normalOverPayout - 1);
  const underExampleTarget = exampleBaseStake * (normalUnderPayout - 1);
  const overInstantExample = roundRecoveryStakeUp(exactRecoveryStake(exampleBaseStake, overExampleTarget, recoveryOverPayout));
  const underInstantExample = roundRecoveryStakeUp(exactRecoveryStake(exampleBaseStake, underExampleTarget, recoveryUnderPayout));

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-24">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">The AI engine learns autonomously — configure risk and trade mode only.</p>
      </div>

      {account && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
          <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-sm text-green-400">Live on <span className="font-mono">{account.loginId}</span> — {account.currency} {Number(account.balance).toFixed(2)}</span>
        </div>
      )}

      {/* Risk Profile */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Risk Profile</CardTitle>
          <CardDescription className="text-xs">Core risk configuration applied to all trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Profile Preset" description="Affects stake sizing multiplier.">
            <Select value={form.riskProfile} onValueChange={(v) => set("riskProfile", v)}>
              <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Risk Amount Type" description="Choose how you specify the amount to risk per trade.">
            <div className="flex rounded-lg overflow-hidden border border-border">
              <button
                onClick={() => set("riskAmountType", "fixed")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${form.riskAmountType === "fixed" ? "bg-primary text-primary-foreground" : "bg-secondary/50 text-muted-foreground hover:text-foreground"}`}
              >
                <DollarSign className="w-3 h-3" /> Fixed $
              </button>
              <button
                onClick={() => set("riskAmountType", "percentage")}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${form.riskAmountType === "percentage" ? "bg-primary text-primary-foreground" : "bg-secondary/50 text-muted-foreground hover:text-foreground"}`}
              >
                <Percent className="w-3 h-3" /> % Balance
              </button>
            </div>
          </SettingRow>
          <SettingRow
            label={form.riskAmountType === "fixed" ? "Risk Amount" : "Risk Percentage"}
            description={form.riskAmountType === "fixed" ? "Fixed dollar amount to risk per trade." : "Percentage of current balance to risk per trade."}
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
          <SettingRow label="Max Stake Per Trade" description="Hard cap per trade regardless of balance.">
            <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={0.5} suffix="$" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Daily Limits */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily Limits</CardTitle>
          <CardDescription className="text-xs">Engine auto-stops when these are hit.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Daily Profit Target" description="Stop once this daily profit is achieved.">
            <NumInput value={form.dailyTarget} onChange={(v) => set("dailyTarget", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Daily Loss Limit" description="Stop if total daily loss hits this.">
            <NumInput value={form.dailyLossLimit} onChange={(v) => set("dailyLossLimit", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Max Drawdown" description="Stop if portfolio drops by this %.">
            <NumInput value={form.maxDrawdown} onChange={(v) => set("maxDrawdown", v)} min={1} max={50} step={0.5} suffix="%" />
          </SettingRow>
          <SettingRow label="Consecutive Loss Limit" description="Pause after this many losses in a row.">
            <NumInput value={form.consecutiveLossLimit} onChange={(v) => set("consecutiveLossLimit", v)} min={1} max={20} />
          </SettingRow>
          <SettingRow label="Cooldown Duration" description="Minutes before engine auto-resumes after a consecutive-loss stop.">
            <NumInput value={form.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} min={1} max={1440} step={5} suffix="min" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Engine Configuration */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Engine Configuration</CardTitle>
          <CardDescription className="text-xs">Core AI engine parameters that control how and when the engine trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow
            label="Paper Trade Mode"
            description="Log all trades to the journal without sending real orders to Deriv. Use to test strategies with zero risk. Turn off to go live."
          >
            <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
          </SettingRow>
          <SettingRow
            label="Require Positive EV"
            description="Only trade when the engine calculates a positive expected value. Disabling allows more trade attempts but may reduce win rate."
          >
            <Switch checked={form.requirePositiveEv} onCheckedChange={(v) => set("requirePositiveEv", v)} />
          </SettingRow>
          <SettingRow
            label="Min Confidence Threshold"
            description="Minimum AI confidence score (0–100) required before placing a trade. Higher = fewer trades, better quality."
          >
            <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={30} max={95} step={1} suffix="%" />
          </SettingRow>
          <SettingRow
            label="Scan Interval"
            description="How often the autonomous engine scans markets for opportunities."
          >
            <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={120} step={1} suffix="s" />
          </SettingRow>
          {form.paperTradeMode && (
            <div className="mt-2 p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg text-[11px] text-amber-400">
              <strong>Paper Trade Mode is ON</strong> — no real orders will be sent to Deriv. All trades are simulated in the journal.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recovery Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Mode</CardTitle>
          <CardDescription className="text-xs">
            When enabled, after a loss the engine escalates stake size to recover the lost amount. Recovery is tracked as a single global state — it returns to normal as soon as accumulated loss debt is fully repaid. Optional target profit is used only to size an ideal recovery stake and never keeps recovery active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Enable Recovery Mode" description="Automatically increase stake after a loss to recover.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>

          {form.recoveryMode && (
            <>
              {/* Auto / Manual mode selector */}
              <div className="mt-3 mb-1">
                <div className="text-xs font-medium text-foreground mb-2">Recovery Calculator Mode</div>
                <div className="flex rounded-lg overflow-hidden border border-border w-full">
                  <button
                    onClick={() => set("recoveryAutoMode", true)}
                    className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors ${form.recoveryAutoMode ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    <span className="font-semibold">Auto</span>
                    <span className={`text-[10px] ${form.recoveryAutoMode ? "text-primary-foreground/80" : "text-muted-foreground"}`}>AI computes exact stake</span>
                  </button>
                  <button
                    onClick={() => set("recoveryAutoMode", false)}
                    className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors border-l border-border ${!form.recoveryAutoMode ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    <span className="font-semibold">Manual</span>
                    <span className={`text-[10px] ${!form.recoveryAutoMode ? "text-primary-foreground/80" : "text-muted-foreground"}`}>Set your own multiplier</span>
                  </button>
                </div>
                {form.recoveryAutoMode ? (
                  <div className="mt-2 p-2.5 bg-primary/5 border border-primary/20 rounded-lg text-[11px] text-muted-foreground space-y-1">
                    <p>
                      <span className="text-primary font-medium">Auto mode — no multiplier: </span>
                      exact stake = (accumulated loss debt + optional original target profit) ÷ (live payout − 1). Recovery still ends the moment debt is cleared, even if the optional target is missed.
                    </p>
                    <p>
                      Payout includes the returned stake, so only payout − 1 is available as profit.
                      Instant targets full clearance in one win; Split never stakes more than one normal base stake per attempt.
                    </p>
                  </div>
                ) : (
                  <div className="mt-2 p-2.5 bg-secondary/20 border border-border rounded-lg text-[11px] text-muted-foreground">
                    <span className="text-foreground font-medium">Manual mode: </span>
                    Your multiplier is used as entered with no payout calibration or hidden range. It compounds after each recovery loss until Max Recovery Steps.
                  </div>
                )}
              </div>

              {/* Recovery Method — available in both modes */}
              <SettingRow
                label="Recovery Method"
                description={form.recoveryAutoMode
                  ? "Auto Split caps every attempt at one normal base stake and carries remaining debt forward. Auto Instant sizes the stake to try to clear debt plus the optional target profit in one win. Missing the target by a cent does not keep recovery active."
                  : "Manual Split uses your compounded multiplier as a cap on the exact target. Manual Instant uses your compounded multiplier stake directly. No automatic payout multiplier is substituted."}
              >
                <Select value={form.recoveryMethod} onValueChange={(v) => set("recoveryMethod", v)}>
                  <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="split">Split</SelectItem>
                    <SelectItem value="instant">Instant</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              {/* Recovery Multiplier — manual mode only */}
              {!form.recoveryAutoMode && (
                <SettingRow
                  label="Recovery Multiplier"
                  description={`Used exactly as entered and compounded by recovery step: Step 1 = ×${form.recoveryMultiplier}, Step 2 = ×${Math.pow(form.recoveryMultiplier, 2).toFixed(2)}, Step 3 = ×${Math.pow(form.recoveryMultiplier, 3).toFixed(2)}. Auto mode never reads this value.`}
                >
                  <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", v)} step={0.01} suffix="×" />
                </SettingRow>
              )}

              {/* Max Recovery Steps — available in both modes */}
              <SettingRow
                label="Max Recovery Steps"
                description={form.recoveryAutoMode
                  ? "Maximum recovery-loss step recorded by the engine. Auto stake still recalculates from live debt and payout; it never adds a fixed multiplier."
                  : "Maximum exponent for your manual multiplier. Recovery continues after this step, but the multiplier stops compounding further."}
              >
                <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={10} />
              </SettingRow>

              {/* Recovery calculation preview */}
              <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                {form.recoveryAutoMode ? (
                  <>
                    <div className="text-xs font-medium text-amber-400 mb-1">Auto recovery — ${exampleBaseStake.toFixed(2)} normal-loss example</div>
                    <div className="text-[10px] text-muted-foreground mb-3">
                      Target profit comes from the original normal trade. Live payout is used at execution; the values below use the fallback schedule.
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {[
                        {
                          side: `OVER ${form.recoveryOverDigit}`,
                          normal: `OVER ${form.normalOverDigit}`,
                          payout: recoveryOverPayout,
                          target: overExampleTarget,
                          instant: overInstantExample,
                        },
                        {
                          side: `UNDER ${form.recoveryUnderDigit}`,
                          normal: `UNDER ${form.normalUnderDigit}`,
                          payout: recoveryUnderPayout,
                          target: underExampleTarget,
                          instant: underInstantExample,
                        },
                      ].map((example) => (
                        <div key={example.side} className="rounded-lg bg-background/50 border border-border/60 p-2.5 space-y-1">
                          <div className="flex justify-between text-[10px]">
                            <span className="font-medium text-foreground">{example.side}</span>
                            <span className="font-mono text-amber-400">{example.payout.toFixed(2)}× payout</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground">
                            ${exampleBaseStake.toFixed(2)} {example.normal} loss + ${example.target.toFixed(2)} original target
                          </p>
                          <div className="flex justify-between text-[10px] pt-1">
                            <span>Instant exact</span>
                            <span className="font-mono font-bold text-amber-300">${example.instant.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-[10px]">
                            <span>Split next stake</span>
                            <span className="font-mono font-bold text-amber-300">${Math.min(exampleBaseStake, example.instant).toFixed(2)} max</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <p className="text-[9px] text-muted-foreground/60 mt-2">
                      Deriv's $0.35 minimum and your Max Stake Per Trade remain hard execution limits.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="text-xs font-medium text-amber-400 mb-1">Manual multiplier ladder (× base stake)</div>
                    <div className="text-[10px] text-muted-foreground mb-2">
                      No auto-calibration. The multiplier compounds after a recovery loss and freezes at Max Recovery Steps.
                    </div>
                    <div className="flex gap-3 flex-wrap">
                      {Array.from({ length: form.maxRecoverySteps }, (_, i) => i + 1).map((step) => (
                        <div key={step} className="text-center">
                          <div className="text-[10px] text-muted-foreground">Step {step}</div>
                          <div className="text-xs font-mono font-bold text-amber-400">
                            {form.recoveryMethod === "split" ? "≤" : ""}×{Math.pow(form.recoveryMultiplier, step).toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Over/Under Digit Configuration */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Over/Under Digit Barriers</CardTitle>
          <CardDescription className="text-xs">
            The AI only trades these exact digit barriers — one pair for normal trading and one pair during recovery. Auto recovery recalculates the exact stake from the selected contract's live payout; no multiplier is needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Normal — OVER digit" description="Barrier for DIGITOVER outside recovery. Default: OVER 1 (~80% win rate, lower payout).">
            <NumInput value={form.normalOverDigit} onChange={(v) => set("normalOverDigit", v)} min={0} max={8} />
          </SettingRow>
          <SettingRow label="Normal — UNDER digit" description="Barrier for DIGITUNDER outside recovery. Default: UNDER 8 (~80% win rate, lower payout).">
            <NumInput value={form.normalUnderDigit} onChange={(v) => set("normalUnderDigit", v)} min={1} max={9} />
          </SettingRow>
          <SettingRow
            label="Recovery — OVER digit"
            description={`Barrier for DIGITOVER while recovering. Fallback payout ${recoveryOverPayout.toFixed(2)}× total return; a live proposal is used for the actual Auto stake.`}
          >
            <NumInput value={form.recoveryOverDigit} onChange={(v) => { set("recoveryOverDigit", v); }} min={0} max={8} />
          </SettingRow>
          <SettingRow
            label="Recovery — UNDER digit"
            description={`Barrier for DIGITUNDER while recovering. Fallback payout ${recoveryUnderPayout.toFixed(2)}× total return; a live proposal is used for the actual Auto stake.`}
          >
            <NumInput value={form.recoveryUnderDigit} onChange={(v) => { set("recoveryUnderDigit", v); }} min={1} max={9} />
          </SettingRow>
          <div className="mt-3 rounded-lg border border-border/60 bg-secondary/10 p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">$1 fallback payout reference</p>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {Object.entries(OVER_PAYOUTS).map(([digit, payout]) => (
                <div key={digit} className="rounded bg-background/60 px-1.5 py-1 text-center">
                  <div className="text-[9px] text-muted-foreground">O{digit} / U{9 - Number(digit)}</div>
                  <div className="text-[10px] font-mono text-foreground">{payout.toFixed(2)}×</div>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 p-2.5 bg-secondary/20 rounded-lg text-[11px] text-muted-foreground space-y-1">
            <p><strong className="text-foreground">Payout meaning:</strong> values are the total returned after a win, including the initial stake. Auto recovery uses only the net portion (payout − 1).</p>
            <p>Other fallback payouts: Even/Odd <strong className="text-foreground">{EVEN_ODD_PAYOUT.toFixed(2)}×</strong> · Rise/Fall <strong className="text-foreground">{RISE_FALL_PAYOUT.toFixed(2)}×</strong> · Matches <strong className="text-foreground">{MATCH_PAYOUT.toFixed(2)}×</strong> · Differs <strong className="text-foreground">{DIFF_PAYOUT.toFixed(2)}×</strong>.</p>
          </div>
        </CardContent>
      </Card>

      {/* AI Engine Contract Mode */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">AI Engine Contract Mode</CardTitle>
          <CardDescription className="text-xs">
            Choose which contract types the engine trades. The AI picks the best market and optimal parameters for each selected type — no manual barriers or directions needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3">
            {CONTRACT_GROUPS.map((group) => {
              const active = group.types.every(t => form.preferredContractTypes.includes(t));
              const partial = !active && group.types.some(t => form.preferredContractTypes.includes(t));
              return (
                <button
                  key={group.id}
                  onClick={() => toggleGroup(group.types)}
                  className={`w-full flex items-start gap-3 p-4 rounded-xl text-left border transition-all ${
                    active
                      ? "bg-primary/10 border-primary/40"
                      : partial
                      ? "bg-amber-500/5 border-amber-500/30"
                      : "bg-secondary/30 border-border hover:border-border/80"
                  }`}
                >
                  <div className={`p-2 rounded-lg mt-0.5 ${active ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"}`}>
                    {group.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`font-semibold text-sm ${active ? "text-primary" : "text-foreground"}`}>{group.label}</span>
                      {active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium">Active</span>}
                      {partial && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium">Partial</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{group.desc}</p>
                    <div className="flex gap-1.5 mt-2">
                      {group.types.map(t => (
                        <span key={t} className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${form.preferredContractTypes.includes(t) ? "bg-primary/10 border-primary/30 text-primary" : "bg-secondary border-border text-muted-foreground"}`}>{t.replace("DIGIT", "").replace("OVER", "OVER").replace("UNDER", "UNDER")}</span>
                      ))}
                    </div>
                  </div>
                  <div className={`w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center mt-1 ${active ? "bg-primary border-primary" : "border-border"}`}>
                    {active && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="p-3 bg-secondary/20 rounded-lg text-xs text-muted-foreground space-y-1">
            <p><strong className="text-foreground">All selected (recommended)</strong> — AI picks the best contract type for each opportunity across all categories</p>
            <p><strong className="text-foreground">Selective mode</strong> — restricts the engine to your chosen contract categories only</p>
            <p><strong className="text-foreground">OVER/UNDER</strong> — AI analyses live digit distribution per tick and selects the most favourable barrier automatically</p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={updateSettings.isPending} className="w-full sm:w-48">
          {updateSettings.isPending ? "Saving…" : "Save All Settings"}
        </Button>
      </div>
    </motion.div>
  );
}
