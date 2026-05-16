import { describe, test, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
    SYSTEM_PROMPT,
    SYMBOL_SYSTEM_PROMPT,
    DIFF_SYSTEM_PROMPT,
    TREE_SUMMARY_SYSTEM_PROMPT,
    TREE_FILE_DIFF_SYSTEM_PROMPT,
} from './prompt';
import {
    DEFAULT_PERSONA_ID,
    Persona,
    buildPersonaFromLens,
    getBuiltInPersona,
    getDefaultPersona,
    hashPersonaPrompts,
    listBuiltInPersonaIds,
    readPersonaIdFromConfig,
    resolvePersona,
    validateCustomPersonas,
    loadCustomPersonasFromConfig,
    CUSTOM_PROMPT_MAX_CHARS,
} from './personas';

const vscodeMock = vscode as unknown as {
    __setConfig: (key: string, value: unknown) => void;
    __resetConfig: () => void;
};
const __setConfig = vscodeMock.__setConfig;
const __resetConfig = vscodeMock.__resetConfig;

describe('built-in persona registry', () => {
    test('exposes the v1 personas in display order', () => {
        expect(listBuiltInPersonaIds()).toEqual([
            'default',
            'critical',
            'security',
            'performance',
            'tests',
            'onboarding',
        ]);
    });

    test('every built-in persona has all five prompt fields populated', () => {
        for (const id of listBuiltInPersonaIds()) {
            const p = getBuiltInPersona(id);
            expect(p, `built-in persona ${id} should exist`).toBeDefined();
            const persona = p as Persona;
            expect(persona.source).toBe('builtin');
            expect(persona.prompts.system.length).toBeGreaterThan(0);
            expect(persona.prompts.symbolSystem.length).toBeGreaterThan(0);
            expect(persona.prompts.diffSystem.length).toBeGreaterThan(0);
            expect(persona.prompts.treeSummarySystem.length).toBeGreaterThan(0);
            expect(persona.prompts.treeFileDiffSystem.length).toBeGreaterThan(0);
        }
    });

    test('default persona prompts are byte-for-byte identical to the originals', () => {
        const def = getDefaultPersona();
        expect(def.id).toBe(DEFAULT_PERSONA_ID);
        expect(def.prompts.system).toBe(SYSTEM_PROMPT);
        expect(def.prompts.symbolSystem).toBe(SYMBOL_SYSTEM_PROMPT);
        expect(def.prompts.diffSystem).toBe(DIFF_SYSTEM_PROMPT);
        expect(def.prompts.treeSummarySystem).toBe(TREE_SUMMARY_SYSTEM_PROMPT);
        expect(def.prompts.treeFileDiffSystem).toBe(TREE_FILE_DIFF_SYSTEM_PROMPT);
    });

    test('non-default personas prepend a lens preamble onto every prompt', () => {
        for (const id of listBuiltInPersonaIds()) {
            if (id === DEFAULT_PERSONA_ID) continue;
            const persona = getBuiltInPersona(id)!;
            // The base prompt should still be present at the tail so output
            // formatting rules (line-numbered links, no fenced code blocks)
            // survive — only the lens changes.
            expect(persona.prompts.system.endsWith(SYSTEM_PROMPT)).toBe(true);
            expect(persona.prompts.symbolSystem.endsWith(SYMBOL_SYSTEM_PROMPT)).toBe(true);
            expect(persona.prompts.diffSystem.endsWith(DIFF_SYSTEM_PROMPT)).toBe(true);
            expect(persona.prompts.treeSummarySystem.endsWith(TREE_SUMMARY_SYSTEM_PROMPT)).toBe(true);
            expect(persona.prompts.treeFileDiffSystem.endsWith(TREE_FILE_DIFF_SYSTEM_PROMPT)).toBe(true);
            expect(persona.prompts.system.length).toBeGreaterThan(SYSTEM_PROMPT.length);
        }
    });

    test('each non-default persona has a distinguishing preamble', () => {
        const fragments: Record<string, RegExp> = {
            critical: /critical pull-request reviewer/i,
            security: /security lens/i,
            performance: /performance lens/i,
            tests: /test-gap/i,
            onboarding: /new to the codebase/i,
        };
        for (const [id, re] of Object.entries(fragments)) {
            const persona = getBuiltInPersona(id)!;
            expect(persona.prompts.system).toMatch(re);
            expect(persona.prompts.symbolSystem).toMatch(re);
        }
    });

    test('built-in cache tags are unique per persona', () => {
        const tags = listBuiltInPersonaIds().map((id) => getBuiltInPersona(id)!.cacheTag);
        expect(new Set(tags).size).toBe(tags.length);
    });
});

