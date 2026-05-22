/**
 * Pluggable TTS provider abstraction.
 *
 * Phase 1 (#63) hard-wired spoken narration to the Web Speech API running
 * inside the narration webview. Phase 3 (#66) splits that integration into a
 * provider interface so a future cloud TTS backend (Azure / ElevenLabs /
 * OpenAI) can be added without touching the rest of the pipeline.
 *
 * Today only `WebSpeechTtsProvider` is functional. `CloudTtsProvider` is a
 * deliberate stub: it documents the shape a future implementation must take,
 * but throws when invoked. Provider selection is also gated behind a feature
 * flag (`codeNarration.speech.providerExperimental`) so that until cloud
 * support lands, switching `codeNarration.speech.provider` to a non-default
 * value is a silent no-op rather than a way to wedge speech entirely.
 *
 * See `docs/tts-providers.md` for the broader design notes.
 */
import type * as vscode from 'vscode';

/** Identifier for a TTS provider implementation. */
export type TtsProviderKind = 'webSpeech' | 'azure' | 'elevenlabs' | 'openai';

/** Default provider. Matches the historical Phase 1 behavior. */
export const DEFAULT_TTS_PROVIDER: TtsProviderKind = 'webSpeech';

/** Setting key for the active provider. */
export const TTS_PROVIDER_SETTING = 'codeNarration.speech.provider';
/** Setting key for the experimental feature flag gating non-default providers. */
export const TTS_PROVIDER_EXPERIMENTAL_SETTING = 'codeNarration.speech.providerExperimental';

/**
 * A voice as surfaced to the user, regardless of provider. The fields mirror
 * the relevant subset of Web Speech's `SpeechSynthesisVoice` plus a `provider`
 * tag so the quick-pick can group voices when multiple providers are wired
 * in.
 */
export interface TtsVoice {
    /** Stable voice identifier, unique within its provider. */
    name: string;
    /** BCP-47 language tag, e.g. `en-US`. */
    lang: string;
    /** Originating provider — useful when listing across providers. */
    provider: TtsProviderKind;
    /** True if the provider considers this voice its default. */
    default?: boolean;
    /** Web Speech only: true if the voice runs locally rather than via a remote server. */
    localService?: boolean;
}

/** A single utterance request. */
export interface SpeakRequest {
    /** Plain-text content (already markdown-stripped) to speak. */
    text: string;
    /** Optional narration section id; lets the UI mark which section is speaking. */
    sectionId?: string;
    /** Optional voice name override, otherwise the provider's default applies. */
    voice?: string;
    /** Speech rate multiplier, where 1.0 = normal. */
    rate?: number;
    /** Pitch multiplier, where 1.0 = normal. */
    pitch?: number;
}

/**
 * A streamed event from `TtsProvider.speak`. The browser-side WebSpeech path
 * only ever emits `sentenceStart` / `sentenceEnd` / `done`, since audio is
 * synthesized in-process. Cloud providers also emit `audio` frames.
 */
export type TtsEvent =
    | { kind: 'sentenceStart'; sectionId?: string; text: string }
    | { kind: 'sentenceEnd'; sectionId?: string }
    | { kind: 'audio'; chunk: Uint8Array; mime: string; sectionId?: string }
    | { kind: 'done'; sectionId?: string }
    | { kind: 'error'; sectionId?: string; message: string };

/** The contract every TTS backend must satisfy. */
export interface TtsProvider {
    readonly kind: TtsProviderKind;
    /** Speak the request; cancellation must stop streaming and any in-flight audio. */
    speak(request: SpeakRequest, token: vscode.CancellationToken): AsyncIterable<TtsEvent>;
    /** Enumerate available voices. Returns an empty array if voices have not yet loaded. */
    listVoices(): Promise<TtsVoice[]>;
    /** Optional teardown for long-lived resources (sockets, audio elements, …). */
    dispose?(): void;
}

/** Inputs to `selectTtsProvider`. Kept narrow so the dispatch is trivially testable. */
export interface TtsProviderSelectionInput {
    /** Raw value of `codeNarration.speech.provider`. */
    requested: string | undefined;
    /** Raw value of `codeNarration.speech.providerExperimental`. */
    experimental: boolean | undefined;
}

/** Decision returned by `selectTtsProvider`. */
export interface TtsProviderSelection {
    /** The provider kind that should actually be used. */
    kind: TtsProviderKind;
    /** True when the user requested something other than the default. */
    requestedNonDefault: boolean;
    /** Why the chosen `kind` differs from the requested value, if it does. */
    fallbackReason?: 'unknownProvider' | 'experimentalDisabled';
}

const KNOWN_PROVIDERS: ReadonlySet<TtsProviderKind> = new Set<TtsProviderKind>([
    'webSpeech', 'azure', 'elevenlabs', 'openai',
]);

function isKnownProvider(value: unknown): value is TtsProviderKind {
    return typeof value === 'string' && (KNOWN_PROVIDERS as ReadonlySet<string>).has(value);
}

/**
 * Choose the TTS provider kind given the user's requested setting and the
 * experimental feature flag. The default provider is always selectable; any
 * other selection requires the feature flag to be on. Unknown values fall
 * back to the default with `fallbackReason='unknownProvider'` so callers can
 * surface a one-time diagnostic.
 */
export function selectTtsProvider(input: TtsProviderSelectionInput): TtsProviderSelection {
    const requested = input.requested && input.requested.length > 0 ? input.requested : DEFAULT_TTS_PROVIDER;
    if (!isKnownProvider(requested)) {
        return { kind: DEFAULT_TTS_PROVIDER, requestedNonDefault: true, fallbackReason: 'unknownProvider' };
    }
    if (requested === DEFAULT_TTS_PROVIDER) {
        return { kind: DEFAULT_TTS_PROVIDER, requestedNonDefault: false };
    }
    if (!input.experimental) {
        return {
            kind: DEFAULT_TTS_PROVIDER,
            requestedNonDefault: true,
            fallbackReason: 'experimentalDisabled',
        };
    }
    return { kind: requested, requestedNonDefault: true };
}

/** Dependencies a provider needs at construction time. Kept minimal so tests can pass plain fakes. */
export interface TtsProviderDeps {
    /** Returns the voices most recently reported by the webview, in `webSpeech` order. */
    getCachedWebSpeechVoices: () => readonly { name: string; lang: string; default?: boolean; localService?: boolean }[];
    /** Returns the API key for a cloud provider, or undefined if not configured. */
    getCloudApiKey: (kind: TtsProviderKind) => Promise<string | undefined>;
}

/**
 * Instantiate a `TtsProvider` for the chosen kind. Today this always returns a
 * `WebSpeechTtsProvider` because cloud providers are stubs; the dispatch is
 * already wired so they can be slotted in without touching call sites.
 */
export function makeTtsProvider(selection: TtsProviderSelection, deps: TtsProviderDeps): TtsProvider {
    if (selection.kind === 'webSpeech') {
        return new WebSpeechTtsProvider({ getCachedVoices: deps.getCachedWebSpeechVoices });
    }
    return new CloudTtsProvider(selection.kind, deps);
}

import { WebSpeechTtsProvider } from './webSpeech';
import { CloudTtsProvider } from './cloud';
export { WebSpeechTtsProvider } from './webSpeech';
export { CloudTtsProvider } from './cloud';
