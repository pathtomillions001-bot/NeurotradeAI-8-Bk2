/**
 * Runs bridge — the host half of the Bot Studio ⇄ NeuroTrade handshake.
 *
 * A DBot is executed by the vendored builder INSIDE the iframe: the tab owns the
 * WebSocket, so only the tab knows when the user pressed Run. The app still has
 * to own everything that follows, because the app is what grants trading rights:
 *
 *   · POST /api/dbots/:id/live      claims the account's one-engine lock, so a
 *                                   server engine can never trade next to a DBot.
 *   · POST /api/dbots/:id/heartbeat keeps the run alive AND mirrors newly
 *                                   settled fills into the journal + the shared
 *                                   recovery ledger.
 *   · POST /api/dbots/:id/stop      releases the lock (badge, account switch,
 *                                   page close).
 *
 * The builder posts `dbot:running {running, dbotId}` whenever that changes; this
 * hook turns it into those calls and, when the RUN must end (the lock was
 * refused, the API asked for a stop — e.g. the demo/real switch), tells the
 * iframe `neurotrade:stop-bot` because the tab is the only place with a stop
 * button.
 *
 * Fills are mirrored server-side on purpose: the heartbeat is the app's proof
 * that a bot is alive, so it is also the only moment the app can trust a fill is
 * fresh. See lib/dbots/mirror.ts.
 */

import { useEffect, type RefObject } from "react";
import { toast } from "sonner";

const HEARTBEAT_MS = 10_000;

export function useDbotRunBridge(
  dbotId: string | null,
  iframeRef?: RefObject<HTMLIFrameElement | null>,
  onRunStateChange?: (running: boolean) => void,
) {
  useEffect(() => {
    if (!dbotId) return;
    const frame = iframeRef?.current ?? null;
    const post = (type: string) => {
      const target = iframeRef?.current?.contentWindow ?? frame?.contentWindow ?? null;
      target?.postMessage({ type }, window.location.origin);
    };

    let running = false;
    let beat: number | undefined;

    const stopBeating = () => {
      if (beat !== undefined) { window.clearInterval(beat); beat = undefined; }
    };

    const heartbeat = async () => {
      try {
        const res = await fetch(`/api/dbots/${dbotId}/heartbeat`, { method: "POST" });
        const data = (await res.json().catch(() => null)) as
          | { stopRequested?: boolean; newFills?: number }
          | null;
        if (!res.ok || data?.stopRequested) {
          // The app asked this run to end (badge Stop, account switch, or the
          // demo/real flip). The tab still owns execution — tell it to stop.
          running = false;
          stopBeating();
          onRunStateChange?.(false);
          post("neurotrade:stop-bot");
          toast.info("This DBot was stopped — the account's engine lock was released");
          return;
        }
        if (data?.newFills) toast.success(`${data.newFills} DBot fill${data.newFills === 1 ? "" : "s"} mirrored to your journal`);
      } catch {
        /* keep the run: a transient network error must not kill a live bot */
      }
    };

    const start = async () => {
      try {
        const res = await fetch(`/api/dbots/${dbotId}/live`, { method: "POST" });
        const data = (await res.json().catch(() => null)) as { error?: string; blockingBotId?: string } | null;
        if (!res.ok) {
          toast.error(data?.error ?? "Could not register the DBot — another engine may be running");
          post("neurotrade:stop-bot");
          return;
        }
        running = true;
        onRunStateChange?.(true);
        stopBeating();
        beat = window.setInterval(heartbeat, HEARTBEAT_MS);
        toast.success("DBot running — fills will mirror into your journal");
      } catch {
        toast.error("Could not register the DBot run");
        post("neurotrade:stop-bot");
      }
    };

    const stop = async (reason: string) => {
      running = false;
      stopBeating();
      onRunStateChange?.(false);
      try {
        await fetch(`/api/dbots/${dbotId}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        });
      } catch {
        /* the registry's heartbeat TTL releases the lock anyway */
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; running?: boolean; dbotId?: string } | undefined;
      if (data?.type !== "dbot:running") return;
      if (data.dbotId && data.dbotId !== dbotId) return;
      if (data.running) void start();
      else void stop("builder");
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      stopBeating();
      // Leaving Bot Studio closes the tab that owns the socket, so the run ends.
      if (running) void stop("page-closed");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbotId]);
}
