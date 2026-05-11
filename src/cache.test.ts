import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { NarrationCache, fileKey, diffKey, treeDiffKey } from './cache';

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

    test('caps the store at 50 entries', async () => {
        for (let i = 0; i < 60; i++) {
            await cache.set(`k${i}`, `v${i}`);
        }
        const stored = memento.get<unknown[]>('codeNarration.cache.v1', []);
        expect(stored).toHaveLength(50);
    });

    test('evicts the oldest entries first when over capacity', async () => {
        for (let i = 0; i < 51; i++) {
            await cache.set(`k${i}`, `v${i}`);
        }
        // The first-set entry has the smallest timestamp, so it gets dropped.
        expect(await cache.get('k0')).toBeUndefined();
        // The most recently added entries remain.
        expect(await cache.get('k50')).toBe('v50');
        expect(await cache.get('k1')).toBe('v1');
    });

    test('get() refreshes the timestamp so a touched entry survives eviction', async () => {
        await cache.set('keep', 'kept-value');
        // Fill another 49 entries so we are at exactly 50 with 'keep' as the oldest.
        for (let i = 0; i < 49; i++) {
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
});
