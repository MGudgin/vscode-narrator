import { describe, test, expect, vi } from 'vitest';
import {
    APIConnectionError,
    APIConnectionTimeoutError,
    APIError,
    APIUserAbortError,
    AuthenticationError,
    BadRequestError,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
} from '@anthropic-ai/sdk';
import { StreamIdleTimeoutError, computeBackoffMs, isTransientError, withIdleTimeout, withTransientRetry } from './retry';

function makeApiError(status: number): APIError {
    return APIError.generate(status, undefined, undefined, undefined);
}

describe('isTransientError — Anthropic SDK errors', () => {
    test('classifies 429 RateLimitError as transient', () => {
        expect(isTransientError(new RateLimitError(429, undefined, undefined, {}))).toBe(true);
    });

    test('classifies 500 InternalServerError as transient', () => {
        expect(isTransientError(new InternalServerError(503, undefined, undefined, {}))).toBe(true);
    });

    test('classifies APIConnectionError as transient', () => {
        expect(isTransientError(new APIConnectionError({ message: 'reset' }))).toBe(true);
        expect(isTransientError(new APIConnectionTimeoutError({}))).toBe(true);
    });

    test('classifies APIUserAbortError as non-transient', () => {
        expect(isTransientError(new APIUserAbortError({}))).toBe(false);
    });

    test('classifies 4xx auth/validation errors as non-transient', () => {
        expect(isTransientError(new BadRequestError(400, undefined, undefined, {}))).toBe(false);
        expect(isTransientError(new AuthenticationError(401, undefined, undefined, {}))).toBe(false);
        expect(isTransientError(new PermissionDeniedError(403, undefined, undefined, {}))).toBe(false);
        expect(isTransientError(new NotFoundError(404, undefined, undefined, {}))).toBe(false);
    });

    test('treats 408/425/429 status as transient via base APIError', () => {
        expect(isTransientError(makeApiError(408))).toBe(true);
        expect(isTransientError(makeApiError(425))).toBe(true);
        expect(isTransientError(makeApiError(429))).toBe(true);
    });

    test('treats 5xx status as transient via base APIError', () => {
        expect(isTransientError(makeApiError(500))).toBe(true);
        expect(isTransientError(makeApiError(503))).toBe(true);
        expect(isTransientError(makeApiError(599))).toBe(true);
    });
});

describe('isTransientError — generic / VS Code LM errors', () => {
    test('Node.js network error codes are transient', () => {
        for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN']) {
            const err = Object.assign(new Error('boom'), { code });
            expect(isTransientError(err)).toBe(true);
        }
    });

    test('AbortError and ABORT_ERR are non-transient', () => {
        const abortByName = Object.assign(new Error('aborted'), { name: 'AbortError' });
        expect(isTransientError(abortByName)).toBe(false);
        const abortByCode = Object.assign(new Error('aborted'), { code: 'ABORT_ERR' });
        expect(isTransientError(abortByCode)).toBe(false);
    });

    test('message-based heuristics catch rate-limit / 503 / timeout phrasing', () => {
        expect(isTransientError(new Error('Too many requests, rate limit'))).toBe(true);
        expect(isTransientError(new Error('upstream returned 503'))).toBe(true);
        expect(isTransientError(new Error('request timed out'))).toBe(true);
        expect(isTransientError(new Error('service unavailable'))).toBe(true);
    });

    test('unknown errors default to non-transient', () => {
        expect(isTransientError(new Error('something broke'))).toBe(false);
        expect(isTransientError(null)).toBe(false);
        expect(isTransientError(undefined)).toBe(false);
        expect(isTransientError('string')).toBe(false);
    });

    test('walks `cause` chain', () => {
        const inner = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        const outer = Object.assign(new Error('wrapped'), { cause: inner });
        expect(isTransientError(outer)).toBe(true);
    });
});

describe('computeBackoffMs', () => {
    test('returns a non-negative integer below the exponential ceiling', () => {
        const orig = Math.random;
        Math.random = () => 0.9999;
        try {
            const d0 = computeBackoffMs(0, 100);
            const d1 = computeBackoffMs(1, 100);
            const d2 = computeBackoffMs(2, 100);
            expect(d0).toBeGreaterThanOrEqual(0);
            expect(d0).toBeLessThan(100);
            expect(d1).toBeLessThan(200);
            expect(d2).toBeLessThan(400);
        } finally {
            Math.random = orig;
        }
    });
});

