// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  buildLocalPreviewApiUrl,
  buildLocalPreviewUrl,
  isLoopbackCallbackPath,
  isPostwaveApiKey,
  isSafeHeaderValue,
  normalizeBrowserAuthUrl,
  normalizeLocalPreviewBaseUrl,
  normalizePreviewFilePath,
  normalizePreviewWidth,
} from "../../src/lib/safe-url.js";

describe("VS Code URL guards", () => {
  it("normalizes browser auth URLs", () => {
    expect(normalizeBrowserAuthUrl("https://app.moosewave.com/cli/auth#x")).toBe(
      "https://app.moosewave.com/cli/auth",
    );
    expect(normalizeBrowserAuthUrl("https://u:p@app.moosewave.com/cli/auth")).toBeNull();
    expect(normalizeBrowserAuthUrl("http://app.moosewave.com/cli/auth")).toBeNull();
    expect(normalizeBrowserAuthUrl("https://evil.example/cli/auth")).toBeNull();
    expect(normalizeBrowserAuthUrl("https://app.moosewave.com/other")).toBeNull();
    expect(normalizeBrowserAuthUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserAuthUrl("https://app.moosewave.com/cli/auth\nbad")).toBeNull();
  });

  it("allows only local preview server bases", () => {
    expect(normalizeLocalPreviewBaseUrl("http://127.0.0.1:4321/root?x#y")).toBe(
      "http://127.0.0.1:4321/root",
    );
    expect(normalizeLocalPreviewBaseUrl("https://localhost:4321")).toBe(
      "https://localhost:4321",
    );
    expect(normalizeLocalPreviewBaseUrl("https://preview.example.test")).toBe(
      "http://localhost:4321",
    );
    expect(normalizeLocalPreviewBaseUrl("http://u:p@localhost:4321")).toBe(
      "http://localhost:4321",
    );
    expect(normalizeLocalPreviewBaseUrl("http://localhost:4321\nx")).toBe(
      "http://localhost:4321",
    );
  });

  it("builds encoded local preview URLs", () => {
    expect(buildLocalPreviewUrl("http://localhost:4321", "emails/welcome email.tsx")).toBe(
      "http://localhost:4321/preview/emails%2Fwelcome%20email.tsx",
    );
    expect(buildLocalPreviewUrl("https://evil.example", "x")).toBe(
      "http://localhost:4321/preview/x",
    );
    expect(buildLocalPreviewUrl("http://localhost:4321", "/private/tmp/email.tsx")).toBe(
      "http://localhost:4321/preview",
    );
    expect(buildLocalPreviewUrl("http://localhost:4321", "../secret.tsx")).toBe(
      "http://localhost:4321/preview",
    );
    expect(normalizePreviewFilePath("emails/welcome.tsx")).toBe("emails/welcome.tsx");
    expect(normalizePreviewFilePath("C:\\Users\\me\\email.tsx")).toBeNull();
  });

  it("builds local dev API URLs without double slashes", () => {
    expect(buildLocalPreviewApiUrl("http://localhost:4321/", "/api/send-test")).toBe(
      "http://localhost:4321/api/send-test",
    );
    expect(buildLocalPreviewApiUrl("http://127.0.0.1:4321/root/", "health")).toBe(
      "http://127.0.0.1:4321/root/health",
    );
    expect(() =>
      buildLocalPreviewApiUrl("http://localhost:4321", "https://evil.example/x"),
    ).toThrow(/Unsafe local preview API path/);
    expect(() =>
      buildLocalPreviewApiUrl("http://localhost:4321", "/api/%2e%2e/health"),
    ).toThrow(/Unsafe local preview API path/);
    expect(() =>
      buildLocalPreviewApiUrl("http://localhost:4321", "/api/%252e%252e/health"),
    ).toThrow(/Unsafe local preview API path/);
    expect(() =>
      buildLocalPreviewApiUrl("http://localhost:4321", "/api\\health"),
    ).toThrow(/Unsafe local preview API path/);
  });

  it("validates extension callback API keys", () => {
    expect(isPostwaveApiKey("pw_1234567890abcdef")).toBe(true);
    expect(isPostwaveApiKey(" pw_1234567890abcdef")).toBe(false);
    expect(isPostwaveApiKey("pw_short")).toBe(false);
    expect(isPostwaveApiKey("sk_1234567890abcdef")).toBe(false);
    expect(isPostwaveApiKey("pw_bad token value")).toBe(false);
  });

  it("matches only the exact loopback callback path", () => {
    expect(isLoopbackCallbackPath("/callback")).toBe(true);
    expect(isLoopbackCallbackPath("/callback?state=x")).toBe(true);
    expect(isLoopbackCallbackPath("/callbackevil")).toBe(false);
    expect(isLoopbackCallbackPath("/%63allback")).toBe(false);
    expect(isLoopbackCallbackPath("/callback\nbad")).toBe(false);

    // The cases the five above could never reach: `new URL(raw, base)` ignores
    // the base for an absolute or protocol-relative input, so a path-only test
    // suite cannot detect a missing origin check. Every one of these returned
    // TRUE from a function named `isLoopbackCallbackPath`.
    expect(isLoopbackCallbackPath("https://evil.example/callback")).toBe(false);
    expect(isLoopbackCallbackPath("http://attacker.test:9999/callback")).toBe(false);
    expect(isLoopbackCallbackPath("//evil.example/callback")).toBe(false);
    expect(isLoopbackCallbackPath("https://u:p@127.0.0.1/callback")).toBe(false);
    expect(isLoopbackCallbackPath("file:///callback")).toBe(false);

    // Loopback spellings that must still be accepted, so the repair is a
    // narrowing of the origin rather than a rejection of everything.
    expect(isLoopbackCallbackPath("http://127.0.0.1/callback")).toBe(true);
    expect(isLoopbackCallbackPath("http://127.0.0.1:5599/callback?code=x")).toBe(true);
    expect(isLoopbackCallbackPath("http://localhost/callback")).toBe(true);
    expect(isLoopbackCallbackPath("http://[::1]/callback")).toBe(true);
  });

  it("validates extension header values before attaching bearer tokens", () => {
    expect(isSafeHeaderValue("pw_1234567890abcdef")).toBe(true);
    expect(isSafeHeaderValue("pw_1234567890abcdef\nX-Bad: yes")).toBe(false);
    expect(isSafeHeaderValue(" pw_1234567890abcdef")).toBe(false);
    expect(isSafeHeaderValue("")).toBe(false);
  });

  it("normalizes preview widths", () => {
    expect(normalizePreviewWidth("mobile")).toBe("mobile");
    expect(normalizePreviewWidth("desktop")).toBe("desktop");
    expect(normalizePreviewWidth("wide")).toBe("desktop");
    expect(normalizePreviewWidth("wide", "mobile")).toBe("mobile");
  });
});
