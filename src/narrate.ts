import * as vscode from 'vscode';
import { NarrationProvider, ProviderInfo } from './llm/index';
import { NarrationUnit, getNarrationUnits } from './symbols';
import { DiffResult, TreeChange, TreeDiffResult, getDiff, getTreeDiff } from './diff';
import { NarrationCache, fileKey, sectionKey, diffKey, treeDiffKey } from './cache';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    DIFF_SYSTEM_PROMPT,
    TREE_SUMMARY_SYSTEM_PROMPT,
    TREE_FILE_DIFF_SYSTEM_PROMPT,
    buildUserPrompt,
    buildUserPromptForRange,
    buildSymbolUserPrompt,
    buildSymbolUserPromptForRange,
    buildDiffUserPrompt,
    buildDiffUserPromptForRange,
    buildTreeSummaryPrompt,
    buildTreeFileDiffPrompt,
    fixupLinks,
} from './prompt';
import { withTransientRetry } from './retry';
import {
    DEFAULT_MAX_PROMPT_TOKENS,
    SubChunkRange,
    formatLineRangeLabel,
    shouldSubChunk,
    splitLineRange,
} from './chunking';

const DEFAULT_SYMBOL_CONCURRENCY = 4;

function readSymbolConcurrency(): number {
    const value = vscode.workspace.getConfiguration('codeNarration').get<number>('symbolConcurrency', DEFAULT_SYMBOL_CONCURRENCY);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_SYMBOL_CONCURRENCY;
    return Math.min(16, Math.floor(value));
}

function readMaxPromptTokens(): number {
    const value = vscode.workspace.getConfiguration('codeNarration').get<number>('maxPromptTokens', DEFAULT_MAX_PROMPT_TOKENS);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1000) return DEFAULT_MAX_PROMPT_TOKENS;
    return Math.floor(value);
}

export interface SectionInit {
    id: string;
    headingMarkdown?: string;
    bodyMarkdown?: string;
    range?: vscode.Range;
    linkUri?: vscode.Uri;
}

export type NarrationEvent =
    | { kind: 'init'; sections: SectionInit[]; fromCache?: boolean }
    | { kind: 'chunk'; sectionId: string; text: string }
    | { kind: 'sectionReset'; sectionId: string }
    | { kind: 'sectionDone'; sectionId: string }
    | { kind: 'done' };

export type NarrationSink = (event: NarrationEvent) => void;

export interface NarrationOptions {
    skipCache: boolean;
    cache: NarrationCache;
    providerInfo: ProviderInfo;
    fetchUnits?: (doc: vscode.TextDocument) => Promise<NarrationUnit[]>;
    fetchDiff?: (uri: vscode.Uri, baseRef: string) => Promise<DiffResult>;
    fetchTreeDiff?: (repoRoot: vscode.Uri, baseRef: string) => Promise<TreeDiffResult>;
    concurrency?: number;
    // Token budget for a single prompt body. When a unit's prompt would
    // exceed this, it is sub-chunked and the per-chunk narrations are
    // merged. Falls back to `codeNarration.maxPromptTokens` setting, then
    // `DEFAULT_MAX_PROMPT_TOKENS`.
    maxPromptTokens?: number;
}

export async function narrateDocument(
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    options: NarrationOptions,
): Promise<void> {
    return narrateFileBody(doc, provider, token, sink, options, []);
}

