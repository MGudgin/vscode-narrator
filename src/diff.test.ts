import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
    getDiff,
    getTreeDiff,
    findRepoRootForUri,
    listRepoRoots,
    watchRepoState,
    shouldRefreshOnRepoStateEvent,
} from './diff';

const vscodeMock = vscode as unknown as {
    __setExtension: (id: string, ext: unknown) => void;
    __resetExtensions: () => void;
};
const __setExtension = vscodeMock.__setExtension;
const __resetExtensions = vscodeMock.__resetExtensions;

beforeEach(() => __resetExtensions());
afterEach(() => __resetExtensions());

// vscode.git Status enum values mirrored from diff.ts.
const STATUS_INDEX_MODIFIED = 0;
const STATUS_INDEX_ADDED = 1;
const STATUS_INDEX_DELETED = 2;
const STATUS_INDEX_RENAMED = 3;
const STATUS_MODIFIED = 5;
const STATUS_DELETED = 6;
const STATUS_UNTRACKED = 7;
const STATUS_UNKNOWN = 99;

interface FakeGitChange {
    uri: vscode.Uri;
    status: number;
    originalUri?: vscode.Uri;
    renameUri?: vscode.Uri;
}

interface FakeRepoOpts {
    rootUri: vscode.Uri;
    headCommit?: string;
    headName?: string;
    changes?: FakeGitChange[];
    fileDiffs?: Map<string, string>;
    fileDiffErrors?: Set<string>;
    showThrows?: boolean;
    diffWithRefThrows?: Error;
}

function makeFakeRepo(opts: FakeRepoOpts) {
    const fileDiffs = opts.fileDiffs ?? new Map<string, string>();
    const fileDiffErrors = opts.fileDiffErrors ?? new Set<string>();
    const listeners = new Set<() => void>();
    return {
        rootUri: opts.rootUri,
        state: {
            HEAD: { commit: opts.headCommit, name: opts.headName },
            onDidChange: (cb: () => void) => {
                listeners.add(cb);
                return { dispose: () => listeners.delete(cb) };
            },
        },
        async diffWith(_ref: string, path?: string) {
            if (path === undefined) {
                if (opts.diffWithRefThrows) throw opts.diffWithRefThrows;
                return opts.changes ?? [];
            }
            if (fileDiffErrors.has(path)) throw new Error(`forced error for ${path}`);
            return fileDiffs.get(path) ?? '';
        },
        async show(_ref: string, _path: string) {
            if (opts.showThrows) throw new Error('not found in base');
            return '';
        },
        fireStateChange(): void {
            for (const cb of listeners) cb();
        },
        setHeadCommit(commit: string | undefined): void {
            this.state.HEAD = { commit, name: opts.headName };
        },
    };
}

type FakeRepo = ReturnType<typeof makeFakeRepo>;

interface InstallExtOpts {
    isActive?: boolean;
    repos?: FakeRepo[];
    repoForUri?: (uri: vscode.Uri) => FakeRepo | null;
}

function installFakeGitExtension(opts: InstallExtOpts = {}): void {
    const api = {
        repositories: opts.repos ?? [],
        getRepository(uri: vscode.Uri) {
            return opts.repoForUri ? opts.repoForUri(uri) : null;
        },
    };
    const realExports = { getAPI: () => api };
    const initiallyActive = opts.isActive ?? true;
    // Match real vscode: exports is undefined until activate() resolves.
    const ext = {
        isActive: initiallyActive,
        exports: (initiallyActive ? realExports : undefined) as typeof realExports,
        activate: async () => {
            ext.isActive = true;
            ext.exports = realExports;
            return realExports;
        },
    };
    __setExtension('vscode.git', ext);
}

