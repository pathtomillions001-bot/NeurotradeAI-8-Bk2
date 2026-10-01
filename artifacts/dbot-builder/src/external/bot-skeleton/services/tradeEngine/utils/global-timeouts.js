/**
 * Shared accessors for the recoverable-error backoff timeouts registry.
 *
 * `recoverFromError` (../utils/helpers.js) stores pending retry timers on the
 * global observer under `global_timeouts` as an OBJECT MAP keyed by numeric
 * timer id: `{ [timerId]: { is_cancellable, msg_type } }`.
 *
 * Two different teardowns (interpreter stop() and api-base
 * clearSubscriptions()) assumed an ARRAY and called `.forEach` on it, so the
 * moment any backoff timer existed, teardown crashed with
 * "global_timeouts.forEach is not a function". For stop() that rejection was
 * swallowed by dbot.stopBot(), which is why bots stopped mid-run with no
 * journal text; for clearSubscriptions() the throw aborted terminateSession()
 * before tick subscriptions were released.
 */
export const getGlobalTimeouts = observer => {
    const state = observer.getState('global_timeouts');
    return state && typeof state === 'object' ? state : {};
};

export const clearGlobalTimeouts = observer => {
    const global_timeouts = getGlobalTimeouts(observer);
    Object.keys(global_timeouts).forEach(timer_id => clearTimeout(Number(timer_id)));
    observer.setState({ global_timeouts: {} });
};
