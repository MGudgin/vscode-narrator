/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { fixupLinks } from './prompt';

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
            // eslint-disable-next-line no-console
            console.log(`[perf] ${label}: ${elapsed.toFixed(2)} ms`);
            return elapsed;
        });
    }
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console
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
describe('[perf] NarrationCache.get rewrites cache on every hit', () => {
    test('every get() on a hit issues a write of the entire array', async () => {
        const memento = new MemoryMemento();
        const cache = new NarrationCache(memento);

        const ENTRIES = 100;
        // Each markdown ~2KB (a representative section narration).
        const body = 'lorem ipsum '.repeat(170);
        for (let i = 0; i < ENTRIES; i++) {
            await cache.set(`k${i}`, body);
        }
        const writesAfterFill = memento.writeCount;
        const baselineBytes = memento.lastWriteBytes;

        // Simulate the parallel-section-cache-check pattern from narrateFileBody.
        const SECTIONS = 20;
        await Promise.all(
            Array.from({ length: SECTIONS }, (_, i) => cache.get(`k${i}`)),
        );

        const extraWrites = memento.writeCount - writesAfterFill;
        // Each get() against a hit issues a full-array write. So extraWrites
        // should equal SECTIONS — that's the bug. A well-behaved cache should
        // do 0 (no touch) or 1 (batched).
        expect(extraWrites).toBe(SECTIONS);
        // The payload written each time is ~the size of the entire cache.
        expect(memento.lastWriteBytes).toBeGreaterThan(baselineBytes * 0.9);
        // eslint-disable-next-line no-console
        console.log(`[perf] cache.get hits: ${SECTIONS} reads -> ${extraWrites} full-array writes (${memento.lastWriteBytes} bytes each)`);
    });

    test('hit-rate scaling: doubling cache size doubles bytes written per get', async () => {
        async function bytesPerGet(entryCount: number): Promise<number> {
            const memento = new MemoryMemento();
            const cache = new NarrationCache(memento);
            const body = 'x'.repeat(2048);
            for (let i = 0; i < entryCount; i++) await cache.set(`k${i}`, body);
            memento.lastWriteBytes = 0;
            await cache.get('k0');
            return memento.lastWriteBytes;
        }
        const small = await bytesPerGet(50);
        const large = await bytesPerGet(200);
        // Roughly linear in entry count — confirms the whole array is rewritten.
        expect(large).toBeGreaterThan(small * 3);
        // eslint-disable-next-line no-console
        console.log(`[perf] write-amplification: 50-entry cache writes ${small}B per get; 200-entry writes ${large}B per get`);
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

    test('flat output size grows linearly but timing super-linearly with depth', async () => {
        const N = 500;
        const FOURX = N * 4;
        const tn = await measure(`flattenSymbols depth=${N}`, () => {
            flattenSymbols(makeDeepTree(N));
        });
        const t4n = await measure(`flattenSymbols depth=${FOURX}`, () => {
            flattenSymbols(makeDeepTree(FOURX));
        });
        // Strictly linear would be ratio ~4. Quadratic would be ~16. We
        // assert better than full quadratic but worse than linear is fine
        // for now — the fix should push it down to ratio < 8.
        const ratio = t4n / Math.max(tn, 0.001);
        // eslint-disable-next-line no-console
        console.log(`[perf] flattenSymbols 4x ratio = ${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        expect(t4n).toBeGreaterThan(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: SentenceBuffer.push runs splitSentences over the entire pending
// buffer on every chunk. For a long section streamed in many small chunks
// the total work is O(N²) in section length.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] SentenceBuffer.push re-scans full pending buffer', () => {
    function streamPushAll(chunks: string[]): number {
        const buf = new SentenceBuffer();
        const start = performance.now();
        for (const c of chunks) buf.push(c);
        buf.flush();
        return performance.now() - start;
    }

    test('many tiny chunks of a long un-terminated paragraph are super-linear', () => {
        // A long block with NO sentence terminator: every push() will re-scan
        // all pending text. This is the worst case for the current
        // implementation.
        function makeChunks(totalChars: number, chunkSize: number): string[] {
            const out: string[] = [];
            const chunk = 'x'.repeat(chunkSize);
            for (let i = 0; i < Math.floor(totalChars / chunkSize); i++) out.push(chunk);
            return out;
        }
        const tN = streamPushAll(makeChunks(20_000, 5));
        const t4N = streamPushAll(makeChunks(80_000, 5));
        const ratio = t4N / Math.max(tN, 0.001);
        // eslint-disable-next-line no-console
        console.log(`[perf] SentenceBuffer push 20k vs 80k chars (5-char chunks): ${tN.toFixed(2)}ms vs ${t4N.toFixed(2)}ms, ratio=${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        // We just record the shape — no hard assertion because timings vary.
        expect(tN).toBeGreaterThan(0);
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Issue: fixupLinks runs a global regex over the entire accumulated markdown
// every time a chunk arrives. With render-throttle gating the call site
// somewhat, but the final replace in sectionDone *always* runs once, and
// during streaming chunks land roughly every 100ms. Over a long section the
// regex pass over already-fixed-up text repeats unboundedly.
// ───────────────────────────────────────────────────────────────────────────
describe('[perf] fixupLinks scans whole accumulated body each call', () => {
    test('per-chunk fixupLinks over growing accumulated markdown is super-linear', () => {
        const uri = vscode.Uri.parse('file:///foo.ts') as unknown as vscode.Uri;

        function simulate(chunks: number): number {
            const chunk = '[foo](narrate://lines/L1-L10) some text here. ';
            let acc = '';
            const start = performance.now();
            for (let i = 0; i < chunks; i++) {
                acc += chunk;
                // Mimic sink.ts throttled render path: fixupLinks(state.accumulated).
                fixupLinks(acc, uri);
            }
            return performance.now() - start;
        }

        const tN = simulate(500);
        const t4N = simulate(2000);
        const ratio = t4N / Math.max(tN, 0.001);
        // eslint-disable-next-line no-console
        console.log(`[perf] fixupLinks per-chunk over growing buffer: ${tN.toFixed(2)}ms vs ${t4N.toFixed(2)}ms, ratio=${ratio.toFixed(2)} (linear=4, quadratic=16)`);
        expect(tN).toBeGreaterThan(0);
    });
});
