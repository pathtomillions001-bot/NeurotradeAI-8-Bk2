import { observer as globalObserver } from './observer';

export const createError = (name, message) => {
    const e = new Error(message);
    e.name = name;
    e.code = name;
    return e;
};

/**
 * ALWAYS returns an Error-shaped object carrying a non-empty, human-readable
 * `message`, no matter what was thrown or used to reject a promise.
 *
 * Payloads actually seen crossing the bot engine boundary:
 *  - Error instances (native, or js-interpreter TypeErrors such as
 *    "undefined is not a function")
 *  - Deriv API wrappers `{ error: { code, message } }` (usually unwrapped
 *    upstream, but an extra layer or a message-less `{ code }` is possible)
 *  - `{ code, message, code_args, subcode }` plain objects
 *  - bare strings — the js-interpreter converts `throw 'x'` (and even
 *    `throw undefined`) in bot code into a plain string that then REPLACES
 *    the run promise's rejection value
 *  - `undefined` / `null` — a bare `Promise.reject()` anywhere in the chain
 *
 * Reading `.code`/`.message` off those payloads unguarded crashed the
 * observer handlers that forward engine failures to the journal, which in
 * turn produced unhandled promise rejections and silently froze the bot
 * mid-run — the "stops mid runs with no error text" bug.
 *
 * Structural fields (code / name / code_args / subcode / details) are
 * preserved because downstream backend-error localisation keys off them.
 */
export const normalizeErrorPayload = (payload, fallback_message = 'Unknown error') => {
    const raw = payload;

    let message;
    if (typeof raw === 'string') {
        message = raw;
    } else if (raw && typeof raw === 'object') {
        message = raw.message ?? (raw.error && typeof raw.error === 'object' ? raw.error.message : undefined);
    }

    if (typeof message !== 'string' || message.trim() === '') {
        message = fallback_message;
    }

    if (raw instanceof Error && raw.message === message) {
        return raw;
    }

    const error = new Error(message);
    if (raw && typeof raw === 'object') {
        const inner = raw.error && typeof raw.error === 'object' ? raw.error : {};
        if (raw.code) error.code = raw.code;
        else if (inner.code) error.code = inner.code;
        if (raw.name && typeof raw.name === 'string') error.name = raw.name;
        if (raw.code_args ?? inner.code_args) error.code_args = raw.code_args ?? inner.code_args;
        if (raw.subcode ?? inner.subcode) error.subcode = raw.subcode ?? inner.subcode;
        if (raw.details) error.details = raw.details;
        if (raw.localizedMessage) error.localizedMessage = raw.localizedMessage;
    }
    return error;
};

export const trackAndEmitError = (message, object = {}) => {
    globalObserver.emit('ui.log.error', message);
    if (window.trackJs) {
        // eslint-disable-next-line no-undef
        trackJs.track(`${message} - Error: ${JSON.stringify(object)}`);
    }
};
