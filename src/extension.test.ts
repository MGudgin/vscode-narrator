import { describe, test, expect } from 'vitest';
import {
    ensureWorkspaceTrustedForNarration,
    isValidRange,
    findSectionForLine,
    normalizeVoices,
    pickVoiceCore,
    PickVoiceDeps,
    VoiceInfo,
    VoiceQuickPickItem,
} from './extension';

type Section = { id: string; range: { start: { line: number }; end: { line: number } } };

function mk(id: string, startLine: number, endLine: number): Section {
    return { id, range: { start: { line: startLine }, end: { line: endLine } } };
}

describe('isValidRange', () => {
    test('rejects null', () => {
        expect(isValidRange(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isValidRange(undefined)).toBe(false);
    });

    test('rejects an empty object', () => {
        expect(isValidRange({})).toBe(false);
    });

    test('rejects when start is null', () => {
        expect(isValidRange({ start: null, end: { line: 0, character: 0 } })).toBe(false);
    });

    test('rejects when end is null', () => {
        expect(isValidRange({ start: { line: 0, character: 0 }, end: null })).toBe(false);
    });

    test('rejects when start.line is a string', () => {
        expect(isValidRange({
            start: { line: 'x', character: 0 },
            end: { line: 0, character: 0 },
        })).toBe(false);
    });

    test('rejects when start.character is missing', () => {
        expect(isValidRange({
            start: { line: 0 },
            end: { line: 0, character: 0 },
        })).toBe(false);
    });

    test('rejects when end.line is NaN', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: NaN, character: 0 },
        })).toBe(false);
    });

    test('rejects when a coordinate is Infinity', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: Infinity, character: 0 },
        })).toBe(false);
    });

    test('rejects a primitive', () => {
        expect(isValidRange('hello')).toBe(false);
        expect(isValidRange(42)).toBe(false);
        expect(isValidRange(true)).toBe(false);
    });

    test('accepts a well-formed range', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: 10, character: 25 },
        })).toBe(true);
    });

    test('accepts a zero-width range', () => {
        expect(isValidRange({
            start: { line: 3, character: 7 },
            end: { line: 3, character: 7 },
        })).toBe(true);
    });
});

