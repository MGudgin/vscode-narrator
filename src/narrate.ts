import * as vscode from 'vscode';
import { NarrationProvider, ProviderInfo } from './llm/index';
import { NarrationUnit, getNarrationUnits } from './symbols';
import { DiffResult, TreeChange, TreeDiffResult, getDiff, getTreeDiff } from './diff';
import { NarrationCache, fileKey, diffKey, treeDiffKey } from './cache';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    DIFF_SYSTEM_PROMPT,
    TREE_SUMMARY_SYSTEM_PROMPT,
    TREE_FILE_DIFF_SYSTEM_PROMPT,
    buildUserPrompt,
    buildSymbolUserPrompt,
    buildDiffUserPrompt,
    buildTreeSummaryPrompt,
    buildTreeFileDiffPrompt,
    fixupLinks,
} from './prompt';
import { withTransientRetry } from './retry';

const DEFAULT_SYMBOL_CONCURRENCY = 4;

function readSymbolConcurrency(): number {
    const value = vscode.workspace.getConfiguration('codeNarration').get<number>('symbolConcurrency', DEFAULT_SYMBOL_CONCURRENCY);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_SYMBOL_CONCURRENCY;
    return Math.min(16, Math.floor(value));
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
            let acc = '';
            await withTransientRetry(
                async (attempt) => {
                    if (attempt > 0) {
                        acc = '';
                        sink({ kind: 'sectionReset', sectionId: 'main' });
                    }
                    for await (const chunk of provider.stream(
                        DIFF_SYSTEM_PROMPT,
                        buildDiffUserPrompt(doc, baseRef, diffResult.unifiedDiff),
                        token,
                    )) {
                        if (token.isCancellationRequested) return;
                        acc += chunk;
                        sink({ kind: 'chunk', sectionId: 'main', text: chunk });
                    }
                },
                { isCancelled: () => token.isCancellationRequested },
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

    const fetchUnits = options.fetchUnits ?? getNarrationUnits;
    const units = await fetchUnits(doc);
    if (token.isCancellationRequested) return;

    if (units.length === 0) {
        sink({ kind: 'init', sections: [...prefixSections, { id: 'main' }] });
        let acc = '';
        await withTransientRetry(
            async (attempt) => {
                if (attempt > 0) {
                    acc = '';
                    sink({ kind: 'sectionReset', sectionId: 'main' });
                }
                for await (const chunk of provider.stream(SYSTEM_PROMPT, buildUserPrompt(doc), token)) {
                    if (token.isCancellationRequested) return;
                    acc += chunk;
                    sink({ kind: 'chunk', sectionId: 'main', text: chunk });
                }
            },
            { isCancelled: () => token.isCancellationRequested },
        );
        if (token.isCancellationRequested) return;
        sink({ kind: 'sectionDone', sectionId: 'main' });
        await options.cache.set(key, fixupLinks(acc, doc.uri));
        sink({ kind: 'done' });
        return;
    }

    const sections = units.map((unit, i) => ({
        id: `s${i}`,
        unit,
        headingMarkdown: buildHeading(doc.uri, unit, unit.name),
        accumulated: '',
    }));

    sink({
        kind: 'init',
        sections: [
            ...prefixSections,
            ...sections.map((s) => ({
                id: s.id,
                headingMarkdown: s.headingMarkdown,
                range: s.unit.range,
            })),
        ],
    });

    const concurrency = options.concurrency ?? readSymbolConcurrency();
    let anyFailure = false;
    await mapWithConcurrency(sections, concurrency, async (sec) => {
        if (token.isCancellationRequested) return;
        try {
            await withTransientRetry(
                async (attempt) => {
                    if (attempt > 0) {
                        sec.accumulated = '';
                        sink({ kind: 'sectionReset', sectionId: sec.id });
                    }
                    for await (const chunk of provider.stream(
                        SYMBOL_SYSTEM_PROMPT,
                        buildSymbolUserPrompt(sec.unit, doc),
                        token,
                    )) {
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
        const finalMd = sections
            .map((s) => {
                const body = fixupLinks(s.accumulated, doc.uri).trim()
                    || '_(no narration produced for this section.)_';
                return `${s.headingMarkdown}\n\n${body}`;
            })
            .join('\n\n');
        await options.cache.set(key, finalMd);
    }
    sink({ kind: 'done' });
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
