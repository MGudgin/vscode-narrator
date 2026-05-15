// Performance / micro-benchmark tests. These assert *complexity shape* rather
// than wall-clock targets, so they remain stable across machines: each test
// runs the suspected hot path at two problem sizes (N and 4N) and fails when
// the ratio is closer to N^2 than N. Wall-clock measurements are logged but
// not asserted on.

import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { NarrationCache } from './cache';
import { flattenSymbols } from './symbols';
import { SentenceBuffer } from './speech';
import { buildUserPromptForRange } from './prompt';
import { buildNarrationSink } from './sink';
import { NarrationTarget } from './target';

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

// Best-of-N microbenchmark: take the minimum elapsed across `samples` runs to
// filter CI neighbour noise and GC pauses. Single-sample timings of fast
// (sub-10 ms) operations are too variance-prone to assert tight ratios against.
async function measureBest(label: string, fn: () => void | Promise<void>, samples = 5): Promise<number> {
    let best = Infinity;
    for (let i = 0; i < samples; i++) {
        const start = performance.now();
        const r = fn();
        if (r instanceof Promise) await r;
        const elapsed = performance.now() - start;
        if (elapsed < best) best = elapsed;
    }
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label}: best ${best.toFixed(2)} ms (of ${samples})`);
    return best;
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
// Issue: flattenSymbols uses `result.push(...flattenSymbols(...))` which
// allocates a new array per recursive call AND spreads it — making the total
// work O(N²) on a deep tree where every level adds one symbol.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] flattenSymbols scaling on deep symbol trees', () => {
    function makeDeepTree(depth: number): vscode.DocumentSymbol[] {
        // Linear chain: 1 root -> 1 child -> 1 child -> ... (depth deep)
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

    test('flat output size grows linearly and timing stays near-linear with depth', async () => {
        const N = 1000;
        const FOURX = N * 4;
        // Warm-up so V8 inlining / GC settles before any timed run.
        flattenSymbols(makeDeepTree(N));
        flattenSymbols(makeDeepTree(FOURX));
        const tn = await measureBest(`flattenSymbols depth=${N}`, () => {
            flattenSymbols(makeDeepTree(N));
        });
        const t4n = await measureBest(`flattenSymbols depth=${FOURX}`, () => {
            flattenSymbols(makeDeepTree(FOURX));
        });
        const ratio = t4n / Math.max(tn, 0.001);
        console.log(`[perf] flattenSymbols 4x ratio = ${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        expect(ratio).toBeLessThan(5);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: SentenceBuffer.push runs splitSentences over the entire pending
// buffer on every chunk. For a long section streamed in many small chunks
// the total work is O(N²) in section length.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] SentenceBuffer.push is sub-quadratic in section length', () => {
    function streamPushAll(chunks: string[]): number {
        const buf = new SentenceBuffer();
        const start = performance.now();
        for (const c of chunks) buf.push(c);
        buf.flush();
        return performance.now() - start;
    }

    test('many tiny chunks of a long un-terminated paragraph stay near-linear', () => {
        // A long block with NO sentence terminator: under the old code every
        // push() re-scanned all pending text (O(N^2)). Post-fix the buffer
        // short-circuits when neither the chunk nor pending carries a
        // terminator, so total work is linear.
        function makeChunks(totalChars: number, chunkSize: number): string[] {
            const out: string[] = [];
            const chunk = 'x'.repeat(chunkSize);
            for (let i = 0; i < Math.floor(totalChars / chunkSize); i++) out.push(chunk);
            return out;
        }
        // Bigger sizes (and a few warm-up rounds) so timing variance at the
        // sub-millisecond scale doesn't dominate the ratio.
        const small = makeChunks(80_000, 5);
        const big = makeChunks(320_000, 5);
        for (let i = 0; i < 3; i++) {
            streamPushAll(small);
            streamPushAll(big);
        }
        const tN = streamPushAll(small);
        const t4N = streamPushAll(big);
        const ratio = t4N / Math.max(tN, 0.001);
        console.log(`[perf] SentenceBuffer push 80k vs 320k chars (5-char chunks): ${tN.toFixed(2)}ms vs ${t4N.toFixed(2)}ms, ratio=${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        // Pre-fix the ratio was ~14; post-fix it should be near-linear.
        expect(ratio).toBeLessThan(6);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: fixupLinks runs a global regex over the entire accumulated markdown
// every time a chunk arrives. With render-throttle gating the call site
// somewhat, but the final replace in sectionDone *always* runs once, and
// during streaming chunks land roughly every 100ms. Over a long section the
// regex pass over already-fixed-up text repeats unboundedly.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] sink chunk render is sub-quadratic in section length', () => {
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

    function simulate(chunks: number): number {
        // The render path in sink.ts is gated by a 100ms throttle. To
        // exercise the per-chunk cost deterministically, monkey-patch
        // Date.now so every chunk crosses the throttle boundary.
        const realNow = Date.now;
        let virtualNow = 1_000_000;
        Date.now = () => (virtualNow += 1000);
        try {
            const sink = buildNarrationSink({
                webview: silentWebview() as any,
                token: liveToken(),
                target: fileTarget(),
                bannerLabel: 'L',
                sectionRanges: [],
            });
            sink({ kind: 'init', sections: [{ id: 'a' }] });
            // Use a chunk ending in `\n\n` so the incremental path settles each
            // chunk into the prefix — this is the common shape of streamed
            // paragraph-style narration.
            const chunk = '[foo](narrate://lines/L1-L10) some text here.\n\n';
            const start = performance.now();
            for (let i = 0; i < chunks; i++) {
                sink({ kind: 'chunk', sectionId: 'a', text: chunk });
            }
            sink({ kind: 'sectionDone', sectionId: 'a' });
            return performance.now() - start;
        } finally {
            Date.now = realNow;
        }
    }

    test('per-chunk render cost stays near-linear as the body grows', () => {
        // Warm-up.
        simulate(200);
        const tN = simulate(500);
        const t4N = simulate(2000);
        const ratio = t4N / Math.max(tN, 0.001);
        console.log(`[perf] sink chunk render 500 vs 2000 chunks: ${tN.toFixed(2)}ms vs ${t4N.toFixed(2)}ms, ratio=${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        // Pre-fix the ratio was ~19; the incremental render brings it under 6.
        expect(ratio).toBeLessThan(6);
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
        // Warm-up.
        buildUserPromptForRange(doc, 0, N - 1);
        const elapsed = await measure('numberLinesInRange 10000 lines', () => {
            buildUserPromptForRange(doc, 0, N - 1);
        });
        expect(elapsed).toBeLessThan(100);
    });
});