describe('resolvePersona', () => {
    test('returns the requested built-in persona when the id matches', () => {
        const p = resolvePersona('security');
        expect(p.id).toBe('security');
    });

    test('falls back to the default persona for an unknown id', () => {
        const p = resolvePersona('does-not-exist');
        expect(p.id).toBe(DEFAULT_PERSONA_ID);
    });

    test('falls back to the default persona when no id is supplied', () => {
        const p = resolvePersona(undefined);
        expect(p.id).toBe(DEFAULT_PERSONA_ID);
    });

    test('custom personas passed via `extra` take precedence over built-ins', () => {
        const custom = buildPersonaFromLens({
            id: 'critical',
            label: 'Custom critical',
            description: 'overridden',
            preamble: 'OVERRIDDEN',
        });
        const extra = new Map([[custom.id, custom]]);
        const p = resolvePersona('critical', extra);
        expect(p.label).toBe('Custom critical');
        expect(p.source).toBe('custom');
    });
});

describe('readPersonaIdFromConfig', () => {
    beforeEach(() => __resetConfig());

    test('returns the configured value when present', () => {
        __setConfig('persona', 'security');
        expect(readPersonaIdFromConfig()).toBe('security');
    });

    test('falls back to the default persona id for empty/missing config', () => {
        expect(readPersonaIdFromConfig()).toBe(DEFAULT_PERSONA_ID);
        __setConfig('persona', '');
        expect(readPersonaIdFromConfig()).toBe(DEFAULT_PERSONA_ID);
    });
});

describe('buildPersonaFromLens (custom persona helper)', () => {
    test('produces a persona that shares the built-in output rules', () => {
        const p = buildPersonaFromLens({
            id: 'pci-aware',
            label: 'PCI-aware reviewer',
            description: 'A fintech house style.',
            preamble: 'You are reviewing this code with PCI-DSS in mind.',
        });
        expect(p.source).toBe('custom');
        expect(p.prompts.system).toContain('PCI-DSS');
        expect(p.prompts.system.endsWith(SYSTEM_PROMPT)).toBe(true);
    });

    test('cache tag changes when the preamble changes', () => {
        const a = buildPersonaFromLens({ id: 'x', label: 'x', description: 'x', preamble: 'A' });
        const b = buildPersonaFromLens({ id: 'x', label: 'x', description: 'x', preamble: 'B' });
        expect(a.cacheTag).not.toBe(b.cacheTag);
    });

    test('hashPersonaPrompts is deterministic', () => {
        const p = buildPersonaFromLens({ id: 'x', label: 'x', description: 'x', preamble: 'A' });
        const h1 = hashPersonaPrompts(p.prompts);
        const h2 = hashPersonaPrompts(p.prompts);
        expect(h1).toBe(h2);
        expect(h1.length).toBe(16);
    });
});

