// SPDX-License-Identifier: AGPL-3.0-only
//
// A denial must offer the affordance that actually resolves it.
//
// `internal/entitlement` exists because "your plan does not include this" and
// "your role does not permit this" need different answers, and a client holding
// only a message string cannot tell them apart — which is how a paywall gets
// shown to someone who needs an admin to change their role.
//
// Until now no client read `reason` at all: a repo-wide grep for
// `reason === "plan"` hit exactly one desktop test file. The vocabulary was on
// the wire and nothing consumed it, so the contract's headline claim had never
// reached a user.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
}));

import { api, ApiError, denialGuidance } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer the next request with `body` and `status`. */
function respondWith(body: unknown, status: number, headers: HeadersInit = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        }),
    ),
  );
}

describe("denial guidance", () => {
  it("tells a role-denied user who can help, not to buy something", () => {
    const out = denialGuidance("your role does not have the campaigns.write permission", {
      reason: "role",
      requiredRole: "editor",
    });
    expect(out).toContain("editor");
    expect(out.toLowerCase()).not.toContain("upgrade");
  });

  it("falls back to asking an administrator when no role is named", () => {
    const out = denialGuidance("forbidden", { reason: "role" });
    expect(out.toLowerCase()).toContain("administrator");
    expect(out.toLowerCase()).not.toContain("upgrade");
  });

  it("offers the upgrade only when the server asserted that remedy", () => {
    expect(
      denialGuidance("monthly sends exhausted", { reason: "plan", remedy: "upgrade_plan" }),
    ).toContain("Upgrade your plan");

    // A plan-class denial the server did NOT attach an upgrade remedy to — the
    // top tier, or a ceiling no plan raises. Offering an upgrade here points at
    // a button that cannot help.
    expect(
      denialGuidance("monthly sends exhausted", { reason: "plan" }),
    ).not.toContain("Upgrade your plan");
  });

  it("names the workspace admin for an allowance only they can raise", () => {
    const out = denialGuidance("monthly render-preview quota exhausted", {
      reason: "plan",
      remedy: "contact_workspace_admin",
    });
    expect(out.toLowerCase()).toContain("administrator");
    expect(out).not.toContain("Upgrade your plan");
  });

  it("adds nothing it cannot substantiate", () => {
    // flag and policy denials resolve through neither money nor permissions.
    // Inventing an action would be worse than offering none.
    for (const reason of ["flag", "policy", "runtime"]) {
      expect(denialGuidance("not available", { reason })).toBe("not available");
    }
    expect(denialGuidance("something failed", {})).toBe("something failed");
  });

  it("says when a quota window reopens — the one refusal waiting resolves", () => {
    // ReasonQuota is the only class where retrying works, and the server sends
    // the number. Web carried `retryAfterSeconds` on ApiError but never said it,
    // so a rate-limited user was left choosing between "a second" and "tomorrow".
    expect(
      denialGuidance("too many exports", { reason: "quota", retryAfterSeconds: 45 }),
    ).toBe("too many exports Try again in 45 seconds.");
    expect(denialGuidance("too many exports", { reason: "quota" })).toBe(
      "too many exports",
    );
  });
});

describe("ApiError carries the denial class, not only the sentence", () => {
  // A screen that wants to render an affordance (upgrade link, "ask <role>",
  // a countdown) needs the class. Desktop's `ApiErr.error.denial` and mobile's
  // `AIApiError.denial` are the same object, so one branch means one thing
  // everywhere.
  it("exposes a parsed denial for a known reason", () => {
    const err = new ApiError("forbidden", 403, undefined, {
      code: "insufficient_permission",
      reason: "role",
      requiredRole: "editor",
    });
    expect(err.denial).toEqual({
      reason: "role",
      code: "insufficient_permission",
      requiredRole: "editor",
    });
    expect(err.message).toContain("Ask a workspace editor");
  });

  it("leaves it unset for an ordinary error and for a reason it does not know", () => {
    expect(new ApiError("gone", 404, undefined, { code: "not_found" }).denial).toBeUndefined();
    expect(
      new ApiError("no", 403, undefined, { code: "x", reason: "vibes" }).denial,
    ).toBeUndefined();
  });
});

