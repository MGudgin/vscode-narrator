import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import {
    targetTitle,
    targetBannerLabel,
    targetMatchesSavedDoc,
    targetShortName,
    isAllowedRevealUri,
    shouldFollowEditor,
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

const commitDiffTarget: NarrationTarget = {
    kind: 'commitDiff',
    uri: vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri,
    baseRef: 'abc1234^',
    headRef: 'abc1234',
    abbrSha: 'abc1234',
    subject: 'feat: add a thing',
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

    test('includes abbreviated sha for commitDiff targets', () => {
        expect(targetTitle(commitDiffTarget)).toBe('Commit abc1234: baz.ts');
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

    test('returns "Diff in <sha>: <subject>" for commitDiff targets', () => {
        expect(targetBannerLabel(commitDiffTarget)).toBe('Diff in abc1234: feat: add a thing');
    });

    test('omits the colon when the commitDiff target has no subject', () => {
        const t: NarrationTarget = { ...commitDiffTarget, subject: '' };
        expect(targetBannerLabel(t)).toBe('Diff in abc1234');
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

    test('commitDiff target never matches a saved doc (it is pinned to a fixed commit)', () => {
        const same = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        expect(targetMatchesSavedDoc(commitDiffTarget, same)).toBe(false);
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

    test('commitDiff target: matches the working-tree URI of the same path, rejects siblings', () => {
        const same = vscode.Uri.parse('file:///foo/bar/baz.ts') as unknown as vscode.Uri;
        const other = vscode.Uri.parse('file:///foo/bar/qux.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(same, commitDiffTarget)).toBe(true);
        expect(isAllowedRevealUri(other, commitDiffTarget)).toBe(false);
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

describe('isAllowedRevealUri — additional edge cases for #89 (Windows / UNC / encoding)', () => {
    // The mock at `test/mocks/vscode.ts` builds `fsPath` by stripping the
    // leading `file://` from the URI string. URIs below are chosen so the
    // resulting fsPath exercises a specific branch of `normalize` in target.ts:
    //   `file://c:/...`       → fsPath `c:/...`        (Windows drive-letter)
    //   `file:////server/...` → fsPath `//server/...`  (UNC share)
    //   `file:///FOO/...`     → fsPath `/FOO/...`      (case-sensitive POSIX)
    // These shapes match what real VS Code's `Uri.fsPath` can produce on
    // Windows / UNC mounts. Even though the test runs on Linux CI under the
    // mock, the security property under test is purely textual — the
    // `isUriUnder` prefix check must reject any candidate whose normalised
    // path lands outside the root.

    const winTreeTarget: NarrationTarget = {
        kind: 'tree',
        repoRoot: vscode.Uri.parse('file://c:/projects/repo') as unknown as vscode.Uri,
        baseRef: 'origin/main',
    };

    const uncTreeTarget: NarrationTarget = {
        kind: 'tree',
        repoRoot: vscode.Uri.parse('file:////server/share/repo') as unknown as vscode.Uri,
        baseRef: 'origin/main',
    };

    test('Windows drive-letter root: accepts a legitimate in-bounds file', () => {
        const inside = vscode.Uri.parse('file://c:/projects/repo/src/index.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, winTreeTarget)).toBe(true);
    });

    test('Windows drive-letter root: rejects "../.." traversal into another user-data path', () => {
        // Classic indirect-injection payload on Windows: hop out of the repo
        // into the user profile. `posix.normalize` collapses the `..`s to
        // `c:/Users/u/.aws/credentials`, which does not start with the repo.
        const trav = vscode.Uri.parse(
            'file://c:/projects/repo/../../Users/u/.aws/credentials',
        ) as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, winTreeTarget)).toBe(false);
    });

    test('Windows drive-letter root: uppercase drive letter on the candidate is accepted', () => {
        // `normalize` lowercases the drive letter on both sides, so
        // `C:/projects/repo/...` is treated as `c:/projects/repo/...`.
        // Pin this so a future tightening doesn't reject legitimate paths
        // VS Code emits with an uppercase drive on Windows.
        const inside = vscode.Uri.parse('file://C:/projects/repo/src/index.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, winTreeTarget)).toBe(true);
    });

    test('Windows drive-letter root: case-mismatched non-drive path component is rejected (fail-closed)', () => {
        // Windows filesystems are case-insensitive in practice, but
        // `normalize` only lowercases the drive letter. A candidate whose
        // path components differ in case from the root therefore does not
        // match. This is a fail-closed posture; pin it so we notice if it
        // changes. The user-facing cost is that the LLM has to emit paths
        // in the same case as the repo root.
        const winRepoCaseTarget: NarrationTarget = {
            kind: 'tree',
            repoRoot: vscode.Uri.parse('file://c:/repo') as unknown as vscode.Uri,
            baseRef: 'origin/main',
        };
        const other = vscode.Uri.parse('file://c:/REPO/x.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(other, winRepoCaseTarget)).toBe(false);
    });

    test('UNC root: accepts a legitimate file inside the share', () => {
        const inside = vscode.Uri.parse('file:////server/share/repo/x.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, uncTreeTarget)).toBe(true);
    });

    test('UNC root: rejects ".." traversal that escapes the repo into a sibling directory on the same share', () => {
        const trav = vscode.Uri.parse('file:////server/share/repo/../other/file') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, uncTreeTarget)).toBe(false);
    });

    test('UNC root: rejects a different host even on a share with the same name', () => {
        // The prefix check has to see the host as part of the path so that a
        // candidate on `//attacker/share/...` cannot satisfy a root on
        // `//server/share/...`.
        const sibling = vscode.Uri.parse('file:////attacker/share/file') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(sibling, uncTreeTarget)).toBe(false);
    });

    test('tree target: redundant `//` inside the candidate path is collapsed and still allowed', () => {
        // `posix.normalize` collapses `//` to `/`, so `/foo/repo//bar`
        // normalises to `/foo/repo/bar` — still inside the repo. Pin this
        // so the fix does not start rejecting paths VS Code's filesystem
        // APIs would happily open.
        const inside = vscode.Uri.parse('file:///foo/repo//bar') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(inside, treeTarget)).toBe(true);
    });

    test('tree target: percent-encoded path separator (%2F) is a literal — does not bypass the check', () => {
        // `%2F` is not decoded by `normalize` or by `path.posix.normalize`.
        // `/foo/repo%2F..%2Fetc/passwd` is therefore a single oddly-named
        // path component, not a traversal, and does not start with
        // `/foo/repo/` (the char after `repo` is `%`, not `/`). Defence
        // against an attacker trying to smuggle traversal past the
        // normaliser by URL-encoding the separator.
        const trav = vscode.Uri.parse('file:///foo/repo%2F..%2Fetc/passwd') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(trav, treeTarget)).toBe(false);
    });

    test('tree target: case-different POSIX prefix is rejected (case-sensitive comparison)', () => {
        // No drive letter, so the case-fold branch of `normalize` does not
        // apply — the comparison is byte-wise. Locks in fail-closed posture
        // for POSIX-style paths that mismatch the root's casing.
        const other = vscode.Uri.parse('file:///FOO/repo/x.ts') as unknown as vscode.Uri;
        expect(isAllowedRevealUri(other, treeTarget)).toBe(false);
    });
});

describe('shouldFollowEditor', () => {
    const fileA = vscode.Uri.parse('file:///work/a.ts') as unknown as vscode.Uri;
    const fileB = vscode.Uri.parse('file:///work/b.ts') as unknown as vscode.Uri;
    const untitled = vscode.Uri.parse('untitled:Untitled-1') as unknown as vscode.Uri;
    const outputCh = vscode.Uri.parse('output:debug') as unknown as vscode.Uri;
    const fileTargetA: NarrationTarget = { kind: 'file', uri: fileA };
    const diffTargetA: NarrationTarget = { kind: 'diff', uri: fileA, baseRef: 'HEAD' };
    const treeTargetA: NarrationTarget = {
        kind: 'tree',
        repoRoot: vscode.Uri.parse('file:///work') as unknown as vscode.Uri,
        baseRef: 'HEAD',
    };

    test('returns false when the setting is off', () => {
        expect(
            shouldFollowEditor({
                newDocUri: fileB,
                newDocScheme: 'file',
                currentTarget: fileTargetA,
                followEnabled: false,
            }),
        ).toBe(false);
    });

    test('returns false when there is no active editor', () => {
        expect(
            shouldFollowEditor({
                newDocUri: undefined,
                newDocScheme: undefined,
                currentTarget: fileTargetA,
                followEnabled: true,
            }),
        ).toBe(false);
    });

    test('returns false when no narration target is open', () => {
        expect(
            shouldFollowEditor({
                newDocUri: fileB,
                newDocScheme: 'file',
                currentTarget: undefined,
                followEnabled: true,
            }),
        ).toBe(false);
    });

    test('diff and tree targets are pinned regardless of setting', () => {
        expect(
            shouldFollowEditor({
                newDocUri: fileB,
                newDocScheme: 'file',
                currentTarget: diffTargetA,
                followEnabled: true,
            }),
        ).toBe(false);

        expect(
            shouldFollowEditor({
                newDocUri: fileB,
                newDocScheme: 'file',
                currentTarget: treeTargetA,
                followEnabled: true,
            }),
        ).toBe(false);
    });

    test('non-file/untitled schemes do not retarget', () => {
        expect(
            shouldFollowEditor({
                newDocUri: outputCh,
                newDocScheme: 'output',
                currentTarget: fileTargetA,
                followEnabled: true,
            }),
        ).toBe(false);
    });

    test('untitled documents do retarget', () => {
        expect(
            shouldFollowEditor({
                newDocUri: untitled,
                newDocScheme: 'untitled',
                currentTarget: fileTargetA,
                followEnabled: true,
            }),
        ).toBe(true);
    });

    test('no-op when the new doc equals the current target', () => {
        expect(
            shouldFollowEditor({
                newDocUri: fileA,
                newDocScheme: 'file',
                currentTarget: fileTargetA,
                followEnabled: true,
            }),
        ).toBe(false);
    });

    test('happy path: file target + file-scheme new doc + enabled -> retarget', () => {
        expect(
            shouldFollowEditor({
                newDocUri: fileB,
                newDocScheme: 'file',
                currentTarget: fileTargetA,
                followEnabled: true,
            }),
        ).toBe(true);
    });
});
