import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';

const exec = util.promisify(cp.exec);

export interface GitFixture {
    /** Absolute filesystem path of the temp repo. */
    readonly dir: string;
    /** Working-tree root URI. */
    readonly rootUri: vscode.Uri;
    /** Convert a repo-relative path to a vscode.Uri. */
    fileUri(relPath: string): vscode.Uri;
    /** Run `git` with the given args inside the fixture; rejects on non-zero exit. */
    git(...args: string[]): Promise<{ stdout: string; stderr: string }>;
    /** Write a file inside the repo, creating parent directories as needed. */
    write(relPath: string, content: string): void;
    /** Best-effort recursive delete of the fixture dir. */
    cleanup(): Promise<void>;
}

/**
 * Create a fresh git repo in an OS temp dir, with user.name/email configured
 * and gpg signing disabled so commits don't prompt. Caller is responsible
 * for `cleanup()` (typically in a finally block).
 */
export async function createGitFixture(): Promise<GitFixture> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-git-'));

    const git = async (...args: string[]) => {
        const quoted = args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
        return exec(`git ${quoted}`, { cwd: dir });
    };

    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Integration Test');
    await git('config', 'commit.gpgsign', 'false');

    return {
        dir,
        rootUri: vscode.Uri.file(dir),
        fileUri(relPath) {
            return vscode.Uri.file(path.join(dir, relPath));
        },
        git,
        write(relPath, content) {
            const full = path.join(dir, relPath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        },
        async cleanup() {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Windows occasionally holds handles after VS Code has touched
                // a file in the repo. Best-effort.
            }
        },
    };
}

/**
 * Tell the vscode.git extension to start tracking `repoRoot`, then poll
 * `getRepository(<file inside repo>)` until it returns non-null. We need
 * this because @vscode/test-electron launches without a workspace folder,
 * so the git extension's automatic discovery has nothing to scan.
 */
export async function openRepoInVscode(repoRoot: vscode.Uri, timeoutMs = 10_000): Promise<void> {
    await vscode.commands.executeCommand('git.openRepository', repoRoot.fsPath);

    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext) throw new Error('vscode.git extension not available in the test host.');
    const gitExtExports = ext.isActive ? ext.exports : await ext.activate();
    const api = gitExtExports.getAPI(1);

    const probeUri = vscode.Uri.file(path.join(repoRoot.fsPath, '.git'));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (api.getRepository(probeUri) || api.getRepository(repoRoot)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`vscode.git did not discover repo at ${repoRoot.fsPath} within ${timeoutMs}ms.`);
}

interface VscodeGitRepo {
    status(): Promise<void>;
    state: { HEAD: { commit?: string } | undefined };
}

/**
 * Look up the vscode.git Repository object for a fixture's root and return it.
 * Used by tests that need to call .status() to force vscode.git to re-read
 * external-git state changes (its filesystem watcher is too slow for tests).
 */
export function getVscodeGitRepo(repoRoot: vscode.Uri): VscodeGitRepo {
    const ext = vscode.extensions.getExtension('vscode.git');
    if (!ext || !ext.isActive) throw new Error('vscode.git not active.');
    const api = ext.exports.getAPI(1);
    const repo = api.getRepository(repoRoot) ?? api.getRepository(vscode.Uri.file(path.join(repoRoot.fsPath, '.git')));
    if (!repo) throw new Error(`vscode.git has no repository for ${repoRoot.fsPath}`);
    return repo as VscodeGitRepo;
}
