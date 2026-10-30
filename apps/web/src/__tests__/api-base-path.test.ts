// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("server API base path", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    [
      "root",
      "https://api.postwave.test",
      "https://api.postwave.test/api/v1/settings/sending?view=exact",
    ],
    [
      "path-prefixed",
      "https://api.postwave.test/gateway/",
      "https://api.postwave.test/gateway/api/v1/settings/sending?view=exact",
    ],
  ];

  it.each(cases)(
    "preserves the %s base without dropping or duplicating segments",
    async (_name, apiUrl, expected) => {
      vi.stubEnv("API_URL", apiUrl);
      const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
        Response.json({ ok: true }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { api } = await import("@/lib/api");

      await api.get("/api/v1/settings/sending", {
        query: { view: "exact" },
        maxAttempts: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(expected);
    },
  );

  it("uses the server-only development tenant for direct server requests", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("POSTWAVE_TENANT_SLUG", "server-demo");
    vi.stubEnv("NEXT_PUBLIC_TENANT_SLUG", "");
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_TENANT_SLUG", "");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("@/lib/api");
    await api.get("/api/v1/auth/whoami", { maxAttempts: 1 });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Tenant-Slug")).toBe("server-demo");
  });

  it("does not expose the server-only tenant on browser requests", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("POSTWAVE_TENANT_SLUG", "server-secret");
    vi.stubEnv("NEXT_PUBLIC_TENANT_SLUG", "");
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_TENANT_SLUG", "");
    vi.stubGlobal("window", {});
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("@/lib/api");
    await api.get("/api/v1/auth/whoami", { maxAttempts: 1 });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("X-Tenant-Slug")).toBe(false);
  });

  it("ignores every tenant escape hatch in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("POSTWAVE_TENANT_SLUG", "server-demo");
    vi.stubEnv("NEXT_PUBLIC_TENANT_SLUG", "public-demo");
    vi.stubEnv("NEXT_PUBLIC_POSTWAVE_TENANT_SLUG", "legacy-demo");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { api } = await import("@/lib/api");
    await api.get("/api/v1/auth/whoami", { maxAttempts: 1 });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("X-Tenant-Slug")).toBe(false);
  });
});
