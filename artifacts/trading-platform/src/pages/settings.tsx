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
import { Plus, X, DollarSign, Percent } from "lucide-react";

/**
 * Autonomous engine settings.
 *
 * Normal trades and recovery trades each have their own contract set. The user
 * picks any mix (Rise/Fall, Over/Under with a barrier, Even/Odd, Matches/Differs
 * with a digit or auto) for each set, independently. The engine trades only
 * what is in the set for the current mode. Recovery sizing is unchanged.
 */

type ContractType = "CALL" | "PUT" | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD" | "DIGITMATCH" | "DIGITDIFF";
interface ContractSpec { type: ContractType; digit: number }

const CONTRACT_INFO: Record<ContractType, { label: string; needsDigit: boolean; allowsAuto: boolean; min: number; max: number; legacy: string }> = {
  CALL: { label: "Rise", needsDigit: false, allowsAuto: false, min: -1, max: -1, legacy: "CALL" },
  PUT: { label: "Fall", needsDigit: false, allowsAuto: false, min: -1, max: -1, legacy: "PUT" },
  DIGITEVEN: { label: "Even", needsDigit: false, allowsAuto: false, min: -1, max: -1, legacy: "DIGITEVEN" },
  DIGITODD: { label: "Odd", needsDigit: false, allowsAuto: false, min: -1, max: -1, legacy: "DIGITODD" },
  DIGITOVER: { label: "Over", needsDigit: true, allowsAuto: false, min: 0, max: 8, legacy: "DIGITOVER" },
  DIGITUNDER: { label: "Under", needsDigit: true, allowsAuto: false, min: 1, max: 9, legacy: "DIGITUNDER" },
  DIGITMATCH: { label: "Matches", needsDigit: false, allowsAuto: true, min: 0, max: 9, legacy: "DIGITMATCH" },
  DIGITDIFF: { label: "Differs", needsDigit: false, allowsAuto: true, min: 0, max: 9, legacy: "DIGITDIFF" },
};

const CONTRACT_TYPES = Object.keys(CONTRACT_INFO) as ContractType[];
const MAX_PER_SET = 8;

const DEFAULT_NORMAL: ContractSpec[] = [
  { type: "CALL", digit: -1 }, { type: "PUT", digit: -1 },
  { type: "DIGITOVER", digit: 1 }, { type: "DIGITUNDER", digit: 8 },
  { type: "DIGITEVEN", digit: -1 }, { type: "DIGITODD", digit: -1 },
];

function specLabel(spec: ContractSpec): string {
  const info = CONTRACT_INFO[spec.type];
  if (info.needsDigit) return `${info.label} ${spec.digit}`;
  if (info.allowsAuto) return spec.digit < 0 ? `${info.label} auto` : `${info.label} ${spec.digit}`;
  return info.label;
}

