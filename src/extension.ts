import * as path from 'path';
import * as vscode from 'vscode';
import {
    readProviderConfig,
    makeProvider,
    describeProvider,
    storeAnthropicKey,
    clearAnthropicKey,
    MissingApiKeyError,
} from './llm/index';
import { narrateDocument, narrateDiff, narrateTreeDiff, NarrationSink } from './narrate';
import { renderShell, renderError, renderMarkdownToHtml, aggregateBannerStatus } from './webview';
import { NarrationTarget, targetMatchesSavedDoc, targetTitle, targetBannerLabel, targetShortName } from './target';
import { NarrationCache } from './cache';
import { fixupLinks } from './prompt';
import { findRepoRootForUri, listRepoRoots, watchRepoState } from './diff';

let panel: vscode.WebviewPanel | undefined;
let currentTarget: NarrationTarget | undefined;
let inFlight: vscode.CancellationTokenSource | undefined;
let saveDebounce: NodeJS.Timeout | undefined;
let selectionDebounce: NodeJS.Timeout | undefined;
let repoStateDebounce: NodeJS.Timeout | undefined;
let repoWatcher: vscode.Disposable | undefined;
let watchedRepoRoot: string | undefined;
let repoWatcherPrimed = false;
let cache: NarrationCache | undefined;
const sectionRanges: { id: string; range: vscode.Range }[] = [];

const SAVE_DEBOUNCE_MS = 500;
const RENDER_THROTTLE_MS = 100;
const SELECTION_DEBOUNCE_MS = 200;
const REPO_STATE_DEBOUNCE_MS = 750;

interface RunOptions {
    skipCache?: boolean;
}

export function activate(context: vscode.ExtensionContext): void {
    cache = new NarrationCache(context.workspaceState);
    context.subscriptions.push(
        vscode.commands.registerCommand('codeNarration.open', () => openFileNarration(context)),
        vscode.commands.registerCommand('codeNarration.openDiff', () => openDiffNarration(context)),
        vscode.commands.registerCommand(
            'codeNarration.openTreeDiff',
            (source?: vscode.SourceControl) => openTreeDiffNarration(context, source),
        ),
        vscode.commands.registerCommand('codeNarration.refresh', () => refreshNarration(context)),
        vscode.commands.registerCommand('codeNarration.reveal', revealLocation),
        vscode.commands.registerCommand('codeNarration.setApiKey', () => setApiKey(context)),
        vscode.commands.registerCommand('codeNarration.pickModel', () => pickModel(context)),
        vscode.commands.registerCommand('codeNarration.clearCache', () => clearCacheCommand()),
        vscode.workspace.onDidSaveTextDocument((doc) => onSave(context, doc)),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChange),
    );
}

export function deactivate(): void {
    inFlight?.cancel();
    inFlight?.dispose();
    panel?.dispose();
    if (saveDebounce) clearTimeout(saveDebounce);
    if (selectionDebounce) clearTimeout(selectionDebounce);
    if (repoStateDebounce) clearTimeout(repoStateDebounce);
    repoWatcher?.dispose();
    repoWatcher = undefined;
    watchedRepoRoot = undefined;
    repoWatcherPrimed = false;
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

async function openTreeDiffNarration(
    context: vscode.ExtensionContext,
    source?: vscode.SourceControl,
): Promise<void> {
    let repoRoot: vscode.Uri | undefined = source?.rootUri;
    if (!repoRoot) {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            repoRoot = await findRepoRootForUri(editor.document.uri);
        }
    }
    if (!repoRoot) {
        const roots = await listRepoRoots();
        if (roots.length === 0) {
            vscode.window.showInformationMessage('No git repository found.');
            return;
        }
        if (roots.length === 1) {
            repoRoot = roots[0];
        } else {
            repoRoot = await pickRepoRoot(roots);
            if (!repoRoot) return;
        }
    }
    const baseRef = vscode.workspace.getConfiguration('codeNarration').get<string>('diffBase', 'HEAD');
    ensurePanel(context);
    await runNarration(context, { kind: 'tree', repoRoot, baseRef });
}

