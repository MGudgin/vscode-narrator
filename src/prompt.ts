import * as vscode from 'vscode';

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

export function buildUserPrompt(doc: vscode.TextDocument): string {
    const path = vscode.workspace.asRelativePath(doc.uri);
    const numbered = numberLines(doc.getText());
    return `File: ${path}\nLanguage: ${doc.languageId}\n\nSource:\n${numbered}`;
}

function numberLines(text: string): string {
    const lines = text.split('\n');
    const width = String(lines.length).length;
    return lines
        .map((line, i) => `${String(i + 1).padStart(width)}│ ${line}`)
        .join('\n');
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
