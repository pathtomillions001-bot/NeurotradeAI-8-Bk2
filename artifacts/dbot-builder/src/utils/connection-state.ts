import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';

/**
 * How a socket status should be treated by the "stop the bot, we went offline"
 * guard.
 *
 * The guard used to treat "anything that is not OPENED" as a disconnect. That
 * includes `UNKNOWN`, the value the stream is seeded with before the first
 * connection is even attempted, and the brief `CLOSED` of every routine socket
 * refresh — which is why users saw an offline notice while plainly online.
 */
export type TConnectionAction =
    /** Connected: clear any offline state. */
    | 'online'
    /** Not connected yet (boot). Do nothing at all. */
    | 'pending'
    /** Socket closed: treat as offline only if it stays closed. */
    | 'maybe-offline';

/** Grace period a closed socket gets to come back before the bot is stopped. */
export const DISCONNECT_GRACE_MS = 2500;

export const getConnectionAction = (status?: string | null): TConnectionAction => {
    if (status === CONNECTION_STATUS.OPENED) return 'online';
    if (status === CONNECTION_STATUS.CLOSED) return 'maybe-offline';
    return 'pending';
};
