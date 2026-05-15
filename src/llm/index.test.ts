import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { describeProvider, readProviderConfig, MissingApiKeyError } from './index';

const vscodeMock = vscode as unknown as {
    __setConfig: (key: string, value: unknown) => void;
    __resetConfig: () => void;
};
const __setConfig = vscodeMock.__setConfig;
const __resetConfig = vscodeMock.__resetConfig;

describe('describeProvider', () => {
    test('reports anthropic provider with its model', () => {
        expect(describeProvider({ kind: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-6', maxOutputTokens: 16384 }))
            .toEqual({ kind: 'anthropic', model: 'claude-sonnet-4-6' });
    });

    test('reports vscodeLm provider with its family when present', () => {
        expect(describeProvider({ kind: 'vscodeLm', modelFamily: 'gpt-4o' }))
            .toEqual({ kind: 'vscodeLm', model: 'gpt-4o' });
    });

    test('reports vscodeLm provider as "auto" when no family is configured', () => {
        expect(describeProvider({ kind: 'vscodeLm' }))
            .toEqual({ kind: 'vscodeLm', model: 'auto' });
    });
});

interface FakeSecrets {
    get: (key: string) => Promise<string | undefined>;
    store: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}

function fakeContext(initialKey?: string): vscode.ExtensionContext {
    const store = new Map<string, string>();
    if (initialKey !== undefined) store.set('codeNarration.anthropicApiKey', initialKey);
    const secrets: FakeSecrets = {
        get: async (k) => store.get(k),
        store: async (k, v) => { store.set(k, v); },
        delete: async (k) => { store.delete(k); },
    };
    return { secrets } as unknown as vscode.ExtensionContext;
}

describe('readProviderConfig', () => {
    beforeEach(() => __resetConfig());
    afterEach(() => __resetConfig());

    test('returns vscodeLm with no family when nothing is configured', async () => {
        const cfg = await readProviderConfig(fakeContext());
        expect(cfg).toEqual({ kind: 'vscodeLm', modelFamily: undefined });
    });

    test('returns vscodeLm with a family when modelFamily is set', async () => {
        __setConfig('vscodeLm.modelFamily', 'claude-sonnet-4');
        const cfg = await readProviderConfig(fakeContext());
        expect(cfg).toEqual({ kind: 'vscodeLm', modelFamily: 'claude-sonnet-4' });
    });

    test('returns anthropic config when provider=anthropic and a key is stored', async () => {
        __setConfig('provider', 'anthropic');
        __setConfig('anthropic.model', 'claude-opus-4-7');
        const cfg = await readProviderConfig(fakeContext('sk-test'));
        expect(cfg).toEqual({ kind: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-7', maxOutputTokens: 16384 });
    });

    test('returns anthropic config with the configured maxOutputTokens override', async () => {
        __setConfig('provider', 'anthropic');
        __setConfig('anthropic.model', 'claude-opus-4-7');
        __setConfig('anthropic.maxOutputTokens', 32000);
        const cfg = await readProviderConfig(fakeContext('sk-test'));
        expect(cfg).toEqual({ kind: 'anthropic', apiKey: 'sk-test', model: 'claude-opus-4-7', maxOutputTokens: 32000 });
    });

    test('falls back to the default maxOutputTokens when the setting is invalid', async () => {
        __setConfig('provider', 'anthropic');
        __setConfig('anthropic.maxOutputTokens', 0);
        const cfg = await readProviderConfig(fakeContext('sk-test'));
        expect(cfg).toMatchObject({ kind: 'anthropic', maxOutputTokens: 16384 });
    });

    test('throws MissingApiKeyError when provider=anthropic but no key is stored', async () => {
        __setConfig('provider', 'anthropic');
        await expect(readProviderConfig(fakeContext())).rejects.toBeInstanceOf(MissingApiKeyError);
    });
});
