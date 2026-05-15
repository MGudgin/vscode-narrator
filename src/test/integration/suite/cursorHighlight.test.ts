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

const TWO_SYMBOL_FIXTURE =
    'export function alpha(): number {\n' +
    '    return 1;\n' +
    '}\n' +
    '\n' +
    'export function beta(): number {\n' +
    '    return 2;\n' +
    '}\n';

interface CapturedMessage {
    kind?: string;
    sectionId?: string;
    sections?: { id: string }[];
    [key: string]: unknown;
}

suite('cursor → section highlight', () => {
    let api: ExtensionApi;

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        api.tapWebviewMessages(undefined);
        await closeAllEditors();
    });

    test('moving the cursor into a symbol emits a highlight message for the matching section', async () => {
        const captured: CapturedMessage[] = [];
        api.tapWebviewMessages((m) => {
            captured.push(m as CapturedMessage);
        });

        const fake = new FakeProvider();
        installFakeProvider(api, fake);

        const file = makeTempFile(TWO_SYMBOL_FIXTURE);
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc);
        await warmupSymbols(doc.uri);

        await vscode.commands.executeCommand('codeNarration.open');

        // Wait for symbol-aware narration to settle so sectionRanges is populated
        // and we can map a cursor line to a section id.
        await waitFor(() => fake.calls.length >= 2, 15_000);
        await waitForSettled(fake);

        // Locate the section ids that the sink told the webview about, paired
        // with the line ranges narrate.ts attached. We expect at least two
        // symbol sections (alpha, beta) with ranges.
        const reset = captured.find((m) => m.kind === 'reset');
        assert.ok(reset, 'Expected a reset message after narration init.');

        // Find a section id whose range straddles "beta" (line 4 in the
        // fixture, 0-indexed). We move the cursor there and assert the
        // highlight message names that section.
        const betaLine = TWO_SYMBOL_FIXTURE.split('\n').findIndex((l) => l.includes('function beta'));
        assert.ok(betaLine >= 0, 'fixture lookup failed for beta');

        const targetPos = new vscode.Position(betaLine, 'export function '.length + 2);
        editor.selection = new vscode.Selection(targetPos, targetPos);

        // SELECTION_DEBOUNCE_MS is 200ms; give the highlight a generous window.
        await waitFor(
            () => captured.some(
                (m) => m.kind === 'highlight' && typeof m.sectionId === 'string',
            ),
            5_000,
        );

        const highlight = captured.find((m) => m.kind === 'highlight');
        assert.ok(highlight, 'no highlight message captured');
        assert.ok(
            typeof highlight.sectionId === 'string' && highlight.sectionId.length > 0,
            'highlight.sectionId should be a non-empty string',
        );

        // Confirm the highlighted section actually covers the beta line: walk
        // the captured reset to find the matching section's range.
        const resetSections = (reset as CapturedMessage).sections ?? [];
        const matched = resetSections.find((s) => s.id === highlight.sectionId);
        assert.ok(matched, `reset did not include section ${highlight.sectionId}`);
    });
});
