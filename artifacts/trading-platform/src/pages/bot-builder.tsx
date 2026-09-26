import { useCallback, useEffect, useRef } from "react";
import { useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import {
  hideBotBuilderFrame,
  showBotBuilderFrame,
  syncBotBuilderSession,
} from "@/lib/bot-builder-frame";

/**
 * Full-height embedding of the Deriv bot builder.
 *
 * - No page chrome of its own (the builder draws its own header) — the builder
 *   gets the entire content height below the app's top bar.
 * - The builder renders at 80% scale (CSS zoom) so the whole workspace, tool
 *   panel and charts fit comfortably on screen instead of cropping.
 * - This page renders only a SLOT. The builder itself is a persistent iframe
 *   owned by lib/bot-builder-frame.ts: it is preloaded when the app shell
 *   mounts and is never moved in the DOM (moving an iframe reloads it), so
 *   opening Bot Builder shows the already-booted builder instantly — with its
 *   workspace, socket and any running bot intact.
 */
export default function BotBuilder() {
  const slotRef = useRef<HTMLDivElement | null>(null);
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

  // Show the preloaded singleton over this page's slot (no DOM move, no
  // reload) and park it off-screen again on unmount so it stays warm — and so
  // a bot that is mid-run keeps running while the user browses the app.
  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    showBotBuilderFrame(slot);
    return () => {
      hideBotBuilderFrame();
    };
  }, []);

  // Keep the builder's session aligned with the account enabled in NeuroTrade:
  // whichever account is active in the app (demo or real) is the one that
  // trades when the user presses Run.
  useEffect(() => {
    syncBotBuilderSession(Boolean(connectedLoginId), connectedLoginId);
  }, [connectedLoginId]);

  // Also re-sync right after the page (re)mounts — the frame may have been
  // shown before the account query above resolved.
  const resyncOnShow = useCallback(() => {
    syncBotBuilderSession(Boolean(connectedLoginId), connectedLoginId);
  }, [connectedLoginId]);
  useEffect(() => {
    // The frame is shown synchronously by the effect above; give it a tick
    // so the builder document (on first ever load) has listeners registered.
    const timeout = window.setTimeout(resyncOnShow, 300);
    const interval = window.setInterval(resyncOnShow, 4000);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
    };
  }, [resyncOnShow]);

  return (
    <div
      data-testid="bot-builder-page"
      className="h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-background"
    >
      {/* The builder iframe is positioned over this slot — see
          lib/bot-builder-frame.ts. */}
      <div ref={slotRef} className="h-full w-full" />
    </div>
  );
}
