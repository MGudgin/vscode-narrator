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
import { narrateDocument, narrateDiff, narrateTreeDiff, readNarrationConfigSnapshot } from './narrate';
import { renderShell, renderError, SpeechConfig } from './webview';
import { NarrationTarget, targetMatchesSavedDoc, targetTitle, targetBannerLabel, targetShortName, isAllowedRevealUri, shouldFollowEditor } from './target';
import { NarrationCache } from './cache';
import { findRepoRootForUri, listRepoRoots, watchRepoState, shouldRefreshOnRepoStateEvent } from './diff';
import { buildNarrationSink } from './sink';

export type ProviderFactory = (
    context: vscode.ExtensionContext,
) => Promise<{ provider: NarrationProvider; info: ProviderInfo }>;

export type WebviewMessageTap = (message: unknown) => void;

export type QuickPickResolver = <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: vscode.QuickPickOptions | undefined,
) => Promise<T | undefined>;

export interface ExtensionApi {
    /**
     * Override how the extension obtains a language model provider. Pass `undefined`
     * to restore the default behavior (read provider from settings). Primarily
     * intended for integration tests that need to swap in a fake provider.
     */
    setProviderFactory(factory: ProviderFactory | undefined): void;
    /**
     * Register a callback invoked for every `webview.postMessage` payload the
     * extension emits. Pass `undefined` to clear. No-op in production (off by
     * default). Primarily intended for integration tests that need to observe
     * extension-to-webview traffic without driving a real webview.
     */
    tapWebviewMessages(tap: WebviewMessageTap | undefined): void;
    /**
     * Override how the extension resolves its internal quick-picks (currently
     * just the multi-repo picker in `openTreeDiff`). Pass `undefined` to
     * restore the default behavior of calling `vscode.window.showQuickPick`.
     * Primarily intended for integration tests that need a deterministic
     * picker without driving the real UI.
     */
    setQuickPickResolver(resolver: QuickPickResolver | undefined): void;
}

const defaultProviderFactory: ProviderFactory = async (context) => {
    const config = await readProviderConfig(context);
    return { provider: makeProvider(config), info: describeProvider(config) };
};

let providerFactory: ProviderFactory = defaultProviderFactory;
let webviewMessageTap: WebviewMessageTap | undefined;
let quickPickResolver: QuickPickResolver | undefined;

let panel: vscode.WebviewPanel | undefined;
let currentTarget: NarrationTarget | undefined;
let inFlight: vscode.CancellationTokenSource | undefined;
let saveDebounce: NodeJS.Timeout | undefined;
let selectionDebounce: NodeJS.Timeout | undefined;
let repoStateDebounce: NodeJS.Timeout | undefined;
let activeEditorDebounce: NodeJS.Timeout | undefined;
let repoWatcher: vscode.Disposable | undefined;
let watchedRepoRoot: string | undefined;
let repoWatcherPrimed = false;
let cache: NarrationCache | undefined;
const sectionRanges: { id: string; range: vscode.Range }[] = [];

const SAVE_DEBOUNCE_MS = 500;
const SELECTION_DEBOUNCE_MS = 200;
const REPO_STATE_DEBOUNCE_MS = 750;
const ACTIVE_EDITOR_DEBOUNCE_MS = 250;

let cachedNarrateOnSave: boolean | undefined;

function readNarrateOnSave(): boolean {
    if (cachedNarrateOnSave === undefined) {
        cachedNarrateOnSave = vscode.workspace
            .getConfiguration('codeNarration')
            .get<boolean>('narrateOnSave', true);
    }
    return cachedNarrateOnSave;
}

function refreshNarrateOnSaveCache(): void {
    cachedNarrateOnSave = vscode.workspace
        .getConfiguration('codeNarration')
        .get<boolean>('narrateOnSave', true);
}

interface RunOptions {
    skipCache?: boolean;
}

/**
 * Pure helper used by every narration command to enforce the
 * untrustedWorkspaces capability promise in package.json:
 *
 *     "In an untrusted workspace, narration commands stay disabled because
 *      the file's contents (and, in tree mode, every changed file in the
 *      repo) are forwarded to a third-party language model."
 *
 * VS Code's `"supported": "limited"` mode only routes `restrictedConfigurations`
 * back to user-scope values — it does NOT block command invocation. So the
 * gate must be enforced in code: every narration command short-circuits with
 * a user-facing warning when `workspace.isTrusted` is false. Settings,
 * cache, voice, and reveal commands are NOT gated — they don't send file
 * contents anywhere.
 *
 * Returns `true` when the workspace is trusted and the command should run.
 * Returns `false` after surfacing a warning when the workspace is untrusted.
 *
 * Exported as a pure helper so the gate logic is unit-testable without
 * spinning up a real VS Code workspace.
 */
