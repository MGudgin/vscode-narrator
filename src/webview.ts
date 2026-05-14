import * as vscode from 'vscode';
import * as crypto from 'crypto';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/**
 * Allowlist for markdown link URLs inside narration output. Narration is
 * LLM-generated and indirectly influenced by the source files being narrated,
 * so the link surface has to be treated as adversarial input.
 *
 * Permitted:
 * - `http(s):` and `mailto:` — standard outbound links.
 * - `command:codeNarration.reveal?…` — produced by `fixupLinks` to wire
 *   heading and inline links to the reveal handler.
 *
 * Rejected (downgraded to plain text by markdown-it):
 * - Any other `command:` URI — would otherwise execute arbitrary VS Code
 *   commands (terminal-send, settings, file open, etc.) on click.
 *   The webview also runs with `enableCommandUris: ['codeNarration.reveal']`,
 *   so a renderer regression here still cannot fire foreign commands.
 * - `file:` — clickable disclosure of any file the VS Code process can read.
 * - `vscode:` — pivots through other installed extensions' URL handlers.
 */
export function isAllowedLinkUrl(url: string): boolean {
    if (/^https?:/i.test(url)) return true;
    if (/^mailto:/i.test(url)) return true;
    if (/^command:codeNarration\.reveal\?/i.test(url)) return true;
    return false;
}

// markdown-it routes every `<a href>` AND every `<img src>` through one
// `validateLink` gate, so the predicate is the union of what's safe as a link
// and what's safe as an image. The renderer-rule override below adds a second
// gate that ensures `data:image/` only ever becomes an `<img>` — not an `<a>`
// that surprises the user, and not a non-image `data:` URI.
md.validateLink = (url: string) => isAllowedLinkUrl(url) || isAllowedImageSrc(url);

/**
 * Allowlist for markdown image `src` URLs. Distinct from `isAllowedLinkUrl`
 * because images are auto-fetched on render — no user click required — so the
 * allowlist must be strictly tighter:
 *
 * Permitted:
 * - `data:image/...` URIs (inline base64, no network fetch).
 *
 * Rejected (the `<img>` tag is dropped at render time, alt text is rendered
 * as escaped plain text instead):
 * - `https?:` — would fire a `GET` to an attacker-controlled URL on render,
 *   leaking whatever the LLM has in context. The webview's CSP also drops
 *   `https:` from `img-src`, so a renderer regression would still be refused
 *   at fetch time.
 * - Any other scheme.
 */
export function isAllowedImageSrc(src: string): boolean {
    return /^data:image\//i.test(src);
}

// Replace markdown-it's default image renderer with one that drops any
// <img> whose src is not in `isAllowedImageSrc`. The alt text is preserved
// as escaped plain text so the reader still sees that something was there.
const defaultImageRule = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const src = tokens[idx].attrGet('src') ?? '';
    if (!isAllowedImageSrc(src)) {
        const alt = tokens[idx].content;
        return alt ? `[image: ${md.utils.escapeHtml(alt)}]` : '';
    }
    return defaultImageRule
        ? defaultImageRule(tokens, idx, opts, env, self)
        : self.renderToken(tokens, idx, opts);
};