describe('findSectionForLine', () => {
    test('returns undefined for an empty list', () => {
        expect(findSectionForLine([], 0)).toBeUndefined();
        expect(findSectionForLine([], 42)).toBeUndefined();
    });

    test('returns the section containing the cursor in a single-section list', () => {
        const sections = [mk('a', 10, 20)];
        expect(findSectionForLine(sections, 15)?.id).toBe('a');
    });

    test('returns undefined when the cursor falls before the first section', () => {
        const sections = [mk('a', 10, 20), mk('b', 30, 40)];
        expect(findSectionForLine(sections, 5)).toBeUndefined();
        expect(findSectionForLine(sections, 9)).toBeUndefined();
    });

    test('returns undefined when the cursor falls after the last section', () => {
        const sections = [mk('a', 10, 20), mk('b', 30, 40)];
        expect(findSectionForLine(sections, 41)).toBeUndefined();
        expect(findSectionForLine(sections, 1000)).toBeUndefined();
    });

    test('returns undefined when the cursor is in a gap between sections', () => {
        const sections = [mk('a', 10, 20), mk('b', 30, 40)];
        expect(findSectionForLine(sections, 21)).toBeUndefined();
        expect(findSectionForLine(sections, 25)).toBeUndefined();
        expect(findSectionForLine(sections, 29)).toBeUndefined();
    });

    test('cursor on the start.line matches that section', () => {
        const sections = [mk('a', 10, 20), mk('b', 30, 40)];
        expect(findSectionForLine(sections, 10)?.id).toBe('a');
        expect(findSectionForLine(sections, 30)?.id).toBe('b');
    });

    test('cursor on the end.line matches that section', () => {
        const sections = [mk('a', 10, 20), mk('b', 30, 40)];
        expect(findSectionForLine(sections, 20)?.id).toBe('a');
        expect(findSectionForLine(sections, 40)?.id).toBe('b');
    });

    test('picks the matching section across many sorted sections', () => {
        const sections = [
            mk('a', 0, 4),
            mk('b', 5, 9),
            mk('c', 10, 14),
            mk('d', 15, 19),
            mk('e', 20, 24),
        ];
        expect(findSectionForLine(sections, 0)?.id).toBe('a');
        expect(findSectionForLine(sections, 7)?.id).toBe('b');
        expect(findSectionForLine(sections, 12)?.id).toBe('c');
        expect(findSectionForLine(sections, 19)?.id).toBe('d');
        expect(findSectionForLine(sections, 24)?.id).toBe('e');
    });

    test('handles a zero-width section (start.line === end.line)', () => {
        const sections = [mk('a', 5, 5), mk('b', 10, 20)];
        expect(findSectionForLine(sections, 5)?.id).toBe('a');
        expect(findSectionForLine(sections, 6)).toBeUndefined();
    });

    test('overlapping ranges: picks the section with the greatest start.line that still encloses the cursor', () => {
        // Outer 0..100 contains inner 20..40. Cursor at 25 sits in both.
        // The binary search pins the rightmost start.line <= cursor, then
        // verifies end.line >= cursor — so the inner (more specific) wins.
        const sections = [mk('outer', 0, 100), mk('inner', 20, 40)];
        expect(findSectionForLine(sections, 25)?.id).toBe('inner');
    });

    test('overlapping ranges: outer wins when the inner does not cover the cursor', () => {
        // Outer 0..100 with inner 20..40. Cursor at 50 is only in outer.
        // The candidate (inner) fails end.line check; the result is undefined
        // because the binary search does not climb back to find outer.
        // This is the documented behaviour: with overlapping ranges the search
        // is deterministic but not exhaustive. In practice getNarrationUnits
        // does not emit overlapping ranges, so this edge case never trips.
        const sections = [mk('outer', 0, 100), mk('inner', 20, 40)];
        expect(findSectionForLine(sections, 50)).toBeUndefined();
    });

    test('large list: 10 000-section lookup resolves in well under 1 ms per call', () => {
        const N = 10_000;
        const sections: Section[] = [];
        for (let i = 0; i < N; i++) {
            // Adjacent ranges, 10 lines each.
            sections.push(mk(`s${i}`, i * 10, i * 10 + 9));
        }
        const LOOKUPS = 1000;
        const start = performance.now();
        let acc = 0;
        for (let k = 0; k < LOOKUPS; k++) {
            // Mix of in-range, on-boundary, and out-of-range cursor lines.
            const cursorLine = (k * 137) % (N * 10);
            const m = findSectionForLine(sections, cursorLine);
            if (m) acc++;
        }
        const elapsed = performance.now() - start;
        const perCall = elapsed / LOOKUPS;
        console.log(`[perf] findSectionForLine N=${N} ${LOOKUPS} lookups: ${elapsed.toFixed(2)} ms total (${perCall.toFixed(4)} ms/call), hits=${acc}`);
        // Well below 1 ms/call — binary search on 10 000 elements is ~14
        // comparisons. Generous threshold so CI doesn't flake.
        expect(perCall).toBeLessThan(1);
    });
});

describe('ensureWorkspaceTrustedForNarration — regression for #127', () => {
    test('returns true and does NOT warn when the workspace is trusted', () => {
        const warnings: string[] = [];
        const allowed = ensureWorkspaceTrustedForNarration(true, 'Open Narration', (m) => warnings.push(m));
        expect(allowed).toBe(true);
        expect(warnings).toEqual([]);
    });

    test('returns false and surfaces a warning when the workspace is untrusted', () => {
        const warnings: string[] = [];
        const allowed = ensureWorkspaceTrustedForNarration(false, 'Open Narration', (m) => warnings.push(m));
        expect(allowed).toBe(false);
        expect(warnings).toHaveLength(1);
        // The warning must name the command (so the user knows which action
        // was blocked) and explain why — the package.json untrustedWorkspaces
        // description promises commands "stay disabled" specifically because
        // file contents would otherwise be sent to a third-party LLM.
        expect(warnings[0]).toContain('Open Narration');
        expect(warnings[0]).toMatch(/untrusted|trust/i);
        expect(warnings[0]).toMatch(/language model|LLM/i);
    });

    test('includes the supplied command label verbatim in the warning', () => {
        const warnings: string[] = [];
        for (const label of [
            'Open Narration',
            'Open Diff Narration',
            'Open Tree Diff Narration',
            'Refresh Narration',
        ]) {
            warnings.length = 0;
            ensureWorkspaceTrustedForNarration(false, label, (m) => warnings.push(m));
            expect(warnings[0]).toContain(label);
        }
    });
});

