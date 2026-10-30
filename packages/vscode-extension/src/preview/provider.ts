// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import { buildLocalPreviewUrl, normalizePreviewWidth } from "../lib/safe-url.js";

/**
 * Provides the live preview webview shown in the Moosewave activity-bar
 * container. The webview hosts an `<iframe>` that points at the local
 * Moosewave dev server's preview route for the active editor file:
 *
 *     ${devServerUrl}/preview/${relativePathToFile}
 *
 * The webview has a tiny toolbar (mobile / desktop / reload / send-test)
 * implemented in plain JS; we deliberately avoid React or any other
 * framework — the contract from the user is "VSCode types only".
 */
export class PostwavePreviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "postwave.preview";

  private view: vscode.WebviewView | undefined;
  private currentFileRel: string | undefined;
  private currentWidth: "mobile" | "desktop";
  private readonly messageNonce = randomUUID();

  constructor(private readonly context: vscode.ExtensionContext) {
    const cfg = vscode.workspace.getConfiguration("postwave");
    this.currentWidth = normalizePreviewWidth(cfg.get<string>("previewWidth"));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.renderHtml();

    view.webview.onDidReceiveMessage((msg: unknown) => {
      if (!isWebviewCommand(msg)) return;
      switch (msg.type) {
        case "toggle-width":
          this.currentWidth =
            this.currentWidth === "mobile" ? "desktop" : "mobile";
          this.refresh();
          break;
        case "reload":
          this.refresh();
          break;
        case "send-test":
          void vscode.commands.executeCommand("postwave.email.sendTest");
          break;
        default:
          break;
      }
    });

    // Refresh on save and on active editor change so the iframe always
    // points at the file the user is currently editing.
    this.context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );

    this.refresh();
  }

  refresh(): void {
    if (!this.view) return;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      if (folder) {
        const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
        this.currentFileRel = rel;
      } else {
        this.currentFileRel = editor.document.fileName;
      }
    }
    this.view.webview.postMessage({
      type: "navigate",
      url: this.previewUrl(),
      width: this.currentWidth,
      nonce: this.messageNonce,
    });
  }

  private previewUrl(): string {
    const cfg = vscode.workspace.getConfiguration("postwave");
    const base = cfg.get<string>("devServerUrl") ?? "http://localhost:4321";
    return buildLocalPreviewUrl(base, this.currentFileRel);
  }

  private renderHtml(): string {
    const initialUrl = this.previewUrl();
    const nonce = this.messageNonce;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; frame-src http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${escapeAttr(nonce)}';" />
  <title>Moosewave Preview</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
    .toolbar { display: flex; gap: 6px; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
    .toolbar button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
    .frame-wrap { position: absolute; top: 38px; bottom: 0; left: 0; right: 0; display: flex; justify-content: center; background: #1e1e1e; }
    iframe { border: 0; height: 100%; background: #fff; }
    iframe.mobile { width: 375px; }
    iframe.desktop { width: 100%; max-width: 720px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button data-cmd="toggle-width">Mobile / Desktop</button>
    <button data-cmd="reload">Reload</button>
    <button data-cmd="send-test">Send test</button>
  </div>
  <div class="frame-wrap">
    <iframe id="pw-frame" class="${this.currentWidth}" src="${escapeAttr(initialUrl)}"></iframe>
  </div>
  <script nonce="${escapeAttr(nonce)}">
    const MESSAGE_NONCE = ${JSON.stringify(nonce)};
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: btn.getAttribute('data-cmd') });
      });
    });
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'navigate') {
        if (msg.nonce !== MESSAGE_NONCE) return;
        if (!isSafePreviewUrl(msg.url)) return;
        const width = normalizePreviewWidth(msg.width);
        if (!width) return;
        const f = document.getElementById('pw-frame');
        f.className = width;
        f.src = msg.url;
      }
    });
    function isSafePreviewUrl(raw) {
      try {
        const url = new URL(String(raw));
        const host = url.hostname.toLowerCase();
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
          (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.pathname === '/preview' || url.pathname.startsWith('/preview/'));
      } catch {
        return false;
      }
    }
    function normalizePreviewWidth(raw) {
      return raw === 'mobile' || raw === 'desktop' ? raw : null;
    }
  </script>
</body>
</html>`;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function isWebviewCommand(raw: unknown): raw is { type: "toggle-width" | "reload" | "send-test" } {
  if (!raw || typeof raw !== "object") return false;
  const type = (raw as { type?: unknown }).type;
  return type === "toggle-width" || type === "reload" || type === "send-test";
}
