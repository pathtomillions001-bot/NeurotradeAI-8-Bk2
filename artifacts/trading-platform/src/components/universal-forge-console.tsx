/**
 * Universal Forge console — user-composed DBot factory for direction and digit contracts.
 *
 * Digit Forge proved the shape: a settings panel whose primary action is
 * CREATE DBOT, with every gram of analysis compiled into the generated
 * workspace. Universal Forge removes both constraints — contract family and recovery set. The user
 * assembles any mix of Rise/Fall, Over/Under barriers, Even/Odd and Matches/Differs for
 * normal trades, and an INDEPENDENT mix for recovery. The generated bot
 * ranks that exact list across up to eight markets before every entry.
 *
 * There is no session, no scan and no stop here: execution belongs to Deriv's
 * own Run button after the user verifies the blocks in the Bot Builder.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2,
  X,
  Target,
  Hammer,
  ShieldCheck,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Activity,
  Plus,
  Sparkles,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

type ForgeContractType =
  | "CALL"
  | "PUT"
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITEVEN"
  | "DIGITODD"
  | "DIGITMATCH"
  | "DIGITDIFF";
interface ForgeSpec {
  type: ForgeContractType;
  digit: number;
}

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
  forceEntryAfter: number;
  watchMarkets: string[];
  ladder: {
    debtGrowthPerStep: number;
    capitalAtRisk: number;
    failureProbability: number;
  };
}

/** Static fallbacks so the panel works even before /options answers. */
const FALLBACK_TYPES: ContractTypeInfo[] = [
  {
    type: "CALL",
    label: "Rise",
    digitLabel: null,
    digitMin: null,
    digitMax: null,
    allowsAuto: false,
    needsDigit: false,
    payout: 1.92,
  },
  {
    type: "PUT",
    label: "Fall",
    digitLabel: null,
    digitMin: null,
    digitMax: null,
    allowsAuto: false,
    needsDigit: false,
    payout: 1.92,
  },
  {
    type: "DIGITOVER",
    label: "Digits Over",
    digitLabel: "Barrier",
    digitMin: 0,
    digitMax: 8,
    allowsAuto: false,
    needsDigit: true,
    payout: 1.95,
  },
  {
    type: "DIGITUNDER",
    label: "Digits Under",
    digitLabel: "Barrier",
    digitMin: 1,
    digitMax: 9,
    allowsAuto: false,
    needsDigit: true,
    payout: 1.95,
  },
  {
    type: "DIGITEVEN",
    label: "Even",
    digitLabel: null,
    digitMin: null,
    digitMax: null,
    allowsAuto: false,
    needsDigit: false,
    payout: 1.95,
  },
  {
    type: "DIGITODD",
    label: "Odd",
    digitLabel: null,
    digitMin: null,
    digitMax: null,
    allowsAuto: false,
    needsDigit: false,
    payout: 1.95,
  },
  {
    type: "DIGITMATCH",
    label: "Matches",
    digitLabel: "Digit",
    digitMin: 0,
    digitMax: 9,
    allowsAuto: true,
    needsDigit: false,
    payout: 8.93,
  },
  {
    type: "DIGITDIFF",
    label: "Differs",
    digitLabel: "Digit",
    digitMin: 0,
    digitMax: 9,
    allowsAuto: true,
    needsDigit: false,
    payout: 1.09,
  },
];

const SHORT_LABEL: Record<ForgeContractType, string> = {
  CALL: "Rise",
  PUT: "Fall",
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
};

/**
 * Forge-time rare-entry check (client copy of the API's gate diagnostics):
 * a contract is "priced tight" when its break-even (1/payout) leaves under
 * ~1.5pt of headroom over its natural win rate. Over 0, Under 9 and Differs
 * are the classic trap — they pay ~1.09× against a 91.7% break-even, so
 * normal entries qualify only on unusually hot tapes. The API re-checks with
 * the exact gate replica and returns warnings; this is the live preview.
 */
const TIGHT_HEADROOM = 0.015;
interface RareLegNote {
  label: string;
  payout: number;
  breakEven: number;
  naturalRate: number;
}

