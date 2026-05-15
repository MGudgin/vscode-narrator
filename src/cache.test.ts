import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { NarrationCache, fileKey, sectionKey, diffKey, treeDiffKey } from './cache';

const MAX_ENTRIES = 200;

class MemoryMemento implements vscode.Memento {
    private store = new Map<string, unknown>();
    keys(): readonly string[] { return Array.from(this.store.keys()); }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.store.has(key) ? (this.store.get(key) as T) : (defaultValue as T | undefined);
    }
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.store.delete(key);
        } else {
            this.store.set(key, value);
        }
    }
    setKeysForSync(_keys: readonly string[]): void {}
}

describe('NarrationCache', () => {
    let memento: MemoryMemento;
    let cache: NarrationCache;

    beforeEach(() => {
        memento = new MemoryMemento();
        cache = new NarrationCache(memento);
    });

    test('round-trips a value', async () => {
        await cache.set('k1', 'v1');
        expect(await cache.get('k1')).toBe('v1');
    });

    test('returns undefined for missing keys', async () => {
        expect(await cache.get('nope')).toBeUndefined();
    });

    test('overwrites existing keys', async () => {
        await cache.set('k1', 'first');
        await cache.set('k1', 'second');
        expect(await cache.get('k1')).toBe('second');
    });

    test('clearAll wipes every entry', async () => {
        await cache.set('a', '1');
        await cache.set('b', '2');
        await cache.clearAll();
        expect(await cache.get('a')).toBeUndefined();
        expect(await cache.get('b')).toBeUndefined();
    });
});

