import * as path from 'path';
import * as vscode from 'vscode';

export type NarrationTarget =
    | { kind: 'file'; uri: vscode.Uri }
    | { kind: 'diff'; uri: vscode.Uri; baseRef: string }
    | { kind: 'tree'; repoRoot: vscode.Uri; baseRef: string };

export function targetMatchesSavedDoc(target: NarrationTarget, savedUri: vscode.Uri): boolean {
    switch (target.kind) {
        case 'file':
        case 'diff':
            return target.uri.toString() === savedUri.toString();
        case 'tree':
            return isUriUnder(target.repoRoot, savedUri);
    }
}

/**
 * Allowlist predicate for the `codeNarration.reveal` command handler.
 *
 * Reveal links are produced by `fixupLinks` from `narrate://lines/...` markers
 * the LLM emits, using the active narration target's URI. An attacker who
 * influences narration output (via indirect prompt injection in the source
 * being narrated) could otherwise hand-craft
 * `command:codeNarration.reveal?["file:///etc/passwd",…]` and open arbitrary
 * files when the user clicks the rendered link. This predicate enforces that
 * the URI being revealed (a) uses a scheme the extension actually narrates
 * and (b) refers to the same document (or, for tree mode, a path inside the
 * watched repo) that the current narration is about.
 */
export function isAllowedRevealUri(uri: vscode.Uri, target: NarrationTarget | undefined): boolean {
    if (uri.scheme !== 'file' && uri.scheme !== 'untitled') return false;
    if (!target) return false;
    return targetMatchesSavedDoc(target, uri);
}

export function targetTitle(target: NarrationTarget): string {
    switch (target.kind) {
        case 'file': return `Narration: ${shortName(target.uri)}`;
        case 'diff': return `Diff (${target.baseRef}): ${shortName(target.uri)}`;
        case 'tree': return `Tree diff (${target.baseRef}): ${shortName(target.repoRoot)}`;
    }
}

export function targetBannerLabel(target: NarrationTarget): string {
    switch (target.kind) {
        case 'file': return 'Full file';
        case 'diff': return `Diff vs ${target.baseRef}`;
        case 'tree': return `Tree diff vs ${target.baseRef}`;
    }
}

export function targetShortName(target: NarrationTarget): string {
    return target.kind === 'tree' ? shortName(target.repoRoot) : shortName(target.uri);
}

function shortName(uri: vscode.Uri): string {
    const p = uri.fsPath || uri.path;
    return p.split(/[\\/]/).filter(Boolean).pop() ?? uri.toString();
}

function isUriUnder(root: vscode.Uri, candidate: vscode.Uri): boolean {
    const rootPath = normalize(root.fsPath || root.path);
    const candPath = normalize(candidate.fsPath || candidate.path);
    if (rootPath.length === 0) return false;
    if (candPath === rootPath) return true;
    return candPath.startsWith(rootPath + '/');
}

function normalize(p: string): string {
    // Lower-case the drive letter on Windows so e.g. "C:/foo" and "c:/foo"
    // match. Forward-slashes only; no trailing slash. `..`/`.` segments are
    // collapsed via `path.posix.normalize` *before* the prefix comparison in
    // `isUriUnder` runs — without this collapse, a URI of the form
    // `<repoRoot>/../<elsewhere>` passes the startsWith check, and VS Code's
    // filesystem APIs would then resolve the traversal when actually opening
    // the file. (Bypass for #70 closed in #89.)
    let out = p.replace(/\\/g, '/');
    out = path.posix.normalize(out);
    if (out.endsWith('/')) out = out.slice(0, -1);
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
}
