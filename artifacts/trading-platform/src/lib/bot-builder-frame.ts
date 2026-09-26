/**
 * Singleton Deriv bot-builder iframe. Its browsing context must NEVER be
 * reparented: removeChild/appendChild (even within the same document) can
 * navigate/reload an iframe, terminating an active interpreter and orders.
 *
 * Mount ONCE in a body-level fixed holder. The shell preloads it in the
 * background, and the Bot Builder page merely aligns the holder over its
 * placeholder. On other routes we park the SAME holder off-screen, keeping
 * the same iframe, workspace, socket and running strategy. Never set src twice.
 * A browser/tab shutdown or broker disconnect is still outside this guarantee.
 */

const BUILDER_PATH = "/bot/preview/";
const HOLDER_ID = "bot-builder-frame-holder";
const FRAME_CLASS = "bot-builder-frame";

let frame: HTMLIFrameElement | null = null;
let visibleContainer: HTMLElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let lastSession: { connected: boolean; loginId: string | null } | null = null;

function postSessionSync(iframe: HTMLIFrameElement): void {
  if (!lastSession) return;
  try {
    iframe.contentWindow?.postMessage(
      { type: BOT_BUILDER_SYNC_MESSAGE, source: "neurotrade-web", ...lastSession },
      window.location.origin,
    );
  } catch {
    // The iframe may still be booting; the load event retries once ready.
  }
}

function ensureHolder(): HTMLDivElement {
  let holder = document.getElementById(HOLDER_ID) as HTMLDivElement | null;
  if (!holder) {
    holder = document.createElement("div");
    holder.id = HOLDER_ID;
    // Never display:none or detach: the builder needs a nonzero viewport to
    // initialize Blockly and retain the same browsing context while trading.
    holder.style.position = "fixed";
    holder.style.left = "-20000px";
    holder.style.top = "0";
    holder.style.width = "1600px";
    holder.style.height = "1000px";
    holder.style.visibility = "hidden";
    holder.style.pointerEvents = "none";
    holder.style.overflow = "hidden";
    holder.style.zIndex = "20"; // below the app's mobile menu, dialogs and toasts
    holder.setAttribute("aria-hidden", "true");
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
    frame.addEventListener("load", () => postSessionSync(frame!));
    frame.src = BUILDER_PATH;
    frame.style.display = "block";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    frame.style.backgroundColor = "white";
    frame.style.transformOrigin = "top left";
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

/** Align the persistent overlay with the route placeholder; NEVER move the iframe. */
function alignBotBuilderFrame(): void {
  if (!visibleContainer) return;
  const rect = visibleContainer.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  const holder = ensureHolder();
  const iframe = getBotBuilderFrame();
  // The original 80% desktop zoom keeps the whole workspace visible. At phone
  // widths, use a 1:1 viewport: zooming created the wrong responsive breakpoint
  // inside the iframe and hid the mobile Run/Stop controls under the drawer.
  const scale = window.matchMedia("(max-width: 600px)").matches ? 1 : 0.8;
  iframe.style.width = `${100 / scale}%`;
  iframe.style.height = `${100 / scale}%`;
  iframe.style.transform = scale === 1 ? "" : `scale(${scale})`;
  holder.style.left = `${rect.left}px`;
  holder.style.top = `${rect.top}px`;
  holder.style.width = `${rect.width}px`;
  holder.style.height = `${rect.height}px`;
  holder.style.visibility = "visible";
  holder.style.pointerEvents = "auto";
  holder.removeAttribute("aria-hidden");
}

/** Show the already-running frame over `container` without changing its parent. */
export function adoptBotBuilderFrame(container: HTMLElement): HTMLIFrameElement {
  const iframe = getBotBuilderFrame();
  visibleContainer = container;
  alignBotBuilderFrame();
  resizeObserver?.disconnect();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(alignBotBuilderFrame);
    resizeObserver.observe(container);
  }
  window.removeEventListener("resize", alignBotBuilderFrame);
  window.removeEventListener("scroll", alignBotBuilderFrame, true);
  window.addEventListener("resize", alignBotBuilderFrame);
  window.addEventListener("scroll", alignBotBuilderFrame, true);
  return iframe;
}

/** Hide visually while retaining the *same* iframe/document and viewport size. */
export function releaseBotBuilderFrame(): void {
  visibleContainer = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  window.removeEventListener("resize", alignBotBuilderFrame);
  window.removeEventListener("scroll", alignBotBuilderFrame, true);
  const holder = ensureHolder();
  holder.style.left = "-20000px";
  holder.style.visibility = "hidden";
  holder.style.pointerEvents = "none";
  holder.setAttribute("aria-hidden", "true");
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
 * where the frame currently lives (visible on the Bot Builder page or parked
 * in the hidden holder). The builder's session bridge answers this by
 * reconnecting its Deriv socket to the SAME account the user enabled in the
 * app — so Run always trades the active demo/real account.
 */
export function syncBotBuilderSession(connected: boolean, loginId: string | null): void {
  // A fresh iframe may not yet have registered its listener. Keep only the
  // latest account identity and resend on its load event, not on an endless
  // timer (which used to reconnect the broker socket while trading).
  lastSession = { connected, loginId };
  postSessionSync(getBotBuilderFrame());
}