export interface SpeechConfig {
    enabled: boolean;
    autoPlay: boolean;
    voice: string;
    rate: number;
    pitch: number;
}

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
.speech-controls {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  margin-left: 0.75em;
}
.speech-controls button,
.section-speak {
  background: transparent;
  color: inherit;
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 0.1em 0.5em;
  font-size: 0.85em;
  cursor: pointer;
  font-family: inherit;
}
.speech-controls button:hover,
.section-speak:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.15));
}
.speech-controls button[disabled],
.section-speak[disabled] {
  opacity: 0.4;
  cursor: default;
}
.speech-controls select,
.speech-controls input[type="range"] {
  font-size: 0.85em;
  color: inherit;
  background: var(--vscode-dropdown-background, transparent);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 3px;
  padding: 0.1em 0.25em;
}
.speech-controls label {
  font-size: 0.8em;
  color: var(--vscode-descriptionForeground);
}
.section-speak {
  margin-right: 0.5em;
  font-size: 0.75em;
  vertical-align: middle;
}
section[data-speaking="true"] {
  background-color: var(--vscode-editor-rangeHighlightBackground, rgba(255, 200, 0, 0.15));
}
`;

const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
    enabled: false,
    autoPlay: false,
    voice: '',
    rate: 1.0,
    pitch: 1.0,
};

/**
 * In-webview speech client. Owns:
 *   - per-section sentence queues, fed by `speech` / `speechReset` messages.
 *   - a single playback cursor that walks sections in order.
 *   - the banner controls (play/pause/stop, voice picker, rate slider) and
 *     per-section ▶ buttons.
 *
 * Exposes `window.__speech` so the outer shell can hand off `reset` and
 * incoming messages without re-binding event listeners.
 */
const SPEECH_CLIENT_JS = `
(function () {
  const cfg = window.__speechConfig || { enabled: false };
  if (!cfg.enabled || typeof window.speechSynthesis === 'undefined') {
    window.__speech = { enabled: false, onReset: function () {}, onMessage: function () {}, speakSection: function () {} };
    return;
  }
  const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  function postToHost(msg) { if (vscodeApi) vscodeApi.postMessage(msg); }
  const synth = window.speechSynthesis;
  // Sections, in order. Each: { id, sentences: string[], done: boolean }.
  const sections = [];
  const sectionById = new Map();
  // Playback cursor: index into sections, and index into the current section's sentences.
  let secIdx = 0;
  let sentIdx = 0;
  let state = 'idle'; // 'idle' | 'speaking' | 'paused'
  let voices = [];
  let chosenVoice = null;

  function refreshVoices() {
    voices = synth.getVoices();
    const sel = document.getElementById('speech-voice');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default';
    sel.appendChild(def);
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + ' (' + v.lang + ')';
      sel.appendChild(o);
    }
    const want = cfg.voice || prev || '';
    sel.value = want;
    chosenVoice = voices.find(function (v) { return v.name === sel.value; }) || null;
  }

  function setButtons() {
    const play = document.getElementById('speech-play');
    const pause = document.getElementById('speech-pause');
    const stop = document.getElementById('speech-stop');
    if (!play || !pause || !stop) return;
    play.disabled = state === 'speaking';
    pause.disabled = state !== 'speaking';
    stop.disabled = state === 'idle';
  }

  function markSpeaking(id, on) {
    const el = document.querySelector('section[data-id="' + id + '"]');
    if (el) el.setAttribute('data-speaking', on ? 'true' : 'false');
  }

  function clearSpeakingMarks() {
    const els = document.querySelectorAll('section[data-speaking="true"]');
    els.forEach(function (el) { el.setAttribute('data-speaking', 'false'); });
  }

  function nextItem() {
    while (secIdx < sections.length) {
      const sec = sections[secIdx];
      if (sentIdx < sec.sentences.length) {
        const text = sec.sentences[sentIdx];
        return { sec: sec, text: text };
      }
      // Section exhausted. If still streaming, wait here for more sentences.
      if (!sec.done) return null;
      sentIdx = 0;
      secIdx++;
    }
    return null;
  }

  function playNext() {
    if (state === 'paused') return;
    if (synth.speaking) return;
    const item = nextItem();
    if (!item) {
      state = 'idle';
      clearSpeakingMarks();
      setButtons();
      return;
    }
    const u = new SpeechSynthesisUtterance(item.text);
    if (chosenVoice) u.voice = chosenVoice;
    u.rate = readRate();
    u.pitch = cfg.pitch || 1.0;
    u.onstart = function () {
      markSpeaking(item.sec.id, true);
    };
    u.onend = function () {
      markSpeaking(item.sec.id, false);
      // Advance the cursor only after the utterance finishes — otherwise a
      // re-entrant playNext() inside onstart would skip ahead.
      sentIdx++;
      // If this was the last sentence we have for this section and the section
      // is still streaming, pause here until more sentences arrive (kicked by
      // pushSentence). Otherwise continue.
      const sec = sections[secIdx];
      if (sec && sentIdx >= sec.sentences.length && !sec.done) {
        // Wait. State stays 'speaking' so pushSentence will resume us.
        return;
      }
      playNext();
    };
    u.onerror = function () {
      markSpeaking(item.sec.id, false);
      sentIdx++;
      playNext();
    };
    state = 'speaking';
    setButtons();
    synth.speak(u);
  }

  function readRate() {
    const r = document.getElementById('speech-rate');
    if (!r) return cfg.rate || 1.0;
    const v = parseFloat(r.value);
    return isFinite(v) ? v : 1.0;
  }

  function play() {
    if (state === 'paused' && synth.paused) {
      synth.resume();
      state = 'speaking';
      setButtons();
      return;
    }
    if (state === 'speaking') return;
    playNext();
  }

  function pause() {
    if (state !== 'speaking') return;
    synth.pause();
    state = 'paused';
    setButtons();
  }

  function stop() {
    synth.cancel();
    clearSpeakingMarks();
    secIdx = 0;
    sentIdx = 0;
    state = 'idle';
    setButtons();
  }

  function pushSentence(sectionId, text) {
    const sec = sectionById.get(sectionId);
    if (!sec) return;
    sec.sentences.push(text);
    if (cfg.autoPlay && state === 'idle') play();
    else if (state === 'speaking' && !synth.speaking) {
      // We were waiting for the next sentence on this section.
      playNext();
    }
  }

  function resetSections(ids) {
    stop();
    sections.length = 0;
    sectionById.clear();
    for (const id of ids) {
      const s = { id: id, sentences: [], done: false };
      sections.push(s);
      sectionById.set(id, s);
    }
  }

  function resetSection(id) {
    const sec = sectionById.get(id);
    if (!sec) return;
    sec.sentences.length = 0;
    sec.done = false;
  }

  function markSectionDone(id) {
    const sec = sectionById.get(id);
    if (sec) sec.done = true;
    // If playback was waiting on this section to deliver more sentences,
    // resume so it can advance to the next section.
    if (state === 'speaking' && !synth.speaking) playNext();
  }

  function speakSection(id) {
    const idx = sections.findIndex(function (s) { return s.id === id; });
    if (idx < 0) return;
    stop();
    secIdx = idx;
    sentIdx = 0;
    play();
  }

  // Wire banner controls.
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'speech-voice') {
      const sel = t;
      chosenVoice = voices.find(function (v) { return v.name === sel.value; }) || null;
      cfg.voice = sel.value;
      // Persist so it sticks across narrations and refreshes.
      postToHost({ kind: 'voiceChanged', voice: sel.value });
    } else if (t.id === 'speech-rate') {
      const r = t;
      const v = parseFloat(r.value);
      if (isFinite(v)) {
        cfg.rate = v;
        postToHost({ kind: 'rateChanged', rate: v });
      }
    }
  });
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.id === 'speech-play') play();
    else if (t.id === 'speech-pause') pause();
    else if (t.id === 'speech-stop') stop();
  });

  synth.addEventListener('voiceschanged', refreshVoices);
  // Voices may already be available synchronously; populate now too.
  refreshVoices();
  setButtons();

  // The OS speech service keeps playing the queued utterance after the webview
  // is torn down (panel close, Refresh re-renders the HTML, etc.) unless we
  // explicitly cancel here before the iframe goes away.
  function cancelSpeech() { try { synth.cancel(); } catch (_) { /* noop */ } }
  window.addEventListener('pagehide', cancelSpeech);
  window.addEventListener('beforeunload', cancelSpeech);

  window.__speech = {
    enabled: true,
    onReset: resetSections,
    onMessage: function (msg) {
      if (msg.kind === 'speech') pushSentence(msg.sectionId, msg.text);
      else if (msg.kind === 'speechReset') resetSection(msg.sectionId);
      else if (msg.kind === 'speechSectionDone') markSectionDone(msg.sectionId);
      else if (msg.kind === 'speechControl') {
        if (msg.command === 'play') play();
        else if (msg.command === 'pause') pause();
        else if (msg.command === 'stop') stop();
      }
      else if (msg.kind === 'speechConfig') {
        if (typeof msg.voice === 'string') {
          cfg.voice = msg.voice;
          const sel = document.getElementById('speech-voice');
          if (sel) {
            sel.value = msg.voice;
            chosenVoice = voices.find(function (v) { return v.name === msg.voice; }) || null;
          }
        }
        if (typeof msg.rate === 'number') {
          cfg.rate = msg.rate;
          const r = document.getElementById('speech-rate');
          if (r) r.value = String(msg.rate);
        }
        if (typeof msg.autoPlay === 'boolean') cfg.autoPlay = msg.autoPlay;
        if (typeof msg.pitch === 'number') cfg.pitch = msg.pitch;
      }
    },
    speakSection: speakSection,
  };
})();
`;

export function renderShell(
    webview: vscode.Webview,
    fileLabel: string,
    bannerLabel?: string,
    speechConfig: SpeechConfig = DEFAULT_SPEECH_CONFIG,
): string {
    const nonce = makeNonce();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
        // No `https:` here — narration never legitimately renders remote
        // images, and allowing them turns an attacker-influenced `<img>` tag
        // into a no-click exfiltration channel (LLM emits a tracking pixel
        // whose URL encodes context, browser fetches on render). Pairs with
        // the markdown image renderer override in `isAllowedImageSrc`.
        `img-src ${webview.cspSource} data:`,
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
${banner(bannerLabel, speechConfig)}
<div id="content">
  <h1>Narrating <code>${escapeHtml(fileLabel)}</code>…</h1>
  <p class="status">Calling the language model.</p>
</div>
<script nonce="${nonce}">
  window.__speechConfig = ${JSON.stringify(speechConfig)};
</script>
<script nonce="${nonce}">${SPEECH_CLIENT_JS}</script>
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
        const speakBtn = window.__speech && window.__speech.enabled
          ? '<button class="section-speak" data-speak-section="' + s.id + '" title="Speak this section">▶</button>'
          : '';
        return '<section data-id="' + s.id + '" data-status="' + status + '">'
          + speakBtn
          + dot
          + (s.headingHtml || '')
          + '<div class="body" id="body-' + s.id + '">' + (s.bodyHtml || '') + '</div>'
          + '</section>';
      }).join('');
      if (window.__speech) window.__speech.onReset(sections.map(function (s) { return s.id; }));
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
      else if (window.__speech) window.__speech.onMessage(msg);
    });
    document.addEventListener('click', function (e) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const sectionId = target.getAttribute('data-speak-section');
      if (sectionId && window.__speech) window.__speech.speakSection(sectionId);
    });
  })();
</script>
</body>
</html>`;
}

