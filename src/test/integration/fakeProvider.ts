import * as vscode from 'vscode';
import type { NarrationProvider } from '../../llm/index';

export interface FakeProviderCall {
    systemPrompt: string;
    userPrompt: string;
}

/**
 * Deterministic NarrationProvider for integration tests. Records every
 * `stream()` invocation and emits a configurable, fixed sequence of chunks
 * per call. No network, no LLM.
 */
export class FakeProvider implements NarrationProvider {
    readonly calls: FakeProviderCall[] = [];
    private readonly chunks: readonly string[];

    constructor(chunks: readonly string[] = ['Fake narration.']) {
        this.chunks = chunks;
    }

    async *stream(
        systemPrompt: string,
        userPrompt: string,
        token: vscode.CancellationToken,
    ): AsyncIterable<string> {
        this.calls.push({ systemPrompt, userPrompt });
        for (const chunk of this.chunks) {
            if (token.isCancellationRequested) return;
            yield chunk;
        }
    }
}
