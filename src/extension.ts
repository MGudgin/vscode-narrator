import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
md.validateLink = (url: string) => /^(https?:|command:|vscode:|file:|mailto:)/i.test(url);

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('codeNarration.open', () => openNarration(context)),
        vscode.commands.registerCommand('codeNarration.reveal', revealLocation),
    );
}

export function deactivate(): void {
    panel?.dispose();
}

function openNarration(context: vscode.ExtensionContext): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('Open a file to narrate.');
        return;
    }

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'codeNarration',
            'Narration',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            {
                enableCommandUris: true,
                enableScripts: false,
                retainContextWhenHidden: true,
            },
        );
        panel.onDidDispose(() => { panel = undefined; }, null, context.subscriptions);
    }

    const markdown = buildPlaceholderMarkdown(editor.document);
    panel.title = `Narration: ${shortName(editor.document)}`;
    panel.webview.html = renderHtml(panel.webview, markdown);
    panel.reveal(vscode.ViewColumn.Beside, true);
}

function buildPlaceholderMarkdown(doc: vscode.TextDocument): string {
    const name = shortName(doc);
    const lineCount = doc.lineCount;
    const top = revealLink(doc.uri, new vscode.Range(0, 0, 0, 0), 'top of file');
    const middleLine = Math.floor(lineCount / 2);
    const middle = revealLink(doc.uri, new vscode.Range(middleLine, 0, middleLine, 0), `line ${middleLine + 1}`);

    return [
        `# Narration of \`${name}\``,
        '',
        '_Phase 1 placeholder._ The LLM round-trip lands in phase 2.',
        '',
        `This file has **${lineCount}** lines. Try the deep links to verify they jump the editor:`,
        '',
        `- Jump to ${top}`,
        `- Jump to ${middle}`,
        '',
        '> Once phase 2 is in, this pane will contain section-by-section narration with one deep link per symbol.',
        '',
    ].join('\n');
}

function revealLink(uri: vscode.Uri, range: vscode.Range, label: string): string {
    const args = encodeURIComponent(JSON.stringify([
        uri.toString(),
        {
            start: { line: range.start.line, character: range.start.character },
            end: { line: range.end.line, character: range.end.character },
        },
    ]));
    return `[${label}](command:codeNarration.reveal?${args})`;
}

async function revealLocation(uriStr: string, rangeLike: { start: { line: number; character: number }; end: { line: number; character: number } }): Promise<void> {
    const uri = vscode.Uri.parse(uriStr);
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(
        rangeLike.start.line, rangeLike.start.character,
        rangeLike.end.line, rangeLike.end.character,
    );
    await vscode.window.showTextDocument(doc, {
        selection: range,
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
    });
}

function shortName(doc: vscode.TextDocument): string {
    const path = doc.uri.fsPath || doc.uri.path;
    return path.split(/[\\/]/).pop() ?? doc.uri.toString();
}

function renderHtml(webview: vscode.Webview, markdown: string): string {
    const body = md.render(markdown);
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
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0 1.25rem 2rem 1.25rem;
      line-height: 1.5;
    }
    h1, h2, h3 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.2em; }
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
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
