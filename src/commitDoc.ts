import * as vscode from 'vscode';

/**
 * Minimal `vscode.TextDocument` shim built from a fixed content string,
 * used to narrate a file's state at a specific git commit without opening
 * an untitled doc in the editor.
 *
 * Only the surface area the narration prompts actually call is implemented:
 *   - `uri`, `languageId`
 *   - `lineCount`
 *   - `getText()` / `getText(range)`
 *   - `lineAt(line)` exposing `range.end.character` and `text`
 *
 * Unused methods throw if invoked so misuse is loud.
 *
 * Built as an exported class rather than a factory so tests can construct
 * instances directly.
 */
export class CommitFileDocument implements vscode.TextDocument {
    private readonly _lines: string[];
    private readonly _eolMarkers: number[]; // length of trailing newline (0, 1, or 2) per line
    readonly uri: vscode.Uri;
    readonly fileName: string;
    readonly isUntitled = false;
    readonly languageId: string;
    readonly version = 1;
    readonly isDirty = false;
    readonly isClosed = false;
    readonly notebook = undefined;
    readonly eol: vscode.EndOfLine;
    readonly encoding = 'utf8';

    constructor(uri: vscode.Uri, languageId: string, content: string) {
        this.uri = uri;
        this.fileName = uri.fsPath || uri.path;
        this.languageId = languageId;
        const { lines, eolMarkers, crlfDominant } = splitContent(content);
        this._lines = lines;
        this._eolMarkers = eolMarkers;
        // `EndOfLine` is a const enum at compile time but a runtime object in
        // real VS Code. Fall back to numeric values (LF = 1, CRLF = 2) so
        // unit tests using the lightweight mock can still construct one.
        const eolEnum = (vscode as { EndOfLine?: { LF: number; CRLF: number } }).EndOfLine
            ?? { LF: 1, CRLF: 2 };
        this.eol = (crlfDominant ? eolEnum.CRLF : eolEnum.LF) as vscode.EndOfLine;
    }

    get lineCount(): number {
        return this._lines.length;
    }

    save(): Thenable<boolean> {
        return Promise.resolve(false);
    }

    lineAt(line: number | vscode.Position): vscode.TextLine {
        const lineNumber = typeof line === 'number' ? line : line.line;
        if (lineNumber < 0 || lineNumber >= this._lines.length) {
            throw new Error(`Illegal value for line ${lineNumber} on ${this._lines.length}-line document.`);
        }
        const text = this._lines[lineNumber];
        const range = new vscode.Range(lineNumber, 0, lineNumber, text.length);
        const rangeIncludingLineBreak = new vscode.Range(
            lineNumber,
            0,
            lineNumber,
            text.length + this._eolMarkers[lineNumber],
        );
        const firstNonWhitespaceCharacterIndex = computeFirstNonWhitespace(text);
        const isEmptyOrWhitespace = firstNonWhitespaceCharacterIndex === text.length;
        return {
            lineNumber,
            text,
            range,
            rangeIncludingLineBreak,
            firstNonWhitespaceCharacterIndex,
            isEmptyOrWhitespace,
        };
    }

    offsetAt(_position: vscode.Position): number {
        throw new Error('CommitFileDocument: offsetAt is not implemented.');
    }

    positionAt(_offset: number): vscode.Position {
        throw new Error('CommitFileDocument: positionAt is not implemented.');
    }

    getText(range?: vscode.Range): string {
        if (!range) return this._lines.join('\n');
        const startLine = Math.max(0, range.start.line);
        const endLine = Math.min(this._lines.length - 1, range.end.line);
        if (startLine > endLine) return '';
        if (startLine === endLine) {
            return this._lines[startLine].slice(range.start.character, range.end.character);
        }
        const out: string[] = [this._lines[startLine].slice(range.start.character)];
        for (let i = startLine + 1; i < endLine; i++) out.push(this._lines[i]);
        out.push(this._lines[endLine].slice(0, range.end.character));
        return out.join('\n');
    }

    getWordRangeAtPosition(): vscode.Range | undefined {
        return undefined;
    }

    validateRange(range: vscode.Range): vscode.Range {
        return range;
    }

    validatePosition(position: vscode.Position): vscode.Position {
        return position;
    }
}

interface SplitContentResult {
    lines: string[];
    eolMarkers: number[];
    crlfDominant: boolean;
}

function splitContent(content: string): SplitContentResult {
    // Split on LF so a trailing newline produces a final empty line, matching
    // VS Code's `TextDocument.lineCount` semantics.
    const rawLines = content.split('\n');
    const lines: string[] = [];
    const eolMarkers: number[] = [];
    let crlf = 0;
    let lf = 0;
    const lastIdx = rawLines.length - 1;
    for (let i = 0; i < rawLines.length; i++) {
        let line = rawLines[i];
        let eol = 0;
        if (i < lastIdx) {
            if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
                line = line.slice(0, -1);
                eol = 2;
                crlf++;
            } else {
                eol = 1;
                lf++;
            }
        }
        lines.push(line);
        eolMarkers.push(eol);
    }
    if (lines.length === 0) {
        lines.push('');
        eolMarkers.push(0);
    }
    return { lines, eolMarkers, crlfDominant: crlf > lf };
}

function computeFirstNonWhitespace(text: string): number {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c !== 32 && c !== 9) return i;
    }
    return text.length;
}
