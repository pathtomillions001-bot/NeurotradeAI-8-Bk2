/**
 * Singleton Deriv bot-builder iframe.
 *
 * The builder is a large standalone React app (Blockly + SmartCharts). Booting
 * it costs seconds, so NeuroTrade boots it ONCE per browser session and keeps
 * that browsing context alive for the rest of the session.
 *
 * ── Why the iframe is never re-parented ──────────────────────────────────────
 * The previous implementation parked the iframe in a hidden holder and MOVED it
 * into the Bot Builder page on every visit, on the assumption that a
 * same-document move preserves the browsing context. It does not: per the HTML
 * spec every browser discards an iframe's document when the element is removed
 * from (or re-inserted into) the DOM, so each visit silently re-ran the entire
 * builder boot — socket handshake, chunk downloads, Blockly injection — which
 * is exactly the "the bot builder page opens fast but then loads forever" the
 * user reported. Leaving the page re-parented it a second time, killing a bot
 * that was mid-run.
 *
 * So the frame now lives in ONE fixed-position host attached to <body> that is
 * created on first use and never moved again:
 *
 *  - the shell preloads it right after the app mounts, so the builder boots in
 *    the background while the user is on any other page;
 *  - the Bot Builder page renders an empty SLOT and calls `showBotBuilderFrame`
 *    with it. The host is positioned (fixed) over that slot and tracks it via a
 *    ResizeObserver, so it lines up with the page exactly like an inline
 *    element — with zero DOM movement;
 *  - leaving the page only hides the host off-screen (`hideBotBuilderFrame`).
 *    The document, websocket, workspace and any RUNNING bot stay alive, and
 *    coming back is a visibility flip: instant, no reload, no loading screens.
 *
 * Nothing here ever changes the host's SIZE while hiding it, because a resize
 * would make Blockly re-layout the workspace for nothing.
 */

const BUILDER_PATH = "/bot/preview/";
const HOST_ID = "bot-builder-frame-host";
const FRAME_CLASS = "bot-builder-frame";
/** Matches the Bot Builder page's own `zoom` so the whole workspace fits. */
const BUILDER_ZOOM = 0.8;
/** Parked far off-screen; the element keeps its size, so no re-layout. */
const OFFSCREEN_TRANSFORM = "translate3d(-200vw, 0, 0)";

type Rect = { top: number; left: number; width: number; height: number };

let host: HTMLDivElement | null = null;
let zoomLayer: HTMLDivElement | null = null;
let frame: HTMLIFrameElement | null = null;
let slot: HTMLElement | null = null;
let slotObserver: ResizeObserver | null = null;
let trackingListenersBound = false;
let lastRect: Rect | null = null;

/**
 * Where the builder will be shown, predicted from the shell's layout, so the
 * background boot already happens at the final size and opening the page needs
 * no resize at all. Mirrors `components/layout.tsx` (fixed 3.5rem mobile top
 * bar, 14rem/16rem desktop sidebar) and the Bot Builder page container.
 */
function predictedRect(): Rect {
  const vw = Math.max(320, window.innerWidth || 1024);
  const vh = Math.max(480, window.innerHeight || 768);
  const isDesktop = window.matchMedia("(min-width: 768px)").matches;
  const isLarge = window.matchMedia("(min-width: 1024px)").matches;
  const left = isDesktop ? (isLarge ? 256 : 224) : 0;
  const top = isDesktop ? 0 : 56;
  return { top, left, width: Math.max(320, vw - left), height: Math.max(360, vh - 56) };
}

