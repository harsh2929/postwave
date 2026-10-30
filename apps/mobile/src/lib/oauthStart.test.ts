import { describe, expect, it } from "vitest";

import {
  buildOAuthStartUrl,
  isOAuthReturnUrl,
  OAUTH_RETURN_URL,
  oauthReturnRouteParams,
} from "./oauthStart";

const STATE = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const SIG = "A".repeat(43);

function returnUrl(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    token: "tok_abc",
    v: "1",
    flow: "magic",
    aud: "mobile",
    state: STATE,
    sig: SIG,
    ...overrides,
  });
  return `${OAUTH_RETURN_URL}?${params.toString()}`;
}

describe("buildOAuthStartUrl", () => {
  it("builds exactly the redirect the server sanitizer admits", () => {
    const url = buildOAuthStartUrl({
      baseUrl: "https://api.moosewave.com",
      provider: "google",
      state: STATE,
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://api.moosewave.com");
    expect(parsed.pathname).toBe("/api/v1/auth/oauth/google/start");
    // sanitizeOAuthRedirect requires scheme postwave, host auth, path /magic
    // and EXACTLY ONE state parameter; anything else is dropped to "".
    const redirect = parsed.searchParams.get("redirect_to") ?? "";
    expect(redirect).toBe(`moosewave://auth/magic?state=${STATE}`);
    expect(parsed.searchParams.getAll("redirect_to")).toHaveLength(1);
  });

  it("keeps a self-hosted origin, including its port", () => {
    const url = buildOAuthStartUrl({
      baseUrl: "https://mail.acme.internal:8443",
      provider: "google",
      state: STATE,
    });
    expect(url.startsWith("https://mail.acme.internal:8443/api/v1/auth/oauth/"))
      .toBe(true);
  });

  it("refuses a base URL that carries credentials, a query, or a fragment", () => {
    for (const bad of [
      "https://user:pw@api.moosewave.com",
      "https://api.moosewave.com?x=1",
      "https://api.moosewave.com#frag",
      "ftp://api.moosewave.com",
      "not a url",
    ]) {
      expect(() =>
        buildOAuthStartUrl({ baseUrl: bad, provider: "google", state: STATE }),
      ).toThrow();
    }
  });

  it("refuses a state that could smuggle a second query parameter", () => {
    expect(() =>
      buildOAuthStartUrl({
        baseUrl: "https://api.moosewave.com",
        provider: "google",
        state: "",
      }),
    ).toThrow();
    // A state containing control characters is rejected by safeAuthLinkState.
    expect(() =>
      buildOAuthStartUrl({
        baseUrl: "https://api.moosewave.com",
        provider: "google",
        state: "abc\ndef",
      }),
    ).toThrow();
  });

  it("percent-encodes a state so it cannot break out of the redirect", () => {
    const url = buildOAuthStartUrl({
      baseUrl: "https://api.moosewave.com",
      provider: "google",
      state: "abc&sig=forged",
    });
    const redirect = new URL(url).searchParams.get("redirect_to") ?? "";
    expect(new URL(redirect).searchParams.getAll("state")).toEqual([
      "abc&sig=forged",
    ]);
    expect(new URL(redirect).searchParams.get("sig")).toBeNull();
  });
});

describe("oauthReturnRouteParams", () => {
  it("translates a signed mobile envelope into magic-return params", () => {
    expect(oauthReturnRouteParams(returnUrl())).toEqual({
      token: "tok_abc",
      link_version: "1",
      link_flow: "magic",
      link_audience: "mobile",
      state: STATE,
      link_signature: SIG,
    });
  });

  it("rejects a web-audience envelope, which is not device-bound", () => {
    const params = new URLSearchParams({
      token: "tok_abc",
      v: "1",
      flow: "magic",
      aud: "web",
      sig: SIG,
    });
    expect(
      oauthReturnRouteParams(`${OAUTH_RETURN_URL}?${params.toString()}`),
    ).toBeNull();
  });

  it("rejects envelopes that are unsigned, mis-versioned, or wrong-flow", () => {
    expect(oauthReturnRouteParams(returnUrl({ sig: "short" }))).toBeNull();
    expect(oauthReturnRouteParams(returnUrl({ v: "2" }))).toBeNull();
    expect(oauthReturnRouteParams(returnUrl({ flow: "reset" }))).toBeNull();
  });

  it("rejects a URL that is not exactly moosewave://auth/magic", () => {
    const query = new URLSearchParams({
      token: "tok_abc",
      v: "1",
      flow: "magic",
      aud: "mobile",
      state: STATE,
      sig: SIG,
    }).toString();
    for (const bad of [
      `moosewave://auth/reset?${query}`,
      `moosewave://evil/magic?${query}`,
      `https://app.moosewave.com/magic-link?${query}`,
      `moosewave://auth/magic?${query}#frag`,
      `moosewave://user@auth/magic?${query}`,
    ]) {
      expect(oauthReturnRouteParams(bad)).toBeNull();
    }
  });

  it("never throws on hostile input", () => {
    for (const bad of ["", "::::", "moosewave://", `x`.repeat(9000)]) {
      expect(oauthReturnRouteParams(bad)).toBeNull();
      expect(isOAuthReturnUrl(bad)).toBe(false);
    }
  });

  it("recognises the callback shape before it is parsed for a proof", () => {
    expect(isOAuthReturnUrl(returnUrl())).toBe(true);
    expect(isOAuthReturnUrl("moosewave://auth/magic")).toBe(true);
    expect(isOAuthReturnUrl("moosewave://auth/oauth-return")).toBe(false);
  });
});