export function ensureWorkspaceTrustedForNarration(
    isTrusted: boolean,
    commandLabel: string,
    showWarning: (message: string) => void,
): boolean {
    if (isTrusted) return true;
    showWarning(
        `${commandLabel}: narration is disabled in untrusted workspaces because it would forward file contents to a third-party language model. Trust the workspace to enable narration.`,
    );
    return false;
}

function isNarrationAllowed(commandLabel: string): boolean {
    return ensureWorkspaceTrustedForNarration(
        vscode.workspace.isTrusted,
        commandLabel,
        (msg) => { vscode.window.showWarningMessage(msg); },
    );
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
        vscode.commands.registerCommand('codeNarration.speak', () => speechControl('play')),
        vscode.commands.registerCommand('codeNarration.stopSpeech', () => speechControl('stop')),
        vscode.commands.registerCommand('codeNarration.pickVoice', () => pickVoice()),
        vscode.workspace.onDidSaveTextDocument((doc) => onSave(context, doc)),
        vscode.window.onDidChangeTextEditorSelection(onSelectionChange),
        vscode.window.onDidChangeActiveTextEditor((editor) => onActiveEditorChange(context, editor)),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('codeNarration.speech')) onSpeechConfigChange();
            if (e.affectsConfiguration('codeNarration.narrateOnSave')) refreshNarrateOnSaveCache();
        }),
    );
    return {
        setProviderFactory(factory) {
            providerFactory = factory ?? defaultProviderFactory;
        },
        tapWebviewMessages(tap) {
            webviewMessageTap = tap;
        },
        setQuickPickResolver(resolver) {
            quickPickResolver = resolver;
        },
    };
}

function notifyWebviewTap(message: unknown): void {
    if (!webviewMessageTap) return;
    try {
        webviewMessageTap(message);
    } catch {
        // Tap is a test-only seam; swallow throws so a misbehaving tap can't
        // break production message flow.
    }
}

function postToWebview(webview: vscode.Webview, message: unknown): void {
    notifyWebviewTap(message);
    void webview.postMessage(message);
}

function readSpeechConfig(): SpeechConfig {
    const cfg = vscode.workspace.getConfiguration('codeNarration.speech');
    return {
        enabled: cfg.get<boolean>('enabled', false),
        autoPlay: cfg.get<boolean>('autoPlay', false),
        voice: cfg.get<string>('voice', ''),
        rate: cfg.get<number>('rate', 1.0),
        pitch: cfg.get<number>('pitch', 1.0),
    };
}

function speechControl(command: 'play' | 'pause' | 'stop'): void {
    if (!panel) {
        vscode.window.showInformationMessage('Open a narration first.');
        return;
    }
    const speech = readSpeechConfig();
    if (!speech.enabled) {
        vscode.window.showWarningMessage(
            'Speech is disabled. Enable codeNarration.speech.enabled to use spoken narration.',
        );
        return;
    }
    postToWebview(panel.webview, { kind: 'speechControl', command });
}

function onSpeechConfigChange(): void {
    if (!panel) return;
    const speech = readSpeechConfig();
    postToWebview(panel.webview, { kind: 'speechConfig', ...speech });
}

async function pickVoice(): Promise<void> {
    // The list of voices lives in the webview. Ask the user to type a name —
    // an extension cannot enumerate Web Speech voices from the host side.
    const cfg = vscode.workspace.getConfiguration('codeNarration.speech');
    const current = cfg.get<string>('voice', '');
    const value = await vscode.window.showInputBox({
        title: 'Code Narration: Voice name',
        prompt: 'Type a voice name as shown in the narration pane voice picker (leave empty for default).',
        value: current,
        ignoreFocusOut: true,
    });
    if (value === undefined) return;
    await cfg.update('voice', value, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
        value ? `Code Narration: voice set to ${value}.` : 'Code Narration: voice cleared (using system default).',
    );
}

export function deactivate(): void {
    inFlight?.cancel();
    inFlight?.dispose();
    panel?.dispose();
    if (saveDebounce) clearTimeout(saveDebounce);
    if (selectionDebounce) clearTimeout(selectionDebounce);
    if (repoStateDebounce) clearTimeout(repoStateDebounce);
    if (activeEditorDebounce) clearTimeout(activeEditorDebounce);
    repoWatcher?.dispose();
    repoWatcher = undefined;
    watchedRepoRoot = undefined;
    repoWatcherPrimed = false;
    cachedNarrateOnSave = undefined;
}

async function openFileNarration(context: vscode.ExtensionContext): Promise<void> {
    if (!isNarrationAllowed('Open Narration')) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file to narrate.');
        return;
    }
    ensurePanel(context);
    await runNarration(context, { kind: 'file', uri: editor.document.uri });
}

