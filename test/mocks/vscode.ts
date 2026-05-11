// Minimal vscode runtime mock for unit tests.
// Types come from @types/vscode at compile time; this module supplies
// just enough behavior for the modules we exercise under vitest.

export const Uri = {
    parse(s: string) {
        return {
            toString: () => s,
            fsPath: s.replace(/^file:\/\//, ''),
            path: s.replace(/^file:\/\//, ''),
            scheme: s.split(':')[0],
        };
    },
};

export class Range {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
    }
}

export const SymbolKind = {
    File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
    Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
    Function: 11, Variable: 12, Constant: 13,
};

const configOverrides = new Map<string, unknown>();
const configInspectOverrides = new Map<string, Record<string, unknown>>();

export function __setConfig(key: string, value: unknown): void {
    configOverrides.set(key, value);
}

export function __setConfigInspect(key: string, value: Record<string, unknown>): void {
    configInspectOverrides.set(key, value);
}

export function __resetConfig(): void {
    configOverrides.clear();
    configInspectOverrides.clear();
}

export const workspace = {
    getConfiguration(_section: string, _scope?: unknown) {
        return {
            get<T>(key: string, defaultValue: T): T {
                return configOverrides.has(key) ? (configOverrides.get(key) as T) : defaultValue;
            },
            inspect<T>(key: string): { globalValue?: T; globalLanguageValue?: T } | undefined {
                const explicit = configInspectOverrides.get(key);
                if (explicit) return explicit as { globalValue?: T; globalLanguageValue?: T };
                if (configOverrides.has(key)) {
                    return { globalValue: configOverrides.get(key) as T };
                }
                return {};
            },
        };
    },
    asRelativePath(uri: unknown) {
        if (typeof uri === 'string') return uri;
        const u = uri as { fsPath?: string };
        return u.fsPath ?? String(uri);
    },
};

export class CancellationTokenSource {
    private cancelled = false;
    token: { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => { dispose: () => void } } = {
        get isCancellationRequested() { return false; },
        onCancellationRequested: () => ({ dispose: () => {} }),
    };
    cancel(): void {
        this.cancelled = true;
        Object.defineProperty(this.token, 'isCancellationRequested', { value: true, configurable: true });
    }
    dispose(): void { /* noop */ }
}
