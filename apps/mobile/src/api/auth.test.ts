import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthClient,
  redactAuthError,
  safeOAuthRedirectTo,
  setMfaRequiredObserver,
} from "./auth";

const MOBILE_LINK_START = {
  link_version: 1 as const,
  link_audience: "mobile" as const,
  state: "device-state",
};

afterEach(() => {
  setMfaRequiredObserver(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mobile auth client response parsing", () => {
  it("accepts only a /me response with explicit authoritative MFA fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            user_id: "user_1",
            tenant_id: "tenant_1",
            email: "owner@example.com",
            role: "owner",
            auth_provider: "password",
            email_verified: true,
            totp_enabled: false,
            mfa_required: true,
            mfa_satisfied: false,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await createAuthClient("https://api.moosewave.com").getMe();

    expect(result.data).toMatchObject({
      totp_enabled: false,
      mfa_required: true,
      mfa_satisfied: false,
    });
  });

  it("rejects a legacy /me response that omits canonical MFA state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            user_id: "user_1",
            tenant_id: "tenant_1",
            email: "owner@example.com",
            role: "owner",
            auth_provider: "password",
            email_verified: true,
            totp_enabled: false,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await createAuthClient("https://api.moosewave.com").getMe();

    expect(result.error).toMatchObject({
      code: "invalid_me_response",
      kind: "parse",
    });
  });

  it("reports mfa_required from cookie-aware auth endpoints", async () => {
    const observer = vi.fn(async () => undefined);
    setMfaRequiredObserver(observer);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: { code: "mfa_required", message: "step up" },
          }),
          { status: 403 },
        ),
      ),
    );

    const result = await createAuthClient(
      "https://api.moosewave.com",
    ).totpDisable();

    expect(result.error).toMatchObject({
      status: 403,
      code: "mfa_required",
      kind: "http",
    });
    expect(observer).toHaveBeenCalledWith({
      baseUrl: "https://api.moosewave.com",
      status: 403,
      code: "mfa_required",
    });
  });

  it("sends a recovery code without a competing TOTP code", async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ mfa_satisfied: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await createAuthClient("https://api.moosewave.com").totpChallenge({
      recovery_code: "once-only-code",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/auth/totp/challenge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ recovery_code: "once-only-code" }),
      }),
    );
  });

  it("handles 204 responses without parsing JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    const res = await createAuthClient(
      "https://api.moosewave.com",
    ).logoutSession();

    expect(res.error).toBeUndefined();
    expect(res.data).toBeUndefined();
  });

  it("handles empty successful responses without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 200 })),
    );

    const res = await createAuthClient(
      "https://api.moosewave.com",
    ).passwordResetStart("reader@example.com", MOBILE_LINK_START);

    expect(res.error).toBeUndefined();
    expect(res.data).toBeUndefined();
  });

  it("normalizes trailing slashes when building auth request URLs", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await createAuthClient("https://api.moosewave.com/").passwordResetStart(
      "reader@example.com",
      MOBILE_LINK_START,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/auth/password-reset/start",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("preserves self-hosted base paths and rejects unsafe auth bases", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await createAuthClient("https://api.example.com/gateway///").passwordResetStart(
      "reader@example.com",
      MOBILE_LINK_START,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/gateway/api/v1/auth/password-reset/start",
      expect.objectContaining({ method: "POST" }),
    );
    expect(() => createAuthClient("https://user:pass@api.example.com")).toThrow(
      /valid http\(s\) URL/,
    );
  });

  it("returns a parse envelope for invalid successful JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{nope", { status: 200 })),
    );

    const res = await createAuthClient("https://api.moosewave.com").getMe();

    expect(res.error?.kind).toBe("parse");
    expect(res.error?.code).toBe("invalid_json");
  });

  it("enforces response limits by UTF-8 bytes in text-only runtimes", async () => {
    const huge = JSON.stringify({ user_id: "u", pad: "😊".repeat(140_000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: null,
        text: async () => huge,
      }) as unknown as Response),
    );

    const res = await createAuthClient("https://api.moosewave.com").getMe();

    expect(res.data).toBeUndefined();
    expect(res.error).toMatchObject({
      code: "response_too_large",
      kind: "parse",
    });
  });

  it("enforces declared auth response limits before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user_id: "u" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(600 * 1024),
            },
          }),
      ),
    );

    const res = await createAuthClient("https://api.moosewave.com").getMe();

    expect(res.data).toBeUndefined();
    expect(res.error?.code).toBe("response_too_large");
  });
});

describe("mobile auth error redaction", () => {
  it("hides database internals before surfacing auth errors", () => {
    expect(redactAuthError("pq: duplicate key value violates unique constraint")).toBe(
      "Server error. Please try again.",
    );
    expect(redactAuthError("Invalid email or password")).toBe(
      "Invalid email or password",
    );
  });
});

describe("mobile OAuth redirect guards", () => {
  it("allows relative app paths and the state-bound native magic return", () => {
    expect(safeOAuthRedirectTo("/(auth)/sign-in")).toBe("/(auth)/sign-in");
    expect(safeOAuthRedirectTo("moosewave://auth/magic?state=abc123")).toBe(
      "moosewave://auth/magic?state=abc123",
    );
  });

  it("rejects the redirects the server's sanitizeOAuthRedirect also rejects", () => {
    expect(safeOAuthRedirectTo("//evil.example/path")).toBeUndefined();
    expect(safeOAuthRedirectTo("https://app.moosewave.com/auth/magic")).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://subscriber/123")).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://u:p@auth/magic")).toBeUndefined();
    expect(safeOAuthRedirectTo(`/${"x".repeat(3000)}`)).toBeUndefined();
    // The server only ever accepts /magic; `oauth-return` would strand the
    // user in a browser because bounceBack falls back to the web origin.
    expect(safeOAuthRedirectTo("moosewave://auth/oauth-return")).toBeUndefined();
    // A native return with no device nonce cannot be matched by magic-return.
    expect(safeOAuthRedirectTo("moosewave://auth/magic")).toBeUndefined();
    // Duplicate or malformed state values are refused, not silently reduced.
    expect(
      safeOAuthRedirectTo("moosewave://auth/magic?state=a&state=b"),
    ).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://auth/magic?state=%20")).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://auth/magic/extra?state=a")).toBeUndefined();
  });

  it("builds OAuth start URLs on the configured API origin", () => {
    expect(
      createAuthClient("https://api.moosewave.com/").oauthStartUrl(
        "google",
        "/(auth)/oauth-return",
      ),
    ).toBe(
      "https://api.moosewave.com/api/v1/auth/oauth/google/start?redirect_to=%2F%28auth%29%2Foauth-return",
    );
  });
});
