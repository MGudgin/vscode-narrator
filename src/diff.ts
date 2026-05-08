import * as vscode from 'vscode';

export type DiffResult =
    | { kind: 'noRepo' }
    | { kind: 'noChanges' }
    | { kind: 'newFile' }
    | { kind: 'modified'; unifiedDiff: string };

interface GitExtension {
    getAPI(version: 1): GitAPI;
}

interface GitAPI {
    getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitRepository {
    rootUri: vscode.Uri;
    diffWith(ref: string, path: string): Promise<string>;
    show(ref: string, path: string): Promise<string>;
}

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

async function getGitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return undefined;
    const api = ext.isActive ? ext.exports : (await ext.activate());
    return api.getAPI(1);
}
