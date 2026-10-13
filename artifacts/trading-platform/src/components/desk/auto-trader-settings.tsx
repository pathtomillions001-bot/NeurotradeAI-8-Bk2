/**
 * The auto-trader's settings — every knob the desk trades by, on one surface.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The report was blunt: "the user must be able to adjust how the auto trader
 * takes trades — risk per trade, trailing, partials, stop management, and how
 * aggressive each mode is — and the auto trader must respect it". The policies
 * themselves live on the server (`desk-settings.ts`); this dialog is the way in.
 *
 * THREE RULES THIS COMPONENT OBEYS
 *
 *   1. **No setting is hidden.** Every field in `AutoTradeSettings` has a
 *      control here, from the per-trade budget down to the pyramid risk cap.
 *      A knob the dialog cannot name is a knob the owner cannot set — the
 *      defect this surface exists to remove.
 *
 *   2. **The server is the only authority.** Ranges come from `autoTradeBounds`
 *      (the server's own clamp table), presets are applied BY the server when
 *      the user picks a style, and the saved result is whatever the response
 *      echoes. The dialog never re-implements a limit or a preset.
 *
 *   3. **Edits are honest about themselves.** Changing any number inside a mode
 *      makes that mode's stance read "Custom" once saved — the style stops
 *      claiming to be a preset it no longer equals.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Check, Gauge, RotateCcw, Settings2, X } from "lucide-react";

import {
  MODE_STYLE_IDS,
  TRADE_MODES,
  deskApi,
  type AutoTradeSettings,
  type DeskSettingBounds,
  type DeskStateResponse,
  type ManagementSettings,
  type ModeSettings,
  type ModeStyle,
  type ModeStyleLabel,
  type PartialRung,
  type RiskSettings,
  type TradeMode,
  type TrailMode,
} from "@/lib/desk";

interface AutoTradeSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The last `/desk/state` payload: the settings, their bounds and the labels. */
  state: DeskStateResponse | null;
  /** Called after a save, so the caller can refetch the desk. */
  onSaved: () => void;
}

const DEFAULT_BOUNDS: DeskSettingBounds = {
  riskPerTradePct: [0.05, 2],
  riskPerTradeMoney: [1, 1_000_000],
  maxRiskPct: [0.1, 5],
  maxDailyLossPct: [0.5, 10],
  maxDrawdownPct: [1, 30],
  maxOpenPositions: [1, 50],
  maxPositionsPerSymbol: [1, 10],
  maxCurrencyExposurePct: [0.5, 20],
  haltAfterConsecutiveLosses: [2, 20],
  minMarginLevelPct: [150, 5000],
  symbolCooldownMs: [60_000, 24 * 3600_000],
  triggerR: [0.2, 10],
  offsetR: [0, 2],
  structureFallbackR: [0, 2],
  partialAtR: [0.2, 10],
  partialClosePct: [5, 100],
  trailPeriod: [2, 200],
  trailMult: [0.5, 10],
  trailActivateR: [0.2, 10],
  trailStepPoints: [0, 5000],
  trailMinStepAtr: [0, 1],
  pyramidMaxAdds: [0, 5],
  pyramidAddAtR: [0.5, 10],
  pyramidSizeRatio: [0.1, 2],
  pyramidRiskCapR: [0.1, 10],
  timeStopBars: [1, 500],
  newsBlackoutMin: [0, 240],
  maxSpreadPoints: [1, 100_000],
};

const TRAIL_MODES: { id: TrailMode; label: string; blurb: string }[] = [
  { id: "atr_chandelier", label: "Chandelier (ATR)", blurb: "Stop trails the extreme by an ATR multiple — the default in every preset." },
  { id: "structure", label: "Structure", blurb: "Stop follows confirmed swing points, so it respects the market's own turns." },
  { id: "fixed_points", label: "Fixed points", blurb: "Stop trails by a fixed number of points on every step, regardless of volatility." },
];

