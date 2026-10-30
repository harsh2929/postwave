// Tests for the approvals decision-error toast mapping. Locks the
// human-readable copy for the new server-side error codes added by
// the approvals two-person rule + per-recipient single-use tokens
// audit closures. Without these, the dashboard falls back to the
// raw server message. Unknown codes must also stay on bounded local copy.

import { describe, expect, it } from "vitest";

import { decisionErrorMessage } from "../lib/approvals-errors";

describe("decisionErrorMessage", () => {
  it("self_approval surfaces specific copy and ignores raw message", () => {
    const msg = decisionErrorMessage(
      "approve",
      "self_approval",
      "raw server text",
    );
    expect(msg).toContain("can't decide an approval you requested");
    expect(msg).not.toContain("raw server text");
  });

  it("token_already_used surfaces specific copy", () => {
    const msg = decisionErrorMessage("reject", "token_already_used", "x");
    expect(msg).toContain("already been used");
  });

  it("not_pending surfaces race-loss copy", () => {
    expect(decisionErrorMessage("approve", "not_pending", "x")).toContain(
      "Already decided",
    );
  });

  it("expired surfaces TTL copy", () => {
    expect(decisionErrorMessage("approve", "expired", "x")).toContain(
      "expired",
    );
  });

  it("forbidden surfaces role copy", () => {
    expect(decisionErrorMessage("reject", "forbidden", "x")).toContain(
      "owner or admin",
    );
  });

  it("unknown code uses local copy and never reflects the server message", () => {
    const canary = "postgres://admin:secret@internal/approval-note-canary";
    const msg = decisionErrorMessage("approve", "weird_new_code", canary);
    expect(msg).toBe(
      "Approve failed. The approval service could not complete the decision.",
    );
    expect(msg).not.toContain(canary);
  });

  it("missing code also ignores the raw message", () => {
    const msg = decisionErrorMessage("reject", undefined, "network down");
    expect(msg).toBe(
      "Reject failed. The approval service could not complete the decision.",
    );
    expect(msg).not.toContain("network down");
  });

  it("verb matches decision in fallback", () => {
    expect(decisionErrorMessage("approve", undefined, "x")).toMatch(
      /^Approve /,
    );
    expect(decisionErrorMessage("reject", undefined, "x")).toMatch(/^Reject /);
  });

  it("adds only a bounded safe request reference", () => {
    const msg = decisionErrorMessage(
      "approve",
      "unknown",
      "raw-message-canary",
      "req_01.safe-reference",
    );
    expect(msg).toContain("Reference: req_01.safe-reference.");
    expect(msg).not.toContain("raw-message-canary");
  });

  it.each([
    "request ref with spaces",
    "request/ref/with/slashes",
    "r".repeat(97),
    "",
  ])("drops unsafe or oversized request reference %j", (reference) => {
    const msg = decisionErrorMessage(
      "reject",
      "unknown",
      "raw-message-canary",
      reference,
    );
    expect(msg).not.toContain("Reference:");
    if (reference) expect(msg).not.toContain(reference);
    expect(msg).not.toContain("raw-message-canary");
  });
});
