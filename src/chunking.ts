// Helpers for sub-chunking source-symbol prompts that would otherwise blow
// past the model's context window.
//
// Strategy: when a prompt body would exceed `maxPromptTokens`, split the
// underlying line range into N approximately-equal chunks, with a small
// overlap between consecutive chunks so the model doesn't lose context at
// boundaries (a function signature on line K should appear in the chunk
// that narrates its body, even if the cut falls mid-function).

export const DEFAULT_MAX_PROMPT_TOKENS = 50_000;

// Heuristic token estimator. The Anthropic SDK exposes
// `client.messages.countTokens` for an exact figure but that costs an extra
// network round-trip, so we use the standard `text.length / 4` rule of
// thumb for English-ish source code. Off by a small constant factor for
// dense token-heavy languages, but always conservative enough that we
// chunk *before* hitting the real context window.
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export interface SubChunkRange {
    startLine: number; // 0-indexed, inclusive
    endLine: number;   // 0-indexed, inclusive
}

export interface SplitOptions {
    maxPromptTokens: number;
    // Lines of overlap between consecutive chunks. Keeps boundary context
    // (e.g. an opening brace, an inner symbol declaration) visible to the
    // next chunk.
    overlapLines?: number;
    // Floor so chunks aren't single-line tail fragments after rounding.
    minChunkLines?: number;
}

export const DEFAULT_OVERLAP_LINES = 8;
const DEFAULT_MIN_CHUNK_LINES = 10;

/**
 * Decide whether a prompt-body string warrants sub-chunking.
 *
 * `bodyText` should be the *expanded* prompt body — typically the
 * line-numbered source for the symbol plus a small constant for the
 * surrounding boilerplate. The boilerplate cost is rolled into the token
 * estimate, not modeled separately, since it's small (< 200 chars) and the
 * heuristic itself has more error than that.
 */
export function shouldSubChunk(bodyText: string, maxPromptTokens: number): boolean {
    if (!Number.isFinite(maxPromptTokens) || maxPromptTokens <= 0) return false;
    return estimateTokens(bodyText) > maxPromptTokens;
}

/**
 * Split a line range into approximately equal chunks small enough to fit
 * within `maxPromptTokens`, given an estimate of the total character count
 * the range expands to in the final prompt.
 *
 * The line ranges are returned 0-indexed and inclusive. Consecutive ranges
 * overlap by `overlapLines` so the model sees enough surrounding context
 * to keep the narration coherent across the cut.
 *
 * Inputs are clamped: if startLine > endLine, returns [] ; if no split is
 * needed, returns a single range covering the whole input.
 */
export function splitLineRange(
    startLine: number,
    endLine: number,
    totalChars: number,
    options: SplitOptions,
): SubChunkRange[] {
    if (endLine < startLine) return [];

    const maxTokens = options.maxPromptTokens;
    const overlap = Math.max(0, options.overlapLines ?? DEFAULT_OVERLAP_LINES);
    const minChunkLines = Math.max(1, options.minChunkLines ?? DEFAULT_MIN_CHUNK_LINES);

    const totalLines = endLine - startLine + 1;
    const totalTokens = Math.ceil(totalChars / 4);

    if (!Number.isFinite(maxTokens) || maxTokens <= 0 || totalTokens <= maxTokens) {
        return [{ startLine, endLine }];
    }

    // How many chunks do we need? We aim for each chunk's token estimate to
    // sit comfortably under the budget — use 80% of the cap as the target so
    // there's headroom for the surrounding boilerplate (system prompt, file
    // header) that callers don't pass into the estimator.
    const targetTokensPerChunk = Math.floor(maxTokens * 0.8);
    const chunkCount = Math.max(2, Math.ceil(totalTokens / Math.max(1, targetTokensPerChunk)));

    // Approximately equal line slices, ignoring overlap for sizing.
    let baseLinesPerChunk = Math.ceil(totalLines / chunkCount);
    if (baseLinesPerChunk < minChunkLines) baseLinesPerChunk = minChunkLines;

    const ranges: SubChunkRange[] = [];
    let cursor = startLine;
    while (cursor <= endLine) {
        const chunkEnd = Math.min(endLine, cursor + baseLinesPerChunk - 1);
        ranges.push({ startLine: cursor, endLine: chunkEnd });
        if (chunkEnd >= endLine) break;
        // Advance, leaving `overlap` lines of trailing context shared with
        // the next chunk. Guarantee forward progress by stepping at least
        // 1 line even if overlap >= baseLinesPerChunk.
        const step = Math.max(1, baseLinesPerChunk - overlap);
        cursor += step;
    }

    return ranges;
}

/**
 * Format a 1-indexed line-range label used in chunk subheadings and merge
 * markers. Matches the `L<start>-L<end>` convention used elsewhere in the
 * narrator (see `prompt.ts` link rewriting).
 */
export function formatLineRangeLabel(range: SubChunkRange): string {
    const startOneBased = range.startLine + 1;
    const endOneBased = range.endLine + 1;
    if (startOneBased === endOneBased) return `L${startOneBased}`;
    return `L${startOneBased}-L${endOneBased}`;
}
