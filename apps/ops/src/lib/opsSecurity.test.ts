import { afterEach, describe, expect, it, vi } from "vitest";

import { loadOpsRuntimeConfig } from "./opsConfig";
import { forwardOpsPost } from "./opsApi";
import {
  BodyLimitError,
  CSRF_HEADER,
  CSRF_VALUE,
  forwardedClientHeaders,
  readBodyBounded,
  requestHasValidOrigin,
  resolveRunbookHref,
  sessionCookieOnly,
} from "./opsSecurity";

const SESSION = `${"a".repeat(22)}.${"b".repeat(43)}`;
const INTENT_KEY = "018f4f4c-53de-7c12-ae4d-fbbac8f735b2";
const RUN_ID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b3";
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

describe("ops runtime configuration", () => {
  it("fails closed when production origins are absent, insecure, or not allowlisted", () => {
    expect(() => loadOpsRuntimeConfig({ NODE_ENV: "production" })).toThrow(
      "OPS_API_ORIGIN is required",
    );
    expect(() =>
      loadOpsRuntimeConfig({
        ...PRODUCTION_ENV,
        OPS_API_ORIGIN: "http://internal-api.postwave.example",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      loadOpsRuntimeConfig({
        ...PRODUCTION_ENV,
        OPS_API_ALLOWED_HOSTS: "other.postwave.example",
      }),
    ).toThrow("not present");
    expect(() =>
      loadOpsRuntimeConfig({
        ...PRODUCTION_ENV,
        OPS_API_ORIGIN: "https://user:password@internal-api.postwave.example/path",
      }),
    ).toThrow("without credentials or a path");
  });

  it("accepts only the exact production API host", () => {
    expect(loadOpsRuntimeConfig(PRODUCTION_ENV)).toEqual({
      apiOrigin: "https://internal-api.postwave.example",
      publicOrigin: "https://ops.postwave.example",
      runbookBaseURL: "https://runbooks.postwave.example/production/",
      production: true,
    });
  });
});

describe("request boundaries", () => {
  it("forwards only a structurally valid pw_session cookie", () => {
    expect(sessionCookieOnly(`pw_ref=tracking; pw_session=${SESSION}; analytics=id`)).toBe(
      `pw_session=${SESSION}`,
    );
    expect(sessionCookieOnly("pw_session=attacker; secret=do-not-forward")).toBeUndefined();
    expect(sessionCookieOnly(`pw_session=${SESSION}; pw_session=${SESSION}`)).toBeUndefined();
    expect(sessionCookieOnly("secret=do-not-forward")).toBeUndefined();
  });

  it("relays the ingress forwarded chain so the API can still see the operator", () => {
    expect(
      forwardedClientHeaders(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.4" })),
    ).toEqual({ "x-forwarded-for": "203.0.113.7, 10.0.0.4" });
    expect(forwardedClientHeaders(new Headers({ "x-real-ip": "203.0.113.7" }))).toEqual({
      "x-forwarded-for": "203.0.113.7",
    });
    // Nothing to vouch for, and nothing we cannot vouch for.
    expect(forwardedClientHeaders(new Headers())).toEqual({});
    expect(forwardedClientHeaders(new Headers({ "x-forwarded-for": "unknown" }))).toEqual({});
    expect(
      forwardedClientHeaders(new Headers({ "x-forwarded-for": "203.0.113.7".repeat(80) })),
    ).toEqual({});
  });

  it("requires the same production origin and explicit CSRF header", () => {
    const config = loadOpsRuntimeConfig(PRODUCTION_ENV);
    const valid = new Request("https://ops.postwave.example/api/checks/a/action", {
      method: "POST",
      headers: { origin: config.publicOrigin, [CSRF_HEADER]: CSRF_VALUE },
    });
    expect(requestHasValidOrigin(valid, config)).toBe(true);
    expect(
      requestHasValidOrigin(
        new Request(valid.url, {
          method: "POST",
          headers: { origin: "https://evil.example", [CSRF_HEADER]: CSRF_VALUE },
        }),
        config,
      ),
    ).toBe(false);
  });

  it("stops streaming bodies at the byte limit", async () => {
    const response = new Response("x".repeat(33));
    await expect(readBodyBounded(response.body, 32)).rejects.toBeInstanceOf(BodyLimitError);
  });

  it("maps repository runbooks onto one trusted base and rejects hostile links", () => {
    const config = loadOpsRuntimeConfig(PRODUCTION_ENV);
    expect(resolveRunbookHref("docs/runbooks/common-failures.md", config)).toBe(
      "https://runbooks.postwave.example/production/common-failures.md",
    );
    expect(resolveRunbookHref("javascript:alert(1)", config)).toBeUndefined();
    expect(resolveRunbookHref("docs/runbooks/../secrets.md", config)).toBeUndefined();
    expect(
      resolveRunbookHref("https://runbooks.postwave.example/production-safe/evil", config),
    ).toBeUndefined();
    expect(resolveRunbookHref("https://evil.example/production/incident", config)).toBeUndefined();
  });
});

describe("ops action proxy", () => {
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

  it("bounds incoming bodies before contacting the API", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await forwardOpsPost(
      request("{}", { "content-length": String(21 * 1024) }),
      "billing.dlq-depth",
      "action",
    );
    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries the operator's address upstream so the IP allowlist stays a factor", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ run_id: RUN_ID, status: "succeeded" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "" }), {
        "x-forwarded-for": "203.0.113.7, 10.0.0.4",
      }),
      "billing.dlq-depth",
      "action",
    );
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["x-forwarded-for"]).toBe(
      "203.0.113.7, 10.0.0.4",
    );
  });

  it("does not leak upstream errors, URLs, or unrelated cookies", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "db_internal",
            message: "postgres://admin:secret@db.internal/private",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "" })),
      "billing.dlq-depth",
      "action",
    );
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain("ops service is unavailable");
    expect(text).not.toContain("postgres");
    expect(text).not.toContain("secret");

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).cookie).toBe(`pw_session=${SESSION}`);
    expect((init?.headers as Record<string, string>).origin).toBe(
      PRODUCTION_ENV.OPS_PUBLIC_ORIGIN,
    );
  });

  it("requires the exact successful action response and exposes only UI fields", async () => {
    stubProduction();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: RUN_ID,
          status: "succeeded",
          result: "replayed one row",
          replayed: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "" })),
      "billing.dlq-depth",
      "action",
    );
    expect(await response.json()).toEqual({
      status: "succeeded",
      result: "replayed one row",
      replayed: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves a truthful in-flight idempotent replay", async () => {
    stubProduction();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: RUN_ID,
          status: "running",
          result: "",
          replayed: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const response = await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "" })),
      "billing.dlq-depth",
      "action",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "running",
      result: "",
      replayed: true,
    });
  });

  it("rejects unknown request and upstream response fields", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: RUN_ID,
          status: "succeeded",
          result: "done",
          replayed: false,
          internal_debug: "must not cross the boundary",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const badRequest = await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "", extra: true })),
      "billing.dlq-depth",
      "action",
    );
    expect(badRequest.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const badResponse = await forwardOpsPost(
      request(JSON.stringify({ idempotency_key: INTENT_KEY, input: "" })),
      "billing.dlq-depth",
      "action",
    );
    expect(badResponse.status).toBe(502);
  });
});

