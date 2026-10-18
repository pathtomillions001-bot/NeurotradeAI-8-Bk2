/**
 * Hedge Pair Forge — a separate Bot Arena DBot factory.
 *
 * The console only asks the API for a Blockly strategy and hands it to the
 * persistent embedded Builder. It has no bot executor, no trading API, and no
 * Run shortcut: trades can begin only after the user presses Builder Run.
 */

import { Fragment, useEffect, useState } from "react";
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
  /** Shared single-contract recovery markup, shown for comparison only. */
  markupPercent: number;
  /** What this bot ships: a pair risks two premiums at once. */
  pairMarkupPercent: number;
  pairRecoveryMultiplier: number;
  analysisWindow: number;
  maxAnalysisWindow: number;
  maxWatchMarkets: number;
  minRepresentableOffset: number;
  maxStake: number;
  currency: string;
}

interface RecoveryProjection {
  debt: number;
  markupPercent: number;
  target: number;
  assumedWinMultiplier: number;
  stakePerLeg: number;
  pairStake: number;
  netOnPairWin: number;
  residualAfterWin: number;
  pairsToClear: number;
  ladder: Array<{ step: number; debt: number; stakePerLeg: number; pairStake: number }>;
  capBinding: string;
  caveat: string;
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
  watchMarkets: string[];
  forceEntryAfter: number;
  recoveryProjection: RecoveryProjection;
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
  const [watchMarkets, setWatchMarkets] = useState<string[]>(["R_50"]);
  const [config, setConfig] = useState({
    stake: 1,
    upperOffset: 0.0001,
    lowerOffset: 0.0001,
    // Deriv's deep history, not the Builder's 1 000-tick ring: a one-minute pair
    // yields 8 non-overlapping samples from 500 ticks and can never be measured.
    analysisWindow: 4999,
    minSamples: 80,
    // 0% = break-even. The runtime enforces this hurdle, so it must not start at
    // a number nobody chose.
    requiredEdgePct: 0,
    // Ceiling on the per-leg ladder. 1.62 would clamp a $2 debt's $1.96 size.
    recoveryMultiplier: 2.43,
    maxRecoverySteps: 3,
    takeProfit: 10,
    stopLoss: 5,
    maxConsecutiveDoubleLosses: 6,
    entryConfirmations: 2,
    recoveryConfirmations: 3,
    /** Patience valve, seconds. 0 = never force a negative-EV entry. */
    forceEntryAfter: 0,
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
    // One quote pip, and never below what the Builder's number field can store:
    // the field carries 8 decimals now, so 0.0001 survives the round trip. It
    // used to declare 0.01 precision, Blockly rounded 0.0001 to 0, and all five
    // price-barrier families held forever on "offsets must both be positive".
    const floor = Number(options?.minRepresentableOffset ?? 1e-8);
    const onePip = Math.max(floor, Number((10 ** -precision).toPrecision(8)));
    setConfig(current => ({ ...current, upperOffset: onePip, lowerOffset: onePip }));
  }, [barrierOffsetsCustomized, options, symbol]);

  /** The seed market is always watched; the rest are the ranking candidates. */
  useEffect(() => {
    setWatchMarkets(current => (current.includes(symbol) ? current : [symbol, ...current]));
  }, [symbol]);

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
  const sharedMarkupPercent = options?.markupPercent ?? 10;
  const pairMarkupPercent = options?.pairMarkupPercent ?? 40;
  const maxWatchMarkets = options?.maxWatchMarkets ?? 8;
  const maxAnalysisWindow = options?.maxAnalysisWindow ?? 5000;

