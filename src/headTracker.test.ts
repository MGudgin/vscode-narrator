import { describe, test, expect } from 'vitest';
import { HeadTracker } from './headTracker';

describe('HeadTracker', () => {
    test('first observation of a repo is not a move', () => {
        const t = new HeadTracker();
        expect(t.observe({ repoId: 'repo-a', headCommit: 'aaaa' })).toBe(false);
    });

    test('same commit observed twice is not a move', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        expect(t.observe({ repoId: 'repo-a', headCommit: 'aaaa' })).toBe(false);
    });

    test('different commit on the same repo counts as a move', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        expect(t.observe({ repoId: 'repo-a', headCommit: 'bbbb' })).toBe(true);
    });

    test('move detection is per-repo, not global', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        t.observe({ repoId: 'repo-b', headCommit: 'bbbb' });
        // repo-b changes — repo-a is unchanged and should not be reported as moved.
        expect(t.observe({ repoId: 'repo-b', headCommit: 'cccc' })).toBe(true);
        expect(t.observe({ repoId: 'repo-a', headCommit: 'aaaa' })).toBe(false);
    });

    test('transition undefined -> commit (after prior observation) is a move', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: undefined });
        expect(t.observe({ repoId: 'repo-a', headCommit: 'aaaa' })).toBe(true);
    });

    test('transition commit -> undefined is a move', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        expect(t.observe({ repoId: 'repo-a', headCommit: undefined })).toBe(true);
    });

    test('forget drops baseline so the next observation is treated as first', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        t.forget('repo-a');
        expect(t.observe({ repoId: 'repo-a', headCommit: 'bbbb' })).toBe(false);
    });

    test('reset clears all baselines', () => {
        const t = new HeadTracker();
        t.observe({ repoId: 'repo-a', headCommit: 'aaaa' });
        t.observe({ repoId: 'repo-b', headCommit: 'bbbb' });
        t.reset();
        expect(t.observe({ repoId: 'repo-a', headCommit: 'cccc' })).toBe(false);
        expect(t.observe({ repoId: 'repo-b', headCommit: 'dddd' })).toBe(false);
    });

    test('replays a realistic commit/checkout sequence', () => {
        const t = new HeadTracker();
        // Activation snapshot.
        expect(t.observe({ repoId: 'r', headCommit: 'c1' })).toBe(false);
        // Save event re-emits state.onDidChange but HEAD didn't move.
        expect(t.observe({ repoId: 'r', headCommit: 'c1' })).toBe(false);
        // User commits.
        expect(t.observe({ repoId: 'r', headCommit: 'c2' })).toBe(true);
        // Another spurious tick.
        expect(t.observe({ repoId: 'r', headCommit: 'c2' })).toBe(false);
        // User switches branch.
        expect(t.observe({ repoId: 'r', headCommit: 'c3' })).toBe(true);
    });
});
