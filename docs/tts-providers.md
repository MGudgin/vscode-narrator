# TTS provider extension point

Status: **design** — Phase 3 (#66) introduced the provider interface and a
WebSpeech implementation. Cloud providers are stubs and disabled in
production.

## Motivation

Phase 1 (#63) shipped spoken narration via the Web Speech API. Quality is
good on Windows 11 / macOS, mediocre on Linux. Cloud TTS (Azure,
ElevenLabs, OpenAI) delivers higher-fidelity voices at the cost of an API
key and per-character billing. We want a clean seam to swap implementations
without rewriting the speech glue.

The new abstraction also mirrors the LLM provider factory in `src/llm/index.ts`,
so the two halves of the extension follow the same shape.

## Interfaces

All types live in `src/tts/index.ts`.

```ts
type TtsProviderKind = 'webSpeech' | 'azure' | 'elevenlabs' | 'openai';

interface TtsVoice {
  name: string;            // stable id within the provider
  lang: string;            // BCP-47, e.g. "en-US"
  provider: TtsProviderKind;
  default?: boolean;
  localService?: boolean;  // webSpeech only
}

interface SpeakRequest {
  text: string;            // plain-text, markdown already stripped
  sectionId?: string;      // optional narration section id
  voice?: string;          // optional override
  rate?: number;           // 1.0 = normal
  pitch?: number;          // 1.0 = normal
}

type TtsEvent =
  | { kind: 'sentenceStart'; sectionId?: string; text: string }
  | { kind: 'sentenceEnd';   sectionId?: string }
  | { kind: 'audio';         chunk: Uint8Array; mime: string; sectionId?: string }
  | { kind: 'done';          sectionId?: string }
  | { kind: 'error';         sectionId?: string; message: string };

interface TtsProvider {
  readonly kind: TtsProviderKind;
  speak(request: SpeakRequest, token: vscode.CancellationToken): AsyncIterable<TtsEvent>;
  listVoices(): Promise<TtsVoice[]>;
  dispose?(): void;
}
```

## Dispatch

`selectTtsProvider({ requested, experimental })` returns:

```ts
interface TtsProviderSelection {
  kind: TtsProviderKind;
  requestedNonDefault: boolean;
  fallbackReason?: 'unknownProvider' | 'experimentalDisabled';
}
```

Rules:

- Unknown values fall back to `webSpeech` with `unknownProvider`.
- Any non-default provider requires `codeNarration.speech.providerExperimental`
  to be `true`. Without the flag, the dispatch silently picks `webSpeech` and
  reports `experimentalDisabled` so the caller can surface a one-time
  diagnostic.
- The default (`webSpeech`) is always selectable, regardless of the flag.

`makeTtsProvider(selection, deps)` constructs the provider:

- `webSpeech` → `WebSpeechTtsProvider` (thin wrapper around the host-side
  cached voice list; playback continues in the webview).
- `azure | elevenlabs | openai` → `CloudTtsProvider` (stub that throws on
  `speak`).

## Settings

```jsonc
{
  // The active provider. Defaults to webSpeech.
  "codeNarration.speech.provider": "webSpeech",

  // Feature flag that gates non-default providers. Until cloud providers ship,
  // this is the only way to opt in to the experimental path.
  "codeNarration.speech.providerExperimental": false
}
```

API keys for cloud providers will use `vscode.SecretStorage`, mirroring
`storeAnthropicKey` in `src/llm/index.ts`. The exact key names will be:

- `codeNarration.azureSpeechKey` + a region setting
- `codeNarration.elevenLabsApiKey`
- `codeNarration.openaiApiKey`

(Not yet declared — they land alongside the implementations.)

## Audio transport

Web Speech synthesizes audio in the webview, so the host-side provider only
emits `sentenceStart` / `sentenceEnd` / `done`. The webview's
`SPEECH_CLIENT_JS` already owns the playback queue and per-section ▶
buttons; no transport changes are needed.

Cloud providers will need to push audio frames into the webview:

1. Provider yields `{ kind: 'audio', chunk: Uint8Array, mime, sectionId }`.
2. The narration pipeline base64-encodes the chunk and posts
   `{ kind: 'speechAudio', sectionId, mime, b64 }` to the webview.
3. The webview client opens a `MediaSource` + `SourceBuffer` per section and
   appends chunks as they arrive. The existing per-section ▶ button maps to
   a `MediaSource.endOfStream()` + audio element play.

Open questions:

- **MIME negotiation**: Azure can emit `audio/mpeg` or `audio/ogg`;
  ElevenLabs is MP3. WebKit and Firefox have different `SourceBuffer`
  compatibility — pick a common format (MP3) for the first cut.
- **Backpressure**: cap the per-section buffer at a small number of seconds
  and pause the cloud stream when the audio element is far behind playback.
- **Caching**: a (text + voice + provider) → audio cache would let
  refreshes replay without re-billing. Out of scope for Phase 3.

## Failure modes

Cloud providers must surface failures visibly:

- Bad API key → status-bar message and a non-blocking notification offering
  the relevant "Set …" command.
- Network error → `{ kind: 'error', message }` event, plus a status-bar
  badge on the narration pane.
- The speech pipeline must **not** silently fall back to the OS voices on a
  cloud failure — that hides bugs and surprises the user.

## Cancellation

`vscode.CancellationToken` is forwarded to an `AbortController.signal` for
HTTP-based providers; the in-flight `fetch` request is aborted, no further
audio chunks are yielded, and the webview drops any buffered audio for the
cancelled section.

## Tests

- `src/tts/index.test.ts` covers `selectTtsProvider` (default, explicit
  default, unknown value, feature-flag gating, cloud requests with and
  without the flag) and `makeTtsProvider` (which class comes back for each
  selection, including all three cloud kinds).
- `WebSpeechTtsProvider` is tested via its `listVoices` proxy and the trivial
  `speak` shape.
- `CloudTtsProvider.speak` is tested to throw `CloudTtsProviderNotImplementedError`
  so a real cloud implementation lands with a failing test rather than a
  silent stub.

## Migration plan

1. Land the abstraction + WebSpeech wrapper + feature flag (this PR).
2. Add `codeNarration.azureSpeechKey` (or equivalent), the cloud transport
   in `webview.ts`, and a real `AzureTtsProvider`. Flip the flag in the test
   workspace.
3. Add a second cloud provider so the abstraction earns its keep.
4. Promote `codeNarration.speech.provider` out of experimental once at least
   one cloud backend has shipped.
