import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import { createGitFixture, openRepoInVscode, GitFixture } from '../gitFixture';
import {
    activateExtension,
    closeAllEditors,
    hasNarrationWebviewTab,
    installFakeProvider,
    resetProviderFactory,
    waitForSettled,
} from '../helpers';
import type { ExtensionApi, BaseRefPicker } from '../../../extension';

suite('codeNarration picker-driven commands', () => {
    let api: ExtensionApi;
    let fixture: GitFixture | undefined;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        api.setBaseRefPicker(undefined);
        await closeAllEditors();
        await fixture?.cleanup();
        fixture = undefined;
    });

    function installPicker(picker: BaseRefPicker): { calls: { defaultRef: string }[] } {
        const calls: { defaultRef: string }[] = [];
        const wrapped: BaseRefPicker = async (repo, defaultRef) => {
            calls.push({ defaultRef });
            return picker(repo, defaultRef);
        };
        api.setBaseRefPicker(wrapped);
        return { calls };
    }

    test('openDiffWithBase narrates against the ref returned by the picker', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        // Two commits: C1 has "return 1", C2 has "return 2". HEAD~1 = C1.
        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'c1');
        fixture.write('alpha.ts', 'export function alpha(): number { return 2; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'c2');
        // Working-tree edit so the diff vs HEAD~1 is non-trivial.
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        await openRepoInVscode(fixture.rootUri);

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        const picker = installPicker(async () => 'HEAD~1');

        await vscode.commands.executeCommand('codeNarration.openDiffWithBase');
        await waitForSettled(fake);

        assert.strictEqual(picker.calls.length, 1, 'Expected the picker to be invoked exactly once.');
        assert.strictEqual(
            picker.calls[0].defaultRef,
            'HEAD',
            'Picker should be called with the configured default ref as the pre-selection.',
        );
        assert.ok(fake.calls.length >= 1, `Expected >=1 LLM call, got ${fake.calls.length}.`);
        const prompt = fake.calls[0].userPrompt;
        assert.ok(
            prompt.includes('return 1') || prompt.includes('return 7'),
            'Expected the diff prompt to mention content from HEAD~1 (return 1) or working tree (return 7).',
        );
    });

    test('openDiffWithBase: picker cancellation is a no-op', async () => {
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

        installPicker(async () => undefined);

        await vscode.commands.executeCommand('codeNarration.openDiffWithBase');
        await waitForSettled(fake);

        assert.strictEqual(fake.calls.length, 0, 'Cancelling the picker must not trigger narration.');
        assert.strictEqual(
            hasNarrationWebviewTab(),
            false,
            'Cancelling the picker must not open the narration panel.',
        );
    });

    test('changeDiffBase swaps the base ref and re-narrates against it', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'c1');
        fixture.write('alpha.ts', 'export function alpha(): number { return 2; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'c2');
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        await openRepoInVscode(fixture.rootUri);
        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        // Open the initial diff against HEAD via the silent command.
        await vscode.commands.executeCommand('codeNarration.openDiff');
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;
        assert.ok(initialCalls >= 1, `Expected >=1 initial LLM call, got ${initialCalls}.`);

        const picker = installPicker(async () => 'HEAD~1');

        await vscode.commands.executeCommand('codeNarration.changeDiffBase');
        await waitForSettled(fake);

        assert.strictEqual(picker.calls.length, 1, 'Picker should run exactly once.');
        assert.strictEqual(
            picker.calls[0].defaultRef,
            'HEAD',
            'changeDiffBase should pre-select the current baseRef as the picker default.',
        );
        assert.ok(
            fake.calls.length > initialCalls,
            `Expected additional LLM calls after switching base ref; got ${fake.calls.length - initialCalls}.`,
        );
    });

    test('changeDiffBase: picking the same ref is a no-op', async () => {
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
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;

        installPicker(async () => 'HEAD'); // same as current baseRef

        await vscode.commands.executeCommand('codeNarration.changeDiffBase');
        await waitForSettled(fake);

        assert.strictEqual(
            fake.calls.length,
            initialCalls,
            `Picking the same ref must not re-narrate; got ${fake.calls.length - initialCalls} additional calls.`,
        );
    });

    test('openTreeDiffWithBase narrates the tree against the picker-chosen ref', async () => {
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

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('a.ts'));
        await vscode.window.showTextDocument(doc);

        const picker = installPicker(async () => 'HEAD');

        await vscode.commands.executeCommand('codeNarration.openTreeDiffWithBase');
        await waitForSettled(fake);

        assert.strictEqual(picker.calls.length, 1, 'Picker should run exactly once.');
        // Tree-diff fan-out is 1 summary + 1 per changed file = 3 calls here.
        assert.strictEqual(
            fake.calls.length,
            3,
            `Expected 3 LLM calls (1 summary + 2 file diffs), got ${fake.calls.length}.`,
        );
    });

    test('openDiffWithBase with no active editor shows a message and skips narration', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        // Ensure no editor is active.
        await closeAllEditors();

        const picker = installPicker(async () => 'HEAD');

        await vscode.commands.executeCommand('codeNarration.openDiffWithBase');

        assert.strictEqual(picker.calls.length, 0, 'Picker must not run when there is no active editor.');
        assert.strictEqual(fake.calls.length, 0, 'No LLM call expected without an active editor.');
    });

    test('changeDiffBase with no diff open shows a message and skips narration', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const picker = installPicker(async () => 'HEAD');

        await vscode.commands.executeCommand('codeNarration.changeDiffBase');

        assert.strictEqual(
            picker.calls.length,
            0,
            'Picker must not run when there is no diff narration open.',
        );
        assert.strictEqual(fake.calls.length, 0, 'No LLM call expected when no diff is open.');
    });
});
