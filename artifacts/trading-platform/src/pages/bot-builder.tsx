import { useCallback, useEffect, useRef } from "react";
import { useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import {
  adoptBotBuilderFrame,
  releaseBotBuilderFrame,
  syncBotBuilderSession,
} from "@/lib/bot-builder-frame";

/**
 * Full-height embedding of the Deriv bot builder.
 *
 * - No page chrome of its own (the builder draws its own header) — the iframe
 *   gets the entire content height below the app's top bar.
 * - The builder renders at 80% scale (CSS zoom) so the whole workspace, tool
 *   panel and charts fit comfortably on screen instead of cropping.
 * - The iframe is a persistent singleton (see lib/bot-builder-frame.ts): it is
 *   preloaded when the app shell mounts and merely MOVED into this page, so
 *   opening Bot Builder is instant and the builder keeps its state between
 *   visits.
 */
export default function BotBuilder() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { data: account } = useGetAccount({
    query: {
      retry: (failureCount: number, error: unknown) => {
        const apiError = error as ApiError | null;
        if (apiError?.status === 404) return false;
        return failureCount < 1;
      },
    },
  } as { query: any });

  const connectedLoginId = account?.loginId ?? null;

  // Adopt the preloaded singleton frame (no reload — same-document move) and
  // park it back in the hidden holder on unmount so it stays warm.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    adoptBotBuilderFrame(container);
    return () => {
      releaseBotBuilderFrame();
    };
  }, []);

  // Keep the builder's session aligned with the account enabled in NeuroTrade:
  // whichever account is active in the app (demo or real) is the one that
  // trades when the user presses Run.
  useEffect(() => {
    syncBotBuilderSession(Boolean(connectedLoginId), connectedLoginId);
  }, [connectedLoginId]);

  // Also re-sync right after the page (re)mounts — the frame may have been
  // adopted before the account query above resolved.
  const resyncOnAdopt = useCallback(() => {
    syncBotBuilderSession(Boolean(connectedLoginId), connectedLoginId);
  }, [connectedLoginId]);
  useEffect(() => {
    // The frame is adopted synchronously by the effect above; give it a tick
    // so the builder document (on first ever load) has listeners registered.
    const timeout = window.setTimeout(resyncOnAdopt, 300);
    const interval = window.setInterval(resyncOnAdopt, 4000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [resyncOnAdopt]);

  return (
    <div
      data-testid="bot-builder-page"
      className="h-[calc(100dvh-3.5rem)] w-full overflow-hidden bg-background md:h-[100dvh]"
    >
      {/*
        The 125%/125% sizing compensates for the 0.8 zoom below: a zoomed box
        that measures 100% only PAINTS at 100% × 0.8 = 80% of its container,
        which left a dead ~20% strip of the page background under the builder —
        the "plain black bar" that sat BELOW the builder's own footer (the bar
        with the GMT server clock) and pushed the real footer off the bottom
        edge of the page. Sizing the zoomed box at 125% makes the painted result
        exactly 100% of the page, so the builder's footer is the last bar on
        screen and the workspace fills the viewport. The page wrapper keeps
        `overflow-hidden`, so the pre-zoom overflow is never visible.

        Height: the 3.5rem subtraction matches the mobile top bar only (the
        desktop header is hidden and <main> has no top padding there), so
        desktop must use the full viewport — otherwise the wrapper stopped
        56px short and the page background showed as a bar BELOW the builder's
        footer, which is what the report described.
      */}
      <div
        ref={containerRef}
        className="h-[125%] w-[125%] [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0 [&>iframe]:bg-white"
        style={{ zoom: 0.8 }}
      />
    </div>
  );
}
