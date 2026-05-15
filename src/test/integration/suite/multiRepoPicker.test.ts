import * as assert from 'assert';
import * as vscode from 'vscode';
import { FakeProvider } from '../fakeProvider';
import { createGitFixture, openRepoInVscode, GitFixture } from '../gitFixture';
import {
    activateExtension,
    closeAllEditors,
    installFakeProvider,
    resetProviderFactory,
    waitFor,
} from '../helpers';
import type { ExtensionApi, QuickPickResolver } from '../../../extension';

interface CapturedMessage {
    kind?: string;
    bannerLabel?: string;
    [key: string]: unknown;
}

suite('codeNarration.openTreeDiff multi-repo picker', () => {
    let api: ExtensionApi;
    const fixtures: GitFixture[] = [];

    suiteSetup(async () => {
        api = await activateExtension();
    });

    teardown(async () => {
        resetProviderFactory(api);
        api.tapWebviewMessages(undefined);
        api.setQuickPickResolver(undefined);
        await closeAllEditors();
        while (fixtures.length > 0) {
            const f = fixtures.pop();
            await f?.cleanup();
        }
    });

    test('picks the second repo via the quick-pick resolver when no active editor disambiguates', async () => {
        const repoA = await createGitFixture();
        const repoB = await createGitFixture();
        fixtures.push(repoA, repoB);

        // Both repos have a tracked file with a pending change so the
        // tree-diff banner has a stable label.
        repoA.write('a.ts', 'export const a = 1;\n');
        await repoA.git('add', '.');
        await repoA.git('commit', '-q', '-m', 'initial');
        repoA.write('a.ts', 'export const a = 99;\n');

        repoB.write('b.ts', 'export const b = 2;\n');
        await repoB.git('add', '.');
        await repoB.git('commit', '-q', '-m', 'initial');
        repoB.write('b.ts', 'export const b = 88;\n');

        await openRepoInVscode(repoA.rootUri);
        await openRepoInVscode(repoB.rootUri);

        installFakeProvider(api, new FakeProvider());

        const captured: CapturedMessage[] = [];
        api.tapWebviewMessages((m) => captured.push(m as CapturedMessage));

        // Make sure no editor is active so openTreeDiff falls through to the
        // listRepoRoots + quick-pick branch.
        await closeAllEditors();

        // Resolver: deterministically pick the entry whose description
        // (the repo fsPath) matches repoB. Path comparison is case-insensitive
        // on Windows because VS Code's git extension may report the drive
        // letter with different casing than mkdtempSync.
        const resolverCalls: {
            itemCount: number;
            picked: string | undefined;
        }[] = [];
        const repoBDirLower = repoB.dir.toLowerCase();
        const resolver: QuickPickResolver = async (items) => {
            for (const item of items) {
                if ((item.description ?? '').toLowerCase() === repoBDirLower) {
                    resolverCalls.push({
                        itemCount: items.length,
                        picked: item.description,
                    });
                    return item;
                }
            }
            resolverCalls.push({
                itemCount: items.length,
                picked: undefined,
            });
            return undefined;
        };
        api.setQuickPickResolver(resolver);

        await vscode.commands.executeCommand('codeNarration.openTreeDiff');

        // Wait for the reset message that carries the bannerLabel.
        await waitFor(
            () => captured.some((m) => m.kind === 'reset' && typeof m.bannerLabel === 'string'),
            10_000,
        );

        assert.strictEqual(resolverCalls.length, 1, 'quick-pick resolver should be called exactly once');
        // The git extension carries repo registrations across tests in the
        // same VS Code instance; we may see >=2 (our two) but never <2.
        assert.ok(
            (resolverCalls[0].itemCount ?? 0) >= 2,
            `Expected >=2 repo choices, got ${resolverCalls[0].itemCount}.`,
        );
        assert.strictEqual(
            resolverCalls[0].picked?.toLowerCase(),
            repoBDirLower,
            'resolver should have picked repoB',
        );

        const reset = captured.find((m) => m.kind === 'reset' && typeof m.bannerLabel === 'string');
        assert.ok(reset, 'no reset captured');

        // bannerLabel itself is just "Tree diff vs HEAD" (no repo identity);
        // the picked repo shows up in the file-section headings, which are
        // built from `relPath(repoRoot, change.uri)`. RepoB's tracked change
        // is `b.ts`, repoA's is `a.ts` — so a section heading mentioning
        // `b.ts` confirms openTreeDiff narrated repoB.
        const stringified = JSON.stringify(reset);
        assert.ok(
            stringified.includes('b.ts'),
            `Expected the reset payload to reference b.ts (repoB's changed file); got: ${stringified.slice(0, 600)}`,
        );
        assert.ok(
            !stringified.includes('a.ts'),
            `Did not expect repoA's a.ts in the reset payload — picker should have selected repoB exclusively. Got: ${stringified.slice(0, 600)}`,
        );
    });
});
