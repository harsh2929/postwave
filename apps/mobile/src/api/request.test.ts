import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "./apiRequestError";
import { getClient } from "./sdkClient";

vi.mock("./sdkClient", () => ({ getClient: vi.fn() }));

// eslint-disable-next-line import/first
import { checkedApiResult, rawRequest, type AIApiResult } from "./request";

describe("rawRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps auth-state races from getClient in the result envelope", async () => {
    vi.mocked(getClient).mockImplementation(() => {
      throw new Error("PostwaveClient requested without credentials");
    });

    await expect(rawRequest("GET", "/api/v1/example")).resolves.toEqual({
      data: null,
      error: {
        status: 0,
        message: "PostwaveClient requested without credentials",
      },
    });
  });

  it("returns successful SDK responses unchanged", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    vi.mocked(getClient).mockReturnValue({
      client: { request },
    } as never);

    await expect(
      rawRequest(
        "PATCH",
        "/api/v1/example",
        { enabled: true },
        {
          idempotencyKey: "operation-00000001",
          headers: { "If-Match": "7" },
        },
      ),
    ).resolves.toEqual({
      data: { ok: true },
      error: null,
    });
    expect(request).toHaveBeenCalledWith("PATCH", "/api/v1/example", {
      body: { enabled: true },
      idempotencyKey: "operation-00000001",
      headers: { "If-Match": "7" },
    });
  });

  it("forwards an AbortSignal so an identity retirement cancels the HTTP request", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);
    const controller = new AbortController();

    await rawRequest("GET", "/api/v1/sms/conversations", undefined, {
      signal: controller.signal,
    });

    expect(request).toHaveBeenCalledWith("GET", "/api/v1/sms/conversations", {
      signal: controller.signal,
    });
  });

  it("turns error envelopes into status-bearing mutation rejections", async () => {
    const promise = Promise.resolve({
      data: null,
      error: { status: 409, message: "conflict" },
    } as const);

    await expect(checkedApiResult(promise)).rejects.toMatchObject({
      message: "conflict",
      status: 409,
    });
  });

  it("captures the server request_id from a PostwaveError (was dropped)", async () => {
    // The SDK's PostwaveError carries .requestId; mobile used to discard it.
    const request = vi.fn(async () => {
      throw Object.assign(new Error("boom"), {
        status: 500,
        requestId: "req_abc123",
      });
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    await expect(rawRequest("GET", "/api/v1/x")).resolves.toEqual({
      data: null,
      error: { status: 500, message: "boom", requestId: "req_abc123" },
    });
  });

  it("propagates requestId onto the thrown mutation error", async () => {
    const promise = Promise.resolve({
      data: null,
      error: { status: 500, message: "boom", requestId: "req_xyz" },
    } as const);

    await expect(checkedApiResult(promise)).rejects.toMatchObject({
      message: "boom",
      status: 500,
      requestId: "req_xyz",
    });
  });

  it("carries the runtimecapability 503 envelope into the result", async () => {
    // Byte-for-byte what runtimecapability.WriteUnavailable encodes; the SDK
    // hands the decoded body over as PostwaveError.payload.
    const body = {
      error: {
        code: "flow_runtime_unavailable",
        message: "Flow execution is disabled.",
        capability: "flow_runtime",
        runtime_status: "unavailable",
        retryable: false,
      },
    };
    const request = vi.fn(async () => {
      throw Object.assign(new Error("Flow execution is disabled."), {
        status: 503,
        code: "flow_runtime_unavailable",
        payload: body,
      });
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    await expect(
      rawRequest("POST", "/api/v1/flow-builder/flows/1/activate"),
    ).resolves.toEqual({
      data: null,
      error: {
        status: 503,
        message: "Flow execution is disabled.",
        code: "flow_runtime_unavailable",
        capability: "flow_runtime",
        runtimeStatus: "unavailable",
        retryable: false,
        // The shared parser lifts every non-framing key of the envelope into
        // `details` -- its contract is "everything the server sent beyond the
        // framing set", and web and desktop already receive exactly this for
        // the same bytes. The typed capability/runtimeStatus/retryable above
        // remain the branch points; `details` is the raw evidence beside them.
        details: {
          capability: "flow_runtime",
          runtime_status: "unavailable",
          retryable: false,
        },
        // The decoded body is carried through as well. A handful of endpoints
        // answer a non-2xx whose body IS the result rather than an error
        // envelope — POST /api/v1/flow-builder/validate returns 422 with the
        // full report precisely when a graph has errors — so a client that
        // only saw the status could report every outcome except the one worth
        // reporting.
        payload: body,
      },
    });
  });

  it("leaves an ordinary 503 free of capability fields", async () => {
    const body = { error: { code: "bad_gateway", message: "upstream down" } };
    const request = vi.fn(async () => {
      throw Object.assign(new Error("upstream down"), {
        status: 503,
        payload: body,
      });
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    // `code` comes off the SDK error's own `.code`, not the body, so this
    // fixture (payload only) legitimately produces no code — the point of the
    // assertion is that NO capability fields appear.
    await expect(rawRequest("GET", "/api/v1/x")).resolves.toEqual({
      data: null,
      error: { status: 503, message: "upstream down", payload: body },
    });
  });

  it("omits `payload` entirely when the SDK error carried no body", async () => {
    // exactOptionalPropertyTypes: an explicit `undefined` would leave the key
    // defined-but-empty, which reads as "there WAS a body" to any `in` check.
    const request = vi.fn(async () => {
      throw Object.assign(new Error("network down"), { status: 0 });
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    const result = await rawRequest("GET", "/api/v1/x");
    expect(result.error && "payload" in result.error).toBe(false);
  });

  it("carries the entitlement denial class into the result", async () => {
    // Byte-for-byte what internal/rbac/rbac.go writes at the permission
    // chokepoint. Mobile used to keep only `status: 403` + `code`, so this and
    // a feature-flag block and a compliance block were indistinguishable.
    const body = {
      error: {
        subject: "campaigns.write",
        reason: "role",
        code: "insufficient_permission",
        message: "your role does not have the campaigns.write permission",
        required_role: "editor",
      },
    };
    const request = vi.fn(async () => {
      throw Object.assign(
        new Error("your role does not have the campaigns.write permission"),
        { status: 403, code: "insufficient_permission", payload: body },
      );
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    const result = await rawRequest("POST", "/api/v1/campaigns");
    expect(result.error?.denial).toEqual({
      reason: "role",
      code: "insufficient_permission",
      subject: "campaigns.write",
      requiredRole: "editor",
    });
  });

  it("leaves an ordinary error free of a denial", async () => {
    const body = { error: { code: "not_found", message: "gone" } };
    const request = vi.fn(async () => {
      throw Object.assign(new Error("gone"), {
        status: 404,
        code: "not_found",
        payload: body,
      });
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);

    const result = await rawRequest("GET", "/api/v1/x");
    // exactOptionalPropertyTypes: the key must be ABSENT, not present-and-undefined.
    expect(result.error && "denial" in result.error).toBe(false);
  });

  it("re-tags the denial onto a thrown mutation error", async () => {
    // A mutation is where the distinction costs most: "ask an editor", "upgrade"
    // and "wait 2 minutes" are three different next steps for someone who just
    // tried to send something.
    const promise = Promise.resolve({
      data: null,
      error: {
        status: 402,
        message: "plan limit reached",
        denial: {
          reason: "plan",
          code: "plan_limit_exceeded",
          remedy: "upgrade_plan",
        },
      },
    } as const);

    await expect(checkedApiResult(promise)).rejects.toMatchObject({
      status: 402,
      denial: { reason: "plan", remedy: "upgrade_plan" },
    });
  });

  it("re-tags the capability envelope onto a thrown mutation error", async () => {
    const promise = Promise.resolve({
      data: null,
      error: {
        status: 503,
        message: "off",
        capability: "flow_runtime",
        runtimeStatus: "unavailable",
        retryable: false,
      },
    } as const);

    await expect(checkedApiResult(promise)).rejects.toMatchObject({
      status: 503,
      capability: "flow_runtime",
      runtimeStatus: "unavailable",
      retryable: false,
    });
  });
});

// PARITY PIN. The rejection's own keys are a contract: errorCopy, onError
// handlers and Sentry read them, and `in` / hasOwnProperty checks treat a
// present-but-undefined key as "the envelope declared this". These pin exactly
// which keys checkedApiResult sets, so moving the tagging into a shared class
// cannot add, drop or blank one.
describe("checkedApiResult rejection shape", () => {
  const reject = async (
    error: Record<string, unknown>,
  ): Promise<Error & Record<string, unknown>> => {
    try {
      await checkedApiResult(
        Promise.resolve({ data: null, error } as unknown as AIApiResult<null>),
      );
    } catch (e) {
      return e as Error & Record<string, unknown>;
    }
    throw new Error("checkedApiResult resolved an error envelope");
  };

  it("re-tags every envelope field it carries, and nothing it does not", async () => {
    const denial = { reason: "plan", code: "plan_limit_exceeded", remedy: "upgrade_plan" };
    const err = await reject({
      status: 503,
      message: "full",
      requestId: "req_1",
      code: "some_code",
      capability: "flow_runtime",
      runtimeStatus: "unavailable",
      retryable: false,
      denial,
      payload: { error: { code: "some_code" } },
      fields: [{ path: "email", message: "is required" }],
      retryAfterSeconds: 0,
      details: { fire_id: "f1" },
      region: "eu",
      correctEndpoint: "https://eu.example.com",
      responseMetadata: { sendingCapOutcome: "committed" },
    });
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.message).toBe("full");
    expect(err).toMatchObject({
      status: 503,
      requestId: "req_1",
      code: "some_code",
      capability: "flow_runtime",
      runtimeStatus: "unavailable",
      retryable: false,
      denial,
      fields: [{ path: "email", message: "is required" }],
      retryAfterSeconds: 0,
      details: { fire_id: "f1" },
      responseMetadata: { sendingCapOutcome: "committed" },
    });
    // payload, region and correctEndpoint are result-envelope only.
    expect(Object.keys(err).sort()).toEqual(
      [
        "capability",
        "code",
        "denial",
        "details",
        "fields",
        "requestId",
        "responseMetadata",
        "retryAfterSeconds",
        "retryable",
        "runtimeStatus",
        "status",
      ].sort(),
    );
  });

  it("sets only `status` on a bare envelope, and stays a plain Error", async () => {
    const err = await reject({ status: 409, message: "conflict" });
    expect(Object.keys(err)).toEqual(["status"]);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("conflict");
  });

  it("sets `retryable` and `runtimeStatus` only inside the capability envelope", async () => {
    // retryAgencyRead reads `retryable` outside the envelope; checkedApiResult
    // never has, and a shared tagger must not start.
    const noCapability = await reject({
      status: 0,
      message: "unreadable",
      code: "invalid_agency_response",
      retryable: false,
    });
    expect(Object.keys(noCapability).sort()).toEqual(["code", "status"]);
    expect(noCapability).not.toHaveProperty("retryable");

    const noRuntimeStatus = await reject({
      status: 503,
      message: "off",
      capability: "flow_runtime",
      retryable: false,
    });
    expect(Object.keys(noRuntimeStatus).sort()).toEqual(
      ["capability", "retryable", "status"].sort(),
    );
  });
});

describe("shared envelope parsing (@postwave/errors)", () => {
  // Mobile was the one surface not normalising through parseErrorEnvelope, so
  // it recovered a strict subset of what web and desktop did from the same
  // bytes. Every case below is a value that used to be dropped on the floor.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function failWith(extra: Record<string, unknown>) {
    const request = vi.fn(async () => {
      throw Object.assign(new Error("failed"), extra);
    });
    vi.mocked(getClient).mockReturnValue({ client: { request } } as never);
  }

  it("recovers per-field validation errors from the envelope body", async () => {
    failWith({
      status: 422,
      code: "validation_failed",
      payload: {
        error: {
          code: "validation_failed",
          message: "failed",
          fields: [{ path: "email", message: "is required" }],
        },
      },
    });
    const res = await rawRequest("POST", "/api/v1/subscribers");
    expect(res.error?.fields).toEqual([
      { path: "email", message: "is required" },
    ]);
  });

  it("prefers the SDK's typed fields when it already parsed them", async () => {
    failWith({
      status: 422,
      code: "validation_failed",
      fields: [{ path: "name", message: "too long" }],
      payload: { error: { code: "validation_failed", message: "failed" } },
    });
    const res = await rawRequest("POST", "/api/v1/lists");
    expect(res.error?.fields).toEqual([{ path: "name", message: "too long" }]);
  });

  it("recovers retry_after_seconds from the body, and lets the SDK's header-derived value win", async () => {
    failWith({
      status: 429,
      code: "rate_limited",
      payload: {
        error: {
          code: "rate_limited",
          message: "slow down",
          retry_after_seconds: 30,
        },
      },
    });
    expect(
      (await rawRequest("GET", "/api/v1/x")).error?.retryAfterSeconds,
    ).toBe(30);

    failWith({
      status: 429,
      code: "rate_limited",
      retryAfterSeconds: 7, // RateLimitError: from the Retry-After HEADER
      payload: {
        error: {
          code: "rate_limited",
          message: "slow down",
          retry_after_seconds: 30,
        },
      },
    });
    expect(
      (await rawRequest("GET", "/api/v1/x")).error?.retryAfterSeconds,
    ).toBe(7);
  });

  it("lifts server context beside the frame into details", async () => {
    failWith({
      status: 409,
      code: "fire_conflict",
      payload: {
        error: {
          code: "fire_conflict",
          message: "already fired",
          fire_id: "f-9",
          state: "sent",
        },
      },
    });
    const res = await rawRequest("POST", "/api/v1/fire");
    expect(res.error?.details).toEqual({ fire_id: "f-9", state: "sent" });
  });

  it("retains only a recognized SDK sending-cap outcome proof", async () => {
    failWith({
      status: 503,
      code: "sending_cap_convergence_pending",
      responseMetadata: {
        sendingCapOutcome: "committed-conservatively-fenced",
      },
    });
    expect(
      (await rawRequest("POST", "/api/v1/deliverability/hub/repair-override"))
        .error?.responseMetadata,
    ).toEqual({ sendingCapOutcome: "committed-conservatively-fenced" });

    failWith({
      status: 503,
      code: "sending_cap_convergence_pending",
      responseMetadata: { sendingCapOutcome: "success-ish" },
    });
    expect(
      (await rawRequest("POST", "/api/v1/deliverability/hub/repair-override"))
        .error,
    ).not.toHaveProperty("responseMetadata");
  });

  it("adds none of the new keys when the error carried nothing to add", async () => {
    // exactOptionalPropertyTypes: an explicit `undefined` would be a different
    // (and wrong) envelope, so the keys must be absent, not present-and-empty.
    failWith({
      status: 500,
      code: "internal_error",
      payload: { error: { code: "internal_error", message: "x" } },
    });
    const res = await rawRequest("GET", "/api/v1/x");
    expect(res.error).toEqual({
      status: 500,
      message: "failed",
      code: "internal_error",
      payload: { error: { code: "internal_error", message: "x" } },
    });
  });

  it("re-tags fields and retryAfterSeconds onto the thrown mutation error", async () => {
    const promise: Promise<AIApiResult<null>> = Promise.resolve({
      data: null,
      error: {
        status: 422,
        message: "failed",
        fields: [{ path: "email", message: "is required" }],
        retryAfterSeconds: 12,
      },
    });
    await expect(checkedApiResult(promise)).rejects.toMatchObject({
      status: 422,
      fields: [{ path: "email", message: "is required" }],
      retryAfterSeconds: 12,
    });
  });
});
