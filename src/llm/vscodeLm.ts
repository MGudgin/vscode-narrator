import * as vscode from 'vscode';
import { NarrationProvider } from './index';

export class VSCodeLmProvider implements NarrationProvider {
    constructor(private readonly modelFamily?: string) {}

    async *stream(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): AsyncGenerator<string> {
        const selector: vscode.LanguageModelChatSelector = this.modelFamily
            ? { family: this.modelFamily }
            : {};
        const models = await vscode.lm.selectChatModels(selector);
        if (!models.length) {
            throw new Error(
                this.modelFamily
                    ? `No language model matches family "${this.modelFamily}". Install GitHub Copilot or pick a different family.`
                    : 'No language models are available. Install GitHub Copilot, or set codeNarration.provider to "anthropic".',
            );
        }
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
        ];
        const response = await models[0].sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            yield chunk;
        }
    }
}
