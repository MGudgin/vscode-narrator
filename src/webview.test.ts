import { describe, test, expect } from 'vitest';
import { aggregateBannerStatus, isAllowedLinkUrl, renderMarkdownToHtml } from './webview';

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