function applyRect(rect: Rect): void {
  if (!host) return;
  const rounded: Rect = {
    top: Math.round(rect.top),
    left: Math.round(rect.left),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
  if (
    lastRect &&
    lastRect.top === rounded.top &&
    lastRect.left === rounded.left &&
    lastRect.width === rounded.width &&
    lastRect.height === rounded.height
  ) {
    return;
  }
  lastRect = rounded;
  host.style.top = `${rounded.top}px`;
  host.style.left = `${rounded.left}px`;
  host.style.width = `${rounded.width}px`;
  host.style.height = `${rounded.height}px`;
}

/** Re-align the host with the slot the Bot Builder page rendered. */
function syncToSlot(): void {
  if (!host || !slot) return;
  const rect = slot.getBoundingClientRect();
  // A collapsed slot means the page is mid-layout; keep the previous geometry
  // rather than resizing the builder to nothing.
  if (rect.width < 1 || rect.height < 1) return;
  applyRect(rect);
}

function bindTrackingListeners(): void {
  if (trackingListenersBound) return;
  trackingListenersBound = true;
  window.addEventListener("resize", syncToSlot);
  window.addEventListener("orientationchange", syncToSlot);
  // `true` → capture, so scrolling of any ancestor container is picked up.
  window.addEventListener("scroll", syncToSlot, true);
}

function ensureHost(): HTMLDivElement {
  if (host) return host;

  host = document.createElement("div");
  host.id = HOST_ID;
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    top: "0px",
    left: "0px",
    width: "0px",
    height: "0px",
    overflow: "hidden",
    // Parked off-screen until the Bot Builder page asks for it. The element is
    // still RENDERED at its real size, which is what keeps the Blockly
    // workspace laid out correctly while it boots in the background.
    transform: OFFSCREEN_TRANSFORM,
    visibility: "hidden",
    pointerEvents: "none",
    zIndex: "0",
    background: "#fff",
  } satisfies Partial<CSSStyleDeclaration>);

  zoomLayer = document.createElement("div");
  Object.assign(zoomLayer.style, {
    width: "100%",
    height: "100%",
    zoom: String(BUILDER_ZOOM),
  } satisfies Partial<CSSStyleDeclaration>);
  host.appendChild(zoomLayer);

  document.body.appendChild(host);
  applyRect(predictedRect());
  bindTrackingListeners();
  return host;
}

export function getBotBuilderFrame(): HTMLIFrameElement {
  const hostEl = ensureHost();
  if (!frame) {
    frame = document.createElement("iframe");
    frame.title = "Deriv Bot Builder";
    frame.className = FRAME_CLASS;
    frame.allow = "clipboard-read; clipboard-write; fullscreen";
    Object.assign(frame.style, {
      display: "block",
      width: "100%",
      height: "100%",
      border: "0",
      background: "#fff",
    } satisfies Partial<CSSStyleDeclaration>);
    // The builder is same-origin; nothing inside needs credentials beyond the
    // shared cookie jar, which flows by default.
    frame.src = BUILDER_PATH;
    (zoomLayer ?? hostEl).appendChild(frame);
  }
  return frame;
}

/** Start booting the builder (no-op after the first call). */
export function preloadBotBuilder(): void {
  getBotBuilderFrame();
}

/**
 * Show the builder over `slotEl` (the Bot Builder page's placeholder) and keep
 * it aligned with it. No DOM move happens, so the builder is NOT reloaded and
 * appears in the same frame the page paints.
 */
export function showBotBuilderFrame(slotEl: HTMLElement): HTMLIFrameElement {
  const iframe = getBotBuilderFrame();
  const hostEl = ensureHost();

  slot = slotEl;
  syncToSlot();

  if (typeof ResizeObserver !== "undefined") {
    slotObserver?.disconnect();
    slotObserver = new ResizeObserver(() => syncToSlot());
    slotObserver.observe(slotEl);
  }
  // The slot's final position can land a frame later (page transition, fonts,
  // scrollbar). Re-sync on the next two frames instead of trusting one read.
  requestAnimationFrame(() => {
    syncToSlot();
    requestAnimationFrame(syncToSlot);
  });

  hostEl.style.transform = "";
  hostEl.style.visibility = "visible";
  hostEl.style.pointerEvents = "auto";
  hostEl.style.zIndex = "10";
  hostEl.removeAttribute("aria-hidden");

  return iframe;
}

/**
 * Park the builder off-screen again. It keeps its size (no workspace
 * re-layout), its document, its socket and any bot that is mid-run.
 */
