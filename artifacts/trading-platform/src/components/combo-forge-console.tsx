/**
 * Combo Forge console — the evidence-gated DBot factory panel.
 *
 * Omni Forge let the user compose any digit contracts for normal and recovery.
 * Combo Forge keeps that freedom, adds Rise/Fall, lets the user pick which
 * markets the running bot scans, and replaces the ranker's gate with a
 * prequential evidence test that — in its default STRICT mode — stays silent
 * unless a contract's win rate is proven above its own break-even.
 *
 * There is no session, no scan and no stop here: execution belongs to Deriv's
 * own Run button after the user verifies the blocks in the Bot Builder. The
 * panel is deliberately honest: every contract is priced below fair odds and
 * the synthetic indices are close to random, so it shows how long a real edge
 * would take to prove and what a FAIR tape does to the gate.
 */

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2, X, Target, Hammer, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronRight, Activity, Plus, Sparkles,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

type ForgeContractType =
  | "DIGITOVER" | "DIGITUNDER" | "DIGITEVEN" | "DIGITODD" | "DIGITMATCH" | "DIGITDIFF" | "CALL" | "PUT";
interface ForgeSpec { type: ForgeContractType; digit: number }
type Strictness = "strict" | "balanced" | "always";

interface ContractTypeInfo {
  type: ForgeContractType;
  label: string;
  digitLabel: string | null;
  digitMin: number | null;
  digitMax: number | null;
  allowsAuto: boolean;
  needsDigit: boolean;
  payout?: number;
}

interface ForgeOptions {
  contractTypes: ContractTypeInfo[];
  overPayouts: Record<string, number>;
  underPayouts: Record<string, number>;
  markets: { symbol: string; displayName: string }[];
  defaults?: { strictness: Strictness; window: number; recoveryPatience: number; normalPatience: number };
  limits?: { maxSet: number; maxMarkets: number; minWindow: number; maxWindow: number };
}

interface GateReading {
  key: string;
  label: string;
  payout: number;
  fairRate: number;
  breakEven: number;
  margin: number;
  ticksToDetect: { edge: number; ticks: number | null }[];
  fairFalseFire: number;
}

interface ForgeSummary {
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
  strictness: Strictness;
  recoveryPatience: number;
  normalPatience: number;
  watchMarkets: string[];
  candidates: { normal: number; recovery: number };
  ladder: { debtGrowthPerStep: number; capitalAtRisk: number; failureProbability: number };
  gate: { normal: GateReading[] };
}

const MAX_SET = 8;
const MAX_MARKETS = 8;

/** Static fallbacks so the panel works even before /options answers. */
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

const SHORT_LABEL: Record<ForgeContractType, string> = {
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
  CALL: "Rise",
  PUT: "Fall",
};

const STRICTNESS_COPY: Record<Strictness, { label: string; blurb: string }> = {
  strict: {
    label: "Strict",
    blurb: "Trades only when a contract's win rate is PROVEN above its break-even (corrected for everything scanned). On a fair tape it stays silent — by design.",
  },
  balanced: {
    label: "Balanced",
    blurb: "Accepts moderate proof of an edge. Trades more often and is fooled by luck more often.",
  },
  always: {
    label: "Always",
    blurb: "Trades the best-timed, cheapest candidate WITHOUT proof of an edge. Every contract is priced below fair odds, so expect the house margin to cost you.",
  },
};

function isDigitFree(type: ForgeContractType): boolean {
  return type === "DIGITEVEN" || type === "DIGITODD" || type === "CALL" || type === "PUT";
}

function specLabel(spec: ForgeSpec): string {
  const base = SHORT_LABEL[spec.type];
  if (isDigitFree(spec.type)) return base;
  if (spec.digit < 0) return `${base} auto`;
  return `${base} ${spec.digit}`;
}

