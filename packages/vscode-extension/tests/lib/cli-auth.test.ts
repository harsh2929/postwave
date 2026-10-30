// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildCliBrowserAuthorizationUrl,
  createCliPkceRequest,
  exchangeCliAuthorizationCode,
  inspectCliLoopbackCallback,
  type CliPkceRequest,
} from "../../src/lib/cli-auth.js";

const fixedRequest: CliPkceRequest = {
  state: "s".repeat(32),
  codeVerifier: "v".repeat(43),
  codeChallenge: "c".repeat(43),
};
const authorizationCode = "A".repeat(43);

describe("VS Code CLI PKCE authentication", () => {
  it("creates a valid S256 PKCE request", () => {
    const request = createCliPkceRequest();

    expect(request.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(request.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.codeChallenge).toBe(
      createHash("sha256").update(request.codeVerifier).digest("base64url"),
    );
  });

  it("builds only the fixed Moosewave browser authorization URL", () => {
    const raw = buildCliBrowserAuthorizationUrl(43123, fixedRequest);
    expect(raw).not.toBeNull();
    const url = new URL(raw!);

    expect(url.origin).toBe("https://app.moosewave.com");
    expect(url.pathname).toBe("/cli/auth");
    expect(url.searchParams.get("source")).toBe("vscode");
    expect(url.searchParams.get("port")).toBe("43123");
    expect(url.searchParams.get("state")).toBe(fixedRequest.state);
    expect(url.searchParams.get("code_challenge")).toBe(
      fixedRequest.codeChallenge,
    );
    expect(url.searchParams.get("challenge_method")).toBe("S256");
    expect(buildCliBrowserAuthorizationUrl(0, fixedRequest)).toBeNull();
  });

  it("accepts one exact GET callback with matching state", () => {
    expect(
      inspectCliLoopbackCallback(
        "GET",
        `/callback?code=${authorizationCode}&state=${fixedRequest.state}`,
        fixedRequest.state,
      ),
    ).toEqual({
      accepted: true,
      code: authorizationCode,
      status: 200,
      message: "authorized",
    });
  });

  it.each([
    [
      "POST",
      `/callback?code=${authorizationCode}&state=${fixedRequest.state}`,
      405,
    ],
    [
      "GET",
      `/other?code=${authorizationCode}&state=${fixedRequest.state}`,
      404,
    ],
    ["GET", `/callback?code=short&state=${fixedRequest.state}`, 400],
    ["GET", `/callback?code=${authorizationCode}&state=${"x".repeat(32)}`, 400],
    [
      "GET",
      `/callback?code=${authorizationCode}&code=${authorizationCode}&state=${fixedRequest.state}`,
      400,
    ],
    [
      "GET",
      `http://evil.example/callback?code=${authorizationCode}&state=${fixedRequest.state}`,
      404,
    ],
  ])("rejects an unsafe loopback callback", (method, url, expectedStatus) => {
    const result = inspectCliLoopbackCallback(method, url, fixedRequest.state);
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(expectedStatus);
  });

  it("exchanges the code directly with the API and returns a valid key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ api_key: "pw_1234567890abcdef" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      exchangeCliAuthorizationCode(authorizationCode, fixedRequest, fetchMock),
    ).resolves.toBe("pw_1234567890abcdef");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe(
      "https://api.moosewave.com/api/v1/auth/cli/token",
    );
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: authorizationCode,
      code_verifier: fixedRequest.codeVerifier,
      state: fixedRequest.state,
    });
  });

  it("rejects failed, malformed, and credential-free token responses", async () => {
    const unauthorized = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response('{"error":"denied"}', { status: 401 })),
    );
    await expect(
      exchangeCliAuthorizationCode(
        authorizationCode,
        fixedRequest,
        unauthorized,
      ),
    ).rejects.toThrow("returned 401");

    const invalidJson = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response("not-json", { status: 200 })),
    );
    await expect(
      exchangeCliAuthorizationCode(
        authorizationCode,
        fixedRequest,
        invalidJson,
      ),
    ).rejects.toThrow("invalid JSON");

    const invalidKey = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ api_key: "unsafe key" }), {
          status: 200,
        }),
      ),
    );
    await expect(
      exchangeCliAuthorizationCode(authorizationCode, fixedRequest, invalidKey),
    ).rejects.toThrow("no valid API key");
  });
});
