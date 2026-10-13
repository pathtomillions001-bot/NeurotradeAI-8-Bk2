/**
 * v5 Desk — the 48px title bar.
 *
 * One strip, left to right: what the Desk is, where its data comes from
 * (source / stream / v4 chips), the three numbers that matter at a glance
 * (equity, day %, open risk), and every control that acts on the whole desk
 * (trade mode, timezone, auto-trade, the MT5 bridge, FLATTEN).
 *
 * All five historical data-testids live here and survive unlinked: the
 * controls are disabled before pairing, never absent, so an operator's muscle
 * memory and every existing test keep working.
 */
import { Globe, Link2, Power, Unplug, Zap } from "lucide-react";

import { TRADE_MODES, type DeskTimezone, type DeskV4Summary, type TradeMode } from "@/lib/desk";
import { formatSignedPct } from "@/lib/desk-ui";

import { Badge, type Tone } from "./primitives";

export interface TitleBarProps {
  /** "MT5 LIVE" | "MT5 WARMING" | "MT5 STALE" | "MT5 REQUIRED" — computed by the page. */
  sourceLabel: string;
  sourceTone: Tone;
  /** True while SSE events are actually arriving (chip reads STREAM, else POLL). */
  streaming: boolean;
  /** v4 layer summary; absent on an older server ⇒ no V4 chip. */
  v4?: DeskV4Summary | null;
  /** Formatted equity ("—" when there is none). */
  equity: string;
  currency: string;
  /** Day % versus the day-start stamp, or null (an em dash, never 0). */
  dayPct: number | null;
  /** Formatted open-risk line, e.g. "1.25% of 3.5%". */
  openRisk: string;
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
  onFlatten: () => void;
  flattenBusy: boolean;
}

export function TitleBar(props: TitleBarProps) {
  const {
    sourceLabel, sourceTone, streaming, v4, equity, currency, dayPct, openRisk,
    mode, onMode, controlsEnabled, settingsBusy, autoTrade, onAutoTrade,
    timeZone, timezones, onTimeZone, bridgeLabel, hasTerminal, onOpenBridge, onFlatten, flattenBusy,
  } = props;

  const dayTone: Tone = dayPct === null ? "mute" : dayPct > 0 ? "up" : dayPct < 0 ? "dn" : "tx";
  const zones = timezones.length > 0 ? timezones : [{ id: timeZone, label: timeZone }];

  return (
    <header className="desk-titlebar">
      <span className="desk-dot d-up" aria-hidden="true" />
      <span className="t-title d-tx hidden shrink-0 tracking-widest sm:inline">DESK</span>

      <Badge tone={sourceTone} title="Where the Desk's data comes from">
        <span data-testid="data-source">{sourceLabel}</span>
      </Badge>
      <span
        className={`desk-badge${streaming ? " desk-badge-cy" : ""}`}
        title={streaming ? "Prices are pushed the instant the terminal heartbeats" : "No fresh prices are arriving — falling back to fast polling"}
      >
        <span className={`desk-dot ${streaming ? "d-cy" : "d-mute"}`} aria-hidden="true" />
        <span data-testid="stream-status">{streaming ? "STREAM" : "POLL"}</span>
      </span>
      {v4 ? (
        v4.enabled && !v4.shadow ? (
          <Badge tone="up" title="The v4 guard layers are computing and gating live orders">V4 LIVE</Badge>
        ) : v4.shadow ? (
          <Badge tone="am" title="The v4 guard layers compute and record, but never place a live order">V4 SHADOW</Badge>
        ) : (
          <Badge tone="mute" title="The v4 guard layers are switched off on this server">V4 OFF</Badge>
        )
      ) : null}

      {/* The three key numbers: hidden below 1280px, where panels need the room. */}
      <div className="hidden min-w-0 shrink items-center gap-4 xl:flex" data-testid="key-numbers">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="t-cap d-mute">Equity</span>
          <span className="t-tile d-tx tnum truncate">{equity}</span>
          <span className="t-cap d-mute">{currency}</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="t-cap d-mute">Day</span>
          <span className={`t-title tnum ${dayTone === "tx" ? "d-tx" : `d-${dayTone}`}`}>{formatSignedPct(dayPct)}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="t-cap d-mute">Open risk</span>
          <span className="t-title d-tx tnum truncate">{openRisk}</span>
        </span>
      </div>

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
