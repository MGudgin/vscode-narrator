import * as vscode from 'vscode';
import { VSCodeLmProvider } from './vscodeLm';
import { AnthropicProvider } from './anthropic';

export interface NarrationProvider {
    stream(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): AsyncIterable<string>;
}

export interface ProviderInfo {
    kind: string;
    model: string;
}

export class MissingApiKeyError extends Error {
    constructor() {
        super('Anthropic API key is not set. Run "Code Narration: Set Anthropic API Key" from the command palette.');
        this.name = 'MissingApiKeyError';
    }
}

export type ProviderConfig =
    | { kind: 'vscodeLm'; modelFamily?: string }
    | { kind: 'anthropic'; apiKey: string; model: string };

const ANTHROPIC_KEY_SECRET = 'codeNarration.anthropicApiKey';

export async function readProviderConfig(context: vscode.ExtensionContext): Promise<ProviderConfig> {
    const config = vscode.workspace.getConfiguration('codeNarration');
    const providerName = config.get<string>('provider', 'vscodeLm');

    if (providerName === 'anthropic') {
        const apiKey = await context.secrets.get(ANTHROPIC_KEY_SECRET);
        if (!apiKey) throw new MissingApiKeyError();
        const model = config.get<string>('anthropic.model', 'claude-sonnet-4-6');
        return { kind: 'anthropic', apiKey, model };
    }

    const family = config.get<string>('vscodeLm.modelFamily', '');
    return { kind: 'vscodeLm', modelFamily: family || undefined };
}

export function makeProvider(config: ProviderConfig): NarrationProvider {
    if (config.kind === 'anthropic') return new AnthropicProvider(config.apiKey, config.model);
    return new VSCodeLmProvider(config.modelFamily);
}

export function describeProvider(config: ProviderConfig): ProviderInfo {
    if (config.kind === 'anthropic') return { kind: 'anthropic', model: config.model };
    return { kind: 'vscodeLm', model: config.modelFamily ?? 'auto' };
}

export async function storeAnthropicKey(context: vscode.ExtensionContext, key: string): Promise<void> {
    await context.secrets.store(ANTHROPIC_KEY_SECRET, key);
}

export async function clearAnthropicKey(context: vscode.ExtensionContext): Promise<void> {
    await context.secrets.delete(ANTHROPIC_KEY_SECRET);
}
