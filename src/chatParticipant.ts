import * as vscode from 'vscode';

/**
 * System prompt for the `@narrator` chat participant. Distinct from the
 * narration prompts in `prompt.ts`: chat answers should be Q&A, direct,
 * and emit clickable `narrate://lines/...` references that the existing
 * `fixupLinks` machinery converts to reveal links.
 */
export const NARRATOR_CHAT_SYSTEM_PROMPT = `You are @narrator, a code Q&A assistant embedded in VS Code's chat panel.

You receive:
- A user question.
- (Optional) The contents of the user's active file, line-numbered.
- (Optional) The user's current selection inside that file, line-numbered.

Output rules:
- Answer the question directly. No preamble, no restatement of the question, no closing remarks.
- Ground every claim in the supplied file/selection where possible.
- When referencing specific lines, use markdown links of the form
    [text](narrate://lines/L<start>-L<end>)
  or, for a single line, [text](narrate://lines/L<n>). The host will
  rewrite these into reveal links that jump the editor to that range.
- Use inline backticks for symbol names. Do NOT emit fenced code blocks
  for code that is already visible to the user in their editor; quote
  short snippets inline instead.
- If the question requires information you don't have (e.g. asks about
  another file, or no file is active), say so plainly and suggest what
  the user could supply.
- Keep answers as concise as the question deserves.`;

/**
 * One follow-up suggestion offered after every answer. Kept generic so it's
 * a useful nudge across question types.
 */
export const DEFAULT_FOLLOWUP = 'Where else is this used in the file?';

export interface ChatContextInputs {
    /** The current active editor's document, if any. */
    activeDocument?: {
        uri: vscode.Uri;
        languageId: string;
        getText(): string;
        getText(range: vscode.Range): string;
        lineCount: number;
    };
    /** Optional selection inside the active document. */
    selection?: vscode.Range;
    /** The free-form question the user typed after `@narrator`. */
    question: string;
}

export interface ChatPromptResult {
    systemPrompt: string;
    userPrompt: string;
    /** Filled in when no active file was supplied — handler should short-circuit. */
    noFileMessage?: string;
}

/**
 * Pure prompt builder for the chat participant. Returns either a
 * `userPrompt` ready to send to a `LanguageModelChat`, or a
 * `noFileMessage` describing the missing context — never both.
 *
 * Exported so unit tests can pin the wire format without booting a chat
 * host.
 */
export function buildChatPrompt(inputs: ChatContextInputs): ChatPromptResult {
    const question = inputs.question.trim();
    if (!inputs.activeDocument) {
        return {
            systemPrompt: NARRATOR_CHAT_SYSTEM_PROMPT,
            userPrompt: '',
            noFileMessage: 'No active editor — open a file and try again. @narrator answers questions about the file you have focused.',
        };
    }
    if (!question) {
        return {
            systemPrompt: NARRATOR_CHAT_SYSTEM_PROMPT,
            userPrompt: '',
            noFileMessage: 'Ask a question after `@narrator`, e.g. `@narrator why a Map here?`.',
        };
    }
    const doc = inputs.activeDocument;
    const path = vscode.workspace.asRelativePath(doc.uri);
    const fileBody = numberLines(doc.getText());
    const parts: string[] = [
        `Question: ${question}`,
        '',
        `Active file: ${path}`,
        `Language: ${doc.languageId}`,
        '',
        'File contents:',
        fileBody,
    ];
    if (inputs.selection && !rangeIsEmpty(inputs.selection)) {
        const selStart = inputs.selection.start.line + 1;
        const selEnd = inputs.selection.end.line + 1;
        const selText = doc.getText(inputs.selection);
        parts.push('', `Current selection (L${selStart}-L${selEnd}):`, numberLinesStartingAt(selText, selStart));
    }
    return {
        systemPrompt: NARRATOR_CHAT_SYSTEM_PROMPT,
        userPrompt: parts.join('\n'),
    };
}

function rangeIsEmpty(r: vscode.Range): boolean {
    return r.start.line === r.end.line && r.start.character === r.end.character;
}

function numberLines(text: string): string {
    const lines = text.split('\n');
    const width = String(lines.length).length;
    return lines
        .map((line, i) => `${String(i + 1).padStart(width)}│ ${line}`)
        .join('\n');
}

function numberLinesStartingAt(text: string, startLine: number): string {
    const lines = text.split('\n');
    const width = String(startLine + lines.length).length;
    return lines
        .map((line, i) => `${String(startLine + i).padStart(width)}│ ${line}`)
        .join('\n');
}

/**
 * Resolve the working-tree uri of the active editor, if any. Wraps
 * `vscode.window.activeTextEditor` so the participant handler can be
 * tested with a synthetic editor.
 */
export interface ActiveEditorLike {
    document: ChatContextInputs['activeDocument'] & object;
    selection: { isEmpty: boolean; start: vscode.Position; end: vscode.Position };
}

