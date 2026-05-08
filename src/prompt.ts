import * as vscode from 'vscode';
import { NarrationUnit } from './symbols';

export const SYSTEM_PROMPT = `You are a code narrator. Given a source file, produce a clear narration in GitHub-flavored markdown for a developer reading the code on the left.

Output rules:
- Break the file into logical sections (e.g. imports, top-level regions, functions, classes, methods).
- Each section starts with a level-2 heading. The heading text MUST be a markdown link of the form:
    [Section title](narrate://lines/L<start>-L<end>)
  For a single-line callout, use [text](narrate://lines/L<n>).
- Use the line numbers shown in the leftmost column of the source. Use them exactly.
- After the heading, write 2-6 sentences in plain prose: what the code does, why it exists, and any non-obvious behavior or invariants.
- You may use inline narrate://lines/... links to point at specific lines or ranges within a section.
- Use inline backticks for symbol names. Do NOT emit fenced code blocks; the reader sees the source on the left.
- Begin your output with the first heading. No preamble, no closing remarks.`;

export const DIFF_SYSTEM_PROMPT = `You are narrating CHANGES to a source file for a developer reviewing their work.

You receive:
- The current (post-change) file contents, line-numbered.
- A unified diff vs a base ref.

Output rules:
- Focus on what CHANGED and WHY. Don't re-explain unchanged code unless context demands it.
- Group related changes into sections. Each section starts with a level-2 heading whose text MUST be a markdown link of the form:
    [Change summary](narrate://lines/L<start>-L<end>)
  using line numbers from the CURRENT (post-change) file.
- After the heading, write 2-5 sentences in plain prose: what changed, what behavior is now different, and any non-obvious consequences.
- Use inline backticks for symbol names. Do NOT emit fenced code blocks; the reviewer can see the code on the left.
- Inline references to specific lines should also be markdown links of the same form.
- If the diff is small or trivial (e.g. whitespace, a renamed variable), say so briefly rather than padding.
- Begin output with the first heading. No preamble, no closing remarks.`;

export const SYMBOL_SYSTEM_PROMPT = `You are narrating one section of a source file for a developer reading the code on the left.

Output rules:
- Write 2-5 sentences in plain prose: what this section does, why it exists, any non-obvious behavior or invariants.
- Use inline backticks for symbol names. Do NOT emit fenced code blocks; the reader sees the source on the left.
- For inline references to specific lines, use markdown links of the form [text](narrate://lines/L<n>) or [text](narrate://lines/L<start>-L<end>). Use the line numbers shown in the leftmost column of the source.
- Output nothing else: no title, no preamble, no closing remarks, no headings.`;

export function buildUserPrompt(doc: vscode.TextDocument): string {
    const path = vscode.workspace.asRelativePath(doc.uri);
    const numbered = numberLines(doc.getText());
    return `File: ${path}\nLanguage: ${doc.languageId}\n\nSource:\n${numbered}`;
}

export function buildDiffUserPrompt(doc: vscode.TextDocument, baseRef: string, unifiedDiff: string): string {
    const path = vscode.workspace.asRelativePath(doc.uri);
    const numbered = numberLines(doc.getText());
    return `File: ${path}\nLanguage: ${doc.languageId}\nDiff base: ${baseRef}\n\nUnified diff:\n${unifiedDiff}\n\nCurrent (post-change) source:\n${numbered}`;
}

export function buildSymbolUserPrompt(unit: NarrationUnit, doc: vscode.TextDocument): string {
    const path = vscode.workspace.asRelativePath(doc.uri);
    const numbered = numberLinesInRange(doc, unit.range);
    const header = unit.kind === 'symbol'
        ? `Section: ${unit.name}${unit.detail ? ` — ${unit.detail}` : ''}`
        : `Section: ${unit.name} (file region — imports, module-level code, etc.)`;
    return `File: ${path}\nLanguage: ${doc.languageId}\n${header}\n\nSource:\n${numbered}`;
}

function numberLines(text: string): string {
    const lines = text.split('\n');
    const width = String(lines.length).length;
    return lines
        .map((line, i) => `${String(i + 1).padStart(width)}│ ${line}`)
        .join('\n');
}

function numberLinesInRange(doc: vscode.TextDocument, range: vscode.Range): string {
    const startLine = range.start.line;
    const endLine = range.end.line;
    const width = String(endLine + 1).length;
    const out: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
        out.push(`${String(i + 1).padStart(width)}│ ${doc.lineAt(i).text}`);
    }
    return out.join('\n');
}

export function fixupLinks(markdown: string, docUri: vscode.Uri): string {
    return markdown.replace(
        /narrate:\/\/lines\/L(\d+)(?:-L(\d+))?/g,
        (_match, startStr: string, endStr: string | undefined) => {
            const startLine = Math.max(0, parseInt(startStr, 10) - 1);
            const endLine = endStr ? Math.max(startLine, parseInt(endStr, 10) - 1) : startLine;
            const range = {
                start: { line: startLine, character: 0 },
                end: { line: endLine, character: Number.MAX_SAFE_INTEGER },
            };
            const args = encodeURIComponent(JSON.stringify([docUri.toString(), range]));
            return `command:codeNarration.reveal?${args}`;
        },
    );
}
