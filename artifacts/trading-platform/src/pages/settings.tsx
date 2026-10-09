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

      {/* Risk and daily controls */}
      <Card className="bg-card border-primary/15 shadow-[0_0_30px_hsl(var(--primary)/0.04)]">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Risk &amp; Daily Controls</CardTitle>
          <CardDescription className="text-xs">Shape per-trade exposure and the automatic stop conditions from one control surface.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 xl:gap-6">
            <div className="rounded-xl border border-border/70 bg-secondary/10 px-4">
              <div className="flex items-center gap-2 pt-3 pb-1">
                <div className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Exposure</span>
              </div>
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
              <SettingRow label="Risk Amount Type" description="Choose a fixed amount or a percentage of balance.">
                <div className="flex rounded-lg overflow-hidden border border-border">
                  <button onClick={() => set("riskAmountType", "fixed")} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${form.riskAmountType === "fixed" ? "bg-primary text-primary-foreground" : "bg-secondary/50 text-muted-foreground hover:text-foreground"}`}><DollarSign className="w-3 h-3" /> Fixed $</button>
                  <button onClick={() => set("riskAmountType", "percentage")} className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${form.riskAmountType === "percentage" ? "bg-primary text-primary-foreground" : "bg-secondary/50 text-muted-foreground hover:text-foreground"}`}><Percent className="w-3 h-3" /> % Balance</button>
                </div>
              </SettingRow>
              <SettingRow label={form.riskAmountType === "fixed" ? "Risk Amount" : "Risk Percentage"} description={form.riskAmountType === "fixed" ? "Fixed dollar amount to risk per trade." : "Percentage of current balance to risk per trade."}>
                <NumInput value={form.riskAmountValue} onChange={(v) => set("riskAmountValue", v)} min={form.riskAmountType === "fixed" ? 0.35 : 0.1} max={form.riskAmountType === "fixed" ? 50000 : 50} step={form.riskAmountType === "fixed" ? 0.5 : 0.1} suffix={form.riskAmountType === "fixed" ? "$" : "%"} />
              </SettingRow>
              <SettingRow label="Max Stake Per Trade" description="Hard cap per trade regardless of balance.">
                <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={0.5} suffix="$" />
              </SettingRow>
            </div>
            <div className="rounded-xl border border-border/70 bg-secondary/10 px-4">
              <div className="flex items-center gap-2 pt-3 pb-1">
                <div className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px_rgb(251_191_36)]" />
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400">Daily guardrails</span>
              </div>
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
              <SettingRow label="Cooldown Duration" description="Minutes before auto-resume after a loss-limit stop.">
                <NumInput value={form.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} min={1} max={1440} step={5} suffix="min" />
              </SettingRow>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Engine Configuration */}
      <Card className="bg-card border-primary/15 shadow-[0_0_30px_hsl(var(--primary)/0.04)]">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-primary shadow-[0_0_10px_hsl(var(--primary))]" />
            <CardTitle className="text-base">Engine Configuration</CardTitle>
          </div>
          <CardDescription className="text-xs">Core AI engine parameters that control how and when the engine trades.</CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 xl:gap-6">
            <div className="rounded-xl border border-border/70 bg-secondary/10 px-4">
              <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Execution posture</div>
              <SettingRow label="Paper Trade Mode" description="Log trades without sending real orders to Deriv.">
                <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
              </SettingRow>
              <SettingRow label="Require Positive EV" description="Only trade when calculated expected value is positive.">
                <Switch checked={form.requirePositiveEv} onCheckedChange={(v) => set("requirePositiveEv", v)} />
              </SettingRow>
            </div>
            <div className="rounded-xl border border-border/70 bg-secondary/10 px-4">
              <div className="pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">Signal quality</div>
              <SettingRow label="Min Confidence Threshold" description="Minimum AI confidence required before placing a trade.">
                <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={30} max={95} step={1} suffix="%" />
              </SettingRow>
              <SettingRow label="Scan Interval" description="How often the autonomous engine scans for opportunities.">
                <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={120} step={1} suffix="s" />
              </SettingRow>
            </div>
          </div>
          {form.paperTradeMode && (
            <div className="mt-2 p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg text-[11px] text-amber-400">
              <strong>Paper Trade Mode is ON</strong> — no real orders will be sent to Deriv. All trades are simulated in the journal.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recovery Mode */}
      <Card className="bg-card border-amber-400/20 shadow-[0_0_30px_rgba(251,191,36,0.04)]">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_10px_rgb(251_191_36)]" />
            <CardTitle className="text-base">Recovery Mode</CardTitle>
          </div>
          <CardDescription className="text-xs">
            When enabled, after a loss the engine escalates stake size to recover the lost amount. Recovery is tracked as a single global state — it returns to normal as soon as accumulated loss debt is fully repaid. Optional target profit is used only to size an ideal recovery stake and never keeps recovery active.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <SettingRow label="Enable Recovery Mode" description="Automatically increase stake after a loss to recover.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>

          {form.recoveryMode && (
            <>
              {/* Auto / Manual mode selector */}
              <div className="mt-3 mb-1">
                <div className="text-xs font-medium text-foreground mb-2">Recovery Calculator Mode</div>
                <div className="flex rounded-xl overflow-hidden border border-border/80 bg-secondary/20 w-full shadow-inner">
                  <button
                    onClick={() => set("recoveryAutoMode", true)}
                    className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors ${form.recoveryAutoMode ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    <span className="font-semibold">Auto</span>
                    <span className={`text-[10px] ${form.recoveryAutoMode ? "text-primary-foreground/80" : "text-muted-foreground"}`}>AI calculates exact stake</span>
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

            </>
          )}
        </CardContent>
      </Card>

      {/* Normal market contracts — what the engine trades outside recovery */}
      <Card className="bg-card border-cyan-400/15 shadow-[0_0_30px_rgba(34,211,238,0.035)]">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgb(34_211_238)]" />
            <CardTitle className="text-base">Normal Market Contracts</CardTitle>
          </div>
          <CardDescription className="text-xs">
            The contracts the engine may trade when it is not recovering. Pick any mix (up to 8). Each Over, Under, Matches and Differs carries its own digit, and Matches or Differs can use auto to let the engine pick the digit from the live tape.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          <AutonomousContractSetEditor
            testId="normal-contracts"
            title="Normal contracts"
            description="Used for every normal trade."
            specs={form.normalContracts}
            onChange={(next) => set("normalContracts", next)}
          />
        </CardContent>
      </Card>

      {/* Recovery contracts — chosen independently of normal */}
      <Card className="bg-card border-violet-400/15 shadow-[0_0_30px_rgba(167,139,250,0.035)]">
        <CardHeader className="pb-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-violet-400 shadow-[0_0_10px_rgb(167_139_250)]" />
            <CardTitle className="text-base">Recovery Contracts</CardTitle>
          </div>
          <CardDescription className="text-xs">
            The contracts the engine may trade while recovering a loss. This set is independent of the normal set, so you can trade Even in normal markets and Matches in recovery. Recovery stakes are sized from the live payout of the contract the engine picks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <AutonomousContractSetEditor
            testId="recovery-contracts"
            title="Recovery contracts"
            description="Used for every recovery trade."
            specs={form.recoveryContracts}
            onChange={(next) => set("recoveryContracts", next)}
          />
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
