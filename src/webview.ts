import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.validateLink = (url: string) => /^(https?:|command:|vscode:|file:|mailto:)/i.test(url);

const STYLES = `
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  padding: 0 1.25rem 2rem 1.25rem;
  line-height: 1.5;
}
h1, h2, h3 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
h2 a { text-decoration: none; }
h2 a:hover { text-decoration: underline; }
code {
  font-family: var(--vscode-editor-font-family);
  background: var(--vscode-textCodeBlock-background);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}
pre code { display: block; padding: 0.75em; overflow-x: auto; }
a { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
blockquote {
  border-left: 3px solid var(--vscode-panel-border);
  margin: 0.5em 0;
  padding: 0.25em 0.75em;
  color: var(--vscode-descriptionForeground);
}
.banner {
  display: flex;
  align-items: center;
  gap: 1em;
  padding: 0.5em 0.75em;
  margin: 0 -1.25rem 1.5em -1.25rem;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 0.9em;
}
.banner-label { color: var(--vscode-descriptionForeground); }
.banner-actions { margin-left: auto; }
.banner-actions a { margin-left: 0.75em; }
.status { color: var(--vscode-descriptionForeground); font-style: italic; }
.error { color: var(--vscode-errorForeground); }
`;

export function renderMarkdown(webview: vscode.Webview, markdown: string, bannerLabel?: string): string {
    return wrap(webview, banner(bannerLabel) + md.render(markdown));
}

export function renderLoading(webview: vscode.Webview, fileLabel: string, bannerLabel?: string): string {
    const body = `${banner(bannerLabel)}<h1>Narrating <code>${escapeHtml(fileLabel)}</code>…</h1>
<p class="status">Calling the language model. This may take a few seconds.</p>`;
    return wrap(webview, body);
}

export function renderError(webview: vscode.Webview, message: string, hint?: string, bannerLabel?: string): string {
    const hintHtml = hint ? `<p>${escapeHtml(hint)}</p>` : '';
    const body = `${banner(bannerLabel)}<h1 class="error">Narration failed</h1>
<p>${escapeHtml(message)}</p>
${hintHtml}`;
    return wrap(webview, body);
}

function banner(label?: string): string {
    if (!label) return '';
    const refresh = `command:codeNarration.refresh`;
    return `<div class="banner">
  <span class="banner-label">${escapeHtml(label)}</span>
  <span class="banner-actions"><a href="${refresh}" title="Re-run narration">↻ Refresh</a></span>
</div>`;
}

function wrap(webview: vscode.Webview, body: string): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} https: data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Narration</title>
  <style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
