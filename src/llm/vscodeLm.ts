import * as vscode from 'vscode';
import { NarrationProvider } from './index';

export class VSCodeLmProvider implements NarrationProvider {
    private modelPromise: Promise<vscode.LanguageModelChat> | undefined;

    constructor(private readonly modelFamily?: string) {}

    private getModel(): Promise<vscode.LanguageModelChat> {
        if (!this.modelPromise) {
            this.modelPromise = this.resolveModel().catch((err) => {
                this.modelPromise = undefined;
                throw err;
            });
        }
        return this.modelPromise;
    }

    private async resolveModel(): Promise<vscode.LanguageModelChat> {
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
        return models[0];
    }

    async *stream(systemPrompt: string, userPrompt: string, token: vscode.CancellationToken): AsyncGenerator<string> {
        const model = await this.getModel();
        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
        ];
        const response = await model.sendRequest(messages, {}, token);
        for await (const chunk of response.text) {
            yield chunk;
        }
    }
}
