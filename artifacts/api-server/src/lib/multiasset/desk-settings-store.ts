/**
 * The auto-trader settings' durable half.
 *
 * The settings themselves are a pure value (`desk-settings.ts`); this module is
 * only about not losing them. It follows the bridge store's rules, because it
 * has exactly the same failure mode to avoid:
 *
 *   • **A read that fails is not a verdict.** A store that cannot be asked
 *     returns `null` — "I do not know" — never the factory defaults. Reverting
 *     an owner's policy because Postgres blinked would be the worst possible
 *     answer: the desk would trade a policy nobody chose and record it as the
 *     owner's.
 *   • **A write that fails is reported, never silently swallowed.** The caller
 *     keeps the in-process value and the next change tries again. The Desk says
 *     "settings saved" only when the row is there.
 *   • **Every read is sanitised.** A row written by an older build (or by hand)
 *     goes through `sanitiseAutoTradeSettings()` against the defaults, so a
 *     payload from a future or corrupt shape can only produce a valid, tighter
 *     policy.
 */

import { db, deskSettingsTable, schemaReady } from "@workspace/db";
import { eq } from "drizzle-orm";

import {
  AUTO_TRADE_SETTINGS_VERSION,
  defaultAutoTradeSettings,
  sanitiseAutoTradeSettings,
  type AutoTradeSettings,
} from "./desk-settings";

/**
 * Load one session's settings.
 *
 * `null` means "the store did not answer" — the caller must then keep whatever
 * it already holds. A row that exists but cannot be parsed is treated the same
 * way, for the same reason.
 */
export async function loadDeskSettings(sessionId: string): Promise<AutoTradeSettings | null> {
  try {
    await schemaReady;
    const rows = await db
      .select()
      .from(deskSettingsTable)
      .where(eq(deskSettingsTable.sessionId, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const parsed = JSON.parse(row.payloadJson) as unknown;
    const current = defaultAutoTradeSettings(row.updatedAtMs || Date.now());
    const settings = sanitiseAutoTradeSettings(current, parsed, row.updatedAtMs || Date.now());
    if ((parsed as { version?: number } | null)?.version !== AUTO_TRADE_SETTINGS_VERSION) {
      // A shape change: the sanitiser has already produced a valid policy from
      // the fields it recognised, and the reason is recorded on the value.
      settings.version = AUTO_TRADE_SETTINGS_VERSION;
    }
    return settings;
  } catch {
    return null;
  }
}

/** Persist one session's settings. Throws only if the store refuses the write. */
export async function saveDeskSettings(sessionId: string, settings: AutoTradeSettings): Promise<void> {
  await schemaReady;
  const payload = JSON.stringify(settings);
  await db
    .insert(deskSettingsTable)
    .values({ sessionId, payloadJson: payload, updatedAtMs: settings.updatedAt })
    .onConflictDoUpdate({
      target: deskSettingsTable.sessionId,
      set: { payloadJson: payload, updatedAtMs: settings.updatedAt },
    });
}
