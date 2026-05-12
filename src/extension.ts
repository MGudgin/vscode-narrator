import * as path from 'path';
import * as vscode from 'vscode';
import {
    readProviderConfig,
    makeProvider,
    describeProvider,
    storeAnthropicKey,
    clearAnthropicKey,
    MissingApiKeyError,
    NarrationProvider,
    ProviderInfo,
} from './llm/index';
import { narrateDocument, narrateDiff, narrateTreeDiff } from './narrate';
import { renderShell, renderError } from './webview';
import { NarrationTarget, targetMatchesSavedDoc, targetTitle, targetBannerLabel, targetShortName } from './target';
import { NarrationCache } from './cache';
import { findRepoRootForUri, listRepoRoots, watchRepoState } from './diff';
import { buildNarrationSink } from './sink';
import { HeadTracker } from './headTracker';

export type ProviderFactory = (
    context: vscode.ExtensionContext,
) => Promise<{ provider: NarrationProvider; info: ProviderInfo }>;

export interface ExtensionApi {
    /**
     * Override how the extension obtains a language model provider. Pass `undefined`
     * to restore the default behavior (read provider from settings). Primarily
     * intended for integration tests that need to swap in a fake provider.
     */
    setProviderFactory(factory: ProviderFactory | undefined): void;
}

const defaultProviderFactory: ProviderFactory = async (context) => {
    const config = await readProviderConfig(context);
    return { provider: makeProvider(config), info: describeProvider(config) };
};

let providerFactory: ProviderFactory = defaultProviderFactory;

let panel: vscode.WebviewPanel | undefined;
let currentTarget: NarrationTarget | undefined;
let inFlight: vscode.CancellationTokenSource | undefined;
let saveDebounce: NodeJS.Timeout | undefined;
let selectionDebounce: NodeJS.Timeout | undefined;
let repoStateDebounce: NodeJS.Timeout | undefined;
let repoWatcher: vscode.Disposable | undefined;
let watchedRepoRoot: string | undefined;
let repoWatcherPrimed = false;
let headDebounce: NodeJS.Timeout | undefined;
let cache: NarrationCache | undefined;
let narrationInProgress = false;
const sectionRanges: { id: string; range: vscode.Range }[] = [];

const SAVE_DEBOUNCE_MS = 500;
const SELECTION_DEBOUNCE_MS = 200;
const REPO_STATE_DEBOUNCE_MS = 750;
const HEAD_DEBOUNCE_MS = 750;

// Minimal subset of the VS Code Git extension API surface we depend on.
interface GitExtensionExports {
    getAPI(version: 1): GitAPI;
}
interface GitAPI {
    readonly repositories: GitRepository[];
    onDidOpenRepository: vscode.Event<GitRepository>;
    onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitRepository {
    readonly rootUri: vscode.Uri;
    readonly state: {
        readonly HEAD: { readonly commit?: string } | undefined;
        readonly onDidChange: vscode.Event<void>;
    };
}

interface RunOptions {
    skipCache?: boolean;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
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
    void subscribeToGitHeadMoves(context);
    return {
        setProviderFactory(factory) {
            providerFactory = factory ?? defaultProviderFactory;
        },
    };
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
    if (headDebounce) clearTimeout(headDebounce);
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

    const sink = buildNarrationSink({
        webview: panel.webview,
        token,
        target,
        bannerLabel,
        sectionRanges,
    });

    narrationInProgress = true;
    try {
        const { provider, info: providerInfo } = await providerFactory(context);
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
    } finally {
        narrationInProgress = false;
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

async function subscribeToGitHeadMoves(context: vscode.ExtensionContext): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!ext) return;
    let exports: GitExtensionExports;
    try {
        exports = ext.isActive ? ext.exports : await ext.activate();
    } catch {
        // Git extension failed to activate — nothing we can do; on-save still works.
        return;
    }
    let api: GitAPI;
    try {
        api = exports.getAPI(1);
    } catch {
        return;
    }

    const tracker = new HeadTracker();
    const repoDisposables = new Map<GitRepository, vscode.Disposable>();

    const watchRepo = (repo: GitRepository): void => {
        // Seed the baseline so the first onDidChange tick doesn't fire spuriously.
        tracker.observe({ repoId: repo.rootUri.toString(), headCommit: repo.state.HEAD?.commit });
        const sub = repo.state.onDidChange(() => onRepoStateChange(context, repo, tracker));
        repoDisposables.set(repo, sub);
    };

    for (const repo of api.repositories) watchRepo(repo);

    context.subscriptions.push(
        api.onDidOpenRepository((repo) => watchRepo(repo)),
        api.onDidCloseRepository((repo) => {
            tracker.forget(repo.rootUri.toString());
            const sub = repoDisposables.get(repo);
            if (sub) {
                sub.dispose();
                repoDisposables.delete(repo);
            }
        }),
        new vscode.Disposable(() => {
            for (const sub of repoDisposables.values()) sub.dispose();
            repoDisposables.clear();
        }),
    );
}

function onRepoStateChange(
    context: vscode.ExtensionContext,
    repo: GitRepository,
    tracker: HeadTracker,
): void {
    const repoId = repo.rootUri.toString();
    const moved = tracker.observe({ repoId, headCommit: repo.state.HEAD?.commit });
    if (!moved) return;
    if (!panel || !currentTarget) return;
    // Tree-diff already has its own watcher in updateRepoWatcher that fires
    // on any repo state change (including HEAD moves) and naturally invalidates
    // via the combined-diff cache key. Widening this gate to include 'tree'
    // would double-fire on commits.
    if (currentTarget.kind !== 'diff') return;
    if (!uriIsInsideRepoRoot(currentTarget.uri, repo.rootUri)) return;

    if (headDebounce) clearTimeout(headDebounce);
    const target = currentTarget;
    headDebounce = setTimeout(() => {
        // Guard against re-entering while a narration is mid-flight. The
        // in-flight narration will be cancelled by runNarration, but we
        // still want to wait for it to settle before kicking off another
        // one to avoid a chain of cancellations on a rapid sequence of
        // commits.
        if (narrationInProgress) {
            headDebounce = setTimeout(() => void runNarration(context, target, { skipCache: true }), HEAD_DEBOUNCE_MS);
            return;
        }
        void runNarration(context, target, { skipCache: true });
    }, HEAD_DEBOUNCE_MS);
}

function uriIsInsideRepoRoot(uri: vscode.Uri, rootUri: vscode.Uri): boolean {
    if (uri.scheme !== rootUri.scheme) return false;
    const rootPath = normalizePath(rootUri.fsPath || rootUri.path);
    const target = normalizePath(uri.fsPath || uri.path);
    if (rootPath === '') return false;
    if (target === rootPath) return true;
    const rootWithSep = rootPath.endsWith('/') ? rootPath : rootPath + '/';
    return target.startsWith(rootWithSep);
}

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

