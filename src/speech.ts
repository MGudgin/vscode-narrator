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
    // Fenced code blocks: replace with a brief spoken marker.
    s = s.replace(/```[\s\S]*?```/g, ' code block omitted. ');
    // Inline code: keep the contents as plain words.
    s = s.replace(/`([^`]+)`/g, '$1');
    // Images: drop entirely (alt text is rarely useful aloud).
    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // Links of the form [text](url): keep just the text.
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    // Leading list markers and blockquote markers.
    s = s.replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '');
    s = s.replace(/^[ \t]*>+[ \t]?/gm, '');
    // Heading markers (#, ##, ...).
    s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
    // Bold/italic. Two passes so doubled markers strip cleanly.
    s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
    s = s.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '$2');
    // Strikethrough.
    s = s.replace(/~~(.+?)~~/g, '$1');
    // Collapse whitespace.
    s = s.replace(/\s+/g, ' ').trim();
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

    /** Add a streamed markdown chunk. Returns any sentences that are now complete. */
    push(chunk: string): string[] {
        if (!chunk) return [];
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
        if (!tail) return [];
        const spoken = markdownToSpeech(tail);
        return spoken.length > 0 ? [spoken] : [];
    }

    /** Discard buffered content without emitting. */
    reset(): void {
        this.pending = '';
    }
}
