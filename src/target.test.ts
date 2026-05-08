import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { targetTitle, targetBannerLabel, targetMatchesSavedDoc, NarrationTarget } from './target';

const fileTarget: NarrationTarget = {
    kind: 'file',
    uri: vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri,
};

const diffTarget: NarrationTarget = {
    kind: 'diff',
    uri: vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri,
    baseRef: 'origin/main',
};

describe('targetTitle', () => {
    test('uses file basename for file targets', () => {
        expect(targetTitle(fileTarget)).toBe('Narration: baz.ts');
    });

    test('includes base ref for diff targets', () => {
        expect(targetTitle(diffTarget)).toBe('Diff (origin/main): baz.ts');
    });
});

describe('targetBannerLabel', () => {
    test('returns "Full file" for file targets', () => {
        expect(targetBannerLabel(fileTarget)).toBe('Full file');
    });

    test('returns "Diff vs <ref>" for diff targets', () => {
        expect(targetBannerLabel(diffTarget)).toBe('Diff vs origin/main');
    });
});

describe('targetMatchesSavedDoc', () => {
    test('matches when URIs are identical', () => {
        const same = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(fileTarget, same)).toBe(true);
    });

    test('does not match for a different file', () => {
        const other = vscode.Uri.parse('file:///foo/bar/qux.ts') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(fileTarget, other)).toBe(false);
    });
});