async function openDiffNarration(context: vscode.ExtensionContext): Promise<void> {
    if (!isNarrationAllowed('Open Diff Narration')) return;
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
    if (!isNarrationAllowed('Open Tree Diff Narration')) return;
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
    const options: vscode.QuickPickOptions = {
        placeHolder: 'Select a git repository to narrate',
        matchOnDescription: true,
    };
    const picked = quickPickResolver
        ? await quickPickResolver(items, options)
        : await vscode.window.showQuickPick(items, options);
    return picked?.uri;
}

async function refreshNarration(context: vscode.ExtensionContext): Promise<void> {
    if (!isNarrationAllowed('Refresh Narration')) return;
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
            // Allowlist of command URIs the webview is permitted to invoke.
            // Narration output is LLM-generated and partly attacker-influenced
            // (via indirect prompt injection in the source being narrated), so
            // `command:` URIs are restricted to the single reveal handler the
            // extension actually emits. Paired with the link allowlist in
            // `isAllowedLinkUrl` and the URI validation in `revealLocation`.
            enableCommandUris: ['codeNarration.reveal', 'codeNarration.refresh'],
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
    panel.webview.onDidReceiveMessage(onWebviewMessage, null, context.subscriptions);
}

interface WebviewMessage {
    kind?: string;
    voice?: unknown;
    rate?: unknown;
    url?: unknown;
}

async function onWebviewMessage(msg: WebviewMessage): Promise<void> {
    if (!msg || typeof msg.kind !== 'string') return;
    const cfg = vscode.workspace.getConfiguration('codeNarration.speech');
    if (msg.kind === 'voiceChanged' && typeof msg.voice === 'string') {
        await cfg.update('voice', msg.voice, vscode.ConfigurationTarget.Global);
    } else if (msg.kind === 'rateChanged' && typeof msg.rate === 'number' && Number.isFinite(msg.rate)) {
        await cfg.update('rate', msg.rate, vscode.ConfigurationTarget.Global);
    } else if (msg.kind === 'openExternal' && typeof msg.url === 'string') {
        await confirmAndOpenExternalLink(msg.url);
    }
}

