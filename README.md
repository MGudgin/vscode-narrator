# Code Narration

LLM-powered narration of source files and diffs, rendered in a side pane in VS Code.

The extension splits a file into its symbols (top-level by default; recursive on opt-in), fans out parallel calls to a language model, and streams each section's markdown narration into a webview beside the editor. Section headings are deep links into the source, and a per-section status dot tracks each call's progress. Diff mode narrates only what changed vs a configurable git ref.

## Install (from VSIX)

1. Download the `.vsix` from the release.
2. In VS Code: **Command Palette** → **Extensions: Install from VSIX...** → pick the file.
3. Reload if prompted.

## Pick a model

The default provider is VS Code's built-in Language Model API, which requires GitHub Copilot to be installed and active. If you don't have Copilot, switch to Anthropic:

1. **Command Palette** → **Code Narration: Set Anthropic API Key** → paste your `sk-ant-...` key. Stored in SecretStorage.
2. **Command Palette** → **Code Narration: Pick Model** → choose Sonnet 4.6 (default), Opus 4.7, or Haiku 4.5.

You can also edit settings directly:

- `codeNarration.provider` — `vscodeLm` | `anthropic`
- `codeNarration.anthropic.model` — model id
- `codeNarration.vscodeLm.modelFamily` — optional family filter

## Use

- **Open Narration** — the book icon in the editor title bar (or **Code Narration: Open Narration**) narrates the active file.
- **Open Diff Narration** — the git-compare icon (or **Code Narration: Open Diff Narration**) narrates only what changed in the active file vs `codeNarration.diffBase` (default `HEAD`).
- **Open Tree Diff Narration** — **Code Narration: Open Tree Diff Narration** narrates every changed file in the current repo vs `codeNarration.diffBase`, as one section per file plus an overview. With multiple repos in the workspace and no active editor, you'll be prompted to pick.
- **Click a section heading** in the narration pane to jump the editor to that range. In tree-diff mode, sections for deleted files render as headings without a link.
- **Cursor sync**: moving the cursor in the editor highlights the matching section in the narration pane.
- **On save**: if the narrated file is saved, the narration re-runs (debounced). Toggle with `codeNarration.narrateOnSave`.
- **Follow active editor**: enable `codeNarration.followActiveEditor` to retarget file-mode narration as focus moves between files. Diff and tree-diff stay pinned regardless.
- **Speech**: enable `codeNarration.speech.enabled` to show TTS controls in the banner (play / pause / stop, voice picker, rate slider). With `codeNarration.speech.autoPlay` on, sentences are spoken as they stream in.

### What you'll see