describe("ops snooze proxy", () => {
  function stubProduction(): void {
    for (const [key, value] of Object.entries(PRODUCTION_ENV)) vi.stubEnv(key, value);
  }

  function request(reason = "vendor incident"): Request {
    return new Request("https://ops.postwave.example/api/checks/billing/snooze", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `pw_session=${SESSION}`,
        origin: PRODUCTION_ENV.OPS_PUBLIC_ORIGIN,
        [CSRF_HEADER]: CSRF_VALUE,
      },
      body: JSON.stringify({ idempotency_key: INTENT_KEY, duration: "24h", reason }),
    });
  }

  it("forwards the payload-bound key and accepts only an exact succeeded outcome", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: RUN_ID,
          status: "succeeded",
          result: "2026-07-17T02:00:00Z",
          snoozed_until: "2026-07-17T02:00:00Z",
          replayed: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const response = await forwardOpsPost(request(), "billing.dlq-depth", "snooze");
    expect(await response.json()).toEqual({
      run_id: RUN_ID,
      status: "succeeded",
      result: "2026-07-17T02:00:00Z",
      snoozed_until: "2026-07-17T02:00:00Z",
      replayed: true,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: INTENT_KEY,
      duration: "24h",
      reason: "vendor incident",
    });
  });

  it("preserves running and failed replays without inventing an expiry", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run_id: RUN_ID,
            status: "running",
            result: "",
            snoozed_until: null,
            replayed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            run_id: RUN_ID,
            status: "failed",
            result: "could not persist the snooze",
            snoozed_until: null,
            replayed: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const running = await forwardOpsPost(request(), "billing.dlq-depth", "snooze");
    expect(await running.json()).toMatchObject({ status: "running", snoozed_until: null });
    const failed = await forwardOpsPost(request(), "billing.dlq-depth", "snooze");
    expect(await failed.json()).toMatchObject({ status: "failed", snoozed_until: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects requests without a canonical key and contradictory upstream outcomes", async () => {
    stubProduction();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          run_id: RUN_ID,
          status: "running",
          result: "",
          snoozed_until: "2026-07-17T02:00:00Z",
          replayed: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const missingKey = new Request(request().url, {
      method: "POST",
      headers: request().headers,
      body: JSON.stringify({ duration: "24h", reason: "vendor incident" }),
    });
    const badRequest = await forwardOpsPost(missingKey, "billing.dlq-depth", "snooze");
    expect(badRequest.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const badResponse = await forwardOpsPost(request(), "billing.dlq-depth", "snooze");
    expect(badResponse.status).toBe(502);
  });

  it("reports an unreachable upstream as ambiguous rather than as not-run", async () => {
    stubProduction();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const response = await forwardOpsPost(request(), "billing.dlq-depth", "snooze");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("retry with the same idempotency key");
  });
});
