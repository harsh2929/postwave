// SPDX-License-Identifier: MIT

import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as vscode from "vscode";

import {
  buildCliBrowserAuthorizationUrl,
  createCliPkceRequest,
  exchangeCliAuthorizationCode,
  inspectCliLoopbackCallback,
} from "../lib/cli-auth.js";

const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the same authorization-code + PKCE flow as the CLI. The browser only
 * receives a challenge and one-time state, then returns a short-lived code to
 * the loopback listener. The API key comes directly from the API token
 * exchange into VS Code SecretStorage and never passes through the browser.
 */
export async function loginCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  const pkce = createCliPkceRequest();
  let loopback: LoopbackHandle | undefined;
  try {
    loopback = await startLoopback(pkce.state);
    const authUrl = buildCliBrowserAuthorizationUrl(loopback.port, pkce);
    if (!authUrl) throw new Error("could not create a safe authorization URL");

    const opened = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    if (!opened)
      throw new Error("VS Code could not open the authorization page");
    void vscode.window.showInformationMessage(
      "Moosewave: approve the sign-in request in your browser.",
    );

    const code = await loopback.done;
    const apiKey = await exchangeCliAuthorizationCode(code, pkce);
    await context.secrets.store("postwave.apiKey", apiKey);
    void vscode.window.showInformationMessage(
      "Moosewave: signed in successfully.",
    );
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Moosewave sign-in failed: ${safeErrorMessage(error)}`,
    );
  } finally {
    loopback?.dispose();
  }
}

export async function logoutCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.secrets.delete("postwave.apiKey");
  void vscode.window.showInformationMessage(
    "Moosewave: local sign-in credential removed.",
  );
}

interface LoopbackHandle {
  server: http.Server;
  port: number;
  done: Promise<string>;
  dispose: () => void;
}

async function startLoopback(expectedState: string): Promise<LoopbackHandle> {
  let settled = false;
  // eslint-disable-next-line prefer-const -- listener callbacks can run before the timer is initialized.
  let timeout: NodeJS.Timeout | undefined;
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: Error) => void = () => {};
  const done = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const settleResolve = (code: string) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    resolveCode(code);
  };
  const settleReject = (error: Error) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    rejectCode(error);
  };

  const server = http.createServer((req, res) => {
    if (settled) {
      writeLoopbackResponse(
        res,
        410,
        "authorization request already completed",
      );
      return;
    }
    const decision = inspectCliLoopbackCallback(
      req.method,
      req.url,
      expectedState,
    );
    writeLoopbackResponse(res, decision.status, decision.message);
    if (decision.accepted && decision.code) settleResolve(decision.code);
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => reject(error);
    server.once("error", onListenError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onListenError);
      resolve();
    });
  });
  server.on("error", (error) => settleReject(error));

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not determine the loopback listener port");
  }
  timeout = setTimeout(
    () => settleReject(new Error("browser authorization timed out")),
    CALLBACK_TIMEOUT_MS,
  );
  const dispose = () => {
    // An error can occur after the listener starts but before `done` is
    // awaited (for example, if VS Code cannot launch the browser). Clear the
    // timer in that path so it cannot later create an unhandled rejection.
    if (!settled) {
      settled = true;
      if (timeout) clearTimeout(timeout);
    }
    server.close();
  };
  return { server, port: (address as AddressInfo).port, done, dispose };
}

function writeLoopbackResponse(
  response: http.ServerResponse,
  status: number,
  message: string,
): void {
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(message);
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  const message = error.message.trim();
  if (!message || /[\u0000-\u001f\u007f]/.test(message)) return "unknown error";
  return message.slice(0, 240);
}