async function confirmAndOpenExternalLink(url: string): Promise<void> {
    // Narration is LLM-generated and partly attacker-influenced, so the
    // link's visible text can be anything ("Read more", "Click here") while
    // the href points at an exfil URL. Show the full URL in the modal so
    // the user can see what they're about to navigate to. See #94.
    if (!/^https?:/i.test(url) && !/^mailto:/i.test(url)) {
        // Unexpected scheme — webview should never post this, but ignore
        // defensively rather than blindly opening.
        return;
    }
    const choice = await vscode.window.showWarningMessage(
        `Open external link?\n\n${url}`,
        { modal: true },
        'Open',
    );
    if (choice !== 'Open') return;
    try {
        const parsed = vscode.Uri.parse(url, true);
        await vscode.env.openExternal(parsed);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Code Narration: could not open link — ${message}`);
    }
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
        const decision = shouldRefreshOnRepoStateEvent({
            eventRepoRoot: repoRoot,
            currentTarget,
            primed: repoWatcherPrimed,
        });
        if (decision.primeNow) {
            repoWatcherPrimed = true;
            return;
        }
        if (!decision.refresh || !currentTarget) return;
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
    // Defence in depth: every entry point already gates on workspace trust,
    // but auto-narrations triggered by save / selection / active-editor /
    // repo-state events route through here without re-passing the command
    // entry. Bail silently here so a workspace that becomes untrusted mid-
    // session cannot leak subsequent file contents to the LLM.
    if (!vscode.workspace.isTrusted) return;

    inFlight?.cancel();
    inFlight?.dispose();
    inFlight = new vscode.CancellationTokenSource();
    const token = inFlight.token;

    currentTarget = target;
    sectionRanges.length = 0;
    const bannerLabel = targetBannerLabel(target);
    const speechConfig = readSpeechConfig();
    panel.title = targetTitle(target);
    panel.webview.html = renderShell(panel.webview, targetShortName(target), bannerLabel, speechConfig);
    panel.reveal(panel.viewColumn, true);

    void updateRepoWatcher(context, target);

    const sinkWebview = panel.webview;
    const sink = buildNarrationSink({
        webview: {
            postMessage(message) {
                notifyWebviewTap(message);
                return sinkWebview.postMessage(message);
            },
        },
        token,
        target,
        bannerLabel,
        sectionRanges,
    });

    try {
        const { provider, info: providerInfo } = await providerFactory(context);
        const narrateOptions = {
            skipCache: opts.skipCache ?? false,
            cache,
            providerInfo,
            configSnapshot: readNarrationConfigSnapshot(),
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
                speechConfig,
            );
            const choice = await vscode.window.showErrorMessage(err.message, 'Set API Key');
            if (choice === 'Set API Key') {
                await setApiKey(context);
                void runNarration(context, target);
            }
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderError(panel.webview, message, undefined, bannerLabel, speechConfig);
    }
}

function onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!panel || !currentTarget) return;
    if (currentTarget.kind === 'tree') return;
    if (e.textEditor.document.uri.toString() !== currentTarget.uri.toString()) return;
    if (sectionRanges.length === 0) return;
    const cursorLine = e.selections[0]?.active.line;
    if (cursorLine === undefined) return;
    const match = findSectionForLine(sectionRanges, cursorLine);
    if (!match) return;
    if (selectionDebounce) clearTimeout(selectionDebounce);
    const matchedId = match.id;
    selectionDebounce = setTimeout(() => {
        if (!panel) return;
        postToWebview(panel.webview, { kind: 'highlight', sectionId: matchedId });
    }, SELECTION_DEBOUNCE_MS);
}

export interface SectionRangeLike {
    id: string;
    range: { start: { line: number }; end: { line: number } };
}

/**
 * Find the narration section that contains `cursorLine`, given a list of
 * sections pre-sorted by `range.start.line` ascending. Returns `undefined`
 * when no section's `[start.line, end.line]` interval covers the cursor.
 *
 * Binary-searches for the rightmost section whose `start.line <= cursorLine`,
 * then verifies `end.line >= cursorLine`. With overlapping ranges this picks
 * the section with the largest `start.line` that still encloses the cursor,
 * which is the deterministic match.
 */
export function findSectionForLine<T extends SectionRangeLike>(
    sections: readonly T[],
    cursorLine: number,
): T | undefined {
    if (sections.length === 0) return undefined;
    let lo = 0;
    let hi = sections.length - 1;
    let best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (sections[mid].range.start.line <= cursorLine) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best < 0) return undefined;
    const candidate = sections[best];
    return candidate.range.end.line >= cursorLine ? candidate : undefined;
}

function onSave(context: vscode.ExtensionContext, doc: vscode.TextDocument): void {
    if (!panel || !currentTarget) return;
    if (!targetMatchesSavedDoc(currentTarget, doc.uri)) return;
    if (!readNarrateOnSave()) return;
    if (saveDebounce) clearTimeout(saveDebounce);
    const target = currentTarget;
    saveDebounce = setTimeout(() => void runNarration(context, target), SAVE_DEBOUNCE_MS);
}

function onActiveEditorChange(
    context: vscode.ExtensionContext,
    editor: vscode.TextEditor | undefined,
): void {
    if (!panel) return;
    const followEnabled = vscode.workspace
        .getConfiguration('codeNarration')
        .get<boolean>('followActiveEditor', false);
    const doc = editor?.document;
    const allow = shouldFollowEditor({
        newDocUri: doc?.uri,
        newDocScheme: doc?.uri.scheme,
        currentTarget,
        followEnabled,
    });
    if (!allow) return;
    if (activeEditorDebounce) clearTimeout(activeEditorDebounce);
    const newUri = doc!.uri;
    activeEditorDebounce = setTimeout(
        () => void runNarration(context, { kind: 'file', uri: newUri }),
        ACTIVE_EDITOR_DEBOUNCE_MS,
    );
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

export interface RangeLike {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

export function isValidRange(r: unknown): r is RangeLike {
    if (!r || typeof r !== 'object') return false;
    const x = r as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } };
    return Number.isFinite(x.start?.line)
        && Number.isFinite(x.start?.character)
        && Number.isFinite(x.end?.line)
        && Number.isFinite(x.end?.character);
}

async function revealLocation(
    uriStr: unknown,
    rangeLike: unknown,
): Promise<void> {
    if (typeof uriStr !== 'string') return;
    let uri: vscode.Uri;
    try {
        uri = vscode.Uri.parse(uriStr, true);
    } catch {
        return;
    }
    // Reveal links are only safe to honour when they point at the document
    // the narration is currently about. A hand-crafted reveal payload could
    // otherwise open arbitrary files via Uri.parse.
    if (!isAllowedRevealUri(uri, currentTarget)) {
        console.warn(
            `codeNarration: refused to reveal ${uri.toString()} — not under the active narration target.`,
        );
        return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const selection = isValidRange(rangeLike)
        ? new vscode.Range(
            rangeLike.start.line,
            rangeLike.start.character,
            rangeLike.end.line,
            rangeLike.end.character,
        )
        : new vscode.Range(0, 0, 0, 0);
    await vscode.window.showTextDocument(doc, {
        selection,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
    });
}

