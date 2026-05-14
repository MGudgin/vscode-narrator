import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    targetTitle,
    targetBannerLabel,
    targetMatchesSavedDoc,
    targetShortName,
    isAllowedRevealUri,
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

describe('isAllowedRevealUri — regression for #70', () => {
    test('rejects when no narration target is active', () => {
        const uri = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(uri, undefined)).toBe(false);
    });

    test('rejects schemes other than file: and untitled:', () => {
        const cases = [
            'http://example.com/x',
            'https://example.com/x',
            'vscode-userdata:/foo/bar',
            'git:/foo/bar?{}',
            'data:text/plain,hi',
            'javascript:alert(1)',
        ];
        for (const u of cases) {
            const uri = vscode.Uri.parse(u) as unknown as vscode.Uri;
            expect(isAllowedRevealUri(uri, fileTarget)).toBe(false);
        }
    });

    test('file target: matches its own URI, rejects siblings', () => {
        const same = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        const other = vscode.Uri.parse('file:///foo/bar/qux.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(same, fileTarget)).toBe(true);
        expect(isAllowedRevealUri(other, fileTarget)).toBe(false);
    });

    test('file target: rejects an attempt to escape via absolute path traversal', () => {
        // The classic indirect-injection payload from #70: a hand-crafted reveal
        // pointing at a sensitive file outside the narration target.
        const passwd = vscode.Uri.parse('file:///etc/passwd') as unknown as vscode.Uri;
        const aws = vscode.Uri.parse('file:///c:/users/u/.aws/credentials') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(passwd, fileTarget)).toBe(false);
        expect(isAllowedRevealUri(aws, fileTarget)).toBe(false);
    });

    test('diff target: matches its own URI, rejects siblings', () => {
        const same = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        const other = vscode.Uri.parse('file:///foo/bar/qux.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(same, diffTarget)).toBe(true);
        expect(isAllowedRevealUri(other, diffTarget)).toBe(false);
    });

    test('tree target: matches files inside the repo root', () => {
        const inside = vscode.Uri.parse('file:///foo/repo/src/index.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, treeTarget)).toBe(true);
    });

    test('tree target: rejects files outside the repo root', () => {
        const sibling = vscode.Uri.parse('file:///foo/repo-other/x.ts') as unknown as vscode.Uri;
        const passwd = vscode.Uri.parse('file:///etc/passwd') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(sibling, treeTarget)).toBe(false);
        expect(isAllowedRevealUri(passwd, treeTarget)).toBe(false);
    });

    test('untitled: documents are permitted when they are the file target', () => {
        const untitled = vscode.Uri.parse('untitled:Untitled-1') as unknown as vscode.Uri;
        const untitledTarget: NarrationTarget = { kind: 'file', uri: untitled };
        expect(isAllowedRevealUri(untitled, untitledTarget)).toBe(true);
    });

    test('tree target rejects ".." traversal even if prefix appears to match (#89)', () => {
        const trav = vscode.Uri.parse('file:///foo/repo/../etc/passwd') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, treeTarget)).toBe(false);
    });

    test('tree target rejects deeper ".." traversal (#89)', () => {
        const trav = vscode.Uri.parse('file:///foo/repo/../../etc/passwd') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, treeTarget)).toBe(false);
    });

    test('tree target rejects mid-path ".." traversal (#89)', () => {
        // The traversal need not be at the start — anywhere it lands outside
        // the repo root must be rejected.
        const trav = vscode.Uri.parse('file:///foo/repo/src/../../etc/passwd') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, treeTarget)).toBe(false);
    });

    test('tree target accepts a path that normalizes back inside the repo (#89)', () => {
        // `/foo/repo/a/../b/x.ts` normalizes to `/foo/repo/b/x.ts` — still
        // inside the repo, so this remains allowed. Pins behaviour so the
        // traversal fix doesn't accidentally reject legitimate redundant `..`.
        const inside = vscode.Uri.parse('file:///foo/repo/a/../b/x.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, treeTarget)).toBe(true);
    });

    test('file target rejects same-name URI with redundant ".." (defence in depth, #89)', () => {
        // file/diff modes already use exact-string match, but lock the
        // behaviour down so any future relaxation does not regress.
        const trav = vscode.Uri.parse('file:///foo/bar/../bar/baz.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, fileTarget)).toBe(false);
    });
});