function specKey(spec: ForgeSpec): string {
  return `${spec.type}:${isDigitFree(spec.type) ? -1 : spec.digit}`;
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

/**
 * One contract set (normal or recovery): the chosen chips plus an inline
 * "add contract" row driven by the API's vocabulary, so the panel can never
 * assemble a combination the generator rejects.
 */
function ContractSetEditor({ title, hint, specs, onChange, types, accent, testId }: {
  title: string;
  hint: string;
  specs: ForgeSpec[];
  onChange: (next: ForgeSpec[]) => void;
  types: ContractTypeInfo[];
  accent: AccentKey;
  testId: string;
}) {
  const a = ACCENTS[accent];
  const [pickType, setPickType] = useState<ForgeContractType>("DIGITOVER");
  const [pickDigit, setPickDigit] = useState(1);
  const [autoDigit, setAutoDigit] = useState(true);

  const info = types.find(t => t.type === pickType) ?? FALLBACK_TYPES[0];
  const digitVisible = info.needsDigit || (info.allowsAuto && !autoDigit);

  const add = () => {
    if (specs.length >= MAX_SET) {
      toast.error(`At most ${MAX_SET} contracts per set — every extra candidate raises the evidence bar`);
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
    const next: ForgeSpec = { type: pickType, digit };
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
            const t = e.target.value as ForgeContractType;
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

function fmtTicks(n: number | null, windowSize: number): string {
  if (n === null) return "more than 1,000";
  return n > windowSize ? `${n.toLocaleString()} (> window)` : n.toLocaleString();
}

export function ComboForgeConsole({
  bot, open, onOpenChange,
}: {
  bot: BotCardData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (status: BotSessionStatus | null) => void;
}) {
  const [, navigate] = useLocation();
  const [options, setOptions] = useState<ForgeOptions | null>(null);
  const [building, setBuilding] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [lastBuild, setLastBuild] = useState<ForgeSummary | null>(null);
  const [forgeWarnings, setForgeWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ summary: ForgeSummary; warnings: string[] } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const [symbol, setSymbol] = useState("R_50");
  const [normal, setNormal] = useState<ForgeSpec[]>([
    { type: "DIGITOVER", digit: 1 },
    { type: "DIGITUNDER", digit: 8 },
  ]);
  const [recovery, setRecovery] = useState<ForgeSpec[]>([
    { type: "DIGITEVEN", digit: -1 },
    { type: "DIGITOVER", digit: 4 },
  ]);
  const [scanMarkets, setScanMarkets] = useState<string[]>(["R_10", "R_25", "R_50", "R_75"]);
  const [config, setConfig] = useState({
    stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, breakerDepth: 6,
  });
  const [strictness, setStrictness] = useState<Strictness>("strict");
  const [gate, setGate] = useState({ window: 500, recoveryPatience: 20, normalPatience: 0 });

  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    fetch("/api/bots/combo-forge/options")
      .then(r => r.json())
      .then(d => { if (!cancelled && d?.contractTypes) setOptions(d); })
      .catch(() => { /* fall back to the static vocabulary */ });
    return () => { cancelled = true; };
  }, [open, options]);

  const types = options?.contractTypes ?? FALLBACK_TYPES;
  const markets = options?.markets ?? SCAN_MARKETS.map(m => ({ symbol: m.symbol, displayName: m.name }));
  const maxMarkets = options?.limits?.maxMarkets ?? MAX_MARKETS;
  const minWindow = options?.limits?.minWindow ?? 80;
  const maxWindow = options?.limits?.maxWindow ?? 1000;

  /** The start market is always scanned; the rest are the user's picks (≤ 8 total). */
  const watchMarkets = useMemo(
    () => [symbol, ...scanMarkets.filter(s => s !== symbol)].slice(0, maxMarkets),
    [symbol, scanMarkets, maxMarkets],
  );

  const requestBody = useMemo(() => ({
    symbol, normal, recovery, watchMarkets, strictness, ...config, ...gate,
  }), [symbol, normal, recovery, watchMarkets, strictness, config, gate]);

  // Forge-time honesty: detection time for a real edge and the false-fire rate
  // on a FAIR tape, from the same generator that renders the bot.
  useEffect(() => {
    if (!open || normal.length === 0 || recovery.length === 0) { setPreview(null); return; }
    let cancelled = false;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      fetch("/api/bots/combo-forge/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })
        .then(r => r.json())
        .then(d => {
          if (cancelled) return;
          setPreview(d?.summary ? { summary: d.summary, warnings: Array.isArray(d.warnings) ? d.warnings : [] } : null);
        })
        .catch(() => { if (!cancelled) setPreview(null); })
        .finally(() => { if (!cancelled) setPreviewBusy(false); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, requestBody, normal.length, recovery.length]);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Target;
  const marketName = markets.find(m => m.symbol === symbol)?.displayName ?? symbol;

  const toggleMarket = (sym: string) => {
    if (sym === symbol) return;
    setScanMarkets(cur => {
      if (cur.includes(sym)) return cur.filter(s => s !== sym);
      if (watchMarkets.length >= maxMarkets) {
        toast.error(`At most ${maxMarkets} markets can be scanned per cycle`);
        return cur;
      }
      return [...cur, sym];
    });
  };

  const handleCreateDbot = async () => {
    if (normal.length === 0 || recovery.length === 0) {
      toast.error("Choose at least one contract for normal trades AND one for recovery");
      return;
    }
    setBuilding(true);
    try {
      const res = await fetch("/api/bots/combo-forge/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
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
      toast.info(`Forging your DBot for ${marketName}…`);
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        const s: ForgeSummary | undefined = data.summary;
        toast.success(
          `DBot forged: ${marketName} · normal [${(s?.normal ?? normal.map(specLabel)).join(", ")}] → ` +
            `recovery [${(s?.recovery ?? recovery.map(specLabel)).join(", ")}] · ` +
            `${STRICTNESS_COPY[s?.strictness ?? strictness].label} mode · stake $${config.stake} · ` +
            `TP $${config.takeProfit} · SL $${config.stopLoss}. ` +
            `It scans ${s?.watchMarkets?.length ?? watchMarkets.length} markets and may hold for long stretches when there is no proven edge. ` +
            `Verify the blocks, then press Run.`,
          { duration: 14_000 },
        );
        for (const w of apiWarnings.slice(0, 3)) toast.warning(w, { duration: 16_000 });
      } else {
        toast.error("The bot builder did not confirm the strategy loaded — open Bot Builder and press Create DBot again.");
      }
    } catch {
      toast.error("Could not reach the forge to build the DBot");
    } finally {
      setBuilding(false);
    }
  };

  const gateRows = preview?.summary.gate.normal ?? [];
  const previewWindow = preview?.summary.window ?? gate.window;

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
            aria-label="Combo Forge console"
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            {/* Header */}
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
                  <Sparkles className="w-3 h-3" /> Digits + Rise/Fall — trades only on evidence
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Choose any digit or Rise/Fall contracts for normal trades, another set for recovery, and
                  the markets the bot may scan. Press <span className="text-white/80 font-semibold">Create DBot</span>:
                  the generated bot tests every market × contract against its own break-even inside the
                  blocks and, in Strict mode, waits until the evidence clears a bar corrected for everything it
                  scanned. Nothing trades here.
                </p>
              </div>

              <ContractSetEditor
                title="Normal contracts"
                hint="Traded at base stake, only when the evidence for that contract clears the bar (Always mode skips the bar)."
                specs={normal}
                onChange={setNormal}
                types={types}
                accent={bot.accent}
                testId="combo-forge-normal-set"
              />
              <ContractSetEditor
                title="Recovery contracts"
                hint="After a loss the bot picks from THIS set the leg whose current win rate is not below fair and whose exact ladder stake grows your balance best."
                specs={recovery}
                onChange={setRecovery}
                types={types}
                accent={bot.accent}
                testId="combo-forge-recovery-set"
              />

              {/* Markets */}
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
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold pt-1">
                  Markets to scan ({watchMarkets.length}/{maxMarkets})
                </p>
                <div className="flex flex-wrap gap-1" data-testid="combo-forge-markets">
                  {markets.map(m => {
                    const on = watchMarkets.includes(m.symbol);
                    return (
                      <button
                        key={m.symbol}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleMarket(m.symbol)}
                        title={m.symbol === symbol ? "Starting market — always scanned" : m.displayName}
                        className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold ${on ? `${a.panelBorder} ${a.panelBg} ${a.text}` : "border-white/10 bg-black/20 text-muted-foreground"}`}
                      >
                        {m.symbol}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[9px] text-muted-foreground/50 leading-snug">
                  Every extra market or contract is one more chance for luck to look like an edge, so the evidence bar rises with the number scanned.
                </p>
              </div>

              {/* Strictness */}
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Evidence mode</p>
                <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Evidence mode">
                  {(["strict", "balanced", "always"] as Strictness[]).map(mode => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={strictness === mode}
                      onClick={() => setStrictness(mode)}
                      data-testid={`combo-forge-mode-${mode}`}
                      className={`h-7 rounded-lg border text-[10px] font-semibold ${strictness === mode ? `${a.panelBorder} ${a.panelBg} ${a.text}` : "border-white/10 bg-black/20 text-muted-foreground hover:text-white"}`}
                    >
                      {STRICTNESS_COPY[mode].label}{mode === "strict" ? " · default" : ""}
                    </button>
                  ))}
                </div>
                <p className="text-[9px] text-muted-foreground/60 leading-snug">{STRICTNESS_COPY[strictness].blurb}</p>
              </div>

              {/* Boundaries */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session boundaries</p>
                <NumInput label="Base stake" value={config.stake} onChange={v => setConfig(c => ({ ...c, stake: v }))} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                <NumInput label="Take profit" value={config.takeProfit} onChange={v => setConfig(c => ({ ...c, takeProfit: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Stop loss" value={config.stopLoss} onChange={v => setConfig(c => ({ ...c, stopLoss: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => setConfig(c => ({ ...c, maxRecoverySteps: v }))} min={1} max={10} step={1} accent={bot.accent}
                          hint="How deep the debt ladder may go before the bot stops deepening the debt." />
                <NumInput label="Circuit breaker" value={config.breakerDepth} onChange={v => setConfig(c => ({ ...c, breakerDepth: v }))} min={3} max={20} step={1} accent={bot.accent}
                          hint="Consecutive losses that stop the run outright — the clustered-loss tail, not the average." />
              </div>

              {/* Honest forge-time preview */}
              <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-1.5" data-testid="combo-forge-preview">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Activity className="w-3 h-3" /> What the evidence gate can and cannot do
                  {previewBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                </p>
                {gateRows.length === 0 && (
                  <p className="text-[9px] text-muted-foreground/60">Preview appears once both sets have a contract.</p>
                )}
                {gateRows.map(r => {
                  const six = r.ticksToDetect.find(t => t.edge === 0.06)?.ticks ?? null;
                  return (
                    <p key={r.key} className="text-[9px] text-muted-foreground leading-snug">
                      <span className="text-white/85 font-semibold">{r.label}</span> pays {r.payout}× · house margin{" "}
                      {(r.margin * 100).toFixed(1)}% · a real +6-point edge takes ≈{fmtTicks(six, previewWindow)} ticks to prove
                      {strictness === "always" ? "" : ` · fair-tape false fire ${(r.fairFalseFire * 100).toFixed(0)}%`}
                    </p>
                  );
                })}
                {preview && (
                  <p className="text-[9px] text-muted-foreground/60 leading-snug">
                    Scanning {preview.summary.candidates.normal} market × contract candidates per cycle.
                  </p>
                )}
                {preview?.warnings.slice(0, 3).map(w => (
                  <p key={w} className="text-[9px] text-amber-300/90 leading-snug flex items-start gap-1">
                    <AlertTriangle className="w-2.5 h-2.5 flex-shrink-0 mt-px" />
                    <span>{w}</span>
                  </p>
                ))}
              </div>

              {/* Advanced: the in-bot analysis */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(v => !v)}
                  className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-white"
                >
                  {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  In-bot analysis
                </button>
                {showAdvanced && (
                  <div className="space-y-2 pl-1">
                    <NumInput label="Tick window" value={gate.window} onChange={v => setGate(g => ({ ...g, window: v }))} min={minWindow} max={maxWindow} step={50} accent={bot.accent}
                              hint={`Ticks per market the running bot analyses (${minWindow}–${maxWindow}). Small edges need hundreds of ticks to prove; a short window cannot prove them at all.`} />
                    <NumInput label="Recovery patience" value={gate.recoveryPatience} onChange={v => setGate(g => ({ ...g, recoveryPatience: v }))} min={0} max={5000} step={1} accent={bot.accent}
                              hint="Evaluations before recovery takes the best-ranked leg even if every leg looks unfavourable, so a debt cannot stall the session. 0 = never force." />
                    <NumInput label="Normal patience" value={gate.normalPatience} onChange={v => setGate(g => ({ ...g, normalPatience: v }))} min={0} max={5000} step={1} accent={bot.accent}
                              hint="0 (recommended) = never enter a normal trade without evidence. Otherwise the bot enters on the best candidate after this many evaluations — that is a bet without proof." />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery uses the app's own ladder
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  debt × (1 + markup) ÷ (payout − 1), floored at 0.35, capped by your max trade stake and live
                  balance, rounded up to the cent — the same formula every NeuroTrade bot uses, applied with the
                  payout of the contract the bot actually picks, and compiled into the blocks so it runs without this app.
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
                    <Stat label="Normal set" value={lastBuild.normal.join(" · ")} />
                    <Stat label="Recovery set" value={lastBuild.recovery.join(" · ")} />
                    <Stat label="Mode" value={STRICTNESS_COPY[lastBuild.strictness].label} />
                    <Stat label="Markets scanned" value={String(lastBuild.watchMarkets.length)} />
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

              <div className="flex items-start gap-1.5 text-[9px] text-muted-foreground/60 leading-snug" data-testid="combo-forge-honesty">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px text-amber-400/70" />
                <span>
                  No win rate is promised. Deriv's synthetic indices are close to random and every contract is
                  priced below its fair odds, so on a fair tape there is no edge to find and any bot loses the
                  margin over time. Combo Forge's value is refusing entries its own numbers reject, paying the
                  lowest margin available, and stopping at your boundaries.
                </span>
              </div>

              <Button
                onClick={handleCreateDbot}
                disabled={building}
                data-testid="create-dbot"
                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
              >
                {building
                  ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Forging DBot…</>
                  : <><Hammer className="w-4 h-4 mr-2" /> Create DBot</>}
              </Button>
              <p className="text-[9px] text-center text-muted-foreground/50">
                Opens the Bot Builder with your blocks loaded. Nothing trades until you press Run there.
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default ComboForgeConsole;
