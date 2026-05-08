import * as vscode from 'vscode';

export type NarrationTarget =
    | { kind: 'file'; uri: vscode.Uri }
    | { kind: 'diff'; uri: vscode.Uri; baseRef: string };

export function targetMatchesSavedDoc(target: NarrationTarget, savedUri: vscode.Uri): boolean {
    return target.uri.toString() === savedUri.toString();
}

export function targetTitle(target: NarrationTarget): string {
    const fileName = shortName(target.uri);
    switch (target.kind) {
        case 'file': return `Narration: ${fileName}`;
        case 'diff': return `Diff (${target.baseRef}): ${fileName}`;
    }
}

export function targetBannerLabel(target: NarrationTarget): string {
    switch (target.kind) {
        case 'file': return 'Full file';
        case 'diff': return `Diff vs ${target.baseRef}`;
    }
}

function shortName(uri: vscode.Uri): string {
    const p = uri.fsPath || uri.path;
    return p.split(/[\\/]/).pop() ?? uri.toString();
}
