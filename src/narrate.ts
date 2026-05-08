import * as vscode from 'vscode';
import { NarrationProvider, ProviderInfo } from './llm/index';
import { NarrationUnit, getNarrationUnits } from './symbols';
import { getDiff } from './diff';
import { NarrationCache, fileKey, diffKey } from './cache';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    DIFF_SYSTEM_PROMPT,
    buildUserPrompt,
    buildSymbolUserPrompt,
    buildDiffUserPrompt,
    fixupLinks,
} from './prompt';

const SYMBOL_CONCURRENCY = 4;

export interface SectionInit {
    id: string;
    headingMarkdown?: string;
    bodyMarkdown?: string;
    range?: vscode.Range;
}

export type NarrationEvent =
    | { kind: 'init'; sections: SectionInit[]; fromCache?: boolean }
    | { kind: 'chunk'; sectionId: string; text: string }
    | { kind: 'sectionDone'; sectionId: string }
    | { kind: 'done' };

export type NarrationSink = (event: NarrationEvent) => void;

export interface NarrationOptions {
    skipCache: boolean;
    cache: NarrationCache;
    providerInfo: ProviderInfo;
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
    const diffResult = await getDiff(doc.uri, baseRef);
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
            for await (const chunk of provider.stream(
                DIFF_SYSTEM_PROMPT,
                buildDiffUserPrompt(doc, baseRef, diffResult.unifiedDiff),
                token,
            )) {
                if (token.isCancellationRequested) return;
                acc += chunk;
                sink({ kind: 'chunk', sectionId: 'main', text: chunk });
            }
            if (token.isCancellationRequested) return;
            sink({ kind: 'sectionDone', sectionId: 'main' });
            await options.cache.set(key, fixupLinks(acc, doc.uri));
            sink({ kind: 'done' });
            return;
        }
    }
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

    const units = await getNarrationUnits(doc);
    if (token.isCancellationRequested) return;

    if (units.length === 0) {
        sink({ kind: 'init', sections: [...prefixSections, { id: 'main' }] });
        let acc = '';
        for await (const chunk of provider.stream(SYSTEM_PROMPT, buildUserPrompt(doc), token)) {
            if (token.isCancellationRequested) return;
            acc += chunk;
            sink({ kind: 'chunk', sectionId: 'main', text: chunk });
        }
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

    await mapWithConcurrency(sections, SYMBOL_CONCURRENCY, async (sec) => {
        if (token.isCancellationRequested) return;
        for await (const chunk of provider.stream(
            SYMBOL_SYSTEM_PROMPT,
            buildSymbolUserPrompt(sec.unit, doc),
            token,
        )) {
            if (token.isCancellationRequested) return;
            sec.accumulated += chunk;
            sink({ kind: 'chunk', sectionId: sec.id, text: chunk });
        }
        if (!token.isCancellationRequested) {
            sink({ kind: 'sectionDone', sectionId: sec.id });
        }
    });

    if (token.isCancellationRequested) return;

    const finalMd = sections
        .map((s) => {
            const body = fixupLinks(s.accumulated, doc.uri).trim()
                || '_(no narration produced for this section.)_';
            return `${s.headingMarkdown}\n\n${body}`;
        })
        .join('\n\n');
    await options.cache.set(key, finalMd);
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
