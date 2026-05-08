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

export const workspace = {
    getConfiguration(_section: string) {
        return {
            get<T>(_key: string, defaultValue: T): T {
                return defaultValue;
            },
        };
    },
    asRelativePath(uri: unknown) {
        if (typeof uri === 'string') return uri;
        const u = uri as { fsPath?: string };
        return u.fsPath ?? String(uri);
    },
};
