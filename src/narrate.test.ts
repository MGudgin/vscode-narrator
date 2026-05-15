import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    narrateDocument,
    narrateDiff,
    narrateTreeDiff,
    NarrationEvent,
    NarrationOptions,
    NarrationSink,
} from './narrate';
import { NarrationCache, fileKey, sectionKey, diffKey, treeDiffKey } from './cache';
import { DEFAULT_MAX_PROMPT_TOKENS } from './chunking';
import { NarrationProvider, ProviderInfo } from './llm/index';
import { NarrationUnit } from './symbols';
import { DiffResult, TreeDiffResult } from './diff';

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
        getText: (range?: vscode.Range) => {
            if (!range) return text;
            const startLine = range.start.line;
            const endLine = range.end.line;
            return lines.slice(startLine, endLine + 1).join('\n');
        },
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

    test('sub-chunks an oversized unit and merges the chunk narrations into one section', async () => {
        // One symbol covering ~1000 lines of 200 chars each → ~50k tokens —
        // forces sub-chunking when maxPromptTokens is set to 5_000.
        const totalLines = 1000;
        const lineText = 'x'.repeat(200);
        const docText = Array.from({ length: totalLines }, () => lineText).join('\n');
        const doc = mockDoc(docText);
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'huge', range: new vscode.Range(0, 0, totalLines - 1, lineText.length) },
        ];
        const { options } = makeOptions({
            fetchUnits: async () => units,
            concurrency: 1,
            maxPromptTokens: 5_000,
        });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);

        const { sink, events } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        // More than one provider call → sub-chunked.
        expect(calls.length).toBeGreaterThan(1);
        // Every per-chunk user prompt should carry the chunk-marker text.
        for (const c of calls) {
            expect(c.userPrompt).toContain('sub-chunk of an oversized section');
        }
        // The merged section emits subheadings marking each chunk.
        const chunkEvents = events.filter((e) => e.kind === 'chunk') as Extract<NarrationEvent, { kind: 'chunk' }>[];
        const merged = chunkEvents.map((c) => c.text).join('');
        expect(merged).toMatch(/### Lines \[L\d+-L\d+\]/);
        expect(events.some((e) => e.kind === 'sectionDone')).toBe(true);
    });

    test('does NOT sub-chunk when the symbol body fits the budget', async () => {
        const doc = mockDoc('short content\nstill short\n');
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'small', range: new vscode.Range(0, 0, 1, 11) },
        ];
        const { options } = makeOptions({
            fetchUnits: async () => units,
            concurrency: 1,
            maxPromptTokens: 50_000,
        });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['ok'], calls);

        const { sink } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        // Exactly one call when the body fits.
        expect(calls).toHaveLength(1);
        expect(calls[0].userPrompt).not.toContain('sub-chunk');
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

    test('does not write the cache when any symbol section fails', async () => {
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'foo', range: new vscode.Range(0, 0, 1, 0) },
            { kind: 'symbol', name: 'bar', range: new vscode.Range(2, 0, 3, 0) },
        ];
        const { options, cache } = makeOptions({ fetchUnits: async () => units, concurrency: 2 });
        const doc = mockDoc('line0\nline1\nline2\nline3\n');

        // First unit streams cleanly; second throws non-transient so withTransientRetry
        // rethrows on first attempt and the section catch sets anyFailure.
        let n = 0;
        const provider: NarrationProvider = {
            async *stream() {
                const i = n++;
                if (i === 1) throw new Error('boom');
                yield 'ok.';
            },
        };

        const { sink } = collectSink();
        await narrateDocument(doc, provider, liveToken(), sink, options);

        // Per-section caching: the successful section's key must remain unwritten
        // when any sibling section fails — preserves the existing all-or-nothing
        // guarantee on a per-narration basis.
        const fooKey = sectionKey(
            doc.uri,
            'foo',
            doc.getText(new vscode.Range(0, 0, 1, 0)),
            DEFAULT_MAX_PROMPT_TOKENS,
            providerInfo,
        );
        expect(await cache.get(fooKey)).toBeUndefined();
    });

    test('per-section cache: editing one section re-narrates only that section', async () => {
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'foo', range: new vscode.Range(0, 0, 0, 8) },
            { kind: 'symbol', name: 'bar', range: new vscode.Range(1, 0, 1, 8) },
            { kind: 'symbol', name: 'baz', range: new vscode.Range(2, 0, 2, 8) },
        ];
        const { options } = makeOptions({ fetchUnits: async () => units, concurrency: 4 });

        // First narration: cold cache, expect one provider call per unit.
        const doc1 = mockDoc('foo body\nbar body\nbaz body\n');
        const calls1: ProviderCall[] = [];
        const provider1 = chunkProvider(['narration.'], calls1);
        const { sink: sink1 } = collectSink();
        await narrateDocument(doc1, provider1, liveToken(), sink1, options);
        expect(calls1).toHaveLength(3);

        // Second narration with the same provider+options but only "bar"'s
        // line changed. Per-section cache should hit foo and baz, miss bar.
        const doc2 = mockDoc('foo body\nBAR EDITED\nbaz body\n');
        const calls2: ProviderCall[] = [];
        const provider2 = chunkProvider(['fresh.'], calls2);
        const { sink: sink2, events: events2 } = collectSink();
        await narrateDocument(doc2, provider2, liveToken(), sink2, options);

        // Acceptance criterion: exactly one LLM call on a single-section edit.
        expect(calls2).toHaveLength(1);
        expect(calls2[0].userPrompt).toContain('Section: bar');

        // Cache hits surface as pre-populated bodyMarkdown in the init payload;
        // the missed section has no body yet (it streams in via chunks).
        const init = events2.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        const foo = init.sections.find((s) => s.id === 's0');
        const bar = init.sections.find((s) => s.id === 's1');
        const baz = init.sections.find((s) => s.id === 's2');
        expect(foo?.bodyMarkdown).toBe('narration.');
        expect(baz?.bodyMarkdown).toBe('narration.');
        expect(bar?.bodyMarkdown).toBeUndefined();
        // Mixed cache state — banner should NOT claim a full cache hit.
        expect(init.fromCache).toBeFalsy();
    });

    test('sub-chunks the no-symbols fallback when the whole-file prompt exceeds maxPromptTokens', async () => {
        // ~3 MB whole-file prompt and no symbols configured.
        const totalLines = 1000;
        const lineText = 'z'.repeat(3000);
        const docText = Array.from({ length: totalLines }, () => lineText).join('\n');
        const doc = mockDoc(docText);
        const { options } = makeOptions({
            fetchUnits: async () => [],
            maxPromptTokens: 5_000,
        });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);
        const { sink, events } = collectSink();

        await narrateDocument(doc, provider, liveToken(), sink, options);

        // Multiple provider calls — fallback path is now chunked.
        expect(calls.length).toBeGreaterThan(1);
        for (const c of calls) {
            expect(c.userPrompt).toContain('sub-chunk of an oversized file');
        }
        const chunkEvents = events.filter((e) => e.kind === 'chunk') as Extract<NarrationEvent, { kind: 'chunk' }>[];
        const merged = chunkEvents.map((c) => c.text).join('');
        expect(merged).toMatch(/### Lines \[L\d+-L\d+\]/);
        expect(events.some((e) => e.kind === 'sectionDone')).toBe(true);
    });

    test('does NOT sub-chunk the no-symbols fallback when the file fits', async () => {
        const { options } = makeOptions({
            fetchUnits: async () => [],
            maxPromptTokens: 50_000,
        });
        const doc = mockDoc('a = 1\nb = 2\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['ok.'], calls);
        const { sink } = collectSink();

        await narrateDocument(doc, provider, liveToken(), sink, options);

        expect(calls).toHaveLength(1);
        expect(calls[0].userPrompt).not.toContain('sub-chunk');
    });

    test('per-section cache: all hits sets fromCache and skips the provider entirely', async () => {
        const units: NarrationUnit[] = [
            { kind: 'symbol', name: 'foo', range: new vscode.Range(0, 0, 0, 8) },
            { kind: 'symbol', name: 'bar', range: new vscode.Range(1, 0, 1, 8) },
        ];
        const { options } = makeOptions({ fetchUnits: async () => units });
        const doc = mockDoc('foo body\nbar body\n');

        const calls1: ProviderCall[] = [];
        await narrateDocument(doc, chunkProvider(['hi.'], calls1), liveToken(), collectSink().sink, options);
        expect(calls1).toHaveLength(2);

        const calls2: ProviderCall[] = [];
        const { sink, events } = collectSink();
        await narrateDocument(doc, chunkProvider(['SHOULD-NOT-APPEAR'], calls2), liveToken(), sink, options);

        expect(calls2).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.fromCache).toBe(true);
        expect(init.sections.every((s) => s.id === 's0' || s.id === 's1' ? !!s.bodyMarkdown : true)).toBe(true);
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

    test('sub-chunks the modified case when the diff prompt exceeds maxPromptTokens', async () => {
        // Build a ~3 MB post-change source so the combined prompt body is far
        // over a 5_000-token budget.
        const totalLines = 1000;
        const lineText = 'y'.repeat(3000);
        const docText = Array.from({ length: totalLines }, () => lineText).join('\n');
        const doc = mockDoc(docText);

        const diff: DiffResult = { kind: 'modified', unifiedDiff: '@@ -1 +1 @@\n-old\n+new' };
        const { options } = makeOptions({
            fetchDiff: async () => diff,
            maxPromptTokens: 5_000,
        });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);
        const { sink, events } = collectSink();

        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        // Multiple provider calls — diff path is now chunked.
        expect(calls.length).toBeGreaterThan(1);
        for (const c of calls) {
            expect(c.userPrompt).toContain('sub-chunk of an oversized change');
        }
        // Subheadings mark each chunk inside the merged section body.
        const chunkEvents = events.filter((e) => e.kind === 'chunk') as Extract<NarrationEvent, { kind: 'chunk' }>[];
        const merged = chunkEvents.map((c) => c.text).join('');
        expect(merged).toMatch(/### Lines \[L\d+-L\d+\]/);
        expect(events.some((e) => e.kind === 'sectionDone')).toBe(true);
    });

    test('does NOT sub-chunk the modified case when the diff prompt fits', async () => {
        const diff: DiffResult = { kind: 'modified', unifiedDiff: '@@ -1 +1 @@\n-old\n+new' };
        const { options } = makeOptions({
            fetchDiff: async () => diff,
            maxPromptTokens: 50_000,
        });
        const doc = mockDoc('short\nfile\n');
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['ok.'], calls);
        const { sink } = collectSink();

        await narrateDiff(doc, 'origin/main', provider, liveToken(), sink, options);

        // Exactly one provider call when the prompt fits.
        expect(calls).toHaveLength(1);
        expect(calls[0].userPrompt).not.toContain('sub-chunk');
    });
});

