/**
 * Which specialist bot owns the account's single execution slot.
 *
 * The Bot Arena shows one running bot and locks the other cards ("Engine
 * busy"). Four engines can own that slot — Dual-Lock, Kill-Shot, the
 * Kill-Shot family oracles and finally the legacy specialist suite.
 *
 * Before this module the priority order was inlined in `routes/bots.ts` and
 * could forget an engine entirely, so `/api/bots` reported `activeBotId: null`
 * while `/api/bots/status` disagreed.
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
