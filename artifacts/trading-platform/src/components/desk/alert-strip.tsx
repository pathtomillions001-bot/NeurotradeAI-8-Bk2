/**
 * v5 Desk — the 32px alert strip.
 *
 * One slot, most severe first (buildAlerts in desk-ui.ts owns the ordering:
 * halt > feed mismatch > stale > reconnecting > action error). The rest wait
 * behind "+N more", which cycles the slot — the strip never grows into the
 * grid, and the grid never overlaps it. The copy is the v4 banners' own, so
 * an alarm reads exactly like the thing it replaced.
 */
import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import type { DeskAlert } from "@/lib/desk-ui";

export function AlertStrip({ alerts }: { alerts: DeskAlert[] }) {
  const [index, setIndex] = useState(0);
  // When the alert set changes shape, start over at the most severe.
  const signature = alerts.map((alert) => alert.id).join("|");
  useEffect(() => setIndex(0), [signature]);

  if (alerts.length === 0) return null;
  const safeIndex = Math.min(index, alerts.length - 1);
  const alert = alerts[safeIndex];
  if (!alert) return null;

  const toneClass = alert.tone === "rose" ? "d-dn" : alert.tone === "amber" ? "d-am" : "d-cy";

  return (
    <div className="desk-alertstrip" role="status" aria-live="polite" data-testid="alert-strip">
      <div className={`desk-alert desk-alert-${alert.tone}`}>
        <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${toneClass}`} aria-hidden="true" />
        <span className={`t-cap shrink-0 font-semibold uppercase tracking-wider ${toneClass}`}>{alert.title}</span>
        <span className="t-body d-tx2 truncate">{alert.text}</span>
        {alerts.length > 1 ? (
          <button
            type="button"
            className="desk-btn ml-auto shrink-0"
            onClick={() => setIndex((safeIndex + 1) % alerts.length)}
            aria-label={`Show the next of ${alerts.length} alerts`}
            data-testid="alert-more"
          >
            +{alerts.length - 1} more
          </button>
        ) : null}
      </div>
    </div>
  );
}
