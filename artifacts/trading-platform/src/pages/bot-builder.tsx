import { useEffect, useRef } from "react";
import { adoptBotBuilderFrame, releaseBotBuilderFrame } from "@/lib/bot-builder-frame";

/**
 * Full-height embedding of the Deriv bot builder.
 *
 * - No page chrome of its own (the builder draws its own header) — the iframe
 *   gets the entire content height below the app's top bar.
 * - The persistent iframe is aligned over this page's placeholder. Desktop
 *   scales it to 80%; mobile stays at 100% for the actual Run/Stop layout.
 * - Its DOM parent and src never change (see lib/bot-builder-frame.ts). Moving
 *   an iframe during route transitions can reload it and terminate a running
 *   strategy. Hiding only its fixed holder keeps the interpreter alive.
 */
export default function BotBuilder() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Account synchronization lives in the persistent app Layout; a route-local
  // query would briefly report "disconnected" on every visit and could reset
  // the builder's broker socket while a DBot is running.

  // Align the preloaded frame with this placeholder. Never detach/reparent it:
  // leaving the route hides it but must not stop an active DBot.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    adoptBotBuilderFrame(container);
    return () => {
      releaseBotBuilderFrame();
    };
  }, []);

  return (
    <div
      data-testid="bot-builder-page"
      className="h-[calc(100vh-3.5rem)] supports-[height:100dvh]:h-[calc(100dvh-3.5rem)] md:h-[100vh] md:supports-[height:100dvh]:h-[100dvh] w-full overflow-hidden bg-background"
    >
      <div
        ref={containerRef}
        className="h-full w-full"
      />
    </div>
  );
}
