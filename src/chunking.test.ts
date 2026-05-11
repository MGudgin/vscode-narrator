import { describe, test, expect } from 'vitest';
import {
    estimateTokens,
    shouldSubChunk,
    splitLineRange,
    formatLineRangeLabel,
    DEFAULT_OVERLAP_LINES,
} from './chunking';

describe('estimateTokens', () => {
    test('returns 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    test('uses the length / 4 heuristic, rounding up', () => {
        // 17 chars / 4 = 4.25 → 5
        expect(estimateTokens('a'.repeat(17))).toBe(5);
        // 16 chars / 4 = 4 exact
        expect(estimateTokens('a'.repeat(16))).toBe(4);
    });
});

describe('shouldSubChunk', () => {
    test('returns false when the prompt fits comfortably', () => {
        const body = 'a'.repeat(100); // ~25 tokens
        expect(shouldSubChunk(body, 50_000)).toBe(false);
    });

    test('returns true when the estimated tokens exceed the cap', () => {
        // 1_000_000 chars / 4 = 250_000 tokens — well over the cap.
        const body = 'a'.repeat(1_000_000);
        expect(shouldSubChunk(body, 50_000)).toBe(true);
    });

    test('returns false for a non-finite or zero budget (defensive: caller misconfig)', () => {
        const body = 'a'.repeat(1_000_000);
        expect(shouldSubChunk(body, 0)).toBe(false);
        expect(shouldSubChunk(body, Number.POSITIVE_INFINITY)).toBe(false);
        expect(shouldSubChunk(body, Number.NaN)).toBe(false);
    });
});

describe('splitLineRange', () => {
    test('returns a single range when total tokens fit under the cap', () => {
        const ranges = splitLineRange(10, 50, 4_000, { maxPromptTokens: 50_000 });
        expect(ranges).toEqual([{ startLine: 10, endLine: 50 }]);
    });

    test('returns [] when endLine < startLine', () => {
        expect(splitLineRange(20, 10, 1000, { maxPromptTokens: 50_000 })).toEqual([]);
    });

    test('splits into multiple chunks when the body is over the cap', () => {
        // 800_000 chars => 200_000 tokens, cap 50_000 => need >=4 chunks at
        // the 80% target (40_000 per chunk).
        const ranges = splitLineRange(0, 999, 800_000, {
            maxPromptTokens: 50_000,
            overlapLines: 0,
        });
        expect(ranges.length).toBeGreaterThanOrEqual(4);
        // Covers the full range, including the final line.
        expect(ranges[0].startLine).toBe(0);
        expect(ranges[ranges.length - 1].endLine).toBe(999);
    });

    test('consecutive chunks overlap by the configured number of lines', () => {
        const ranges = splitLineRange(0, 999, 800_000, {
            maxPromptTokens: 50_000,
            overlapLines: 8,
        });
        expect(ranges.length).toBeGreaterThan(1);
        for (let i = 1; i < ranges.length; i++) {
            const prev = ranges[i - 1];
            const curr = ranges[i];
            // current.startLine sits inside the previous chunk's tail —
            // overlap == prev.endLine - curr.startLine + 1.
            const overlap = prev.endLine - curr.startLine + 1;
            // Allow a one-line slack on the last chunk (it shrinks to fit
            // the remainder), but every internal chunk should have at least
            // a few lines of overlap.
            expect(overlap).toBeGreaterThanOrEqual(1);
            expect(overlap).toBeLessThanOrEqual(8 + 1);
        }
    });

    test('preserves coverage with no gaps between chunks', () => {
        const ranges = splitLineRange(0, 499, 400_000, {
            maxPromptTokens: 50_000,
            overlapLines: 5,
        });
        // The union of all ranges must cover every line from 0..499.
        const covered = new Set<number>();
        for (const r of ranges) {
            for (let i = r.startLine; i <= r.endLine; i++) covered.add(i);
        }
        for (let line = 0; line <= 499; line++) {
            expect(covered.has(line)).toBe(true);
        }
    });

    test('uses the default overlap when none is supplied', () => {
        const ranges = splitLineRange(0, 999, 800_000, { maxPromptTokens: 50_000 });
        if (ranges.length > 1) {
            const overlap = ranges[0].endLine - ranges[1].startLine + 1;
            expect(overlap).toBeGreaterThanOrEqual(1);
            expect(overlap).toBeLessThanOrEqual(DEFAULT_OVERLAP_LINES + 1);
        }
    });

    test('honours a small minChunkLines floor on tiny remainders', () => {
        // A pathological case: 10000 lines, but estimated chars are huge so
        // chunkCount would push baseLinesPerChunk below 10.
        const ranges = splitLineRange(0, 9999, 100_000_000, {
            maxPromptTokens: 50_000,
            overlapLines: 0,
            minChunkLines: 10,
        });
        for (const r of ranges) {
            // Last chunk may be shorter than the floor; only enforce on
            // interior chunks.
            const isLast = r.endLine === 9999;
            if (!isLast) {
                expect(r.endLine - r.startLine + 1).toBeGreaterThanOrEqual(10);
            }
        }
    });

    test('handles a single-line range without splitting', () => {
        const ranges = splitLineRange(42, 42, 10, { maxPromptTokens: 50_000 });
        expect(ranges).toEqual([{ startLine: 42, endLine: 42 }]);
    });
});

describe('formatLineRangeLabel', () => {
    test('formats a single-line range as L<n>', () => {
        expect(formatLineRangeLabel({ startLine: 0, endLine: 0 })).toBe('L1');
        expect(formatLineRangeLabel({ startLine: 41, endLine: 41 })).toBe('L42');
    });

    test('formats a multi-line range as L<start>-L<end> with 1-based indices', () => {
        expect(formatLineRangeLabel({ startLine: 9, endLine: 19 })).toBe('L10-L20');
    });
});
