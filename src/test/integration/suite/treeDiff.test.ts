import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import { createGitFixture, openRepoInVscode, GitFixture } from '../gitFixture';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    resetProviderFactory,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

suite('codeNarration.openTreeDiff', () => {
    let api: ExtensionApi;
    let fixture: GitFixture | undefined;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
        await fixture?.cleanup();
        fixture = undefined;
    });

    test('fans out across modified files: one summary call plus one per file', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        fixture.write('a.ts', 'export const a = 1;\n');
        fixture.write('b.ts', 'export const b = 2;\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'initial');

        fixture.write('a.ts', 'export const a = 99;\n');
        fixture.write('b.ts', 'export const b = 88;\n');

        await openRepoInVscode(fixture.rootUri);

        // Open a doc inside the repo so openTreeDiff's "active editor →
        // repo root" path resolves without needing an SCM contribution arg.
        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('a.ts'));
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openTreeDiff');

        assert.strictEqual(
            fake.calls.length,
            3,
            `Expected 3 LLM calls (1 summary + 2 file diffs), got ${fake.calls.length}.`,
        );
    });
});
