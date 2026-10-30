// SPDX-License-Identifier: MIT
import * as vscode from "vscode";

import { buildLocalPreviewApiUrl } from "./lib/safe-url.js";

/**
 * Status bar item that pings `${devServerUrl}/health` every 10 seconds
 * and shows connected / disconnected. Uses the global `fetch` available
 * in Node 18+ (VSCode bundles a recent enough Node).
 */
const POLL_INTERVAL_MS = 10_000;

export class PostwaveStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private connected = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = "postwave.preview.open";
    this.render();
    this.item.show();
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  private async poll(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("postwave");
    const healthUrl = buildLocalPreviewApiUrl(
      cfg.get<string>("devServerUrl") ?? "http://localhost:4321",
      "/health",
    );
    let ok = false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 3_000);
      try {
        const resp = await fetch(healthUrl, { signal: ac.signal });
        ok = resp.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      ok = false;
    }
    if (ok !== this.connected) {
      this.connected = ok;
      this.render();
    }
  }

  private render(): void {
    if (this.connected) {
      this.item.text = "$(circle-filled) Moosewave";
      this.item.tooltip = "Moosewave dev server: connected";
      this.item.color = new vscode.ThemeColor("charts.green");
    } else {
      this.item.text = "$(circle-outline) Moosewave";
      this.item.tooltip =
        "Moosewave dev server: disconnected. Run `postwave dev`.";
      this.item.color = new vscode.ThemeColor("charts.red");
    }
  }
}
