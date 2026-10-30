import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmPublicFormToken,
  fetchPublicForm,
  fetchPublicLandingPage,
  fetchPublicPreferences,
  visitorIPFromHeaders,
} from "@/lib/public-pages-api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("public page API fetchers", () => {
  it("keeps more than ten server-side form renders free of reconstructed forwarding identity", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const slug = new URL(url).pathname.split("/").at(-1) || "form";
      return Response.json({
        form: { id: slug, slug, status: "published" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        fetchPublicForm(`form-${index + 1}`, "https://api.example.com"),
      ),
    );

    expect(results).toHaveLength(25);
    expect(results.every((result) => result.kind === "ok")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(25);
    for (const [, init] of fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(headers.get("x-real-ip")).toBeNull();
    }
  });

  it("returns missing for public form 404s", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("missing", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "missing",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/public/forms/missing",
      expect.objectContaining({
        cache: "no-store",
        credentials: "omit",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("returns unavailable for public form 5xxs and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    await expect(
      fetchPublicForm("signup", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(
      fetchPublicForm("signup", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("preserves preference-token semantics while failing soft on outages", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("expired")) return new Response(null, { status: 410 });
      if (url.includes("missing")) return new Response(null, { status: 404 });
      return new Response("down", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicPreferences("expired", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "expired",
    });
    await expect(
      fetchPublicPreferences("missing", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "missing",
    });
    await expect(
      fetchPublicPreferences("oops", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "unavailable",
    });
  });

  it("validates public preference JSON before treating it as subscriber state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          email: "reader@example.com",
          expiresAt: "2026-09-30T12:00:00Z",
          topics: [],
          frequencyPreference: "default",
          gpc: false,
          customization: {
            logo_url: "https://assets.example.com/logo.png",
            primary_color: "#123ABC",
            footer_text: "Subscriber controls",
            show_postwave_badge: false,
          },
        }),
      ),
    );
    await expect(
      fetchPublicPreferences("valid", "https://api.example.com"),
    ).resolves.toMatchObject({ kind: "ok" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          email: "reader@example.com",
          expiresAt: "2026-09-30T12:00:00Z",
          topics: [],
          frequencyPreference: "default",
          gpc: false,
          customization: {
            logo_url: "data:image/svg+xml,<svg onload=alert(1) />",
            primary_color: "#123ABC",
            footer_text: "Subscriber controls",
            show_postwave_badge: false,
          },
        }),
      ),
    );
    await expect(
      fetchPublicPreferences("malformed", "https://api.example.com"),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  it("returns unavailable instead of throwing when landing pages are unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );

    await expect(
      fetchPublicLandingPage("launch", "https://api.example.com"),
    ).resolves.toEqual({ kind: "unavailable" });
  });

  // Renamed. This asserted 410 -> "unavailable" and was RIGHT at the time: the
  // API had no expired state, so mapping the status would have invented one.
  // The API now returns 410 with {"state":"expired"} (migration 1867 gave
  // double-opt-in links a window), and the locale strings for the page have
  // shipped in seven languages since before either change. Reading a state the
  // server genuinely sends is the opposite of inventing one — and reporting it
  // as "unavailable" told the reader to refresh a link that will never work
  // again.
  it("confirms public form tokens and reads the expiry state the API now sends", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("missing")) return new Response(null, { status: 404 });
      if (url.includes("expired")) return new Response(null, { status: 410 });
      if (url.includes("already")) {
        return Response.json({ state: "already" });
      }
      if (url.includes("down")) return new Response(null, { status: 503 });
      return Response.json({ state: "confirmed" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      confirmPublicFormToken("ok", "https://api.example.com"),
    ).resolves.toBe("confirmed");
    await expect(
      confirmPublicFormToken("already", "https://api.example.com"),
    ).resolves.toBe("already");
    await expect(
      confirmPublicFormToken("expired", "https://api.example.com"),
    ).resolves.toBe("expired");
    await expect(
      confirmPublicFormToken("missing", "https://api.example.com"),
    ).resolves.toBe("missing");
    await expect(
      confirmPublicFormToken("down", "https://api.example.com"),
    ).resolves.toBe("unavailable");

    for (const [, init] of fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(headers.get("x-real-ip")).toBeNull();
    }
  });

  it("normalizes public API base URLs before fetching", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("missing", "https://api.example.com///"),
    ).resolves.toEqual({ kind: "missing" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/api/public/forms/missing",
      expect.any(Object),
    );
  });

  it("preserves safe path prefixes in public API base URLs", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("missing", "https://api.example.com/gateway/"),
    ).resolves.toEqual({ kind: "missing" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/gateway/api/public/forms/missing",
      expect.any(Object),
    );
  });

  it("fails public lookups softly when the API base URL is unsafe", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("signup", "https://user:pass@api.example.com"),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      fetchPublicPreferences("token", "https://api.example.com#token"),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      confirmPublicFormToken("token", "javascript:alert(1)"),
    ).resolves.toBe("unavailable");
    await expect(
      fetchPublicLandingPage("launch", "http://api.example.com"),
    ).resolves.toEqual({ kind: "unavailable" });
    await expect(
      fetchPublicForm("signup", "https://api.example.com/\nmalformed"),
    ).resolves.toEqual({ kind: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows localhost HTTP during development-style public lookups", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("missing", "http://localhost:8080"),
    ).resolves.toEqual({ kind: "missing" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/public/forms/missing",
      expect.any(Object),
    );
  });

  it("rejects unsafe public slugs and tokens before fetching", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchPublicForm("../admin", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "missing",
    });
    await expect(
      fetchPublicLandingPage("launch/page", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "missing",
    });
    await expect(
      fetchPublicPreferences("token\nx", "https://api.example.com"),
    ).resolves.toEqual({
      kind: "missing",
    });
    await expect(
      confirmPublicFormToken("%2e%2e", "https://api.example.com"),
    ).resolves.toBe("missing");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// visitor-ip-leftmost-xff: the API resolves the client IP by walking
