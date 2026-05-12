import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import { createGitFixture, getVscodeGitRepo, openRepoInVscode, GitFixture } from '../gitFixture';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    resetProviderFactory,
    waitFor,
    waitForSettled,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

// HEAD_DEBOUNCE_MS in extension.ts is 750. Generous slack for slow CI.
const POST_HEAD_MOVE_WAIT_MS = 5_000;

suite('Diff narration HEAD-move auto-refresh', () => {
    let api: ExtensionApi;
    let fixture: GitFixture | undefined;
    let fixtureB: GitFixture | undefined;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
        await vscode.workspace
            .getConfiguration('codeNarration')
            .update('narrateOnSave', undefined, vscode.ConfigurationTarget.Global);
        await fixture?.cleanup();
        fixture = undefined;
        await fixtureB?.cleanup();
        fixtureB = undefined;
    });

    test('committing while a diff narration is open triggers a re-narrate', async () => {
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
        assert.ok(initialCalls >= 1, `Expected >=1 initial LLM call, got ${initialCalls}.`);

        // Commit the v7 change, then write v99 to the working tree so the
        // post-commit diff is non-empty. Force vscode.git to observe the
        // commit via status() — its filesystem watcher is too slow for tests.
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'second');
        fixture.write('alpha.ts', 'export function alpha(): number { return 99; }\n');
        await getVscodeGitRepo(fixture.rootUri).status();

        await waitFor(() => fake.calls.length > initialCalls, POST_HEAD_MOVE_WAIT_MS + 6_000);
        await waitForSettled(fake);

        assert.ok(
            fake.calls.length > initialCalls,
            `Expected the HEAD-move watcher to trigger a re-narrate; got ${fake.calls.length - initialCalls} additional calls.`,
        );
    });

    test('checking out another branch while a diff narration is open triggers a re-narrate', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        // v1 on main; branch "other" with v2; back on main.
        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'v1 on main');
        await fixture.git('checkout', '-q', '-b', 'other');
        fixture.write('alpha.ts', 'export function alpha(): number { return 2; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'v2 on other');
        await fixture.git('checkout', '-q', 'main');

        // Working-tree edit so the initial diff vs HEAD is non-empty.
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        await openRepoInVscode(fixture.rootUri);
        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openDiff');
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;
        assert.ok(initialCalls >= 1, `Expected >=1 initial LLM call, got ${initialCalls}.`);

        // Force-checkout other (discards working-tree edits), then write
        // a fresh working-tree change so the post-checkout diff is non-empty.
        await fixture.git('checkout', '-q', '-f', 'other');
        fixture.write('alpha.ts', 'export function alpha(): number { return 9; }\n');
        await getVscodeGitRepo(fixture.rootUri).status();

        await waitFor(() => fake.calls.length > initialCalls, POST_HEAD_MOVE_WAIT_MS + 6_000);
        await waitForSettled(fake);

        assert.ok(
            fake.calls.length > initialCalls,
            `Expected branch checkout to trigger a re-narrate; got ${fake.calls.length - initialCalls} additional calls.`,
        );
    });

    test('save without commit does not trigger the HEAD-move refresh path', async () => {
        fixture = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        await vscode.workspace
            .getConfiguration('codeNarration')
            .update('narrateOnSave', false, vscode.ConfigurationTarget.Global);

        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'initial');
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        await openRepoInVscode(fixture.rootUri);
        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        const editor = await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openDiff');
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;

        // Edit the buffer and save — working-tree dirty, but HEAD does not
        // move. HeadTracker should suppress.
        await editor.edit((edit) => {
            const text = doc.getText();
            const idx = text.indexOf('return 7');
            const startPos = doc.positionAt(idx + 'return '.length);
            const endPos = doc.positionAt(idx + 'return 7'.length);
            edit.replace(new vscode.Range(startPos, endPos), '42');
        });
        await doc.save();
        await getVscodeGitRepo(fixture.rootUri).status();

        await new Promise((r) => setTimeout(r, POST_HEAD_MOVE_WAIT_MS));
        await waitForSettled(fake);

        assert.strictEqual(
            fake.calls.length,
            initialCalls,
            `Expected zero additional LLM calls when HEAD did not move; got ${fake.calls.length - initialCalls}.`,
        );
    });

    test('HEAD move in a different repo does not refresh the open diff narration', async () => {
        fixture = await createGitFixture();
        fixtureB = await createGitFixture();
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        await vscode.workspace
            .getConfiguration('codeNarration')
            .update('narrateOnSave', false, vscode.ConfigurationTarget.Global);

        // Repo A: commit + working-tree edit so the diff is non-empty.
        fixture.write('alpha.ts', 'export function alpha(): number { return 1; }\n');
        await fixture.git('add', '.');
        await fixture.git('commit', '-q', '-m', 'a-initial');
        fixture.write('alpha.ts', 'export function alpha(): number { return 7; }\n');

        // Repo B: needs an initial commit so subsequent commits are valid.
        fixtureB.write('beta.ts', 'export const beta = 1;\n');
        await fixtureB.git('add', '.');
        await fixtureB.git('commit', '-q', '-m', 'b-initial');

        await openRepoInVscode(fixture.rootUri);
        await openRepoInVscode(fixtureB.rootUri);

        const doc = await vscode.workspace.openTextDocument(fixture.fileUri('alpha.ts'));
        await vscode.window.showTextDocument(doc);

        await vscode.commands.executeCommand('codeNarration.openDiff');
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;

        // Move HEAD in repo B — the diff narration in repo A must NOT
        // re-narrate.
        fixtureB.write('beta.ts', 'export const beta = 2;\n');
        await fixtureB.git('add', '.');
        await fixtureB.git('commit', '-q', '-m', 'b-second');
        await getVscodeGitRepo(fixtureB.rootUri).status();

        await new Promise((r) => setTimeout(r, POST_HEAD_MOVE_WAIT_MS));
        await waitForSettled(fake);

        assert.strictEqual(
            fake.calls.length,
            initialCalls,
            `Expected zero additional LLM calls for a HEAD move in a different repo; got ${fake.calls.length - initialCalls}.`,
        );
    });
});
