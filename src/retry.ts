import {
    APIError,
    APIConnectionError,
    APIUserAbortError,
    InternalServerError,
    RateLimitError,
} from '@anthropic-ai/sdk';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BASE_DELAY_MS = 500;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;

export class StreamIdleTimeoutError extends Error {
    constructor(idleTimeoutMs: number) {
        super(`Stream idle for more than ${idleTimeoutMs}ms; aborting.`);
        this.name = 'StreamIdleTimeoutError';
    }
}

export interface IdleTimeoutOptions {
    setTimer?: (cb: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
}

/**
 * Wrap an async iterable so it throws `StreamIdleTimeoutError` when no chunk
 * arrives within `idleTimeoutMs`. Pass `0` (or any non-positive number) to
 * disable the timeout. The timer is reset on every yielded chunk so a slow
 * but steady stream completes normally; only true stalls trip the timeout.
 */
export function withIdleTimeout<T>(
    source: AsyncIterable<T>,
    idleTimeoutMs: number,
    opts: IdleTimeoutOptions = {},
): AsyncIterable<T> {
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return source;
    const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    return {
        [Symbol.asyncIterator](): AsyncIterator<T> {
            const iterator = source[Symbol.asyncIterator]();
            let timer: unknown;
            const armTimer = (reject: (err: unknown) => void) => {
                timer = setTimer(() => reject(new StreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
            };
            const disarmTimer = () => {
                if (timer !== undefined) {
                    clearTimer(timer);
                    timer = undefined;
                }
            };
            return {
                async next(): Promise<IteratorResult<T>> {
                    return new Promise<IteratorResult<T>>((resolve, reject) => {
                        armTimer((err) => {
                            // On timeout, attempt to close the underlying iterator so
                            // upstream resources (HTTP sockets, etc.) are released.
                            iterator.return?.().catch(() => { /* swallow */ });
                            reject(err);
                        });
                        iterator.next().then(
                            (result) => {
                                disarmTimer();
                                resolve(result);
                            },
                            (err) => {
                                disarmTimer();
                                reject(err);
                            },
                        );
                    });
                },
                async return(value?: T): Promise<IteratorResult<T>> {
                    disarmTimer();
                    if (iterator.return) return iterator.return(value);
                    return { value: value as T, done: true };
                },
                async throw(err?: unknown): Promise<IteratorResult<T>> {
                    disarmTimer();
                    if (iterator.throw) return iterator.throw(err);
                    throw err;
                },
            };
        },
    };
}

const TRANSIENT_NODE_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EPIPE',
]);

export function isTransientError(err: unknown): boolean {
    if (err === null || err === undefined) return false;

    if (err instanceof StreamIdleTimeoutError) return true;
    if (err instanceof APIUserAbortError) return false;
    if (err instanceof APIConnectionError) return true;
    if (err instanceof RateLimitError) return true;
    if (err instanceof InternalServerError) return true;
    if (err instanceof APIError) {
        const status = err.status;
        if (typeof status === 'number') {
            if (status === 408 || status === 425 || status === 429) return true;
            return status >= 500 && status < 600;
        }
        return false;
    }

    if (typeof err !== 'object') return false;
    const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };

    const name = typeof e.name === 'string' ? e.name : '';
    if (name === 'AbortError' || name === 'CancellationError') return false;

    const code = typeof e.code === 'string' ? e.code : '';
    if (code === 'ABORT_ERR') return false;
    if (TRANSIENT_NODE_CODES.has(code)) return true;

    if (e.cause && e.cause !== err && isTransientError(e.cause)) return true;

    const message = typeof e.message === 'string' ? e.message : '';
    if (/\b(429|503|504|rate ?limit|timed? ?out|temporarily unavailable|connection reset|service unavailable)\b/i.test(message)) {
        return true;
    }

    return false;
}

export function computeBackoffMs(attempt: number, baseDelayMs: number = DEFAULT_BASE_DELAY_MS): number {
    const ceiling = baseDelayMs * Math.pow(2, attempt);
    return Math.floor(Math.random() * ceiling);
}

export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    isTransient?: (err: unknown) => boolean;
    isCancelled?: () => boolean;
    onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void | Promise<void>;
    sleep?: (ms: number) => Promise<void>;
    backoff?: (attempt: number, baseDelayMs: number) => number;
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        const handle = setTimeout(resolve, ms) as unknown as { unref?: () => void };
        if (typeof handle.unref === 'function') handle.unref();
    });

export async function withTransientRetry<T>(
    fn: (attempt: number) => Promise<T>,
    opts: RetryOptions = {},
): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const transient = opts.isTransient ?? isTransientError;
    const sleep = opts.sleep ?? defaultSleep;
    const backoff = opts.backoff ?? computeBackoffMs;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (opts.isCancelled?.()) throw lastError ?? new Error('cancelled');
        try {
            return await fn(attempt);
        } catch (err) {
            lastError = err;
            if (opts.isCancelled?.()) throw err;
            if (!transient(err)) throw err;
            if (attempt === maxAttempts - 1) throw err;
            const delayMs = backoff(attempt, baseDelayMs);
            await opts.onRetry?.({ attempt: attempt + 1, error: err, delayMs });
            await sleep(delayMs);
        }
    }
    throw lastError;
}
