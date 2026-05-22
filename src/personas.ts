import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    DIFF_SYSTEM_PROMPT,
    TREE_SUMMARY_SYSTEM_PROMPT,
    TREE_FILE_DIFF_SYSTEM_PROMPT,
} from './prompt';

/**
 * A persona scopes the *lens* used when narrating code, without changing the
 * output formatting rules (line-numbered links, no fenced code blocks, etc.).
 *
 * Built-in personas are composed by prepending a short "lens preamble" to the
 * base system prompts exported from `prompt.ts`. Custom personas (#24) can
 * either supply full prompts or extend the same base prompts via
 * `composePromptsFromLens`.
 */
export interface PersonaPrompts {
    /** System prompt for whole-file narration. */
    system: string;
    /** System prompt for a single symbol section. */
    symbolSystem: string;
    /** System prompt for single-file diff narration. */
    diffSystem: string;
    /** System prompt for the tree-diff summary section. */
    treeSummarySystem: string;
    /** System prompt for per-file tree-diff narration. */
    treeFileDiffSystem: string;
}

export type PersonaSource = 'builtin' | 'custom';

export interface Persona {
    id: string;
    label: string;
    description: string;
    source: PersonaSource;
    /**
     * Component mixed into cache keys so switching personas invalidates stale
     * narrations. For built-ins this is just the id (their prompts are part of
     * the source tree and travel with `PROMPT_VERSION`). For custom personas
     * (#24) this also includes a content hash so editing a prompt evicts the
     * cache entries that used it.
     */
    cacheTag: string;
    prompts: PersonaPrompts;
}

export const DEFAULT_PERSONA_ID = 'default';

/**
 * Lens preamble used to focus a built-in persona's narration on a particular
 * review style. The base output rules from `prompt.ts` follow on a fresh line,
 * so the model still produces line-numbered links and skips fenced code blocks.
 */
interface PersonaLens {
    id: string;
    label: string;
    description: string;
    /** Sentence(s) prepended to every system prompt. Empty for the default persona. */
    preamble: string;
}

const BUILT_IN_LENSES: PersonaLens[] = [
    {
        id: DEFAULT_PERSONA_ID,
        label: 'Default',
        description: 'What does this code do and why does it exist?',
        preamble: '',
    },
    {
        id: 'critical',
        label: 'Critical reviewer',
        description: "What's questionable, missing, or risky? Pushback you'd raise in PR review.",
        preamble:
            "You are reviewing this code as a critical pull-request reviewer. Lead with what's questionable, missing, or risky: brittle assumptions, error-handling gaps, racy interactions, missing tests, dead branches, surprising defaults. Be specific and actionable; do not pad with restatement of obvious behavior.",
    },
    {
        id: 'security',
        label: 'Security reviewer',
        description: 'Untrusted input flow, auth, injection, secrets, dependency risks.',
        preamble:
            'You are reviewing this code through a security lens. Trace where untrusted input enters and how it flows. Call out: authentication and authorization gaps, injection vectors (SQL, command, path, template, prototype-pollution), unsafe deserialization, secrets in code, weak crypto, SSRF, time-of-check/time-of-use, and risky third-party calls. Distinguish suspected from confirmed issues; do not invent vulnerabilities.',
    },
    {
        id: 'performance',
        label: 'Performance reviewer',
        description: 'Hot paths, allocations, blocking calls, async pitfalls, big-O concerns.',
        preamble:
            'You are reviewing this code through a performance lens. Focus on hot paths, algorithmic complexity, allocation pressure, repeated work, synchronous I/O on async paths, lock contention, and unnecessary copies. Mention specific structures or call sites; avoid generic advice.',
    },
    {
        id: 'tests',
        label: 'Test gap reviewer',
        description: "Branches and edge cases that aren't covered. What tests would I write?",
        preamble:
            'You are reviewing this code as a test-gap analyst. Identify branches, edge cases, and failure modes that look uncovered by existing tests. For each gap suggest a concrete test (input, expected behavior). Prefer behaviour-level tests over implementation details.',
    },
    {
        id: 'onboarding',
        label: 'Onboarding guide',
        description: 'Explain this to someone new. Frame intent before mechanics.',
        preamble:
            "You are explaining this code to a developer new to the codebase. Lead with intent and the role this code plays before describing mechanics. Anchor in concrete examples of how it gets used. Avoid jargon that a newcomer wouldn't have context for; define terms when they first appear.",
    },
];

function composePromptsFromLens(preamble: string): PersonaPrompts {
    if (preamble.length === 0) {
        return {
            system: SYSTEM_PROMPT,
            symbolSystem: SYMBOL_SYSTEM_PROMPT,
            diffSystem: DIFF_SYSTEM_PROMPT,
            treeSummarySystem: TREE_SUMMARY_SYSTEM_PROMPT,
            treeFileDiffSystem: TREE_FILE_DIFF_SYSTEM_PROMPT,
        };
    }
    const prefix = `${preamble}\n\n`;
    return {
        system: prefix + SYSTEM_PROMPT,
        symbolSystem: prefix + SYMBOL_SYSTEM_PROMPT,
        diffSystem: prefix + DIFF_SYSTEM_PROMPT,
        treeSummarySystem: prefix + TREE_SUMMARY_SYSTEM_PROMPT,
        treeFileDiffSystem: prefix + TREE_FILE_DIFF_SYSTEM_PROMPT,
    };
}