export async function narrateDiff(
    doc: vscode.TextDocument,
    baseRef: string,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    options: NarrationOptions,
): Promise<void> {
    const fetchDiff = options.fetchDiff ?? getDiff;
    const diffResult = await fetchDiff(doc.uri, baseRef);
    if (token.isCancellationRequested) return;

    switch (diffResult.kind) {
        case 'noRepo':
            throw new Error('This file is not in a git repository.');
        case 'noChanges':
            sink({
                kind: 'init',
                sections: [{
                    id: 'main',
                    bodyMarkdown: `## No changes\n\nThis file is identical to \`${baseRef}\`.`,
                }],
            });
            sink({ kind: 'done' });
            return;
        case 'newFile': {
            const banner: SectionInit = {
                id: 'banner',
                bodyMarkdown: `> _Newly added file — no base content vs \`${baseRef}\`._`,
            };
            await narrateFileBody(doc, provider, token, sink, options, [banner]);
            return;
        }
        case 'modified': {
            const key = diffKey(doc.uri, diffResult.unifiedDiff, baseRef, options.providerInfo);
            if (!options.skipCache) {
                const cached = await options.cache.get(key);
                if (cached) {
                    sink({
                        kind: 'init',
                        sections: [{ id: 'cached', bodyMarkdown: cached }],
                        fromCache: true,
                    });
                    sink({ kind: 'done' });
                    return;
                }
            }
            sink({ kind: 'init', sections: [{ id: 'main' }] });
            const maxPromptTokens = options.maxPromptTokens ?? readMaxPromptTokens();
            const acc = await streamWholeFileOrChunked(
                doc,
                provider,
                token,
                sink,
                DIFF_SYSTEM_PROMPT,
                buildDiffUserPrompt(doc, baseRef, diffResult.unifiedDiff),
                (startLine, endLine) =>
                    buildDiffUserPromptForRange(doc, baseRef, diffResult.unifiedDiff, startLine, endLine),
                maxPromptTokens,
            );
            if (token.isCancellationRequested) return;
            sink({ kind: 'sectionDone', sectionId: 'main' });
            await options.cache.set(key, fixupLinks(acc, doc.uri));
            sink({ kind: 'done' });
            return;
        }
    }
}

export async function narrateTreeDiff(
    repoRoot: vscode.Uri,
    baseRef: string,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    options: NarrationOptions,
): Promise<void> {
    const fetchTreeDiff = options.fetchTreeDiff ?? getTreeDiff;
    const treeResult = await fetchTreeDiff(repoRoot, baseRef);
    if (token.isCancellationRequested) return;

    switch (treeResult.kind) {
        case 'noRepo':
            throw new Error('No git repository found at the requested root.');
        case 'noChanges':
            sink({
                kind: 'init',
                sections: [{
                    id: 'main',
                    bodyMarkdown: `## No changes\n\nThe working tree is identical to \`${baseRef}\`.`,
                }],
            });
            sink({ kind: 'done' });
            return;
    }

    const { changes, combinedDiff } = treeResult;
    const key = treeDiffKey(repoRoot, combinedDiff, baseRef, options.providerInfo);
    if (!options.skipCache) {
        const cached = await options.cache.get(key);
        if (cached) {
            sink({
                kind: 'init',
                sections: [{ id: 'cached', bodyMarkdown: cached }],
                fromCache: true,
            });
            sink({ kind: 'done' });
            return;
        }
    }

    interface TreeSection {
        id: string;
        kind: 'summary' | 'file';
        headingMarkdown: string;
        linkUri?: vscode.Uri;
        change?: TreeChange;
        accumulated: string;
    }

    const summarySection: TreeSection = {
        id: 'summary',
        kind: 'summary',
        headingMarkdown: `## Overview`,
        accumulated: '',
    };

    const fileSections: TreeSection[] = changes.map((change, i) => ({
        id: `f${i}`,
        kind: 'file',
        headingMarkdown: buildTreeFileHeading(repoRoot, change),
        linkUri: change.uri,
        change,
        accumulated: '',
    }));

    const allSections = [summarySection, ...fileSections];

    sink({
        kind: 'init',
        sections: allSections.map((s) => ({
            id: s.id,
            headingMarkdown: s.headingMarkdown,
            linkUri: s.linkUri,
        })),
    });

    const concurrency = options.concurrency ?? 4;
    let anyFailure = false;

    await mapWithConcurrency(allSections, concurrency, async (sec) => {
        if (token.isCancellationRequested) return;
        const systemPrompt = sec.kind === 'summary'
            ? TREE_SUMMARY_SYSTEM_PROMPT
            : TREE_FILE_DIFF_SYSTEM_PROMPT;
        const userPrompt = sec.kind === 'summary'
            ? buildTreeSummaryPrompt(repoRoot, baseRef, changes, combinedDiff)
            : buildTreeFileDiffPrompt(repoRoot, baseRef, sec.change!);
        try {
            await withTransientRetry(
                async (attempt) => {
                    if (attempt > 0) {
                        sec.accumulated = '';
                        sink({ kind: 'sectionReset', sectionId: sec.id });
                    }
                    for await (const chunk of provider.stream(systemPrompt, userPrompt, token)) {
                        if (token.isCancellationRequested) return;
                        sec.accumulated += chunk;
                        sink({ kind: 'chunk', sectionId: sec.id, text: chunk });
                    }
                },
                { isCancelled: () => token.isCancellationRequested },
            );
        } catch (err) {
            if (token.isCancellationRequested) return;
            anyFailure = true;
            sec.accumulated = `_(failed: ${errorMessage(err)})_`;
            sink({ kind: 'sectionReset', sectionId: sec.id });
            sink({ kind: 'chunk', sectionId: sec.id, text: sec.accumulated });
        }
        if (!token.isCancellationRequested) {
            sink({ kind: 'sectionDone', sectionId: sec.id });
        }
    });

    if (token.isCancellationRequested) return;

    if (!anyFailure) {
        const finalMd = allSections
            .map((s) => {
                const linkUri = s.linkUri ?? repoRoot;
                const body = fixupLinks(s.accumulated, linkUri).trim()
                    || '_(no narration produced for this section.)_';
                return `${s.headingMarkdown}\n\n${body}`;
            })
            .join('\n\n');
        await options.cache.set(key, finalMd);
    }
    sink({ kind: 'done' });
}

