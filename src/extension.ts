import * as vscode from 'vscode';
import {
    readProviderConfig,
    makeProvider,
    describeProvider,
    storeAnthropicKey,
    clearAnthropicKey,
    MissingApiKeyError,
} from './llm/index';
import { narrateDocument, narrateDiff, NarrationSink } from './narrate';
import { renderShell, renderError, renderMarkdownToHtml } from './webview';
import { NarrationTarget, targetMatchesSavedDoc, targetTitle, targetBannerLabel } from './target';
import { NarrationCache } from './cache';
import { fixupLinks } from './prompt';

let panel: vscode.WebviewPanel | undefined;
let currentTarget: NarrationTarget | undefined;
let inFlight: vscode.CancellationTokenSource | undefined;
let saveDebounce: NodeJS.Timeout | undefined;
let cache: NarrationCache | undefined;

const SAVE_DEBOUNCE_MS = 500;
const RENDER_THROTTLE_MS = 100;

interface RunOptions {
    skipCache?: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
    cache = new NarrationCache(context.workspaceState);
    context.subscriptions.push(
        vscode.commands.registerCommand('codeNarration.open', () => openFileNarration(context)),
        vscode.commands.registerCommand('codeNarration.openDiff', () => openDiffNarration(context)),
        vscode.commands.registerCommand('codeNarration.refresh', () => refreshNarration(context)),
        vscode.commands.registerCommand('codeNarration.reveal', revealLocation),
        vscode.commands.registerCommand('codeNarration.setApiKey', () => setApiKey(context)),
        vscode.workspace.onDidSaveTextDocument((doc) => onSave(context, doc)),
    );
}

export function deactivate(): void {
    inFlight?.cancel();
    inFlight?.dispose();
    panel?.dispose();
    if (saveDebounce) clearTimeout(saveDebounce);
}

async function openFileNarration(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file to narrate.');
        return;
    }
    ensurePanel(context);
    await runNarration(context, { kind: 'file', uri: editor.document.uri });
}

async function openDiffNarration(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file to narrate diffs for.');
        return;
    }
    const baseRef = vscode.workspace.getConfiguration('codeNarration').get<string>('diffBase', 'HEAD');
    ensurePanel(context);
    await runNarration(context, { kind: 'diff', uri: editor.document.uri, baseRef });
}

async function refreshNarration(context: vscode.ExtensionContext): Promise<void> {
    if (!currentTarget) {
        vscode.window.showInformationMessage('No narration to refresh. Open one first.');
        return;
    }
    ensurePanel(context);
    await runNarration(context, currentTarget, { skipCache: true });
}

function ensurePanel(context: vscode.ExtensionContext): void {
    if (panel) return;
    panel = vscode.window.createWebviewPanel(
        'codeNarration',
        'Narration',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
            enableCommandUris: true,
            enableScripts: true,
            retainContextWhenHidden: true,
        },
    );
    panel.onDidDispose(
        () => {
            panel = undefined;
            currentTarget = undefined;
            inFlight?.cancel();
        },
        null,
        context.subscriptions,
    );
}

