import * as vscode from 'vscode';
import {
    readProviderConfig,
    makeProvider,
    storeAnthropicKey,
    clearAnthropicKey,
    MissingApiKeyError,
} from './llm/index';
import { SYSTEM_PROMPT, buildUserPrompt, fixupLinks } from './prompt';
import { renderMarkdown, renderLoading, renderError } from './webview';

let panel: vscode.WebviewPanel | undefined;
let currentDocUri: vscode.Uri | undefined;
let inFlight: vscode.CancellationTokenSource | undefined;
let saveDebounce: NodeJS.Timeout | undefined;

const SAVE_DEBOUNCE_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('codeNarration.open', () => openNarration(context)),
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

async function openNarration(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file to narrate.');
        return;
    }
    ensurePanel(context);
    await runNarration(context, editor.document);
}

function ensurePanel(context: vscode.ExtensionContext): void {
    if (panel) return;
    panel = vscode.window.createWebviewPanel(
        'codeNarration',
        'Narration',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
            enableCommandUris: true,
            enableScripts: false,
            retainContextWhenHidden: true,
        },
    );
    panel.onDidDispose(
        () => {
            panel = undefined;
            currentDocUri = undefined;
            inFlight?.cancel();
        },
        null,
        context.subscriptions,
    );
}

async function runNarration(context: vscode.ExtensionContext, doc: vscode.TextDocument): Promise<void> {
    if (!panel) return;

    inFlight?.cancel();
    inFlight?.dispose();
    inFlight = new vscode.CancellationTokenSource();
    const token = inFlight.token;

    currentDocUri = doc.uri;
    const label = shortName(doc);
    panel.title = `Narration: ${label}`;
    panel.webview.html = renderLoading(panel.webview, label);
    panel.reveal(vscode.ViewColumn.Beside, true);

    try {
        const providerConfig = await readProviderConfig(context);
        const provider = makeProvider(providerConfig);
        const userPrompt = buildUserPrompt(doc);
        const raw = await provider.narrate(SYSTEM_PROMPT, userPrompt, token);
        if (token.isCancellationRequested || !panel) return;
        const fixed = fixupLinks(raw, doc.uri);
        panel.webview.html = renderMarkdown(panel.webview, fixed);
    } catch (err) {
        if (token.isCancellationRequested || !panel) return;
        if (err instanceof MissingApiKeyError) {
            panel.webview.html = renderError(
                panel.webview,
                err.message,
                'Run "Code Narration: Set Anthropic API Key" from the command palette.',
            );
            const choice = await vscode.window.showErrorMessage(err.message, 'Set API Key');
            if (choice === 'Set API Key') {
                await setApiKey(context);
                void runNarration(context, doc);
            }
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderError(panel.webview, message);
    }
}

function onSave(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
    if (!panel || !currentDocUri) return;
    if (currentDocUri.toString() !== doc.uri.toString()) return;
    const enabled = vscode.workspace.getConfiguration('codeNarration').get<boolean>('narrateOnSave', true);
    if (!enabled) return;
    if (saveDebounce) clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() => void runNarration(context, doc), SAVE_DEBOUNCE_MS);
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

function shortName(doc: vscode.TextDocument): string {
    const path = doc.uri.fsPath || doc.uri.path;
    return path.split(/[\\/]/).pop() ?? doc.uri.toString();
}
