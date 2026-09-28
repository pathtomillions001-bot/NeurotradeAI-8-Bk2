/**
 * Digit Forge console — the DBot factory panel.
 *
 * Every other console in the Arena scans, then trades. This one does neither.
 * It is a settings panel whose primary action is CREATE DBOT: the API renders a
 * stock Deriv-Bot (Blockly) strategy from these settings, the web app pushes it
 * into the embedded bot builder and routes the user there. Execution belongs to
 * Deriv's own Run button, so there is no session, no status polling and no stop
 * action — only "what should the generated bot believe, and how brave is it".
 *
 * The panel is deliberately explicit about WHERE the analysis runs: inside the
 * generated workspace, on the user's own Deriv connection, every tick.
 */

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  Loader2, X, Workflow, Hammer, ShieldCheck, AlertTriangle,
  ChevronDown, ChevronRight, Activity,
} from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import type { BotCardData, BotSessionStatus, AccentKey } from "@/lib/bots";
import { ACCENTS, BOT_ICON, SCAN_MARKETS } from "@/lib/bots";
import { loadStrategyIntoBotBuilder } from "@/lib/bot-builder-frame";

interface Contract { side: "DIGITOVER" | "DIGITUNDER"; barrier: number }

interface ForgeOptions {
  markets: { symbol: string; displayName: string }[];
}

interface ForgeSummary {
  symbol: string;
  displayName: string;
  normal: string;
  recovery: string;
  stake: number;
  takeProfit: number;
  stopLoss: number;
  maxRecoverySteps: number;
  markupPercent: number;
  maxStake: number;
  normalPayout: number;
  recoveryPayout: number;
  breakerDepth: number;
  currency: string;
  window: number;
  minSamples: number;
  confidenceZ: number;
  forceEntryAfter: number;
  useMarkov: boolean;
  useStreakCooldown: boolean;
  runLimit: number;
  breakEven: number;
  watchMarkets: string[];
  ladder: { debtGrowthPerStep: number; capitalAtRisk: number; failureProbability: number };
}

// Internal startup defaults keep the generated XML portable. The running
// DBot ranks every enabled normal and recovery barrier before it trades.
const FALLBACK_NORMAL: Contract = { side: "DIGITOVER", barrier: 2 };
const FALLBACK_RECOVERY: Contract = { side: "DIGITOVER", barrier: 5 };

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