function buildTreeFileHeading(repoRoot: vscode.Uri, change: TreeChange): string {
    const safeRel = escapeMarkdownPath(relPathForHeading(repoRoot, change.uri));
    const tag = change.status === 'modified' ? '' : ` _(${change.status})_`;
    let label: string;
    if (change.status === 'renamed' && change.originalUri) {
        const safeOld = escapeMarkdownPath(relPathForHeading(repoRoot, change.originalUri));
        label = `\`${safeOld}\` → \`${safeRel}\``;
    } else {
        label = `\`${safeRel}\``;
    }
    if (change.status === 'deleted') {
        return `## ${label}${tag}`;
    }
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: Number.MAX_SAFE_INTEGER } };
    const args = encodeURIComponent(JSON.stringify([change.uri.toString(), range]));
    return `## [${label}](command:codeNarration.reveal?${args})${tag}`;
}

function relPathForHeading(repoRoot: vscode.Uri, file: vscode.Uri): string {
    const rootPath = (repoRoot.fsPath || repoRoot.path).replace(/\\/g, '/').replace(/\/$/, '');
    const filePath = (file.fsPath || file.path).replace(/\\/g, '/');
    return rootPath && filePath.toLowerCase().startsWith(rootPath.toLowerCase() + '/')
        ? filePath.slice(rootPath.length + 1)
        : filePath;
}

function escapeMarkdownPath(path: string): string {
    return path.replace(/[\[\]]/g, '\\$&');
}

