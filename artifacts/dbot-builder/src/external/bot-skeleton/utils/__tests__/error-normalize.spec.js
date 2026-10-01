/**
 * `normalizeErrorPayload` exists because engine failures cross several
 * boundaries (js-interpreter, interface promises, observer emits) and reach
 * the journal handlers in many shapes. BEFORE it existed:
 *  - a bare `Promise.reject()` arrived as `undefined`, crashed the run-panel's
 *    `onError` on the first `.code` read, and the bot froze mid-run with no
 *    journal text;
 *  - `throw 'x'` inside bot code surfaced as a bare string, whose missing
 *    `.message` was pushed into the journal as `undefined` — a blank error row.
 */
import { normalizeErrorPayload } from '../error';

describe('normalizeErrorPayload', () => {
    it('passes Error instances through untouched', () => {
        const err = new TypeError('undefined is not a function');
        err.code = 'SomeCode';
        expect(normalizeErrorPayload(err)).toBe(err);
    });

    it('turns undefined (bare reject()) into an Error with real text', () => {
        const err = normalizeErrorPayload(undefined);
        expect(err).toBeInstanceOf(Error);
        expect(err.message.trim()).not.toBe('');
        expect(err.code).toBeUndefined();
    });

    it('turns null into an Error with real text', () => {
        const err = normalizeErrorPayload(null);
        expect(err).toBeInstanceOf(Error);
        expect(err.message.trim()).not.toBe('');
    });

    it('turns bare strings (interpreter `throw "x"` payloads) into Errors', () => {
        const err = normalizeErrorPayload('Rate limit reached');
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Rate limit reached');
    });

    it('unwraps Deriv API error wrappers', () => {
        const err = normalizeErrorPayload({ error: { code: 'InvalidtoBuy', message: 'Stake too low', code_args: ['1'] } });
        expect(err.message).toBe('Stake too low');
        expect(err.code).toBe('InvalidtoBuy');
        expect(err.code_args).toEqual(['1']);
    });

    it('falls back to real text for message-less { code } wrappers', () => {
        const err = normalizeErrorPayload({ code: 'WrongResponse' });
        expect(err.message.trim()).not.toBe('');
        expect(err.code).toBe('WrongResponse');
    });

    it('preserves structural fields used by backend-error localisation', () => {
        const err = normalizeErrorPayload({
            message: 'x',
            code: 'C',
            subcode: 'S',
            code_args: ['a', 'b'],
            details: { some: 'thing' },
        });
        expect(err.code).toBe('C');
        expect(err.subcode).toBe('S');
        expect(err.code_args).toEqual(['a', 'b']);
        expect(err.details).toEqual({ some: 'thing' });
    });

    it('replaces blank-string messages with fallback text', () => {
        const err = normalizeErrorPayload('   ');
        expect(err.message.trim()).not.toBe('');
    });

    it('respects a custom fallback message', () => {
        const err = normalizeErrorPayload(undefined, 'Custom fallback');
        expect(err.message).toBe('Custom fallback');
    });
});
