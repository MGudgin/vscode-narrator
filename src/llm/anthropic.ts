import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { NarrationProvider } from './index';

/**
 * Marker appended to a section's narration when Anthropic reports that the
 * response was cut off because it hit the `max_tokens` budget. Surfaced as
 * markdown italic on its own line so the user can tell the section is
 * incomplete instead of treating the truncated output as the full answer.
 */
export const MAX_TOKENS_TRUNCATION_MARKER = '\n\n_(truncated — output exceeded max_tokens)_';

export const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 16384;

export class AnthropicProvider implements NarrationProvider {
    private readonly client: Anthropic;
    private readonly maxOutputTokens: number;

    constructor(apiKey: string, private readonly model: string, maxOutputTokens?: number) {
        this.client = new Anthropic({ apiKey });
        this.maxOutputTokens = typeof maxOutputTokens === 'number'
            && Number.isFinite(maxOutputTokens)
            && maxOutputTokens > 0
            ? Math.floor(maxOutputTokens)
            : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS;
    }

    async *stream(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): AsyncGenerator<string> {
        const abortController = new AbortController();
        const sub = token.onCancellationRequested(() => abortController.abort());
        try {
            const stream = this.client.messages.stream(
                {
                    model: this.model,
                    max_tokens: this.maxOutputTokens,
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
            let truncated = false;
            for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    yield event.delta.text;
                } else if (event.type === 'message_delta' && event.delta.stop_reason === 'max_tokens') {
                    // The model hit the max_tokens cap. Remember it and surface a
                    // marker after the stream drains so partial sections are
                    // distinguishable from naturally-completed ones. Other stop
                    // reasons (end_turn, stop_sequence, tool_use) are not
                    // truncations and need no marker.
                    truncated = true;
                }
            }
            if (truncated) {
                yield MAX_TOKENS_TRUNCATION_MARKER;
            }
        } finally {
            sub.dispose();
        }
    }
}