async function narrateFileBody(
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    options: NarrationOptions,
    prefixSections: SectionInit[],
): Promise<void> {
    const fetchUnits = options.fetchUnits ?? getNarrationUnits;
    const units = await fetchUnits(doc);
    if (token.isCancellationRequested) return;

    if (units.length === 0) {
        // No symbol provider results — fall back to whole-file caching, keyed
        // on the entire document text. Per-section caching does not apply here.
        const key = fileKey(doc.uri, doc.getText(), options.providerInfo);
        if (!options.skipCache) {
            const cached = await options.cache.get(key);
            if (cached) {
                sink({
                    kind: 'init',
                    sections: [...prefixSections, { id: 'cached', bodyMarkdown: cached }],
                    fromCache: true,
                });
                sink({ kind: 'done' });
                return;
            }
        }
        sink({ kind: 'init', sections: [...prefixSections, { id: 'main' }] });
        const maxPromptTokens = options.maxPromptTokens ?? readMaxPromptTokens();
        const acc = await streamWholeFileOrChunked(
            doc,
            provider,
            token,
            sink,
            SYSTEM_PROMPT,
            buildUserPrompt(doc),
            (startLine, endLine) => buildUserPromptForRange(doc, startLine, endLine),
            maxPromptTokens,
        );
        if (token.isCancellationRequested) return;
        sink({ kind: 'sectionDone', sectionId: 'main' });
        await options.cache.set(key, fixupLinks(acc, doc.uri));
        sink({ kind: 'done' });
        return;
    }

    const maxPromptTokens = options.maxPromptTokens ?? readMaxPromptTokens();
    const sections: Section[] = units.map((unit, i) => ({
        id: `s${i}`,
        unit,
        headingMarkdown: buildHeading(doc.uri, unit, unit.name),
        accumulated: '',
        cacheKey: sectionKey(
            doc.uri,
            unit.name,
            doc.getText(unit.range),
            maxPromptTokens,
            options.providerInfo,
        ),
        cachedBody: undefined,
    }));

    if (!options.skipCache) {
        await Promise.all(sections.map(async (s) => {
            s.cachedBody = await options.cache.get(s.cacheKey);
        }));
    }
    const allCached = sections.length > 0 && sections.every((s) => s.cachedBody !== undefined);

    sink({
        kind: 'init',
        sections: [
            ...prefixSections,
            ...sections.map((s) => ({
                id: s.id,
                headingMarkdown: s.headingMarkdown,
                range: s.unit.range,
                bodyMarkdown: s.cachedBody,
            })),
        ],
        fromCache: allCached || undefined,
    });

    const concurrency = options.concurrency ?? readSymbolConcurrency();
    let anyFailure = false;
    await mapWithConcurrency(sections, concurrency, async (sec) => {
        if (token.isCancellationRequested) return;
        if (sec.cachedBody !== undefined) return;
        try {
            await narrateSection(sec, doc, provider, token, sink, maxPromptTokens);
        } catch (err) {
            if (token.isCancellationRequested) return;
            anyFailure = true;
            sec.accumulated = `_(failed: ${errorMessage(err)})_`;
            sink({ kind: 'sectionReset', sectionId: sec.id });
            sink({ kind: 'chunk', sectionId: sec.id, text: sec.accumulated });
        }
        if (!token.isCancellationRequested) {
            sink({ kind: 'sectionDone', sectionId: sec.id });
        }
    });

    if (token.isCancellationRequested) return;

    if (!anyFailure) {
        const writes: { key: string; markdown: string }[] = [];
        for (const s of sections) {
            if (s.cachedBody !== undefined) continue;
            const body = fixupLinks(s.accumulated, doc.uri);
            if (body.trim().length === 0) continue;
            writes.push({ key: s.cacheKey, markdown: body });
        }
        if (writes.length > 0) await options.cache.setMany(writes);
    }
    sink({ kind: 'done' });
}

interface Section {
    id: string;
    unit: NarrationUnit;
    headingMarkdown: string;
    accumulated: string;
    cacheKey: string;
    cachedBody: string | undefined;
}

/**
 * Narrate a single section, sub-chunking the underlying source when its
 * prompt would exceed the configured token budget.
 *
 * Below the budget: a single streaming call, identical to the pre-#19
 * behavior — output streams directly into the section as it arrives.
 *
 * Above the budget: split the line range into overlapping sub-chunks (see
 * `chunking.ts`), narrate each one sequentially, and concatenate the
 * outputs with a level-3 line-range subheading between them. Sequential
 * (not parallel) so the user sees the section fill in top-to-bottom in
 * stream order, matching how the source reads. The cost of an extra
 * narration pass is dwarfed by the cost of the chunks themselves, and the
 * outer `mapWithConcurrency` is still parallelising across *sections*.
 */
