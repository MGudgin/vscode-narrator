import * as vscode from 'vscode';
import * as crypto from 'crypto';
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
.banner-dot {
  display: inline-block;
  margin-right: 0.5em;
  font-size: 0.85em;
  line-height: 1;
  vertical-align: middle;
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  transition: color 0.25s ease;
}
.banner-dot[data-status="hidden"] { display: none; }
.banner-dot[data-status="streaming"] {
  color: var(--vscode-charts-yellow, #f5a623);
  animation: cn-pulse 1.2s ease-in-out infinite;
}
.banner-dot[data-status="complete"] {
  color: var(--vscode-charts-green, #4caf50);
  animation: none;
}
.status { color: var(--vscode-descriptionForeground); font-style: italic; }
.error { color: var(--vscode-errorForeground); }
section {
  margin: 0 -0.5em 1.25rem -0.5em;
  padding: 0 0.5em;
  border-radius: 4px;
  transition: background-color 0.25s ease;
}
section.highlighted {
  background-color: var(--vscode-editor-rangeHighlightBackground, rgba(255, 200, 0, 0.15));
}
section .body:empty::before {
  content: '…';
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
section > h2::after {
  content: '●';
  display: inline-block;
  margin-left: 0.55em;
  font-size: 0.7em;
  vertical-align: middle;
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  transition: color 0.25s ease;
}
section[data-status="streaming"] > h2::after {
  color: var(--vscode-charts-yellow, #f5a623);
  animation: cn-pulse 1.2s ease-in-out infinite;
}
section[data-status="complete"] > h2::after {
  color: var(--vscode-charts-green, #4caf50);
  animation: none;
}
.section-dot {
  display: inline-block;
  margin-right: 0.55em;
  margin-bottom: 0.4em;
  font-size: 0.7em;
  vertical-align: middle;
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  transition: color 0.25s ease;
}
section[data-status="streaming"] > .section-dot {
  color: var(--vscode-charts-yellow, #f5a623);
  animation: cn-pulse 1.2s ease-in-out infinite;
}
section[data-status="complete"] > .section-dot {
  color: var(--vscode-charts-green, #4caf50);
  animation: none;
}
@keyframes cn-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
`;

export function renderShell(webview: vscode.Webview, fileLabel: string, bannerLabel?: string): string {
    const nonce = makeNonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
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
${banner(bannerLabel)}
<div id="content">
  <h1>Narrating <code>${escapeHtml(fileLabel)}</code>…</h1>
  <p class="status">Calling the language model.</p>
</div>
<script nonce="${nonce}">
  (function () {
    const content = document.getElementById('content');
    let highlightTimer = null;
    function reset(sections, bannerLabel) {
      if (typeof bannerLabel === 'string') {
        const lbl = document.getElementById('banner-label');
        if (lbl) lbl.textContent = bannerLabel;
      }
      content.innerHTML = sections.map(function (s) {
        const status = s.status || 'queued';
        const dot = (!s.headingHtml && !s.bodyHtml) ? '<span class="section-dot">●</span>' : '';
        return '<section data-id="' + s.id + '" data-status="' + status + '">'
          + dot
          + (s.headingHtml || '')
          + '<div class="body" id="body-' + s.id + '">' + (s.bodyHtml || '') + '</div>'
          + '</section>';
      }).join('');
    }
    function replace(id, html) {
      const el = document.getElementById('body-' + id);
      if (el) el.innerHTML = html;
    }
    function setStatus(id, status) {
      const el = document.querySelector('section[data-id="' + id + '"]');
      if (el) el.setAttribute('data-status', status);
    }
    function setBannerStatus(status) {
      const el = document.getElementById('banner-dot');
      if (el) el.setAttribute('data-status', status);
    }
    function highlight(id) {
      const el = document.querySelector('section[data-id="' + id + '"]');
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlighted');
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(function () { el.classList.remove('highlighted'); }, 1500);
    }
    window.addEventListener('message', function (e) {
      const msg = e.data;
      if (!msg) return;
      if (msg.kind === 'reset') reset(msg.sections, msg.bannerLabel);
      else if (msg.kind === 'replace') replace(msg.sectionId, msg.bodyHtml);
      else if (msg.kind === 'sectionStatus') setStatus(msg.sectionId, msg.status);
      else if (msg.kind === 'bannerStatus') setBannerStatus(msg.status);
      else if (msg.kind === 'highlight') highlight(msg.sectionId);
    });
  })();
</script>
</body>
</html>`;
}

export function renderError(webview: vscode.Webview, message: string, hint?: string, bannerLabel?: string): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} https: data:`,
    ].join('; ');
    const hintHtml = hint ? `<p>${escapeHtml(hint)}</p>` : '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Narration</title>
  <style>${STYLES}</style>
</head>
<body>
${banner(bannerLabel)}
<h1 class="error">Narration failed</h1>
<p>${escapeHtml(message)}</p>
${hintHtml}
</body>
</html>`;
}

export function renderMarkdownToHtml(markdown: string): string {
    return md.render(markdown);
}

export type SectionStatus = 'queued' | 'streaming' | 'complete';
export type BannerStatus = 'hidden' | 'streaming' | 'complete';

/**
 * Aggregates the per-section narration statuses into a single banner-level
 * status.
 *
 * - `hidden` when there are no sections (no active narration).
 * - `streaming` when any section is still queued or streaming.
 * - `complete` when every section has finished.
 */
export function aggregateBannerStatus(statuses: Iterable<SectionStatus>): BannerStatus {
    let count = 0;
    let anyPending = false;
    for (const s of statuses) {
        count++;
        if (s !== 'complete') anyPending = true;
    }
    if (count === 0) return 'hidden';
    return anyPending ? 'streaming' : 'complete';
}

function banner(label?: string): string {
    if (!label) return '';
    const refresh = `command:codeNarration.refresh`;
    return `<div class="banner">
  <span class="banner-dot" id="banner-dot" data-status="hidden" title="Narration progress">●</span>
  <span class="banner-label" id="banner-label">${escapeHtml(label)}</span>
  <span class="banner-actions"><a href="${refresh}" title="Re-run narration">↻ Refresh</a></span>
</div>`;
}

function makeNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
