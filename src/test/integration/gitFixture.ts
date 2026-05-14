import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import * as vscode from 'vscode';

const execFile = util.promisify(cp.execFile);

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

    // execFile launches git directly (no shell), so args containing spaces,
    // quotes, or shell metacharacters (`$`, backtick, `!`, …) are passed
    // verbatim. The previous `exec` + JSON.stringify quoting was safe for the
    // current call sites but a footgun for future fixtures that might carry
    // user-derived paths.
    const git = (...args: string[]) => execFile('git', args, { cwd: dir });

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
