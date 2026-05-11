import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import { createGitFixture, openRepoInVscode, GitFixture } from '../gitFixture';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    resetProviderFactory,
    warmupSymbols,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

suite('codeNarration.openDiff', () => {
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

    test('narrates the diff of a modified tracked file', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'initial');
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        await openRepoInVscode(fixture.rootUri);

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openDiff');

        assert.strictEqual(
            fake.calls.length,
            1,
            `Expected exactly 1 LLM call for a single-file diff, got ${fake.calls.length}.`,
        );
        const prompt = fake.calls[0].userPrompt;
        assert.ok(
            prompt.includes('return 7') || prompt.includes('return 1'),
            'Expected the diff prompt to mention the changed content (return 1/7).',
        );
    });

    test('makes no LLM call when the file is identical to HEAD', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'initial');

        await openRepoInVscode(fixture.rootUri);

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openDiff');

        assert.strictEqual(
            fake.calls.length,
            0,
            `Expected 0 LLM calls for an unchanged file (noChanges short-circuit), got ${fake.calls.length}.`,
        );
    });

    test('falls back to full-file narration when the file is untracked', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        // Initial commit so HEAD exists.
        fixture.write('placeholder.ts', '// keep repo non-empty\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'initial');

        // New file that's never been added.
        fixture.write('untracked.ts', 'export function untracked(): number { return 42; }\n');

        await openRepoInVscode(fixture.rootUri);

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('untracked.ts'));
        await vscode.window.showTextDocument(doc);
        await warmupSymbols(doc.uri);

        await vscode.commands.executeCommand('codeNarration.openDiff');

        // newFile path: file gets full-file narration with a "newly added" banner.
        // The one top-level function should produce one LLM call.
        assert.ok(
            fake.calls.length >= 1,
            `Expected >=1 LLM call for untracked-file fallback to full-file narration, got ${fake.calls.length}.`,
        );
    });
});
