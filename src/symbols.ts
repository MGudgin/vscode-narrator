import * as vscode from 'vscode';

export interface NarrationUnit {
    kind: 'region' | 'symbol';
    name: string;
    range: vscode.Range;
    detail?: string;
}

export async function getNarrationUnits(doc: vscode.TextDocument): Promise<NarrationUnit[]> {
    const symbols = await fetchTopLevelSymbols(doc);
    if (symbols.length === 0) return [];

    const recurse = vscode.workspace.getConfiguration('codeNarration').get<boolean>('recurseSymbols', false);
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

    for (const sym of sorted) {
        units.push({
            kind: 'symbol',
            name: sym.name,
            range: sym.range,
            detail: sym.detail,
        });
    }

    const lastEnd = sorted[sorted.length - 1].range.end;
    const lastDocLine = doc.lineCount - 1;
    if (lastEnd.line < lastDocLine) {
        const postRange = new vscode.Range(lastEnd.line + 1, 0, lastDocLine, doc.lineAt(lastDocLine).range.end.character);
        if (doc.getText(postRange).trim().length > 0) {
            units.push({ kind: 'region', name: 'End of file', range: postRange });
        }
    }

    return units;
}

function flattenSymbols(
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
