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

suite('revealLocation', () => {
    let api: ExtensionApi;

    suiteSetup(async () => { api = await activateExtension(); });
    teardown(async () => {
        resetProviderFactory(api);
        await closeAllEditors();
    });

    test('codeNarration.reveal selects the requested range in the editor', async () => {
        // The reveal handler refuses to open URIs that are not the active
        // narration target (security boundary added with #68/#69/#70). Open
        // narration for the test file first so `currentTarget` matches the
        // URI we're about to reveal.
        installFakeProvider(api, new FakeProvider());
        const content = 'line zero\nline one\nline two\nline three\n';
        const file = makeTempFile(content);
        const uri = vscode.Uri.file(file);

        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('codeNarration.open');
        await waitFor(hasNarrationWebviewTab, 5_000);

        await vscode.commands.executeCommand(
            'codeNarration.reveal',
            uri.toString(),
            {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 8 },
            },
        );

        await waitFor(() => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return false;
            if (editor.document.uri.toString() !== uri.toString()) return false;
            const sel = editor.selection;
            return (
                sel.start.line === 1 && sel.start.character === 0 &&
                sel.end.line === 1 && sel.end.character === 8
            );
        }, 5_000);
    });

    test('codeNarration.reveal refuses to open a URI outside the current narration target', async () => {
        installFakeProvider(api, new FakeProvider());
        const narrated = makeTempFile('narrated\n');
        const other = makeTempFile('other\n');
        const narratedUri = vscode.Uri.file(narrated);
        const otherUri = vscode.Uri.file(other);

        const doc = await vscode.workspace.openTextDocument(narratedUri);
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('codeNarration.open');
        await waitFor(hasNarrationWebviewTab, 5_000);

        // Attempt to reveal a different file. The handler should silently
        // refuse, leaving the narrated file as the active editor.
        await vscode.commands.executeCommand(
            'codeNarration.reveal',
            otherUri.toString(),
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
        );

        // Give the (rejected) command a moment to complete its async path,
        // then assert the active editor is still the narrated file.
        await new Promise((r) => setTimeout(r, 300));
        const active = vscode.window.activeTextEditor;
        if (active) {
            // It is acceptable for either nothing to be active or for the
            // narrated file to remain active — what must NOT happen is for
            // `other` to have been opened.
            if (active.document.uri.toString() === otherUri.toString()) {
                throw new Error('reveal handler opened a URI outside the active narration target');
            }
        }
    });
});
