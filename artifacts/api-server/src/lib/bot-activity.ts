/**
 * Which specialist bot owns the account's single execution slot.
 *
 * The Bot Arena shows one running bot and locks the other cards ("Engine
 * busy"). Six engines can own that slot — Match Pulse, Dual-Lock, Kill-Shot,
 * the Kill-Shot family oracles, Twin-Hedge Edge, the Compounding Range
 * Sentinel (accumulator) and finally the legacy specialist suite.
 *
 * Before this module the priority order was inlined in `routes/bots.ts` and
 * FORGOT the accumulator entirely: with the Compounding Range Sentinel
 * running, `/api/bots` reported `activeBotId: null` and attached no session to
 * its card, so the catalogue disagreed with `/api/bots/status` (which does
 * include it). Anything reading the catalogue would have shown "no bot
 * running" while the accumulator was mid-session.
 *
 * Kept pure and engine-agnostic so the order is unit-tested (bot-activity.test.ts)
 * and cannot silently drift again when a bot is added.
 */

export interface ActiveBotCandidate {
  /** Bot id advertised by the engine, or null when it reports no bot. */
  botId: string | null;
  /** Whether that engine currently owns the execution slot for this session. */
  running: boolean;
}

/**
 * The first running candidate wins. Ids are resolved in the order the caller
 * passes them, so the priority order is explicit at the call site.
 */
export function pickActiveBotId(candidates: readonly ActiveBotCandidate[]): string | null {
  for (const candidate of candidates) {
    if (candidate.running && candidate.botId) return candidate.botId;
  }
  return null;
}
