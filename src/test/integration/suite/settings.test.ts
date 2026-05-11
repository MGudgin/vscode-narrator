import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    makeTempFile,
    resetProviderFactory,
    warmupSymbols,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

const CLASS_FIXTURE =
    'export class Foo {\n' +
    '    alpha(): number { return 1; }\n' +
    '    beta(): number { return 2; }\n' +
    '}\n';

suite('recurseSymbols setting', () => {
    let api: ExtensionApi;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
    });

    test('default (auto) on a TS file narrates the class only; "always" narrates the methods too', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const file = makeTempFile(CLASS_FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);
        await warmupSymbols(doc.uri);

        const config = vscode.workspace.getConfiguration('codeNarration');
        let topLevelCalls = 0;
        let recursiveCalls = 0;

        try {
            // Default setting is "auto"; TS is not container-heavy, so it
            // resolves to top-level only.
            await vscode.commands.executeCommand('codeNarration.open');
            topLevelCalls = fake.calls.length;

            // Switch to "always" and refresh (skipCache: true) so every
            // section restreams.
            await config.update('recurseSymbols', 'always', vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('codeNarration.refresh');
            recursiveCalls = fake.calls.length - topLevelCalls;
        } finally {
            await config.update('recurseSymbols', undefined, vscode.ConfigurationTarget.Global);
        }

        assert.strictEqual(
            topLevelCalls,
            1,
            `Expected 1 LLM call with default recurseSymbols (class Foo only), got ${topLevelCalls}.`,
        );
        // Exact count depends on what the TS language server reports — it
        // sometimes synthesizes implicit members. The integration assertion
        // is that toggling to "always" demonstrably expands into children.
        assert.ok(
            recursiveCalls > topLevelCalls,
            `Expected recurseSymbols=always to expand into child sections; got ${recursiveCalls} (vs ${topLevelCalls} at top-level).`,
        );
    });
});