  /**
   * Same arithmetic the runtime uses, projected at the configured ladder ceiling
   * because no live payout exists in this panel. The server returns the
   * authoritative projection with the build; this is only the pre-build preview.
   */
  const previewProjection = (() => {
    const debt = Number((Math.max(0.35, config.stake) * 2).toFixed(2));
    const target = debt * (1 + pairMarkupPercent / 100);
    const m = Math.max(1.01, config.recoveryMultiplier);
    const cap = Math.max(0.35, config.stake) * m;
    const exact = m > 1 ? target / (m - 1) : Infinity;
    const stakePerLeg = Math.max(0.35, Math.ceil((Math.min(exact, cap, maxStake) - 1e-10) * 100) / 100);
    const netOnPairWin = Number((stakePerLeg * (m - 2)).toFixed(2));
    let remaining = debt;
    let pairsToClear = 0;
    while (remaining > 0.005 && pairsToClear < 40 && netOnPairWin > 0) {
      const owed = remaining;
      const sized = Math.max(0.35, Math.ceil((Math.min(owed * (1 + pairMarkupPercent / 100) / (m - 1), cap, maxStake) - 1e-10) * 100) / 100);
      const net = sized * (m - 2);
      if (net <= 0) break;
      remaining = Math.max(0, remaining - net);
      pairsToClear += 1;
    }
    return {
      debt, target, assumedWinMultiplier: m, stakePerLeg,
      pairStake: Number((stakePerLeg * 2).toFixed(2)),
      netOnPairWin,
      residualAfterWin: Number(Math.max(0, debt - netOnPairWin).toFixed(2)),
      pairsToClear: remaining > 0.005 ? 0 : pairsToClear,
      capBinding: exact > cap + 1e-9 ? "ladder ceiling" : "none",
    };
  })();
  const projection: RecoveryProjection | null = lastBuild?.summary?.recoveryProjection ?? null;

