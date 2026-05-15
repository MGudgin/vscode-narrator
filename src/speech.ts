/**
 * Helpers for turning streamed markdown narration into speakable plain text.
 *
 * The webview ultimately drives the speech via `window.speechSynthesis`. Our job
 * here is to deliver complete sentences in plain prose, so the synthesizer
 * gets natural prosody. Two pieces:
 *
 * - `markdownToSpeech` strips markdown syntax that would otherwise be read aloud
 *   verbatim ("hash hash heading", "backtick foo backtick").
 * - `SentenceBuffer` accumulates streamed markdown chunks and emits whole
 *   sentences as they complete, holding any trailing partial sentence until the
 *   next chunk or an explicit flush.
 */

// Words ending in `.` that are NOT sentence terminators. Kept lowercase; the
// match is case-insensitive on the word preceding the period.
const ABBREVIATIONS = new Set([
    'e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof',
    'st', 'jr', 'sr', 'no', 'fig', 'cf', 'al',
]);

// Regex constants for markdownToSpeech. Defined once at module load so they
// aren't re-compiled per call — `markdownToSpeech` runs per-sentence during
// streaming, dozens to hundreds of times per narration.
const RE_FENCED_CODE = /```[\s\S]*?```/g;
const RE_INLINE_CODE = /`([^`]+)`/g;
// Image (`![alt](url)`) -> drop; link (`[text](url)`) -> keep `text`. The image
// alt may be empty (`![]` is legal); a link text may not, so the alternation
// preserves the prior `[^\]]*` (image) vs `[^\]]+` (link) requirement.
const RE_IMAGE_OR_LINK = /(!)\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\(([^)]+)\)/g;
// One pass collapses the three former line-prefix sweeps (bullets/blockquotes/
// headings). Order in the alternation does not change semantics because each
// alternative matches a different leading character class.
const RE_LINE_PREFIX = /^(?:[ \t]*(?:[-*+]|\d+\.)[ \t]+|[ \t]*>+[ \t]?|[ \t]{0,3}#{1,6}[ \t]+)/gm;
const RE_BOLD = /(\*\*|__)(.+?)\1/g;
const RE_EMPH = /(\*|_)(?=\S)(.+?)(?<=\S)\1/g;
const RE_STRIKE = /~~(.+?)~~/g;
const RE_WS_RUN = /\s+/g;

/**
 * Strip markdown formatting so the text reads naturally when spoken.
 *
 * Conservative regex-based stripping. We use this on per-sentence fragments,
 * not whole documents — feeding markdown-it partial input is unreliable, and
 * for short prose fragments the common cases are well-covered by regex.
 */
export function markdownToSpeech(md: string): string {
    if (!md) return '';
    let s = md;
    // Cheap `indexOf` probes gate each regex sweep. Most narration sentences
    // contain only a subset of markdown features, so on average we skip
    // 4-6 of the expensive scans entirely (especially the fenced-code
    // `[\s\S]*?` sweep and the lookbehind-using emphasis sweeps).
    if (s.indexOf('```') !== -1) {
        s = s.replace(RE_FENCED_CODE, ' code block omitted. ');
    }
    if (s.indexOf('`') !== -1) {
        s = s.replace(RE_INLINE_CODE, '$1');
    }
    if (s.indexOf('[') !== -1) {
        // Single sweep handles both `![alt](url)` (drop entirely) and
        // `[text](url)` (keep just the text). The alternation captures `!`
        // into group 1 for the image branch; group 2 holds the link text for
        // the link branch. Either group is undefined on the other branch.
        s = s.replace(RE_IMAGE_OR_LINK, (_m, bang: string | undefined, linkText: string | undefined) =>
            (bang ? '' : (linkText ?? '')));
    }
    // One multiline sweep replaces three former sequential passes for
    // list bullets, blockquote markers, and ATX headings. The three
    // alternatives are line-anchored and disjoint at the first leading
    // non-whitespace character, so semantics are preserved for all inputs
    // pinned by the test suite.
    s = s.replace(RE_LINE_PREFIX, '');
    if (s.indexOf('*') !== -1 || s.indexOf('_') !== -1) {
        s = s.replace(RE_BOLD, '$2');
        s = s.replace(RE_EMPH, '$2');
    }
    if (s.indexOf('~~') !== -1) {
        s = s.replace(RE_STRIKE, '$1');
    }
    s = s.replace(RE_WS_RUN, ' ').trim();
    return s;
}

interface SplitResult {
    /** Complete sentences in order, each trimmed. */
    sentences: string[];
    /** Trailing partial sentence (no terminator yet). May be empty. */
    remainder: string;
}

