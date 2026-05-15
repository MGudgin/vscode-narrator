import * as vscode from 'vscode';
import { NarrationSink } from './narrate';
import { NarrationTarget } from './target';
import { renderMarkdownToHtml, computeBannerStatus, BannerStatus, SectionStatus } from './webview';
import { fixupLinks } from './prompt';
import { SentenceBuffer, markdownToSpeech } from './speech';

const RENDER_THROTTLE_MS = 100;

interface SectionState {
    accumulated: string;
    /**
     * Offset in `accumulated` whose prefix has already been rendered to
     * `settledHtml`. Incremental chunk renders only run `fixupLinks` +
     * `renderMarkdownToHtml` over the small slice past this offset, so the
     * total work per section is linear in body length instead of quadratic.
     */
    settledUpTo: number;
    /** HTML for `accumulated.slice(0, settledUpTo)`, built incrementally. */
    settledHtml: string;
    lastRender: number;
    static: boolean;
    status: SectionStatus;
    linkUri: vscode.Uri;
    speech: SentenceBuffer;
}

/**
 * Largest offset `<= end` at which the markdown prefix ends at a paragraph
 * boundary (blank-line separator). Returns -1 when no such boundary exists
 * past `min`.
 *
 * Rendering at a paragraph boundary is the chunk-safety guarantee: a blank
 * line separates the settled prefix from anything that follows, so partial
 * constructs like `[link text` waiting for its `](url)` cannot straddle the
 * cut.
 */
function lastBlockBoundary(s: string, min: number, end: number): number {
    if (end <= min) return -1;
    const idx = s.lastIndexOf('\n\n', end - 1);
    return idx >= min ? idx + 2 : -1;
}

function finalSectionHtml(state: SectionState): string {
    if (state.accumulated.trim().length === 0) {
        return renderMarkdownToHtml(
            fixupLinks('_(no narration produced for this section.)_', state.linkUri),
        );
    }
    // Reuse the incrementally-built settled prefix and render only the tail.
    const tail = state.accumulated.slice(state.settledUpTo);
    const tailHtml = tail.length > 0
        ? renderMarkdownToHtml(fixupLinks(tail, state.linkUri))
        : '';
    state.settledHtml += tailHtml;
    state.settledUpTo = state.accumulated.length;
    return state.settledHtml;
}

export interface SinkParams {
    webview: Pick<vscode.Webview, 'postMessage'>;
    token: vscode.CancellationToken;
    target: NarrationTarget;
    bannerLabel: string;
    /** Populated on every `init` event so callers can map cursor positions to sections. */
    sectionRanges: { id: string; range: vscode.Range }[];
}

