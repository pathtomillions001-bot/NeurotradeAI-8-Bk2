/**
 * Hedge Pair Forge — a separate Bot Arena DBot factory.
 *
 * The console only asks the API for a Blockly strategy and hands it to the
 * persistent embedded Builder. It has no bot executor, no trading API, and no
 * Run shortcut: trades can begin only after the user presses Builder Run.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  AlertTriangle, ArrowLeftRight, ChevronDown, ChevronRight, GitMerge,
  Hammer, Loader2, ShieldCheck, X,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { AccentKey, BotCardData, BotSessionStatus } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

interface HedgePairOptions {
  markets: Array<{ symbol: string; displayName: string; pipSize: number; digitEnabled: boolean }>;
  markupPercent: number;
  maxStake: number;
  currency: string;
}

interface HedgePairSummary {
  symbol: string;
  displayName: string;
  family: string;
  pair: string;
  contracts: [string, string];
  perLegStake: number;
  basePairExposure: number;
  targetDurationTicks: number;
  analysisWindow: number;
  minSamples: number;
  requiredEdge: number;
  recoveryMultiplier: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStakePerLeg: number;
  maxPairExposure: number;
  takeProfit: number;
  stopLoss: number;
  maxConsecutiveDoubleLosses: number;
  entryConfirmations: number;
  recoveryConfirmations: number;
  currency: string;
}

interface HedgePairBuild {
  name: string;
  xml: string;
  summary: HedgePairSummary;
  warnings: string[];
}

const FAMILIES = [
  { id: "DIGIT_OVERUNDER", label: "Over 5 / Under 4", type: "Digits", confirmations: 2, recoveryConfirmations: 3, note: "Both lose on 4 or 5. Other digits win exactly one leg." },
  { id: "ONLY_UPS_DOWNS", label: "Only Ups / Only Downs", type: "Runs", confirmations: 3, recoveryConfirmations: 4, note: "Every successive tick must move strictly one way; a flat or reversal loses that leg." },
  { id: "HIGHER_LOWER", label: "Higher / Lower", type: "Higher/Lower", confirmations: 2, recoveryConfirmations: 3, note: "Deriv CALL/PUT proposals use separate upper/lower relative offsets; both lose inside the band or on either strict boundary." },
  { id: "TOUCH_UPPER_LOWER", label: "Touch upper / Touch lower", type: "Touch/No Touch", confirmations: 2, recoveryConfirmations: 3, note: "First-passage path contracts; a path can touch both barriers, so both legs may win." },
  { id: "NO_TOUCH_UPPER_LOWER", label: "No Touch upper / No Touch lower", type: "Touch/No Touch", confirmations: 3, recoveryConfirmations: 4, note: "Both legs can win if neither barrier is touched; path and duration matter." },
  { id: "ENDS_BETWEEN_OUTSIDE", label: "Ends Between / Ends Outside", type: "Ends Between/Outside", confirmations: 2, recoveryConfirmations: 3, note: "Strict boundary equality can make both legs lose." },
  { id: "STAYS_BETWEEN_OUTSIDE", label: "Stays Between / Goes Outside", type: "Stays Between/Goes Outside", confirmations: 3, recoveryConfirmations: 4, note: "The full path is tested; touching either boundary ends the stays contract." },
] as const;

const PRICE_BARRIER_FAMILIES = new Set([
  "HIGHER_LOWER",
  "TOUCH_UPPER_LOWER",
  "NO_TOUCH_UPPER_LOWER",
  "ENDS_BETWEEN_OUTSIDE",
  "STAYS_BETWEEN_OUTSIDE",
]);

function NumInput({ label, value, onChange, min, max, step = 1, suffix, accent, hint }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  accent: AccentKey;
  hint?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground flex-1">{label}</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={event => onChange(Number(event.target.value))}
            className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
          />
          {suffix && <span className="text-[10px] text-muted-foreground min-w-8">{suffix}</span>}
        </div>
      </div>
      {hint && <p className="text-[9px] text-muted-foreground/55 leading-snug">{hint}</p>}
    </div>
  );
}

function Readout({ label, value, accent }: { label: string; value: string; accent: AccentKey }) {
  const a = ACCENTS[accent];
  return (
    <div className="rounded-lg border border-white/5 bg-black/25 px-2.5 py-2">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">{label}</p>
      <p className={`text-xs font-mono font-bold ${a.text}`}>{value}</p>
    </div>
  );
}

export function HedgePairForgeConsole({
  bot, open, onOpenChange,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [, navigate] = useLocation();
  const [options, setOptions] = useState<HedgePairOptions | null>(null);
  const [building, setBuilding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastBuild, setLastBuild] = useState<HedgePairBuild | null>(null);
  const [symbol, setSymbol] = useState("R_50");
  const [family, setFamily] = useState<(typeof FAMILIES)[number]["id"]>("DIGIT_OVERUNDER");
  const [barrierOffsetsCustomized, setBarrierOffsetsCustomized] = useState(false);
  const [config, setConfig] = useState({
    stake: 1,
    upperOffset: 0.0001,
    lowerOffset: 0.0001,
    analysisWindow: 500,
    minSamples: 80,
    requiredEdgePct: 1,
    recoveryMultiplier: 1.62,
    maxRecoverySteps: 3,
    takeProfit: 10,
    stopLoss: 5,
    maxConsecutiveDoubleLosses: 6,
    entryConfirmations: 2,
    recoveryConfirmations: 3,
  });

  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    fetch("/api/bots/hedge-pair/options")
      .then(response => response.json())
      .then((data: HedgePairOptions) => {
        if (!cancelled && Array.isArray(data?.markets)) {
          setOptions(data);
          if (data.markets.length && !data.markets.some(market => market.symbol === symbol)) {
            setSymbol(data.markets[0]!.symbol);
          }
        }
      })
      .catch(() => { /* the API error is shown on Create DBot; never trade from this panel */ });
    return () => { cancelled = true; };
  }, [open, options, symbol]);

  useEffect(() => {
    if (barrierOffsetsCustomized) return;
    const selected = options?.markets.find(market => market.symbol === symbol);
    if (!selected) return;
    const precision = Math.max(0, Math.min(8, Math.trunc(Number(selected.pipSize) || 0)));
    const onePip = Number((10 ** -precision).toPrecision(8));
    setConfig(current => ({ ...current, upperOffset: onePip, lowerOffset: onePip }));
  }, [barrierOffsetsCustomized, options, symbol]);

  if (!bot) return null;
  const accent = bot.accent;
  const a = ACCENTS[accent];
  const Icon = BOT_ICON[bot.icon] ?? GitMerge;
  const markets = options?.markets ?? SCAN_MARKETS.map(market => ({
    symbol: market.symbol,
    displayName: market.name,
    pipSize: 2,
    digitEnabled: true,
  }));
  const selectedMarket = markets.find(market => market.symbol === symbol);
  const barrierPrecision = Math.max(0, Math.min(8, Math.trunc(Number(selectedMarket?.pipSize) || 2)));
  const barrierStep = Number((10 ** -barrierPrecision).toPrecision(8));
  const selectedFamily = FAMILIES.find(item => item.id === family) ?? FAMILIES[0];
  const usesPriceBarriers = PRICE_BARRIER_FAMILIES.has(family);
  const currency = options?.currency ?? "USD";
  const maxStake = options?.maxStake ?? 500;
  const markupPercent = options?.markupPercent ?? 10;

  const createDbot = async () => {
    if (config.stake < 0.35 || config.stake > maxStake) {
      toast.error(`Each leg must be at least 0.35 and cannot exceed your ${currency} ${maxStake} max-stake setting.`);
      return;
    }
    setBuilding(true);
    try {
      const response = await fetch("/api/bots/hedge-pair/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          family,
          ...config,
          requiredEdge: config.requiredEdgePct / 100,
        }),
      });
      const data = await response.json() as HedgePairBuild & { error?: string };
      if (!response.ok || !data?.xml) {
        toast.error(data?.error ?? "Could not build the hedge-pair DBot");
        return;
      }
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol });
      setLastBuild(data);
      toast.info(`Loading ${selectedFamily.label} into the Bot Builder…`);
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        toast.success(
          `DBot loaded for ${selectedMarket?.displayName ?? symbol} · ${selectedFamily.label} · ` +
          `${currency} ${config.stake.toFixed(2)} each (${currency} ${(config.stake * 2).toFixed(2)} pair exposure). ` +
          `Review its blocks, then press Run in the Builder.`,
          { duration: 14000 },
        );
      } else {
        toast.error("Builder did not acknowledge the strategy. Reopen Bot Builder and create it again.");
      }
    } catch {
      toast.error("Could not reach Hedge Pair Forge to build the DBot");
    } finally {
      setBuilding(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label="Hedge Pair Forge console"
            className={`fixed bottom-20 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            <div className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}>
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}>{bot.code}</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{bot.tagline}</p>
                </div>
              </div>
              <button onClick={() => onOpenChange(false)} aria-label="Close console" className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                  <Hammer className="w-3 h-3" /> Builds only — no trades from this console
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Create DBot loads a strategy into the embedded Deriv Builder. It does not buy contracts.
                  The generated bot starts trading only when you press that Builder’s <b className="text-white/80">Run</b> button.
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Market & pair</p>
                <select
                  value={symbol}
                  onChange={event => setSymbol(event.target.value)}
                  aria-label="Market"
                  className={`w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2 text-xs text-white focus:outline-none ${a.focusBorder}`}
                >
                  {markets.map(market => <option key={market.symbol} value={market.symbol}>{market.displayName} ({market.symbol})</option>)}
                </select>
                <select
                  value={family}
                  onChange={event => {
                    const nextFamily = event.target.value as typeof family;
                    const timing = FAMILIES.find(item => item.id === nextFamily) ?? FAMILIES[0];
                    setFamily(nextFamily);
                    setConfig(current => ({
                      ...current,
                      entryConfirmations: timing.confirmations,
                      recoveryConfirmations: timing.recoveryConfirmations,
                    }));
                  }}
                  aria-label="Hedge pair family"
                  className={`w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2 text-xs text-white focus:outline-none ${a.focusBorder}`}
                >
                  {FAMILIES.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <p className="text-[9px] text-muted-foreground/65 leading-snug">{selectedFamily.note}</p>
              </div>

              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Pair exposure & stop limits</p>
                <NumInput
                  label="Stake per leg"
                  value={config.stake}
                  onChange={stake => setConfig(current => ({ ...current, stake }))}
                  min={0.35}
                  max={maxStake}
                  step={0.05}
                  suffix={currency}
                  accent={accent}
                  hint={`Pair exposure is ${currency} ${(Math.max(0, config.stake) * 2).toFixed(2)} before settlement. Each leg is capped at ${currency} ${maxStake}.`}
                />
                <NumInput
                  label="Take profit"
                  value={config.takeProfit}
                  onChange={takeProfit => setConfig(current => ({ ...current, takeProfit }))}
                  min={0.01}
                  step={1}
                  suffix={currency}
                  accent={accent}
                />
                <NumInput
                  label="Stop loss"
                  value={config.stopLoss}
                  onChange={stopLoss => setConfig(current => ({ ...current, stopLoss }))}
                  min={0.01}
                  step={1}
                  suffix={currency}
                  accent={accent}
                />
                <NumInput
                  label="Double-loss breaker"
                  value={config.maxConsecutiveDoubleLosses}
                  onChange={maxConsecutiveDoubleLosses => setConfig(current => ({ ...current, maxConsecutiveDoubleLosses }))}
                  min={1}
                  max={20}
                  step={1}
                  accent={accent}
                  hint="Stops after this many consecutive pairs where both legs lose. A split outcome resets this breaker and never triggers recovery."
                />
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(value => !value)}
                  className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-white"
                >
                  {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Analysis, timing & recovery
                </button>
                {showAdvanced && (
                  <div className="space-y-2 pl-1">
                    <div className="rounded-lg border border-white/5 bg-black/25 px-2.5 py-2">
                      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">Duration policy</p>
                      <p className={`text-xs font-mono font-bold ${a.text}`}>1 tick target · live minimum if needed</p>
                      <p className="text-[9px] text-muted-foreground/55 leading-snug">The Builder checks each exact contract/barrier range. It keeps one tick when supported; otherwise it raises both legs only to the shortest common duration in Deriv’s live metadata, then validates both proposals.</p>
                    </div>
                    {usesPriceBarriers && (
                      <>
                        <NumInput
                          label="Upper barrier offset"
                          value={config.upperOffset}
                          onChange={upperOffset => {
                            setBarrierOffsetsCustomized(true);
                            setConfig(current => ({ ...current, upperOffset }));
                          }}
                          min={barrierStep}
                          max={100000}
                          step={barrierStep}
                          suffix="price"
                          accent={accent}
                          hint={`Entry-relative price units; defaults to one quote pip (${barrierStep}). Deriv’s proposal response is the final validity check.`}
                        />
                        <NumInput
                          label="Lower barrier offset"
                          value={config.lowerOffset}
                          onChange={lowerOffset => {
                            setBarrierOffsetsCustomized(true);
                            setConfig(current => ({ ...current, lowerOffset }));
                          }}
                          min={barrierStep}
                          max={100000}
                          step={barrierStep}
                          suffix="price"
                          accent={accent}
                        />
                      </>
                    )}
                    <NumInput
                      label="Analysis tape"
                      value={config.analysisWindow}
                      onChange={analysisWindow => setConfig(current => ({ ...current, analysisWindow }))}
                      min={100}
                      max={1000}
                      step={25}
                      suffix="ticks"
                      accent={accent}
                      hint="At most 1,000 Builder ticks are cached. Longer pair durations yield fewer complete, non-overlapping historical outcomes."
                    />
                    <NumInput
                      label="Minimum complete pairs"
                      value={config.minSamples}
                      onChange={minSamples => setConfig(current => ({ ...current, minSamples }))}
                      min={20}
                      max={1000}
                      step={10}
                      suffix="pairs"
                      accent={accent}
                    />
                    <NumInput
                      label="Entry confirmations"
                      value={config.entryConfirmations}
                      onChange={entryConfirmations => setConfig(current => ({ ...current, entryConfirmations }))}
                      min={selectedFamily.confirmations}
                      max={12}
                      step={1}
                      suffix="fresh ticks"
                      accent={accent}
                      hint={`Family floor is ${selectedFamily.confirmations}; the generated Builder enforces it even if the block is edited manually.`}
                    />
                    <NumInput
                      label="Recovery confirmations"
                      value={config.recoveryConfirmations}
                      onChange={recoveryConfirmations => setConfig(current => ({ ...current, recoveryConfirmations }))}
                      min={selectedFamily.recoveryConfirmations}
                      max={12}
                      step={1}
                      suffix="fresh ticks"
                      accent={accent}
                      hint={`Recovery floor is ${selectedFamily.recoveryConfirmations}; recovery scans wait longer than normal entries by family.`}
                    />
                    <NumInput
                      label="Required 95% joint EV lower bound"
                      value={config.requiredEdgePct}
                      onChange={requiredEdgePct => setConfig(current => ({ ...current, requiredEdgePct }))}
                      min={0}
                      max={50}
                      step={0.1}
                      suffix="%"
                      accent={accent}
                      hint="Measured per combined pair stake using both live proposal total-return multipliers. HAC uncertainty, a zero-edge prior, sample minimums, recent-vs-old instability and current family context must all pass."
                    />
                    <NumInput
                      label="Fallback ladder multiplier"
                      value={config.recoveryMultiplier}
                      onChange={recoveryMultiplier => setConfig(current => ({ ...current, recoveryMultiplier }))}
                      min={1.01}
                      max={5}
                      step={0.01}
                      accent={accent}
                      hint="Used as the baseline ladder; recovery sizes to debt + markup from the live joint 95% EV lower bound and may require a higher multiplier. Max-stake and balance caps remain absolute; if they prevent the target, the bot holds."
                    />
                    <NumInput
                      label="Maximum recovery steps"
                      value={config.maxRecoverySteps}
                      onChange={maxRecoverySteps => setConfig(current => ({ ...current, maxRecoverySteps }))}
                      min={1}
                      max={10}
                      step={1}
                      accent={accent}
                    />
                    <Readout label="Risk Management markup" value={`${markupPercent}%`} accent={accent} />
                    <Readout label="Max stake / leg" value={`${currency} ${maxStake}`} accent={accent} />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery & payout arithmetic
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  Net pair P&amp;L is return₁ + return₂ − stake₁ − stake₂. A winning leg does not guarantee that the pair is profitable. Recovery arms only after <b className="text-white/80">both legs lose</b>, adding both actual lost stakes to debt. A split never arms or advances recovery—even with negative combined P&amp;L—though its actual aggregate result is recorded.
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  Final sizing needs positive measured joint EV at live payouts and is capped by the configured ladder, per-leg max stake and half the current balance. It can still lose; there is no guaranteed edge or debt recovery.
                </p>
              </div>

              <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                  <ArrowLeftRight className="w-3 h-3" /> Two contracts are not an atomic hedge
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  The Builder sends both proposal-backed buys concurrently, but Deriv can accept only one. The generated bot attempts an early close on a partial fill where possible, monitors any remaining position to settlement, and halts new entries. No exact simultaneity is claimed.
                </p>
              </div>

              {lastBuild && (
                <div className="grid grid-cols-2 gap-1.5">
                  <Readout label="Last pair exposure" value={`${lastBuild.summary.currency} ${lastBuild.summary.basePairExposure.toFixed(2)}`} accent={accent} />
                  <Readout label="Target duration" value={`${lastBuild.summary.targetDurationTicks} tick(s) before metadata fallback`} accent={accent} />
                  <Readout label="Required joint EV LCB" value={`${(lastBuild.summary.requiredEdge * 100).toFixed(2)}%`} accent={accent} />
                  <Readout label="Family" value={lastBuild.summary.pair} accent={accent} />
                </div>
              )}

              <div className="flex items-start gap-1.5 text-[9px] text-muted-foreground/65 leading-snug">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px text-amber-400/80" />
                <span>The screen replays historical price paths using today’s live proposal return multipliers—not archived historical quotes—so it is not a validated backtest or forecast. Future prices, payouts, ties and execution can differ; no edge or profit is promised.</span>
              </div>

              <Button
                onClick={createDbot}
                disabled={building || !selectedMarket}
                data-testid="create-hedge-pair-dbot"
                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
              >
                {building
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Loading strategy…</>
                  : <><Hammer className="w-4 h-4 mr-2" /> Create DBot</>}
              </Button>
              <p className="text-[9px] text-center text-muted-foreground/55">
                Loads blocks into Bot Builder. It does not start trades; press Run in the Builder when ready.
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default HedgePairForgeConsole;