function rareLegNotes(
  specs: ForgeSpec[],
  options: ForgeOptions | null,
): RareLegNote[] {
  const over = options?.overPayouts ?? {};
  const under = options?.underPayouts ?? {};
  const typePayout = (t: ForgeContractType, fallback: number) =>
    options?.contractTypes.find((ct) => ct.type === t)?.payout ?? fallback;
  const notes: RareLegNote[] = [];
  for (const spec of specs) {
    let payout: number;
    let naturalRate: number;
    switch (spec.type) {
      case "CALL":
      case "PUT":
        payout = typePayout(spec.type, 1.92);
        naturalRate = 0.5;
        break;
      case "DIGITOVER":
        payout = Number(over[String(spec.digit)]) || 1.09;
        naturalRate = (9 - spec.digit) / 10;
        break;
      case "DIGITUNDER":
        payout = Number(under[String(spec.digit)]) || 1.09;
        naturalRate = spec.digit / 10;
        break;
      case "DIGITEVEN":
      case "DIGITODD":
        payout = typePayout(spec.type, 1.95);
        naturalRate = 0.5;
        break;
      case "DIGITMATCH":
        payout = typePayout("DIGITMATCH", 8.93);
        naturalRate = 0.1;
        break;
      case "DIGITDIFF":
        payout = typePayout("DIGITDIFF", 1.09);
        naturalRate = 0.9;
        break;
      default:
        continue;
    }
    const breakEven = 1 / payout;
    if (breakEven - naturalRate > TIGHT_HEADROOM) {
      notes.push({ label: specLabel(spec), payout, breakEven, naturalRate });
    }
  }
  return notes;
}

function specLabel(spec: ForgeSpec): string {
  const base = SHORT_LABEL[spec.type];
  if (
    spec.type === "CALL" ||
    spec.type === "PUT" ||
    spec.type === "DIGITEVEN" ||
    spec.type === "DIGITODD"
  )
    return base;
  if (spec.digit < 0) return `${base} auto`;
  return `${base} ${spec.digit}`;
}

function specKey(spec: ForgeSpec): string {
  return `${spec.type}:${spec.type === "CALL" || spec.type === "PUT" || spec.type === "DIGITEVEN" || spec.type === "DIGITODD" ? -1 : spec.digit}`;
}

function NumInput({
  label: lbl,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  accent,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
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
        <span className="text-xs text-muted-foreground flex-1">{lbl}</span>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`w-20 h-7 text-right font-mono text-xs bg-black/30 border-white/10 focus-visible:ring-0 ${a.focusBorder}`}
          />
          {suffix && (
            <span className="text-[10px] text-muted-foreground w-6">
              {suffix}
            </span>
          )}
        </div>
      </div>
      {hint && (
        <p className="text-[9px] text-muted-foreground/50 leading-snug">
          {hint}
        </p>
      )}
    </div>
  );
}