async function runNarration(
    context: vscode.ExtensionContext,
    target: NarrationTarget,
    opts: RunOptions = {},
): Promise<void> {
    if (!panel || !cache) return;

    inFlight?.cancel();
    inFlight?.dispose();
    inFlight = new vscode.CancellationTokenSource();
    const token = inFlight.token;

    currentTarget = target;
    const bannerLabel = targetBannerLabel(target);
    panel.title = targetTitle(target);
    panel.webview.html = renderShell(panel.webview, shortName(target.uri), bannerLabel);
    panel.reveal(vscode.ViewColumn.Beside, true);

    const sectionState = new Map<string, { accumulated: string; lastRender: number; static: boolean }>();
    const activePanel = panel;

    const sink: NarrationSink = (event) => {
        if (token.isCancellationRequested) return;
        switch (event.kind) {
            case 'init': {
                sectionState.clear();
                const sectionsForWebview = event.sections.map((s) => {
                    const headingHtml = s.headingMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.headingMarkdown, target.uri))
                        : '';
                    const bodyHtml = s.bodyMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.bodyMarkdown, target.uri))
                        : '';
                    sectionState.set(s.id, {
                        accumulated: s.bodyMarkdown ?? '',
                        lastRender: 0,
                        static: !!s.bodyMarkdown,
                    });
                    return { id: s.id, headingHtml, bodyHtml };
                });
                void activePanel.webview.postMessage({ kind: 'reset', sections: sectionsForWebview });
                break;
            }
            case 'chunk': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated += event.text;
                const now = Date.now();
                if (now - state.lastRender < RENDER_THROTTLE_MS) return;
                state.lastRender = now;
                const html = renderMarkdownToHtml(fixupLinks(state.accumulated, target.uri));
                void activePanel.webview.postMessage({ kind: 'replace', sectionId: event.sectionId, bodyHtml: html });
                break;
            }
            case 'done': {
                for (const [id, state] of sectionState) {
                    if (state.static) continue;
                    const md = state.accumulated.trim().length > 0
                        ? state.accumulated
                        : '_(no narration produced for this section.)_';
                    const html = renderMarkdownToHtml(fixupLinks(md, target.uri));
                    void activePanel.webview.postMessage({ kind: 'replace', sectionId: id, bodyHtml: html });
                }
                break;
            }
        }
    };

    try {
        const doc = await vscode.workspace.openTextDocument(target.uri);
        const providerConfig = await readProviderConfig(context);
        const provider = makeProvider(providerConfig);
        const providerInfo = describeProvider(providerConfig);
        const narrateOptions = {
            skipCache: opts.skipCache ?? false,
            cache,
            providerInfo,
        };

        if (target.kind === 'file') {
            await narrateDocument(doc, provider, token, sink, narrateOptions);
        } else {
            await narrateDiff(doc, target.baseRef, provider, token, sink, narrateOptions);
        }
    } catch (err) {
        if (token.isCancellationRequested || !panel) return;
        if (err instanceof MissingApiKeyError) {
            panel.webview.html = renderError(
                panel.webview,
                err.message,
                'Run "Code Narration: Set Anthropic API Key" from the command palette.',
                bannerLabel,
            );
            const choice = await vscode.window.showErrorMessage(err.message, 'Set API Key');
            if (choice === 'Set API Key') {
                await setApiKey(context);
                void runNarration(context, target);
            }
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderError(panel.webview, message, undefined, bannerLabel);
    }
}

function onSave(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
    if (!panel || !currentTarget) return;
    if (!targetMatchesSavedDoc(currentTarget, doc.uri)) return;
    const enabled = vscode.workspace.getConfiguration('codeNarration').get<boolean>('narrateOnSave', true);
    if (!enabled) return;
    if (saveDebounce) clearTimeout(saveDebounce);
    const target = currentTarget;
    saveDebounce = setTimeout(() => void runNarration(context, target), SAVE_DEBOUNCE_MS);
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
    const key = await vscode.window.showInputBox({
        title: 'Code Narration: Anthropic API Key',
        placeHolder: 'sk-ant-... (leave empty to clear)',
        password: true,
        ignoreFocusOut: true,
    });
    if (key === undefined) return;
    if (key.trim() === '') {
        await clearAnthropicKey(context);
        vscode.window.showInformationMessage('Code Narration: API key cleared.');
    } else {
        await storeAnthropicKey(context, key.trim());
        vscode.window.showInformationMessage('Code Narration: API key stored.');
    }
}

async function revealLocation(
    uriStr: string,
    rangeLike: { start: { line: number; character: number }; end: { line: number; character: number } },
): Promise<void> {
    const uri = vscode.Uri.parse(uriStr);
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(
        rangeLike.start.line,
        rangeLike.start.character,
        rangeLike.end.line,
        rangeLike.end.character,
    );
    await vscode.window.showTextDocument(doc, {
        selection: range,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
    });
}

function shortName(uri: vscode.Uri): string {
    const p = uri.fsPath || uri.path;
    return p.split(/[\\/]/).pop() ?? uri.toString();
}
