import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

// The Anthropic SDK is constructed inside the provider and we never want to hit
// the network from tests. We mock the default export with a class whose
// `messages.stream(...)` returns a programmable async iterable. Each test seeds
// `nextEvents` with the SDK events the stream should yield.

interface StreamEvent {
    type: string;
    [k: string]: unknown;
}

let nextEvents: StreamEvent[] = [];
let lastStreamArgs: Record<string, unknown> | undefined;

vi.mock('@anthropic-ai/sdk', () => {
    class FakeAnthropic {
        messages = {
            stream: (args: Record<string, unknown>) => {
                lastStreamArgs = args;
                return {
                    async *[Symbol.asyncIterator]() {
                        for (const event of nextEvents) yield event;
                    },
                };
            },
        };
    }
    return { default: FakeAnthropic };
});

import { AnthropicProvider, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS, MAX_TOKENS_TRUNCATION_MARKER } from './anthropic';

function liveToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

async function collect(provider: AnthropicProvider): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of provider.stream('sys', 'user', liveToken())) out.push(chunk);
    return out;
}

describe('AnthropicProvider stream', () => {
    beforeEach(() => { nextEvents = []; lastStreamArgs = undefined; });

    test('yields text deltas in order', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello, ' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world.' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
            { type: 'message_stop' },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        expect(await collect(provider)).toEqual(['Hello, ', 'world.']);
    });

    test('appends truncation marker after the last text chunk when stop_reason is max_tokens', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial answer' } },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } },
            { type: 'message_stop' },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        const chunks = await collect(provider);

        expect(chunks).toEqual(['Partial answer', MAX_TOKENS_TRUNCATION_MARKER]);
        // Sanity-check the marker's wording matches the exact spec from the issue.
        expect(MAX_TOKENS_TRUNCATION_MARKER).toContain('_(truncated — output exceeded max_tokens)_');
        // The marker must be on its own line (not glued to the previous chunk).
        expect(MAX_TOKENS_TRUNCATION_MARKER.startsWith('\n')).toBe(true);
    });

    test('does not append a marker for stop_reason=end_turn', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
            { type: 'message_stop' },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        const chunks = await collect(provider);
        expect(chunks).toEqual(['Done.']);
        expect(chunks.join('')).not.toContain('truncated');
    });

    test('does not append a marker for stop_reason=stop_sequence', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Stopped early.' } },
            { type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: 'X' } },
            { type: 'message_stop' },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        const chunks = await collect(provider);
        expect(chunks).toEqual(['Stopped early.']);
    });

    test('ignores non-text content_block_delta types', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'visible' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        expect(await collect(provider)).toEqual(['visible']);
    });

    test('passes the configured maxOutputTokens to the SDK call', async () => {
        nextEvents = [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6', 32000);
        await collect(provider);
        expect(lastStreamArgs?.max_tokens).toBe(32000);
        expect(lastStreamArgs?.model).toBe('claude-sonnet-4-6');
    });

    test('defaults max_tokens to DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS when no override is given', async () => {
        nextEvents = [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6');
        await collect(provider);
        expect(lastStreamArgs?.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
    });

    test('ignores a non-positive maxOutputTokens override and falls back to the default', async () => {
        nextEvents = [{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6', 0);
        await collect(provider);
        expect(lastStreamArgs?.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
    });

    test('configured maxOutputTokens still yields the truncation marker on stop_reason=max_tokens', async () => {
        nextEvents = [
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'big partial' } },
            { type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null } },
            { type: 'message_stop' },
        ];
        const provider = new AnthropicProvider('sk-test', 'claude-sonnet-4-6', 64000);
        const chunks = await collect(provider);
        expect(lastStreamArgs?.max_tokens).toBe(64000);
        expect(chunks).toEqual(['big partial', MAX_TOKENS_TRUNCATION_MARKER]);
    });
});