  const createDbot = async () => {
    if (config.stake < 0.35 || config.stake > maxStake) {
      toast.error(`Each leg must be at least 0.35 and cannot exceed your ${currency} ${maxStake} max-stake setting.`);
      return;
    }
    if (watchMarkets.length > maxWatchMarkets) {
      toast.error(`Watch at most ${maxWatchMarkets} markets — Deriv's request budget, not a preference.`);
      return;
    }
    if (usesPriceBarriers && (config.upperOffset < 1e-8 || config.lowerOffset < 1e-8)) {
      toast.error("Both barrier offsets must be positive and at least 0.00000001 price units.");
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
          watchMarkets: watchMarkets.join(","),
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

                <div className="rounded-lg border border-white/5 bg-black/25 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
                      Markets to watch &amp; rank ({watchMarkets.length}/{maxWatchMarkets})
                    </p>
                    {watchMarkets.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setWatchMarkets([symbol])}
                        className="text-[9px] text-muted-foreground/70 hover:text-white"
                      >
                        reset to {symbol}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-1 max-h-28 overflow-y-auto pr-1">
                    {markets.map(market => {
                      const isSeed = market.symbol === symbol;
                      const checked = isSeed || watchMarkets.includes(market.symbol);
                      const full = !checked && watchMarkets.length >= maxWatchMarkets;
                      return (
                        <label
                          key={market.symbol}
                          className={`flex items-center gap-1.5 text-[10px] font-mono ${isSeed ? "text-white/85" : full ? "text-muted-foreground/35" : "text-muted-foreground"} ${full ? "cursor-not-allowed" : "cursor-pointer"}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={isSeed || full}
                            onChange={event => setWatchMarkets(current => event.target.checked
                              ? (current.includes(market.symbol) ? current : [...current, market.symbol])
                              : current.filter(entry => entry !== market.symbol))}
                            className="w-3 h-3 accent-current"
                          />
                          {market.symbol}
                        </label>
                      );
                    })}
                  </div>
                  <p className="text-[9px] text-muted-foreground/55 leading-snug">
                    {watchMarkets.length > 1
                      ? `The bot replays this pair on every market listed, ranks them on measured evidence — repayment rate, estimate stability, entry timing and sample confidence, never on assumed payouts — and switches between contracts when one leads by at least 1 point (2 in recovery), after 60 evaluations on the current market and 120 since the last switch. Only the winner is quoted live before a buy.`
                      : `Only ${symbol} is watched, so no market-to-market switching can happen. Add markets to let the bot rotate to wherever this pair measures best.`}
                  </p>
                </div>
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
                      max={maxAnalysisWindow}
                      step={250}
                      suffix="ticks"
                      accent={accent}
                      hint={`Deriv returns up to 4,999 ticks of deep history in one call (5,000 is rejected), cached per market for a minute. Replay is non-overlapping, so one observation costs the pair's whole duration: a 60-tick pair yields 16 samples from 500 ticks and 83 from 4,999. Below a hard floor of 20 the bot holds and names that arithmetic in the Journal instead of quietly lowering the bar.`}
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
                      label="Required joint EV (0 = break-even)"
                      value={config.requiredEdgePct}
                      onChange={requiredEdgePct => setConfig(current => ({ ...current, requiredEdgePct }))}
                      min={0}
                      max={50}
                      step={0.1}
                      suffix="%"
                      accent={accent}
                      hint="Measured per combined pair stake from both live proposal multipliers and the replayed joint win/loss states. The 95% lower bound, estimate instability across windows and the entry-timing score are reported alongside it in the Journal. Too few paired samples, a tape where every replayed pair lost both legs, an unstable estimate and entry timing are HARD blockers and are never overridden."
                    />
                    <NumInput
                      label="Force entry after (0 = never)"
                      value={config.forceEntryAfter}
                      onChange={forceEntryAfter => setConfig(current => ({ ...current, forceEntryAfter }))}
                      min={0}
                      max={3600}
                      step={30}
                      suffix="sec"
                      accent={accent}
                      hint="Patience valve. After this many seconds of holding against a NEGATIVE measured EV, the bot enters anyway and labels the entry in the Journal. It never overrides a hard blocker and recovery never uses it. Off by default: the bot would rather keep explaining itself than buy a losing pair on a timer."
                    />
                    <NumInput
                      label="Recovery ladder ceiling"
                      value={config.recoveryMultiplier}
                      onChange={recoveryMultiplier => setConfig(current => ({ ...current, recoveryMultiplier }))}
                      min={1.01}
                      max={5}
                      step={0.01}
                      accent={accent}
                      hint="A CEILING on each recovery leg (base × ceiling^step), never the size — the size comes from the debt. At the old 1.62 the ceiling clamps a $2.00 debt's $1.96 leg to $1.62 and the Journal says so; 2.43 leaves the debt-driven size room. It creates no win probability and guarantees nothing."
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
                    <Readout label="Pair recovery markup (this bot)" value={`${pairMarkupPercent}%`} accent={accent} />
                    <Readout label="Shared single-contract markup" value={`${sharedMarkupPercent}% (not used here)`} accent={accent} />
                    <Readout label="Max stake / leg" value={`${currency} ${maxStake}`} accent={accent} />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery &amp; payout arithmetic
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  Net pair P&amp;L is return₁ + return₂ − stake₁ − stake₂. A winning leg does not guarantee that the pair is profitable. Recovery arms only after <b className="text-white/80">both legs lose</b>, adding <b className="text-white/80">both</b> actual lost premiums to debt — {currency} {config.stake.toFixed(2)} a leg is {currency} {(config.stake * 2).toFixed(2)} of debt, not {currency} {config.stake.toFixed(2)}. A split never arms or advances recovery, but it no longer disarms an outstanding debt either: recovery stays armed and sizes the residual until the debt is actually zero.
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  Per-leg stake = debt × (1 + {pairMarkupPercent}%) ÷ (winning-leg payout − 1), using the <b className="text-white/80">poorer</b> of the two live legs, then capped by base × {config.recoveryMultiplier.toFixed(2)}^step, {currency} {maxStake} max stake and half the balance, and floored at {currency} 0.35. The pair spends two premiums, so one split win nets stake × (payout − 2) and does <b className="text-white/80">not</b> clear the debt — the ledger carries the residual. Sizing refuses to trade when the live winning leg pays 2.00× or less, because no split could then shrink the debt. It can still lose; there is no guaranteed edge or debt recovery.
                </p>
                <div className="rounded-lg border border-white/5 bg-black/30 px-2 py-1.5 space-y-1">
                  <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
                    Projected at a {(projection?.assumedWinMultiplier ?? previewProjection.assumedWinMultiplier).toFixed(2)}× winning leg
                    {projection ? " (server, from your build)" : " (this bot's ladder ceiling — no live payout exists here)"}
                  </p>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px] font-mono">
                    <span className="text-muted-foreground/70">One pair's debt</span>
                    <span className={`text-right ${a.text}`}>{currency} {(projection?.debt ?? previewProjection.debt).toFixed(2)}</span>
                    <span className="text-muted-foreground/70">× (1 + markup)</span>
                    <span className={`text-right ${a.text}`}>{currency} {(projection?.target ?? previewProjection.target).toFixed(2)} target</span>
                    <span className="text-muted-foreground/70">÷ (payout − 1) → per leg</span>
                    <span className={`text-right ${a.text}`}>{currency} {(projection?.stakePerLeg ?? previewProjection.stakePerLeg).toFixed(2)}</span>
                    <span className="text-muted-foreground/70">At risk that pair</span>
                    <span className={`text-right ${a.text}`}>{currency} ${(projection?.pairStake ?? previewProjection.pairStake).toFixed(2)}</span>
                    <span className="text-muted-foreground/70">A split win nets</span>
                    <span className={`text-right ${(projection?.netOnPairWin ?? previewProjection.netOnPairWin) > 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      {(projection?.netOnPairWin ?? previewProjection.netOnPairWin) >= 0 ? "+" : "−"}{currency} {Math.abs(projection?.netOnPairWin ?? previewProjection.netOnPairWin).toFixed(2)}
                    </span>
                    <span className="text-muted-foreground/70">Still owed after it</span>
                    <span className={`text-right ${a.text}`}>{currency} ${(projection?.residualAfterWin ?? previewProjection.residualAfterWin).toFixed(2)}</span>
                    <span className="text-muted-foreground/70">Split wins to clear</span>
                    <span className={`text-right ${a.text}`}>
                      {(projection?.pairsToClear ?? previewProjection.pairsToClear) > 0
                        ? `${projection?.pairsToClear ?? previewProjection.pairsToClear}`
                        : "impossible at this payout"}
                    </span>
                  </div>
                  {(projection?.ladder ?? []).length > 0 && (
                    <div className="pt-1 border-t border-white/5">
                      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">If another double loss lands mid-recovery</p>
                      <div className="grid grid-cols-3 gap-x-2 text-[9px] font-mono text-muted-foreground/80 pt-0.5">
                        <span>step</span><span className="text-right">debt</span><span className="text-right">per leg</span>
                        {(projection?.ladder ?? []).map(rung => (
                          <Fragment key={rung.step}>
                            <span>{rung.step}</span>
                            <span className="text-right">{currency} {rung.debt.toFixed(2)}</span>
                            <span className={`text-right ${a.text}`}>{currency} {rung.stakePerLeg.toFixed(2)}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}
                  {(projection?.capBinding ?? previewProjection.capBinding) !== "none" && (
                    <p className="text-[9px] text-amber-300/85 leading-snug">
                      Clamped by the {(projection?.capBinding ?? previewProjection.capBinding)} — raise the ladder ceiling if you want the debt-driven size to stand.
                    </p>
                  )}
                  {projection && <p className="text-[9px] text-muted-foreground/55 leading-snug">{projection.caveat}</p>}
                </div>
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
                  <Readout label="Required joint EV" value={`${(lastBuild.summary.requiredEdge * 100).toFixed(2)}% per combined stake`} accent={accent} />
                  <Readout label="Family" value={lastBuild.summary.pair} accent={accent} />
                  <Readout label="Analysis tape" value={`${lastBuild.summary.analysisWindow} ticks deep history`} accent={accent} />
                  <Readout label="Markets watched" value={lastBuild.summary.watchMarkets.length > 1
                    ? `${lastBuild.summary.watchMarkets.length} · ${lastBuild.summary.watchMarkets.join(", ")}`
                    : `${lastBuild.summary.watchMarkets[0] ?? lastBuild.summary.symbol} only · no switching`} accent={accent} />
                  <Readout label="Recovery markup" value={`${lastBuild.summary.markupPercent}% (pair-local)`} accent={accent} />
                  <Readout label="Patience valve" value={lastBuild.summary.forceEntryAfter > 0
                    ? `forces entry after ${lastBuild.summary.forceEntryAfter}s`
                    : "off · never forces a negative-EV entry"} accent={accent} />
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
