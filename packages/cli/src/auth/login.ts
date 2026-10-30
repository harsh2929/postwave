// SPDX-License-Identifier: MIT

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import open from "open";
import chalk from "chalk";
import prompts from "prompts";
import { setCredentials, resolveBaseUrl, isSafeCredentialValue } from "../lib/config.js";

export interface LoginOptions {
  apiKey?: string;
  baseUrl?: string;
  noBrowser?: boolean;
}

export async function login(opts: LoginOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl(opts.baseUrl);

  if (opts.apiKey) {
    if (!isSafeCredentialValue(opts.apiKey)) {
      console.error(chalk.red("Refusing to store an unsafe API key."));
      process.exitCode = 1;
      return;
    }
    try {
      setCredentials({
        apiKey: opts.apiKey,
        baseUrl,
        storedAt: new Date().toISOString(),
      });
      console.log(chalk.green("Stored API key from --api-key flag."));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
    return;
  }

  if (opts.noBrowser) {
    const r = await prompts({
      type: "password",
      name: "key",
      message: "Paste your API key:",
    });
    if (!r.key) {
      console.log(chalk.red("Aborted."));
      return;
    }
    if (!isSafeCredentialValue(r.key)) {
      console.error(chalk.red("Refusing to store an unsafe API key."));
      process.exitCode = 1;
      return;
    }
    try {
      setCredentials({
        apiKey: r.key,
        baseUrl,
        storedAt: new Date().toISOString(),
      });
      console.log(chalk.green("Stored."));
    } catch (err) {
      console.error(chalk.red((err as Error).message));
      process.exitCode = 1;
    }
    return;
  }

  try {
    await browserLogin(baseUrl);
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}

async function browserLogin(baseUrl: string): Promise<void> {
  const { server, port } = await listen();
  const authBase = normalizeBrowserAuthBaseUrl(baseUrl);
  if (!authBase) {
    server.close();
    throw new Error("Unsafe Moosewave base URL.");
  }

  // OAuth 2.0 authorization-code + PKCE (RFC 7636). The verifier never leaves
  // this process; only its SHA-256 challenge goes to the browser, and the
  // browser only ever hands back a one-time code (not the key).
  const state = crypto.randomBytes(24).toString("base64url");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const authUrl =
    `${authBase}/cli/auth?port=${port}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}` +
    `&challenge_method=S256`;

  console.log(`Opening: ${authUrl}`);
  await open(authUrl).catch(() => undefined);
  console.log("Waiting for you to approve in the browser. If it did not open, paste the URL above.");

  const cb = await waitForCallback(server);
  server.close();

  if (!cb.code) {
    console.log(chalk.red("Login did not complete. No authorization code received."));
    return;
  }
  if (cb.state !== state) {
    console.log(chalk.red("Login aborted: state mismatch (possible tampering)."));
    return;
  }

  // Exchange the code + our private verifier for the API key, directly with the
  // backend. The key is returned here and nowhere else.
  let payload: { api_key?: string; tenant_id?: string; email?: string };
  try {
    const res = await fetch(new URL("/api/v1/auth/cli/token", baseUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: cb.code, code_verifier: codeVerifier, state }),
    });
    if (!res.ok) {
      console.log(chalk.red(`Login failed: token exchange returned ${res.status}.`));
      return;
    }
    payload = (await res.json()) as { api_key?: string; tenant_id?: string; email?: string };
  } catch (err) {
    console.log(chalk.red(`Login failed: ${(err as Error).message}`));
    return;
  }

  const apiKey = payload.api_key;
  if (!apiKey || !isSafeCredentialValue(apiKey)) {
    console.log(chalk.red("Login failed: no valid API key returned."));
    return;
  }

  try {
    setCredentials({
      apiKey,
      baseUrl,
      tenantId: payload.tenant_id,
      email: payload.email,
      storedAt: new Date().toISOString(),
    });
    console.log(chalk.green(`Logged in${payload.email ? ` as ${payload.email}` : ""}.`));
  } catch (err) {
    console.error(chalk.red((err as Error).message));
    process.exitCode = 1;
  }
}

export function normalizeBrowserAuthBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !isLocalHttpUrl(url)) return null;
    url.pathname = url.pathname.replace(/\/api\/?$/, "").replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isLocalHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

interface CallbackResult {
  code?: string;
  state?: string;
}

function listen(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

function waitForCallback(server: http.Server): Promise<CallbackResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({}), 5 * 60 * 1000);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        "<!doctype html><meta charset=utf-8><title>Moosewave CLI</title>" +
          "<body style=\"font-family:system-ui;padding:48px;text-align:center;\">" +
          "<h1>Authorized.</h1><p>You can close this tab and return to your terminal.</p>" +
          "</body>",
      );
      clearTimeout(timeout);
      resolve({ code, state });
    });
  });
}