async function narrateSection(
    sec: Section,
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    maxPromptTokens: number,
): Promise<void> {
    const fullPrompt = buildSymbolUserPrompt(sec.unit, doc);
    if (!shouldSubChunk(fullPrompt, maxPromptTokens)) {
        await streamIntoSection(sec, provider, token, sink, SYMBOL_SYSTEM_PROMPT, fullPrompt);
        return;
    }

    // Determine the line range and total char count, then split.
    const startLine = sec.unit.range.start.line;
    const endLine = sec.unit.range.end.line;
    const ranges = splitLineRange(startLine, endLine, fullPrompt.length, {
        maxPromptTokens,
    });

    // Defensive: if splitting failed to produce more than one chunk
    // (degenerate input), fall back to a single call rather than blocking.
    if (ranges.length <= 1) {
        await streamIntoSection(sec, provider, token, sink, SYMBOL_SYSTEM_PROMPT, fullPrompt);
        return;
    }

    for (let i = 0; i < ranges.length; i++) {
        if (token.isCancellationRequested) return;
        const range = ranges[i];
        await streamChunkIntoSection(sec, doc, provider, token, sink, range, i, ranges.length);
    }
}

/**
 * Stream a single chunk of an oversized section into the section's body.
 * Emits a level-3 subheading marking the chunk's 1-based line range before
 * the chunk's narration so the user can correlate output back to the
 * source.
 */
async function streamChunkIntoSection(
    sec: Section,
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    range: SubChunkRange,
    chunkIndex: number,
    chunkCount: number,
): Promise<void> {
    const label = formatLineRangeLabel(range);
    // Spacing between chunks: leading double-newline for any chunk after
    // the first. Keeps the markdown well-formed when chunks concatenate.
    const subheading = `${chunkIndex > 0 ? '\n\n' : ''}### Lines [${label}](narrate://lines/${label}) (chunk ${chunkIndex + 1}/${chunkCount})\n\n`;
    sec.accumulated += subheading;
    sink({ kind: 'chunk', sectionId: sec.id, text: subheading });

    const userPrompt = buildSymbolUserPromptForRange(sec.unit, doc, range.startLine, range.endLine);

    // Track the index at which this chunk's text starts in `sec.accumulated`
    // so that a retry can trim it back without nuking earlier chunks.
    const chunkStartOffset = sec.accumulated.length;

    await withTransientRetry(
        async (attempt) => {
            if (attempt > 0) {
                // On retry, trim back to the start of *this* chunk's body
                // and re-stream just this chunk. Earlier chunks are
                // preserved. The whole section is then reset and re-played
                // via `sectionReset` so the webview shows the truncation
                // and re-stream.
                sec.accumulated = sec.accumulated.slice(0, chunkStartOffset);
                sink({ kind: 'sectionReset', sectionId: sec.id });
                sink({ kind: 'chunk', sectionId: sec.id, text: sec.accumulated });
            }
            for await (const chunk of provider.stream(SYMBOL_SYSTEM_PROMPT, userPrompt, token)) {
                if (token.isCancellationRequested) return;
                sec.accumulated += chunk;
                sink({ kind: 'chunk', sectionId: sec.id, text: chunk });
            }
        },
        { isCancelled: () => token.isCancellationRequested },
    );
}

/**
 * Stream a whole-file or diff narration into the "main" section, sub-chunking
 * when the prompt exceeds the configured token budget. Mirrors the symbol
 * sub-chunking strategy: split the document line range into overlapping
 * chunks, emit a `### Lines L<start>-L<end>` subheading before each chunk's
 * narration, and concatenate the outputs.
 */
