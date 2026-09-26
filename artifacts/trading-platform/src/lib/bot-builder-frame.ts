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
 *  - the iframe is NEVER re-parented. The permanent fixed holder is resized
 *    over the Bot Builder page, avoiding the browser-dependent iframe reload
 *    that can occur when an iframe node is moved;
 *  - when the page unmounts only the holder moves off-screen, so the same
 *    browsing context, websocket, Blockly workspace and running bot survive.
 */

const BUILDER_PATH = "/bot/preview/";
const HOLDER_ID = "bot-builder-frame-holder";
const FRAME_CLASS = "bot-builder-frame";

let frame: HTMLIFrameElement | null = null;
let adoptedContainer: HTMLElement | null = null;
let containerObserver: ResizeObserver | null = null;
let resizeListenerInstalled = false;

function parkHolder(holder: HTMLDivElement): void {
  // Never display:none and never detach/re-parent the iframe. Both can destroy
  // or suspend the builder's browsing context, which would stop a running bot.
  // Keeping one fixed, off-screen parent preserves Blockly, sockets and trades.
  holder.style.left = "-20000px";
  holder.style.top = "0";
  holder.style.width = `${Math.max(390, window.innerWidth)}px`;
  holder.style.height = `${Math.max(700, window.innerHeight)}px`;
  holder.style.opacity = "0";
  holder.style.pointerEvents = "none";
  holder.style.zIndex = "-1";
}

function positionHolder(): void {
  if (!adoptedContainer) return;
  const holder = ensureHolder();
  const rect = adoptedContainer.getBoundingClientRect();
  holder.style.left = `${rect.left}px`;
  holder.style.top = `${rect.top}px`;
  holder.style.width = `${rect.width}px`;
  holder.style.height = `${rect.height}px`;
  holder.style.opacity = "1";
  holder.style.pointerEvents = "auto";
  // Below app dialogs/mobile navigation, above ordinary page content.
  holder.style.zIndex = "20";
}

function ensureHolder(): HTMLDivElement {
  let holder = document.getElementById(HOLDER_ID) as HTMLDivElement | null;
  if (!holder) {
    holder = document.createElement("div");
    holder.id = HOLDER_ID;
    holder.style.position = "fixed";
    holder.style.overflow = "hidden";
    holder.style.background = "white";
    holder.style.transition = "none";
    document.body.appendChild(holder);
    parkHolder(holder);
  }
  if (!resizeListenerInstalled) {
    resizeListenerInstalled = true;
    window.addEventListener("resize", positionHolder, { passive: true });
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
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.background = "white";
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
 * Reveal the singleton frame over `container` WITHOUT moving the iframe node.
 * Re-parenting an iframe can recreate its browsing context in real browsers;
 * that would tear down a running DBot. The permanent holder is only resized.
 */
export function adoptBotBuilderFrame(container: HTMLElement): HTMLIFrameElement {
  const iframe = getBotBuilderFrame();
  adoptedContainer = container;
  containerObserver?.disconnect();
  containerObserver = new ResizeObserver(positionHolder);
  containerObserver.observe(container);
  positionHolder();
  // Fonts/sidebar layout can shift after the first paint without a resize.
  window.requestAnimationFrame(positionHolder);
  return iframe;
}

/** Move only the permanent holder off-screen; the iframe remains alive in it. */
export function releaseBotBuilderFrame(): void {
  adoptedContainer = null;
  containerObserver?.disconnect();
  containerObserver = null;
  parkHolder(ensureHolder());
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

