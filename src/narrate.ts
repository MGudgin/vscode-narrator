import * as vscode from 'vscode';
import { NarrationProvider } from './llm/index';
import { NarrationUnit, getNarrationUnits } from './symbols';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    buildUserPrompt,
    buildSymbolUserPrompt,
    fixupLinks,
    parseSectionResponse,
} from './prompt';

const SYMBOL_CONCURRENCY = 4;

export async function narrateDocument(
    doc: vscode.TextDocument,
    provider: NarrationProvider,
    token: vscode.CancellationToken,
): Promise<string> {
    const units = await getNarrationUnits(doc);
    if (token.isCancellationRequested) return '';

    if (units.length === 0) {
        const userPrompt = buildUserPrompt(doc);
        const raw = await provider.narrate(SYSTEM_PROMPT, userPrompt, token);
        return fixupLinks(raw, doc.uri);
    }

    const sections = await mapWithConcurrency(units, SYMBOL_CONCURRENCY, async (unit) => {
        if (token.isCancellationRequested) return null;
        const userPrompt = buildSymbolUserPrompt(unit, doc);
        const raw = await provider.narrate(SYMBOL_SYSTEM_PROMPT, userPrompt, token);
        if (token.isCancellationRequested) return null;
        const parsed = parseSectionResponse(raw, unit.name);
        return { unit, title: parsed.title, body: parsed.body };
    });

    if (token.isCancellationRequested) return '';

    const parts: string[] = [];
    for (const section of sections) {
        if (!section) continue;
        const heading = buildHeading(doc.uri, section.unit, section.title);
        const body = fixupLinks(section.body, doc.uri);
        parts.push(`${heading}\n\n${body}`);
    }
    return parts.join('\n\n');
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
