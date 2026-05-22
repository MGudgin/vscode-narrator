import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    NARRATOR_CHAT_SYSTEM_PROMPT,
    DEFAULT_FOLLOWUP,
    buildChatPrompt,
    activeEditorToInputs,
    extractNarrateRefs,
} from './chatParticipant';

function mockDoc(text: string, uri = 'file:///r/a.ts', languageId = 'typescript') {
    const lines = text.split('\n');
    return {
        uri: vscode.Uri.parse(uri) as unknown as vscode.Uri,
        languageId,
        lineCount: lines.length,
        getText: (range?: vscode.Range) => {
            if (!range) return text;
            const start = range.start.line;
            const end = range.end.line;
            return lines.slice(start, end + 1).join('\n');
        },
    } as const;
}

describe('NARRATOR_CHAT_SYSTEM_PROMPT', () => {
    test('mentions the @narrator role and the narrate:// link convention', () => {
        expect(NARRATOR_CHAT_SYSTEM_PROMPT).toMatch(/@narrator/);
        expect(NARRATOR_CHAT_SYSTEM_PROMPT).toContain('narrate://lines/');
    });

    test('asks for Q&A style, not narration style', () => {
        expect(NARRATOR_CHAT_SYSTEM_PROMPT.toLowerCase()).toMatch(/answer/);
        expect(NARRATOR_CHAT_SYSTEM_PROMPT.toLowerCase()).toMatch(/no preamble/);
    });
});

describe('DEFAULT_FOLLOWUP', () => {
    test('is a non-empty single suggestion', () => {
        expect(DEFAULT_FOLLOWUP.trim().length).toBeGreaterThan(0);
    });
});

describe('buildChatPrompt', () => {
    test('returns a noFileMessage when no active document is present', () => {
        const out = buildChatPrompt({ question: 'why?' });
        expect(out.noFileMessage).toMatch(/No active editor/);
        expect(out.userPrompt).toBe('');
        expect(out.systemPrompt).toBe(NARRATOR_CHAT_SYSTEM_PROMPT);
    });

    test('returns a noFileMessage when the question is empty/whitespace', () => {
        const out = buildChatPrompt({ question: '   ', activeDocument: mockDoc('a\n') });
        expect(out.noFileMessage).toMatch(/Ask a question/);
    });

    test('includes the question, language, path, and numbered file body', () => {
        const doc = mockDoc('alpha\nbeta\ngamma\n');
        const out = buildChatPrompt({ question: 'what does this do?', activeDocument: doc });
        expect(out.noFileMessage).toBeUndefined();
        expect(out.userPrompt).toContain('Question: what does this do?');
        expect(out.userPrompt).toContain('Language: typescript');
        // Path comes from asRelativePath, which in the mock returns the fsPath
        expect(out.userPrompt).toMatch(/Active file: .+a\.ts/);
        // Numbered body — leftmost column is the line number followed by box
        expect(out.userPrompt).toMatch(/1[│|]\s+alpha/);
        expect(out.userPrompt).toMatch(/3[│|]\s+gamma/);
    });

    test('appends a Selection block when a non-empty range is supplied', () => {
        const doc = mockDoc('one\ntwo\nthree\nfour\n');
        const out = buildChatPrompt({
            question: 'why?',
            activeDocument: doc,
            selection: new vscode.Range(1, 0, 2, 3),
        });
        expect(out.userPrompt).toMatch(/Current selection \(L2-L3\)/);
        expect(out.userPrompt).toMatch(/2[│|]\s+two/);
        expect(out.userPrompt).toMatch(/3[│|]\s+thr/);
    });

    test('drops the Selection block when the range is empty', () => {
        const doc = mockDoc('one\ntwo\n');
        const out = buildChatPrompt({
            question: 'why?',
            activeDocument: doc,
            selection: new vscode.Range(0, 0, 0, 0),
        });
        expect(out.userPrompt).not.toMatch(/Current selection/);
    });

    test('trims the question before embedding it', () => {
        const doc = mockDoc('x\n');
        const out = buildChatPrompt({ question: '   why?   ', activeDocument: doc });
        expect(out.userPrompt).toContain('Question: why?');
        expect(out.userPrompt).not.toContain('Question:    why?');
    });
});

describe('activeEditorToInputs', () => {
    test('returns just the question when no editor is supplied', () => {
        const out = activeEditorToInputs(undefined, 'q');
        expect(out).toEqual({ question: 'q' });
    });

    test('passes the document through and converts the editor selection to a Range', () => {
        const doc = mockDoc('one\ntwo\nthree\n');
        const editor = {
            document: doc,
            selection: {
                isEmpty: false,
                start: { line: 1, character: 0 } as vscode.Position,
                end: { line: 2, character: 3 } as vscode.Position,
            },
        };
        const out = activeEditorToInputs(editor as Parameters<typeof activeEditorToInputs>[0], 'q');
        expect(out.activeDocument).toBe(doc);
        expect(out.selection).toBeDefined();
        expect(out.selection!.start.line).toBe(1);
        expect(out.selection!.end.line).toBe(2);
    });

    test('omits selection when the editor selection is empty', () => {
        const doc = mockDoc('one\n');
        const editor = {
            document: doc,
            selection: {
                isEmpty: true,
                start: { line: 0, character: 0 } as vscode.Position,
                end: { line: 0, character: 0 } as vscode.Position,
            },
        };
        const out = activeEditorToInputs(editor as Parameters<typeof activeEditorToInputs>[0], 'q');
        expect(out.selection).toBeUndefined();
    });
});

describe('extractNarrateRefs', () => {
    test('returns an empty list when no narrate:// links are present', () => {
        expect(extractNarrateRefs('Plain text, no refs.')).toEqual([]);
    });

    test('parses a single-line ref into a zero-width range (0-indexed)', () => {
        const out = extractNarrateRefs('See [this](narrate://lines/L5).');
        expect(out).toEqual([{ startLine: 4, endLine: 4 }]);
    });

    test('parses a multi-line ref into the corresponding 0-indexed range', () => {
        const out = extractNarrateRefs('See [block](narrate://lines/L10-L20).');
        expect(out).toEqual([{ startLine: 9, endLine: 19 }]);
    });

    test('parses several refs from one body', () => {
        const out = extractNarrateRefs(
            'First [a](narrate://lines/L1), then [b](narrate://lines/L3-L4), finally [c](narrate://lines/L7-L7).',
        );
        expect(out).toEqual([
            { startLine: 0, endLine: 0 },
            { startLine: 2, endLine: 3 },
            { startLine: 6, endLine: 6 },
        ]);
    });

    test('clamps a reversed range so endLine >= startLine', () => {
        const out = extractNarrateRefs('weird [r](narrate://lines/L10-L2)');
        expect(out).toEqual([{ startLine: 9, endLine: 9 }]);
    });
});
