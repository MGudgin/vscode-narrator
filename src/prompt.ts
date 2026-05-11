import * as vscode from 'vscode';
import { NarrationUnit } from './symbols';
import { TreeChange } from './diff';

const MAX_COMBINED_DIFF_CHARS = 12000;

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

export const TREE_SUMMARY_SYSTEM_PROMPT = `You are summarizing a multi-file changeset for a developer reviewing their work.

You receive:
- A list of changed files with their statuses (added, modified, deleted, renamed).
- A truncated combined unified diff.

Output rules:
- Write 3-6 sentences in plain prose summarizing the overall intent of the changeset.
- Lead with the headline change. Group related files when it helps the reader.
- Mention surprising or risky aspects (deletions, renames, cross-cutting changes).
- Use inline backticks for file paths and symbol names. Do NOT emit fenced code blocks or markdown links — per-file detail follows in subsequent sections.
- Output nothing else: no title, no preamble, no closing remarks, no headings.`;

export const TREE_FILE_DIFF_SYSTEM_PROMPT = `You are narrating CHANGES to a single file inside a larger changeset for a developer reviewing their work.

You receive:
- The file path and status (added, modified, deleted, renamed).
- A unified diff vs a base ref.

Output rules:
- Write 2-5 sentences in plain prose: what changed, what behavior is now different, and any non-obvious consequences.
- For inline references to specific lines, use markdown links of the form [text](narrate://lines/L<n>) or [text](narrate://lines/L<start>-L<end>) using line numbers from the post-change file.
- Use inline backticks for symbol names. Do NOT emit fenced code blocks or top-level headings; the section heading is supplied separately.
- If the diff is small or trivial (e.g. whitespace, a renamed variable), say so briefly rather than padding.
- Output nothing else: no title, no preamble, no closing remarks.`;

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

export function buildTreeSummaryPrompt(
    repoRoot: vscode.Uri,
    baseRef: string,
    changes: TreeChange[],
    combinedDiff: string,
): string {
    const repoName = (repoRoot.fsPath || repoRoot.path).split(/[\\/]/).filter(Boolean).pop() ?? '';
    const list = changes
        .map((c) => {
            const path = relativePath(repoRoot, c.uri);
            if (c.status === 'renamed' && c.originalUri) {
                return `- [renamed] ${relativePath(repoRoot, c.originalUri)} → ${path}`;
            }
            return `- [${c.status}] ${path}`;
        })
        .join('\n');
    const truncated = combinedDiff.length > MAX_COMBINED_DIFF_CHARS
        ? combinedDiff.slice(0, MAX_COMBINED_DIFF_CHARS) + `\n\n[…diff truncated, ${combinedDiff.length - MAX_COMBINED_DIFF_CHARS} more chars]`
        : combinedDiff;
    return `Repository: ${repoName}\nBase ref: ${baseRef}\n\nChanged files:\n${list}\n\nCombined unified diff:\n${truncated}`;
}

export function buildTreeFileDiffPrompt(
    repoRoot: vscode.Uri,
    baseRef: string,
    change: TreeChange,
): string {
    const path = relativePath(repoRoot, change.uri);
    const diffBody = change.unifiedDiff.trim().length > 0
        ? change.unifiedDiff
        : '(no diff body available)';
    const lines = [`File: ${path}`];
    if (change.status === 'renamed' && change.originalUri) {
        lines.push(`Renamed from: ${relativePath(repoRoot, change.originalUri)}`);
    }
    lines.push(`Status: ${change.status}`, `Diff base: ${baseRef}`);
    return `${lines.join('\n')}\n\nUnified diff:\n${diffBody}`;
}

export function buildSymbolUserPrompt(unit: NarrationUnit, doc: vscode.TextDocument): string {
    const path = vscode.workspace.asRelativePath(doc.uri);
    const numbered = numberLinesInRange(doc, unit.range);
    const header = unit.kind === 'symbol'
        ? `Section: ${unit.name}${unit.detail ? ` — ${unit.detail}` : ''}`
        : `Section: ${unit.name} (file region — imports, module-level code, etc.)`;
    return `File: ${path}\nLanguage: ${doc.languageId}\n${header}\n\nSource:\n${numbered}`;
}

function relativePath(root: vscode.Uri, file: vscode.Uri): string {
    const rootPath = (root.fsPath || root.path).replace(/\\/g, '/').replace(/\/$/, '');
    const filePath = (file.fsPath || file.path).replace(/\\/g, '/');
    if (rootPath && filePath.toLowerCase().startsWith(rootPath.toLowerCase() + '/')) {
        return filePath.slice(rootPath.length + 1);
    }
    return filePath;
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
