import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_REJECT_REASON_CHARS,
  PUSH_REJECT_PARAM,
  PUSH_REJECT_ROUTE,
  pushDecisionBlockedNotice,
  pushDecisionConfirmCopy,
  pushDecisionGate,
  pushDecisionOutcomeNotice,
  pushRejectNeedsReasonNotice,
  pushRejectPlan,
  pushRejectRouteParams,
  roleMayDecide,
} from "./pushDecisionFlow";

const base = {
  canUseOnlineServices: true,
  sessionValidation: "validated_online",
  retryable: false,
  role: "owner" as string | null,
  mode: "session" as "api_key" | "session" | null,
};

/**
 * The authorization fact under test was read from the Go handler, not from the
 * route manifest: apps/api/internal/approvals/handlers.go `decide` and
 * `decideReturningApproval` both call `requireAdmin`, which admits only
 * owner|admin (and short-circuits to allow for API-key auth, whose scopes were
 * already enforced upstream).
 */
describe("roleMayDecide", () => {
  it("admits owner and admin sessions", () => {
    expect(roleMayDecide("owner", "session")).toBe(true);
    expect(roleMayDecide("admin", "session")).toBe(true);
  });

  it("refuses editor, viewer, member and unknown roles", () => {
    expect(roleMayDecide("editor", "session")).toBe(false);
    expect(roleMayDecide("viewer", "session")).toBe(false);
    expect(roleMayDecide("member", "session")).toBe(false);
    expect(roleMayDecide("", "session")).toBe(false);
    expect(roleMayDecide(null, "session")).toBe(false);
  });

  it("does not second-guess an API-key session", () => {
    // requireAdmin returns true for API-key auth, and the phone cannot see the
    // key's scopes — refusing locally would break a path that works.
    expect(roleMayDecide(null, "api_key")).toBe(true);
    expect(roleMayDecide("viewer", "api_key")).toBe(true);
  });
});

describe("pushDecisionGate", () => {
  it("asks for confirmation on the ordinary authenticated path", () => {
    expect(pushDecisionGate(base)).toEqual({ kind: "confirm" });
  });

  it("blocks a role that can only ever receive a 403", () => {
    expect(pushDecisionGate({ ...base, role: "viewer" })).toEqual({
      kind: "blocked_role",
    });
  });

  it("blocks on role even while offline, because that is the durable answer", () => {
    expect(
      pushDecisionGate({
        ...base,
        role: "editor",
        canUseOnlineServices: false,
        sessionValidation: "offline_cached",
      }),
    ).toEqual({ kind: "blocked_role" });
  });

  it("defers a COLD-START decision while the session is still checking", () => {
    // The response can be re-read next run, so leave it unconsumed rather than
    // nagging about being offline when we are demonstrably reaching /me.
    expect(
      pushDecisionGate({
        ...base,
        canUseOnlineServices: false,
        sessionValidation: "checking",
        retryable: true,
      }),
    ).toEqual({ kind: "retry_later" });
  });

  it("attempts a LIVE decision while checking, since it cannot be re-read", () => {
    expect(
      pushDecisionGate({
        ...base,
        canUseOnlineServices: false,
        sessionValidation: "checking",
        retryable: false,
      }),
    ).toEqual({ kind: "confirm" });
  });

  it("reports offline when the session is settled and unusable", () => {
    expect(
      pushDecisionGate({
        ...base,
        canUseOnlineServices: false,
        sessionValidation: "offline_cached",
        retryable: true,
      }),
    ).toEqual({ kind: "offline" });
  });
});

describe("pushDecisionConfirmCopy", () => {
  it("names the verb and marks a rejection destructive", () => {
    expect(pushDecisionConfirmCopy("reject")).toMatchObject({
      title: "Reject this request?",
      confirmLabel: "Reject",
      destructive: true,
    });
    expect(pushDecisionConfirmCopy("approve")).toMatchObject({
      title: "Approve this request?",
      confirmLabel: "Approve",
      destructive: false,
    });
  });

  it("says the decision is recorded immediately", () => {
    expect(pushDecisionConfirmCopy("approve").message).toMatch(
      /recorded immediately/i,
    );
  });
});

