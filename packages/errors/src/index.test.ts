import { describe, it, expect } from "vitest";

import {
  parseErrorEnvelope,
  formatErrorMessage,
  parseDenial,
  denialGuidance,
  denialRetryable,
  isDenialReason,
  DENIAL_REASONS,
} from "./index.js";

describe("parseErrorEnvelope", () => {
  it("parses the canonical nested envelope", () => {
    expect(
      parseErrorEnvelope({
        error: {
          code: "plan_limit_exceeded",
          message: "Over limit",
          request_id: "req_1",
        },
      }),
    ).toEqual({
      code: "plan_limit_exceeded",
      message: "Over limit",
      requestId: "req_1",
    });
  });

  it("parses a flat RFC-7807 body (detail + top-level request_id)", () => {
    expect(
      parseErrorEnvelope({
        detail: "Bad thing",
        request_id: "req_2",
        region: "eu",
      }),
    ).toEqual({ message: "Bad thing", requestId: "req_2", region: "eu" });
  });

  it("accepts camelCase requestId and header fallback", () => {
    expect(
      parseErrorEnvelope({ error: { message: "x", requestId: "req_c" } })
        .requestId,
    ).toBe("req_c");
    const headers = new Headers({ "x-request-id": "req_h" });
    expect(
      parseErrorEnvelope({ error: { message: "x" } }, headers).requestId,
    ).toBe("req_h");
  });

  it("coerces retry_after_seconds and normalizes field errors", () => {
    const out = parseErrorEnvelope({
      error: {
        code: "validation",
        message: "bad",
        retry_after_seconds: "30",
        fields: [
          { path: "email", message: "required" },
          { field: "name", message: "too long" },
          { path: "x" }, // dropped — no message
        ],
      },
    });
    expect(out.retryAfterSeconds).toBe(30);
    expect(out.fields).toEqual([
      { path: "email", message: "required" },
      { path: "name", message: "too long" },
    ]);
  });

  it("never throws on garbage", () => {
    expect(parseErrorEnvelope(null)).toEqual({});
    expect(parseErrorEnvelope("")).toEqual({});
    expect(parseErrorEnvelope(42)).toEqual({});
    expect(parseErrorEnvelope({ error: 5 })).toEqual({});
  });

  it("treats a plain string body as the message (proxy/timeout text)", () => {
    expect(parseErrorEnvelope("upstream timed out")).toEqual({
      message: "upstream timed out",
    });
  });

  it('treats `{error:"string"}` as the message', () => {
    expect(parseErrorEnvelope({ error: "boom" })).toEqual({ message: "boom" });
  });

  it("lifts unknown inner-error keys into `details` (framing fields excluded)", () => {
    const out = parseErrorEnvelope({
      error: {
        code: "send_time_opt_cold",
        message: "not enough opens",
        request_id: "req_d",
        min_opens: 50,
        window_days: 30,
      },
    });
    expect(out).toEqual({
      code: "send_time_opt_cold",
      message: "not enough opens",
      requestId: "req_d",
      details: { min_opens: 50, window_days: 30 },
    });
    // A nested error with only framing keys yields no `details`.
    expect(
      parseErrorEnvelope({ error: { message: "x" } }).details,
    ).toBeUndefined();
  });

  it("preserves request-bound top-level siblings of a nested error", () => {
    const out = parseErrorEnvelope({
      error: {
        code: "playground_fire_receipt_expired",
        message: "Private receipt expired.",
      },
      fire_id: "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e",
      state: "receipt_expired",
    });
    expect(out.details).toEqual({
      fire_id: "018f3f6a-5c6d-7a8b-9c0d-1e2f3a4b5c6e",
      state: "receipt_expired",
    });
  });
});

