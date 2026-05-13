import { describe, test, expect } from 'vitest';
import * as vscode from 'vscode';
import { buildNarrationSink } from './sink';
import { NarrationTarget } from './target';

interface CapturedMessage {
    kind: string;
    [key: string]: unknown;
}

function makeWebview(): { postMessage: (m: unknown) => Thenable<boolean>; messages: CapturedMessage[] } {
    const messages: CapturedMessage[] = [];
    return {
        messages,
        postMessage(m: unknown) {
            messages.push(m as CapturedMessage);
            return Promise.resolve(true);
        },
    };
}

function liveToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

function cancelledToken(): vscode.CancellationToken {
    return {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken;
}

function fileTarget(uri = 'file:///workspace/src/foo.ts'): NarrationTarget {
    return { kind: 'file', uri: vscode.Uri.parse(uri) as unknown as vscode.Uri };
}

function treeTarget(root = 'file:///workspace'): NarrationTarget {
    return { kind: 'tree', repoRoot: vscode.Uri.parse(root) as unknown as vscode.Uri, baseRef: 'HEAD' };
}

describe('buildNarrationSink', () => {
    test('init posts reset, then bannerStatus:streaming when sections are pending', () => {
        const webview = makeWebview();
        const ranges: { id: string; range: vscode.Range }[] = [];
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'Full file',
            sectionRanges: ranges,
        });

        sink({ kind: 'init', sections: [{ id: 'a' }, { id: 'b' }] });

        expect(webview.messages.map((m) => m.kind)).toEqual(['reset', 'bannerStatus']);
        const reset = webview.messages[0];
        expect(reset.bannerLabel).toBe('Full file');
        expect((reset.sections as { id: string; status: string }[]).map((s) => s.status)).toEqual([
            'queued',
            'queued',
        ]);
        expect(webview.messages[1].status).toBe('streaming');
    });

    test('init with all-static sections jumps banner straight to complete', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'Full file',
            sectionRanges: [],
        });

        sink({
            kind: 'init',
            sections: [{ id: 'a', bodyMarkdown: 'hello' }],
            fromCache: true,
        });

        expect(webview.messages[0].kind).toBe('reset');
        expect(webview.messages[0].bannerLabel).toBe('Full file • Cached');
        expect((webview.messages[0].sections as { status: string }[])[0].status).toBe('complete');
        // A static section emits one upfront speech message with the stripped body.
        const speech = webview.messages.find((m) => m.kind === 'speech');
        expect(speech).toMatchObject({ kind: 'speech', sectionId: 'a', text: 'hello' });
        expect(webview.messages.some((m) => m.kind === 'bannerStatus' && m.status === 'complete')).toBe(true);
    });

    test('init populates sectionRanges from sections that carry a range', () => {
        const webview = makeWebview();
        const ranges: { id: string; range: vscode.Range }[] = [
            { id: 'stale', range: new vscode.Range(0, 0, 0, 0) },
        ];
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: ranges,
        });

        const r1 = new vscode.Range(2, 0, 5, 0);
        sink({
            kind: 'init',
            sections: [
                { id: 'a', range: r1 },
                { id: 'b' }, // no range, should be skipped
            ],
        });

        expect(ranges).toEqual([{ id: 'a', range: r1 }]);
    });

    test('first chunk on a queued section emits sectionStatus:streaming then a replace', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }] });
        webview.messages.length = 0;

        sink({ kind: 'chunk', sectionId: 'a', text: 'hello ' });

        // Order: section flips to streaming; banner already 'streaming' so no banner post; replace posted.
        const kinds = webview.messages.map((m) => m.kind);
        expect(kinds[0]).toBe('sectionStatus');
        expect(webview.messages[0]).toMatchObject({ sectionId: 'a', status: 'streaming' });
        expect(kinds).toContain('replace');
        expect(kinds).not.toContain('bannerStatus');
    });

    test('chunks on a static section are ignored', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a', bodyMarkdown: 'static' }] });
        webview.messages.length = 0;

        sink({ kind: 'chunk', sectionId: 'a', text: 'extra' });

        expect(webview.messages).toEqual([]);
    });

    test('sectionDone on the last streaming section posts final replace, sectionStatus, and bannerStatus:complete', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }] });
        sink({ kind: 'chunk', sectionId: 'a', text: 'hi' });
        webview.messages.length = 0;

        sink({ kind: 'sectionDone', sectionId: 'a' });

        const kinds = webview.messages.map((m) => m.kind);
        // The trailing partial sentence flushes as a speech message before the
        // section transitions to complete.
        expect(kinds).toEqual(['replace', 'speech', 'speechSectionDone', 'sectionStatus', 'bannerStatus']);
        const speech = webview.messages.find((m) => m.kind === 'speech');
        expect(speech).toMatchObject({ kind: 'speech', sectionId: 'a', text: 'hi' });
        const status = webview.messages.find((m) => m.kind === 'sectionStatus');
        expect(status).toMatchObject({ sectionId: 'a', status: 'complete' });
        const banner = webview.messages.find((m) => m.kind === 'bannerStatus');
        expect(banner).toMatchObject({ status: 'complete' });
    });

    test('sectionDone with no content emits the placeholder body', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }] });
        webview.messages.length = 0;

        sink({ kind: 'sectionDone', sectionId: 'a' });

        const replace = webview.messages.find((m) => m.kind === 'replace');
        expect(replace).toBeDefined();
        // The placeholder markdown gets rendered to HTML containing the underscore'd text.
        expect((replace?.bodyHtml as string)).toMatch(/no narration produced/);
    });

    test('done finalises sections that never received sectionDone', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }, { id: 'b' }] });
        sink({ kind: 'chunk', sectionId: 'a', text: 'some text' });
        webview.messages.length = 0;

        sink({ kind: 'done' });

        const completeStatuses = webview.messages.filter(
            (m) => m.kind === 'sectionStatus' && m.status === 'complete',
        );
        expect(completeStatuses.map((m) => m.sectionId).sort()).toEqual(['a', 'b']);
        expect(webview.messages.some((m) => m.kind === 'bannerStatus' && m.status === 'complete')).toBe(true);
    });

    test('cancelled token causes every event to no-op', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: cancelledToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }] });
        sink({ kind: 'chunk', sectionId: 'a', text: 'hi' });
        sink({ kind: 'sectionDone', sectionId: 'a' });
        sink({ kind: 'done' });

        expect(webview.messages).toEqual([]);
    });

    test('sectionReset clears accumulation and re-posts streaming status', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({ kind: 'init', sections: [{ id: 'a' }] });
        sink({ kind: 'chunk', sectionId: 'a', text: 'partial' });
        webview.messages.length = 0;

        sink({ kind: 'sectionReset', sectionId: 'a' });

        expect(webview.messages).toEqual([
            { kind: 'replace', sectionId: 'a', bodyHtml: '' },
            { kind: 'sectionStatus', sectionId: 'a', status: 'streaming' },
            { kind: 'speechReset', sectionId: 'a' },
        ]);
    });

    test('chunk events emit speech messages on sentence boundaries', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });
        sink({ kind: 'init', sections: [{ id: 'a' }] });
        webview.messages.length = 0;

        sink({ kind: 'chunk', sectionId: 'a', text: 'Hello world. ' });

        const speech = webview.messages.filter((m) => m.kind === 'speech');
        expect(speech).toEqual([
            { kind: 'speech', sectionId: 'a', text: 'Hello world.' },
        ]);
    });

    test('init emits an upfront speech message for the section heading', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: fileTarget(),
            bannerLabel: 'L',
            sectionRanges: [],
        });

        sink({
            kind: 'init',
            sections: [{ id: 'a', headingMarkdown: '## [foo](narrate://lines/L1)' }],
        });

        const speech = webview.messages.find((m) => m.kind === 'speech');
        expect(speech).toMatchObject({ kind: 'speech', sectionId: 'a', text: 'foo' });
    });

    test('tree target uses repoRoot as the fallback link URI for sections without their own', () => {
        const webview = makeWebview();
        const sink = buildNarrationSink({
            webview,
            token: liveToken(),
            target: treeTarget(),
            bannerLabel: 'Tree diff',
            sectionRanges: [],
        });

        // Smoke: should not throw, should not consult target.uri (which doesn't exist on tree targets).
        sink({
            kind: 'init',
            sections: [{ id: 'a', headingMarkdown: '## heading' }],
        });

        expect(webview.messages[0].kind).toBe('reset');
    });
});
