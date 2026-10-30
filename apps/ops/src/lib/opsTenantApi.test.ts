// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardKillSwitch, isTenantID, normalizeKillSwitch } from "./opsTenantApi";
import { CSRF_HEADER, CSRF_VALUE } from "./opsSecurity";

const TENANT_ID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b1";
const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;
const ENV = {
  NODE_ENV: "production",
  OPS_API_ORIGIN: "https://internal-api.postwave.example",
  OPS_API_ALLOWED_HOSTS: "internal-api.postwave.example",
  OPS_PUBLIC_ORIGIN: "https://ops.postwave.example",
  OPS_RUNBOOK_BASE_URL: "https://runbooks.postwave.example/production/",
} as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("isTenantID", () => {
  it("accepts a UUID", () => {
    expect(isTenantID(TENANT_ID)).toBe(true);
  });
  it("rejects a path-traversal id", () => {
    expect(isTenantID("../../v1/subscribers")).toBe(false);
    expect(isTenantID("not-a-uuid")).toBe(false);
    expect(isTenantID("")).toBe(false);
    expect(isTenantID("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isTenantID(TENANT_ID.toUpperCase())).toBe(false);
  });
});

describe("normalizeKillSwitch", () => {
  it("accepts the applied shape", () => {
    const n = normalizeKillSwitch({ tenant_id: TENANT_ID, paused: true, status: "applied" }, TENANT_ID, true);
    expect(n).toEqual({ tenant_id: TENANT_ID, paused: true, status: "applied" });
  });
  it("rejects a missing/unknown status", () => {
    expect(normalizeKillSwitch({ tenant_id: TENANT_ID, paused: true })).toBeUndefined();
    expect(normalizeKillSwitch({ tenant_id: TENANT_ID, paused: true, status: "queued" })).toBeUndefined();
  });
  it("rejects a non-boolean paused", () => {
    expect(normalizeKillSwitch({ tenant_id: TENANT_ID, paused: "yes", status: "applied" })).toBeUndefined();
  });
  it("rejects extra fields and a state that does not match the request", () => {
    expect(normalizeKillSwitch({ tenant_id: TENANT_ID, paused: true, status: "applied", secret: "x" })).toBeUndefined();
    expect(normalizeKillSwitch(
      { tenant_id: TENANT_ID, paused: false, status: "applied" },
      TENANT_ID,
      true,
    )).toBeUndefined();
  });
  it("rejects a non-object", () => {
    expect(normalizeKillSwitch(null)).toBeUndefined();
    expect(normalizeKillSwitch([1, 2])).toBeUndefined();
  });
});

describe("kill-switch proxy", () => {
  function request(
    body = JSON.stringify({ paused: true, reason: "spam complaint spike" }),
    extraHeaders: Record<string, string> = {},
  ): Request {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    return new Request(`https://ops.postwave.example/api/tenants/${TENANT_ID}/kill-switch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `tracking=x; pw_session=${SESSION}; internal=x`,
        origin: ENV.OPS_PUBLIC_ORIGIN,
        [CSRF_HEADER]: CSRF_VALUE,
        ...extraHeaders,
      },
      body,
    });
  }

  it("rejects a path-traversal tenant id before any upstream call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardKillSwitch(request(), "../evil");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("that is not a tenant id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards only the session cookie and returns the applied outcome", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ tenant_id: TENANT_ID, paused: true, status: "applied" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await forwardKillSwitch(request(), TENANT_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant_id: TENANT_ID,
      paused: true,
      status: "applied",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("cookie")).toBe(`pw_session=${SESSION}`);
    expect(forwarded.get("origin")).toBe(ENV.OPS_PUBLIC_ORIGIN);
  });

  it("bounds oversized incoming bodies before contacting the API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardKillSwitch(
      request("{}", { "content-length": String(21 * 1024) }),
      TENANT_ID,
    );
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request body that is not the exact kill-switch shape", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const nonBoolean = await forwardKillSwitch(
      request(JSON.stringify({ paused: "yes", reason: "spam complaint spike" })),
      TENANT_ID,
    );
    expect(nonBoolean.status).toBe(400);

    const extraField = await forwardKillSwitch(
      request(JSON.stringify({ paused: true, reason: "spam complaint spike", secret: "x" })),
      TENANT_ID,
    );
    expect(extraField.status).toBe(400);

    const missingReason = await forwardKillSwitch(
      request(JSON.stringify({ paused: true })),
      TENANT_ID,
    );
    expect(missingReason.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an upstream state that contradicts the requested pause", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ tenant_id: TENANT_ID, paused: false, status: "applied" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await forwardKillSwitch(request(), TENANT_ID);
    expect(response.status).toBe(502);
  });

  it("rejects a non-JSON request content type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardKillSwitch(
      request(JSON.stringify({ paused: true, reason: "spam complaint spike" }), {
        "content-type": "text/plain",
      }),
      TENANT_ID,
    );
    expect(response.status).toBe(415);
    expect(await response.text()).toContain("the request must be JSON");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an applied-shape upstream body served under a non-JSON media type", async () => {
    // The body is valid, correctly-shaped JSON — only the content-type is wrong.
    // Without the upstream media-type gate this would parse and normalize to a
    // 200, so asserting 502 isolates that gate rather than an incidental
    // JSON.parse throw (which an unparseable body would trigger either way).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ tenant_id: TENANT_ID, paused: true, status: "applied" }),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    );
    const response = await forwardKillSwitch(request(), TENANT_ID);
    expect(response.status).toBe(502);
  });

  it("reports an unreachable upstream as idempotent-safe rather than not-run", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const response = await forwardKillSwitch(request(), TENANT_ID);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("the kill switch is idempotent");
  });
});