function Stat({
  label: lbl,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="bg-black/25 rounded-lg px-2 py-1.5">
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/60">
        {lbl}
      </p>
      <p
        className={`text-[11px] font-mono font-bold ${tone ?? "text-white/90"}`}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * One contract set (normal or recovery): the chosen chips plus an inline
 * "add contract" row driven by the API's vocabulary, so the panel can never
 * assemble a combination the generator rejects.
 */
function ContractSetEditor({
  title,
  hint,
  specs,
  onChange,
  types,
  accent,
  testId,
}: {
  title: string;
  hint: string;
  specs: ForgeSpec[];
  onChange: (next: ForgeSpec[]) => void;
  types: ContractTypeInfo[];
  accent: AccentKey;
  testId: string;
}) {
  const a = ACCENTS[accent];
  const [pickType, setPickType] = useState<ForgeContractType>("CALL");
  const [pickDigit, setPickDigit] = useState(1);
  const [autoDigit, setAutoDigit] = useState(true);

  const info = types.find((t) => t.type === pickType) ?? FALLBACK_TYPES[0];
  const digitVisible = info.needsDigit || (info.allowsAuto && !autoDigit);

  const add = () => {
    if (specs.length >= 6) {
      toast.error(
        "At most 6 contracts per set — the ranker needs candidates, not noise",
      );
      return;
    }
    const digit = info.needsDigit
      ? pickDigit
      : info.allowsAuto
        ? autoDigit
          ? -1
          : pickDigit
        : -1;
    if (digitVisible) {
      const min = info.digitMin ?? 0;
      const max = info.digitMax ?? 9;
      if (!Number.isInteger(digit) || digit < min || digit > max) {
        toast.error(
          `${info.label}: ${info.digitLabel ?? "digit"} must be ${min}–${max}`,
        );
        return;
      }
    }
    const next: ForgeSpec = { type: pickType, digit };
    if (specs.some((s) => specKey(s) === specKey(next))) {
      toast.info(`${specLabel(next)} is already in the set`);
      return;
    }
    onChange([...specs, next]);
  };

  return (
    <div className="space-y-1.5" data-testid={testId}>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {title}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {specs.length === 0 && (
          <span className="text-[10px] text-amber-300/80">
            Add at least one contract
          </span>
        )}
        {specs.map((spec) => (
          <span
            key={specKey(spec)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${a.panelBorder} ${a.panelBg} ${a.text}`}
          >
            {specLabel(spec)}
            <button
              type="button"
              aria-label={`Remove ${specLabel(spec)}`}
              onClick={() =>
                onChange(specs.filter((s) => specKey(s) !== specKey(spec)))
              }
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
          onChange={(e) => {
            const t = e.target.value as ForgeContractType;
            setPickType(t);
            const ti = types.find((x) => x.type === t);
            if (ti?.needsDigit) setPickDigit(ti.digitMin ?? 0);
          }}
          aria-label={`${title} contract type`}
          className={`flex-1 h-7 rounded-lg bg-black/30 border border-white/10 px-1.5 text-[11px] text-white focus:outline-none ${a.focusBorder}`}
        >
          {types.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        {info.allowsAuto && (
          <button
            type="button"
            onClick={() => setAutoDigit((v) => !v)}
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
            onChange={(e) => setPickDigit(Number(e.target.value))}
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

export function UniversalForgeConsole({
  bot,
  open,
  onOpenChange,
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

  const [symbol, setSymbol] = useState("R_50");
  // The user's example from the brief is the default: mixed categories in
  // BOTH sets — the shape Digit Forge cannot express.
  const [normal, setNormal] = useState<ForgeSpec[]>([
    { type: "CALL", digit: -1 },
    { type: "PUT", digit: -1 },
    { type: "DIGITOVER", digit: 2 },
  ]);
  const [recovery, setRecovery] = useState<ForgeSpec[]>([
    { type: "DIGITEVEN", digit: -1 },
    { type: "PUT", digit: -1 },
    { type: "DIGITOVER", digit: 4 },
  ]);
  const [config, setConfig] = useState({
    stake: 1,
    takeProfit: 10,
    stopLoss: 5,
    maxRecoverySteps: 3,
    breakerDepth: 6,
  });
  const [gate, setGate] = useState({ window: 120, forceEntryAfter: 0 });

  // Vocabulary (contract digit rules, canonical payouts, digit markets) comes
  // from the API so the panel can never offer what the generator rejects.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    fetch("/api/bots/universal-forge/options")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.contractTypes) setOptions(d);
      })
      .catch(() => {
        /* fall back to the static vocabulary */
      });
    return () => {
      cancelled = true;
    };
  }, [open, options]);

  const types = options?.contractTypes ?? FALLBACK_TYPES;
  const markets =
    options?.markets ??
    SCAN_MARKETS.map((m) => ({ symbol: m.symbol, displayName: m.name }));
  // Live rare-entry preview on the set being assembled (API re-verifies exactly).
  const rareNormal = rareLegNotes(normal, options);

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Target;
  const marketName =
    markets.find((m) => m.symbol === symbol)?.displayName ?? symbol;

  /**
   * CREATE DBOT — the whole point of this console. Render the strategy on the
   * API with the user's OWN contract sets, hand the XML to the warm builder
   * iframe, then route to Bot Builder so the user lands on their blocks.
   */
  const handleCreateDbot = async () => {
    if (normal.length === 0 || recovery.length === 0) {
      toast.error(
        "Choose at least one normal contract AND one recovery contract",
      );
      return;
    }
    setBuilding(true);
    try {
      const res = await fetch("/api/bots/universal-forge/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          normal,
          recovery,
          watchMarkets: markets.map((m) => m.symbol).slice(0, 8),
          ...config,
          ...gate,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.xml) {
        toast.error(data?.error ?? "Could not forge the DBot strategy");
        return;
      }
      const loaded = loadStrategyIntoBotBuilder({
        name: data.name,
        xml: data.xml,
        symbol,
      });
      setLastBuild(data.summary ?? null);
      const apiWarnings: string[] = Array.isArray(data.warnings)
        ? data.warnings
        : [];
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
            `stake $${config.stake} · TP $${config.takeProfit} · SL $${config.stopLoss}. ` +
            `It ranks YOUR contracts across ${s?.watchMarkets?.length ?? 8} markets before every entry. ` +
            `Verify the blocks, then press Run.`,
          { duration: 14_000 },
        );
        // The gate's verdict on the chosen legs must never be a silent
        // surprise — each rare-entry leg gets its own explicit warning.
        for (const w of apiWarnings.slice(0, 3)) {
          toast.warning(w, { duration: 16_000 });
        }
      } else {
        toast.error(
          "The bot builder did not confirm the strategy loaded — open Bot Builder and press Create DBot again.",
        );
      }
    } catch {
      toast.error("Could not reach Universal Forge to build the DBot");
    } finally {
      setBuilding(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/40 z-40"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 400, damping: 35 }}
            role="dialog"
            aria-label="Universal Forge console"
            className={`fixed bottom-20 right-4 z-50 w-84 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto rounded-2xl border ${a.panelBorder} bg-[#080d17] shadow-2xl ${a.cardGlow}`}
          >
            {/* Header */}
            <div
              className={`flex items-center justify-between gap-2 p-4 border-b border-white/5 bg-gradient-to-r ${a.headerGrad}`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div
                  className={`w-9 h-9 rounded-xl ${a.iconBg} ${a.iconBorder} flex items-center justify-center flex-shrink-0`}
                >
                  <Icon className={`w-4.5 h-4.5 ${a.text}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    {bot.name}
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${a.badgeBg} ${a.text} font-normal`}
                    >
                      {bot.code}
                    </span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                    {bot.tagline}
                  </p>
                </div>
              </div>
              <button
                onClick={() => onOpenChange(false)}
                aria-label="Close console"
                className="text-muted-foreground hover:text-white p-1 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* What this bot is */}
              <div
                className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}
              >
                <p
                  className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}
                >
                  <Sparkles className="w-3 h-3" /> Direction + digit contracts —
                  one forged DBot
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Assemble ANY mix of Rise/Fall and digit contracts for normal
                  trades and an independent mix for recovery, then press{" "}
                  <span className="text-white/80 font-semibold">
                    Create DBot
                  </span>
                  . The generated bot ranks your exact list across up to eight
                  markets before every entry — conservative EV, Wilson lower
                  bound, loss-conditioned timing for recovery, clustering and
                  stability — all compiled into the blocks. Nothing trades here.
                </p>
              </div>

              {/* The contract sets — the whole reason Universal Forge exists */}
              <ContractSetEditor
                title="Normal contracts"
                hint="Traded at base stake, only when the tape's worst plausible win rate clears that contract's break-even."
                specs={normal}
                onChange={setNormal}
                types={types}
                accent={bot.accent}
                testId="universal-forge-normal-set"
              />

              {/* Rare-entry preview — the Over 0 / Under 9 trap, visible BEFORE forging */}
              {rareNormal.length > 0 && (
                <div
                  className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 space-y-1"
                  data-testid="rare-entry-hint"
                >
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3" /> Rare-entry{" "}
                    {rareNormal.length === 1 ? "leg" : "legs"} in the normal set
                  </p>
                  {rareNormal.map((r) => (
                    <p
                      key={r.label}
                      className="text-[9px] text-muted-foreground leading-snug"
                    >
                      <span className="text-amber-200 font-semibold">
                        {r.label}
                      </span>{" "}
                      pays {r.payout}× — break-even is{" "}
                      {(r.breakEven * 100).toFixed(1)}% against a{" "}
                      {(r.naturalRate * 100).toFixed(0)}% natural rate, so the
                      bot only buys it on unusually hot tapes. Expect long quiet
                      stretches; it trades more freely in the recovery set
                      (looser gate), or set{" "}
                      <span className="text-white/70 font-semibold">
                        Force entry after
                      </span>{" "}
                      below.
                    </p>
                  ))}
                </div>
              )}
              <ContractSetEditor
                title="Recovery contracts"
                hint="After a loss the bot ranks THIS set on P(win | previous loss) — the state a recovery entry actually fires from — and sizes the stake to clear the debt."
                specs={recovery}
                onChange={setRecovery}
                types={types}
                accent={bot.accent}
                testId="universal-forge-recovery-set"
              />

              {/* Market */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Starting market
                </p>
                <select
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                  aria-label="Market"
                  className={`w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2 text-xs text-white focus:outline-none ${a.focusBorder}`}
                >
                  {markets.map((m) => (
                    <option key={m.symbol} value={m.symbol}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>

              {/* Boundaries */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Session boundaries
                </p>
                <NumInput
                  label="Base stake"
                  value={config.stake}
                  onChange={(v) => setConfig((c) => ({ ...c, stake: v }))}
                  min={0.35}
                  step={0.5}
                  suffix="USD"
                  accent={bot.accent}
                />
                <NumInput
                  label="Take profit"
                  value={config.takeProfit}
                  onChange={(v) => setConfig((c) => ({ ...c, takeProfit: v }))}
                  min={1}
                  step={1}
                  suffix="USD"
                  accent={bot.accent}
                />
                <NumInput
                  label="Stop loss"
                  value={config.stopLoss}
                  onChange={(v) => setConfig((c) => ({ ...c, stopLoss: v }))}
                  min={1}
                  step={1}
                  suffix="USD"
                  accent={bot.accent}
                />
                <NumInput
                  label="Max recovery steps"
                  value={config.maxRecoverySteps}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, maxRecoverySteps: v }))
                  }
                  min={1}
                  max={10}
                  step={1}
                  accent={bot.accent}
                  hint="How deep the debt ladder may go before the bot gives the debt up and returns to base stake."
                />
                <NumInput
                  label="Circuit breaker"
                  value={config.breakerDepth}
                  onChange={(v) =>
                    setConfig((c) => ({ ...c, breakerDepth: v }))
                  }
                  min={3}
                  max={20}
                  step={1}
                  accent={bot.accent}
                  hint="Consecutive losses that stop the run outright — the clustered-loss tail, not the average."
                />
              </div>

              {/* Advanced: the in-bot analysis */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold hover:text-white"
                >
                  {showAdvanced ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  In-bot analysis
                </button>
                {showAdvanced && (
                  <div className="space-y-2 pl-1">
                    <NumInput
                      label="Tick window"
                      value={gate.window}
                      onChange={(v) => setGate((g) => ({ ...g, window: v }))}
                      min={30}
                      max={300}
                      step={10}
                      accent={bot.accent}
                      hint="Digits the running bot keeps per market (30 is the gate's sample minimum). Longer = steadier estimate, slower to notice a regime change."
                    />
                    <NumInput
                      label="Force entry after"
                      value={gate.forceEntryAfter}
                      onChange={(v) =>
                        setGate((g) => ({ ...g, forceEntryAfter: v }))
                      }
                      min={0}
                      max={5000}
                      step={1}
                      accent={bot.accent}
                      hint="0 = infinite patience. Otherwise the bot takes the highest-ranked candidate after this many refusals — the escape hatch for rare-entry legs like Over 0 / Under 9."
                    />
                  </div>
                )}
              </div>

              {/* Recovery provenance */}
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery uses the app's
                  own ladder
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  debt × (1 + markup) ÷ (payout − 1), floored at 0.35, capped by
                  your max trade stake and live balance, rounded up to the cent
                  — the same formula every NeuroTrade bot uses, compiled into
                  the blocks so it runs without this app.
                </p>
              </div>

              {lastBuild && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground flex items-center gap-1.5">
                    <Activity className="w-3 h-3" /> Last forge
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Stat
                      label="Capital at risk"
                      value={`${lastBuild.ladder.capitalAtRisk.toFixed(1)}× stake`}
                      tone="text-amber-300"
                    />
                    <Stat
                      label="Ladder failure odds"
                      value={`${(lastBuild.ladder.failureProbability * 100).toFixed(1)}%`}
                    />
                    <Stat
                      label="Normal set"
                      value={lastBuild.normal.join(" · ")}
                    />
                    <Stat
                      label="Recovery set"
                      value={lastBuild.recovery.join(" · ")}
                    />
                  </div>
                  {forgeWarnings.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-white/5">
                      {forgeWarnings.map((w) => (
                        <p
                          key={w}
                          className="text-[9px] text-amber-300/90 leading-snug flex items-start gap-1"
                        >
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
                  Contracts are priced below their fair odds, so no mix is
                  positive by itself. The bot's edge is refusing entries its own
                  numbers reject, sizing recovery safely, and stopping at your
                  boundaries when it is wrong.
                </span>
              </div>

              {/* PRIMARY ACTION */}
              <Button
                onClick={handleCreateDbot}
                disabled={building}
                data-testid="create-dbot"
                className={`w-full h-10 ${a.solidBtn} text-white font-bold text-xs`}
              >
                {building ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Forging
                    DBot…
                  </>
                ) : (
                  <>
                    <Hammer className="w-4 h-4 mr-2" /> Create DBot
                  </>
                )}
              </Button>
              <p className="text-[9px] text-center text-muted-foreground/50">
                Opens the Bot Builder with your blocks loaded. Nothing trades
                until you press Run there.
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

export default UniversalForgeConsole;
