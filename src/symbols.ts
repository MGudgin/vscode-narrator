import * as vscode from 'vscode';

export interface NarrationUnit {
    kind: 'region' | 'symbol';
    name: string;
    range: vscode.Range;
    detail?: string;
}

export type SymbolFetcher = (doc: vscode.TextDocument) => Promise<vscode.DocumentSymbol[]>;

export interface NarrationUnitOptions {
    fetchSymbols?: SymbolFetcher;
    recurse?: boolean;
}

const CONTAINER_HEAVY_LANGUAGES: ReadonlySet<string> = new Set([
    'csharp', 'java', 'cpp', 'c', 'kotlin', 'swift', 'scala',
    'fsharp', 'vb', 'objective-c', 'objective-cpp',
]);

export type RecurseSetting = 'auto' | 'always' | 'never';

export function normalizeRecurseSetting(value: unknown): RecurseSetting | undefined {
    if (value === 'always' || value === true) return 'always';
    if (value === 'never' || value === false) return 'never';
    if (value === 'auto') return 'auto';
    return undefined;
}

export function resolveRecurseSymbols(doc: vscode.TextDocument): boolean {
    const config = vscode.workspace.getConfiguration('codeNarration', doc.uri);
    const inspected = config.inspect<unknown>('recurseSymbols');
    const raw =
        inspected?.workspaceFolderLanguageValue
        ?? inspected?.workspaceLanguageValue
        ?? inspected?.globalLanguageValue
        ?? inspected?.workspaceFolderValue
        ?? inspected?.workspaceValue
        ?? inspected?.globalValue;
    const setting = normalizeRecurseSetting(raw) ?? 'auto';
    if (setting === 'always') return true;
    if (setting === 'never') return false;
    return CONTAINER_HEAVY_LANGUAGES.has(doc.languageId);
}

export async function getNarrationUnits(
    doc: vscode.TextDocument,
    options: NarrationUnitOptions = {},
): Promise<NarrationUnit[]> {
    const fetcher = options.fetchSymbols ?? fetchTopLevelSymbols;
    const symbols = await fetcher(doc);
    if (symbols.length === 0) return [];

    const recurse = options.recurse ?? resolveRecurseSymbols(doc);
    const expanded = recurse ? flattenSymbols(symbols) : symbols;
    const sorted = [...expanded].sort((a, b) => a.range.start.line - b.range.start.line);
    const units: NarrationUnit[] = [];

    const firstStart = sorted[0].range.start;
    if (firstStart.line > 0 || firstStart.character > 0) {
        const preambleRange = new vscode.Range(0, 0, firstStart.line, 0);
        if (doc.getText(preambleRange).trim().length > 0) {
            units.push({ kind: 'region', name: 'Top of file', range: preambleRange });
        }
    }

    const lastDocLine = Math.max(0, doc.lineCount - 1);
    for (const sym of sorted) {
        const clampedRange = clampRangeToDoc(sym.range, doc);
        units.push({
            kind: 'symbol',
            name: sym.name,
            range: clampedRange,
            detail: sym.detail,
        });
    }

    const lastEnd = sorted[sorted.length - 1].range.end;
    if (lastEnd.line < lastDocLine) {
        const postRange = new vscode.Range(lastEnd.line + 1, 0, lastDocLine, doc.lineAt(lastDocLine).range.end.character);
        if (doc.getText(postRange).trim().length > 0) {
            units.push({ kind: 'region', name: 'End of file', range: postRange });
        }
    }

    return units;
}

function clampRangeToDoc(range: vscode.Range, doc: vscode.TextDocument): vscode.Range {
    const lastLine = Math.max(0, doc.lineCount - 1);
    if (range.end.line <= lastLine && range.start.line <= lastLine) return range;
    const clampedStartLine = Math.min(range.start.line, lastLine);
    const clampedEndLine = Math.min(range.end.line, lastLine);
    const endChar = doc.lineAt(clampedEndLine).range.end.character;
    return new vscode.Range(clampedStartLine, range.start.character, clampedEndLine, endChar);
}

export function flattenSymbols(
    symbols: vscode.DocumentSymbol[],
    parentPath: string = '',
): vscode.DocumentSymbol[] {
    const result: vscode.DocumentSymbol[] = [];
    for (const s of symbols) {
        const qualified = parentPath ? `${parentPath}.${s.name}` : s.name;
        result.push({
            name: qualified,
            detail: s.detail,
            kind: s.kind,
            range: s.range,
            selectionRange: s.selectionRange,
            children: [],
        } as vscode.DocumentSymbol);
        if (s.children && s.children.length > 0) {
            result.push(...flattenSymbols(s.children, qualified));
        }
    }
    return result;
}

async function fetchTopLevelSymbols(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
    );
    if (!result || result.length === 0) return [];

    if (isDocumentSymbol(result[0])) {
        return result as vscode.DocumentSymbol[];
    }
    return (result as vscode.SymbolInformation[]).map((s) => ({
        name: s.name,
        detail: '',
        kind: s.kind,
        range: s.location.range,
        selectionRange: s.location.range,
        children: [],
    } as vscode.DocumentSymbol));
}

function isDocumentSymbol(obj: unknown): obj is vscode.DocumentSymbol {
    return !!obj && typeof obj === 'object'
        && 'range' in obj
        && 'children' in obj
        && Array.isArray((obj as { children: unknown }).children);
}
