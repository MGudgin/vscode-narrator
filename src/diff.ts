import * as vscode from 'vscode';

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

interface GitRepository {
    rootUri: vscode.Uri;
    state: GitRepositoryState;
    diffWith(ref: string): Promise<GitChange[]>;
    diffWith(ref: string, path: string): Promise<string>;
    show(ref: string, path: string): Promise<string>;
}

interface GitRepositoryState {
    onDidChange: vscode.Event<void>;
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

    const changes: TreeChange[] = [];
    for (const c of rawChanges) {
        const status = mapStatus(c.status);
        let unifiedDiff = '';
        try {
            unifiedDiff = await repo.diffWith(baseRef, c.uri.fsPath);
        } catch {
            unifiedDiff = '';
        }
        const change: TreeChange = { uri: c.uri, status, unifiedDiff };
        if (status === 'renamed' && c.originalUri) change.originalUri = c.originalUri;
        changes.push(change);
    }

    changes.sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));

    if (!changes.some((c) => c.unifiedDiff.trim() !== '')) return { kind: 'noChanges' };

    const combinedDiff = changes.map((c) => formatCombinedDiffEntry(repoRoot, c)).join('\n\n');
    return { kind: 'modified', changes, combinedDiff };
}

function formatCombinedDiffEntry(repoRoot: vscode.Uri, change: TreeChange): string {
    const path = relPath(repoRoot, change.uri);
    let header = `--- FILE: ${path} (${change.status})`;
    if (change.status === 'renamed' && change.originalUri) {
        header += ` from ${relPath(repoRoot, change.originalUri)}`;
    }
    header += ' ---';
    return `${header}\n${change.unifiedDiff}`;
}

function relPath(root: vscode.Uri, file: vscode.Uri): string {
    const rootPath = (root.fsPath || root.path).replace(/\\/g, '/').replace(/\/$/, '');
    const filePath = (file.fsPath || file.path).replace(/\\/g, '/');
    if (rootPath && filePath.toLowerCase().startsWith(rootPath.toLowerCase() + '/')) {
        return filePath.slice(rootPath.length + 1);
    }
    return filePath;
}

export async function findRepoRootForUri(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const api = await getGitApi();
    if (!api) return undefined;
    const repo = api.getRepository(uri);
    return repo?.rootUri;
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
