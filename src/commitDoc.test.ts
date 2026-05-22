import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { CommitFileDocument } from './commitDoc';

const uri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;

describe('CommitFileDocument', () => {
    test('exposes lineCount and per-line text for an LF-separated body', () => {
        const doc = new CommitFileDocument(uri, 'typescript', 'one\ntwo\nthree\n');
        // Trailing newline produces a final empty "line", mirroring vscode.TextDocument.
        expect(doc.lineCount).toBe(4);
        expect(doc.lineAt(0).text).toBe('one');
        expect(doc.lineAt(1).text).toBe('two');
        expect(doc.lineAt(2).text).toBe('three');
        expect(doc.lineAt(3).text).toBe('');
        expect(doc.lineAt(2).range.end.character).toBe(5);
    });

    test('getText() with no range returns the full body, joined with LF', () => {
        const doc = new CommitFileDocument(uri, 'typescript', 'a\nb\nc');
        expect(doc.getText()).toBe('a\nb\nc');
    });

    test('getText(range) returns the slice across multiple lines', () => {
        const doc = new CommitFileDocument(uri, 'typescript', 'aaa\nbbb\nccc');
        const range = new vscode.Range(0, 1, 2, 2);
        expect(doc.getText(range)).toBe('aa\nbbb\ncc');
    });

    test('handles CRLF input: lines exclude the trailing \\r and lineCount stays accurate', () => {
        const doc = new CommitFileDocument(uri, 'typescript', 'x\r\ny\r\nz');
        expect(doc.lineCount).toBe(3);
        expect(doc.lineAt(0).text).toBe('x');
        expect(doc.lineAt(1).text).toBe('y');
        expect(doc.lineAt(2).text).toBe('z');
        // Real VS Code: EndOfLine.CRLF = 2, EndOfLine.LF = 1. Mock omits the
        // enum, so we just check the dominant-EOL detection produced the CRLF
        // sentinel value rather than the LF one.
        const lfDoc = new CommitFileDocument(uri, 'typescript', 'x\ny\nz');
        expect(doc.eol).not.toBe(lfDoc.eol);
    });

    test('lineAt out of range throws', () => {
        const doc = new CommitFileDocument(uri, 'typescript', 'only');
        expect(() => doc.lineAt(5)).toThrow(/Illegal value for line/);
    });

    test('exposes uri and languageId verbatim', () => {
        const doc = new CommitFileDocument(uri, 'javascript', '');
        expect(doc.uri).toBe(uri);
        expect(doc.languageId).toBe('javascript');
    });

    test('empty input still yields one empty line (mirrors VS Code semantics)', () => {
        const doc = new CommitFileDocument(uri, 'plaintext', '');
        expect(doc.lineCount).toBe(1);
        expect(doc.lineAt(0).text).toBe('');
    });

    test('firstNonWhitespaceCharacterIndex and isEmptyOrWhitespace', () => {
        const doc = new CommitFileDocument(uri, 'plaintext', '   hello\n   \n');
        expect(doc.lineAt(0).firstNonWhitespaceCharacterIndex).toBe(3);
        expect(doc.lineAt(0).isEmptyOrWhitespace).toBe(false);
        expect(doc.lineAt(1).isEmptyOrWhitespace).toBe(true);
    });
});
