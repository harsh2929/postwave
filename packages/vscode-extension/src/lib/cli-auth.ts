// SPDX-License-Identifier: MIT

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { readResponseTextLimited } from "./http.js";
import { isPostwaveApiKey, normalizeBrowserAuthUrl } from "./safe-url.js";

const AUTH_URL = "https://app.moosewave.com/cli/auth";
const TOKEN_URL = "https://api.moosewave.com/api/v1/auth/cli/token";
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 8 * 1024;
const CALLBACK_CODE_RE = /^[A-Za-z0-9_-]{32,256}$/;
const PKCE_VALUE_RE = /^[A-Za-z0-9_-]{32,256}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface CliPkceRequest {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export interface LoopbackCallbackDecision {
  accepted: boolean;
  code?: string;
  status: number;
  message: string;
}

export function createCliPkceRequest(): CliPkceRequest {
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { state, codeVerifier, codeChallenge };
}

export function buildCliBrowserAuthorizationUrl(
  port: number,
  request: CliPkceRequest,
): string | null {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !PKCE_VALUE_RE.test(request.state) ||
    !PKCE_VALUE_RE.test(request.codeVerifier) ||
    !PKCE_VALUE_RE.test(request.codeChallenge)
  ) {
    return null;
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set("source", "vscode");
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("challenge_method", "S256");
  return normalizeBrowserAuthUrl(url.toString());
}

export function inspectCliLoopbackCallback(
  method: string | undefined,
  rawUrl: string | undefined,
  expectedState: string,
): LoopbackCallbackDecision {
  if (method !== "GET") {
    return { accepted: false, status: 405, message: "method not allowed" };
  }
  if (!rawUrl || CONTROL_RE.test(rawUrl)) {
    return { accepted: false, status: 400, message: "invalid callback URL" };
  }

  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return { accepted: false, status: 400, message: "invalid callback URL" };
  }
  if (url.origin !== "http://127.0.0.1" || url.pathname !== "/callback") {
    return { accepted: false, status: 404, message: "not found" };
  }
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== "code" && key !== "state") ||
    url.searchParams.getAll("code").length !== 1 ||
    url.searchParams.getAll("state").length !== 1
  ) {
    return {
      accepted: false,
      status: 400,
      message: "invalid callback parameters",
    };
  }
  const state = url.searchParams.get("state") ?? "";
  if (!constantTimeEqual(state, expectedState)) {
    return { accepted: false, status: 400, message: "state mismatch" };
  }
  const code = url.searchParams.get("code") ?? "";
  if (!CALLBACK_CODE_RE.test(code)) {
    return {
      accepted: false,
      status: 400,
      message: "invalid authorization code",
    };
  }
  return { accepted: true, code, status: 200, message: "authorized" };
}

export async function exchangeCliAuthorizationCode(
  code: string,
  request: CliPkceRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (
    !CALLBACK_CODE_RE.test(code) ||
    !PKCE_VALUE_RE.test(request.state) ||
    !PKCE_VALUE_RE.test(request.codeVerifier)
  ) {
    throw new Error("invalid CLI authorization exchange input");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        code,
        code_verifier: request.codeVerifier,
        state: request.state,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readResponseTextLimited(
      response,
      MAX_TOKEN_RESPONSE_BYTES,
    );
    if (!response.ok) {
      throw new Error(`Moosewave token exchange returned ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("Moosewave token exchange returned invalid JSON");
    }
    const apiKey =
      payload && typeof payload === "object" && "api_key" in payload
        ? (payload as { api_key?: unknown }).api_key
        : undefined;
    if (!isPostwaveApiKey(apiKey)) {
      throw new Error("Moosewave token exchange returned no valid API key");
    }
    return apiKey;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Moosewave token exchange timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}
