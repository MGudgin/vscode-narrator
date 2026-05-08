# Code Narration

LLM-powered narration of source files and diffs, rendered in a side pane in VS Code.

The extension splits a file into top-level symbols, fans out parallel calls to a language model, and streams the resulting markdown narration into a webview beside the editor. Section headings are deep links into the source. Diff mode narrates only what changed vs a configurable git ref.

## Install (from VSIX)

1. Download the `.vsix` from the release.
2. In VS Code: **Command Palette** → **Extensions: Install from VSIX...** → pick the file.
3. Reload if prompted.

## Pick a model

The default provider is VS Code's built-in Language Model API, which requires GitHub Copilot to be installed (any subscription level — the extension just borrows the model). If you don't have Copilot, switch to Anthropic:

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
- **Refresh** link in the narration banner — re-runs and bypasses the cache.
- **On save**: if the narrated file is saved, the narration re-runs (debounced). Toggle with `codeNarration.narrateOnSave`.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `codeNarration.provider` | `vscodeLm` | `vscodeLm` or `anthropic` |
| `codeNarration.vscodeLm.modelFamily` | `""` | Optional family for VS Code LM picks |
| `codeNarration.anthropic.model` | `claude-sonnet-4-6` | Any Anthropic model id |
| `codeNarration.diffBase` | `HEAD` | Git ref for diff mode |
| `codeNarration.narrateOnSave` | `true` | Re-narrate after save |

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

## License

MIT — see `LICENSE`.
