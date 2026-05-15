import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { normalizeRoot, relPath, relPathFromRoot } from './paths';

describe('normalizeRoot', () => {
    test('converts backslashes to forward slashes', () => {
        expect(normalizeRoot('C:\\foo\\bar')).toBe('c:/foo/bar');
    });

    test('strips trailing slash', () => {
        expect(normalizeRoot('/foo/bar/')).toBe('/foo/bar');
    });

    test('lower-cases Windows drive letters', () => {
        expect(normalizeRoot('D:/Workspace/proj')).toBe('d:/Workspace/proj');
    });

    test('collapses .. segments', () => {
        expect(normalizeRoot('/foo/bar/../baz')).toBe('/foo/baz');
    });

    test('collapses . segments', () => {
        expect(normalizeRoot('/foo/./bar')).toBe('/foo/bar');
    });

    test('returns empty input as a dot (posix.normalize convention)', () => {
        // posix.normalize('') === '.'  — callers downstream treat empty
        // root as a no-op anyway. Just nail down the exact behaviour.
        expect(normalizeRoot('')).toBe('.');
    });

    test('plain posix paths pass through unchanged apart from trailing slash', () => {
        expect(normalizeRoot('/foo/bar/baz')).toBe('/foo/bar/baz');
    });
});

describe('relPath', () => {
    test('returns the relative path for a file under the root (posix)', () => {
        const root = normalizeRoot('/foo/repo');
        const file = vscode.Uri.parse('file:///foo/repo/src/a.ts') as unknown as vscode.Uri;
        expect(relPath(root, file)).toBe('src/a.ts');
    });

    test('returns the file path when the file is not under the root', () => {
        const root = normalizeRoot('/foo/repo');
        const file = vscode.Uri.parse('file:///other/place.ts') as unknown as vscode.Uri;
        // Out-of-root file returns the normalized absolute fallback.
        expect(relPath(root, file)).toBe('/other/place.ts');
    });

    test('case-insensitive prefix match on Windows-style paths', () => {
        // Both paths reference the same location on disk but use different
        // casing on the drive letter. The shared helper must treat them as
        // equivalent so heading/diff link generation works on Windows.
        const root = normalizeRoot('C:\\Workspace\\proj');
        const file = { fsPath: 'c:\\Workspace\\proj\\src\\x.ts', path: '/c:/Workspace/proj/src/x.ts' } as unknown as vscode.Uri;
        expect(relPath(root, file)).toBe('src/x.ts');
    });

    test('handles trailing slash on the original root input', () => {
        const root = normalizeRoot('/foo/repo/');
        const file = vscode.Uri.parse('file:///foo/repo/a.ts') as unknown as vscode.Uri;
        expect(relPath(root, file)).toBe('a.ts');
    });

    test('returns empty string when file is the root itself', () => {
        const root = normalizeRoot('/foo/repo');
        const file = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;
        expect(relPath(root, file)).toBe('');
    });

    test('rejects a sibling whose path shares a common prefix string but not a path-component boundary', () => {
        const root = normalizeRoot('/foo/repo');
        // /foo/repository starts with /foo/repo as a string but is NOT under it.
        const sibling = vscode.Uri.parse('file:///foo/repository/x.ts') as unknown as vscode.Uri;
        // The fallback returns the normalized path of the sibling, not a truncated rel.
        expect(relPath(root, sibling)).toBe('/foo/repository/x.ts');
    });
});

describe('relPathFromRoot', () => {
    test('convenience wrapper normalizes the root and resolves the relative path', () => {
        const root = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;
        const file = vscode.Uri.parse('file:///foo/repo/src/a.ts') as unknown as vscode.Uri;
        expect(relPathFromRoot(root, file)).toBe('src/a.ts');
    });
});