describe('getDiff', () => {
    test('throws when the git extension is not installed', async () => {
        const uri = vscode.Uri.parse('file:///foo/a.ts');
        await expect(getDiff(uri as unknown as vscode.Uri, 'HEAD')).rejects.toThrow(/Git extension is not available/);
    });

    test('returns noRepo when the uri is not inside any repository', async () => {
        installFakeGitExtension({ repoForUri: () => null });
        const uri = vscode.Uri.parse('file:///foo/a.ts');
        await expect(getDiff(uri as unknown as vscode.Uri, 'HEAD')).resolves.toEqual({ kind: 'noRepo' });
    });

    test('returns newFile when the base ref does not contain the file', async () => {
        const repo = makeFakeRepo({
            rootUri: vscode.Uri.parse('file:///r') as unknown as vscode.Uri,
            showThrows: true,
        });
        installFakeGitExtension({ repos: [repo], repoForUri: () => repo });
        const uri = vscode.Uri.parse('file:///r/a.ts');
        await expect(getDiff(uri as unknown as vscode.Uri, 'HEAD')).resolves.toEqual({ kind: 'newFile' });
    });

    test('returns noChanges when the file diff is empty', async () => {
        const uri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: vscode.Uri.parse('file:///r') as unknown as vscode.Uri,
            fileDiffs: new Map([[uri.fsPath, '   \n']]),
        });
        installFakeGitExtension({ repos: [repo], repoForUri: () => repo });
        await expect(getDiff(uri, 'HEAD')).resolves.toEqual({ kind: 'noChanges' });
    });

    test('returns modified with the unified diff when the file changed', async () => {
        const uri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const diff = '@@ -1 +1 @@\n-old\n+new\n';
        const repo = makeFakeRepo({
            rootUri: vscode.Uri.parse('file:///r') as unknown as vscode.Uri,
            fileDiffs: new Map([[uri.fsPath, diff]]),
        });
        installFakeGitExtension({ repos: [repo], repoForUri: () => repo });
        await expect(getDiff(uri, 'origin/main')).resolves.toEqual({ kind: 'modified', unifiedDiff: diff });
    });

    test('wraps diffWith failures with the base ref in the error message', async () => {
        const uri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: vscode.Uri.parse('file:///r') as unknown as vscode.Uri,
            fileDiffErrors: new Set([uri.fsPath]),
        });
        installFakeGitExtension({ repos: [repo], repoForUri: () => repo });
        await expect(getDiff(uri, 'origin/main')).rejects.toThrow(/git diff failed for "origin\/main".*forced error/);
    });

    test('activates the git extension when it is not yet active', async () => {
        const uri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: vscode.Uri.parse('file:///r') as unknown as vscode.Uri,
            fileDiffs: new Map([[uri.fsPath, 'diff']]),
        });
        installFakeGitExtension({ isActive: false, repos: [repo], repoForUri: () => repo });
        await expect(getDiff(uri, 'HEAD')).resolves.toEqual({ kind: 'modified', unifiedDiff: 'diff' });
    });
});

