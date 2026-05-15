import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { fixupLinks, buildUserPrompt, buildDiffUserPrompt } from './prompt';

const docUri = vscode.Uri.parse('file:///foo/bar.ts') as unknown as vscode.Uri;

describe('fixupLinks', () => {
    test('rewrites narrate://lines/L<n> to a command URI', () => {
        const result = fixupLinks('[click](narrate://lines/L42)', docUri);
        expect(result.startsWith('[click](command:codeNarration.reveal?')).toBe(true);
    });

    test('encodes the doc URI and 0-indexed range as JSON args', () => {
        const result = fixupLinks('[range](narrate://lines/L10-L20)', docUri);
        const match = result.match(/command:codeNarration\.reveal\?([^)]+)\)$/);
        expect(match).not.toBeNull();
        const args = JSON.parse(decodeURIComponent(match![1]));
        expect(args[0]).toBe('file:///foo/bar.ts');
        expect(args[1]).toEqual({
            start: { line: 9, character: 0 },
            end: { line: 19, character: Number.MAX_SAFE_INTEGER },
        });
    });

    test('single-line link uses same start and end line', () => {
        const result = fixupLinks('[here](narrate://lines/L7)', docUri);
        const match = result.match(/command:codeNarration\.reveal\?([^)]+)\)$/);
        const args = JSON.parse(decodeURIComponent(match![1]));
        expect(args[1].start.line).toBe(6);
        expect(args[1].end.line).toBe(6);
    });

    test('rewrites multiple links in one document', () => {
        const md = '[a](narrate://lines/L1) and [b](narrate://lines/L2-L5)';
        const result = fixupLinks(md, docUri);
        const matches = result.match(/command:codeNarration\.reveal/g) ?? [];
        expect(matches.length).toBe(2);
    });

    test('leaves unrelated URLs alone', () => {
        const md = '[external](https://example.com) and [code](narrate://lines/L1)';
        const result = fixupLinks(md, docUri);
        expect(result).toContain('https://example.com');
    });

    test('leaves bare text without URLs untouched', () => {
        const md = 'plain text with no links at all';
        expect(fixupLinks(md, docUri)).toBe(md);
    });

    test('clamps a 30-digit line number to a safely-integer-sized ceiling', () => {
        const huge = '9'.repeat(30);
        const md = `[bogus](narrate://lines/L${huge})`;
        const result = fixupLinks(md, docUri);
        const match = result.match(/command:codeNarration\.reveal\?([^)]+)\)$/);
        expect(match).not.toBeNull();
        const args = JSON.parse(decodeURIComponent(match![1]));
        const startLine = args[1].start.line;
        const endLine = args[1].end.line;
        expect(Number.isFinite(startLine)).toBe(true);
        expect(Number.isSafeInteger(startLine)).toBe(true);
        expect(startLine).toBeLessThanOrEqual(1_000_000);
        expect(Number.isFinite(endLine)).toBe(true);
        expect(Number.isSafeInteger(endLine)).toBe(true);
        expect(endLine).toBeLessThanOrEqual(1_000_000);
    });

    test('clamps both ends of a huge range link', () => {
        const huge = '9'.repeat(30);
        const md = `[r](narrate://lines/L${huge}-L${huge})`;
        const result = fixupLinks(md, docUri);
        const match = result.match(/command:codeNarration\.reveal\?([^)]+)\)$/);
        const args = JSON.parse(decodeURIComponent(match![1]));
        expect(args[1].start.line).toBeLessThanOrEqual(1_000_000);
        expect(args[1].end.line).toBeLessThanOrEqual(1_000_000);
        expect(Number.isSafeInteger(args[1].start.line)).toBe(true);
        expect(Number.isSafeInteger(args[1].end.line)).toBe(true);
    });
});

describe('buildUserPrompt', () => {
    test('numbers each line and includes the file path', () => {
        const doc = mockDoc('foo.ts', 'typescript', 'first\nsecond\nthird\n');
        const prompt = buildUserPrompt(doc);
        expect(prompt).toContain('foo.ts');
        expect(prompt).toContain('Language: typescript');
        expect(prompt).toMatch(/1│ first/);
        expect(prompt).toMatch(/2│ second/);
        expect(prompt).toMatch(/3│ third/);
    });
});

describe('buildDiffUserPrompt', () => {
    test('includes the unified diff and base ref alongside the source', () => {
        const doc = mockDoc('a.ts', 'typescript', 'hello\n');
        const prompt = buildDiffUserPrompt(doc, 'origin/main', '@@ -1 +1 @@\n-hi\n+hello');
        expect(prompt).toContain('Diff base: origin/main');
        expect(prompt).toContain('Unified diff:');
        expect(prompt).toContain('+hello');
        expect(prompt).toContain('Current (post-change) source:');
    });
});

function mockDoc(relPath: string, languageId: string, text: string): vscode.TextDocument {
    return {
        uri: vscode.Uri.parse(`file:///${relPath}`) as unknown as vscode.Uri,
        languageId,
        getText: () => text,
    } as unknown as vscode.TextDocument;
}