describe('withTransientRetry', () => {
    test('returns the value on first success', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        const result = await withTransientRetry(fn, { sleep: async () => {} });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries transient errors up to maxAttempts and succeeds', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'ECONNRESET' }))
            .mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'ETIMEDOUT' }))
            .mockResolvedValue('ok');
        const onRetry = vi.fn();
        const result = await withTransientRetry(fn, {
            sleep: async () => {},
            onRetry,
        });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry.mock.calls[0][0].attempt).toBe(1);
        expect(onRetry.mock.calls[1][0].attempt).toBe(2);
    });

    test('throws non-transient errors immediately without retrying', async () => {
        const err = new Error('bad request');
        const fn = vi.fn().mockRejectedValue(err);
        await expect(withTransientRetry(fn, { sleep: async () => {} })).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('rethrows the last transient error after exhausting attempts', async () => {
        const transient = Object.assign(new Error('still down'), { code: 'ECONNRESET' });
        const fn = vi.fn().mockRejectedValue(transient);
        await expect(
            withTransientRetry(fn, { maxAttempts: 3, sleep: async () => {} }),
        ).rejects.toBe(transient);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    test('passes the attempt index to fn (0-based)', async () => {
        const seen: number[] = [];
        const fn = vi.fn(async (attempt: number) => {
            seen.push(attempt);
            if (attempt < 2) throw Object.assign(new Error('net'), { code: 'ECONNRESET' });
            return 'ok';
        });
        await withTransientRetry(fn, { sleep: async () => {} });
        expect(seen).toEqual([0, 1, 2]);
    });

    test('aborts when isCancelled returns true', async () => {
        let cancelled = false;
        const fn = vi.fn(async () => {
            cancelled = true;
            throw Object.assign(new Error('net'), { code: 'ECONNRESET' });
        });
        await expect(
            withTransientRetry(fn, {
                sleep: async () => {},
                isCancelled: () => cancelled,
            }),
        ).rejects.toBeDefined();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('uses provided backoff function and sleeps between attempts', async () => {
        const sleep = vi.fn(async () => {});
        const backoff = vi.fn((attempt: number) => 10 * (attempt + 1));
        const fn = vi.fn()
            .mockRejectedValueOnce(Object.assign(new Error('net'), { code: 'ECONNRESET' }))
            .mockResolvedValue('ok');
        await withTransientRetry(fn, { sleep, backoff });
        expect(backoff).toHaveBeenCalledWith(0, 500);
        expect(sleep).toHaveBeenCalledWith(10);
    });
});

describe('withIdleTimeout', () => {
    function neverYields(): AsyncIterable<string> {
        return {
            [Symbol.asyncIterator]() {
                return {
                    next(): Promise<IteratorResult<string>> {
                        // Pending forever — simulates a hung upstream stream.
                        return new Promise(() => { /* never resolves */ });
                    },
                };
            },
        };
    }

    async function asArray<T>(it: AsyncIterable<T>): Promise<T[]> {
        const out: T[] = [];
        for await (const v of it) out.push(v);
        return out;
    }

    test('throws StreamIdleTimeoutError when no chunk arrives within the window', async () => {
        // Drive the timer manually so the test is deterministic without
        // pulling in fake timers (the never-resolving promise is the
        // adversary here, not real time).
        let scheduled: (() => void) | undefined;
        const stream = withIdleTimeout(neverYields(), 50, {
            setTimer: (cb) => { scheduled = cb; return 'h'; },
            clearTimer: () => { scheduled = undefined; },
        });
        const iter = stream[Symbol.asyncIterator]();
        const pending = iter.next();
        // Fire the idle timer immediately.
        scheduled?.();
        await expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    });

    test('passes through values when the source yields before the timer fires', async () => {
        async function* source() {
            yield 'a';
            yield 'b';
            yield 'c';
        }
        // Real timer with a long window — values resolve immediately so the
        // timer never fires.
        expect(await asArray(withIdleTimeout(source(), 10_000))).toEqual(['a', 'b', 'c']);
    });

    test('returns the source unchanged when idleTimeoutMs is 0 (disabled)', async () => {
        async function* source() { yield 'x'; }
        const it = source();
        expect(withIdleTimeout(it, 0)).toBe(it);
    });

    test('returns the source unchanged when idleTimeoutMs is negative', async () => {
        async function* source() { yield 'x'; }
        const it = source();
        expect(withIdleTimeout(it, -1)).toBe(it);
    });

    test('classifies StreamIdleTimeoutError as transient so withTransientRetry retries it', () => {
        expect(isTransientError(new StreamIdleTimeoutError(60_000))).toBe(true);
    });

    test('clears the timer on a successful chunk so a steady stream never trips it', async () => {
        let scheduledCount = 0;
        let clearedCount = 0;
        async function* source() {
            yield '1';
            yield '2';
        }
        const stream = withIdleTimeout(source(), 100, {
            setTimer: () => { scheduledCount++; return 'h'; },
            clearTimer: () => { clearedCount++; },
        });
        expect(await asArray(stream)).toEqual(['1', '2']);
        // One arm/disarm pair per next() call (including the final end-of-stream poll).
        expect(scheduledCount).toBeGreaterThan(0);
        expect(scheduledCount).toBe(clearedCount);
    });
});