describe('getTreeDiff', () => {
    const repoRoot = vscode.Uri.parse('file:///r') as unknown as vscode.Uri;

    test('throws when the git extension is not installed', async () => {
        await expect(getTreeDiff(repoRoot, 'HEAD')).rejects.toThrow(/Git extension is not available/);
    });

    test('returns noRepo when no repository matches the root', async () => {
        installFakeGitExtension({ repos: [], repoForUri: () => null });
        await expect(getTreeDiff(repoRoot, 'HEAD')).resolves.toEqual({ kind: 'noRepo' });
    });

    test('returns noChanges when diffWith returns no entries', async () => {
        const repo = makeFakeRepo({ rootUri: repoRoot, changes: [] });
        installFakeGitExtension({ repos: [repo] });
        await expect(getTreeDiff(repoRoot, 'HEAD')).resolves.toEqual({ kind: 'noChanges' });
    });

    test('returns noChanges when every per-file diff comes back empty', async () => {
        const aUri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            changes: [{ uri: aUri, status: STATUS_MODIFIED }],
            fileDiffs: new Map([[aUri.fsPath, '']]),
        });
        installFakeGitExtension({ repos: [repo] });
        await expect(getTreeDiff(repoRoot, 'HEAD')).resolves.toEqual({ kind: 'noChanges' });
    });

    test('returns modified with sorted changes and combined diff', async () => {
        const bUri = vscode.Uri.parse('file:///r/src/b.ts') as unknown as vscode.Uri;
        const aUri = vscode.Uri.parse('file:///r/src/a.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            changes: [
                { uri: bUri, status: STATUS_MODIFIED },
                { uri: aUri, status: STATUS_INDEX_ADDED },
            ],
            fileDiffs: new Map([[aUri.fsPath, 'A-DIFF'], [bUri.fsPath, 'B-DIFF']]),
        });
        installFakeGitExtension({ repos: [repo] });

        const result = await getTreeDiff(repoRoot, 'origin/main');
        expect(result.kind).toBe('modified');
        if (result.kind !== 'modified') return;
        // Sorted by fsPath: a before b.
        expect(result.changes.map((c) => c.uri.fsPath)).toEqual([aUri.fsPath, bUri.fsPath]);
        expect(result.changes.map((c) => c.status)).toEqual(['added', 'modified']);
        expect(result.combinedDiff).toBe(
            '--- FILE: src/a.ts (added) ---\nA-DIFF\n\n--- FILE: src/b.ts (modified) ---\nB-DIFF',
        );
    });

    test('renamed entries carry originalUri and surface in the combinedDiff header', async () => {
        const newUri = vscode.Uri.parse('file:///r/src/new.ts') as unknown as vscode.Uri;
        const oldUri = vscode.Uri.parse('file:///r/src/old.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            changes: [{ uri: newUri, originalUri: oldUri, status: STATUS_INDEX_RENAMED }],
            fileDiffs: new Map([[newUri.fsPath, 'R-DIFF']]),
        });
        installFakeGitExtension({ repos: [repo] });

        const result = await getTreeDiff(repoRoot, 'origin/main');
        expect(result.kind).toBe('modified');
        if (result.kind !== 'modified') return;
        expect(result.changes[0].originalUri?.toString()).toBe(oldUri.toString());
        expect(result.combinedDiff).toBe('--- FILE: src/new.ts (renamed) from src/old.ts ---\nR-DIFF');
    });

    test('individual per-file diff failures fall back to empty without aborting', async () => {
        const aUri = vscode.Uri.parse('file:///r/a.ts') as unknown as vscode.Uri;
        const bUri = vscode.Uri.parse('file:///r/b.ts') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            changes: [
                { uri: aUri, status: STATUS_MODIFIED },
                { uri: bUri, status: STATUS_MODIFIED },
            ],
            fileDiffs: new Map([[bUri.fsPath, 'B-DIFF']]),
            fileDiffErrors: new Set([aUri.fsPath]),
        });
        installFakeGitExtension({ repos: [repo] });

        const result = await getTreeDiff(repoRoot, 'HEAD');
        expect(result.kind).toBe('modified');
        if (result.kind !== 'modified') return;
        const aChange = result.changes.find((c) => c.uri.fsPath === aUri.fsPath);
        expect(aChange?.unifiedDiff).toBe('');
        expect(result.combinedDiff).toContain('B-DIFF');
    });

    test('wraps top-level diffWith failures with the base ref in the error message', async () => {
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            diffWithRefThrows: new Error('boom'),
        });
        installFakeGitExtension({ repos: [repo] });
        await expect(getTreeDiff(repoRoot, 'origin/main')).rejects.toThrow(/git diff failed for "origin\/main".*boom/);
    });

    test('maps each git status to the corresponding ChangeStatus', async () => {
        const cases: Array<{ status: number; expected: 'added' | 'modified' | 'deleted' | 'renamed' | 'other' }> = [
            { status: STATUS_INDEX_MODIFIED, expected: 'modified' },
            { status: STATUS_INDEX_ADDED, expected: 'added' },
            { status: STATUS_INDEX_DELETED, expected: 'deleted' },
            { status: STATUS_INDEX_RENAMED, expected: 'renamed' },
            { status: STATUS_MODIFIED, expected: 'modified' },
            { status: STATUS_DELETED, expected: 'deleted' },
            { status: STATUS_UNTRACKED, expected: 'added' },
            { status: STATUS_UNKNOWN, expected: 'other' },
        ];

        const changes: FakeGitChange[] = cases.map((c, i) => ({
            uri: vscode.Uri.parse(`file:///r/f${i.toString().padStart(2, '0')}.ts`) as unknown as vscode.Uri,
            status: c.status,
        }));
        const fileDiffs = new Map<string, string>();
        for (const c of changes) fileDiffs.set(c.uri.fsPath, `D-${c.status}`);

        const repo = makeFakeRepo({ rootUri: repoRoot, changes, fileDiffs });
        installFakeGitExtension({ repos: [repo] });

        const result = await getTreeDiff(repoRoot, 'HEAD');
        expect(result.kind).toBe('modified');
        if (result.kind !== 'modified') return;
        for (const c of cases) {
            const change = result.changes.find((ch) => ch.unifiedDiff === `D-${c.status}`);
            expect(change?.status).toBe(c.expected);
        }
    });

    test('falls back to api.getRepository(repoRoot) when no repositories entry matches', async () => {
        const otherRoot = vscode.Uri.parse('file:///other') as unknown as vscode.Uri;
        const repo = makeFakeRepo({
            rootUri: repoRoot,
            changes: [{
                uri: vscode.Uri.parse('file:///r/x.ts') as unknown as vscode.Uri,
                status: STATUS_MODIFIED,
            }],
            fileDiffs: new Map([['/r/x.ts', 'X-DIFF']]),
        });
        // repositories list points elsewhere; getRepository fallback finds the right one.
        installFakeGitExtension({
            repos: [makeFakeRepo({ rootUri: otherRoot })],
            repoForUri: (uri) => uri.toString() === repoRoot.toString() ? repo : null,
        });
        const result = await getTreeDiff(repoRoot, 'HEAD');
        expect(result.kind).toBe('modified');
    });
});

