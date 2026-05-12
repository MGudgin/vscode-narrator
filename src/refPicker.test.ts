import { describe, test, expect } from 'vitest';
import { buildRefItems, findActiveIndex, MAX_RELATIVE, PickerCommit, PickerRef } from './refPicker';

function commit(hash: string, message: string): PickerCommit {
    return { hash, message };
}

function ref(type: number, name: string): PickerRef {
    return { type, name };
}

describe('buildRefItems', () => {
    test('returns no relative section when there are no commits', () => {
        const items = buildRefItems({ commits: [], refs: [] });
        const sections = items.filter((it) => it.kind === 'separator').map((it) => it.label);
        expect(sections).not.toContain('Relative to HEAD');
    });

    test('builds HEAD, HEAD~1, …, HEAD~N labels with subject and short SHA', () => {
        const commits = [
            commit('aaaaaaaa1', 'Add picker\n\nbody'),
            commit('bbbbbbbb2', 'Fix bug'),
            commit('cccccccc3', 'Refactor'),
        ];
        const items = buildRefItems({ commits, refs: [] });
        const relRefs = items.filter((it) => it.kind === 'ref' && it.ref.startsWith('HEAD'));
        expect(relRefs).toHaveLength(3);
        expect(relRefs[0]).toMatchObject({ kind: 'ref', label: 'HEAD', ref: 'HEAD', description: 'Add picker (aaaaaaa)' });
        expect(relRefs[1]).toMatchObject({ kind: 'ref', label: 'HEAD~1', ref: 'HEAD~1', description: 'Fix bug (bbbbbbb)' });
        expect(relRefs[2]).toMatchObject({ kind: 'ref', label: 'HEAD~2', ref: 'HEAD~2', description: 'Refactor (ccccccc)' });
    });

    test('caps the relative section at MAX_RELATIVE entries', () => {
        const commits = Array.from({ length: MAX_RELATIVE + 5 }, (_, i) => commit(`h${i}`, `m${i}`));
        const items = buildRefItems({ commits, refs: [] });
        const relRefs = items.filter((it) => it.kind === 'ref' && it.ref.startsWith('HEAD'));
        expect(relRefs).toHaveLength(MAX_RELATIVE);
        expect(relRefs[relRefs.length - 1]).toMatchObject({ ref: `HEAD~${MAX_RELATIVE - 1}` });
    });

    test('marks the current branch with description "current"', () => {
        const refs = [ref(0, 'main'), ref(0, 'feature-x')];
        const items = buildRefItems({ commits: [], refs, headBranchName: 'feature-x' });
        const branches = items.filter((it) => it.kind === 'ref');
        const featureX = branches.find((it) => it.kind === 'ref' && it.ref === 'feature-x');
        const main = branches.find((it) => it.kind === 'ref' && it.ref === 'main');
        expect(featureX).toMatchObject({ description: 'current', isCurrent: true });
        expect(main).toMatchObject({ ref: 'main' });
        expect(main && 'isCurrent' in main && main.isCurrent).toBeFalsy();
    });

    test('includes both local and remote branches', () => {
        const refs = [ref(0, 'main'), ref(1, 'origin/main'), ref(1, 'origin/dev')];
        const items = buildRefItems({ commits: [], refs });
        const refLabels = items.filter((it) => it.kind === 'ref').map((it) => (it as { ref: string }).ref);
        expect(refLabels).toEqual(expect.arrayContaining(['main', 'origin/main', 'origin/dev']));
    });

    test('omits the tags section when there are no tags', () => {
        const items = buildRefItems({ commits: [], refs: [ref(0, 'main')] });
        const sectionLabels = items.filter((it) => it.kind === 'separator').map((it) => it.label);
        expect(sectionLabels).not.toContain('Tags');
    });

    test('includes a tags section when tags are present', () => {
        const refs = [ref(2, 'v1.0.0'), ref(2, 'v1.1.0')];
        const items = buildRefItems({ commits: [], refs });
        const sectionLabels = items.filter((it) => it.kind === 'separator').map((it) => it.label);
        expect(sectionLabels).toContain('Tags');
        const tagRefs = items
            .filter((it) => it.kind === 'ref')
            .map((it) => (it as { ref: string }).ref);
        expect(tagRefs).toEqual(expect.arrayContaining(['v1.0.0', 'v1.1.0']));
    });

    test('always appends a custom-input item at the end', () => {
        const items = buildRefItems({ commits: [], refs: [] });
        const last = items[items.length - 1];
        expect(last.kind).toBe('custom');
    });
});

describe('findActiveIndex', () => {
    test('returns the index of a matching ref item', () => {
        const items = buildRefItems({
            commits: [commit('abc1234', 'first')],
            refs: [ref(0, 'main')],
        });
        const idx = findActiveIndex(items, 'main');
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(items[idx]).toMatchObject({ kind: 'ref', ref: 'main' });
    });

    test('returns -1 when no item matches', () => {
        const items = buildRefItems({ commits: [], refs: [ref(0, 'main')] });
        expect(findActiveIndex(items, 'nonexistent-ref')).toBe(-1);
    });

    test('skips separator items even if their label matches', () => {
        const items = buildRefItems({ commits: [commit('a', 'm')], refs: [] });
        expect(findActiveIndex(items, 'Relative to HEAD')).toBe(-1);
    });
});
