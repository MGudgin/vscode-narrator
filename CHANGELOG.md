# Changelog

## 0.1.1 — 2026-05-08

### Added

- Transient stream errors (network blips, rate-limit hiccups) now retry per section with exponential backoff before failing. (#17)

### Changed

- Bumped `esbuild` to `^0.25.0` and `vitest` to `^3.0.0` to clear advisory GHSA-67mh-4wv8-2f99. (#33)
- Tightened `.vscodeignore` so CI workflow yamls, test files, and dev-only configs no longer ship in the `.vsix`. Payload is 8 files vs. the previous 11.
- README brought up to date with current behavior — settings table now lists `symbolConcurrency` and `recurseSymbols`, plus a "What you'll see" subsection covering per-section status dots, streaming, and the banner. New "Building from source" section documents the canonical npm scripts. (#36)
- Removed an outdated `(used in phase 4)` parenthetical from the `codeNarration.diffBase` setting description.

### Internal

- Test suite grew from 17 to 78 tests covering `target`, `symbols`, `narrate`, expanded `cache`, `llm/index`, and the new `retry` module. (#28)
- `symbols.ts` and `narrate.ts` refactored to accept injected dependencies (`SymbolFetcher`, etc.) so unit tests mock cleanly without touching the extension host.

## 0.1.0 — 2026-05-08

Initial dogfooding release.

### Features

- Full-file narration with symbol-aware chunking and parallel fan-out (up to 4 concurrent calls).
- Diff narration vs a configurable git ref (default `HEAD`); short-circuits on no-changes; banner-frames newly added files.
- Code-to-narration sync: cursor in editor scrolls and highlights the matching section.
- Per-section status indicators (queued / streaming / complete) on full-file narration; section-level dot for headless diff narration.
- Section deep links jump to exact symbol ranges.
- Streaming token rendering with per-section throttling.
- Workspace-state cache; refresh skips the cache; manual "Clear Cache" command.
- Provider abstraction: VS Code Language Model API (default, requires GitHub Copilot) and Anthropic SDK (key stored in SecretStorage).
- Quick-pick model selector ("Pick Model" command).
- Configurable symbol concurrency (`codeNarration.symbolConcurrency`) and opt-in recursion into child symbols (`codeNarration.recurseSymbols`).
