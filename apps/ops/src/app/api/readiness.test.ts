// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as health } from "./health/route";
import { GET as ready } from "./ready/route";

const PRODUCTION_ENV = {
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

describe("ops health contracts", () => {
  it("keeps liveness independent of upstream dependencies", async () => {
    const response = health();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports ready only after the configuration and API readiness pass", async () => {
    for (const [key, value] of Object.entries(PRODUCTION_ENV)) {
      vi.stubEnv(key, value);
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"status":"ready"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await ready();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://internal-api.postwave.example/api/ready");
    expect(init?.headers).toEqual({ accept: "application/json" });
    expect(init?.credentials).toBeUndefined();
    expect(init?.redirect).toBe("error");
  });

  it("fails closed without leaking configuration or upstream failures", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const missingConfig = await ready();
    expect(missingConfig.status).toBe(503);
    expect(await missingConfig.json()).toEqual({ status: "unavailable" });

    for (const [key, value] of Object.entries(PRODUCTION_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret", { status: 503 }));
    const upstreamFailure = await ready();
    expect(upstreamFailure.status).toBe(503);
    const body = await upstreamFailure.text();
    expect(body).not.toContain("secret");
    expect(body).not.toContain("internal-api");
  });

  it("rejects a non-JSON or broadened readiness response", async () => {
    for (const [key, value] of Object.entries(PRODUCTION_ENV)) {
      vi.stubEnv(key, value);
    }
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"status":"ready","internal":"leak"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    expect((await ready()).status).toBe(503);

    fetchMock.mockResolvedValue(
      new Response('{"status":"ready"}', {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    expect((await ready()).status).toBe(503);
  });
});
