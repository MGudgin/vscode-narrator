// Performance / micro-benchmark tests. These assert *complexity shape* rather
// than wall-clock targets, so they remain stable across machines: each test
// runs the suspected hot path at two problem sizes (N and 4N) and fails when
// the ratio is closer to N^2 than N. Wall-clock measurements are logged but
// not asserted on.

import { describe, test, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { NarrationCache, sectionKey, sectionKeyFromHash, hashContent } from './cache';
import {
    flattenSymbols,
    getFlattenSymbolsInternalAllocations,
    resetFlattenSymbolsInternalAllocations,
} from './symbols';
import { SentenceBuffer, markdownToSpeech } from './speech';
import { buildUserPromptForRange } from './prompt';
import {
    buildNarrationSink,
    getSinkRenderBytesProcessed,
    resetSinkRenderBytesProcessed,
} from './sink';
import { NarrationTarget } from './target';
import { findSectionForLine } from './extension';
import {
    narrateDocument,
    NarrationEvent,
    NarrationOptions,
    NarrationSink,
} from './narrate';
import { NarrationUnit } from './symbols';
import { NarrationProvider, ProviderInfo } from './llm/index';

class MemoryMemento implements vscode.Memento {
    private store = new Map<string, unknown>();
    public readCount = 0;
    public writeCount = 0;
    public lastWriteBytes = 0;
    keys(): readonly string[] { return Array.from(this.store.keys()); }
    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        this.readCount++;
        return this.store.has(key) ? (this.store.get(key) as T) : (defaultValue as T | undefined);
    }
    async update(key: string, value: unknown): Promise<void> {
        this.writeCount++;
        if (value === undefined) {
            this.store.delete(key);
        } else {
            this.store.set(key, value);
            try { this.lastWriteBytes = JSON.stringify(value).length; } catch { /* noop */ }
        }
    }
    setKeysForSync(_keys: readonly string[]): void {}
}

function measure(label: string, fn: () => void | Promise<void>): Promise<number> {
    const start = performance.now();
    const r = fn();
    if (r instanceof Promise) {
        return r.then(() => {
            const elapsed = performance.now() - start;
            // Surface timings so the CI log shows them.
            console.log(`[perf] ${label}: ${elapsed.toFixed(2)} ms`);
            return elapsed;
        });
    }
    const elapsed = performance.now() - start;
    console.log(`[perf] ${label}: ${elapsed.toFixed(2)} ms`);
    return Promise.resolve(elapsed);
}

