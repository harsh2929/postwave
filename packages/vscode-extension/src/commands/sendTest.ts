// SPDX-License-Identifier: MIT
import * as vscode from "vscode";

import {
  buildLocalPreviewApiUrl,
  isSafeHeaderValue,
  normalizeLocalPreviewBaseUrl,
} from "../lib/safe-url.js";
import {
  readResponseTextLimited,
  ResponseBodyTooLargeError,
} from "../lib/http.js";

const SEND_TEST_TIMEOUT_MS = 15_000;
const SEND_TEST_MAX_ERROR_BYTES = 8 * 1024;

/**
 * Asks the local Moosewave dev server to compile the active file and
 * deliver a one-off test send. The dev server owns rendering — this
 * command just forwards the file path.
 */
export async function sendTestCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showErrorMessage("Moosewave: no active editor.");
    return;
  }

  const recipient = await vscode.window.showInputBox({
    prompt: "Send test email to which address?",
    placeHolder: "you@example.com",
    validateInput: (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : "Invalid email address.",
  });
  if (!recipient) return;
  const subject = await vscode.window.showInputBox({
    prompt: "Subject line for the test email",
    value: "Moosewave preview",
    validateInput: (v) =>
      v.trim().length > 0 && v.trim().length <= 180
        ? null
        : "Subject must be 1-180 characters.",
  });
  if (subject === undefined) return;

  const cfg = vscode.workspace.getConfiguration("postwave");
  const base = normalizeLocalPreviewBaseUrl(
    cfg.get<string>("devServerUrl") ?? "http://localhost:4321",
  );
  const sendTestUrl = buildLocalPreviewApiUrl(base, "/api/send-test");

  const apiKey = (await context.secrets.get("postwave.apiKey")) ?? "";

  const rel = vscode.workspace.asRelativePath(editor.document.uri, false);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SEND_TEST_TIMEOUT_MS);
  try {
    const resp = await fetch(sendTestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(isSafeHeaderValue(apiKey)
          ? { authorization: `Bearer ${apiKey}` }
          : {}),
      },
      signal: ac.signal,
      body: JSON.stringify({ path: rel, to: recipient, subject }),
    });
    if (!resp.ok) {
      let body = "";
      try {
        body = await readResponseTextLimited(resp, SEND_TEST_MAX_ERROR_BYTES);
      } catch (err) {
        body =
          err instanceof ResponseBodyTooLargeError
            ? `error response exceeded ${SEND_TEST_MAX_ERROR_BYTES} bytes`
            : "could not read error response";
      }
      void vscode.window.showErrorMessage(
        `Moosewave send-test failed (${resp.status}): ${body.slice(0, 200)}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Moosewave: test email queued to ${recipient}.`,
    );
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    void vscode.window.showErrorMessage(
      timedOut
        ? `Moosewave: send-test timed out after ${SEND_TEST_TIMEOUT_MS / 1000}s.`
        : `Moosewave: could not reach dev server at ${base}. Run \`postwave dev\`. (${(err as Error).message})`,
    );
  } finally {
    clearTimeout(timer);
  }
}