async function pickRepoRoot(roots: vscode.Uri[]): Promise<vscode.Uri | undefined> {
    const items = roots.map((uri) => ({
        label: path.basename(uri.fsPath) || uri.fsPath,
        description: uri.fsPath,
        uri,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a git repository to narrate',
        matchOnDescription: true,
    });
    return picked?.uri;
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
    // ViewColumn.Beside falls back to column 1 when no editor is active, which means
    // a later Explorer click opens the file on top of the webview. Pin to column 2 in
    // that case so files always land in column 1.
    const initialColumn = vscode.window.activeTextEditor
        ? vscode.ViewColumn.Beside
        : vscode.ViewColumn.Two;
    panel = vscode.window.createWebviewPanel(
        'codeNarration',
        'Narration',
        { viewColumn: initialColumn, preserveFocus: true },
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
            repoWatcher?.dispose();
            repoWatcher = undefined;
            watchedRepoRoot = undefined;
            repoWatcherPrimed = false;
        },
        null,
        context.subscriptions,
    );
}

async function updateRepoWatcher(context: vscode.ExtensionContext, target: NarrationTarget): Promise<void> {
    const desiredRoot = target.kind === 'tree' ? target.repoRoot.toString() : undefined;
    if (desiredRoot === watchedRepoRoot) return;

    repoWatcher?.dispose();
    repoWatcher = undefined;
    watchedRepoRoot = undefined;
    repoWatcherPrimed = false;

    if (target.kind !== 'tree') return;

    const watcher = await watchRepoState(target.repoRoot, (repoRoot) => {
        if (!repoWatcherPrimed) {
            repoWatcherPrimed = true;
            return;
        }
        if (!currentTarget || currentTarget.kind !== 'tree') return;
        if (currentTarget.repoRoot.toString() !== repoRoot.toString()) return;
        if (repoStateDebounce) clearTimeout(repoStateDebounce);
        const t = currentTarget;
        repoStateDebounce = setTimeout(() => void runNarration(context, t), REPO_STATE_DEBOUNCE_MS);
    });
    if (!watcher) return;
    repoWatcher = watcher;
    watchedRepoRoot = desiredRoot;
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
    sectionRanges.length = 0;
    const bannerLabel = targetBannerLabel(target);
    panel.title = targetTitle(target);
    panel.webview.html = renderShell(panel.webview, targetShortName(target), bannerLabel);
    panel.reveal(panel.viewColumn, true);

    void updateRepoWatcher(context, target);

    type Status = 'queued' | 'streaming' | 'complete';
    const sectionState = new Map<string, { accumulated: string; lastRender: number; static: boolean; status: Status; linkUri: vscode.Uri }>();
    const activePanel = panel;
    let lastBannerStatus: 'hidden' | 'streaming' | 'complete' = 'hidden';
    const syncBannerStatus = (): void => {
        const next = aggregateBannerStatus(
            Array.from(sectionState.values(), (s) => s.status),
        );
        if (next === lastBannerStatus) return;
        lastBannerStatus = next;
        void activePanel.webview.postMessage({ kind: 'bannerStatus', status: next });
    };
    const fallbackLinkUri = target.kind === 'tree' ? target.repoRoot : target.uri;

    const sink: NarrationSink = (event) => {
        if (token.isCancellationRequested) return;
        switch (event.kind) {
            case 'init': {
                sectionState.clear();
                sectionRanges.length = 0;
                const sectionsForWebview = event.sections.map((s) => {
                    if (s.range) {
                        sectionRanges.push({ id: s.id, range: s.range });
                    }
                    const linkUri = s.linkUri ?? fallbackLinkUri;
                    const headingHtml = s.headingMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.headingMarkdown, linkUri))
                        : '';
                    const bodyHtml = s.bodyMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.bodyMarkdown, linkUri))
                        : '';
                    const isStatic = !!s.bodyMarkdown;
                    const initialStatus: Status = isStatic ? 'complete' : 'queued';
                    sectionState.set(s.id, {
                        accumulated: s.bodyMarkdown ?? '',
                        lastRender: 0,
                        static: isStatic,
                        status: initialStatus,
                        linkUri,
                    });
                    return { id: s.id, headingHtml, bodyHtml, status: initialStatus };
                });
                const labelWithCache = event.fromCache ? `${bannerLabel} • Cached` : bannerLabel;
                void activePanel.webview.postMessage({
                    kind: 'reset',
                    sections: sectionsForWebview,
                    bannerLabel: labelWithCache,
                });
                lastBannerStatus = 'hidden';
                syncBannerStatus();
                break;
            }
            case 'chunk': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated += event.text;
                if (state.status === 'queued') {
                    state.status = 'streaming';
                    void activePanel.webview.postMessage({
                        kind: 'sectionStatus',
                        sectionId: event.sectionId,
                        status: 'streaming',
                    });
                    syncBannerStatus();
                }
                const now = Date.now();
                if (now - state.lastRender < RENDER_THROTTLE_MS) return;
                state.lastRender = now;
                const html = renderMarkdownToHtml(fixupLinks(state.accumulated, state.linkUri));
                void activePanel.webview.postMessage({ kind: 'replace', sectionId: event.sectionId, bodyHtml: html });
                break;
            }
            case 'sectionReset': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated = '';
                state.lastRender = 0;
                state.status = 'streaming';
                void activePanel.webview.postMessage({
                    kind: 'replace',
                    sectionId: event.sectionId,
                    bodyHtml: '',
                });
                void activePanel.webview.postMessage({
                    kind: 'sectionStatus',
                    sectionId: event.sectionId,
                    status: 'streaming',
                });
                syncBannerStatus();
                break;
            }
            case 'sectionDone': {
                const state = sectionState.get(event.sectionId);
                if (!state) return;
                state.status = 'complete';
                if (!state.static) {
                    const md = state.accumulated.trim().length > 0
                        ? state.accumulated
                        : '_(no narration produced for this section.)_';
                    const html = renderMarkdownToHtml(fixupLinks(md, state.linkUri));
                    void activePanel.webview.postMessage({
                        kind: 'replace',
                        sectionId: event.sectionId,
                        bodyHtml: html,
                    });
                }
                void activePanel.webview.postMessage({
                    kind: 'sectionStatus',
                    sectionId: event.sectionId,
                    status: 'complete',
                });
                syncBannerStatus();
                break;
            }
            case 'done': {
                for (const [id, state] of sectionState) {
                    if (state.status === 'complete') continue;
                    if (!state.static) {
                        const md = state.accumulated.trim().length > 0
                            ? state.accumulated
                            : '_(no narration produced for this section.)_';
                        const html = renderMarkdownToHtml(fixupLinks(md, state.linkUri));
                        void activePanel.webview.postMessage({ kind: 'replace', sectionId: id, bodyHtml: html });
                    }
                    state.status = 'complete';
                    void activePanel.webview.postMessage({
                        kind: 'sectionStatus',
                        sectionId: id,
                        status: 'complete',
                    });
                }
                syncBannerStatus();
                break;
            }
        }
    };

    try {
        const providerConfig = await readProviderConfig(context);
        const provider = makeProvider(providerConfig);
        const providerInfo = describeProvider(providerConfig);
        const narrateOptions = {
            skipCache: opts.skipCache ?? false,
            cache,
            providerInfo,
        };

        if (target.kind === 'tree') {
            await narrateTreeDiff(target.repoRoot, target.baseRef, provider, token, sink, narrateOptions);
        } else if (target.kind === 'file') {
            const doc = await vscode.workspace.openTextDocument(target.uri);
            await narrateDocument(doc, provider, token, sink, narrateOptions);
        } else {
            const doc = await vscode.workspace.openTextDocument(target.uri);
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

function onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!panel || !currentTarget) return;
    if (currentTarget.kind === 'tree') return;
    if (e.textEditor.document.uri.toString() !== currentTarget.uri.toString()) return;
    if (sectionRanges.length === 0) return;
    const cursorLine = e.selections[0]?.active.line;
    if (cursorLine === undefined) return;
    const match = sectionRanges.find(
        (s) => cursorLine >= s.range.start.line && cursorLine <= s.range.end.line,
    );
    if (!match) return;
    if (selectionDebounce) clearTimeout(selectionDebounce);
    const matchedId = match.id;
    selectionDebounce = setTimeout(() => {
        if (!panel) return;
        void panel.webview.postMessage({ kind: 'highlight', sectionId: matchedId });
    }, SELECTION_DEBOUNCE_MS);
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

interface ModelChoice extends vscode.QuickPickItem {
    pick?: { kind: 'vscodeLm'; family: string } | { kind: 'anthropic'; model: string };
}

async function pickModel(context: vscode.ExtensionContext): Promise<void> {
    const items: ModelChoice[] = [];

    let lmModels: vscode.LanguageModelChat[] = [];
    try {
        lmModels = await vscode.lm.selectChatModels();
    } catch {
        // No LM API available.
    }

    if (lmModels.length > 0) {
        items.push({ label: 'VS Code Language Model', kind: vscode.QuickPickItemKind.Separator });
        for (const m of lmModels) {
            items.push({
                label: `$(rocket) ${m.name}`,
                description: `${m.vendor} • family: ${m.family}`,
                detail: 'VS Code LM API',
                pick: { kind: 'vscodeLm', family: m.family },
            });
        }
    }

    items.push({ label: 'Anthropic API', kind: vscode.QuickPickItemKind.Separator });
    const presets = [
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', desc: 'Fast, high-quality (default)' },
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', desc: 'Best quality, slower & costlier' },
        { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', desc: 'Cheapest, fastest' },
    ];
    for (const p of presets) {
        items.push({
            label: `$(server-environment) ${p.name}`,
            description: p.id,
            detail: p.desc,
            pick: { kind: 'anthropic', model: p.id },
        });
    }

    const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a language model for narration',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    if (!choice?.pick) return;

    const config = vscode.workspace.getConfiguration('codeNarration');
    const target = vscode.ConfigurationTarget.Global;
    if (choice.pick.kind === 'vscodeLm') {
        await config.update('provider', 'vscodeLm', target);
        await config.update('vscodeLm.modelFamily', choice.pick.family, target);
        vscode.window.showInformationMessage(`Code Narration: model set to VS Code LM (${choice.pick.family}).`);
    } else {
        await config.update('provider', 'anthropic', target);
        await config.update('anthropic.model', choice.pick.model, target);
        const key = await context.secrets.get('codeNarration.anthropicApiKey');
        if (!key) {
            const setIt = 'Set API Key';
            const ans = await vscode.window.showWarningMessage(
                `Code Narration: model set to Anthropic ${choice.pick.model}, but no API key is configured.`,
                setIt,
            );
            if (ans === setIt) await setApiKey(context);
        } else {
            vscode.window.showInformationMessage(`Code Narration: model set to Anthropic ${choice.pick.model}.`);
        }
    }
}

async function clearCacheCommand(): Promise<void> {
    if (!cache) return;
    const ans = await vscode.window.showWarningMessage(
        'Clear all cached narrations?',
        { modal: false },
        'Clear',
    );
    if (ans !== 'Clear') return;
    await cache.clearAll();
    vscode.window.showInformationMessage('Code Narration: cache cleared.');
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