- **Per-section status dot** next to each heading: grey while waiting for a worker, amber and pulsing while chunks stream in, green once the section is complete. Diff mode shows a single dot at the top of the pane in the same colour scheme.
- **Streaming bodies**: each section's prose fills in as the model produces it; sections in the symbol fan-out complete independently and out of order.
- **Banner** at the top of the pane shows the active target (`Full file` or `Diff vs <ref>`) and a **↻ Refresh** link that re-runs while bypassing the cache. A `• Cached` suffix appears when the result came from cache.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `codeNarration.provider` | `vscodeLm` | `vscodeLm` or `anthropic` |
| `codeNarration.vscodeLm.modelFamily` | `""` | Optional family for VS Code LM picks |
| `codeNarration.anthropic.model` | `claude-sonnet-4-6` | Any Anthropic model id |
| `codeNarration.anthropic.maxOutputTokens` | `16384` | Max tokens an Anthropic narration may emit per request. Raise if long symbols / diffs are getting cut off (a truncation marker appears in the section); lower to cap spend. Should not exceed the model's documented max (Sonnet 4.6: 64k, Opus 4.7: 32k, Haiku 4.5: 8k). |
| `codeNarration.diffBase` | `HEAD` | Git ref for diff mode |
| `codeNarration.narrateOnSave` | `true` | Re-narrate after save |
| `codeNarration.followActiveEditor` | `false` | In file mode, retarget the pane as the active editor changes. Diff / tree-diff targets stay pinned. |
| `codeNarration.symbolConcurrency` | `4` | Max parallel LLM calls during symbol-aware fan-out (1–16) |
| `codeNarration.recurseSymbols` | `"auto"` | Narrate child symbols as their own sections. `"auto"` recurses for container-heavy languages and stays top-level for others; `"always"` forces recursion; `"never"` forces top-level only |
| `codeNarration.maxPromptTokens` | `50000` | Token budget per prompt body; oversized symbols are sub-chunked and merged |
| `codeNarration.streamIdleTimeoutMs` | `60000` | Max ms the LLM stream may go without emitting a chunk before the request is aborted and (where applicable) retried. Guards against hung proxies and stalled SSE connections. `0` disables. |
| `codeNarration.persona` | `"default"` | Active narration persona. Built-ins: `default`, `critical`, `security`, `performance`, `tests`, `onboarding`. Custom ids from `codeNarration.customPersonas` are also accepted. |
| `codeNarration.customPersonas` | `{}` | Map of user-defined personas (id → `{displayName, description, preamble, systemPrompt, ...}`). See [Custom personas](#custom-personas). |
| `codeNarration.speech.enabled` | `false` | Show TTS controls in the narration pane and enable the system speech voices (Web Speech API). |
| `codeNarration.speech.autoPlay` | `false` | Speak sentences automatically as they stream in. Requires `speech.enabled`. |
| `codeNarration.speech.voice` | `""` | Preferred voice name. Empty uses the system default. Set via **Code Narration: Pick Voice**. |
| `codeNarration.speech.rate` | `1.0` | Speech rate multiplier (0.5 = half speed, 2.0 = double speed). |
| `codeNarration.speech.pitch` | `1.0` | Speech pitch multiplier (0 = lowest, 2 = highest). |

`"auto"` (the default) recurses for languages whose top level is mostly namespaces and classes — C#, Java, C/C++, Kotlin, Swift, Scala, F#, VB, Objective-C/C++ — so methods, properties, and events each get their own section, and stays top-level only for everything else. Set the value globally or under a `[language]` scope to override. Legacy boolean values (`true`/`false`) are still honored as `"always"`/`"never"`.

## Personas

A persona controls the *lens* a narration uses — the same code reads very differently as "what does this do?" vs "what's risky here?" — without changing the output format (line-numbered links, no fenced code blocks, etc.). Switch via `codeNarration.persona` or **Code Narration: Pick Persona**. The active persona is shown in the narration pane banner whenever it isn't the default, and is part of the cache key so swapping personas serves a fresh narration.

Built-in personas:

| Id | Lens |
| --- | --- |
| `default` | What does this code do and why does it exist? |
| `critical` | What's questionable, missing, or risky? Pushback you'd raise in PR review. |
| `security` | Untrusted-input flow, auth, injection, secrets, dependency risks. |
| `performance` | Hot paths, allocations, blocking calls, async pitfalls, big-O concerns. |
| `tests` | Branches and edge cases that aren't covered. What tests would I write? |
| `onboarding` | Explain this to someone new to the codebase. Frame intent before mechanics. |
| `refactor-scout` | Concrete restructurings that would simplify or de-duplicate this code. |
| `doc-comment-writer` | Output formatted as docstrings/inline comments aimed at a future maintainer. |
| `accessibility-reviewer` | ARIA, keyboard navigation, contrast, hard-coded user-facing strings. |
| `cost-analyst` | Retry storms, fan-out, idempotency, expensive synchronous calls in hot paths. |

### Per-invocation override

**Code Narration: Open Narration with…** and **Code Narration: Open Diff Narration with…** prompt for a persona via quick-pick (or take one as a command argument) and use it just for that narration. Subsequent save/refresh re-runs of the same target keep using the chosen persona; opening a fresh narration without `with…` reverts to the `codeNarration.persona` setting. A keybinding can target a specific persona by passing its id:

```jsonc
// keybindings.json
{
  "key": "ctrl+shift+s",
  "command": "codeNarration.openDiffWithPersona",
  "args": "security"
}
```

### Custom personas

Define your own lenses with the `codeNarration.customPersonas` setting. Each entry is keyed by a persona id (1-64 chars: letters, digits, `-`, `_`) and may set a user-visible `displayName`, a `description`, and prompt overrides. The simplest shape extends the built-in output rules with a single `preamble` sentence:

```jsonc
"codeNarration.customPersonas": {
  "pci-aware": {
    "displayName": "PCI-aware reviewer",
    "description": "Fintech house style: flag PCI-DSS-relevant code paths.",
    "preamble": "You are reviewing this code with PCI-DSS in mind. Call out cardholder data handling, key management, and audit-trail gaps."
  }
}
```

You can also fully override any prompt slot (`systemPrompt`, `symbolSystemPrompt`, `diffSystemPrompt`, `treeSummarySystemPrompt`, `treeFileDiffSystemPrompt`); slots you don't override fall back to the built-in base prompts with your `preamble` (if any) prepended, so you don't have to re-state the shared output formatting rules.

Custom personas appear in the `Pick Persona` quick-pick (marked with a ✎ icon) and are accepted by the `codeNarration.persona` setting. Each persona's cache tag includes a hash of its prompts, so editing a custom persona invalidates only its cached narrations. Invalid entries (id collisions with built-ins, unknown fields, oversize prompts, etc.) are skipped at load time and surface a one-shot warning rather than breaking narration.

## Commands

| Command | Description |
| --- | --- |
| Code Narration: Open Narration | Narrate the active file |
| Code Narration: Open Diff Narration | Narrate the active file's diff vs base ref |
| Code Narration: Open Narration with… | Narrate the active file with a persona override (#23). Persona id can be passed as an argument for keybindings. |
| Code Narration: Open Diff Narration with… | Same, for diff narration. |
| Code Narration: Open Tree Diff Narration | Narrate every changed file in the repo vs base ref |
| Code Narration: Refresh Narration | Re-run, bypassing the cache |
| Code Narration: Pick Model | Quick-pick a model |
| Code Narration: Pick Persona | Quick-pick the active narration persona |
| Code Narration: Set Anthropic API Key | Store / clear the Anthropic key |
| Code Narration: Clear Cache | Wipe cached narrations for this workspace |
| Code Narration: Speak Narration | Start TTS playback of the current narration |
| Code Narration: Stop Speech | Stop TTS playback |
| Code Narration: Pick Voice | Quick-pick the TTS voice (sets `codeNarration.speech.voice`) |

## Notes

- The cache is keyed by `(target, content, provider, model, prompt-version)` and lives in workspaceState; switching models or editing prompt files invalidates entries naturally.
- All `command:` URIs in narration markdown are restricted to `codeNarration.reveal` (jumps the editor); the only other allowed command URI is the banner's own host-generated `codeNarration.refresh` link, which is emitted directly by the host (never by the LLM) and never passes through the markdown allowlist. See `isAllowedLinkUrl` in `src/webview.ts` for the source of truth.
- Transient stream errors (network blips, rate limits) are retried per section with exponential backoff before failing. A stream that goes idle for longer than `codeNarration.streamIdleTimeoutMs` (default 60 s) is aborted and retried.
- Massive single symbols (thousands of lines, no nested structure) that would blow past the model's context window are split into overlapping line-range sub-chunks under `codeNarration.maxPromptTokens` (default 50 000), narrated independently, then merged into the section with line-range subheadings. The same sub-chunking applies to whole-file diff narration and to the no-symbols fallback.
- If an Anthropic response hits `codeNarration.anthropic.maxOutputTokens`, a `_(response truncated — model hit max_tokens)_` marker is appended to the section so silent truncation is always visible.
- In tree-diff mode, inline references inside a *deleted* file's section render as plain text rather than as `command:` reveal links — there's no useful destination for "line 5 of the deleted file."

## Building from source

```bash
npm install
npm test          # vitest unit tests
npm run lint      # eslint
npm run compile   # type-check + lint + esbuild bundle
npm run package   # produces code-narration-<version>.vsix
```

## License

MIT — see `LICENSE`.