describe("the whole denial survives the transport, not a subset of it", () => {
  // The three loose fields (`reason`, `remedy`, `requiredRole`) are enough to
  // pick a SENTENCE, which is why flattening the parsed denial into them looked
  // fine. They are not enough to render an AFFORDANCE: `subject`, `tier`,
  // `resource`, `limit` and `current` are what a plan-ceiling screen shows, the
  // server already sent them, and web dropped them between the parser and
  // `ApiError` — while claiming in the same file that its `denial` was the same
  // object desktop and mobile carry. Asserted end-to-end through `api.get`,
  // because a constructor-only test cannot see a transport that never passed
  // them on.

  it("carries a plan ceiling's numbers, tier and subject", async () => {
    // entitlement.PlanLimit as written by limits.WriteExceeded.
    respondWith(
      {
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
      },
      402,
    );

    const err = await api.post("/api/v1/subscribers", {}).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.denial).toEqual({
      reason: "plan",
      code: "plan_limit_exceeded",
      subject: "plan.contacts",
      resource: "contacts",
      tier: "studio",
      limit: 5000,
      current: 5000,
      remedy: "upgrade_plan",
    });
    expect(err?.message).toContain("Upgrade your plan");
  });

  it("carries the role a refusal names, from the RBAC chokepoint's own body", async () => {
    // Byte-for-byte internal/rbac/rbac.go.
    respondWith(
      {
        error: {
          subject: "campaigns.write",
          reason: "role",
          code: "insufficient_permission",
          message: "your role does not have the campaigns.write permission",
          required_role: "editor",
        },
      },
      403,
    );

    const err = await api.post("/api/v1/campaigns", {}).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.denial).toEqual({
      reason: "role",
      code: "insufficient_permission",
      subject: "campaigns.write",
      requiredRole: "editor",
    });
    expect(err?.message).toContain("Ask a workspace editor");
    expect(err?.message.toLowerCase()).not.toContain("upgrade");
  });

  it("merges a Retry-After header the body did not carry", async () => {
    // The server mirrors `retry_after_seconds` INTO the header, and a proxy can
    // strip either half. Desktop's errorFromResponse does the same merge; a
    // denial that reaches one surface with a countdown and the other without is
    // the drift this contract exists to stop.
    respondWith(
      { error: { reason: "quota", code: "rate_limited", message: "too many exports" } },
      429,
      { "retry-after": "120" },
    );

    // `maxAttempts: 1` because httpFetch's own 429 handling would otherwise
    // sleep for the Retry-After it just read. That backoff is correct transport
    // behaviour; this test is about what the ERROR carries once retries are
    // exhausted, which is the state a user is shown.
    const err = await api.get("/api/v1/subscribers", { maxAttempts: 1 }).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.denial?.retryAfterSeconds).toBe(120);
    expect(err?.message).toContain("Try again in 2 minutes");
  });

  it("does not overwrite a retry-after the body did carry", async () => {
    respondWith(
      {
        error: {
          reason: "quota",
          code: "rate_limited",
          message: "too many exports",
          retry_after_seconds: 45,
        },
      },
      429,
      { "retry-after": "999" },
    );

    const err = await api.get("/api/v1/subscribers", { maxAttempts: 1 }).then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.denial?.retryAfterSeconds).toBe(45);
  });

  it("leaves an ordinary refusal-shaped error with no denial", async () => {
    respondWith({ error: { code: "not_found", message: "gone" } }, 404);
    const err = await api.get("/api/v1/subscribers/missing").then(
      () => null,
      (e: unknown) => e as ApiError,
    );
    expect(err?.denial).toBeUndefined();
    expect(err?.message).toBe("gone");
  });
});
