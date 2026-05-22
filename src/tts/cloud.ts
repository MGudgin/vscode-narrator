/**
 * Cloud TTS provider — deliberate stub for Phase 3 (#66).
 *
 * The class encodes the shape a real implementation must take but does no
 * network work. It throws `CloudTtsProviderNotImplementedError` from `speak`
 * and returns an empty `listVoices`. The dispatch in `selectTtsProvider`
 * already gates this behind a feature flag, so production users currently
 * cannot reach this code by accident.
 *
 * Outstanding work for a real implementation:
 *
 * - **Azure Cognitive Services Speech**: REST or WebSocket streaming TTS via
 *   `speech.platform.bing.com`. Voice list comes from
 *   `https://<region>.tts.speech.microsoft.com/cognitiveservices/voices/list`.
 *   Audio frames stream as `audio/mpeg` (or `ogg-opus`) chunks; forward them
 *   via `postMessage` to the webview, which plays them with `MediaSource` +
 *   `SourceBuffer`.
 * - **ElevenLabs**: `POST /v1/text-to-speech/{voice_id}/stream`, streams MP3.
 *   Voice list from `GET /v1/voices`.
 * - **OpenAI TTS**: `POST /v1/audio/speech` with `stream_format: "audio"`.
 * - **API keys**: store via `context.secrets`, mirroring `storeAnthropicKey`.
 * - **Cancellation**: propagate `CancellationToken` into `AbortController.signal`
 *   so partial audio stops on cancel. Emit a final `error` event if the cloud
 *   call fails so the host can surface a non-blocking banner.
 * - **Failure modes**: bad key / network error must surface as a visible
 *   status (banner or status-bar message) rather than silently falling back
 *   to the OS voices — Phase 3 acceptance criteria.
 */
import type * as vscode from 'vscode';
import { TtsEvent, TtsProvider, TtsProviderKind, TtsVoice, SpeakRequest, TtsProviderDeps } from './index';

export class CloudTtsProviderNotImplementedError extends Error {
    constructor(kind: TtsProviderKind) {
        super(`Cloud TTS provider '${kind}' is not yet implemented. Set codeNarration.speech.provider back to 'webSpeech'.`);
        this.name = 'CloudTtsProviderNotImplementedError';
    }
}

export class CloudTtsProvider implements TtsProvider {
    readonly kind: TtsProviderKind;

    constructor(kind: TtsProviderKind, private readonly _deps: TtsProviderDeps) {
        this.kind = kind;
    }

    async listVoices(): Promise<TtsVoice[]> {
        // TODO(#66): fetch voices from the chosen cloud provider's voices
        // endpoint (Azure: /voices/list, ElevenLabs: /v1/voices, OpenAI:
        // hard-coded list). Cache for the duration of the session.
        return [];
    }

    async *speak(_request: SpeakRequest, _token: vscode.CancellationToken): AsyncIterable<TtsEvent> {
        // TODO(#66): synthesize audio from the cloud provider, stream chunks
        // back as `{ kind: 'audio', chunk, mime }` events, and propagate
        // cancellation via `AbortController.signal`.
        // The `yield` below is unreachable but keeps TypeScript happy about the
        // declared `AsyncIterable<TtsEvent>` return type, and the throw runs
        // first so callers always observe the not-implemented error.
        if (this.kind) throw new CloudTtsProviderNotImplementedError(this.kind);
        yield { kind: 'error', message: 'unreachable' };
    }
}
