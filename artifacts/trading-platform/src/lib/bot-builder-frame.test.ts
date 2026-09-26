import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptBotBuilderFrame, BOT_BUILDER_SYNC_MESSAGE, getBotBuilderFrame,
  preloadBotBuilder, releaseBotBuilderFrame, syncBotBuilderSession,
} from "./bot-builder-frame";

test("page navigation never reparents/reloads the builder's browsing context", () => {
  type FakeElement = {
    id: string;
    src: string;
    style: Record<string, string>;
    parentElement: FakeElement | null;
    children: FakeElement[];
    attributes: Map<string, string>;
    appendChild: (child: FakeElement) => FakeElement;
    setAttribute: (key: string, value: string) => void;
    removeAttribute: (key: string) => void;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
    addEventListener: (name: string, callback: () => void) => void;
    emit: (name: string) => void;
    contentWindow?: { postMessage: (payload: unknown, origin: string) => void };
  };
  const events = new Map<string, Set<() => void>>();
  const frameMessages: Array<{ payload: any; origin: string }> = [];
  const elements = new Map<string, FakeElement>();
  let frameAppends = 0;
  let phone = false;
  let frameLoads: (() => void) | null = null;
  let rect = { left: 240, top: 0, width: 1100, height: 760 };
  const element = (): FakeElement => {
    const el: FakeElement = {
      id: "", src: "", style: {}, parentElement: null, children: [], attributes: new Map(),
      appendChild(child) {
        if (child.parentElement) throw new Error("Attempted to move a live iframe");
        if (child.contentWindow) frameAppends++;
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      setAttribute(key, value) { this.attributes.set(key, value); },
      removeAttribute(key) { this.attributes.delete(key); },
      getBoundingClientRect: () => rect,
      addEventListener(name, cb) { if (name === "load") frameLoads = cb; },
      emit(name) { if (name === "load") frameLoads?.(); },
    };
    return el;
  };
  const body = element();
  const documentMock = {
    body,
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => {
      const el = element();
      if (tag === "iframe") el.contentWindow = {
        postMessage: (payload: unknown, origin: string) => frameMessages.push({ payload, origin }),
      };
      const originalAppend = body.appendChild;
      body.appendChild = child => {
        const result = originalAppend.call(body, child);
        if (child.id) elements.set(child.id, child);
        return result;
      };
      return el;
    },
  };
  const windowMock = {
    location: { origin: "https://neurotrade.example" },
    matchMedia: () => ({ matches: phone }),
    addEventListener(name: string, fn: () => void) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name)!.add(fn);
    },
    removeEventListener(name: string, fn: () => void) { events.get(name)?.delete(fn); },
  };
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  (globalThis as any).window = windowMock;
  (globalThis as any).document = documentMock;
  try {
    preloadBotBuilder();
    const iframe = getBotBuilderFrame() as unknown as FakeElement;
    const holder = iframe.parentElement!;
    assert.equal(holder.parentElement, body);
    assert.equal(iframe.src, "/bot/preview/");
    assert.equal(frameAppends, 1);
    const placeholder = element();
    adoptBotBuilderFrame(placeholder as unknown as HTMLElement);
    assert.equal(iframe.parentElement, holder);
    assert.equal(holder.style.left, "240px");
    assert.equal(holder.style.visibility, "visible");
    assert.equal(iframe.style.transform, "scale(0.8)");
    assert.equal(iframe.style.width, "125%");

    // SPA navigation hides it, but DOES NOT change parent, src or frame state.
    releaseBotBuilderFrame();
    assert.equal(holder.style.left, "-20000px");
    assert.equal(holder.style.visibility, "hidden");
    assert.equal(holder.attributes.get("aria-hidden"), "true");
    phone = true;
    rect = { left: 0, top: 56, width: 390, height: 730 };
    adoptBotBuilderFrame(placeholder as unknown as HTMLElement);
    assert.equal(holder.style.top, "56px");
    assert.equal(iframe.style.transform, "");
    assert.equal(iframe.style.width, "100%");
    assert.equal(iframe.parentElement, holder);
    assert.equal(frameAppends, 1);
    assert.equal(events.get("resize")?.size, 1);
    releaseBotBuilderFrame();
    assert.equal(events.get("resize")?.size, 0);
    assert.equal(holder.style.width, "390px"); // preserve the phone viewport while trading off-screen
    assert.equal(holder.style.height, "730px");
    assert.equal(holder.style.pointerEvents, "none");

    syncBotBuilderSession(true, "VRT123");
    iframe.emit("load"); // lost early message is resent once the frame boots
    assert.deepEqual(frameMessages.at(-1), {
      payload: { type: BOT_BUILDER_SYNC_MESSAGE, source: "neurotrade-web", connected: true, loginId: "VRT123" },
      origin: "https://neurotrade.example",
    });
    assert.equal(frameAppends, 1);
  } finally {
    (globalThis as any).window = oldWindow;
    (globalThis as any).document = oldDocument;
  }
});