export function renderError(
    webview: vscode.Webview,
    message: string,
    hint?: string,
    bannerLabel?: string,
    speechConfig: SpeechConfig = DEFAULT_SPEECH_CONFIG,
): string {
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        // No `https:` here — narration never legitimately renders remote
        // images, and allowing them turns an attacker-influenced `<img>` tag
        // into a no-click exfiltration channel (LLM emits a tracking pixel
        // whose URL encodes context, browser fetches on render). Pairs with
        // the markdown image renderer override in `isAllowedImageSrc`.
        `img-src ${webview.cspSource} data:`,
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
${banner(bannerLabel, speechConfig)}
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

function banner(label?: string, speech: SpeechConfig = DEFAULT_SPEECH_CONFIG): string {
    if (!label) return '';
    const refresh = `command:codeNarration.refresh`;
    const speechControls = speech.enabled ? `
  <span class="speech-controls" id="speech-controls">
    <button id="speech-play" title="Speak narration">▶</button>
    <button id="speech-pause" title="Pause" disabled>⏸</button>
    <button id="speech-stop" title="Stop" disabled>⏹</button>
    <label for="speech-voice">Voice</label>
    <select id="speech-voice"></select>
    <label for="speech-rate">Rate</label>
    <input type="range" id="speech-rate" min="0.5" max="2" step="0.05" value="${speech.rate}" />
  </span>` : '';
    return `<div class="banner">
  <span class="banner-dot" id="banner-dot" data-status="hidden" title="Narration progress">●</span>
  <span class="banner-label" id="banner-label">${escapeHtml(label)}</span>${speechControls}
  <span class="banner-actions"><a href="${refresh}" title="Re-run narration">↻ Refresh</a></span>
</div>`;
}

function makeNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