export function hideBotBuilderFrame(): void {
  slotObserver?.disconnect();
  slotObserver = null;
  slot = null;
  if (!host) return;
  host.style.transform = OFFSCREEN_TRANSFORM;
  host.style.visibility = "hidden";
  host.style.pointerEvents = "none";
  host.style.zIndex = "0";
  host.setAttribute("aria-hidden", "true");
}

export const BOT_BUILDER_SYNC_MESSAGE = "NEUROTRADE_BOT_BUILDER_SYNC";
/** Host → builder: load this Blockly XML into the workspace. */
export const BOT_BUILDER_LOAD_STRATEGY_MESSAGE = "NEUROTRADE_BOT_BUILDER_LOAD_STRATEGY";
/** Builder → host: the strategy with this requestId is (or is not) in the workspace. */
export const BOT_BUILDER_STRATEGY_LOADED_MESSAGE = "NEUROTRADE_BOT_BUILDER_STRATEGY_LOADED";

export interface BotBuilderStrategy {
  /** File / strategy name shown in the builder. */
  name: string;
  /** Deriv-Bot Blockly workspace XML. */
  xml: string;
  /** Deriv symbol the trade definition targets (builder verifies market path). */
  symbol?: string;
}

type PendingLoad = {
  requestId: string;
  strategy: BotBuilderStrategy;
  resolve: (ok: boolean) => void;
  timer: number;
  ticker: number;
};

let pendingLoad: PendingLoad | null = null;
let loadListenerInstalled = false;

function installLoadListener(): void {
  if (loadListenerInstalled) return;
  loadListenerInstalled = true;
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as { type?: string; requestId?: string; ok?: boolean; error?: string } | null;
    if (!data || data.type !== BOT_BUILDER_STRATEGY_LOADED_MESSAGE) return;
    if (!pendingLoad || data.requestId !== pendingLoad.requestId) return;
    const done = pendingLoad;
    pendingLoad = null;
    window.clearTimeout(done.timer);
    window.clearInterval(done.ticker);
    done.resolve(data.ok !== false);
  });
}

function postLoad(load: PendingLoad): void {
  const iframe = getBotBuilderFrame();
  try {
    iframe.contentWindow?.postMessage(
      {
        type: BOT_BUILDER_LOAD_STRATEGY_MESSAGE,
        source: "neurotrade-web",
        requestId: load.requestId,
        name: load.strategy.name,
        xml: load.strategy.xml,
        symbol: load.strategy.symbol ?? null,
      },
      window.location.origin,
    );
  } catch {
    // Builder document not ready yet — the ticker retries until it acks.
  }
}

/**
 * Push a generated strategy into the (possibly still booting) Deriv bot
 * builder. The message is re-sent every second until the builder acknowledges
 * it has loaded the workspace, so it is safe to call before the iframe's
 * document exists or before the user has ever opened the Bot Builder page.
 * Resolves `true` once the blocks are in the workspace, `false` on timeout
 * or if the builder rejected the XML.
 */
export function loadStrategyIntoBotBuilder(
  strategy: BotBuilderStrategy,
  timeoutMs = 45_000,
): Promise<boolean> {
  installLoadListener();
  // Make sure the frame is booting.
  getBotBuilderFrame();

  if (pendingLoad) {
    // A newer request supersedes an older one that never got acked.
    const stale = pendingLoad;
    pendingLoad = null;
    window.clearTimeout(stale.timer);
    window.clearInterval(stale.ticker);
    stale.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const requestId = `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const load: PendingLoad = {
      requestId,
      strategy,
      resolve,
      timer: window.setTimeout(() => {
        if (pendingLoad?.requestId !== requestId) return;
        pendingLoad = null;
        window.clearInterval(load.ticker);
        resolve(false);
      }, timeoutMs),
      ticker: window.setInterval(() => postLoad(load), 1000),
    };
    pendingLoad = load;
    postLoad(load);
  });
}

/**
 * Push the NeuroTrade-connected Deriv account into the builder, no matter
 * whether the frame is currently shown or parked off-screen. The builder's
 * session bridge answers this by reconnecting its Deriv socket to the SAME
 * account the user enabled in the app — so Run always trades the active
 * demo/real account.
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