describe("pushDecisionOutcomeNotice", () => {
  it("confirms success with the decision that was made", () => {
    expect(
      pushDecisionOutcomeNotice({ ok: true, online: true, decision: "approve" }),
    ).toEqual({ message: "Request approved.", kind: "success" });
    expect(
      pushDecisionOutcomeNotice({ ok: true, online: true, decision: "reject" }),
    ).toEqual({ message: "Request rejected.", kind: "success" });
  });

  it("does not blame a failed OFFLINE post on the request being stale", () => {
    const notice = pushDecisionOutcomeNotice({
      ok: false,
      online: false,
      decision: "approve",
    });
    expect(notice.kind).toBe("error");
    expect(notice.message).toMatch(/offline/i);
    expect(notice.message).not.toMatch(/expired/i);
  });

  it("explains an online failure as already-decided or expired", () => {
    const notice = pushDecisionOutcomeNotice({
      ok: false,
      online: true,
      decision: "reject",
    });
    expect(notice.kind).toBe("error");
    expect(notice.message).toMatch(/already have been decided or expired/i);
  });
});

describe("pushDecisionBlockedNotice", () => {
  it("tells a blocked role the real reason", () => {
    expect(pushDecisionBlockedNotice("blocked_role")).toEqual({
      message:
        "Deciding approvals requires an owner or admin role in this workspace.",
      kind: "error",
    });
  });

  it("gives the offline case an action to take later", () => {
    expect(pushDecisionBlockedNotice("offline")?.message).toMatch(
      /open approvals after reconnecting/i,
    );
  });

  it("has nothing to say for the paths that continue", () => {
    expect(pushDecisionBlockedNotice("confirm")).toBeNull();
    expect(pushDecisionBlockedNotice("retry_later")).toBeNull();
  });
});

/**
 * GOVERNANCE#37. The property under test is a NEGATIVE one and it is the whole
 * point: there must be no input to this function that yields a reject with no
 * reason. Every other surface enforces that through
 * `rejectDraftSubmitState`; the notification button was the exception.
 */
describe("pushRejectPlan", () => {
  it("submits a typed reason, trimmed", () => {
    expect(pushRejectPlan("  Needs legal review first ")).toEqual({
      kind: "submit",
      notes: "Needs legal review first",
    });
  });

  it("never yields a submit without a reason", () => {
    for (const empty of [undefined, null, "", "   ", "\n\t ", 7, {}, []]) {
      expect(pushRejectPlan(empty as never)).toEqual({ kind: "needs_reason" });
    }
  });

  it("routes an over-long reason into the app instead of truncating it", () => {
    // Truncation would send HALF of a stated reason to the requester and
    // record it as the approver's words.
    const long = "x".repeat(MAX_PUSH_REJECT_REASON_CHARS + 1);
    expect(pushRejectPlan(long)).toEqual({ kind: "needs_reason" });
    const atLimit = "x".repeat(MAX_PUSH_REJECT_REASON_CHARS);
    expect(pushRejectPlan(atLimit)).toEqual({
      kind: "submit",
      notes: atLimit,
    });
  });

  it("measures the limit after trimming, not before", () => {
    const padded = `  ${"x".repeat(MAX_PUSH_REJECT_REASON_CHARS)}  `;
    expect(pushRejectPlan(padded).kind).toBe("submit");
  });
});

describe("reasonless reject routing", () => {
  it("targets the request itself, not the queue", () => {
    expect(PUSH_REJECT_ROUTE).toBe("/(tabs)/approvals/[id]");
    expect(pushRejectRouteParams("appr_9")).toEqual({
      id: "appr_9",
      [PUSH_REJECT_PARAM]: "1",
    });
  });

  it("explains why the button did not simply reject", () => {
    const notice = pushRejectNeedsReasonNotice();
    expect(notice.kind).toBe("warning");
    expect(notice.message).toMatch(/reason/i);
  });
});

describe("pushDecisionConfirmCopy — reason echo", () => {
  it("shows the approver what the requester will read", () => {
    const copy = pushDecisionConfirmCopy("reject", " Wrong list ");
    expect(copy.message).toContain('"Wrong list"');
    expect(copy.destructive).toBe(true);
  });

  it("keeps the original copy when there is no reason to echo", () => {
    expect(pushDecisionConfirmCopy("approve").message).toMatch(
      /Open Approvals first/,
    );
    expect(pushDecisionConfirmCopy("reject", "   ").message).toMatch(
      /Open Approvals first/,
    );
  });
});
