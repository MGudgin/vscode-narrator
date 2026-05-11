import { describe, test, expect } from 'vitest';
import { aggregateBannerStatus } from './webview';

describe('aggregateBannerStatus', () => {
    test('returns "hidden" when no sections are present', () => {
        expect(aggregateBannerStatus([])).toBe('hidden');
    });

    test('returns "streaming" when any section is still queued', () => {
        expect(aggregateBannerStatus(['queued'])).toBe('streaming');
        expect(aggregateBannerStatus(['queued', 'complete'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete', 'queued', 'complete'])).toBe('streaming');
    });

    test('returns "streaming" when any section is actively streaming', () => {
        expect(aggregateBannerStatus(['streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete', 'streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['streaming', 'complete', 'queued'])).toBe('streaming');
    });

    test('returns "complete" only when every section is complete', () => {
        expect(aggregateBannerStatus(['complete'])).toBe('complete');
        expect(aggregateBannerStatus(['complete', 'complete', 'complete'])).toBe('complete');
    });

    test('handles single-section diff-mode style input', () => {
        // Diff-modified mode emits one section.
        expect(aggregateBannerStatus(['queued'])).toBe('streaming');
        expect(aggregateBannerStatus(['streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete'])).toBe('complete');
    });

    test('accepts any iterable, not just arrays', () => {
        const set = new Set<'queued' | 'streaming' | 'complete'>(['streaming', 'complete']);
        expect(aggregateBannerStatus(set)).toBe('streaming');
    });
});
