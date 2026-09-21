/**
 * Which console drives which bot, and — more importantly — which consoles this
 * BUNDLE can actually render.
 *
 * The catalogue comes from the API at runtime, so a web build can be handed a
 * bot whose console it has never heard of (see src/lib/console-contract.ts for
 * the incident). `missingConsoles()` turns that into an explicit, loud result
 * that the Bot Arena renders as an "update available" panel, instead of the
 * previous behaviour: silently opening the generic specialist console and
 * looking "different" for no visible reason.
 */

import type { ComponentType } from "react";
import { ApexConsole } from "@/components/apex-console";
import { BastionConsole } from "@/components/bastion-console";
import { ParityForgeConsole } from "@/components/parity-forge-console";
import { SurgeConsole } from "@/components/surge-console";
import { BotConsole } from "@/components/bot-console";
import { DualLockConsole } from "@/components/dual-lock-console";
import { KillShotConsole } from "@/components/killshot-console";
import { KillShotFamilyConsole } from "@/components/killshot-family-console";
import { WEB_CONSOLE_IDS, type WebConsoleId } from "./console-contract";
import type { BotCardData, BotSessionStatus } from "./bots";

export interface BotConsoleProps {
  bot: BotCardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: BotSessionStatus | null;
  onSession: (session: BotSessionStatus | null) => void;
}

/** Every console this build can render, keyed by its contract id. */
export const CONSOLE_REGISTRY: Record<WebConsoleId, ComponentType<BotConsoleProps>> = {
  "apex@1": ApexConsole,
  "bastion@1": BastionConsole,
  "parity-forge@1": ParityForgeConsole,
  "surge@1": SurgeConsole,
  "specialist@1": BotConsole,
  "dual-lock@1": DualLockConsole,
  "killshot@1": KillShotConsole,
  "killshot-family@1": KillShotFamilyConsole,
};

/** Console ids this bundle implements (mirrors `WEB_CONSOLE_IDS` exactly). */
export function implementedConsoleIds(): string[] {
  return Object.keys(CONSOLE_REGISTRY).sort();
}

export type ConsoleResolution =
  | { ok: true; id: string; Console: ComponentType<BotConsoleProps> }
  | { ok: false; id: string };

/**
 * Resolve the console for a catalogue bot.
 *
 * A bot with no `console` field (an API older than this bundle) falls back to
 * the specialist console — that direction is safe, because the OLD catalogue is
 * a subset of what this bundle can draw. The unsafe direction (the API asks for
 * a console this bundle has never heard of) is reported, never guessed.
 */
export function resolveConsole(bot: Pick<BotCardData, "console">): ConsoleResolution {
  const id = bot.console ?? "specialist@1";
  const Console = (CONSOLE_REGISTRY as Record<string, ComponentType<BotConsoleProps> | undefined>)[id];
  return Console ? { ok: true, id, Console } : { ok: false, id };
}

export interface ConsoleSkew {
  /** Ids the API asked for that this bundle cannot render. */
  missing: string[];
  /** Bots affected by the missing consoles, for a human-readable message. */
  bots: Array<{ id: string; name: string; console: string }>;
  /** True when the Bot Arena must not pretend everything is fine. */
  skewed: boolean;
}

/**
 * Compare the catalogue's console ids with this bundle's registry.
 *
 * `consoleContract` is the API's own list (optional, for an immediate mismatch
 * even before a bot of that console type appears). Bot-level ids are the
 * authoritative check.
 */
export function consoleSkew(
  bots: Array<Pick<BotCardData, "id" | "name" | "console">>,
  consoleContract?: string[],
  /**
   * Console ids the running bundle can draw. Defaults to this build's registry;
   * injectable so the stale-bundle case can be tested directly
   * (console-registry.test.ts) instead of only in production.
   */
  implementedIds: Iterable<string> = implementedConsoleIds(),
): ConsoleSkew {
  const implemented = new Set(implementedIds);

  const missingBots = bots
    .map(bot => ({ bot, id: bot.console ?? "specialist@1" }))
    .filter(entry => !implemented.has(entry.id))
    .map(entry => ({ id: entry.bot.id, name: entry.bot.name, console: entry.id }));

  const missing = new Set(missingBots.map(entry => entry.console));
  for (const id of consoleContract ?? []) {
    if (!implemented.has(id)) missing.add(id);
  }

  return { missing: [...missing].sort(), bots: missingBots, skewed: missing.size > 0 };
}