export function buildNarrationSink(params: SinkParams): NarrationSink {
    const { webview, token, target, bannerLabel, sectionRanges } = params;
    const sectionState = new Map<string, SectionState>();
    let lastBannerStatus: BannerStatus = 'hidden';
    const fallbackLinkUri = target.kind === 'tree' ? target.repoRoot : target.uri;

    const syncBannerStatus = (): void => {
        const { next, shouldEmit } = computeBannerStatus(
            Array.from(sectionState.values(), (s) => s.status),
            lastBannerStatus,
        );
        if (!shouldEmit) return;
        lastBannerStatus = next;
        void webview.postMessage({ kind: 'bannerStatus', status: next });
    };

    return (event) => {
        if (token.isCancellationRequested) return;
        switch (event.kind) {
            case 'init': {
                sectionState.clear();
                sectionRanges.length = 0;
                const speechBySection: { id: string; text: string }[] = [];
                const sectionsForWebview = event.sections.map((s) => {
                    if (s.range) {
                        sectionRanges.push({ id: s.id, range: s.range });
                    }
                    const linkUri = s.linkUri ?? fallbackLinkUri;
                    const headingHtml = s.headingMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.headingMarkdown, linkUri))
                        : '';
                    const bodyHtml = s.bodyMarkdown
                        ? renderMarkdownToHtml(fixupLinks(s.bodyMarkdown, linkUri))
                        : '';
                    const isStatic = !!s.bodyMarkdown;
                    const initialStatus: SectionStatus = isStatic ? 'complete' : 'queued';
                    const accumulated = s.bodyMarkdown ?? '';
                    sectionState.set(s.id, {
                        accumulated,
                        settledUpTo: accumulated.length,
                        settledHtml: bodyHtml,
                        lastRender: 0,
                        static: isStatic,
                        status: initialStatus,
                        linkUri,
                        speech: new SentenceBuffer(),
                    });
                    if (isStatic) {
                        const headingText = s.headingMarkdown ? markdownToSpeech(s.headingMarkdown) : '';
                        const bodyText = markdownToSpeech(s.bodyMarkdown ?? '');
                        const combined = [headingText, bodyText].filter((t) => t.length > 0).join('. ');
                        if (combined.length > 0) speechBySection.push({ id: s.id, text: combined });
                    } else if (s.headingMarkdown) {
                        const headingText = markdownToSpeech(s.headingMarkdown);
                        if (headingText.length > 0) speechBySection.push({ id: s.id, text: headingText });
                    }
                    return { id: s.id, headingHtml, bodyHtml, status: initialStatus };
                });
                const labelWithCache = event.fromCache ? `${bannerLabel} • Cached` : bannerLabel;
                void webview.postMessage({
                    kind: 'reset',
                    sections: sectionsForWebview,
                    bannerLabel: labelWithCache,
                });
                // Section headings (and any static bodies) feed the speech queue
                // up front so 'Play' can speak the heading even before chunks land.
                for (const item of speechBySection) {
                    void webview.postMessage({
                        kind: 'speech',
                        sectionId: item.id,
                        text: item.text,
                    });
                }
                lastBannerStatus = 'hidden';
                syncBannerStatus();
                break;
            }
            case 'chunk': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated += event.text;
                if (state.status === 'queued') {
                    state.status = 'streaming';
                    void webview.postMessage({
                        kind: 'sectionStatus',
                        sectionId: event.sectionId,
                        status: 'streaming',
                    });
                    syncBannerStatus();
                }
                for (const sentence of state.speech.push(event.text)) {
                    void webview.postMessage({
                        kind: 'speech',
                        sectionId: event.sectionId,
                        text: sentence,
                    });
                }
                const now = Date.now();
                if (now - state.lastRender < RENDER_THROTTLE_MS) return;
                state.lastRender = now;
                const boundary = lastBlockBoundary(
                    state.accumulated,
                    state.settledUpTo,
                    state.accumulated.length,
                );
                if (boundary > state.settledUpTo) {
                    const newlySettled = state.accumulated.slice(state.settledUpTo, boundary);
                    state.settledHtml += renderMarkdownToHtml(fixupLinks(newlySettled, state.linkUri));
                    state.settledUpTo = boundary;
                }
                const tail = state.accumulated.slice(state.settledUpTo);
                const tailHtml = tail.length > 0
                    ? renderMarkdownToHtml(fixupLinks(tail, state.linkUri))
                    : '';
                void webview.postMessage({
                    kind: 'replace',
                    sectionId: event.sectionId,
                    bodyHtml: state.settledHtml + tailHtml,
                });
                break;
            }
            case 'sectionReset': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated = '';
                state.settledUpTo = 0;
                state.settledHtml = '';
                state.lastRender = 0;
                state.status = 'streaming';
                state.speech.reset();
                void webview.postMessage({
                    kind: 'replace',
                    sectionId: event.sectionId,
                    bodyHtml: '',
                });
                void webview.postMessage({
                    kind: 'sectionStatus',
                    sectionId: event.sectionId,
                    status: 'streaming',
                });
                void webview.postMessage({
                    kind: 'speechReset',
                    sectionId: event.sectionId,
                });
                syncBannerStatus();
                break;
            }
            case 'sectionDone': {
                const state = sectionState.get(event.sectionId);
                if (!state) return;
                state.status = 'complete';
                if (!state.static) {
                    const html = finalSectionHtml(state);
                    void webview.postMessage({
                        kind: 'replace',
                        sectionId: event.sectionId,
                        bodyHtml: html,
                    });
                    for (const sentence of state.speech.flush()) {
                        void webview.postMessage({
                            kind: 'speech',
                            sectionId: event.sectionId,
                            text: sentence,
                        });
                    }
                }
                void webview.postMessage({
                    kind: 'speechSectionDone',
                    sectionId: event.sectionId,
                });
                void webview.postMessage({
                    kind: 'sectionStatus',
                    sectionId: event.sectionId,
                    status: 'complete',
                });
                syncBannerStatus();
                break;
            }
            case 'done': {
                for (const [id, state] of sectionState) {
                    if (state.status === 'complete') continue;
                    if (!state.static) {
                        const html = finalSectionHtml(state);
                        void webview.postMessage({ kind: 'replace', sectionId: id, bodyHtml: html });
                        for (const sentence of state.speech.flush()) {
                            void webview.postMessage({
                                kind: 'speech',
                                sectionId: id,
                                text: sentence,
                            });
                        }
                    }
                    state.status = 'complete';
                    void webview.postMessage({
                        kind: 'speechSectionDone',
                        sectionId: id,
                    });
                    void webview.postMessage({
                        kind: 'sectionStatus',
                        sectionId: id,
                        status: 'complete',
                    });
                }
                syncBannerStatus();
                break;
            }
        }
    };
}