const BUILT_IN_PERSONAS: ReadonlyMap<string, Persona> = (() => {
    const map = new Map<string, Persona>();
    for (const lens of BUILT_IN_LENSES) {
        map.set(lens.id, {
            id: lens.id,
            label: lens.label,
            description: lens.description,
            source: 'builtin',
            cacheTag: `builtin:${lens.id}`,
            prompts: composePromptsFromLens(lens.preamble),
        });
    }
    return map;
})();

/** Built-in persona ids in display order. */
export function listBuiltInPersonaIds(): string[] {
    return BUILT_IN_LENSES.map((l) => l.id);
}

/** Return the built-in persona with the given id, or undefined. */
export function getBuiltInPersona(id: string): Persona | undefined {
    return BUILT_IN_PERSONAS.get(id);
}

/** Stable default persona, never undefined. */
export function getDefaultPersona(): Persona {
    return BUILT_IN_PERSONAS.get(DEFAULT_PERSONA_ID)!;
}

/**
 * Resolve a persona by id, falling back to the default persona when the id is
 * unknown. Custom personas (#24) extend this lookup by passing them via
 * `extra`.
 */
export function resolvePersona(id: string | undefined, extra?: ReadonlyMap<string, Persona>): Persona {
    if (id) {
        if (extra) {
            const hit = extra.get(id);
            if (hit) return hit;
        }
        const builtIn = BUILT_IN_PERSONAS.get(id);
        if (builtIn) return builtIn;
    }
    return getDefaultPersona();
}

/**
 * Read the persona id from settings. Unknown values fall back to the default
 * persona id at resolution time, not here, so the raw setting remains visible
 * for diagnostics.
 */
export function readPersonaIdFromConfig(): string {
    const cfg = vscode.workspace.getConfiguration('codeNarration');
    const raw = cfg.get<string>('persona', DEFAULT_PERSONA_ID);
    return typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_PERSONA_ID;
}

/** Short hash helper used by custom persona cache tags. */
export function hashPersonaPrompts(prompts: PersonaPrompts): string {
    const h = crypto.createHash('sha256');
    h.update(prompts.system);
    h.update('\x1f');
    h.update(prompts.symbolSystem);
    h.update('\x1f');
    h.update(prompts.diffSystem);
    h.update('\x1f');
    h.update(prompts.treeSummarySystem);
    h.update('\x1f');
    h.update(prompts.treeFileDiffSystem);
    return h.digest('hex').slice(0, 16);
}

/**
 * Compose a Persona from a free-form lens preamble. Intended for custom
 * personas (#24) that want to share the built-in output rules.
 */
export function buildPersonaFromLens(args: {
    id: string;
    label: string;
    description: string;
    preamble: string;
}): Persona {
    const prompts = composePromptsFromLens(args.preamble);
    return {
        id: args.id,
        label: args.label,
        description: args.description,
        source: 'custom',
        cacheTag: `custom:${args.id}:${hashPersonaPrompts(prompts)}`,
        prompts,
    };
}

/**
 * Maximum length of a single user-supplied prompt string. Prevents a
 * malformed config from silently breaking narration (e.g. a 1 MB blob
 * blowing past the model's context window).
 */
export const CUSTOM_PROMPT_MAX_CHARS = 8_000;

/** Maximum length of a displayName / id / description. */
export const CUSTOM_LABEL_MAX_CHARS = 120;

/** Per-id field shape accepted in the `codeNarration.customPersonas` setting. */
export interface CustomPersonaSpec {
    /** User-visible name; shown in quick-pick. */
    displayName?: string;
    /** One-line description; shown in quick-pick detail. */
    description?: string;
    /**
     * Optional lens preamble. If provided, slots not overridden below are
     * composed by prepending this sentence to the built-in base prompts.
     */
    preamble?: string;
    /** Full override for whole-file narration. */
    systemPrompt?: string;
    /** Full override for symbol-section narration. */
    symbolSystemPrompt?: string;
    /** Full override for diff narration. */
    diffSystemPrompt?: string;
    /** Full override for tree-diff summary narration. */
    treeSummarySystemPrompt?: string;
    /** Full override for per-file tree-diff narration. */
    treeFileDiffSystemPrompt?: string;
}

export interface CustomPersonaError {
    id: string;
    reason: string;
}

