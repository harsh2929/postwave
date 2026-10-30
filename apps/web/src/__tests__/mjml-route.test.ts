import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/mjml/route";

describe("MJML compile route boundary", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
  });

  it("requires an authenticated session before compiling", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mjml: "<mjml></mjml>" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires JSON content type", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          cookie: "pw_session=content-type-session; unrelated=private",
        },
        body: "{}",
      }),
    );

    expect(res.status).toBe(415);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toMatchObject({
      error: "Content-Type must be application/json",
    });
    const authHeaders = new Headers(
      vi.mocked(fetch).mock.calls[0]?.[1]?.headers,
    );
    expect(authHeaders.get("cookie")).toBe("pw_session=content-type-session");
  });

  it("rejects oversized bodies before parsing", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(201 * 1024),
          cookie: "pw_session=oversized-session",
        },
        body: JSON.stringify({ mjml: "<mjml></mjml>" }),
      }),
    );

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "Request body too large",
    });
  });

  it("rejects mj-include without invoking the compiler", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pw_session=include-session",
        },
        body: JSON.stringify({
          mjml: '<mjml><mj-body><mj-include path="https://example.com/x" /></mj-body></mjml>',
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(res.json()).resolves.toMatchObject({
      error: "mj-include is not supported by this endpoint",
    });
  });

  it("rejects caller-requested minification", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pw_session=minify-session",
          "x-real-ip": "192.0.2.11",
        },
        body: JSON.stringify({
          mjml: "<mjml><mj-body /></mjml>",
          options: { minify: true },
        }),
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "MJML minify is disabled on this endpoint",
    });
  });

  it("awaits MJML 5 and returns compiled HTML", async () => {
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pw_session=compile-session",
          "x-real-ip": "192.0.2.12",
        },
        body: JSON.stringify({
          mjml: "<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>",
        }),
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      html: expect.stringContaining("<!doctype html>"),
      errors: [],
    });
  });

  it("rate limits by validated credential despite spoofed client IPs", async () => {
    let last!: Response;
    for (let index = 0; index < 21; index += 1) {
      last = await POST(
        new Request("https://app.postwave.test/api/mjml", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: "pw_session=rate-limit-session",
            "x-real-ip": `192.0.2.${index + 1}`,
            "x-forwarded-for": `198.51.100.${index + 1}`,
          },
          body: JSON.stringify({ mjml: "<mjml><mj-body /></mjml>" }),
        }),
      );
    }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("charges the same identity's budget across re-issued session cookies", async () => {
    // Every request presents a DIFFERENT pw_session value — what an attacker
    // gets by signing in repeatedly — but /auth/me resolves them all to one
    // user, so they must share one 20/minute allowance.
    const meResponse = (userID: string) => () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            user_id: userID,
            tenant_id: "22222222-2222-2222-2222-222222222222",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.mocked(fetch).mockImplementation(
      meResponse("11111111-1111-1111-1111-111111111111"),
    );

    let last!: Response;
    for (let index = 0; index < 21; index += 1) {
      last = await POST(
        new Request("https://app.postwave.test/api/mjml", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `pw_session=rotated-session-${index}`,
          },
          body: JSON.stringify({ mjml: "<mjml><mj-body /></mjml>" }),
        }),
      );
    }
    expect(last.status).toBe(429);

    // A different identity still gets its own allowance.
    vi.mocked(fetch).mockImplementation(
      meResponse("33333333-3333-3333-3333-333333333333"),
    );
    const other = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pw_session=rotated-session-0",
        },
        body: JSON.stringify({ mjml: "<mjml><mj-body /></mjml>" }),
      }),
    );
    expect(other.status).toBe(200);
  });

  it("fails closed when the API rejects the presented credential", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const res = await POST(
      new Request("https://app.postwave.test/api/mjml", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "pw_session=rejected-session",
        },
        body: JSON.stringify({ mjml: "<mjml></mjml>" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
