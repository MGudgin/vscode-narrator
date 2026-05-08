# Changelog

## 0.1.0 — 2026-05-08

Initial dogfooding release.

### Features

- Full-file narration with symbol-aware chunking and parallel fan-out (up to 4 concurrent calls).
- Diff narration vs a configurable git ref (default `HEAD`); short-circuits on no-changes; banner-frames newly added files.
- Code-to-narration sync: cursor in editor scrolls and highlights the matching section.
- Per-section status indicators (queued / streaming / complete) on full-file narration.
- Section deep links jump to exact symbol ranges.
- Streaming token rendering with per-section throttling.
- Workspace-state cache; refresh skips the cache; manual "Clear Cache" command.
- Provider abstraction: VS Code Language Model API (default, requires GitHub Copilot) and Anthropic SDK (key stored in SecretStorage).
- Quick-pick model selector ("Pick Model" command).

### Known limitations

- Diff narration shows no per-section status dot (single-section, no built heading to attach to).
- Whole-tree diff narration not yet implemented.
- Recursive symbol traversal and configurable concurrency are not yet exposed as settings.
