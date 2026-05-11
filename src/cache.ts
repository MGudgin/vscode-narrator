import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ProviderInfo } from './llm/index';

export const PROMPT_VERSION = 2;
const MAX_ENTRIES = 200;
const STATE_KEY = 'codeNarration.cache.v1';
const KEY_SEPARATOR = '\x1f';

interface CacheEntry {
    key: string;
    markdown: string;
    timestamp: number;
}

export class NarrationCache {
    constructor(private readonly state: vscode.Memento) {}

    async get(key: string): Promise<string | undefined> {
        const entries = this.read();
        const found = entries.find((e) => e.key === key);
        if (!found) return undefined;
        found.timestamp = Date.now();
        try {
            await this.state.update(STATE_KEY, entries);
        } catch {
            // best-effort LRU touch
        }
        return found.markdown;
    }

    async set(key: string, markdown: string): Promise<void> {
        return this.setMany([{ key, markdown }]);
    }

    async setMany(updates: { key: string; markdown: string }[]): Promise<void> {
        if (updates.length === 0) return;
        try {
            const incomingKeys = new Set(updates.map((u) => u.key));
            const now = Date.now();
            let entries = this.read().filter((e) => !incomingKeys.has(e.key));
            for (const u of updates) entries.push({ key: u.key, markdown: u.markdown, timestamp: now });
            entries.sort((a, b) => b.timestamp - a.timestamp);
            if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES);
            await this.state.update(STATE_KEY, entries);
        } catch (err) {
            console.error('codeNarration: cache write failed', err);
        }
    }

    async clearAll(): Promise<void> {
        await this.state.update(STATE_KEY, []);
    }

    private read(): CacheEntry[] {
        return this.state.get<CacheEntry[]>(STATE_KEY, []);
    }
}

export function fileKey(uri: vscode.Uri, content: string, info: ProviderInfo): string {
    return hashKey(['file', uri.toString(), content, info.kind, info.model, String(PROMPT_VERSION)]);
}

export function sectionKey(
    uri: vscode.Uri,
    unitName: string,
    unitText: string,
    maxPromptTokens: number,
    info: ProviderInfo,
): string {
    return hashKey([
        'section',
        uri.toString(),
        unitName,
        unitText,
        String(maxPromptTokens),
        info.kind,
        info.model,
        String(PROMPT_VERSION),
    ]);
}

export function diffKey(uri: vscode.Uri, unifiedDiff: string, baseRef: string, info: ProviderInfo): string {
    return hashKey(['diff', uri.toString(), unifiedDiff, baseRef, info.kind, info.model, String(PROMPT_VERSION)]);
}

export function treeDiffKey(repoRoot: vscode.Uri, combinedDiff: string, baseRef: string, info: ProviderInfo): string {
    return hashKey(['tree', repoRoot.toString(), combinedDiff, baseRef, info.kind, info.model, String(PROMPT_VERSION)]);
}

function hashKey(parts: string[]): string {
    return crypto.createHash('sha256').update(parts.join(KEY_SEPARATOR)).digest('hex');
}
