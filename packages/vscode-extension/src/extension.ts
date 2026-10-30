// SPDX-License-Identifier: MIT
import * as vscode from "vscode";

import { loginCommand, logoutCommand } from "./commands/login.js";
import { sendTestCommand } from "./commands/sendTest.js";
import { registerDiagnostics } from "./lint/diagnostics.js";
import { PostwavePreviewProvider } from "./preview/provider.js";
import { PostwaveStatusBar } from "./status.js";

/**
 * Extension entry point. Wires:
 *   - the live preview WebviewViewProvider in the Moosewave activity bar
 *   - the lint diagnostic collection (runs on save / open)
 *   - the five commands (preview, send-test, dev-server, sign-in, sign-out)
 *   - the status bar item that polls the dev-server health endpoint
 */
export function activate(context: vscode.ExtensionContext): void {
  // Webview view provider.
  const provider = new PostwavePreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PostwavePreviewProvider.viewType,
      provider,
    ),
  );

  // Diagnostics.
  registerDiagnostics(context);

  // Status bar.
  const statusBar = new PostwaveStatusBar();
  statusBar.start();
  context.subscriptions.push(statusBar);

  // Commands.
  context.subscriptions.push(
    vscode.commands.registerCommand("postwave.preview.open", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.postwave");
      provider.refresh();
    }),
    vscode.commands.registerCommand("postwave.email.sendTest", () =>
      sendTestCommand(context),
    ),
    vscode.commands.registerCommand("postwave.devServer.start", async () => {
      const term = vscode.window.createTerminal("Moosewave dev");
      term.show();
      term.sendText("npx postwave dev");
    }),
    vscode.commands.registerCommand("postwave.login", () =>
      loginCommand(context),
    ),
    vscode.commands.registerCommand("postwave.logout", () =>
      logoutCommand(context),
    ),
  );
}

export function deactivate(): void {
  // Resources are cleaned up via context.subscriptions.
}