describe("denial vocabulary", () => {
  // The exact envelope `entitlement.Write` puts on the wire for the RBAC
  // chokepoint (internal/rbac/rbac.go) — the single most-hit denial in the API.
  const roleBody = {
    error: {
      subject: "campaigns.write",
      reason: "role",
      code: "insufficient_permission",
      message: "your role does not have the campaigns.write permission",
      required_role: "editor",
    },
  };

  it("parses the reason class out of the envelope", () => {
    const out = parseErrorEnvelope(roleBody);
    expect(out.denial).toEqual({
      reason: "role",
      code: "insufficient_permission",
      subject: "campaigns.write",
      requiredRole: "editor",
    });
  });

  it("parses a plan ceiling with its numbers and remedy", () => {
    // entitlement.PlanLimit(...) as emitted by limits.WriteExceeded.
    const out = parseErrorEnvelope({
      error: {
        subject: "plan.contacts",
        reason: "plan",
        code: "plan_limit_exceeded",
        message: "plan limit reached for contacts",
        resource: "contacts",
        tier: "studio",
        limit: 5000,
        current: 5000,
        remedy: "upgrade_plan",
      },
    });
    expect(out.denial).toEqual({
      reason: "plan",
      code: "plan_limit_exceeded",
      subject: "plan.contacts",
      resource: "contacts",
      tier: "studio",
      limit: 5000,
      current: 5000,
      remedy: "upgrade_plan",
    });
  });

  it("takes retry_after_seconds off the typed field, not `details`", () => {
    const out = parseErrorEnvelope({
      error: { reason: "quota", code: "rate_limited", retry_after_seconds: 90 },
    });
    expect(out.denial?.retryAfterSeconds).toBe(90);
  });

  it("drops a reason outside the closed vocabulary rather than passing it on", () => {
    // A client switches on this to pick an affordance; an unknown value would
    // fall through every arm to whatever the default happens to be.
    const out = parseErrorEnvelope({
      error: { reason: "vibes", code: "x", message: "no" },
    });
    expect(out.denial).toBeUndefined();
    // …but it stays visible in `details`, which is "everything else the server
    // sent" and must not silently lose keys.
    expect(out.details).toEqual({ reason: "vibes" });
    expect(isDenialReason("vibes")).toBe(false);
    for (const r of DENIAL_REASONS) expect(isDenialReason(r)).toBe(true);
  });

  it("leaves an ordinary error envelope with no denial", () => {
    expect(
      parseErrorEnvelope({ error: { code: "not_found", message: "gone" } })
        .denial,
    ).toBeUndefined();
  });

  it("names who can help on a role refusal, and never offers to sell", () => {
    const out = denialGuidance(
      "your role does not have the campaigns.write permission",
      parseErrorEnvelope(roleBody).denial,
    );
    expect(out).toContain("Ask a workspace editor");
    expect(out.toLowerCase()).not.toContain("upgrade");
  });

  it("offers the upgrade only when the server asserted that remedy", () => {
    expect(
      denialGuidance("over limit", { reason: "plan", remedy: "upgrade_plan" }),
    ).toContain("Upgrade your plan");
    // Top tier: entitlement.Write strips the remedy before it reaches the wire,
    // so a plan denial can arrive with nothing to buy — and must not invent one.
    expect(denialGuidance("over limit", { reason: "plan" })).toBe("over limit");
  });

  it("says when a quota window reopens, and only when the server said so", () => {
    expect(
      denialGuidance("too many requests", {
        reason: "quota",
        retryAfterSeconds: 90,
      }),
    ).toBe("too many requests Try again in 2 minutes.");
    expect(denialGuidance("too many requests", { reason: "quota" })).toBe(
      "too many requests",
    );
  });

  it("adds nothing it cannot substantiate", () => {
    for (const reason of ["flag", "policy", "runtime"]) {
      expect(denialGuidance("not available", { reason })).toBe("not available");
    }
    expect(denialGuidance("something failed", undefined)).toBe(
      "something failed",
    );
  });

  it("marks retryable exactly the reasons the server statuses as 'later'", () => {
    // Not a judgement call: `entitlement.Reason.httpStatus` maps quota→429 and
    // runtime→503, and 402/403 for the rest. A 503 from
    // `rbacresolve.writePermissionCheckFailedDenial` is the grant store being
    // unreadable — the server's own comment says the point of classifying it is
    // to let a client say "try again shortly".
    expect(denialRetryable({ reason: "quota" })).toBe(true);
    expect(denialRetryable({ reason: "runtime" })).toBe(true);
    for (const reason of ["plan", "role", "flag", "policy"] as const) {
      expect(denialRetryable({ reason })).toBe(false);
    }
    expect(denialRetryable(undefined)).toBe(false);
    // Every member of the closed vocabulary is decided above, so a new reason
    // cannot be added without someone stating whether waiting resolves it.
    expect(DENIAL_REASONS.length).toBe(6);
  });

  it("parseDenial reads the same shape from an already-normalized error", () => {
    expect(
      parseDenial({ details: { reason: "flag" }, code: "feature_disabled" }),
    ).toEqual({ reason: "flag", code: "feature_disabled" });
  });
});

