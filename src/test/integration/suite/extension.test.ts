import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import {
    activateExtension,
    closeAllEditors,
    hasNarrationWebviewTab,
    installFakeProvider,
    makeTempFile,
    resetProviderFactory,
    waitFor,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

suite('Smoke', () => {
    let api: ExtensionApi;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
    });

    test('codeNarration.open produces a Narration webview tab', async () => {
        installFakeProvider(api, new FakeProvider());

        const file = makeTempFile('export function hello(): string { return "hi"; }\n');
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.open');

        await waitFor(hasNarrationWebviewTab, 5_000);
    });
});