describe('findRepoRootForUri', () => {
    test('returns undefined when no git extension is installed', async () => {
        const uri = vscode.Uri.parse('file:///r/a.ts');
        await expect(findRepoRootForUri(uri as unknown as vscode.Uri)).resolves.toBeUndefined();
    });

    test('returns undefined when the uri is not in any repository', async () => {
        installFakeGitExtension({ repoForUri: () => null });
        const uri = vscode.Uri.parse('file:///r/a.ts');
        await expect(findRepoRootForUri(uri as unknown as vscode.Uri)).resolves.toBeUndefined();
    });

    test('returns the repository rootUri when one is found', async () => {
        const rootUri = vscode.Uri.parse('file:///r') as unknown as vscode.Uri;
        const repo = makeFakeRepo({ rootUri });
        installFakeGitExtension({ repos: [repo], repoForUri: () => repo });
        const uri = vscode.Uri.parse('file:///r/a.ts');
        const result = await findRepoRootForUri(uri as unknown as vscode.Uri);
        expect(result?.toString()).toBe(rootUri.toString());
    });
});

describe('listRepoRoots', () => {
    test('returns an empty list when no git extension is installed', async () => {
        await expect(listRepoRoots()).resolves.toEqual([]);
    });

    test('returns an empty list when there are no repositories', async () => {
        installFakeGitExtension({ repos: [] });
        await expect(listRepoRoots()).resolves.toEqual([]);
    });

    test('returns rootUris for every repository in api.repositories order', async () => {
        const r1 = vscode.Uri.parse('file:///r1') as unknown as vscode.Uri;
        const r2 = vscode.Uri.parse('file:///r2') as unknown as vscode.Uri;
        installFakeGitExtension({
            repos: [makeFakeRepo({ rootUri: r1 }), makeFakeRepo({ rootUri: r2 })],
        });
        const result = await listRepoRoots();
        expect(result.map((u) => u.toString())).toEqual([r1.toString(), r2.toString()]);
    });
});

