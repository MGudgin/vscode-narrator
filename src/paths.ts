import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Normalize a filesystem-style path string into the canonical form used by
 * the shared path helpers: forward-slash separators, no trailing slash,
 * lower-cased Windows drive letter, and `.`/`..` segments collapsed.
 *
 * Callers compute this once per root and pass the result to `relPath` so
 * each lookup avoids repeating the per-character regex work and stays
 * consistent with `target.ts:normalize` for cross-platform behavior.
 */
export function normalizeRoot(rootPath: string): string {
    let out = rootPath.replace(/\\/g, '/');
    out = path.posix.normalize(out);
    if (out.endsWith('/')) out = out.slice(0, -1);
    if (/^[A-Za-z]:\//.test(out)) out = out[0].toLowerCase() + out.slice(1);
    return out;
}

/**
 * Resolve `fileUri` to a path relative to `normalizedRoot`. The root must
 * already have been run through `normalizeRoot` so the per-file loop
 * doesn't repeat that work for every entry in a tree-diff.
 *
 * Returns the absolute-style fallback (the normalized file path, lossy on
 * the drive letter case to match the root) when the file is not under
 * the root. The case-insensitive prefix match matches `target.ts:normalize`
 * and the prior `diff.ts`/`prompt.ts`/`narrate.ts` helpers.
 */
export function relPath(normalizedRoot: string, fileUri: vscode.Uri): string {
    const rawFile = fileUri.fsPath || fileUri.path;
    const normalizedFile = normalizeRoot(rawFile);
    if (normalizedRoot.length === 0) return normalizedFile;
    if (normalizedFile.toLowerCase() === normalizedRoot.toLowerCase()) return '';
    const prefix = normalizedRoot.toLowerCase() + '/';
    if (normalizedFile.toLowerCase().startsWith(prefix)) {
        return normalizedFile.slice(normalizedRoot.length + 1);
    }
    return normalizedFile;
}

/**
 * Convenience wrapper for one-shot callers that don't have a pre-normalized
 * root handy. Tree-diff loops should call `normalizeRoot` once and pass the
 * result into `relPath` to avoid normalizing the root per file.
 */
export function relPathFromRoot(rootUri: vscode.Uri, fileUri: vscode.Uri): string {
    const raw = rootUri.fsPath || rootUri.path;
    return relPath(normalizeRoot(raw), fileUri);
}
