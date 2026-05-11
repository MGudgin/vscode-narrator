import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    makeTempFile,
    resetProviderFactory,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

const TWO_SYMBOL_FIXTURE =
    'export function alpha(): number { return 1; }\n' +
    '\n' +
    'export function beta(): number { return 2; }\n';

suite('Per-section cache, end-to-end', () => {
    let api: ExtensionApi;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
    });

    test('re-narrating identical content produces zero additional LLM calls', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const file = makeTempFile(TWO_SYMBOL_FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);

        // First narration: cold. `executeCommand` awaits the full narration,
        // including the cache.setMany write, before resolving.
        await vscode.commands.executeCommand('codeNarration.open');
        const initialCalls = fake.calls.length;
        assert.ok(
            initialCalls >= 2,
            `Expected >=2 initial LLM calls (one per symbol), got ${initialCalls}.`,
        );

        // Second narration on unchanged content: all sections hit cache.
        await vscode.commands.executeCommand('codeNarration.open');
        assert.strictEqual(
            fake.calls.length,
            initialCalls,
            `Expected zero additional LLM calls on re-narrate, got ${fake.calls.length - initialCalls}.`,
        );
    });

    test('codeNarration.refresh restreams every section (skipCache)', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const file = makeTempFile(TWO_SYMBOL_FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.open');
        const initialCalls = fake.calls.length;
        assert.ok(initialCalls >= 2, `Expected >=2 initial calls, got ${initialCalls}.`);

        await vscode.commands.executeCommand('codeNarration.refresh');
        const afterRefresh = fake.calls.length - initialCalls;
        assert.strictEqual(
            afterRefresh,
            initialCalls,
            `Refresh should restream all ${initialCalls} sections; got ${afterRefresh} additional calls.`,
        );
    });
});
