import { describe, expect, it } from "vitest";

import { errorPresentation, statusOf } from "./errorCopy";
import { WireShapeError } from "./wireShapeError";

const withStatus = (status: number) =>
  Object.assign(new Error("raw server text"), { status });

describe("statusOf", () => {
  it("reads the SDK error's status", () => {
    expect(statusOf(withStatus(403))).toBe(403);
  });

  it("falls back to 0 for plain errors and junk", () => {
    expect(statusOf(new Error("x"))).toBe(0);
    expect(statusOf(null)).toBe(0);
    expect(statusOf({ status: "403" })).toBe(0);
  });
});

describe("errorPresentation", () => {
  it("hides the retry button on verdicts a retry cannot change", () => {
    for (const status of [401, 403, 404]) {
      expect(errorPresentation(withStatus(status)).retryable).toBe(false);
    }
  });

  it("keeps the retry button for transient failures", () => {
    for (const status of [429, 500, 503, 0]) {
      expect(errorPresentation(withStatus(status)).retryable).toBe(true);
    }
  });

  it("distinguishes permission, expiry, missing and rate limit", () => {
    expect(errorPresentation(withStatus(401)).message).toMatch(/expired/iu);
    expect(errorPresentation(withStatus(403)).message).toMatch(/access/iu);
    expect(errorPresentation(withStatus(404)).message).toMatch(/no longer/iu);
    expect(errorPresentation(withStatus(429)).message).toMatch(/too many/iu);
  });

  it("never echoes the raw server message", () => {
    for (const status of [401, 403, 404, 429, 500, 0]) {
      expect(errorPresentation(withStatus(status)).message).not.toContain(
        "raw server text",
      );
    }
  });

  it("prefers the explicit override over everything", () => {
    expect(
      errorPresentation(withStatus(403), { explicit: "Custom copy" }),
    ).toEqual({ message: "Custom copy", retryable: true });
  });

  it("reports offline only once a server verdict is ruled out", () => {
    expect(errorPresentation(new Error("x"), { online: false }).message).toMatch(
      /offline/iu,
    );
    // A 403 received while the radio is flaky is still a permission problem.
    expect(
      errorPresentation(withStatus(403), { online: false }).message,
    ).toMatch(/access/iu);
  });

  it("renders a deliberately-disabled runtime as non-retryable", () => {
    // runtimecapability.WriteUnavailable: a 503 that is a product boundary,
    // not a fault. Without this it fell into the generic 5xx branch and
    // offered a Retry button that could never work.
    const error = Object.assign(new Error("Flow execution is disabled."), {
      status: 503,
      capability: "flow_runtime",
      runtimeStatus: "unavailable",
      retryable: false,
    });
    expect(errorPresentation(error)).toEqual({
      message: "Flow execution is disabled.",
      retryable: false,
    });
  });

  it("still treats an ordinary 503 as a retryable server fault", () => {
    const error = Object.assign(new Error("upstream down"), { status: 503 });
    expect(errorPresentation(error)).toEqual({
      message: "The server had a problem with this request. Please try again.",
      retryable: true,
    });
  });
});

// A 2xx body the client could not read is a different fault from a dropped
// connection: the network worked, and the app and server disagree about the
// shape. `wire_shape` had no reader anywhere, so it rendered exactly like a
// network blip and the user was never told that updating could help.
describe("errorPresentation — a response this app version cannot read", () => {
  const WIRE_SHAPE =
    "Moosewave sent a response this version of the app can't read. If this keeps happening, update the app.";

  it("names a wire-shape failure instead of calling it a loading blip", () => {
    const drift = errorPresentation(new WireShapeError("sending status"));
    const blip = errorPresentation(new Error("socket hang up"));
    expect(drift).toEqual({ message: WIRE_SHAPE, retryable: true });
    expect(drift.message).not.toBe(blip.message);
  });

  it("reads the code off any error that carries it, not only the class", () => {
    // Other shape errors carry the same code without the class.
    const tagged = Object.assign(new Error("x"), { code: "wire_shape" });
    expect(errorPresentation(tagged)).toEqual({
      message: WIRE_SHAPE,
      retryable: true,
    });
  });

  it("keeps the wire-shape sentence while the device reports offline", () => {
    // A body was received, so the connection is not the problem. The server's
    // answer outranks the connectivity guess, as it does for a 403.
    expect(
      errorPresentation(new WireShapeError("sending status"), { online: false }),
    ).toEqual({ message: WIRE_SHAPE, retryable: true });
  });

  it("never echoes the raw sentence the parser wrote", () => {
    const error = new WireShapeError(
      "site-key register",
      "The site-key register response was malformed.",
    );
    expect(errorPresentation(error).message).toBe(WIRE_SHAPE);
  });
});

