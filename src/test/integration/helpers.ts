import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi, ProviderFactory } from '../../extension';
import { FakeProvider } from './fakeProvider';

export const EXTENSION_ID = 'gudge.code-narration';

export async function activateExtension(): Promise<ExtensionApi> {
    const ext = vscode.extensions.getExtension<ExtensionApi>(EXTENSION_ID);
    if (!ext) throw new Error(`Extension ${EXTENSION_ID} not found in test host.`);
    if (ext.isActive) return ext.exports;
    return await ext.activate();
}

export function installFakeProvider(api: ExtensionApi, fake: FakeProvider): void {
    const factory: ProviderFactory = async () => ({
        provider: fake,
        info: { kind: 'fake', model: 'fake-1' },
    });
    api.setProviderFactory(factory);
}

export function resetProviderFactory(api: ExtensionApi): void {
    api.setProviderFactory(undefined);
}

export function makeTempFile(content: string, ext = '.ts'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narrator-it-'));
    const filePath = path.join(dir, `fixture${ext}`);
    fs.writeFileSync(filePath, content);
    return filePath;
}

export async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 10_000,
    intervalMs = 50,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) return;
        } catch (err) {
            lastErr = err;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    const tail = lastErr ? ` (last error: ${(lastErr as Error).message ?? lastErr})` : '';
    throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms${tail}`);
}

/**
 * Resolves once `fake.calls.length` has not changed for `quietMs`. Used to
 * confirm that asynchronous narration has fully settled before asserting
 * on the recorded call count.
 */
export async function waitForSettled(fake: FakeProvider, quietMs = 1000): Promise<void> {
    let lastCount = fake.calls.length;
    let stableSince = Date.now();
    while (Date.now() - stableSince < quietMs) {
        await new Promise((r) => setTimeout(r, 100));
        if (fake.calls.length !== lastCount) {
            lastCount = fake.calls.length;
            stableSince = Date.now();
        }
    }
}

export async function closeAllEditors(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/**
 * Block until `vscode.executeDocumentSymbolProvider` returns at least one
 * symbol for the given URI, or `timeoutMs` elapses. The TypeScript language
 * server can be slow on the first request in a test run, especially after
 * other extensions (e.g. vscode.git) have warmed up. Calling this before
 * `codeNarration.open` ensures the narration path's symbol fetch succeeds
 * rather than falling back to the whole-file path.
 *
 * Best-effort: does not throw on timeout — some tests legitimately expect
 * no symbols (the fallback path), and the call-count assertions guard the
 * real invariant.
 */
export async function warmupSymbols(uri: vscode.Uri, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = await vscode.commands.executeCommand<unknown[] | undefined>(
                'vscode.executeDocumentSymbolProvider',
                uri,
            );
            if (Array.isArray(result) && result.length > 0) return;
        } catch {
            // Language server not ready — retry.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export function hasNarrationWebviewTab(): boolean {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { viewType?: string } | undefined;
            if (typeof input?.viewType === 'string' && input.viewType.includes('codeNarration')) {
                return true;
            }
        }
    }
    return false;
}
