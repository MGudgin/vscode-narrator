import * as vscode from 'vscode';
import { NarrationSink } from './narrate';
import { NarrationTarget } from './target';
import { renderMarkdownToHtml, aggregateBannerStatus, BannerStatus, SectionStatus } from './webview';
import { fixupLinks } from './prompt';
import { SentenceBuffer, markdownToSpeech } from './speech';

const RENDER_THROTTLE_MS = 100;

interface SectionState {
    accumulated: string;
    lastRender: number;
    static: boolean;
    status: SectionStatus;
    linkUri: vscode.Uri;
    speech: SentenceBuffer;
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
        const next = aggregateBannerStatus(
            Array.from(sectionState.values(), (s) => s.status),
        );
        if (next === lastBannerStatus) return;
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
                    sectionState.set(s.id, {
                        accumulated: s.bodyMarkdown ?? '',
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
                const html = renderMarkdownToHtml(fixupLinks(state.accumulated, state.linkUri));
                void webview.postMessage({ kind: 'replace', sectionId: event.sectionId, bodyHtml: html });
                break;
            }
            case 'sectionReset': {
                const state = sectionState.get(event.sectionId);
                if (!state || state.static) return;
                state.accumulated = '';
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
                    const md = state.accumulated.trim().length > 0
                        ? state.accumulated
                        : '_(no narration produced for this section.)_';
                    const html = renderMarkdownToHtml(fixupLinks(md, state.linkUri));
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
                        const md = state.accumulated.trim().length > 0
                            ? state.accumulated
                            : '_(no narration produced for this section.)_';
                        const html = renderMarkdownToHtml(fixupLinks(md, state.linkUri));
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
