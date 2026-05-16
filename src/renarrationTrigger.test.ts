import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    RenarrationTrigger,
    SAVE_DEBOUNCE_MS,
    REPO_STATE_DEBOUNCE_MS,
    ACTIVE_EDITOR_DEBOUNCE_MS,
    LIVE_EDIT_DEBOUNCE_MS,
    evaluateSaveTrigger,
    evaluateRepoStateTrigger,
    evaluateActiveEditorTrigger,
    evaluateLiveEditTrigger,
} from './renarrationTrigger';
import type { NarrationTarget } from './target';

// A NarrationTarget literal good enough for predicates / dispatch identity.
function fileTarget(uri: string): NarrationTarget {
    return {
        kind: 'file',
        uri: { toString: () => uri, fsPath: uri, path: uri, scheme: 'file' } as never,
    };
}

function diffTarget(uri: string): NarrationTarget {
    return {
        kind: 'diff',
        baseRef: 'HEAD',
        uri: { toString: () => uri, fsPath: uri, path: uri, scheme: 'file' } as never,
    };
}

function docUri(s: string) {
    return { toString: () => s, fsPath: s, path: s, scheme: 'file' };
}

describe('RenarrationTrigger', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('debounces a single fire and dispatches once after the window', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///a');
        const trigger = new RenarrationTrigger<void>(
            'save',
            500,
            () => ({ allow: true, target }),
            dispatch,
        );

        trigger.fire();
        vi.advanceTimersByTime(499);
        expect(dispatch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(target, undefined);
    });

    test('coalesces simultaneous triggers within the debounce window', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///a');
        const trigger = new RenarrationTrigger<void>(
            'save',
            500,
            () => ({ allow: true, target }),
            dispatch,
        );

        trigger.fire();
        trigger.fire();
        trigger.fire();
        vi.advanceTimersByTime(499);
        expect(dispatch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('successive fires inside the window extend the timer (no dispatch until quiescence)', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///live');
        const trigger = new RenarrationTrigger<void>(
            'save',
            1500,
            () => ({ allow: true, target }),
            dispatch,
        );

        trigger.fire();
        vi.advanceTimersByTime(1000);
        trigger.fire();
        vi.advanceTimersByTime(1000);
        trigger.fire();
        vi.advanceTimersByTime(1499);
        expect(dispatch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('predicate returning allow=false prevents dispatch and arms no timer', () => {
        const dispatch = vi.fn();
        const trigger = new RenarrationTrigger<void>(
            'save',
            500,
            () => ({ allow: false }),
            dispatch,
        );

        trigger.fire();
        expect(trigger.pending).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(dispatch).not.toHaveBeenCalled();
    });

    test('predicate evaluated at fire-time uses the input it was given', () => {
        const dispatch = vi.fn();
        const seen: string[] = [];
        const trigger = new RenarrationTrigger<string>(
            'save',
            500,
            (id) => {
                seen.push(id);
                return id === 'allow'
                    ? { allow: true, target: fileTarget(`file:///${id}`) }
                    : { allow: false };
            },
            dispatch,
        );

        trigger.fire('deny');
        trigger.fire('allow');
        vi.advanceTimersByTime(500);

        expect(seen).toEqual(['deny', 'allow']);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toMatchObject({ kind: 'file' });
    });

    test('a denied fire does not cancel a previously-armed dispatch', () => {
        const dispatch = vi.fn();
        let mode: 'on' | 'off' = 'on';
        const target = fileTarget('file:///a');
        const trigger = new RenarrationTrigger<void>(
            'save',
            500,
            () => (mode === 'on' ? { allow: true, target } : { allow: false }),
            dispatch,
        );

        trigger.fire();
        expect(trigger.pending).toBe(true);
        mode = 'off';
        trigger.fire();
        expect(trigger.pending).toBe(true);
        vi.advanceTimersByTime(500);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    test('cancel() drops a pending dispatch', () => {
        const dispatch = vi.fn();
        const trigger = new RenarrationTrigger<void>(
            'save',
            500,
            () => ({ allow: true, target: fileTarget('file:///a') }),
            dispatch,
        );

        trigger.fire();
        trigger.cancel();
        expect(trigger.pending).toBe(false);
        vi.advanceTimersByTime(500);
        expect(dispatch).not.toHaveBeenCalled();
    });

    test('passes per-event options (e.g. skipCache) through to dispatch', () => {
        const dispatch = vi.fn();
        const target = diffTarget('file:///x');
        const trigger = new RenarrationTrigger<void>(
            'repoState',
            REPO_STATE_DEBOUNCE_MS,
            () => ({ allow: true, target, options: { skipCache: true } }),
            dispatch,
        );

        trigger.fire();
        vi.advanceTimersByTime(REPO_STATE_DEBOUNCE_MS);
        expect(dispatch).toHaveBeenCalledWith(target, { skipCache: true });
    });
});

describe('debounce constants match the policy preserved from extension.ts', () => {
    test('values', () => {
        expect(SAVE_DEBOUNCE_MS).toBe(500);
        expect(REPO_STATE_DEBOUNCE_MS).toBe(750);
        expect(ACTIVE_EDITOR_DEBOUNCE_MS).toBe(250);
        // #26 live-edit needs a longer settle window than save.
        expect(LIVE_EDIT_DEBOUNCE_MS).toBe(1500);
        expect(LIVE_EDIT_DEBOUNCE_MS).toBeGreaterThan(SAVE_DEBOUNCE_MS);
    });
});

describe('evaluateSaveTrigger', () => {
    const target = fileTarget('file:///doc');

    test('allows when panel open, target matches, and narrateOnSave is on', () => {
        const ev = evaluateSaveTrigger({
            panelOpen: true,
            currentTarget: target,
            narrateOnSave: true,
            savedDocUri: docUri('file:///doc'),
        });
        expect(ev.allow).toBe(true);
        expect(ev.target).toBe(target);
    });

    test('denies when panel is closed', () => {
        expect(evaluateSaveTrigger({
            panelOpen: false,
            currentTarget: target,
            narrateOnSave: true,
            savedDocUri: docUri('file:///doc'),
        }).allow).toBe(false);
    });

    test('denies when there is no current target', () => {
        expect(evaluateSaveTrigger({
            panelOpen: true,
            currentTarget: undefined,
            narrateOnSave: true,
            savedDocUri: docUri('file:///doc'),
        }).allow).toBe(false);
    });

    test('denies when narrateOnSave setting is off', () => {
        expect(evaluateSaveTrigger({
            panelOpen: true,
            currentTarget: target,
            narrateOnSave: false,
            savedDocUri: docUri('file:///doc'),
        }).allow).toBe(false);
    });

    test('denies when saved doc does not match the current file target', () => {
        expect(evaluateSaveTrigger({
            panelOpen: true,
            currentTarget: target,
            narrateOnSave: true,
            savedDocUri: docUri('file:///other'),
        }).allow).toBe(false);
    });
});

describe('evaluateRepoStateTrigger', () => {
    test('allows when panel is open and a target is set', () => {
        const target = fileTarget('file:///a');
        const ev = evaluateRepoStateTrigger({ panelOpen: true, currentTarget: target });
        expect(ev.allow).toBe(true);
        expect(ev.target).toBe(target);
    });

    test('denies when panel is closed', () => {
        const target = fileTarget('file:///a');
        expect(evaluateRepoStateTrigger({ panelOpen: false, currentTarget: target }).allow).toBe(false);
    });

    test('denies when there is no current target', () => {
        expect(evaluateRepoStateTrigger({ panelOpen: true, currentTarget: undefined }).allow).toBe(false);
    });
});

describe('evaluateActiveEditorTrigger', () => {
    const fileA = fileTarget('file:///a');
    const newEditorUri = { toString: () => 'file:///b', scheme: 'file' };

    test('allows when follow is on, target is file, and new doc differs', () => {
        const ev = evaluateActiveEditorTrigger({
            panelOpen: true,
            followEnabled: true,
            currentTarget: fileA,
            newDocUri: newEditorUri,
        });
        expect(ev.allow).toBe(true);
        expect(ev.target?.kind).toBe('file');
    });

    test('denies when follow setting is off', () => {
        expect(evaluateActiveEditorTrigger({
            panelOpen: true,
            followEnabled: false,
            currentTarget: fileA,
            newDocUri: newEditorUri,
        }).allow).toBe(false);
    });

    test('denies when panel is closed', () => {
        expect(evaluateActiveEditorTrigger({
            panelOpen: false,
            followEnabled: true,
            currentTarget: fileA,
            newDocUri: newEditorUri,
        }).allow).toBe(false);
    });

    test('denies when there is no new doc (editor closed)', () => {
        expect(evaluateActiveEditorTrigger({
            panelOpen: true,
            followEnabled: true,
            currentTarget: fileA,
            newDocUri: undefined,
        }).allow).toBe(false);
    });
});

describe('evaluateLiveEditTrigger (#26)', () => {
    const fileA = fileTarget('file:///a');

    test('allows when panel is open, setting is on, target is the file, and doc matches', () => {
        const ev = evaluateLiveEditTrigger({
            panelOpen: true,
            liveEditEnabled: true,
            currentTarget: fileA,
            changedDocUri: docUri('file:///a'),
        });
        expect(ev.allow).toBe(true);
        expect(ev.target).toBe(fileA);
    });

    test('denies when the setting is off', () => {
        const ev = evaluateLiveEditTrigger({
            panelOpen: true,
            liveEditEnabled: false,
            currentTarget: fileA,
            changedDocUri: docUri('file:///a'),
        });
        expect(ev.allow).toBe(false);
    });

    test('denies when the pane shows a different document', () => {
        const ev = evaluateLiveEditTrigger({
            panelOpen: true,
            liveEditEnabled: true,
            currentTarget: fileA,
            changedDocUri: docUri('file:///other'),
        });
        expect(ev.allow).toBe(false);
    });

    test('denies when the current target is a diff (pinned)', () => {
        const diff = diffTarget('file:///a');
        const ev = evaluateLiveEditTrigger({
            panelOpen: true,
            liveEditEnabled: true,
            currentTarget: diff,
            changedDocUri: docUri('file:///a'),
        });
        expect(ev.allow).toBe(false);
    });

    test('denies when the panel is closed', () => {
        const ev = evaluateLiveEditTrigger({
            panelOpen: false,
            liveEditEnabled: true,
            currentTarget: fileA,
            changedDocUri: docUri('file:///a'),
        });
        expect(ev.allow).toBe(false);
    });

    test('denies when there is no current target', () => {
        const ev = evaluateLiveEditTrigger({
            panelOpen: true,
            liveEditEnabled: true,
            currentTarget: undefined,
            changedDocUri: docUri('file:///a'),
        });
        expect(ev.allow).toBe(false);
    });
});

describe('RenarrationTrigger wired with evaluateLiveEditTrigger (#26 integration)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    test('coalesces a burst of edit events into a single dispatch', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///live');
        const trigger = new RenarrationTrigger<{ toString(): string }>(
            'liveEdit',
            LIVE_EDIT_DEBOUNCE_MS,
            (changedUri) => evaluateLiveEditTrigger({
                panelOpen: true,
                liveEditEnabled: true,
                currentTarget: target,
                changedDocUri: changedUri,
            }),
            dispatch,
        );

        for (let i = 0; i < 10; i++) {
            trigger.fire(docUri('file:///live'));
            vi.advanceTimersByTime(100);
        }
        expect(dispatch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(LIVE_EDIT_DEBOUNCE_MS);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith(target, undefined);
    });

    test('does not fire when the changed document is different from the target', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///live');
        const trigger = new RenarrationTrigger<{ toString(): string }>(
            'liveEdit',
            LIVE_EDIT_DEBOUNCE_MS,
            (changedUri) => evaluateLiveEditTrigger({
                panelOpen: true,
                liveEditEnabled: true,
                currentTarget: target,
                changedDocUri: changedUri,
            }),
            dispatch,
        );

        trigger.fire(docUri('file:///somewhere/else'));
        vi.advanceTimersByTime(LIVE_EDIT_DEBOUNCE_MS * 2);
        expect(dispatch).not.toHaveBeenCalled();
    });

    test('does not fire when liveEdit setting is off', () => {
        const dispatch = vi.fn();
        const target = fileTarget('file:///live');
        let enabled = false;
        const trigger = new RenarrationTrigger<{ toString(): string }>(
            'liveEdit',
            LIVE_EDIT_DEBOUNCE_MS,
            (changedUri) => evaluateLiveEditTrigger({
                panelOpen: true,
                liveEditEnabled: enabled,
                currentTarget: target,
                changedDocUri: changedUri,
            }),
            dispatch,
        );

        trigger.fire(docUri('file:///live'));
        vi.advanceTimersByTime(LIVE_EDIT_DEBOUNCE_MS * 2);
        expect(dispatch).not.toHaveBeenCalled();

        enabled = true;
        trigger.fire(docUri('file:///live'));
        vi.advanceTimersByTime(LIVE_EDIT_DEBOUNCE_MS);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
