import type { NarrationTarget } from './target';
import { targetMatchesSavedDoc, shouldFollowEditor } from './target';

/**
 * Per-source debounce timings for re-narration triggers. Co-located here so
 * the abstraction owns the timing policy, not the call sites.
 */
export const SAVE_DEBOUNCE_MS = 500;
export const REPO_STATE_DEBOUNCE_MS = 750;
export const ACTIVE_EDITOR_DEBOUNCE_MS = 250;
export const LIVE_EDIT_DEBOUNCE_MS = 1500;

export type TriggerSource = 'save' | 'repoState' | 'activeEditor' | 'liveEdit';

export interface TriggerRunOptions {
    skipCache?: boolean;
}

export interface TriggerEvaluation {
    /** Whether dispatch should be scheduled. */
    allow: boolean;
    /** Target to re-narrate. Required when allow=true. */
    target?: NarrationTarget;
    /** Per-event RunOptions (e.g. skipCache for HEAD moves). */
    options?: TriggerRunOptions;
}

export type TriggerEvaluator<TInput> = (input: TInput) => TriggerEvaluation;
export type TriggerDispatcher = (
    target: NarrationTarget,
    options: TriggerRunOptions | undefined,
) => void;

/**
 * Single point of truth for "is re-narration allowed now?" plus debounce
 * coalescing for a particular trigger source.
 *
 * Each source (save, repo state, active editor follow, live edit) creates its
 * own instance, parameterised by:
 * - `source` — used only for diagnostics today.
 * - `debounceMs` — coalesce window between successive `fire()` calls.
 * - `evaluate` — pure predicate returning the target to re-narrate (or
 *   `allow:false` to drop the event before the timer is armed).
 * - `dispatch` — terminal callback that runs the narration. Invoked once per
 *   debounce window, with the target snapshot from when the timer was armed.
 *
 * Behaviour intentionally preserved from the previous ad-hoc `setTimeout`
 * pattern in `extension.ts`:
 *   - Predicate is evaluated at `fire()` time. If it returns `allow:false`,
 *     no timer is started and any pending timer is left untouched (so a
 *     dropped event does not cancel a previously-armed dispatch).
 *   - Successive `fire()` calls with `allow:true` reset the timer and replace
 *     the captured target.
 *   - Dispatch fires unconditionally once the timer expires; callers rely on
 *     `runNarration` to bail out if global state (e.g. panel closed) has
 *     since changed.
 */
export class RenarrationTrigger<TInput> {
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(
        readonly source: TriggerSource,
        readonly debounceMs: number,
        private readonly evaluate: TriggerEvaluator<TInput>,
        private readonly dispatch: TriggerDispatcher,
    ) {}

    /**
     * Evaluate the predicate against `input`. On `allow:true`, (re-)arm the
     * debounce timer so dispatch runs after `debounceMs` of quiescence.
     */
    fire(input: TInput): void {
        const decision = this.evaluate(input);
        if (!decision.allow || !decision.target) return;
        const target = decision.target;
        const options = decision.options;
        if (this.timer !== undefined) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.dispatch(target, options);
        }, this.debounceMs);
    }

    /** Drop any pending dispatch without invoking it. */
    cancel(): void {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }

    /** True when a debounce timer is currently armed. */
    get pending(): boolean {
        return this.timer !== undefined;
    }
}

// ---------------------------------------------------------------------------
// Per-source predicates. Extracted as pure functions so the live extension
// can pass simple closures into RenarrationTrigger and tests can exercise
// the gating logic directly.
// ---------------------------------------------------------------------------

export interface SaveTriggerInput {
    panelOpen: boolean;
    currentTarget: NarrationTarget | undefined;
    narrateOnSave: boolean;
    savedDocUri: { toString(): string; fsPath?: string; path?: string; scheme?: string };
}

export function evaluateSaveTrigger(input: SaveTriggerInput): TriggerEvaluation {
    if (!input.panelOpen || !input.currentTarget) return { allow: false };
    if (!input.narrateOnSave) return { allow: false };
    if (!targetMatchesSavedDoc(input.currentTarget, input.savedDocUri as never)) {
        return { allow: false };
    }
    return { allow: true, target: input.currentTarget };
}

export interface RepoStateTriggerInput {
    panelOpen: boolean;
    currentTarget: NarrationTarget | undefined;
}

export function evaluateRepoStateTrigger(input: RepoStateTriggerInput): TriggerEvaluation {
    if (!input.panelOpen || !input.currentTarget) return { allow: false };
    return { allow: true, target: input.currentTarget };
}

export interface ActiveEditorTriggerInput {
    panelOpen: boolean;
    followEnabled: boolean;
    currentTarget: NarrationTarget | undefined;
    newDocUri: { toString(): string; scheme?: string } | undefined;
}

export function evaluateActiveEditorTrigger(input: ActiveEditorTriggerInput): TriggerEvaluation {
    if (!input.panelOpen) return { allow: false };
    const allow = shouldFollowEditor({
        newDocUri: input.newDocUri as never,
        newDocScheme: input.newDocUri?.scheme,
        currentTarget: input.currentTarget,
        followEnabled: input.followEnabled,
    });
    if (!allow || !input.newDocUri) return { allow: false };
    return { allow: true, target: { kind: 'file', uri: input.newDocUri as never } };
}

export interface LiveEditTriggerInput {
    panelOpen: boolean;
    liveEditEnabled: boolean;
    currentTarget: NarrationTarget | undefined;
    changedDocUri: { toString(): string };
}

/**
 * Predicate for #26 live-edit mode. Re-narration is allowed only when:
 *   - The narration panel is open.
 *   - The `codeNarration.liveEdit` setting is on.
 *   - The current target is a file narration (diff/tree targets are pinned).
 *   - The changed document is the one currently being narrated.
 *
 * "Stopped typing" is enforced by the trigger's debounce window, not here.
 */
export function evaluateLiveEditTrigger(input: LiveEditTriggerInput): TriggerEvaluation {
    if (!input.panelOpen || !input.currentTarget) return { allow: false };
    if (!input.liveEditEnabled) return { allow: false };
    if (input.currentTarget.kind !== 'file') return { allow: false };
    if (input.changedDocUri.toString() !== input.currentTarget.uri.toString()) {
        return { allow: false };
    }
    return { allow: true, target: input.currentTarget };
}
