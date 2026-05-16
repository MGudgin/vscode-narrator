import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ProviderInfo } from './llm/index';
import { PROMPT_VERSION } from './prompt';

const MAX_ENTRIES = 200;
const STATE_KEY = 'codeNarration.cache.v1';
const KEY_SEPARATOR = '\x1f';

interface CacheEntry {
    key: string;
    markdown: string;
    timestamp: number;
}

function isCacheEntry(value: unknown): value is CacheEntry {
    if (!value || typeof value !== 'object') return false;
    const e = value as { key?: unknown; markdown?: unknown; timestamp?: unknown };
    return typeof e.key === 'string'
        && typeof e.markdown === 'string'
        && typeof e.timestamp === 'number'
        && Number.isFinite(e.timestamp);
}

export class NarrationCache {
    private entries: Map<string, CacheEntry> | undefined;

    constructor(private readonly state: vscode.Memento) {}

    async get(key: string): Promise<string | undefined> {
        const entries = this.ensureLoaded();
        const found = entries.get(key);
        if (found === undefined) return undefined;
        // LRU touch is purely in-memory; persistence happens on the next write.
        // The recency order survives within the process; on reload from
        // workspaceState the persisted `timestamp` field re-establishes it.
        this.bumpToEnd(entries, key, found);
        return found.markdown;
    }

    async getMany(keys: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        if (keys.length === 0) return out;
        const entries = this.ensureLoaded();
        for (const key of keys) {
            const found = entries.get(key);
            if (found === undefined) continue;
            out.set(key, found.markdown);
            this.bumpToEnd(entries, key, found);
        }
        return out;
    }

    async set(key: string, markdown: string): Promise<void> {
        return this.setMany([{ key, markdown }]);
    }

    async setMany(updates: { key: string; markdown: string }[]): Promise<void> {
        if (updates.length === 0) return;
        try {
            const entries = this.ensureLoaded();
            const now = Date.now();
            for (const u of updates) {
                entries.delete(u.key);
                entries.set(u.key, { key: u.key, markdown: u.markdown, timestamp: now });
            }
            while (entries.size > MAX_ENTRIES) {
                const oldestKey = entries.keys().next().value;
                if (oldestKey === undefined) break;
                entries.delete(oldestKey);
            }
            await this.state.update(STATE_KEY, Array.from(entries.values()));
        } catch (err) {
            console.error('codeNarration: cache write failed', err);
        }
    }

    async clearAll(): Promise<void> {
        this.entries = new Map();
        await this.state.update(STATE_KEY, []);
    }

    private bumpToEnd(entries: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
        entries.delete(key);
        entry.timestamp = Date.now();
        entries.set(key, entry);
    }

    private ensureLoaded(): Map<string, CacheEntry> {
        if (this.entries !== undefined) return this.entries;
        this.entries = this.readFromState();
        return this.entries;
    }

    private readFromState(): Map<string, CacheEntry> {
        const raw = this.state.get<unknown>(STATE_KEY, []);
        const result = new Map<string, CacheEntry>();
        if (!Array.isArray(raw)) return result;
        const valid: CacheEntry[] = [];
        for (const item of raw) {
            if (isCacheEntry(item)) valid.push(item);
        }
        // Oldest-first so iteration order matches LRU; eviction drops the head.
        valid.sort((a, b) => a.timestamp - b.timestamp);
        for (const entry of valid) {
            result.delete(entry.key);
            result.set(entry.key, entry);
        }
        return result;
    }
}

// Default cache-tag used when a caller omits a persona — corresponds to the
// built-in `default` persona registered in `src/personas.ts`. Defined here
// (rather than imported) to keep `cache.ts` free of the persona dependency
// graph and to let `personas.ts` import cache helpers without a cycle.
const DEFAULT_PERSONA_CACHE_TAG = 'builtin:default';

export function fileKey(
    uri: vscode.Uri,
    content: string,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return hashKey([
        'file',
        uri.toString(),
        content,
        info.kind,
        info.model,
        String(PROMPT_VERSION),
        personaCacheTag,
    ]);
}

export function sectionKey(
    uri: vscode.Uri,
    unitName: string,
    unitText: string,
    maxPromptTokens: number,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return sectionKeyFromHash(uri, unitName, hashContent(unitText), maxPromptTokens, info, personaCacheTag);
}

export function sectionKeyFromHash(
    uri: vscode.Uri,
    unitName: string,
    unitTextHash: string,
    maxPromptTokens: number,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return hashKey([
        'section',
        uri.toString(),
        unitName,
        unitTextHash,
        String(maxPromptTokens),
        info.kind,
        info.model,
        String(PROMPT_VERSION),
        personaCacheTag,
    ]);
}

export function hashContent(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
}

export function diffKey(
    uri: vscode.Uri,
    unifiedDiff: string,
    baseRef: string,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return hashKey([
        'diff',
        uri.toString(),
        unifiedDiff,
        baseRef,
        info.kind,
        info.model,
        String(PROMPT_VERSION),
        personaCacheTag,
    ]);
}

export function commitDiffKey(
    uri: vscode.Uri,
    unifiedDiff: string,
    baseRef: string,
    headRef: string,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return hashKey([
        'commitDiff',
        uri.toString(),
        unifiedDiff,
        baseRef,
        headRef,
        info.kind,
        info.model,
        String(PROMPT_VERSION),
        personaCacheTag,
    ]);
}

export function treeDiffKey(
    repoRoot: vscode.Uri,
    combinedDiff: string,
    baseRef: string,
    info: ProviderInfo,
    personaCacheTag: string = DEFAULT_PERSONA_CACHE_TAG,
): string {
    return hashKey([
        'tree',
        repoRoot.toString(),
        combinedDiff,
        baseRef,
        info.kind,
        info.model,
        String(PROMPT_VERSION),
        personaCacheTag,
    ]);
}

function hashKey(parts: string[]): string {
    return crypto.createHash('sha256').update(parts.join(KEY_SEPARATOR)).digest('hex');
}