// The denial vocabulary is why status is the wrong key for a refusal: `role`,
// `flag` and `policy` are ALL 403, and a `plan` ceiling is a 402 that matched
// no arm in the status table at all. Mobile dropped the class at the SDK
// boundary, so all four told the user the same thing.
describe("errorPresentation — classified denials", () => {
  const denied = (denial: Record<string, unknown>, status = 403) =>
    Object.assign(new Error("raw server text"), { status, denial });

  it("names the role that would unblock the user, and never offers to sell", () => {
    const out = errorPresentation(
      denied({ reason: "role", code: "insufficient_permission", requiredRole: "editor" }),
    );
    expect(out.message).toBe(
      "Your role can't do this. Ask a workspace editor to do it for you.",
    );
    expect(out.retryable).toBe(false);
  });

  it("falls back to naming an administrator when the server named no role", () => {
    expect(errorPresentation(denied({ reason: "role" })).message).toMatch(
      /administrator/iu,
    );
  });

  it("separates the three 403s that used to read identically", () => {
    const role = errorPresentation(denied({ reason: "role" })).message;
    const flag = errorPresentation(denied({ reason: "flag" })).message;
    const policy = errorPresentation(denied({ reason: "policy" })).message;
    expect(new Set([role, flag, policy]).size).toBe(3);
    // …and each points at the thing that actually resolves it.
    expect(role).toMatch(/role/iu);
    expect(flag).toMatch(/switched off/iu);
    expect(policy).toMatch(/policy/iu);
  });

  it("explains a plan ceiling that previously fell through to 'something went wrong'", () => {
    const upgradeable = errorPresentation(
      denied({ reason: "plan", code: "plan_limit_exceeded", remedy: "upgrade_plan" }, 402),
    );
    expect(upgradeable.message).toMatch(/upgrade/iu);
    expect(upgradeable.retryable).toBe(false);

    // Top tier: entitlement.Write strips the remedy because there is nothing
    // above `pro` to buy. Pointing at an upgrade here is pointing at nothing.
    const topTier = errorPresentation(
      denied({ reason: "plan", code: "plan_limit_exceeded", tier: "pro" }, 402),
    );
    expect(topTier.message).not.toMatch(/upgrade or reduce/iu);
    expect(topTier.message).toMatch(/limit/iu);
  });

  it("keeps a retry button only where the server's status says one could work", () => {
    const quota = errorPresentation(
      denied({ reason: "quota", code: "rate_limited", retryAfterSeconds: 120 }, 429),
    );
    expect(quota.message).toContain("Try again in 2 minutes");
    expect(quota.retryable).toBe(true);

    // `runtime` is the other one: entitlement statuses it 503, and its
    // highest-traffic emitter is rbacresolve's `permission_check_failed` — the
    // grant store unreadable for a moment, which clears itself. Before the
    // denial contract this 503 fell to the generic 5xx arm and DID offer a
    // retry; treating the class as permanent took that away and replaced it
    // with a claim about the deployment that this envelope cannot make.
    const runtime = errorPresentation(
      denied({ reason: "runtime", code: "permission_check_failed" }, 503),
    );
    expect(runtime.retryable).toBe(true);
    expect(runtime.message).not.toMatch(/deployment/iu);

    for (const reason of ["plan", "role", "flag", "policy"]) {
      expect(errorPresentation(denied({ reason })).retryable).toBe(false);
    }
  });

  it("still defers to the runtimecapability envelope for a real product boundary", () => {
    // That envelope is the one that CAN say "switched off in this deployment":
    // it names the capability and carries `retryable: false` on the wire.
    // errorCopy checks the denial first, so this pins that a 503 carrying the
    // capability envelope still reaches the capability branch, not the
    // entitlement one.
    const off = Object.assign(new Error("Flow execution is not enabled"), {
      status: 503,
      capability: "flow_execution",
      // The only value runtimecapability.WriteUnavailable emits, and what
      // isCapabilityUnavailable requires — not a paraphrase.
      runtimeStatus: "unavailable",
      retryable: false,
    });
    const out = errorPresentation(off);
    expect(out.retryable).toBe(false);
    expect(out.message).not.toBe("This isn't available right now. Try again shortly.");
  });

  it("never echoes the raw server message, denial or not", () => {
    for (const reason of ["plan", "role", "flag", "quota", "policy", "runtime"]) {
      expect(errorPresentation(denied({ reason })).message).not.toContain(
        "raw server text",
      );
    }
  });

  it("leaves the explicit override winning, as before", () => {
    expect(
      errorPresentation(denied({ reason: "role" }), { explicit: "Custom copy" }),
    ).toEqual({ message: "Custom copy", retryable: true });
  });

  it("still lets an expired session win over a denial", () => {
    // A 401 is about the credential, not the entitlement — and the server
    // never classifies one. Belt and braces: if both ever appear, sign-in is
    // the only next step that can work.
    expect(errorPresentation(denied({ reason: "role" }, 401)).message).toMatch(
      /expired/iu,
    );
  });

  it("falls back to the status table when the server did not classify", () => {
    expect(errorPresentation(withStatus(403)).message).toMatch(/access/iu);
    // A reason outside the closed vocabulary is not a class this client
    // understands, so it must not be presented as one. `parseDenialEnvelope`
    // drops it upstream; nothing reaches `denial` here.
    expect(
      errorPresentation(Object.assign(new Error("x"), { status: 403 })).message,
    ).toMatch(/access/iu);
  });
});