describe('NarrationCache LRU eviction', () => {
    let memento: MemoryMemento;
    let cache: NarrationCache;
    let fakeNow = 0;

    beforeEach(() => {
        memento = new MemoryMemento();
        cache = new NarrationCache(memento);
        fakeNow = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => ++fakeNow);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test(`caps the store at ${MAX_ENTRIES} entries`, async () => {
        for (let i = 0; i < MAX_ENTRIES + 10; i++) {
            await cache.set(`k${i}`, `v${i}`);
        }
        const stored = memento.get<unknown[]>('codeNarration.cache.v1', []);
        expect(stored).toHaveLength(MAX_ENTRIES);
    });

    test('evicts the oldest entries first when over capacity', async () => {
        for (let i = 0; i < MAX_ENTRIES + 1; i++) {
            await cache.set(`k${i}`, `v${i}`);
        }
        // The first-set entry has the smallest timestamp, so it gets dropped.
        expect(await cache.get('k0')).toBeUndefined();
        // The most recently added entries remain.
        expect(await cache.get(`k${MAX_ENTRIES}`)).toBe(`v${MAX_ENTRIES}`);
        expect(await cache.get('k1')).toBe('v1');
    });

    test('get() refreshes the timestamp so a touched entry survives eviction', async () => {
        await cache.set('keep', 'kept-value');
        // Fill enough entries so we are at exactly MAX_ENTRIES with 'keep' as the oldest.
        for (let i = 0; i < MAX_ENTRIES - 1; i++) {
            await cache.set(`fill${i}`, `v${i}`);
        }
        // Touch 'keep' to bump its timestamp ahead of the oldest fill entries.
        expect(await cache.get('keep')).toBe('kept-value');
        // Add two more so something must be evicted; 'keep' should survive.
        await cache.set('new1', 'n1');
        await cache.set('new2', 'n2');
        expect(await cache.get('keep')).toBe('kept-value');
        expect(await cache.get('fill0')).toBeUndefined();
    });

    test('setMany writes multiple entries atomically without losing any to RMW races', async () => {
        const updates = Array.from({ length: 5 }, (_, i) => ({ key: `m${i}`, markdown: `v${i}` }));
        await cache.setMany(updates);
        for (let i = 0; i < 5; i++) {
            expect(await cache.get(`m${i}`)).toBe(`v${i}`);
        }
    });

    test('setMany() is a no-op for an empty update list', async () => {
        await cache.set('pre', 'existing');
        await cache.setMany([]);
        expect(await cache.get('pre')).toBe('existing');
    });
});

describe('NarrationCache resilience to corrupt persisted state', () => {
    let memento: MemoryMemento;
    let cache: NarrationCache;
    const STATE_KEY = 'codeNarration.cache.v1';

    beforeEach(() => {
        memento = new MemoryMemento();
        cache = new NarrationCache(memento);
    });

    test('returns undefined when state is a non-array object', async () => {
        await memento.update(STATE_KEY, { wrong: 'shape' });
        await expect(cache.get('any')).resolves.toBeUndefined();
    });

    test('returns undefined when state is null', async () => {
        await memento.update(STATE_KEY, null);
        await expect(cache.get('any')).resolves.toBeUndefined();
    });

    test('returns undefined when state is a string', async () => {
        await memento.update(STATE_KEY, 'not-an-array');
        await expect(cache.get('any')).resolves.toBeUndefined();
    });

    test('returns undefined when state is a number', async () => {
        await memento.update(STATE_KEY, 42);
        await expect(cache.get('any')).resolves.toBeUndefined();
    });

    test('skips malformed entries inside a partially-corrupt array', async () => {
        await memento.update(STATE_KEY, [
            { key: 'good', markdown: 'value', timestamp: 1 },
            null,
            'not-an-entry',
            { key: 'no-markdown', timestamp: 2 },
            { key: 'wrong-types', markdown: 5, timestamp: 'oops' },
            { key: 'good2', markdown: 'value2', timestamp: 3 },
        ]);
        expect(await cache.get('good')).toBe('value');
        expect(await cache.get('good2')).toBe('value2');
        expect(await cache.get('no-markdown')).toBeUndefined();
        expect(await cache.get('wrong-types')).toBeUndefined();
    });

    test('set() recovers a bricked cache by overwriting corrupt state', async () => {
        await memento.update(STATE_KEY, { wrong: 'shape' });
        await cache.set('k', 'v');
        expect(await cache.get('k')).toBe('v');
    });
});

describe('cache key builders', () => {
    const uri = vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri;
    const provider = { kind: 'anthropic', model: 'claude-sonnet-4-6' };

    test('fileKey is deterministic for identical inputs', () => {
        expect(fileKey(uri, 'content', provider)).toBe(fileKey(uri, 'content', provider));
    });

    test('fileKey changes when content changes', () => {
        expect(fileKey(uri, 'a', provider)).not.toBe(fileKey(uri, 'b', provider));
    });

    test('fileKey changes when model changes', () => {
        const other = { kind: 'anthropic', model: 'claude-opus-4-7' };
        expect(fileKey(uri, 'content', provider)).not.toBe(fileKey(uri, 'content', other));
    });

    test('fileKey and diffKey for the same file are distinct', () => {
        expect(fileKey(uri, 'content', provider))
            .not.toBe(diffKey(uri, 'content', 'HEAD', provider));
    });

    test('diffKey changes when base ref changes', () => {
        expect(diffKey(uri, 'd', 'HEAD', provider))
            .not.toBe(diffKey(uri, 'd', 'origin/main', provider));
    });

    test('treeDiffKey is distinct from fileKey and diffKey for the same uri/content', () => {
        // Same uri on every call so the discriminator field is the only thing that can disambiguate.
        const tree = treeDiffKey(uri, 'combined', 'HEAD', provider);
        expect(tree).not.toBe(fileKey(uri, 'combined', provider));
        expect(tree).not.toBe(diffKey(uri, 'combined', 'HEAD', provider));
    });

    test('treeDiffKey changes when combined diff changes', () => {
        const repoRoot = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;
        expect(treeDiffKey(repoRoot, 'a', 'HEAD', provider))
            .not.toBe(treeDiffKey(repoRoot, 'b', 'HEAD', provider));
    });

    test('treeDiffKey changes when base ref changes', () => {
        const repoRoot = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;
        expect(treeDiffKey(repoRoot, 'd', 'HEAD', provider))
            .not.toBe(treeDiffKey(repoRoot, 'd', 'origin/main', provider));
    });

    test('sectionKey is deterministic for identical inputs', () => {
        expect(sectionKey(uri, 'foo', 'body', 50000, provider))
            .toBe(sectionKey(uri, 'foo', 'body', 50000, provider));
    });

    test('sectionKey changes when the unit text changes', () => {
        expect(sectionKey(uri, 'foo', 'a', 50000, provider))
            .not.toBe(sectionKey(uri, 'foo', 'b', 50000, provider));
    });

    test('sectionKey changes when the unit name changes', () => {
        expect(sectionKey(uri, 'foo', 'body', 50000, provider))
            .not.toBe(sectionKey(uri, 'bar', 'body', 50000, provider));
    });

    test('sectionKey changes when maxPromptTokens changes', () => {
        // Sub-chunking shape depends on the prompt-token budget, so cached
        // bodies are not interchangeable across different budgets.
        expect(sectionKey(uri, 'foo', 'body', 5000, provider))
            .not.toBe(sectionKey(uri, 'foo', 'body', 50000, provider));
    });

    test('sectionKey is distinct from fileKey for the same uri+text', () => {
        expect(sectionKey(uri, 'foo', 'body', 50000, provider))
            .not.toBe(fileKey(uri, 'body', provider));
    });
});
