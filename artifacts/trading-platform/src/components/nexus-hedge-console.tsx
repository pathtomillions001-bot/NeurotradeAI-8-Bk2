/**
 * Nexus Hedge Forge console — universal super-hedge DBot factory.
 *
 * Extends Omni Forge to Rise/Fall. User picks ANY mix of:
 * Over 0-8, Under 1-9, Even, Odd, Matches 0-9/auto, Differs 0-9/auto,
 * Rise, Fall — independent for normal and recovery (up to 8 each).
 * Multi-scale fusion + Dirichlet-10 conditional + phi/rho hedge score +
 * ladder utility + elastic Kelly + live payout re-quote inside the bot.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2, X, Target, Hammer, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronRight, Activity, Plus, Sparkles, GitBranch,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

type NexusContractType = "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD" | "DIGITMATCH" | "DIGITDIFF" | "CALL" | "PUT";
interface NexusSpec { type: NexusContractType; digit: number }

interface ContractTypeInfo {
  type: NexusContractType;
  label: string;
  digitLabel: string | null;
  digitMin: number | null;
  digitMax: number | null;
  allowsAuto: boolean;
  needsDigit: boolean;
  payout?: number;
}

interface NexusOptions {
  contractTypes: ContractTypeInfo[];
  overPayouts: Record<string, number>;
  underPayouts: Record<string, number>;
  markets: { symbol: string; displayName: string }[];
}

interface NexusSummary {
  symbol: string;
  displayName: string;
  normal: string[];
  recovery: string[];
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  breakerDepth: number;
  window: number;
  forceEntryAfter: number;
  watchMarkets: string[];
  ladder: { debtGrowthPerStep: number; capitalAtRisk: number; failureProbability: number };
}

const FALLBACK_TYPES: ContractTypeInfo[] = [
  { type: "DIGITOVER", label: "Digits Over", digitLabel: "Barrier", digitMin: 0, digitMax: 8, allowsAuto: false, needsDigit: true, payout: 1.95 },
  { type: "DIGITUNDER", label: "Digits Under", digitLabel: "Barrier", digitMin: 1, digitMax: 9, allowsAuto: false, needsDigit: true, payout: 1.95 },
  { type: "DIGITEVEN", label: "Even", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false, payout: 1.95 },
  { type: "DIGITODD", label: "Odd", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false, payout: 1.95 },
  { type: "DIGITMATCH", label: "Matches", digitLabel: "Digit", digitMin: 0, digitMax: 9, allowsAuto: true, needsDigit: false, payout: 8.93 },
  { type: "DIGITDIFF", label: "Differs", digitLabel: "Digit", digitMin: 0, digitMax: 9, allowsAuto: true, needsDigit: false, payout: 1.09 },
  { type: "CALL", label: "Rise", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false, payout: 1.92 },
  { type: "PUT", label: "Fall", digitLabel: null, digitMin: null, digitMax: null, allowsAuto: false, needsDigit: false, payout: 1.92 },
];

const SHORT_LABEL: Record<NexusContractType, string> = {
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
  CALL: "Rise",
  PUT: "Fall",
};

const TIGHT_HEADROOM = 0.015;
interface RareLegNote { label: string; payout: number; breakEven: number; naturalRate: number }

function rareLegNotes(specs: NexusSpec[], options: NexusOptions | null): RareLegNote[] {
  const over = options?.overPayouts ?? {};
  const under = options?.underPayouts ?? {};
  const typePayout = (t: NexusContractType, fallback: number) =>
    options?.contractTypes.find(ct => ct.type === t)?.payout ?? fallback;
  const notes: RareLegNote[] = [];
  for (const spec of specs) {
    // Rise/Fall are not rare-entry traps — skip them
    if (spec.type === "CALL" || spec.type === "PUT") continue;
    let payout: number;
    let naturalRate: number;
    switch (spec.type) {
      case "DIGITOVER": payout = Number(over[String(spec.digit)]) || 1.09; naturalRate = (9 - spec.digit) / 10; break;
      case "DIGITUNDER": payout = Number(under[String(spec.digit)]) || 1.09; naturalRate = spec.digit / 10; break;
      case "DIGITEVEN": case "DIGITODD": payout = typePayout(spec.type, 1.95); naturalRate = 0.5; break;
      case "DIGITMATCH": payout = typePayout("DIGITMATCH", 8.93); naturalRate = 0.1; break;
      case "DIGITDIFF": payout = typePayout("DIGITDIFF", 1.09); naturalRate = 0.9; break;
      default: continue;
    }
    const breakEven = 1 / payout;
    if (breakEven - naturalRate > TIGHT_HEADROOM) {
      notes.push({ label: specLabel(spec), payout, breakEven, naturalRate });
    }
  }
  return notes;
}

function specLabel(spec: NexusSpec): string {
  if (spec.type === "DIGITEVEN" || spec.type === "DIGITODD" || spec.type === "CALL" || spec.type === "PUT") {
    return SHORT_LABEL[spec.type];
  }
  if (spec.digit < 0) return `${SHORT_LABEL[spec.type]} auto`;
  return `${SHORT_LABEL[spec.type]} ${spec.digit}`;
}

function specKey(spec: NexusSpec): string {
  const needsDigit = spec.type === "DIGITOVER" || spec.type === "DIGITUNDER" || spec.type === "DIGITMATCH" || spec.type === "DIGITDIFF";
  return `${spec.type}:${needsDigit ? spec.digit : -1}`;
}

function hedgeOverlapNote(normal: NexusSpec[], recovery: NexusSpec[]): string | null {
  const nKeys = new Set(normal.map(specKey));
  const overlap = recovery.filter(s => nKeys.has(specKey(s)));
  if (overlap.length === 0) return null;
  return `Recovery reuses ${overlap.map(specLabel).join(", ")} — hedge ranker will de-weight correlated legs (phi/rho) and may favour anti-correlated pairs. Overlap is allowed but reduces HedgeScore.`;
}

function NumInput({ label: lbl, value, onChange, min, max, step = 1, suffix, accent, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; suffix?: string; accent: AccentKey; hint?: string;
}) {
  const a = ACCENTS[accent];
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground flex-1">{lbl}</span>
        <div className="flex items-center gap-1">
          <Input
            type="number" value={value} min={min} max={max} step={step}
            onChange={e => onChange(Number(e.target.value))}
            className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
          />
          {suffix && <span className="text-[10px] text-muted-foreground w-6">{suffix}</span>}
        </div>
      </div>
      {hint && <p className="text-[9px] text-muted-foreground/50 leading-snug">{hint}</p>}
    </div>
  );
}

function Stat({ label: lbl, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-black/25 rounded-lg px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">{lbl}</p>
      <p className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}>{value}</p>
    </div>
  );
}

function ContractSetEditor({ title, hint, specs, onChange, types, accent, testId }: {
  title: string;
  hint: string;
  specs: NexusSpec[];
  onChange: (next: NexusSpec[]) => void;
  types: ContractTypeInfo[];
  accent: AccentKey;
  testId: string;
}) {
  const a = ACCENTS[accent];
  const [pickType, setPickType] = useState<NexusContractType>("DIGITOVER");
  const [pickDigit, setPickDigit] = useState(1);
  const [autoDigit, setAutoDigit] = useState(true);

  const info = types.find(t => t.type === pickType) ?? FALLBACK_TYPES[0];
  const digitVisible = info.needsDigit || (info.allowsAuto && !autoDigit);

  const add = () => {
    if (specs.length >= 8) {
      toast.error("At most 8 contracts per set — the ranker needs candidates, not noise");
      return;
    }
    const digit =
      info.needsDigit ? pickDigit
      : info.allowsAuto ? (autoDigit ? -1 : pickDigit)
      : -1;
    if (digitVisible) {
      const min = info.digitMin ?? 0;
      const max = info.digitMax ?? 9;
      if (!Number.isInteger(digit) || digit < min || digit > max) {
        toast.error(`${info.label}: ${info.digitLabel ?? "digit"} must be ${min}–${max}`);
        return;
      }
    }
    const next: NexusSpec = { type: pickType, digit };
    if (specs.some(s => specKey(s) === specKey(next))) {
      toast.info(`${specLabel(next)} is already in the set`);
      return;
    }
    onChange([...specs, next]);
  };

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {specs.length === 0 && (
          <span className="text-[10px] text-amber-300/80">Add at least one contract</span>
        )}
        {specs.map(spec => (
          <span
            key={specKey(spec)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${a.panelBorder} ${a.panelBg} ${a.text}`}
          >
            {specLabel(spec)}
            <button
              type="button"
              aria-label={`Remove ${specLabel(spec)}`}
              onClick={() => onChange(specs.filter(s => specKey(s) !== specKey(spec)))}
              className="text-muted-foreground hover:text-white"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <select
          value={pickType}
          onChange={e => {
            const t = e.target.value as NexusContractType;
            setPickType(t);
            const ti = types.find(x => x.type === t);
            if (ti?.needsDigit) setPickDigit(ti.digitMin ?? 0);
          }}
          aria-label={`${title} contract type`}
          className={`flex-1 h-7 rounded-lg bg-black/30 border border-white/10 px-1.5 text-[11px] text-white focus:outline-none ${a.focusBorder}`}
        >
          {types.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        {info.allowsAuto && (
          <button
            type="button"
            onClick={() => setAutoDigit(v => !v)}
            aria-pressed={autoDigit}
            className={`h-7 px-2 rounded-lg border text-[10px] font-semibold ${autoDigit ? `${a.panelBorder} ${a.panelBg} ${a.text}` : "border-white/10 bg-black/20 text-muted-foreground"}`}
            title="Auto: the running bot picks the digit from the live tape (hottest for Matches, coldest for Differs)"
          >
            auto
          </button>
        )}
        {digitVisible && (
          <Input
            type="number"
            value={pickDigit}
            min={info.digitMin ?? 0}
            max={info.digitMax ?? 9}
            step={1}
            aria-label={`${title} ${info.digitLabel ?? "digit"}`}
            onChange={e => setPickDigit(Number(e.target.value))}
            className={`w-14 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
          />
        )}
        <button
          type="button"
          onClick={add}
          aria-label={`Add contract to ${title}`}
          className={`h-7 w-7 rounded-lg ${a.solidBtn} text-white flex items-center justify-center flex-shrink-0`}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <p className="text-[9px] text-muted-foreground/50 leading-snug">{hint}</p>
    </div>
  );
}

export function NexusHedgeConsole({
  bot, open, onOpenChange,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [, navigate] = useLocation();
  const [options, setOptions] = useState<NexusOptions | null>(null);
  const [building, setBuilding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastBuild, setLastBuild] = useState<NexusSummary | null>(null);
  const [forgeWarnings, setForgeWarnings] = useState<string[]>([]);

  const [symbol, setSymbol] = useState("R_50");
  const [normal, setNormal] = useState<NexusSpec[]>([
    { type: "DIGITOVER", digit: 1 },
    { type: "DIGITEVEN", digit: -1 },
  ]);
  const [recovery, setRecovery] = useState<NexusSpec[]>([
    { type: "DIGITUNDER", digit: 6 },
    { type: "CALL", digit: -1 },
  ]);
  const [config, setConfig] = useState({
    stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, breakerDepth: 6,
  });
  const [gate, setGate] = useState({ window: 120, forceEntryAfter: 0 });

  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    fetch("/api/bots/nexus-hedge/options")
      .then(r => r.json())
      .then(d => { if (!cancelled && d?.contractTypes) setOptions(d); })
      .catch(() => { /* fallback vocabulary */ });
    return () => { cancelled = true; };
  }, [open, options]);

  const types = options?.contractTypes ?? FALLBACK_TYPES;
  const markets = options?.markets ?? SCAN_MARKETS.map(m => ({ symbol: m.symbol, displayName: m.name }));
  const rareNormal = rareLegNotes(normal, options);
  const overlapNote = hedgeOverlapNote(normal, recovery);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Target;
  const marketName = markets.find(m => m.symbol === symbol)?.displayName ?? symbol;

  const handleCreateDbot = async () => {
    if (normal.length === 0 || recovery.length === 0) {
      toast.error("Choose at least one contract for normal trades AND one for recovery");
      return;
    }
    setBuilding(true);
    try {
      const res = await fetch("/api/bots/nexus-hedge/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          normal,
          recovery,
          watchMarkets: markets.map(m => m.symbol).slice(0, 8),
          ...config,
          ...gate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.xml) {
        toast.error(data?.error ?? "Could not forge the DBot strategy");
        return;
      }
      const loaded = loadStrategyIntoBotBuilder({ name: data.name, xml: data.xml, symbol });
      setLastBuild(data.summary ?? null);
      const apiWarnings: string[] = Array.isArray(data.warnings) ? data.warnings : [];
      setForgeWarnings(apiWarnings);
      toast.info(`Forging your hedge DBot for ${marketName}…`);
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        const s: NexusSummary | undefined = data.summary;
        toast.success(
          `DBot forged: ${marketName} · normal [${(s?.normal ?? normal.map(specLabel)).join(", ")}] → ` +
            `recovery [${(s?.recovery ?? recovery.map(specLabel)).join(", ")}] · ` +
            `stake $${config.stake} · TP $${config.takeProfit} · SL $${config.stopLoss}. ` +
            `Hedge-aware across ${s?.watchMarkets?.length ?? 8} markets — verify blocks, then press Run.`,
          { duration: 14_000 },
        );
        for (const w of apiWarnings.slice(0, 3)) {
          toast.warning(w, { duration: 16_000 });
        }
      } else {
        toast.error("The bot builder did not confirm the strategy loaded — open Bot Builder and press Create DBot again.");
      }
    } catch {
      toast.error("Could not reach the forge to build the DBot");
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
            aria-label="Nexus Hedge Forge console"
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
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
              <button onClick={() => onOpenChange(false)} aria-label="Close console"
                      className="text-muted-foreground hover:text-white p-1 flex-shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                  <GitBranch className="w-3 h-3" /> Universal hedge — your contracts, super-hedged
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Pick <span className="text-white/80 font-semibold">any</span> mix — Over, Under, Even/Odd, Matches/Differs, Rise/Fall — for normal and an independent mix for recovery (up to 8 each). The forged bot ranks every pair across up to eight markets with <span className="text-white/70">multi-scale fusion, Dirichlet-10 conditional, phi/rho HedgeScore</span> and ladder-aware utility, then sizes with an elastic Kelly cap and live payout re-quote. Nothing trades here.
                </p>
              </div>

              <ContractSetEditor
                title="Normal contracts"
                hint="At base stake, only when the tape's worst plausible win rate clears that contract's break-even. HedgeScore prices correlation with recovery legs."
                specs={normal}
                onChange={setNormal}
                types={types}
                accent={bot.accent}
                testId="nexus-hedge-normal-set"
              />

              {rareNormal.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-1" data-testid="rare-entry-hint">
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3" /> Rare-entry {rareNormal.length === 1 ? "leg" : "legs"} in normal
                  </p>
                  {rareNormal.map(r => (
                    <p key={r.label} className="text-[9px] text-muted-foreground leading-snug">
                      <span className="text-amber-200 font-semibold">{r.label}</span> pays {r.payout}× — break-even {(r.breakEven * 100).toFixed(1)}% vs {(r.naturalRate * 100).toFixed(0)}% natural, so the bot only buys it on hot tapes. It trades more freely in recovery (looser gate) or use <span className="text-white/70 font-semibold">Force entry after</span>.
                    </p>
                  ))}
                </div>
              )}

              <ContractSetEditor
                title="Recovery contracts"
                hint="After a loss the bot ranks THIS set on P(win | previous loss) — the state a recovery entry fires from — and sizes to clear debt. Hedge-aware: anti-correlated pairs (Over↔Under, Even↔Odd, Rise↔Fall) get a HedgeScore uplift."
                specs={recovery}
                onChange={setRecovery}
                types={types}
                accent={bot.accent}
                testId="nexus-hedge-recovery-set"
              />

              {overlapNote && (
                <div className="rounded-xl border border-sky-500/25 bg-sky-500/10 p-2.5" data-testid="hedge-overlap-hint">
                  <p className="text-[9px] text-sky-200/90 leading-snug flex items-start gap-1.5">
                    <GitBranch className="w-3 h-3 flex-shrink-0 mt-px" />
                    <span>{overlapNote}</span>
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Starting market</p>
                <select
                  value={symbol}
                  onChange={e => setSymbol(e.target.value)}
                  aria-label="Market"
                  className={`w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2 text-xs text-white focus:outline-none ${a.focusBorder}`}
                >
                  {markets.map(m => <option key={m.symbol} value={m.symbol}>{m.displayName}</option>)}
                </select>
              </div>

              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session boundaries</p>
                <NumInput label="Base stake" value={config.stake} onChange={v => setConfig(c => ({ ...c, stake: v }))} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                <NumInput label="Take profit" value={config.takeProfit} onChange={v => setConfig(c => ({ ...c, takeProfit: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Stop loss" value={config.stopLoss} onChange={v => setConfig(c => ({ ...c, stopLoss: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => setConfig(c => ({ ...c, maxRecoverySteps: v }))} min={1} max={10} step={1} accent={bot.accent}
                          hint="Debt ladder depth before returning to base stake." />
                <NumInput label="Circuit breaker" value={config.breakerDepth} onChange={v => setConfig(c => ({ ...c, breakerDepth: v }))} min={3} max={20} step={1} accent={bot.accent}
                          hint="Consecutive losses that halt the run." />
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-white"
                >
                  {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  Hedge engine
                </button>
                {showAdvanced && (
                  <div className="space-y-2 pl-1">
                    <NumInput label="Tick window" value={gate.window} onChange={v => setGate(g => ({ ...g, window: v }))} min={30} max={300} step={10} accent={bot.accent}
                              hint="Digits the running bot keeps per market. 30 is the gate minimum; longer steadies the estimate." />
                    <NumInput label="Force entry after" value={gate.forceEntryAfter} onChange={v => setGate(g => ({ ...g, forceEntryAfter: v }))} min={0} max={5000} step={1} accent={bot.accent}
                              hint="0 = infinite patience. Otherwise the highest-ranked hedge pair fires after this many refusals." />
                    <div className="rounded-lg border border-white/5 bg-black/20 p-2 space-y-1">
                      <p className="text-[9px] uppercase tracking-widest font-semibold text-muted-foreground">Inside the forged bot</p>
                      <p className="text-[9px] text-muted-foreground/70 leading-snug">
                        Multi-scale EW (half-life 60) + Dirichlet(α=10) posterior, Wilson 90% LCB vs break-even, two-state Markov G², clustering & instability penalties, phi/rho hedge, ladder ExpectedLogUtility, elastic Kelly cap (×1.5 on low HedgeScore), live payout re-quote, Page-Hinkley freeze.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery uses the app's own ladder
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  debt × (1 + markup) ÷ (payout − 1), floored at 0.35, capped by max stake and live balance, rounded to the cent — elastic cap widens when HedgeScore is high.
                </p>
              </div>

              {lastBuild && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                    <Activity className="w-3 h-3" /> Last forge
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Stat label="Capital at risk" value={`${lastBuild.ladder.capitalAtRisk.toFixed(1)}× stake`} tone="text-amber-300" />
                    <Stat label="Ladder failure odds" value={`${(lastBuild.ladder.failureProbability * 100).toFixed(1)}%`} />
                    <Stat label="Normal" value={lastBuild.normal.join(" · ")} />
                    <Stat label="Recovery" value={lastBuild.recovery.join(" · ")} />
                  </div>
                  {forgeWarnings.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-white/5">
                      {forgeWarnings.map(w => (
                        <p key={w} className="text-[9px] text-amber-300/90 leading-snug flex items-start gap-1">
                          <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 mt-px" />
                          <span>{w}</span>
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-start gap-1.5 text-[9px] text-muted-foreground/60 leading-snug">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px text-amber-400/70" />
                <span>
                  Digit and Rise/Fall contracts are priced below fair odds. Edge is refusing every entry the numbers reject — and stopping at your boundaries when wrong.
                </span>
              </div>

              <Button
                onClick={handleCreateDbot}
                disabled={building}
                data-testid="create-dbot"
                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
              >
                {building
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Forging hedge DBot…</>
                  : <><Hammer className="w-4 h-4 mr-2" /> Create DBot</>}
              </Button>
              <p className="text-[9px] text-center text-muted-foreground/50">
                Opens the Bot Builder with hedge-aware blocks loaded. Nothing trades until you press Run.
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default NexusHedgeConsole;
