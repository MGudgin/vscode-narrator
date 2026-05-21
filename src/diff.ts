import * as vscode from 'vscode';
import { mapWithConcurrency } from './concurrency';
import { normalizeRoot, relPath } from './paths';

const TREE_DIFF_FETCH_CONCURRENCY = 8;

export type DiffResult =
    | { kind: 'noRepo' }
    | { kind: 'noChanges' }
    | { kind: 'newFile' }
    | { kind: 'modified'; unifiedDiff: string };

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'other';

export interface TreeChange {
    uri: vscode.Uri;
    status: ChangeStatus;
    unifiedDiff: string;
    originalUri?: vscode.Uri;
}

export type TreeDiffResult =
    | { kind: 'noRepo' }
    | { kind: 'noChanges' }
    | { kind: 'modified'; changes: TreeChange[]; combinedDiff: string };

interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    repositories: GitRepository[];
    getRepository(uri: vscode.Uri): GitRepository | null;
}

export interface GitRepository {
    rootUri: vscode.Uri;
    state: GitRepositoryState;
    diffWith(ref: string): Promise<GitChange[]>;
    diffWith(ref: string, path: string): Promise<string>;
    show(ref: string, path: string): Promise<string>;
    log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}

interface GitRepositoryState {
    onDidChange: vscode.Event<void>;
    HEAD: { name?: string; commit?: string } | undefined;
    refs: GitRef[];
}

export interface GitCommit {
    hash: string;
    message: string;
}

export interface GitRef {
    type: number;
    name?: string;
    commit?: string;
}

interface GitChange {
    uri: vscode.Uri;
    originalUri?: vscode.Uri;
    renameUri?: vscode.Uri;
    status: number;
}

// vscode.git Status enum values we care about. Numeric to avoid pulling
// the git extension's d.ts into the build.
const STATUS_INDEX_MODIFIED = 0;
const STATUS_INDEX_ADDED = 1;
const STATUS_INDEX_DELETED = 2;
const STATUS_INDEX_RENAMED = 3;
const STATUS_MODIFIED = 5;
const STATUS_DELETED = 6;
const STATUS_UNTRACKED = 7;

export async function getDiff(uri: vscode.Uri, baseRef: string): Promise<DiffResult> {
    const api = await getGitApi();
    if (!api) throw new Error('The built-in Git extension is not available.');

    const repo = api.getRepository(uri);
    if (!repo) return { kind: 'noRepo' };

    const fsPath = uri.fsPath;

    let baseExists = true;
    try {
        await repo.show(baseRef, fsPath);
    } catch {
        baseExists = false;
    }
    if (!baseExists) return { kind: 'newFile' };

    let unifiedDiff = '';
    try {
        unifiedDiff = await repo.diffWith(baseRef, fsPath);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`git diff failed for "${baseRef}": ${msg}`);
    }

    if (!unifiedDiff || unifiedDiff.trim() === '') return { kind: 'noChanges' };
    return { kind: 'modified', unifiedDiff };
}

export async function getTreeDiff(repoRoot: vscode.Uri, baseRef: string): Promise<TreeDiffResult> {
    const api = await getGitApi();
    if (!api) throw new Error('The built-in Git extension is not available.');

    const repo = pickRepoForRoot(api, repoRoot);
    if (!repo) return { kind: 'noRepo' };

    let rawChanges: GitChange[];
    try {
        rawChanges = await repo.diffWith(baseRef);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`git diff failed for "${baseRef}": ${msg}`);
    }

    if (!rawChanges || rawChanges.length === 0) return { kind: 'noChanges' };

    const { results } = await mapWithConcurrency(rawChanges, TREE_DIFF_FETCH_CONCURRENCY, async (c) => {
        const status = mapStatus(c.status);
        let unifiedDiff = '';
        try {
            unifiedDiff = await repo.diffWith(baseRef, c.uri.fsPath);
        } catch {
            unifiedDiff = '';
        }
        const change: TreeChange = { uri: c.uri, status, unifiedDiff };
        if (status === 'renamed' && c.originalUri) change.originalUri = c.originalUri;
        return change;
    });
    const changes: TreeChange[] = results.filter((c): c is TreeChange => c !== undefined);

    changes.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));

    if (!changes.some((c) => c.unifiedDiff.trim() !== '')) return { kind: 'noChanges' };

    const normalizedRoot = normalizeRoot(repoRoot.fsPath || repoRoot.path);
    const combinedDiff = changes.map((c) => formatCombinedDiffEntry(normalizedRoot, c)).join('\n\n');
    return { kind: 'modified', changes, combinedDiff };
}

