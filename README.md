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
- **Click a section heading** in the narration pane to jump the editor to that range.
- **Cursor sync**: moving the cursor in the editor highlights the matching section in the narration pane.
- **On save**: if the narrated file is saved, the narration re-runs (debounced). Toggle with `codeNarration.narrateOnSave`.

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
| `codeNarration.diffBase` | `HEAD` | Git ref for diff mode |
| `codeNarration.narrateOnSave` | `true` | Re-narrate after save |
| `codeNarration.symbolConcurrency` | `4` | Max parallel LLM calls during symbol-aware fan-out (1–16) |
| `codeNarration.recurseSymbols` | `false` (`true` for container-heavy languages — see below) | Narrate child symbols (e.g. methods inside a class) as their own sections |

For languages whose top level is mostly namespaces and classes — C#, Java, C/C++, Kotlin, Swift, Scala, F#, VB, Objective-C/C++ — `recurseSymbols` defaults to `true` so methods, properties, and events each get their own section. Other languages keep the top-level-only default. Set `codeNarration.recurseSymbols` globally or under a `[language]` scope to override.

## Commands

| Command | Description |
| --- | --- |
| Code Narration: Open Narration | Narrate the active file |
| Code Narration: Open Diff Narration | Narrate the active file's diff vs base ref |
| Code Narration: Refresh Narration | Re-run, bypassing the cache |
| Code Narration: Pick Model | Quick-pick a model |
| Code Narration: Set Anthropic API Key | Store / clear the Anthropic key |
| Code Narration: Clear Cache | Wipe cached narrations for this workspace |

## Notes

- The cache is keyed by `(target, content, provider, model, prompt-version)` and lives in workspaceState; switching models or editing prompt files invalidates entries naturally.
- All `command:` URIs in the narration are restricted to a `codeNarration.reveal` handler that jumps the editor; nothing else can be invoked from generated content.
- Transient stream errors (network blips, rate limits) are retried per section with exponential backoff before failing.

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
