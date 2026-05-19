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
