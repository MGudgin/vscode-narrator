import * as vscode from 'vscode';
import { activateExtension, closeAllEditors, makeTempFile, waitFor } from '../helpers';

suite('revealLocation', () => {
    suiteSetup(async () => { await activateExtension(); });
    teardown(async () => { await closeAllEditors(); });

    test('codeNarration.reveal selects the requested range in the editor', async () => {
        const content = 'line zero\nline one\nline two\nline three\n';
        const file = makeTempFile(content);
        const uri = vscode.Uri.file(file);

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
});
