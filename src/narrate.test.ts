import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    narrateDocument,
    narrateDiff,
    NarrationEvent,
    NarrationOptions,
    NarrationSink,
} from './narrate';
import { NarrationCache, fileKey, diffKey } from './cache';
import { NarrationProvider, ProviderInfo } from './llm/index';
import { NarrationUnit } from './symbols';
import { DiffResult } from './diff';

class MemoryMemento implements vscode.Memento {
    private store = new Map<string, unknown>();
    keys(): readonly string[] { return Array.from(this.store.keys()); }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.store.has(key) ? (this.store.get(key) as T) : (defaultValue as T | undefined);
    }
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) this.store.delete(key);
        else this.store.set(key, value);
    }
    setKeysForSync(_keys: readonly string[]): void {}
}

function mockDoc(text: string): vscode.TextDocument {
    const lines = text.split('\n');
    return {
        uri: vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri,
        languageId: 'typescript',
        lineCount: lines.length,
        getText: () => text,
        lineAt: (line: number) => ({
            text: lines[line] ?? '',
            range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
        }),
    } as unknown as vscode.TextDocument;
}

function liveToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

function preCancelledToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

interface ProviderCall { systemPrompt: string; userPrompt: string; }

function chunkProvider(chunks: string[], record?: ProviderCall[]): NarrationProvider {
    return {
        async *stream(systemPrompt: string, userPrompt: string) {
            record?.push({ systemPrompt, userPrompt });
            for (const c of chunks) yield c;
        },
    };
}

const providerInfo: ProviderInfo = { kind: 'test', model: 'm1' };

function makeOptions(extra: Partial<NarrationOptions> = {}): { options: NarrationOptions; cache: NarrationCache } {
    const cache = new NarrationCache(new MemoryMemento());
    const options: NarrationOptions = {
        skipCache: false,
        cache,
        providerInfo,
        ...extra,
    };
    return { options, cache };
}

function collectSink(): { sink: NarrationSink; events: NarrationEvent[] } {
    const events: NarrationEvent[] = [];
    return { sink: (e) => events.push(e), events };
}

describe('narrateDocument', () => {
    test('returns cached markdown without calling the provider on a cache hit', async () => {
        const { options, cache } = makeOptions({ fetchUnits: async () => [] });
        const doc = mockDoc('hello world\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['SHOULD-NOT-APPEAR'], calls);

        // Pre-populate the cache with a value matching the file key.

        await cache.set(fileKey(doc.uri, doc.getText(), providerInfo), '## cached body');

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(calls).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.fromCache).toBe(true);
        expect(init.sections.some((s) => s.bodyMarkdown === '## cached body')).toBe(true);
        expect(events[events.length - 1]).toEqual({ kind: 'done' });
    });

    test('falls back to whole-file streaming when no symbols are present', async () => {
        const { options, cache } = makeOptions({ fetchUnits: async () => [] });
        const doc = mockDoc('a = 1\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['## H', 'ello'], calls);

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections.map((s) => s.id)).toEqual(['main']);
        const chunks = events.filter((e) => e.kind === 'chunk');
        expect(chunks).toHaveLength(2);
        expect(events.some((e) => e.kind === 'sectionDone')).toBe(true);
        expect(events[events.length - 1]).toEqual({ kind: 'done' });

        // Result is cached

        expect(await cache.get(fileKey(doc.uri, doc.getText(), providerInfo))).toBe('## Hello');
    });

    test('emits one section per narration unit and one provider call per unit', async () => {
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'foo', range: new vscode.Range(0, 0, 1, 0) },
            { kind: 'symbol', name: 'bar', range: new vscode.Range(2, 0, 3, 0) },
            { kind: 'symbol', name: 'baz', range: new vscode.Range(4, 0, 5, 0) },
        ];
        const { options } = makeOptions({ fetchUnits: async () => units, concurrency: 4 });
        const doc = mockDoc('line0\nline1\nline2\nline3\nline4\nline5\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(calls).toHaveLength(3);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections.map((s) => s.id)).toEqual(['s0', 's1', 's2']);
        const sectionDones = events.filter((e) => e.kind === 'sectionDone');
        expect(sectionDones).toHaveLength(3);
    });

    test('skipCache=true bypasses the cached value and re-streams', async () => {
        const { options, cache } = makeOptions({ fetchUnits: async () => [], skipCache: true });
        const doc = mockDoc('content\n');

        await cache.set(fileKey(doc.uri, doc.getText(), providerInfo), 'old');

        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['fresh'], calls);

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        expect(events.some((e) => e.kind === 'chunk' && e.text === 'fresh')).toBe(true);
        // After streaming, the new value overwrites the cache.
        expect(await cache.get(fileKey(doc.uri, doc.getText(), providerInfo))).toBe('fresh');
    });

    test('returns early without calling the provider when the token is already cancelled', async () => {
        const { options } = makeOptions({ fetchUnits: async () => [] });
        const doc = mockDoc('content\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['x'], calls);

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, preCancelledToken(), sink, options);

        // Init may or may not have fired depending on the path, but no chunks should be emitted.
        expect(events.some((e) => e.kind === 'chunk')).toBe(false);
    });

    test('respects the concurrency cap when there are more units than workers', async () => {
        const units: NarrationUnit[] = Array.from({ length: 6 }, (_, i) => ({
            kind: 'symbol' as const,
            name: `s${i}`,
            range: new vscode.Range(i, 0, i, 0),
        }));
        let inFlight = 0;
        let peak = 0;
        const provider: NarrationProvider = {
            async *stream() {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise<void>((r) => setImmediate(r));
                yield 'x';
                inFlight--;
            },
        };

        const { options } = makeOptions({ fetchUnits: async () => units, concurrency: 2 });
        const doc = mockDoc(Array.from({ length: 6 }, (_, i) => `line${i}`).join('\n'));

        const { sink } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(peak).toBeLessThanOrEqual(2);
        expect(peak).toBe(2);
    });
});