function specKey(spec: ContractSpec): string {
  const info = CONTRACT_INFO[spec.type];
  return `${spec.type}:${info.needsDigit || info.allowsAuto ? spec.digit : -1}`;
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

/** A single set (normal or recovery): chips for what is chosen, plus an add row. */
function ContractSetEditor({ title, hint, specs, onChange, testId }: {
  title: string; hint: string; specs: ContractSpec[]; onChange: (next: ContractSpec[]) => void; testId: string;
}) {
  const [pickType, setPickType] = useState<ContractType>("DIGITOVER");
  const [pickDigit, setPickDigit] = useState(1);
  const [auto, setAuto] = useState(true);
  const info = CONTRACT_INFO[pickType];
  const digitVisible = info.needsDigit || (info.allowsAuto && !auto);

  const add = () => {
    if (specs.length >= MAX_PER_SET) {
      toast.error(`At most ${MAX_PER_SET} contracts per set`);
      return;
    }
    const digit = info.needsDigit || (info.allowsAuto && !auto) ? pickDigit : -1;
    if (digitVisible && (!Number.isInteger(digit) || digit < info.min || digit > info.max)) {
      toast.error(`${info.label}: digit must be ${info.min}–${info.max}`);
      return;
    }
    const next: ContractSpec = { type: pickType, digit };
    if (specs.some((s) => specKey(s) === specKey(next))) {
      toast.info(`${specLabel(next)} is already in this set`);
      return;
    }
    onChange([...specs, next]);
  };

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {specs.length === 0 && <span className="text-xs text-amber-400">Add at least one contract — this mode will not trade without one.</span>}
        {specs.map((spec) => (
          <span key={specKey(spec)} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
            {specLabel(spec)}
            <button
              type="button"
              aria-label={`Remove ${specLabel(spec)}`}
              onClick={() => onChange(specs.filter((s) => specKey(s) !== specKey(spec)))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={pickType} onValueChange={(v) => {
          const t = v as ContractType;
          setPickType(t);
          if (CONTRACT_INFO[t].needsDigit) setPickDigit(CONTRACT_INFO[t].min);
        }}>
          <SelectTrigger aria-label={`${title} contract`} className="w-32 h-8 bg-secondary/50 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CONTRACT_TYPES.map((t) => <SelectItem key={t} value={t}>{CONTRACT_INFO[t].label}</SelectItem>)}
          </SelectContent>
        </Select>
        {info.allowsAuto && (
          <button
            type="button"
            onClick={() => setAuto((v) => !v)}
            aria-pressed={auto}
            className={`h-8 px-2.5 rounded-md border text-xs font-medium ${auto ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-secondary/40 text-muted-foreground"}`}
            title="Auto: the engine picks the digit from the live tape (most frequent for Matches, least for Differs)"
          >
            auto
          </button>
        )}
        {digitVisible && (
          <Input
            type="number" aria-label={`${title} digit`}
            value={pickDigit} min={info.min} max={info.max} step={1}
            onChange={(e) => setPickDigit(Number(e.target.value))}
            className="w-20 h-8 text-right font-mono text-xs bg-secondary/50"
          />
        )}
        <Button type="button" size="sm" variant="secondary" onClick={add} aria-label={`Add to ${title}`} className="h-8 gap-1 text-xs">
          <Plus className="w-3.5 h-3.5" /> Add
        </Button>
        <span className="text-[11px] text-muted-foreground ml-auto">{specs.length}/{MAX_PER_SET}</span>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{hint}</p>
    </div>
  );
}

/** Legacy settings → the two sets, so existing users see exactly what they had. */
function legacySet(types: string[], over: number, under: number): ContractSpec[] {
  const out: ContractSpec[] = [];
  for (const t of types) {
    const ct = t === "RISE" ? "CALL" : t === "FALL" ? "PUT" : t;
    if (ct === "DIGITOVER") out.push({ type: "DIGITOVER", digit: over });
    else if (ct === "DIGITUNDER") out.push({ type: "DIGITUNDER", digit: under });
    else if (CONTRACT_INFO[ct as ContractType]) out.push({ type: ct as ContractType, digit: -1 });
  }
  return out.length > 0 ? out : DEFAULT_NORMAL;
}

function normalizeStored(list: unknown): ContractSpec[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out: ContractSpec[] = [];
  for (const e of list as any[]) {
    const raw = e?.type === "RISE" ? "CALL" : e?.type === "FALL" ? "PUT" : e?.type;
    if (!CONTRACT_INFO[raw as ContractType]) continue;
    out.push({ type: raw as ContractType, digit: typeof e.digit === "number" ? e.digit : -1 });
  }
  return out.length > 0 ? out : null;
}

export default function Settings() {
  const { data: settings, isLoading } = useGetSettings();
  const { data: account } = useGetAccount();
  const updateSettings = useUpdateSettings();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    riskProfile: "moderate" as "conservative" | "moderate" | "aggressive",
    riskAmountType: "fixed" as "fixed" | "percentage",
    riskAmountValue: 1,
    maxTradeStake: 500,
    dailyTarget: 50,
    dailyLossLimit: 30,
    maxDrawdown: 10,
    consecutiveLossLimit: 3,
    cooldownMinutes: 30,
    paperTradeMode: false,
    requirePositiveEv: true,
    minConfidenceThreshold: 50,
    loopIntervalSec: 15,
    recoveryMode: false,
    recoveryAutoMode: true,
    recoveryMethod: "split" as "split" | "instant",
    recoveryMultiplier: 1.62,
    maxRecoverySteps: 3,
    normalContracts: DEFAULT_NORMAL,
    recoveryContracts: DEFAULT_NORMAL,
    // Legacy fields — kept so the saved row stays complete for other engines.
    normalOverDigit: 1,
    normalUnderDigit: 8,
    recoveryOverDigit: 3,
    recoveryUnderDigit: 6,
    tradeDurationSec: 5,
    marketRotationAfter: 5,
    autonomousEnabled: false,
    scanAllMarkets: true,
    preferredCategories: ["synthetic"],
    allowedMarkets: [] as string[],
  });

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    const normalOver = s.normalOverDigit ?? 1;
    const normalUnder = s.normalUnderDigit ?? 8;
    const recOver = s.recoveryOverDigit ?? 3;
    const recUnder = s.recoveryUnderDigit ?? 6;
    const legacyTypes: string[] = (settings.preferredContractTypes ?? []).length > 0
      ? settings.preferredContractTypes
      : ["CALL", "PUT", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD"];
    setForm({
      riskProfile: settings.riskProfile as any,
      riskAmountType: (s.riskAmountType ?? "fixed") as "fixed" | "percentage",
      riskAmountValue: s.riskAmountValue ?? 1,
      maxTradeStake: s.maxTradeStake ?? 500,
      dailyTarget: settings.dailyTarget,
      dailyLossLimit: settings.dailyLossLimit,
      maxDrawdown: settings.maxDrawdown,
      consecutiveLossLimit: settings.consecutiveLossLimit,
      cooldownMinutes: s.cooldownMinutes ?? 30,
      paperTradeMode: s.paperTradeMode ?? false,
      requirePositiveEv: s.requirePositiveEv ?? true,
      minConfidenceThreshold: s.minConfidenceThreshold ?? 50,
      loopIntervalSec: s.loopIntervalSec ?? 15,
      recoveryMode: s.recoveryMode ?? false,
      recoveryAutoMode: s.recoveryAutoMode ?? true,
      recoveryMethod: (s.recoveryMethod ?? "split") as "split" | "instant",
      recoveryMultiplier: s.recoveryMultiplier ?? 1.62,
      maxRecoverySteps: s.maxRecoverySteps ?? 3,
      normalContracts: normalizeStored(s.autonomousNormalContracts) ?? legacySet(legacyTypes, normalOver, normalUnder),
      recoveryContracts: normalizeStored(s.autonomousRecoveryContracts) ?? legacySet(legacyTypes, recOver, recUnder),
      normalOverDigit: normalOver,
      normalUnderDigit: normalUnder,
      recoveryOverDigit: recOver,
      recoveryUnderDigit: recUnder,
      tradeDurationSec: s.tradeDurationSec ?? 5,
      marketRotationAfter: settings.marketRotationAfter,
      autonomousEnabled: settings.autonomousEnabled,
      scanAllMarkets: s.scanAllMarkets ?? true,
      preferredCategories: s.preferredCategories?.length > 0 ? s.preferredCategories : ["synthetic"],
      allowedMarkets: s.allowedMarkets ?? [],
    });
  }, [settings]);

  const set = (key: string, val: unknown) => setForm((prev) => ({ ...prev, [key]: val }));

  const handleSave = () => {
    // Keep the legacy shared fields consistent with the sets the user picked.
    const types = [...new Set([...form.normalContracts, ...form.recoveryContracts].map((c) => CONTRACT_INFO[c.type].legacy))];
    const firstOver = form.normalContracts.find((c) => c.type === "DIGITOVER");
    const firstUnder = form.normalContracts.find((c) => c.type === "DIGITUNDER");
    const recOver = form.recoveryContracts.find((c) => c.type === "DIGITOVER");
    const recUnder = form.recoveryContracts.find((c) => c.type === "DIGITUNDER");
    const { normalContracts, recoveryContracts, ...rest } = form;
    const payload = {
      ...rest,
      preferredContractTypes: types,
      normalOverDigit: firstOver?.digit ?? form.normalOverDigit,
      normalUnderDigit: firstUnder?.digit ?? form.normalUnderDigit,
      recoveryOverDigit: recOver?.digit ?? form.recoveryOverDigit,
      recoveryUnderDigit: recUnder?.digit ?? form.recoveryUnderDigit,
      autonomousNormalContracts: normalContracts,
      autonomousRecoveryContracts: recoveryContracts,
    };
    updateSettings.mutate({ data: payload as any }, {
      onSuccess: (saved: any) => {
        // IMPORTANT: use the orval query key so the form does not revert to stale data.
        const settingsKey = getGetSettingsQueryKey();
        queryClient.setQueryData(settingsKey, saved);
        queryClient.invalidateQueries({ queryKey: settingsKey });
        queryClient.invalidateQueries({ queryKey: ["markets-top-signals"] });
        queryClient.invalidateQueries({ queryKey: ["markets", "ranked-all"] });
        queryClient.invalidateQueries({ queryKey: ["/api/markets/top"] });
        queryClient.invalidateQueries({ queryKey: ["getAiEngineStatus"] });
        toast.success("Settings saved");
      },
      onError: (err: any) => {
        toast.error(err?.data?.error || err?.message || "Failed to save settings");
      },
    });
  };

  if (isLoading) return <div className="p-8 text-muted-foreground text-sm animate-pulse">Loading settings…</div>;

  const exampleBaseStake = form.riskAmountType === "percentage" && account
    ? Math.max(0.35, Number(account.balance) * form.riskAmountValue / 100)
    : Math.max(0.35, form.riskAmountValue);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-3xl mx-auto space-y-5 pb-24">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Autonomous Engine Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm">Pick what the engine trades in normal mode and what it trades while recovering. Each set is independent.</p>
      </div>

      {account && (
        <div className="flex items-center gap-3 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
          <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
          <span className="text-sm text-green-400">Live on <span className="font-mono">{account.loginId}</span> — {account.currency} {Number(account.balance).toFixed(2)}</span>
        </div>
      )}

      {/* Contracts — normal */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Normal Contracts</CardTitle>
          <CardDescription className="text-xs">What the engine may trade when it is not recovering.</CardDescription>
        </CardHeader>
        <CardContent>
          <ContractSetEditor
            title="Normal"
            testId="normal-contracts"
            specs={form.normalContracts}
            onChange={(next) => set("normalContracts", next)}
            hint="Over and Under need a barrier (Over 0–8, Under 1–9). Matches and Differs can use a fixed digit or auto (the engine reads the tape). Even, Odd, Rise and Fall have no barrier."
          />
        </CardContent>
      </Card>

      {/* Contracts — recovery */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Contracts</CardTitle>
          <CardDescription className="text-xs">What the engine may trade while recovering a loss. This set is independent of the normal set — pick any mix.</CardDescription>
        </CardHeader>
        <CardContent>
          <ContractSetEditor
            title="Recovery"
            testId="recovery-contracts"
            specs={form.recoveryContracts}
            onChange={(next) => set("recoveryContracts", next)}
            hint="The engine ranks only the contracts you pick here. It does not switch contract types on its own during recovery."
          />
        </CardContent>
      </Card>

      {/* Stake & risk */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Stake &amp; Risk</CardTitle>
          <CardDescription className="text-xs">How much each normal trade risks.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Risk Profile" description="Affects the stake sizing multiplier.">
            <Select value={form.riskProfile} onValueChange={(v) => set("riskProfile", v)}>
              <SelectTrigger className="w-36 bg-secondary/50 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="conservative">Conservative</SelectItem>
                <SelectItem value="moderate">Moderate</SelectItem>
                <SelectItem value="aggressive">Aggressive</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label="Risk Amount Type" description="Fixed dollars or a percentage of balance.">
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
            description={form.riskAmountType === "fixed" ? "Dollar stake for a normal trade." : `Percent of balance (≈ $${exampleBaseStake.toFixed(2)} now).`}
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
          <SettingRow label="Max Stake Per Trade" description="Hard cap on any single trade, including recovery.">
            <NumInput value={form.maxTradeStake} onChange={(v) => set("maxTradeStake", v)} min={0.35} max={50000} step={0.5} suffix="$" />
          </SettingRow>
        </CardContent>
      </Card>

      {/* Recovery ladder */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recovery Ladder</CardTitle>
          <CardDescription className="text-xs">
            After a loss, the engine sizes the next stake to recover the outstanding debt. Recovery ends as soon as the debt is repaid. Optional target profit only sizes the stake and never keeps recovery active.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Enable Recovery Mode" description="Increase the stake after a loss to recover it.">
            <Switch checked={form.recoveryMode} onCheckedChange={(v) => set("recoveryMode", v)} />
          </SettingRow>

          {form.recoveryMode && (
            <>
              <div className="mt-3 mb-1">
                <div className="text-xs font-medium text-foreground mb-2">Recovery Calculator</div>
                <div className="flex rounded-lg overflow-hidden border border-border w-full">
                  <button
                    onClick={() => set("recoveryAutoMode", true)}
                    className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors ${form.recoveryAutoMode ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    Auto
                    <span className={`text-[10px] ${form.recoveryAutoMode ? "text-primary-foreground/80" : "text-muted-foreground"}`}>Engine computes the stake from the live payout</span>
                  </button>
                  <button
                    onClick={() => set("recoveryAutoMode", false)}
                    className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 text-xs font-medium transition-colors border-l border-border ${!form.recoveryAutoMode ? "bg-primary text-primary-foreground" : "bg-secondary/40 text-muted-foreground hover:text-foreground"}`}
                  >
                    Manual
                    <span className={`text-[10px] ${!form.recoveryAutoMode ? "text-primary-foreground/80" : "text-muted-foreground"}`}>Your own multiplier</span>
                  </button>
                </div>
              </div>

              <SettingRow
                label="Recovery Method"
                description={form.recoveryAutoMode
                  ? "Split caps each attempt at one normal base stake and carries the rest forward. Instant sizes one attempt to clear the debt in one win."
                  : "Split caps the manual ladder at the exact target. Instant uses the manual ladder directly."}
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
                  description={`Used as entered, compounding per recovery step: step 1 ×${form.recoveryMultiplier}, step 2 ×${Math.pow(form.recoveryMultiplier, 2).toFixed(2)}, step 3 ×${Math.pow(form.recoveryMultiplier, 3).toFixed(2)}.`}
                >
                  <NumInput value={form.recoveryMultiplier} onChange={(v) => set("recoveryMultiplier", v)} step={0.01} suffix="×" />
                </SettingRow>
              )}

              <SettingRow
                label="Max Recovery Steps"
                description={form.recoveryAutoMode
                  ? "Recovery-loss step the engine records. Auto stakes still come from live debt and payout."
                  : "Exponent limit for your manual multiplier. The multiplier stops compounding here."}
              >
                <NumInput value={form.maxRecoverySteps} onChange={(v) => set("maxRecoverySteps", v)} min={1} max={10} />
              </SettingRow>
            </>
          )}
        </CardContent>
      </Card>

      {/* Engine */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Engine</CardTitle>
          <CardDescription className="text-xs">When and how the engine trades.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Paper Trade Mode" description="Simulate every trade in the journal. No real orders are sent to Deriv.">
            <Switch checked={form.paperTradeMode} onCheckedChange={(v) => set("paperTradeMode", v)} />
          </SettingRow>
          <SettingRow label="Require Positive EV" description="Only trade when the expected value is positive.">
            <Switch checked={form.requirePositiveEv} onCheckedChange={(v) => set("requirePositiveEv", v)} />
          </SettingRow>
          <SettingRow label="Min Confidence" description="Minimum confidence (0–100) before a trade is placed.">
            <NumInput value={form.minConfidenceThreshold} onChange={(v) => set("minConfidenceThreshold", v)} min={30} max={95} step={1} suffix="%" />
          </SettingRow>
          <SettingRow label="Scan Interval" description="How often the engine scans markets when it is not reacting to ticks.">
            <NumInput value={form.loopIntervalSec} onChange={(v) => set("loopIntervalSec", v)} min={5} max={120} step={1} suffix="s" />
          </SettingRow>
          {form.paperTradeMode && (
            <div className="mt-2 p-2.5 bg-amber-500/5 border border-amber-500/20 rounded-lg text-[11px] text-amber-400">
              <strong>Paper Trade Mode is ON</strong> — no real orders will be sent to Deriv.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Daily limits */}
      <Card className="bg-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Daily Limits</CardTitle>
          <CardDescription className="text-xs">The engine stops when any of these is hit.</CardDescription>
        </CardHeader>
        <CardContent>
          <SettingRow label="Daily Profit Target" description="Stop once this profit is reached.">
            <NumInput value={form.dailyTarget} onChange={(v) => set("dailyTarget", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Daily Loss Limit" description="Stop if the day's loss reaches this.">
            <NumInput value={form.dailyLossLimit} onChange={(v) => set("dailyLossLimit", v)} min={1} max={100000} step={1} suffix="$" />
          </SettingRow>
          <SettingRow label="Max Drawdown" description="Stop if the portfolio drops by this percentage.">
            <NumInput value={form.maxDrawdown} onChange={(v) => set("maxDrawdown", v)} min={1} max={50} step={0.5} suffix="%" />
          </SettingRow>
          <SettingRow label="Consecutive Loss Limit" description="Pause after this many losses in a row.">
            <NumInput value={form.consecutiveLossLimit} onChange={(v) => set("consecutiveLossLimit", v)} min={1} max={20} />
          </SettingRow>
          <SettingRow label="Cooldown" description="Minutes before the engine resumes after a consecutive-loss stop.">
            <NumInput value={form.cooldownMinutes} onChange={(v) => set("cooldownMinutes", v)} min={1} max={1440} step={5} suffix="min" />
          </SettingRow>
        </CardContent>
      </Card>

      <div className="flex justify-end pt-2">
        <Button onClick={handleSave} disabled={updateSettings.isPending || form.normalContracts.length === 0 || form.recoveryContracts.length === 0} className="w-full sm:w-48">
          {updateSettings.isPending ? "Saving…" : "Save Settings"}
        </Button>
      </div>
      {(form.normalContracts.length === 0 || form.recoveryContracts.length === 0) && (
        <p className="text-right text-[11px] text-amber-400">Each set needs at least one contract before you can save.</p>
      )}
    </motion.div>
  );
}