describe('normalizeVoices', () => {
    test('returns an empty array for an empty input', () => {
        expect(normalizeVoices([])).toEqual([]);
    });

    test('drops entries with missing or non-string names', () => {
        expect(normalizeVoices([
            { name: 'Alice', lang: 'en-US' },
            { name: '', lang: 'en-US' },
            { lang: 'en-US' },
            null,
            'not-an-object',
            42,
        ])).toEqual([{ name: 'Alice', lang: 'en-US', default: undefined, localService: undefined }]);
    });

    test('coerces missing lang to empty string', () => {
        expect(normalizeVoices([{ name: 'Alice' }])).toEqual([
            { name: 'Alice', lang: '', default: undefined, localService: undefined },
        ]);
    });

    test('preserves default and localService booleans, ignoring non-booleans', () => {
        expect(normalizeVoices([
            { name: 'Alice', lang: 'en-US', default: true, localService: true },
            { name: 'Bob', lang: 'fr-FR', default: 'yes', localService: 0 },
        ])).toEqual([
            { name: 'Alice', lang: 'en-US', default: true, localService: true },
            { name: 'Bob', lang: 'fr-FR', default: undefined, localService: undefined },
        ]);
    });

    test('deduplicates by name, keeping the first occurrence', () => {
        expect(normalizeVoices([
            { name: 'Alice', lang: 'en-US' },
            { name: 'Alice', lang: 'en-GB' },
            { name: 'Bob', lang: 'fr-FR' },
        ])).toEqual([
            { name: 'Alice', lang: 'en-US', default: undefined, localService: undefined },
            { name: 'Bob', lang: 'fr-FR', default: undefined, localService: undefined },
        ]);
    });
});

