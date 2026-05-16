/**
 * Web Speech API provider — the Phase 1 (#63) default path.
 *
 * Audio synthesis happens inside the narration webview using
 * `window.speechSynthesis`, so this host-side wrapper is intentionally thin:
 *
 *  - `listVoices` returns the most recent voice list the webview reported via
 *    its `voicesList` message (see `extension.ts`). The list may be empty
 *    until the webview has had a chance to load voices.
 *  - `speak` returns an empty async iterable because the webview owns
 *    playback end-to-end. The provider exists primarily so cloud providers can
 *    be plugged into the same dispatch shape without changing every caller.
 */
import type * as vscode from 'vscode';
import { TtsEvent, TtsProvider, TtsProviderKind, TtsVoice, SpeakRequest } from './index';

export interface WebSpeechTtsProviderDeps {
    /** Returns the voices most recently reported by the webview. */
    getCachedVoices: () => readonly { name: string; lang: string; default?: boolean; localService?: boolean }[];
}

export class WebSpeechTtsProvider implements TtsProvider {
    readonly kind: TtsProviderKind = 'webSpeech';

    constructor(private readonly deps: WebSpeechTtsProviderDeps) {}

    async listVoices(): Promise<TtsVoice[]> {
        return this.deps.getCachedVoices().map((v) => ({
            name: v.name,
            lang: v.lang,
            default: v.default,
            localService: v.localService,
            provider: 'webSpeech' as const,
        }));
    }

    /**
     * Web Speech playback is driven entirely from the webview today, so this
     * method emits a `done` event without producing audio. It exists only so
     * that cloud providers can present a uniform interface to the rest of the
     * extension.
     */
    async *speak(request: SpeakRequest, _token: vscode.CancellationToken): AsyncIterable<TtsEvent> {
        yield { kind: 'sentenceStart', sectionId: request.sectionId, text: request.text };
        yield { kind: 'sentenceEnd', sectionId: request.sectionId };
        yield { kind: 'done', sectionId: request.sectionId };
    }
}