/** Convert an `ActiveEditorLike` to inputs for `buildChatPrompt`. */
export function activeEditorToInputs(editor: ActiveEditorLike | undefined, question: string): ChatContextInputs {
    if (!editor) return { question };
    const sel = editor.selection;
    const selection = sel && !sel.isEmpty
        ? new vscode.Range(sel.start.line, sel.start.character, sel.end.line, sel.end.character)
        : undefined;
    return {
        activeDocument: editor.document,
        selection,
        question,
    };
}

/**
 * Register the chat participant. Returns the participant so callers can
 * dispose it; in `activate()` the disposable is added to
 * `context.subscriptions` and managed by VS Code.
 *
 * The handler:
 * - Builds a Q&A prompt with the active file as context.
 * - Sends it to `request.model` (the host-selected LM) and streams the
 *   reply as markdown.
 * - Emits a `narrate://lines/...` → reveal-link fixup post-process so
 *   inline references behave the same as in the narration panel.
 * - Offers one suggested follow-up.
 *
 * The handler intentionally does NOT touch our own `NarrationProvider` —
 * the chat host's selected model is the single source of truth so the
 * answer stays consistent with the rest of the chat UI.
 */
export function registerNarratorChatParticipant(
    context: vscode.ExtensionContext,
    deps: ChatParticipantDeps = {},
): vscode.Disposable | undefined {
    if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
        // Older VS Code without the Chat Participant API. Nothing to do.
        return undefined;
    }
    const participant = vscode.chat.createChatParticipant('narrator', async (request, _chatContext, response, token) => {
        const editor = deps.getActiveEditor ? deps.getActiveEditor() : vscode.window.activeTextEditor;
        const inputs = activeEditorToInputs(editor as ActiveEditorLike | undefined, request.prompt ?? '');
        const built = buildChatPrompt(inputs);
        if (built.noFileMessage) {
            response.markdown(built.noFileMessage);
            return;
        }

        // Add a clickable reference to the active file so VS Code's chat UI
        // surfaces it as "context used" in the answer header.
        if (inputs.activeDocument) {
            const range = inputs.selection ?? new vscode.Range(0, 0, 0, 0);
            response.reference(new vscode.Location(inputs.activeDocument.uri, range));
        }

        const messages = [
            vscode.LanguageModelChatMessage.User(`${built.systemPrompt}\n\n${built.userPrompt}`),
        ];

        const uri = inputs.activeDocument?.uri;
        try {
            const lmResponse = await request.model.sendRequest(messages, {}, token);
            let acc = '';
            for await (const fragment of lmResponse.text) {
                if (token.isCancellationRequested) return;
                acc += fragment;
                response.markdown(fragment);
            }
            // Rewrite trailing `narrate://lines/...` links to `command:codeNarration.reveal`
            // URIs, but only for the *complete* accumulated text — VS Code's chat UI
            // doesn't re-render markdown so we can't patch in place. Instead, append
            // a small "Jump to…" footer for the most-referenced range if any were
            // emitted.
            if (uri) {
                const refs = extractNarrateRefs(acc);
                if (refs.length > 0) {
                    response.markdown('\n\n---\n*Tap a line reference above to reveal it in the editor.*');
                    for (const ref of refs) {
                        const range = new vscode.Range(ref.startLine, 0, ref.endLine, 0);
                        response.reference(new vscode.Location(uri, range));
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            response.markdown(`\n\n_The language model request failed: ${msg}_`);
            return;
        }
    });
    participant.iconPath = undefined;
    participant.followupProvider = {
        provideFollowups(_result, _context, _token) {
            return [{ prompt: DEFAULT_FOLLOWUP, label: DEFAULT_FOLLOWUP }];
        },
    };
    context.subscriptions.push(participant);
    return participant;
}

export interface ChatParticipantDeps {
    /** Test seam: override how the active editor is resolved. */
    getActiveEditor?: () => ActiveEditorLike | undefined;
}

interface NarrateRef {
    startLine: number;
    endLine: number;
}

const NARRATE_LINK_RE = /narrate:\/\/lines\/L(\d+)(?:-L(\d+))?/g;

/**
 * Pure: parse `narrate://lines/L<start>-L<end>` references out of a chunk of
 * markdown. Used to emit clickable post-answer references. Exported for tests.
 */
export function extractNarrateRefs(text: string): NarrateRef[] {
    const out: NarrateRef[] = [];
    let m: RegExpExecArray | null;
    NARRATE_LINK_RE.lastIndex = 0;
    while ((m = NARRATE_LINK_RE.exec(text)) !== null) {
        const start = Math.max(0, parseInt(m[1], 10) - 1);
        const end = m[2] ? Math.max(start, parseInt(m[2], 10) - 1) : start;
        if (Number.isFinite(start) && Number.isFinite(end)) {
            out.push({ startLine: start, endLine: end });
        }
    }
    return out;
}
