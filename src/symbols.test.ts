import { describe, test, expect, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { flattenSymbols, getNarrationUnits, resolveRecurseSymbols } from './symbols';

const vscodeMock = vscode as unknown as {
    __setConfigInspect: (key: string, value: Record<string, unknown>) => void;
    __resetConfig: () => void;
};
const __setConfigInspect = vscodeMock.__setConfigInspect;
const __resetConfig = vscodeMock.__resetConfig;

function sym(name: string, startLine: number, endLine: number, children: vscode.DocumentSymbol[] = []): vscode.DocumentSymbol {
    return {
        name,
        detail: '',
        kind: vscode.SymbolKind.Function,
        range: new vscode.Range(startLine, 0, endLine, 0),
        selectionRange: new vscode.Range(startLine, 0, startLine, 0),
        children,
    } as unknown as vscode.DocumentSymbol;
}

function mockDoc(lines: string[], languageId: string = 'typescript'): vscode.TextDocument {
    return {
        uri: vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri,
        languageId,
        lineCount: lines.length,
        getText: (range?: vscode.Range): string => {
            if (!range) return lines.join('\n');
            const parts: string[] = [];
            for (let i = range.start.line; i <= range.end.line && i < lines.length; i++) {
                const line = lines[i] ?? '';
                if (i === range.start.line && i === range.end.line) {
                    parts.push(line.slice(range.start.character, range.end.character));
                } else if (i === range.start.line) {
                    parts.push(line.slice(range.start.character));
                } else if (i === range.end.line) {
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

describe('flattenSymbols', () => {
    test('returns empty for an empty input', () => {
        expect(flattenSymbols([])).toEqual([]);
    });

    test('keeps leaf names unchanged when there is no parent path', () => {
        const result = flattenSymbols([sym('foo', 0, 5), sym('bar', 6, 10)]);
        expect(result.map((s) => s.name)).toEqual(['foo', 'bar']);
    });

    test('qualifies child names with the parent path', () => {
        const tree = [sym('Foo', 0, 20, [sym('bar', 1, 5), sym('baz', 6, 10)])];
        const flat = flattenSymbols(tree);
        expect(flat.map((s) => s.name)).toEqual(['Foo', 'Foo.bar', 'Foo.baz']);
    });

    test('qualifies grand-child names recursively', () => {
        const grandchildren = [sym('inner', 2, 4)];
        const children = [sym('mid', 1, 5, grandchildren)];
        const tree = [sym('Outer', 0, 20, children)];
        const flat = flattenSymbols(tree);
        expect(flat.map((s) => s.name)).toEqual(['Outer', 'Outer.mid', 'Outer.mid.inner']);
    });

    test('strips children from the flattened entries', () => {
        const flat = flattenSymbols([sym('Foo', 0, 10, [sym('bar', 1, 5)])]);
        expect(flat.every((s) => s.children.length === 0)).toBe(true);
    });
});

describe('getNarrationUnits', () => {
    test('returns [] when the symbol provider yields no symbols', async () => {
        const doc = mockDoc(['line one', 'line two']);
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => [] });
        expect(units).toEqual([]);
    });

    test('emits a "Top of file" preamble when the first symbol does not start at 0,0', async () => {
        const doc = mockDoc(['import x;', 'import y;', '', 'function f() {}', '}']);
        const symbols = [sym('f', 3, 4)];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols });
        expect(units[0]).toMatchObject({ kind: 'region', name: 'Top of file' });
        expect(units[1]).toMatchObject({ kind: 'symbol', name: 'f' });
    });

    test('skips the preamble when the leading region is whitespace only', async () => {
        const doc = mockDoc(['', '', 'function f() {}', '}']);
        const symbols = [sym('f', 2, 3)];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols });
        expect(units.find((u) => u.name === 'Top of file')).toBeUndefined();
    });

    test('emits an "End of file" postamble when content extends past the last symbol', async () => {
        const doc = mockDoc(['function f() {}', '}', 'const trailing = 1;']);
        const symbols = [sym('f', 0, 1)];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols });
        expect(units[units.length - 1]).toMatchObject({ kind: 'region', name: 'End of file' });
    });

    test('orders symbols by their starting line', async () => {
        const doc = mockDoc(['function a() {}', 'function b() {}', 'function c() {}']);
        const symbols = [sym('c', 2, 2), sym('a', 0, 0), sym('b', 1, 1)];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols });
        expect(units.map((u) => u.name)).toEqual(['a', 'b', 'c']);
    });

    test('flattens children when recurse is true', async () => {
        const doc = mockDoc([
            'class Foo {',  // 0
            '  bar() {}',   // 1
            '  baz() {}',   // 2
            '}',            // 3
        ]);
        const symbols = [sym('Foo', 0, 3, [sym('bar', 1, 1), sym('baz', 2, 2)])];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols, recurse: true });
        const symbolNames = units.filter((u) => u.kind === 'symbol').map((u) => u.name);
        expect(symbolNames).toEqual(['Foo', 'Foo.bar', 'Foo.baz']);
    });

    test('keeps only top-level symbols when recurse is false', async () => {
        const doc = mockDoc([
            'class Foo {', '  bar() {}', '  baz() {}', '}',
        ]);
        const symbols = [sym('Foo', 0, 3, [sym('bar', 1, 1), sym('baz', 2, 2)])];
        const units = await getNarrationUnits(doc, { fetchSymbols: async () => symbols, recurse: false });
        expect(units.map((u) => u.name)).toEqual(['Foo']);
    });
});

describe('resolveRecurseSymbols', () => {
    afterEach(() => __resetConfig());

    test('auto: recurses for container-heavy languages (csharp)', () => {
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(true);
    });

    test('auto: recurses for cpp', () => {
        expect(resolveRecurseSymbols(mockDoc([''], 'cpp'))).toBe(true);
    });

    test('auto: top-level only for typescript', () => {
        expect(resolveRecurseSymbols(mockDoc([''], 'typescript'))).toBe(false);
    });

    test('auto: top-level only for python', () => {
        expect(resolveRecurseSymbols(mockDoc([''], 'python'))).toBe(false);
    });

    test('"never" overrides csharp auto', () => {
        __setConfigInspect('recurseSymbols', { globalValue: 'never' });
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(false);
    });

    test('"always" overrides typescript auto', () => {
        __setConfigInspect('recurseSymbols', { globalValue: 'always' });
        expect(resolveRecurseSymbols(mockDoc([''], 'typescript'))).toBe(true);
    });

    test('explicit "auto" falls back to the language default', () => {
        __setConfigInspect('recurseSymbols', { globalValue: 'auto' });
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(true);
        expect(resolveRecurseSymbols(mockDoc([''], 'typescript'))).toBe(false);
    });

    test('language-scoped value overrides global value', () => {
        __setConfigInspect('recurseSymbols', { globalValue: 'never', globalLanguageValue: 'always' });
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(true);
    });

    test('legacy boolean true is honored as "always"', () => {
        __setConfigInspect('recurseSymbols', { globalValue: true });
        expect(resolveRecurseSymbols(mockDoc([''], 'typescript'))).toBe(true);
    });

    test('legacy boolean false is honored as "never"', () => {
        __setConfigInspect('recurseSymbols', { globalValue: false });
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(false);
    });

    test('unknown string falls back to language default', () => {
        __setConfigInspect('recurseSymbols', { globalValue: 'garbage' });
        expect(resolveRecurseSymbols(mockDoc([''], 'csharp'))).toBe(true);
        expect(resolveRecurseSymbols(mockDoc([''], 'typescript'))).toBe(false);
    });
});
