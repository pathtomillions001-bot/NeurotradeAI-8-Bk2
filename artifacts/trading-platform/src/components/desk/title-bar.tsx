/**
 * v5 Desk — the 48px title bar.
 *
 * One strip, left to right: what the Desk is, and every control that acts on
 * the whole desk (trade mode, timezone, auto-trade, the MT5 bridge, the
 * auto-trader settings, FLATTEN).
 *
 * ── WHAT IS DELIBERATELY NOT HERE ANY MORE ──────────────────────────────────
 *
 * The bar used to carry three informational blocks as well: the data-source
 * badge (MT5 LIVE / STALE / WARMING), the stream badge (STREAM / POLL), the v4
 * layer chip and the key-numbers block (Equity, Day %, open risk). Between
 * 1024 and 1279 px those blocks plus the controls exceeded the row, and the
 * chips visually overlapped the mode control. They are deleted, not hidden:
 *
 *   • source and stream state       → status bar + Feed & health panel
 *   • the v4 layer flags            → the Learning workspace's own headers
 *   • equity / day / open risk      → the stat strip tiles on every other
 *                                     workspace (and the Command panels)
 *
 * The bar is now only what the operator acts on, so it cannot overflow at any
 * width the Desk supports. `open-settings` is the one addition: the auto-trader
 * settings (risk per trade, per-mode management policy) hang off it.
 */
import { Globe, Link2, Power, Settings, Unplug, Zap } from "lucide-react";

import { TRADE_MODES, type DeskTimezone, type TradeMode } from "@/lib/desk";

export interface TitleBarProps {
  mode: TradeMode;
  onMode: (mode: TradeMode) => void;
  /** Mode/auto/timezone controls need a live terminal and an idle mutation. */
  controlsEnabled: boolean;
  settingsBusy: boolean;
  autoTrade: boolean;
  onAutoTrade: () => void;
  timeZone: string;
  timezones: DeskTimezone[];
  onTimeZone: (id: string) => void;
  /** "MT5 12345678" when paired, "Link MT5" when not. */
  bridgeLabel: string;
  hasTerminal: boolean;
  onOpenBridge: () => void;
  /** Opens the auto-trader settings dialog (risk, per-mode management policy). */
  onOpenSettings: () => void;
  onFlatten: () => void;
  flattenBusy: boolean;
}

export function TitleBar(props: TitleBarProps) {
  const {
    mode, onMode, controlsEnabled, settingsBusy, autoTrade, onAutoTrade,
    timeZone, timezones, onTimeZone, bridgeLabel, hasTerminal, onOpenBridge,
    onOpenSettings, onFlatten, flattenBusy,
  } = props;

  const zones = timezones.length > 0 ? timezones : [{ id: timeZone, label: timeZone }];

  return (
    <header className="desk-titlebar">
      <span className="desk-dot d-up" aria-hidden="true" />
      <span className="t-title d-tx hidden shrink-0 tracking-widest sm:inline">DESK</span>

      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5 overflow-x-auto">
        <div className="desk-seg" role="group" aria-label="Trade mode">
          {TRADE_MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`desk-seg-btn${mode === entry.id ? " desk-seg-active" : ""}`}
              disabled={!controlsEnabled || settingsBusy}
              onClick={() => onMode(entry.id)}
              title={`${entry.label} — ${entry.blurb}`}
              aria-pressed={mode === entry.id}
              data-testid={`mode-${entry.id}`}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <label className="flex shrink-0 items-center gap-1" title="Timezone for every timestamp on the desk">
          <Globe className="h-3 w-3 d-mute" aria-hidden="true" />
          <select
            value={timeZone}
            disabled={settingsBusy}
            onChange={(event) => onTimeZone(event.target.value)}
            className="desk-btn max-w-[130px] appearance-none pr-4"
            data-testid="timezone-select"
            aria-label="Desk timezone"
          >
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id} className="bg-[var(--desk-s2)] text-[var(--desk-tx)]">
                {zone.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`desk-btn${autoTrade ? " d-up" : ""}`}
          style={autoTrade ? { borderColor: "color-mix(in srgb, var(--desk-up) 45%, transparent)", background: "color-mix(in srgb, var(--desk-up) 8%, transparent)" } : undefined}
          disabled={!controlsEnabled || settingsBusy}
          onClick={onAutoTrade}
          aria-pressed={autoTrade}
          title={autoTrade ? "The agent may place its own orders — switch off to require manual arming" : "Manual mode: nothing is placed unless you arm it"}
          data-testid="auto-trade-toggle"
        >
          <Zap className="h-3 w-3" aria-hidden="true" />Auto {autoTrade ? "ON" : "OFF"}
        </button>

        <button
          type="button"
          className="desk-btn"
          onClick={onOpenSettings}
          title="Auto-trader settings: risk per trade, stops, partials, trailing, pyramid — per mode"
          data-testid="open-settings"
        >
          <Settings className="h-3 w-3" aria-hidden="true" />Settings
        </button>

        <button
          type="button"
          className="desk-btn"
          onClick={onOpenBridge}
          title="MT5 bridge: pairing, link health and the EA download"
          data-testid="open-bridge"
        >
          {hasTerminal ? <Link2 className="h-3 w-3 d-up" aria-hidden="true" /> : <Unplug className="h-3 w-3" aria-hidden="true" />}
          {bridgeLabel}
        </button>

        <button
          type="button"
          className="desk-btn desk-btn-danger"
          disabled={!hasTerminal || flattenBusy}
          onClick={onFlatten}
          title="Cancel every armed plan and request all MT5 positions be closed"
          data-testid="kill-switch"
        >
          <Power className="h-3 w-3" aria-hidden="true" />FLATTEN
        </button>
      </div>
    </header>
  );
}