describe('validateCustomPersonas (#24)', () => {
    test('returns an empty result for missing/null config', () => {
        const empty = validateCustomPersonas(undefined);
        expect(empty.personas.size).toBe(0);
        expect(empty.errors).toEqual([]);
        const nul = validateCustomPersonas(null);
        expect(nul.personas.size).toBe(0);
        expect(nul.errors).toEqual([]);
    });

    test('reports a top-level error when the value is not an object', () => {
        const { personas, errors } = validateCustomPersonas([]);
        expect(personas.size).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toMatch(/object map/);
    });

    test('accepts a valid preamble-only entry and composes onto the base prompts', () => {
        const { personas, errors } = validateCustomPersonas({
            'pci-aware': {
                displayName: 'PCI-aware reviewer',
                description: 'Fintech house style.',
                preamble: 'You are reviewing with PCI-DSS in mind.',
            },
        });
        expect(errors).toEqual([]);
        const p = personas.get('pci-aware');
        expect(p, 'expected pci-aware persona').toBeDefined();
        expect((p as Persona).source).toBe('custom');
        expect((p as Persona).label).toBe('PCI-aware reviewer');
        expect((p as Persona).prompts.system).toContain('PCI-DSS');
        // Base output rules still applied to every prompt slot.
        expect((p as Persona).prompts.system.endsWith(SYSTEM_PROMPT)).toBe(true);
        expect((p as Persona).prompts.symbolSystem.endsWith(SYMBOL_SYSTEM_PROMPT)).toBe(true);
        expect((p as Persona).prompts.diffSystem.endsWith(DIFF_SYSTEM_PROMPT)).toBe(true);
        expect((p as Persona).prompts.treeSummarySystem.endsWith(TREE_SUMMARY_SYSTEM_PROMPT)).toBe(true);
        expect((p as Persona).prompts.treeFileDiffSystem.endsWith(TREE_FILE_DIFF_SYSTEM_PROMPT)).toBe(true);
    });

    test('accepts full prompt overrides and skips composition for overridden slots', () => {
        const { personas, errors } = validateCustomPersonas({
            'fully-custom': {
                displayName: 'Fully custom',
                systemPrompt: 'CUSTOM SYS',
                symbolSystemPrompt: 'CUSTOM SYM',
                diffSystemPrompt: 'CUSTOM DIFF',
            },
        });
        expect(errors).toEqual([]);
        const p = personas.get('fully-custom') as Persona;
        expect(p.prompts.system).toBe('CUSTOM SYS');
        expect(p.prompts.symbolSystem).toBe('CUSTOM SYM');
        expect(p.prompts.diffSystem).toBe('CUSTOM DIFF');
        // Non-overridden slots fall back to the base prompts.
        expect(p.prompts.treeSummarySystem).toBe(TREE_SUMMARY_SYSTEM_PROMPT);
        expect(p.prompts.treeFileDiffSystem).toBe(TREE_FILE_DIFF_SYSTEM_PROMPT);
    });

    test('cache tag changes when prompts change so edits invalidate the cache', () => {
        const a = validateCustomPersonas({ 'p': { preamble: 'A' } }).personas.get('p') as Persona;
        const b = validateCustomPersonas({ 'p': { preamble: 'B' } }).personas.get('p') as Persona;
        expect(a.cacheTag).not.toBe(b.cacheTag);
        expect(a.cacheTag.startsWith('custom:p:')).toBe(true);
    });

    test('rejects malformed ids without dropping the other entries', () => {
        const { personas, errors } = validateCustomPersonas({
            '': { preamble: 'x' },
            'has spaces': { preamble: 'x' },
            'has/slash': { preamble: 'x' },
            'good-one': { preamble: 'still loads' },
        });
        expect(personas.size).toBe(1);
        expect(personas.has('good-one')).toBe(true);
        expect(errors.length).toBe(3);
    });

    test('rejects ids that collide with built-in personas', () => {
        const { personas, errors } = validateCustomPersonas({
            security: { preamble: 'override attempt' },
        });
        expect(personas.size).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].id).toBe('security');
        expect(errors[0].reason).toMatch(/built-in/);
    });

    test('rejects entries with no prompt content at all', () => {
        const { personas, errors } = validateCustomPersonas({
            'empty': { displayName: 'Empty' },
        });
        expect(personas.size).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toMatch(/at least one/);
    });

    test('rejects oversize prompt strings to prevent silent breakage', () => {
        const huge = 'x'.repeat(CUSTOM_PROMPT_MAX_CHARS + 1);
        const { personas, errors } = validateCustomPersonas({
            'big': { systemPrompt: huge },
        });
        expect(personas.size).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toMatch(/exceeds .*-character limit/);
    });

    test('rejects entries where a field is the wrong type', () => {
        const { personas, errors } = validateCustomPersonas({
            'p': { preamble: 123 },
        });
        expect(personas.size).toBe(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].reason).toMatch(/must be a string/);
    });

    test('resolvePersona looks custom personas up before built-ins', () => {
        const custom = validateCustomPersonas({
            'house-style': { preamble: 'house lens' },
        }).personas;
        const p = resolvePersona('house-style', custom);
        expect(p.id).toBe('house-style');
        expect(p.source).toBe('custom');
    });

    test('loadCustomPersonasFromConfig reads the setting via the workspace config API', () => {
        __setConfig('customPersonas', {
            'house-style': { preamble: 'house lens' },
        });
        const { personas, errors } = loadCustomPersonasFromConfig();
        expect(errors).toEqual([]);
        expect(personas.has('house-style')).toBe(true);
    });
});
