// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { forwardOpsPost } from "./opsApi";
import { CSRF_HEADER, CSRF_VALUE } from "./opsSecurity";

const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;
const INTENT_KEY = "018f4f4c-53de-7c12-ae4d-fbbac8f735b2";
const PRODUCTION_ENV = {
  NODE_ENV: "production",
  OPS_API_ORIGIN: "https://internal-api.postwave.example",
  OPS_API_ALLOWED_HOSTS: "internal-api.postwave.example",
  OPS_PUBLIC_ORIGIN: "https://ops.postwave.example",
  OPS_RUNBOOK_BASE_URL: "https://runbooks.postwave.example/production/",
} satisfies NodeJS.ProcessEnv;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ops action proxy guards", () => {
  function stubProduction(): void {
    for (const [key, value] of Object.entries(PRODUCTION_ENV)) vi.stubEnv(key, value);
  }

  function request(body: string, extraHeaders: Record<string, string> = {}): Request {
    return new Request("https://ops.postwave.example/api/checks/billing/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `tracking=secret; pw_session=${SESSION}; internal=secret`,
        origin: PRODUCTION_ENV.OPS_PUBLIC_ORIGIN,
        [CSRF_HEADER]: CSRF_VALUE,
        ...extraHeaders,
      },
      body,
    });
  }

  const validBody = JSON.stringify({ idempotency_key: INTENT_KEY, input: "" });

  it("rejects a path-traversal check id before any config load or network call", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardOpsPost(request(validBody), "../../v1/subscribers", "action");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("bad_check_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request missing the CSRF header before reaching the API", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const noCsrf = new Request("https://ops.postwave.example/api/checks/billing/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `pw_session=${SESSION}`,
        origin: PRODUCTION_ENV.OPS_PUBLIC_ORIGIN,
      },
      body: validBody,
    });
    const response = await forwardOpsPost(noCsrf, "billing.dlq-depth", "action");
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a foreign origin even with the CSRF header present", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardOpsPost(
      request(validBody, { origin: "https://evil.example" }),
      "billing.dlq-depth",
      "action",
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_rejected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-JSON content type before reading the body", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardOpsPost(
      request(validBody, { "content-type": "text/plain" }),
      "billing.dlq-depth",
      "action",
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe("json_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the runtime config cannot load", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OPS_API_ORIGIN", "");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardOpsPost(request(validBody), "billing.dlq-depth", "action");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("ops_not_configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
