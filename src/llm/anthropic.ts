import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { NarrationProvider } from './index';

export class AnthropicProvider implements NarrationProvider {
    private readonly client: Anthropic;

    constructor(apiKey: string, private readonly model: string) {
        this.client = new Anthropic({ apiKey });
    }

    async narrate(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): Promise<string> {
        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        try {
            const response = await this.client.messages.create(
                {
                    model: this.model,
                    max_tokens: 8192,
                    system: [
                        {
                            type: 'text',
                            text: systemPrompt,
                            cache_control: { type: 'ephemeral' },
                        },
                    ],
                    messages: [{ role: 'user', content: userPrompt }],
                },
                { signal: abortController.signal },
            );

            return response.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('');
        } finally {
            cancelSub.dispose();
        }
    }
}