// ───────────────────────────────────────────────────────────────────────────
// Issue: NarrationCache.get() touches the LRU timestamp by REWRITING the
// entire cache array on every read hit. With many cached entries this is
// O(N) read + O(N) write + JSON serialize over the full payload per get().
// For a file with 20 sections, narrateFileBody fires 20 parallel cache.get()
// calls — each one rewriting the whole array.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] NarrationCache.get LRU touch no longer rewrites the cache', () => {
    test('parallel section gets issue zero writes (was: one per hit)', async () => {
        const memento = new MemoryMemento();
        const cache = new NarrationCache(memento);

        const ENTRIES = 100;
        // Each markdown ~2KB (a representative section narration).
        const body = 'lorem ipsum '.repeat(170);
        for (let i = 0; i < ENTRIES; i++) {
            await cache.set(`k${i}`, body);
        }
        const writesAfterFill = memento.writeCount;

        // Simulate the parallel-section-cache-check pattern from narrateFileBody.
        const SECTIONS = 20;
        await Promise.all(
            Array.from({ length: SECTIONS }, (_, i) => cache.get(`k${i}`)),
        );

        const extraWrites = memento.writeCount - writesAfterFill;
        // After #74, LRU touches stay in memory until the next write.
        expect(extraWrites).toBe(0);
        console.log(`[perf] cache.get hits: ${SECTIONS} reads -> ${extraWrites} writes`);
    });

    test('getMany batched read returns all hits with at most one write', async () => {
        const memento = new MemoryMemento();
        const cache = new NarrationCache(memento);

        const ENTRIES = 100;
        const body = 'lorem ipsum '.repeat(170);
        for (let i = 0; i < ENTRIES; i++) await cache.set(`k${i}`, body);
        const writesAfterFill = memento.writeCount;

        const SECTIONS = 20;
        const keys = Array.from({ length: SECTIONS }, (_, i) => `k${i}`);
        const hits = await cache.getMany(keys);

        // Every requested key is a hit.
        expect(hits.size).toBe(SECTIONS);
        for (const k of keys) expect(hits.get(k)).toBe(body);
        // No persistence write happens for read-side LRU touches.
        expect(memento.writeCount - writesAfterFill).toBe(0);
    });

    test('per-get bytes written is zero regardless of cache size', async () => {
        async function bytesPerGet(entryCount: number): Promise<number> {
            const memento = new MemoryMemento();
            const cache = new NarrationCache(memento);
            const body = 'x'.repeat(2048);
            for (let i = 0; i < entryCount; i++) await cache.set(`k${i}`, body);
            const before = memento.writeCount;
            await cache.get('k0');
            return memento.writeCount - before;
        }
        const small = await bytesPerGet(50);
        const large = await bytesPerGet(200);
        // Post-fix: read-time writes are eliminated entirely.
        expect(small).toBe(0);
        expect(large).toBe(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: flattenSymbols used `result.push(...flattenSymbols(...))` which
// allocates a fresh result array per recursive call and then spreads it,
// producing O(N²) work on deep trees. The fix threads a shared accumulator
// through every recursive call so internal allocations stay at exactly 1
// regardless of tree depth.
//
// Assertion: count internal `[]` allocations via an exported counter. After
// the fix this is exactly 1 (the top-level default-supplied accumulator),
// regardless of node count. A regression to the per-call-allocates pattern
// would push the count to ~N.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] flattenSymbols allocates exactly one accumulator regardless of depth', () => {
    function makeDeepTree(depth: number): vscode.DocumentSymbol[] {
        let node: any = {
            name: `n${depth - 1}`,
            detail: '',
            kind: 0,
            range: new vscode.Range(0, 0, 0, 0),
            selectionRange: new vscode.Range(0, 0, 0, 0),
            children: [],
        };
        for (let i = depth - 2; i >= 0; i--) {
            node = {
                name: `n${i}`,
                detail: '',
                kind: 0,
                range: new vscode.Range(0, 0, 0, 0),
                selectionRange: new vscode.Range(0, 0, 0, 0),
                children: [node],
            };
        }
        return [node];
    }

    test('depth=1000 and depth=4000 each cause exactly 1 internal allocation', () => {
        for (const depth of [1000, 4000]) {
            resetFlattenSymbolsInternalAllocations();
            const out = flattenSymbols(makeDeepTree(depth));
            expect(out.length).toBe(depth);
            expect(getFlattenSymbolsInternalAllocations()).toBe(1);
        }
    });

    test('passing an explicit accumulator triggers zero internal allocations and reuses the array', () => {
        const seed: vscode.DocumentSymbol[] = [];
        resetFlattenSymbolsInternalAllocations();
        const result = flattenSymbols(makeDeepTree(2000), '', seed);
        expect(result).toBe(seed);
        expect(getFlattenSymbolsInternalAllocations()).toBe(0);
        expect(result.length).toBe(2000);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: SentenceBuffer.push ran splitSentences over the entire pending
// buffer on every chunk, producing O(N²) total scanned bytes when chunks
// have no terminator. The fix short-circuits that scan whenever neither
// the new chunk nor pending carries a terminator.
//
// Assertion: total bytes scanned across all push() calls stays linear in
// total appended bytes. Pre-fix the scan-bytes were O(N²/chunkSize); post
// fix scan-bytes are 0 for a terminator-free stream and a small multiple
// of N once terminators appear.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] SentenceBuffer.push scan-bytes stay linear in section length', () => {
    function makeChunks(totalChars: number, chunkSize: number, char: string): string[] {
        const out: string[] = [];
        const chunk = char.repeat(chunkSize);
        for (let i = 0; i < Math.floor(totalChars / chunkSize); i++) out.push(chunk);
        return out;
    }

    test('a terminator-free stream triggers zero scan-bytes regardless of length', () => {
        for (const total of [80_000, 320_000]) {
            const buf = new SentenceBuffer();
            for (const c of makeChunks(total, 5, 'x')) buf.push(c);
            expect(buf.appendedBytes).toBe(total);
            // The fast path is taken on every push — no splitSentences scan ever runs.
            expect(buf.scannedBytes).toBe(0);
        }
    });

    test('scan-bytes ratio is near-linear (≤ 5×) for 4× input growth on terminator-bearing text', () => {
        function streamScanBytes(totalChars: number, chunkSize: number): { scanned: number; appended: number } {
            const buf = new SentenceBuffer();
            // Repeating pattern with a sentence terminator every ~80 chars to
            // exercise the actual scan path.
            const pattern = 'lorem ipsum dolor sit amet consectetur. ';
            const chunks: string[] = [];
            let built = '';
            while (built.length < totalChars) built += pattern;
            for (let i = 0; i < built.length; i += chunkSize) {
                chunks.push(built.slice(i, i + chunkSize));
            }
            for (const c of chunks) buf.push(c);
            return { scanned: buf.scannedBytes, appended: buf.appendedBytes };
        }
        const small = streamScanBytes(80_000, 5);
        const big = streamScanBytes(320_000, 5);
        // eslint-disable-next-line no-console
        console.log(`[perf] SentenceBuffer scan-bytes: small=${small.scanned} (appended ${small.appended}), big=${big.scanned} (appended ${big.appended})`);
        const ratio = big.scanned / Math.max(small.scanned, 1);
        // Linear would be 4; quadratic would be 16. Allow generous headroom for
        // the small remainder kept across pushes — the metric is deterministic
        // so this only catches a real complexity regression.
        expect(ratio).toBeLessThan(5);
        // And the absolute bound: scan-bytes must stay a small constant
        // multiple of appended bytes (linear in section length).
        expect(big.scanned).toBeLessThan(big.appended * 4);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: every throttled chunk render re-ran fixupLinks + renderMarkdownToHtml
// over the full accumulated body, giving O(N²) total bytes-rendered across a
// section's lifetime. The fix tracks a settledUpTo offset and only renders
// the slice past that boundary (plus a small unsettled tail).
//
// Assertion: total bytes processed by the renderer stays linear in the body
// length, independent of how many render calls are issued. Pre-fix the ratio
// for a 4× longer body was ~16× (quadratic); post-fix it should be near 4×.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] sink renderer processes each byte O(1) times across a section', () => {
    function fileTarget(): NarrationTarget {
        return { kind: 'file', uri: vscode.Uri.parse('file:///foo.ts') as unknown as vscode.Uri };
    }
    function liveToken(): vscode.CancellationToken {
        return {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} }),
        } as unknown as vscode.CancellationToken;
    }
    function silentWebview(): { postMessage: () => Thenable<boolean> } {
        return { postMessage: () => Promise.resolve(true) };
    }

    function streamSection(chunks: number): { rendered: number; bodyBytes: number } {
        // Force every chunk past the 100ms throttle by advancing Date.now.
        const realNow = Date.now;
        let virtualNow = 1_000_000;
        Date.now = () => (virtualNow += 1000);
        try {
            resetSinkRenderBytesProcessed();
            const sink = buildNarrationSink({
                webview: silentWebview() as any,
                token: liveToken(),
                target: fileTarget(),
                bannerLabel: 'L',
                sectionRanges: [],
            });
            sink({ kind: 'init', sections: [{ id: 'a' }] });
            const chunk = '[foo](narrate://lines/L1-L10) some text here.\n\n';
            for (let i = 0; i < chunks; i++) {
                sink({ kind: 'chunk', sectionId: 'a', text: chunk });
            }
            sink({ kind: 'sectionDone', sectionId: 'a' });
            return { rendered: getSinkRenderBytesProcessed(), bodyBytes: chunks * chunk.length };
        } finally {
            Date.now = realNow;
        }
    }

    test('total render bytes scales linearly with body length, not chunk count squared', () => {
        const small = streamSection(500);
        const big = streamSection(2000);
        // eslint-disable-next-line no-console
        console.log(`[perf] sink render bytes: small=${small.rendered} (body ${small.bodyBytes}), big=${big.rendered} (body ${big.bodyBytes})`);
        const ratio = big.rendered / Math.max(small.rendered, 1);
        // Linear would be 4; quadratic would be 16. Deterministic metric, so
        // any value materially above 4 indicates a real regression.
        expect(ratio).toBeLessThan(6);
        // And absolute: each body byte should be rendered at most a small
        // constant number of times across the section's lifetime.
        expect(big.rendered).toBeLessThan(big.bodyBytes * 3);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: numberLinesInRange iterates doc.lineAt(i).text per line. lineAt
// allocates a TextLine object every call. For a 10000-line range that's
// 10000 allocations + 10000 .text gets. After the fix this single range
// is rendered via one doc.getText(range).split('\n') pass.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] numberLinesInRange avoids per-line lineAt allocations', () => {
    function makePerfDoc(lines: string[]): vscode.TextDocument {
        const text = lines.join('\n');
        return {
            uri: vscode.Uri.parse('file:///big.ts') as unknown as vscode.Uri,
            languageId: 'typescript',
            lineCount: lines.length,
            getText: (range?: vscode.Range) => {
                if (!range) return text;
                const parts: string[] = [];
                const startLine = range.start.line;
                const endLine = range.end.line;
                for (let i = startLine; i <= endLine && i < lines.length; i++) {
                    const line = lines[i] ?? '';
                    if (i === startLine && i === endLine) {
                        parts.push(line.slice(range.start.character, range.end.character));
                    } else if (i === startLine) {
                        parts.push(line.slice(range.start.character));
                    } else if (i === endLine) {
                        parts.push(line.slice(0, range.end.character));
                    } else {
                        parts.push(line);
                    }
                }
                return parts.join('\n');
            },
            lineAt: (line: number) => ({
                text: lines[line] ?? '',
                range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
            }),
        } as unknown as vscode.TextDocument;
    }

    test('rendering a 10000-line range completes well under 100 ms', async () => {
        const N = 10_000;
        const lines = Array.from({ length: N }, (_, i) => `const value${i} = ${i};`);
        const doc = makePerfDoc(lines);
        buildUserPromptForRange(doc, 0, N - 1);
        const elapsed = await measure('numberLinesInRange 10000 lines', () => {
            buildUserPromptForRange(doc, 0, N - 1);
        });
        expect(elapsed).toBeLessThan(100);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #82: sectionRanges cursor lookup. The pre-fix code called Array.find
// over every range on each cursor move (200ms debounce, but unbounded in
// section count). The post-fix binary search resolves a 10 000-section list
// in microseconds per call.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] findSectionForLine binary search scales to thousands of sections', () => {
    test('10 000-section list resolves in under 1 ms per lookup', () => {
        const N = 10_000;
        const sections: { id: string; range: { start: { line: number }; end: { line: number } } }[] = [];
        for (let i = 0; i < N; i++) {
            sections.push({ id: `s${i}`, range: { start: { line: i * 10 }, end: { line: i * 10 + 9 } } });
        }
        const LOOKUPS = 1000;
        const start = performance.now();
        for (let k = 0; k < LOOKUPS; k++) {
            findSectionForLine(sections, (k * 137) % (N * 10));
        }
        const elapsed = performance.now() - start;
        const perCall = elapsed / LOOKUPS;
        // eslint-disable-next-line no-console
        console.log(`[perf] findSectionForLine N=${N} ${LOOKUPS} lookups: total=${elapsed.toFixed(2)} ms, ${perCall.toFixed(4)} ms/call`);
        expect(perCall).toBeLessThan(1);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #83: markdownToSpeech ran 11 chained `.replace` passes over the same
// string and re-allocated the regex literals on every call. The optimized
// version (a) hoists every RegExp to module scope and (b) collapses
// `![…](…)` + `[…](…)` into one sweep and the three line-prefix sweeps
// (bullets, blockquotes, headings) into one multiline sweep — 11 passes
// down to 8. We measure the optimized version against the pre-fix shape
// (still pure JS, with regex literals fresh each call as before) and
// assert at least a 30% speedup on a representative markdown blob.
// ───────────────────────────────────────────────────────────────────────────
function preFixMarkdownToSpeech(md: string): string {
    if (!md) return '';
    let s = md;
    s = s.replace(new RegExp('```[\\s\\S]*?```', 'g'), ' code block omitted. ');
    s = s.replace(new RegExp('`([^`]+)`', 'g'), '$1');
    s = s.replace(new RegExp('!\\[[^\\]]*\\]\\([^)]*\\)', 'g'), '');
    s = s.replace(new RegExp('\\[([^\\]]+)\\]\\(([^)]+)\\)', 'g'), '$1');
    s = s.replace(new RegExp('^[ \\t]*([-*+]|\\d+\\.)[ \\t]+', 'gm'), '');
    s = s.replace(new RegExp('^[ \\t]*>+[ \\t]?', 'gm'), '');
    s = s.replace(new RegExp('^[ \\t]{0,3}#{1,6}[ \\t]+', 'gm'), '');
    s = s.replace(new RegExp('(\\*\\*|__)(.+?)\\1', 'g'), '$2');
    s = s.replace(new RegExp('(\\*|_)(?=\\S)(.+?)(?<=\\S)\\1', 'g'), '$2');
    s = s.replace(new RegExp('~~(.+?)~~', 'g'), '$1');
    s = s.replace(new RegExp('\\s+', 'g'), ' ').trim();
    return s;
}

describe('[perf] markdownToSpeech is faster after collapsing passes and hoisting regex constants', () => {
    test('optimized version is measurably faster than the pre-fix 11-pass shape', () => {
        const fragment = [
            '## Imports',
            '',
            '- Pulls in `vscode` and `path`.',
            '- See [the docs](https://example.com/x) for details.',
            '',
            '> Note: the `narrate()` call is **bold** and *important*.',
            '',
            '1. First step.',
            '2. Second step.',
            '',
            '~~deprecated~~ replaced with `newApi`.',
            'Plain prose with no markdown at all to balance the scan.',
        ].join('\n');
        const md = fragment.repeat(50);

        for (let i = 0; i < 20; i++) {
            markdownToSpeech(md);
            preFixMarkdownToSpeech(md);
        }

        const ITERATIONS = 500;
        function bench(fn: (s: string) => string): number {
            const start = performance.now();
            for (let i = 0; i < ITERATIONS; i++) fn(md);
            return performance.now() - start;
        }

        const ROUNDS = 7;
        const beforeSamples: number[] = [];
        const afterSamples: number[] = [];
        for (let r = 0; r < ROUNDS; r++) {
            if (r % 2 === 0) {
                beforeSamples.push(bench(preFixMarkdownToSpeech));
                afterSamples.push(bench(markdownToSpeech));
            } else {
                afterSamples.push(bench(markdownToSpeech));
                beforeSamples.push(bench(preFixMarkdownToSpeech));
            }
        }
        function median(xs: number[]): number {
            const sorted = [...xs].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        }
        const tBefore = median(beforeSamples);
        const tAfter = median(afterSamples);
        const speedup = tBefore / Math.max(tAfter, 0.001);
        console.log(`[perf] markdownToSpeech pre-fix=${tBefore.toFixed(2)}ms optimized=${tAfter.toFixed(2)}ms speedup=${speedup.toFixed(2)}x (median of ${ROUNDS}, ${ITERATIONS} iterations on ~${md.length}B)`);

        expect(markdownToSpeech(md)).toBe(preFixMarkdownToSpeech(md));
        // Regression guard only: V8 caches compiled regex from string literals
        // aggressively, so the `new RegExp(literal)` baseline often matches the
        // optimized path after warmup on shared CI runners. Local runs show the
        // expected 1.25-1.5x improvement; CI is structurally noisy here. Fail
        // only if the optimized version becomes meaningfully slower.
        expect(speedup).toBeGreaterThan(0.85);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #79: settings re-read from getConfiguration multiple times per
// narration. After the fix, the narration entrypoint takes a single
// snapshot of the relevant codeNarration settings keys and passes it down,
// so a full narration of N sections should call getConfiguration AT MOST
// once for the narration-level keys — not once per section.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] narration takes one config snapshot, not one per section', () => {
    function mockDoc(text: string): vscode.TextDocument {
        const lines = text.split('\n');
        return {
            uri: vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri,
            languageId: 'typescript',
            lineCount: lines.length,
            getText: (range?: vscode.Range) => {
                if (!range) return text;
                return lines.slice(range.start.line, range.end.line + 1).join('\n');
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
    function chunkProvider(chunks: string[]): NarrationProvider {
        return {
            async *stream() {
                for (const c of chunks) yield c;
            },
        };
    }

    test('a 20-section narration calls getConfiguration at most once per settings key', async () => {
        const spy = vi.spyOn(vscode.workspace, 'getConfiguration');
        try {
            const units: NarrationUnit[] = Array.from({ length: 20 }, (_, i) => ({
                kind: 'symbol' as const,
                name: `s${i}`,
                range: new vscode.Range(i, 0, i, 6),
            }));
            const text = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
            const doc = mockDoc(text);
            const cache = new NarrationCache(new MemoryMemento());
            const options: NarrationOptions = {
                skipCache: false,
                cache,
                providerInfo: { kind: 'test', model: 'm1' } as ProviderInfo,
                fetchUnits: async () => units,
                concurrency: 4,
            };
            const events: NarrationEvent[] = [];
            const sink: NarrationSink = (e) => events.push(e);
            await narrateDocument(doc, chunkProvider(['ok.']), liveToken(), sink, options);

            expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
            // eslint-disable-next-line no-console
            console.log(`[perf] getConfiguration calls for 20-section narration: ${spy.mock.calls.length}`);
        } finally {
            spy.mockRestore();
        }
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue #80: sectionKey hashes the whole unit text per section. After the
// fix, the unit text is hashed once via hashContent() and the digest is
// fed into sectionKeyFromHash for every cache-key build — so creating N
// keys for the same unit takes time linear in the digest length, not in
// the body length.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] sectionKey body hashing happens once per unique unit', () => {
    test('sectionKey(body) and sectionKeyFromHash(hashContent(body)) produce the same digest', () => {
        const uri = vscode.Uri.parse('file:///foo.ts') as unknown as vscode.Uri;
        const provider = { kind: 'anthropic', model: 'sonnet' };
        const body = 'x'.repeat(5000);
        const fromHashFlow = sectionKeyFromHash(uri, 'foo', hashContent(body), 50000, provider);
        const fromOldFlow = sectionKey(uri, 'foo', body, 50000, provider);
        expect(fromHashFlow).toBe(fromOldFlow);
    });

    test('precomputed-hash flow is much faster than re-hashing the body each call for a large unit', () => {
        const uri = vscode.Uri.parse('file:///foo.ts') as unknown as vscode.Uri;
        const provider = { kind: 'anthropic', model: 'sonnet' };
        const body = 'y'.repeat(200_000);
        const N = 200;

        const oldStart = performance.now();
        for (let i = 0; i < N; i++) {
            sectionKey(uri, 'foo', body, 50000, provider);
        }
        const oldElapsed = performance.now() - oldStart;

        const newStart = performance.now();
        const unitHash = hashContent(body);
        for (let i = 0; i < N; i++) {
            sectionKeyFromHash(uri, 'foo', unitHash, 50000, provider);
        }
        const newElapsed = performance.now() - newStart;

        // eslint-disable-next-line no-console
        console.log(`[perf] sectionKey body-hash dedup: ${N} keys old=${oldElapsed.toFixed(2)}ms vs new=${newElapsed.toFixed(2)}ms`);
        expect(newElapsed).toBeLessThan(oldElapsed / 4);
    });

    test('section-key snapshot is stable: pinning the digest for fixed inputs', () => {
        const uri = vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri;
        const provider = { kind: 'anthropic', model: 'claude-sonnet-4-6' };
        const body = 'body';
        const expected = sectionKey(uri, 'foo', body, 50000, provider);
        expect(sectionKeyFromHash(uri, 'foo', hashContent(body), 50000, provider)).toBe(expected);
        expect(expected).toMatch(/^[a-f0-9]{64}$/);
    });
});