const TIME_FRAMES = ["M1", "M2", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function AutoTradeSettingsDialog({ open, onClose, state, onSaved }: AutoTradeSettingsDialogProps) {
  const saved = state?.autoTradeSettings ?? null;
  const bounds = state?.autoTradeBounds ?? DEFAULT_BOUNDS;
  const presets = state?.autoTradePresets ?? null;
  const [draft, setDraft] = useState<AutoTradeSettings | null>(null);
  const [mode, setMode] = useState<TradeMode>("intraday");
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-seed whenever the dialog opens or the server hands back a new revision,
  // so what is on screen is always what the desk is actually trading.
  useEffect(() => {
    if (!open) return;
    setDraft(saved ? clone(saved) : null);
    setSavedNote(null);
  }, [open, saved?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => deskApi.settings(patch),
    onSuccess: (data) => {
      const pushed = data.managementPushedTo ?? 0;
      setSavedNote(pushed > 0 ? `Saved — pushed to ${pushed} open position${pushed === 1 ? "" : "s"}.` : "Saved.");
      onSaved();
    },
  });
  const load = useMutation({
    mutationFn: (next: AutoTradeSettings) => deskApi.settings({ autoTradeSettings: next }),
  });
  void load;

  const perMode = draft?.perMode ?? null;
  const current: ModeSettings | null = perMode ? perMode[mode] : null;
  const modeLabel = TRADE_MODES.find((entry) => entry.id === mode)?.label ?? mode;

  const styles = useMemo(
    () =>
      MODE_STYLE_IDS.map((id) => ({
        id,
        ...(presets?.[id] ?? ({ label: id.charAt(0).toUpperCase() + id.slice(1), blurb: "" } as ModeStyleLabel)),
      })),
    [presets],
  );

  if (!open) return null;

  const patch = (fn: (next: AutoTradeSettings) => void) => {
    if (!draft) return;
    const next = clone(draft);
    fn(next);
    setDraft(next);
  };

  const setRisk = <K extends keyof RiskSettings>(key: K, value: RiskSettings[K]) =>
    patch((next) => {
      next.risk[key] = value;
    });

  const setManagement = <K extends keyof ManagementSettings>(key: K, fn: (block: ManagementSettings[K]) => void) =>
    patch((next) => fn(next.perMode[mode].management[key]));

  const setModeRisk = (value: number) =>
    patch((next) => {
      next.perMode[mode].riskPerTradePct = value;
    });

  const applyStyle = (style: ModeStyle) => {
    if (!draft || style === "custom") return;
    // The SERVER applies the preset: sending the style alone (no `management`
    // block) is the documented way to ask for a preset's whole policy, and it
    // keeps one home for the numbers.
    save.mutate({ autoTradeSettings: { perMode: { [mode]: { style } } } });
  };

  const resetModeToPreset = () => {
    if (!draft || !current) return;
    const style = current.style === "custom" ? "balanced" : current.style;
    applyStyle(style);
  };

  const saveDraft = () => {
    if (!draft) return;
    save.mutate({ autoTradeSettings: draft });
  };

  const pushed = state?.autoTradeSettings;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4">
      <div className="max-h-[94dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-zinc-800 bg-zinc-950 shadow-2xl sm:rounded-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Auto-trader settings</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-4 text-[12px] text-zinc-300 sm:p-5">
          {!draft || !current ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5" />
              This desk has not reported its auto-trader settings yet. Reconnect the terminal or reload the Desk, and
              the surface will appear here.
            </p>
          ) : (
            <>
              <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-[11px] leading-relaxed text-zinc-400">
                These are the rules the auto trader trades by. Risk and guards apply to the whole desk; break-even,
                partials, trailing, pyramids and the time stop are per mode, because a scalp and a swing must not share
                one policy. Saving while positions are open pushes the new policy to them on the next heartbeat —
                nothing has to be closed and re-opened for a change to take effect.
              </p>

              {/* ── mode + stance ─────────────────────────────────────────── */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {TRADE_MODES.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setMode(entry.id)}
                      className={`desk-seg-btn${mode === entry.id ? " desk-seg-active" : ""}`}
                      data-testid={`settings-mode-${entry.id}`}
                    >
                      {entry.label}
                    </button>
                  ))}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-zinc-500">{modeLabel} policy</span>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {styles.map((style) => (
                    <button
                      key={style.id}
                      type="button"
                      disabled={save.isPending}
                      onClick={() => applyStyle(style.id)}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        current.style === style.id
                          ? "border-emerald-500/50 bg-emerald-500/10"
                          : "border-zinc-700 bg-zinc-900/60 hover:border-zinc-600"
                      }`}
                      data-testid={`settings-style-${style.id}`}
                    >
                      <span className="flex items-center gap-1.5 text-[12px] font-medium text-zinc-100">
                        {style.label}
                        {current.style === style.id && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                      </span>
                      <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">{style.blurb}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-zinc-500">
                  <span>
                    Stance: <span className="font-medium text-zinc-300">{current.style}</span>
                    {current.style === "custom" ? " — a preset you have edited." : " — the preset's own numbers."}
                  </span>
                  <button type="button" onClick={resetModeToPreset} disabled={save.isPending} className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-50">
                    <RotateCcw className="h-3 w-3" /> Reset {modeLabel.toLowerCase()} to its preset
                  </button>
                </div>
              </section>

              {/* ── risk & budget ─────────────────────────────────────────── */}
              <Section title="Risk & budget" blurb="Applies to every mode. Per-mode budgets below override the desk-wide one.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Per-mode risk" hint={`% of equity risked on a ${modeLabel.toLowerCase()} trade`} value={current.riskPerTradePct} bounds={bounds.riskPerTradePct} step={0.05} onChange={setModeRisk} />
                  <Field label="Risk per trade (desk)" hint="Fallback budget when a mode does not set its own" value={draft.risk.riskPerTradePct} bounds={bounds.riskPerTradePct} step={0.05} onChange={(v) => setRisk("riskPerTradePct", v)} />
                  <Field label="Max risk per trade" hint="Hard ceiling, however the budget is set" value={draft.risk.maxRiskPct} bounds={bounds.maxRiskPct} step={0.1} onChange={(v) => setRisk("maxRiskPct", v)} />
                  <Field label="Max daily loss" hint="% of equity; trading halts for the day" value={draft.risk.maxDailyLossPct} bounds={bounds.maxDailyLossPct} step={0.5} onChange={(v) => setRisk("maxDailyLossPct", v)} />
                  <Field label="Max drawdown" hint="% from the equity peak before the desk stands down" value={draft.risk.maxDrawdownPct} bounds={bounds.maxDrawdownPct} step={1} onChange={(v) => setRisk("maxDrawdownPct", v)} />
                  <Field label="Max open positions" hint="Across every symbol" value={draft.risk.maxOpenPositions} bounds={bounds.maxOpenPositions} step={1} onChange={(v) => setRisk("maxOpenPositions", v)} />
                  <Field label="Max per symbol" hint="One symbol may not crowd the book" value={draft.risk.maxPositionsPerSymbol} bounds={bounds.maxPositionsPerSymbol} step={1} onChange={(v) => setRisk("maxPositionsPerSymbol", v)} />
                  <Field label="Currency exposure cap" hint="% of equity exposed in one currency" value={draft.risk.maxCurrencyExposurePct} bounds={bounds.maxCurrencyExposurePct} step={0.5} onChange={(v) => setRisk("maxCurrencyExposurePct", v)} />
                  <Field label="Halt after losses" hint="Consecutive losses before a pause" value={draft.risk.haltAfterConsecutiveLosses} bounds={bounds.haltAfterConsecutiveLosses} step={1} onChange={(v) => setRisk("haltAfterConsecutiveLosses", v)} />
                  <Field label="Min margin level" hint="% — new entries stop below it" value={draft.risk.minMarginLevelPct} bounds={bounds.minMarginLevelPct} step={5} onChange={(v) => setRisk("minMarginLevelPct", v)} />
                  <Field label="Symbol cooldown" hint="Minutes after a stop-out before re-entry" value={Math.round(draft.risk.symbolCooldownMs / 60_000)} bounds={[bounds.symbolCooldownMs[0] / 60_000, bounds.symbolCooldownMs[1] / 60_000]} step={1} onChange={(v) => setRisk("symbolCooldownMs", Math.round(v * 60_000))} />
                  <Toggle label="Allow live trading" hint="Off = analyse and arm, never send an order" checked={draft.risk.liveTradingEnabled} onChange={(v) => setRisk("liveTradingEnabled", v)} />
                  <Select
                    label="Position sizing"
                    hint="Percent of equity, or a fixed amount per trade"
                    value={draft.risk.sizingMode}
                    options={[{ id: "percent", label: "Percent of equity" }, { id: "fixed_money", label: "Fixed money" }]}
                    onChange={(v) => setRisk("sizingMode", v as RiskSettings["sizingMode"])}
                  />
                  <Field label="Fixed money per trade" hint="Used when sizing is fixed money" value={draft.risk.riskPerTradeMoney} bounds={bounds.riskPerTradeMoney} step={1} suffix="acct ccy" onChange={(v) => setRisk("riskPerTradeMoney", v)} />
                </div>
              </Section>

              {/* ── stop-loss management: break-even ─────────────────────── */}
              <Section title="Stop management — break-even" blurb="When the stop is moved to (and past) entry, per R of progress.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Toggle label="Enabled" hint="Move the stop once the trade is in profit" checked={current.management.breakeven.enabled} onChange={(v) => setManagement("breakeven", (b) => (b.enabled = v))} />
                  <Field label="Trigger" hint="R of progress that arms the move" value={current.management.breakeven.triggerR} bounds={bounds.triggerR} step={0.1} suffix="R" onChange={(v) => setManagement("breakeven", (b) => (b.triggerR = v))} />
                  <Field label="Offset beyond entry" hint="How far past entry+round-trip the stop lands" value={current.management.breakeven.offsetR} bounds={bounds.offsetR} step={0.05} suffix="R" onChange={(v) => setManagement("breakeven", (b) => (b.offsetR = v))} />
                  <Toggle label="Require structure" hint="Wait for a confirmed swing shift before moving. The fallback below still guarantees the move." checked={current.management.breakeven.requireStructure} onChange={(v) => setManagement("breakeven", (b) => (b.requireStructure = v))} />
                  <Field label="Structure fallback" hint="R beyond the trigger after which the stop moves anyway. 0 = wait for structure, however long" value={current.management.breakeven.structureFallbackR} bounds={bounds.structureFallbackR} step={0.05} suffix="R" onChange={(v) => setManagement("breakeven", (b) => (b.structureFallbackR = v))} />
                  <p className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2 text-[10px] leading-relaxed text-zinc-500">
                    The reported bug — “1R in profit and nothing happened” — was a stop waiting for structure that never
                    came. A non-zero fallback is the deadline: at {current.management.breakeven.triggerR}R +
                    {" "}{current.management.breakeven.structureFallbackR}R the stop moves with or without a pivot.
                  </p>
                </div>
              </Section>

              {/* ── partial closes ───────────────────────────────────────── */}
              <Section title="Partial closes" blurb="Bank part of the position at R targets. Rungs are taken in ascending order.">
                <div className="space-y-2">
                  <Toggle label="Enabled" hint="Close a share of the position at each rung" checked={current.management.partials.enabled} onChange={(v) => setManagement("partials", (p) => (p.enabled = v))} />
                  {current.management.partials.rungs.map((rung, index) => (
                    <div key={index} className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
                      <Field label={`Rung ${index + 1} at`} value={rung.atR} bounds={bounds.partialAtR} step={0.1} suffix="R" onChange={(v) => setManagement("partials", (p) => (p.rungs[index].atR = v))} />
                      <Field label="Close" value={rung.closePct} bounds={bounds.partialClosePct} step={5} suffix="%" onChange={(v) => setManagement("partials", (p) => (p.rungs[index].closePct = v))} />
                      <button
                        type="button"
                        onClick={() => setManagement("partials", (p) => { p.rungs.splice(index, 1); })}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:border-red-500/50 hover:text-red-300"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={current.management.partials.rungs.length >= 4}
                      onClick={() => setManagement("partials", (p) => { p.rungs.push({ atR: 1, closePct: 50 } as PartialRung); })}
                      className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-40"
                    >
                      Add a rung
                    </button>
                    <span className="text-[10px] text-zinc-500">
                      {current.management.partials.rungs.length} of 4 rungs · total{" "}
                      {current.management.partials.rungs.reduce((sum, rung) => sum + rung.closePct, 0)}%
                    </span>
                  </div>
                </div>
              </Section>

              {/* ── trailing ─────────────────────────────────────────────── */}
              <Section title="Trailing stop" blurb="How the stop follows the trade once it is running.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Toggle label="Enabled" hint="Trail the stop behind the trade's extreme" checked={current.management.trail.enabled} onChange={(v) => setManagement("trail", (t) => (t.enabled = v))} />
                  <Field label="Activate at" hint="R of progress before the trail starts" value={current.management.trail.activateAtR} bounds={bounds.trailActivateR} step={0.1} suffix="R" onChange={(v) => setManagement("trail", (t) => (t.activateAtR = v))} />
                  <Field label="ATR period" hint="Bars used for the ATR" value={current.management.trail.period} bounds={bounds.trailPeriod} step={1} onChange={(v) => setManagement("trail", (t) => (t.period = v))} />
                  <Field label="ATR multiple" hint="Distance behind the extreme" value={current.management.trail.mult} bounds={bounds.trailMult} step={0.1} suffix="×ATR" onChange={(v) => setManagement("trail", (t) => (t.mult = v))} />
                  <Field label="Min step (points)" hint="Absolute floor for a trail move" value={current.management.trail.stepPoints} bounds={bounds.trailStepPoints} step={1} suffix="pts" onChange={(v) => setManagement("trail", (t) => (t.stepPoints = v))} />
                  <Field label="Min step (ATR)" hint="Skip moves smaller than this share of an ATR" value={current.management.trail.minStepAtr} bounds={bounds.trailMinStepAtr} step={0.05} suffix="×ATR" onChange={(v) => setManagement("trail", (t) => (t.minStepAtr = v))} />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  {TRAIL_MODES.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setManagement("trail", (t) => (t.mode = entry.id))}
                      className={`rounded-lg border p-2.5 text-left transition-colors ${
                        current.management.trail.mode === entry.id ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-700 bg-zinc-900/60 hover:border-zinc-600"
                      }`}
                    >
                      <span className="block text-[12px] font-medium text-zinc-100">{entry.label}</span>
                      <span className="mt-1 block text-[10px] leading-relaxed text-zinc-500">{entry.blurb}</span>
                    </button>
                  ))}
                </div>
              </Section>

              {/* ── pyramids ─────────────────────────────────────────────── */}
              <Section title="Pyramid adds" blurb="Add to a winner — only while the base trade is protected.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Toggle label="Enabled" hint="Allow adds in the trade's direction" checked={current.management.pyramid.enabled} onChange={(v) => setManagement("pyramid", (p) => (p.enabled = v))} />
                  <Field label="Max adds" value={current.management.pyramid.maxAdds} bounds={bounds.pyramidMaxAdds} step={1} onChange={(v) => setManagement("pyramid", (p) => (p.maxAdds = v))} />
                  <Field label="Add at" hint="R of progress before the first add" value={current.management.pyramid.addAtR} bounds={bounds.pyramidAddAtR} step={0.1} suffix="R" onChange={(v) => setManagement("pyramid", (p) => (p.addAtR = v))} />
                  <Field label="Size ratio" hint="Add size relative to the base position" value={current.management.pyramid.sizeRatio} bounds={bounds.pyramidSizeRatio} step={0.1} suffix="×" onChange={(v) => setManagement("pyramid", (p) => (p.sizeRatio = v))} />
                  <Field label="Portfolio risk cap" value={current.management.pyramid.portfolioRiskCapR} bounds={bounds.pyramidRiskCapR} step={0.1} suffix="R" onChange={(v) => setManagement("pyramid", (p) => (p.portfolioRiskCapR = v))} />
                  <Toggle label="Base at break-even first" hint="Never add while the base is still at risk" checked={current.management.pyramid.requireBaseAtBreakeven} onChange={(v) => setManagement("pyramid", (p) => (p.requireBaseAtBreakeven = v))} />
                </div>
              </Section>

              {/* ── time stop ────────────────────────────────────────────── */}
              <Section title="Time stop" blurb="Cut a trade that has gone nowhere for too long.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Toggle label="Enabled" checked={current.management.timeStop.enabled} onChange={(v) => setManagement("timeStop", (t) => (t.enabled = v))} />
                  <Field label="No progress for" value={current.management.timeStop.noProgressBars} bounds={bounds.timeStopBars} step={1} suffix="bars" onChange={(v) => setManagement("timeStop", (t) => (t.noProgressBars = v))} />
                  <Select
                    label="Timeframe"
                    hint="Bars are counted on this frame; entry frame when unset"
                    value={current.management.timeStop.timeframe ?? ""}
                    options={[{ id: "", label: "Entry timeframe" }, ...TIME_FRAMES.map((tf) => ({ id: tf, label: tf }))]}
                    onChange={(v) => setManagement("timeStop", (t) => (t.timeframe = v === "" ? null : v))}
                  />
                </div>
              </Section>

              {/* ── guards ───────────────────────────────────────────────── */}
              <Section title="Entry guards" blurb="Conditions that pause entries rather than change open trades.">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Max spread" hint="Points at fill. Leave 0 to derive it from the asset's own cost" value={current.management.guards.maxSpreadPoints ?? 0} bounds={[0, bounds.maxSpreadPoints[1]]} step={1} suffix="pts" onChange={(v) => setManagement("guards", (g) => (g.maxSpreadPoints = v <= 0 ? null : v))} />
                  <Field label="News blackout" hint="Minutes either side of a red-folder release" value={current.management.guards.newsBlackoutMin} bounds={bounds.newsBlackoutMin} step={5} suffix="min" onChange={(v) => setManagement("guards", (g) => (g.newsBlackoutMin = v))} />
                  <Toggle label="Flat before session close" hint="Scalp/intraday only — a swing trade is allowed to hold" checked={current.management.guards.flatBeforeSessionClose} onChange={(v) => setManagement("guards", (g) => (g.flatBeforeSessionClose = v))} />
                </div>
              </Section>

              {save.error instanceof Error && (
                <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed text-red-200">
                  Could not save the settings: {save.error.message}
                </p>
              )}
              {save.isSuccess && savedNote && (
                <p className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-[11px] text-emerald-200">
                  <Check className="h-3.5 w-3.5" /> {savedNote}
                </p>
              )}
              {pushed && pushed.version !== draft.version && (
                <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-200">
                  The server stores settings version {pushed.version}; this dialog edits version {draft.version}. Update
                  the Desk before saving.
                </p>
              )}

              <div className="sticky bottom-0 -mx-4 -mb-4 flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-950 px-4 py-3 sm:-mx-5 sm:-mb-5 sm:px-5">
                <span className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                  <Gauge className="h-3.5 w-3.5" /> Applied by the desk on the next heartbeat — open positions included.
                </span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={onClose} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-900">
                    Close
                  </button>
                  <button
                    type="button"
                    disabled={save.isPending}
                    onClick={saveDraft}
                    data-testid="settings-save"
                    className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-medium text-emerald-200 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {save.isPending ? "Saving…" : "Apply settings"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
      <h3 className="text-[12px] font-semibold text-zinc-100">{title}</h3>
      <p className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">{blurb}</p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  value,
  bounds,
  step,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  bounds?: readonly [number, number];
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  const [min, max] = bounds ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2 text-[11px] text-zinc-300">
        <span>{label}</span>
        {suffix && <span className="text-[10px] text-zinc-500">{suffix}</span>}
      </span>
      <input
        type="number"
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[12px] text-zinc-100 outline-none focus:border-emerald-500/60"
        value={Number.isFinite(value) ? value : 0}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step ?? 1}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, next)));
        }}
      />
      {hint && <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">{hint}</span>}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-[11px] text-zinc-300">
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

function Select({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[11px] text-zinc-300">{label}</span>
      <select
        className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-emerald-500/60"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <span className="mt-0.5 block text-[10px] leading-relaxed text-zinc-500">{hint}</span>}
    </label>
  );
}
