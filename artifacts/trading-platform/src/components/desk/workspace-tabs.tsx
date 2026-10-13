/**
 * v5 Desk — the 40px workspace tab bar.
 *
 * Command | Markets | Learning | Journal & performance. A real ARIA tablist:
 * roving tabindex, arrow keys move AND select, Home/End jump. The workspace
 * grid in desk-shell.tsx is the single tabpanel these tabs control.
 *
 * Badges are counts, never decorations: Markets carries the watchlist size,
 * Learning carries the number of governed agents that are halved or disabled
 * (amber — something there needs a human). The right edge keeps the old
 * desk's context sentence: which symbol and mode every panel is describing.
 */
import { useRef, type KeyboardEvent } from "react";

import { DESK_TABS, DESK_TAB_LABELS, type DeskTab } from "./desk-layout";
import type { Tone } from "./primitives";

export interface WorkspaceTabBadge {
  count: number;
  tone: Tone;
  /** Accessible description of what the count means. */
  label: string;
}

export interface WorkspaceTabsProps {
  tab: DeskTab;
  onTab: (tab: DeskTab) => void;
  badges?: Partial<Record<DeskTab, WorkspaceTabBadge>>;
  /** Right-hand context, e.g. "Selected EURUSD · Intraday". */
  context?: string;
}

export function WorkspaceTabs({ tab, onTab, badges, context }: WorkspaceTabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusTab = (next: DeskTab) => {
    onTab(next);
    refs.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = DESK_TABS.length - 1;
    let target: number | null = null;
    if (event.key === "ArrowRight") target = index === lastIndex ? 0 : index + 1;
    else if (event.key === "ArrowLeft") target = index === 0 ? lastIndex : index - 1;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = lastIndex;
    if (target === null) return;
    event.preventDefault();
    const nextTab = DESK_TABS[target];
    if (nextTab) focusTab(nextTab);
  };

  return (
    <div className="desk-tabbar">
      <div role="tablist" aria-label="Desk workspaces" className="flex min-w-0 items-stretch">
        {DESK_TABS.map((entry, index) => {
          const active = entry === tab;
          const badge = badges?.[entry];
          return (
            <button
              key={entry}
              ref={(node) => {
                refs.current[entry] = node;
              }}
              type="button"
              role="tab"
              id={`desk-tab-${entry}`}
              aria-selected={active}
              aria-controls={`desk-workspace-${entry}`}
              tabIndex={active ? 0 : -1}
              className={`desk-tab${active ? " desk-tab-active" : ""}`}
              onClick={() => onTab(entry)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {DESK_TAB_LABELS[entry]}
              {badge && badge.count > 0 ? (
                <span
                  className={`desk-badge${badge.tone === "tx" || badge.tone === "mute" ? "" : ` desk-badge-${badge.tone}`}`}
                  title={badge.label}
                >
                  {badge.count}
                  <span className="sr-only"> {badge.label}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {context ? <span className="t-cap d-mute ml-auto hidden shrink-0 self-center md:inline" data-testid="desk-context-label">{context}</span> : null}
    </div>
  );
}
