# Changelog

## 0.2.0 — 2026-05-11

### Added

- Whole-tree diff narration mode: new `Open Tree Diff Narration` command (in the SCM title bar) narrates every changed file in the working tree against `codeNarration.diffBase` in a single pane. (#14, #51)
- Banner-level streaming indicator surfaces in-flight LLM activity at the top of the narration pane, separate from per-section dots. (#15, #43)
- Oversized symbols are now sub-chunked before the LLM call: when a symbol's prompt would exceed `codeNarration.maxPromptTokens`, it is split into overlapping line-range sub-chunks, each narrated independently, and the results are merged. New `codeNarration.maxPromptTokens` setting (default `50000`) controls the budget. (#19, #45)

### Changed

- `codeNarration.recurseSymbols` now ships per-language defaults under `auto` (the new default): container-heavy languages (C#, Java, C/C++, Kotlin, Swift, Scala, F#, VB, Objective-C/C++) recurse into child symbols; others stay top-level. Legacy boolean values (`true`/`false`) are still honored as `always`/`never`. (#39, #41)
- Narration cache is now keyed at the section level instead of the whole-file level, so edits to one section no longer invalidate untouched sections in the same file. (#25, #54)

### Fixed

- `src/cache.ts` was being classified as binary by git due to an early non-text byte; the file is now plain text and diffs render normally. (#48)

### Internal

- Added `@vscode/test-electron` integration test harness covering real extension-host scenarios. Tier 1 covers cache hits, refresh, preamble edits, and `recurseSymbols`; tier 2 covers diff, tree-diff, and a reusable git fixture helper. (#29, #55, #56, #57)
- Extracted the narration sink and introduced a provider factory for dependency injection, paving the way for headless test scenarios. (#53)

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