describe('narrateTreeDiff', () => {
    const repoRoot = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;

    test('emits a "No changes" section when the tree is clean', async () => {
        const { options } = makeOptions({ fetchTreeDiff: async () => ({ kind: 'noChanges' } as TreeDiffResult) });
        const calls: ProviderCall[] = [];
        const { sink, events } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', chunkProvider([], calls), liveToken(), sink, options);

        expect(calls).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections[0].bodyMarkdown).toContain('No changes');
        expect(init.sections[0].bodyMarkdown).toContain('origin/main');
        expect(events[events.length - 1]).toEqual({ kind: 'done' });
    });

    test('throws when no repo is found', async () => {
        const { options } = makeOptions({ fetchTreeDiff: async () => ({ kind: 'noRepo' } as TreeDiffResult) });
        const { sink } = collectSink();
        await expect(
            narrateTreeDiff(repoRoot, 'origin/main', chunkProvider([]), liveToken(), sink, options),
        ).rejects.toThrow(/git repository/);
    });

    test('emits summary plus one section per changed file and caches the result', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ a\n@@ b',
            changes: [
                {
                    uri: vscode.Uri.parse('file:///foo/repo/src/a.ts') as unknown as vscode.Uri,
                    status: 'modified',
                    unifiedDiff: '@@ a',
                },
                {
                    uri: vscode.Uri.parse('file:///foo/repo/src/b.ts') as unknown as vscode.Uri,
                    status: 'added',
                    unifiedDiff: '@@ b',
                },
            ],
        };
        const { options, cache } = makeOptions({ fetchTreeDiff: async () => tree });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);
        const { sink, events } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        // One LLM call for the summary plus one per file.
        expect(calls).toHaveLength(3);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.sections.map((s) => s.id)).toEqual(['summary', 'f0', 'f1']);
        // Per-file sections carry their own linkUri so navigation lands in the right file.
        expect(init.sections[1].linkUri?.toString()).toBe('file:///foo/repo/src/a.ts');
        expect(init.sections[2].linkUri?.toString()).toBe('file:///foo/repo/src/b.ts');
        const sectionDones = events.filter((e) => e.kind === 'sectionDone');
        expect(sectionDones).toHaveLength(3);

        const stored = await cache.get(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo));
        expect(stored).toContain('## Overview');
        expect(stored).toContain('a.ts');
        expect(stored).toContain('b.ts');
    });

    test('returns a cache hit without calling the provider', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ x',
            changes: [{
                uri: vscode.Uri.parse('file:///foo/repo/x.ts') as unknown as vscode.Uri,
                status: 'modified',
                unifiedDiff: '@@ x',
            }],
        };
        const { options, cache } = makeOptions({ fetchTreeDiff: async () => tree });
        await cache.set(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo), 'cached tree');

        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['SHOULD-NOT-APPEAR'], calls);
        const { sink, events } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        expect(calls).toHaveLength(0);
        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        expect(init.fromCache).toBe(true);
        expect(init.sections.some((s) => s.bodyMarkdown === 'cached tree')).toBe(true);
    });

    test('skipCache=true bypasses the cached value and re-streams', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ y',
            changes: [{
                uri: vscode.Uri.parse('file:///foo/repo/y.ts') as unknown as vscode.Uri,
                status: 'modified',
                unifiedDiff: '@@ y',
            }],
        };
        const { options, cache } = makeOptions({ fetchTreeDiff: async () => tree, skipCache: true });
        await cache.set(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo), 'stale');

        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['fresh'], calls);
        const { sink } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        // One summary call + one per-file call.
        expect(calls).toHaveLength(2);
        const stored = await cache.get(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo));
        expect(stored).not.toBe('stale');
        expect(stored).toContain('fresh');
    });

    test('renamed files surface "old → new" in the heading and the per-file prompt', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ r',
            changes: [{
                uri: vscode.Uri.parse('file:///foo/repo/src/new.ts') as unknown as vscode.Uri,
                originalUri: vscode.Uri.parse('file:///foo/repo/src/old.ts') as unknown as vscode.Uri,
                status: 'renamed',
                unifiedDiff: '@@ r',
            }],
        };
        const { options } = makeOptions({ fetchTreeDiff: async () => tree });
        const calls: ProviderCall[] = [];
        const provider = chunkProvider(['body.'], calls);
        const { sink, events } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        const fileSection = init.sections.find((s) => s.id === 'f0');
        expect(fileSection?.headingMarkdown).toContain('`src/old.ts` → `src/new.ts`');

        const filePromptCall = calls.find((c) => c.userPrompt.includes('File: src/new.ts'));
        expect(filePromptCall?.userPrompt).toContain('Renamed from: src/old.ts');

        const summaryPromptCall = calls.find((c) => c.userPrompt.includes('Changed files:'));
        expect(summaryPromptCall?.userPrompt).toContain('[renamed] src/old.ts → src/new.ts');
    });

    test('deleted file: inline narrate-links are stripped to plain text, no reveal URI emitted', async () => {
        const deletedUri = vscode.Uri.parse('file:///foo/repo/src/gone.ts') as unknown as vscode.Uri;
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ d',
            changes: [{
                uri: deletedUri,
                status: 'deleted',
                unifiedDiff: '@@ d',
            }],
        };
        const { options, cache } = makeOptions({ fetchTreeDiff: async () => tree });
        // Per-file provider: emit a narrate-link only in the deleted file's section body.
        // Summary section gets neutral prose so we can isolate the deleted-file behaviour.
        const provider: NarrationProvider = {
            async *stream(_systemPrompt: string, userPrompt: string) {
                if (userPrompt.includes('Status: deleted')) {
                    yield 'Removed [some helper](narrate://lines/L5) earlier this week.';
                } else {
                    yield 'overview text.';
                }
            },
        };
        const { sink } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        const stored = await cache.get(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo));
        expect(stored).toBeDefined();
        // The deleted-file section's body must NOT contain a command URI
        // pointing at the deleted path — that would open a non-existent file.
        expect(stored).not.toContain(deletedUri.toString());
        expect(stored).not.toContain('command:codeNarration.reveal');
        expect(stored).not.toContain('narrate://lines');
        // The bracketed link text survives as plain text so the prose still reads naturally.
        expect(stored).toContain('some helper');
    });

    test('deleted file: section init has linkUri undefined to avoid opening the deleted path', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ d2',
            changes: [{
                uri: vscode.Uri.parse('file:///foo/repo/src/gone2.ts') as unknown as vscode.Uri,
                status: 'deleted',
                unifiedDiff: '@@ d2',
            }],
        };
        const { options } = makeOptions({ fetchTreeDiff: async () => tree });
        const { sink, events } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', chunkProvider(['body.']), liveToken(), sink, options);

        const init = events.find((e) => e.kind === 'init') as Extract<NarrationEvent, { kind: 'init' }>;
        const deletedSection = init.sections.find((s) => s.id === 'f0');
        expect(deletedSection?.linkUri).toBeUndefined();
    });

    test('does not write the cache when any per-file section fails', async () => {
        const tree: TreeDiffResult = {
            kind: 'modified',
            combinedDiff: '@@ z',
            changes: [{
                uri: vscode.Uri.parse('file:///foo/repo/z.ts') as unknown as vscode.Uri,
                status: 'modified',
                unifiedDiff: '@@ z',
            }],
        };
        const { options, cache } = makeOptions({ fetchTreeDiff: async () => tree });

        // Provider fails after streaming nothing — withTransientRetry exhausts retries and rethrows.
        const provider: NarrationProvider = {
            async *stream() { throw new Error('boom'); },
        };
        const { sink } = collectSink();

        await narrateTreeDiff(repoRoot, 'origin/main', provider, liveToken(), sink, options);

        const stored = await cache.get(treeDiffKey(repoRoot, tree.combinedDiff, 'origin/main', providerInfo));
        expect(stored).toBeUndefined();
    });
});