// X-Forwarded-For from the right (apps/api/internal/middleware/client_ip.go),
// because everything to the LEFT of a proxy-appended entry is client-supplied.
// Relaying only the leftmost entry handed the attacker's own value to that
// walk as the sole hop, minting a fresh rate-limit bucket per request.
describe("visitorIPFromHeaders", () => {
  const headersOf = (map: Record<string, string>): Pick<Headers, "get"> => ({
    get: (name: string) => map[name.toLowerCase()] ?? null,
  });

  it("relays the whole chain so the API's rightmost walk still sees the real peer", () => {
    const chain = visitorIPFromHeaders(
      headersOf({ "x-forwarded-for": "203.0.113.7, 198.51.100.20" }),
    );

    expect(chain).toBe("203.0.113.7, 198.51.100.20");
    // The forged leftmost entry must not be the only thing that survives.
    expect(chain).not.toBe("203.0.113.7");
    expect(chain.split(",").at(-1)?.trim()).toBe("198.51.100.20");
  });

  it("normalizes spacing without dropping hops", () => {
    expect(
      visitorIPFromHeaders(
        headersOf({ "x-forwarded-for": " 2001:db8::1 ,10.0.0.4 , 10.0.0.9" }),
      ),
    ).toBe("2001:db8::1, 10.0.0.4, 10.0.0.9");
  });

  it("drops the chain entirely when any hop is not an IP literal", () => {
    expect(
      visitorIPFromHeaders(
        headersOf({ "x-forwarded-for": "evil.example.com, 198.51.100.20" }),
      ),
    ).toBe("");
    expect(
      visitorIPFromHeaders(
        headersOf({ "x-forwarded-for": "198.51.100.20, not an ip" }),
      ),
    ).toBe("");
  });

  it("refuses a stuffed chain and falls back to x-real-ip", () => {
    expect(
      visitorIPFromHeaders(
        headersOf({
          "x-forwarded-for": Array.from(
            { length: 40 },
            (_, i) => `10.0.0.${i}`,
          ).join(","),
        }),
      ),
    ).toBe("");
    expect(
      visitorIPFromHeaders(headersOf({ "x-real-ip": "198.51.100.20" })),
    ).toBe("198.51.100.20");
    expect(visitorIPFromHeaders(headersOf({}))).toBe("");
  });
});
