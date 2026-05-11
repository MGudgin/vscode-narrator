import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    targetTitle,
    targetBannerLabel,
    targetMatchesSavedDoc,
    targetShortName,
    NarrationTarget,
} from './target';

const fileTarget: NarrationTarget = {
    kind: 'file',
    uri: vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri,
};

const diffTarget: NarrationTarget = {
    kind: 'diff',
    uri: vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri,
    baseRef: 'origin/main',
};

const treeTarget: NarrationTarget = {
    kind: 'tree',
    repoRoot: vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri,
    baseRef: 'origin/main',
};

describe('targetTitle', () => {
    test('uses file basename for file targets', () => {
        expect(targetTitle(fileTarget)).toBe('Narration: baz.ts');
    });

    test('includes base ref for diff targets', () => {
        expect(targetTitle(diffTarget)).toBe('Diff (origin/main): baz.ts');
    });

    test('uses repo folder name for tree targets', () => {
        expect(targetTitle(treeTarget)).toBe('Tree diff (origin/main): repo');
    });
});

describe('targetBannerLabel', () => {
    test('returns "Full file" for file targets', () => {
        expect(targetBannerLabel(fileTarget)).toBe('Full file');
    });

    test('returns "Diff vs <ref>" for diff targets', () => {
        expect(targetBannerLabel(diffTarget)).toBe('Diff vs origin/main');
    });

    test('returns "Tree diff vs <ref>" for tree targets', () => {
        expect(targetBannerLabel(treeTarget)).toBe('Tree diff vs origin/main');
    });
});

describe('targetShortName', () => {
    test('returns file basename for file targets', () => {
        expect(targetShortName(fileTarget)).toBe('baz.ts');
    });

    test('returns repo folder name for tree targets', () => {
        expect(targetShortName(treeTarget)).toBe('repo');
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

    test('tree target matches any file inside the repo root', () => {
        const inside = vscode.Uri.parse('file:///foo/repo/src/index.ts') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(treeTarget, inside)).toBe(true);
    });

    test('tree target matches the repo root itself', () => {
        const root = vscode.Uri.parse('file:///foo/repo') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(treeTarget, root)).toBe(true);
    });

    test('tree target does not match siblings of the repo root', () => {
        const sibling = vscode.Uri.parse('file:///foo/repo-other/src/index.ts') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(treeTarget, sibling)).toBe(false);
    });
});
