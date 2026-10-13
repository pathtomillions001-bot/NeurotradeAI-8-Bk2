/**
 * v5 Desk — the 60px stat strip.
 *
 * The context strip's non-Command variant: eight tiles that repeat the
 * desk-wide numbers on the workspaces where the title bar's key numbers are
 * not the point (Markets, Learning, Journal). Command replaces this strip
 * with the decision pipeline.
 *
 * Tiles are dumb: the page computes every value (from the API, through
 * desk-ui's formatters) and passes strings — an unavailable number arrives as
 * "—" and is rendered exactly like that. Below 1024px the strip becomes 4×2.
 */
import type { Tone } from "./primitives";

export interface StatTile {
  id: string;
  label: string;
  /** Pre-formatted value; "—" when the API has nothing. */
  value: string;
  tone?: Tone;
  /** Optional second line (e.g. the money behind a day %). */
  sub?: string | null;
  title?: string;
}

export function StatStrip({ tiles }: { tiles: StatTile[] }) {
  return (
    <div className="desk-statstrip" data-testid="stat-strip">
      {tiles.map((tile) => (
        <div key={tile.id} className="desk-tile" data-tile={tile.id} title={tile.title ?? (tile.sub ? `${tile.label}: ${tile.sub}` : undefined)}>
          <span className="t-cap d-mute truncate">{tile.label}</span>
          <span className={`t-tile tnum truncate ${tile.tone ? `d-${tile.tone}` : "d-tx"}`}>{tile.value}</span>
          {tile.sub ? <span className="t-cap d-mute truncate">{tile.sub}</span> : null}
        </div>
      ))}
    </div>
  );
}
