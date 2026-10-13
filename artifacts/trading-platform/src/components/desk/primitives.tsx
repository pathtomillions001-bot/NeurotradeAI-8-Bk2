/**
 * v5 Desk — the shared visual vocabulary.
 *
 * Badge, Meter, Chip, Table: the small set of pieces every panel is built
 * from. Two rules run through all of them:
 *
 *  1. Colour is never the only signal — a badge always carries a word or a
 *     mark, a meter always sits beside the number it draws.
 *  2. Tables take ONE column template and ONE row height from desk-layout's
 *     TABLES registry; the header and every row share the exact template, so
 *     columns cannot drift between panels or between renders.
 *
 * Missing data renders as an em dash by the caller (desk-ui's formatters);
 * these components never invent a value.
 */
import { createContext, useContext, type ReactNode } from "react";

import { TABLES, TABLE_HEADER_HEIGHT, type TableId } from "./desk-layout";

/** The Desk's fixed colour meanings (documented at the top of desk.css). */
export type Tone = "up" | "dn" | "am" | "cy" | "vi" | "mute" | "tx";

// ── numbers ─────────────────────────────────────────────────────────────────

/** A tabular-figure span: every number on the Desk wears this. */
export function Num({ children, className, tone }: { children: ReactNode; className?: string; tone?: Tone }) {
  const toneClass = tone ? ` d-${tone}` : "";
  return <span className={`tnum${toneClass}${className ? ` ${className}` : ""}`}>{children}</span>;
}

// ── badge ───────────────────────────────────────────────────────────────────

export function Badge({ tone = "mute", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  const toneClass = tone === "tx" || tone === "mute" ? "" : ` desk-badge-${tone}`;
  return (
    <span className={`desk-badge${toneClass}`} title={title}>
      {children}
    </span>
  );
}

// ── meter ───────────────────────────────────────────────────────────────────

/**
 * A 4px progress bar — the only "bar" the Desk draws, and always decoration
 * beside a printed number (aria-hidden). A null fraction draws an empty
 * track: an unknown value is not a zero value.
 */
export function Meter({ fraction, tone = "cy", className }: { fraction: number | null; tone?: Tone; className?: string }) {
  const pct = fraction === null ? null : Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={`desk-meter d-${tone}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {pct !== null ? <div className="desk-meter-fill" style={{ width: `${pct}%` }} /> : null}
    </div>
  );
}

// ── chip ────────────────────────────────────────────────────────────────────

export function Chip({ active, onClick, children, title }: { active?: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      className={`desk-chip${active ? " desk-chip-active" : ""}`}
      onClick={onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      title={title}
    >
      {children}
    </button>
  );
}

// ── tables ──────────────────────────────────────────────────────────────────

interface TableSpecCtx {
  columns: string;
  rowHeight: number;
}
const SpecContext = createContext<TableSpecCtx | null>(null);

function useSpec(id?: TableId): TableSpecCtx {
  const fromContext = useContext(SpecContext);
  if (id) return TABLES[id];
  if (!fromContext) throw new Error("Desk TR used outside a Desk Table");
  return fromContext;
}

export interface TableProps {
  /** The registry key: the single source of this table's columns and row height. */
  id: TableId;
  /** Column headers, one per template column; null leaves a column unheaded. */
  head?: (ReactNode | null)[];
  className?: string;
  children: ReactNode;
}

export function Table({ id, head, className, children }: TableProps) {
  const spec = TABLES[id];
  return (
    <SpecContext.Provider value={spec}>
      <div className={className} data-table={id}>
        {head ? (
          <div
            className="desk-tr desk-thead t-cap"
            style={{ gridTemplateColumns: spec.columns, height: TABLE_HEADER_HEIGHT }}
          >
            {head.map((cell, index) => (
              // eslint-disable-next-line react/no-array-index-key -- header cells are positional by design
              <div key={index} className="truncate font-medium">
                {cell ?? ""}
              </div>
            ))}
          </div>
        ) : null}
        {children}
      </div>
    </SpecContext.Provider>
  );
}

export interface TRProps {
  /** Optional registry key when the row is rendered outside a Table. */
  id?: TableId;
  /** Clickable rows become real <button>s — keyboard and focus ring for free. */
  onClick?: () => void;
  selected?: boolean;
  title?: string;
  className?: string;
  "data-testid"?: string;
  children: ReactNode;
}

export function TR({ id, onClick, selected, title, className, children, ...rest }: TRProps) {
  const spec = useSpec(id);
  const style = { gridTemplateColumns: spec.columns, height: `${spec.rowHeight}px` };
  const classes = `desk-tr t-body${selected ? " desk-row-selected" : ""}${className ? ` ${className}` : ""}`;
  const testId = rest["data-testid"];
  if (onClick) {
    return (
      <button type="button" className={classes} style={style} onClick={onClick} title={title} aria-pressed={selected} data-testid={testId}>
        {children}
      </button>
    );
  }
  return (
    <div className={classes} style={style} title={title} data-testid={testId}>
      {children}
    </div>
  );
}

/** A 28px sticky sub-header inside a panel body ("Open positions" / "Plans"). */
export function SubHeader({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="desk-subheader">
      <span className="truncate">{children}</span>
      {right ? <span className="t-cap d-mute ml-auto flex shrink-0 items-center gap-2 font-normal normal-case tracking-normal">{right}</span> : null}
    </div>
  );
}

// ── empty / loading states ──────────────────────────────────────────────────

export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="desk-empty">
      <span aria-hidden="true" className="t-tile d-mute">—</span>
      <span>{children}</span>
    </div>
  );
}

/** Static placeholder rows while a query is in flight (no shimmer: the Desk is calm). */
export function SkeletonRows({ rows, columns = 3 }: { rows: number; columns?: number }) {
  return (
    <div className="flex flex-col gap-2 p-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        // eslint-disable-next-line react/no-array-index-key -- placeholders carry no identity
        <div key={rowIndex} className="flex gap-2">
          {Array.from({ length: columns }, (_, colIndex) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={colIndex} className="desk-skel flex-1" style={{ maxWidth: colIndex === 0 ? "40%" : undefined }} />
          ))}
        </div>
      ))}
    </div>
  );
}
