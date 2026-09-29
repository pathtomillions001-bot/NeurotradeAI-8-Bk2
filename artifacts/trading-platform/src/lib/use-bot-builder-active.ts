import { useLocation } from "wouter";

/**
 * True while the embedded Deriv bot builder owns the main view.
 *
 * The builder runs its trading engine on the SAME browser main thread as this
 * app. While it is visible (and especially while a bot is running inside it),
 * every poll/re-render the shell performs can delay the builder's websocket
 * handlers and timers past a tick boundary — on 1-tick markets that literally
 * skips trade opportunities. Background work that consults this hook is
 * expected to pause or slow down while the builder is on screen.
 */
export function useIsBotBuilderActive(): boolean {
  const [location] = useLocation();
  return location === "/bot-builder" || location.startsWith("/bot-builder/");
}