/**
 * Split text into complete sentences plus a trailing remainder.
 *
 * A sentence terminator is `.`, `!`, or `?` followed by whitespace or end-of-input.
 * Runs of `.` (ellipses) are treated as a single terminator. Abbreviations like
 * `e.g.` and `Mr.` do NOT terminate sentences. The remainder is whatever
 * follows the last terminator (or the whole input if there is none).
 */
export function splitSentences(text: string): SplitResult {
    const sentences: string[] = [];
    let start = 0;
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];
        if (ch === '.' || ch === '!' || ch === '?') {
            // Consume any ellipsis run before deciding.
            let endOfPunct = i;
            while (endOfPunct + 1 < len && text[endOfPunct + 1] === '.') {
                endOfPunct++;
            }
            const next = endOfPunct + 1 < len ? text[endOfPunct + 1] : '';
            const atBoundary = next === '' || /\s/.test(next);

            if (atBoundary && !isAbbreviation(text, start, i)) {
                const sentence = text.slice(start, endOfPunct + 1).trim();
                if (sentence.length > 0) sentences.push(sentence);
                i = endOfPunct + 1;
                while (i < len && /\s/.test(text[i])) i++;
                start = i;
                continue;
            }
            i = endOfPunct + 1;
            continue;
        }
        i++;
    }

    const remainder = text.slice(start);
    return { sentences, remainder };
}

function isAbbreviation(text: string, sentenceStart: number, periodIndex: number): boolean {
    // Walk back through both letters and embedded periods so multi-segment
    // abbreviations like `e.g.` and `U.S.A.` are recognized.
    let j = periodIndex - 1;
    while (j >= sentenceStart && /[A-Za-z.]/.test(text[j])) j--;
    const word = text.slice(j + 1, periodIndex).toLowerCase();
    if (!word) return false;
    // Any internal period marks the token as abbreviation-like (e.g. `e.g`,
    // `u.s.a`). This is the cheapest reliable signal.
    if (word.includes('.')) return true;
    return ABBREVIATIONS.has(word);
}

/**
 * Accumulates streamed markdown chunks for a single section and yields whole
 * sentences (markdown-stripped) as they complete. Use one buffer per section.
 *
 * Usage:
 *   const buf = new SentenceBuffer();
 *   buf.push(chunkText); // returns 0..N speakable sentences
 *   buf.flush();         // returns the trailing partial as one sentence, then clears
 */
export class SentenceBuffer {
    private pending = '';
    /**
     * True when `pending` is known to contain no `.`/`!`/`?`. Maintained
     * across pushes so a long run of terminator-free chunks accumulates in
     * `pending` without re-scanning all of it on every push.
     */
    private pendingHasNoTerminator = true;

    /** Add a streamed markdown chunk. Returns any sentences that are now complete. */
    push(chunk: string): string[] {
        if (!chunk) return [];
        const chunkHasTerm = hasTerminator(chunk);
        // Fast path: if neither the existing pending nor the new chunk holds
        // any terminator, there cannot be a sentence boundary. Append and exit.
        if (!chunkHasTerm && this.pendingHasNoTerminator) {
            this.pending += chunk;
            return [];
        }
        this.pending += chunk;
        // If the buffer ends right at a terminator (no whitespace after), hold
        // the last sentence back — it could be part of a yet-incomplete
        // abbreviation like `e.` extending to `e.g.` in the next chunk.
        const last = this.pending[this.pending.length - 1];
        const endsAtTerminator = last === '.' || last === '!' || last === '?';
        const { sentences, remainder } = splitSentences(this.pending);
        if (endsAtTerminator && remainder === '' && sentences.length > 0) {
            this.pending = sentences.pop()!;
        } else {
            this.pending = remainder;
        }
        this.pendingHasNoTerminator = !hasTerminator(this.pending);
        const speakable: string[] = [];
        for (const s of sentences) {
            const spoken = markdownToSpeech(s);
            if (spoken.length > 0) speakable.push(spoken);
        }
        return speakable;
    }

    /**
     * Emit any trailing partial sentence as a final speech fragment, and clear
     * the buffer. Returns 0 or 1 strings.
     */
    flush(): string[] {
        const tail = this.pending.trim();
        this.pending = '';
        this.pendingHasNoTerminator = true;
        if (!tail) return [];
        const spoken = markdownToSpeech(tail);
        return spoken.length > 0 ? [spoken] : [];
    }

    /** Discard buffered content without emitting. */
    reset(): void {
        this.pending = '';
        this.pendingHasNoTerminator = true;
    }
}

function hasTerminator(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const ch = s.charCodeAt(i);
        // '.' = 46, '!' = 33, '?' = 63
        if (ch === 46 || ch === 33 || ch === 63) return true;
    }
    return false;
}
