import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    makeTempFile,
    resetProviderFactory,
    waitFor,
    waitForSettled,
    warmupSymbols,
} from '../helpers';
import type { ExtensionApi } from '../../../extension';

const FIXTURE =
    'export function alpha(): number { return 1; }\n' +
    '\n' +
    'export function beta(): number { return 2; }\n';

const PREAMBLE_FIXTURE =
    '// This file is the preamble.\n' +
    '\n' +
    'export function alpha(): number { return 1; }\n' +
    '\n' +
    'export function beta(): number { return 2; }\n';

suite('onSave and per-section cache', () => {
    let api: ExtensionApi;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
    });

    test('editing one symbol then saving triggers exactly one additional LLM call', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        // Each test gets a fresh tmpdir, so the section cache keys (which
        // include the URI) are unique to this run and will miss cold.
        const file = makeTempFile(FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await warmupSymbols(doc.uri);

        await vscode.commands.executeCommand('codeNarration.open');

        // Wait for the initial narration to fully settle.
        await waitFor(() => fake.calls.length >= 2, 15_000);
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;
        assert.ok(
            initialCalls >= 2,
            `Expected >=2 initial LLM calls (one per symbol), got ${initialCalls}.`,
        );

        // Find and replace `return 1` with `return 7` inside `alpha`.
        const text = doc.getText();
        const idx = text.indexOf('return 1');
        assert.notStrictEqual(idx, -1, 'fixture lookup failed');
        const startPos = doc.positionAt(idx + 'return '.length);
        const endPos = doc.positionAt(idx + 'return 1'.length);

        await editor.edit((edit) => {
            edit.replace(new vscode.Range(startPos, endPos), '7');
        });
        await doc.save();

        // SAVE_DEBOUNCE_MS is 500ms in extension.ts. Allow generous slack.
        await waitFor(() => fake.calls.length > initialCalls, 15_000);
        await waitForSettled(fake);

        assert.strictEqual(
            fake.calls.length - initialCalls,
            1,
            `Expected exactly 1 additional LLM call after editing one section, got ${fake.calls.length - initialCalls}.`,
        );
    });

    test('editing the preamble triggers exactly one additional LLM call', async () => {
        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const file = makeTempFile(PREAMBLE_FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await warmupSymbols(doc.uri);

        await vscode.commands.executeCommand('codeNarration.open');

        // Three units expected: Top-of-file preamble + alpha + beta.
        await waitFor(() => fake.calls.length >= 3, 15_000);
        await waitForSettled(fake);
        const initialCalls = fake.calls.length;
        assert.ok(
            initialCalls >= 3,
            `Expected >=3 initial LLM calls (preamble + 2 symbols), got ${initialCalls}.`,
        );

        // Edit the preamble comment: replace "This" with "XXXX".
        const text = doc.getText();
        const idx = text.indexOf('This');
        assert.notStrictEqual(idx, -1, 'preamble lookup failed');
        const startPos = doc.positionAt(idx);
        const endPos = doc.positionAt(idx + 'This'.length);

        await editor.edit((edit) => {
            edit.replace(new vscode.Range(startPos, endPos), 'XXXX');
        });
        await doc.save();

        await waitFor(() => fake.calls.length > initialCalls, 15_000);
        await waitForSettled(fake);

        assert.strictEqual(
            fake.calls.length - initialCalls,
            1,
            `Expected exactly 1 additional LLM call after editing only the preamble, got ${fake.calls.length - initialCalls}.`,
        );
    });
});
