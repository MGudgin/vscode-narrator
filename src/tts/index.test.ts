import { describe, test, expect } from 'vitest';
import {
    selectTtsProvider,
    makeTtsProvider,
    DEFAULT_TTS_PROVIDER,
    TtsProviderDeps,
} from './index';
import { WebSpeechTtsProvider } from './webSpeech';
import { CloudTtsProvider, CloudTtsProviderNotImplementedError } from './cloud';

function makeDeps(): TtsProviderDeps {
    return {
        getCachedWebSpeechVoices: () => [
            { name: 'Alice', lang: 'en-US', default: true, localService: true },
            { name: 'Bob', lang: 'fr-FR', default: false, localService: false },
        ],
        getCloudApiKey: async () => undefined,
    };
}

describe('selectTtsProvider', () => {
    test('returns the default provider when nothing is requested', () => {
        expect(selectTtsProvider({ requested: undefined, experimental: false }))
            .toEqual({ kind: 'webSpeech', requestedNonDefault: false });
    });

    test('returns the default provider when the empty string is requested', () => {
        expect(selectTtsProvider({ requested: '', experimental: false }))
            .toEqual({ kind: 'webSpeech', requestedNonDefault: false });
    });

    test('returns the default provider when webSpeech is explicitly requested', () => {
        expect(selectTtsProvider({ requested: 'webSpeech', experimental: true }))
            .toEqual({ kind: 'webSpeech', requestedNonDefault: false });
    });

    test('falls back to default for unknown providers and reports unknownProvider', () => {
        expect(selectTtsProvider({ requested: 'bogus', experimental: true }))
            .toEqual({
                kind: DEFAULT_TTS_PROVIDER,
                requestedNonDefault: true,
                fallbackReason: 'unknownProvider',
            });
    });

    test('falls back to default when a cloud provider is requested without the feature flag', () => {
        for (const kind of ['azure', 'elevenlabs', 'openai']) {
            expect(selectTtsProvider({ requested: kind, experimental: false }))
                .toEqual({
                    kind: DEFAULT_TTS_PROVIDER,
                    requestedNonDefault: true,
                    fallbackReason: 'experimentalDisabled',
                });
        }
    });

    test('honours a cloud provider request when the feature flag is on', () => {
        for (const kind of ['azure', 'elevenlabs', 'openai'] as const) {
            expect(selectTtsProvider({ requested: kind, experimental: true }))
                .toEqual({ kind, requestedNonDefault: true });
        }
    });

    test('treats experimental=undefined the same as experimental=false', () => {
        expect(selectTtsProvider({ requested: 'azure', experimental: undefined }))
            .toEqual({
                kind: DEFAULT_TTS_PROVIDER,
                requestedNonDefault: true,
                fallbackReason: 'experimentalDisabled',
            });
    });
});

describe('makeTtsProvider', () => {
    test('returns a WebSpeechTtsProvider for the webSpeech selection', async () => {
        const provider = makeTtsProvider({ kind: 'webSpeech', requestedNonDefault: false }, makeDeps());
        expect(provider).toBeInstanceOf(WebSpeechTtsProvider);
        expect(provider.kind).toBe('webSpeech');
        const voices = await provider.listVoices();
        expect(voices.map((v) => v.name)).toEqual(['Alice', 'Bob']);
        expect(voices.every((v) => v.provider === 'webSpeech')).toBe(true);
    });

    test('returns a CloudTtsProvider for any non-default selection', () => {
        for (const kind of ['azure', 'elevenlabs', 'openai'] as const) {
            const provider = makeTtsProvider({ kind, requestedNonDefault: true }, makeDeps());
            expect(provider).toBeInstanceOf(CloudTtsProvider);
            expect(provider.kind).toBe(kind);
        }
    });
});

describe('WebSpeechTtsProvider', () => {
    test('listVoices proxies the host-side cached voice list', async () => {
        const provider = new WebSpeechTtsProvider({
            getCachedVoices: () => [
                { name: 'Alice', lang: 'en-US', default: true, localService: true },
            ],
        });
        const voices = await provider.listVoices();
        expect(voices).toEqual([
            { name: 'Alice', lang: 'en-US', default: true, localService: true, provider: 'webSpeech' },
        ]);
    });

    test('listVoices returns an empty array when the webview has not yet reported voices', async () => {
        const provider = new WebSpeechTtsProvider({ getCachedVoices: () => [] });
        expect(await provider.listVoices()).toEqual([]);
    });

    test('speak emits sentenceStart / sentenceEnd / done because playback runs in the webview', async () => {
        const provider = new WebSpeechTtsProvider({ getCachedVoices: () => [] });
        const events = [];
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        for await (const ev of provider.speak({ text: 'hello', sectionId: 's1' }, token as never)) {
            events.push(ev);
        }
        expect(events).toEqual([
            { kind: 'sentenceStart', sectionId: 's1', text: 'hello' },
            { kind: 'sentenceEnd', sectionId: 's1' },
            { kind: 'done', sectionId: 's1' },
        ]);
    });
});

describe('CloudTtsProvider', () => {
    test('listVoices returns an empty array because no cloud backend is wired yet', async () => {
        const provider = new CloudTtsProvider('azure', makeDeps());
        expect(await provider.listVoices()).toEqual([]);
    });

    test('speak throws CloudTtsProviderNotImplementedError', async () => {
        const provider = new CloudTtsProvider('elevenlabs', makeDeps());
        const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        await expect((async () => {
            for await (const ev of provider.speak({ text: 'hi' }, token as never)) {
                void ev;
            }
        })()).rejects.toBeInstanceOf(CloudTtsProviderNotImplementedError);
    });
});
