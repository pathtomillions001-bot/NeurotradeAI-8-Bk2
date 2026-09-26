import { CONNECTION_STATUS } from '@/external/bot-skeleton/services/api/observables/connection-status-stream';
import { DISCONNECT_GRACE_MS, getConnectionAction } from '../connection-state';

describe('connection state guard', () => {
    it('treats an open socket as online', () => {
        expect(getConnectionAction(CONNECTION_STATUS.OPENED)).toBe('online');
    });

    it('ignores the pre-connection UNKNOWN status instead of reporting offline', () => {
        // This is the bug that made the "you're back online / the bot has
        // stopped" dialog appear while the user was connected.
        expect(getConnectionAction(CONNECTION_STATUS.UNKNOWN)).toBe('pending');
        expect(getConnectionAction(undefined)).toBe('pending');
        expect(getConnectionAction(null)).toBe('pending');
        expect(getConnectionAction('')).toBe('pending');
    });

    it('only a closed socket can stop a running bot', () => {
        expect(getConnectionAction(CONNECTION_STATUS.CLOSED)).toBe('maybe-offline');
    });

    it('gives a closed socket time to reconnect', () => {
        expect(DISCONNECT_GRACE_MS).toBeGreaterThan(0);
    });
});
