import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { NarrationProvider } from './index';

export class AnthropicProvider implements NarrationProvider {
    private readonly client: Anthropic;

    constructor(apiKey: string, private readonly model: string) {
        this.client = new Anthropic({ apiKey });
    }

    async *stream(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): AsyncGenerator<string> {
        const abortController = new AbortController();
        const sub = token.onCancellationRequested(() => abortController.abort());
        try {
            const stream = this.client.messages.stream(
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
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    yield event.delta.text;
                }
            }
        } finally {
            sub.dispose();
        }
    }
}