describe('narrateDiff', () => {
    test('throws when the file is not in a git repository', async () => {
        const { options } = makeOptions({ fetchDiff: async () => ({ kind: 'noRepo' } as DiffResult) });
        const doc = mockDoc('hello\n');
        const { sink } = collectSink();

        await expect(
            narrateDiff(doc, 'HEAD', chunkProvider([]), liveToken(), sink, options),
        ).rejects.toThrow(/not in a git repository/);
    });

    test('emits a "No changes" section when there is no diff', async () => {
        const { options } = makeOptions({ fetchDiff: async () => ({ kind: 'noChanges' } as DiffResult) });
        const doc = mockDoc('hello\n');
        const calls: ProviderCall[] = [];
        const { sink, events } = collectSink();

        await narrateDiff(doc, 'origin/main', chunkProvider([], calls), liveToken(), sink, options);

        expect(calls).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections[0].bodyMarkdown).toContain('No changes');
        expect(init.sections[0].bodyMarkdown).toContain('origin/main');
        expect(events[events.length - 1]).toEqual({ kind: 'done' });
    });

    test('newFile narrates the whole file with a banner prefix section', async () => {
        const { options } = makeOptions({
            fetchDiff: async () => ({ kind: 'newFile' } as DiffResult),
            fetchUnits: async () => [],
        });
        const doc = mockDoc('content\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['fresh'], calls);
        const { sink, events } = collectSink();

        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections.some((s) => s.id === 'banner' && s.bodyMarkdown?.includes('Newly added file'))).toBe(true);
        expect(events.some((e) => e.kind === 'chunk')).toBe(true);
    });

    test('modified streams the diff prompt and caches the result', async () => {
        const diff: DiffResult = { kind: 'modified', unifiedDiff: '@@ -1 +1 @@\n-old\n+new' };
        const { options, cache } = makeOptions({ fetchDiff: async () => diff });
        const doc = mockDoc('new\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['## diff narration'], calls);
        const { sink, events } = collectSink();

        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        expect(calls[0].userPrompt).toContain('+new');
        expect(events.some((e) => e.kind === 'sectionDone')).toBe(true);


        const stored = await cache.get(diffKey(doc.uri, diff.unifiedDiff, 'origin/main', providerInfo));
        expect(stored).toBe('## diff narration');
    });

    test('modified returns a cache hit without calling the provider', async () => {
        const diff: DiffResult = { kind: 'modified', unifiedDiff: '@@ x' };
        const { options, cache } = makeOptions({ fetchDiff: async () => diff });
        const doc = mockDoc('new\n');

        await cache.set(diffKey(doc.uri, diff.unifiedDiff, 'origin/main', providerInfo), 'cached diff');

        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['SHOULD-NOT-APPEAR'], calls);
        const { sink, events } = collectSink();
        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        expect(calls).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.fromCache).toBe(true);
        expect(init.sections.some((s) => s.bodyMarkdown === 'cached diff')).toBe(true);
    });

    test('modified with skipCache re-streams even when a cache entry exists', async () => {
        const diff: DiffResult = { kind: 'modified', unifiedDiff: '@@ y' };
        const { options, cache } = makeOptions({ fetchDiff: async () => diff, skipCache: true });
        const doc = mockDoc('new\n');

        await cache.set(diffKey(doc.uri, diff.unifiedDiff, 'origin/main', providerInfo), 'stale');

        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['fresh'], calls);
        const { sink } = collectSink();
        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        expect(await cache.get(diffKey(doc.uri, diff.unifiedDiff, 'origin/main', providerInfo))).toBe('fresh');
    });

    test('returns early without throwing when the token is cancelled before fetching the diff completes', async () => {
        const { options } = makeOptions({ fetchDiff: async () => ({ kind: 'noChanges' } as DiffResult) });
        const doc = mockDoc('hello\n');
        const { sink, events } = collectSink();

        await narrateDiff(doc, 'origin/main', chunkProvider([]), preCancelledToken(), sink, options);

        // Pre-cancelled token should short-circuit before emitting any events.
        expect(events).toHaveLength(0);
    });
});