describe("formatErrorMessage", () => {
  it("appends the request-id suffix", () => {
    expect(formatErrorMessage("Save failed", "req_9")).toBe(
      "Save failed (request req_9)",
    );
  });
  it("omits the suffix when there is no request id", () => {
    expect(formatErrorMessage("Save failed")).toBe("Save failed");
  });
  it("falls back on an empty message (truthy check, matching web/desktop)", () => {
    expect(formatErrorMessage("", undefined, "Oops")).toBe("Oops");
    expect(formatErrorMessage(undefined, "r1")).toBe(
      "Something went wrong (request r1)",
    );
    // A non-empty message passes through, matching `message || fallback`.
    expect(formatErrorMessage("boom", "r1")).toBe("boom (request r1)");
  });
});

describe("Retry-After header and case-insensitive header records", () => {
  it("reads Retry-After when the body carries no retry_after_seconds", () => {
    // 110 sites in apps/api set this header; only a handful also put the value
    // in the body. Commerce's WebhookInProgress is representative:
    //   w.Header().Set("Retry-After", "10")
    //   httperror.Write(w, 503, "webhook_in_progress", …)
    const e = parseErrorEnvelope(
      {
        error: { code: "webhook_in_progress", message: "Already processing." },
      },
      { "retry-after": "10" },
    );
    expect(e.retryAfterSeconds).toBe(10);
  });

  it("prefers the body value over the header", () => {
    // The body is written next to the decision; the header is the fallback.
    const e = parseErrorEnvelope(
      {
        error: {
          reason: "quota",
          message: "Slow down.",
          retry_after_seconds: 90,
        },
      },
      { "retry-after": "10" },
    );
    expect(e.retryAfterSeconds).toBe(90);
  });

  it("feeds the header value through to quota guidance", () => {
    // The point of reading it at all: denialGuidance's quota arm needs a
    // number, or the reader guesses between "a second" and "tomorrow".
    const e = parseErrorEnvelope(
      {
        error: {
          reason: "quota",
          code: "rate_limited",
          message: "Too many sends.",
        },
      },
      { "retry-after": "120" },
    );
    expect(e.denial?.retryAfterSeconds).toBe(120);
    expect(denialGuidance(e.message ?? "", e.denial)).toBe(
      "Too many sends. Try again in 2 minutes.",
    );
  });

  it.each([
    ["0", "a zero wait is not a wait"],
    ["-5", "a negative delta"],
    [
      "Wed, 21 Oct 2015 07:28:00 GMT",
      "an HTTP-date needs a clock this parser must not have",
    ],
    ["  ", "blank"],
    ["12abc", "trailing junk"],
  ])("ignores Retry-After %j (%s)", (value) => {
    const e = parseErrorEnvelope(
      { error: { message: "x" } },
      { "retry-after": value },
    );
    expect(e.retryAfterSeconds).toBeUndefined();
  });

  it("finds a header record key whatever its case", () => {
    // Node lowercases incoming headers, but a hand-built record or a client
    // that copies headers keeps `X-Request-Id`, and the suffix silently
    // vanished — leaving the user no id to quote in a support report.
    expect(parseErrorEnvelope({}, { "X-Request-Id": "req-2" }).requestId).toBe(
      "req-2",
    );
    expect(parseErrorEnvelope({}, { "x-request-id": "req-1" }).requestId).toBe(
      "req-1",
    );
    expect(parseErrorEnvelope({}, { "X-REQUEST-ID": "req-3" }).requestId).toBe(
      "req-3",
    );
    expect(
      parseErrorEnvelope({}, { "Retry-After": "45" }).retryAfterSeconds,
    ).toBe(45);
  });

  it("still prefers a body request id over the header", () => {
    // Guard the guard: a scan that matched everything would break precedence.
    const e = parseErrorEnvelope(
      { error: { request_id: "from-body" } },
      { "X-Request-Id": "from-header" },
    );
    expect(e.requestId).toBe("from-body");
  });

  it("keeps working with a real Headers object", () => {
    const e = parseErrorEnvelope(
      {},
      new Headers({ "X-Request-Id": "req-h", "Retry-After": "30" }),
    );
    expect(e.requestId).toBe("req-h");
    expect(e.retryAfterSeconds).toBe(30);
  });
});
