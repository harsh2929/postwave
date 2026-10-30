import { describe, expect, it } from "vitest";

import {
  denialFromError,
  denialPresentation,
  isClassifiedDenial,
  parseDenialEnvelope,
} from "./denialEnvelope";

/** Byte-for-byte the body internal/rbac/rbac.go encodes at the permission
 *  chokepoint — the most-hit denial in the API. */
const ROLE_WIRE = {
  error: {
    subject: "campaigns.write",
    reason: "role",
    code: "insufficient_permission",
    message: "your role does not have the campaigns.write permission",
    required_role: "editor",
  },
};

/** entitlement.PlanLimit, as written by limits.WriteExceeded. */
const PLAN_WIRE = {
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
};

describe("parseDenialEnvelope", () => {
  it("reads the server's refusal, snake_case included", () => {
    expect(parseDenialEnvelope(ROLE_WIRE)).toEqual({
      reason: "role",
      code: "insufficient_permission",
      subject: "campaigns.write",
      requiredRole: "editor",
    });
  });

  it("reads a plan ceiling with its numbers and the server's remedy", () => {
    expect(parseDenialEnvelope(PLAN_WIRE)).toEqual({
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

  it("ignores an ordinary error envelope", () => {
    // Every consumer switches on `reason` to pick an affordance, so a body that
    // is not a classified refusal must not be mistaken for one.
    expect(
      parseDenialEnvelope({ error: { code: "not_found", message: "gone" } }),
    ).toBeUndefined();
    expect(parseDenialEnvelope(undefined)).toBeUndefined();
    expect(parseDenialEnvelope("plain text")).toBeUndefined();
  });

  it("drops a reason outside the closed vocabulary", () => {
    expect(
      parseDenialEnvelope({ error: { reason: "vibes", message: "no" } }),
    ).toBeUndefined();
  });
});

describe("denialFromError", () => {
  it("reads the SDK error's decoded body", () => {
    const err = Object.assign(new Error("forbidden"), {
      status: 403,
      payload: ROLE_WIRE,
    });
    expect(denialFromError(err)?.requiredRole).toBe("editor");
  });

  it("returns undefined for an error the SDK gave no body", () => {
    expect(denialFromError(new Error("network down"))).toBeUndefined();
    expect(denialFromError(null)).toBeUndefined();
  });
});

describe("isClassifiedDenial", () => {
  it("is true only once a denial is attached", () => {
    expect(isClassifiedDenial({ denial: { reason: "flag" } })).toBe(true);
    expect(isClassifiedDenial({ status: 403 })).toBe(false);
    expect(isClassifiedDenial(null)).toBe(false);
  });
});

describe("denialPresentation", () => {
  it("gives each reason its own answer, because each has its own remedy", () => {
    const messages = (
      ["plan", "role", "flag", "quota", "policy", "runtime"] as const
    ).map((reason) => denialPresentation({ reason }).message);
    expect(new Set(messages).size).toBe(6);
  });

  it("never mentions a role, plan or delay the server did not send", () => {
    expect(denialPresentation({ reason: "role" }).message).not.toMatch(/editor/iu);
    expect(denialPresentation({ reason: "quota" }).message).not.toMatch(/\d/u);
    // No remedy on a plan denial means the top tier, or a ceiling no plan
    // raises. Offering an upgrade points at a button that cannot help.
    expect(denialPresentation({ reason: "plan" }).message).not.toMatch(
      /upgrade or reduce/iu,
    );
  });

  it("offers a retry only where the server's own status says one could work", () => {
    // entitlement.Reason.httpStatus: quota → 429, runtime → 503. The other four
    // are 402/403 and hold until a human changes something, so a Try again
    // button on them is a lie for as long as the denial lasts.
    expect(denialPresentation({ reason: "quota" }).retryable).toBe(true);
    expect(denialPresentation({ reason: "runtime" }).retryable).toBe(true);
    for (const reason of ["plan", "role", "flag", "policy"] as const) {
      expect(denialPresentation({ reason }).retryable).toBe(false);
    }
  });

  it("does not tell a user a deployment fact this envelope cannot assert", () => {
    // `runtime`'s highest-traffic emitter is rbacresolve's
    // `permission_check_failed` — the grant store unreadable for a moment, not
    // a capability compiled out. Only internal/runtimecapability's envelope
    // (capability + retryable:false) can claim "switched off in this
    // deployment", and lib/capabilityEnvelope is what reads that one.
    const out = denialPresentation({ reason: "runtime" });
    expect(out.message).not.toMatch(/deployment/iu);
    expect(out.message).not.toMatch(/nothing to retry/iu);
  });

  it("uses the workspace-admin remedy when the server asserted it", () => {
    expect(
      denialPresentation({ reason: "plan", remedy: "contact_workspace_admin" }).message,
    ).toMatch(/administrator can raise it/iu);
    expect(
      denialPresentation({ reason: "flag", remedy: "contact_workspace_admin" }).message,
    ).toMatch(/administrator can turn it on/iu);
  });

  it("never promises an administrator on a flag denial the server left remedy-less", () => {
    // agency.not_agency, archive.tips_disabled and
    // handlers.direct_provision_disabled all send Reason=flag with NO remedy,
    // each with a comment saying so deliberately: no admin, no upgrade and no
    // role resolves them. Naming an administrator sends the user to ask for
    // something nobody can grant.
    const out = denialPresentation({ reason: "flag" });
    expect(out.message).not.toMatch(/administrator/iu);
    // And it must be a DIFFERENT sentence from the one the server does
    // substantiate, or reading the remedy would make no difference.
    expect(out.message).not.toBe(
      denialPresentation({ reason: "flag", remedy: "contact_workspace_admin" })
        .message,
    );
    expect(out.retryable).toBe(false);
  });
});