describe('watchRepoState', () => {
    const repoRoot = vscode.Uri.parse('file:///r') as unknown as vscode.Uri;

    test('returns undefined when no git extension is installed', async () => {
        const listener = vi.fn();
        await expect(watchRepoState(repoRoot, listener)).resolves.toBeUndefined();
        expect(listener).not.toHaveBeenCalled();
    });

    test('returns undefined when no repository matches the root', async () => {
        installFakeGitExtension({ repos: [], repoForUri: () => null });
        const listener = vi.fn();
        await expect(watchRepoState(repoRoot, listener)).resolves.toBeUndefined();
        expect(listener).not.toHaveBeenCalled();
    });

    test('forwards every state change with the repository rootUri', async () => {
        const repo = makeFakeRepo({ rootUri: repoRoot });
        installFakeGitExtension({ repos: [repo] });

        const listener = vi.fn();
        const disposable = await watchRepoState(repoRoot, listener);
        expect(disposable).toBeDefined();

        repo.fireStateChange();
        repo.fireStateChange();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(listener.mock.calls[0][0].toString()).toBe(repoRoot.toString());
        expect(listener.mock.calls[1][0].toString()).toBe(repoRoot.toString());

        disposable?.dispose();
        repo.fireStateChange();
        // No additional calls after disposal.
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe('shouldRefreshOnRepoStateEvent', () => {
    const repoA = vscode.Uri.parse('file:///repo-a') as unknown as vscode.Uri;
    const repoB = vscode.Uri.parse('file:///repo-b') as unknown as vscode.Uri;
    const fileUri = vscode.Uri.parse('file:///repo-a/src/x.ts') as unknown as vscode.Uri;

    test('the first event primes the watcher and does not refresh', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: { kind: 'tree', repoRoot: repoA },
                primed: false,
            }),
        ).toEqual({ primeNow: true, refresh: false });
    });

    test('primes regardless of the current target shape', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: undefined,
                primed: false,
            }),
        ).toEqual({ primeNow: true, refresh: false });

        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: { kind: 'file', uri: fileUri },
                primed: false,
            }),
        ).toEqual({ primeNow: true, refresh: false });
    });

    test('after priming, no current target means no refresh', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: undefined,
                primed: true,
            }),
        ).toEqual({ primeNow: false, refresh: false });
    });

    test('after priming, non-tree targets are ignored', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: { kind: 'file', uri: fileUri },
                primed: true,
            }),
        ).toEqual({ primeNow: false, refresh: false });

        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: { kind: 'diff', uri: fileUri, baseRef: 'HEAD' },
                primed: true,
            }),
        ).toEqual({ primeNow: false, refresh: false });
    });

    test('after priming, tree target for a different repo is ignored', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoB,
                currentTarget: { kind: 'tree', repoRoot: repoA },
                primed: true,
            }),
        ).toEqual({ primeNow: false, refresh: false });
    });

    test('after priming, tree target for the same repo refreshes', () => {
        expect(
            shouldRefreshOnRepoStateEvent({
                eventRepoRoot: repoA,
                currentTarget: { kind: 'tree', repoRoot: repoA },
                primed: true,
            }),
        ).toEqual({ primeNow: false, refresh: true });
    });

    test('table-driven coverage of (primed x target.kind x root-match)', () => {
        type Row = {
            primed: boolean;
            target:
                | { kind: 'tree'; repoRoot: vscode.Uri }
                | { kind: string; [key: string]: unknown }
                | undefined;
            eventRoot: vscode.Uri;
            primeNow: boolean;
            refresh: boolean;
        };
        const rows: Row[] = [
            { primed: false, target: undefined, eventRoot: repoA, primeNow: true, refresh: false },
            { primed: false, target: { kind: 'tree', repoRoot: repoA }, eventRoot: repoA, primeNow: true, refresh: false },
            { primed: false, target: { kind: 'file' }, eventRoot: repoA, primeNow: true, refresh: false },
            { primed: true, target: undefined, eventRoot: repoA, primeNow: false, refresh: false },
            { primed: true, target: { kind: 'file' }, eventRoot: repoA, primeNow: false, refresh: false },
            { primed: true, target: { kind: 'diff' }, eventRoot: repoA, primeNow: false, refresh: false },
            { primed: true, target: { kind: 'tree', repoRoot: repoA }, eventRoot: repoB, primeNow: false, refresh: false },
            { primed: true, target: { kind: 'tree', repoRoot: repoB }, eventRoot: repoA, primeNow: false, refresh: false },
            { primed: true, target: { kind: 'tree', repoRoot: repoA }, eventRoot: repoA, primeNow: false, refresh: true },
        ];
        for (const r of rows) {
            expect(
                shouldRefreshOnRepoStateEvent({
                    eventRepoRoot: r.eventRoot,
                    currentTarget: r.target,
                    primed: r.primed,
                }),
            ).toEqual({ primeNow: r.primeNow, refresh: r.refresh });
        }
    });
});