export interface LoadCustomPersonasResult {
    personas: Map<string, Persona>;
    errors: CustomPersonaError[];
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateString(
    field: string,
    value: unknown,
    maxLen: number,
    required: boolean,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
    if (value === undefined || value === null) {
        if (required) return { ok: false, reason: `missing required field "${field}"` };
        return { ok: true, value: undefined };
    }
    if (typeof value !== 'string') {
        return { ok: false, reason: `field "${field}" must be a string` };
    }
    if (value.length > maxLen) {
        return { ok: false, reason: `field "${field}" exceeds ${maxLen}-character limit (${value.length})` };
    }
    return { ok: true, value };
}

/**
 * Build a Persona from a validated custom spec. Slots not provided fall back
 * to the lens preamble (if any) layered on the base prompts, which gives the
 * user the "default boilerplate" they can extend without re-specifying the
 * shared output formatting rules.
 */
function personaFromSpec(id: string, spec: CustomPersonaSpec): Persona {
    const base = composePromptsFromLens(spec.preamble ?? '');
    const prompts: PersonaPrompts = {
        system: spec.systemPrompt ?? base.system,
        symbolSystem: spec.symbolSystemPrompt ?? base.symbolSystem,
        diffSystem: spec.diffSystemPrompt ?? base.diffSystem,
        treeSummarySystem: spec.treeSummarySystemPrompt ?? base.treeSummarySystem,
        treeFileDiffSystem: spec.treeFileDiffSystemPrompt ?? base.treeFileDiffSystem,
    };
    const label = spec.displayName && spec.displayName.length > 0 ? spec.displayName : id;
    const description = spec.description ?? '';
    return {
        id,
        label,
        description,
        source: 'custom',
        cacheTag: `custom:${id}:${hashPersonaPrompts(prompts)}`,
        prompts,
    };
}

/**
 * Validate a raw `codeNarration.customPersonas` value and return the
 * persona map plus a list of per-entry errors. Malformed entries are skipped
 * rather than failing the whole map, so a single typo doesn't break the
 * other custom personas.
 *
 * Visible for tests; the runtime entry point is `loadCustomPersonasFromConfig`.
 */
export function validateCustomPersonas(raw: unknown): LoadCustomPersonasResult {
    const personas = new Map<string, Persona>();
    const errors: CustomPersonaError[] = [];

    if (raw === undefined || raw === null) {
        return { personas, errors };
    }
    if (!isPlainObject(raw)) {
        errors.push({ id: '', reason: '`codeNarration.customPersonas` must be an object map keyed by persona id' });
        return { personas, errors };
    }

    for (const [id, entry] of Object.entries(raw)) {
        if (!ID_RE.test(id)) {
            errors.push({
                id,
                reason: 'persona id must be 1-64 chars of letters, digits, hyphen, or underscore (start with a letter or digit)',
            });
            continue;
        }
        if (BUILT_IN_PERSONAS.has(id)) {
            errors.push({ id, reason: `persona id "${id}" collides with a built-in persona; choose another id` });
            continue;
        }
        if (!isPlainObject(entry)) {
            errors.push({ id, reason: 'persona entry must be an object' });
            continue;
        }

        const fields: Array<[keyof CustomPersonaSpec, number, boolean]> = [
            ['displayName', CUSTOM_LABEL_MAX_CHARS, false],
            ['description', CUSTOM_LABEL_MAX_CHARS, false],
            ['preamble', CUSTOM_PROMPT_MAX_CHARS, false],
            ['systemPrompt', CUSTOM_PROMPT_MAX_CHARS, false],
            ['symbolSystemPrompt', CUSTOM_PROMPT_MAX_CHARS, false],
            ['diffSystemPrompt', CUSTOM_PROMPT_MAX_CHARS, false],
            ['treeSummarySystemPrompt', CUSTOM_PROMPT_MAX_CHARS, false],
            ['treeFileDiffSystemPrompt', CUSTOM_PROMPT_MAX_CHARS, false],
        ];
        const spec: CustomPersonaSpec = {};
        let fieldError: string | undefined;
        for (const [name, maxLen, required] of fields) {
            const res = validateString(name as string, entry[name as string], maxLen, required);
            if (!res.ok) {
                fieldError = res.reason;
                break;
            }
            if (res.value !== undefined) {
                (spec as Record<string, string>)[name as string] = res.value;
            }
        }
        if (fieldError) {
            errors.push({ id, reason: fieldError });
            continue;
        }

        // Reject entries that contribute no override at all — they would be
        // indistinguishable from the default persona and just clutter the
        // quick-pick.
        const hasAnyPrompt = Boolean(
            spec.preamble ||
                spec.systemPrompt ||
                spec.symbolSystemPrompt ||
                spec.diffSystemPrompt ||
                spec.treeSummarySystemPrompt ||
                spec.treeFileDiffSystemPrompt,
        );
        if (!hasAnyPrompt) {
            errors.push({ id, reason: 'persona must define at least one of: preamble, systemPrompt, symbolSystemPrompt, diffSystemPrompt, treeSummarySystemPrompt, treeFileDiffSystemPrompt' });
            continue;
        }

        personas.set(id, personaFromSpec(id, spec));
    }

    return { personas, errors };
}

/**
 * Runtime entry point: read `codeNarration.customPersonas` from VS Code
 * settings and produce a validated persona map. Errors are returned alongside
 * the (possibly partial) map so the caller can surface them as a one-shot
 * warning rather than failing narration.
 */
export function loadCustomPersonasFromConfig(): LoadCustomPersonasResult {
    const cfg = vscode.workspace.getConfiguration('codeNarration');
    const raw = cfg.get<unknown>('customPersonas');
    return validateCustomPersonas(raw);
}
