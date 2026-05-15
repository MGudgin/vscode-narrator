import { describe, test, expect } from 'vitest';
import { markdownToSpeech, splitSentences, SentenceBuffer } from './speech';

describe('markdownToSpeech', () => {
    test('strips fenced code blocks with a spoken marker', () => {
        const md = 'Before.\n\n```ts\nfoo();\n```\n\nAfter.';
        expect(markdownToSpeech(md)).toBe('Before. code block omitted. After.');
    });

    test('strips inline code, keeping the contents', () => {
        expect(markdownToSpeech('Calls `narrateDocument` first.')).toBe('Calls narrateDocument first.');
    });

    test('drops link URLs but keeps the visible text', () => {
        const md = 'See [the docs](https://example.com/x) for details.';
        expect(markdownToSpeech(md)).toBe('See the docs for details.');
    });

    test('strips heading markers', () => {
        expect(markdownToSpeech('## Imports')).toBe('Imports');
        expect(markdownToSpeech('### Lines 1-10')).toBe('Lines 1-10');
    });

    test('strips bold and italic markers', () => {
        expect(markdownToSpeech('This is **bold** and *italic*.')).toBe('This is bold and italic.');
        expect(markdownToSpeech('And __also__ _this_.')).toBe('And also this.');
    });

    test('strips list bullets and blockquote markers', () => {
        const md = '- one\n- two\n\n> quoted';
        expect(markdownToSpeech(md)).toBe('one two quoted');
    });

    test('drops images entirely', () => {
        expect(markdownToSpeech('See ![alt](pic.png) here.')).toBe('See here.');
    });

    test('empty input returns empty string', () => {
        expect(markdownToSpeech('')).toBe('');
    });
});

describe('splitSentences', () => {
    test('splits on . ! ?', () => {
        const r = splitSentences('Hello world. How are you? I am fine!');
        expect(r.sentences).toEqual(['Hello world.', 'How are you?', 'I am fine!']);
        expect(r.remainder).toBe('');
    });

    test('returns a trailing partial as remainder', () => {
        const r = splitSentences('Done. Still typing');
        expect(r.sentences).toEqual(['Done.']);
        expect(r.remainder).toBe('Still typing');
    });

    test('does not split on common abbreviations', () => {
        const r = splitSentences('Tools like git, e.g. for diffs, are essential. Also Mr. Foo says hi.');
        expect(r.sentences).toEqual([
            'Tools like git, e.g. for diffs, are essential.',
            'Also Mr. Foo says hi.',
        ]);
        expect(r.remainder).toBe('');
    });

    test('handles ellipses as a single terminator at a boundary', () => {
        const r = splitSentences('Wait... Now go.');
        expect(r.sentences).toEqual(['Wait...', 'Now go.']);
        expect(r.remainder).toBe('');
    });

    test('decimal numbers are not split (digit after period is not whitespace)', () => {
        const r = splitSentences('Pi is roughly 3.14 today.');
        expect(r.sentences).toEqual(['Pi is roughly 3.14 today.']);
        expect(r.remainder).toBe('');
    });

    test('empty input yields no sentences and empty remainder', () => {
        const r = splitSentences('');
        expect(r.sentences).toEqual([]);
        expect(r.remainder).toBe('');
    });
});

describe('SentenceBuffer', () => {
    test('emits sentences as they complete across chunks', () => {
        const buf = new SentenceBuffer();
        expect(buf.push('Hello ')).toEqual([]);
        expect(buf.push('world. How ')).toEqual(['Hello world.']);
        expect(buf.push('are you? I am ')).toEqual(['How are you?']);
        // Last chunk ends right at the terminator — held until flush.
        expect(buf.push('fine!')).toEqual([]);
        expect(buf.flush()).toEqual(['I am fine!']);
    });

    test('strips markdown from emitted sentences', () => {
        const buf = new SentenceBuffer();
        const out = buf.push('Calls `foo` from [bar](narrate://lines/L1). Then exits.');
        // Trailing `exits.` is held; flush emits it.
        expect(out).toEqual(['Calls foo from bar.']);
        expect(buf.flush()).toEqual(['Then exits.']);
    });

    test('flush returns any trailing partial sentence', () => {
        const buf = new SentenceBuffer();
        buf.push('Done. Still ');
        expect(buf.flush()).toEqual(['Still']);
        // Flush is idempotent on an empty buffer.
        expect(buf.flush()).toEqual([]);
    });

    test('reset discards pending content without emitting', () => {
        const buf = new SentenceBuffer();
        buf.push('partial text');
        buf.reset();
        expect(buf.flush()).toEqual([]);
    });

    test('an abbreviation split across chunks does not produce a false sentence', () => {
        const buf = new SentenceBuffer();
        // First chunk ends at a terminator — held until we see what follows.
        expect(buf.push('Use git, e.')).toEqual([]);
        // Second chunk extends the abbreviation and adds more sentences. The
        // final `Done.` is also held (terminator at EOI) until a flush.
        expect(buf.push('g. for diffs. Done.')).toEqual(['Use git, e.g. for diffs.']);
        expect(buf.flush()).toEqual(['Done.']);
    });

    test('terminator followed by whitespace inside a chunk is emitted immediately', () => {
        const buf = new SentenceBuffer();
        // The trailing space disambiguates `Done.` as a complete sentence.
        expect(buf.push('First. Second. ')).toEqual(['First.', 'Second.']);
    });

    test('a long terminator-free run followed by a terminator is detected', () => {
        // Regression for #75: the cheap-path that skips re-scanning when no
        // terminator is present must not lose track when a terminator finally
        // arrives. Many chunks of plain text with no `.`/`!`/`?` then one
        // chunk closing the sentence.
        const buf = new SentenceBuffer();
        for (let i = 0; i < 50; i++) expect(buf.push('lorem ')).toEqual([]);
        expect(buf.push('ipsum. ')).toEqual([
            ('lorem '.repeat(50) + 'ipsum.').trim(),
        ]);
    });

    test('terminator landing as the first character of a new chunk still splits', () => {
        // Regression for #75: ensure the boundary check considers prior
        // pending content even when the new chunk is just a terminator.
        const buf = new SentenceBuffer();
        expect(buf.push('Hello world')).toEqual([]);
        expect(buf.push('.')).toEqual([]);
        // The trailing space confirms `.` as a terminator.
        expect(buf.push(' Next.')).toEqual(['Hello world.']);
    });
});
