import * as vscode from 'vscode';
import { normalizeRoot } from './paths';

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

/**
 * Pure predicate for the follow-active-editor feature. Returns true iff the
 * active-editor change should cause the narration pane to retarget to the
 * new document.
 *
 * Skip cases (return false):
 * - Setting is off.
 * - No editor / no document.
 * - Current target is `diff` or `tree` — those are intentionally pinned.
 * - New document scheme is not `file:` or `untitled:` (avoid webviews, output
 *   channels, settings editors, etc.).
 * - The new document is the same as the current target — no-op.
 */
export function shouldFollowEditor(args: {
    newDocUri: vscode.Uri | undefined;
    newDocScheme: string | undefined;
    currentTarget: NarrationTarget | undefined;
    followEnabled: boolean;
}): boolean {
    if (!args.followEnabled) return false;
    if (!args.newDocUri || !args.newDocScheme) return false;
    if (!args.currentTarget || args.currentTarget.kind !== 'file') return false;
    if (args.newDocScheme !== 'file' && args.newDocScheme !== 'untitled') return false;
    if (args.currentTarget.uri.toString() === args.newDocUri.toString()) return false;
    return true;
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

/**
 * Compose the banner string used by the narration pane, appending the active
 * persona's label as a `•`-separated suffix when it's anything other than the
 * built-in `default` persona.
 *
 * Empty `personaLabel` or the literal `Default` (the built-in default
 * persona's label) is omitted so the banner stays uncluttered for the most
 * common case. Other personas surface in the banner so the user can tell at a
 * glance which lens shaped the narration they're looking at.
 */
export function bannerLabelWithPersona(target: NarrationTarget, personaLabel: string | undefined): string {
    const base = targetBannerLabel(target);
    if (!personaLabel) return base;
    if (personaLabel === 'Default') return base;
    return `${base} • ${personaLabel}`;
}

export function targetShortName(target: NarrationTarget): string {
    return target.kind === 'tree' ? shortName(target.repoRoot) : shortName(target.uri);
}

function shortName(uri: vscode.Uri): string {
    const p = uri.fsPath || uri.path;
    return p.split(/[\\/]/).filter(Boolean).pop() ?? uri.toString();
}

function isUriUnder(root: vscode.Uri, candidate: vscode.Uri): boolean {
    const rootPath = normalizeRoot(root.fsPath || root.path);
    const candPath = normalizeRoot(candidate.fsPath || candidate.path);
    if (rootPath.length === 0) return false;
    if (candPath === rootPath) return true;
    return candPath.startsWith(rootPath + '/');
}