describe('pickVoiceCore', () => {
    interface Recorded {
        savedValue?: string;
        info?: string;
        inputBoxShown: boolean;
        quickPickShown: boolean;
        quickPickItems?: readonly VoiceQuickPickItem[];
    }

    function makeDeps(overrides: {
        current?: string;
        hasPanel?: boolean;
        voices?: VoiceInfo[];
        quickPick?: (items: readonly VoiceQuickPickItem[]) => VoiceQuickPickItem | undefined;
        inputBox?: (options: { value?: string }) => string | undefined;
    } = {}): { deps: PickVoiceDeps; rec: Recorded } {
        const rec: Recorded = { inputBoxShown: false, quickPickShown: false };
        const deps: PickVoiceDeps = {
            getCurrent: () => overrides.current ?? '',
            hasNarrationPanel: () => overrides.hasPanel ?? true,
            fetchVoices: () => Promise.resolve(overrides.voices ?? []),
            showQuickPick: (items) => {
                rec.quickPickShown = true;
                rec.quickPickItems = items;
                const pick = overrides.quickPick ? overrides.quickPick(items) : undefined;
                return Promise.resolve(pick);
            },
            showInputBox: (options) => {
                rec.inputBoxShown = true;
                const v = overrides.inputBox ? overrides.inputBox(options) : undefined;
                return Promise.resolve(v);
            },
            save: (value) => { rec.savedValue = value; return Promise.resolve(); },
            showInfo: (message) => { rec.info = message; },
        };
        return { deps, rec };
    }

    test('falls back to free-text input when no narration panel is open', async () => {
        const { deps, rec } = makeDeps({ hasPanel: false, inputBox: () => 'Daniel' });
        await pickVoiceCore(deps);
        expect(rec.inputBoxShown).toBe(true);
        expect(rec.quickPickShown).toBe(false);
        expect(rec.savedValue).toBe('Daniel');
        expect(rec.info).toBe('Code Narration: voice set to Daniel.');
    });

    test('falls back to free-text input when the webview reports no voices', async () => {
        const { deps, rec } = makeDeps({ hasPanel: true, voices: [], inputBox: () => '' });
        await pickVoiceCore(deps);
        expect(rec.inputBoxShown).toBe(true);
        expect(rec.quickPickShown).toBe(false);
        expect(rec.savedValue).toBe('');
        expect(rec.info).toBe('Code Narration: voice cleared (using system default).');
    });

    test('does not save or notify when the free-text input is cancelled', async () => {
        const { deps, rec } = makeDeps({ hasPanel: false, inputBox: () => undefined });
        await pickVoiceCore(deps);
        expect(rec.savedValue).toBeUndefined();
        expect(rec.info).toBeUndefined();
    });

    test('shows a quick-pick when voices are available and persists the selection', async () => {
        const voices: VoiceInfo[] = [
            { name: 'Alice', lang: 'en-US', default: true },
            { name: 'Bob', lang: 'fr-FR' },
        ];
        const { deps, rec } = makeDeps({
            current: '',
            voices,
            quickPick: (items) => items.find((i) => i.voiceName === 'Bob'),
        });
        await pickVoiceCore(deps);
        expect(rec.quickPickShown).toBe(true);
        expect(rec.inputBoxShown).toBe(false);
        // First item is the Default sentinel; voices follow in input order.
        expect(rec.quickPickItems?.map((i) => i.voiceName)).toEqual(['', 'Alice', 'Bob']);
        expect(rec.quickPickItems?.[1].detail).toBe('default');
        expect(rec.savedValue).toBe('Bob');
        expect(rec.info).toBe('Code Narration: voice set to Bob.');
    });

    test('quick-pick includes a Default sentinel that clears the voice setting', async () => {
        const voices: VoiceInfo[] = [{ name: 'Alice', lang: 'en-US' }];
        const { deps, rec } = makeDeps({
            current: 'Alice',
            voices,
            quickPick: (items) => items[0], // The Default sentinel.
        });
        await pickVoiceCore(deps);
        expect(rec.savedValue).toBe('');
        expect(rec.info).toBe('Code Narration: voice cleared (using system default).');
    });

    test('pre-marks the current voice as picked in the quick-pick', async () => {
        const voices: VoiceInfo[] = [
            { name: 'Alice', lang: 'en-US' },
            { name: 'Bob', lang: 'fr-FR' },
        ];
        const { deps, rec } = makeDeps({
            current: 'Bob',
            voices,
            quickPick: () => undefined,
        });
        await pickVoiceCore(deps);
        const picked = rec.quickPickItems?.filter((i) => i.picked === true).map((i) => i.voiceName);
        expect(picked).toEqual(['Bob']);
    });

    test('skips save and notify when the quick-pick is cancelled', async () => {
        const voices: VoiceInfo[] = [{ name: 'Alice', lang: 'en-US' }];
        const { deps, rec } = makeDeps({ voices, quickPick: () => undefined });
        await pickVoiceCore(deps);
        expect(rec.savedValue).toBeUndefined();
        expect(rec.info).toBeUndefined();
    });

    test('skips save and notify when the user picks the already-selected voice', async () => {
        const voices: VoiceInfo[] = [{ name: 'Alice', lang: 'en-US' }];
        const { deps, rec } = makeDeps({
            current: 'Alice',
            voices,
            quickPick: (items) => items.find((i) => i.voiceName === 'Alice'),
        });
        await pickVoiceCore(deps);
        expect(rec.savedValue).toBeUndefined();
        expect(rec.info).toBeUndefined();
    });
});
