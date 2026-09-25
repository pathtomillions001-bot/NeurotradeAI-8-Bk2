/**
 * Singleton Deriv bot-builder iframe.
 *
 * The builder is a ~large standalone React app; mounting its iframe only when
 * the user opens the Bot Builder page meant a multi-second blank wait on every
 * visit. Instead we create the iframe ONCE per browser session and keep it
 * alive in a hidden holder attached to <body>:
 *
 *  - the shell preloads it right after the app mounts, so the builder boots in
 *    the background while the user is on any other page;
 *  - when the Bot Builder page mounts it ADOPTS the same <iframe> element by
 *    moving it into the page container — moving an iframe within the same
 *    document does NOT reload it, so the builder appears instantly with all
 *    its state (loaded strategy, connection, workspace) intact;
 *  - when the page unmounts the frame goes back to the off-screen holder,
 *    staying warm (websocket + workspace) for the next visit.
 */

const BUILDER_PATH = "/bot/preview/";
const HOLDER_ID = "bot-builder-frame-holder";
const FRAME_CLASS = "bot-builder-frame";

let frame: HTMLIFrameElement | null = null;

function ensureHolder(): HTMLDivElement {
  let holder = document.getElementById(HOLDER_ID) as HTMLDivElement | null;
  if (!holder) {
    holder = document.createElement("div");
    holder.id = HOLDER_ID;
    // Parked off-screen but RENDERED at a real viewport size — a display:none
    // iframe would give the builder a zero-size inner viewport and break the
    // Blockly workspace layout at boot. Off-screen keeps the browsing context
    // fully alive and warm; moving it into the page later fires the iframe's
    // own resize so the workspace reflows.
    holder.style.position = "fixed";
    holder.style.left = "-20000px";
    holder.style.top = "0";
    holder.style.width = "1600px";
    holder.style.height = "1000px";
    holder.style.visibility = "hidden";
    holder.style.pointerEvents = "none";
    holder.style.overflow = "hidden";
    document.body.appendChild(holder);
  }
  return holder;
}

export function getBotBuilderFrame(): HTMLIFrameElement {
  if (!frame) {
    frame = document.createElement("iframe");
    frame.title = "Deriv Bot Builder";
    frame.className = FRAME_CLASS;
    frame.allow = "clipboard-read; clipboard-write; fullscreen";
    frame.src = BUILDER_PATH;
    // The builder is same-origin; nothing inside needs credentials beyond the
    // shared cookie jar, which flows by default.
    ensureHolder().appendChild(frame);
  }
  return frame;
}

/** Start booting the builder (no-op after the first call). */
export function preloadBotBuilder(): void {
  getBotBuilderFrame();
}

/**
 * Move the singleton frame into `container` (no reload — same-document move).
 * Returns the frame so the caller can post sync messages to it.
 */
export function adoptBotBuilderFrame(container: HTMLElement): HTMLIFrameElement {
  const iframe = getBotBuilderFrame();
  if (iframe.parentElement !== container) {
    container.appendChild(iframe);
  }
  return iframe;
}

/** Park the frame back into the hidden holder (keeps it warm). */
export function releaseBotBuilderFrame(): void {
  const iframe = getBotBuilderFrame();
  ensureHolder().appendChild(iframe);
}

export const BOT_BUILDER_SYNC_MESSAGE = "NEUROTRADE_BOT_BUILDER_SYNC";

/**
 * Push the NeuroTrade-connected Deriv account into the builder, no matter
 * where the frame currently lives (visible on the Bot Builder page or parked
 * in the hidden holder). The builder's session bridge answers this by
 * reconnecting its Deriv socket to the SAME account the user enabled in the
 * app — so Run always trades the active demo/real account.
 */
export function syncBotBuilderSession(connected: boolean, loginId: string | null): void {
  const iframe = getBotBuilderFrame();
  try {
    iframe.contentWindow?.postMessage(
      {
        type: BOT_BUILDER_SYNC_MESSAGE,
        source: "neurotrade-web",
        connected,
        loginId,
      },
      window.location.origin,
    );
  } catch {
    // The builder document may not exist yet (still loading); its own boot
    // fetch of /api/auth/bot-builder/session covers initial connection.
  }
}