function Toggle({ label: lbl, description, value, onChange, accent }: {
  label: string; description: string; value: boolean; onChange: (v: boolean) => void; accent: AccentKey;
}) {
  const a = ACCENTS[accent];
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      aria-pressed={value}
      className={`w-full text-left rounded-lg border px-2.5 py-2 transition-colors ${
        value ? `${a.panelBorder} ${a.panelBg}` : "border-white/10 bg-black/20"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`text-[11px] font-semibold ${value ? a.text : "text-muted-foreground"}`}>{lbl}</span>
        <span className={`w-7 h-4 rounded-full flex items-center px-0.5 transition-colors ${value ? a.solidBtn : "bg-white/10"}`}>
          <span className={`w-3 h-3 rounded-full bg-white transition-transform ${value ? "translate-x-3" : ""}`} />
        </span>
      </div>
      <p className="text-[9px] text-muted-foreground/60 leading-snug mt-0.5">{description}</p>
    </button>
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

export function DigitForgeConsole({
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

  const [symbol, setSymbol] = useState("R_50");
  const [config, setConfig] = useState({
    stake: 1, takeProfit: 10, stopLoss: 5, maxRecoverySteps: 3, breakerDepth: 6,
  });
  const [gate, setGate] = useState({
    window: 120, minSamples: 30, confidenceZ: 1.645, forceEntryAfter: 0,
    useMarkov: true, useStreakCooldown: true,
  });

  // The vocabulary (legal barriers, digit markets, canonical payouts) comes from
  // the API so the panel can never offer a combination the generator rejects.
  useEffect(() => {
    if (!open || options) return;
    let cancelled = false;
    fetch("/api/bots/digit-forge/options")
      .then(r => r.json())
      .then(d => { if (!cancelled && d?.markets) setOptions(d); })
      .catch(() => { /* fall back to the static market list below */ });
    return () => { cancelled = true; };
  }, [open, options]);

  const markets = options?.markets ?? SCAN_MARKETS.map(m => ({ symbol: m.symbol, displayName: m.name }));

  if (!bot) return null;
  const a = ACCENTS[bot.accent];
  const Icon = BOT_ICON[bot.icon] ?? Workflow;
  const marketName = markets.find(m => m.symbol === symbol)?.displayName ?? symbol;

  /**
   * CREATE DBOT — the whole point of this console. Render the strategy on the
   * API, hand the XML to the warm builder iframe, then route to Bot Builder so
   * the user lands on their blocks.
   */
  const handleCreateDbot = async () => {
    setBuilding(true);
    try {
      const res = await fetch("/api/bots/digit-forge/dbot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          // Internal startup values keep the XML portable. The running DBot
          // enables and ranks every legal normal/recovery barrier itself.
          normal: FALLBACK_NORMAL,
          recovery: FALLBACK_RECOVERY,
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
      toast.info(`Forging your DBot for ${marketName}…`);
      onOpenChange(false);
      navigate("/bot-builder");
      const ok = await loaded;
      if (ok) {
        const s: ForgeSummary | undefined = data.summary;
        toast.success(
          `DBot forged: ${marketName} · adaptive normal and focused recovery barriers · ` +
            `stake $${config.stake} · TP $${config.takeProfit} · SL $${config.stopLoss}. ` +
            `It measures its own tape (${s?.window ?? gate.window}-tick window) before every normal entry. ` +
            `Verify the blocks, then press Run.`,
          { duration: 14_000 },
        );
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
            aria-label="Digit Forge console"
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
              {/* What this bot is */}
              <div className={`rounded-xl border ${a.panelBorder} ${a.panelBg} p-3 space-y-1.5`}>
                <p className={`text-[10px] uppercase tracking-widest font-semibold ${a.text} flex items-center gap-1.5`}>
                  <Hammer className="w-3 h-3" /> This console builds, it does not trade
                </p>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Choose a starting market and session boundaries, then press{" "}
                  <span className="text-white/80 font-semibold">Create DBot</span>. The generated bot enables
                  only Over 1 / Over 2 / Under 7 / Under 8 normally and Over 5 / Under 4 in recovery, ranks them across up to eight markets,
                  and safely switches market between contracts when another tape is stronger. Bayesian probability,
                  live EV, Markov transitions, stability and loss clustering all run inside your Bot Builder.
                </p>
              </div>

              {/* Market */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Market</p>
                <select
                  value={symbol}
                  onChange={e => setSymbol(e.target.value)}
                  aria-label="Market"
                  className={`w-full h-8 rounded-lg bg-black/30 border border-white/10 px-2 text-xs text-white focus:outline-none ${a.focusBorder}`}
                >
                  {markets.map(m => <option key={m.symbol} value={m.symbol}>{m.displayName}</option>)}
                </select>
              </div>

              {/* Boundaries */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Session boundaries</p>
                <NumInput label="Base stake" value={config.stake} onChange={v => setConfig(c => ({ ...c, stake: v }))} min={0.35} step={0.5} suffix="USD" accent={bot.accent} />
                <NumInput label="Take profit" value={config.takeProfit} onChange={v => setConfig(c => ({ ...c, takeProfit: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Stop loss" value={config.stopLoss} onChange={v => setConfig(c => ({ ...c, stopLoss: v }))} min={1} step={1} suffix="USD" accent={bot.accent} />
                <NumInput label="Max recovery steps" value={config.maxRecoverySteps} onChange={v => setConfig(c => ({ ...c, maxRecoverySteps: v }))} min={1} max={10} step={1} accent={bot.accent}
                          hint="Caps the recovery step counter, not the debt. Unpaid losses stay in recovery until repaid; stop-loss and the circuit breaker stop the run." />
                <NumInput label="Circuit breaker" value={config.breakerDepth} onChange={v => setConfig(c => ({ ...c, breakerDepth: v }))} min={3} max={20} step={1} accent={bot.accent}
                          hint="Consecutive losses that stop the run outright — the clustered-loss tail, not the average." />
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
                    <NumInput label="Tick window" value={gate.window} onChange={v => setGate(g => ({ ...g, window: v }))} min={20} max={300} step={10} accent={bot.accent}
                              hint="Digits the running bot keeps in memory. Longer = steadier estimate, slower to notice a regime change." />
                    <NumInput label="Minimum samples" value={gate.minSamples} onChange={v => setGate(g => ({ ...g, minSamples: v }))} min={10} max={300} step={5} accent={bot.accent}
                              hint="No entry at all until the bot has seen this many ticks." />
                    <NumInput label="Confidence z" value={gate.confidenceZ} onChange={v => setGate(g => ({ ...g, confidenceZ: v }))} min={0} max={3} step={0.005} accent={bot.accent}
                              hint="Agresti–Coull lower bound. 1.645 = 95% one-sided; 0 = trade the raw rate." />
                    <NumInput label="Force entry after" value={gate.forceEntryAfter} onChange={v => setGate(g => ({ ...g, forceEntryAfter: v }))} min={0} max={5000} step={10} accent={bot.accent}
                              hint="Normal mode only: 0 = infinite patience; otherwise allows an entry after this many refusals. Recovery always waits for a confirmed setup." />
                    <Toggle label="Markov dependence test" accent={bot.accent}
                            description="Two-state chain + G² likelihood-ratio test; the conditional rate only votes when G² > 3.84 (χ²₁, 5%)."
                            value={gate.useMarkov} onChange={v => setGate(g => ({ ...g, useMarkov: v }))} />
                    <Toggle label="Streak cooldown" accent={bot.accent}
                            description="Stand down while the current adverse run exceeds the window's expected worst run."
                            value={gate.useStreakCooldown} onChange={v => setGate(g => ({ ...g, useStreakCooldown: v }))} />
                  </div>
                )}
              </div>

              {/* Recovery provenance */}
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-2.5 space-y-1">
                <p className="text-[10px] uppercase tracking-widest font-semibold text-amber-300 flex items-center gap-1.5">
                  <ShieldCheck className="w-3 h-3" /> Recovery uses the app's own ladder
                </p>
                <p className="text-[9px] text-muted-foreground leading-snug">
                  debt × (1 + markup) ÷ (live payout − 1), using the selected Over 5 or Under 4 quote before
                  sizing — the same recovery formula as the app's AI bots. Stakes round up without exceeding
                  your max trade stake or live balance. Partial wins reduce debt; normal trading resumes only
                  when that debt is repaid. No affordable minimum stake means no trade.
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
                    <Stat label="Streak cooldown" value={`${lastBuild.runLimit} losses`} />
                    <Stat label="Break-even" value={`${(lastBuild.breakEven * 100).toFixed(1)}%`} />
                  </div>
                </div>
              )}

              <div className="flex items-start gap-1.5 text-[9px] text-muted-foreground/60 leading-snug">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px text-amber-400/70" />
                <span>
                  Digit contracts are priced below their fair odds, so no gate makes them positive by itself.
                  The bot's edge is refusing to trade a tape that has not earned it — and stopping at your
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

export default DigitForgeConsole;