async function streamWholeFileOrChunked(
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    systemPrompt: string,
    fullPrompt: string,
    buildRangePrompt: (startLine: number, endLine: number) => string,
    maxPromptTokens: number,
): Promise<string> {
    let acc = '';
    if (!shouldSubChunk(fullPrompt, maxPromptTokens)) {
        await withTransientRetry(
            async (attempt) => {
                if (attempt > 0) {
                    acc = '';
                    sink({ kind: 'sectionReset', sectionId: 'main' });
                }
                for await (const chunk of provider.stream(systemPrompt, fullPrompt, token)) {
                    if (token.isCancellationRequested) return;
                    acc += chunk;
                    sink({ kind: 'chunk', sectionId: 'main', text: chunk });
                }
            },
            { isCancelled: () => token.isCancellationRequested },
        );
        return acc;
    }

    const startLine = 0;
    const endLine = Math.max(0, doc.lineCount - 1);
    const ranges = splitLineRange(startLine, endLine, fullPrompt.length, { maxPromptTokens });

    if (ranges.length <= 1) {
        await withTransientRetry(
            async (attempt) => {
                if (attempt > 0) {
                    acc = '';
                    sink({ kind: 'sectionReset', sectionId: 'main' });
                }
                for await (const chunk of provider.stream(systemPrompt, fullPrompt, token)) {
                    if (token.isCancellationRequested) return;
                    acc += chunk;
                    sink({ kind: 'chunk', sectionId: 'main', text: chunk });
                }
            },
            { isCancelled: () => token.isCancellationRequested },
        );
        return acc;
    }

    for (let i = 0; i < ranges.length; i++) {
        if (token.isCancellationRequested) return acc;
        const range = ranges[i];
        const label = formatLineRangeLabel(range);
        const subheading = `${i > 0 ? '\n\n' : ''}### Lines [${label}](narrate://lines/${label}) (chunk ${i + 1}/${ranges.length})\n\n`;
        acc += subheading;
        sink({ kind: 'chunk', sectionId: 'main', text: subheading });

        const userPrompt = buildRangePrompt(range.startLine, range.endLine);
        const chunkStartOffset = acc.length;

        await withTransientRetry(
            async (attempt) => {
                if (attempt > 0) {
                    acc = acc.slice(0, chunkStartOffset);
                    sink({ kind: 'sectionReset', sectionId: 'main' });
                    sink({ kind: 'chunk', sectionId: 'main', text: acc });
                }
                for await (const chunk of provider.stream(systemPrompt, userPrompt, token)) {
                    if (token.isCancellationRequested) return;
                    acc += chunk;
                    sink({ kind: 'chunk', sectionId: 'main', text: chunk });
                }
            },
            { isCancelled: () => token.isCancellationRequested },
        );
    }
    return acc;
}

async function streamIntoSection(
    sec: Section,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
    sink: NarrationSink,
    systemPrompt: string,
    userPrompt: string,
): Promise<void> {
    await withTransientRetry(
        async (attempt) => {
            if (attempt > 0) {
                sec.accumulated = '';
                sink({ kind: 'sectionReset', sectionId: sec.id });
            }
            for await (const chunk of provider.stream(systemPrompt, userPrompt, token)) {
                if (token.isCancellationRequested) return;
                sec.accumulated += chunk;
                sink({ kind: 'chunk', sectionId: sec.id, text: chunk });
            }
        },
        { isCancelled: () => token.isCancellationRequested },
    );
}

function buildHeading(docUri: vscode.Uri, unit: NarrationUnit, title: string): string {
    const range = {
        start: { line: unit.range.start.line, character: unit.range.start.character },
        end: { line: unit.range.end.line, character: unit.range.end.character },
    };
    const args = encodeURIComponent(JSON.stringify([docUri.toString(), range]));
    const safeTitle = title.replace(/[\[\]]/g, '\\$&').replace(/[\r\n]+/g, ' ').trim();
    return `## [${safeTitle}](command:codeNarration.reveal?${args})`;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const idx = next++;
            if (idx >= items.length) return;
            results[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}
