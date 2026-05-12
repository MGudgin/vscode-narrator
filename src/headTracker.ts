// Pure logic for tracking HEAD-commit changes across multiple git repositories.
//
// The Git extension's `state.onDidChange` event fires for many reasons —
// working-tree edits, index updates, branch/HEAD moves, etc. Only HEAD moves
// (i.e. the commit pointed to by HEAD changing) should trigger a re-narrate
// in diff mode. `git commit` and `git checkout <branch>` both change
// `HEAD.commit`; plain working-tree edits do not.

export interface HeadSnapshot {
    repoId: string;
    headCommit: string | undefined;
}

export class HeadTracker {
    private readonly lastSeen = new Map<string, string | undefined>();

    /**
     * Record the latest HEAD commit for a repository and report whether it
     * changed since the previous observation.
     *
     * The first observation of a repository is *not* considered a change —
     * we have no baseline to compare against, so reporting it as a move
     * would cause a spurious re-narrate on activation.
     *
     * Transitioning between `undefined` and a real commit hash *is* a
     * change. (E.g. a freshly cloned repo with no HEAD getting its first
     * commit, or vice-versa.)
     */
    observe(snapshot: HeadSnapshot): boolean {
        const { repoId, headCommit } = snapshot;
        const hadPrior = this.lastSeen.has(repoId);
        const prior = this.lastSeen.get(repoId);
        this.lastSeen.set(repoId, headCommit);
        if (!hadPrior) return false;
        return prior !== headCommit;
    }

    /** Forget a repository (e.g. when it's closed). */
    forget(repoId: string): void {
        this.lastSeen.delete(repoId);
    }

    /** Reset all tracking. */
    reset(): void {
        this.lastSeen.clear();
    }
}
