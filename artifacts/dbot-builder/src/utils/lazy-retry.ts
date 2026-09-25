import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type Factory<R> = () => Promise<R>;

/**
 * `React.lazy` with bounded retries.
 *
 * A single failed chunk fetch (tunnel flap, brief offline moment on mobile,
 * cold CDN edge) would otherwise surface through the nearest error boundary as
 * the "Sorry for the interruption" screen and take the whole builder — and any
 * running bot — down with it. Retrying the dynamic import a couple of times
 * with a small backoff heals the transient cases; a persistent failure still
 * rejects to the boundary as before.
 */
export function lazyWithRetry<R extends { default: ComponentType<unknown> }>(
    factory: Factory<R>,
    retries = 2,
    backoff_ms = 350,
): LazyExoticComponent<R['default']> {
    return lazy(async () => {
        let last_error: unknown;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await factory();
            } catch (error) {
                last_error = error;
                if (attempt < retries) {
                    await new Promise(resolve => setTimeout(resolve, backoff_ms * (attempt + 1)));
                }
            }
        }

        throw last_error;
    });
}
