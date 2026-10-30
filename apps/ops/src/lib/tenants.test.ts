import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nextHeaders = vi.hoisted(() => ({ headers: vi.fn() }));

vi.mock("next/headers", () => ({ headers: nextHeaders.headers }));

import {
  fetchTenants,
  MAX_TENANT_ROWS,
  MAX_TENANT_SEARCH_LENGTH,
  MAX_TENANTS_RESPONSE_BYTES,
  parseTenantsResponse,
} from "./tenants";

const SESSION = `${"A".repeat(22)}.${"b".repeat(43)}`;

const tenant = {
  tenant_id: "018f4f4c-53de-7c12-ae4d-fbbac8f735b1",
  slug: "acme",
  name: "Acme",
  tier: "pro",
  current_period_end: "2026-08-01T00:00:00Z",
  dunning: false,
  sending_paused: false,
  health: "ok",
  created_at: "2026-07-01T12:30:00Z",
};

describe("parseTenantsResponse", () => {
  it("validates each row and the explicit truncation marker", () => {
    const result = parseTenantsResponse(200, {
      tenants: [tenant],
      truncated: false,
    });

    expect(result).toEqual({ ok: true, tenants: [tenant], truncated: false });
  });

  it("rejects unregistered fields instead of silently broadening the boundary", () => {
    expect(parseTenantsResponse(200, {
      tenants: [{ ...tenant, internal_debug: "must not cross the boundary" }],
      truncated: false,
    }).ok).toBe(false);
  });

  it.each([
    ["a non-object row", "tenant"],
    ["a missing slug", { ...tenant, slug: undefined }],
    ["a wrong boolean type", { ...tenant, dunning: "false" }],
    ["an unknown health", { ...tenant, health: "unknown" }],
    ["an inconsistent health", { ...tenant, dunning: true, health: "ok" }],
    ["an invalid created timestamp", { ...tenant, created_at: "yesterday" }],
    ["a non-RFC3339 timestamp", { ...tenant, created_at: "0" }],
    ["a null period end", { ...tenant, current_period_end: null }],
    ["control characters", { ...tenant, name: "Acme\nInjected" }],
    ["an oversized name", { ...tenant, name: "x".repeat(257) }],
  ])("rejects %s", (_label, candidate) => {
    expect(parseTenantsResponse(200, { tenants: [candidate], truncated: false })).toEqual({
      ok: false,
      message: "tenant directory returned an unexpected shape",
    });
  });

  it("rejects duplicate tenant IDs so rendering keys remain unambiguous", () => {
    expect(
      parseTenantsResponse(200, {
        tenants: [tenant, { ...tenant, slug: "acme-copy" }],
        truncated: false,
      }).ok,
    ).toBe(false);
  });

  it("rejects more rows than the API contract permits", () => {
    const tenants = Array.from({ length: MAX_TENANT_ROWS + 1 }, (_, index) => ({
      ...tenant,
      tenant_id: `tenant-${index}`,
      slug: `tenant-${index}`,
    }));

    expect(parseTenantsResponse(200, { tenants, truncated: true }).ok).toBe(false);
  });

  it.each([
    [401, "operator authentication is required"],
    [403, "operator access was denied"],
    [429, "the ops service rate limit was reached"],
    [500, "the tenant directory is unavailable"],
    [418, "the tenant directory request was rejected"],
  ])("normalizes HTTP %i without exposing an upstream body", (status, message) => {
    expect(parseTenantsResponse(status, { secret: "upstream detail" })).toEqual({
      ok: false,
      message,
    });
  });

  it("treats a malformed 200 body as a failure, not an empty directory", () => {
    expect(parseTenantsResponse(200, { nope: true }).ok).toBe(false);
  });
});

describe("fetchTenants", () => {
  beforeEach(() => {
    nextHeaders.headers.mockReset();
    nextHeaders.headers.mockResolvedValue(
      new Headers({
        cookie: `analytics=secret; pw_session=${SESSION}; csrf=secret`,
      }),
    );
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes search, requests the explicit row cap, and forwards only the session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ tenants: [tenant], truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTenants("  Acme  ")).resolves.toEqual({
      ok: true,
      tenants: [tenant],
      truncated: false,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [request, init] = fetchMock.mock.calls[0];
    const requestURL = new URL(String(request));
    expect(requestURL.pathname).toBe("/api/internal/ops/views/tenants");
    expect(requestURL.searchParams.get("search")).toBe("Acme");
    expect(requestURL.searchParams.get("limit")).toBe(String(MAX_TENANT_ROWS));
    expect(new Headers(init?.headers).get("cookie")).toBe(`pw_session=${SESSION}`);
    expect(init?.cache).toBe("no-store");
  });

  it("fails closed before networking when a search is too long", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTenants("x".repeat(MAX_TENANT_SEARCH_LENGTH + 1))).resolves.toEqual({
      ok: false,
      message: "the tenant search is invalid",
    });
    expect(nextHeaders.headers).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(fetchTenants("界".repeat(43))).resolves.toEqual({
      ok: false,
      message: "the tenant search is invalid",
    });
    await expect(fetchTenants("%".repeat(65))).resolves.toEqual({
      ok: false,
      message: "the tenant search is invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a success response whose declared body exceeds the byte budget", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ tenants: [tenant], truncated: false }), {
        status: 200,
        headers: {
          "content-length": String(MAX_TENANTS_RESPONSE_BYTES + 1),
          "content-type": "application/json",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchTenants()).resolves.toEqual({
      ok: false,
      message: "tenant directory returned invalid data",
    });
  });

  it("requires JSON media type on successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ tenants: [tenant], truncated: false }), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );

    await expect(fetchTenants()).resolves.toEqual({
      ok: false,
      message: "tenant directory returned invalid data",
    });
  });

  it("keeps the normalized status error when an error body is oversized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("forbidden", {
          status: 403,
          headers: { "content-length": String(MAX_TENANTS_RESPONSE_BYTES + 1) },
        }),
      ),
    );

    await expect(fetchTenants()).resolves.toEqual({
      ok: false,
      message: "operator access was denied",
    });
  });
});
