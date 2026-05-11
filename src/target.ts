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
    // match. Forward-slashes only; no trailing slash.
    let out = p.replace(/\\/g, '/');
    if (out.endsWith('/')) out = out.slice(0, -1);
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
}
