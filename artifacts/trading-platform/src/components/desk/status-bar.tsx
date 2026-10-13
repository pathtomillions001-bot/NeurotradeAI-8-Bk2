/**
 * v5 Desk — the 28px status bar.
 *
 * The quiet telemetry line: how many feeds are fresh / warming / stale (and
 * whether any price disagrees with its own candles), how long ago the stream
 * last beat, which EA version is connected, and the broker-side server clock
 * in the desk's timezone. The server time is stamped by /state and advanced
 * locally by the same offset, so it ticks without asking the API every second
 * — and shows an em dash, not the browser's clock, until the first stamp
 * lands. The browser clock is never presented as the server's.
 */
import { useEffect, useState } from "react";

import { formatInZone, zoneAbbreviation } from "@/lib/desk";

export interface StatusBarProps {
  fresh: number;
  warming: number;
  stale: number;
  mismatch: number;
  /** Server timestamp of the last SSE event (useDeskStream's lastEventAt). */
  lastEventAt: number | null;
  /** EA version from the bridge status report; null before the first heartbeat. */
  eaVersion?: string | null;
  /** /state's serverTime stamp… */
  serverTime: number | null;
  /** …and the moment the client received it (the query's dataUpdatedAt). */
  stateFetchedAt: number | null;
  timeZone: string;
}

export function StatusBar({ fresh, warming, stale, mismatch, lastEventAt, eaVersion, serverTime, stateFetchedAt, timeZone }: StatusBarProps) {
  // One local tick a second: enough for a clock and a beat age, cheap enough
  // to leave running. Reduced motion is irrelevant — no animation, just text.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const serverNow = serverTime !== null && stateFetchedAt !== null ? serverTime + (now - stateFetchedAt) : null;
  const beatSeconds =
    serverNow !== null && lastEventAt !== null ? Math.max(0, (serverNow - lastEventAt) / 1000) : null;
  const clockLabel =
    serverNow !== null
      ? `${formatInZone(serverNow, timeZone, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })} ${zoneAbbreviation(serverNow, timeZone)}`
      : "—";

  return (
    <footer className="desk-statusbar" data-testid="status-bar">
      <span className="tnum shrink-0" data-testid="feed-counts">
        <span className="d-up">{fresh} fresh</span>
        <span className="d-mute"> · </span>
        <span className={warming > 0 ? "d-am" : "d-mute"}>{warming} warming</span>
        <span className="d-mute"> · </span>
        <span className={stale > 0 ? "d-am" : "d-mute"}>{stale} stale</span>
        {mismatch > 0 ? (
          <>
            <span className="d-mute"> · </span>
            <span className="d-dn" title="A price that disagrees with its own candles — trading on it is blocked">
              {mismatch} mismatch
            </span>
          </>
        ) : null}
      </span>

      <span className="d-mute shrink-0" title="How long ago the live stream last beat">
        beat <span className="tnum d-tx2" data-testid="stream-beat">{beatSeconds !== null ? `${beatSeconds.toFixed(1)}s` : "—"}</span>
      </span>

      <span className="d-mute hidden shrink-0 sm:inline" title="The connected MT5 expert advisor">
        EA <span className="d-tx2" data-testid="ea-version">{eaVersion ?? "—"}</span>
      </span>

      <span className="d-mute ml-auto shrink-0" title="Broker-side server clock, in the desk's timezone">
        server <span className="tnum d-tx2" data-testid="server-time">{clockLabel}</span>
      </span>
    </footer>
  );
}