function formatCombinedDiffEntry(normalizedRoot: string, change: TreeChange): string {
    const rel = relPath(normalizedRoot, change.uri);
    let header = `--- FILE: ${rel} (${change.status})`;
    if (change.status === 'renamed' && change.originalUri) {
        header += ` from ${relPath(normalizedRoot, change.originalUri)}`;
    }
    header += ' ---';
    return `${header}\n${change.unifiedDiff}`;
}

export async function findRepoRootForUri(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const api = await getGitApi();
    if (!api) return undefined;
    const repo = api.getRepository(uri);
    return repo?.rootUri;
}

export async function getRepositoryForUri(uri: vscode.Uri): Promise<GitRepository | undefined> {
    const api = await getGitApi();
    if (!api) return undefined;
    return api.getRepository(uri) ?? undefined;
}

export async function getRepositoryForRoot(repoRoot: vscode.Uri): Promise<GitRepository | undefined> {
    const api = await getGitApi();
    if (!api) return undefined;
    return pickRepoForRoot(api, repoRoot);
}

export async function listRepoRoots(): Promise<vscode.Uri[]> {
    const api = await getGitApi();
    if (!api) return [];
    return api.repositories.map((r) => r.rootUri);
}

export type RepoStateListener = (repoRoot: vscode.Uri) => void;

export async function watchRepoState(repoRoot: vscode.Uri, listener: RepoStateListener): Promise<vscode.Disposable | undefined> {
    const api = await getGitApi();
    if (!api) return undefined;
    const repo = pickRepoForRoot(api, repoRoot);
    if (!repo) return undefined;
    return repo.state.onDidChange(() => listener(repo.rootUri));
}

export interface RepoStateDecisionArgs {
    /** The repoRoot reported by the state-change event. */
    eventRepoRoot: vscode.Uri;
    /**
     * The currently active narration target, if any. Loosely typed so this
     * pure helper does not pull in `target.ts`; callers pass their concrete
     * `NarrationTarget` and the only fields read are `kind` and (when
     * `kind === 'tree'`) `repoRoot`.
     */
    currentTarget:
        | { kind: 'tree'; repoRoot: vscode.Uri }
        | { kind: string; [key: string]: unknown }
        | undefined;
    /** Whether the watcher has already absorbed its first (priming) event. */
    primed: boolean;
}

export interface RepoStateDecision {
    /** If true, the caller should mark the watcher primed and not refresh. */
    primeNow: boolean;
    /** If true, the caller should schedule a debounced re-narration. */
    refresh: boolean;
}

/**
 * Pure decision logic for `updateRepoWatcher`. Extracted so the
 * priming-vs-refresh policy can be table-driven in unit tests without
 * driving vscode.git's state events.
 */
export function shouldRefreshOnRepoStateEvent(args: RepoStateDecisionArgs): RepoStateDecision {
    if (!args.primed) return { primeNow: true, refresh: false };
    const target = args.currentTarget;
    if (!target || target.kind !== 'tree') return { primeNow: false, refresh: false };
    const treeTarget = target as { kind: 'tree'; repoRoot: vscode.Uri };
    if (treeTarget.repoRoot.toString() !== args.eventRepoRoot.toString()) {
        return { primeNow: false, refresh: false };
    }
    return { primeNow: false, refresh: true };
}

function pickRepoForRoot(api: GitAPI, repoRoot: vscode.Uri): GitRepository | undefined {
    const target = repoRoot.toString();
    return api.repositories.find((r) => r.rootUri.toString() === target)
        ?? api.getRepository(repoRoot)
        ?? undefined;
}

function mapStatus(status: number): ChangeStatus {
    switch (status) {
        case STATUS_INDEX_ADDED:
        case STATUS_UNTRACKED:
            return 'added';
        case STATUS_INDEX_DELETED:
        case STATUS_DELETED:
            return 'deleted';
        case STATUS_INDEX_RENAMED:
            return 'renamed';
        case STATUS_INDEX_MODIFIED:
        case STATUS_MODIFIED:
            return 'modified';
        default:
            return 'other';
    }
}

async function getGitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return undefined;
    const api = ext.isActive ? ext.exports : (await ext.activate());
    return api.getAPI(1);
}
